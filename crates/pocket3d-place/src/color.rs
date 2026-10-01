//! sRGB transfer functions shared by the cooker and the handheld.

/// Linear light → sRGB-encoded, both 0..1 (clamped).
pub fn encode(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

/// sRGB-encoded → linear light, both 0..1.
pub fn decode(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

/// Linear light → an sRGB-encoded byte.
pub fn encode8(v: f32) -> u8 {
    (encode(v) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        for i in 0..=255u32 {
            let v = i as f32 / 255.0;
            assert!((super::decode(super::encode(v)) - v).abs() < 1e-4);
        }
        assert_eq!(super::encode8(1.0), 255);
        assert_eq!(super::encode8(0.0), 0);
    }
}
