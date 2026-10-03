//! Conservative orientation bounds for immutable, one-sided SGX triangles.
//! This is target visibility data, never a substitute for source geometry.
use crate::{Blend, Draw, Kind, Meta, VertexLayout};
use alloc::string::String;
#[cfg(not(feature = "std"))]
use num_traits::Float;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Cone {
    pub axis: [f32; 3],
    pub cosine: f32,
    pub offset: f32,
    /// Maximum (|edge1|+|edge2|)/|cross|; bounds orientation sensitivity.
    pub condition: f32,
}
impl Cone {
    pub fn values(self) -> [f32; 6] {
        [
            self.axis[0],
            self.axis[1],
            self.axis[2],
            self.cosine,
            self.offset,
            self.condition,
        ]
    }
    pub fn from_values(v: [f32; 6]) -> Self {
        Self {
            axis: [v[0], v[1], v[2]],
            cosine: v[3],
            offset: v[4],
            condition: v[5],
        }
    }
    pub fn valid(self) -> bool {
        self.values().iter().all(|x| x.is_finite())
            && self.cosine > 0.
            && self.cosine <= 1.
            && self.condition > 0.
            && dot(self.axis.map(f64::from), self.axis.map(f64::from)) > 0.5
    }
    pub fn disabled(self) -> bool {
        self.values().iter().all(|x| x.to_bits() == 0)
    }
    /// Prepare immutable coefficients once, after source containment validation.
    pub fn prepare(self) -> PreparedCone {
        if !self.valid() {
            return PreparedCone::default();
        }
        let axis = self.axis.map(f64::from);
        let norm = dot(axis, axis).sqrt();
        let exact = axis.map(|x| x / norm * self.cosine as f64);
        let k = exact.map(|x| x as f32);
        let delta = core::array::from_fn(|i| k[i] as f64 - exact[i]);
        // Rounding k changes its dot product by at most |delta|*|view|.
        // Include that error in the outward sine coefficient, with additional
        // f32-scale slack covering preparation's f64/libm arithmetic.
        let sine = up((1. - (self.cosine as f64) * self.cosine as f64)
            .max(0.)
            .sqrt()
            + dot(delta, delta).sqrt()
            + 4. * f32::EPSILON as f64);
        PreparedCone {
            k,
            sine,
            offset: self.offset,
            condition: self.condition,
        }
    }
    /// A strict negative upper bound is required. Near/tangent, ill-conditioned
    /// or invalid inputs remain visible. Calculations use f64 to keep the
    /// decision away from cancellation; no f32 squared-comparison shortcut.
    pub fn backfacing(self, lo: [f32; 3], hi: [f32; 3], eye: [f32; 3]) -> bool {
        if !self.valid()
            || eye.iter().chain(&lo).chain(&hi).any(|x| !x.is_finite())
            || (0..3).any(|k| lo[k] > hi[k])
        {
            return false;
        }
        if (0..3).all(|k| eye[k] >= lo[k] && eye[k] <= hi[k]) {
            return false;
        }
        let center: [f64; 3] = core::array::from_fn(|k| (lo[k] as f64 + hi[k] as f64) * 0.5);
        let v = core::array::from_fn(|k| eye[k] as f64 - center[k]);
        let mut axis = self.axis.map(f64::from);
        let length = dot(axis, axis).sqrt();
        for x in &mut axis {
            *x /= length;
        }
        let distance = dot(v, v).sqrt();
        let along = dot(axis, v);
        let cosine = self.cosine as f64;
        let sine = (1. - cosine * cosine).max(0.).sqrt();
        let upper = if along >= cosine * distance {
            distance
        } else {
            along * cosine + (dot(v, v) - along * along).max(0.).sqrt() * sine
        } + self.offset as f64;
        // Coordinate-sensitive guard for f32 camera/vertex transforms and
        // plane orientation. Sliver/tiny triangles enlarge this guard rather
        // than being treated as an exact stable face. Large ranges keep more.
        let magnitude = (0..3)
            .map(|k| {
                (eye[k] as f64)
                    .abs()
                    .max((lo[k] as f64).abs())
                    .max((hi[k] as f64).abs())
            })
            .fold(1f64, f64::max);
        let guard =
            64. * f32::EPSILON as f64 * magnitude * (1. + self.condition as f64 * distance) + 1e-6;
        upper.is_finite() && guard.is_finite() && upper < -guard
    }
}

