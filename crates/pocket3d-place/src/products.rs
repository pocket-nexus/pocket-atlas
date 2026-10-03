//! Once-per-instance inputs to the shared Products packaging shader.
//!
//! This follows surface_v.cg's byte recovery, polynomial sRGB approximation,
//! dot-product coefficients and GLSL `fract` rule. CPU and GPU sine precision
//! can choose different atlas designs; this is not a pixel-equivalence claim.

fn fraction(value: f32) -> f32 {
    value - num_traits::Float::floor(value)
}

/// Return the atlas horizontal seed and integral band in `[0, 8)`. Input is
/// the stored RGB seed, before any display grading or material multiplication.
/// Uses the crate's portable Float backend; exact values can still depend on
/// the enabled math backend and differ from GPU sine precision.
pub fn package_params(color: [u8; 3]) -> [f32; 2] {
    let c = color.map(|v| {
        let s = v as f32 / 255.0;
        s * (s * (s * 0.305306011 + 0.682171111) + 0.012522878)
    });
    let seed = (c[0] * 12.9898 + c[1] * 78.233) + c[2] * 37.719;
    let hash = |phase: f32| fraction(num_traits::Float::sin(phase) * 43758.5453);
    let horizontal = hash((seed * 0.37 + 1.0) * 12.9898);
    let band = num_traits::Float::floor(hash((seed * 0.71 + 7.0) * 12.9898) * 8.0);
    [horizontal, band]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fraction_follows_glsl_for_negative_sines() {
        assert_eq!(fraction(-1.25), 0.75);
        assert_eq!(fraction(-2.0), 0.0);
        assert_eq!(fraction(1.25), 0.25);
        assert_ne!(fraction(-1.25), (-1.25f32).fract().abs());
    }
    #[test]
    fn all_seed_channels_and_atlas_boundaries_stay_finite() {
        for channel in 0..3 {
            for value in 0..=255 {
                for background in [0, 1, 127, 128, 254, 255] {
                    let mut color = [background; 3];
                    color[channel] = value;
                    let [horizontal, band] = package_params(color);
                    assert!(horizontal >= 0.0 && horizontal < 1.0);
                    assert!(band >= 0.0 && band < 8.0 && band == band.floor());
                    for uv in [0.0, 1.0] {
                        let atlas = [
                            horizontal * 0.93 + uv * 0.055,
                            (band + 0.08 + uv * 0.8) / 8.0,
                        ];
                        assert!(atlas.into_iter().all(|v| v >= 0.0 && v < 1.0));
                    }
                }
            }
        }
    }
}
