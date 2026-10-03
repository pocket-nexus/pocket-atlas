//! Conservative overlap of shadow casters and receivers in sun space.
//! No scene, renderer or platform dependencies: `rustc --test` can test this
//! module directly. The rows map world positions to shadow (u, v, depth),
//! with depth increasing away from the light.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SunBounds {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

const DEPTH_EPSILON: f64 = 1.0e-5;
const PCF_RADIUS_TEXELS: f64 = 1.5;

fn valid(bounds: &SunBounds) -> bool {
    (0..3).all(|axis| bounds.min[axis].is_finite() && bounds.max[axis].is_finite() && bounds.min[axis] <= bounds.max[axis])
}

fn unbounded() -> SunBounds {
    SunBounds { min: [f32::NEG_INFINITY; 3], max: [f32::INFINITY; 3] }
}

fn lower(value: f64) -> f32 {
    let rounded = value as f32;
    if (rounded as f64) > value { rounded.next_down() } else { rounded }
}

fn upper(value: f64) -> f32 {
    let rounded = value as f32;
    if (rounded as f64) < value { rounded.next_up() } else { rounded }
}

/// Projects a world AABB, expanded by `world_padding` on every world axis.
/// For an affine row, the exact projected radius is the sum of its absolute
/// coefficients times the box's half extents. Intermediates use f64 and the
/// stored f32 endpoints round outward so cancellation cannot shrink the box.
/// Invalid input fails open by returning an unbounded box.
pub fn project(rows: &[[f32; 4]; 3], lo: [f32; 3], hi: [f32; 3], world_padding: f32) -> SunBounds {
    if !valid(&SunBounds { min: lo, max: hi }) || !world_padding.is_finite() || world_padding < 0.0 || !rows.iter().flatten().all(|v| v.is_finite()) {
        return unbounded();
    }
    let center: [f64; 3] = std::array::from_fn(|axis| (lo[axis] as f64 + hi[axis] as f64) * 0.5);
    let extent: [f64; 3] = std::array::from_fn(|axis| (hi[axis] as f64 - lo[axis] as f64) * 0.5 + world_padding as f64);
    let mut result = SunBounds { min: [0.0; 3], max: [0.0; 3] };
    for (axis, row) in rows.iter().enumerate() {
        let mut c = row[3] as f64;
        let mut radius = 0.0;
        for k in 0..3 {
            c += row[k] as f64 * center[k];
            radius += (row[k] as f64).abs() * extent[k];
        }
        result.min[axis] = lower(c - radius);
        result.max[axis] = upper(c + radius);
    }
    result
}

