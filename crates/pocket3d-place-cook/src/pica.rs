//! PICA200 variant of a place. Reuses the canonical geometry, material
//! annotations, lighting bake, cameras and motion; no place-name branches.
//! RGB565/RGBA4 mip chains are tiled offline, and lighting is converted to
//! display-referred vertex colour because PICA200 has fixed TEV combiners.
//!
//! The iPod touch 4 (GLES 2 on an SGX535) draws the same table as it is
//! cooked, one texture times one vertex colour (`gles` below). That pack keeps
//! its texels in plain rows and adds what a dusk vista needs (`light_fields`,
//! `vista`), both cooked as seen from the middle of the camera shots.
use crate::textures::{self, Rgba};
use glam::{Mat4, Quat, Vec3};
use pocket3d_place as pc;
use std::collections::HashMap;
use crate::{artifact::Artifact, profile::Profile};

// This schema belongs to PICA, independently of Vita's pc::VERSION.
// tests/pipeline.rs verifies emitted packs against n3ds/src/format.h.
const CONTAINER_VERSION: u32 = 5;
const TABLE_VERSION: u32 = 3;
// ipod/src/scene.c reads the same table from its own container.
const GLES_CONTAINER_VERSION: u32 = 1;

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
fn hash(x: f32) -> f32 {
    (x.sin() * 43758.547).fract().abs()
}
// vita/shaders/common.cgh: the hashes window_f.cg picks a room with.
fn hash32(p: [f32; 2]) -> Vec3 {
    let frac = |v: Vec3| v - v.floor();
    let mut p3 = frac(Vec3::new(p[0], p[1], p[0]) * Vec3::new(0.1031, 0.1030, 0.0973));
    p3 += p3.dot(Vec3::new(p3.y, p3.x, p3.z) + 33.33);
    frac((Vec3::new(p3.x, p3.x, p3.y) + Vec3::new(p3.y, p3.z, p3.z)) * Vec3::new(p3.z, p3.y, p3.x))
}
fn hash12(p: [f32; 2]) -> f32 {
    let frac = |v: Vec3| v - v.floor();
    let mut p3 = frac(Vec3::new(p[0], p[1], p[0]) * 0.1031);
    p3 += p3.dot(Vec3::new(p3.y, p3.z, p3.x) + 33.33);
    ((p3.x + p3.y) * p3.z).fract()
}
/// The light of the room behind a pane as window_f.cg picks it from the
/// pane's seed (the floor of its UV): dark, or a warm or a cool lamp, through
/// the material's tint. GLES draws one neutral room texture times this.
fn room(seed: [f32; 2], mat: &pc::Material) -> Vec3 {
    let h = hash32(seed.map(|s| s * 1.37 + 0.5));
    if h.x >= 0.62 {
        return Vec3::new(0.015, 0.016, 0.02) * mat.emissive[0];
    }
    let lamp = if hash12(seed.map(|s| s + 17.1)) < 0.68 { Vec3::new(1.0, 0.72, 0.45) } else { Vec3::new(0.82, 0.9, 1.0) };
    lamp * Vec3::from(mat.tint.unwrap_or([1.0; 3])) * ((0.55 + h.y * 0.9) * 0.5 * mat.emissive[0])
}
fn procedural(kind: pc::Kind, gles: bool) -> Rgba {
    let (w, h) = (256, 256);
    let px = (0..h)
        .flat_map(|y| {
            (0..w).map(move |x| {
                let u = x as f32 / w as f32;
                let v = y as f32 / h as f32;
                match kind {
                    pc::Kind::InteriorWindow => {
                        let tile = (x / 32) + (y / 64) * 8;
                        // GLES lights each pane by its vertex colour (`room`).
                        let lit = gles || hash(tile as f32 * 12.97 + 1.0) > 0.38;
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
                        if gles { [k, k, k, 1.0] } else { [k, k * 0.72, k * 0.44, 1.0] }
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
/// Texels by the table's format code (0 RGBA8, 3 RGB565, 4 RGBA4). PICA reads
/// bottom-up 8x8 Morton tiles and RGBA8 as ABGR; GLES reads top-down rows.
fn texels(img: &Rgba, format: u32, gles: bool) -> Vec<u8> {
    let size = if format == 0 { 4 } else { 2 };
    let mut out = vec![0; (img.w * img.h) as usize * size];
    for y in 0..img.h {
        for x in 0..img.w {
            let p = img.px[((if gles { y } else { img.h - 1 - y }) * img.w + x) as usize];
            let c = [
                byte(srgb(p[0])),
                byte(srgb(p[1])),
                byte(srgb(p[2])),
                byte(p[3]),
            ];
            let i = size
                * if gles {
                    (y * img.w + x) as usize
                } else {
                    (((y / 8) * (img.w / 8) + x / 8) * 64) as usize + morton(x % 8, y % 8)
                };
            let c16 = c.map(u16::from);
            match format {
                0 => out[i..i + 4].copy_from_slice(&if gles { c } else { [c[3], c[2], c[1], c[0]] }),
                3 => out[i..i + 2].copy_from_slice(
                    &(((c16[0] >> 3) << 11) | ((c16[1] >> 2) << 5) | (c16[2] >> 3)).to_le_bytes(),
                ),
                _ => out[i..i + 2].copy_from_slice(
                    &(((c16[0] >> 4) << 12) | ((c16[1] >> 4) << 8) | ((c16[2] >> 4) << 4) | (c16[3] >> 4))
                        .to_le_bytes(),
                ),
            }
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

// Principal extents make the structural-detail test independent of rotation.
// World-axis bounds classify a diagonal tube as a thick box; face axes fail
// on curved tubes and rings. A symmetric 3x3 Jacobi solve covers both cases.
fn principal_extents(points: &[Vec3]) -> Vec3 {
    let center = points.iter().copied().sum::<Vec3>() / points.len() as f32;
    let mut a = [[0.0f32; 3]; 3];
    for &p in points {
        let d = (p - center).to_array();
        for i in 0..3 {
            for j in 0..3 {
                a[i][j] += d[i] * d[j];
            }
        }
    }
    let mut axes = [Vec3::X, Vec3::Y, Vec3::Z];
    for _ in 0..16 {
        let (p, q) = [(0, 1), (0, 2), (1, 2)]
            .into_iter()
            .max_by(|&(i, j), &(k, l)| a[i][j].abs().total_cmp(&a[k][l].abs()))
            .unwrap();
        if a[p][q].abs() < 1e-10 {
            break;
        }
        let angle = 0.5 * (2.0 * a[p][q]).atan2(a[q][q] - a[p][p]);
        let (s, c) = angle.sin_cos();
        let (ap, aq, off) = (a[p][p], a[q][q], a[p][q]);
        a[p][p] = c * c * ap - 2.0 * s * c * off + s * s * aq;
        a[q][q] = s * s * ap + 2.0 * s * c * off + c * c * aq;
        a[p][q] = 0.0;
        a[q][p] = 0.0;
        for k in 0..3 {
            if k != p && k != q {
                let (x, y) = (a[k][p], a[k][q]);
                a[k][p] = c * x - s * y;
                a[p][k] = a[k][p];
                a[k][q] = s * x + c * y;
                a[q][k] = a[k][q];
            }
        }
        let (x, y) = (axes[p], axes[q]);
        axes[p] = c * x - s * y;
        axes[q] = s * x + c * y;
    }
    let mut lo = Vec3::splat(f32::MAX);
    let mut hi = Vec3::splat(f32::MIN);
    for &p in points {
        let d = p - center;
        let q = Vec3::new(d.dot(axes[0]), d.dot(axes[1]), d.dot(axes[2]));
        lo = lo.min(q);
        hi = hi.max(q);
    }
    let mut e = (hi - lo).to_array();
    e.sort_by(f32::total_cmp);
    Vec3::from(e)
}

fn structural_detail(extent: Vec3, fine: usize, coarse: usize) -> bool {
    fine >= 24
        && coarse * 100 < fine * 45
        && (0.008..=0.12).contains(&extent.x)
        && (0.1..=2.0).contains(&extent.z)
}

/// Preserve compact tubes/rings that canonical distance LODs partly erase.
/// Their coarse geometry stays identical; a separate 2 m cell can select a
/// bounded-error middle LOD without restoring an entire 32 m street chunk.
/// Draw reserved bit 0 marks this near-detail policy (no format-size change).
fn recover_structural_details(
    geom: &mut Vec<u8>,
    draws: Vec<Vec<u8>>,
    eligible_materials: &[bool],
) -> Vec<Vec<u8>> {
    let get = |r: &[u8], o: usize| u32::from_le_bytes(r[o..o + 4].try_into().unwrap()) as usize;
    let put =
        |r: &mut [u8], o: usize, v: usize| r[o..o + 4].copy_from_slice(&(v as u32).to_le_bytes());
    let mut output = Vec::new();
    for d in draws {
        if get(&d, 12) != u32::MAX as usize
            || get(&d, 16) != u32::MAX as usize
            || !eligible_materials[get(&d, 0)]
        {
            output.push(d);
            continue;
        }
        let count = get(&d, 8);
        let base = get(&d, 4);
        let vertices = geom[base..base + count * 24].to_vec();
        let positions: Vec<Vec3> = (0..count)
            .map(|i| {
                Vec3::new(
                    readf(&vertices, i * 24),
                    readf(&vertices, i * 24 + 4),
                    readf(&vertices, i * 24 + 8),
                )
            })
            .collect();
        let lods: [Vec<u32>; 4] = std::array::from_fn(|k| {
            let start = get(&d, 48 + k * 12);
            geom[start..start + get(&d, 52 + k * 12) * 2]
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes([v[0], v[1]]) as u32)
                .collect()
        });
        let mut parent: Vec<usize> = (0..count).collect();
        fn root(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            i
        }
        let join = |parent: &mut [usize], a, b| {
            let (a, b) = (root(parent, a), root(parent, b));
            parent[a] = b;
        };
        for t in lods[0].chunks_exact(3) {
            join(&mut parent, t[0] as usize, t[1] as usize);
            join(&mut parent, t[1] as usize, t[2] as usize);
        }
        let mut at = HashMap::new();
        for (i, p) in positions.iter().enumerate() {
            let first = *at.entry(p.to_array().map(f32::to_bits)).or_insert(i);
            join(&mut parent, first, i);
        }
        let roots: Vec<usize> = (0..count).map(|i| root(&mut parent, i)).collect();
        let mut parts = std::collections::BTreeMap::<usize, [Vec<u32>; 4]>::new();
        for (k, indices) in lods.iter().enumerate() {
            for t in indices.chunks_exact(3) {
                let r = roots[t[0] as usize];
                debug_assert!(k == 3 || t.iter().all(|&i| roots[i as usize] == r));
                parts.entry(r).or_default()[k].extend(t);
            }
        }
        let adapter = meshopt::VertexDataAdapter::new(&vertices, 24, 0).unwrap();
        let attrs: Vec<f32> = vertices
            .chunks_exact(24)
            .flat_map(|v| {
                [
                    readf(v, 12),
                    readf(v, 16),
                    v[20] as f32 / 255.0,
                    v[21] as f32 / 255.0,
                    v[22] as f32 / 255.0,
                ]
            })
            .collect();
        let locked = vec![false; count];
        let mut retained: [Vec<u32>; 4] = Default::default();
        let mut cells = std::collections::BTreeMap::<[i32; 3], [Vec<u32>; 4]>::new();
        for (_, mut part) in parts {
            let mut used = part[0].clone();
            used.sort_unstable();
            used.dedup();
            let points: Vec<Vec3> = used.iter().map(|&i| positions[i as usize]).collect();
            if points.is_empty()
                || !structural_detail(
                    principal_extents(&points),
                    part[0].len() / 3,
                    part[2].len() / 3,
                )
            {
                for k in 0..4 {
                    retained[k].extend(&part[k]);
                }
                continue;
            }
            // The middle LOD removes tessellation, never whole components.
            // UV and display colour still constrain collapses at material seams.
            let simplified = meshopt::simplify_with_attributes_and_locks(
                &part[0],
                &adapter,
                &attrs,
                &[0.05, 0.05, 0.2, 0.2, 0.2],
                20,
                &locked,
                (part[0].len() / 9).max(12) * 3,
                0.008,
                meshopt::SimplifyOptions::ErrorAbsolute,
                None,
            );
            part[1] = if simplified.is_empty() {
                part[0].clone()
            } else {
                simplified
            };
            let lo = points
                .iter()
                .copied()
                .fold(Vec3::splat(f32::MAX), Vec3::min);
            let hi = points
                .iter()
                .copied()
                .fold(Vec3::splat(f32::MIN), Vec3::max);
            let key = ((lo + hi) * 0.25).to_array().map(|v| v.floor() as i32);
            let cell = cells.entry(key).or_default();
            for k in 0..4 {
                cell[k].extend(&part[k]);
            }
        }
        if cells.is_empty() {
            output.push(d);
            continue;
        }
        let mut emit = |indices: [Vec<u32>; 4], detail: bool| {
            if indices[0].is_empty() {
                return;
            }
            let mut rec = d.clone();
            let mut remap = HashMap::new();
            let mut compact: Vec<u8> = Vec::new();
            let mut lo = Vec3::splat(f32::MAX);
            let mut hi = Vec3::splat(f32::MIN);
            let levels: [Vec<u32>; 4] = indices.map(|level| {
                level
                    .into_iter()
                    .map(|i| {
                        *remap.entry(i).or_insert_with(|| {
                            let n = (compact.len() / 24) as u32;
                            compact.extend(&vertices[i as usize * 24..(i as usize + 1) * 24]);
                            lo = lo.min(positions[i as usize]);
                            hi = hi.max(positions[i as usize]);
                            n
                        })
                    })
                    .collect()
            });
            align(geom, 16);
            put(&mut rec, 4, geom.len());
            put(&mut rec, 8, compact.len() / 24);
            put(&mut rec, 28, detail as usize);
            geom.extend(compact);
            let center = (lo + hi) * 0.5;
            for (k, v) in [center.x, center.y, center.z, (hi - lo).length() * 0.5]
                .into_iter()
                .enumerate()
            {
                rec[32 + k * 4..36 + k * 4].copy_from_slice(&v.to_le_bytes());
            }
            for (k, indices) in levels.iter().enumerate() {
                align(geom, 4);
                put(&mut rec, 48 + k * 12, geom.len());
                put(&mut rec, 52 + k * 12, indices.len());
                for &i in &meshopt::optimize_vertex_cache(indices, remap.len()) {
                    geom.extend((i as u16).to_le_bytes());
                }
            }
            if detail {
                rec[68..72].copy_from_slice(&0.008f32.to_le_bytes());
            }
            output.push(rec);
        };
        emit(retained, false);
        for cell in cells.into_values() {
            emit(cell, true);
        }
    }
    output
}

// Display-referred panoramas preserve authored day/twilight colour, sunlight
// and clouds without spending fragment instructions or an HDR target on PICA.
pub(super) fn sky_radiance(s: &pc::DaySky, d: Vec3) -> Vec3 {
    let h = d.y;
    let mut color =
        Vec3::from(s.horizon).lerp(Vec3::from(s.zenith), h.max(0.0).powf(s.gradient_power));
    if h < 0.0 {
        color =
            Vec3::from(s.horizon).lerp(Vec3::from(s.ground), (-h * s.ground_blend).clamp(0.0, 1.0));
    }
    let mu = d.dot(Vec3::from(s.sun_direction)).max(0.0);
    let smooth =
        ((mu - s.disc_cos_outer) / (s.disc_cos_inner - s.disc_cos_outer).max(1e-6)).clamp(0.0, 1.0);
    color += Vec3::from(s.sun_color)
        * (s.glow
            * (s.glow_wide[0] * mu.powf(s.glow_wide[1])
                + s.glow_tight[0] * mu.powf(s.glow_tight[1]))
            + s.disc * smooth * smooth * (3.0 - 2.0 * smooth));
    if let Some(t) = &s.twilight {
        let a = Vec3::new(d.x, 0.0, d.z)
            .normalize_or(Vec3::Z)
            .dot(Vec3::new(s.sun_direction[0], 0.0, s.sun_direction[2]).normalize_or(Vec3::Z))
            .clamp(-1.0, 1.0);
        let toward = (a + 1.0) * 0.5;
        let away = (1.0 - a) * 0.5;
        color += Vec3::from(t.band.color)
            * ((-h.abs() / t.band.height.max(1e-5)).exp()
                * (1.0 - t.band.sun_bias + t.band.sun_bias * toward.powf(t.band.sun_power)));
        let z = (h - t.belt.elevation) / t.belt.width.max(1e-5);
        color += Vec3::from(t.belt.color) * ((-z * z).exp() * away.powf(t.belt.power));
        color *= 1.0
            - t.shadow.strength
                * (-h.abs() / t.shadow.height.max(1e-5)).exp()
                * away.powf(t.shadow.power);
    }
    color
}
// Match a filtered GPU panorama sample (repeat azimuth, clamp elevation).
pub(super) fn bilinear(image: &Rgba, u: f32, v: f32) -> [f32; 4] {
    let x = u * image.w as f32 - 0.5;
    let y = v * image.h as f32 - 0.5;
    let (ix, iy) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - x.floor(), y - y.floor());
    let pixel = |a: i32, b: i32| {
        image.px[b.clamp(0, image.h as i32 - 1) as usize * image.w as usize
            + a.rem_euclid(image.w as i32) as usize]
    };
    let (a, b, c, d) = (
        pixel(ix, iy),
        pixel(ix + 1, iy),
        pixel(ix, iy + 1),
        pixel(ix + 1, iy + 1),
    );
    std::array::from_fn(|k| {
        (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy
    })
}
// Compute the premultiplied *display* contribution, after composing the
// original HDR sky + cloud radiance through the authored tone curve. Simply
// toning the cloud in isolation then blending display RGB darkens its rim.
// Empty sky texels are exactly zero, so bilinear filtering cannot
// introduce a black fringe (runtime blend is ONE, ONE_MINUS_SRC_ALPHA).
fn cloud_overlay(base: Vec3, radiance: Vec3, alpha: f32, post: &pc::Post) -> Vec3 {
    let target = grade(base * (1.0 - alpha) + radiance, post);
    (target - grade(base, post) * (1.0 - alpha)).max(Vec3::ZERO)
}
fn panorama(s: &pc::DaySky, post: &pc::Post, clouds: Option<&Rgba>) -> Rgba {
    let (w, h) = if clouds.is_some() {
        (1024, 512)
    } else {
        (512, 256)
    };
    let px = (0..h)
        .flat_map(|y| {
            (0..w).map(move |x| {
                let az = (x as f32 + 0.5) / w as f32 * std::f32::consts::TAU;
                let elevation = ((y as f32 + 0.5) / h as f32 - 0.5) * std::f32::consts::PI;
                let d = Vec3::new(
                    az.sin() * elevation.cos(),
                    elevation.sin(),
                    -az.cos() * elevation.cos(),
                );
                let (rgb, alpha) = if let Some(c) = clouds {
                    let turn = az / std::f32::consts::TAU;
                    let u = (turn * 2.0).fract();
                    let lv = (elevation.max(0.0) / std::f32::consts::FRAC_PI_2).sqrt();
                    let v = ((turn * 2.0).floor() + lv.clamp(0.5 / 512.0, 1.0 - 0.5 / 512.0)) * 0.5;
                    let p = bilinear(c, u, v);
                    let f = (d.y / s.fade_elevation.max(1e-5)).clamp(0.0, 1.0);
                    let f = f * f * (3.0 - 2.0 * f);
                    let radiance =
                        (Vec3::from(s.cloud_sun) * p[1] + Vec3::from(s.cloud_ambient) * p[2]) * f;
                    (
                        cloud_overlay(sky_radiance(s, d), radiance, p[0] * f, post),
                        p[0] * f,
                    )
                } else {
                    (grade(sky_radiance(s, d), post), 1.0)
                };
                let c = rgb.map(linear);
                [c.x, c.y, c.z, alpha]
            })
        })
        .collect();
    Rgba { w, h, px }
}
fn push_texture(src: &Rgba, format: u32, gles: bool, tex: &mut Vec<u8>, textures: &mut Vec<[u32; 8]>) -> u32 {
    align(tex, 128);
    let off = tex.len();
    tex.extend(texels(src, format, gles));
    textures.push([
        src.w,
        src.h,
        format,
        1,
        off as u32,
        (tex.len() - off) as u32,
        0,
        1,
    ]);
    textures.len() as u32 - 1
}
/// A dusk vista's height haze between `eye` and `p` (`VistaHaze`), on a
/// scene-linear colour: what is left of it, and the horizon scattered in.
fn vista(m: &crate::source::Scene, eye: Vec3, p: Vec3, c: Vec3, additive: bool) -> Vec3 {
    let Some(h) = &m.vista_haze else { return c };
    let t = h.transmittance(eye.to_array(), p.to_array());
    if additive {
        return c * t;
    }
    let flat = |v: Vec3| Vec3::new(v.x, 0.0, v.z).normalize_or_zero();
    let (base, sun) = m.day_sky.as_ref().map_or((m.atmosphere.sky_horizon, [0.0; 3]), |s| {
        s.horizon_parts(flat(p - eye).dot(flat(Vec3::from(s.sun_direction))))
    });
    let sky = (Vec3::from(base) + Vec3::from(sun) * h.sun_weight(t)) * h.gain;
    c * t + (sky + Vec3::from(h.glow) * h.relative_density(p.y)) * (1.0 - t)
}

/// The sprites of one GLES light field, 52 bytes each: position, radius,
/// path, path cycles, phase, blink cycles, duty, 1 / k and the display colour
/// with the twinkle in alpha. A vista's lights sit kilometres from cameras
/// that move tens of metres, so the colour is the light's energy
/// k² = (D / S)² (`pc::LightField`) through `air` and the tone curve
/// `display` as `eye` sees it with `focal` = H / tan(fovY / 2); the vertex
/// program scales it by its own k over the k here. Sprites blend after the
/// tone curve on this target, so still, steady lights beyond 1 km within a
/// pixel and a half of each other there (sprites are wider) are summed into
/// one before it: a hundred of them would otherwise add up to white. What
/// the curve leaves at black is dropped.
fn sprites(lights: &[pc::LightPoint], f: &pc::LightField, eye: Vec3, focal: f32, height: f32, air: impl Fn(Vec3, Vec3) -> Vec3, display: impl Fn(Vec3) -> Vec3) -> Vec<u8> {
    let (lo, hi) = (f.min_pixels * height / 272.0, f.max_pixels * height / 272.0);
    // (energy, position weighted by energy with the weight in w, first light with the largest radius)
    let mut cells: std::collections::BTreeMap<Option<[i32; 2]>, Vec<(Vec3, glam::Vec4, pc::LightPoint)>> = Default::default();
    for l in lights {
        let v = Vec3::from(l.position) - eye;
        let dist = v.length().max(0.01);
        let size = l.radius * focal / dist;
        let k = (size / size.clamp(lo, hi)).min(1.0);
        let energy = air(eye + v, Vec3::from(l.color) * (l.intensity * f.gain * k * k));
        let steady = l.path == [0.0; 3] && (l.blink_cycles == 0.0 || l.duty >= 1.0);
        let cell = (steady && dist > 1000.0 && size < lo)
            .then(|| [v.x.atan2(-v.z), (v.y / dist).asin()].map(|a| (a * focal / 3.0).floor() as i32));
        let at = (Vec3::from(l.position).extend(1.0)) * energy.max_element().max(1e-12);
        match cells.entry(cell).or_default() {
            group if cell.is_some() && !group.is_empty() => {
                group[0].0 += energy;
                group[0].1 += at;
                group[0].2.radius = group[0].2.radius.max(l.radius);
            }
            group => group.push((energy, at, *l)),
        }
    }
    let mut points = Vec::new();
    for (energy, at, l) in cells.into_values().flatten() {
        let p = at.truncate() / at.w;
        let dist = (p - eye).length().max(0.01);
        let size = l.radius * focal / dist;
        // Added to the frame: less the curve's own black.
        let color = display(energy) - display(Vec3::ZERO);
        if color.max_element() < 1.5 / 255.0 {
            continue;
        }
        // Scintillation grows over the first 8 km of air; a display colour
        // follows about the square root of the energy.
        let twinkle = l.twinkle * (dist / 8000.0).min(1.0) * 0.35 * 0.5;
        fs(&mut points, &p.to_array());
        fs(&mut points, &[l.radius]);
        fs(&mut points, &l.path);
        fs(&mut points, &[l.path_cycles, l.phase, l.blink_cycles, l.duty, (size.clamp(lo, hi) / size).max(1.0)]);
        points.extend([byte(color.x), byte(color.y), byte(color.z), byte(twinkle * 4.0)]);
    }
    points
}

/// The GLES `FELD` section: a count, then per field its first sprite and
/// count, bounding sphere, sprite sizes in pixels, depth pull and period,
/// then every field's `sprites`.
fn light_fields(m: &crate::source::Scene, eye: Vec3, focal: f32, height: f32) -> Vec<u8> {
    let (mut records, mut points) = (Vec::new(), Vec::new());
    for d in &m.draws {
        let crate::source::Geometry::LightField(lights) = &d.geometry else { continue };
        let f = m.materials[d.material as usize].lights.unwrap_or_default();
        let field = sprites(lights, &f, eye, focal, height, |p, c| vista(m, eye, p, c, true), |c| grade(c, &m.post));
        let (min, max) = (Vec3::from(d.min), Vec3::from(d.max));
        u32s(&mut records, &[points.len() as u32 / 52, field.len() as u32 / 52]);
        fs(&mut records, &((min + max) * 0.5).to_array());
        fs(&mut records, &[(max - min).length() * 0.5, f.min_pixels * height / 272.0, f.max_pixels * height / 272.0, f.depth_pull, f.period]);
        points.extend(field);
    }
    let mut out = Vec::new();
    u32s(&mut out, &[records.len() as u32 / 40]);
    out.extend(records);
    out.extend(points);
    out
}

pub(super) fn sun_occluder(scene: &crate::source::Scene) -> Option<crate::occlusion::Occluder> {
    let m = scene;
    assert!(m.materials.iter().all(|m| !m.vertex_pbr), "PICA lowering requires source materials, not Vita PBR palettes");
    m.sun.as_ref()?.shadow.as_ref()?;
    let mut tris = Vec::new();
    for d in &m.draws {
        let mat = &m.materials[d.material as usize];
        if !d.cast_shadow
            || d.node.is_some()
            || d.skin.is_some()
            || mat.kind == pc::Kind::Glass
            || mat.kind == pc::Kind::Water
            || mat.blend != pc::Blend::Opaque
        {
            continue;
        }
        for tri in d.indices().chunks_exact(3)
        {
            let p: Vec<Vec3> = tri.iter()
                .map(|&v| scene.vertex(d, v as usize).pos)
                .collect();
            tris.push(crate::occlusion::Tri {
                a: p[0],
                e1: p[1] - p[0],
                e2: p[2] - p[0],
                opacity: if mat.alpha_test > 0.0 { 0.55 } else { 1.0 },
            });
        }
    }
    Some(crate::occlusion::Occluder::new(tris, 1, 2000.0))
}

/// Keep the two coarsest shared levels in PICA's three main-view slots.
/// Extra fine rigid levels must not inflate LOD2 or its reflection proxy.
fn main_lods<'a>(indices: &'a [u32], levels: &'a [crate::source::Lod]) -> impl Iterator<Item = (&'a [u32], u32, f32)> {
    std::iter::once((indices, indices.len() as u32, 0.0))
        .chain(levels.iter().skip(levels.len().saturating_sub(2)).map(|l| (l.indices.as_slice(), l.indices.len() as u32, l.error)))
}

pub fn cook(scene: &crate::source::Scene, profile: &Profile) -> Result<Artifact,String> {
    let m = scene;
    let gles = profile.target == crate::ir::Target::Ipod;
    // GLES adds an emission map of its own to the lit surface (MAT_GLOW). One
    // texture times one colour draws a floodlit wall white all over where the
    // map paints cones of light, and a distant tower black between its windows
    // where its body should fade into the haze.
    let glows = |mat: &pc::Material| {
        gles && mat.kind == pc::Kind::Standard && mat.emission.is_some() && mat.albedo != mat.emission
            && mat.blend == pc::Blend::Opaque && mat.alpha_test == 0.0 && !mat.interior
    };
    let eye = m.camera.shots.iter().flat_map(|s| [s.from.pos, s.to.pos]).map(Vec3::from).sum::<Vec3>()
        / (2 * m.camera.shots.len().max(1)) as f32;
    let mut tex = Vec::new();
    let mut geom = Vec::new();
    let mut anim = Vec::new();
    let mut table = Vec::new();
    // PICA header: version and table counts, animation rate, scene atmosphere.
    let mut textures = Vec::new();
    let mut mats = Vec::new();
    let mut texkeys = HashMap::new();
    let mut decoded = HashMap::new();
    // Aggregate usage before deduplication: a texture shared with a dim
    // material must retain the resolution needed by its luminous lettering.
    let mut emissive_strips = vec![false; m.textures.len()];
    for mat in &m.materials {
        if mat.emission.is_some()
            && mat.emissive.iter().copied().fold(0.0, f32::max) > 0.1
            && mat.color[..3].iter().all(|&v| v < 0.1)
        {
            if let Some(ti) = mat.albedo.or(mat.emission) {
                let t = &m.textures[ti as usize];
                if t.wrap_s == pc::Wrap::Clamp
                    && t.wrap_t == pc::Wrap::Clamp
                    && t.width.max(t.height) >= t.width.min(t.height) * 4
                {
                    emissive_strips[ti as usize] = true;
                }
            }
        }
    }
    for mat in &m.materials {
        let proc = matches!(
            mat.kind,
            pc::Kind::InteriorWindow | pc::Kind::Skyline | pc::Kind::Tower
        );
        let water = mat.kind == pc::Kind::Water;
        let ti = if water {
            mat.normal
        } else {
            mat.albedo.or(mat.emission)
        };
        let grid = mat
            .uv_anim
            .map_or([1, 1], |a| [a.cols.max(1), a.rows.max(1)]);
        let mut texture = |ti: Option<u32>| {
        let key = (
            ti,
            if proc || water {
                mat.kind as u32 + 1
            } else {
                0
            },
            grid,
        );
        if ti.is_some() || proc {
            *texkeys.entry(key).or_insert_with(|| {
                let mut src = if proc {
                    procedural(mat.kind, gles)
                } else {
                    let id = ti.unwrap();
                    let d = decoded
                        .entry(id)
                        .or_insert_with(|| m.textures[id as usize].image());
                    Rgba {
                        w: d.w,
                        h: d.h,
                        px: d.px.clone(),
                    }
                };
                if water {
                    // Fixed TEV consumes the wave normals as a bounded luminance
                    // field; two independently scrolling layers modulate the
                    // body/sky Fresnel colour evaluated by the vertex program.
                    for p in &mut src.px {
                        let slope = ((p[0] - 0.5) * 0.7 + (p[1] - 0.5) * 0.5).clamp(-0.4, 0.4);
                        let v = linear((0.88 + slope * 0.28).clamp(0.65, 1.0));
                        *p = [v, v, v, 1.0];
                    }
                }
                // Authored 4K text atlases retain 1024 for the 400px display.
                // The old Vita intermediate had already reduced these to 2K;
                // testing 2K here incorrectly promotes ordinary source maps.
                let detail = src.w>=4096 || grid[0]>1 || grid[1]>1 || ti.is_some_and(|id| emissive_strips[id as usize]);
                let limit = profile.pica_texture_cap(ti.and_then(|id|m.textures[id as usize].usage), detail);
                let (w, h) = textures::pow2_fit(src.w, src.h, limit);
                let (w, h) = (w.max(8), h.max(8));
                let mut level = textures::resize(&src, w, h);
                let alpha = src.px.iter().any(|p| p[3] < 0.98);
                // GLES keeps eight bits behind an alpha channel; RGBA4 bands its gradients.
                let format = if !alpha { 3 } else if gles { 0 } else { 4 };
                align(&mut tex, 128);
                let off = tex.len();
                let mut levels = 0;
                loop {
                    tex.extend(texels(&level, format, gles));
                    levels += 1;
                    if level.w.min(level.h) <= 8 || level.w / grid[0] <= 4 || level.h / grid[1] <= 4
                    {
                        break;
                    }
                    level = textures::resize(&level, level.w / 2, level.h / 2);
                }
                textures.push([
                    w,
                    h,
                    format,
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
        }
        };
        let (tx, glow) = if glows(mat) { (texture(mat.albedo), texture(mat.emission)) } else { (texture(ti), u32::MAX) };
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
        if water {
            flags |= 256;
        }
        if glows(mat) {
            flags |= 512;
        }
        let alpha = if mat.kind == pc::Kind::Glass {
            0.16
        } else {
            mat.color[3]
        };
        let wet = mat.wet.as_ref().map_or(0.0, |w| w.puddles);
        let mut record = Vec::new();
        u32s(&mut record, &[tx, flags]);
        fs(&mut record, &[alpha, wet, mat.roughness, mat.alpha_test]);
        let a = mat.uv_anim.unwrap_or_default();
        u32s(&mut record, &[a.cols.max(1), a.rows.max(1), a.frames]);
        fs(&mut record, &[a.fps, a.scroll[0], a.scroll[1], a.phase]);
        u32s(&mut record, &[mat.emissive_track.unwrap_or(u32::MAX)]);
        let water = mat.water.unwrap_or_default();
        // A MAT_GLOW material has no waves: its emission map's index goes there.
        fs(&mut record, &if glows(mat) { [glow as f32, 0.0, 0.0] } else { water.waves[0] });
        fs(&mut record, &water.waves[1]);
        fs(
            &mut record,
            &[mat.normal_scale, water.mask, water.distance_roughness],
        );
        assert_eq!(record.len(), 92);
        mats.push(record);
    }
    let mut draws = Vec::new();
    let mut skin_data = Vec::new();
    // World matrices and joint matrices are sampled once by the cooker.
    // Runtime interpolates 3x4 rows, with the original sample rate retained.
    let mut used_nodes = std::collections::BTreeSet::new();
    for d in &m.draws {
        if let Some(n) = d.node {
            used_nodes.insert(n);
        }
    }
    for skin in &m.skins {
        if let Some(&root) = skin.joints.first() {
            used_nodes.insert(root);
        }
    }
    let used_nodes: Vec<u32> = used_nodes.into_iter().collect();
    let node_map: HashMap<u32, u32> = used_nodes
        .iter()
        .enumerate()
        .map(|(i, &n)| (n, i as u32))
        .collect();
    let matrices = used_nodes.len() + m.skins.iter().map(|s| s.joints.len()).sum::<usize>();
    // Long transport loops need not repeat every rigid transform at 15 Hz.
    // Reduce only if their palette would exceed the Old 3DS animation budget.
    let decimate = ((m.frames.max(1) as usize * matrices.max(1) * 48).div_ceil(profile.recipe.animation_palette_bytes as usize))
        .max(1) as u32;
    let frames = m.frames.max(1).div_ceil(decimate);
    let fps = if m.frames > 0 {
        m.fps * frames as f32 / m.frames as f32
    } else {
        m.fps
    };
    let mut skin_base = Vec::new();
    let mut at = used_nodes.len();
    for s in &m.skins {
        skin_base.push(at);
        at += s.joints.len();
    }
    let mut world0 = Vec::new();
    // Node matrices at eight moments of the loop: GLES lights what moves there.
    let mut poses = Vec::new();
    for sampled in 0..frames {
        let frame = (sampled as u64 * m.frames.max(1) as u64 / frames as u64) as u32;
        let mut world = vec![Mat4::IDENTITY; m.nodes.len()];
        for (i, n) in m.nodes.iter().enumerate() {
            let (t, q) = if let Some(r) = &n.track {
                let sample = r[frame as usize % r.len()];
                (Vec3::new(sample[0], sample[1], sample[2]), Quat::from_xyzw(sample[3], sample[4], sample[5], sample[6]).normalize())
            } else {
                (Vec3::from(n.translation), Quat::from_array(n.rotation))
            };
            let local = Mat4::from_scale_rotation_translation(Vec3::from(n.scale), q, t);
            world[i] = n.parent.map_or(local, |p| world[p as usize] * local);
        }
        for &i in &used_nodes {
            fs(&mut anim, &rows(world[i as usize]));
        }
        for s in &m.skins {
            for (j, &n) in s.joints.iter().enumerate() {
                let a = s.inverse_bind[j];
                fs(
                    &mut anim,
                    &rows(world[n as usize] * Mat4::from_cols_slice(&a)),
                );
            }
        }
        if gles && sampled % (frames / 8).max(1) == 0 {
            poses.push(world.clone());
        }
        if sampled == 0 {
            world0 = world;
        }
    }
    let track_start = anim.len();
    for track in &m.material_tracks {
        let count = track.samples.len().max(1);
        for sampled in 0..frames {
            let frame = sampled as u64 * m.frames.max(1) as u64 / frames as u64;
            fs(
                &mut anim,
                &[track.samples[(frame % count as u64) as usize]],
            );
        }
    }
    for mat in &mut mats {
        let track = u32::from_le_bytes(mat[52..56].try_into().unwrap());
        if track != u32::MAX {
            mat[52..56].copy_from_slice(
                &((track_start + track as usize * frames as usize * 4) as u32).to_le_bytes(),
            );
        }
    }
    // One shadow ray per vertex cuts wedges across whole walls where a shadow
    // map draws an edge: on 480x320 the unshadowed sun over the baked sky
    // occlusion reads cleaner, so GLES takes that.
    let occluder = if gles { None } else { sun_occluder(scene) };
    let baker = crate::bake::Baker::new(
        &m.lights,
        (m.atmosphere.hemisphere_sky, m.atmosphere.hemisphere_ground),
        None,
    );
    for d in &m.draws {
        if matches!(d.geometry, crate::source::Geometry::LightField(_)) {
            continue;
        }
        let mat = &m.materials[d.material as usize];
        let hazed = mat.fog && !mat.interior;
        let additive = mat.blend == pc::Blend::Additive;
        align(&mut geom, 16);
        let vo = geom.len();
        let mut positions = Vec::new();
        // The seed of each vertex's pane (GLES windows: `room`).
        let window = gles && mat.kind == pc::Kind::InteriorWindow;
        let mut panes = vec![[0.0f32; 2]; if window { d.vertex_count() as usize } else { 0 }];
        for t in d.indices().chunks_exact(3).filter(|_| window) {
            let seed = (t.iter().map(|&i| scene.vertex(d, i as usize).uv).sum::<glam::Vec2>() / 3.0).floor().to_array();
            t.iter().for_each(|&i| panes[i as usize] = seed);
        }
        for i in 0..d.vertex_count() as usize {
            let v = scene.vertex(d, i);
            let pos = v.pos;
            let n = v.normal.normalize_or(Vec3::Y);
            let mut uv = v.uv.to_array();
            let mut vc = Vec3::from_array(core::array::from_fn(|k| linear(v.color[k] as f32 / 255.0)));
            let world = d
                .node
                .map_or(pos, |i| world0[i as usize].transform_point3(pos));
            let mut light = if d.class == crate::source::VertexClass::Baked {
                let k = v.light[3] as f32 / 255.0;
                Vec3::new(v.light[0] as f32, v.light[1] as f32, v.light[2] as f32)
                    .map(|v| (v / 255.0 * k).powi(2) * 64.0)
            } else if gles {
                // The mean over its path (a rig goes with its first joint):
                // the first pose of a walker may stand in the dark.
                poses.iter().map(|pose| {
                    let at = d.node.map(|i| pose[i as usize]).or(d.skin.map(|s| {
                        let skin = &m.skins[s as usize];
                        pose[skin.joints[0] as usize] * Mat4::from_cols_slice(&skin.inverse_bind[0])
                    })).unwrap_or(Mat4::IDENTITY);
                    baker.irradiance(at.transform_point3(pos), at.transform_vector3(n).normalize_or(n), mat.env_strength, false, 1.0)
                }).sum::<Vec3>() / poses.len().max(1) as f32 + Vec3::splat(0.08)
            } else {
                baker.irradiance(world, n, mat.env_strength, false, 1.0) + Vec3::splat(0.08)
            };
            let world_n = d.node.map_or(n, |i| {
                world0[i as usize].transform_vector3(n).normalize_or(n)
            });
            if !mat.interior && !matches!(mat.kind, pc::Kind::Unlit | pc::Kind::Water) {
                if let Some(sun) = &m.sun {
                    let direction = Vec3::from(sun.direction);
                    let visibility = occluder
                        .as_ref()
                        .map_or(1.0, |o| o.ray_visibility(world, world_n, direction, 2000.0));
                    light += Vec3::from(sun.radiance)
                        * (world_n.dot(direction).max(0.0)
                            * visibility
                            * std::f32::consts::FRAC_1_PI);
                }
            }
            let base = Vec3::new(mat.color[0], mat.color[1], mat.color[2]);
            let tone = |c: Vec3| grade(if hazed { vista(m, eye, world, c, additive) } else { c }, &m.post);
            let mut strength = None;
            let color = match mat.kind {
                pc::Kind::Products => {
                    let seed = vc.dot(Vec3::new(12.9898, 78.233, 37.719));
                    let h1 = hash((seed * 0.37 + 1.0) * 12.9898);
                    let h2 = hash((seed * 0.71 + 7.0) * 12.9898);
                    uv = [
                        h1 * 0.93 + uv[0].clamp(0.0, 1.0) * 0.055,
                        ((h2 * 8.0).floor() + 0.08 + uv[1].clamp(0.0, 1.0) * 0.8) / 8.0,
                    ];
                    tone(Vec3::splat(mat.emissive[0] * (0.78 + 0.22 * v.color[3] as f32 / 255.0)))
                }
                pc::Kind::InteriorWindow => {
                    uv = [uv[0] / 8.0, uv[1] / 4.0];
                    if gles { tone(room(panes[i], mat)) } else { Vec3::splat(0.9) }
                }
                pc::Kind::Skyline => {
                    let tangent =
                        Vec3::new(v.tangent[0], v.tangent[1], v.tangent[2]);
                    uv = [pos.dot(tangent) / 32.0, pos.y / 52.8];
                    Vec3::ONE
                }
                pc::Kind::Tower => {
                    uv[1] = pos.y / 352.0;
                    Vec3::ONE
                }
                pc::Kind::Water => {
                    let w = mat.water.unwrap_or_default();
                    let body = Vec3::from(w.body).lerp(
                        Vec3::from(w.shallow.unwrap_or(w.body)),
                        if mat.vertex_color {
                            vc.x.clamp(0.0, 1.0)
                        } else {
                            0.0
                        },
                    );
                    uv = [world.x, world.z];
                    tone(body * Vec3::from(m.atmosphere.hemisphere_sky))
                }
                pc::Kind::Unlit => tone(base * if mat.vertex_color { vc } else { Vec3::ONE }),
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
                    if glows(mat) {
                        let lit = grade(vista(m, eye, world, emission, true), &m.post) - grade(Vec3::ZERO, &m.post);
                        strength = Some(byte(lit.max_element()));
                        emission = Vec3::ZERO;
                    }
                    tone(albedo * irr + emission)
                }
            };
            fs(&mut geom, &pos.to_array());
            fs(&mut geom, &uv);
            geom.extend([
                byte(color.x),
                byte(color.y),
                byte(color.z),
                if let Some(strength) = strength {
                    strength
                } else if mat.vertex_color && (mat.blend != pc::Blend::Opaque || mat.alpha_test > 0.0) {
                    v.color[3]
                } else {
                    255
                },
            ]);
            positions.push(pos);
        }
        let mut lod = Vec::new();
        // The shared analysis keeps a skinned mesh whole: its error measure
        // knows no joints. GLES cannot draw a street of people at full detail,
        // so triangles bound to one joint alone, which stay rigid, collapse
        // onto each other there.
        let rigid: Vec<crate::source::Lod> = if gles && d.skin.is_some() {
            let tris: Vec<[u32; 3]> = d.indices().chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
            let mut locked = vec![false; d.vertex_count() as usize];
            for t in &tris {
                let joint = scene.vertex(d, t[0] as usize).joints[0];
                if t.iter().map(|&i| scene.vertex(d, i as usize)).any(|v| v.weights[0] != 255 || v.joints[0] != joint) {
                    t.iter().for_each(|&i| locked[i as usize] = true);
                }
            }
            crate::geometry::lods(d.vertices(), &tris, crate::source::VertexClass::Static, &locked, false, &[0.01, 0.03], 0.02)
                .into_iter()
                .map(|(t, error)| crate::source::Lod { indices: t.into_iter().flatten().collect(), error })
                .collect()
        } else {
            Vec::new()
        };
        // Paint lying on a road collapses within its plane at no measured
        // error: GLES picks levels by that error, so its decals keep theirs.
        let levels = if gles && mat.polygon_offset.is_some() { &[][..] } else if d.skin.is_some() { &rigid } else { d.lods() };
        for (indices, count, error) in main_lods(d.indices(), levels)
        {
            if lod.len() == 3 {
                break;
            }
            align(&mut geom, 4);
            let off = geom.len();
            geom.extend(indices.iter().flat_map(|&i| u16::try_from(i).expect("PICA index overflow").to_le_bytes()));
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
            meshopt::VertexDataAdapter::new(&geom[vo..vo + d.vertex_count() as usize * 24], 24, 0)
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
        let proxy = meshopt::optimize_vertex_cache(&proxy, d.vertex_count() as usize);
        align(&mut geom, 4);
        let po = geom.len() as u32;
        for &v in &proxy {
            geom.extend((v as u16).to_le_bytes());
        }
        lod.push((po, proxy.len() as u32, error * scale));
        let skoff = if let Some(s) = d.skin {
            let off = skin_data.len();
            for i in 0..d.vertex_count() as usize {
                let v = scene.vertex(d, i);
                for &j in &v.joints {
                    skin_data.extend(((skin_base[s as usize] + j as usize) as u16).to_le_bytes());
                }
                skin_data.extend(&v.weights);
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
        let root = d
            .skin
            .map_or(u32::MAX, |s| node_map[&m.skins[s as usize].joints[0]]);
        let mut rec = Vec::new();
        u32s(
            &mut rec,
            &[
                d.material,
                vo as u32,
                d.vertex_count(),
                skoff,
                d.node.map_or(u32::MAX, |n| node_map[&n]),
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
    let eligible_materials: Vec<bool> = m
        .materials
        .iter()
        .map(|mat| {
            mat.kind == pc::Kind::Standard
                && mat.blend == pc::Blend::Opaque
                && mat.emission.is_none()
                && mat.emissive.iter().all(|&v| v <= 0.0)
        })
        .collect();
    let draws = recover_structural_details(&mut geom, draws, &eligible_materials);
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
    for material in &mats {
        let mut key = material.clone();
        let flags = get(&key, 4);
        if flags & (4 | 256) == 0 {
            key[12..20].fill(0);
        }
        if flags & 8 == 0 {
            key[20..24].fill(0);
        }
        if flags & (256 | 512) == 0 {
            key[56..92].fill(0);
        }
        let id = *state_ids.entry(key).or_insert_with(|| {
            let id = gpu_materials.len() as u32;
            gpu_materials.push(material.clone());
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
    let mut effect_lights: Vec<([f32; 3], f32, [f32; 3], f32)> = m
        .fog_lights
        .iter()
        .map(|l| {
            (
                l.position,
                l.radius,
                grade(Vec3::from(l.color) * l.intensity, &m.post).to_array(),
                l.intensity,
            )
        })
        .collect();
    // Dusk sign light pools already exist in the shared scene. Their compact
    // glows use the same authored positions, without a full-screen HDR bloom.
    if effect_lights.is_empty() && m.day_sky.as_ref().is_some_and(|s| s.twilight.is_some()) {
        for light in m.lights.iter().filter(|l| l.node.is_none()).take(64) {
            let radius = if light.kind == pc::LightKind::Rect {
                light.size[0].max(light.size[1]).max(1.0)
            } else {
                1.5
            };
            effect_lights.push((
                light.position,
                radius,
                grade(Vec3::from(light.color), &m.post).to_array(),
                4.0,
            ));
        }
    }
    let mut features = 0u32;
    if m.rain.active {
        features |= 1;
    }
    if !m.fog_lights.is_empty() && m.atmosphere.haze_density > 0.0 {
        features |= 2;
    }
    if !effect_lights.is_empty() {
        features |= 8;
    }
    if m.materials
        .iter()
        .any(|v| v.wet.as_ref().is_some_and(|w| w.planar))
    {
        features |= 4;
    }
    if m.materials.iter().any(|v| v.kind == pc::Kind::Water) {
        features |= 32;
    }
    if m.materials.iter().any(|v| v.uv_anim.is_some()) {
        features |= 64;
    }
    if matrices > 0 && frames > 1 {
        features |= 128;
    }
    let (mut sky_texture, mut cloud_texture, mut cloud_drift) = (u32::MAX, u32::MAX, 0.0);
    if let Some(sky) = &m.day_sky {
        features |= 16;
        sky_texture = push_texture(
            &panorama(sky, &m.post, None),
            if gles { 0 } else { 3 },
            gles,
            &mut tex,
            &mut textures,
        );
        if let Some(id) = sky.clouds {
            let cloud = m.textures[id as usize].image();
            cloud_texture = push_texture(
                &panorama(sky, &m.post, Some(&cloud)),
                0,
                gles,
                &mut tex,
                &mut textures,
            );
            cloud_drift = sky.drift;
        }
    }
    // PICA binary tables followed by skin weights. All offsets in bytes.
    u32s(
        &mut table,
        &[
            TABLE_VERSION,
            textures.len() as u32,
            mats.len() as u32,
            draws.len() as u32,
            m.camera.shots.len() as u32,
            matrices as u32,
            frames,
            effect_lights.len() as u32,
            m.rain.dry_boxes.len() as u32,
            skin_data.len() as u32,
        ],
    );
    fs(
        &mut table,
        &[
            fps,
            // A vista's haze is in the vertex colours (`vista`).
            if m.vista_haze.is_some() { 0.0 } else { m.atmosphere.fog_density },
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
    u32s(&mut table, &[features, sky_texture, cloud_texture]);
    fs(&mut table, &[cloud_drift]);
    assert_eq!(table.len(), 120);
    for t in &textures {
        u32s(&mut table, t);
    }
    for material in &mats {
        table.extend(material);
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
    for (position, radius, color, intensity) in &effect_lights {
        fs(&mut table, position);
        fs(&mut table, &[*radius]);
        fs(&mut table, color);
        fs(&mut table, &[*intensity]);
    }
    for b in &m.rain.dry_boxes {
        fs(&mut table, &b[0]);
        fs(&mut table, &b[1]);
    }
    table.extend(&skin_data);
    let field = if gles {
        let fov = m.camera.shots.iter().map(|s| s.from.fov + s.to.fov).sum::<f32>() / (2 * m.camera.shots.len().max(1)) as f32;
        let height = profile.presentation.render_height as f32;
        light_fields(m, eye, height / (fov.to_radians() * 0.5).tan(), height)
    } else {
        Vec::new()
    };
    let summary = serde_json::json!({"target":profile.target.name(),"version":TABLE_VERSION,"name":m.name,"kind":m.kind,"sourceMaterials":m.materials.len(),"textures":textures.len(),"draws":draws.len(),"textureBytes":tex.len(),"geometryBytes":geom.len(),"animationBytes":anim.len(),"matrices":matrices,"frames":frames,"fps":fps,"features":features,"sourceNodes":m.nodes.len(),"camera":m.camera});
    let meta = serde_json::to_vec(&summary).unwrap();
    let mut sections: Vec<([u8; 4], &[u8], u32)> = vec![
        (pc::TAG_META, &meta, 16),
        (*b"PICA", &table, 16),
        (pc::TAG_TEXTURES, &tex, 128),
        (pc::TAG_GEOMETRY, &geom, 128),
        (pc::TAG_ANIMATION, &anim, 16),
    ];
    if gles {
        sections.push((*b"FELD", &field, 16));
    }
    let out = pc::write_versioned(pc::MAGIC, if gles { GLES_CONTAINER_VERSION } else { CONTAINER_VERSION }, &sections);
    Ok(Artifact {
        bytes: out, summary,
        sections: [("META",meta.len()),("PICA",table.len()),("TEXD",tex.len()),("GEOM",geom.len()),("ANIM",anim.len())].into_iter().chain(gles.then_some(("FELD",field.len()))).map(|(k,v)|(k.into(),v)).collect(),
        textures: textures.iter().enumerate().map(|(id,t)|serde_json::json!({"id":id,"sourceTextures":texkeys.iter().filter(|(_,output)|**output as usize==id).filter_map(|(key,_)|key.0).collect::<std::collections::BTreeSet<_>>(),"sources":texkeys.iter().filter(|(_,output)|**output as usize==id).filter_map(|(key,_)|key.0).flat_map(|source|crate::provenance::texture_sources(scene,source as usize)).collect::<std::collections::BTreeSet<_>>(),"width":t[0],"height":t[1],"format":t[2],"levels":t[3],"bytes":t[5]})).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fine_levels_do_not_replace_coarse_handheld_slots() {
        let levels: Vec<crate::source::Lod> = [0.01, 0.025, 0.06, 0.25].into_iter().enumerate().map(|(i, error)| crate::source::Lod { indices: vec![i as u32; 3], error }).collect();
        let base = [4, 5, 6];
        let selected: Vec<_> = main_lods(&base, &levels).collect();
        assert_eq!(selected, vec![(base.as_slice(), 3, 0.0), (levels[2].indices.as_slice(), 3, 0.06), (levels[3].indices.as_slice(), 3, 0.25)]);
        assert_eq!(main_lods(&base, &[]).count(), 1);
        assert_eq!(main_lods(&base, &levels[..1]).count(), 2);
    }

    #[test]
    fn structural_classifier_preserves_rotated_tubes_but_rejects_wires_and_panels() {
        let rotation = Quat::from_euler(glam::EulerRot::YXZ, 0.7, 0.4, 0.2);
        let points: Vec<Vec3> = (0..8)
            .map(|i| {
                rotation
                    * Vec3::new(
                        if i & 1 == 0 { -0.01 } else { 0.01 },
                        if i & 2 == 0 { -0.02 } else { 0.02 },
                        if i & 4 == 0 { -0.3 } else { 0.3 },
                    )
                    + Vec3::new(2.0, 4.0, 8.0)
            })
            .collect();
        let extents = principal_extents(&points);
        assert!((extents - Vec3::new(0.02, 0.04, 0.6)).length() < 1e-5);
        assert!(structural_detail(extents, 32, 4));
        assert!(!structural_detail(Vec3::new(0.004, 0.004, 0.6), 32, 0));
        assert!(!structural_detail(Vec3::new(0.02, 0.4, 0.6), 12, 0));
        assert!(!structural_detail(extents, 32, 24));
    }

    #[test]
    fn partial_tube_lod_gets_local_complete_middle_mesh_without_changing_coarse() {
        let mut geom = Vec::new();
        let mut fine = Vec::<u32>::new();
        // A structural tube and an equally tessellated subpixel wire share
        // one canonical draw. Both have a few surviving coarse triangles.
        for (part, radius) in [0.02, 0.002].into_iter().enumerate() {
            for i in 0..16 {
                let a = i as f32 * std::f32::consts::TAU / 16.0;
                for y in [0.0, 0.6] {
                    fs(
                        &mut geom,
                        &[
                            part as f32 * 8.0 + radius * a.cos(),
                            y,
                            radius * a.sin(),
                            0.0,
                            0.0,
                        ],
                    );
                    geom.extend([128, 128, 128, 255]);
                }
                let a = part as u32 * 32 + i * 2;
                let b = part as u32 * 32 + ((i + 1) % 16) * 2;
                fine.extend([a, b, a + 1, b, b + 1, a + 1]);
            }
        }
        let coarse = vec![0, 2, 1, 32, 34, 33];
        let mut d = Vec::new();
        u32s(&mut d, &[0, 0, 64, u32::MAX, u32::MAX, u32::MAX, 0, 0]);
        fs(&mut d, &[4.0, 0.3, 0.0, 4.1]);
        for (k, indices) in [&fine, &coarse, &coarse, &coarse].into_iter().enumerate() {
            u32s(&mut d, &[geom.len() as u32, indices.len() as u32]);
            fs(&mut d, &[if k == 0 { 0.0 } else { 0.25 }]);
            for &i in indices {
                geom.extend((i as u16).to_le_bytes());
            }
        }
        let result = recover_structural_details(&mut geom, vec![d], &[true]);
        assert_eq!(result.len(), 2);
        let get = |r: &[u8], o: usize| u32::from_le_bytes(r[o..o + 4].try_into().unwrap()) as usize;
        let detail = result.iter().find(|r| get(r, 28) == 1).unwrap();
        assert_eq!(get(detail, 52), 96);
        assert!(get(detail, 64) > 3 && get(detail, 64) <= 96);
        assert_eq!(get(detail, 76), 3);
        assert!(readf(detail, 44) < 0.31);
        assert_eq!(result.iter().map(|r| get(r, 52)).sum::<usize>(), fine.len());
        assert_eq!(
            result.iter().map(|r| get(r, 76)).sum::<usize>(),
            coarse.len()
        );
        // Coarse faces retain all coordinates and winding despite remapping.
        let mut coarse_positions = Vec::new();
        for r in &result {
            let start = get(r, 72);
            for ix in geom[start..start + get(r, 76) * 2].chunks_exact(2) {
                let offset = get(r, 4) + u16::from_le_bytes([ix[0], ix[1]]) as usize * 24;
                coarse_positions.push(geom[offset..offset + 12].to_vec());
            }
        }
        let mut expected: Vec<Vec<u8>> = coarse
            .iter()
            .map(|&i| geom[i as usize * 24..i as usize * 24 + 12].to_vec())
            .collect();
        expected.sort();
        coarse_positions.sort();
        assert_eq!(coarse_positions, expected);
    }

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
    fn sky_bake_retains_day_gradient_and_twilight_direction() {
        let mut sky: pc::DaySky = serde_json::from_value(serde_json::json!({
            "zenith":[0.1,0.2,0.4], "horizon":[0.4,0.5,0.6], "ground":[0.04,0.04,0.04],
            "gradient_power":1.0,"ground_blend":2.0,"sun_direction":[1.0,0.0,0.0],
            "sun_color":[1.0,1.0,1.0],"glow":0.0,"glow_wide":[1.0,2.0],"glow_tight":[1.0,20.0],
            "disc":0.0,"disc_cos_inner":0.9999,"disc_cos_outer":0.999,
            "clouds":null,"cloud_sun":[1.0,1.0,1.0],"cloud_ambient":[0.1,0.1,0.1],
            "fade_elevation":0.1,"drift":0.001,"twilight":null
        }))
        .unwrap();
        assert!((sky_radiance(&sky, Vec3::Y) - Vec3::from(sky.zenith)).length() < 1e-6);
        assert!((sky_radiance(&sky, Vec3::NEG_Y) - Vec3::from(sky.ground)).length() < 1e-6);
        assert!((sky_radiance(&sky, Vec3::X) - Vec3::from(sky.horizon)).length() < 1e-6);
        sky.twilight = Some(pc::Twilight {
            band: pc::TwilightBand {
                color: [0.5, 0.1, 0.0],
                height: 0.1,
                sun_bias: 1.0,
                sun_power: 2.0,
            },
            belt: pc::TwilightBelt {
                color: [0.0; 3],
                elevation: 0.1,
                width: 0.05,
                power: 2.0,
            },
            shadow: pc::TwilightShadow {
                strength: 0.0,
                height: 0.1,
                power: 2.0,
            },
        });
        let toward = sky_radiance(&sky, Vec3::X);
        let away = sky_radiance(&sky, Vec3::NEG_X);
        assert!((toward - away - Vec3::new(0.5, 0.1, 0.0)).length() < 1e-6);
        assert!((away - Vec3::from(sky.horizon)).length() < 1e-6);
    }

    #[test]
    fn cloud_edges_filter_without_dark_halos_and_preserve_hdr_grade() {
        let mut post = pc::Post::default();
        post.tone = pc::ToneCurve::Aces;
        for base in [Vec3::new(0.5, 0.67, 0.9), Vec3::new(0.1, 0.22, 0.6)] {
            let background = grade(base, &post);
            for alpha in [0.02, 0.25, 0.7, 1.0] {
                let radiance = Vec3::splat(3.0) * alpha;
                let cloud = cloud_overlay(base, radiance, alpha, &post);
                let expected = grade(base * (1.0 - alpha) + radiance, &post);
                assert!((cloud + background * (1.0 - alpha) - expected).length() < 1e-6);
                // Filtering from a cloud texel into a fully transparent texel
                // is convex interpolation of completed sky colours, not an
                // extra multiplication of already-filtered RGB by opacity.
                for edge in [0.01, 0.1, 0.5, 0.9] {
                    let filtered = cloud * edge + background * (1.0 - alpha * edge);
                    assert!((filtered - background.lerp(expected, edge)).length() < 1e-6);
                    assert!(filtered.min_element() >= background.min_element() - 1e-6);
                }
            }
        }
        assert_eq!(cloud_overlay(Vec3::ONE, Vec3::ZERO, 0.0, &post), Vec3::ZERO);
    }
    #[test]
    fn rgba8_upload_has_pica_abgr_channels_and_preserves_alpha() {
        let mut px = vec![[0.0; 4]; 64];
        px[0] = [1.0, linear(0.5), 0.0, 0.25];
        let image = Rgba { w: 8, h: 8, px };
        let bytes = texels(&image, 0, false);
        let offset = morton(0, 7) * 4;
        assert_eq!(&bytes[offset..offset + 4], &[64, 0, 128, 255]);
        assert_eq!(&bytes[0..4], &[0, 0, 0, 0]);
        // GLES: the first texel of the first row, RGBA.
        assert_eq!(&texels(&image, 0, true)[0..4], &[255, 128, 0, 64]);
    }

    #[test]
    fn gles_light_field_sums_far_steady_lights_and_drops_the_dark() {
        let field = pc::LightField { min_pixels: 2.0, max_pixels: 10.0, gain: 1.0, depth_pull: 0.0, period: 120.0 };
        let light = |x: f32, z: f32, intensity: f32| pc::LightPoint { position: [x, 0.0, z], color: [1.0; 3], intensity, radius: 0.2, duty: 1.0, ..Default::default() };
        let cook = |lights: &[pc::LightPoint]| sprites(lights, &field, Vec3::ZERO, 800.0, 320.0, |_, c| c, |c| c.min(Vec3::ONE));
        let color = |bytes: &[u8], i: usize| bytes[i * 52 + 48];
        // At 5 km a cell is 19 m wide: these two share one, and their energy
        // (k² = (0.032 / 2.35)² of 1000 each) adds up in one sprite.
        let one = cook(&[light(0.0, -5000.0, 1000.0)]);
        let two = cook(&[light(0.0, -5000.0, 1000.0), light(4.0, -5000.0, 1000.0)]);
        assert_eq!((one.len(), two.len()), (52, 52));
        assert!((color(&two, 0) as i32 - 2 * color(&one, 0) as i32).abs() <= 1, "{} {}", color(&one, 0), color(&two, 0));
        // A moving light, a near one and one 100 m to the side stay apart.
        let mut moving = light(4.0, -5000.0, 1000.0);
        moving.path = [10.0, 0.0, 0.0];
        assert_eq!(cook(&[light(0.0, -5000.0, 1000.0), moving, light(0.0, -500.0, 30.0), light(100.0, -5000.0, 1000.0)]).len(), 4 * 52);
        // A light the tone curve leaves at black is no sprite.
        assert!(cook(&[light(0.0, -5000.0, 1.0)]).is_empty());
        // 1 / k: the sub-pixel light's sprite is 2.35 px wide, the light 0.032.
        let k = f32::from_le_bytes(one[44..48].try_into().unwrap());
        assert!((k - 2.0 * 320.0 / 272.0 / (0.2 * 800.0 / 5000.0)).abs() < 0.01, "{k}");
    }

    #[test]
    fn gles_window_rooms_follow_the_vita_hash() {
        // window_f.cg lights a room while hash32(seed * 1.37 + 0.5).x < 0.62:
        // the seed (0, 0), worked by hand, is lit.
        assert!((hash32([0.5, 0.5]) - Vec3::new(0.3037, 0.3183, 0.3185)).abs().max_element() < 2e-3);
        let hashes: Vec<Vec3> = (0..200).map(|i| hash32([i as f32 * 1.37 + 0.5, (i / 7) as f32 * 1.37 + 0.5])).collect();
        let lit = hashes.iter().filter(|h| h.x < 0.62).count();
        assert!((100..150).contains(&lit), "{lit} of 200 rooms lit");
        assert!((0..200).all(|i| (0.0..1.0).contains(&hash12([i as f32 + 17.1, 3.0 + 17.1]))));
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
        let image = Rgba { w: 8, h: 8, px };
        let rows = texels(&image, 3, true);
        assert_eq!((&rows[0..2], &rows[126..128]), (&0xf800u16.to_le_bytes()[..], &0x001fu16.to_le_bytes()[..]));
        let b = texels(&image, 3, false);
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


