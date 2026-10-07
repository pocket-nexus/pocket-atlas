//! Fixed-function lowering from shared scene analysis to a PSP device pack. Static irradiance is
//! already baked by the common cooker. PSP stores compact indexed GE vertices,
//! RGBA4444 swizzled textures and the original rigid/skeletal animation.
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
#[path = "psp_daylight.rs"]
mod daylight;
#[path = "psp_lights.rs"]
mod lights;
#[path = "psp_thin.rs"]
mod thin;
#[path = "psp_water.rs"]
mod water;
use pocket_atlas_model as pc;
use pocket3d_place_psp as pp;
use std::collections::HashMap;
use crate::{artifact::Artifact, profile::Profile};

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

/// Native GE sampling policy: one-metre lighting refinement with a half-
/// metre contact guard. AO retains fine trim/reveal contact; directional rays
/// must not magnify those unresolved occluders over whole facade triangles.
pub(super) fn daylight_tolerance(focus: Option<(Vec3, Vec3)>) -> crate::bake::Tolerance {
    crate::bake::Tolerance { min_edge: 1.0, abs: 0.004, rel: 0.25, rounds: 4, focus, grow: 0.2 }
}

pub(super) fn static_sun_light(sun: Option<&pc::Sun>, occluder: Option<&crate::occlusion::Occluder>, pos: Vec3, normal: Vec3) -> Vec3 {
    let shadows = occluder.filter(|_| sun.is_some_and(|s| s.shadow.is_some()));
    daylight::sun_light(sun, shadows, pos + normal.normalize_or(Vec3::Y) * 0.5, normal, true)
}

/// Draws at least this far from every camera are drawn in the vista range.
const SPLIT: f32 = 400.0;

/// Where the cameras stand: each shot's ends and middle, and the corners of
/// the free camera's walkable volumes.
fn cameras(m: &crate::source::Scene) -> Vec<Vec3> {
    let mut points: Vec<Vec3> = m
        .camera
        .shots
        .iter()
        .flat_map(|s| {
            let (a, b) = (Vec3::from(s.from.pos), Vec3::from(s.to.pos));
            [a, b, (a + b) * 0.5]
        })
        .collect();
    for b in &m.camera.walkable {
        for i in 0..8 {
            points.push(Vec3::new(b[if i & 1 == 0 { 0 } else { 3 }], b[if i & 2 == 0 { 1 } else { 4 }], b[if i & 4 == 0 { 2 } else { 5 }]));
        }
    }
    points
}

