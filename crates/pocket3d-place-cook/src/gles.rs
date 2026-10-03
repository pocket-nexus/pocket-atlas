//! SGX535 lowering from shared source analysis. No device pack is an input.
//! Positions/UVs retain source precision; textures are filtered from original
//! RGBA pixels. PLIP and its vertex layouts have a version independent of Vita.
use pocket3d_place as pc;
use std::path::Path;
#[path = "gles_clusters.rs"]
mod gles_clusters;
#[path = "gles_colors.rs"]
mod gles_colors;
#[path = "gles_effects.rs"]
mod gles_effects;
#[path = "gles_environment.rs"]
mod gles_environment;
#[path = "gles_geometry.rs"]
mod gles_geometry;
#[path = "gles_products.rs"]
mod gles_products;
#[path = "gles_pvrtc.rs"]
mod gles_pvrtc;
type Result<T> = std::result::Result<T, String>;

/// SGX's fixed 320-pixel height needs centimetre-scale levels between the
/// source mesh and the shared 6 cm tier. Keep the shared tiers byte-for-byte:
/// these additions are independently simplified from the same float source,
/// with the same attribute weights, chunk locks and structural-detail policy.
/// This is a target policy; other backends continue to call `geometry::lods`.
pub(crate) fn source_lods(
    vertices: &[crate::geometry::Vertex],
    triangles: &[[u32; 3]],
    locked: &[bool],
    drop_parts: bool,
    shared_bounds: &[f32],
) -> Vec<(Vec<[u32; 3]>, f32)> {
    let shared = crate::geometry::lods(vertices, triangles, locked, drop_parts, shared_bounds);
    let mut fine =
        crate::geometry::lods(vertices, triangles, locked, drop_parts, &[0.01, 0.02, 0.04]);
    // An inserted level must reduce the finer tier and remain finer than the
    // next shared one. A shared tier with a smaller measured error dominates
    // an otherwise promising fine candidate; never weaken that existing tier.
    fine.retain(|(triangles, error)| {
        shared.iter().all(|(original, original_error)| {
            if original_error == error {
                false
            } else if original_error < error {
                original.len() > triangles.len()
            } else {
                original.len() < triangles.len()
            }
        })
    });
    fine.extend(shared);
    fine.sort_by(|a, b| a.1.total_cmp(&b.1));
    fine
}

