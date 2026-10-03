//! SGX display-only index LODs. Tangents are absent from the float display
//! vertex stream; all other source attributes and the Reference topology stay
//! immutable. As for ordinary source LODs, error is the compiler's measured
//! attribute-weighted simplifier error, not a Hausdorff or raster guarantee.
use crate::{Draw, DrawLod, Meta, Range, VertexLayout};
use alloc::{
    collections::{BTreeMap, BTreeSet},
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};

pub const VERSION: u32 = 1;

pub fn eligible(meta: &Meta, d: &Draw) -> bool {
    d.layout == VertexLayout::Baked
        && d.node.is_none()
        && d.skin.is_none()
        && d.pos_scale == [1.0; 3]
        && d.pos_offset == [0.0; 3]
        && d.vertex_count <= 65535
        && meta.materials.get(d.material as usize).is_some_and(|m| {
            m.kind == crate::Kind::Standard
                && m.blend == crate::Blend::Opaque
                && m.depth_write
                && m.alpha_test == 0.0
                && m.wet.is_none()
                && !m.vertex_pbr
                && !m.interior
                && m.emission.is_none()
                && m.emissive_track.is_none()
                && m.emission_shade.is_none()
        })
}

pub fn source_end(meta: &Meta) -> Result<u32, String> {
    let mut end = 0;
    for d in &meta.draws {
        for r in core::iter::once(&d.vertices)
            .chain(core::iter::once(&d.indices))
            .chain(d.lods.iter().map(|l| &l.indices))
        {
            end = end.max(
                r.offset
                    .checked_add(r.size)
                    .ok_or("derived LOD source overflow")?,
            );
        }
    }
    Ok(end)
}

pub fn source_hash(meta: &Meta, draw: &Draw, geometry: &[u8]) -> Result<String, String> {
    let material = meta
        .materials
        .get(draw.material as usize)
        .ok_or("display LOD material")?;
    let mut hash = crate::content_hash::Fnv1a64::default();
    hash.update(&serde_json::to_vec(&(VERSION, draw, material)).map_err(|e| e.to_string())?);
    hash.update(crate::parts::slice(geometry, &draw.vertices)?);
    for r in core::iter::once(&draw.indices).chain(draw.lods.iter().map(|l| &l.indices)) {
        hash.update(crate::parts::slice(geometry, r)?);
    }
    Ok(format!("{:016x}", hash.finish()))
}

pub fn triangles(
    range: &Range,
    count: u32,
    vertices: u32,
    data: &[u8],
) -> Result<Vec<[u32; 3]>, String> {
    if range.offset % 2 != 0 || count % 3 != 0 || count.checked_mul(2) != Some(range.size) {
        return Err("display LOD range/count".into());
    }
    crate::parts::slice(data, range)?
        .chunks_exact(6)
        .map(|b| {
            let tri = core::array::from_fn(|k| u16::from_le_bytes([b[k * 2], b[k * 2 + 1]]) as u32);
            if tri.iter().any(|&i| i >= vertices) {
                Err("display LOD local index".into())
            } else {
                Ok(tri)
            }
        })
        .collect()
}

fn position(v: &[u8]) -> Result<[u32; 3], String> {
    let p = super::floats::<3>(v, 0)?;
    if p.iter().any(|v| !v.is_finite()) {
        return Err("display LOD nonfinite position".into());
    }
    Ok(p.map(|v| if v == 0.0 { 0 } else { v.to_bits() }))
}