/// Same 24-byte runtime footprint as the serialized Cone; f32-only queries.
/// Coefficients are private so only checked preparation can enable rejection.
#[derive(Clone, Copy, Debug, Default)]
pub struct PreparedCone {
    k: [f32; 3],
    sine: f32,
    offset: f32,
    condition: f32,
}
impl PreparedCone {
    /// A conservative L1 bound avoids query-time square roots and f64 on A4.
    ///
    /// Rounding bound (round-to-nearest, u = f32::EPSILON / 2): for M >= 1,
    /// computed view components differ by at most 4uM. Preparation gives
    /// |k|_1 < 2, so the dot error is at most 24uM; the exact view L1 norm
    /// is at most the computed norm + 32uM. The two positive operations in
    /// b = sine + guard*condition incur at most 5u relative error. Including
    /// the product and final sum gives error < 64u*S, where
    /// S = M + |offset| + guard + b*(L1 + M), using computed b and L1.
    /// Computing S has at most six rounding steps. The 256u multiplier below
    /// still exceeds 64u*S after downward rounding. Flushed subnormal errors
    /// are also covered: M >= 1, guard >= 64*EPSILON, and the 1e-6 term keep
    /// this allowance many orders above the few possible MIN_POSITIVE errors.
    /// Nonfinite arithmetic or coordinates outside the proved domain retain
    /// geometry. L1 >= L2 can likewise retain extra clusters, never hide them.
    pub fn backfacing(self, lo: [f32; 3], hi: [f32; 3], eye: [f32; 3]) -> bool {
        if self.condition <= 0.
            || eye.iter().chain(&lo).chain(&hi).any(|x| !x.is_finite())
            || (0..3).any(|k| lo[k] > hi[k])
            || (0..3).all(|k| eye[k] >= lo[k] && eye[k] <= hi[k])
        {
            return false;
        }
        let magnitude = (0..3)
            .map(|k| eye[k].abs().max(lo[k].abs()).max(hi[k].abs()))
            .fold(1f32, f32::max);
        // Keep center/view arithmetic comfortably below overflow. Very large
        // worlds are conservatively visible, not sent to a slow fallback.
        if magnitude > 1_152_921_504_606_846_976.0 {
            return false;
        }
        let v: [f32; 3] = core::array::from_fn(|k| eye[k] - (lo[k] + hi[k]) * 0.5);
        let products = core::array::from_fn::<_, 3, _>(|k| self.k[k] * v[k]);
        let along = (products[0] + products[1]) + products[2];
        let l1 = (v[0].abs() + v[1].abs()) + v[2].abs();
        // Multiplication by this power of two is exact in the bounded domain.
        let guard_scale = (64. * f32::EPSILON) * magnitude;
        let b = self.sine + guard_scale * self.condition;
        let upper = ((along + self.offset) + guard_scale) + b * l1 + 1e-6;
        let scale = ((magnitude + self.offset.abs()) + guard_scale) + b * (l1 + magnitude);
        let slack = (128. * f32::EPSILON) * scale;
        upper.is_finite() && slack.is_finite() && upper < -slack
    }
}
pub fn eligible(meta: &Meta, d: &Draw) -> bool {
    d.layout == VertexLayout::Baked
        && d.pos_offset == [0.; 3]
        && d.pos_scale == [1.; 3]
        && d.node.is_none()
        && d.skin.is_none()
        && meta.materials.get(d.material as usize).is_some_and(|m| {
            m.kind == Kind::Standard
                && m.blend == Blend::Opaque
                && m.depth_write
                && !m.double_sided
                && m.alpha_test == 0.
        })
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.into_iter().zip(b).map(|(x, y)| x * y).sum()
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    core::array::from_fn(|k| a[k] - b[k])
}
fn plane(p: [[f32; 3]; 3]) -> Option<([f64; 3], f64)> {
    if p.iter().flatten().any(|x| !x.is_finite()) {
        return None;
    }
    let a = sub(p[1].map(f64::from), p[0].map(f64::from));
    let b = sub(p[2].map(f64::from), p[0].map(f64::from));
    let n = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    let length = dot(n, n).sqrt();
    if !length.is_finite() || length <= 0. {
        return None;
    }
    let condition = (dot(a, a).sqrt() + dot(b, b).sqrt()) / length;
    if !condition.is_finite() || condition > 1e12 {
        return None;
    }
    Some((n.map(|x| x / length), condition))
}
pub fn bucket(p: [[f32; 3]; 3]) -> u8 {
    let Some((n, _)) = plane(p) else { return 6 };
    let mut k = 0;
    for i in 1..3 {
        if n[i].abs() > n[k].abs() {
            k = i;
        }
    }
    (k * 2 + usize::from(n[k] < 0.)) as u8
}
fn up(x: f64) -> f32 {
    let y = x as f32;
    if y as f64 >= x {
        return y;
    }
    if y == 0. {
        return f32::from_bits(1);
    }
    f32::from_bits(if y > 0. {
        y.to_bits() + 1
    } else {
        y.to_bits() - 1
    })
}
fn down(x: f64) -> f32 {
    -up(-x)
}
/// Deterministic source proof used by both compiler and loader. Normals are
/// derived from actual index winding, never authored shading normals.
pub fn build(
    d: &Draw,
    g: &[u8],
    indices: &[u16],
    lo: [f32; 3],
    hi: [f32; 3],
) -> Result<Cone, String> {
    if indices.is_empty() || indices.len() % 3 != 0 {
        return Err("backface triangle count".into());
    }
    let point = |t: &[u16]| -> Result<[[f32; 3]; 3], String> {
        Ok([
            super::position(d, g, t[0])?,
            super::position(d, g, t[1])?,
            super::position(d, g, t[2])?,
        ])
    };
    let mut sum = [0f64; 3];
    let mut category = None;
    for t in indices.chunks_exact(3) {
        let p = point(t)?;
        let b = bucket(p);
        if b == 6 || category.is_some_and(|x| x != b) {
            return Ok(Cone::default());
        }
        category = Some(b);
        let (n, _) = plane(p).unwrap();
        for k in 0..3 {
            sum[k] += n[k];
        }
    }
    let length = dot(sum, sum).sqrt();
    if !length.is_finite() || length == 0. {
        return Ok(Cone::default());
    }
    let axis = sum.map(|x| (x / length) as f32);
    let mut a = axis.map(f64::from);
    let length = dot(a, a).sqrt();
    for x in &mut a {
        *x /= length;
    }
    let center: [f64; 3] = core::array::from_fn(|k| (lo[k] as f64 + hi[k] as f64) * 0.5);
    let (mut cosine, mut offset, mut condition, mut extent) = (1f64, f64::NEG_INFINITY, 0f64, 1f64);
    for t in indices.chunks_exact(3) {
        let p = point(t)?;
        let (n, c) = plane(p).unwrap();
        cosine = cosine.min(dot(n, a));
        let relative = sub(p[0].map(f64::from), center);
        offset = offset.max(-dot(n, relative));
        extent = extent.max(relative.into_iter().map(f64::abs).sum());
        condition = condition.max(c);
    }
    let result = Cone {
        axis,
        cosine: down(cosine - 4. * f32::EPSILON as f64),
        offset: up(offset + 8. * f32::EPSILON as f64 * extent),
        condition: up(condition * (1. + 8. * f32::EPSILON as f64)),
    };
    Ok(if result.valid() {
        result
    } else {
        Cone::default()
    })
}

