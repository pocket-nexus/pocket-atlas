//! Triangle soup → quantized, chunked, indexed draws.

use glam::{Vec2, Vec3};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Default)]
pub struct Vertex {
    pub pos: Vec3,
    pub normal: Vec3,
    /// xyz + handedness in w.
    pub tangent: [f32; 4],
    pub uv: Vec2,
    /// sRGB-encoded RGBA.
    pub color: [u8; 4],
    pub joints: [u8; 4],
    pub weights: [u8; 4],
    /// Baked diffuse irradiance (square-root RGBM, see `bake`).
    pub light: [u8; 4],
}

/// Per-vertex tangents from UV gradients (accumulated per triangle, then
/// Gram-Schmidt against the normal).
pub fn tangents(pos: &[Vec3], nrm: &[Vec3], uv: &[Vec2], tris: &[[u32; 3]]) -> Vec<[f32; 4]> {
    let n = pos.len();
    let mut t = vec![Vec3::ZERO; n];
    let mut b = vec![Vec3::ZERO; n];
    for tri in tris {
        let [i0, i1, i2] = tri.map(|i| i as usize);
        let e1 = pos[i1] - pos[i0];
        let e2 = pos[i2] - pos[i0];
        let d1 = uv[i1] - uv[i0];
        let d2 = uv[i2] - uv[i0];
        let r = d1.x * d2.y - d2.x * d1.y;
        if r.abs() < 1e-12 {
            continue;
        }
        let f = 1.0 / r;
        let sdir = (e1 * d2.y - e2 * d1.y) * f;
        let tdir = (e2 * d1.x - e1 * d2.x) * f;
        for &i in &[i0, i1, i2] {
            t[i] += sdir;
            b[i] += tdir;
        }
    }
    (0..n)
        .map(|i| {
            let nn = nrm[i];
            let mut tt = t[i] - nn * nn.dot(t[i]);
            if tt.length_squared() < 1e-12 {
                // Any vector perpendicular to the normal.
                tt = if nn.x.abs() < 0.9 { Vec3::X } else { Vec3::Z };
                tt -= nn * nn.dot(tt);
            }
            let tt = tt.normalize();
            let w = if nn.cross(tt).dot(b[i]) < 0.0 { -1.0 } else { 1.0 };
            [tt.x, tt.y, tt.z, w]
        })
        .collect()
}

pub struct Built {
    pub vertices: Vec<u8>,
    pub indices: Vec<u8>,
    pub vertex_count: u32,
    pub index_count: u32,
    pub pos_offset: [f32; 3],
    pub pos_scale: [f32; 3],
    pub uv_offset: [f32; 2],
    pub uv_scale: [f32; 2],
    pub min: [f32; 3],
    pub max: [f32; 3],
}

fn s16n(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32767.0).round() as i16
}
fn s8n(v: f32) -> i8 {
    (v.clamp(-1.0, 1.0) * 127.0).round() as i8
}

