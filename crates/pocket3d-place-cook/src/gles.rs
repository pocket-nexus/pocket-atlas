//! GLES texture adaptation. Geometry, materials and animation retain the
//! common PLCE contract; iOS cannot sample the Vita's BC texture formats.
//!
//! The common cooker stops each mip dimension at four texels. GLES continues
//! to one, so narrow mip tails must be resampled rather than cropped. Authored
//! partial chains remain partial (in particular, flipbook frames must not bleed
//! together). The runtime must support a texture maximum mip level.
use pocket3d_place as pc;
use serde_json::value::RawValue;
use std::{collections::BTreeMap, ops::Range, path::Path};

type Result<T> = std::result::Result<T, String>;

struct Adapted {
    bytes: Vec<u8>,
    texture_count: usize,
    texture_bytes: usize,
    geometry_bytes: usize,
    animation_bytes: usize,
    largest_texture: usize,
}

pub fn cook(input: &Path, output: &Path, cap: u32) {
    let source = std::fs::read(input).expect("source place");
    let out = adapt(&source, cap).unwrap_or_else(|e| panic!("GLES adaptation: {e}"));
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).expect("output directory");
    }
    std::fs::write(output, &out.bytes).expect("write GLES place");
    let mib = |n: usize| n as f64 / 1048576.0;
    println!(
        "GLES place: {} bytes, {} textures, texture cap {cap}",
        out.bytes.len(),
        out.texture_count
    );
    println!(
        "  texture payload {:.2} MiB + geometry {:.2} MiB; animation {:.2} MiB; largest texture upload {:.2} MiB",
        mib(out.texture_bytes), mib(out.geometry_bytes), mib(out.animation_bytes), mib(out.largest_texture)
    );
    // This is payload accounting, not a device memory estimate: driver copies,
    // render targets, decoded JSON and the OS also occupy the shared RAM.
}