pub fn cook(
    source: &crate::source::Scene,
    output: &Path,
    cap: u32,
    pvrtctool: Option<&Path>,
) -> Result<()> {
    let encoder = pvrtctool
        .map(|path| gles_pvrtc::Encoder::new(path, output.parent().unwrap_or(Path::new("."))))
        .transpose()?;
    let (bytes, recipe, receipt) = lower(source, cap, encoder.as_ref())?;
    // Validate/bake every sidecar before publishing any file.
    let colors = gles_colors::adapt_with_recipe(&bytes, &recipe)?;
    let clusters = gles_clusters::adapt(&bytes)?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(output, &bytes).map_err(|e| e.to_string())?;
    std::fs::write(output.with_extension("ipod-color.bin"), &colors.bytes)
        .map_err(|e| e.to_string())?;
    std::fs::write(output.with_extension("ipod-color.json"), &colors.json)
        .map_err(|e| e.to_string())?;
    std::fs::write(output.with_extension("ipod-clusters.bin"), &clusters)
        .map_err(|e| e.to_string())?;
    if let Some(receipt) = receipt {
        std::fs::write(
            output.with_extension("ipod-texture-receipt.json"),
            serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    } else if let Err(error) =
        std::fs::remove_file(output.with_extension("ipod-texture-receipt.json"))
    {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("remove obsolete PVRTC receipt: {error}"));
        }
    }
    let p = pc::ipod::parse(&bytes).map_err(|e| e.to_string())?;
    println!("iPod PLIP v1: {} bytes, GEOM {} bytes, TEXD {} bytes, {} display draws / {} color bytes, {} cluster bytes", bytes.len(),p.section(pc::TAG_GEOMETRY).unwrap().len(),p.section(pc::TAG_TEXTURES).unwrap().len(),colors.draws,colors.bytes.len(),clusters.len());
    Ok(())
}
fn append(out: &mut Vec<u8>, data: &[u8], align: usize) -> Result<pc::Range> {
    let start = out.len().checked_add(align - 1).ok_or("payload overflow")? / align * align;
    let end = start.checked_add(data.len()).ok_or("payload overflow")?;
    if end > u32::MAX as usize {
        return Err("iPod payload exceeds u32".into());
    }
    out.resize(start, 0);
    out.extend_from_slice(data);
    Ok(pc::Range {
        offset: start as u32,
        size: data.len() as u32,
    })
}
fn lower(
    source: &crate::source::Scene,
    cap: u32,
    encoder: Option<&gles_pvrtc::Encoder>,
) -> Result<(Vec<u8>, gles_products::Recipe, Option<gles_pvrtc::Receipt>)> {
    if cap == 0 {
        return Err("texture cap must be positive".into());
    }
    let mut meta = source.meta.clone();
    meta.version = pc::ipod::VERSION;
    let geometry = gles_geometry::lower(source, &mut meta)?;
    let mut pixels = Vec::new();
    for (i, t) in meta.textures.iter_mut().enumerate() {
        let (mut texture, bytes) =
            lower_texture(t, source.textures(), cap, source.texture_policy(i))
                .map_err(|e| format!("texture {i} ({}): {e}", t.name))?;
        texture.data = append(&mut pixels, &bytes, 16)?;
        *t = texture;
    }
    let recipe = gles_products::bake(source, &mut meta, &mut pixels)?;
    let mut ipod_recipes = gles_effects::bake(&mut meta, &mut pixels)?;
    let (display_cubes, cube_recipes) = gles_environment::bake(&meta, &pixels)?;
    ipod_recipes.display_cubes = cube_recipes;
    let mut compressed = Vec::new();
    let receipt = if let Some(encoder) = encoder {
        let out = encoder.bake(&meta, &pixels)?;
        compressed = out.bytes;
        ipod_recipes.pvrtc = out.recipes;
        Some(out.receipt)
    } else {
        None
    };
    let json = serde_json::to_vec(&pc::ipod::Metadata {
        scene: meta,
        ipod_recipes,
    })
    .map_err(|e| e.to_string())?;
    let mut sections = vec![
        (pc::TAG_META, json.as_slice(), 16),
        (pc::TAG_TEXTURES, pixels.as_slice(), 16),
        (pc::TAG_GEOMETRY, geometry.as_slice(), 16),
        (pc::TAG_ANIMATION, source.animation(), 16),
    ];
    if !compressed.is_empty() {
        sections.push((pc::ipod::TAG_PVRTC, compressed.as_slice(), 16));
    }
    if !display_cubes.is_empty() {
        sections.push((pc::ipod::TAG_DISPLAY_CUBES, display_cubes.as_slice(), 16));
    }
    let mut total = 16usize + sections.len() * 16;
    for (_, data, align) in &sections {
        total = total
            .checked_add(*align as usize - 1)
            .map(|n| n / *align as usize * *align as usize)
            .and_then(|n| n.checked_add(data.len()))
            .ok_or("iPod pack overflow")?;
        if total > u32::MAX as usize {
            return Err("iPod pack exceeds u32".into());
        }
    }
    Ok((
        pc::write_versioned(pc::ipod::MAGIC, pc::ipod::VERSION, &sections),
        recipe,
        receipt,
    ))
}
fn level_bytes(format: pc::TexFormat, w: u32, h: u32) -> Result<usize> {
    let stride = match format {
        pc::TexFormat::Rgba8 => 4,
        pc::TexFormat::Rgba16f => 8,
        _ => {
            return Err(
                "iPod lowering requires original RGBA pixels, not BC device textures".into(),
            )
        }
    };
    (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(stride))
        .ok_or("texture size overflow".into())
}
fn lower_texture(
    t: &pc::Texture,
    blob: &[u8],
    cap: u32,
    policy: crate::source::TexturePolicy,
) -> Result<(pc::Texture, Vec<u8>)> {
    if cap == 0
        || t.width == 0
        || t.height == 0
        || t.mips == 0
        || t.mips > 32
        || policy.cells.0 == 0
        || policy.cells.1 == 0
        || policy.max_mips == 0
    {
        return Err("invalid texture dimensions or policy".into());
    }
    let source = pc::parts::slice(blob, &t.data)?;
    let mut expected = 0usize;
    let (mut sw, mut sh) = (t.width, t.height);
    for _ in 0..t.mips {
        expected = expected
            .checked_add(level_bytes(t.format, sw, sh)?)
            .ok_or("mip overflow")?;
        sw = (sw / 2).max(1);
        sh = (sh / 2).max(1);
    }
    if source.len() != expected {
        return Err("source mip payload size mismatch".into());
    }
    if t.format == pc::TexFormat::Rgba16f
        && source
            .chunks_exact(2)
            .any(|b| !half::f16::from_le_bytes(b.try_into().unwrap()).is_finite())
    {
        return Err("non-finite environment texel".into());
    }
    let pow2 = |n: u32| 1u32 << (31 - n.leading_zeros());
    let limit = pow2(cap);
    let scale = (limit as f64 / t.width.max(t.height) as f64).min(1.0);
    let (width, height) = (
        pow2(((t.width as f64 * scale).floor() as u32).max(1)),
        pow2(((t.height as f64 * scale).floor() as u32).max(1)),
    );
    let mut out = t.clone();
    out.width = width;
    out.height = height;
    let mut bytes = Vec::new();
    if t.role == pc::TexRole::Environment {
        if t.mips > 32 - width.max(height).leading_zeros() {
            return Err("texture cap cannot preserve environment roughness levels".into());
        }
        let (mut sw, mut sh, mut dw, mut dh, mut at) = (t.width, t.height, width, height, 0);
        for _ in 0..t.mips {
            let n = level_bytes(t.format, sw, sh)?;
            bytes.extend(resample(t, &source[at..at + n], sw, sh, dw, dh)?);
            at += n;
            sw = (sw / 2).max(1);
            sh = (sh / 2).max(1);
            dw = (dw / 2).max(1);
            dh = (dh / 2).max(1);
        }
    } else {
        if t.format != pc::TexFormat::Rgba8 || t.mips != 1 {
            return Err("material source must contain one original RGBA8 image".into());
        }
        if width % policy.cells.0 != 0 || height % policy.cells.1 != 0 {
            return Err("texture cap cannot preserve flipbook cell boundaries".into());
        }
        let mut mip = resample(t, source, t.width, t.height, width, height)?;
        let (mut w, mut h) = (width, height);
        out.mips = 0;
        loop {
            bytes.extend(&mip);
            out.mips += 1;
            let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
            if (w == 1 && h == 1)
                || out.mips >= policy.max_mips
                || (policy.cells != (1, 1) && (nw / policy.cells.0 < 4 || nh / policy.cells.1 < 4))
            {
                break;
            }
            mip = resize(t, &mip, w, h, nw, nh)?;
            w = nw;
            h = nh;
        }
    }
    out.data.size = u32::try_from(bytes.len()).map_err(|_| "texture exceeds u32")?;
    Ok((out, bytes))
}
fn resample(t: &pc::Texture, source: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>> {
    if sw == dw && sh == dh {
        Ok(source.to_vec())
    } else {
        resize(t, source, sw, sh, dw, dh)
    }
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
    #[test]
    fn fine_source_lods_preserve_shared_tiers_and_chunk_locks() {
        use crate::geometry::{self, Vertex};
        use glam::{Vec2, Vec3};
        let mut vertices = Vec::new();
        let mut triangles = Vec::new();
        let n = 24u32;
        for y in 0..=n {
            for x in 0..=n {
                let u = x as f32 / n as f32;
                let v = y as f32 / n as f32;
                vertices.push(Vertex {
                    pos: Vec3::new(u * 4.0, v * 4.0, (u * 6.0).sin() * (v * 6.0).sin() * 0.4),
                    normal: Vec3::Z,
                    uv: Vec2::new(u, v),
                    color: [255; 4],
                    ..Default::default()
                });
                if x < n && y < n {
                    let a = y * (n + 1) + x;
                    triangles.extend([[a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]]);
                }
            }
        }
        let locks: Vec<_> = vertices
            .iter()
            .map(|v| v.pos.x == 0.0 || v.pos.x == 4.0)
            .collect();
        let shared = geometry::lods(&vertices, &triangles, &locks, false, &[0.06, 0.25]);
        let result = source_lods(&vertices, &triangles, &locks, false, &[0.06, 0.25]);
        assert!(
            result.len() > shared.len(),
            "fixture needs a useful fine tier"
        );
        for tier in &shared {
            assert!(result.contains(tier), "shared topology/error changed");
        }
        for pair in result.windows(2) {
            assert!(pair[0].1 < pair[1].1);
            assert!(pair[0].0.len() > pair[1].0.len());
        }
        for (triangles, error) in &result {
            assert!(error.is_finite() && *error >= 0.0);
            assert!(triangles
                .iter()
                .flatten()
                .all(|&i| (i as usize) < vertices.len()));
            for (i, locked) in locks.iter().enumerate() {
                if *locked {
                    assert!(triangles.iter().flatten().any(|&v| v as usize == i));
                }
            }
        }
    }
    pub(super) fn texture(role: pc::TexRole, w: u32, h: u32) -> pc::Texture {
        serde_json::from_value(json!({"name":"test","role":role,"format":"rgba8","width":w,"height":h,"mips":1,"data":{"offset":0,"size":w*h*4},"wrap_s":"repeat","wrap_t":"clamp","has_alpha":false})).unwrap()
    }
    #[test]
    fn original_texels_and_semantic_mips() {
        let src = [0, 0, 0, 255, 255, 255, 255, 255].repeat(8);
        let t = texture(pc::TexRole::Color, 4, 4);
        let (out, bytes) = lower_texture(&t, &src, 4, Default::default()).unwrap();
        assert_eq!(&bytes[..64], &src);
        assert_eq!(out.mips, 3);
        assert_eq!(&bytes[64..], [188, 188, 188, 255].repeat(5));
        let t = texture(pc::TexRole::Data, 4, 4);
        assert_eq!(
            lower_texture(&t, &src, 1, Default::default()).unwrap().1,
            [128, 128, 128, 255]
        );
    }
    #[test]
    fn alpha_normal_and_flipbook_boundaries() {
        let mut t = texture(pc::TexRole::Color, 8, 4);
        t.has_alpha = true;
        let src = [255, 0, 0, 255, 0, 0, 255, 0].repeat(16);
        assert_eq!(
            lower_texture(&t, &src, 1, Default::default()).unwrap().1,
            [255, 0, 0, 128]
        );
        let (t, b) = lower_texture(
            &t,
            &src,
            8,
            crate::source::TexturePolicy {
                cells: (2, 1),
                max_mips: 32,
            },
        )
        .unwrap();
        assert_eq!(t.mips, 1);
        assert_eq!(b, src);
        let t = texture(pc::TexRole::Normal, 4, 4);
        let src = [204, 128, 0, 255, 51, 128, 0, 255].repeat(8);
        assert_eq!(
            lower_texture(&t, &src, 1, Default::default()).unwrap().1,
            [128, 128, 0, 255]
        );
    }
    #[test]
    fn reject_compressed_and_truncated_source() {
        let mut t = texture(pc::TexRole::Data, 4, 4);
        assert!(lower_texture(&t, &[0; 63], 4, Default::default()).is_err());
        t.format = pc::TexFormat::Bc1;
        assert!(lower_texture(&t, &[0; 64], 4, Default::default())
            .unwrap_err()
            .contains("original RGBA"));
    }
    pub(super) fn fixture(texture: &pc::Texture) -> serde_json::Value {
        json!({
            "version": pc::ipod::VERSION, "name": "Full loop fixture", "kind": "night-street",
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
}
