//! SGX display-environment recipe math, shared by the compiler and legacy
//! startup fallback. Average linear source radiance, grade once, then reproject
//! the bounded octahedral map into ES2 cube faces; never grade HDR encoding.
use alloc::{
    string::{String, ToString},
    vec::Vec,
};
#[cfg(not(feature = "std"))]
use num_traits::Float;

pub fn post_hash(post: &crate::Post) -> Result<String, String> {
    let bytes = serde_json::to_vec(post).map_err(|e| e.to_string())?;
    Ok(alloc::format!("{:016x}", crate::content_hash::hash(&bytes)))
}

/// Bind both bytes and the interpretation used by this target recipe. Range
/// offsets and labels do not affect pixels; dimensions/format/role/mips do.
pub fn source_hash(texture: &crate::Texture, data: &[u8]) -> Result<String, String> {
    let interpretation = serde_json::to_vec(&(
        texture.format,
        texture.width,
        texture.height,
        texture.mips,
        texture.role,
    ))
    .map_err(|e| e.to_string())?;
    let mut hash = crate::content_hash::Fnv1a64::default();
    hash.update(&interpretation);
    hash.update(data);
    Ok(alloc::format!("{:016x}", hash.finish()))
}

fn half_float(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = (h >> 10) & 31;
    let m = h & 1023;
    if e == 0 {
        sign * m as f32 * f32::from_bits(103 << 23) // 2^-24, exact.
    } else {
        sign * (1.0 + m as f32 / 1024.0) * f32::from_bits((e as u32 + 112) << 23)
    }
}

/// Average source radiance before grading. Reusing the encoded HDR texture
/// would grade sqrt-compressed values; averaging display bytes would also bias
/// bright texels. This unchanged graded oct map is the cube prototype's input.
pub fn oct_pixels(
    texture: &crate::Texture,
    data: &[u8],
    strength: f32,
    post: &crate::Post,
) -> Result<(u32, u32, Vec<u8>), String> {
    if !strength.is_finite() || strength < 0.0 {
        return Err("invalid display environment strength".into());
    }
    let post_values = [
        post.exposure,
        post.contrast,
        post.saturation,
        post.lift[0],
        post.lift[1],
        post.lift[2],
        post.gain[0],
        post.gain[1],
        post.gain[2],
    ];
    if post_values.iter().any(|v| !v.is_finite()) {
        return Err("non-finite display environment grade".into());
    }
    let stride = match texture.format {
        crate::TexFormat::Rgba16f => 8,
        crate::TexFormat::Rgba8 => 4,
        _ => return Err("unsupported display environment format".into()),
    };
    let (sw, sh) = (texture.width as usize, texture.height as usize);
    let size = sw.checked_mul(sh).and_then(|n| n.checked_mul(stride));
    if sw == 0 || sh == 0 || size.is_none_or(|n| n > data.len()) {
        return Err("display environment source range".into());
    }
    if stride == 8
        && data[..size.unwrap()]
            .chunks_exact(2)
            .any(|b| u16::from_le_bytes([b[0], b[1]]) & 0x7c00 == 0x7c00)
    {
        return Err("non-finite display environment radiance".into());
    }
    let divisor = sw.max(sh).div_ceil(64).max(1);
    let (w, h) = (sw.div_ceil(divisor), sh.div_ceil(divisor));
    let mut pixels = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        let (y0, y1) = (
            y as f32 * sh as f32 / h as f32,
            (y + 1) as f32 * sh as f32 / h as f32,
        );
        for x in 0..w {
            let (x0, x1) = (
                x as f32 * sw as f32 / w as f32,
                (x + 1) as f32 * sw as f32 / w as f32,
            );
            let mut rgb = [0.0; 3];
            for sy in y0 as usize..(y1.ceil() as usize).min(sh) {
                let wy = (y1.min((sy + 1) as f32) - y0.max(sy as f32)).max(0.0);
                for sx in x0 as usize..(x1.ceil() as usize).min(sw) {
                    let weight = wy * (x1.min((sx + 1) as f32) - x0.max(sx as f32)).max(0.0);
                    let at = (sy * sw + sx) * stride;
                    for c in 0..3 {
                        let value = if stride == 8 {
                            half_float(u16::from_le_bytes([data[at + c * 2], data[at + c * 2 + 1]]))
                        } else {
                            data[at + c] as f32 / 255.0
                        };
                        rgb[c] += value.max(0.0) * weight;
                    }
                }
            }
            let area = (x1 - x0) * (y1 - y0);
            let display = crate::color::tone(rgb.map(|v| v / area * strength), post);
            if display.iter().any(|v| !v.is_finite()) {
                return Err("non-finite display environment result".into());
            }
            pixels.extend(display.map(|v| (v * 255.0 + 0.5) as u8));
            pixels.push(255);
        }
    }
    Ok((w as u32, h as u32, pixels))
}