fn adapt(source: &[u8], cap: u32) -> Result<Adapted> {
    if cap == 0 {
        return Err("texture cap must be positive".into());
    }
    // Pack::parse allocates its section table. Bound the count before calling it
    // and reject aliases/duplicates rather than silently picking the first one.
    let count = source.get(8..12).ok_or("truncated pack header")?;
    let count = u32::from_le_bytes(count.try_into().unwrap()) as usize;
    if source.len() < 16 || count > (source.len() - 16) / 16 {
        return Err("truncated section table".into());
    }
    let pack = pc::Pack::parse(source).map_err(|e| e.to_string())?;
    let table_end = 16 + count * 16;
    for (i, section) in pack.sections.iter().enumerate() {
        let start = section.offset as usize;
        let end = start + section.size as usize;
        if start < table_end
            || !section.align.is_power_of_two()
            || start % section.align as usize != 0
        {
            return Err("invalid section alignment or offset".into());
        }
        if pack.sections[..i].iter().any(|s| {
            s.tag == section.tag
                || (start < s.offset as usize + s.size as usize && (s.offset as usize) < end)
        }) {
            return Err("duplicate or overlapping sections".into());
        }
    }
    let meta = pack.meta().map_err(|e| e.to_string())?;
    if meta.version != pc::VERSION {
        return Err(format!("unsupported metadata version {}", meta.version));
    }
    // Keep unrecognised metadata and sections, too. Only the five texture
    // representation fields change; material references and all tracks remain.
    let mut json: BTreeMap<String, Box<RawValue>> =
        serde_json::from_slice(pack.section(pc::TAG_META).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let mut texture_json: Vec<Box<RawValue>> =
        serde_json::from_str(json.get("textures").ok_or("missing texture table")?.get())
            .map_err(|e| e.to_string())?;
    let blob = pack.section(pc::TAG_TEXTURES).map_err(|e| e.to_string())?;
    let geometry_bytes = pack
        .section(pc::TAG_GEOMETRY)
        .map_err(|e| e.to_string())?
        .len();
    let animation_bytes = pack
        .section(pc::TAG_ANIMATION)
        .map_err(|e| e.to_string())?
        .len();
    let mut pixels = Vec::new();
    let mut largest_texture = 0;
    for (i, texture) in meta.textures.iter().enumerate() {
        let (mut texture, data) = adapt_texture(texture, blob, cap)
            .map_err(|e| format!("texture {} ({i}): {e}", texture.name))?;
        texture.data.offset =
            u32::try_from(pixels.len()).map_err(|_| "texture blob exceeds 4 GiB")?;
        texture.data.size = u32::try_from(data.len()).map_err(|_| "texture exceeds 4 GiB")?;
        largest_texture = largest_texture.max(data.len());
        pixels.extend(data);
        let encoded = serde_json::to_value(texture).map_err(|e| e.to_string())?;
        let mut fields: BTreeMap<String, Box<RawValue>> =
            serde_json::from_str(texture_json[i].get()).map_err(|e| e.to_string())?;
        for field in ["width", "height", "mips", "format", "data"] {
            fields.insert(
                field.into(),
                serde_json::value::to_raw_value(&encoded[field]).map_err(|e| e.to_string())?,
            );
        }
        texture_json[i] = serde_json::value::to_raw_value(&fields).map_err(|e| e.to_string())?;
    }
    if pixels.len() > u32::MAX as usize {
        return Err("texture blob exceeds 4 GiB".into());
    }
    json.insert(
        "textures".into(),
        serde_json::value::to_raw_value(&texture_json).map_err(|e| e.to_string())?,
    );
    let json = serde_json::to_vec(&json).map_err(|e| e.to_string())?;
    let sections: Vec<_> = pack
        .sections
        .iter()
        .map(|s| {
            let data = match s.tag {
                pc::TAG_META => json.as_slice(),
                pc::TAG_TEXTURES => pixels.as_slice(),
                _ => &source[s.offset as usize..s.offset as usize + s.size as usize],
            };
            (s.tag, data, s.align)
        })
        .collect();
    // The container uses u32 offsets. Check before its serializer's casts.
    let mut total = table_end;
    for (_, data, align) in &sections {
        total = total
            .checked_add(*align as usize - 1)
            .map(|n| n / *align as usize * *align as usize)
            .and_then(|n| n.checked_add(data.len()))
            .ok_or("pack size overflow")?;
        if total > u32::MAX as usize {
            return Err("GLES pack exceeds 4 GiB".into());
        }
    }
    Ok(Adapted {
        bytes: pc::write(&sections),
        texture_count: meta.textures.len(),
        texture_bytes: pixels.len(),
        geometry_bytes,
        animation_bytes,
        largest_texture,
    })
}

struct Mip {
    width: u32,
    height: u32,
    bytes: Range<usize>,
}

fn level_bytes(format: pc::TexFormat, width: u32, height: u32) -> Result<usize> {
    let (w, h, stride) = match format {
        pc::TexFormat::Bc1 => (width.div_ceil(4), height.div_ceil(4), 8),
        pc::TexFormat::Bc3 | pc::TexFormat::Bc5 => (width.div_ceil(4), height.div_ceil(4), 16),
        pc::TexFormat::Rgba8 => (width, height, 4),
        pc::TexFormat::Rgba16f => (width, height, 8),
    };
    (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(stride))
        .ok_or_else(|| "mip size overflow".into())
}

fn mip_layout(t: &pc::Texture, floor: u32) -> Result<Vec<Mip>> {
    let (mut width, mut height, mut offset) = (t.width, t.height, 0usize);
    let mut levels = Vec::new();
    for _ in 0..t.mips {
        let end = offset
            .checked_add(level_bytes(t.format, width, height)?)
            .ok_or("texture size overflow")?;
        levels.push(Mip {
            width,
            height,
            bytes: offset..end,
        });
        offset = end;
        width = (width / 2).max(floor.min(t.width));
        height = (height / 2).max(floor.min(t.height));
    }
    Ok(levels)
}

fn adapt_texture(t: &pc::Texture, blob: &[u8], cap: u32) -> Result<(pc::Texture, Vec<u8>)> {
    if cap == 0
        || t.width == 0
        || t.height == 0
        || t.mips == 0
        || t.mips > 32 - t.width.max(t.height).leading_zeros()
    {
        return Err("invalid dimensions, mip count or cap".into());
    }
    let start = t.data.offset as usize;
    let end = start
        .checked_add(t.data.size as usize)
        .ok_or("texture range overflow")?;
    let source = blob.get(start..end).ok_or("texture range outside TEXD")?;
    if t.format == pc::TexFormat::Rgba16f
        && source
            .chunks_exact(2)
            .any(|b| !half::f16::from_le_bytes([b[0], b[1]]).is_finite())
    {
        return Err("non-finite half-float texel".into());
    }
    let mut levels = mip_layout(t, 4)?;
    if levels.last().unwrap().bytes.end != source.len() {
        // Also accept standard uncompressed GLES chains on a repeat cook.
        // BC blocks cannot distinguish the layouts by size; common BC sources
        // always use the four-pixel floor and are decoded that way.
        levels = mip_layout(t, 1)?;
        if levels.last().unwrap().bytes.end != source.len() {
            return Err(format!(
                "mip payload size mismatch: declared {}, expected {}",
                source.len(),
                levels.last().unwrap().bytes.end
            ));
        }
    }
    let mut output = t.clone();
    let mut data = Vec::new();
    let (mut width, mut height) = (t.width, t.height);
    let mut first = 0;
    while width > cap || height > cap {
        width = (width / 2).max(1);
        height = (height / 2).max(1);
        first += 1;
    }
    output.width = width;
    output.height = height;
    if t.role == pc::TexRole::Environment {
        // Environment level n represents roughness n/(mips-1), not an ordinary
        // minification mip. Keep every roughness level and resize each spatially.
        // A cap unable to hold those distinct levels cannot preserve the map.
        if t.mips > 32 - width.max(height).leading_zeros() {
            return Err("cap cannot preserve the environment roughness levels".into());
        }
        first = 0;
    }
    if first >= t.mips as usize {
        // A one-level panorama / short flipbook has no authored mip this small.
        // Box filtering its last level respects aligned cell boundaries; never
        // generate a new tail beyond the author's original stopping point.
        let last = levels.last().unwrap();
        data = convert_level(t, last, &source[last.bytes.clone()], width, height)?;
        output.mips = 1;
    } else {
        output.mips = t.mips - first as u32;
        for level in &levels[first..] {
            data.extend(convert_level(
                t,
                level,
                &source[level.bytes.clone()],
                width,
                height,
            )?);
            width = (width / 2).max(1);
            height = (height / 2).max(1);
        }
    }
    if t.format != pc::TexFormat::Rgba16f {
        output.format = pc::TexFormat::Rgba8;
    }
    Ok((output, data))
}

fn convert_level(
    t: &pc::Texture,
    level: &Mip,
    source: &[u8],
    width: u32,
    height: u32,
) -> Result<Vec<u8>> {
    let decoded = match t.format {
        pc::TexFormat::Bc1 | pc::TexFormat::Bc3 | pc::TexFormat::Bc5 => {
            let format = match t.format {
                pc::TexFormat::Bc1 => texpresso::Format::Bc1,
                pc::TexFormat::Bc3 => texpresso::Format::Bc3,
                _ => texpresso::Format::Bc5,
            };
            let mut rgba = vec![0u8; level_bytes(pc::TexFormat::Rgba8, level.width, level.height)?];
            format.decompress(
                source,
                level.width as usize,
                level.height as usize,
                &mut rgba,
            );
            rgba
        }
        _ => source.to_vec(),
    };
    if (width, height) == (level.width, level.height) {
        return Ok(decoded);
    }
    resize(t, &decoded, level.width, level.height, width, height)
}

/// Area filtering in the texture's semantic space: sRGB colours are linearised
/// and premultiplied, data channels remain independent, and XY normals are
/// reconstructed / averaged / normalised. Half-float maps retain HDR precision.
fn resize(t: &pc::Texture, source: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>> {
    let half = t.format == pc::TexFormat::Rgba16f;
    let color = t.role == pc::TexRole::Color && !half;
    let normal = t.role == pc::TexRole::Normal;
    let premultiply = t.role == pc::TexRole::Color && t.has_alpha;
    let stride = if half { 8 } else { 4 };
    let mut out = Vec::with_capacity(level_bytes(
        if half {
            pc::TexFormat::Rgba16f
        } else {
            pc::TexFormat::Rgba8
        },
        dw,
        dh,
    )?);
    let sample = |x: u32, y: u32| -> Result<[f32; 4]> {
        let at = (y as usize * sw as usize + x as usize) * stride;
        let mut p = if half {
            core::array::from_fn(|c| {
                half::f16::from_le_bytes(source[at + c * 2..at + c * 2 + 2].try_into().unwrap())
                    .to_f32()
            })
        } else {
            core::array::from_fn(|c| source[at + c] as f32 / 255.0)
        };
        if !p.iter().all(|v| v.is_finite()) {
            return Err("non-finite half-float texel".into());
        }
        if color {
            for v in &mut p[..3] {
                *v = pc::color::decode(*v);
            }
        }
        if normal {
            p[0] = p[0] * 2.0 - 1.0;
            p[1] = p[1] * 2.0 - 1.0;
            p[2] = (1.0 - p[0] * p[0] - p[1] * p[1]).max(0.0).sqrt();
        }
        if premultiply {
            for c in 0..3 {
                p[c] *= p[3];
            }
        }
        Ok(p)
    };
    for y in 0..dh {
        let ya = y as f64 * sh as f64 / dh as f64;
        let yb = (y + 1) as f64 * sh as f64 / dh as f64;
        for x in 0..dw {
            let xa = x as f64 * sw as f64 / dw as f64;
            let xb = (x + 1) as f64 * sw as f64 / dw as f64;
            let mut sum = [0.0f64; 4];
            for sy in ya.floor() as u32..yb.ceil().min(sh as f64) as u32 {
                for sx in xa.floor() as u32..xb.ceil().min(sw as f64) as u32 {
                    let weight = (xb.min(sx as f64 + 1.0) - xa.max(sx as f64))
                        * (yb.min(sy as f64 + 1.0) - ya.max(sy as f64));
                    let p = sample(sx, sy)?;
                    for c in 0..4 {
                        sum[c] += p[c] as f64 * weight;
                    }
                }
            }
            let mut p = sum.map(|v| (v / ((xb - xa) * (yb - ya))) as f32);
            if premultiply && p[3] > 0.0 {
                for c in 0..3 {
                    p[c] /= p[3];
                }
            }
            if normal {
                let length = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
                if length > 1e-8 {
                    p[0] = p[0] / length * 0.5 + 0.5;
                    p[1] = p[1] / length * 0.5 + 0.5;
                } else {
                    p[0] = 0.5;
                    p[1] = 0.5;
                }
                p[2] = 0.0; // The renderer reconstructs Z from XY, as for BC5.
            }
            if color {
                for v in &mut p[..3] {
                    *v = pc::color::encode(*v);
                }
            }
            if half {
                for v in p {
                    out.extend(half::f16::from_f32(v).to_le_bytes());
                }
            } else {
                out.extend(p.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn texture(
        format: pc::TexFormat,
        role: pc::TexRole,
        width: u32,
        height: u32,
        mips: u32,
        size: usize,
    ) -> pc::Texture {
        pc::Texture {
            name: "fixture".into(),
            role,
            format,
            width,
            height,
            mips,
            data: pc::Range {
                offset: 0,
                size: size as u32,
            },
            wrap_s: pc::Wrap::Repeat,
            wrap_t: pc::Wrap::Clamp,
            has_alpha: false,
            mean: [0.2, 0.3, 0.4, 1.0],
            lod_bias: -0.5,
        }
    }

    #[test]
    fn block_formats_keep_alpha_and_normal_channels() {
        let red = [0, 248, 0, 0, 0, 0, 0, 0];
        let alpha = [64, 64, 0, 0, 0, 0, 0, 0];
        let green = [192, 192, 0, 0, 0, 0, 0, 0];
        for (format, source, pixel) in [
            (pc::TexFormat::Bc1, red.to_vec(), [255, 0, 0, 255]),
            (pc::TexFormat::Bc3, [alpha, red].concat(), [255, 0, 0, 64]),
            (
                pc::TexFormat::Bc5,
                [alpha, green].concat(),
                [64, 192, 0, 255],
            ),
        ] {
            let t = texture(format, pc::TexRole::Data, 4, 4, 1, source.len());
            let (out, bytes) = adapt_texture(&t, &source, 4).unwrap();
            assert_eq!(out.format, pc::TexFormat::Rgba8);
            assert_eq!(bytes, pixel.repeat(16));
        }
    }

    #[test]
    fn partial_mips_select_exact_source_without_extending_flipbook_tail() {
        let mut source = [17, 23, 31, 255].repeat(64 * 32);
        let tail = [67, 71, 79, 255].repeat(32 * 16);
        source.extend(&tail);
        let t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Color,
            64,
            32,
            2,
            source.len(),
        );
        let (out, bytes) = adapt_texture(&t, &source, 32).unwrap();
        assert_eq!((out.width, out.height, out.mips), (32, 16, 1));
        assert_eq!(bytes, tail);
        assert_eq!(out.mean, t.mean);
        assert_eq!(out.lod_bias, t.lod_bias);
        assert_eq!(out.wrap_s, t.wrap_s);
    }

    #[test]
    fn common_narrow_mips_are_filtered_to_gles_dimensions_not_cropped() {
        let mut source = Vec::new();
        for width in [32, 16, 8, 4] {
            for row in 0..4 {
                source.extend([row * 40, 0, 0, 255].repeat(width));
            }
        }
        let t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Data,
            32,
            4,
            4,
            source.len(),
        );
        let (out, bytes) = adapt_texture(&t, &source, 16).unwrap();
        assert_eq!((out.width, out.height, out.mips), (16, 2, 3));
        assert_eq!(bytes.len(), (16 * 2 + 8 + 4) * 4);
        assert_eq!(&bytes[..16 * 4], [20, 0, 0, 255].repeat(16));
        assert_eq!(&bytes[16 * 4..32 * 4], [100, 0, 0, 255].repeat(16));
        assert_eq!(&bytes[32 * 4..], [60, 0, 0, 255].repeat(12));
        // A second adaptation recognises the standard uncompressed layout.
        let mut out = out;
        out.data.size = bytes.len() as u32;
        assert_eq!(adapt_texture(&out, &bytes, 16).unwrap().1, bytes);
    }

    #[test]
    fn fallback_preserves_aspect_and_filters_colour_in_linear_space() {
        let source: Vec<_> = (0..64 * 16)
            .flat_map(|i| if i % 2 == 0 { [0, 0, 0, 255] } else { [255; 4] })
            .collect();
        let t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Color,
            64,
            16,
            1,
            source.len(),
        );
        let (out, bytes) = adapt_texture(&t, &source, 16).unwrap();
        assert_eq!((out.width, out.height, out.mips), (16, 4, 1));
        assert_eq!(bytes, [188, 188, 188, 255].repeat(16 * 4));
        let mut t = t;
        t.role = pc::TexRole::Data;
        assert_eq!(
            adapt_texture(&t, &source, 16).unwrap().1,
            [128, 128, 128, 255].repeat(16 * 4)
        );
    }

    #[test]
    fn colour_alpha_is_premultiplied_but_data_channels_are_independent() {
        let source = [255, 0, 0, 255, 0, 0, 255, 0].repeat(8);
        let mut t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Color,
            4,
            4,
            1,
            source.len(),
        );
        t.has_alpha = true;
        assert_eq!(adapt_texture(&t, &source, 1).unwrap().1, [255, 0, 0, 128]);
        t.role = pc::TexRole::Data;
        assert_eq!(adapt_texture(&t, &source, 1).unwrap().1, [128, 0, 128, 128]);
    }

    #[test]
    fn resampled_normals_reconstruct_z_before_averaging() {
        let source = [204, 128, 0, 255, 51, 128, 0, 255].repeat(8);
        let t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Normal,
            4,
            4,
            1,
            source.len(),
        );
        let bytes = adapt_texture(&t, &source, 1).unwrap().1;
        assert_eq!(bytes, [128, 128, 0, 255]);
    }

    #[test]
    fn environment_keeps_hdr_values_and_every_roughness_level() {
        let pixel = |v| {
            [v, v / 2.0, -0.5, 1.0]
                .map(|v| half::f16::from_f32(v).to_le_bytes())
                .concat()
        };
        let source = [pixel(4.0).repeat(8 * 8), pixel(2.0).repeat(4 * 4)].concat();
        let t = texture(
            pc::TexFormat::Rgba16f,
            pc::TexRole::Environment,
            8,
            8,
            2,
            source.len(),
        );
        let (out, bytes) = adapt_texture(&t, &source, 4).unwrap();
        assert_eq!((out.width, out.height, out.mips), (4, 4, 2));
        assert_eq!(out.format, pc::TexFormat::Rgba16f);
        assert_eq!(
            bytes,
            [pixel(4.0).repeat(4 * 4), pixel(2.0).repeat(2 * 2)].concat()
        );
        assert!(adapt_texture(&t, &source, 1)
            .unwrap_err()
            .contains("roughness"));
    }

    #[test]
    fn malformed_ranges_and_mips_fail_even_when_the_bad_level_would_be_skipped() {
        let source = vec![0; 8 * 8 * 4 + 4 * 4 * 4];
        let t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Data,
            8,
            8,
            2,
            source.len(),
        );
        for invalid in [
            pc::Texture {
                mips: 0,
                ..t.clone()
            },
            pc::Texture {
                mips: 33,
                ..t.clone()
            },
            pc::Texture {
                width: 0,
                ..t.clone()
            },
            pc::Texture {
                data: pc::Range {
                    offset: u32::MAX,
                    size: 10,
                },
                ..t.clone()
            },
            pc::Texture {
                data: pc::Range {
                    offset: 0,
                    size: t.data.size - 1,
                },
                ..t.clone()
            },
        ] {
            assert!(adapt_texture(&invalid, &source, 4).is_err());
        }
        assert!(adapt_texture(&t, &source, 0).is_err());
        assert!(adapt_texture(&t, &source[..source.len() - 1], 4).is_err());
        let nan = half::f16::NAN.to_le_bytes().repeat(4 * 4 * 4);
        let t = texture(
            pc::TexFormat::Rgba16f,
            pc::TexRole::Data,
            4,
            4,
            1,
            nan.len(),
        );
        assert!(adapt_texture(&t, &nan, 4)
            .unwrap_err()
            .contains("non-finite"));
    }

    fn fixture(texture: &pc::Texture) -> serde_json::Value {
        json!({
            "version": pc::VERSION, "name": "Full loop fixture", "kind": "night-street",
            "min": [-1,-2,-3], "max": [4,5,6], "textures": [texture], "materials": [],
            "draws": [{"material":0,"layout":"static","vertices":{"offset":0,"size":72},
                "vertex_count":3,"indices":{"offset":72,"size":6},"index_count":3,
                "pos_offset":[0,0,0],"pos_scale":[1,1,1],"uv_offset":[0,0],"uv_scale":[1,1],
                "min":[0,0,0],"max":[1,1,1],"node":0,"skin":null,"no_reflect":false,"cast_shadow":true}],
            "nodes": [{"name":"moving","parent":null,"translation":[0,0,0],"rotation":[0,0,0,1],
                "scale":[1,1,1],"track":{"offset":0,"size":3600*7*4}}],
            "skins": [], "lights": [], "fog_lights": [], "fog_tracks": [], "material_tracks": [],
            "fps":30,"frames":3600,"atmosphere":{"fog_color":[0,0,0],"fog_density":0,
                "haze_density":0,"haze_ambient":[0,0,0],"haze_ambient_density":0,
                "dry_min":[0,0,0],"dry_max":[0,0,0],"hemisphere_sky":[0,0,0],
                "hemisphere_ground":[0,0,0],"sky_zenith":[0,0,0],"sky_horizon":[0,0,0],
                "sky_glow":[0,0,0],"environment":null,"environment_strength":1},
            "rain":{"active":true,"dry_boxes":[],"drip_edges":[],"steam_vents":[]},
            "camera":{"shots":[],"walkable":[],"intro":{"pos":[0,1,2],"target":[3,4,5],"fov":40}},
            "doors":null,"beacons":[],"stats":{"triangles":1},"unknown_future_metadata":{"keep":true}
        })
    }

    #[test]
    fn untouched_metadata_numbers_keep_the_original_lexemes() {
        let texels = [255, 0, 0, 255].repeat(8 * 8);
        let t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Color,
            8,
            8,
            1,
            texels.len(),
        );
        let meta = serde_json::to_string(&fixture(&t))
            .unwrap()
            .replace(
                "\"pos_offset\":[0,0,0]",
                "\"pos_offset\":[0,-2.4492937e-16,0]",
            )
            .replace(
                "\"name\":\"fixture\"",
                "\"name\":\"fixture\",\"future\":-2.4492937e-16",
            );
        let source = pc::write(&[
            (pc::TAG_META, meta.as_bytes(), 16),
            (pc::TAG_TEXTURES, &texels, 16),
            (pc::TAG_GEOMETRY, &[], 16),
            (pc::TAG_ANIMATION, &[], 16),
        ]);
        let out = adapt(&source, 4).unwrap();
        let pack = pc::Pack::parse(&out.bytes).unwrap();
        let text = std::str::from_utf8(pack.section(pc::TAG_META).unwrap()).unwrap();
        assert!(text.contains("\"pos_offset\":[0,-2.4492937e-16,0]"));
        assert!(text.contains("\"future\":-2.4492937e-16"));
    }

    #[test]
    fn pack_adaptation_preserves_geometry_full_loop_and_other_metadata() {
        let texels = [255, 0, 0, 255].repeat(8 * 8);
        let t = texture(
            pc::TexFormat::Rgba8,
            pc::TexRole::Color,
            8,
            8,
            1,
            texels.len(),
        );
        let mut json = fixture(&t);
        json["textures"][0]["future_texture_field"] = json!("retain");
        let meta = serde_json::to_vec(&json).unwrap();
        let geometry: Vec<_> = (0..78).collect();
        let animation: Vec<_> = (0..3600 * 7)
            .flat_map(|i| (i as f32 / 7.0).to_le_bytes())
            .collect();
        let source = pc::write(&[
            (pc::TAG_META, &meta, 16),
            (pc::TAG_TEXTURES, &texels, 4096),
            (pc::TAG_GEOMETRY, &geometry, 4096),
            (pc::TAG_ANIMATION, &animation, 16),
            (*b"XTRA", b"keep", 16),
        ]);
        let out = adapt(&source, 4).unwrap();
        let result = pc::Pack::parse(&out.bytes).unwrap();
        assert_eq!(result.section(pc::TAG_GEOMETRY).unwrap(), geometry);
        assert_eq!(result.section(pc::TAG_ANIMATION).unwrap(), animation);
        assert_eq!(result.section(*b"XTRA").unwrap(), b"keep");
        let mut output_json: serde_json::Value =
            serde_json::from_slice(result.section(pc::TAG_META).unwrap()).unwrap();
        for field in ["width", "height", "mips", "format", "data"] {
            output_json["textures"][0][field] = json["textures"][0][field].clone();
        }
        assert_eq!(output_json, json);
        assert_eq!(result.meta().unwrap().frames, 3600);
        assert_eq!(out.geometry_bytes, geometry.len());
        assert_eq!(out.animation_bytes, animation.len());
        assert_eq!(out.texture_bytes, 4 * 4 * 4);
        assert_eq!(out.largest_texture, 4 * 4 * 4);
        let meta = result.meta().unwrap();
        let tex = &meta.textures[0];
        assert_eq!(tex.data.size, 4 * 4 * 4);
        assert_eq!(
            result.section(pc::TAG_TEXTURES).unwrap().len(),
            tex.data.size as usize
        );
    }
}
