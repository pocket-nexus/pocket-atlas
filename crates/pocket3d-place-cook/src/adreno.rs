//! What an Adreno 305 under OpenGL ES 3 (the Redmi 1S, `android/`) is cooked
//! that the table's other readers are not. The table, the geometry and the
//! light are `pica.rs`'s; this module holds the parts that belong to this
//! GPU alone.
//!
//! **ETC2 texels.** The GPU reads ETC2 at the cost of RGB565 and has no S3TC,
//! so an opaque surface is 4 bits a texel instead of 16 and its cap is twice
//! the iPod's in the same memory. A block is coded the ETC1 way (two halves,
//! each a base colour and a table of four brightness steps) or as ETC2's
//! plane (three corner colours, every texel between them), whichever leaves
//! the smaller error: the plane is what keeps a gradient from showing its
//! blocks.
//!
//! **The sun's shadows from a depth map.** The other readers of the table
//! have the sun in their vertex colours, shadowed by a ray a vertex (PICA) or
//! not at all (the iPod touch). This GPU compares a fragment's depth with a
//! depth texture in one filtered fetch, so the renderer draws the place's
//! shadow map once, when it loads the place, and a sunlit surface is its lit
//! colour or its shaded one by that fetch. Both are cooked: the colour is
//! the surface in the sun, and its alpha, which such a surface has no other
//! use for, is the share of that colour left without the sun. The shaded
//! colour is cooler than the lit one as well as darker; one tint for the
//! place carries that (`Shade`, the `SUNL` section).
//!
//! **Relief in the texture.** A normal map is arithmetic in every fragment
//! on the Vita. Here its relief is lit once, by a light fixed over the
//! texture, and multiplied into the surface's texture (`relief`): a stone
//! wall keeps its joints at no cost to the frame.
use crate::textures::Rgba;
use glam::Vec3;
use pocket3d_place as pc;

/// Table format codes this target adds to `n3ds/src/format.h`'s 0, 3 and 4.
pub const FORMAT_ETC2_RGB: u32 = 5;
/// `PLCE` container version of this target's pack (`android/src/scene.c`).
pub const CONTAINER_VERSION: u32 = 0x201;
/// A material flag beside `n3ds/src/format.h`'s: the vertices' alpha is the
/// share of their colour left in the sun's shadow.
pub const MAT_SUN: u32 = 1024;

/// A lit, opaque surface whose vertex alpha is free to carry the shade.
pub fn takes_sun(mat: &pc::Material) -> bool {
    mat.kind == pc::Kind::Standard && !mat.interior && mat.blend == pc::Blend::Opaque && !(mat.vertex_color && mat.alpha_test > 0.0)
}

fn luminance(c: Vec3) -> f32 {
    c.dot(Vec3::new(0.2126, 0.7152, 0.0722))
}

/// What the place's sunlit vertices say about its shade: how many there are,
/// and how the shaded colour's hue differs from the lit one's.
#[derive(Default)]
pub struct Shade {
    count: u32,
    tint: Vec3,
    weight: f32,
}
impl Shade {
    /// The byte a vertex keeps in its alpha: the luminance of `shaded` over
    /// that of `lit`, both display-referred.
    pub fn share(&mut self, lit: Vec3, shaded: Vec3) -> u8 {
        let k = if luminance(lit) > 1e-4 { (luminance(shaded) / luminance(lit)).clamp(0.0, 1.0) } else { 1.0 };
        self.count += 1;
        // The tint is read where the sun matters and the colour is not clipped.
        if k < 0.8 && lit.min_element() > 0.02 && lit.max_element() < 0.98 {
            let weight = 1.0 - k;
            self.tint += shaded / (lit * k.max(1e-3)) * weight;
            self.weight += weight;
        }
        (k * 255.0 + 0.5) as u8
    }
    pub fn any(&self) -> bool {
        self.count > 0
    }
    /// `SUNL`, 76 bytes of little-endian floats: the direction towards the
    /// sun; the shadow camera's position; its left, right, bottom, top, near
    /// and far; its depth bias and normal bias in metres; the shade's tint;
    /// two zeros. A vertex in shadow is its colour times its share k times
    /// mix(tint, 1, k).
    pub fn section(&self, sun: &pc::Sun) -> Vec<u8> {
        let shadow = sun.shadow.as_ref().expect("a sunlit vertex without a shadow camera");
        let tint = if self.weight > 0.0 { (self.tint / self.weight).clamp(Vec3::splat(0.5), Vec3::splat(1.6)) } else { Vec3::ONE };
        let mut out = Vec::with_capacity(80);
        for v in Vec3::from(sun.direction).normalize().to_array().into_iter().chain(shadow.position).chain(shadow.ortho).chain([shadow.bias, shadow.normal_bias]).chain(tint.to_array()).chain([0.0, 0.0]) {
            out.extend(v.to_le_bytes());
        }
        out
    }
}

