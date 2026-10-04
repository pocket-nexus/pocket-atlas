//! PICA200 variant of a place. Reuses the canonical geometry, material
//! annotations, lighting bake, cameras and motion; no place-name branches.
//! RGB565/RGBA4 mip chains are tiled offline, and lighting is converted to
//! display-referred vertex colour because PICA200 has fixed TEV combiners.
use crate::textures::{self, Rgba};
use crate::native_sky::{grade, panorama, sun_occluder};
#[cfg(test)]
use crate::native_sky::{sky_radiance, cloud_overlay};
use glam::{Mat4, Quat, Vec3};
use pocket3d_place as pc;
use std::collections::HashMap;
use crate::{artifact::Artifact, profile::Profile};

// This schema belongs to PICA, independently of Vita's pc::VERSION.
// tests/pipeline.rs verifies emitted packs against n3ds/src/format.h.
const CONTAINER_VERSION: u32 = 5;
const TABLE_VERSION: u32 = 4;

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

// PICA v4 keeps every source sample. Repeated rigid transforms share a track;
// constant transforms store one sample. TRS records retain f32 translation and
// scale and quantize only the unit quaternion (snorm16, < 0.0001 rad error).
// Non-TRS affine transforms, including shear, retain all twelve f32 components.
fn trs(m: Mat4) -> Option<(Vec3, Quat, Vec3)> {
    if !m.is_finite() || m.determinant().abs() < 1e-12 {
        return None;
    }
    let (s, q, t) = m.to_scale_rotation_translation();
    if !s.is_finite() || !q.is_finite() || !t.is_finite() {
        return None;
    }
    let q = q.normalize();
    let reconstructed = Mat4::from_scale_rotation_translation(s, q, t);
    if m.to_cols_array().into_iter().zip(reconstructed.to_cols_array())
        .any(|(a, b)| (a - b).abs() > 1e-5 * (1.0 + a.abs())) {
        return None;
    }
    Some((t, if q.w < 0.0 { -q } else { q }, s))
}

