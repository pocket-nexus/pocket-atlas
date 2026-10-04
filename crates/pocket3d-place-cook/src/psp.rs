//! Fixed-function lowering from shared scene analysis to a PSP device pack. Static irradiance is
//! already baked by the common cooker. PSP stores compact indexed GE vertices,
//! RGBA4444 swizzled textures and the original rigid/skeletal animation.
use crate::{artifact::Artifact, profile::Profile};
use bytemuck::{Pod, Zeroable};
use glam::{Mat3, Mat4, Quat, Vec3};
use pocket3d_place_psp as pp;
use pocket_atlas_model as pc;
use std::collections::HashMap;

pub(super) struct Writer(Vec<u8>);
impl Writer {
    pub(super) fn push<T: Pod>(&mut self, items: &[T]) -> pp::Span {
        self.0.resize(self.0.len().next_multiple_of(16), 0);
        let span = pp::Span {
            offset: self.0.len() as u32,
            count: items.len() as u32,
        };
        self.0.extend_from_slice(bytemuck::cast_slice(items));
        span
    }
}

fn tone(v: f32) -> u8 {
    // A bounded filmic curve in the cooker replaces the HDR composite. GE
    // multiplies the encoded texture and encoded vertex light at runtime.
    let x = v.max(0.0);
    pc::color::encode8((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))
}
pub(super) fn color(c: [f32; 3], alpha: f32) -> u32 {
    u32::from_le_bytes([
        tone(c[0]),
        tone(c[1]),
        tone(c[2]),
        (alpha.clamp(0.0, 1.0) * 255.0) as u8,
    ])
}

/// GE swizzle: 16-byte × 8-row blocks, not Morton order.
pub(super) fn swizzle(pixels: &[u8], row: usize, height: usize) -> Vec<u8> {
    pocket_psp_ge::swizzle::swizzle_rows(pixels, row, height).expect("valid GE texture rows")
}