/// Multiplies a surface's texture by its normal map's relief, lit from the
/// upper left of the texture: a texel facing the light keeps its colour, one
/// turned away is darkened. `strength` is the material's normal scale.
pub fn relief(texture: &mut Rgba, normals: &Rgba, strength: f32) {
    // In tangent space: x along u, y against v (the map's green is up), z out of the surface.
    let light = Vec3::new(-0.42, 0.48, 0.77).normalize();
    for y in 0..texture.h {
        for x in 0..texture.w {
            let n = crate::pica::bilinear(normals, (x as f32 + 0.5) / texture.w as f32, (y as f32 + 0.5) / texture.h as f32);
            let n = Vec3::new((n[0] * 2.0 - 1.0) * strength, (n[1] * 2.0 - 1.0) * strength, (n[2] * 2.0 - 1.0).max(0.05)).normalize();
            let lit = (n.dot(light) / light.z).clamp(0.35, 1.0);
            let p = &mut texture.px[(y * texture.w + x) as usize];
            for c in &mut p[..3] {
                *c *= lit;
            }
        }
    }
}

const STEPS: [[i32; 4]; 8] = [
    [2, 8, -2, -8],
    [5, 17, -5, -17],
    [9, 29, -9, -29],
    [13, 42, -13, -42],
    [18, 60, -18, -60],
    [24, 80, -24, -80],
    [33, 106, -33, -106],
    [47, 183, -47, -183],
];

fn srgb8(x: f32) -> i32 {
    let x = x.clamp(0.0, 1.0);
    let v = if x <= 0.003_130_8 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
    (v * 255.0 + 0.5) as i32
}

/// The table and the step of each texel that bring `px` nearest to `base`.
fn half(px: &[[i32; 3]], base: [i32; 3]) -> (i64, usize, [usize; 8]) {
    let mut best = (i64::MAX, 0, [0; 8]);
    for (t, steps) in STEPS.iter().enumerate() {
        let mut total = 0i64;
        let mut picks = [0; 8];
        for (i, p) in px.iter().enumerate() {
            let mut least = i64::MAX;
            for (k, s) in steps.iter().enumerate() {
                let e: i64 = (0..3).map(|c| ((base[c] + s).clamp(0, 255) - p[c]) as i64).map(|d| d * d).sum();
                if e < least {
                    least = e;
                    picks[i] = k;
                }
            }
            total += least;
            if total >= best.0 {
                break;
            }
        }
        if total < best.0 {
            best = (total, t, picks);
        }
    }
    best
}