/// Check geometric containment, not producer/libm bit identity. The compiler
/// reserves substantially more f32-scale slack than this check requires, so
/// std and no_std sqrt rounding cannot turn an outward bound inward. A zero
/// descriptor safely disables this optional rejection for any source cluster.
pub fn validate(
    cone: Cone,
    d: &Draw,
    geometry: &[u8],
    indices: &[u16],
    lo: [f32; 3],
    hi: [f32; 3],
) -> Result<(), String> {
    if cone.disabled() {
        return Ok(());
    }
    if !cone.valid()
        || indices.is_empty()
        || indices.len() % 3 != 0
        || lo.iter().chain(&hi).any(|x| !x.is_finite())
        || (0..3).any(|k| lo[k] > hi[k])
    {
        return Err("invalid cluster backface descriptor".into());
    }
    let center: [f64; 3] = core::array::from_fn(|k| (lo[k] as f64 + hi[k] as f64) * 0.5);
    let a = cone.axis.map(f64::from);
    let length = dot(a, a).sqrt();
    let a = a.map(|x| x / length);
    for t in indices.chunks_exact(3) {
        let p = [
            super::position(d, geometry, t[0])?,
            super::position(d, geometry, t[1])?,
            super::position(d, geometry, t[2])?,
        ];
        let Some((n, condition)) = plane(p) else {
            return Err("cluster backface proof contains unstable triangle".into());
        };
        let relative = sub(p[0].map(f64::from), center);
        let extent = relative.into_iter().map(f64::abs).sum::<f64>().max(1.);
        if cone.cosine as f64 > dot(n, a) - f32::EPSILON as f64
            || (cone.offset as f64) < -dot(n, relative) + 2. * f32::EPSILON as f64 * extent
            || (cone.condition as f64) < condition * (1. + 2. * f32::EPSILON as f64)
        {
            return Err("cluster backface descriptor does not enclose source".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(points: &[[f32; 3]]) -> (Draw, alloc::vec::Vec<u8>) {
        let mut bytes = alloc::vec::Vec::new();
        for p in points {
            let mut v = [0u8; 56];
            for k in 0..3 {
                v[k * 4..k * 4 + 4].copy_from_slice(&p[k].to_le_bytes());
            }
            bytes.extend(v);
        }
        let d = Draw {
            material: 0,
            layout: VertexLayout::Baked,
            vertices: crate::Range {
                offset: 0,
                size: bytes.len() as u32,
            },
            vertex_count: points.len() as u32,
            indices: crate::Range { offset: 0, size: 0 },
            index_count: 0,
            pos_offset: [0.; 3],
            pos_scale: [1.; 3],
            uv_offset: [0.; 2],
            uv_scale: [1.; 2],
            min: [0.; 3],
            max: [1.; 3],
            node: None,
            skin: None,
            no_reflect: false,
            cast_shadow: true,
            lods: alloc::vec![],
        };
        (d, bytes)
    }
    #[test]
    fn planar_reflection_near_and_degenerate_cases_remain_conservative() {
        for scale in [1f32, 100.] {
            for origin in [0f32, 10000.] {
                let p = [
                    [origin, 0., origin],
                    [origin, 0., origin + scale],
                    [origin + scale, 0., origin],
                ];
                let (d, g) = fixture(&p);
                let lo = [origin, 0., origin];
                let hi = [origin + scale, 0., origin + scale];
                let cone = build(&d, &g, &[0, 1, 2], lo, hi).unwrap();
                validate(cone, &d, &g, &[0, 1, 2], lo, hi).unwrap();
                assert!(cone.valid());
                let front = [origin + scale * 0.5, scale * 10., origin + scale * 0.5];
                let back = [front[0], -front[1], front[2]];
                assert!(!cone.backfacing(lo, hi, front));
                assert!(cone.backfacing(lo, hi, back));
                assert!(!cone.backfacing(lo, hi, [front[0], -1e-8, front[2]]));
                assert!(!cone.backfacing(lo, hi, [f32::NAN, 0., 0.]));
            }
        }
        let (d, g) = fixture(&[[0.; 3], [1., 0., 0.], [2., 0., 0.]]);
        let c = build(&d, &g, &[0, 1, 2], [0.; 3], [2., 0., 0.]).unwrap();
        assert_eq!(c, Cone::default());
        assert!(!c.backfacing([0.; 3], [2., 0., 0.], [0., 0., -100.]));
    }
    #[test]
    fn every_culled_cone_has_only_backfacing_source_triangles() {
        let mut p = alloc::vec::Vec::new();
        for i in 0..25 {
            let x = i as f32 * 0.07;
            let z = (i % 5) as f32 * 0.11;
            p.extend([
                [x, 0., z],
                [x, 0., z + 0.08],
                [x + 0.06, 0.02 * (i % 3) as f32, z],
            ]);
        }
        let (d, g) = fixture(&p);
        let indices: alloc::vec::Vec<u16> = (0..p.len() as u16).collect();
        let lo = [0., 0., 0.];
        let hi = [2., 0.1, 1.];
        let cone = build(&d, &g, &indices, lo, hi).unwrap();
        validate(cone, &d, &g, &indices, lo, hi).unwrap();
        assert!(cone.valid());
        let mut culled = 0;
        for x in -12..=12 {
            for y in -12..=12 {
                for z in -6..=6 {
                    let eye = [x as f32 * 0.7, y as f32 * 0.7, z as f32 * 0.7];
                    if cone.prepare().backfacing(lo, hi, eye) {
                        culled += 1;
                        assert!(cone.backfacing(lo, hi, eye));
                        for t in p.chunks_exact(3) {
                            let (n, _) = plane([t[0], t[1], t[2]]).unwrap();
                            assert!(dot(n, sub(eye.map(f64::from), t[0].map(f64::from))) < 0.);
                        }
                    }
                }
            }
        }
        assert!(culled > 500);
    }
    #[test]
    fn source_containment_accepts_outward_bounds_and_rejects_inward_bounds() {
        let (d, g) = fixture(&[[0., 0., 0.], [0., 0., 1.], [1., 0.3, 0.]]);
        let (lo, hi) = ([0.; 3], [1., 0.3, 1.]);
        let c = build(&d, &g, &[0, 1, 2], lo, hi).unwrap();
        validate(c, &d, &g, &[0, 1, 2], lo, hi).unwrap();
        // Producer and consumer need not reproduce exactly the same rounded
        // float values. Wider bounds remain valid and only reject less.
        let mut wider = c;
        wider.cosine -= 0.01;
        wider.offset += 0.01;
        wider.condition *= 2.;
        validate(wider, &d, &g, &[0, 1, 2], lo, hi).unwrap();
        for bad in [
            Cone { cosine: 1., ..c },
            Cone {
                offset: c.offset - 0.1,
                ..c
            },
            Cone {
                condition: c.condition * 0.5,
                ..c
            },
            Cone {
                axis: [f32::NAN, 0., 0.],
                ..c
            },
        ] {
            assert!(validate(bad, &d, &g, &[0, 1, 2], lo, hi).is_err());
        }
        validate(Cone::default(), &d, &g, &[0, 1, 2], lo, hi).unwrap();
    }
    #[test]
    fn prepared_f32_l1_bound_keeps_footprint_and_never_rejects_more() {
        assert_eq!(core::mem::size_of::<PreparedCone>(), 24);
        let mut state = 0x1296123412349876u64;
        let mut random = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut rejected = 0;
        for i in 0..100_000 {
            let axis: [f32; 3] = core::array::from_fn(|_| (random() * 2. - 1.) as f32);
            let length = dot(axis.map(f64::from), axis.map(f64::from)).sqrt();
            if length < 0.1 {
                continue;
            }
            let scale = [1e-38f64, 1e-8, 0.001, 1., 1000., 1e8, 1e14][i % 7];
            let cone = Cone {
                axis: axis.map(|x| (x as f64 / length) as f32),
                cosine: if i % 7 == 0 {
                    1.
                } else {
                    (0.001 + random() * 0.999) as f32
                },
                offset: ((random() * 2. - 1.) * scale) as f32,
                condition: [1e-6, 1., 100., 1e12][i % 4],
            };
            let prepared = cone.prepare();
            assert!(
                prepared
                    .k
                    .into_iter()
                    .map(|x| (x as f64).abs())
                    .sum::<f64>()
                    < 2.
            );
            let center: [f32; 3] =
                core::array::from_fn(|_| ((random() * 2. - 1.) * scale * 10.) as f32);
            let lo = core::array::from_fn(|k| center[k] - (scale * 0.1) as f32);
            let hi = core::array::from_fn(|k| center[k] + (scale * 0.1) as f32);
            let eye =
                core::array::from_fn(|k| center[k] + ((random() * 2. - 1.) * scale * 100.) as f32);
            if prepared.backfacing(lo, hi, eye) {
                rejected += 1;
                assert!(cone.backfacing(lo, hi, eye));
            }
            assert!(!prepared.backfacing(lo, hi, center));
            assert!(!prepared.backfacing(lo, hi, [f32::NAN, 0., 0.]));
            assert!(!prepared.backfacing(lo, hi, [f32::INFINITY, 0., 0.]));
            assert!(!Cone::default().prepare().backfacing(lo, hi, eye));
        }
        assert!(rejected > 100);
    }
    #[test]
    fn prepared_f32_near_boundary_and_cancellation_have_no_false_rejection() {
        // Offset cancellation around the more conservative L1 boundary is a
        // stronger arithmetic oracle than just comparing the original cone.
        // Large coordinates with small view offsets exercise center rounding.
        let mut rejected = 0;
        for magnitude in [1f32, 1e4, 1e8, 1e14, 1e17] {
            for cosine in [0.001, 0.5, 0.999, 1.] {
                for condition in [f32::from_bits(1), 1e-6, 1., 1e12] {
                    for direction in [[1., -1., 0.5], [-1., 0.5, -1.], [0., 0., -1.]] {
                        let lo = [magnitude, -magnitude, magnitude];
                        let hi = lo.map(|x| x + magnitude * 1e-4);
                        let eye = core::array::from_fn(|k| lo[k] + direction[k] * magnitude * 1e-3);
                        let cone = Cone {
                            axis: [0.3, -0.4, 0.8660254],
                            cosine,
                            offset: 0.,
                            condition,
                        };
                        let prepared = cone.prepare();
                        let v: [f64; 3] = core::array::from_fn(|k| {
                            eye[k] as f64 - (lo[k] as f64 + hi[k] as f64) * 0.5
                        });
                        let m = (0..3)
                            .map(|k| {
                                (eye[k] as f64)
                                    .abs()
                                    .max((lo[k] as f64).abs())
                                    .max((hi[k] as f64).abs())
                            })
                            .fold(1f64, f64::max);
                        let guard = 64. * f32::EPSILON as f64 * m;
                        let base = dot(prepared.k.map(f64::from), v)
                            + guard
                            + (prepared.sine as f64 + guard * condition as f64)
                                * v.into_iter().map(f64::abs).sum::<f64>()
                            + 1e-6;
                        for step in [-1e-2, -1e-4, -1e-6, -1e-8, 0., 1e-8, 1e-6, 1e-4, 1e-2] {
                            let offset = (-base + step * base.abs().max(1.)) as f32;
                            let candidate = Cone { offset, ..cone };
                            if candidate.prepare().backfacing(lo, hi, eye) {
                                rejected += 1;
                                assert!(base + (offset as f64) < 0.);
                                assert!(candidate.backfacing(lo, hi, eye));
                            }
                        }
                    }
                }
            }
        }
        assert!(rejected > 100);
    }
    #[test]
    fn prepared_f32_outside_domain_and_overflow_remain_visible() {
        let c = Cone {
            axis: [0., 0., 1.],
            cosine: 1.,
            offset: 0.,
            condition: 1e-30,
        };
        let prepared = c.prepare();
        assert!(prepared.backfacing([0.; 3], [1.; 3], [0., 0., -1e10]));
        for eye in [[0., 0., -2f32.powi(61)], [f32::MAX, 0., -f32::MAX]] {
            assert!(!prepared.backfacing([0.; 3], [1.; 3], eye));
        }
        for offset in [f32::MAX, -f32::MAX] {
            let overflow = Cone {
                offset,
                condition: f32::MAX,
                ..c
            }
            .prepare();
            assert!(!overflow.backfacing([0.; 3], [1.; 3], [0., 0., -1e10]));
        }
        assert!(!prepared.backfacing([1.; 3], [0.; 3], [0., 0., -100.]));
    }
}
