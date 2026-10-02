//! Readers for the `extras.pocketAtlas` annotations of a place export (see
//! README: Signage, Dusk places, Daytime places, Water).

use pocket3d_place as pc;
use serde_json::Value;

/// A number, or `d` when absent.
pub fn f(v: &Value, k: &str, d: f32) -> f32 {
    v.get(k).and_then(|x| x.as_f64()).map(|x| x as f32).unwrap_or(d)
}

/// The first `N` numbers of an array; missing ones from `d`.
pub fn arr<const N: usize>(v: &Value, d: [f32; N]) -> [f32; N] {
    let a = v.as_array();
    core::array::from_fn(|i| a.and_then(|a| a.get(i)).and_then(|x| x.as_f64()).map_or(d[i], |x| x as f32))
}

/// Three numbers (a colour or a vector), 0 where missing.
pub fn v3(v: &Value) -> [f32; 3] {
    arr(v, [0.0; 3])
}

/// A material's animated coordinates: a flipbook (`frames`, `cols`, `rows`,
/// `fps`) and/or a `scroll`, shifted by `phase` seconds.
pub fn uv_anim(x: &Value) -> Option<pc::UvAnim> {
    let frames = f(x, "frames", 1.0).max(1.0) as u32;
    let scroll = x.get("scroll").map(|s| arr(s, [0.0; 2])).unwrap_or([0.0; 2]);
    (frames > 1 || scroll != [0.0; 2]).then(|| pc::UvAnim {
        cols: f(x, "cols", frames as f32).max(1.0) as u32,
        rows: f(x, "rows", 1.0).max(1.0) as u32,
        frames,
        fps: f(x, "fps", 8.0),
        scroll,
        phase: f(x, "phase", 0.0),
    })
}

/// Open water (`kind: "water"`): `waves` and `body` are required.
pub fn water(x: &Value, material: &str) -> pc::Water {
    let waves = x.get("waves").and_then(|w| w.as_array()).filter(|w| w.len() == 2).unwrap_or_else(|| panic!("water material {material}: `waves` needs two layers"));
    let body = x.get("body").unwrap_or_else(|| panic!("water material {material}: no `body`"));
    pc::Water {
        waves: [arr(&waves[0], [0.0; 3]), arr(&waves[1], [0.0; 3])],
        body: v3(body),
        distance_roughness: f(x, "distanceRoughness", 0.0),
        shallow: x.get("shallow").filter(|v| v.is_array()).map(v3),
        mask: f(x, "mask", 0.0),
    }
}

/// A light field's sprite range, gain and depth pull (`kind: "lights"`, the
/// web's defaults); `period` from the material's `loop` (s), else
/// `fallback` (the place's recorded loop).
pub fn light_field(x: &Value, fallback: f32) -> pc::LightField {
    let min_pixels = f(x, "minPixels", 2.0).max(0.0);
    pc::LightField {
        min_pixels,
        max_pixels: f(x, "maxPixels", 16.0).max(min_pixels),
        gain: f(x, "gain", 1.0),
        depth_pull: f(x, "depthPull", 0.012).max(0.0),
        period: f(x, "loop", fallback).max(1e-3),
    }
}

/// One light of a field: `p` and `color` from POSITION and COLOR_0, the
/// rest from the custom attributes `_LIGHT` (intensity, radius, phase,
/// twinkle), `_PATH` (dx, dy, dz, cycles) and `_BLINK` (cycles, duty), each
/// optional (missing: no light, no motion, always on).
pub fn light_point(p: [f32; 3], color: [f32; 3], light: Option<&[f32]>, path: Option<&[f32]>, blink: Option<&[f32]>) -> pc::LightPoint {
    let at = |v: Option<&[f32]>, i: usize, d: f32| v.and_then(|v| v.get(i)).copied().unwrap_or(d);
    pc::LightPoint {
        position: p,
        color,
        intensity: at(light, 0, 0.0),
        radius: at(light, 1, 0.0),
        phase: at(light, 2, 0.0),
        twinkle: at(light, 3, 0.0),
        path: [at(path, 0, 0.0), at(path, 1, 0.0), at(path, 2, 0.0)],
        path_cycles: at(path, 3, 0.0),
        blink_cycles: at(blink, 0, 0.0),
        duty: if blink.is_some() { at(blink, 1, 1.0) } else { 1.0 },
    }
}

