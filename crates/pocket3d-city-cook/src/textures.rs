//! Texture cooking: power-of-two resize, gamma-correct mip chains and block
//! compression. Output rows (or 4×4 block rows) are linear; the runtime
//! swizzles on upload with the GPU's transfer engine.

use pocket3d_city::{TexFormat, TexRole};
use rayon::prelude::*;

pub struct Rgba {
    pub w: u32,
    pub h: u32,
    pub px: Vec<[f32; 4]>,
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// Decodes 8-bit RGBA into floats; colour roles are converted to linear.
pub fn from_rgba8(w: u32, h: u32, data: &[u8], role: TexRole) -> Rgba {
    let srgb = role == TexRole::Color;
    let px = data
        .chunks_exact(4)
        .map(|p| {
            let f = |v: u8| v as f32 / 255.0;
            if srgb {
                [srgb_to_linear(f(p[0])), srgb_to_linear(f(p[1])), srgb_to_linear(f(p[2])), f(p[3])]
            } else {
                [f(p[0]), f(p[1]), f(p[2]), f(p[3])]
            }
        })
        .collect();
    Rgba { w, h, px }
}

/// Area-average resample to (w, h). Used for both power-of-two fitting and mips.
pub fn resize(src: &Rgba, w: u32, h: u32) -> Rgba {
    if src.w == w && src.h == h {
        return Rgba { w, h, px: src.px.clone() };
    }
    let sx = src.w as f32 / w as f32;
    let sy = src.h as f32 / h as f32;
    let px: Vec<[f32; 4]> = (0..h)
        .into_par_iter()
        .flat_map_iter(|y| {
            let src = &src;
            (0..w).map(move |x| {
                // Box filter over the source footprint (bilinear when upscaling).
                let x0 = x as f32 * sx;
                let y0 = y as f32 * sy;
                if sx <= 1.0 && sy <= 1.0 {
                    let fx = (x0 + 0.5 * sx - 0.5).max(0.0);
                    let fy = (y0 + 0.5 * sy - 0.5).max(0.0);
                    let ix = (fx as u32).min(src.w - 1);
                    let iy = (fy as u32).min(src.h - 1);
                    let jx = (ix + 1).min(src.w - 1);
                    let jy = (iy + 1).min(src.h - 1);
                    let tx = fx - ix as f32;
                    let ty = fy - iy as f32;
                    let p = |a: u32, b: u32| src.px[(b * src.w + a) as usize];
                    let mut o = [0.0; 4];
                    for c in 0..4 {
                        let top = p(ix, iy)[c] * (1.0 - tx) + p(jx, iy)[c] * tx;
                        let bot = p(ix, jy)[c] * (1.0 - tx) + p(jx, jy)[c] * tx;
                        o[c] = top * (1.0 - ty) + bot * ty;
                    }
                    return o;
                }
                let xa = x0.floor() as u32;
                let ya = y0.floor() as u32;
                let xb = ((x0 + sx).ceil() as u32).min(src.w).max(xa + 1);
                let yb = ((y0 + sy).ceil() as u32).min(src.h).max(ya + 1);
                let mut o = [0.0f32; 4];
                let mut n = 0.0;
                for yy in ya..yb {
                    for xx in xa..xb {
                        let p = src.px[(yy * src.w + xx) as usize];
                        // Premultiply so transparent texels do not bleed colour.
                        let a = p[3].max(1e-4);
                        o[0] += p[0] * a;
                        o[1] += p[1] * a;
                        o[2] += p[2] * a;
                        o[3] += a;
                        n += 1.0;
                    }
                }
                let a = o[3];
                [o[0] / a, o[1] / a, o[2] / a, a / n]
            })
        })
        .collect();
    Rgba { w, h, px }
}

fn renormalize(img: &mut Rgba) {
    for p in &mut img.px {
        let x = p[0] * 2.0 - 1.0;
        let y = p[1] * 2.0 - 1.0;
        let z = (p[2] * 2.0 - 1.0).max(0.0);
        let l = (x * x + y * y + z * z).sqrt().max(1e-5);
        p[0] = x / l * 0.5 + 0.5;
        p[1] = y / l * 0.5 + 0.5;
        p[2] = z / l * 0.5 + 0.5;
    }
}

fn to_bytes(img: &Rgba, role: TexRole) -> Vec<u8> {
    let srgb = role == TexRole::Color;
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    img.px
        .iter()
        .flat_map(|p| {
            if srgb {
                [q(linear_to_srgb(p[0])), q(linear_to_srgb(p[1])), q(linear_to_srgb(p[2])), q(p[3])]
            } else {
                [q(p[0]), q(p[1]), q(p[2]), q(p[3])]
            }
        })
        .collect()
}

pub fn pow2_fit(w: u32, h: u32, cap: u32) -> (u32, u32) {
    let f = |v: u32| {
        let p = v.next_power_of_two();
        // Prefer rounding down when the source is closer to the lower power.
        let p = if p > v && (p - v) > v - p / 2 { p / 2 } else { p };
        p.clamp(4, cap)
    };
    (f(w), f(h))
}

pub struct Encoded {
    pub format: TexFormat,
    pub width: u32,
    pub height: u32,
    pub mips: u32,
    pub data: Vec<u8>,
}

/// Picks the block format for a role and encodes the full mip chain.
pub fn encode(src: &Rgba, role: TexRole, cap: u32, alpha: bool) -> Encoded {
    let format = match role {
        TexRole::Normal => TexFormat::Bc5,
        _ if alpha => TexFormat::Bc3,
        _ => TexFormat::Bc1,
    };
    encode_as(src, role, format, cap, 12)
}

/// Encodes `src` in `format` with at most `max_mips` levels (down to 4×4).
pub fn encode_as(src: &Rgba, role: TexRole, format: TexFormat, cap: u32, max_mips: u32) -> Encoded {
    let (w, h) = pow2_fit(src.w, src.h, cap);
    let mut level = resize(src, w, h);
    if role == TexRole::Normal {
        renormalize(&mut level);
    }
    let mut data = Vec::new();
    let mut mips = 0;
    loop {
        data.extend(compress(&level, role, format));
        mips += 1;
        if (level.w <= 4 && level.h <= 4) || mips >= max_mips {
            break;
        }
        let nw = (level.w / 2).max(4);
        let nh = (level.h / 2).max(4);
        level = resize(&level, nw, nh);
        if role == TexRole::Normal {
            renormalize(&mut level);
        }
    }
    Encoded { format, width: w, height: h, mips, data }
}

fn compress(level: &Rgba, role: TexRole, format: TexFormat) -> Vec<u8> {
    let bytes = to_bytes(level, role);
    let (w, h) = (level.w as usize, level.h as usize);
    match format {
        TexFormat::Bc1 | TexFormat::Bc3 => {
            let fmt = if format == TexFormat::Bc1 { texpresso::Format::Bc1 } else { texpresso::Format::Bc3 };
            let mut out = vec![0u8; fmt.compressed_size(w, h)];
            let params = texpresso::Params { algorithm: texpresso::Algorithm::ClusterFit, ..Default::default() };
            fmt.compress(&bytes, w, h, params, &mut out);
            out
        }
        TexFormat::Bc5 => {
            // Two BC4 channels: R = normal X, G = normal Y.
            let mut rg = vec![0u8; w * h * 4];
            for i in 0..w * h {
                rg[i * 4] = bytes[i * 4];
                rg[i * 4 + 1] = bytes[i * 4 + 1];
                rg[i * 4 + 3] = 255;
            }
            let fmt = texpresso::Format::Bc5;
            let mut out = vec![0u8; fmt.compressed_size(w, h)];
            fmt.compress(&rg, w, h, texpresso::Params::default(), &mut out);
            out
        }
        TexFormat::Rgba8 => bytes,
        TexFormat::Rgba16f => unreachable!(),
    }
}
