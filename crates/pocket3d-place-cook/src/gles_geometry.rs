//! Shared vertex pages for GLES, with independently culled source draws.
//!
//! Only opaque, world-space baked meshes enter a page. Draw IDs, bounds and
//! per-draw LOD lists stay independent. Each index level is laid out in source
//! draw order, allowing the renderer to combine adjacent *visible* ranges.
use super::{pc, RawValue, Result};
use glam::Vec3;
use std::collections::BTreeMap;

const MAX_VERTICES: usize = 65535;
const VALIDATION_HEIGHT: f32 = 640.0;

/// Explicit cook-time precision tradeoffs, independent of place identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Balanced,
    Throughput,
}

#[derive(Clone, Copy)]
struct Limits {
    cell: f32,
    position: f32,
    pixels: f32,
    texels: f32,
}

impl Profile {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "balanced" => Ok(Self::Balanced),
            "throughput" => Ok(Self::Throughput),
            _ => Err(format!(
                "unknown GLES geometry profile {value:?}; use balanced or throughput"
            )),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Balanced => "balanced",
            Self::Throughput => "throughput",
        }
    }

    fn limits(self) -> Limits {
        match self {
            Self::Balanced => Limits {
                cell: 64.0,
                position: 0.002,
                pixels: 0.2,
                texels: 0.1,
            },
            Self::Throughput => Limits {
                cell: 256.0,
                position: 0.01,
                pixels: 1.0,
                texels: 0.25,
            },
        }
    }

    pub fn description(self) -> String {
        let l = self.limits();
        format!(
            "{}: {} m cells, <= {} mm position / {} px at 640 high / {} adapted texels",
            self.name(),
            l.cell,
            l.position * 1000.0,
            l.pixels,
            l.texels
        )
    }
}

pub(super) struct Batched {
    pub bytes: Vec<u8>,
    pub draws: Vec<Box<RawValue>>,
    pub pages: usize,
    pub shared_draws: usize,
    pub position_error: f32,
    pub uv_error_texels: f32,
}

struct Page {
    draws: Vec<usize>,
    vertices: Vec<u8>,
    bases: Vec<u16>,
    pos_offset: [f32; 3],
    pos_scale: [f32; 3],
    uv_offset: [f32; 2],
    uv_scale: [f32; 2],
    position_error: f32,
    uv_error_texels: f32,
    errors: Vec<f32>,
    bounds: Vec<([f32; 3], [f32; 3])>,
}

fn slice<'a>(bytes: &'a [u8], range: &pc::Range) -> Result<&'a [u8]> {
    let end = range
        .offset
        .checked_add(range.size)
        .ok_or("geometry range overflow")?;
    bytes
        .get(range.offset as usize..end as usize)
        .ok_or_else(|| "geometry range outside GEOM".into())
}

fn decode(bytes: &[u8], at: usize, scale: f32, offset: f32) -> f32 {
    let q = i16::from_le_bytes([bytes[at], bytes[at + 1]]);
    (q as f32 / 32767.0).max(-1.0) * scale + offset
}

fn encode(bytes: &mut [u8], at: usize, value: f32, scale: f32, offset: f32) -> f32 {
    let q =
        (((value as f64 - offset as f64) / scale as f64).clamp(-1.0, 1.0) * 32767.0).round() as i16;
    bytes[at..at + 2].copy_from_slice(&q.to_le_bytes());
    decode(bytes, at, scale, offset)
}

fn span<const N: usize>(lo: [f32; N], hi: [f32; N], floor: f32) -> ([f32; N], [f32; N]) {
    let offset = std::array::from_fn(|k| ((lo[k] as f64 + hi[k] as f64) * 0.5) as f32);
    // Round the center to the actual uniform precision, then cover both ends.
    let scale = std::array::from_fn(|k| (hi[k] - offset[k]).max(offset[k] - lo[k]).max(floor));
    (offset, scale)
}

/// Includes every eye position on each authored shot's linear path. Inside
/// the 3:2 viewport, the perspective Jacobian is bounded by
/// (1 + tan(fov/2)^2 * (1 + aspect^2)) / distance. The margin covers the
/// changed denominator after displacement; the 0.25 m near plane bounds it.
fn position_limit(meta: &pc::Meta, p: Vec3, limits: Limits) -> f32 {
    let mut limit = limits.position;
    let mut camera = |a: &pc::ShotKey, b: &pc::ShotKey| {
        let start = Vec3::from(a.pos);
        let direction = Vec3::from(b.pos) - start;
        let t =
            ((p - start).dot(direction) / direction.length_squared().max(1e-12)).clamp(0.0, 1.0);
        let distance = p.distance(start + direction * t).max(0.25);
        for fov in [a.fov, b.fov] {
            let tan = (fov.to_radians() * 0.5).tan();
            let pixel = 2.0 * tan / (VALIDATION_HEIGHT * (1.0 + 3.25 * tan * tan));
            limit = limit.min(distance * pixel * limits.pixels * 0.99);
        }
    };
    for shot in &meta.camera.shots {
        camera(&shot.from, &shot.to);
    }
    camera(&meta.camera.intro, &meta.camera.intro);
    limit
}