pub fn cook(scene: &crate::source::Scene, profile: &Profile) -> Result<Artifact,String> {
    let m = scene;
    assert!(m.materials.iter().all(|m| !m.vertex_pbr), "PSP lowering requires source materials, not Vita PBR palettes");
    let daytime = daylight::enabled(&m.kind);
    // The vista's haze, the water's Fresnel and the light sprites are cooked
    // as seen from the middle of the camera shots, as on the 3DS.
    let eye = m.camera.shots.iter().flat_map(|s| [s.from.pos, s.to.pos]).map(Vec3::from).sum::<Vec3>()
        / (2 * m.camera.shots.len().max(1)) as f32;
    let cameras = cameras(m);
    // Metres a pixel spans per metre of distance, at the shots' mean lens.
    let fov = m.camera.shots.iter().map(|s| s.from.fov + s.to.fov).sum::<f32>() / (2 * m.camera.shots.len().max(1)) as f32;
    let pixel = (fov.to_radians() * 0.5).tan() / 136.0;
    let mut narrow_triangles = 0;
    let mut w = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
    let mut textures = Vec::new();
    let mut tex_map = HashMap::new();
    let water_tex: HashMap<usize, u32> = if daytime {
        m.materials
            .iter()
            .enumerate()
            .filter(|(_, mat)| mat.kind == pc::Kind::Water)
            .filter_map(|(i, mat)| water::texture(m, mat, &mut w, &mut textures).map(|t| (i, t)))
            .collect()
    } else {
        HashMap::new()
    };
    // A sky-lit surface with an emission map of its own (floodlit stone, a
    // train's windows) is lit without it, then drawn again with the map
    // added (`pp::GLOW`), as the 3DS's second combiner stage adds it. In a
    // vista an emission map without an albedo (a far tower's windows) goes
    // the same way, over its hazed base colour.
    let glows = |mat: &pc::Material| {
        daytime
            && mat.kind == pc::Kind::Standard
            && (mat.albedo.is_some() || m.vista_haze.is_some())
            && mat.emission.is_some()
            && mat.albedo != mat.emission
            && mat.blend == pc::Blend::Opaque
            && mat.alpha_test == 0.0
            && !mat.interior
            && mat.emissive.iter().any(|&e| e >= 0.1)
    };
    let ids: Vec<u32> = m
        .materials
        .iter()
        .filter(|mat| !(daytime && mat.kind == pc::Kind::Water))
        .flat_map(|mat| [mat.albedo.or(mat.emission), mat.emission.filter(|_| glows(mat))])
        .flatten()
        .collect();
    for id in ids {
        {
            if tex_map.contains_key(&id) {
                continue;
            }
            let t = &m.textures[id as usize];
            let rgba = t.rgba8();
            let luminous = m.materials.iter().any(|m| {
                (m.albedo.or(m.emission) == Some(id) || (glows(m) && m.emission == Some(id)))
                    && (m.emissive.iter().any(|&e| e > 0.1) || m.kind == pc::Kind::Unlit)
            });
            // Daylight glossy maps carry smooth reflected gradients. Keep their
            // original precision; 4-bit ramps turn into moving contour bands.
            // Aggregate all uses before deduplication, independent of names.
            let smooth = daytime && m.materials.iter().any(|m| {
                m.albedo.or(m.emission) == Some(id)
                    && (m.kind == pc::Kind::Glass
                        || (m.kind == pc::Kind::Standard && m.roughness <= 0.25))
            });
            let format = if smooth { pp::RGBA8888 } else { pp::RGBA4444 };
            let bpp = if smooth { 4 } else { 2 };
            let cap = profile.psp_texture_cap(t.usage,luminous,daytime);
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
                let pixels: Vec<u8> = if smooth { level.as_raw().clone() } else { level
                    .pixels()
                    .flat_map(|p| {
                        let q = |v: u8| (v as u16 * 15 + 127) / 255;
                        (q(p[0]) | q(p[1]) << 4 | q(p[2]) << 8 | q(p[3]) << 12).to_le_bytes()
                    })
                    .collect() };
                chain.extend(swizzle(&pixels, mw as usize * bpp, mh as usize));
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
                pixels,
                width,
                height,
                wrap: (t.wrap_s != pc::Wrap::Repeat) as u32
                    | ((t.wrap_t != pc::Wrap::Repeat) as u32) << 1,
                mips,
                format,
            });
        }
    }
    let mut materials: Vec<_> = m
        .materials
        .iter()
        .enumerate()
        .map(|(i, mat)| {
            let mut uv = mat.uv_anim.unwrap_or_default();
            if water_tex.contains_key(&i) {
                uv.scroll = water::scroll(mat);
            }
            pp::Material {
                texture: if let Some(&t) = water_tex.get(&i) {
                    t
                } else if glows(mat) {
                    mat.albedo.map(|id| tex_map[&id]).unwrap_or(pp::NONE)
                } else {
                    mat.albedo.or(mat.emission).map(|id| tex_map[&id]).unwrap_or(pp::NONE)
                },
                flags: if mat.blend != pc::Blend::Opaque {
                    pp::ALPHA
                } else {
                    0
                } | if mat.double_sided {
                    pp::DOUBLE_SIDED
                } else {
                    0
                } | if !daytime && mat.wet.as_ref().is_some_and(|v| v.planar) {
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
    let glow_materials: HashMap<usize, u32> = m
        .materials
        .iter()
        .enumerate()
        .filter(|(_, mat)| glows(mat))
        .map(|(i, mat)| {
            let base = materials[i];
            materials.push(pp::Material {
                texture: tex_map[&mat.emission.unwrap()],
                flags: pp::GLOW | (base.flags & pp::DOUBLE_SIDED),
                alpha_test: 0,
                ..base
            });
            (i, materials.len() as u32 - 1)
        })
        .collect();
    let baker = crate::bake::Baker::new(
        &m.lights,
        (m.atmosphere.hemisphere_sky, m.atmosphere.hemisphere_ground),
        None,
    );
    let occluder = if daytime && !scene.baked_sun {
        crate::pica::sun_occluder(scene)
    } else {
        None
    };
    let world = daylight::world_matrices(m);
    let mut draws = Vec::new();
    for draw in &m.draws {
        if matches!(draw.geometry, crate::source::Geometry::LightField(_)) {
            continue;
        }
        let mat = &m.materials[draw.material as usize];
        let model = if daytime {
            draw.node.map_or(Mat4::IDENTITY, |i| world[i as usize])
        } else {
            Mat4::IDENTITY
        };
        let normal_matrix = model.inverse().transpose();
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
        if daytime && mat.kind == pc::Kind::Water {
            let spread = cameras.iter().map(|c| (*c - eye).length()).fold(0.0, f32::max);
            let laid = water::lay(m, draw, mat, eye, SPLIT + spread);
            for part in laid.parts {
                let mut remap = HashMap::<u16, u16>::new();
                let mut vertices = Vec::new();
                let indices: Vec<u16> = part
                    .iter()
                    .map(|&i| {
                        *remap.entry(i).or_insert_with(|| {
                            vertices.push(laid.vertices[i as usize]);
                            (vertices.len() - 1) as u16
                        })
                    })
                    .collect();
                let (min, max) = vertices.iter().fold((Vec3::splat(f32::MAX), Vec3::splat(f32::MIN)), |(a, b), v| {
                    (a.min(Vec3::from(v.pos)), b.max(Vec3::from(v.pos)))
                });
                draws.push(pp::Draw {
                    vertices: w.push(&vertices),
                    indices: w.push(&indices),
                    weights: w.push::<pp::Weights>(&[]),
                    joints: w.push::<pp::Joint>(&[]),
                    material: draw.material,
                    node: pp::NONE,
                    flags: pp::NO_REFLECT,
                    reserved: 0,
                    min: min.to_array(),
                    max: max.to_array(),
                });
            }
            continue;
        }
        // Coarse lists retain outlines and the bake's lighting boundaries.
        // No camera-specific scene copies: all six shots share these draws.
        // Keep the visible aperture of overlay panes intact.
        let thin = (daytime && mat.polygon_offset.is_none() && draw.node.is_none() && draw.skin.is_none())
            .then(|| thin::select(draw, eye, pixel));
        narrow_triangles += thin.as_ref().map_or(0, |t| t.narrow_triangles);
        let indices = if daytime && mat.polygon_offset.is_some() {
            draw.indices()
        } else if let Some(t) = &thin {
            &t.indices
        } else {
            draw.lods().last().map(|l| l.indices.as_slice()).unwrap_or(draw.indices())
        };
        let glow = glow_materials.get(&(draw.material as usize)).copied();
        let mut glow_colors = Vec::new();
        let mut remap = HashMap::<u16, u16>::new();
        let mut vertices = Vec::new();
        let mut weights = Vec::new();
        let mut out_indices = Vec::new();
        let mut selected: Vec<u16> = indices.iter().map(|&i| u16::try_from(i).expect("GE index overflow")).collect();
        if draw.node.is_some() || draw.skin.is_some() {
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
                    draw.skin.is_some() && scene.vertex(draw, i).weights.iter().filter(|&&w| w > 0).count() > 1
                })
                .collect();
            if let Some((tris, _)) = crate::geometry::simplify(&verts, &tris, 0.15, 0.025, &locks, 0.02) {
                selected = tris.iter().flatten().map(|&i| i as u16).collect();
            }
        }
        for old in selected {
            let index = *remap.entry(old).or_insert_with(|| {
                let v = scene.vertex(draw, old as usize);
                let normal = v.normal.normalize_or(Vec3::Y);
                let at = v.pos + normal * thin.as_ref().map_or(0.0, |t| t.widen[old as usize]);
                let pos = at.to_array();
                let uv = v.uv.to_array();
                let vc = core::array::from_fn::<_, 3, _>(|i| pc::color::decode(v.color[i] as f32 / 255.0));
                let world_pos = model.transform_point3(at);
                let world_normal = normal_matrix.transform_vector3(normal).normalize_or(normal);
                let mut irradiance = if draw.class == crate::source::VertexClass::Baked {
                    let a = v.light[3] as f32 / 255.0;
                    Vec3::from_array(core::array::from_fn(|i| {
                        (v.light[i] as f32 / 255.0 * a).powi(2) * 64.0
                    }))
                } else {
                    baker.irradiance(world_pos, world_normal, mat.env_strength, true, 1.0)
                };
                if daytime
                    && !(scene.baked_sun && draw.class == crate::source::VertexClass::Baked)
                    && !mat.interior
                    && !matches!(mat.kind, pc::Kind::Unlit | pc::Kind::Water)
                {
                    irradiance += daylight::sun_light(
                        m.sun.as_ref(),
                        occluder.as_ref(),
                        world_pos,
                        world_normal,
                        draw.node.is_none() && draw.skin.is_none(),
                    );
                }
                let base =
                    Vec3::new(mat.color[0], mat.color[1], mat.color[2]) * Vec3::from_array(vc);
                let light = match mat.kind {
                    pc::Kind::Unlit => base,
                    pc::Kind::InteriorWindow => Vec3::new(0.24, 0.18, 0.11) * mat.emissive[0],
                    pc::Kind::Products => base * mat.emissive[0],
                    pc::Kind::Glass => Vec3::new(0.07, 0.10, 0.12),
                    _ if mat.interior => Vec3::from_array(mat.emissive) * Vec3::from_array(vc),
                    _ if glow.is_some() => base * irradiance,
                    _ => base * irradiance + Vec3::from_array(mat.emissive),
                };
                if glow.is_some() {
                    // What the emission adds to the frame, through the haze.
                    let lit = |c: Vec3| Vec3::from(pc::color::tone(c.to_array(), &m.post));
                    let add = lit(crate::pica::vista(m, eye, world_pos, Vec3::from_array(mat.emissive), true)) - lit(Vec3::ZERO);
                    let b = add.to_array().map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
                    glow_colors.push(u32::from_le_bytes([b[0], b[1], b[2], 255]));
                }
                // A vista's height haze between the shots and the surface.
                let light = if mat.fog && !mat.interior {
                    crate::pica::vista(m, eye, world_pos, light, false)
                } else {
                    light
                };
                let alpha = if mat.kind == pc::Kind::Glass {
                    0.14
                } else {
                    mat.color[3] * v.color[3] as f32 / 255.0
                };
                vertices.push(pp::Vertex {
                    uv,
                    color: if daytime {
                        daylight::graded(light, alpha, &m.post)
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
        if let Some(material) = glow {
            let lit: Vec<pp::Vertex> = vertices.iter().zip(&glow_colors).map(|(v, &color)| pp::Vertex { color, ..*v }).collect();
            draws.push(pp::Draw {
                vertices: w.push(&lit),
                indices: w.push(&out_indices),
                weights: w.push(&weights),
                joints: w.push(&joints),
                material,
                node: draw.node.unwrap_or(pp::NONE),
                flags: pp::NO_REFLECT,
                reserved: 0,
                min: draw.min,
                max: draw.max,
            });
        }
        draws.push(pp::Draw {
            vertices: w.push(&vertices),
            indices: w.push(&out_indices),
            weights: w.push(&weights),
            joints: w.push(&joints),
            material: draw.material,
            node: draw.node.unwrap_or(pp::NONE),
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
            min: draw.min,
            max: draw.max,
        });
    }
    let mut nodes: Vec<_> = m
        .nodes
        .iter()
        .map(|n| pp::Node {
            parent: n.parent.unwrap_or(pp::NONE),
            track: w.push(&n.track.as_ref().map(|t| t.iter().flatten().copied().collect::<Vec<f32>>()).unwrap_or_default()),
            translation: n.translation,
            rotation: n.rotation,
            scale: n.scale,
        })
        .collect();
    let mut lights: Vec<_> = m
        .fog_lights
        .iter()
        .filter(|_| !daytime)
        .map(|l| pp::Light {
            pos: l.position,
            color: color(l.color, 1.0),
            radius: l.radius,
            track: w.push(&l.track.map(|t| m.fog_tracks[t as usize].samples.iter().flatten().copied().collect::<Vec<f32>>()).unwrap_or_default()),
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
    // A sky-lit place draws what lies at least SPLIT from every camera in a
    // vista range of its own, then clears depth for the near range: a 16-bit
    // depth buffer from 0.5 m holds a street, not a 70 km horizon. A night
    // street keeps its 300 m far plane.
    let reach = |d: &pp::Draw| {
        let (lo, hi) = (Vec3::from(d.min), Vec3::from(d.max));
        cameras.iter().fold((f32::MAX, 0.0f32), |(near, far), &c| {
            (near.min((c.clamp(lo, hi) - c).length()), far.max((c - lo).abs().max((c - hi).abs()).length()))
        })
    };
    let (mut far, mut vista) = (300.0f32, (f32::MAX, 0.0f32));
    if daytime {
        far = 0.0;
        for d in &mut draws {
            let (near, farthest) = reach(d);
            if d.node == pp::NONE && d.weights.count == 0 && near > SPLIT {
                d.flags |= pp::FAR;
                vista = (vista.0.min(near), vista.1.max(farthest));
            } else {
                far = far.max(farthest);
            }
        }
        far = far.max(300.0) * 1.02;
    }
    batch_geometry(&mut w, &mut draws, &materials);
    compact(&mut w, &mut textures, &mut draws, &mut nodes, &mut lights);
    let field = lights::cook(m, eye, &mut w, &mut textures);
    if let Some(f) = &field {
        vista = (vista.0.min(f.nearest), vista.1.max(f.farthest));
    }
    let vista = if vista.1 > 0.0 { (vista.0 * 0.9, vista.1 * 1.02) } else { (0.0, 0.0) };
    let mut h = pp::Header::zeroed();
    h.magic = pp::MAGIC;
    h.version = pp::VERSION;
    h.rain = (!daytime && m.rain.active) as u32;
    let (sky_vertices, sky_texture) = if daytime {
        daylight::sky(m, &mut w, &mut textures)
    } else {
        (pp::Span::default(), pp::NONE)
    };
    h.sky_vertices = sky_vertices;
    h.sky_texture = sky_texture;
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
    h.fog_color = if daytime {
        daylight::graded(Vec3::from(m.atmosphere.fog_color), 1.0, &m.post)
    } else {
        color(m.atmosphere.fog_color, 1.0)
    };
    h.sky_color = if daytime {
        daylight::graded(Vec3::from(m.atmosphere.sky_horizon), 1.0, &m.post)
    } else {
        color(m.atmosphere.sky_horizon, 1.0)
    };
    // GE fog is linear: a sky-lit place's runs where the authored exp² fog
    // goes from 5% to 95%; a vista's haze is in its vertex colours.
    let density = m.atmosphere.fog_density;
    (h.fog_near, h.fog_far) = if !daytime {
        (12.0, (1.8 / density.max(0.001)).min(250.0))
    } else if m.vista_haze.is_some() || density <= 0.0 {
        (0.0, 0.0)
    } else {
        (0.226 / density, 1.73 / density)
    };
    h.far = far;
    (h.vista_near, h.vista_far) = vista;
    if let Some(f) = &field {
        h.sprites = w.push(&f.groups);
        h.sprite_texture = f.texture;
    } else {
        h.sprite_texture = pp::NONE;
    }
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
    pp::validate(&w.0).map_err(|e|format!("PSP pack: {e}"))?;
    let triangles: u32 = draws.iter().map(|d| d.indices.count / 3).sum();
    let vertices_total: u32 = draws
        .iter()
        .map(|d| (d.vertices.offset, d.vertices.count))
        .collect::<std::collections::BTreeSet<_>>()
        .iter()
        .map(|v| v.1)
        .sum();
    let report = serde_json::json!({"target":"psp","kind":m.kind,"skyTriangles":h.sky_vertices.count / 3,"sunBake":daytime && m.sun.is_some(),"rain":h.rain != 0,"draws":draws.len(),"triangles":triangles,"vertices":vertices_total,"textures":textures.len(),"bytes":w.0.len(),"far":h.far,"vista":[h.vista_near,h.vista_far],"farDraws":draws.iter().filter(|d|d.flags & pp::FAR != 0).count(),"narrowTriangles":narrow_triangles,"fog":[h.fog_near,h.fog_far],"sprites":field.as_ref().map_or(0,|f|f.sprites),"spriteGroups":field.as_ref().map_or(0,|f|f.groups.len()),"animatedNodes":nodes.iter().filter(|n|n.track.count>0).count(),"skinnedDraws":draws.iter().filter(|d|d.weights.count>0).count(),"shots":shots.len()});
    Ok(Artifact {
        bytes: w.0, summary: report, sections: Default::default(),
        textures: textures.iter().enumerate().map(|(id,t)|serde_json::json!({"id":id,"sourceTextures":tex_map.iter().filter_map(|(source,output)|(*output as usize==id).then_some(*source)).collect::<std::collections::BTreeSet<_>>(),"sources":tex_map.iter().filter(|(_,output)|**output as usize==id).flat_map(|(source,_)|crate::provenance::texture_sources(scene,*source as usize)).collect::<std::collections::BTreeSet<_>>(),"width":t.width,"height":t.height,"levels":t.mips,"bytes":t.pixels.count})).collect(),
    })
}

/// Share one vertex buffer across spatial chunks of the same material. The
/// runtime can concatenate only the visible chunks' indices into one GE draw.
fn batch_geometry(w: &mut Writer, draws: &mut [pp::Draw], materials: &[pp::Material]) {
    let mut groups = std::collections::BTreeMap::<(u32, u32), Vec<usize>>::new();
    for (i, d) in draws.iter().enumerate() {
        if d.node == pp::NONE
            && d.weights.count == 0
            && materials[d.material as usize].flags & pp::ALPHA == 0
        {
            groups.entry((d.material, d.flags)).or_default().push(i);
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
            for &i in &group[start..end] {
                let d = &draws[i];
                let base = verts.len() as u16;
                let source = pp::slice::<pp::Vertex>(&w.0, d.vertices).unwrap();
                verts.extend_from_slice(source);
                indices.push(
                    pp::slice::<u16>(&w.0, d.indices)
                        .unwrap()
                        .iter()
                        .map(|&v| v + base)
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

/// Discard superseded geometry and retain shared ranges exactly once.
fn compact(
    w: &mut Writer,
    textures: &mut [pp::Texture],
    draws: &mut [pp::Draw],
    nodes: &mut [pp::Node],
    lights: &mut [pp::Light],
) {
    let mut out = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
    let mut copied = HashMap::<(u32, u32, usize), pp::Span>::new();
    let mut copy = |span: &mut pp::Span, stride: usize| {
        if span.count == 0 {
            *span = pp::Span::default();
            return;
        }
        let key = (span.offset, span.count, stride);
        *span = *copied.entry(key).or_insert_with(|| {
            let start = span.offset as usize;
            let s = out.push(&w.0[start..start + span.count as usize * stride]);
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
        copy(&mut d.vertices, core::mem::size_of::<pp::Vertex>());
        copy(&mut d.indices, 2);
        copy(&mut d.weights, 8);
        copy(&mut d.joints, core::mem::size_of::<pp::Joint>());
    }
    for n in nodes {
        copy(&mut n.track, 4);
    }
    for l in lights {
        copy(&mut l.track, 4);
    }
    *w = out;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn coarse_sun_rejects_unresolved_contacts_but_retains_building_shadows() {
        for normal in [Vec3::Y, Vec3::Z] {
            let u = Vec3::X;
            let v = normal.cross(u);
            let mut sun = pc::Sun {
                direction: normal.to_array(), radiance: [3.0; 3],
                shadow: Some(pc::SunShadow { position: [0.0; 3], ortho: [-4.0,4.0,-4.0,4.0,0.1,10.0], map_size: 512, bias: 0.0, normal_bias: 0.0, radius: 1.0 }),
            };
            for (distance, blocked) in [(0.1, false), (2.0, true)] {
                let o = crate::occlusion::Occluder::new(vec![crate::occlusion::Tri {
                    a: normal * distance - u * 2.0 - v * 2.0, e1: u * 8.0, e2: v * 8.0, opacity: 1.0,
                }], 32, 4.0);
                let c = static_sun_light(Some(&sun), Some(&o), Vec3::ZERO, normal);
                assert_eq!(c.x < 0.01, blocked);
                assert!(o.visibility(Vec3::ZERO, normal) < 1.0, "AO retains contact detail");
                sun.shadow = None;
                assert!(static_sun_light(Some(&sun), Some(&o), Vec3::ZERO, normal).x > 0.9);
                sun.shadow = Some(pc::SunShadow { position: [0.0; 3], ortho: [-4.0,4.0,-4.0,4.0,0.1,10.0], map_size: 512, bias: 0.0, normal_bias: 0.0, radius: 1.0 });
            }
        }
    }

    #[test]
    fn converts_daylight_sky_and_disables_night_effects_without_changing_night() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.pocket-build/validation/psp-daylight-tests");
        std::fs::create_dir_all(&root).unwrap();
        let key = serde_json::json!({"pos":[0,1,3],"target":[0,1,0],"fov":50});
        for kind in daylight::KINDS {
            let meta = serde_json::json!({
                "name":"Daylight conversion regression","kind":kind,
                "min":[-10,0,-10],"max":[10,20,10],"textures":[],"materials":[],"draws":[],
                "nodes":[],"skins":[],"lights":[],"fog_tracks":[],"material_tracks":[],
                "fog_lights":[{"position":[1,2,3],"color":[1,0.5,0.2],"intensity":1,"radius":2,"spot":null,"track":null}],
                "fps":30,"frames":1,"beacons":[],"doors":null,"stats":{},
                "atmosphere":{"fog_color":[0.4,0.5,0.6],"fog_density":0.003,"haze_density":0,
                    "haze_ambient":[0,0,0],"haze_ambient_density":0,"dry_min":[0,0,0],"dry_max":[0,0,0],
                    "hemisphere_sky":[0.4,0.45,0.5],"hemisphere_ground":[0.2,0.2,0.2],
                    "sky_zenith":[0.1,0.2,0.4],"sky_horizon":[0.4,0.5,0.6],"sky_glow":[0,0,0],
                    "environment":null,"environment_strength":0},
                "rain":{"active":true,"dry_boxes":[],"drip_edges":[],"steam_vents":[]},
                "camera":{"shots":[{"name":"Sky","from":key,"to":key,"duration":10}],"intro":key,"walkable":[]},
                "day_sky":{"zenith":[0.1,0.2,0.4],"horizon":[0.4,0.5,0.6],"ground":[0.04,0.04,0.04],
                    "gradient_power":1,"ground_blend":2,"sun_direction":[1,0,0],"sun_color":[1,1,1],
                    "glow":0,"glow_wide":[1,2],"glow_tight":[1,20],"disc":0,
                    "disc_cos_inner":0.9999,"disc_cos_outer":0.999,"clouds":null,
                    "cloud_sun":[1,1,1],"cloud_ambient":[0.1,0.1,0.1],"fade_elevation":0.1,"drift":0.001}
            });
            let output = root.join(format!("{kind}.psp.place"));
            let scene = crate::source::Scene {
                provenance: serde_json::Value::Null,
                name: "Daylight conversion regression".into(), kind: kind.into(),
                min: [-10.0,0.0,-10.0], max: [10.0,20.0,10.0],
                textures: vec![], materials: vec![], draws: vec![], nodes: vec![], skins: vec![],
                lights: vec![], fog_tracks: vec![], material_tracks: vec![],
                fog_lights: serde_json::from_value(meta["fog_lights"].clone()).unwrap(),
                fps: 30.0, frames: 1, atmosphere: serde_json::from_value(meta["atmosphere"].clone()).unwrap(),
                rain: serde_json::from_value(meta["rain"].clone()).unwrap(),
                camera: serde_json::from_value(meta["camera"].clone()).unwrap(),
                day_sky: serde_json::from_value(meta["day_sky"].clone()).unwrap(),
                doors: None, beacons: vec![], effects: Default::default(), sun: None,
                post: Default::default(), vista_haze: None, stats: serde_json::json!({}),
                baked_sun: false,
            };
            let artifact = cook(&scene, &Profile::builtin(crate::ir::Target::Psp)).unwrap();
            std::fs::write(&output, &artifact.bytes).unwrap();
            let bytes = artifact.bytes;
            let h = pp::validate(&bytes).unwrap();
            assert_eq!(core::mem::size_of::<pp::Header>(), 176);
            if kind == "night-street" {
                // A night street keeps its 300 m range and its fog.
                assert_eq!((h.far, h.vista_far), (300.0, 0.0));
                assert_eq!((h.fog_near, h.fog_far), (12.0, (1.8f32 / 0.003).min(250.0)));
                assert_eq!(h.rain, 1);
                assert_eq!(h.lights.count, 1);
                assert_eq!(h.sky_texture, pp::NONE);
                assert_eq!(h.sky_vertices.count, 0);
                assert_eq!(h.sky_color, color([0.4, 0.5, 0.6], 1.0));
            } else {
                // Linear fog where the authored exp² fog runs from 5% to 95%.
                assert_eq!((h.fog_near, h.fog_far), (0.226 / 0.003, 1.73 / 0.003));
                assert!(h.far >= 300.0 && h.vista_far == 0.0);
                assert_eq!(h.rain, 0);
                assert_eq!(h.lights.count, 0);
                assert_eq!(h.sky_vertices.count, 32 * 16 * 6);
                let t =
                    &pp::slice::<pp::Texture>(&bytes, h.textures).unwrap()[h.sky_texture as usize];
                assert_eq!((t.width, t.height), (512, 256));
                assert_eq!(t.format, pp::RGBA8888);
                let pixels = pp::slice::<u32>(
                    &bytes,
                    pp::Span {
                        offset: t.pixels.offset,
                        count: t.pixels.count / 4,
                    },
                )
                .unwrap();
                assert!(pixels.iter().all(|v| v & 0xff000000 == 0xff000000));
                // This fixture has no directional glow/clouds: a sky row must
                // stay azimuth-invariant, with no magnified Bayer checkerboard.
                let pixel = |x: usize, y: usize| {
                    let byte = ((y / 8) * (512 * 4 / 16) + x * 4 / 16) * 128
                        + (y % 8) * 16 + x * 4 % 16;
                    pixels[byte / 4]
                };
                for y in [90, 128, 170, 220] {
                    for x in 1..512 {
                        assert_eq!(pixel(x, y), pixel(0, y));
                    }
                }
                assert!(pixels.iter().any(|v| v.to_le_bytes()[0] % 17 != 0));
                assert_ne!(
                    pixels[0],
                    pixels[pixels.len() - 1],
                    "ground and zenith retain different colours"
                );
                // Payload corruption must be caught before passing pointers to GE.
                let mut bad = bytes.clone();
                bad[h.sky_vertices.offset as usize + 12..h.sky_vertices.offset as usize + 16]
                    .copy_from_slice(&f32::NAN.to_le_bytes());
                assert_eq!(pp::validate(&bad).err(), Some("sky vertex"));
                let mut bad = bytes.clone();
                let head = bytemuck::from_bytes_mut::<pp::Header>(&mut bad[..core::mem::size_of::<pp::Header>()]);
                head.sky_texture = head.textures.count;
                assert_eq!(pp::validate(&bad).err(), Some("sky geometry"));
                let mut bad = bytes.clone();
                let at = h.textures.offset as usize
                    + h.sky_texture as usize * core::mem::size_of::<pp::Texture>() + 24;
                bad[at..at + 4].copy_from_slice(&99u32.to_le_bytes());
                assert_eq!(pp::validate(&bad).err(), Some("texture format"));
                bad[at..at + 4].copy_from_slice(&pp::RGBA4444.to_le_bytes());
                assert_eq!(pp::validate(&bad).err(), Some("texture layout"));
            }
        }
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