/// An interior window's `tint` (linear RGB, three numbers); None when
/// absent or malformed (white).
pub fn tint(x: &Value) -> Option<[f32; 3]> {
    x.get("tint").and_then(|t| t.as_array()).filter(|a| a.len() >= 3 && a.iter().take(3).all(|v| v.is_number())).map(|_| v3(&x["tint"]))
}

/// Shaded emission retains a web material's normal/height modulation.
pub fn emission_shade(x: &Value) -> Option<pc::EmissionShade> {
    let value = x.get("emissionShade")?;
    let shade: pc::EmissionShade = serde_json::from_value(value.clone()).expect("invalid emissionShade");
    assert!(shade.normal.iter().chain(&shade.height).all(|v| v.is_finite()) && shade.height[0] < shade.height[1], "invalid emissionShade range");
    Some(shade)
}

/// A material's `lodBias`: a number (mip levels, clamped to −3..1), or
/// `"auto"` (None: measured from the texture's mapping).
pub fn lod_bias(x: &Value) -> Option<Option<f32>> {
    match x.get("lodBias")? {
        Value::String(s) if s == "auto" => Some(None),
        v => v.as_f64().map(|b| Some((b as f32).clamp(-3.0, 1.0))),
    }
}

/// The vista haze (scene `haze` with an `inversion`); `None` for the night
/// streets' lit haze, which shares the key. `band` (the weight of the sky's
/// sun-side terms in the inscatter) is 1, the dome, when absent.
pub fn vista_haze(h: &Value) -> Option<pc::VistaHaze> {
    h.get("inversion")?.as_f64()?;
    Some(pc::VistaHaze {
        density: f(h, "density", 0.0),
        inversion: f(h, "inversion", 0.0),
        scale: f(h, "scale", 100.0).max(1e-3),
        gain: f(h, "gain", 1.0),
        glow: v3(&h["glow"]),
        band: f(h, "band", 1.0),
    })
}