/// Exact edges shared by static draws remain locked, including different
/// materials and non-display neighbours. Only eligible draws are simplified;
/// collecting all original static edges keeps their shared borders sealed.
pub fn boundary_locks(
    meta: &Meta,
    geometry: &[u8],
    selected: Option<&[u32]>,
) -> Result<Vec<BTreeSet<[u32; 3]>>, String> {
    let mut locks = vec![BTreeSet::new(); meta.draws.len()];
    // A compact, sorted 28-byte edge record avoids per-edge tree allocations.
    // The loader collects only recipe candidates; unrelated neighbours are
    // scanned below without retaining their edges or vertices.
    let mut edges = Vec::<([u32; 3], [u32; 3], u32)>::new();
    let visit = |d: &Draw, emit: &mut dyn FnMut([u32; 3], [u32; 3])| -> Result<(), String> {
        let bytes = crate::parts::slice(geometry, &d.vertices)?;
        let stride = super::stride(d.layout) as usize;
        if bytes.len()
            != (d.vertex_count as usize)
                .checked_mul(stride)
                .ok_or("display LOD vertex overflow")?
        {
            return Err("display LOD vertex size".into());
        }
        for tri in triangles(&d.indices, d.index_count, d.vertex_count, geometry)? {
            let mut positions = [[0; 3]; 3];
            for k in 0..3 {
                positions[k] = position(&bytes[tri[k] as usize * stride..][..stride])?;
            }
            for k in 0..3 {
                let a = positions[k];
                let b = positions[(k + 1) % 3];
                emit(a.min(b), a.max(b));
            }
        }
        Ok(())
    };
    for (di, d) in meta.draws.iter().enumerate().filter(|(i, d)| {
        eligible(meta, d) && selected.is_none_or(|s| s.binary_search(&(*i as u32)).is_ok())
    }) {
        edges
            .try_reserve(d.index_count as usize)
            .map_err(|_| "display boundary allocation")?;
        visit(d, &mut |a, b| edges.push((a, b, di as u32)))?;
    }
    edges.sort_unstable();
    edges.dedup();
    for (di, d) in
        meta.draws.iter().enumerate().filter(|(_, d)| {
            d.node.is_none() && d.skin.is_none() && d.layout != VertexLayout::Lights
        })
    {
        visit(d, &mut |a, b| {
            let start = edges.partition_point(|&(x, y, _)| (x, y) < (a, b));
            for &(_, _, owner) in edges[start..]
                .iter()
                .take_while(|&&(x, y, _)| (x, y) == (a, b))
            {
                if owner as usize != di {
                    locks[owner as usize].extend([a, b]);
                }
            }
        })?;
    }
    Ok(locks)
}

pub struct Topology {
    /// Compact vertex -> unchanged original source vertex.
    pub representatives: Vec<u32>,
    /// Source-local vertex -> canonical source-local vertex (tangent omitted).
    canonical: Vec<u32>,
    pub full: Vec<[u32; 3]>,
    pub locked: Vec<bool>,
    roots: Vec<u32>,
    protected_edges: BTreeMap<[u32; 2], usize>,
}
impl Topology {
    pub fn new(d: &Draw, geometry: &[u8], locks: &BTreeSet<[u32; 3]>) -> Result<Self, String> {
        if d.layout != VertexLayout::Baked
            || d.vertices.size
                != d.vertex_count
                    .checked_mul(56)
                    .ok_or("display LOD vertex overflow")?
        {
            return Err("display LOD source layout".into());
        }
        let bytes = crate::parts::slice(geometry, &d.vertices)?;
        let source = triangles(&d.indices, d.index_count, d.vertex_count, geometry)?;
        let mut map = BTreeMap::<[u8; 40], u32>::new();
        let mut representatives = Vec::new();
        let mut compact = vec![u32::MAX; d.vertex_count as usize];
        let mut canonical = vec![u32::MAX; d.vertex_count as usize];
        let mut locked = Vec::new();
        for &i in source.iter().flatten() {
            if compact[i as usize] != u32::MAX {
                continue;
            }
            let v = &bytes[i as usize * 56..(i as usize + 1) * 56];
            if super::floats::<6>(v, 0)?
                .iter()
                .chain(super::floats::<2>(v, 40)?.iter())
                .any(|v| !v.is_finite())
            {
                return Err("display LOD nonfinite attribute".into());
            }
            let mut key = [0; 40];
            key[..24].copy_from_slice(&v[..24]);
            key[24..].copy_from_slice(&v[40..]);
            let ci = *map.entry(key).or_insert_with(|| {
                representatives.push(i);
                locked.push(locks.contains(&position(v).unwrap()));
                representatives.len() as u32 - 1
            });
            compact[i as usize] = ci;
            canonical[i as usize] = representatives[ci as usize];
        }
        let full: Vec<_> = source
            .iter()
            .map(|t| t.map(|i| compact[i as usize]))
            .collect();
        let mut protected_edges = BTreeMap::new();
        for t in &full {
            for k in 0..3 {
                let (a, b) = (t[k] as usize, t[(k + 1) % 3] as usize);
                if locked[a] && locked[b] {
                    *protected_edges
                        .entry([representatives[a], representatives[b]])
                        .or_default() += 1;
                }
            }
        }
        Ok(Self {
            representatives,
            canonical,
            full,
            locked,
            roots: super::components(d, geometry)?,
            protected_edges,
        })
    }
    pub fn validate_level(&self, triangles: &[[u32; 3]]) -> Result<(), String> {
        let mut used = BTreeSet::new();
        let mut edges = BTreeMap::new();
        for &t in triangles {
            if t.iter()
                .any(|&i| self.canonical.get(i as usize) != Some(&i))
            {
                return Err("display LOD noncanonical/source-local index".into());
            }
            let r = self.roots[t[0] as usize];
            if r == u32::MAX || t.iter().any(|&i| self.roots[i as usize] != r) {
                return Err("display LOD crosses original component".into());
            }
            used.extend(t);
            for k in 0..3 {
                *edges.entry([t[k], t[(k + 1) % 3]]).or_default() += 1;
            }
        }
        if self
            .representatives
            .iter()
            .zip(&self.locked)
            .any(|(&i, &lock)| lock && !used.contains(&i))
            || self
                .protected_edges
                .iter()
                .any(|(edge, count)| edges.get(edge) != Some(count))
        {
            return Err("display LOD changed shared chunk boundary".into());
        }
        Ok(())
    }
}