fn animation_tracks(tracks: &[Vec<Mat4>]) -> (Vec<u8>, usize, usize) {
    let mut out = vec![0; tracks.len() * 12];
    let mut shared = HashMap::<(u32, Vec<u8>), u32>::new();
    let mut affine = 0;
    for (i, track) in tracks.iter().enumerate() {
        assert!(!track.is_empty());
        let samples = if track.iter().all(|m| *m == track[0]) { &track[..1] } else { track.as_slice() };
        let decomposed = samples.iter().map(|&m| trs(m)).collect::<Option<Vec<_>>>();
        let kind = if decomposed.is_some() { 1 } else { 0 };
        let mut data = Vec::new();
        if let Some(trs) = decomposed {
            for (t, q, s) in trs {
                fs(&mut data, &t.to_array());
                fs(&mut data, &s.to_array());
                for v in q.to_array() {
                    data.extend(((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
                }
            }
        } else {
            affine += 1;
            for &m in samples { fs(&mut data, &rows(m)); }
        }
        let offset = *shared.entry((kind, data.clone())).or_insert_with(|| {
            let offset = out.len() as u32;
            out.extend(data);
            offset
        });
        let mut record = Vec::new();
        u32s(&mut record, &[offset, samples.len() as u32, kind]);
        out[i * 12..(i + 1) * 12].copy_from_slice(&record);
    }
    (out, shared.len(), affine)
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
    // Slim rings and tubes retain the existing near-detail policy. Thicker
    // posts qualify only with a compact, roughly round cross-section, so a
    // 16 cm striped support is not mistaken for an expendable distant wire.
    let section = (0.008..=0.12).contains(&extent.x)
        || ((0.12..=0.24).contains(&extent.x) && extent.y <= extent.x * 1.5);
    fine >= 24
        && coarse * 100 < fine * 45
        && section
        && (0.1..=2.0).contains(&extent.z)
}

fn planar_detail(extent: Vec3, fine: usize, coarse: usize) -> bool {
    // Opaque textured markers are already close to their minimal topology.
    // Preserve their image-bearing face locally, rather than leaving only
    // the surrounding sign frame. Material eligibility excludes alpha cards.
    (1..=12).contains(&fine) && coarse < fine
        && extent.x <= 0.005 && (0.08..=2.0).contains(&extent.y)
        && extent.z <= 4.0
}

fn planar_material(mat: &pc::Material) -> bool {
    mat.albedo.is_some() && mat.alpha_test == 0.0
        && mat.kind == pc::Kind::Standard && mat.blend == pc::Blend::Opaque
}

/// Preserve compact tubes/rings that canonical distance LODs partly erase.
/// Their coarse geometry stays identical; a separate 2 m cell can select a
/// bounded-error middle LOD without restoring an entire 32 m street chunk.
/// Draw reserved bit 0 marks this near-detail policy (no format-size change).
fn recover_structural_details(
    geom: &mut Vec<u8>,
    draws: Vec<Vec<u8>>,
    eligible_materials: &[bool],
    planar_materials: &[bool],
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
            let extent = if points.is_empty() { Vec3::ZERO } else { principal_extents(&points) };
            let marker = planar_materials[get(&d, 0)]
                && planar_detail(extent, part[0].len() / 3, part[2].len() / 3);
            if points.is_empty() || (!marker && !structural_detail(
                extent, part[0].len() / 3, part[2].len() / 3)) {
                for k in 0..4 {
                    retained[k].extend(&part[k]);
                }
                continue;
            }
            // The middle LOD removes tessellation, never whole components.
            // UV and display colour still constrain collapses at material seams.
            let simplified = if marker { part[0].clone() } else { meshopt::simplify_with_attributes_and_locks(
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
            ) };
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

fn tiled_rgba8(img: &Rgba) -> Vec<u8> {
    let mut out = vec![0; (img.w * img.h * 4) as usize];
    for y in 0..img.h {
        for x in 0..img.w {
            let p = img.px[((img.h - 1 - y) * img.w + x) as usize];
            // PICA GPU_RGBA8 stores ABGR byte order, i.e. little-endian RRGGBBAA.
            let c = [
                byte(p[3]),
                byte(srgb(p[2])),
                byte(srgb(p[1])),
                byte(srgb(p[0])),
            ];
            let i = (((y / 8) * (img.w / 8) + x / 8) * 64) as usize + morton(x % 8, y % 8);
            out[i * 4..i * 4 + 4].copy_from_slice(&c);
        }
    }
    out
}
fn push_texture(src: &Rgba, alpha: bool, tex: &mut Vec<u8>, textures: &mut Vec<[u32; 8]>) -> u32 {
    align(tex, 128);
    let off = tex.len();
    tex.extend(if alpha {
        tiled_rgba8(src)
    } else {
        tiled(src, false)
    });
    textures.push([
        src.w,
        src.h,
        if alpha { 0 } else { 3 },
        1,
        off as u32,
        (tex.len() - off) as u32,
        0,
        1,
    ]);
    textures.len() as u32 - 1
}
/// Keep the two coarsest shared levels in PICA's three main-view slots.
/// Extra fine rigid levels must not inflate LOD2 or its reflection proxy.
fn main_lods<'a>(indices: &'a [u32], levels: &'a [crate::source::Lod]) -> impl Iterator<Item = (&'a [u32], u32, f32)> {
    std::iter::once((indices, indices.len() as u32, 0.0))
        .chain(levels.iter().skip(levels.len().saturating_sub(2)).map(|l| (l.indices.as_slice(), l.indices.len() as u32, l.error)))
}

pub fn cook(scene: &crate::source::Scene, profile: &Profile) -> Result<Artifact,String> {
    let m = scene;
    let mut tex = Vec::new();
    let mut geom = Vec::new();
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
        let key = (
            ti,
            if proc || water {
                mat.kind as u32 + 1
            } else {
                0
            },
            grid,
        );
        let tx = if ti.is_some() || proc {
            *texkeys.entry(key).or_insert_with(|| {
                let mut src = if proc {
                    procedural(mat.kind)
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
                align(&mut tex, 128);
                let off = tex.len();
                let mut levels = 0;
                loop {
                    tex.extend(tiled(&level, alpha));
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
        if water {
            flags |= 256;
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
        fs(&mut record, &water.waves[0]);
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
    let frames = m.frames.max(1);
    let fps = m.fps;
    let mut matrix_tracks = vec![Vec::with_capacity(frames as usize); matrices];
    let mut skin_base = Vec::new();
    let mut at = used_nodes.len();
    for s in &m.skins {
        skin_base.push(at);
        at += s.joints.len();
    }
    let mut world0 = Vec::new();
    for frame in 0..frames {
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
        for (slot, &i) in used_nodes.iter().enumerate() {
            matrix_tracks[slot].push(world[i as usize]);
        }
        for (skin_id, s) in m.skins.iter().enumerate() {
            for (j, &n) in s.joints.iter().enumerate() {
                matrix_tracks[skin_base[skin_id] + j].push(
                    world[n as usize] * Mat4::from_cols_slice(&s.inverse_bind[j]),
                );
            }
        }
        if frame == 0 {
            world0 = world;
        }
    }
    let (encoded, unique_tracks, affine_tracks) = animation_tracks(&matrix_tracks);
    let mut anim = encoded;
    if anim.len() > profile.recipe.animation_palette_bytes as usize {
        return Err(format!("PICA full-rate animation palette needs {} bytes (budget {}); source samples cannot be discarded", anim.len(), profile.recipe.animation_palette_bytes));
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
    let occluder = sun_occluder(scene);
    let baker = crate::bake::Baker::new(
        &m.lights,
        (m.atmosphere.hemisphere_sky, m.atmosphere.hemisphere_ground),
        None,
    );
    for d in &m.draws {
        let mat = &m.materials[d.material as usize];
        align(&mut geom, 16);
        let vo = geom.len();
        let mut positions = Vec::new();
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
            } else {
                baker.irradiance(world, n, mat.env_strength, false, 1.0) + Vec3::splat(0.08)
            };
            let world_n = d.node.map_or(n, |i| {
                world0[i as usize].transform_vector3(n).normalize_or(n)
            });
            if !mat.interior && !matches!(mat.kind, pc::Kind::Unlit | pc::Kind::Water) {
                if let Some(sun) = &m.sun {
                    let direction = Vec3::from(sun.direction);
                    // A moving object's exported rest pose may be hidden below
                    // the world. Baking static occlusion there would shadow it
                    // for the entire loop. PICA retains directional lighting;
                    // only stationary geometry receives baked sun occlusion.
                    let visibility = if d.node.is_some() || d.skin.is_some() { 1.0 }
                        else { occluder.as_ref().map_or(1.0, |o| o.ray_visibility(world, world_n, direction, 2000.0)) };
                    light += Vec3::from(sun.radiance)
                        * (world_n.dot(direction).max(0.0)
                            * visibility
                            * std::f32::consts::FRAC_1_PI);
                }
            }
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
                        Vec3::splat(mat.emissive[0] * (0.78 + 0.22 * v.color[3] as f32 / 255.0)),
                        &m.post,
                    )
                }
                pc::Kind::InteriorWindow => {
                    uv = [uv[0] / 8.0, uv[1] / 4.0];
                    Vec3::splat(0.9)
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
                    grade(body * Vec3::from(m.atmosphere.hemisphere_sky), &m.post)
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
            geom.extend([
                byte(color.x),
                byte(color.y),
                byte(color.z),
                if mat.vertex_color && (mat.blend != pc::Blend::Opaque || mat.alpha_test > 0.0) {
                    v.color[3]
                } else {
                    255
                },
            ]);
            positions.push(pos);
        }
        let mut lod = Vec::new();
        for (indices, count, error) in main_lods(d.indices(), d.lods())
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
        // The runtime bounds skins using every weighted joint, not the root alone.
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
    let planar_materials: Vec<bool> = m.materials.iter().map(planar_material).collect();
    let draws = recover_structural_details(&mut geom, draws, &eligible_materials, &planar_materials);
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
        if flags & 256 == 0 {
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
            false,
            &mut tex,
            &mut textures,
        );
        if let Some(id) = sky.clouds {
            let cloud = m.textures[id as usize].image();
            cloud_texture = push_texture(
                &panorama(sky, &m.post, Some(&cloud)),
                true,
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
    let mut audio = Vec::new();
    if let Some(record) = crate::analysis::audio::native_record(m.audio.as_ref()) {
        fs(&mut audio, &record);
    }
    let summary = serde_json::json!({"target":"3ds","version":TABLE_VERSION,"name":m.name,"kind":m.kind,"sourceMaterials":m.materials.len(),"textures":textures.len(),"draws":draws.len(),"textureBytes":tex.len(),"geometryBytes":geom.len(),"animationBytes":anim.len(),"uniqueAnimationTracks":unique_tracks,"affineAnimationTracks":affine_tracks,"matrices":matrices,"frames":frames,"fps":fps,"features":features,"sourceNodes":m.nodes.len(),"camera":m.camera,"audio":m.audio});
    let meta = serde_json::to_vec(&summary).unwrap();
    let mut sections: Vec<([u8; 4], &[u8], u32)> = vec![
        (pc::TAG_META, &meta, 16), (*b"PICA", &table, 16),
        (pc::TAG_TEXTURES, &tex, 128), (pc::TAG_GEOMETRY, &geom, 128),
        (pc::TAG_ANIMATION, &anim, 16),
    ];
    if !audio.is_empty() { sections.push((*b"AUDI", &audio, 16)); }
    let out = pc::write_versioned(pc::MAGIC, CONTAINER_VERSION, &sections);
    Ok(Artifact {
        bytes: out, summary,
        sections: sections.iter().map(|(tag,data,_)| (std::str::from_utf8(tag).unwrap().into(), data.len())).collect(),
        textures: textures.iter().enumerate().map(|(id,t)|serde_json::json!({"id":id,"sourceTextures":texkeys.iter().filter(|(_,output)|**output as usize==id).filter_map(|(key,_)|key.0).collect::<std::collections::BTreeSet<_>>(),"sources":texkeys.iter().filter(|(_,output)|**output as usize==id).filter_map(|(key,_)|key.0).flat_map(|source|crate::provenance::texture_sources(scene,source as usize)).collect::<std::collections::BTreeSet<_>>(),"width":t[0],"height":t[1],"format":t[2],"levels":t[3],"bytes":t[5]})).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_rate_tracks_share_constants_and_preserve_affine_shear() {
        let constant = vec![Mat4::from_translation(Vec3::new(123.456, -1000.0, 7.0)); 960];
        let moving: Vec<_> = (0..960).map(|i| Mat4::from_scale_rotation_translation(
            Vec3::new(0.5, 2.0, 1.0), Quat::from_rotation_x(i as f32 * 1.7),
            Vec3::new(i as f32 * 0.5, 0.0, 0.0))).collect();
        let mut shear = Mat4::IDENTITY;
        shear.y_axis.x = 0.2;
        let (bytes, unique, affine) = animation_tracks(&[constant.clone(), constant, moving.clone(), vec![shear; 960]]);
        let word = |at: usize| u32::from_le_bytes(bytes[at..at+4].try_into().unwrap());
        assert_eq!((unique, affine), (3, 1));
        assert_eq!(&bytes[0..12], &bytes[12..24]);
        assert_eq!(word(4), 1);
        assert_eq!(word(24+4), 960, "never decimate the 64-second loop");
        assert_eq!(word(24+8), 1);
        assert_eq!(word(36+8), 0, "shear must use lossless affine records");
        let at = word(24) as usize;
        for (i, expected) in moving.iter().enumerate() {
            let sample = at + i * 32;
            let t = Vec3::new(readf(&bytes, sample), readf(&bytes, sample+4), readf(&bytes, sample+8));
            let s = Vec3::new(readf(&bytes, sample+12), readf(&bytes, sample+16), readf(&bytes, sample+20));
            let q = Quat::from_array(std::array::from_fn(|k| i16::from_le_bytes(bytes[sample+24+k*2..sample+26+k*2].try_into().unwrap()) as f32 / 32767.0)).normalize();
            let decoded = Mat4::from_scale_rotation_translation(s, q, t);
            for p in [Vec3::ZERO, Vec3::ONE, Vec3::new(0.0, 0.3, 0.0)] {
                assert!(decoded.transform_point3(p).distance(expected.transform_point3(p)) < 0.00015);
            }
        }
        assert_eq!(bytes.len(), 48 + 32 + 960*32 + 48);
    }
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
        assert!(structural_detail(Vec3::new(0.16, 0.16, 0.38), 40, 0));
        assert!(!structural_detail(Vec3::new(0.16, 0.6, 1.0), 40, 0));
        assert!(!structural_detail(Vec3::new(0.3, 0.3, 0.8), 40, 0));
    }

    #[test]
    fn textured_marker_retains_its_face_but_cutout_foliage_does_not() {
        let mut material = pc::Material {
            name: "marker".into(), kind: pc::Kind::Standard, blend: pc::Blend::Opaque,
            double_sided: false, depth_write: true, alpha_test: 0.0,
            color: [1.0;4], emissive: [0.0;3], roughness: 0.5, metalness: 0.0,
            normal_scale: 1.0, ao_strength: 1.0, env_strength: 1.0,
            albedo: Some(0), normal: None, orm: None, emission: None,
            vertex_color: false, vertex_pbr: false, interior: false, fog: true,
            wet: None, damp: None, drops: 0.0, clearcoat: 0.0, polygon_offset: None,
            emissive_track: None, uv_anim: None, water: None, lights: None, tint: None,
        };
        assert!(planar_material(&material));
        material.polygon_offset = Some([-1.0, -1.0]);
        assert!(planar_material(&material), "depth-biased printed decals retain their face");
        material.alpha_test = 0.5;
        assert!(!planar_material(&material));
        material.alpha_test = 0.0;
        material.blend = pc::Blend::Alpha;
        assert!(!planar_material(&material));
        assert!(planar_detail(Vec3::new(0.0, 0.25, 0.88), 2, 0));
        assert!(!planar_detail(Vec3::new(0.0, 0.03, 0.88), 2, 0));
        assert!(!planar_detail(Vec3::new(0.0, 20.0, 30.0), 2, 0));
        let mut geometry = Vec::new();
        for (position, uv) in [([-0.44,0.0,0.0],[0.1,0.2]),([0.44,0.0,0.0],[0.3,0.2]),
                              ([-0.44,0.25,0.0],[0.1,0.4]),([0.44,0.25,0.0],[0.3,0.4])] {
            fs(&mut geometry, &position);
            fs(&mut geometry, &uv);
            geometry.extend([50,100,150,255]);
        }
        let original = geometry.clone();
        let mut draw = Vec::new();
        u32s(&mut draw, &[0,0,4,u32::MAX,u32::MAX,u32::MAX,0,0]);
        fs(&mut draw, &[0.0,0.125,0.0,0.46]);
        for lod in 0..4 {
            u32s(&mut draw, &[geometry.len() as u32, if lod==0 {6} else {0}]);
            fs(&mut draw, &[if lod==0 {0.0} else {0.25}]);
            if lod==0 {for index in [0u16,1,2,2,1,3] {geometry.extend(index.to_le_bytes());}}
        }
        let get = |r: &[u8], at:usize| u32::from_le_bytes(r[at..at+4].try_into().unwrap()) as usize;
        let excluded = recover_structural_details(&mut geometry.clone(), vec![draw.clone()], &[true], &[false]);
        assert_eq!(get(&excluded[0],64),0);
        let recovered = recover_structural_details(&mut geometry, vec![draw], &[true], &[true]);
        assert_eq!(recovered.len(),1);
        let r=&recovered[0];
        assert_eq!(get(r,28),1);
        assert_eq!((get(r,52),get(r,64),get(r,76)),(6,6,0));
        let vertices=get(r,4);let mut actual:Vec<_>=geometry[vertices..vertices+96].chunks_exact(24).collect();
        let mut expected:Vec<_>=original.chunks_exact(24).collect();actual.sort();expected.sort();
        assert_eq!(actual,expected,"marker UVs, display colours and positions stay exact");
    }

    #[test]
    fn partial_tube_lod_gets_local_complete_middle_mesh_without_changing_coarse() {
        for radius in [0.02, 0.08] {
        let mut geom = Vec::new();
        let mut fine = Vec::<u32>::new();
        // A structural tube and an equally tessellated subpixel wire share
        // one canonical draw. Both have a few surviving coarse triangles.
        for (part, radius) in [radius, 0.002].into_iter().enumerate() {
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
        let result = recover_structural_details(&mut geom, vec![d], &[true], &[false]);
        assert_eq!(result.len(), 2);
        let get = |r: &[u8], o: usize| u32::from_le_bytes(r[o..o + 4].try_into().unwrap()) as usize;
        let detail = result.iter().find(|r| get(r, 28) == 1).unwrap();
        assert_eq!(get(detail, 52), 96);
        assert!(get(detail, 64) > 3 && get(detail, 64) <= 96);
        assert_eq!(get(detail, 76), 3);
        let expected_radius = (0.3_f32.powi(2) + 2.0 * radius * radius).sqrt();
        assert!((readf(detail, 44) - expected_radius).abs() < 1e-5);
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
        let bytes = tiled_rgba8(&Rgba { w: 8, h: 8, px });
        let offset = morton(0, 7) * 4;
        assert_eq!(&bytes[offset..offset + 4], &[64, 0, 128, 255]);
        assert_eq!(&bytes[0..4], &[0, 0, 0, 0]);
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
