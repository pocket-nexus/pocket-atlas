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
    pub source: Vec<Vertex>,
    pub vertices: Vec<u8>,
    pub indices: Vec<u8>,
    pub vertex_count: u32,
    pub index_count: u32,
    /// Coarser index lists over the same vertices (LOD1, LOD2), each with
    /// its error from the full mesh (m).
    pub lods: Vec<(Vec<u8>, u32, f32)>,
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

/// Reorders triangles for the post-transform vertex cache.
pub fn cache_order(tris: &[[u32; 3]], vertex_count: usize) -> Vec<[u32; 3]> {
    let flat: Vec<u32> = tris.iter().flatten().copied().collect();
    meshopt::optimize_vertex_cache(&flat, vertex_count).chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

fn u16_indices(tris: &[[u32; 3]]) -> Vec<u8> {
    let mut idx = Vec::with_capacity(tris.len() * 6);
    for t in tris {
        for &i in t {
            idx.extend((i as u16).to_le_bytes());
        }
    }
    idx
}

/// Simplified index list over `verts` for distant draws: shading attributes
/// (normal, baked light, vertex colour, UV) weigh into the error, borders
/// between chunks stay locked. `None` when it removes less than a third.
/// Reduced index list over `tris`' vertices: `keep` of the triangles, at
/// most `max_error` (m) off. `locked` vertices stay where they are (edges
/// shared with a neighbouring chunk, so chunks stay sealed); open borders of
/// the mesh itself (tube ends, rails) may simplify. None if nothing goes.
pub fn simplify(verts: &[Vertex], tris: &[[u32; 3]], keep: f32, max_error: f32, locked: &[bool]) -> Option<(Vec<[u32; 3]>, f32)> {
    if tris.len() < 64 {
        return None;
    }
    let pos: Vec<f32> = verts.iter().flat_map(|v| [v.pos.x, v.pos.y, v.pos.z]).collect();
    let bytes: Vec<u8> = pos.iter().flat_map(|f| f.to_le_bytes()).collect();
    let adapter = meshopt::VertexDataAdapter::new(&bytes, 12, 0).ok()?;
    const ATTRS: usize = 9;
    let attrs: Vec<f32> = verts
        .iter()
        .flat_map(|v| {
            let l = v.light.map(|c| c as f32 / 255.0);
            let lum = (l[0] * 0.3 + l[1] * 0.6 + l[2] * 0.1) * l[3];
            let c = v.color.map(|c| c as f32 / 255.0);
            [v.normal.x, v.normal.y, v.normal.z, lum, c[0], c[1], c[2], v.uv.x, v.uv.y]
        })
        .collect();
    let weights = [0.4, 0.4, 0.4, 2.0, 0.5, 0.5, 0.5, 0.02, 0.02];
    let flat: Vec<u32> = tris.iter().flatten().copied().collect();
    let mut err = 0.0f32;
    let out = meshopt::simplify_with_attributes_and_locks(
        &flat,
        &adapter,
        &attrs,
        &weights,
        ATTRS * 4,
        locked,
        ((flat.len() as f32 * keep) as usize / 3) * 3,
        max_error,
        meshopt::SimplifyOptions::ErrorAbsolute,
        Some(&mut err),
    );
    if out.len() >= flat.len() || out.is_empty() {
        return None;
    }
    Some((out.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect(), err))
}

/// Quantizes one draw (≤ 65 536 unique vertices) into the Static (24 B),
/// Baked (28 B) or Skinned (32 B) layout. `lods`: reduced triangles over the
/// same vertices and their errors, finest first.
pub fn build(verts: &[Vertex], tris: &[[u32; 3]], layout: pocket3d_place::VertexLayout, lods: Vec<(Vec<[u32; 3]>, f32)>, encode_vita: bool) -> Built {
    let skinned = layout == pocket3d_place::VertexLayout::Skinned;
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
    for v in verts.iter().filter(|_| encode_vita) {
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
        if layout == pocket3d_place::VertexLayout::Baked {
            out.extend(v.light);
        }
        if skinned {
            out.extend(v.joints);
            out.extend(v.weights);
        }
    }
    Built {
        source: if encode_vita { Vec::new() } else { verts.to_vec() },
        vertices: out,
        indices: u16_indices(&cache_order(tris, verts.len())),
        vertex_count: verts.len() as u32,
        index_count: (tris.len() * 3) as u32,
        lods: lods.into_iter().map(|(t, e)| (u16_indices(&t), (t.len() * 3) as u32, e)).collect(),
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
/// Visible width of each vertex's connected part (parts joined by shared
/// triangles or equal positions): the middle of the part's three extents,
/// the gap its removal leaves from most directions. The extents are measured
/// along the part's own face axes (exact for the boxes most parts are, and
/// for rotated buildings), not along the world axes.
fn part_widths(verts: &[Vertex], tris: &[[u32; 3]]) -> Vec<f32> {
    let mut parent: Vec<u32> = (0..verts.len() as u32).collect();
    fn find(p: &mut [u32], mut i: u32) -> u32 {
        while p[i as usize] != i {
            p[i as usize] = p[p[i as usize] as usize];
            i = p[i as usize];
        }
        i
    }
    let union = |p: &mut Vec<u32>, a: u32, b: u32| {
        let (a, b) = (find(p, a), find(p, b));
        if a != b {
            p[a as usize] = b;
        }
    };
    for t in tris {
        union(&mut parent, t[0], t[1]);
        union(&mut parent, t[1], t[2]);
    }
    let mut at: HashMap<[u32; 3], u32> = HashMap::new();
    for (i, v) in verts.iter().enumerate() {
        let first = *at.entry(pos_bits(v.pos)).or_insert(i as u32);
        union(&mut parent, first, i as u32);
    }
    let roots: Vec<u32> = (0..verts.len() as u32).map(|i| find(&mut parent, i)).collect();
    // Axes per part: the first face normal, then the face normal most
    // perpendicular to it, then their cross product.
    let mut normals: HashMap<u32, Vec<Vec3>> = HashMap::new();
    for t in tris {
        let (a, b, c) = (verts[t[0] as usize].pos, verts[t[1] as usize].pos, verts[t[2] as usize].pos);
        let n = (b - a).cross(c - a);
        if n.length_squared() > 1e-12 {
            normals.entry(roots[t[0] as usize]).or_default().push(n.normalize());
        }
    }
    let axes: HashMap<u32, [Vec3; 3]> = normals
        .into_iter()
        .map(|(r, ns)| {
            let x = ns[0];
            let y = ns.iter().min_by(|a, b| a.dot(x).abs().total_cmp(&b.dot(x).abs())).copied().unwrap_or(Vec3::Y);
            let y = (y - x * y.dot(x)).try_normalize().unwrap_or_else(|| x.any_orthonormal_vector());
            (r, [x, y, x.cross(y)])
        })
        .collect();
    let mut bounds: HashMap<u32, ([f32; 3], [f32; 3])> = HashMap::new();
    for (i, v) in verts.iter().enumerate() {
        let Some(ax) = axes.get(&roots[i]) else { continue };
        let p = [v.pos.dot(ax[0]), v.pos.dot(ax[1]), v.pos.dot(ax[2])];
        let b = bounds.entry(roots[i]).or_insert((p, p));
        for k in 0..3 {
            b.0[k] = b.0[k].min(p[k]);
            b.1[k] = b.1[k].max(p[k]);
        }
    }
    roots
        .iter()
        .map(|r| {
            let Some((lo, hi)) = bounds.get(r) else { return f32::MAX };
            let mut e = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
            e.sort_by(|a, b| a.total_cmp(b));
            e[1]
        })
        .collect()
}

/// Reduced levels at most `bounds` metres off (LOD1 ≤ 6 cm and LOD2 ≤ 25 cm
/// near the middle of a place, coarser for far chunks), nested so each
/// level only removes triangles: with `drop_parts`, parts narrower than the
/// level's error go (window bars, rails, small boxes, which no edge collapse
/// can reduce), then the rest simplifies to 40 % of the level above. A level
/// is kept when it has at most two thirds of the triangles of the level
/// above (a draw may have only the coarse one).
pub fn lods(verts: &[Vertex], tris: &[[u32; 3]], locked: &[bool], drop_parts: bool, bounds: &[f32]) -> Vec<(Vec<[u32; 3]>, f32)> {
    let widths = if drop_parts { part_widths(verts, tris) } else { vec![f32::MAX; verts.len()] };
    let mut out: Vec<(Vec<[u32; 3]>, f32)> = Vec::new();
    let (mut prev, mut prev_err) = (tris.to_vec(), 0.0f32);
    for &bound in bounds {
        let kept: Vec<[u32; 3]> = prev.iter().filter(|t| widths[t[0] as usize] > bound).copied().collect();
        let mut err = if kept.len() < prev.len() { bound } else { prev_err };
        let level = match simplify(verts, &kept, 0.4, bound - prev_err, locked) {
            Some((l, e)) => {
                err = err.max(prev_err + e);
                l
            }
            None => kept,
        };
        // An empty level is kept: every part of the draw is narrower than
        // its error, and the renderer skips the draw.
        if level.len() * 3 > prev.len() * 2 {
            continue;
        }
        out.push((cache_order(&level, verts.len()), err));
        if level.is_empty() {
            break;
        }
        prev = level;
        prev_err = err;
    }
    out
}

/// Position bits, for matching vertices across attribute seams and chunks.
pub fn pos_bits(p: Vec3) -> [u32; 3] {
    [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]
}

/// How unevenly a triangle's texture mapping spreads texels: log2 of the
/// ratio of the texel densities (texels per metre) along the mapping's two
/// principal directions, and the triangle's area (m²). `texels` scales UV
/// to texels (the texture's size). None for degenerate triangles or
/// mappings (a constant UV).
pub fn texel_anisotropy(p: [Vec3; 3], uv: [Vec2; 3], texels: Vec2) -> Option<(f32, f32)> {
    let (e1, e2) = (p[1] - p[0], p[2] - p[0]);
    let n = e1.cross(e2);
    let area = n.length() * 0.5;
    if area < 1e-8 {
        return None;
    }
    // The triangle in its own plane: e1 along x.
    let t1 = e1.normalize();
    let t2 = n.normalize().cross(t1);
    let (ax, bx, by) = (e1.length(), e2.dot(t1), e2.dot(t2));
    let (d1, d2) = ((uv[1] - uv[0]) * texels, (uv[2] - uv[0]) * texels);
    // J · [a b] = [d1 d2] with a = (ax, 0), b = (bx, by).
    let det = ax * by;
    if det.abs() < 1e-12 {
        return None;
    }
    let c0 = d1 / ax;
    let c1 = (d2 - c0 * bx) / by;
    // Singular values of J = [c0 c1]: σ1² + σ2² = f, σ1 σ2 = g.
    let f = c0.length_squared() + c1.length_squared();
    let g = (c0.x * c1.y - c1.x * c0.y).abs();
    let disc = (f * f * 0.25 - g * g).max(0.0).sqrt();
    let (s1, s2) = ((f * 0.5 + disc).sqrt(), (f * 0.5 - disc).max(0.0).sqrt());
    if s1 < 1e-6 || s2 < 1e-6 * s1 {
        return None;
    }
    Some(((s1 / s2).log2(), area))
}

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
        let sides = 5;
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

/// LOD1 of one shelf item: a two-sided vertical card through its centre,
/// spanning its wider horizontal extent (4 triangles instead of 10–23).
pub fn product_card(src: &[Vertex]) -> (Vec<Vertex>, Vec<[u32; 3]>) {
    let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for v in src {
        lo = lo.min(v.pos);
        hi = hi.max(v.pos);
    }
    let c = (lo + hi) * 0.5;
    let along_x = hi.x - lo.x >= hi.z - lo.z;
    let (a, b, n) = if along_x {
        (Vec3::new(lo.x, 0.0, c.z), Vec3::new(hi.x, 0.0, c.z), Vec3::Z)
    } else {
        (Vec3::new(c.x, 0.0, hi.z), Vec3::new(c.x, 0.0, lo.z), Vec3::X)
    };
    let vtx = |p: Vec3, n: Vec3, u: f32, t: f32| Vertex {
        pos: Vec3::new(p.x, lo.y + t * (hi.y - lo.y), p.z),
        normal: n,
        tangent: [1.0, 0.0, 0.0, 1.0],
        uv: Vec2::new(u, t),
        color: [255, 255, 255, (t * 255.0).round() as u8],
        joints: [0; 4],
        weights: [255, 0, 0, 0],
        light: [0; 4],
    };
    let mut verts = Vec::with_capacity(8);
    for side in [n, -n] {
        verts.extend([vtx(a, side, 0.0, 0.0), vtx(b, side, 1.0, 0.0), vtx(b, side, 1.0, 1.0), vtx(a, side, 0.0, 1.0)]);
    }
    (verts, vec![[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6]])
}
