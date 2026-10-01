//! PICA200 variant of a place. Reuses the canonical geometry, material
//! annotations, lighting bake, cameras and motion; no place-name branches.
//! RGB565/RGBA4 mip chains are tiled offline, and lighting is converted to
//! display-referred vertex colour because PICA200 has fixed TEV combiners.
use crate::textures::{self, Rgba};
use glam::{Mat4, Quat, Vec3};
use pocket3d_place as pc;
use std::{collections::HashMap, path::Path};

fn u32s(out: &mut Vec<u8>, v: &[u32]) {
    for n in v {
        out.extend(n.to_le_bytes());
    }
}
fn fs(out: &mut Vec<u8>, v: &[f32]) {
    for n in v {
        out.extend(n.to_le_bytes());
    }
}
fn align(b: &mut Vec<u8>, n: usize) {
    b.resize(b.len().div_ceil(n) * n, 0);
}
fn readf(b: &[u8], at: usize) -> f32 {
    f32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}
fn q16(b: &[u8], at: usize) -> f32 {
    i16::from_le_bytes([b[at], b[at + 1]]) as f32 / 32767.0
}
fn linear(x: f32) -> f32 {
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}
fn srgb(x: f32) -> f32 {
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.max(0.0).powf(1.0 / 2.4) - 0.055
    }
}
fn byte(x: f32) -> u8 {
    (x.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}
// The same authored AgX/ACES grade as the Vita's colour LUT.
fn grade(c: Vec3, p: &pc::Post) -> Vec3 {
    Vec3::from(pc::color::tone(c.to_array(), p))
}
fn decode(t: &pc::Texture, blob: &[u8]) -> Rgba {
    let data = &blob[t.data.offset as usize..(t.data.offset + t.data.size) as usize];
    let mut rgba = vec![0u8; (t.width * t.height * 4) as usize];
    match t.format {
        pc::TexFormat::Bc1 | pc::TexFormat::Bc3 | pc::TexFormat::Bc5 => {
            let f = match t.format {
                pc::TexFormat::Bc1 => texpresso::Format::Bc1,
                pc::TexFormat::Bc3 => texpresso::Format::Bc3,
                _ => texpresso::Format::Bc5,
            };
            f.decompress(data, t.width as usize, t.height as usize, &mut rgba);
        }
        pc::TexFormat::Rgba8 => {
            let n = rgba.len();
            rgba.copy_from_slice(&data[..n]);
        }
        _ => panic!("PICA material cannot sample {:?}", t.format),
    }
    textures::from_rgba8(t.width, t.height, &rgba, t.role)
}
fn hash(x: f32) -> f32 {
    (x.sin() * 43758.547).fract().abs()
}
fn procedural(kind: pc::Kind) -> Rgba {
    let (w, h) = (256, 256);
    let px = (0..h)
        .flat_map(|y| {
            (0..w).map(move |x| {
                let u = x as f32 / w as f32;
                let v = y as f32 / h as f32;
                match kind {
                    pc::Kind::InteriorWindow => {
                        let tile = (x / 32) + (y / 64) * 8;
                        let lit = hash(tile as f32 * 12.97 + 1.0) > 0.38;
                        let (s, t) = ((x % 32) as f32 / 32.0, (y % 64) as f32 / 64.0);
                        let edge = s < 0.06 || s > 0.94 || t < 0.06 || t > 0.94;
                        let shade = if edge {
                            0.07
                        } else if t < 0.25 {
                            0.4
                        } else {
                            0.6 + 0.35 * t
                        };
                        let curtain = if (s < 0.22 || s > 0.82) && tile % 3 == 0 {
                            0.55
                        } else {
                            1.0
                        };
                        let k = if lit { shade * curtain } else { 0.018 };
                        [k, k * 0.72, k * 0.44, 1.0]
                    }
                    pc::Kind::Skyline => {
                        let (s, t) = (x % 16, y % 16);
                        let tile = x / 16 + (y / 16) * 16;
                        let lit =
                            s > 4 && s < 12 && t > 5 && t < 12 && hash(tile as f32 * 17.17) > 0.78;
                        if lit {
                            [0.32, 0.23, 0.13, 1.0]
                        } else {
                            [0.014, 0.016, 0.021, 1.0]
                        }
                    }
                    pc::Kind::Tower => {
                        let u = (u * 4.0).fract();
                        let v = (v * 16.0).fract();
                        let line = u.min(1.0 - u) < 0.07
                            || v.min(1.0 - v) < 0.045
                            || (u - v).abs() < 0.05
                            || (u + v - 1.0).abs() < 0.05;
                        [1.0, 0.28, 0.035, if line { 1.0 } else { 0.0 }]
                    }
                    _ => [1.0; 4],
                }
            })
        })
        .collect();
    Rgba { w, h, px }
}
/// Morton address inside an 8x8 tile (the screen/UV vertical flip is done once here).
fn morton(x: u32, y: u32) -> usize {
    let mut n = 0;
    for b in 0..3 {
        n |= ((x >> b) & 1) << (2 * b);
        n |= ((y >> b) & 1) << (2 * b + 1);
    }
    n as usize
}
fn tiled(img: &Rgba, alpha: bool) -> Vec<u8> {
    let mut out = vec![0; (img.w * img.h * 2) as usize];
    for y in 0..img.h {
        for x in 0..img.w {
            let p = img.px[((img.h - 1 - y) * img.w + x) as usize];
            let c = [
                byte(srgb(p[0])),
                byte(srgb(p[1])),
                byte(srgb(p[2])),
                byte(p[3]),
            ];
            let v = if alpha {
                ((c[0] as u16 >> 4) << 12)
                    | ((c[1] as u16 >> 4) << 8)
                    | ((c[2] as u16 >> 4) << 4)
                    | (c[3] as u16 >> 4)
            } else {
                ((c[0] as u16 >> 3) << 11) | ((c[1] as u16 >> 2) << 5) | (c[2] as u16 >> 3)
            };
            let i = (((y / 8) * (img.w / 8) + x / 8) * 64) as usize + morton(x % 8, y % 8);
            out[i * 2..i * 2 + 2].copy_from_slice(&v.to_le_bytes());
        }
    }
    out
}
fn rows(m: Mat4) -> [f32; 12] {
    let t = m.transpose();
    let a = t.to_cols_array();
    a[..12].try_into().unwrap()
}

fn repack_geometry(old_geom: Vec<u8>, draws: &mut [Vec<u8>]) -> Vec<u8> {
    // Keep vertices of adjacent static draws with the same material in one
    // contiguous, u16-addressable buffer. Indices retain per-draw LOD ranges;
    // the host can gather only visible chunks into one material submission.
    let mut geom = Vec::new();
    let get = |r: &[u8], o: usize| u32::from_le_bytes(r[o..o + 4].try_into().unwrap());
    let put = |r: &mut [u8], o: usize, v: u32| r[o..o + 4].copy_from_slice(&v.to_le_bytes());
    let mut group_mat = u32::MAX;
    let mut group_count = 65536;
    for d in draws.iter_mut() {
        let mat = get(d, 0);
        let count = get(d, 8);
        let is_static = get(d, 12) == u32::MAX && get(d, 16) == u32::MAX;
        if !is_static || mat != group_mat || group_count + count > 65536 {
            align(&mut geom, 128);
            group_count = 0;
        }
        let start = get(d, 4) as usize;
        put(d, 4, geom.len() as u32);
        geom.extend(&old_geom[start..start + count as usize * 24]);
        group_mat = if is_static { mat } else { u32::MAX };
        group_count += count;
    }
    let mut index_ranges = HashMap::new();
    for d in draws.iter_mut() {
        for k in 0..4 {
            let o = 48 + k * 12;
            let start = get(d, o) as usize;
            let count = get(d, o + 4) as usize;
            let dst = *index_ranges.entry((start, count)).or_insert_with(|| {
                align(&mut geom, 4);
                let offset = geom.len() as u32;
                geom.extend(&old_geom[start..start + count * 2]);
                offset
            });
            put(d, o, dst);
        }
    }
    geom
}

pub fn cook(input: &Path, output: &Path, cap: u32) {
    assert!(
        cap.is_power_of_two() && (64..=1024).contains(&cap),
        "--tex must be a power of two in 64..1024"
    );
    let bytes = std::fs::read(input).expect("read source place");
    let pack = pc::Pack::parse(&bytes).unwrap();
    let m = pack.meta().unwrap();
    let src_tex = pack.section(pc::TAG_TEXTURES).unwrap();
    let src_geom = pack.section(pc::TAG_GEOMETRY).unwrap();
    let src_anim = pack.section(pc::TAG_ANIMATION).unwrap();
    let mut tex = Vec::new();
    let mut geom = Vec::new();
    let mut anim = Vec::new();
    let mut table = Vec::new();
    // PICA header: version and table counts, animation rate, scene atmosphere.
    let mut textures = Vec::new();
    let mut mats = Vec::new();
    let mut texkeys = HashMap::new();
    let mut decoded = HashMap::new();
    for mat in &m.materials {
        let proc = matches!(
            mat.kind,
            pc::Kind::InteriorWindow | pc::Kind::Skyline | pc::Kind::Tower
        );
        let ti = mat.albedo.or(mat.emission);
        let key = (ti, if proc { mat.kind as u32 + 1 } else { 0 });
        let tx = if ti.is_some() || proc {
            *texkeys.entry(key).or_insert_with(|| {
                let src = if proc {
                    procedural(mat.kind)
                } else {
                    let id = ti.unwrap();
                    let d = decoded
                        .entry(id)
                        .or_insert_with(|| decode(&m.textures[id as usize], src_tex));
                    Rgba {
                        w: d.w,
                        h: d.h,
                        px: d.px.clone(),
                    }
                };
                // Text atlases retain 1024 so Japanese lettering survives the 400px display.
                let limit = if src.w >= 4096 { 1024 } else { cap };
                let (w, h) = textures::pow2_fit(src.w, src.h, limit);
                let (w, h) = (w.max(8), h.max(8));
                let mut level = textures::resize(&src, w, h);
                let alpha = src.px.iter().any(|p| p[3] < 0.98);
                align(&mut tex, 128);
                let off = tex.len();
                let mut levels = 0;
                loop {
                    tex.extend(tiled(&level, alpha));
                    levels += 1;
                    if level.w.min(level.h) <= 8 {
                        break;
                    }
                    level = textures::resize(&level, level.w / 2, level.h / 2);
                }
                textures.push([
                    w,
                    h,
                    if alpha { 4 } else { 3 },
                    levels,
                    off as u32,
                    (tex.len() - off) as u32,
                    ti.map_or(0, |i| m.textures[i as usize].wrap_s as u32),
                    ti.map_or(0, |i| m.textures[i as usize].wrap_t as u32),
                ]);
                textures.len() as u32 - 1
            })
        } else {
            u32::MAX
        };
        let mut flags = 0u32;
        if mat.blend != pc::Blend::Opaque {
            flags |= 1;
        }
        if mat.double_sided {
            flags |= 2;
        }
        if mat.wet.as_ref().is_some_and(|w| w.planar) {
            flags |= 4;
        }
        if mat.alpha_test > 0.0 || mat.kind == pc::Kind::Tower {
            flags |= 8;
        }
        if mat.fog && !mat.interior {
            flags |= 16;
        }
        if mat.kind == pc::Kind::Glass {
            flags |= 32;
        }
        if mat.blend == pc::Blend::Additive || mat.kind == pc::Kind::Tower {
            flags |= 64;
        }
        if mat.depth_write {
            flags |= 128;
        }
        let alpha = if mat.kind == pc::Kind::Glass {
            0.16
        } else {
            mat.color[3]
        };
        let wet = mat.wet.as_ref().map_or(0.0, |w| w.puddles);
        mats.push((tx, flags, alpha, wet, mat.roughness, mat.alpha_test));
    }
    let mut draws = Vec::new();
    let mut skin_data = Vec::new();
    // World matrices and joint matrices are sampled once by the cooker.
    // Runtime interpolates 3x4 rows, with the original sample rate retained.
    let frames = m.frames.max(1);
    let matrices = m.nodes.len() + m.skins.iter().map(|s| s.joints.len()).sum::<usize>();
    let mut skin_base = Vec::new();
    let mut at = m.nodes.len();
    for s in &m.skins {
        skin_base.push(at);
        at += s.joints.len();
    }
    let mut world0 = Vec::new();
    for frame in 0..frames {
        let mut world = vec![Mat4::IDENTITY; m.nodes.len()];
        for (i, n) in m.nodes.iter().enumerate() {
            let (t, q) = if let Some(r) = &n.track {
                let p = r.offset as usize + frame as usize % (r.size as usize / 28) * 28;
                (
                    Vec3::new(
                        readf(src_anim, p),
                        readf(src_anim, p + 4),
                        readf(src_anim, p + 8),
                    ),
                    Quat::from_xyzw(
                        readf(src_anim, p + 12),
                        readf(src_anim, p + 16),
                        readf(src_anim, p + 20),
                        readf(src_anim, p + 24),
                    )
                    .normalize(),
                )
            } else {
                (Vec3::from(n.translation), Quat::from_array(n.rotation))
            };
            let local = Mat4::from_scale_rotation_translation(Vec3::from(n.scale), q, t);
            world[i] = n.parent.map_or(local, |p| world[p as usize] * local);
            fs(&mut anim, &rows(world[i]));
        }
        for s in &m.skins {
            for (j, &n) in s.joints.iter().enumerate() {
                let p = s.inverse_bind.offset as usize + j * 64;
                let a: Vec<f32> = (0..16).map(|k| readf(src_anim, p + k * 4)).collect();
                fs(
                    &mut anim,
                    &rows(world[n as usize] * Mat4::from_cols_slice(&a)),
                );
            }
        }
        if frame == 0 {
            world0 = world;
        }
    }
    let baker = crate::bake::Baker::new(
        &m.lights,
        (m.atmosphere.hemisphere_sky, m.atmosphere.hemisphere_ground),
        None,
    );
    for d in &m.draws {
        let mat = &m.materials[d.material as usize];
        let stride = d.layout.stride() as usize;
        align(&mut geom, 16);
        let vo = geom.len();
        let mut positions = Vec::new();
        for i in 0..d.vertex_count as usize {
            let p = &src_geom[d.vertices.offset as usize + i * stride..][..stride];
            let pos = Vec3::from(d.pos_offset)
                + Vec3::new(q16(p, 0), q16(p, 2), q16(p, 4)) * Vec3::from(d.pos_scale);
            let n = Vec3::new(p[8] as i8 as f32, p[9] as i8 as f32, p[10] as i8 as f32)
                .normalize_or(Vec3::Y);
            let mut uv = [
                q16(p, 16) * d.uv_scale[0] + d.uv_offset[0],
                q16(p, 18) * d.uv_scale[1] + d.uv_offset[1],
            ];
            let mut vc = Vec3::new(
                linear(p[20] as f32 / 255.0),
                linear(p[21] as f32 / 255.0),
                linear(p[22] as f32 / 255.0),
            );
            let world = d
                .node
                .map_or(pos, |i| world0[i as usize].transform_point3(pos));
            let light = if d.layout == pc::VertexLayout::Baked {
                let k = p[27] as f32 / 255.0;
                Vec3::new(p[24] as f32, p[25] as f32, p[26] as f32)
                    .map(|v| (v / 255.0 * k).powi(2) * 64.0)
            } else {
                baker.irradiance(world, n, mat.env_strength, false, 1.0) + Vec3::splat(0.08)
            };
            let base = Vec3::new(mat.color[0], mat.color[1], mat.color[2]);
            let color = match mat.kind {
                pc::Kind::Products => {
                    let seed = vc.dot(Vec3::new(12.9898, 78.233, 37.719));
                    let h1 = hash((seed * 0.37 + 1.0) * 12.9898);
                    let h2 = hash((seed * 0.71 + 7.0) * 12.9898);
                    uv = [
                        h1 * 0.93 + uv[0].clamp(0.0, 1.0) * 0.055,
                        ((h2 * 8.0).floor() + 0.08 + uv[1].clamp(0.0, 1.0) * 0.8) / 8.0,
                    ];
                    grade(
                        Vec3::splat(mat.emissive[0] * (0.78 + 0.22 * p[23] as f32 / 255.0)),
                        &m.post,
                    )
                }
                pc::Kind::InteriorWindow => {
                    uv = [uv[0] / 8.0, uv[1] / 4.0];
                    Vec3::splat(0.9)
                }
                pc::Kind::Skyline => {
                    let tangent =
                        Vec3::new(p[12] as i8 as f32, p[13] as i8 as f32, p[14] as i8 as f32)
                            / 127.0;
                    uv = [pos.dot(tangent) / 32.0, pos.y / 52.8];
                    Vec3::ONE
                }
                pc::Kind::Tower => {
                    uv[1] = pos.y / 352.0;
                    Vec3::ONE
                }
                pc::Kind::Unlit => grade(
                    base * if mat.vertex_color { vc } else { Vec3::ONE },
                    &m.post,
                ),
                _ => {
                    if !mat.vertex_color {
                        vc = Vec3::ONE;
                    }
                    let mut albedo = base * vc;
                    if let Some(w) = &mat.wet {
                        albedo *= w.darken;
                    }
                    if let Some(w) = &mat.damp {
                        albedo *= w.darken;
                    }
                    let mut irr = light;
                    if let Some(o) = mat.orm {
                        let orm = m.textures[o as usize].mean;
                        irr *= 1.0 - mat.ao_strength * (1.0 - orm[0]);
                    }
                    // Interior surfaces are lit by authored emission.
                    let mut emission = Vec3::from(mat.emissive);
                    // Authored interior surfaces use vertex color as their lit
                    // palette. Fold their hemispheric emission into the bake.
                    if mat.interior && mat.vertex_color {
                        let t = ((world.y - 0.05) / 1.4).clamp(0.0, 1.0);
                        let height = 0.62 + 0.38 * t * t * (3.0 - 2.0 * t);
                        emission *= vc * ((0.6 + 0.4 * n.y + 0.12 * n.x.abs()) * height);
                    }
                    let rgb = albedo * irr + emission;
                    grade(rgb, &m.post)
                }
            };
            fs(&mut geom, &pos.to_array());
            fs(&mut geom, &uv);
            geom.extend([byte(color.x), byte(color.y), byte(color.z), 255]);
            positions.push(pos);
        }
        let mut lod = Vec::new();
        for (range, count, error) in std::iter::once((&d.indices, d.index_count, 0.0))
            .chain(d.lods.iter().map(|l| (&l.indices, l.index_count, l.error)))
        {
            if lod.len() == 3 {
                break;
            }
            align(&mut geom, 4);
            let off = geom.len();
            geom.extend(&src_geom[range.offset as usize..(range.offset + range.size) as usize]);
            lod.push((off as u32, count, error));
        }
        while lod.len() < 3 {
            lod.push(*lod.last().unwrap());
        }
        // Reflections are sampled at reduced resolution. A separate proxy
        // keeps their silhouette budget independent of the primary mesh LODs.
        let (off, count, _) = lod[2];
        let indices: Vec<u32> = geom[off as usize..off as usize + count as usize * 2]
            .chunks_exact(2)
            .map(|v| u16::from_le_bytes([v[0], v[1]]) as u32)
            .collect();
        let scale = positions
            .iter()
            .copied()
            .fold(Vec3::splat(f32::MIN), Vec3::max)
            - positions
                .iter()
                .copied()
                .fold(Vec3::splat(f32::MAX), Vec3::min);
        let scale = scale.max_element().max(0.001);
        let adapter =
            meshopt::VertexDataAdapter::new(&geom[vo..vo + d.vertex_count as usize * 24], 24, 0)
                .unwrap();
        let mut error = 0.0;
        let proxy = if count > 36 {
            meshopt::simplify_sloppy(
                &indices,
                &adapter,
                (count as usize / 15).max(6) * 3,
                0.4 / scale,
                Some(&mut error),
            )
        } else {
            indices
        };
        let proxy = meshopt::optimize_vertex_cache(&proxy, d.vertex_count as usize);
        align(&mut geom, 4);
        let po = geom.len() as u32;
        for &v in &proxy {
            geom.extend((v as u16).to_le_bytes());
        }
        lod.push((po, proxy.len() as u32, error * scale));
        let skoff = if let Some(s) = d.skin {
            let off = skin_data.len();
            for i in 0..d.vertex_count as usize {
                let p = &src_geom[d.vertices.offset as usize + i * stride..];
                for &j in &p[24..28] {
                    skin_data.extend(((skin_base[s as usize] + j as usize) as u16).to_le_bytes());
                }
                skin_data.extend(&p[28..32]);
            }
            off as u32
        } else {
            u32::MAX
        };
        let lo = positions
            .iter()
            .fold(Vec3::splat(f32::MAX), |a, &p| a.min(p));
        let hi = positions
            .iter()
            .fold(Vec3::splat(f32::MIN), |a, &p| a.max(p));
        let center = (lo + hi) * 0.5;
        let radius = (hi - lo).length() * 0.5;
        // Bounds of skinned people follow their root at runtime.
        let root = d.skin.map_or(u32::MAX, |s| m.skins[s as usize].joints[0]);
        let mut rec = Vec::new();
        u32s(
            &mut rec,
            &[
                d.material,
                vo as u32,
                d.vertex_count,
                skoff,
                d.node.unwrap_or(u32::MAX),
                root,
                d.no_reflect as u32,
                0,
            ],
        );
        fs(&mut rec, &[center.x, center.y, center.z, radius]);
        for (off, n, e) in lod {
            u32s(&mut rec, &[off, n]);
            fs(&mut rec, &[e]);
        }
        draws.push(rec);
    }
    // Canonical street chunks are broad. Subdivide detail-only chunks so
    // approaching one rail does not restore all thin geometry across 32 m.
    let get = |r: &[u8], o: usize| u32::from_le_bytes(r[o..o + 4].try_into().unwrap());
    let put = |r: &mut [u8], o: usize, v: u32| r[o..o + 4].copy_from_slice(&v.to_le_bytes());
    let mut split_draws = Vec::new();
    for d in draws {
        if get(&d, 12) != u32::MAX
            || get(&d, 16) != u32::MAX
            || get(&d, 64) != 0
            || get(&d, 76) != 0
            || readf(&d, 44) <= 8.0
        {
            split_draws.push(d);
            continue;
        }
        let start = get(&d, 48) as usize;
        let count = get(&d, 52) as usize;
        let base = get(&d, 4) as usize;
        let mut cells = std::collections::BTreeMap::<[i32; 3], Vec<u16>>::new();
        for tri in geom[start..start + count * 2].chunks_exact(6) {
            let ix: Vec<u16> = tri
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect();
            let center = ix.iter().fold(Vec3::ZERO, |v, &i| {
                v + Vec3::new(
                    readf(&geom, base + i as usize * 24),
                    readf(&geom, base + i as usize * 24 + 4),
                    readf(&geom, base + i as usize * 24 + 8),
                )
            }) / 3.0;
            let key = center.to_array().map(|v| (v / 8.0).floor() as i32);
            cells.entry(key).or_default().extend(ix);
        }
        for indices in cells.into_values() {
            let mut rec = d.clone();
            let mut vertices: Vec<u8> = Vec::new();
            let mut remap = HashMap::new();
            let mut remapped = Vec::new();
            let mut lo = Vec3::splat(f32::MAX);
            let mut hi = Vec3::splat(f32::MIN);
            for i in indices {
                let index = *remap.entry(i).or_insert_with(|| {
                    let p = base + i as usize * 24;
                    let pos = Vec3::new(readf(&geom, p), readf(&geom, p + 4), readf(&geom, p + 8));
                    lo = lo.min(pos);
                    hi = hi.max(pos);
                    let j = (vertices.len() / 24) as u16;
                    vertices.extend(&geom[p..p + 24]);
                    j
                });
                remapped.extend(index.to_le_bytes());
            }
            align(&mut geom, 16);
            put(&mut rec, 4, geom.len() as u32);
            put(&mut rec, 8, (vertices.len() / 24) as u32);
            geom.extend(vertices);
            let center = (lo + hi) * 0.5;
            let bound = [center.x, center.y, center.z, (hi - lo).length() * 0.5];
            for (k, v) in bound.iter().enumerate() {
                rec[32 + k * 4..36 + k * 4].copy_from_slice(&v.to_le_bytes());
            }
            align(&mut geom, 4);
            put(&mut rec, 48, geom.len() as u32);
            put(&mut rec, 52, (remapped.len() / 2) as u32);
            geom.extend(remapped);
            split_draws.push(rec);
        }
    }
    let mut draws = split_draws;
    assert!(draws.len() <= 4096, "PICA draw limit");
    // Lighting and palette differences are now in vertex colors. Coalesce
    // materials that have identical PICA state, while retaining their original
    // shared-source material shading in the bake above.
    let mut gpu_materials = Vec::new();
    let mut state_ids = HashMap::new();
    let mut material_ids = Vec::new();
    for &(t, f, a, w, r, c) in &mats {
        let key = (
            t,
            f,
            a.to_bits(),
            if f & 4 != 0 { w.to_bits() } else { 0 },
            if f & 4 != 0 { r.to_bits() } else { 0 },
            if f & 8 != 0 { c.to_bits() } else { 0 },
        );
        let id = *state_ids.entry(key).or_insert_with(|| {
            let id = gpu_materials.len() as u32;
            gpu_materials.push((t, f, a, w, r, c));
            id
        });
        material_ids.push(id);
    }
    mats = gpu_materials;
    for d in &mut draws {
        let id = material_ids[get(d, 0) as usize];
        put(d, 0, id);
    }
    draws.sort_by_key(|d| (get(d, 0), get(d, 16) != u32::MAX || get(d, 12) != u32::MAX));
    geom = repack_geometry(geom, &mut draws);
    // PICA binary tables followed by skin weights. All offsets in bytes.
    u32s(
        &mut table,
        &[
            2,
            textures.len() as u32,
            mats.len() as u32,
            draws.len() as u32,
            m.camera.shots.len() as u32,
            matrices as u32,
            frames,
            m.fog_lights.len() as u32,
            m.rain.dry_boxes.len() as u32,
            skin_data.len() as u32,
        ],
    );
    fs(
        &mut table,
        &[
            m.fps,
            m.atmosphere.fog_density,
            m.atmosphere.haze_density,
            m.rain.active as u8 as f32,
        ],
    );
    fs(
        &mut table,
        &grade(Vec3::from(m.atmosphere.fog_color), &m.post).to_array(),
    );
    fs(&mut table, &[m.post.bloom_intensity]);
    fs(
        &mut table,
        &grade(Vec3::from(m.atmosphere.sky_zenith), &m.post).to_array(),
    );
    fs(&mut table, &[m.post.vignette]);
    fs(
        &mut table,
        &grade(Vec3::from(m.atmosphere.sky_horizon), &m.post).to_array(),
    );
    fs(&mut table, &[0.0]);
    for t in &textures {
        u32s(&mut table, t);
    }
    for &(t, f, a, w, r, cut) in &mats {
        u32s(&mut table, &[t, f]);
        fs(&mut table, &[a, w, r, cut]);
    }
    for d in &draws {
        table.extend(d);
    }
    for s in &m.camera.shots {
        let mut name = [0; 32];
        for (a, b) in name.iter_mut().take(31).zip(s.name.as_bytes()) {
            *a = *b;
        }
        table.extend(name);
        for k in [&s.from, &s.to] {
            fs(&mut table, &k.pos);
            fs(&mut table, &k.target);
            fs(&mut table, &[k.fov]);
        }
        fs(&mut table, &[s.duration]);
    }
    for l in &m.fog_lights {
        fs(&mut table, &l.position);
        fs(&mut table, &[l.radius]);
        fs(
            &mut table,
            &grade(Vec3::from(l.color) * l.intensity, &m.post).to_array(),
        );
        fs(&mut table, &[l.intensity]);
    }
    for b in &m.rain.dry_boxes {
        fs(&mut table, &b[0]);
        fs(&mut table, &b[1]);
    }
    table.extend(&skin_data);
    let summary = serde_json::json!({"target":"3ds","version":2,"name":m.name,"kind":m.kind,"sourceMaterials":m.materials.len(),"textures":textures.len(),"draws":draws.len(),"textureBytes":tex.len(),"geometryBytes":geom.len(),"animationBytes":anim.len(),"matrices":matrices,"frames":frames,"fps":m.fps,"camera":m.camera});
    let meta = serde_json::to_vec(&summary).unwrap();
    let out = pc::write(&[
        (pc::TAG_META, &meta, 16),
        (*b"PICA", &table, 16),
        (pc::TAG_TEXTURES, &tex, 128),
        (pc::TAG_GEOMETRY, &geom, 128),
        (pc::TAG_ANIMATION, &anim, 16),
    ]);
    std::fs::create_dir_all(output.parent().unwrap()).unwrap();
    std::fs::write(output, &out).unwrap();
    println!("{}", serde_json::to_string_pretty(&summary).unwrap());
    println!(
        "wrote {} ({:.2} MiB)",
        output.display(),
        out.len() as f64 / 1048576.0
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batching_preserves_vertices_lods_and_shared_ranges() {
        let mut geometry: Vec<u8> = (0..192).map(|v| v as u8).collect();
        geometry.extend([0, 0, 1, 0, 2, 0, 1, 0, 3, 0, 2, 0]);
        let original = geometry.clone();
        let mut draws = Vec::new();
        for i in 0..2 {
            let mut d = Vec::new();
            u32s(&mut d, &[7, i * 96, 4, u32::MAX, u32::MAX, u32::MAX, 0, 0]);
            fs(&mut d, &[0.0; 4]);
            for _ in 0..4 {
                u32s(&mut d, &[192 + i * 6, 3]);
                fs(&mut d, &[0.0]);
            }
            draws.push(d);
        }
        let output = repack_geometry(geometry, &mut draws);
        let get = |r: &[u8], o: usize| u32::from_le_bytes(r[o..o + 4].try_into().unwrap()) as usize;
        assert_eq!(get(&draws[1], 4) - get(&draws[0], 4), 4 * 24);
        for (i, d) in draws.iter().enumerate() {
            let vertices = get(d, 4);
            assert_eq!(
                &output[vertices..vertices + 96],
                &original[i * 96..i * 96 + 96]
            );
            for k in 0..4 {
                let offset = get(d, 48 + k * 12);
                assert_eq!(offset % 4, 0);
                assert_eq!(offset, get(d, 48));
                assert_eq!(
                    &output[offset..offset + 6],
                    &original[192 + i * 6..198 + i * 6]
                );
            }
        }
        // Eight vertices and two shared index ranges; LOD aliases aren't copied four times.
        assert_eq!(output.len(), 206);
    }

    #[test]
    fn morton_covers_one_tile() {
        let mut hits = [false; 64];
        for y in 0..8 {
            for x in 0..8 {
                let i = morton(x, y);
                assert!(!hits[i]);
                hits[i] = true;
            }
        }
        assert!(hits.iter().all(|x| *x));
    }
    #[test]
    fn rgb565_tiling_flips_once_and_preserves_channels() {
        let mut px = vec![[0., 0., 0., 1.]; 64];
        px[0] = [1., 0., 0., 1.];
        px[63] = [0., 0., 1., 1.];
        let b = tiled(&Rgba { w: 8, h: 8, px }, false);
        let pixel = |x, y| {
            u16::from_le_bytes(
                b[morton(x, y) * 2..morton(x, y) * 2 + 2]
                    .try_into()
                    .unwrap(),
            )
        };
        assert_eq!(pixel(0, 7), 0xf800);
        assert_eq!(pixel(7, 0), 0x001f);
    }
}
