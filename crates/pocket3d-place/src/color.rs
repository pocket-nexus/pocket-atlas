//! Shared scene-linear to display colour transform for handheld backends.

/// three.js ACESFilmicToneMapping (exposure applied by the caller), linear out.
fn aces(c: [f32; 3]) -> [f32; 3] {
    let x = c.map(|v| v / 0.6);
    // Column vectors, as the GLSL mat3 constructors.
    let input = [
        [0.59719, 0.07600, 0.02840],
        [0.35458, 0.90834, 0.13383],
        [0.04823, 0.01566, 0.83777],
    ];
    let output = [
        [1.60475, -0.10208, -0.00327],
        [-0.53108, 1.10813, -0.07276],
        [-0.07367, -0.00605, 1.07602],
    ];
    let mul = |m: [[f32; 3]; 3], v: [f32; 3]| -> [f32; 3] {
        std::array::from_fn(|j| m[0][j] * v[0] + m[1][j] * v[1] + m[2][j] * v[2])
    };
    let v = mul(input, x)
        .map(|v| (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081));
    mul(output, v).map(|v| v.clamp(0.0, 1.0))
}

/// The place's tone curve (AgX or ACES, as three.js) followed by its grade
/// (the web's grade effect: contrast, saturation, lift, gain) and sRGB
/// encoding, for one scene-linear colour.
pub fn tone(c: [f32; 3], post: &crate::Post) -> [f32; 3] {
    let c = c.map(|v| v * post.exposure);
    let v = if post.tone == crate::ToneCurve::Aces {
        aces(c)
    } else {
        agx(c)
    };
    let v = v.map(|x| 0.18 * (x.max(0.0) / 0.18).powf(post.contrast));
    let l = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    let smooth = |a: f32, b: f32, x: f32| {
        let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let (sh, hi) = (1.0 - smooth(0.0, 0.35, l), smooth(0.35, 1.0, l));
    std::array::from_fn(|k| {
        let x = (l + (v[k] - l) * post.saturation + post.lift[k] * sh * 0.04)
            * (1.0 + (post.gain[k] - 1.0) * hi);
        let x = x.clamp(0.0, 1.0);
        if x < 0.0031308 {
            x * 12.92
        } else {
            1.055 * x.powf(1.0 / 2.4) - 0.055
        }
    })
}

/// AgX (as three.js), display-linear out.
fn agx(c: [f32; 3]) -> [f32; 3] {
    let mul = |v: [f32; 3], m: [[f32; 3]; 3]| -> [f32; 3] {
        std::array::from_fn(|j| v[0] * m[0][j] + v[1] * m[1][j] + v[2] * m[2][j])
    };
    let to2020 = [
        [0.6274, 0.0691, 0.0164],
        [0.3293, 0.9195, 0.0880],
        [0.0433, 0.0113, 0.8956],
    ];
    let inset = [
        [0.856627153315983, 0.137318972929847, 0.11189821299995],
        [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
        [0.0482516061458583, 0.101439036467562, 0.811302368396859],
    ];
    let outset = [
        [
            1.1271005818144368,
            -0.1413297634984383,
            -0.14132976349843826,
        ],
        [
            -0.11060664309660323,
            1.157823702216272,
            -0.11060664309660294,
        ],
        [
            -0.016493938717834573,
            -0.016493938717834257,
            1.2519364065950405,
        ],
    ];
    let to_srgb = [
        [1.6605, -0.1246, -0.0182],
        [-0.5876, 1.1329, -0.1006],
        [-0.0728, -0.0083, 1.1187],
    ];
    let mut v = mul(mul(c, to2020), inset);
    for x in &mut v {
        let l = ((x.max(1e-10).log2() + 12.47393) / 16.5).clamp(0.0, 1.0);
        let (x2, x4) = (l * l, l * l * l * l);
        *x = 15.5 * x4 * x2 - 40.14 * x4 * l + 31.96 * x4 - 6.868 * x2 * l
            + 0.4298 * x2
            + 0.1191 * l
            - 0.00232;
    }
    v = mul(v, outset).map(|x| x.max(0.0).powf(2.2));
    mul(v, to_srgb).map(|x| x.clamp(0.0, 1.0))
}