/// A block the ETC1 way: (error, the 8 bytes).
fn halves(px: &[[i32; 3]; 16]) -> (i64, [u8; 8]) {
    let mut best: (i64, [u8; 8]) = (i64::MAX, [0; 8]);
    for flip in 0..2 {
        // The texels of each half: left and right, or top and bottom.
        let ids: [Vec<usize>; 2] = [0, 1].map(|h| (0..16).filter(|k| (if flip == 0 { k % 4 } else { k / 4 }) / 2 == h).collect());
        let texels = |h: usize| -> Vec<[i32; 3]> { ids[h].iter().map(|&k| px[k]).collect() };
        let (t0, t1) = (texels(0), texels(1));
        let mean = |t: &[[i32; 3]]| -> [f32; 3] { [0, 1, 2].map(|c| t.iter().map(|p| p[c] as f32).sum::<f32>() / t.len() as f32) };
        let mut wanted = [mean(&t0), mean(&t1)];
        // Two rounds: the mean, then the base that centres the steps the first round picked.
        for round in 0..2 {
            let q5 = |m: [f32; 3]| m.map(|v| (v * 31.0 / 255.0).round().clamp(0.0, 31.0) as i32);
            let (a5, b5) = (q5(wanted[0]), q5(wanted[1]));
            // Five bits a channel with the second base within -4..3 of the first, or four bits each.
            let near = (0..3).all(|c| (-4..=3).contains(&(b5[c] - a5[c])));
            let (bases, head): ([[i32; 3]; 2], [u8; 3]) = if near {
                ([a5.map(|v| (v << 3) | (v >> 2)), b5.map(|v| (v << 3) | (v >> 2))], [0, 1, 2].map(|c| ((a5[c] << 3) | ((b5[c] - a5[c]) & 7)) as u8))
            } else {
                let q4 = |m: [f32; 3]| m.map(|v| (v * 15.0 / 255.0).round().clamp(0.0, 15.0) as i32);
                let (a4, b4) = (q4(wanted[0]), q4(wanted[1]));
                ([a4.map(|v| (v << 4) | v), b4.map(|v| (v << 4) | v)], [0, 1, 2].map(|c| ((a4[c] << 4) | b4[c]) as u8))
            };
            let (h0, h1) = (half(&t0, bases[0]), half(&t1, bases[1]));
            if h0.0 + h1.0 < best.0 {
                // A texel's step is two bits, kept in two words of sixteen: its place in them is x * 4 + y.
                let mut bits = 0u32;
                for (h, picks) in [(0, &h0.2), (1, &h1.2)] {
                    for (&k, &pick) in ids[h].iter().zip(picks) {
                        let at = (k % 4) * 4 + k / 4;
                        bits |= ((pick as u32 & 1) << at) | ((pick as u32 >> 1) << (16 + at));
                    }
                }
                let control = ((h0.1 as u8) << 5) | ((h1.1 as u8) << 2) | ((near as u8) << 1) | flip as u8;
                let b = bits.to_be_bytes();
                best = (h0.0 + h1.0, [head[0], head[1], head[2], control, b[0], b[1], b[2], b[3]]);
            }
            if round == 0 {
                for (h, (t, found)) in [(&t0, &h0), (&t1, &h1)].into_iter().enumerate() {
                    wanted[h] = [0, 1, 2].map(|c| t.iter().zip(found.2).map(|(p, k)| (p[c] - STEPS[found.1][k]) as f32).sum::<f32>() / t.len() as f32);
                }
            }
        }
    }
    best
}

/// A block as ETC2's plane: the colours at (0, 0), (4, 0) and (0, 4), in 6, 7
/// and 6 bits, fitted to the texels by least squares.
fn plane(px: &[[i32; 3]; 16]) -> (i64, [u8; 8]) {
    let mut corner = [[0i32; 3]; 3]; // origin, horizontal, vertical; red, green, blue as stored
    let mut wide = [[0i32; 3]; 3];
    for c in 0..3 {
        // c(x, y) = a + b x + d y over x, y in 0..4: sums of x and of y are 24, of x^2 56, of x y 36.
        let (mut s, mut sx, mut sy) = (0.0f32, 0.0f32, 0.0f32);
        for k in 0..16 {
            let v = px[k][c] as f32;
            s += v;
            sx += v * (k % 4) as f32;
            sy += v * (k / 4) as f32;
        }
        let b = (sx - 1.5 * s) / 20.0;
        let d = (sy - 1.5 * s) / 20.0;
        let a = s / 16.0 - 1.5 * (b + d);
        let bits = if c == 1 { 7 } else { 6 };
        for (i, v) in [a, a + 4.0 * b, a + 4.0 * d].into_iter().enumerate() {
            let q = (v.clamp(0.0, 255.0) * ((1 << bits) - 1) as f32 / 255.0).round() as i32;
            corner[i][c] = q;
            wide[i][c] = if bits == 7 { (q << 1) | (q >> 6) } else { (q << 2) | (q >> 4) };
        }
    }
    let mut error = 0i64;
    for k in 0..16 {
        let (x, y) = ((k % 4) as i32, (k / 4) as i32);
        for c in 0..3 {
            let v = ((x * (wide[1][c] - wide[0][c]) + y * (wide[2][c] - wide[0][c]) + 4 * wide[0][c] + 2) >> 2).clamp(0, 255);
            error += ((v - px[k][c]) as i64).pow(2);
        }
    }
    let ([ro, go, bo], [rh, gh, bh], [rv, gv, bv]) = (corner[0].map(|v| v as u64), corner[1].map(|v| v as u64), corner[2].map(|v| v as u64));
    // The 57 bits sit in a block whose blue "overflows" as a differential
    // ETC1 block would read it, which is how a decoder knows the plane.
    let mut word = ro << 57 | (go >> 6) << 56 | (go & 63) << 49 | (bo >> 5) << 48 | ((bo >> 3) & 3) << 43 | (bo & 7) << 39
        | (rh >> 1) << 34 | 1 << 33 | (rh & 1) << 32 | gh << 25 | bh << 19 | rv << 13 | gv << 6 | bv;
    // Red and green must not overflow: the spare bit above each is the opposite of the bit below it.
    word |= (!(word >> 62) & 1) << 63;
    word |= (!(word >> 54) & 1) << 55;
    // Blue must: read as five bits and a signed three, it has to leave 0..31.
    let over = ((bo >> 3) & 3) + ((bo >> 1) & 3) >= 4;
    if over {
        word |= 7 << 45;
    } else {
        word |= 1 << 42;
    }
    (error, word.to_be_bytes())
}