pub const FACE_SIZE: u32 = 64;
pub const CUBE_BYTES: usize = 6 * FACE_SIZE as usize * FACE_SIZE as usize * 4;

// OpenGL ES 2.0.25 section 3.7.5, table 3.11. The order matches
// GL_TEXTURE_CUBE_MAP_POSITIVE_X + face. Rows increase with texture t.
fn direction(face: usize, s: f32, t: f32) -> [f32; 3] {
    let (s, t) = (s * 2.0 - 1.0, t * 2.0 - 1.0);
    match face {
        0 => [1.0, -t, -s],
        1 => [-1.0, -t, s],
        2 => [s, 1.0, t],
        3 => [s, -1.0, -t],
        4 => [s, -t, 1.0],
        5 => [-s, -t, -1.0],
        _ => unreachable!(),
    }
}

fn oct_uv(d: [f32; 3]) -> [f32; 2] {
    let sum = d[0].abs() + d[1].abs() + d[2].abs();
    let mut p = [d[0] / sum, d[2] / sum];
    if d[1] < 0.0 {
        p = [
            (1.0 - p[1].abs()) * if p[0] >= 0.0 { 1.0 } else { -1.0 },
            (1.0 - p[0].abs()) * if p[1] >= 0.0 { 1.0 } else { -1.0 },
        ];
    }
    p.map(|v| v * 0.5 + 0.5)
}