fn texel_scale(meta: &pc::Meta, material: u32, cap: u32) -> [f32; 2] {
    let m = &meta.materials[material as usize];
    let mut size = [1.0f32; 2];
    // Match the texture adapter's halving, including nonsquare textures.
    // Error is measured at the largest mip actually sampled by this target.
    for id in [m.albedo, m.normal, m.orm, m.emission]
        .into_iter()
        .flatten()
    {
        if let Some(t) = meta.textures.get(id as usize) {
            let (mut width, mut height) = (t.width, t.height);
            while width > cap || height > cap {
                width = (width / 2).max(1);
                height = (height / 2).max(1);
            }
            size[0] = size[0].max(width as f32);
            size[1] = size[1].max(height as f32);
        }
    }
    size
}

fn try_page(
    meta: &pc::Meta,
    source: &[u8],
    group: &[usize],
    cap: u32,
    limits: Limits,
) -> Result<Option<Page>> {
    if group.len() < 2 {
        return Ok(None);
    }
    let mut pos_lo = [f32::INFINITY; 3];
    let mut pos_hi = [f32::NEG_INFINITY; 3];
    let mut uv_lo = [f32::INFINITY; 2];
    let mut uv_hi = [f32::NEG_INFINITY; 2];
    let mut count = 0usize;
    for &i in group {
        let d = &meta.draws[i];
        count = count
            .checked_add(d.vertex_count as usize)
            .ok_or("vertex count overflow")?;
        if count > MAX_VERTICES {
            return Ok(None);
        }
        let vertices = slice(source, &d.vertices)?;
        if vertices.len() != d.vertex_count as usize * 28 || d.vertex_count == 0 {
            return Err("baked vertex count/stride mismatch".into());
        }
        for v in vertices.chunks_exact(28) {
            for k in 0..3 {
                let p = decode(v, k * 2, d.pos_scale[k], d.pos_offset[k]);
                if !p.is_finite() {
                    return Err("non-finite decoded position".into());
                }
                pos_lo[k] = pos_lo[k].min(p);
                pos_hi[k] = pos_hi[k].max(p);
            }
            for k in 0..2 {
                let uv = decode(v, 16 + k * 2, d.uv_scale[k], d.uv_offset[k]);
                if !uv.is_finite() {
                    return Err("non-finite decoded UV".into());
                }
                uv_lo[k] = uv_lo[k].min(uv);
                uv_hi[k] = uv_hi[k].max(uv);
            }
        }
    }
    let (pos_offset, pos_scale) = span(pos_lo, pos_hi, 1e-4);
    let (uv_offset, uv_scale) = span(uv_lo, uv_hi, 1e-5);
    let texels = texel_scale(meta, meta.draws[group[0]].material, cap);
    let mut page = Page {
        draws: group.to_vec(),
        vertices: Vec::with_capacity(count * 28),
        bases: Vec::new(),
        pos_offset,
        pos_scale,
        uv_offset,
        uv_scale,
        position_error: 0.0,
        uv_error_texels: 0.0,
        errors: Vec::new(),
        bounds: Vec::new(),
    };
    for &i in group {
        let d = &meta.draws[i];
        page.bases.push((page.vertices.len() / 28) as u16);
        let mut error = 0.0f32;
        let (mut lo, mut hi) = (d.min, d.max);
        for source_vertex in slice(source, &d.vertices)?.chunks_exact(28) {
            // Normals, tangents, padding, colors and baked irradiance remain
            // byte-identical. Only position/UV words receive a new basis.
            let mut vertex: [u8; 28] = source_vertex.try_into().unwrap();
            let before: [f32; 3] = std::array::from_fn(|k| {
                decode(source_vertex, k * 2, d.pos_scale[k], d.pos_offset[k])
            });
            let after: [f32; 3] = std::array::from_fn(|k| {
                encode(&mut vertex, k * 2, before[k], pos_scale[k], pos_offset[k])
            });
            let delta = Vec3::from(before).distance(Vec3::from(after));
            if delta > position_limit(meta, Vec3::from(before), limits) {
                return Ok(None);
            }
            error = error.max(delta);
            for k in 0..3 {
                lo[k] = lo[k].min(after[k]);
                hi[k] = hi[k].max(after[k]);
            }
            for k in 0..2 {
                let before = decode(source_vertex, 16 + k * 2, d.uv_scale[k], d.uv_offset[k]);
                let after = encode(&mut vertex, 16 + k * 2, before, uv_scale[k], uv_offset[k]);
                let uv_error = (after - before).abs() * texels[k];
                if uv_error > limits.texels {
                    return Ok(None);
                }
                page.uv_error_texels = page.uv_error_texels.max(uv_error);
            }
            page.vertices.extend(vertex);
        }
        page.position_error = page.position_error.max(error);
        page.errors.push(error);
        page.bounds.push((lo, hi));
    }
    Ok(Some(page))
}