/// The twilight terms of a day sky (`sky.twilight`).
pub fn twilight(t: &Value) -> pc::Twilight {
    let (b, l, s) = (&t["band"], &t["belt"], &t["shadow"]);
    pc::Twilight {
        band: pc::TwilightBand { color: v3(&b["color"]), height: f(b, "height", 0.075), sun_bias: f(b, "sunBias", 0.0), sun_power: f(b, "sunPower", 1.0) },
        belt: pc::TwilightBelt { color: v3(&l["color"]), elevation: f(l, "elevation", 0.14), width: f(l, "width", 0.09), power: f(l, "power", 1.0) },
        shadow: pc::TwilightShadow { strength: f(s, "strength", 0.0), height: f(s, "height", 0.07), power: f(s, "power", 1.0) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shaded_emission_annotation() {
        assert!(emission_shade(&json!({})).is_none());
        let shade = emission_shade(&json!({"emissionShade": {"normal": [0.12, 0.4, 0, 0.6], "height": [0.05, 1.45, 0.62, 1]}})).unwrap();
        assert_eq!(shade.normal, [0.12, 0.4, 0.0, 0.6]);
        assert_eq!(shade.height, [0.05, 1.45, 0.62, 1.0]);
    }

    #[test]
    #[should_panic(expected = "invalid emissionShade range")]
    fn shaded_emission_rejects_empty_height_range() {
        emission_shade(&json!({"emissionShade": {"normal": [0, 0, 0, 1], "height": [1, 1, 0, 1]}}));
    }

    #[test]
    fn sign_flipbook_and_scroll() {
        let a = uv_anim(&json!({"kind": "sign", "frames": 32, "cols": 1, "rows": 32, "fps": 6, "scroll": [0.1], "phase": 2})).unwrap();
        assert_eq!((a.cols, a.rows, a.frames, a.fps, a.scroll, a.phase), (1, 32, 32, 6.0, [0.1, 0.0], 2.0));
        assert!(uv_anim(&json!({"kind": "sign"})).is_none());
        assert_eq!(uv_anim(&json!({"frames": 4})).unwrap().cols, 4);
    }

    #[test]
    fn water_fields() {
        let w = water(&json!({"kind": "water", "waves": [[0.02, 0.35, 1.15], [0.11, -0.75, 0.55]], "body": [0.001, 0.05, 0.09], "shallow": [0.005, 0.09, 0.1], "mask": 0.14, "distanceRoughness": 1.2e-5}), "sea");
        assert_eq!(w.waves[1], [0.11, -0.75, 0.55]);
        assert_eq!(w.shallow, Some([0.005, 0.09, 0.1]));
        assert_eq!(w.mask, 0.14);
    }

    #[test]
    #[should_panic(expected = "two layers")]
    fn water_needs_waves() {
        water(&json!({"body": [0, 0, 0]}), "sea");
    }

    #[test]
    fn light_field_and_points() {
        let x = json!({"kind": "lights", "minPixels": 1.5, "maxPixels": 12, "gain": 0.8});
        let l = light_field(&x, 120.0);
        assert_eq!((l.min_pixels, l.max_pixels, l.gain, l.period, l.depth_pull), (1.5, 12.0, 0.8, 120.0, 0.012));
        assert_eq!(light_field(&json!({"loop": 60, "minPixels": 3, "maxPixels": 1}), 120.0).max_pixels, 3.0);
        let p = light_point([1.0, 2.0, 3.0], [1.0, 0.5, 0.1], Some(&[40.0, 0.2, 0.25, 0.6]), Some(&[0.0, 0.0, -900.0, 2.0]), None);
        assert_eq!((p.intensity, p.radius, p.phase, p.twinkle), (40.0, 0.2, 0.25, 0.6));
        assert_eq!((p.path, p.path_cycles, p.blink_cycles, p.duty), ([0.0, 0.0, -900.0], 2.0, 0.0, 1.0));
        let b = light_point([0.0; 3], [1.0, 0.0, 0.0], None, None, Some(&[40.0, 0.1]));
        assert_eq!((b.blink_cycles, b.duty, b.intensity), (40.0, 0.1, 0.0));
    }

    #[test]
    fn interior_tint() {
        let x = json!({"kind": "interiorWindow", "intensity": 2.4, "tint": [1.0, 0.78, 0.36]});
        assert_eq!(tint(&x), Some([1.0, 0.78, 0.36]));
        // Places without one (the konbini, Akihabara) stay white.
        assert_eq!(tint(&json!({"kind": "interiorWindow", "intensity": 1.4})), None);
        assert_eq!(tint(&json!({"tint": [1, 0.5]})), None);
        assert_eq!(tint(&json!({"tint": "warm"})), None);
    }

    #[test]
    fn lod_bias_number_or_auto() {
        assert_eq!(lod_bias(&json!({"lodBias": "auto"})), Some(None));
        assert_eq!(lod_bias(&json!({"lodBias": -1.5})), Some(Some(-1.5)));
        assert_eq!(lod_bias(&json!({"lodBias": -9})), Some(Some(-3.0)));
        assert_eq!(lod_bias(&json!({"lodBias": "sharp"})), None);
        assert_eq!(lod_bias(&json!({})), None);
    }

    #[test]
    fn vista_haze_needs_an_inversion() {
        let h = vista_haze(&json!({"density": 1.6e-4, "inversion": -60, "scale": 60, "gain": 1.25, "band": 0.25, "glow": [0.0045, 0.003, 0.0035], "note": "…"})).unwrap();
        assert_eq!((h.density, h.inversion, h.scale, h.gain, h.band, h.glow), (1.6e-4, -60.0, 60.0, 1.25, 0.25, [0.0045, 0.003, 0.0035]));
        // Without `band`, the sky's sun-side terms keep their full weight.
        assert_eq!(vista_haze(&json!({"density": 1e-4, "inversion": 0})).unwrap().band, 1.0);
        // The night streets' lit haze shares the key.
        assert!(vista_haze(&json!({"density": 0.015, "ambient": [0.1, 0.1, 0.1]})).is_none());
        assert!(vista_haze(&Value::Null).is_none());
    }

    #[test]
    fn short_arrays_take_defaults() {
        assert_eq!(arr(&json!([3]), [1.0, 2.0]), [3.0, 2.0]);
        assert_eq!(arr(&Value::Null, [1.0, 2.0]), [1.0, 2.0]);
    }
}
