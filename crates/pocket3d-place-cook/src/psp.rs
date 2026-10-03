//! Shared fixed-function adaptation of a cooked place. Static irradiance is
//! already baked by the common cooker. PSP stores compact indexed GE vertices,
//! RGBA4444 swizzled textures and the original rigid/skeletal animation.
use bytemuck::{Pod, Zeroable};
use glam::Vec3;
use pocket3d_place as pc;
use pocket3d_place_psp as pp;
use std::{collections::HashMap, path::Path};

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
fn word(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}
fn float(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

/// GE swizzle: 16-byte × 8-row blocks, not Morton order.
pub(super) fn swizzle(pixels: &[u8], row: usize, height: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len());
    for y in (0..height).step_by(8) {
        for x in (0..row).step_by(16) {
            for dy in 0..8 {
                out.extend_from_slice(&pixels[(y + dy) * row + x..(y + dy) * row + x + 16]);
            }
        }
    }
    out
}

pub fn cook(input: &Path, output: &Path) {
    let bytes = std::fs::read(input).expect("input place");
    let pack = pc::Pack::parse(&bytes).expect("cook this revision's Vita pack first");
    let m = pack.meta().expect("place metadata");
    assert!(m.driving.is_none(), "Driving worlds require a GE residency/compiler and driving runtime; use the Vita target");
    assert_eq!(
        m.kind, "night-street",
        "PSP currently supports the night-street material/effect set"
    );
    let tex = pack.section(pc::TAG_TEXTURES).unwrap();
    let geom = pack.section(pc::TAG_GEOMETRY).unwrap();
    let anim = pack.section(pc::TAG_ANIMATION).unwrap();
    let mut w = Writer(vec![0; core::mem::size_of::<pp::Header>()]);
    let mut textures = Vec::new();
    let mut tex_map = HashMap::new();
    for mat in &m.materials {
        if let Some(id) = mat.albedo.or(mat.emission) {
            if tex_map.contains_key(&id) {
                continue;
            }
            let t = &m.textures[id as usize];
            let source = &tex[t.data.offset as usize..(t.data.offset + t.data.size) as usize];
            let mut rgba = vec![0; (t.width * t.height * 4) as usize];
            match t.format {
                pc::TexFormat::Bc1 => texpresso::Format::Bc1.decompress(
                    source,
                    t.width as usize,
                    t.height as usize,
                    &mut rgba,
                ),
                pc::TexFormat::Bc3 => texpresso::Format::Bc3.decompress(
                    source,
                    t.width as usize,
                    t.height as usize,
                    &mut rgba,
                ),
                pc::TexFormat::Rgba8 => {
                    rgba.copy_from_slice(&source[..(t.width * t.height * 4) as usize])
                }
                _ => panic!("unsupported PSP colour texture {}", t.name),
            }
            let luminous = m.materials.iter().any(|m| {
                m.albedo.or(m.emission) == Some(id)
                    && (m.emissive.iter().any(|&e| e > 0.1) || m.kind == pc::Kind::Unlit)
            });
            let cap = if luminous { 512 } else { 128 };
            let width = t.width.min(cap).max(8);
            let height = t.height.min(cap).max(8);
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
                &m,
                geom,
                tex,
                &mut w,
                &mut textures,
                &mut materials,
                &mut draws,
            );
            continue;
        }
        // Coarse lists retain outlines and the bake's lighting boundaries.
        // No camera-specific scene copies: all six shots share these draws.
        let indices = draw
            .lods
            .last()
            .map(|l| &l.indices)
            .unwrap_or(&draw.indices);
        let source = &geom[indices.offset as usize..(indices.offset + indices.size) as usize];
        let mut remap = HashMap::<u16, u16>::new();
        let mut vertices = Vec::new();
        let mut weights = Vec::new();
        let mut out_indices = Vec::new();
        let mut selected: Vec<u16> = source
            .chunks_exact(2)
            .map(|v| u16::from_le_bytes(v.try_into().unwrap()))
            .collect();
        if draw.node.is_some() || draw.skin.is_some() {
            let verts: Vec<_> = (0..draw.vertex_count as usize)
                .map(|i| {
                    let offset = draw.vertices.offset as usize + i * draw.layout.stride() as usize;
                    let b = &geom[offset..offset + draw.layout.stride() as usize];
                    crate::geometry::Vertex {
                        pos: Vec3::from_array(core::array::from_fn(|k| {
                            word(b, k * 2) as f32 / 32767.0 * draw.pos_scale[k] + draw.pos_offset[k]
                        })),
                        normal: Vec3::new(b[8] as i8 as f32, b[9] as i8 as f32, b[10] as i8 as f32)
                            .normalize_or(Vec3::Y),
                        uv: glam::Vec2::from_array(core::array::from_fn(|k| {
                            word(b, 16 + k * 2) as f32 / 32767.0 * draw.uv_scale[k]
                                + draw.uv_offset[k]
                        })),
                        color: b[20..24].try_into().unwrap(),
                        ..Default::default()
                    }
                })
                .collect();
            let tris: Vec<_> = selected
                .chunks_exact(3)
                .map(|t| [t[0] as u32, t[1] as u32, t[2] as u32])
                .collect();
            // Keep joint-transition vertices; simplify the rigid portions of
            // each garment/prop while retaining the original bone weights.
            let locks: Vec<bool> = (0..verts.len())
                .map(|i| {
                    draw.skin.is_some() && {
                        let at = draw.vertices.offset as usize + i * 32 + 28;
                        geom[at..at + 4].iter().filter(|&&w| w > 0).count() > 1
                    }
                })
                .collect();
            if let Some((tris, _)) = crate::geometry::simplify(&verts, &tris, 0.15, 0.025, &locks) {
                selected = tris.iter().flatten().map(|&i| i as u16).collect();
            }
        }
        for old in selected {
            let index = *remap.entry(old).or_insert_with(|| {
                let offset =
                    draw.vertices.offset as usize + old as usize * draw.layout.stride() as usize;
                let b = &geom[offset..offset + draw.layout.stride() as usize];
                let pos = core::array::from_fn(|i| {
                    word(b, i * 2) as f32 / 32767.0 * draw.pos_scale[i] + draw.pos_offset[i]
                });
                let uv = core::array::from_fn(|i| {
                    word(b, 16 + i * 2) as f32 / 32767.0 * draw.uv_scale[i] + draw.uv_offset[i]
                });
                let vc = core::array::from_fn::<_, 3, _>(|i| {
                    pc::color::decode(b[20 + i] as f32 / 255.0)
                });
                let normal = Vec3::new(b[8] as i8 as f32, b[9] as i8 as f32, b[10] as i8 as f32)
                    .normalize_or(Vec3::Y);
                let irradiance = if draw.layout == pc::VertexLayout::Baked {
                    let a = b[27] as f32 / 255.0;
                    Vec3::from_array(core::array::from_fn(|i| {
                        (b[24 + i] as f32 / 255.0 * a).powi(2) * 64.0
                    }))
                } else {
                    baker.irradiance(Vec3::from_array(pos), normal, mat.env_strength, true, 1.0)
                };
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
                    mat.color[3] * b[23] as f32 / 255.0
                };
                vertices.push(pp::Vertex {
                    uv,
                    color: color((light * m.post.exposure).to_array(), alpha),
                    pos,
                });
                if draw.layout == pc::VertexLayout::Skinned {
                    weights.push(pp::Weights {
                        joints: b[24..28].try_into().unwrap(),
                        weights: b[28..32].try_into().unwrap(),
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
                        inverse: core::array::from_fn(|k| {
                            float(anim, skin.inverse_bind.offset as usize + i * 64 + k * 4)
                        }),
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
    let mut copy_track = |r: Option<&pc::Range>| {
        let floats: Vec<f32> = r
            .map(|r| {
                anim[r.offset as usize..(r.offset + r.size) as usize]
                    .chunks_exact(4)
                    .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                    .collect()
            })
            .unwrap_or_default();
        w.push(&floats)
    };
    let mut nodes: Vec<_> = m
        .nodes
        .iter()
        .map(|n| pp::Node {
            parent: n.parent.unwrap_or(pp::NONE),
            track: copy_track(n.track.as_ref()),
            translation: n.translation,
            rotation: n.rotation,
            scale: n.scale,
        })
        .collect();
    let mut lights: Vec<_> = m
        .fog_lights
        .iter()
        .map(|l| pp::Light {
            pos: l.position,
            color: color(l.color, 1.0),
            radius: l.radius,
            track: copy_track(l.track.map(|t| &m.fog_tracks[t as usize].data)),
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
    batch_geometry(&mut w, &mut draws, &materials);
    compact(&mut w, &mut textures, &mut draws, &mut nodes, &mut lights);
    let mut h = pp::Header::zeroed();
    h.magic = pp::MAGIC;
    h.version = pp::VERSION;
    h.rain = m.rain.active as u32;
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
    if let Some(d) = m.doors {
        h.doors = [d.left, d.right];
        h.door_trigger = d.trigger;
        h.door_radius = d.radius;
        h.door_travel = d.travel;
    }
    h.bytes = w.0.len() as u32;
    w.0[..core::mem::size_of::<pp::Header>()].copy_from_slice(bytemuck::bytes_of(&h));
    println!(
        "PSP payload: {} bytes, {} textures, {} draws",
        w.0.len(),
        textures.len(),
        draws.len()
    );
    pp::validate(&w.0).expect("PSP pack validation");
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(output, &w.0).unwrap();
    let triangles: u32 = draws.iter().map(|d| d.indices.count / 3).sum();
    let vertices_total: u32 = draws
        .iter()
        .map(|d| (d.vertices.offset, d.vertices.count))
        .collect::<std::collections::BTreeSet<_>>()
        .iter()
        .map(|v| v.1)
        .sum();
    let report = serde_json::json!({"target":"psp","draws":draws.len(),"triangles":triangles,"vertices":vertices_total,"textures":textures.len(),"bytes":w.0.len(),"animatedNodes":nodes.iter().filter(|n|n.track.count>0).count(),"skinnedDraws":draws.iter().filter(|d|d.weights.count>0).count(),"shots":shots.len()});
    std::fs::write(
        output.with_extension("json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{report}");
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
