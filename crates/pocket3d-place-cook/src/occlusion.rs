//! Sky occlusion for the vertex bake: the share of the cosine-weighted
//! hemisphere above a point that no static geometry blocks within a reach.
//! It scales the hemisphere and environment terms (what screen-space AO does
//! for the web reference), not the lights. A BVH over the place's static
//! triangles answers any-hit ray queries.

use glam::Vec3;

pub struct Tri {
    pub a: Vec3,
    pub e1: Vec3,
    pub e2: Vec3,
    /// How much a hit blocks: 1 for solid surfaces, less for cut-out foliage.
    pub opacity: f32,
}

#[derive(Clone, Copy)]
struct Node {
    min: Vec3,
    max: Vec3,
    /// Leaf: first triangle and count; inner: left child (right = left + 1).
    start: u32,
    count: u32,
}

pub struct Occluder {
    tris: Vec<Tri>,
    nodes: Vec<Node>,
    rays: Vec<Vec3>,
    reach: f32,
}

const LEAF: usize = 4;

impl Occluder {
    /// `rays` cosine-weighted directions around +Z, reused (rotated) at every
    /// point; `reach` is the longest ray (metres).
    pub fn new(mut tris: Vec<Tri>, rays: usize, reach: f32) -> Self {
        let mut nodes = Vec::with_capacity(tris.len() / 2 + 1);
        nodes.push(Node { min: Vec3::ZERO, max: Vec3::ZERO, start: 0, count: tris.len() as u32 });
        let mut stack = vec![0usize];
        while let Some(i) = stack.pop() {
            let Node { start, count, .. } = nodes[i];
            let (s, c) = (start as usize, count as usize);
            let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
            let (mut clo, mut chi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
            for t in &tris[s..s + c] {
                for p in [t.a, t.a + t.e1, t.a + t.e2] {
                    lo = lo.min(p);
                    hi = hi.max(p);
                }
                let ctr = t.a + (t.e1 + t.e2) / 3.0;
                clo = clo.min(ctr);
                chi = chi.max(ctr);
            }
            nodes[i].min = lo;
            nodes[i].max = hi;
            if c <= LEAF {
                continue;
            }
            // Median split on the longest centroid axis.
            let ext = chi - clo;
            let axis = if ext.x >= ext.y && ext.x >= ext.z { 0 } else if ext.y >= ext.z { 1 } else { 2 };
            let key = |t: &Tri| (t.a + (t.e1 + t.e2) / 3.0)[axis];
            tris[s..s + c].select_nth_unstable_by(c / 2, |x, y| key(x).total_cmp(&key(y)));
            let left = nodes.len();
            nodes.push(Node { min: Vec3::ZERO, max: Vec3::ZERO, start: start, count: (c / 2) as u32 });
            nodes.push(Node { min: Vec3::ZERO, max: Vec3::ZERO, start: start + (c / 2) as u32, count: (c - c / 2) as u32 });
            nodes[i].start = left as u32;
            nodes[i].count = 0;
            stack.push(left);
            stack.push(left + 1);
        }
        // Stratified cosine-weighted directions (golden-angle spiral on the disc).
        let dirs = (0..rays)
            .map(|k| {
                let r = ((k as f32 + 0.5) / rays as f32).sqrt();
                let phi = k as f32 * 2.399_963;
                Vec3::new(r * phi.cos(), r * phi.sin(), (1.0 - r * r).max(0.0).sqrt())
            })
            .collect();
        Self { tris, nodes, rays: dirs, reach }
    }

    fn slab(n: &Node, o: Vec3, inv: Vec3, tmax: f32) -> bool {
        let t0 = (n.min - o) * inv;
        let t1 = (n.max - o) * inv;
        let near = t0.min(t1).max_element().max(0.0);
        let far = t0.max(t1).min_element().min(tmax);
        near <= far
    }

    /// Opacity of the first surface that blocks the ray (0: open sky).
    fn blocked(&self, o: Vec3, d: Vec3, tmax: f32) -> f32 {
        let inv = Vec3::new(1.0 / d.x, 1.0 / d.y, 1.0 / d.z);
        let mut stack = [0u32; 64];
        let mut sp = 1usize;
        let mut best = 0.0f32;
        while sp > 0 {
            sp -= 1;
            let n = &self.nodes[stack[sp] as usize];
            if !Self::slab(n, o, inv, tmax) {
                continue;
            }
            if n.count == 0 {
                if sp + 2 <= stack.len() {
                    stack[sp] = n.start;
                    stack[sp + 1] = n.start + 1;
                    sp += 2;
                }
                continue;
            }
            for t in &self.tris[n.start as usize..(n.start + n.count) as usize] {
                // Möller–Trumbore, both faces.
                let p = d.cross(t.e2);
                let det = t.e1.dot(p);
                if det.abs() < 1e-9 {
                    continue;
                }
                let id = 1.0 / det;
                let s = o - t.a;
                let u = s.dot(p) * id;
                if !(0.0..=1.0).contains(&u) {
                    continue;
                }
                let q = s.cross(t.e1);
                let v = d.dot(q) * id;
                if v < 0.0 || u + v > 1.0 {
                    continue;
                }
                let h = t.e2.dot(q) * id;
                if h > 1e-3 && h < tmax {
                    if t.opacity >= 1.0 {
                        return 1.0;
                    }
                    best = best.max(t.opacity);
                }
            }
        }
        best
    }

    /// Unblocked share of the cosine-weighted hemisphere around `n` at `p`.
    pub fn visibility(&self, p: Vec3, n: Vec3) -> f32 {
        let n = n.normalize_or(Vec3::Y);
        let t = if n.y.abs() < 0.9 { Vec3::Y.cross(n).normalize() } else { Vec3::X.cross(n).normalize() };
        let b = n.cross(t);
        // Off the surface a little, so the triangle itself does not count.
        let o = p + n * 0.02;
        let mut open = 0.0;
        for r in &self.rays {
            let d = t * r.x + b * r.y + n * r.z;
            open += 1.0 - self.blocked(o, d, self.reach);
        }
        open / self.rays.len() as f32
    }
}