/// Whether a caster could shadow any part of a receiver.
/// Expand both UV intervals by 1.5 texels, retaining PCF and rounding edges.
/// Receiver depth must reach at least the nearest caster depth: a receiver
/// wholly in front of a caster cannot be shadowed by it. This is deliberately
/// only a rejection test; overlap is not proof that shadowing occurs.
pub fn may_receive(receiver: &SunBounds, caster: &SunBounds, texel: f32) -> bool {
    if !valid(receiver) || !valid(caster) || !texel.is_finite() || texel < 0.0 {
        return true;
    }
    let pad = PCF_RADIUS_TEXELS * texel as f64;
    for axis in 0..2 {
        if receiver.max[axis] as f64 + pad < caster.min[axis] as f64 - pad
            || caster.max[axis] as f64 + pad < receiver.min[axis] as f64 - pad
        {
            return false;
        }
    }
    receiver.max[2] as f64 + DEPTH_EPSILON >= caster.min[2] as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sun overhead, then inclined along (3, 4, 0). UV basis vectors are
    // perpendicular to each direction; the depth rows point away from it.
    const PROJECTIONS: [[[f32; 4]; 3]; 2] = [
        [[0.125, 0.0, 0.0, 0.5], [0.0, 0.0, 0.125, 0.5], [0.0, -0.02, 0.0, 0.5]],
        [[0.1, -0.075, 0.0, 0.5], [0.0, 0.0, 0.125, 0.5], [-0.012, -0.016, 0.0, 0.5]],
    ];

    fn corners(rows: &[[f32; 4]; 3], lo: [f32; 3], hi: [f32; 3], padding: f32) -> ([f64; 3], [f64; 3]) {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for corner in 0..8 {
            let p: [f64; 3] = std::array::from_fn(|axis| {
                if corner & (1 << axis) == 0 { lo[axis] as f64 - padding as f64 } else { hi[axis] as f64 + padding as f64 }
            });
            for (axis, row) in rows.iter().enumerate() {
                let value = row[3] as f64 + (0..3).map(|k| row[k] as f64 * p[k]).sum::<f64>();
                min[axis] = min[axis].min(value);
                max[axis] = max[axis].max(value);
            }
        }
        (min, max)
    }

    #[test]
    fn affine_bounds_enclose_all_eight_corners_for_two_sun_directions() {
        for rows in PROJECTIONS {
            for (lo, hi) in [([-3.7, -1.3, -5.2], [2.1, 7.9, 4.8]), ([10391.3, -7281.4, 309.4], [10391.7, -7280.2, 311.8])] {
                for padding in [0.0, 0.25, 1.3] {
                    let bounds = project(&rows, lo, hi, padding);
                    let (reference_min, reference_max) = corners(&rows, lo, hi, padding);
                    for axis in 0..3 {
                        assert!(bounds.min[axis] as f64 <= reference_min[axis], "min {axis}: {bounds:?}, {reference_min:?}");
                        assert!(bounds.max[axis] as f64 >= reference_max[axis], "max {axis}: {bounds:?}, {reference_max:?}");
                        let slack = (reference_min[axis].abs().max(reference_max[axis].abs()) + 1.0) * f32::EPSILON as f64 * 2.0;
                        assert!(reference_min[axis] - bounds.min[axis] as f64 <= slack);
                        assert!(bounds.max[axis] as f64 - reference_max[axis] <= slack);
                    }
                }
            }
        }
    }

    #[test]
    fn padding_is_expanded_in_world_axes_before_projection() {
        let rows = [[2.0, -3.0, 4.0, 10.0], [-0.5, 0.0, 0.0, 1.0], [0.0, 1.0, 0.0, 0.0]];
        let bounds = project(&rows, [0.0; 3], [0.0; 3], 0.5);
        assert_eq!(bounds, SunBounds { min: [5.5, 0.75, -0.5], max: [14.5, 1.25, 0.5] });
    }

    #[test]
    fn disjoint_world_boxes_aligned_along_light_must_be_kept() {
        let receiver_lo = [-0.5; 3];
        let receiver_hi = [0.5; 3];
        for (rows, caster_center) in PROJECTIONS.into_iter().zip([[0.0, 10.0, 0.0], [6.0, 8.0, 0.0]]) {
            let caster_lo = caster_center.map(|v| v - 0.5);
            let caster_hi = caster_center.map(|v| v + 0.5);
            assert!(caster_lo[1] > receiver_hi[1]);
            let receiver = project(&rows, receiver_lo, receiver_hi, 0.0);
            let caster = project(&rows, caster_lo, caster_hi, 0.0);
            assert!(may_receive(&receiver, &caster, 1.0 / 512.0));
            assert!(!may_receive(&caster, &receiver, 1.0 / 512.0), "a box wholly toward the sun cannot receive this shadow");
        }
    }

    #[test]
    fn pcf_edges_on_both_sides_and_axes_are_retained() {
        let caster = SunBounds { min: [0.4, 0.4, 0.3], max: [0.6, 0.6, 0.4] };
        for axis in 0..2 {
            for sign in [-1.0, 1.0] {
                let mut receiver = SunBounds { min: [0.45, 0.45, 0.5], max: [0.55, 0.55, 0.6] };
                if sign < 0.0 { receiver.min[axis] = 0.35; receiver.max[axis] = 0.371; }
                else { receiver.min[axis] = 0.629; receiver.max[axis] = 0.65; }
                assert!(!may_receive(&receiver, &caster, 0.0));
                assert!(may_receive(&receiver, &caster, 0.01), "keep the conservative two-sided PCF fringe");
            }
        }
    }

    #[test]
    fn genuinely_separated_projections_and_front_receivers_are_rejected() {
        let caster = SunBounds { min: [0.4, 0.4, 0.3], max: [0.6, 0.6, 0.4] };
        for axis in 0..2 {
            let mut receiver = SunBounds { min: [0.45, 0.45, 0.5], max: [0.55, 0.55, 0.6] };
            receiver.min[axis] = 0.64; receiver.max[axis] = 0.7;
            assert!(!may_receive(&receiver, &caster, 0.01));
        }
        let mut receiver = caster;
        receiver.min[2] = 0.1; receiver.max[2] = 0.3 - 2.0e-5;
        assert!(!may_receive(&receiver, &caster, 0.01));
        receiver.max[2] = 0.3 - 0.5e-5;
        assert!(may_receive(&receiver, &caster, 0.01), "preserve near-equal depths within epsilon");
    }

    #[test]
    fn invalid_inputs_fail_open_instead_of_erasing_shadows() {
        let bounds = SunBounds { min: [0.0; 3], max: [1.0; 3] };
        for bad in [f32::NAN, f32::INFINITY, -1.0] {
            assert!(may_receive(&bounds, &bounds, bad));
            let projected = project(&PROJECTIONS[0], bounds.min, bounds.max, bad);
            assert!(may_receive(&projected, &bounds, 0.0));
        }
        assert!(may_receive(&SunBounds { min: [1.0; 3], max: [0.0; 3] }, &bounds, 0.0));
        let mut rows = PROJECTIONS[0]; rows[0][0] = f32::NAN;
        assert!(may_receive(&project(&rows, bounds.min, bounds.max, 0.0), &bounds, 0.0));
    }
}