fn partition(
    meta: &pc::Meta,
    source: &[u8],
    group: &[usize],
    pages: &mut Vec<Page>,
    cap: u32,
    limits: Limits,
) -> Result<()> {
    if group.len() < 2 {
        return Ok(());
    }
    // A repeat cook must not duplicate a previously shared vertex page.
    let first = &meta.draws[group[0]];
    if group.iter().all(|&i| {
        let d = &meta.draws[i];
        d.vertices.offset == first.vertices.offset
            && d.vertices.size == first.vertices.size
            && d.pos_offset == first.pos_offset
            && d.pos_scale == first.pos_scale
            && d.uv_offset == first.uv_offset
            && d.uv_scale == first.uv_scale
    }) {
        return Ok(());
    }
    if let Some(page) = try_page(meta, source, group, cap, limits)? {
        pages.push(page);
    } else {
        let mid = group.len() / 2;
        partition(meta, source, &group[..mid], pages, cap, limits)?;
        partition(meta, source, &group[mid..], pages, cap, limits)?;
    }
    Ok(())
}

fn append(bytes: &mut Vec<u8>, data: &[u8], align: usize) -> Result<pc::Range> {
    let at = bytes
        .len()
        .checked_add(align - 1)
        .ok_or("geometry size overflow")?
        / align
        * align;
    let end = at.checked_add(data.len()).ok_or("geometry size overflow")?;
    if end > u32::MAX as usize {
        return Err("geometry exceeds 4 GiB".into());
    }
    bytes.resize(at, 0);
    bytes.extend_from_slice(data);
    Ok(pc::Range {
        offset: at as u32,
        size: data.len() as u32,
    })
}

fn indices(
    source: &[u8],
    range: &pc::Range,
    count: u32,
    vertices: u32,
    base: u16,
) -> Result<Vec<u8>> {
    let data = slice(source, range)?;
    if count % 3 != 0 || data.len() != count as usize * 2 || range.offset % 2 != 0 {
        return Err("triangle index count/alignment mismatch".into());
    }
    let mut out = Vec::with_capacity(data.len());
    for b in data.chunks_exact(2) {
        let i = u16::from_le_bytes(b.try_into().unwrap());
        if i as u32 >= vertices {
            return Err("triangle index exceeds vertex count".into());
        }
        let i = i.checked_add(base).ok_or("rebased index exceeds u16")?;
        out.extend(i.to_le_bytes());
    }
    Ok(out)
}

