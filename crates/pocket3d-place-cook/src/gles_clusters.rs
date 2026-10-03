//! Optional connected-part LOD groups and lossless visibility clusters.
//! The original PLIP, attributes, full geometry and every LOD remain untouched.
use pocket3d_place as pc;
use std::collections::BTreeMap;
type Result<T> = std::result::Result<T, String>;
const CELL: f64 = 16.0;
const PART_CELL: f64 = 4.0;
// A4 moving-view measurements make tiny per-face query/cache records costly.
// Split only substantial spatial clusters; the source/group/LOD policy stays
// unchanged and smaller mixed-orientation clusters remain conservatively visible.
const MIN_FACING_SPLIT_TRIANGLES: usize = 24;
const HEADER: usize = 56;
fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    })
}
fn word(bytes: &mut Vec<u8>, n: usize) -> Result<()> {
    bytes.extend(
        u32::try_from(n)
            .map_err(|_| "cluster payload exceeds u32")?
            .to_le_bytes(),
    );
    Ok(())
}
fn eligible(meta: &pc::Meta, d: &pc::Draw) -> bool {
    d.layout == pc::VertexLayout::Baked
        && d.node.is_none()
        && d.skin.is_none()
        && meta.materials.get(d.material as usize).is_some_and(|m| {
            m.kind == pc::Kind::Standard && m.blend == pc::Blend::Opaque && m.depth_write
        })
}
#[derive(Clone)]
struct Bounds {
    min: [f32; 3],
    max: [f32; 3],
}
impl Bounds {
    fn new() -> Self {
        Self {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        }
    }
    fn point(&mut self, p: [f32; 3]) {
        for k in 0..3 {
            self.min[k] = self.min[k].min(p[k]);
            self.max[k] = self.max[k].max(p[k]);
        }
    }
    fn extend(&mut self, b: &Self) {
        self.point(b.min);
        self.point(b.max);
    }
    fn padded(&self, d: &pc::Draw) -> Self {
        let mut b = self.clone();
        for k in 0..3 {
            let pad =
                d.pos_scale[k].abs() * 2e-6 + b.min[k].abs().max(b.max[k].abs()) * 2e-7 + 1e-5;
            b.min[k] -= pad;
            b.max[k] += pad;
        }
        b
    }
    fn bytes(&self, d: &pc::Draw, out: &mut Vec<u8>) {
        let b = self.padded(d);
        for n in b.min.into_iter().chain(b.max) {
            out.extend(n.to_le_bytes());
        }
    }
}
struct Cluster {
    indices: Vec<u16>,
    bounds: Bounds,
}
struct Group {
    bounds: Bounds,
    levels: Vec<BTreeMap<[i64; 3], Cluster>>,
}
fn groups(d: &pc::Draw, lods: &[pc::DrawLod], geometry: &[u8]) -> Result<Vec<Group>> {
    let roots = pc::ipod::components(d, geometry)?;
    let mut parts = BTreeMap::<u32, Bounds>::new();
    for (i, &r) in roots.iter().enumerate() {
        if r != u32::MAX {
            parts
                .entry(r)
                .or_insert_with(Bounds::new)
                .point(pc::ipod::position(d, geometry, i as u16)?);
        }
    }
    let mut bins = BTreeMap::<[i64; 3], Group>::new();
    let mut cells = BTreeMap::new();
    for (r, b) in parts {
        let cell = core::array::from_fn(|k| {
            ((b.min[k] as f64 + b.max[k] as f64) / (2.0 * PART_CELL)).floor() as i64
        });
        cells.insert(r, cell);
        let group = bins.entry(cell).or_insert_with(|| Group {
            bounds: Bounds::new(),
            levels: (0..=lods.len()).map(|_| BTreeMap::new()).collect(),
        });
        group.bounds.extend(&b);
    }
    for (level, (range, count)) in core::iter::once((&d.indices, d.index_count))
        .chain(lods.iter().map(|l| (&l.indices, l.index_count)))
        .enumerate()
    {
        if count % 3 != 0 || count.checked_mul(2) != Some(range.size) {
            return Err("cluster source index count".into());
        }
        for tri in pc::parts::slice(geometry, range)?.chunks_exact(6) {
            let ids: [u16; 3] =
                core::array::from_fn(|k| u16::from_le_bytes([tri[k * 2], tri[k * 2 + 1]]));
            let root = roots
                .get(ids[0] as usize)
                .copied()
                .ok_or("part index out of bounds")?;
            if root == u32::MAX || ids.iter().any(|&i| roots.get(i as usize) != Some(&root)) {
                return Err("LOD triangle crosses full connected components".into());
            }
            let positions = [
                pc::ipod::position(d, geometry, ids[0])?,
                pc::ipod::position(d, geometry, ids[1])?,
                pc::ipod::position(d, geometry, ids[2])?,
            ];
            let cell = core::array::from_fn(|k| {
                ((positions[0][k] as f64 + positions[1][k] as f64 + positions[2][k] as f64)
                    / (3.0 * CELL))
                    .floor() as i64
            });
            let group = bins.get_mut(&cells[&root]).unwrap();
            let cluster = group.levels[level].entry(cell).or_insert_with(|| Cluster {
                indices: Vec::new(),
                bounds: Bounds::new(),
            });
            cluster.indices.extend(ids);
            for p in positions {
                cluster.bounds.point(p);
                group.bounds.point(p);
            }
        }
    }
    Ok(bins.into_values().collect())
}
fn oriented(
    meta: &pc::Meta,
    d: &pc::Draw,
    g: &[u8],
    clusters: BTreeMap<[i64; 3], Cluster>,
) -> Result<Vec<Cluster>> {
    let mut out = Vec::new();
    for (_, c) in clusters {
        if !pc::ipod::backface::eligible(meta, d)
            || c.indices.len() / 3 < MIN_FACING_SPLIT_TRIANGLES
        {
            out.push(c);
            continue;
        }
        let mut buckets: BTreeMap<u8, Vec<u16>> = BTreeMap::new();
        for t in c.indices.chunks_exact(3) {
            let positions = [
                pc::ipod::position(d, g, t[0])?,
                pc::ipod::position(d, g, t[1])?,
                pc::ipod::position(d, g, t[2])?,
            ];
            buckets
                .entry(pc::ipod::backface::bucket(positions))
                .or_default()
                .extend_from_slice(t);
        }
        for indices in buckets.into_values() {
            out.push(Cluster {
                indices,
                bounds: c.bounds.clone(),
            });
        }
    }
    Ok(out)
}
pub(super) fn adapt(source: &[u8]) -> Result<Vec<u8>> {
    let pack = pc::ipod::parse(source).map_err(|e| e.to_string())?;
    let meta_bytes = pack.section(pc::TAG_META).map_err(|e| e.to_string())?;
    let metadata: pc::ipod::Metadata =
        serde_json::from_slice(meta_bytes).map_err(|e| e.to_string())?;
    let meta = metadata.scene;
    let effective = pc::ipod::display_lods::EffectiveLods::new(&meta, &metadata.ipod_recipes)?;
    let geometry = pack.section(pc::TAG_GEOMETRY).map_err(|e| e.to_string())?;
    let (mut draws, mut group_data, mut levels, mut bounds, mut indices) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut ng, mut nl, mut nc, mut ni) = (0, 0, 0, 0);
    for (di, d) in meta.draws.iter().enumerate() {
        let lods = effective.get(&meta, di);
        word(&mut draws, ng)?;
        if !eligible(&meta, d) {
            word(&mut draws, 0)?;
            continue;
        }
        let all = groups(d, lods, geometry)?;
        // Decide membership from the original spatial partition, before
        // orientation splitting. Otherwise a formerly raw draw could acquire
        // a different group bound and therefore a different LOD decision.
        if all.is_empty() || (all.len() == 1 && all[0].levels.iter().all(|l| l.len() <= 1)) {
            word(&mut draws, 0)?;
            continue;
        }
        word(&mut draws, all.len())?;
        ng += all.len();
        for group in all {
            word(&mut group_data, nl)?;
            word(&mut group_data, group.levels.len())?;
            group.bounds.bytes(d, &mut group_data);
            for (k, clusters) in group.levels.into_iter().enumerate() {
                let clusters = oriented(&meta, d, geometry, clusters)?;
                let error = if k == 0 { 0.0 } else { lods[k - 1].error };
                levels.extend(error.to_le_bytes());
                word(&mut levels, nc)?;
                word(&mut levels, clusters.len())?;
                nl += 1;
                nc += clusters.len();
                for c in clusters {
                    word(&mut bounds, ni)?;
                    word(&mut bounds, c.indices.len())?;
                    c.bounds.bytes(d, &mut bounds);
                    let b = c.bounds.padded(d);
                    let facing = if pc::ipod::backface::eligible(&meta, d) {
                        pc::ipod::backface::build(d, geometry, &c.indices, b.min, b.max)?
                    } else {
                        Default::default()
                    };
                    for value in facing.values() {
                        bounds.extend(value.to_le_bytes());
                    }
                    ni += c.indices.len();
                    for i in c.indices {
                        indices.extend(i.to_le_bytes());
                    }
                }
            }
        }
    }
    let mut out = vec![0u8; HEADER];
    out.extend(draws);
    out.extend(group_data);
    out.extend(levels);
    out.extend(bounds);
    out.extend(indices);
    out[..4].copy_from_slice(b"IPCL");
    out[4..8].copy_from_slice(&3u32.to_le_bytes());
    for (at, h) in [
        (8, hash(meta_bytes)),
        (16, hash(geometry)),
        (24, hash(&out[HEADER..])),
    ] {
        out[at..at + 8].copy_from_slice(&h.to_le_bytes());
    }
    for (at, n) in [
        (32, meta.draws.len()),
        (36, ng),
        (40, nl),
        (44, nc),
        (48, ni),
    ] {
        out[at..at + 4].copy_from_slice(
            &u32::try_from(n)
                .map_err(|_| "cluster payload exceeds u32")?
                .to_le_bytes(),
        );
    }
    Ok(out)
}