/// Quantizes one draw (≤ 65 536 unique vertices) into the Static (24 B),
/// Baked (28 B) or Skinned (32 B) layout.
pub fn build(verts: &[Vertex], tris: &[[u32; 3]], layout: pocket3d_city::VertexLayout) -> Built {
    let skinned = layout == pocket3d_city::VertexLayout::Skinned;
    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);
    let mut uvmin = Vec2::splat(f32::MAX);
    let mut uvmax = Vec2::splat(f32::MIN);
    for v in verts {
        min = min.min(v.pos);
        max = max.max(v.pos);
        uvmin = uvmin.min(v.uv);
        uvmax = uvmax.max(v.uv);
    }
    let center = (min + max) * 0.5;
    let half = ((max - min) * 0.5).max(Vec3::splat(1e-4));
    let uvc = (uvmin + uvmax) * 0.5;
    let uvh = ((uvmax - uvmin) * 0.5).max(Vec2::splat(1e-5));
    let stride = layout.stride() as usize;
    let mut out = Vec::with_capacity(verts.len() * stride);
    for v in verts {
        let q = (v.pos - center) / half;
        for c in [q.x, q.y, q.z, 0.0] {
            out.extend(s16n(c).to_le_bytes());
        }
        let n = v.normal.normalize_or_zero();
        out.extend([s8n(n.x) as u8, s8n(n.y) as u8, s8n(n.z) as u8, 0]);
        out.extend([s8n(v.tangent[0]) as u8, s8n(v.tangent[1]) as u8, s8n(v.tangent[2]) as u8, s8n(v.tangent[3]) as u8]);
        let u = (v.uv - uvc) / uvh;
        out.extend(s16n(u.x).to_le_bytes());
        out.extend(s16n(u.y).to_le_bytes());
        out.extend(v.color);
        if layout == pocket3d_city::VertexLayout::Baked {
            out.extend(v.light);
        }
        if skinned {
            out.extend(v.joints);
            out.extend(v.weights);
        }
    }
    let mut idx = Vec::with_capacity(tris.len() * 6);
    for t in tris {
        for &i in t {
            idx.extend((i as u16).to_le_bytes());
        }
    }
    Built {
        vertices: out,
        indices: idx,
        vertex_count: verts.len() as u32,
        index_count: (tris.len() * 3) as u32,
        pos_offset: center.to_array(),
        pos_scale: half.to_array(),
        uv_offset: uvc.to_array(),
        uv_scale: uvh.to_array(),
        min: min.to_array(),
        max: max.to_array(),
    }
}

/// Splits a triangle soup (already deduplicated per source primitive) into
/// groups of ≤ 65 536 vertices, remapping indices per group.
pub fn split(verts: &[Vertex], tris: &[[u32; 3]]) -> Vec<(Vec<Vertex>, Vec<[u32; 3]>)> {
    let mut out = Vec::new();
    let mut map: HashMap<u32, u32> = HashMap::new();
    let mut cur_v: Vec<Vertex> = Vec::new();
    let mut cur_t: Vec<[u32; 3]> = Vec::new();
    for t in tris {
        let new = t.iter().filter(|i| !map.contains_key(i)).count();
        if cur_v.len() + new > 65535 {
            out.push((std::mem::take(&mut cur_v), std::mem::take(&mut cur_t)));
            map.clear();
        }
        let mut r = [0u32; 3];
        for (k, &i) in t.iter().enumerate() {
            r[k] = *map.entry(i).or_insert_with(|| {
                cur_v.push(verts[i as usize]);
                (cur_v.len() - 1) as u32
            });
        }
        cur_t.push(r);
    }
    if !cur_t.is_empty() {
        out.push((cur_v, cur_t));
    }
    out
}