/// Validate all appended ranges together. Recipes may have alignment gaps,
/// but neither may overlap source vertices/indices or the other recipe.
pub fn validate_ranges(
    meta: &Meta,
    geometry: &[u8],
    recipes: &super::Recipes,
) -> Result<(), String> {
    let source_end = source_end(meta)?;
    let mut ranges = Vec::new();
    for level in recipes
        .skin_lods
        .iter()
        .flat_map(|r| &r.draws)
        .flat_map(|d| &d.levels)
        .chain(
            recipes
                .display_lods
                .iter()
                .flat_map(|r| &r.draws)
                .flat_map(|d| &d.levels),
        )
        .chain(
            recipes
                .animated_display_lods
                .iter()
                .flat_map(|r| &r.draws)
                .flat_map(|d| &d.levels),
        )
    {
        let r = &level.indices;
        if r.offset < source_end
            || r.offset % 2 != 0
            || level.index_count.checked_mul(2) != Some(r.size)
        {
            return Err("derived LOD range overlaps source/count".into());
        }
        crate::parts::slice(geometry, r)?;
        if r.size > 0 {
            ranges.push((
                r.offset,
                r.offset
                    .checked_add(r.size)
                    .ok_or("derived LOD range overflow")?,
            ));
        }
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|r| r[0].1 > r[1].0) {
        return Err("derived LOD recipes overlap".into());
    }
    Ok(())
}

pub fn validate(meta: &Meta, geometry: &[u8], recipes: &super::Recipes) -> Result<(), String> {
    validate_ranges(meta, geometry, recipes)?;
    let Some(recipe) = &recipes.display_lods else {
        return Ok(());
    };
    if recipe.version != VERSION || recipe.draws.is_empty() {
        return Err("display LOD version/empty draws".into());
    }
    let selected: Vec<_> = recipe.draws.iter().map(|d| d.draw).collect();
    let locks = boundary_locks(meta, geometry, Some(&selected))?;
    let mut prior = None;
    for entry in &recipe.draws {
        if prior.is_some_and(|d| d >= entry.draw) {
            return Err("display LOD draw order".into());
        }
        prior = Some(entry.draw);
        let d = meta
            .draws
            .get(entry.draw as usize)
            .ok_or("display LOD draw index")?;
        if !eligible(meta, d) || entry.levels.is_empty() {
            return Err("display LOD unsupported/empty draw".into());
        }
        if entry.source_hash != source_hash(meta, d, geometry)?
            || entry.payload_hash != super::skin_lods::payload_hash(&entry.levels, geometry)?
        {
            return Err("display LOD source/payload identity".into());
        }
        let topology = Topology::new(d, geometry, &locks[entry.draw as usize])?;
        let (mut count, mut error) = (d.index_count, 0.0);
        for l in &entry.levels {
            if !l.error.is_finite() || l.error <= error || l.index_count >= count {
                return Err("display LOD error/count order".into());
            }
            topology.validate_level(&triangles(
                &l.indices,
                l.index_count,
                d.vertex_count,
                geometry,
            )?)?;
            count = l.index_count;
            error = l.error;
        }
    }
    Ok(())
}

