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
    fn short_arrays_take_defaults() {
        assert_eq!(arr(&json!([3]), [1.0, 2.0]), [3.0, 2.0]);
        assert_eq!(arr(&Value::Null, [1.0, 2.0]), [1.0, 2.0]);
    }
}