#[cfg(test)]
#[path = "../../../ipod/src/mesh_clusters.rs"]
pub(super) mod runtime;
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (pc::Meta, Vec<u8>) {
        let (mut m, _, mut g) = super::super::gles_geometry::tests::fixture();
        for d in &mut m.draws {
            for v in
                g[d.vertices.offset as usize..][..d.vertices.size as usize].chunks_exact_mut(56)
            {
                let x = f32::from_le_bytes(v[..4].try_into().unwrap()) * 32.;
                v[..4].copy_from_slice(&x.to_le_bytes());
            }
            d.min[0] -= 32.;
            d.max[0] += 32.;
        }
        (m, g)
    }
    fn source(m: &pc::Meta, g: &[u8]) -> Vec<u8> {
        pc::write_versioned(
            pc::ipod::MAGIC,
            pc::ipod::VERSION,
            &[
                (pc::TAG_META, &serde_json::to_vec(m).unwrap(), 16),
                (pc::TAG_GEOMETRY, g, 16),
                (pc::TAG_TEXTURES, &[], 16),
                (pc::TAG_ANIMATION, &[], 16),
            ],
        )
    }
    fn read(bytes: &[u8], source: &[u8]) -> Result<runtime::MeshClusters> {
        let p = pc::ipod::parse(source).unwrap();
        runtime::MeshClusters::parse(
            bytes,
            &p.meta().unwrap(),
            p.section(pc::TAG_META).unwrap(),
            p.section(pc::TAG_GEOMETRY).unwrap(),
        )
    }
    #[test]
    fn exact_full_and_each_lod_roundtrip_without_changing_source() {
        let (m, g) = fixture();
        let src = source(&m, &g);
        let copy = src.clone();
        let bytes = adapt(&src).unwrap();
        let out = read(&bytes, &src).unwrap();
        assert_eq!(src, copy);
        assert_eq!(bytes, adapt(&src).unwrap());
        for (i, d) in m.draws.iter().enumerate() {
            for (k, n) in core::iter::once(d.index_count)
                .chain(d.lods.iter().map(|l| l.index_count))
                .enumerate()
            {
                let count: usize = out
                    .groups(i)
                    .unwrap()
                    .iter()
                    .flat_map(|g| out.clusters(&out.levels(g)[k]))
                    .map(|c| out.indices(c).len())
                    .sum();
                assert_eq!(count, n as usize);
            }
        }
        assert!(out.groups(100).is_none());
        assert_eq!(out.bytes() - out.query_bytes() + HEADER, bytes.len());
    }
    #[test]
    fn v3_facing_proof_is_recomputed_and_v2_stays_readable() {
        let (mut m, g) = separate_parts();
        m.draws[0].pos_scale = [1.; 3];
        let source = source(&m, &g);
        let bytes = adapt(&source).unwrap();
        let groups = u32::from_le_bytes(bytes[36..40].try_into().unwrap()) as usize;
        let levels = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(bytes[44..48].try_into().unwrap()) as usize;
        let at = HEADER + m.draws.len() * 8 + groups * 32 + levels * 12;
        for value in [f32::NAN, 0., 0.00001] {
            let mut bad = bytes.clone();
            bad[at + 32 + 5 * 4..at + 56].copy_from_slice(&value.to_le_bytes());
            rehash(&mut bad);
            assert!(read(&bad, &source).is_err());
        }
        let mut old = bytes[..at].to_vec();
        old[4..8].copy_from_slice(&2u32.to_le_bytes());
        for c in bytes[at..at + count * 56].chunks_exact(56) {
            old.extend_from_slice(&c[..32]);
        }
        old.extend_from_slice(&bytes[at + count * 56..]);
        rehash(&mut old);
        let legacy = read(&old, &source).unwrap();
        let modern = read(&bytes, &source).unwrap();
        let view = runtime::Query::new([[0., 0., 0., 1.]; 6], [0., 0., -100.], 0.00001);
        let mut a = 0;
        let mut b = 0;
        legacy.query(0, &view, |_, _, _, c| a += legacy.indices(&c).len());
        modern.query(0, &view, |_, _, _, c| b += modern.indices(&c).len());
        assert!(a > 0);
        assert_eq!(b, 0);
    }
    fn rehash(bytes: &mut [u8]) {
        let h = hash(&bytes[HEADER..]);
        bytes[24..32].copy_from_slice(&h.to_le_bytes());
    }
    #[test]
    fn orientation_split_does_not_add_formerly_raw_draws() {
        let (mut m, mut g) = separate_parts();
        let d = &mut m.draws[0];
        d.pos_scale = [1.; 3];
        // Two disconnected, oppositely wound patches in the same original
        // part cell and triangle cell would produce two orientation buckets.
        for i in 0..8 {
            let x = (i % 4 == 1 || i % 4 == 2) as u8 as f32 + (i / 4) as f32 * 2.;
            g[i * 56..i * 56 + 4].copy_from_slice(&x.to_le_bytes());
        }
        for range in core::iter::once(&d.indices).chain(d.lods.iter().map(|l| &l.indices)) {
            for tri in g[range.offset as usize..][..range.size as usize].chunks_exact_mut(6) {
                if u16::from_le_bytes(tri[..2].try_into().unwrap()) >= 4 {
                    tri.swap(2, 4);
                    tri.swap(3, 5);
                }
            }
        }
        let original = pc::parts::slice(&g, &d.indices).unwrap().to_vec();
        d.indices.offset = g.len() as u32;
        for _ in 0..6 {
            g.extend(&original);
        }
        d.indices.size = original.len() as u32 * 6;
        d.index_count = d.indices.size / 2;
        d.lods.clear();
        let all = groups(d, &d.lods, &g).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].levels[0].len(), 1);
        let clusters = oriented(
            &m,
            &m.draws[0],
            &g,
            all.into_iter().next().unwrap().levels.remove(0),
        )
        .unwrap();
        assert_eq!(clusters.len(), 2);
        let src = source(&m, &g);
        assert!(read(&adapt(&src).unwrap(), &src)
            .unwrap()
            .groups(0)
            .is_none());
    }
    #[test]
    fn facing_threshold_preserves_23_and_24_triangle_lods_exactly() {
        let (mut meta, mut geometry) = separate_parts();
        let d = &mut meta.draws[0];
        d.pos_scale = [1.; 3];
        d.min = [0.; 3];
        d.max = [33., 1., 0.];
        geometry.truncate(8 * 56);
        // Two opposite-facing complete parts occupy one original spatial
        // cluster. A distant third part keeps the old draw membership active.
        for i in 0..8 {
            let x = (i % 4 == 1 || i % 4 == 2) as u8 as f32 + (i / 4) as f32 * 2.;
            geometry[i * 56..i * 56 + 4].copy_from_slice(&x.to_le_bytes());
        }
        for p in [[32f32, 0., 0.], [33., 0., 0.], [32., 1., 0.]] {
            let mut vertex = [0u8; 56];
            for k in 0..3 {
                vertex[k * 4..k * 4 + 4].copy_from_slice(&p[k].to_le_bytes());
            }
            geometry.extend(vertex);
        }
        d.vertex_count = 11;
        d.vertices.size = 11 * 56;
        let mut levels = Vec::new();
        for n in [24usize, 23] {
            let start = geometry.len();
            for i in 0..n {
                for index in if i % 2 == 0 { [0u16, 1, 2] } else { [4, 6, 5] } {
                    geometry.extend(index.to_le_bytes());
                }
            }
            for index in [8u16, 9, 10] {
                geometry.extend(index.to_le_bytes());
            }
            levels.push(pc::Range {
                offset: start as u32,
                size: (geometry.len() - start) as u32,
            });
        }
        d.indices = levels[0].clone();
        d.index_count = levels[0].size / 2;
        d.lods = vec![pc::DrawLod {
            indices: levels[1].clone(),
            index_count: levels[1].size / 2,
            error: 0.02,
        }];
        let src = source(&meta, &geometry);
        let copy = src.clone();
        let bytes = adapt(&src).unwrap();
        let out = read(&bytes, &src).unwrap(); // re-proves every exact multiset
        assert_eq!(src, copy);
        assert_eq!(bytes, adapt(&src).unwrap());
        let groups = out.groups(0).unwrap();
        assert_eq!(groups.len(), 2);
        let levels = out.levels(&groups[0]);
        assert_eq!(
            levels.iter().map(|l| l.error).collect::<Vec<_>>(),
            [0., 0.02]
        );
        assert_eq!(out.clusters(&levels[0]).len(), 2);
        assert_eq!(out.clusters(&levels[1]).len(), 1);
        let cluster = &out.clusters(&levels[1])[0];
        let expected: Vec<u16> = (0..23)
            .flat_map(|i| if i % 2 == 0 { [0, 1, 2] } else { [4, 6, 5] })
            .collect();
        assert_eq!(out.indices(cluster), expected); // no small-cluster reorder
        assert!(pc::ipod::backface::build(
            &meta.draws[0],
            &geometry,
            out.indices(cluster),
            cluster.min,
            cluster.max
        )
        .unwrap()
        .disabled());
    }
    fn separate_parts() -> (pc::Meta, Vec<u8>) {
        let (mut m, _) = fixture();
        m.draws.truncate(1);
        let d = &mut m.draws[0];
        d.pos_offset = [0.0; 3];
        d.pos_scale = [16.0, 1.0, 1.0];
        d.min = [-8.0, 0.0, 0.0];
        d.max = [9.0, 1.0, 0.0];
        d.vertex_count = 8;
        d.vertices = pc::Range {
            offset: 0,
            size: 8 * 56,
        };
        let mut g = vec![0; 8 * 56];
        for (i, p) in [
            [-8.0, 0.0],
            [-7.0, 0.0],
            [-7.0, 1.0],
            [-8.0, 1.0],
            [8.0, 0.0],
            [9.0, 0.0],
            [9.0, 1.0],
            [8.0, 1.0],
        ]
        .iter()
        .enumerate()
        {
            for k in 0..2 {
                g[i * 56 + k * 4..i * 56 + k * 4 + 4].copy_from_slice(&(p[k] as f32).to_le_bytes());
            }
        }
        d.indices = pc::Range {
            offset: g.len() as u32,
            size: 24,
        };
        d.index_count = 12;
        for i in [0u16, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7] {
            g.extend(i.to_le_bytes());
        }
        d.lods = vec![
            pc::DrawLod {
                indices: pc::Range {
                    offset: g.len() as u32,
                    size: 12,
                },
                index_count: 6,
                error: 0.02,
            },
            pc::DrawLod {
                indices: pc::Range {
                    offset: g.len() as u32 + 12,
                    size: 0,
                },
                index_count: 0,
                error: 0.1,
            },
        ];
        for i in [0u16, 1, 2, 4, 5, 6] {
            g.extend(i.to_le_bytes());
        }
        (m, g)
    }
    #[test]
    fn whole_parts_keep_every_lod_and_empty_levels_without_cross_group_holes() {
        let (m, g) = separate_parts();
        let src = source(&m, &g);
        let bytes = adapt(&src).unwrap();
        let out = read(&bytes, &src).unwrap();
        let groups = out.groups(0).unwrap();
        assert_eq!(groups.len(), 2);
        for group in groups {
            let levels = out.levels(group);
            assert_eq!(levels.len(), 3);
            assert_eq!(
                levels.iter().map(|l| l.error).collect::<Vec<_>>(),
                [0.0, 0.02, 0.1]
            );
            assert_eq!(
                out.clusters(&levels[0])
                    .iter()
                    .map(|c| out.indices(c).len())
                    .sum::<usize>(),
                6
            );
            assert_eq!(
                out.clusters(&levels[1])
                    .iter()
                    .map(|c| out.indices(c).len())
                    .sum::<usize>(),
                3
            );
            assert!(out.clusters(&levels[2]).is_empty());
            let copied = out.clusters(&levels[0])[0];
            assert_eq!(out.indices(&copied).len(), 6);
        }
        // A valid source index and legal byte range cannot justify connecting
        // two originally disconnected components in a new LOD.
        let mut changed = g.clone();
        let at = m.draws[0].lods[0].indices.offset as usize;
        changed[at + 2..at + 4].copy_from_slice(&4u16.to_le_bytes());
        assert!(adapt(&source(&m, &changed))
            .unwrap_err()
            .contains("crosses"));
        // Rehash and widen all bounds so only component ownership catches the
        // full triangles deliberately split between groups. Global multisets
        // still match exactly after the triangle swap.
        let mut bad = bytes.clone();
        let groups_at = HEADER + 8;
        let levels_at = groups_at + 2 * 32;
        let clusters_at = levels_at + 6 * 12;
        let index_at = clusters_at + 4 * 56;
        let a = bad[index_at..index_at + 6].to_vec();
        let b = bad[index_at + 18..index_at + 24].to_vec();
        bad[index_at..index_at + 6].copy_from_slice(&b);
        bad[index_at + 18..index_at + 24].copy_from_slice(&a);
        for at in [
            groups_at,
            groups_at + 32,
            clusters_at,
            clusters_at + 56,
            clusters_at + 112,
            clusters_at + 168,
        ] {
            for k in 0..3 {
                bad[at + 8 + k * 4..at + 12 + k * 4].copy_from_slice(&(-100f32).to_le_bytes());
                bad[at + 20 + k * 4..at + 24 + k * 4].copy_from_slice(&100f32.to_le_bytes());
            }
        }
        rehash(&mut bad);
        assert!(read(&bad, &src).err().unwrap().contains("component"));
    }
    #[test]
    fn components_join_position_seams_but_ignore_unreferenced_page_vertices() {
        let (mut m, mut g) = separate_parts();
        // Join the independent faces through one exact position seam while
        // retaining their separate UV/color vertex identities.
        let pos = g[..12].to_vec();
        g[4 * 56..4 * 56 + 12].copy_from_slice(&pos);
        let d = &m.draws[0];
        let roots = pc::ipod::components(d, &g).unwrap();
        assert!(roots.iter().all(|r| *r == roots[0]));
        // A large shared page may include vertices unused by this draw.
        m.draws[0].index_count = 6;
        m.draws[0].indices.size = 12;
        let roots = pc::ipod::components(&m.draws[0], &g).unwrap();
        assert!(roots[..4].iter().all(|r| *r != u32::MAX));
        assert!(roots[4..].iter().all(|r| *r == u32::MAX));
    }
    #[test]
    fn source_identity_and_malformed_ranges_bounds_and_triangles_fail() {
        let (m, g) = fixture();
        let src = source(&m, &g);
        let bytes = adapt(&src).unwrap();
        for at in [0, 4, 8, 16, 24, 32, 36, 40, 44, 48, 56] {
            let mut bad = bytes.clone();
            bad[at] ^= 0xff;
            assert!(read(&bad, &src).is_err(), "offset {at}");
        }
        let groups = u32::from_le_bytes(bytes[36..40].try_into().unwrap()) as usize;
        let levels = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        let clusters_at = HEADER + m.draws.len() * 8 + groups * 32 + levels * 12;
        for (at, value) in [
            (clusters_at, u32::MAX),
            (clusters_at + 4, 2),
            (clusters_at + 8, f32::NAN.to_bits()),
            (clusters_at + 20, (-1000f32).to_bits()),
        ] {
            let mut bad = bytes.clone();
            bad[at..at + 4].copy_from_slice(&value.to_le_bytes());
            rehash(&mut bad);
            assert!(read(&bad, &src).is_err(), "offset {at}");
        }
        // Valid in-range index, wrong winding: bounds still pass, identity of
        // the ordered triangle must reject it even after payload rehashing.
        let n = bytes.len();
        let mut bad = bytes.clone();
        bad[n - 2..].copy_from_slice(&0u16.to_le_bytes());
        rehash(&mut bad);
        assert!(read(&bad, &src).is_err());
        assert!(read(&bytes[..bytes.len() - 1], &src).is_err());
        let mut changed = g;
        changed[0] ^= 1;
        assert!(read(&bytes, &source(&m, &changed)).is_err());
    }
    #[test]
    fn dynamic_and_nonopaque_draws_are_excluded() {
        for kind in 0..5 {
            let (mut m, g) = fixture();
            match kind {
                0 => m.draws[0].node = Some(0),
                1 => m.draws[0].skin = Some(0),
                2 => m.materials[0].blend = pc::Blend::Alpha,
                3 => m.materials[0].depth_write = false,
                _ => m.materials[0].kind = pc::Kind::Water,
            };
            let src = source(&m, &g);
            let out = read(&adapt(&src).unwrap(), &src).unwrap();
            assert!(out.groups(0).is_none());
        }
    }
    #[test]
    fn cutout_clusters_preserve_exact_triangles_and_coverage_attributes() {
        let (mut m, g) = fixture();
        m.materials[0].alpha_test = 0.5;
        let src = source(&m, &g);
        let bytes = adapt(&src).unwrap();
        let out = read(&bytes, &src).unwrap();
        let d = &m.draws[0];
        for (k, n) in core::iter::once(d.index_count)
            .chain(d.lods.iter().map(|l| l.index_count))
            .enumerate()
        {
            let count: usize = out
                .groups(0)
                .unwrap()
                .iter()
                .flat_map(|g| out.clusters(&out.levels(g)[k]))
                .map(|c| out.indices(c).len())
                .sum();
            assert_eq!(count, n as usize);
        }
        assert_eq!(
            pc::ipod::parse(&src)
                .unwrap()
                .section(pc::TAG_GEOMETRY)
                .unwrap(),
            g
        );
        m.materials[0].blend = pc::Blend::Alpha;
        let src = source(&m, &g);
        let out = read(&adapt(&src).unwrap(), &src).unwrap();
        assert!(out.groups(0).is_none());
    }
}
