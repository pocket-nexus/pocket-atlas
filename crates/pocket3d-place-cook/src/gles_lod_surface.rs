//! Offline sampled surface-distance measurement. Never a runtime raster path.
use glam::Vec3;
#[derive(Clone)]
struct BNode {
    lo: Vec3,
    hi: Vec3,
    start: usize,
    end: usize,
    left: usize,
    right: usize,
}
pub(super) struct Surface {
    pub(super) tris: Vec<[u32; 3]>,
    order: Vec<usize>,
    nodes: Vec<BNode>,
}
impl Surface {
    pub(super) fn new(indices: &[u32], p: &[Vec3]) -> Self {
        let tris: Vec<_> = indices
            .chunks_exact(3)
            .map(|t| [t[0], t[1], t[2]])
            .collect();
        let mut s = Self {
            order: (0..tris.len()).collect(),
            tris,
            nodes: Vec::new(),
        };
        s.build(p, 0, s.tris.len());
        s
    }
    fn build(&mut self, p: &[Vec3], start: usize, end: usize) -> usize {
        let mut lo = Vec3::splat(f32::INFINITY);
        let mut hi = Vec3::splat(f32::NEG_INFINITY);
        for &i in &self.order[start..end] {
            for &v in &self.tris[i] {
                lo = lo.min(p[v as usize]);
                hi = hi.max(p[v as usize]);
            }
        }
        let id = self.nodes.len();
        self.nodes.push(BNode {
            lo,
            hi,
            start,
            end,
            left: 0,
            right: 0,
        });
        if end - start > 8 {
            let extent = hi - lo;
            let axis = if extent.x > extent.y && extent.x > extent.z {
                0
            } else if extent.y > extent.z {
                1
            } else {
                2
            };
            let tris = &self.tris;
            self.order[start..end].sort_unstable_by(|&a, &b| {
                let x = tris[a].iter().map(|&i| p[i as usize][axis]).sum::<f32>();
                let y = tris[b].iter().map(|&i| p[i as usize][axis]).sum::<f32>();
                x.total_cmp(&y)
            });
            let mid = (start + end) / 2;
            let l = self.build(p, start, mid);
            let r = self.build(p, mid, end);
            self.nodes[id].left = l;
            self.nodes[id].right = r;
        }
        id
    }
    pub(super) fn refit(&mut self, p: &[Vec3]) {
        for i in (0..self.nodes.len()).rev() {
            let n = &self.nodes[i];
            let (lo, hi) = if n.left != 0 {
                (
                    self.nodes[n.left].lo.min(self.nodes[n.right].lo),
                    self.nodes[n.left].hi.max(self.nodes[n.right].hi),
                )
            } else {
                let mut lo = Vec3::splat(f32::INFINITY);
                let mut hi = Vec3::splat(f32::NEG_INFINITY);
                for &j in &self.order[n.start..n.end] {
                    for &v in &self.tris[j] {
                        lo = lo.min(p[v as usize]);
                        hi = hi.max(p[v as usize]);
                    }
                }
                (lo, hi)
            };
            self.nodes[i].lo = lo;
            self.nodes[i].hi = hi;
        }
    }
    pub(super) fn distance2(&self, p: Vec3, vertices: &[Vec3]) -> f32 {
        let mut best = f32::INFINITY;
        self.visit(0, p, vertices, &mut best);
        best
    }
    fn visit(&self, id: usize, p: Vec3, vertices: &[Vec3], best: &mut f32) {
        let n = &self.nodes[id];
        if p.distance_squared(p.clamp(n.lo, n.hi)) > *best {
            return;
        }
        if n.left == 0 {
            for &i in &self.order[n.start..n.end] {
                let t = self.tris[i];
                *best = best.min(point_triangle(
                    p,
                    vertices[t[0] as usize],
                    vertices[t[1] as usize],
                    vertices[t[2] as usize],
                ));
            }
        } else {
            let a = &self.nodes[n.left];
            let b = &self.nodes[n.right];
            let da = p.distance_squared(p.clamp(a.lo, a.hi));
            let db = p.distance_squared(p.clamp(b.lo, b.hi));
            let (first, last) = if da < db {
                (n.left, n.right)
            } else {
                (n.right, n.left)
            };
            self.visit(first, p, vertices, best);
            self.visit(last, p, vertices, best);
        }
    }
}
fn segment2(p: Vec3, a: Vec3, b: Vec3) -> f32 {
    let ab = b - a;
    let t = ((p - a).dot(ab) / ab.length_squared().max(1e-30)).clamp(0., 1.);
    p.distance_squared(a + ab * t)
}
fn point_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> f32 {
    let ab = b - a;
    let ac = c - a;
    if ab.cross(ac).length_squared() < 1e-20 {
        return segment2(p, a, b)
            .min(segment2(p, b, c))
            .min(segment2(p, c, a));
    }
    let ap = p - a;
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0. && d2 <= 0. {
        return ap.length_squared();
    }
    let bp = p - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0. && d4 <= d3 {
        return bp.length_squared();
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0. && d1 >= 0. && d3 <= 0. {
        return p.distance_squared(a + ab * (d1 / (d1 - d3)));
    }
    let cp = p - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0. && d5 <= d6 {
        return cp.length_squared();
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0. && d2 >= 0. && d6 <= 0. {
        return p.distance_squared(a + ac * (d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0. && (d4 - d3) >= 0. && (d5 - d6) >= 0. {
        return p.distance_squared(b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))));
    }
    let denom = 1. / (va + vb + vc);
    p.distance_squared(a + ab * (vb * denom) + ac * (vc * denom))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distance_handles_faces_edges_vertices_and_degenerate_triangles() {
        let (a, b, c) = (Vec3::ZERO, Vec3::X, Vec3::Y);
        assert!((point_triangle(Vec3::new(0.2, 0.3, 2.), a, b, c) - 4.).abs() < 1e-6);
        assert!((point_triangle(Vec3::new(2., 0., 0.), a, b, c) - 1.).abs() < 1e-6);
        assert!((point_triangle(Vec3::new(-1., -1., 0.), a, b, c) - 2.).abs() < 1e-6);
        assert!((point_triangle(Vec3::new(0.5, 2., 0.), a, b, b) - 4.).abs() < 1e-6);
        assert_eq!(point_triangle(Vec3::Z, a, a, a), 1.);
    }
    #[test]
    fn refitted_bvh_matches_brute_force_after_nonrigid_deformation() {
        let mut p = Vec::new();
        let mut indices = Vec::new();
        for i in 0..40 {
            let x = i as f32 * 0.2;
            let n = p.len() as u32;
            p.extend([
                Vec3::new(x, 0., 0.),
                Vec3::new(x + 0.15, 0., 0.),
                Vec3::new(x, 1., 0.),
            ]);
            indices.extend([n, n + 1, n + 2]);
        }
        let mut bvh = Surface::new(&indices, &p);
        for frame in 0..3 {
            for (i, v) in p.iter_mut().enumerate() {
                v.z = (i as f32 * 0.31 + frame as f32).sin();
            }
            bvh.refit(&p);
            for k in 0..91 {
                let q = Vec3::new(k as f32 * 0.11 - 0.4, 0.4, 1.5);
                let oracle = indices
                    .chunks_exact(3)
                    .map(|t| {
                        point_triangle(q, p[t[0] as usize], p[t[1] as usize], p[t[2] as usize])
                    })
                    .fold(f32::INFINITY, f32::min);
                assert!((bvh.distance2(q, &p) - oracle).abs() < 1e-6);
            }
        }
    }
}
