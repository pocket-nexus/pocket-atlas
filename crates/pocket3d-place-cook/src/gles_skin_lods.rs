//! SGX-only, same-influence index LODs over untouched source float vertices.
//! The shared frontend deliberately emits no skinned LODs. Reference retains
//! that full topology; these optional ranges belong only to the target recipe.
use super::{pc, Result};
use crate::{geometry, source};
use std::collections::BTreeMap;

pub(super) fn build(
    source: &source::Scene,
    meta: &pc::Meta,
    geometry: &mut Vec<u8>,
    animation: &[u8],
) -> Result<Option<pc::ipod::SkinLods>> {
    use pc::ipod::skin_lods as proof;
    let animation_hash = proof::animation_hash(meta, animation)?;
    let mut draws = Vec::new();
    let mut palettes = BTreeMap::new();
    for (id, (src, draw)) in source.draws.iter().zip(&meta.draws).enumerate() {
        let Some(skin) = draw.skin else {
            continue;
        };
        if draw.layout != pc::VertexLayout::Skinned
            || !draw.lods.is_empty()
            || !proof::eligible(meta, draw)
            || src
                .vertices()
                .iter()
                .any(|v| v.color[3] != src.vertices()[0].color[3])
        {
            continue;
        }
        if !palettes.contains_key(&skin) {
            palettes.insert(skin, proof::joint_bounds(meta, skin, animation)?);
        }
        let Some(joints) = &palettes[&skin] else {
            continue;
        };
        let topology = proof::Topology::new(draw, geometry)?;
        let affine_bound = topology.affine_bound(joints)?;
        let levels = simplify(src.vertices(), &topology, affine_bound);
        if levels.is_empty() {
            continue;
        }
        let source_hash = proof::source_hash(draw, geometry, animation_hash)?;
        let mut encoded = Vec::new();
        for (triangles, error) in levels {
            topology.validate_level(&triangles)?;
            let triangles = geometry::cache_order(&triangles, src.vertices().len());
            let bytes: Vec<_> = triangles
                .iter()
                .flatten()
                .flat_map(|&i| (i as u16).to_le_bytes())
                .collect();
            encoded.push(pc::DrawLod {
                indices: super::append(geometry, &bytes, 2)?,
                index_count: u32::try_from(triangles.len() * 3)
                    .map_err(|_| "skin LOD count overflow")?,
                error,
            });
        }
        draws.push(pc::ipod::SkinLodDraw {
            draw: id as u32,
            source_hash,
            payload_hash: proof::payload_hash(&encoded, geometry)?,
            affine_bound,
            levels: encoded,
        });
    }
    if draws.is_empty() {
        return Ok(None);
    }
    let recipe = pc::ipod::SkinLods {
        version: proof::VERSION,
        draws,
    };
    proof::validate(meta, geometry, animation, &recipe)?;
    Ok(Some(recipe))
}

