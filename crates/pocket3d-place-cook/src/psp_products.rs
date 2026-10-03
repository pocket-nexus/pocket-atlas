//! Collapse coplanar shelf facings into alpha-tested textured cards. This
//! bakes the Products material, not a photograph of a scene or camera shot:
//! cards remain world geometry and work from the free camera and mirror.
use super::psp::{color, swizzle, Writer};
use crate::source as pc;
use pocket3d_place_psp as pp;
use std::collections::BTreeMap;

pub fn cook(
    draw: &pc::Draw,
    mat: &pc::Material,
    scene: &crate::source::Scene,
    w: &mut Writer,
    textures: &mut Vec<pp::Texture>,
    materials: &mut Vec<pp::Material>,
    draws: &mut Vec<pp::Draw>,
) {
    let meta = scene;
    let ids = draw.lods().last().map(|l| l.indices.as_slice()).unwrap_or(draw.indices());
    let mut planes: BTreeMap<(usize, i32), Vec<([f32; 3], [f32; 3], [u8; 4])>> = BTreeMap::new();
    // A product_card has four triangles, front and back. Each side's two
    // triangles share the same normal; process only its positive side.
    let mut cards: BTreeMap<(usize, i32, [i32; 4]), ([f32; 3], [f32; 3], [u8; 4])> =
        BTreeMap::new();
    for tri in ids.chunks_exact(3) {
        let verts: Vec<&crate::geometry::Vertex> = tri.iter().map(|&i| scene.vertex(draw, i as usize)).collect();
        let axis = if verts[0].normal.x.abs() > verts[0].normal.z.abs() {
            0
        } else {
            2
        };
        if verts[0].normal[axis] <= 0.0 {
            continue;
        }
        let lo = core::array::from_fn(|k| verts.iter().map(|v| v.pos[k]).fold(f32::MAX, f32::min));
        let hi = core::array::from_fn(|k| verts.iter().map(|v| v.pos[k]).fold(f32::MIN, f32::max));
        let along = 2 - axis;
        let key = (
            axis,
            ((lo[axis] + hi[axis]) * 0.5 / 0.12).round() as i32,
            [
                (lo[along] * 1000.0).round() as i32,
                (hi[along] * 1000.0).round() as i32,
                (lo[1] * 1000.0).round() as i32,
                (hi[1] * 1000.0).round() as i32,
            ],
        );
        cards.insert(key, (lo, hi, verts[0].color));
    }
    for ((axis, plane, _), card) in cards {
        planes.entry((axis, plane)).or_default().push(card);
    }
    let t = &meta.textures[mat.albedo.unwrap() as usize];
    let art = t.rgba8();
    let ph = |n: f32| {
        let v = (n * 12.9898).sin() * 43758.5453;
        v - v.floor()
    };
    let mut baked = Vec::new();
    for ((axis, plane), cards) in planes {
        let along = 2 - axis;
        let mut lo = [f32::MAX; 3];
        let mut hi = [f32::MIN; 3];
        for (a, b, _) in &cards {
            for k in 0..3 {
                lo[k] = lo[k].min(a[k]);
                hi[k] = hi[k].max(b[k]);
            }
        }
        let width = (((hi[along] - lo[along]) * 48.0).ceil() as u32)
            .next_power_of_two()
            .clamp(8, 128);
        let height = (((hi[1] - lo[1]) * 48.0).ceil() as u32)
            .next_power_of_two()
            .clamp(8, 128);
        let mut pixels = vec![0u16; (width * height) as usize];
        for (a, b, vc) in cards {
            let x0 = ((a[along] - lo[along]) / (hi[along] - lo[along]) * width as f32) as u32;
            let x1 = (((b[along] - lo[along]) / (hi[along] - lo[along]) * width as f32).ceil()
                as u32)
                .min(width);
            let y0 = ((hi[1] - b[1]) / (hi[1] - lo[1]) * height as f32) as u32;
            let y1 = (((hi[1] - a[1]) / (hi[1] - lo[1]) * height as f32).ceil() as u32).min(height);
            let c = core::array::from_fn::<_, 3, _>(|i| pc::color::decode(vc[i] as f32 / 255.0));
            let seed = c[0] * 12.9898 + c[1] * 78.233 + c[2] * 37.719;
            let h1 = ph(seed * 0.37 + 1.0);
            let band = (ph(seed * 0.71 + 7.0) * 8.0).floor();
            for y in y0..y1 {
                for x in x0..x1 {
                    let u = (x - x0) as f32 / (x1 - x0).max(1) as f32;
                    let v = 1.0 - (y - y0) as f32 / (y1 - y0).max(1) as f32;
                    let tx = ((h1 * 0.93 + u * 0.055) * t.width as f32) as usize % t.width as usize;
                    let ty = (((band + 0.08 + v * 0.8) / 8.0) * t.height as f32) as usize
                        % t.height as usize;
                    let light = core::array::from_fn(|i| {
                        let pack = pc::color::decode(
                            art[(ty * t.width as usize + tx) * 4 + i] as f32 / 255.0,
                        ) * 1.15;
                        let mix = 0.85 * (0.75 + 0.25 * h1);
                        (c[i] * (1.0 - mix) + pack * mix) * (0.78 + 0.22 * v) * mat.emissive[0]
                    });
                    let rgba = color(light, 1.0).to_le_bytes();
                    pixels[(y * width + x) as usize] = (rgba[0] as u16 >> 4)
                        | (rgba[1] as u16 >> 4) << 4
                        | (rgba[2] as u16 >> 4) << 8
                        | 0xf000;
                }
            }
        }
        let point = |x, y| {
            let mut p = [0.0; 3];
            p[axis] = plane as f32 * 0.12;
            p[along] = x;
            p[1] = y;
            p
        };
        let verts = [
            pp::Vertex {
                uv: [0.0, 1.0],
                color: 0xffffffff,
                pos: point(lo[along], lo[1]),
            },
            pp::Vertex {
                uv: [1.0, 1.0],
                color: 0xffffffff,
                pos: point(hi[along], lo[1]),
            },
            pp::Vertex {
                uv: [1.0, 0.0],
                color: 0xffffffff,
                pos: point(hi[along], hi[1]),
            },
            pp::Vertex {
                uv: [0.0, 0.0],
                color: 0xffffffff,
                pos: point(lo[along], hi[1]),
            },
        ];
        baked.push((width as usize, height as usize, pixels, verts, lo, hi));
    }

    baked.sort_by_key(|c| core::cmp::Reverse((c.1, c.0)));
    let mut atlas = vec![0u16; 512 * 512];
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let (mut x, mut y, mut row) = (0usize, 0usize, 0usize);
    for (width, height, pixels, mut quad, _, _) in baked {
        if x + width > 512 {
            x = 0;
            y += row;
            row = 0;
        }
        if y + height > 512 {
            emit(
                w,
                textures,
                materials,
                draws,
                &atlas,
                &vertices,
                &indices,
                (y + row).next_power_of_two().min(512),
            );
            atlas.fill(0);
            vertices.clear();
            indices.clear();
            x = 0;
            y = 0;
            row = 0;
        }
        for j in 0..height {
            atlas[(y + j) * 512 + x..(y + j) * 512 + x + width]
                .copy_from_slice(&pixels[j * width..(j + 1) * width]);
        }
        for v in &mut quad {
            v.uv[0] = (x as f32 + 0.5 + v.uv[0] * (width - 1) as f32) / 512.0;
            v.uv[1] = y as f32 + 0.5 + v.uv[1] * (height - 1) as f32;
        }
        let base = vertices.len() as u16;
        vertices.extend(quad);
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        x += width;
        row = row.max(height);
    }
    if !vertices.is_empty() {
        emit(
            w,
            textures,
            materials,
            draws,
            &atlas,
            &vertices,
            &indices,
            (y + row).next_power_of_two().min(512),
        );
    }
}
fn emit(
    w: &mut Writer,
    textures: &mut Vec<pp::Texture>,
    materials: &mut Vec<pp::Material>,
    draws: &mut Vec<pp::Draw>,
    pixels: &[u16],
    vertices: &[pp::Vertex],
    indices: &[u16],
    height: usize,
) {
    let texid = textures.len() as u32;
    textures.push(pp::Texture {
        pixels: w.push(&swizzle(
            bytemuck::cast_slice(&pixels[..512 * height]),
            1024,
            height,
        )),
        width: 512,
        height: height as u32,
        wrap: 3,
        mips: 1,
        format: pp::RGBA4444,
    });
    let matid = materials.len() as u32;
    materials.push(pp::Material {
        texture: texid,
        flags: pp::DOUBLE_SIDED,
        alpha_test: 127,
        grid: [1, 1],
        ..Default::default()
    });
    let vertices: Vec<_> = vertices
        .iter()
        .map(|v| {
            let mut v = *v;
            v.uv[1] /= height as f32;
            v
        })
        .collect();
    let mut lo = [f32::MAX; 3];
    let mut hi = [f32::MIN; 3];
    for v in &vertices {
        for k in 0..3 {
            lo[k] = lo[k].min(v.pos[k]);
            hi[k] = hi[k].max(v.pos[k]);
        }
    }
    draws.push(pp::Draw {
        vertices: w.push(&vertices),
        indices: w.push(indices),
        weights: w.push::<pp::Weights>(&[]),
        joints: w.push::<pp::Joint>(&[]),
        material: matid,
        node: pp::NONE,
        flags: pp::NO_REFLECT,
        min: lo,
        max: hi,
        ..Default::default()
    });
}
