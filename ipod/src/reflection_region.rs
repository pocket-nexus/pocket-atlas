//! Read footprint of the SGX display wet-response pass, in the original FBOs.
//!
//! This does not change a projection, viewport, LOD, or texture coordinate. The
//! caller must use `Full` unless **every** mirror consumer uses the display wet
//! recipe: screen UV + (puddles-0.5)*0.006 + ripple*(uWet.w*puddle*0.005), with
//! puddle in [0,uWetCurve.w]. Both sharp and blurred reads are included even if
//! the shader selects one. Targets must use GL_LINEAR/CLAMP_TO_EDGE, no mipmaps;
//! down_f must have its current centre/four-diagonal taps at +/-1/source texel.
//! Bounds must enclose the vertices in world space (including animation/LOD).
//! Reference and other wet shader recipes have different offsets: use `Full`.
//!
//! Clear the whole mirror first, then scissor sky/meshes to `mirror` and down_f
//! to `down`. Keep the original full target sizes and UV mapping. Disable the
//! scissor before subsequent passes. `Empty` permits skipping both mirror
//! passes; it must not disable other wet shading or change reflection uniforms.
use glam::{Mat4, Vec3};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Rect {
    fn from_edges(lo: [i32; 2], hi: [i32; 2]) -> Self {
        Self {
            x: lo[0],
            y: lo[1],
            width: hi[0] - lo[0],
            height: hi[1] - lo[1],
        }
    }
    fn union(self, other: Self) -> Self {
        Self::from_edges(
            [self.x.min(other.x), self.y.min(other.y)],
            [
                (self.x + self.width).max(other.x + other.width),
                (self.y + self.height).max(other.y + other.height),
            ],
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReflectionRegion {
    Empty,
    Full,
    Scissor { mirror: Rect, down: Rect },
}

#[derive(Clone, Copy, Debug)]
pub struct WetBounds {
    pub min: Vec3,
    pub max: Vec3,
    /// Actual uWet.w, not a material default or the current ripple sample.
    pub ripple: f32,
    /// Actual uWetCurve.w (the smoothstep's maximum puddle gain).
    pub puddle_gain: f32,
}

impl ReflectionRegion {
    /// Pure O(readers) calculation; no allocations or GL state. Sizes are the
    /// actual wet-response, sharp-mirror and downsampled-mirror dimensions.
    /// The matrix is the unchanged main GL view-projection (near z >= -w).
    pub fn calculate(
        vp: Mat4,
        response: [i32; 2],
        mirror: [i32; 2],
        down: [i32; 2],
        readers: impl IntoIterator<Item = WetBounds>,
    ) -> Self {
        if ![response, mirror, down]
            .into_iter()
            .flatten()
            .all(|n| (1..=4096).contains(&n))
        {
            return Self::Full;
        }
        let columns = vp.to_cols_array_2d().map(|column| column.map(f64::from));
        if columns.iter().flatten().any(|x| !x.is_finite()) {
            return Self::Full;
        }
        let mut region: Option<(Rect, Rect)> = None;
        for reader in readers {
            if !reader.ripple.is_finite()
                || reader.ripple.abs() > 16.0
                || !reader.puddle_gain.is_finite()
                || !(0.0..=1.0).contains(&reader.puddle_gain)
            {
                return Self::Full;
            }
            let uv = match projected_bounds(&columns, reader.min, reader.max) {
                Err(()) => return Self::Full,
                Ok(None) => continue,
                Ok(Some(uv)) => uv,
            };
            let shift =
                0.003 + 0.005 * f64::from(reader.ripple.abs()) * f64::from(reader.puddle_gain);
            // vScreen is highp; the generated wet FS subsequently copies UV to
            // mediump. Reserve at least a whole mirror texel, and a larger
            // normalized guard on larger targets (several binary16 roundings
            // of the bounded UV/offset arithmetic). Do not infer a smaller
            // guard from a frozen ripple frame or a particular puddle sample.
            let precision = (1.0 + 0.003 + 0.005 * f64::from(reader.ripple.abs())) / 256.0;
            let mut sample_lo = [0.0; 2];
            let mut sample_hi = [0.0; 2];
            for k in 0..2 {
                // Conservatively include each response cell touched by the
                // projected box, then use its centre: that is where the wet
                // shader runs. This also covers the response's later native
                // GL_LINEAR resolve; no main-scene occlusion is subtracted.
                let n = f64::from(response[k]);
                let first = libm::floor(uv[k] * n).max(0.0).min(n - 1.0);
                let last = (libm::ceil(uv[k + 2] * n) - 1.0).max(first).min(n - 1.0);
                let guard = precision.max(1.0 / f64::from(mirror[k]));
                sample_lo[k] = (first + 0.5) / n - shift - guard;
                sample_hi[k] = (last + 0.5) / n + shift + guard;
            }
            let sharp = linear_rect(sample_lo, sample_hi, mirror);
            let blur = linear_rect(sample_lo, sample_hi, down);
            let mut source_lo = [0.0; 2];
            let mut source_hi = [0.0; 2];
            for (k, (first, count)) in [(blur.x, blur.width), (blur.y, blur.height)]
                .into_iter()
                .enumerate()
            {
                // Complete dependency of all down texels in the rectangular
                // scissor, including both diagonal taps and source bilinear
                // filtering. Handles odd/non-2:1 target ratios as well.
                source_lo[k] =
                    (f64::from(first) + 0.5) / f64::from(down[k]) - 1.0 / f64::from(mirror[k]);
                source_hi[k] = (f64::from(first + count) - 0.5) / f64::from(down[k])
                    + 1.0 / f64::from(mirror[k]);
            }
            let source = sharp.union(linear_rect(source_lo, source_hi, mirror));
            region = Some(match region {
                None => (source, blur),
                Some((a, b)) => (a.union(source), b.union(blur)),
            });
        }
        match region {
            None => Self::Empty,
            Some((a, b))
                if a == Rect::from_edges([0, 0], mirror) && b == Rect::from_edges([0, 0], down) =>
            {
                Self::Full
            }
            Some((mirror, down)) => Self::Scissor { mirror, down },
        }
    }
}

/// All bilinear texels with nonzero or boundary-zero weight, with texture-edge
/// clamp. Edges returned to glScissor are integral and upper-exclusive.
fn linear_rect(lo: [f64; 2], hi: [f64; 2], size: [i32; 2]) -> Rect {
    let mut first = [0; 2];
    let mut last = [0; 2];
    for k in 0..2 {
        let n = f64::from(size[k]);
        first[k] = libm::floor(lo[k] * n - 0.5).max(0.0).min(n - 1.0) as i32;
        last[k] = (libm::floor(hi[k] * n - 0.5) + 1.0).max(0.0).min(n - 1.0) as i32 + 1;
    }
    Rect::from_edges(first, last)
}

/// Project a box clipped against an expanded GL near half-space. Linear-
/// fractional extrema over this convex polytope lie at its original corners
/// or its twelve original-edge/near-plane intersections. XY is clamped only
/// after perspective division, so a near-crossing box need not return Full.
/// Each clip coordinate carries an absolute f32 dot-product error envelope;
/// near rejection is relaxed by that envelope and the perspective divide is
/// bounded by interval endpoints. Ill-conditioned w falls back to Full.
fn projected_bounds(m: &[[f64; 4]; 4], min: Vec3, max: Vec3) -> Result<Option<[f64; 4]>, ()> {
    let lo = min.to_array().map(f64::from);
    let hi = max.to_array().map(f64::from);
    if (0..3).any(|k| !lo[k].is_finite() || !hi[k].is_finite() || lo[k] > hi[k]) {
        return Err(());
    }
    let magnitude = [
        lo[0].abs().max(hi[0].abs()),
        lo[1].abs().max(hi[1].abs()),
        lo[2].abs().max(hi[2].abs()),
        1.0,
    ];
    let mut error = [0.0; 4];
    for r in 0..4 {
        let sum = (0..4).map(|c| m[c][r].abs() * magnitude[c]).sum::<f64>();
        if !sum.is_finite() || sum > 1e30 {
            return Err(());
        }
        error[r] = sum.max(1.0) * (16.0 * f64::from(f32::EPSILON));
    }
    let mut corners = [[0.0; 4]; 8];
    for (bits, out) in corners.iter_mut().enumerate() {
        let p = [
            if bits & 1 == 0 { lo[0] } else { hi[0] },
            if bits & 2 == 0 { lo[1] } else { hi[1] },
            if bits & 4 == 0 { lo[2] } else { hi[2] },
            1.0,
        ];
        for r in 0..4 {
            out[r] = (0..4).map(|c| m[c][r] * p[c]).sum();
        }
    }
    // All six homogeneous planes, conservatively relaxed for f32 arithmetic.
    for axis in 0..3 {
        for sign in [-1.0, 1.0] {
            if corners
                .iter()
                .all(|p| p[3] + sign * p[axis] < -(error[3] + error[axis]))
            {
                return Ok(None);
            }
        }
    }
    let near_error = error[2] + error[3];
    let distance = |p: [f64; 4]| p[2] + p[3] + near_error;
    let mut points = [[0.0; 4]; 20];
    let mut count = 0;
    for p in corners {
        if distance(p) >= 0.0 {
            points[count] = p;
            count += 1;
        }
    }
    for a in 0..8 {
        for bit in [1, 2, 4] {
            if a & bit != 0 {
                continue;
            }
            let b = a | bit;
            let (da, db) = (distance(corners[a]), distance(corners[b]));
            if (da >= 0.0) != (db >= 0.0) {
                let t = da / (da - db);
                for k in 0..4 {
                    points[count][k] = corners[a][k] + t * (corners[b][k] - corners[a][k]);
                }
                count += 1;
            }
        }
    }
    if count == 0 {
        return Ok(None);
    }
    let mut result = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for p in &points[..count] {
        if p[3] - error[3] <= 1e-5 {
            return Err(());
        }
        for k in 0..2 {
            for numerator in [p[k] - error[k], p[k] + error[k]] {
                for denominator in [p[3] - error[3], p[3] + error[3]] {
                    let uv = (numerator / denominator) * 0.5 + 0.5;
                    if !uv.is_finite() {
                        return Err(());
                    }
                    result[k] = result[k].min(uv);
                    result[k + 2] = result[k + 2].max(uv);
                }
            }
        }
    }
    for v in &mut result {
        *v = v.clamp(0.0, 1.0);
    }
    // A six-plane AABB test is only a broad phase. After near clipping a
    // surviving box can lie wholly beyond a side plane; clamping then gives
    // zero area on that viewport edge, not a covered boundary pixel.
    if result[2] <= result[0] || result[3] <= result[1] {
        return Ok(None);
    }
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec4;
    fn perspective() -> Mat4 {
        glam::camera::rh::proj::opengl::perspective(1.0, 1.5, 0.25, 100000.0)
    }
    fn bounds(min: [f32; 3], max: [f32; 3]) -> WetBounds {
        WetBounds {
            min: Vec3::from(min),
            max: Vec3::from(max),
            ripple: 0.6,
            puddle_gain: 1.0,
        }
    }
    fn region(vp: Mat4, readers: impl IntoIterator<Item = WetBounds>) -> ReflectionRegion {
        ReflectionRegion::calculate(vp, [160, 106], [160, 106], [80, 53], readers)
    }
    fn contains(rect: Rect, x: i32, y: i32) -> bool {
        x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
    }
    fn rects(r: ReflectionRegion, mirror: [i32; 2], down: [i32; 2]) -> (Rect, Rect) {
        match r {
            ReflectionRegion::Empty => panic!("expected a read footprint"),
            ReflectionRegion::Full => (
                Rect::from_edges([0, 0], mirror),
                Rect::from_edges([0, 0], down),
            ),
            ReflectionRegion::Scissor { mirror, down } => (mirror, down),
        }
    }
    #[test]
    fn empty_and_all_six_frustum_planes_reject_boxes() {
        assert_eq!(region(perspective(), []), ReflectionRegion::Empty);
        for (lo, hi) in [
            ([100., 0., -2.], [101., 1., -1.]),
            ([-101., 0., -2.], [-100., 1., -1.]),
            ([0., 100., -2.], [1., 101., -1.]),
            ([0., -101., -2.], [1., -100., -1.]),
            ([0., 0., 1.], [1., 1., 2.]),
        ] {
            assert_eq!(
                region(perspective(), [bounds(lo, hi)]),
                ReflectionRegion::Empty,
                "{lo:?}"
            );
        }
        let short_far = glam::camera::rh::proj::opengl::perspective(1.0, 1.5, 0.25, 10.0);
        assert_eq!(
            region(short_far, [bounds([0., 0., -12.], [1., 1., -11.])]),
            ReflectionRegion::Empty
        );
    }
    #[test]
    fn native_gl_bottom_left_is_not_the_cg_texture_y_flip() {
        let bottom = region(
            perspective(),
            [bounds([-0.2, -1.2, -4.], [0.2, -0.8, -3.8])],
        );
        let top = region(perspective(), [bounds([-0.2, 0.8, -4.], [0.2, 1.2, -3.8])]);
        let (bottom, _) = rects(bottom, [160, 106], [80, 53]);
        let (top, _) = rects(top, [160, 106], [80, 53]);
        assert!(bottom.y + bottom.height < 53);
        assert!(top.y > 53);
    }
    #[test]
    fn clips_near_crossing_edges_instead_of_dropping_behind_corners() {
        let input = bounds([0.03, -0.3, -0.6], [0.07, -0.2, 0.1]);
        let vp = perspective();
        let r = region(vp, [input]);
        assert!(matches!(r, ReflectionRegion::Scissor { .. }), "{r:?}");
        let m = vp.to_cols_array_2d().map(|c| c.map(f64::from));
        let projected = projected_bounds(&m, input.min, input.max).unwrap().unwrap();
        // The max X occurs on the new near-plane edge, not a kept original
        // corner. Check it directly using the shader's f32 matrix transform.
        let near = vp * Vec4::new(0.07, -0.2, -0.25, 1.0);
        let u = f64::from(near.x / near.w * 0.5 + 0.5);
        assert!(projected[2] >= u);
        let kept_corner = vp * Vec4::new(0.07, -0.2, -0.6, 1.0);
        assert!(u > f64::from(kept_corner.x / kept_corner.w * 0.5 + 0.5) + 0.08);
    }
    #[test]
    fn near_crossing_ground_below_the_viewport_does_not_create_an_edge_read() {
        let vp = perspective()
            * glam::camera::rh::view::look_at_mat4(
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(0.0, 4.0, -1.0),
                Vec3::Y,
            );
        assert_eq!(
            region(vp, [bounds([-100.0, 0.0, -100.0], [100.0, 0.0, 100.0])]),
            ReflectionRegion::Empty
        );
    }
    #[test]
    fn camera_inside_box_and_fullscreen_are_conservative() {
        assert_eq!(
            region(perspective(), [bounds([-10., -10., -2.], [10., 10., 2.])]),
            ReflectionRegion::Full
        );
        assert_eq!(
            region(perspective(), [bounds([-10., -10., -2.], [10., 10., -1.])]),
            ReflectionRegion::Full
        );
    }
    #[test]
    fn invalid_and_ill_conditioned_inputs_fall_back_without_elision() {
        for input in [
            bounds([f32::NAN, 0., -1.], [1., 1., -1.]),
            bounds([1., 0., -1.], [0., 1., -1.]),
            WetBounds {
                ripple: f32::INFINITY,
                ..bounds([0., 0., -1.], [1., 1., -1.])
            },
            WetBounds {
                puddle_gain: -0.1,
                ..bounds([0., 0., -1.], [1., 1., -1.])
            },
        ] {
            assert_eq!(region(perspective(), [input]), ReflectionRegion::Full);
        }
        let input = bounds([0., 0., 0.], [1., 1., 0.]);
        assert_eq!(region(Mat4::ZERO, [input]), ReflectionRegion::Full);
        assert_eq!(
            ReflectionRegion::calculate(Mat4::IDENTITY, [0, 106], [160, 106], [80, 53], [input]),
            ReflectionRegion::Full
        );
        let huge = bounds([-1e38, -1., -1.], [1e38, 1., 1.]);
        assert_eq!(region(perspective(), [huge]), ReflectionRegion::Full);
    }
    fn random(seed: &mut u32) -> f32 {
        *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (*seed >> 8) as f32 / 16777216.0
    }
    #[test]
    fn randomized_projected_aabb_contains_f32_vertex_transforms() {
        let mut seed = 0x904218au32;
        let vp = perspective()
            * glam::camera::rh::view::look_at_mat4(
                Vec3::new(1.1, 0.8, 2.3),
                Vec3::new(-0.4, 0.2, -3.),
                Vec3::Y,
            );
        let matrix = vp.to_cols_array_2d().map(|c| c.map(f64::from));
        let mut checked = 0;
        for _ in 0..2048 {
            let center = Vec3::new(
                random(&mut seed) * 16. - 8.,
                random(&mut seed) * 12. - 6.,
                random(&mut seed) * 24. - 20.,
            );
            let extent = Vec3::new(
                random(&mut seed) * 4. + 0.001,
                random(&mut seed) * 4. + 0.001,
                random(&mut seed) * 4. + 0.001,
            );
            let min = center - extent;
            let max = center + extent;
            let projected = projected_bounds(&matrix, min, max);
            for i in 0..64 {
                let t = if i < 8 {
                    Vec3::new((i & 1) as f32, ((i >> 1) & 1) as f32, ((i >> 2) & 1) as f32)
                } else {
                    Vec3::new(random(&mut seed), random(&mut seed), random(&mut seed))
                };
                let p = vp * (min + (max - min) * t).extend(1.0);
                if p.w <= 0. || p.x.abs() > p.w || p.y.abs() > p.w || p.z.abs() > p.w {
                    continue;
                }
                checked += 1;
                if let Ok(result) = projected {
                    let result = result.expect("a visible f32 point must not be rejected");
                    let uv = [
                        (p.x / p.w * 0.5 + 0.5) as f64,
                        (p.y / p.w * 0.5 + 0.5) as f64,
                    ];
                    assert!(
                        (0..2).all(|k| uv[k] >= result[k] - 1e-7 && uv[k] <= result[k + 2] + 1e-7),
                        "{uv:?} outside {result:?}"
                    );
                }
            }
        }
        assert!(checked > 10000);
    }
    fn texels(u: f64, n: i32) -> [i32; 2] {
        let i = libm::floor(u * f64::from(n) - 0.5) as i32;
        [i.clamp(0, n - 1), (i + 1).clamp(0, n - 1)]
    }
    fn check_source_tap(rect: Rect, uv: [f64; 2], size: [i32; 2]) {
        for y in texels(uv[1], size[1]) {
            for x in texels(uv[0], size[0]) {
                assert!(contains(rect, x, y), "tap {x},{y} outside {rect:?}");
            }
        }
    }
    #[test]
    fn guard_covers_perturbation_bilinear_and_all_five_down_taps() {
        for (response, mirror, down) in [
            ([160, 106], [160, 106], [80, 53]),
            ([159, 105], [161, 107], [80, 53]),
            ([480, 320], [160, 106], [80, 53]),
        ] {
            for x in [0, 1, response[0] / 3, response[0] - 2, response[0] - 1] {
                for y in [0, 1, response[1] / 3, response[1] - 2, response[1] - 1] {
                    let uv = [
                        (f64::from(x) + 0.5) / f64::from(response[0]),
                        (f64::from(y) + 0.5) / f64::from(response[1]),
                    ];
                    let p = [(uv[0] * 2. - 1.) as f32, (uv[1] * 2. - 1.) as f32, 0.];
                    let input = bounds(p, p);
                    let r = ReflectionRegion::calculate(
                        Mat4::IDENTITY,
                        response,
                        mirror,
                        down,
                        [input],
                    );
                    let (sharp_rect, down_rect) = rects(r, mirror, down);
                    for ox in [-1., 0., 1.] {
                        for oy in [-1., 0., 1.] {
                            // Shader perturb extrema, plus half a mirror texel of
                            // extra UV error. Production reserves >= one texel.
                            let sample = [
                                uv[0] + ox * (0.006 + 0.5 / f64::from(mirror[0])),
                                uv[1] + oy * (0.006 + 0.5 / f64::from(mirror[1])),
                            ];
                            check_source_tap(sharp_rect, sample, mirror);
                            for by in texels(sample[1], down[1]) {
                                for bx in texels(sample[0], down[0]) {
                                    assert!(contains(down_rect, bx, by));
                                    for (dx, dy) in
                                        [(0., 0.), (-1., -1.), (1., 1.), (-1., 1.), (1., -1.)]
                                    {
                                        let source = [
                                            (f64::from(bx) + 0.5) / f64::from(down[0])
                                                + dx / f64::from(mirror[0]),
                                            (f64::from(by) + 0.5) / f64::from(down[1])
                                                + dy / f64::from(mirror[1]),
                                        ];
                                        check_source_tap(sharp_rect, source, mirror);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn union_down_rectangle_has_no_unrendered_source_holes() {
        let inputs = [
            bounds([-0.8, -0.6, 0.], [-0.7, -0.5, 0.]),
            bounds([0.6, 0.5, 0.], [0.8, 0.6, 0.]),
        ];
        let (mirror, down) = rects(region(Mat4::IDENTITY, inputs), [160, 106], [80, 53]);
        for y in down.y..down.y + down.height {
            for x in down.x..down.x + down.width {
                for (dx, dy) in [(0., 0.), (-1., -1.), (1., 1.), (-1., 1.), (1., -1.)] {
                    check_source_tap(
                        mirror,
                        [
                            (f64::from(x) + 0.5) / 80. + dx / 160.,
                            (f64::from(y) + 0.5) / 53. + dy / 106.,
                        ],
                        [160, 106],
                    );
                }
            }
        }
    }
}