/// Immutable selection view shared by the cooker, cluster proof and runtime.
/// It does not rewrite Meta or participate in the source identity hash.
#[derive(Default)]
pub struct EffectiveLods {
    draws: Vec<Option<Vec<DrawLod>>>,
}
impl EffectiveLods {
    pub fn new(meta: &Meta, recipes: &super::Recipes) -> Result<Self, String> {
        if recipes.skin_lods.is_none()
            && recipes.display_lods.is_none()
            && recipes.animated_display_lods.is_none()
        {
            return Ok(Self::default());
        }
        let mut draws = vec![None; meta.draws.len()];
        for (draw, levels) in recipes
            .skin_lods
            .iter()
            .flat_map(|r| &r.draws)
            .map(|d| (d.draw, &d.levels))
            .chain(
                recipes
                    .display_lods
                    .iter()
                    .flat_map(|r| &r.draws)
                    .map(|d| (d.draw, &d.levels)),
            )
        {
            let source = meta
                .draws
                .get(draw as usize)
                .ok_or("effective LOD draw index")?;
            let dst = draws
                .get_mut(draw as usize)
                .ok_or("effective LOD draw index")?;
            if dst.is_some() {
                return Err("multiple derived LOD recipes on draw".into());
            }
            let mut all = source.lods.clone();
            all.extend(levels.iter().cloned());
            if all.iter().any(|l| !l.error.is_finite() || l.error < 0.0) {
                return Err("effective LOD nonfinite error".into());
            }
            all.sort_by(|a, b| {
                a.error
                    .total_cmp(&b.error)
                    .then(a.index_count.cmp(&b.index_count))
            });
            let mut count = source.index_count;
            all.retain(|l| {
                if l.index_count < count {
                    count = l.index_count;
                    true
                } else {
                    false
                }
            });
            *dst = Some(all);
        }
        // The approximate animation/display tiers supplement the original
        // same-influence tiers. Neither changes the other's proof or payload.
        for entry in recipes.animated_display_lods.iter().flat_map(|r| &r.draws) {
            if recipes
                .display_lods
                .iter()
                .flat_map(|r| &r.draws)
                .any(|d| d.draw == entry.draw)
            {
                return Err("static and animated display LOD recipes overlap".into());
            }
            let source = meta
                .draws
                .get(entry.draw as usize)
                .ok_or("animated effective LOD draw")?;
            let dst = draws
                .get_mut(entry.draw as usize)
                .ok_or("animated effective LOD draw")?;
            let mut all = dst.take().unwrap_or_else(|| source.lods.clone());
            all.extend(entry.levels.iter().cloned());
            if all.iter().any(|l| !l.error.is_finite() || l.error < 0.) {
                return Err("animated effective LOD error".into());
            }
            all.sort_by(|a, b| {
                a.error
                    .total_cmp(&b.error)
                    .then(a.index_count.cmp(&b.index_count))
            });
            let mut count = source.index_count;
            all.retain(|l| {
                if l.index_count < count {
                    count = l.index_count;
                    true
                } else {
                    false
                }
            });
            *dst = Some(all);
        }
        Ok(Self { draws })
    }
    pub fn get<'a>(&'a self, meta: &'a Meta, draw: usize) -> &'a [DrawLod] {
        self.draws
            .get(draw)
            .and_then(Option::as_deref)
            .unwrap_or(&meta.draws[draw].lods)
    }
    pub fn bytes(&self) -> usize {
        self.draws.capacity() * core::mem::size_of::<Option<Vec<DrawLod>>>()
            + self
                .draws
                .iter()
                .flatten()
                .map(|d| d.capacity() * core::mem::size_of::<DrawLod>())
                .sum::<usize>()
    }
}
