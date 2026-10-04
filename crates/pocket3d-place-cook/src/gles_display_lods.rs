//! Index-only display LODs derived during the same source lowering. The SGX
//! display vertex ABI does not contain a tangent: removing only those seams
//! before the existing bounded simplifier restores useful static LODs without
//! changing the original vertices, full indices or source metadata.
use super::{pc, Result};
use crate::{geometry, source::VertexClass};
use glam::{Vec2, Vec3};

pub(super) fn build(meta: &pc::Meta, data: &mut Vec<u8>) -> Result<Option<pc::ipod::DisplayLods>> {
    use pc::ipod::display_lods as proof;
    let boundaries = proof::boundary_locks(meta, data, None)?;
    let mut draws = Vec::new();
    for (id, d) in meta
        .draws
        .iter()
        .enumerate()
        .filter(|(_, d)| proof::eligible(meta, d))
    {
        let topology = proof::Topology::new(d, data, &boundaries[id])?;
        // No tangent duplication, no new optimization opportunity.
        if topology.representatives.len() == d.vertex_count as usize {
            continue;
        }
        let bytes = pc::parts::slice(data, &d.vertices)?;
        let vertices: Vec<_> = topology
            .representatives
            .iter()
            .map(|&i| {
                let v = &bytes[i as usize * 56..(i as usize + 1) * 56];
                Ok(geometry::Vertex {
                    pos: Vec3::from(pc::ipod::floats::<3>(v, 0)?),
                    normal: Vec3::from(pc::ipod::floats::<3>(v, 12)?),
                    tangent: [1., 0., 0., 1.],
                    uv: Vec2::from(pc::ipod::floats::<2>(v, 40)?),
                    color: v[48..52].try_into().unwrap(),
                    light: v[52..56].try_into().unwrap(),
                    joints: [0; 4],
                    weights: [0; 4],
                })
            })
            .collect::<Result<_>>()?;
        let m = &meta.materials[d.material as usize];
        let drop_parts = m.emissive.iter().all(|&x| x <= 0.0);
        let mut candidates = levels(&vertices, &topology.full, &topology.locked, drop_parts);
        candidates.retain(|(t, e)| {
            *e > 0.0
                && e.is_finite()
                && !d
                    .lods
                    .iter()
                    .any(|l| l.error <= *e && l.index_count as usize <= t.len() * 3)
        });
        let source_hash = proof::source_hash(meta, d, data)?;
        let mut encoded = Vec::new();
        let (mut prior_count, mut prior_error) = (d.index_count, 0.0);
        for (triangles, error) in candidates {
            let triangles: Vec<_> = triangles
                .iter()
                .map(|t| t.map(|i| topology.representatives[i as usize]))
                .collect();
            // The simplifier may drop a narrow part; a part touching a shared
            // chunk edge must instead retain its original level.
            if error <= prior_error
                || triangles.len() * 3 >= prior_count as usize
                || topology.validate_level(&triangles).is_err()
            {
                continue;
            }
            let bytes: Vec<_> = triangles
                .iter()
                .flatten()
                .flat_map(|&i| (i as u16).to_le_bytes())
                .collect();
            let index_count = u32::try_from(triangles.len() * 3)
                .map_err(|_| "display LOD index count overflow")?;
            encoded.push(pc::DrawLod {
                indices: super::append(data, &bytes, 2)?,
                index_count,
                error,
            });
            prior_count = index_count;
            prior_error = error;
        }
        if !encoded.is_empty() {
            draws.push(pc::ipod::DisplayLodDraw {
                draw: id as u32,
                source_hash,
                payload_hash: pc::ipod::skin_lods::payload_hash(&encoded, data)?,
                levels: encoded,
            });
        }
    }
    if draws.is_empty() {
        return Ok(None);
    }
    let recipe = pc::ipod::DisplayLods {
        version: proof::VERSION,
        draws,
    };
    let recipes = pc::ipod::Recipes {
        display_lods: Some(recipe.clone()),
        ..Default::default()
    };
    proof::validate(meta, data, &recipes)?;
    Ok(Some(recipe))
}

