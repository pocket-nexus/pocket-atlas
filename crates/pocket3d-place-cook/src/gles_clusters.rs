//! Optional connected-part LOD groups and lossless visibility clusters.
//! The original PLIP, attributes, full geometry and every LOD remain untouched.
use pocket3d_place as pc;
use std::collections::BTreeMap;
type Result<T> = std::result::Result<T, String>;
const CELL: f64 = 16.0;
const PART_CELL: f64 = 4.0;
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
    fn bytes(&self, d: &pc::Draw, out: &mut Vec<u8>) {
        let mut b = self.clone();
        for k in 0..3 {
            let pad =
                d.pos_scale[k].abs() * 2e-6 + b.min[k].abs().max(b.max[k].abs()) * 2e-7 + 1e-5;
            b.min[k] -= pad;
            b.max[k] += pad;
        }
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
fn groups(d: &pc::Draw, geometry: &[u8]) -> Result<Vec<Group>> {
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
            levels: (0..=d.lods.len()).map(|_| BTreeMap::new()).collect(),
        });
        group.bounds.extend(&b);
    }
    for (level, (range, count)) in core::iter::once((&d.indices, d.index_count))
        .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
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
pub(super) fn adapt(source: &[u8]) -> Result<Vec<u8>> {
    let pack = pc::ipod::parse(source).map_err(|e| e.to_string())?;
    let meta_bytes = pack.section(pc::TAG_META).map_err(|e| e.to_string())?;
    let meta = pack.meta().map_err(|e| e.to_string())?;
    let geometry = pack.section(pc::TAG_GEOMETRY).map_err(|e| e.to_string())?;
    let (mut draws, mut group_data, mut levels, mut bounds, mut indices) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut ng, mut nl, mut nc, mut ni) = (0, 0, 0, 0);
    for d in &meta.draws {
        word(&mut draws, ng)?;
        if !eligible(&meta, d) {
            word(&mut draws, 0)?;
            continue;
        }
        let all = groups(d, geometry)?;
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
                let error = if k == 0 { 0.0 } else { d.lods[k - 1].error };
                levels.extend(error.to_le_bytes());
                word(&mut levels, nc)?;
                word(&mut levels, clusters.len())?;
                nl += 1;
                nc += clusters.len();
                for (_, c) in clusters {
                    word(&mut bounds, ni)?;
                    word(&mut bounds, c.indices.len())?;
                    c.bounds.bytes(d, &mut bounds);
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
    out[4..8].copy_from_slice(&2u32.to_le_bytes());
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
mod runtime;
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
    fn rehash(bytes: &mut [u8]) {
        let h = hash(&bytes[HEADER..]);
        bytes[24..32].copy_from_slice(&h.to_le_bytes());
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
        let index_at = clusters_at + 4 * 32;
        let a = bad[index_at..index_at + 6].to_vec();
        let b = bad[index_at + 18..index_at + 24].to_vec();
        bad[index_at..index_at + 6].copy_from_slice(&b);
        bad[index_at + 18..index_at + 24].copy_from_slice(&a);
        for at in [
            groups_at,
            groups_at + 32,
            clusters_at,
            clusters_at + 32,
            clusters_at + 64,
            clusters_at + 96,
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