/// Low-poly stand-in for one shelf item (unit-height shape in its own frame,
/// y up from 0): round shapes (cans, cups, bottles) become a hexagonal lathe
/// that follows the item's profile at a few heights, everything else a box.
/// No bottom faces. UVs wrap around (u) and run up the side (v); colour alpha
/// carries the normalized height, as the products shader expects.
pub fn product_proxy(src: &[Vertex]) -> (Vec<Vertex>, Vec<[u32; 3]>) {
    let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for v in src {
        lo = lo.min(v.pos);
        hi = hi.max(v.pos);
    }
    let c = (lo + hi) * 0.5;
    let h = (hi.y - lo.y).max(1e-4);
    let radial = |v: &Vertex| Vec2::new(v.pos.x - c.x, v.pos.z - c.z).length();
    let rmax = src.iter().map(radial).fold(0.0f32, f32::max).max(1e-4);
    // Distinct directions among the outermost vertices: a lathe or cylinder
    // has one per radial segment, a box four.
    let mut angles: Vec<i32> = src
        .iter()
        .filter(|v| radial(v) > rmax * 0.8)
        .map(|v| ((v.pos.z - c.z).atan2(v.pos.x - c.x) * 16.0 / std::f32::consts::PI).round() as i32)
        .collect();
    angles.sort_unstable();
    angles.dedup();
    let round = angles.len() >= 8;

    let mut verts: Vec<Vertex> = Vec::new();
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let vtx = |p: Vec3, n: Vec3, u: f32, t: f32| Vertex {
        pos: p,
        normal: n,
        tangent: [1.0, 0.0, 0.0, 1.0],
        uv: Vec2::new(u, t),
        color: [255, 255, 255, (t.clamp(0.0, 1.0) * 255.0).round() as u8],
        joints: [0; 4],
        weights: [255, 0, 0, 0],
        light: [0; 4],
    };
    let top_y = hi.y;
    if round {
        let sides = 6;
        // Profile radius at a few heights (bottles narrow at the shoulder and neck).
        let sample = [0.0f32, 0.55, 0.8, 1.0];
        let profile: Vec<f32> = sample
            .iter()
            .map(|&t| {
                let r = src.iter().filter(|v| ((v.pos.y - lo.y) / h - t).abs() < 0.13).map(radial).fold(0.0f32, f32::max);
                if r > 0.0 { r } else { rmax }
            })
            .collect();
        // Drop interior rings the neighbours already interpolate: cans and
        // cups keep two rings, bottles their shoulder and neck.
        let mut keep: Vec<usize> = (0..sample.len()).collect();
        let mut i = 1;
        while i + 1 < keep.len() {
            let (a, k, b) = (keep[i - 1], keep[i], keep[i + 1]);
            let f = (sample[k] - sample[a]) / (sample[b] - sample[a]);
            if (profile[k] - (profile[a] + (profile[b] - profile[a]) * f)).abs() < 0.08 * rmax {
                keep.remove(i);
            } else {
                i += 1;
            }
        }
        let rings: Vec<f32> = keep.iter().map(|&k| sample[k]).collect();
        let radius: Vec<f32> = keep.iter().map(|&k| profile[k]).collect();
        for (k, &t) in rings.iter().enumerate() {
            for s in 0..=sides {
                let a = s as f32 / sides as f32 * std::f32::consts::TAU;
                let d = Vec3::new(a.cos(), 0.0, a.sin());
                verts.push(vtx(Vec3::new(c.x, lo.y + t * h, c.z) + d * radius[k], d, s as f32 / sides as f32, t));
            }
        }
        let row = (sides + 1) as u32;
        for k in 0..rings.len() as u32 - 1 {
            for s in 0..sides as u32 {
                let (a, b) = (k * row + s, (k + 1) * row + s);
                tris.push([a, b, a + 1]);
                tris.push([a + 1, b, b + 1]);
            }
        }
        let base = verts.len() as u32;
        let r = *radius.last().unwrap();
        for s in 0..sides {
            let a = s as f32 / sides as f32 * std::f32::consts::TAU;
            verts.push(vtx(Vec3::new(c.x + a.cos() * r, top_y, c.z + a.sin() * r), Vec3::Y, 0.5, 1.0));
        }
        for s in 1..sides as u32 - 1 {
            tris.push([base, base + s + 1, base + s]);
        }
    } else {
        let (hx, hz) = ((hi.x - lo.x) * 0.5, (hi.z - lo.z) * 0.5);
        let corners = [Vec3::new(-hx, 0.0, -hz), Vec3::new(hx, 0.0, -hz), Vec3::new(hx, 0.0, hz), Vec3::new(-hx, 0.0, hz)];
        for k in 0..4 {
            let (p0, p1) = (corners[k], corners[(k + 1) % 4]);
            let n = Vec3::Y.cross(p1 - p0).normalize();
            let base = verts.len() as u32;
            let (u0, u1) = (k as f32 / 4.0, (k + 1) as f32 / 4.0);
            let at = |p: Vec3, t: f32| Vec3::new(c.x + p.x, lo.y + t * h, c.z + p.z);
            verts.push(vtx(at(p0, 0.0), n, u0, 0.0));
            verts.push(vtx(at(p1, 0.0), n, u1, 0.0));
            verts.push(vtx(at(p1, 1.0), n, u1, 1.0));
            verts.push(vtx(at(p0, 1.0), n, u0, 1.0));
            tris.push([base, base + 2, base + 1]);
            tris.push([base, base + 3, base + 2]);
        }
        let base = verts.len() as u32;
        for p in corners {
            verts.push(vtx(Vec3::new(c.x + p.x, top_y, c.z + p.z), Vec3::Y, 0.5, 1.0));
        }
        tris.push([base, base + 2, base + 1]);
        tris.push([base, base + 3, base + 2]);
    }
    (verts, tris)
}