fn block(px: &[[i32; 3]; 16]) -> [u8; 8] {
    let etc1 = halves(px);
    if etc1.0 == 0 {
        return etc1.1;
    }
    let flat = plane(px);
    if flat.0 < etc1.0 { flat.1 } else { etc1.1 }
}

/// A picture as `GL_COMPRESSED_RGB8_ETC2`: blocks in rows from the picture's
/// first row. `img` is scene-linear; the texels are display-referred, as
/// every other format of the table. Sides are multiples of four.
pub fn etc2_rgb(img: &Rgba) -> Vec<u8> {
    let (w, h) = (img.w as usize, img.h as usize);
    assert!(w % 4 == 0 && h % 4 == 0, "ETC2 picture {w} x {h}");
    let bytes: Vec<[i32; 3]> = img.px.iter().map(|p| [srgb8(p[0]), srgb8(p[1]), srgb8(p[2])]).collect();
    let mut out = Vec::with_capacity(w * h / 2);
    for by in (0..h).step_by(4) {
        for bx in (0..w).step_by(4) {
            let px: [[i32; 3]; 16] = core::array::from_fn(|k| bytes[(by + k / 4) * w + bx + k % 4]);
            out.extend(block(&px));
        }
    }
    out
}

/// What a block decodes to, `out[y * 4 + x]`: the two block kinds this module writes.
#[cfg(test)]
pub(crate) fn decode(b: &[u8; 8]) -> [[i32; 3]; 16] {
    let word = u64::from_be_bytes(*b);
    let diff = b[3] & 2 != 0;
    let signed = |v: u8| ((v as i32 & 7) << 29) >> 29;
    if diff {
        let sums = [0, 1, 2].map(|c| (b[c] >> 3) as i32 + signed(b[c]));
        assert!((0..32).contains(&sums[0]) && (0..32).contains(&sums[1]), "T and H blocks are not written");
        if !(0..32).contains(&sums[2]) {
            let f = |at: u32, n: u32| ((word >> at) & ((1 << n) - 1)) as i32;
            let six = |v: i32| (v << 2) | (v >> 4);
            let seven = |v: i32| (v << 1) | (v >> 6);
            let o = [six(f(57, 6)), seven(f(56, 1) << 6 | f(49, 6)), six(f(48, 1) << 5 | f(43, 2) << 3 | f(39, 3))];
            let hz = [six(f(34, 5) << 1 | f(32, 1)), seven(f(25, 7)), six(f(19, 6))];
            let v = [six(f(13, 6)), seven(f(6, 7)), six(f(0, 6))];
            return core::array::from_fn(|k| {
                let (x, y) = ((k % 4) as i32, (k / 4) as i32);
                [0, 1, 2].map(|c| ((x * (hz[c] - o[c]) + y * (v[c] - o[c]) + 4 * o[c] + 2) >> 2).clamp(0, 255))
            });
        }
    }
    let flip = b[3] & 1;
    let tables = [(b[3] >> 5) as usize, ((b[3] >> 2) & 7) as usize];
    let bases: [[i32; 3]; 2] = if diff {
        let a = [0, 1, 2].map(|c| (b[c] >> 3) as i32);
        [a.map(|v| (v << 3) | (v >> 2)), [0, 1, 2].map(|c| a[c] + signed(b[c])).map(|v| (v << 3) | (v >> 2))]
    } else {
        [[0, 1, 2].map(|c| (b[c] >> 4) as i32).map(|v| (v << 4) | v), [0, 1, 2].map(|c| (b[c] & 15) as i32).map(|v| (v << 4) | v)]
    };
    let bits = word as u32;
    core::array::from_fn(|k| {
        let (x, y) = (k % 4, k / 4);
        let h = (if flip == 0 { x } else { y }) / 2;
        let at = x * 4 + y;
        let pick = ((bits >> at) & 1) | (((bits >> (16 + at)) & 1) << 1);
        bases[h].map(|v| (v + STEPS[tables[h]][pick as usize]).clamp(0, 255))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worst(a: &[[i32; 3]; 16], b: &[[i32; 3]; 16]) -> i32 {
        (0..16).flat_map(|k| (0..3).map(move |c| (k, c))).map(|(k, c)| (a[k][c] - b[k][c]).abs()).max().unwrap()
    }

    #[test]
    fn two_flat_halves_come_back_as_they_went_in() {
        let px: [[i32; 3]; 16] = core::array::from_fn(|k| if k / 4 < 2 { [200, 40, 40] } else { [30, 90, 160] });
        let b = block(&px);
        assert!(worst(&decode(&b), &px) <= 8);
    }

    #[test]
    fn a_gradient_is_coded_as_a_plane_and_stays_smooth() {
        // A sky: each channel its own slope across and down the block.
        let px: [[i32; 3]; 16] = core::array::from_fn(|k| {
            let (x, y) = ((k % 4) as i32, (k / 4) as i32);
            [40 + 6 * x + 3 * y, 90 + 2 * x + 9 * y, 200 - 5 * x - 4 * y]
        });
        let b = block(&px);
        // Blue overflows as a differential block reads it; red and green do not.
        let signed = |v: u8| ((v as i32 & 7) << 29) >> 29;
        let sums = [0, 1, 2].map(|c| (b[c] >> 3) as i32 + signed(b[c]));
        assert!(b[3] & 2 != 0 && (0..32).contains(&sums[0]) && (0..32).contains(&sums[1]) && !(0..32).contains(&sums[2]));
        assert!(worst(&decode(&b), &px) <= 4, "{:?}", decode(&b));
        // The same ramp the ETC1 way steps by its table: the plane is the smaller error.
        assert!(plane(&px).0 < halves(&px).0);
    }

    #[test]
    fn every_blue_corner_overflows() {
        // All 64 blue origins, with the other fields at their extremes.
        for bo in 0..64 {
            for fill in [0u8, 255] {
                let px: [[i32; 3]; 16] = core::array::from_fn(|k| [fill as i32, fill as i32, (bo * 4 + (k as i32 % 4) * 3).min(255)]);
                let b = plane(&px).1;
                let signed = |v: u8| ((v as i32 & 7) << 29) >> 29;
                let sums = [0, 1, 2].map(|c| (b[c] >> 3) as i32 + signed(b[c]));
                assert!((0..32).contains(&sums[0]) && (0..32).contains(&sums[1]) && !(0..32).contains(&sums[2]), "blue {bo}: {sums:?}");
                assert!(b[3] & 2 != 0);
            }
        }
    }

    #[test]
    fn a_picture_is_half_a_byte_a_texel_in_row_order() {
        let img = Rgba { w: 8, h: 4, px: (0..32).map(|i| if i % 8 < 4 { [1.0, 0.0, 0.0, 1.0] } else { [0.0, 0.0, 1.0, 1.0] }).collect() };
        let out = etc2_rgb(&img);
        assert_eq!(out.len(), 16);
        let (left, right) = (decode(out[..8].try_into().unwrap()), decode(out[8..].try_into().unwrap()));
        assert!(left[0][0] > 240 && left[0][2] < 16 && right[0][2] > 240 && right[0][0] < 16);
    }
}