fn simplify(
    vertices: &[geometry::Vertex],
    topology: &pc::ipod::skin_lods::Topology,
    affine_bound: f32,
) -> Vec<(Vec<[u32; 3]>, f32)> {
    let mut groups = BTreeMap::<[u8; 8], Vec<[u32; 3]>>::new();
    let mut mixed = Vec::new();
    for &tri in &topology.full {
        let key = topology.influences[tri[0] as usize];
        if !topology.preserve(tri) {
            groups.entry(key).or_default().push(tri);
        } else {
            mixed.push(tri);
        }
    }
    // Compact each influence region only for the offline simplifier. The
    // emitted indices map directly back to the original source vertex array.
    let mut groups: Vec<_> = groups
        .into_values()
        .map(|triangles| {
            let mut map = BTreeMap::new();
            let mut original = Vec::new();
            let mut compact = Vec::new();
            let mut locks = Vec::new();
            let triangles: Vec<_> = triangles
                .iter()
                .map(|tri| {
                    tri.map(|i| {
                        *map.entry(i).or_insert_with(|| {
                            let local = compact.len() as u32;
                            original.push(i);
                            compact.push(vertices[i as usize]);
                            locks.push(topology.locked[i as usize]);
                            local
                        })
                    })
                })
                .collect();
            (compact, locks, original, triangles, 0.0f32)
        })
        .collect();
    let mut levels = Vec::new();
    let mut previous_count = topology.full.len();
    let mut previous_error = 0.0;
    for world_budget in [0.005, 0.01, 0.025, 0.06, 0.25] {
        let mut triangles = mixed.clone();
        let mut error = 0.0f32;
        for (vertices, locks, original, indices, prior) in &mut groups {
            let remaining = world_budget / affine_bound - *prior;
            if remaining > 0.0 {
                if let Some((candidate, e)) =
                    geometry::simplify(vertices, indices, 0.4, remaining, locks, 0.02)
                {
                    if candidate.len() * 3 <= indices.len() * 2 {
                        *indices = candidate;
                        let sum = *prior as f64 + e as f64;
                        *prior = sum as f32;
                        if (*prior as f64) < sum {
                            *prior = f32::from_bits(prior.to_bits() + 1);
                        }
                    }
                }
            }
            triangles.extend(indices.iter().map(|t| t.map(|i| original[i as usize])));
            let product = *prior as f64 * affine_bound as f64;
            let mut world = product as f32;
            if (world as f64) < product {
                world = f32::from_bits(world.to_bits() + 1);
            }
            error = error.max(world);
        }
        // A failed structural proof is a conservative full fallback for this
        // level, not permission to emit a cracked boundary.
        if triangles.len() < previous_count
            && error > previous_error
            && error.is_finite()
            && topology.validate_level(&triangles).is_ok()
        {
            previous_count = triangles.len();
            previous_error = error;
            levels.push((triangles, error));
        }
    }
    levels
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::{Vec2, Vec3};
    fn grid(origin: f32) -> (Vec<geometry::Vertex>, pc::Draw, Vec<u8>) {
        let mut vertices = Vec::new();
        for y in 0..=20 {
            for x in 0..=20 {
                vertices.push(geometry::Vertex {
                    pos: Vec3::new(
                        origin + x as f32 / 20.,
                        y as f32 / 20.,
                        0.002 * (x * x + y * y) as f32 / 400.,
                    ),
                    normal: Vec3::Z,
                    tangent: [1., 0., 0., 1.],
                    uv: Vec2::new(x as f32 / 20., y as f32 / 20.),
                    color: [255; 4],
                    joints: if x < 10 { [0, 0, 0, 0] } else { [1, 0, 0, 0] },
                    weights: [255, 0, 0, 0],
                    ..Default::default()
                });
            }
        }
        let mut bytes = Vec::new();
        for v in &vertices {
            super::super::gles_geometry::vertex(v, pc::VertexLayout::Skinned, &mut bytes).unwrap();
        }
        let vbytes = bytes.len();
        for y in 0..20 {
            for x in 0..20 {
                let a = (y * 21 + x) as u16;
                for i in [a, a + 1, a + 21, a + 1, a + 22, a + 21] {
                    bytes.extend(i.to_le_bytes());
                }
            }
        }
        let draw = pc::Draw {
            material: 0,
            layout: pc::VertexLayout::Skinned,
            vertices: pc::Range {
                offset: 0,
                size: vbytes as u32,
            },
            vertex_count: vertices.len() as u32,
            indices: pc::Range {
                offset: vbytes as u32,
                size: (bytes.len() - vbytes) as u32,
            },
            index_count: 2400,
            pos_offset: [0.; 3],
            pos_scale: [1.; 3],
            uv_offset: [0.; 2],
            uv_scale: [1.; 2],
            min: [0.; 3],
            max: [2.; 3],
            node: None,
            skin: Some(0),
            no_reflect: false,
            cast_shadow: true,
            lods: vec![],
        };
        (vertices, draw, bytes)
    }
    #[test]
    fn independent_material_chunks_keep_open_boundaries_and_mixed_weights() {
        // Two independently simplified material chunks can choose different
        // levels. Every edge endpoint remains the exact source vertex, so
        // shared boundaries cannot collapse to inconsistent polylines.
        for (origin, affine) in [(0., 1.), (1., 3.)] {
            let (vertices, draw, bytes) = grid(origin);
            let topology = pc::ipod::skin_lods::Topology::new(&draw, &bytes).unwrap();
            let before = bytes.clone();
            let levels = simplify(&vertices, &topology, affine);
            assert!(!levels.is_empty());
            assert!(levels.last().unwrap().0.len() < topology.full.len() / 2);
            for (triangles, error) in &levels {
                assert!(*error > 0. && *error <= 0.25001);
                topology.validate_level(triangles).unwrap();
                for y in 0..=20 {
                    for x in [0, 20] {
                        assert!(triangles.iter().flatten().any(|&i| i == y * 21 + x));
                    }
                }
            }
            assert_eq!(bytes, before);
            let mut bad = levels.last().unwrap().0.clone();
            bad.push([0, 1, 20]); // A new cross-influence triangle is forbidden.
            assert!(topology.validate_level(&bad).is_err());
        }
    }
    #[test]
    fn shading_seam_vertices_and_directed_edges_cannot_disappear() {
        let (mut vertices, mut draw, mut bytes) = grid(0.);
        // A coincident vertex with a different tangent handedness is a real
        // seam even when the SGX diffuse shader currently ignores tangents.
        let mut seam = vertices[220];
        seam.tangent[3] = -1.;
        let at = draw.vertices.size as usize;
        let old_indices = bytes.split_off(at);
        super::super::gles_geometry::vertex(&seam, pc::VertexLayout::Skinned, &mut bytes).unwrap();
        draw.vertex_count += 1;
        draw.vertices.size += 60;
        draw.indices.offset += 60;
        bytes.extend(old_indices);
        // Reference both sides, rather than introducing an unused fixture vertex.
        let extra = [441u16, 221, 241, 220, 441, 221];
        for i in extra {
            bytes.extend(i.to_le_bytes());
        }
        draw.indices.size += 12;
        draw.index_count += 6;
        vertices.push(seam);
        let topology = pc::ipod::skin_lods::Topology::new(&draw, &bytes).unwrap();
        assert!(topology.locked[220] && topology.locked[441]);
        assert!(
            topology.preserve([220, 441, 221]),
            "degenerate chart pole stays original"
        );
        let levels = simplify(&vertices, &topology, 1.);
        assert!(!levels.is_empty());
        assert!(levels.last().unwrap().0.len() < topology.full.len() / 2);
        for (triangles, _) in &levels {
            topology.validate_level(triangles).unwrap();
            assert!(triangles.contains(&[220, 441, 221]));
            assert!(triangles.contains(&[441, 221, 241]));
        }
        let mut bad = topology.full.clone();
        bad.pop();
        assert!(topology.validate_level(&bad).is_err());
    }
    #[test]
    fn recipe_binds_source_animation_payload_and_only_appended_indices() {
        use pc::ipod::skin_lods as proof;
        let (vertices, draw, mut geometry) = grid(0.);
        let texture = super::super::tests::texture(pc::TexRole::Color, 1, 1);
        let mut value = super::super::tests::fixture(&texture);
        value["draws"] = serde_json::json!([draw]);
        value["nodes"] = serde_json::json!([
            {"name":"a","parent":null,"translation":[0,0,0],"rotation":[0,0,0,1],"scale":[1,1,1],"track":null},
            {"name":"b","parent":0,"translation":[0,1,0],"rotation":[0,0,0,1],"scale":[1,2,1],"track":null}]);
        value["skins"] =
            serde_json::json!([{"joints":[0,1],"inverse_bind":{"offset":0,"size":128}}]);
        value["materials"] = serde_json::json!([{"name":"skin","kind":"standard","blend":"opaque","double_sided":false,"depth_write":true,"alpha_test":0,"color":[1,1,1,1],"emissive":[0,0,0],"roughness":0.5,"metalness":0,"normal_scale":1,"ao_strength":1,"env_strength":1,"albedo":null,"normal":null,"orm":null,"emission":null,"vertex_color":true,"interior":false,"fog":true,"wet":null,"damp":null,"drops":0,"clearcoat":0,"polygon_offset":null,"emissive_track":null}]);
        let meta: pc::Meta = serde_json::from_value(value).unwrap();
        let animation: Vec<_> = glam::Mat4::IDENTITY
            .to_cols_array()
            .repeat(2)
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect();
        let topology = proof::Topology::new(&draw, &geometry).unwrap();
        let bound = topology
            .affine_bound(&proof::joint_bounds(&meta, 0, &animation).unwrap().unwrap())
            .unwrap();
        let prefix = geometry.clone();
        let source_hash = proof::source_hash(
            &draw,
            &geometry,
            proof::animation_hash(&meta, &animation).unwrap(),
        )
        .unwrap();
        let mut levels = Vec::new();
        for (triangles, error) in simplify(&vertices, &topology, bound) {
            let bytes: Vec<_> = triangles
                .iter()
                .flatten()
                .flat_map(|&i| (i as u16).to_le_bytes())
                .collect();
            levels.push(pc::DrawLod {
                indices: super::super::append(&mut geometry, &bytes, 2).unwrap(),
                index_count: (triangles.len() * 3) as u32,
                error,
            });
        }
        let recipe = pc::ipod::SkinLods {
            version: proof::VERSION,
            draws: vec![pc::ipod::SkinLodDraw {
                draw: 0,
                source_hash,
                payload_hash: proof::payload_hash(&levels, &geometry).unwrap(),
                affine_bound: bound,
                levels,
            }],
        };
        proof::validate(&meta, &geometry, &animation, &recipe).unwrap();
        assert_eq!(geometry[..prefix.len()], prefix);
        let mut changed = geometry.clone();
        changed[0] ^= 1;
        assert!(proof::validate(&meta, &changed, &animation, &recipe).is_err());
        let mut changed = geometry.clone();
        changed[prefix.len()] ^= 1;
        assert!(proof::validate(&meta, &changed, &animation, &recipe).is_err());
        let mut changed = animation.clone();
        changed[12 * 4..13 * 4].copy_from_slice(&1f32.to_le_bytes());
        assert!(proof::validate(&meta, &geometry, &changed, &recipe).is_err());
        let mut bad = recipe.clone();
        bad.draws[0].levels[0].indices.offset = draw.indices.offset;
        assert!(proof::validate(&meta, &geometry, &animation, &bad).is_err());
        let mut bad = recipe.clone();
        bad.draws[0].affine_bound += 0.001;
        assert!(proof::validate(&meta, &geometry, &animation, &bad).is_err());
        let mut bad = recipe;
        bad.draws[0].levels[0].error = f32::NAN;
        assert!(proof::validate(&meta, &geometry, &animation, &bad).is_err());
    }
}