// Match the previous level-zero GL_LINEAR / CLAMP_TO_EDGE display texture.
fn sample(width: u32, height: u32, pixels: &[u8], uv: [f32; 2]) -> [f32; 4] {
    let x = (uv[0] * width as f32 - 0.5).clamp(0.0, width as f32 - 1.0);
    let y = (uv[1] * height as f32 - 0.5).clamp(0.0, height as f32 - 1.0);
    let (x0, y0) = (x as u32, y as u32);
    let (x1, y1) = ((x0 + 1).min(width - 1), (y0 + 1).min(height - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    core::array::from_fn(|c| {
        let get = |x: u32, y: u32| pixels[((y * width + x) * 4) as usize + c] as f32;
        let a = get(x0, y0) * (1.0 - fx) + get(x1, y0) * fx;
        let b = get(x0, y1) * (1.0 - fx) + get(x1, y1) * fx;
        a * (1.0 - fy) + b * fy
    })
}

pub fn cube_faces(width: u32, height: u32, pixels: &[u8]) -> Result<[Vec<u8>; 6], String> {
    if width == 0
        || height == 0
        || width > 64
        || height > 64
        || pixels.len() != width as usize * height as usize * 4
    {
        return Err("display cube expects a complete graded oct map of at most 64x64".into());
    }
    let mut faces: [Vec<u8>; 6] = core::array::from_fn(|_| Vec::new());
    for (face, data) in faces.iter_mut().enumerate() {
        data.try_reserve_exact(CUBE_BYTES / 6)
            .map_err(|_| "display cube allocation")?;
        for y in 0..FACE_SIZE {
            for x in 0..FACE_SIZE {
                let d = direction(
                    face,
                    (x as f32 + 0.5) / FACE_SIZE as f32,
                    (y as f32 + 0.5) / FACE_SIZE as f32,
                );
                let color = sample(width, height, pixels, oct_uv(d));
                data.extend(color.map(|c| (c + 0.5) as u8));
            }
        }
    }
    Ok(faces)
}

/// Six contiguous RGBA8 faces in GL_TEXTURE_CUBE_MAP_POSITIVE_X + face order.
pub fn bake(
    texture: &crate::Texture,
    data: &[u8],
    strength: f32,
    post: &crate::Post,
) -> Result<Vec<u8>, String> {
    let (w, h, pixels) = oct_pixels(texture, data, strength, post)?;
    let faces = cube_faces(w, h, &pixels)?;
    let mut out = Vec::new();
    out.try_reserve_exact(CUBE_BYTES)
        .map_err(|_| "display cube allocation")?;
    for face in faces {
        out.extend(face);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use alloc::vec;
    #[test]
    fn average_is_linear_before_grade_and_nonfinite_inputs_fail() {
        let mut texture = crate::Texture {
            name: "env".into(),
            role: crate::TexRole::Environment,
            format: crate::TexFormat::Rgba16f,
            width: 128,
            height: 64,
            mips: 1,
            data: crate::Range {
                offset: 0,
                size: 65536,
            },
            wrap_s: crate::Wrap::Clamp,
            wrap_t: crate::Wrap::Clamp,
            has_alpha: false,
            mean: [0.0; 4],
            lod_bias: 0.0,
        };
        let mut data = Vec::new();
        for i in 0..128 * 64 {
            let h = if i % 2 == 0 { 0u16 } else { 0x4400 };
            for _ in 0..3 {
                data.extend(h.to_le_bytes());
            }
            data.extend(0x3c00u16.to_le_bytes());
        }
        let post = crate::Post::default();
        let (w, h, pixels) = oct_pixels(&texture, &data, 0.25, &post).unwrap();
        assert_eq!((w, h), (64, 32));
        let rgb = crate::color::tone([0.5; 3], &post).map(|v| (v * 255.0 + 0.5) as u8);
        assert!(pixels
            .chunks_exact(4)
            .all(|p| p == [rgb[0], rgb[1], rgb[2], 255]));
        assert!(oct_pixels(&texture, &data[..8], 1.0, &post).is_err());
        data[..2].copy_from_slice(&0x7c00u16.to_le_bytes());
        assert!(oct_pixels(&texture, &data, 1.0, &post).is_err());
        texture.format = crate::TexFormat::Rgba8;
        texture.width = 1;
        texture.height = 1;
        assert_eq!(
            oct_pixels(&texture, &[255; 4], 0.5, &post).unwrap().2,
            [rgb[0], rgb[1], rgb[2], 255]
        );
        for strength in [f32::NAN, f32::INFINITY, -1.0] {
            assert!(oct_pixels(&texture, &[255; 4], strength, &post).is_err());
        }
        let hash = post_hash(&post).unwrap();
        let mut changed = post;
        changed.vignette += 0.1;
        assert_ne!(
            hash,
            post_hash(&changed).unwrap(),
            "hash covers the complete Post contract"
        );
        let data = [0; 64];
        texture.width = 4;
        texture.height = 4;
        let identity = source_hash(&texture, &data).unwrap();
        for field in 0..5 {
            let mut changed = texture.clone();
            match field {
                0 => changed.format = crate::TexFormat::Rgba16f,
                1 => changed.width = 2,
                2 => changed.height = 2,
                3 => changed.mips = 2,
                _ => changed.role = crate::TexRole::Color,
            }
            assert_ne!(
                identity,
                source_hash(&changed, &data).unwrap(),
                "source interpretation field {field}"
            );
        }
        let mut changed = data;
        changed[63] = 1;
        assert_ne!(identity, source_hash(&texture, &changed).unwrap());
        texture.data.offset = 16;
        texture.name = "aliased source".into();
        assert_eq!(identity, source_hash(&texture, &data).unwrap());
    }

    fn cube_sample(faces: &[Vec<u8>; 6], d: [f32; 3]) -> [f32; 4] {
        cube_sample_at_size(FACE_SIZE, faces, d)
    }

    fn cube_sample_at_size(size: u32, faces: &[Vec<u8>; 6], d: [f32; 3]) -> [f32; 4] {
        let [x, y, z] = d;
        let (face, sc, tc, major) = if x.abs() >= y.abs() && x.abs() >= z.abs() {
            if x >= 0.0 {
                (0, -z, -y, x.abs())
            } else {
                (1, z, -y, x.abs())
            }
        } else if y.abs() >= z.abs() {
            if y >= 0.0 {
                (2, x, z, y.abs())
            } else {
                (3, x, -z, y.abs())
            }
        } else if z >= 0.0 {
            (4, x, -y, z.abs())
        } else {
            (5, -x, -y, z.abs())
        };
        sample(
            size,
            size,
            &faces[face],
            [(sc / major + 1.0) * 0.5, (tc / major + 1.0) * 0.5],
        )
    }

    /// A deterministic angular sample, including every face edge/corner and
    /// both sides of seams. Values are display-byte errors, not GPU precision.
    pub(crate) fn error(width: u32, height: u32, pixels: &[u8]) -> (f64, f32, usize) {
        error_at_size(width, height, pixels, FACE_SIZE)
    }

    pub(crate) fn error_at_size(
        width: u32,
        height: u32,
        pixels: &[u8],
        size: u32,
    ) -> (f64, f32, usize) {
        assert!([32, 64, 128].contains(&size));
        // Experiment only: production uses the fixed 64px implementation.
        let faces: [Vec<u8>; 6] = core::array::from_fn(|face| {
            let mut data = Vec::new();
            for y in 0..size {
                for x in 0..size {
                    let d = direction(
                        face,
                        (x as f32 + 0.5) / size as f32,
                        (y as f32 + 0.5) / size as f32,
                    );
                    data.extend(sample(width, height, pixels, oct_uv(d)).map(|c| (c + 0.5) as u8));
                }
            }
            data
        });
        if size == FACE_SIZE {
            assert_eq!(faces, cube_faces(width, height, pixels).unwrap());
        }
        let mut sum = 0.0f64;
        let mut max = 0.0f32;
        let mut count = 0;
        for face in 0..6 {
            for y in 0..=128 {
                for x in 0..=128 {
                    let d = direction(face, x as f32 / 128.0, y as f32 / 128.0);
                    let expected = sample(width, height, pixels, oct_uv(d));
                    let actual = cube_sample_at_size(size, &faces, d);
                    for c in 0..3 {
                        let e = (expected[c] - actual[c]).abs();
                        sum += f64::from(e * e);
                        max = max.max(e);
                        count += 1;
                    }
                }
            }
        }
        (sum.sqrt() / (count as f64).sqrt(), max, count / 3)
    }

    #[test]
    fn face_centers_and_rows_follow_es2_cube_orientation() {
        assert_eq!(
            (0..6).map(|f| direction(f, 0.5, 0.5)).collect::<Vec<_>>(),
            [
                [1.0, 0.0, 0.0],
                [-1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0]
            ]
        );
        assert_eq!(direction(0, 0.0, 0.0), [1.0, 1.0, 1.0]);
        assert_eq!(direction(2, 0.0, 0.0), [-1.0, 1.0, -1.0]);
        assert_eq!(direction(5, 0.0, 1.0), [1.0, -1.0, -1.0]);
        assert_eq!(oct_uv([0.0, 1.0, 0.0]), [0.5, 0.5]);
        assert_eq!(oct_uv([0.0, -1.0, 0.0]), [1.0, 1.0]);
    }

    #[test]
    fn constant_maps_are_exact_and_invalid_maps_are_rejected() {
        let faces = cube_faces(1, 1, &[51, 102, 153, 255]).unwrap();
        assert_eq!(faces.iter().map(Vec::len).sum::<usize>(), CUBE_BYTES);
        assert!(faces
            .iter()
            .all(|f| f.chunks_exact(4).all(|p| p == [51, 102, 153, 255])));
        for (w, h, n) in [(0, 1, 0), (1, 0, 0), (65, 1, 260), (1, 1, 3), (1, 1, 8)] {
            assert!(cube_faces(w, h, &vec![0; n]).is_err());
        }
    }

    #[test]
    fn direction_colored_map_preserves_axes_and_measures_seam_error() {
        let mut pixels = Vec::new();
        for y in 0..64 {
            for x in 0..64 {
                let (u, v) = ((x as f32 + 0.5) / 32.0 - 1.0, (y as f32 + 0.5) / 32.0 - 1.0);
                let mut d = [u, 1.0 - u.abs() - v.abs(), v];
                if d[1] < 0.0 {
                    d[0] = (1.0 - v.abs()) * u.signum();
                    d[2] = (1.0 - u.abs()) * v.signum();
                }
                let length = d.iter().map(|v| v * v).sum::<f32>().sqrt();
                pixels.extend(d.map(|v| ((v / length * 0.5 + 0.5) * 255.0 + 0.5) as u8));
                pixels.push(255);
            }
        }
        let faces = cube_faces(64, 64, &pixels).unwrap();
        for face in 0..6 {
            let d = direction(face, 0.5, 0.5);
            let actual = cube_sample(&faces, d);
            for c in 0..3 {
                assert!((actual[c] - (d[c] * 0.5 + 0.5) * 255.0).abs() < 2.5);
            }
        }
        let (rmse, max, count) = error(64, 64, &pixels);
        std::println!("cube synthetic: samples={count}, RGB byte RMSE={rmse:.6}, max={max:.6}");
        assert!(rmse < 0.7 && max < 3.5, "{rmse} / {max}");
    }
}
