//! Animation-aware display approximation, after final graded colors exist.
//! All candidate indices reference original vertices/weights. Error metadata
//! reports sampled posed surface distances separately from the QEM metric.
use super::{pc, Result};
use glam::{Mat4, Quat, Vec3};
use pc::ipod::animated_display_lods as proof;
use std::collections::{BTreeMap, BTreeSet};
#[path = "gles_lod_surface.rs"]
mod surface;
use surface::Surface;
#[derive(Clone)]
struct Vertex {
    pos: Vec3,
    uv: [f32; 2],
    color: [u8; 4],
    joints: [u8; 4],
    weights: [u8; 4],
    original: u32,
}
fn pose(v: &Vertex, b: &[f32]) -> Vec3 {
    let mut p = Vec3::ZERO;
    for k in 0..4 {
        let w = v.weights[k] as f32 / 255.;
        if w == 0. {
            continue;
        }
        let rows = &b[v.joints[k] as usize * 12..][..12];
        p += Vec3::new(
            rows[0] * v.pos.x + rows[1] * v.pos.y + rows[2] * v.pos.z + rows[3],
            rows[4] * v.pos.x + rows[5] * v.pos.y + rows[6] * v.pos.z + rows[7],
            rows[8] * v.pos.x + rows[9] * v.pos.y + rows[10] * v.pos.z + rows[11],
        ) * w;
    }
    p
}
fn floats<const N: usize>(data: &[u8], at: usize) -> Result<[f32; N]> {
    pc::ipod::floats(data, at)
}
/// Same TRS, loop interval, shortest-path nlerp and world×inverse-bind order
/// as the target animation contract. Half keys include the final loop seam.
fn palettes(meta: &pc::Meta, animation: &[u8], skin: usize) -> Result<Vec<Vec<f32>>> {
    let source = meta.skins.get(skin).ok_or("animated LOD skin")?;
    let bind = pc::parts::slice(animation, &source.inverse_bind)?;
    let samples = meta
        .frames
        .checked_mul(proof::SUBFRAMES)
        .ok_or("animated LOD samples overflow")?;
    if samples == 0 || samples > proof::MAX_SAMPLES {
        return Err("animated LOD sample budget".into());
    }
    let mut out = Vec::with_capacity(samples as usize);
    for sample in 0..samples {
        let mut world = Vec::with_capacity(meta.nodes.len());
        for n in &meta.nodes {
            let (mut t, mut q) = (Vec3::from(n.translation), Quat::from_array(n.rotation));
            if let Some(track) = &n.track {
                let bytes = pc::parts::slice(animation, track)?;
                let count = bytes.len() / 28;
                if count == 0 || bytes.len() % 28 != 0 {
                    return Err("animated LOD track stride".into());
                }
                let a = sample as usize / proof::SUBFRAMES as usize % count;
                let b = (a + 1) % count;
                let x = floats::<7>(bytes, a * 28)?;
                let y = floats::<7>(bytes, b * 28)?;
                let phase = (sample % proof::SUBFRAMES) as f32 / proof::SUBFRAMES as f32;
                t = Vec3::from_slice(&x).lerp(Vec3::from_slice(&y), phase);
                q = Quat::from_slice(&x[3..]).lerp(Quat::from_slice(&y[3..]), phase);
            }
            let m = Mat4::from_scale_rotation_translation(Vec3::from(n.scale), q, t);
            let m = if let Some(parent) = n.parent {
                *world
                    .get(parent as usize)
                    .ok_or("animated LOD parent order")?
                    * m
            } else {
                m
            };
            if !m.is_finite() {
                return Err("animated LOD nonfinite pose".into());
            }
            world.push(m);
        }
        let mut rows = Vec::with_capacity(source.joints.len() * 12);
        for (i, &node) in source.joints.iter().enumerate() {
            let m = *world.get(node as usize).ok_or("animated LOD joint node")?
                * Mat4::from_cols_array(&floats::<16>(bind, i * 64)?);
            let a = m.to_cols_array();
            for row in 0..3 {
                rows.extend([a[row], a[4 + row], a[8 + row], a[12 + row]]);
            }
        }
        out.push(rows);
    }
    Ok(out)
}
fn representatives(vertices: &[Vertex], poses: &[Vec<f32>]) -> Vec<u32> {
    let probes: Vec<usize> = (0..32.min(vertices.len()))
        .map(|k| k * vertices.len() / 32.min(vertices.len()))
        .collect();
    let features: Vec<Vec<f32>> = poses
        .iter()
        .map(|pal| {
            let center = pose(&vertices[0], pal);
            probes
                .iter()
                .flat_map(|&i| (pose(&vertices[i], pal) - center).to_array())
                .collect()
        })
        .collect();
    let mut chosen = vec![0usize];
    let mut nearest = vec![f32::INFINITY; features.len()];
    while chosen.len() < proof::REPRESENTATIVE_POSES.min(features.len()) {
        let last = *chosen.last().unwrap();
        for (i, p) in features.iter().enumerate() {
            let dist = p
                .iter()
                .zip(&features[last])
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f32>();
            nearest[i] = nearest[i].min(dist);
        }
        let next = (0..nearest.len())
            .max_by(|&a, &b| nearest[a].total_cmp(&nearest[b]))
            .unwrap();
        if nearest[next] < 1e-12 {
            break;
        }
        chosen.push(next);
    }
    chosen.sort_unstable();
    chosen.into_iter().map(|x| x as u32).collect()
}
fn measure(
    vertices: &[Vertex],
    full: &[u32],
    candidate: &[u32],
    poses: &[Vec<f32>],
    dense: &BTreeSet<u32>,
    qem_error: f32,
) -> Result<pc::ipod::AnimatedLodMeasurement> {
    let bind: Vec<_> = vertices.iter().map(|v| v.pos).collect();
    let mut source = Surface::new(full, &bind);
    let mut target = Surface::new(candidate, &bind);
    let (mut maximum, mut sum, mut samples, mut dense_count) = (0f32, 0f64, 0u64, 0u64);
    for (frame, pal) in poses.iter().enumerate() {
        let posed: Vec<_> = vertices.iter().map(|v| pose(v, pal)).collect();
        if posed.iter().any(|p| !p.is_finite()) {
            return Err("animated LOD nonfinite posed vertex".into());
        }
        source.refit(&posed);
        target.refit(&posed);
        let all = dense.contains(&(frame as u32));
        let mut record = |e: f32| {
            maximum = maximum.max(e);
            samples += 1;
            if all {
                sum += e as f64 * e as f64;
                dense_count += 1;
            }
        };
        let n = if all {
            posed.len()
        } else {
            proof::SPARSE_SAMPLES.min(posed.len())
        };
        for k in 0..n {
            let i = if all { k } else { k * posed.len() / n };
            record(target.distance2(posed[i], &posed).sqrt());
        }
        for (mesh, other) in [(&source, &target), (&target, &source)] {
            let n = if all {
                mesh.tris.len()
            } else {
                proof::SPARSE_SAMPLES.min(mesh.tris.len())
            };
            for k in 0..n {
                let i = if all { k } else { k * mesh.tris.len() / n };
                let t = mesh.tris[i];
                record(
                    other
                        .distance2(
                            (posed[t[0] as usize] + posed[t[1] as usize] + posed[t[2] as usize])
                                / 3.,
                            &posed,
                        )
                        .sqrt(),
                );
            }
        }
    }
    if !maximum.is_finite() || !sum.is_finite() || dense_count == 0 {
        return Err("animated LOD measurement invalid".into());
    }
    Ok(pc::ipod::AnimatedLodMeasurement {
        qem_error,
        sampled_max: maximum,
        dense_rms: (sum / dense_count as f64).sqrt() as f32,
        samples,
        dense_point_samples: dense_count,
    })
}
fn vertices(meta: &pc::Meta, d: &pc::Draw, g: &[u8], colors: &[u8]) -> Result<Vec<Vertex>> {
    let raw = pc::parts::slice(g, &d.vertices)?;
    if raw.len() != d.vertex_count as usize * 60 || colors.len() != d.vertex_count as usize * 4 {
        return Err("animated LOD source/color stride".into());
    }
    let bones = meta.skins[d.skin.unwrap() as usize].joints.len();
    raw.chunks_exact(60)
        .enumerate()
        .map(|(i, b)| {
            proof::dense_weights(b, bones)?;
            let uv = floats::<2>(b, 40)?;
            Ok(Vertex {
                pos: Vec3::from(floats::<3>(b, 0)?),
                uv: core::array::from_fn(|k| uv[k] * d.uv_scale[k] + d.uv_offset[k]),
                color: colors[i * 4..i * 4 + 4].try_into().unwrap(),
                joints: b[52..56].try_into().unwrap(),
                weights: b[56..60].try_into().unwrap(),
                original: i as u32,
            })
        })
        .collect()
}
fn levels(
    meta: &pc::Meta,
    d: &pc::Draw,
    g: &[u8],
    colors: &[u8],
    poses: &[Vec<f32>],
    topology: &proof::Topology,
) -> Result<(
    Vec<(Vec<u32>, pc::ipod::AnimatedLodMeasurement)>,
    Vec<u32>,
    Vec<u32>,
)> {
    let source = vertices(meta, d, g, colors)?;
    let full: Vec<u32> = topology.full.iter().flatten().copied().collect();
    let referenced: BTreeSet<u32> = full.iter().copied().collect();
    let mut compact = Vec::new();
    let mut locks = Vec::new();
    let mut mapping = vec![u32::MAX; source.len()];
    let mut lookup = BTreeMap::<Vec<u8>, u32>::new();
    for i in referenced {
        let v = &source[i as usize];
        let mut key = Vec::new();
        for x in v.pos.to_array().into_iter().chain(v.uv) {
            key.extend(x.to_le_bytes());
        }
        key.extend(v.color);
        let raw = &g[d.vertices.offset as usize + i as usize * 60..][..60];
        key.extend(proof::dense_weights(
            raw,
            meta.skins[d.skin.unwrap() as usize].joints.len(),
        )?);
        let local = *lookup.entry(key).or_insert_with(|| {
            let local = compact.len() as u32;
            compact.push(v.clone());
            locks.push(false);
            local
        });
        locks[local as usize] |= topology.locked[i as usize];
        mapping[i as usize] = local;
    }
    let indices: Vec<_> = full.iter().map(|&i| mapping[i as usize]).collect();
    let reps = representatives(&compact, poses);
    let dense: BTreeSet<u32> = proof::dense_schedule(poses.len() as u32, &reps)
        .into_iter()
        .collect();
    let mut attributes = Vec::new();
    for v in &compact {
        for &frame in &reps {
            attributes.extend(
                (pose(v, &poses[frame as usize]) - pose(&compact[0], &poses[frame as usize]))
                    .to_array(),
            );
        }
        attributes.extend(v.uv);
        attributes.extend(v.color.map(|x| x as f32 / 255.));
    }
    let mut weights = vec![1. / (reps.len() as f32).sqrt(); reps.len() * 3];
    weights.extend([0.02, 0.02, 0.5, 0.5, 0.5, 0.5]);
    let position: Vec<u8> = compact
        .iter()
        .flat_map(|v| v.pos.to_array().into_iter().flat_map(f32::to_le_bytes))
        .collect();
    let adapter = meshopt::VertexDataAdapter::new(&position, 12, 0).map_err(|e| e.to_string())?;
    let mut measured = Vec::new();
    let mut previous = None;
    for budget in [0.0025, 0.005, 0.01, 0.02, 0.04] {
        let mut error = 0.;
        let candidate = meshopt::simplify_with_attributes_and_locks(
            &indices,
            &adapter,
            &attributes,
            &weights,
            weights.len() * 4,
            &locks,
            (indices.len() / 30) * 3,
            budget,
            meshopt::SimplifyOptions::ErrorAbsolute,
            Some(&mut error),
        );
        if candidate.is_empty()
            || candidate.len() >= indices.len()
            || previous.as_ref().is_some_and(|p| p == &candidate)
        {
            continue;
        }
        previous = Some(candidate.clone());
        let candidate: Vec<u32> = candidate
            .iter()
            .map(|&i| compact[i as usize].original)
            .collect();
        let triangles: Vec<_> = candidate
            .chunks_exact(3)
            .map(|t| [t[0], t[1], t[2]])
            .collect();
        if topology.validate_level(&triangles).is_err() {
            continue;
        }
        // Measure the actual published order: sparse candidate probes are
        // deterministic and must describe the cache-optimized payload.
        let candidate: Vec<u32> = crate::geometry::cache_order(&triangles, source.len())
            .into_iter()
            .flatten()
            .collect();
        let measurement = measure(&source, &full, &candidate, poses, &dense, error)?;
        measured.push((candidate, measurement));
    }
    measured.sort_by(|a, b| {
        proof::guarded_error(a.1.sampled_max)
            .unwrap()
            .total_cmp(&proof::guarded_error(b.1.sampled_max).unwrap())
            .then(a.0.len().cmp(&b.0.len()))
    });
    let (mut count, mut error) = (full.len(), 0.);
    measured.retain(|(t, m)| {
        let e = proof::guarded_error(m.sampled_max).unwrap();
        if t.len() < count && e > error {
            count = t.len();
            error = e;
            true
        } else {
            false
        }
    });
    Ok((measured, reps, dense.into_iter().collect()))
}
/// This is a private phase of the same source-IR target lowering. The input is
/// the just-built PLIP artifact, not another device/backend or an external pack.
pub(super) fn lower(input: &[u8], colors: &super::gles_colors::Colors) -> Result<Vec<u8>> {
    let p = pc::ipod::parse(input).map_err(|e| e.to_string())?;
    let mut metadata: pc::ipod::Metadata =
        serde_json::from_slice(p.section(pc::TAG_META).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let meta = &metadata.scene;
    let animation = p.section(pc::TAG_ANIMATION).map_err(|e| e.to_string())?;
    let mut geometry = p
        .section(pc::TAG_GEOMETRY)
        .map_err(|e| e.to_string())?
        .to_vec();
    let ah = pc::ipod::skin_lods::animation_hash(meta, animation)?;
    let cross = proof::boundary_locks(meta, &geometry, animation)?;
    let mut palette_cache = BTreeMap::new();
    let mut draws = Vec::new();
    for color in &colors.animation {
        let d = meta
            .draws
            .get(color.draw as usize)
            .ok_or("animated color draw")?;
        if !proof::eligible(meta, d) || d.index_count < 192 {
            continue;
        }
        if pc::parts::slice(&geometry, &d.vertices)?
            .chunks_exact(60)
            .any(|v| v[56..60].iter().map(|&w| w as u16).sum::<u16>() != 255)
        {
            continue;
        }
        let skin = d.skin.unwrap();
        if !palette_cache.contains_key(&skin) {
            let data = if pc::ipod::skin_lods::joint_bounds(meta, skin, animation)?.is_some() {
                Some(palettes(meta, animation, skin as usize)?)
            } else {
                None
            };
            palette_cache.insert(skin, data);
        }
        let Some(poses) = &palette_cache[&skin] else {
            continue;
        };
        let topology = proof::Topology::new(meta, d, &geometry, &cross[color.draw as usize])?;
        let source_hash = proof::source_hash(meta, d, &geometry, ah)?;
        let graded = pc::parts::slice(&colors.bytes, &color.range)?;
        let (measured, representative_samples, dense_samples) =
            levels(meta, d, &geometry, graded, poses, &topology)?;
        if measured.is_empty() {
            continue;
        }
        let mut levels = Vec::new();
        let mut measurements = Vec::new();
        for (indices, measurement) in measured {
            let bytes: Vec<u8> = indices
                .iter()
                .flat_map(|&i| (i as u16).to_le_bytes())
                .collect();
            levels.push(pc::DrawLod {
                indices: super::append(&mut geometry, &bytes, 2)?,
                index_count: indices.len() as u32,
                error: proof::guarded_error(measurement.sampled_max).ok_or("animated LOD error")?,
            });
            measurements.push(measurement);
        }
        draws.push(pc::ipod::AnimatedDisplayLodDraw {
            draw: color.draw,
            source_hash,
            colors_hash: proof::color_hash(graded),
            payload_hash: pc::ipod::skin_lods::payload_hash(&levels, &geometry)?,
            sample_count: poses.len() as u32,
            representative_samples,
            dense_samples,
            levels,
            measurements,
        });
    }
    if draws.is_empty() {
        return Ok(input.to_vec());
    }
    draws.sort_by_key(|d| d.draw);
    let recipe = pc::ipod::AnimatedDisplayLods {
        version: proof::VERSION,
        draws,
    };
    proof::validate(meta, &geometry, animation, &recipe)?;
    metadata.ipod_recipes.animated_display_lods = Some(recipe);
    pc::ipod::display_lods::validate_ranges(&metadata.scene, &geometry, &metadata.ipod_recipes)?;
    metadata.scene.stats["geometryBytes"] = geometry.len().into();
    let json = serde_json::to_vec(&metadata).map_err(|e| e.to_string())?;
    let sections: Vec<_> = p
        .sections
        .iter()
        .map(|s| {
            Ok((
                s.tag,
                if s.tag == pc::TAG_META {
                    json.as_slice()
                } else if s.tag == pc::TAG_GEOMETRY {
                    geometry.as_slice()
                } else {
                    p.section(s.tag).map_err(|e| e.to_string())?
                },
                s.align,
            ))
        })
        .collect::<Result<_>>()?;
    Ok(pc::write_versioned(
        pc::ipod::MAGIC,
        pc::ipod::VERSION,
        &sections,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(scale: f32) -> (pc::Meta, Vec<u8>, Vec<u8>, Vec<u8>) {
        let texture = super::super::tests::texture(pc::TexRole::Color, 1, 1);
        let mut value = super::super::tests::fixture(&texture);
        value["frames"] = 2.into();
        value["nodes"] = serde_json::json!([
   {"name":"root","parent":null,"translation":[0,0,0],"rotation":[0,0,0,1],"scale":[1,1,1],"track":null},
   {"name":"bent","parent":0,"translation":[0,0,0],"rotation":[0,0,0,1],"scale":[scale,1,1],"track":{"offset":128,"size":56}}]);
        value["skins"] =
            serde_json::json!([{"joints":[0,1],"inverse_bind":{"offset":0,"size":128}}]);
        value["materials"] = serde_json::json!([{"name":"skin","kind":"standard","blend":"opaque","double_sided":false,"depth_write":true,"alpha_test":0,"color":[1,1,1,1],"emissive":[0,0,0],"roughness":0.5,"metalness":0,"normal_scale":1,"ao_strength":1,"env_strength":1,"albedo":null,"normal":null,"orm":null,"emission":null,"vertex_color":true,"interior":false,"fog":true,"wet":null,"damp":null,"drops":0,"clearcoat":0,"polygon_offset":null,"emissive_track":null}]);
        let mut g = Vec::new();
        let mut colors = Vec::new();
        for y in 0..=16 {
            for x in 0..=16 {
                let w = (x * 255 / 16) as u8;
                let v = crate::geometry::Vertex {
                    pos: Vec3::new(
                        x as f32 / 16.,
                        y as f32 / 16.,
                        0.001 * (x * x + y * y) as f32 / 256.,
                    ),
                    normal: Vec3::Z,
                    tangent: [1., 0., 0., 1.],
                    uv: glam::Vec2::new(x as f32 / 16., y as f32 / 16.),
                    color: [255; 4],
                    joints: [0, 1, 0, 0],
                    weights: [255 - w, w, 0, 0],
                    ..Default::default()
                };
                super::super::gles_geometry::vertex(&v, pc::VertexLayout::Skinned, &mut g).unwrap();
                colors.extend([192u8, 128, 64, 255]);
            }
        }
        let vbytes = g.len();
        for y in 0..16 {
            for x in 0..16 {
                let a = (y * 17 + x) as u16;
                for i in [a, a + 1, a + 17, a + 1, a + 18, a + 17] {
                    g.extend(i.to_le_bytes());
                }
            }
        }
        let d = pc::Draw {
            material: 0,
            layout: pc::VertexLayout::Skinned,
            vertices: pc::Range {
                offset: 0,
                size: vbytes as u32,
            },
            vertex_count: 289,
            indices: pc::Range {
                offset: vbytes as u32,
                size: (g.len() - vbytes) as u32,
            },
            index_count: 1536,
            pos_offset: [0.; 3],
            pos_scale: [1.; 3],
            uv_offset: [0.; 2],
            uv_scale: [1.; 2],
            min: [0.; 3],
            max: [1.; 3],
            node: None,
            skin: Some(0),
            no_reflect: false,
            cast_shadow: true,
            lods: vec![],
        };
        value["draws"] = serde_json::json!([d]);
        let mut anim: Vec<u8> = Mat4::IDENTITY
            .to_cols_array()
            .repeat(2)
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect();
        anim.extend(
            [
                0f32, 0., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0.38268343, 0., 0.9238795,
            ]
            .into_iter()
            .flat_map(f32::to_le_bytes),
        );
        (serde_json::from_value(value).unwrap(), g, anim, colors)
    }
    #[test]
    fn mixed_weights_keep_source_vertices_boundaries_and_sample_the_loop_seam() {
        for scale in [1., 2.5] {
            let (meta, g, anim, colors) = fixture(scale);
            let before = g.clone();
            let d = &meta.draws[0];
            let poses = palettes(&meta, &anim, 0).unwrap();
            assert_eq!(poses.len(), 4);
            assert_eq!(
                poses[1], poses[3],
                "two-key midpoint and last-to-first seam agree"
            );
            assert_ne!(poses[0], poses[2]);
            let locks = proof::boundary_locks(&meta, &g, &anim).unwrap();
            let topology = proof::Topology::new(&meta, d, &g, &locks[0]).unwrap();
            let (tiers, reps, dense) = levels(&meta, d, &g, &colors, &poses, &topology).unwrap();
            assert!(!tiers.is_empty());
            assert!(tiers.last().unwrap().0.len() < d.index_count as usize / 2);
            assert_eq!(g, before);
            let mut geometry = g.clone();
            let mut recipe = pc::ipod::AnimatedDisplayLodDraw {
                draw: 0,
                source_hash: proof::source_hash(
                    &meta,
                    d,
                    &g,
                    pc::ipod::skin_lods::animation_hash(&meta, &anim).unwrap(),
                )
                .unwrap(),
                colors_hash: proof::color_hash(&colors),
                payload_hash: String::new(),
                sample_count: 4,
                representative_samples: reps,
                dense_samples: dense,
                levels: vec![],
                measurements: vec![],
            };
            for (indices, measurement) in tiers {
                assert!(indices.iter().all(|&i| i < d.vertex_count));
                let bytes: Vec<u8> = indices
                    .iter()
                    .flat_map(|&i| (i as u16).to_le_bytes())
                    .collect();
                recipe.levels.push(pc::DrawLod {
                    indices: super::super::append(&mut geometry, &bytes, 2).unwrap(),
                    index_count: indices.len() as u32,
                    error: proof::guarded_error(measurement.sampled_max).unwrap(),
                });
                recipe.measurements.push(measurement);
            }
            recipe.payload_hash =
                pc::ipod::skin_lods::payload_hash(&recipe.levels, &geometry).unwrap();
            let recipe = pc::ipod::AnimatedDisplayLods {
                version: 1,
                draws: vec![recipe],
            };
            proof::validate(&meta, &geometry, &anim, &recipe).unwrap();
            assert_eq!(&geometry[..g.len()], &g);
            for mode in 0..5 {
                let mut bad = recipe.clone();
                match mode {
                    0 => bad.draws[0].measurements[0].samples += 1,
                    1 => bad.draws[0].dense_samples.pop().map(|_| ()).unwrap(),
                    2 => bad.draws[0].source_hash = "0".repeat(16),
                    3 => bad.draws[0].levels[0].error *= 0.5,
                    _ => bad.draws[0].payload_hash = "0".repeat(16),
                };
                assert!(proof::validate(&meta, &geometry, &anim, &bad).is_err());
            }
            let mut changed = anim.clone();
            changed[132] ^= 1;
            assert!(proof::validate(&meta, &geometry, &changed, &recipe).is_err());
            let mut neighbors = meta.clone();
            let mut neighbor = d.clone();
            neighbor.material = 0;
            neighbors.draws.push(neighbor);
            let cross = proof::boundary_locks(&neighbors, &g, &anim).unwrap();
            assert!(cross[0].iter().all(|&x| x));
            assert!(cross[1].iter().all(|&x| x));
        }
    }
    #[test]
    fn topology_keeps_distinct_motion_boundaries_and_closed_components() {
        let (mut meta, _, _, _) = fixture(1.);
        let points = [
            [0f32, 0., 0.],
            [1., 0., 0.],
            [0., 1., 0.],
            [0., 0., 0.],
            [1., 0., 0.],
            [0., 1., 0.],
        ];
        let mut g = Vec::new();
        for (i, p) in points.into_iter().enumerate() {
            let v = crate::geometry::Vertex {
                pos: Vec3::from(p),
                joints: [if i < 3 { 0 } else { 1 }, 0, 0, 0],
                weights: [255, 0, 0, 0],
                ..Default::default()
            };
            super::super::gles_geometry::vertex(&v, pc::VertexLayout::Skinned, &mut g).unwrap();
        }
        let d = &mut meta.draws[0];
        d.vertex_count = 6;
        d.vertices.size = 360;
        d.indices = pc::Range {
            offset: 360,
            size: 12,
        };
        d.index_count = 6;
        g.extend([0u16, 1, 2, 3, 5, 4].into_iter().flat_map(u16::to_le_bytes));
        let t = proof::Topology::new(&meta, &meta.draws[0], &g, &[false; 6]).unwrap();
        assert!(
            t.locked.iter().all(|&x| x),
            "same bind edges with different weights remain open motion boundaries"
        );
        assert!(t.validate_level(&[[0, 1, 2]]).is_err());
        let mut g = Vec::new();
        for origin in [0., 3.] {
            for p in [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]] {
                let v = crate::geometry::Vertex {
                    pos: Vec3::from(p) + Vec3::X * origin,
                    joints: [0; 4],
                    weights: [255, 0, 0, 0],
                    ..Default::default()
                };
                super::super::gles_geometry::vertex(&v, pc::VertexLayout::Skinned, &mut g).unwrap();
            }
        }
        let d = &mut meta.draws[0];
        d.vertex_count = 8;
        d.vertices.size = 480;
        d.indices = pc::Range {
            offset: 480,
            size: 48,
        };
        d.index_count = 24;
        let tetra = [[0u16, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
        for base in [0, 4] {
            for t in tetra {
                for i in t {
                    g.extend((i + base).to_le_bytes());
                }
            }
        }
        let t = proof::Topology::new(&meta, &meta.draws[0], &g, &[false; 8]).unwrap();
        assert!(t.locked.iter().all(|&x| !x));
        assert!(t
            .validate_level(&[[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]])
            .unwrap_err()
            .contains("component"));
    }
    #[test]
    fn phase_is_deterministic_preserves_source_sections_and_skips_unsupported_weights() {
        let (meta, g, anim, bytes) = fixture(1.);
        let json = serde_json::to_vec(&meta).unwrap();
        let tex = [255u8; 4];
        let source = pc::write_versioned(
            pc::ipod::MAGIC,
            pc::ipod::VERSION,
            &[
                (pc::TAG_META, &json, 16),
                (pc::TAG_GEOMETRY, &g, 16),
                (pc::TAG_ANIMATION, &anim, 16),
                (pc::TAG_TEXTURES, &tex, 16),
            ],
        );
        let colors = super::super::gles_colors::Colors {
            animation: vec![super::super::gles_colors::AnimationColors {
                draw: 0,
                range: pc::Range {
                    offset: 0,
                    size: bytes.len() as u32,
                },
            }],
            json: vec![],
            bytes,
            draws: 1,
        };
        let out = lower(&source, &colors).unwrap();
        assert_eq!(out, lower(&source, &colors).unwrap());
        let pack = pc::ipod::parse(&out).unwrap();
        let result: pc::ipod::Metadata =
            serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
        assert!(result.ipod_recipes.animated_display_lods.is_some());
        assert_eq!(
            serde_json::to_value(&result.scene.draws).unwrap(),
            serde_json::to_value(&meta.draws).unwrap()
        );
        assert_eq!(&pack.section(pc::TAG_GEOMETRY).unwrap()[..g.len()], &g);
        assert_eq!(pack.section(pc::TAG_ANIMATION).unwrap(), &anim);
        assert_eq!(pack.section(pc::TAG_TEXTURES).unwrap(), &tex);
        let mut bad = g.clone();
        bad[56] = 254;
        let source = pc::write_versioned(
            pc::ipod::MAGIC,
            pc::ipod::VERSION,
            &[
                (pc::TAG_META, &json, 16),
                (pc::TAG_GEOMETRY, &bad, 16),
                (pc::TAG_ANIMATION, &anim, 16),
                (pc::TAG_TEXTURES, &tex, 16),
            ],
        );
        assert_eq!(lower(&source, &colors).unwrap(), source);
    }
    #[test]
    fn pose_uses_all_original_slots_without_renormalization() {
        let v = Vertex {
            pos: Vec3::new(2., 3., 4.),
            uv: [0.; 2],
            color: [255; 4],
            joints: [1, 0, 1, 0],
            weights: [1, 127, 126, 1],
            original: 0,
        };
        let b = [
            1., 0., 0., 5., 0., 1., 0., 6., 0., 0., 1., 7., 2., 0., 0., 8., 0., 3., 0., 9., 0., 0.,
            4., 10.,
        ];
        let a = Vec3::new(7., 9., 11.);
        let c = Vec3::new(12., 18., 26.);
        let expected = c * (1. / 255.) + a * (127. / 255.) + c * (126. / 255.) + a * (1. / 255.);
        assert_eq!(pose(&v, &b), expected);
    }
}