pub fn cook(scene: &crate::source::Scene, profile: &Profile) -> Result<Artifact, String> {
    let m = scene;
    assert!(
        m.materials.iter().all(|m| !m.vertex_pbr),
        "PSP lowering requires source materials, not Vita PBR palettes"
    );
    let daylight = m.day_sky.is_some();
    let geometry_recipe = profile.recipe.psp_geometry.clone().unwrap_or_default();
    let occluder = crate::native_sky::sun_occluder(m);
    let mut world = Vec::with_capacity(m.nodes.len());
    for n in &m.nodes {
        let local = Mat4::from_scale_rotation_translation(
            Vec3::from(n.scale),
            Quat::from_array(n.rotation),
            Vec3::from(n.translation),
        );
        world.push(n.parent.map_or(local, |p| world[p as usize] * local));
    }
    let mut w = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
    let mut textures = Vec::new();
    let mut tex_map = HashMap::new();
    for mat in &m.materials {
        if let Some(id) = mat.albedo.or(mat.emission) {
            if tex_map.contains_key(&id) {
                continue;
            }
            let t = &m.textures[id as usize];
            let rgba = t.rgba8();
            let luminous = m.materials.iter().any(|m| {
                m.albedo.or(m.emission) == Some(id)
                    && (m.emissive.iter().any(|&e| e > 0.1) || m.kind == pc::Kind::Unlit)
            });
            let cap = profile.psp_texture_cap(t.usage, luminous);
            let width = t.width.next_power_of_two().min(cap).max(8);
            let height = t.height.next_power_of_two().min(cap).max(8);
            let img = image::RgbaImage::from_raw(t.width, t.height, rgba).unwrap();
            let small =
                image::imageops::resize(&img, width, height, image::imageops::FilterType::Lanczos3);
            let mut chain = Vec::new();
            let mut level = small;
            let mut mips = 0;
            loop {
                let (mw, mh) = level.dimensions();
                let pixels: Vec<u8> = level
                    .pixels()
                    .flat_map(|p| {
                        let q = |v: u8| (v as u16 * 15 + 127) / 255;
                        (q(p[0]) | q(p[1]) << 4 | q(p[2]) << 8 | q(p[3]) << 12).to_le_bytes()
                    })
                    .collect();
                chain.extend(swizzle(&pixels, mw as usize * 2, mh as usize));
                mips += 1;
                if mw <= 8 || mh <= 8 {
                    break;
                }
                level = image::imageops::resize(
                    &level,
                    mw / 2,
                    mh / 2,
                    image::imageops::FilterType::Triangle,
                );
            }
            let pixels = w.push(&chain);
            tex_map.insert(id, textures.len() as u32);
            textures.push(pp::Texture {
                format: pp::RGBA4444,
                pixels,
                width,
                height,
                wrap: (t.wrap_s != pc::Wrap::Repeat) as u32
                    | ((t.wrap_t != pc::Wrap::Repeat) as u32) << 1,
                mips,
            });
        }
    }
    let mut materials: Vec<_> = m
        .materials
        .iter()
        .map(|mat| {
            let uv = mat.uv_anim.unwrap_or_default();
            pp::Material {
                texture: mat
                    .albedo
                    .or(mat.emission)
                    .map(|id| tex_map[&id])
                    .unwrap_or(pp::NONE),
                flags: if mat.blend != pc::Blend::Opaque {
                    pp::ALPHA
                } else {
                    0
                } | if mat.double_sided {
                    pp::DOUBLE_SIDED
                } else {
                    0
                } | if mat.wet.as_ref().is_some_and(|v| v.planar) {
                    pp::WET
                } else {
                    0
                } | if !mat.depth_write {
                    pp::NO_DEPTH_WRITE
                } else {
                    0
                },
                alpha_test: (mat.alpha_test * 255.0) as u32,
                // Interior-window cards sit millimetres in front of facades.
                // At street-view distances that gap is less than one PSP
                // 16-bit depth unit, producing view-dependent stripes. Use
                // the same reversed-depth offset as other surface overlays.
                depth_bias: if mat.kind == pc::Kind::InteriorWindow
                    || mat.polygon_offset.is_some()
                    || (mat.albedo.is_some() && mat.emissive.iter().any(|&e| e > 0.1))
                {
                    4
                } else {
                    0
                },
                uv_speed: uv.scroll,
                grid: [uv.cols.max(1), uv.rows.max(1)],
                frames: uv.frames,
                fps: uv.fps,
            }
        })
        .collect();
    let baker = crate::bake::Baker::new(
        &m.lights,
        (m.atmosphere.hemisphere_sky, m.atmosphere.hemisphere_ground),
        None,
    );
    let mut draws = Vec::new();
    for draw in &m.draws {
        let mat = &m.materials[draw.material as usize];
        if mat.kind == pc::Kind::Products {
            super::psp_products::cook(
                draw,
                mat,
                scene,
                &mut w,
                &mut textures,
                &mut materials,
                &mut draws,
            );
            continue;
        }
        // Coarse lists retain outlines and the bake's lighting boundaries.
        // No camera-specific scene copies: all six shots share these draws.
        let indices = if daylight {
            draw.indices()
        } else {
            draw.lods()
                .last()
                .map(|l| l.indices.as_slice())
                .unwrap_or(draw.indices())
        };
        // Fixed children share their animated ancestor's model frame. This is
        // final GE-state batching; original PBR factors were already shaded.
        let mut node = draw.node;
        let mut rebase = Mat4::IDENTITY;
        if daylight && draw.skin.is_none() {
            while let Some(id) = node {
                let n = &m.nodes[id as usize];
                if n.track.is_some() || n.parent.is_none() {
                    break;
                }
                let local = Mat4::from_scale_rotation_translation(
                    Vec3::from(n.scale),
                    Quat::from_array(n.rotation),
                    Vec3::from(n.translation),
                );
                rebase = local * rebase;
                node = n.parent;
            }
        }
        let mut remap = HashMap::<u16, u16>::new();
        let mut vertices = Vec::new();
        let mut weights = Vec::new();
        let mut out_indices = Vec::new();
        let mut selected: Vec<u16> = indices
            .iter()
            .map(|&i| u16::try_from(i).expect("GE index overflow"))
            .collect();
        if !daylight && draw.node.is_some() && draw.skin.is_none() {
            let verts: Vec<_> = (0..draw.vertex_count() as usize)
                .map(|i| *scene.vertex(draw, i))
                .collect();
            let tris: Vec<_> = selected
                .chunks_exact(3)
                .map(|t| [t[0] as u32, t[1] as u32, t[2] as u32])
                .collect();
            // Keep joint-transition vertices; simplify the rigid portions of
            // each garment/prop while retaining the original bone weights.
            let locks: Vec<bool> = (0..verts.len())
                .map(|i| {
                    draw.skin.is_some()
                        && scene
                            .vertex(draw, i)
                            .weights
                            .iter()
                            .filter(|&&w| w > 0)
                            .count()
                            > 1
                })
                .collect();
            if let Some((tris, _)) =
                crate::geometry::simplify(&verts, &tris, 0.15, 0.025, &locks, 0.02)
            {
                selected = tris.iter().flatten().map(|&i| i as u16).collect();
            }
        }
        for old in selected {
            let index = *remap.entry(old).or_insert_with(|| {
                let v = scene.vertex(draw, old as usize);
                let pos = rebase.transform_point3(v.pos).to_array();
                // The GE renderer disables Texture2D for this final material.
                // Canonicalize its dead UVs before exact vertex welding so
                // authoring seams do not duplicate otherwise identical data.
                let uv = if materials[draw.material as usize].texture == pp::NONE {
                    [0.0; 2]
                } else {
                    v.uv.to_array()
                };
                let vc = core::array::from_fn::<_, 3, _>(|i| {
                    pc::color::decode(v.color[i] as f32 / 255.0)
                });
                let normal = v.normal.normalize_or(Vec3::Y);
                let world_pos = draw
                    .node
                    .map_or(v.pos, |n| world[n as usize].transform_point3(v.pos));
                let world_normal = draw.node.map_or(normal, |n| {
                    (Mat3::from_mat4(world[n as usize]).inverse().transpose() * normal)
                        .normalize_or(normal)
                });
                let mut irradiance = if draw.class == crate::source::VertexClass::Baked {
                    let a = v.light[3] as f32 / 255.0;
                    Vec3::from_array(core::array::from_fn(|i| {
                        (v.light[i] as f32 / 255.0 * a).powi(2) * 64.0
                    }))
                } else {
                    baker.irradiance(Vec3::from_array(pos), normal, mat.env_strength, true, 1.0)
                };
                if daylight
                    && !mat.interior
                    && !matches!(mat.kind, pc::Kind::Unlit | pc::Kind::Glass)
                {
                    if let Some(sun) = &m.sun {
                        let direction = Vec3::from(sun.direction);
                        // Static occlusion belongs to baked geometry. Moving
                        // objects retain directional fill as they travel.
                        let visibility = if draw.node.is_none() && draw.skin.is_none() {
                            occluder.as_ref().map_or(1.0, |o| {
                                o.ray_visibility(world_pos, world_normal, direction, 2000.0)
                            })
                        } else {
                            1.0
                        };
                        irradiance += Vec3::from(sun.radiance)
                            * (world_normal.dot(direction).max(0.0)
                                * visibility
                                * std::f32::consts::FRAC_1_PI);
                    }
                }
                let base =
                    Vec3::new(mat.color[0], mat.color[1], mat.color[2]) * Vec3::from_array(vc);
                let light = match mat.kind {
                    pc::Kind::Unlit => base,
                    pc::Kind::InteriorWindow => Vec3::new(0.24, 0.18, 0.11) * mat.emissive[0],
                    pc::Kind::Products => base * mat.emissive[0],
                    pc::Kind::Glass => Vec3::new(0.07, 0.10, 0.12),
                    _ if mat.interior => Vec3::from_array(mat.emissive) * Vec3::from_array(vc),
                    _ => base * irradiance + Vec3::from_array(mat.emissive),
                };
                let alpha = if mat.kind == pc::Kind::Glass {
                    0.14
                } else {
                    mat.color[3] * v.color[3] as f32 / 255.0
                };
                vertices.push(pp::Vertex {
                    uv,
                    color: if daylight {
                        u32::from_le_bytes([
                            (crate::native_sky::grade(light, &m.post).x * 255.0).round() as u8,
                            (crate::native_sky::grade(light, &m.post).y * 255.0).round() as u8,
                            (crate::native_sky::grade(light, &m.post).z * 255.0).round() as u8,
                            (alpha.clamp(0.0, 1.0) * 255.0) as u8,
                        ])
                    } else {
                        color((light * m.post.exposure).to_array(), alpha)
                    },
                    pos,
                });
                if draw.class == crate::source::VertexClass::Skinned {
                    weights.push(pp::Weights {
                        joints: v.joints,
                        weights: v.weights,
                    });
                }
                (vertices.len() - 1) as u16
            });
            out_indices.push(index);
        }
        // PBR normals/tangents have now become GE vertex colours. Their
        // original seams may be byte-identical in the final GE stream;
        // merge only complete records (including deformation weights).
        let mut unique = HashMap::<Vec<u8>, u16>::new();
        let mut compact_vertices = Vec::new();
        let mut compact_weights = Vec::new();
        let mut vertex_remap = Vec::new();
        for (i, vertex) in vertices.iter().enumerate() {
            let mut key = bytemuck::bytes_of(vertex).to_vec();
            if let Some(weight) = weights.get(i) {
                key.extend(bytemuck::bytes_of(weight));
            }
            let new = *unique.entry(key).or_insert_with(|| {
                let index = compact_vertices.len() as u16;
                compact_vertices.push(*vertex);
                if let Some(weight) = weights.get(i) {
                    compact_weights.push(*weight);
                }
                index
            });
            vertex_remap.push(new);
        }
        for index in &mut out_indices {
            *index = vertex_remap[*index as usize];
        }
        for index in remap.values_mut() {
            *index = vertex_remap[*index as usize];
        }
        vertices = compact_vertices;
        weights = compact_weights;
        let mut lods = [pp::Lod::default(); 4];
        if daylight && draw.skin.is_none() {
            for (out, source) in lods.iter_mut().zip(draw.lods()) {
                let indices: Vec<u16> =
                    source.indices.iter().map(|&i| remap[&(i as u16)]).collect();
                *out = pp::Lod {
                    indices: w.push(&indices),
                    error: source.error,
                };
            }
        }
        let lo = vertices
            .iter()
            .fold(Vec3::splat(f32::MAX), |v, p| v.min(Vec3::from(p.pos)));
        let hi = vertices
            .iter()
            .fold(Vec3::splat(f32::MIN), |v, p| v.max(Vec3::from(p.pos)));
        let joints: Vec<_> = draw
            .skin
            .map(|s| {
                let skin = &m.skins[s as usize];
                skin.joints
                    .iter()
                    .enumerate()
                    .map(|(i, &node)| pp::Joint {
                        node,
                        inverse: skin.inverse_bind[i],
                    })
                    .collect()
            })
            .unwrap_or_default();
        draws.push(pp::Draw {
            vertices: w.push(&vertices),
            indices: w.push(&out_indices),
            weights: w.push(&weights),
            joints: w.push(&joints),
            material: draw.material,
            node: node.unwrap_or(pp::NONE),
            flags: if draw.no_reflect
                || (draw.node.is_none()
                    && draw.skin.is_none()
                    && mat.kind != pc::Kind::Unlit
                    && mat.emissive.iter().all(|&e| e < 0.1))
            {
                pp::NO_REFLECT
            } else {
                0
            },
            reserved: 0,
            min: lo.to_array(),
            max: hi.to_array(),
            lods,
            ..Default::default()
        });
    }
    let mut tracks = HashMap::<Vec<u32>, pp::Span>::new();
    let mut packed_tracks = HashMap::<Vec<u8>, pp::Span>::new();
    let mut max_track_error = 0.0f32;
    let mut nodes: Vec<_> = m
        .nodes
        .iter()
        .map(|n| {
            let mut out = pp::Node {
                parent: n.parent.unwrap_or(pp::NONE),
                translation: n.translation,
                rotation: n.rotation,
                scale: n.scale,
                ..Default::default()
            };
            if let Some(keys) = n.track.as_ref().filter(|v| !v.is_empty()) {
                if keys.iter().all(|key| key == &keys[0]) {
                    out.translation.copy_from_slice(&keys[0][..3]);
                    out.rotation.copy_from_slice(&keys[0][3..]);
                } else if daylight {
                    let lo: [f32; 3] = core::array::from_fn(|i| {
                        keys.iter().map(|v| v[i]).fold(f32::MAX, f32::min)
                    });
                    let hi: [f32; 3] = core::array::from_fn(|i| {
                        keys.iter().map(|v| v[i]).fold(f32::MIN, f32::max)
                    });
                    out.track_offset = core::array::from_fn(|i| (lo[i] + hi[i]) * 0.5);
                    out.track_scale = core::array::from_fn(|i| (hi[i] - lo[i]) * 0.5);
                    let quant = |v: f32| (v.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                    let packed: Vec<pp::PackedTrs> = keys
                        .iter()
                        .map(|key| pp::PackedTrs {
                            translation: core::array::from_fn(|i| {
                                quant(if out.track_scale[i] > 0.0 {
                                    (key[i] - out.track_offset[i]) / out.track_scale[i]
                                } else {
                                    0.0
                                })
                            }),
                            rotation: core::array::from_fn(|i| quant(key[i + 3])),
                            padding: 0,
                        })
                        .collect();
                    let mut track_error = 0.0f32;
                    for (original, encoded) in keys.iter().zip(&packed) {
                        let decoded = pp::decode_trs(&out, encoded);
                        track_error = track_error.max(
                            (Vec3::from_slice(&decoded[..3]) - Vec3::from_slice(&original[..3]))
                                .length(),
                        );
                    }
                    if track_error <= geometry_recipe.track_position_error_meters {
                        max_track_error = max_track_error.max(track_error);
                        out.track_encoding = 1;
                        out.track = *packed_tracks
                            .entry(bytemuck::cast_slice(&packed).to_vec())
                            .or_insert_with(|| w.push(&packed));
                    } else {
                        // Wide motion retains every original float sample when
                        // the fixed-rate compact format cannot meet its bound.
                        out.track_offset = [0.0; 3];
                        out.track_scale = [0.0; 3];
                        let data: Vec<f32> = keys.iter().flatten().copied().collect();
                        out.track = *tracks
                            .entry(data.iter().map(|v| v.to_bits()).collect())
                            .or_insert_with(|| w.push(&data));
                    }
                } else {
                    let data: Vec<f32> = keys.iter().flatten().copied().collect();
                    out.track = *tracks
                        .entry(data.iter().map(|v| v.to_bits()).collect())
                        .or_insert_with(|| w.push(&data));
                }
            }
            out
        })
        .collect();
    let mut lights: Vec<_> = m
        .fog_lights
        .iter()
        .map(|l| pp::Light {
            pos: l.position,
            color: color(l.color, 1.0),
            radius: l.radius,
            track: w.push(
                &l.track
                    .map(|t| {
                        m.fog_tracks[t as usize]
                            .samples
                            .iter()
                            .flatten()
                            .copied()
                            .collect::<Vec<f32>>()
                    })
                    .unwrap_or_default(),
            ),
            reserved: 0,
        })
        .collect();
    let shots: Vec<_> = m
        .camera
        .shots
        .iter()
        .map(|s| {
            let mut name = [0; 16];
            let mut len = s.name.len().min(15);
            while !s.name.is_char_boundary(len) {
                len -= 1;
            }
            name[..len].copy_from_slice(&s.name.as_bytes()[..len]);
            let key = |k: &pc::ShotKey| {
                [
                    k.pos[0],
                    k.pos[1],
                    k.pos[2],
                    k.target[0],
                    k.target[1],
                    k.target[2],
                    k.fov,
                ]
            };
            pp::Shot {
                name,
                from: key(&s.from),
                to: key(&s.to),
                duration: s.duration,
            }
        })
        .collect();
    let dry: Vec<[f32; 6]> = m
        .rain
        .dry_boxes
        .iter()
        .map(|b| [b[0][0], b[0][1], b[0][2], b[1][0], b[1][1], b[1][2]])
        .collect();
    draws.retain(|d| d.indices.count > 0);
    if daylight {
        let mut merged = Vec::new();
        let mut keys = HashMap::new();
        let map: Vec<u32> = materials
            .iter()
            .map(|mat| {
                *keys
                    .entry(bytemuck::bytes_of(mat).to_vec())
                    .or_insert_with(|| {
                        let id = merged.len() as u32;
                        merged.push(*mat);
                        id
                    })
            })
            .collect();
        for d in &mut draws {
            d.material = map[d.material as usize];
        }
        materials = merged;
    }
    let mut sky_texture = pp::NONE;
    let mut cloud_texture = pp::NONE;
    let mut cloud_drift = 0.0;
    if let Some(sky) = &m.day_sky {
        sky_texture = sky_texture_push(
            &crate::native_sky::panorama(sky, &m.post, None),
            &mut w,
            &mut textures,
        );
        if let Some(id) = sky.clouds {
            cloud_texture = sky_texture_push(
                &crate::native_sky::panorama(sky, &m.post, Some(&m.textures[id as usize].image())),
                &mut w,
                &mut textures,
            );
            cloud_drift = sky.drift;
        }
    }
    batch_geometry(&mut w, &mut draws, &materials);
    let max_vertex_error = if daylight {
        pack_vertices(&mut w, &mut draws, &materials, &textures, &geometry_recipe)
    } else {
        0.0
    };
    compact(&mut w, &mut textures, &mut draws, &mut nodes, &mut lights);
    let mut h = pp::Header::zeroed();
    h.magic = pp::MAGIC;
    h.version = pp::VERSION;
    h.rain = m.rain.active as u32;
    h.sky_texture = sky_texture;
    h.cloud_texture = cloud_texture;
    h.cloud_drift = cloud_drift;
    h.lod_pixels = if daylight {
        geometry_recipe.lod_pixels
    } else {
        0.0
    };
    h.audio = w.push(
        &crate::analysis::audio::native_record(m.audio.as_ref())
            .map(|v| v.to_vec())
            .unwrap_or_default(),
    );
    h.textures = w.push(&textures);
    h.materials = w.push(&materials);
    h.draws = w.push(&draws);
    h.nodes = w.push(&nodes);
    h.shots = w.push(&shots);
    h.dry_boxes = w.push(&dry);
    h.lights = w.push(&lights);
    h.walkable = w.push(&m.camera.walkable);
    h.fps = m.fps;
    h.frames = m.frames;
    h.fog_color = color(m.atmosphere.fog_color, 1.0);
    h.sky_color = color(m.atmosphere.sky_horizon, 1.0);
    h.fog_near = 12.0;
    h.fog_far = (1.8 / m.atmosphere.fog_density.max(0.001)).min(250.0);
    h.doors = [pp::NONE; 2];
    if let Some(d) = &m.doors {
        h.doors = [d.left, d.right];
        h.door_trigger = d.trigger;
        h.door_radius = d.radius;
        h.door_travel = d.travel;
    }
    h.bytes = w.0.len() as u32;
    w.0[..core::mem::size_of::<pp::Header>()].copy_from_slice(bytemuck::bytes_of(&h));
    crate::progress!(
        "PSP payload: {} bytes, {} textures, {} draws",
        w.0.len(),
        textures.len(),
        draws.len()
    );
    let texture_bytes: u32 = textures.iter().map(|t| t.pixels.count).sum();
    let animation_bytes: u32 = nodes
        .iter()
        .map(|n| {
            (
                n.track.offset,
                n.track.count,
                if n.track_encoding == 1 { 16 } else { 4 },
            )
        })
        .collect::<std::collections::BTreeSet<_>>()
        .iter()
        .map(|v| v.1 * v.2)
        .sum();
    pp::validate(&w.0).map_err(|e| {
        format!(
            "PSP pack: {e}; {} bytes (textures {texture_bytes}, animation {animation_bytes})",
            w.0.len()
        )
    })?;
    let triangles: u32 = draws.iter().map(|d| d.indices.count / 3).sum();
    let vertices_total: u32 = draws
        .iter()
        .map(|d| (d.vertices.offset, d.vertices.count))
        .collect::<std::collections::BTreeSet<_>>()
        .iter()
        .map(|v| v.1)
        .sum();
    let report = serde_json::json!({"target":"psp","frames":h.frames,"fps":h.fps,"daySky":daylight,"textureBytes":texture_bytes,"animationBytes":animation_bytes,"maxTrackPositionError":max_track_error,"maxVertexPositionError":max_vertex_error,"clouds":cloud_texture!=pp::NONE,"draws":draws.len(),"triangles":triangles,"vertices":vertices_total,"textures":textures.len(),"bytes":w.0.len(),"animatedNodes":nodes.iter().filter(|n|n.track.count>0).count(),"skinnedDraws":draws.iter().filter(|d|d.weights.count>0).count(),"shots":shots.len()});
    Ok(Artifact {
        bytes: w.0, summary: report, sections: Default::default(),
        textures: textures.iter().enumerate().map(|(id,t)|serde_json::json!({"id":id,"width":t.width,"height":t.height,"levels":t.mips,"bytes":t.pixels.count})).collect(),
    })
}

fn sky_texture_push(
    image: &crate::textures::Rgba,
    w: &mut Writer,
    textures: &mut Vec<pp::Texture>,
) -> u32 {
    let image = crate::textures::resize(image, 512, 256);
    let rgba: Vec<u8> = image
        .px
        .iter()
        .flat_map(|p| {
            [
                pc::color::encode8(p[0]),
                pc::color::encode8(p[1]),
                pc::color::encode8(p[2]),
                (p[3].clamp(0.0, 1.0) * 255.0).round() as u8,
            ]
        })
        .collect();
    let pixels = w.push(&swizzle(&rgba, 512 * 4, 256));
    let id = textures.len() as u32;
    textures.push(pp::Texture {
        pixels,
        width: 512,
        height: 256,
        wrap: 2,
        mips: 1,
        format: pp::RGBA8888,
    });
    id
}

/// Share one vertex buffer across spatial chunks of the same material. The
/// runtime can concatenate only the visible chunks' indices into one GE draw.
fn batch_geometry(w: &mut Writer, draws: &mut [pp::Draw], materials: &[pp::Material]) {
    let mut groups = std::collections::BTreeMap::<(u32, u32, u32), Vec<usize>>::new();
    for (i, d) in draws.iter().enumerate() {
        if d.weights.count == 0 && materials[d.material as usize].flags & pp::ALPHA == 0 {
            groups
                .entry((d.material, d.flags, d.node))
                .or_default()
                .push(i);
        }
    }
    for group in groups.values() {
        let mut start = 0;
        while start < group.len() {
            let mut end = start;
            let mut count = 0;
            let mut icount = 0;
            while end < group.len() {
                let d = &draws[group[end]];
                if count + d.vertices.count > 65535
                    || (icount + d.indices.count) as usize > pp::MAX_INDICES
                {
                    break;
                }
                count += d.vertices.count;
                icount += d.indices.count;
                end += 1;
            }
            if end == start {
                start += 1;
                continue;
            }
            let mut verts = Vec::new();
            let mut indices = Vec::new();
            let mut unique = HashMap::<[u32; 6], u16>::new();
            for &i in &group[start..end] {
                // Adjacent spatial chunks repeat boundary vertices. Their
                // final GE bytes may share storage without weakening culling.
                let remap: Vec<u16> = pp::slice::<pp::Vertex>(&w.0, draws[i].vertices)
                    .unwrap()
                    .iter()
                    .map(|v| {
                        let key = *bytemuck::from_bytes::<[u32; 6]>(bytemuck::bytes_of(v));
                        *unique.entry(key).or_insert_with(|| {
                            let id = verts.len() as u16;
                            verts.push(*v);
                            id
                        })
                    })
                    .collect();
                for lod in &mut draws[i].lods {
                    if lod.indices.count > 0 {
                        let rebased: Vec<u16> = pp::slice::<u16>(&w.0, lod.indices)
                            .unwrap()
                            .iter()
                            .map(|&v| remap[v as usize])
                            .collect();
                        lod.indices = w.push(&rebased);
                    }
                }
                let d = &draws[i];
                indices.push(
                    pp::slice::<u16>(&w.0, d.indices)
                        .unwrap()
                        .iter()
                        .map(|&v| remap[v as usize])
                        .collect::<Vec<_>>(),
                );
            }
            let vertices = w.push(&verts);
            for (&i, indices) in group[start..end].iter().zip(indices) {
                draws[i].vertices = vertices;
                draws[i].indices = w.push(&indices);
            }
            start = end;
        }
    }
}

/// Lower directly from float GE attributes, not another device's packed
/// vertices. Every shared buffer gets one decode; oversized spans retain
/// floats if quantization exceeds 5 mm or a quarter of a material texel.
fn pack_vertices(
    w: &mut Writer,
    draws: &mut [pp::Draw],
    materials: &[pp::Material],
    textures: &[pp::Texture],
    recipe: &crate::profile::PspGeometry,
) -> f32 {
    let mut groups = std::collections::BTreeMap::<(u32, u32), Vec<usize>>::new();
    for (i, d) in draws.iter().enumerate() {
        if d.weights.count == 0 {
            groups
                .entry((d.vertices.offset, d.vertices.count))
                .or_default()
                .push(i);
        }
    }
    let mut max_error = 0.0f32;
    for ids in groups.values() {
        let source = pp::slice::<pp::Vertex>(&w.0, draws[ids[0]].vertices).unwrap();
        let lo = source
            .iter()
            .fold(Vec3::splat(f32::MAX), |a, v| a.min(Vec3::from(v.pos)));
        let hi = source
            .iter()
            .fold(Vec3::splat(f32::MIN), |a, v| a.max(Vec3::from(v.pos)));
        let uvlo: [f32; 2] =
            core::array::from_fn(|i| source.iter().map(|v| v.uv[i]).fold(f32::MAX, f32::min));
        let uvhi: [f32; 2] =
            core::array::from_fn(|i| source.iter().map(|v| v.uv[i]).fold(f32::MIN, f32::max));
        let error = (hi - lo).length() / (4.0 * 32767.0);
        let mat = &materials[draws[ids[0]].material as usize];
        let texel = if mat.texture == pp::NONE {
            [1.0; 2]
        } else {
            let t = &textures[mat.texture as usize];
            [t.width as f32, t.height as f32]
        };
        if error > recipe.vertex_position_error_meters
            || (0..2)
                .any(|i| (uvhi[i] - uvlo[i]) * texel[i] / 131070.0 > recipe.vertex_uv_error_texels)
        {
            continue;
        }
        let center = (lo + hi) * 0.5;
        let extent = (hi - lo) * 0.5;
        let packed: Vec<pp::PackedVertex> = source
            .iter()
            .map(|v| pp::PackedVertex {
                pos: core::array::from_fn(|i| {
                    (if extent[i] > 0.0 {
                        (v.pos[i] - center[i]) / extent[i]
                    } else {
                        0.0
                    })
                    .clamp(-1.0, 1.0)
                    .mul_add(32767.0, 0.0)
                    .round() as i16
                }),
                uv: core::array::from_fn(|i| {
                    (if uvhi[i] > uvlo[i] {
                        (v.uv[i] - uvlo[i]) / (uvhi[i] - uvlo[i])
                    } else {
                        0.0
                    })
                    .clamp(0.0, 1.0)
                    .mul_add(65535.0, 0.0)
                    .round() as u16
                }),
                color: v.color,
                padding: 0,
            })
            .collect();
        let vertices = w.push(&packed);
        max_error = max_error.max(error);
        for &i in ids {
            let d = &mut draws[i];
            d.vertices = vertices;
            d.vertex_format = 1;
            d.pos_offset = center.to_array();
            d.pos_scale = (extent * (32768.0 / 32767.0)).to_array();
            d.uv_offset = uvlo;
            d.uv_scale = core::array::from_fn(|i| (uvhi[i] - uvlo[i]) * (32768.0 / 65535.0));
            for k in 0..3 {
                d.min[k] -= error;
                d.max[k] += error;
            }
        }
    }
    max_error
}

/// Discard superseded geometry and retain shared ranges exactly once.
fn compact(
    w: &mut Writer,
    textures: &mut [pp::Texture],
    draws: &mut [pp::Draw],
    nodes: &mut [pp::Node],
    lights: &mut [pp::Light],
) {
    let mut out = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
    let mut copied = HashMap::<(Vec<u8>, usize), pp::Span>::new();
    let mut copy = |span: &mut pp::Span, stride: usize| {
        if span.count == 0 {
            *span = pp::Span::default();
            return;
        }
        let start = span.offset as usize;
        let data = &w.0[start..start + span.count as usize * stride];
        let key = (data.to_vec(), stride);
        *span = *copied.entry(key).or_insert_with(|| {
            let s = out.push(data);
            pp::Span {
                offset: s.offset,
                count: span.count,
            }
        });
    };
    for t in textures {
        copy(&mut t.pixels, 1);
    }
    for d in draws {
        copy(
            &mut d.vertices,
            if d.vertex_format == 1 {
                core::mem::size_of::<pp::PackedVertex>()
            } else {
                core::mem::size_of::<pp::Vertex>()
            },
        );
        copy(&mut d.indices, 2);
        for lod in &mut d.lods {
            copy(&mut lod.indices, 2);
        }
        copy(&mut d.weights, 8);
        copy(&mut d.joints, core::mem::size_of::<pp::Joint>());
    }
    for n in nodes {
        copy(
            &mut n.track,
            if n.track_encoding == 1 {
                core::mem::size_of::<pp::PackedTrs>()
            } else {
                4
            },
        );
    }
    for l in lights {
        copy(&mut l.track, 4);
    }
    *w = out;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packed_ge_attributes_preserve_texture_coordinates_and_fall_back_for_wide_spans() {
        let mut w = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
        let source = [
            pp::Vertex {
                pos: [-4.5, 0.125, 20.0],
                uv: [-1.25, 3.0],
                color: 0x12345678,
            },
            pp::Vertex {
                pos: [12.3, 7.75, 20.0],
                uv: [7.125, 0.25],
                color: 0xabcdef12,
            },
            pp::Vertex {
                pos: [1.2345, 3.5678, 20.0],
                uv: [0.98765, 2.71828],
                color: 0xffeeddcc,
            },
        ];
        let mut draws = [pp::Draw {
            vertices: w.push(&source),
            node: pp::NONE,
            min: [-4.5, 0.125, 20.0],
            max: [12.3, 7.75, 20.0],
            ..Default::default()
        }];
        let mats = [pp::Material {
            texture: 0,
            ..Default::default()
        }];
        let textures = [pp::Texture {
            width: 512,
            height: 256,
            ..Default::default()
        }];
        let error = pack_vertices(&mut w, &mut draws, &mats, &textures, &Default::default());
        assert_eq!(draws[0].vertex_format, 1);
        for (input, packed) in source
            .iter()
            .zip(pp::slice::<pp::PackedVertex>(&w.0, draws[0].vertices).unwrap())
        {
            let output = pp::decode_vertex(&draws[0], packed);
            assert!((Vec3::from(input.pos) - Vec3::from(output.pos)).length() <= error + 1e-6);
            assert_eq!(input.color, output.color);
            for k in 0..2 {
                assert!((input.uv[k] - output.uv[k]).abs() * [512.0, 256.0][k] < 0.25);
            }
            for k in 0..3 {
                assert!((draws[0].min[k]..=draws[0].max[k]).contains(&output.pos[k]));
            }
        }
        // A large shared vertex buffer must retain floats, even if each draw is small.
        let mut wide = source;
        wide[1].pos[0] = 10000.0;
        let original = w.push(&wide);
        let mut d = [pp::Draw {
            vertices: original,
            ..Default::default()
        }];
        assert_eq!(
            pack_vertices(&mut w, &mut d, &mats, &textures, &Default::default()),
            0.0
        );
        assert_eq!(d[0].vertex_format, 0);
        assert_eq!(d[0].vertices.offset, original.offset);
        // A small object with thousands of UV repeats must also retain floats.
        wide = source;
        wide[1].uv[0] = 10000.0;
        let mut d = [pp::Draw {
            vertices: w.push(&wide),
            ..Default::default()
        }];
        assert_eq!(
            pack_vertices(&mut w, &mut d, &mats, &textures, &Default::default()),
            0.0
        );
        assert_eq!(d[0].vertex_format, 0);
    }

    #[test]
    fn byte_interning_preserves_distinct_packed_decode_and_lod_ranges() {
        let mut w = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
        let packed = [pp::PackedVertex::default(); 3];
        let mut draws: Vec<_> = [0.0, 10.0]
            .into_iter()
            .map(|x| pp::Draw {
                vertices: w.push(&packed),
                indices: w.push(&[0u16, 1, 2]),
                vertex_format: 1,
                pos_offset: [x, 0.0, 0.0],
                lods: [pp::Lod {
                    indices: w.push(&[0u16, 2, 1]),
                    error: 0.1,
                }; 4],
                ..Default::default()
            })
            .collect();
        compact(&mut w, &mut [], &mut draws, &mut [], &mut []);
        assert_eq!(draws[0].vertices.offset, draws[1].vertices.offset);
        assert_eq!(draws[0].indices.offset, draws[1].indices.offset);
        assert_ne!(draws[0].indices.offset, draws[0].lods[0].indices.offset);
        assert_eq!(pp::decode_vertex(&draws[0], &packed[0]).pos, [0.0; 3]);
        assert_eq!(
            pp::decode_vertex(&draws[1], &packed[0]).pos,
            [10.0, 0.0, 0.0]
        );
    }

    #[test]
    fn spatial_batch_weld_shares_only_identical_ge_boundary_vertices() {
        let mut w = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
        let a = pp::Vertex {
            pos: [0.0, 0.0, 0.0],
            color: 0xff112233,
            ..Default::default()
        };
        let b = pp::Vertex {
            pos: [1.0, 0.0, 0.0],
            ..a
        };
        let c = pp::Vertex {
            pos: [0.0, 1.0, 0.0],
            ..a
        };
        let d = pp::Vertex {
            pos: [1.0, 1.0, 0.0],
            ..a
        };
        let mut draws: Vec<_> = [[a, b, c], [b, d, c]]
            .iter()
            .enumerate()
            .map(|(i, v)| pp::Draw {
                vertices: w.push(v),
                indices: w.push(&[0u16, 1, 2]),
                node: pp::NONE,
                min: [i as f32, 0.0, 0.0],
                max: [i as f32 + 1.0, 1.0, 0.0],
                lods: [pp::Lod {
                    indices: w.push(&[2u16, 1, 0]),
                    error: 0.1,
                }; 4],
                ..Default::default()
            })
            .collect();
        batch_geometry(&mut w, &mut draws, &[pp::Material::default()]);
        assert_eq!(draws[0].vertices.count, 4);
        assert_eq!(draws[0].vertices.offset, draws[1].vertices.offset);
        assert_eq!(pp::slice::<u16>(&w.0, draws[1].indices).unwrap(), [1, 3, 2]);
        assert_eq!(
            pp::slice::<u16>(&w.0, draws[1].lods[0].indices).unwrap(),
            [2, 3, 1]
        );
        assert_eq!(
            draws[1].min,
            [1.0, 0.0, 0.0],
            "spatial culling remains per chunk"
        );
    }

    #[test]
    fn batching_rebases_indices_without_losing_spatial_chunks() {
        let mut w = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
        let mut draws = Vec::new();
        for x in [0.0, 10.0] {
            let vertices = [
                pp::Vertex {
                    pos: [x, 0.0, 0.0],
                    ..Default::default()
                },
                pp::Vertex {
                    pos: [x + 1.0, 0.0, 0.0],
                    ..Default::default()
                },
                pp::Vertex {
                    pos: [x, 1.0, 0.0],
                    ..Default::default()
                },
            ];
            draws.push(pp::Draw {
                vertices: w.push(&vertices),
                indices: w.push(&[0u16, 1, 2]),
                node: pp::NONE,
                min: [x, 0.0, 0.0],
                max: [x + 1.0, 1.0, 0.0],
                ..Default::default()
            });
        }
        batch_geometry(&mut w, &mut draws, &[pp::Material::default()]);
        assert_eq!(draws[0].vertices.offset, draws[1].vertices.offset);
        assert_eq!(
            pp::slice::<u16>(&w.0, draws[1].indices).unwrap(),
            &[3, 4, 5]
        );
        assert_eq!(draws[1].min, [10.0, 0.0, 0.0]);
        let mut textures = [];
        let mut nodes = [];
        let mut lights = [];
        compact(&mut w, &mut textures, &mut draws, &mut nodes, &mut lights);
        let vs = pp::slice::<pp::Vertex>(&w.0, draws[1].vertices).unwrap();
        assert_eq!(vs[3].pos, [10.0, 0.0, 0.0]);
        assert_eq!(draws[0].vertices.offset, draws[1].vertices.offset);
    }
    #[test]
    fn ge_swizzle_preserves_rows_and_blocks() {
        let source: Vec<u8> = (0..32 * 16).map(|i| (i / 32 * 7 + i % 32) as u8).collect();
        let tiled = super::swizzle(&source, 32, 16);
        for y in 0..16 {
            for x in 0..32 {
                let index = ((y / 8) * 2 + x / 16) * 128 + (y % 8) * 16 + x % 16;
                assert_eq!(tiled[index], source[y * 32 + x]);
            }
        }
    }
}
