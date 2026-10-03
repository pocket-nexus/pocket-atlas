//! Concatenation is valid only inside one cooked vertex page. Visibility and
//! LOD are resolved before this test; a gap is never filled with hidden geometry.
use pocket3d_place::Draw;

pub fn shared_page(a: &Draw, b: &Draw) -> bool {
    a.material == b.material
        && a.layout == b.layout
        && a.node.is_none()
        && b.node.is_none()
        && a.skin.is_none()
        && b.skin.is_none()
        && a.vertices.offset == b.vertices.offset
        && a.vertices.size == b.vertices.size
        && a.vertex_count == b.vertex_count
        && a.pos_offset == b.pos_offset
        && a.pos_scale == b.pos_scale
        && a.uv_offset == b.uv_offset
        && a.uv_scale == b.uv_scale
}
pub fn compatible(a: &Draw, b: &Draw, offset: u32, count: u32, next: u32, more: u32) -> bool {
    shared_page(a, b)
        && count.checked_mul(2).and_then(|n| offset.checked_add(n)) == Some(next)
        && count
            .checked_add(more)
            .is_some_and(|n| n <= i32::MAX as u32)
}

/// A shared display haze uniform adds at most one display-byte of error to
/// (1-T)*H+T*C when H,T,C are all in [0,1]. Callers must exclude emission and
/// reflection additions that can make C exceed one. Upload the decoded key,
/// never the first source draw's unquantized value.
pub fn quantize_haze(value: [f32; 4]) -> Option<[u8; 4]> {
    if !value
        .iter()
        .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
    {
        return None;
    }
    // Error is affine in the surface channel C, so its extrema on [0,1]
    // are at C=0 and C=1. Reserve four f32 epsilons for the arithmetic below;
    // this is stricter than the one-byte bound on the decoded uniform.
    const LIMIT: f32 = 1.0 / 255.0 - 4.0 * f32::EPSILON;
    let within = |channel: usize, color: u8, transmittance: u8| {
        let h = color as f32 / 255.0;
        let t = transmittance as f32 / 255.0;
        let offset = (1.0 - t) * h - (1.0 - value[3]) * value[channel];
        let slope = t - value[3];
        offset.abs().max((offset + slope).abs()) <= LIMIT
    };
    // Nearly transparent haze may share one key regardless of sky azimuth.
    // Merely rounding T to a byte would retain irrelevant H differences.
    if (0..3).all(|k| within(k, 0, 255)) {
        return Some([0, 0, 0, 255]);
    }
    let t = (value[3] * 255.0 + 0.5) as u8;
    let mut key = [0, 0, 0, t];
    for k in 0..3 {
        // H is attenuated by (1-T), so a coarser canonical color can often
        // satisfy the same bound. T keeps its nearest byte. Never use another
        // draw's color: every source must pass against this decoded key.
        key[k] = [1, 2, 4, 8, 16, 32, 64, 128, 255]
            .into_iter()
            .find_map(|steps| {
                let cell = (value[k] * steps as f32 + 0.5) as u32;
                let color = ((cell * 255 + steps / 2) / steps) as u8;
                within(k, color, t).then_some(color)
            })?;
    }
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draw() -> Draw {
        serde_json::from_str(r#"{"material":0,"layout":"baked","vertices":{"offset":0,"size":168},"vertex_count":6,"indices":{"offset":168,"size":6},"index_count":3,"pos_offset":[0,0,0],"pos_scale":[1,1,1],"uv_offset":[0,0],"uv_scale":[1,1],"min":[0,0,0],"max":[1,1,1],"node":null,"skin":null,"no_reflect":false,"cast_shadow":true}"#).unwrap()
    }
    #[test]
    fn contiguous_visible_ranges_join_but_culled_or_lod_gaps_do_not() {
        let a = draw();
        let b = a.clone();
        assert!(compatible(&a, &b, 168, 3, 174, 3));
        assert!(!compatible(&a, &b, 168, 3, 180, 3));
        assert!(!compatible(&a, &b, u32::MAX - 1, 3, 4, 3));
    }
    #[test]
    fn shared_bytes_do_not_imply_shared_transform_or_material() {
        let a = draw();
        let mut b = a.clone();
        b.pos_offset[0] = 1.0;
        assert!(!compatible(&a, &b, 168, 3, 174, 3));
        let mut b = a.clone();
        b.uv_scale[0] = 2.0;
        assert!(!compatible(&a, &b, 168, 3, 174, 3));
        let mut b = a.clone();
        b.material = 1;
        assert!(!compatible(&a, &b, 168, 3, 174, 3));
        let mut b = a.clone();
        b.node = Some(0);
        assert!(!compatible(&a, &b, 168, 3, 174, 3));
    }
    fn assert_haze_bound(value: [f32; 4]) {
        let Some(key) = quantize_haze(value) else {
            return;
        };
        // Evaluate in f64 using the actual f32 uniform values uploaded by the
        // renderer. This does not repeat the helper's f32 acceptance test.
        let q = key.map(|v| (v as f32 / 255.0) as f64);
        let v = value.map(f64::from);
        for k in 0..3 {
            for c in [0.0, 1.0] {
                let original = (1.0 - v[3]) * v[k] + v[3] * c;
                let canonical = (1.0 - q[3]) * q[k] + q[3] * c;
                assert!(
                    (canonical - original).abs() <= 1.0 / 255.0,
                    "haze {value:?}, key {key:?}, channel {k}, surface {c}"
                );
            }
        }
    }
    #[test]
    fn haze_canonicalization_removes_irrelevant_color_without_discarding_visible_haze() {
        assert_eq!(quantize_haze([0.1, 0.6, 0.9, 1.0]), Some([0, 0, 0, 255]));
        assert_eq!(quantize_haze([0.1, 0.6, 0.9, 0.999]), Some([0, 0, 0, 255]));
        // T near one alone is insufficient: the C=1 endpoint still needs fog.
        assert_ne!(quantize_haze([0.0, 0.0, 0.0, 0.995]), Some([0, 0, 0, 255]));
        let a = [0.60, 0.62, 0.64, 0.99];
        let b = [0.61, 0.63, 0.65, 0.99];
        assert_eq!(quantize_haze(a), quantize_haze(b));
        assert_eq!(quantize_haze(a).unwrap()[3], (a[3] * 255.0 + 0.5) as u8);
        assert_haze_bound(a);
        assert_haze_bound(b);
    }
    #[test]
    fn haze_canonicalization_bounds_independent_channels_and_byte_boundaries() {
        // Exercise both sides of byte rounding boundaries, including endpoints,
        // with independently bright/dark channels and nearly clear haze.
        for byte in 0..=255 {
            for delta in [-0.5001, -0.5, -0.4999, 0.0, 0.4999, 0.5, 0.5001] {
                let t = ((byte as f32 + delta) / 255.0).clamp(0.0, 1.0);
                for h in [0.0, 0.125, 0.25, 0.5, 0.75, 0.875, 1.0] {
                    assert_haze_bound([h, 1.0 - h, 0.0, t]);
                    assert_haze_bound([h, 1.0, 1.0 - h, t]);
                }
            }
        }
        let mut seed = 0x51a5_4a7bu32;
        let mut random = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed >> 8) as f32 / 16_777_215.0
        };
        for _ in 0..262_144 {
            let value = core::array::from_fn(|_| random());
            assert_haze_bound(value);
            assert_haze_bound([value[0], value[1], value[2], 0.98 + value[3] * 0.02]);
        }
    }
    #[test]
    fn haze_batching_has_a_bounded_display_error_and_rejects_hdr_values() {
        for hi in 0..31 {
            for ti in 0..37 {
                let h = hi as f32 / 30.0;
                let t = ti as f32 / 36.0;
                let q = quantize_haze([h, h, h, t])
                    .unwrap()
                    .map(|v| v as f32 / 255.0);
                // Linear in C: checking both extrema bounds every C in [0,1].
                for c in [0.0, 1.0] {
                    let a = (1.0 - t) * h + t * c;
                    let b = (1.0 - q[3]) * q[0] + q[3] * c;
                    assert!((a - b).abs() <= 1.0 / 255.0 + 1e-6);
                }
            }
        }
        assert!(quantize_haze([1.01, 0.0, 0.0, 1.0]).is_none());
        assert!(quantize_haze([0.0, 0.0, 0.0, f32::NAN]).is_none());
    }
}