/// Returns None if no safe sharing is possible, preserving the pack exactly.
pub(super) fn adapt_with_profile(
    meta: &pc::Meta,
    raw: &[Box<RawValue>],
    source: &[u8],
    cap: u32,
    profile: Profile,
) -> Result<Option<Batched>> {
    if cap == 0 {
        return Err("texture cap must be positive".into());
    }
    if raw.len() != meta.draws.len() {
        return Err("draw JSON count mismatch".into());
    }
    let limits = profile.limits();
    let mut groups = BTreeMap::<(u32, bool, bool, i64, i64), Vec<usize>>::new();
    let mut vertex_uses = BTreeMap::<(u32, u32), usize>::new();
    for d in &meta.draws {
        *vertex_uses
            .entry((d.vertices.offset, d.vertices.size))
            .or_default() += 1;
    }
    for (i, d) in meta.draws.iter().enumerate() {
        if d.layout != pc::VertexLayout::Baked || d.node.is_some() || d.skin.is_some() {
            continue;
        }
        // A repeat cook must not append an existing shared page once per draw.
        if vertex_uses[&(d.vertices.offset, d.vertices.size)] > 1 {
            continue;
        }
        let m = meta
            .materials
            .get(d.material as usize)
            .ok_or("invalid baked material reference")?;
        if m.blend != pc::Blend::Opaque || !m.depth_write {
            continue;
        }
        if !d.min.iter().chain(&d.max).all(|v| v.is_finite()) {
            return Err("non-finite draw bounds".into());
        }
        let cell =
            |k| (((d.min[k] as f64 + d.max[k] as f64) * 0.5) / limits.cell as f64).floor() as i64;
        groups
            .entry((d.material, d.no_reflect, d.cast_shadow, cell(0), cell(2)))
            .or_default()
            .push(i);
    }
    let mut pages = Vec::new();
    for group in groups.values() {
        partition(meta, source, group, &mut pages, cap, limits)?;
    }
    if pages.is_empty() {
        return Ok(None);
    }
    let mut out = Batched {
        bytes: Vec::new(),
        draws: raw.to_vec(),
        pages: pages.len(),
        shared_draws: pages.iter().map(|p| p.draws.len()).sum(),
        position_error: 0.0,
        uv_error_texels: 0.0,
    };
    let mut draws = meta.draws.clone();
    let mut changed = vec![false; draws.len()];
    for page in pages {
        let vr = append(&mut out.bytes, &page.vertices, 16)?;
        let vertex_count = (page.vertices.len() / 28) as u32;
        for (j, &i) in page.draws.iter().enumerate() {
            changed[i] = true;
            let d = &mut draws[i];
            d.vertices = vr.clone();
            d.vertex_count = vertex_count;
            d.pos_offset = page.pos_offset;
            d.pos_scale = page.pos_scale;
            d.uv_offset = page.uv_offset;
            d.uv_scale = page.uv_scale;
            (d.min, d.max) = page.bounds[j];
            // Both the full mesh and LOD vertices move by at most error.
            for l in &mut d.lods {
                l.error += 2.0 * page.errors[j];
            }
        }
        // No padding between draws within a level: this is the contiguous
        // range contract consumed by the runtime. Empty LODs stay empty.
        let levels = page
            .draws
            .iter()
            .map(|&i| meta.draws[i].lods.len())
            .max()
            .unwrap_or(0);
        for level in 0..=levels {
            for (j, &i) in page.draws.iter().enumerate() {
                let d = &meta.draws[i];
                let (range, count) = if level == 0 {
                    (&d.indices, d.index_count)
                } else if let Some(l) = d.lods.get(level - 1) {
                    (&l.indices, l.index_count)
                } else {
                    continue;
                };
                let data = indices(source, range, count, d.vertex_count, page.bases[j])?;
                let range = append(&mut out.bytes, &data, 2)?;
                if level == 0 {
                    draws[i].indices = range;
                } else {
                    draws[i].lods[level - 1].indices = range;
                }
            }
        }
        out.position_error = out.position_error.max(page.position_error);
        out.uv_error_texels = out.uv_error_texels.max(page.uv_error_texels);
    }
    // Compact untouched payloads without decoding or reordering them. Shared
    // source ranges remain shared; animation and all other sections are outside
    // this function and never change.
    let mut copied = BTreeMap::<(u32, u32), pc::Range>::new();
    for (i, d) in draws.iter_mut().enumerate() {
        if changed[i] {
            continue;
        }
        let mut copy = |r: &mut pc::Range| -> Result<()> {
            let key = (r.offset, r.size);
            if let Some(new) = copied.get(&key) {
                *r = new.clone();
            } else {
                let new = append(&mut out.bytes, slice(source, r)?, 16)?;
                copied.insert(key, new.clone());
                *r = new;
            }
            Ok(())
        };
        copy(&mut d.vertices)?;
        copy(&mut d.indices)?;
        for l in &mut d.lods {
            copy(&mut l.indices)?;
        }
    }
    for (i, d) in draws.iter().enumerate() {
        let mut fields: BTreeMap<String, Box<RawValue>> =
            serde_json::from_str(raw[i].get()).map_err(|e| e.to_string())?;
        let encoded = serde_json::to_value(d).map_err(|e| e.to_string())?;
        let fields_to_update: &[&str] = if changed[i] {
            &[
                "vertices",
                "vertex_count",
                "indices",
                "pos_offset",
                "pos_scale",
                "uv_offset",
                "uv_scale",
                "min",
                "max",
            ]
        } else {
            &["vertices", "indices"]
        };
        for &field in fields_to_update {
            fields.insert(
                field.into(),
                serde_json::value::to_raw_value(&encoded[field]).map_err(|e| e.to_string())?,
            );
        }
        // Preserve unknown LOD fields and the exact lexemes of unchanged errors.
        if let Some(lods) = fields.get("lods") {
            let mut lods: Vec<BTreeMap<String, Box<RawValue>>> =
                serde_json::from_str(lods.get()).map_err(|e| e.to_string())?;
            for (j, l) in lods.iter_mut().enumerate() {
                l.insert(
                    "indices".into(),
                    serde_json::value::to_raw_value(&d.lods[j].indices)
                        .map_err(|e| e.to_string())?,
                );
                if changed[i] {
                    l.insert(
                        "error".into(),
                        serde_json::value::to_raw_value(&d.lods[j].error)
                            .map_err(|e| e.to_string())?,
                    );
                }
            }
            fields.insert(
                "lods".into(),
                serde_json::value::to_raw_value(&lods).map_err(|e| e.to_string())?,
            );
        }
        out.draws[i] = serde_json::value::to_raw_value(&fields).map_err(|e| e.to_string())?;
    }
    Ok(Some(out))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::json;

    fn adapt(
        meta: &pc::Meta,
        raw: &[Box<RawValue>],
        bytes: &[u8],
        cap: u32,
    ) -> Result<Option<Batched>> {
        adapt_with_profile(meta, raw, bytes, cap, Profile::Balanced)
    }

    pub(crate) fn fixture() -> (pc::Meta, Vec<Box<RawValue>>, Vec<u8>) {
        let texture: pc::Texture = serde_json::from_value(json!({
            "name":"test", "role":"color", "format":"rgba8", "width":512,
            "height":512,"mips":1,"data":{"offset":0,"size":1048576},
            "wrap_s":"repeat","wrap_t":"repeat","has_alpha":false
        }))
        .unwrap();
        let mut m = super::super::tests::fixture(&texture);
        m["materials"] = json!([{
            "name":"baked", "kind":"standard", "blend":"opaque", "double_sided":false,
            "depth_write":true,"alpha_test":0,"color":[1,1,1,1],"emissive":[0,0,0],
            "roughness":1,"metalness":0,"normal_scale":1,"ao_strength":1,"env_strength":1,
            "albedo":0,"normal":null,"orm":null,"emission":null,"vertex_color":true,
            "interior":false,"fog":true,"wet":null,"damp":null,"drops":0,"clearcoat":0,
            "polygon_offset":null,"emissive_track":null
        }]);
        m["camera"]["intro"] = json!({"pos":[1,10,50],"target":[0,0,0],"fov":50});
        let mut geometry = Vec::new();
        let mut draws = Vec::new();
        for x in [1.0, 3.0] {
            let mut vertices = Vec::new();
            for (i, p) in [
                [-32767i16, -32767],
                [32767, -32767],
                [32767, 32767],
                [-32767, 32767],
            ]
            .into_iter()
            .enumerate()
            {
                let mut v = [0u8; 28];
                for at in [0, 16] {
                    v[at..at + 2].copy_from_slice(&p[0].to_le_bytes());
                }
                for at in [2, 18] {
                    v[at..at + 2].copy_from_slice(&p[1].to_le_bytes());
                }
                for at in [
                    6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23, 24, 25, 26, 27,
                ] {
                    v[at] = (at + i) as u8;
                }
                vertices.extend(v);
            }
            let vr = append(&mut geometry, &vertices, 16).unwrap();
            let idx: Vec<_> = [0u16, 1, 2, 0, 2, 3]
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect();
            let ir = append(&mut geometry, &idx, 2).unwrap();
            let lr = append(&mut geometry, &idx[..6], 2).unwrap();
            let empty = append(&mut geometry, &[], 2).unwrap();
            draws.push(json!({
                "material":0,"layout":"baked","vertices":vr,"vertex_count":4,
                "indices":ir,"index_count":6,"pos_offset":[x,1,1],"pos_scale":[1,1,1],
                "uv_offset":[0.5,0.5],"uv_scale":[0.5,0.5],"min":[x-1.0,0,1],"max":[x+1.0,2,1],
                "node":null,"skin":null,"no_reflect":false,"cast_shadow":true,
                "lods":[{"indices":lr,"index_count":3,"error":0.06,"future_lod":"keep"},
                    {"indices":empty,"index_count":0,"error":0.25}],"future_draw":{"keep":true}
            }));
        }
        m["draws"] = json!(draws);
        let raw = draws
            .iter()
            .map(|d| serde_json::value::to_raw_value(d).unwrap())
            .collect();
        (serde_json::from_value(m).unwrap(), raw, geometry)
    }

    fn output_meta(meta: &pc::Meta, batch: &Batched) -> pc::Meta {
        let mut meta = meta.clone();
        meta.draws = batch
            .draws
            .iter()
            .map(|v| serde_json::from_str(v.get()).unwrap())
            .collect();
        meta
    }

    fn assert_shape(before: &pc::Meta, source: &[u8], after: &pc::Meta, output: &[u8]) {
        assert_shape_with_profile(before, source, after, output, Profile::Balanced);
    }

    pub(crate) fn assert_shape_with_profile(
        before: &pc::Meta,
        source: &[u8],
        after: &pc::Meta,
        output: &[u8],
        profile: Profile,
    ) {
        assert_eq!(before.draws.len(), after.draws.len());
        for (i, (a, b)) in before.draws.iter().zip(&after.draws).enumerate() {
            assert_eq!(
                (
                    a.material,
                    a.layout,
                    a.node,
                    a.skin,
                    a.no_reflect,
                    a.cast_shadow
                ),
                (
                    b.material,
                    b.layout,
                    b.node,
                    b.skin,
                    b.no_reflect,
                    b.cast_shadow
                )
            );
            assert_eq!(a.lods.len(), b.lods.len());
            let av = slice(source, &a.vertices).unwrap();
            let bv = slice(output, &b.vertices).unwrap();
            let stride = a.layout.stride() as usize;
            if a.layout == pc::VertexLayout::Lights {
                assert_eq!(av, bv);
                continue;
            }
            for (ar, ac, br, bc) in
                std::iter::once((&a.indices, a.index_count, &b.indices, b.index_count)).chain(
                    a.lods
                        .iter()
                        .zip(&b.lods)
                        .map(|(a, b)| (&a.indices, a.index_count, &b.indices, b.index_count)),
                )
            {
                assert_eq!(ac, bc, "draw {i}: triangles");
                for (ai, bi) in slice(source, ar)
                    .unwrap()
                    .chunks_exact(2)
                    .zip(slice(output, br).unwrap().chunks_exact(2))
                {
                    let ai = u16::from_le_bytes(ai.try_into().unwrap()) as usize * stride;
                    let bi = u16::from_le_bytes(bi.try_into().unwrap()) as usize * stride;
                    let (va, vb) = (&av[ai..ai + stride], &bv[bi..bi + stride]);
                    // Matching every indexed vertex in sequence checks winding
                    // and topology, including all LODs, rather than totals only.
                    if a.layout != pc::VertexLayout::Baked
                        || a.node.is_some()
                        || a.skin.is_some()
                        || before.materials[a.material as usize].blend != pc::Blend::Opaque
                    {
                        assert_eq!(va, vb, "untouched draw {i}");
                        continue;
                    }
                    assert_eq!(&va[6..16], &vb[6..16]);
                    assert_eq!(&va[20..], &vb[20..]);
                    let ap = Vec3::from_array(std::array::from_fn(|k| {
                        decode(va, k * 2, a.pos_scale[k], a.pos_offset[k])
                    }));
                    let bp = Vec3::from_array(std::array::from_fn(|k| {
                        decode(vb, k * 2, b.pos_scale[k], b.pos_offset[k])
                    }));
                    assert!(
                        ap.distance(bp) <= position_limit(before, ap, profile.limits()) + 1e-8,
                        "draw {i}: position"
                    );
                    for k in 0..2 {
                        let au = decode(va, 16 + k * 2, a.uv_scale[k], a.uv_offset[k]);
                        let bu = decode(vb, 16 + k * 2, b.uv_scale[k], b.uv_offset[k]);
                        assert!(
                            (au - bu).abs() * texel_scale(before, a.material, 512)[k]
                                <= profile.limits().texels + 1e-6,
                            "draw {i}: UV"
                        );
                    }
                }
            }
            for (a, b) in a.lods.iter().zip(&b.lods) {
                assert!(b.error >= a.error);
            }
        }
    }

    #[test]
    fn pages_preserve_draw_ids_attributes_and_every_lod_topology() {
        let (m, raw, geometry) = fixture();
        let out = adapt(&m, &raw, &geometry, 512).unwrap().unwrap();
        assert_eq!((out.pages, out.shared_draws), (1, 2));
        let after = output_meta(&m, &out);
        let (a, b) = (&after.draws[0], &after.draws[1]);
        assert_eq!(a.vertices.offset, b.vertices.offset);
        assert_eq!((a.vertex_count, b.vertex_count), (8, 8));
        assert_eq!(a.indices.offset + a.indices.size, b.indices.offset);
        assert_eq!(
            a.lods[0].indices.offset + a.lods[0].indices.size,
            b.lods[0].indices.offset
        );
        assert_eq!((a.lods[1].index_count, b.lods[1].index_count), (0, 0));
        assert_shape(&m, &geometry, &after, &out.bytes);
        assert!(out.draws[0].get().contains("\"future_lod\":\"keep\""));
        assert!(out.draws[0]
            .get()
            .contains("\"future_draw\":{\"keep\":true}"));
        assert!(
            adapt(&after, &out.draws, &out.bytes, 512)
                .unwrap()
                .is_none(),
            "repeat cook must not duplicate page"
        );
    }

    #[test]
    fn transparent_moving_and_skinned_draws_never_enter_pages() {
        for mode in 0..3 {
            let (mut m, raw, geometry) = fixture();
            match mode {
                0 => m.materials[0].blend = pc::Blend::Alpha,
                1 => m.draws[0].node = Some(0),
                _ => {
                    m.draws[0].skin = Some(0);
                    m.draws[0].layout = pc::VertexLayout::Skinned;
                }
            }
            assert!(adapt(&m, &raw, &geometry, 512).unwrap().is_none());
        }
    }

    #[test]
    fn packed_pages_leave_animation_and_unknown_metadata_byte_exact() {
        let (m, raw, geometry) = fixture();
        let mut fields: BTreeMap<String, Box<RawValue>> =
            serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        fields.insert(
            "draws".into(),
            serde_json::value::to_raw_value(&raw).unwrap(),
        );
        fields.insert(
            "future_value".into(),
            RawValue::from_string("-2.4492937e-16".into()).unwrap(),
        );
        let meta = serde_json::to_vec(&fields).unwrap();
        let animation: Vec<_> = (0..m.frames * 7)
            .flat_map(|i| (i as f32 / 7.0).to_le_bytes())
            .collect();
        let texels = vec![255; 512 * 512 * 4];
        let source = pc::write(&[
            (pc::TAG_META, &meta, 16),
            (pc::TAG_GEOMETRY, &geometry, 16),
            (pc::TAG_TEXTURES, &texels, 16),
            (pc::TAG_ANIMATION, &animation, 16),
            (*b"XTRA", b"future section", 16),
        ]);
        let output = super::super::adapt(&source, 512).unwrap();
        let pack = pc::Pack::parse(&output.bytes).unwrap();
        assert_eq!(pack.section(pc::TAG_ANIMATION).unwrap(), animation);
        assert_eq!(pack.section(*b"XTRA").unwrap(), b"future section");
        let after: BTreeMap<String, Box<RawValue>> =
            serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
        for (key, value) in &fields {
            if key != "draws" && key != "textures" {
                assert_eq!(value.get(), after[key].get(), "{key}");
            }
        }
        assert_shape(
            &m,
            &geometry,
            &pack.meta().unwrap(),
            pack.section(pc::TAG_GEOMETRY).unwrap(),
        );
    }

    #[test]
    fn existing_shared_pages_are_not_duplicated_when_other_draws_are_present() {
        let (m, raw, geometry) = fixture();
        let first = adapt(&m, &raw, &geometry, 512).unwrap().unwrap();
        let mut meta = output_meta(&m, &first);
        let mut bytes = first.bytes.clone();
        let mut third = m.draws[0].clone();
        third.vertices =
            append(&mut bytes, slice(&geometry, &third.vertices).unwrap(), 16).unwrap();
        third.indices = append(&mut bytes, slice(&geometry, &third.indices).unwrap(), 2).unwrap();
        for l in &mut third.lods {
            l.indices = append(&mut bytes, slice(&geometry, &l.indices).unwrap(), 2).unwrap();
        }
        meta.draws.push(third);
        let raw: Vec<_> = meta
            .draws
            .iter()
            .map(|d| serde_json::value::to_raw_value(d).unwrap())
            .collect();
        assert!(adapt(&meta, &raw, &bytes, 512).unwrap().is_none());
    }

    #[test]
    fn malformed_indices_and_vertex_ranges_return_errors() {
        let (m, raw, mut geometry) = fixture();
        let at = m.draws[1].indices.offset as usize;
        geometry[at..at + 2].copy_from_slice(&99u16.to_le_bytes());
        assert!(adapt(&m, &raw, &geometry, 512)
            .err()
            .unwrap()
            .contains("index exceeds"));
        let (mut m, raw, geometry) = fixture();
        m.draws[1].vertices.offset = u32::MAX - 4;
        assert!(adapt(&m, &raw, &geometry, 512)
            .err()
            .unwrap()
            .contains("range overflow"));
        assert!(indices(
            &[255, 255, 0, 0, 0, 0],
            &pc::Range { offset: 0, size: 6 },
            3,
            65536,
            1
        )
        .is_err());
    }

    #[test]
    fn spatial_precision_telephoto_and_u16_limits_are_enforced() {
        let (mut m, raw, geometry) = fixture();
        m.draws[1].min[0] += 64.0;
        m.draws[1].max[0] += 64.0;
        assert!(adapt(&m, &raw, &geometry, 512).unwrap().is_none());
        let (mut m, raw, geometry) = fixture();
        m.draws[1].uv_scale[0] = 1333.0;
        assert!(adapt(&m, &raw, &geometry, 512).unwrap().is_none());
        let (mut m, _, _) = fixture();
        m.camera.intro.pos = [0.0, 0.0, 1.0];
        m.camera.intro.fov = 50.0;
        let wide = position_limit(&m, Vec3::ZERO, Profile::Balanced.limits());
        m.camera.intro.fov = 3.0;
        assert!(position_limit(&m, Vec3::ZERO, Profile::Balanced.limits()) < wide / 8.0);
        let (mut m, raw, geometry) = fixture();
        m.draws[1].vertex_count = 65535;
        assert!(adapt(&m, &raw, &geometry, 512).unwrap().is_none());
    }

    #[test]
    fn uv_error_uses_the_adapted_nonsquare_texture_dimensions() {
        let (mut m, raw, geometry) = fixture();
        m.textures[0].width = 4096;
        m.textures[0].height = 256;
        assert_eq!(texel_scale(&m, 0, 512), [512.0, 32.0]);
        assert_eq!(texel_scale(&m, 0, 300), [256.0, 16.0]);
        assert!(adapt(&m, &raw, &geometry, 0).is_err());
    }

    #[test]
    fn throughput_is_explicit_and_preserves_topology_across_balanced_cells() {
        assert_eq!(Profile::parse("balanced").unwrap(), Profile::Balanced);
        assert_eq!(Profile::parse("throughput").unwrap(), Profile::Throughput);
        assert!(Profile::parse("conservative").is_err());
        let (mut m, _, geometry) = fixture();
        m.draws[1].pos_offset[0] += 64.0;
        m.draws[1].min[0] += 64.0;
        m.draws[1].max[0] += 64.0;
        let raw: Vec<_> = m
            .draws
            .iter()
            .map(|d| serde_json::value::to_raw_value(d).unwrap())
            .collect();
        assert!(adapt(&m, &raw, &geometry, 512).unwrap().is_none());
        let output = adapt_with_profile(&m, &raw, &geometry, 512, Profile::Throughput)
            .unwrap()
            .unwrap();
        assert_shape_with_profile(
            &m,
            &geometry,
            &output_meta(&m, &output),
            &output.bytes,
            Profile::Throughput,
        );
        assert_eq!((output.pages, output.shared_draws), (1, 2));
    }

    #[test]
    #[ignore = "set POCKET_ATLAS_GLES_SOURCES to the canonical places directory"]
    fn verifies_real_scene_topology_and_payload_attributes() {
        let root = std::env::var("POCKET_ATLAS_GLES_SOURCES").expect("source directory");
        let mut count = 0;
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_dir() {
                continue;
            }
            let path = entry
                .path()
                .join(format!("{}.place", entry.file_name().to_string_lossy()));
            if !path.is_file() {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let pack = pc::Pack::parse(&bytes).unwrap();
            let m = pack.meta().unwrap();
            let raw: BTreeMap<String, Box<RawValue>> =
                serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
            let raw: Vec<Box<RawValue>> = serde_json::from_str(raw["draws"].get()).unwrap();
            let geometry = pack.section(pc::TAG_GEOMETRY).unwrap();
            for profile in [Profile::Balanced, Profile::Throughput] {
                if let Some(out) = adapt_with_profile(&m, &raw, geometry, 512, profile).unwrap() {
                    assert_shape_with_profile(
                        &m,
                        geometry,
                        &output_meta(&m, &out),
                        &out.bytes,
                        profile,
                    );
                    println!(
                        "{} ({}): {} pages / {} shared draws; {:.6} m / {:.5} texels; GEOM {} -> {}",
                        path.display(), profile.name(), out.pages, out.shared_draws,
                        out.position_error, out.uv_error_texels, geometry.len(), out.bytes.len()
                    );
                }
            }
            count += 1;
        }
        assert!(count > 0, "no source packs found");
    }
}