fn levels(
    v: &[geometry::Vertex],
    t: &[[u32; 3]],
    locks: &[bool],
    drop_parts: bool,
) -> Vec<(Vec<[u32; 3]>, f32)> {
    let shared = geometry::lods(
        v,
        t,
        VertexClass::Baked,
        locks,
        drop_parts,
        &[0.06, 0.25],
        0.02,
    );
    let mut fine = geometry::lods(
        v,
        t,
        VertexClass::Baked,
        locks,
        drop_parts,
        &[0.01, 0.02, 0.04],
        0.02,
    );
    fine.retain(|(tris, error)| {
        shared.iter().all(|(old, e)| {
            if e == error {
                false
            } else if e < error {
                old.len() > tris.len()
            } else {
                old.len() < tris.len()
            }
        })
    });
    fine.extend(shared);
    fine.sort_by(|a, b| a.1.total_cmp(&b.1));
    fine
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (pc::Meta, Vec<u8>) {
        let (mut m, _, _) = super::super::gles_geometry::tests::fixture();
        m.draws.truncate(1);
        m.materials.truncate(1);
        let mat = &mut m.materials[0];
        mat.emission = None;
        mat.emissive_track = None;
        mat.emission_shade = None;
        mat.interior = false;
        mat.wet = None;
        mat.alpha_test = 0.0;
        let d = &mut m.draws[0];
        d.material = 0;
        d.node = None;
        d.skin = None;
        d.lods.clear();
        d.layout = pc::VertexLayout::Baked;
        let mut data = Vec::new();
        for z in 0..16 {
            for x in 0..16 {
                for (j, (a, b)) in [(0, 0), (1, 0), (1, 1), (0, 0), (1, 1), (0, 1)]
                    .into_iter()
                    .enumerate()
                {
                    let p = [(x + a) as f32, 0.0, (z + b) as f32];
                    let uv = [p[0] * 0.1, p[2] * 0.1];
                    for f in p
                        .into_iter()
                        .chain([0., 1., 0.])
                        .chain([if j < 3 { 1. } else { -1. }, 0., 0., 1.])
                        .chain(uv)
                    {
                        data.extend(f.to_le_bytes());
                    }
                    data.extend([128, 128, 128, 255, 128, 128, 128, 255]);
                }
            }
        }
        d.vertex_count = (data.len() / 56) as u32;
        d.vertices = pc::Range {
            offset: 0,
            size: data.len() as u32,
        };
        d.index_count = d.vertex_count;
        d.indices = pc::Range {
            offset: data.len() as u32,
            size: d.index_count * 2,
        };
        for i in 0..d.vertex_count {
            data.extend((i as u16).to_le_bytes());
        }
        d.min = [0., 0., 0.];
        d.max = [16., 0., 16.];
        (m, data)
    }
    #[test]
    fn tangent_lods_preserve_source_and_bind_recipe_effective_cluster_identity() {
        let (m, mut g) = fixture();
        let prefix = g.clone();
        let original = serde_json::to_vec(&m).unwrap();
        let recipe = build(&m, &mut g).unwrap().unwrap();
        assert_eq!(recipe.draws.len(), 1);
        assert!(recipe.draws[0].levels.last().unwrap().index_count < m.draws[0].index_count / 2);
        assert_eq!(&g[..prefix.len()], &prefix);
        assert_eq!(serde_json::to_vec(&m).unwrap(), original);
        let recipes = pc::ipod::Recipes {
            display_lods: Some(recipe),
            ..Default::default()
        };
        pc::ipod::display_lods::validate(&m, &g, &recipes).unwrap();
        let effective = pc::ipod::display_lods::EffectiveLods::new(&m, &recipes).unwrap();
        assert!(m.draws[0].lods.is_empty());
        assert!(!effective.get(&m, 0).is_empty());
        let metadata = pc::ipod::Metadata {
            scene: m.clone(),
            ipod_recipes: recipes.clone(),
        };
        let mb = serde_json::to_vec(&metadata).unwrap();
        let pack = pc::write_versioned(
            pc::ipod::MAGIC,
            pc::ipod::VERSION,
            &[
                (pc::TAG_META, &mb, 16),
                (pc::TAG_GEOMETRY, &g, 16),
                (pc::TAG_TEXTURES, &[], 16),
                (pc::TAG_ANIMATION, &[], 16),
            ],
        );
        let clusters = super::super::gles_clusters::adapt(&pack).unwrap();
        let parsed = super::super::gles_clusters::runtime::MeshClusters::parse_with_lods(
            &clusters, &m, &mb, &g, &effective,
        )
        .unwrap();
        assert_eq!(
            u64::from_le_bytes(clusters[8..16].try_into().unwrap()),
            pc::content_hash::hash(&mb)
        );
        // A different source identity cannot be excused by an identical view.
        let mut wrong = mb.clone();
        wrong.push(b' ');
        assert!(
            super::super::gles_clusters::runtime::MeshClusters::parse_with_lods(
                &clusters, &m, &wrong, &g, &effective
            )
            .is_err()
        );
        drop(parsed);
        for kind in 0..5 {
            let mut bad = recipes.clone();
            let entry = &mut bad.display_lods.as_mut().unwrap().draws[0];
            match kind {
                0 => entry.source_hash = "0".repeat(16),
                1 => entry.payload_hash = "0".repeat(16),
                2 => entry.levels[0].indices.offset = 0,
                3 => entry.levels[0].error = f32::NAN,
                _ => entry.draw = u32::MAX,
            }
            assert!(pc::ipod::display_lods::validate(&m, &g, &bad).is_err());
        }
        let mut bad = m.clone();
        bad.materials[0].alpha_test = 0.5;
        assert!(pc::ipod::display_lods::validate(&bad, &g, &recipes).is_err());
    }
    #[test]
    fn tangent_canonicalization_preserves_all_other_attributes_and_cross_material_edges() {
        use pc::ipod::display_lods as proof;
        let (mut m, g) = fixture();
        let d = &m.draws[0];
        let topology = proof::Topology::new(d, &g, &Default::default()).unwrap();
        assert!(topology.representatives.len() < d.vertex_count as usize);
        for at in [12, 40, 48, 52] {
            let mut changed = g.clone();
            changed[3 * 56 + at] ^= 1;
            let other = proof::Topology::new(d, &changed, &Default::default()).unwrap();
            assert_eq!(
                other.representatives.len(),
                topology.representatives.len() + 1,
                "attribute {at}"
            );
        }
        let mut neighbour = d.clone();
        neighbour.material = 1;
        m.draws.push(neighbour);
        let mut mat = m.materials[0].clone();
        mat.alpha_test = 0.5;
        m.materials.push(mat);
        let locks = proof::boundary_locks(&m, &g, Some(&[0])).unwrap();
        assert!(!locks[0].is_empty());
        assert!(locks[1].is_empty());
        let proof = proof::Topology::new(&m.draws[0], &g, &locks[0]).unwrap();
        assert!(proof.validate_level(&[]).is_err());
        let mut unavailable = m.clone();
        unavailable.draws[1].node = Some(0);
        assert!(
            pc::ipod::display_lods::boundary_locks(&unavailable, &g, Some(&[0])).unwrap()[0]
                .is_empty()
        );
    }
}
