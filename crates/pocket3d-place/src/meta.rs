//! The `META` table: everything a renderer needs besides raw GPU payloads.

use serde::{Deserialize, Serialize};
pub use pocket_atlas_model::*;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Range {
    pub offset: u32,
    pub size: u32,
}

// ---------------------------------------------------------------- textures

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TexFormat {
    /// 8-bit RGBA.
    Rgba8,
    /// BC1 / DXT1 (opaque RGB).
    Bc1,
    /// BC3 / DXT5 (RGB + interpolated alpha).
    Bc3,
    /// BC5 (two channels: normal X, Y).
    Bc5,
    /// Half-float RGBA, linear rows (environment map).
    Rgba16f,
}
// Block and pixel data are stored in linear row order; runtimes swizzle on
// upload (the Vita GPU's transfer engine produces its native layout).

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Texture {
    pub name: String,
    pub role: TexRole,
    pub format: TexFormat,
    pub width: u32,
    pub height: u32,
    pub mips: u32,
    /// Bytes of mip level 0 .. mips-1, contiguous, inside `TEXD`.
    pub data: Range,
    pub wrap_s: Wrap,
    pub wrap_t: Wrap,
    pub has_alpha: bool,
    /// Mean of each source channel (0..1, as stored): what a renderer uses
    /// when it drops the map (an ORM map's occlusion, roughness, metalness).
    #[serde(default)]
    pub mean: [f32; 4],
    /// Mip level bias for the texture's mapping: a texture laid with more
    /// texels per metre along one direction than the other (a window grid
    /// of narrow windows and tall floors) is blurred by isotropic mip
    /// selection along the sparser direction; a negative bias picks the
    /// level by that direction instead.
    #[serde(default)]
    pub lod_bias: f32,
}

// --------------------------------------------------------------- materials

pub const LIGHT_POINT_STRIDE: usize = 40;
pub const LIGHT_POINTS_PER_DRAW: usize = 16384;

/// Encodes one Atlas light into the Vita point record.
pub fn encode_light_point(light: &LightPoint, offset: Vec3, scale: Vec3, out: &mut Vec<u8>) {
        let s16 = |v: f32| ((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes();
        for k in 0..3 {
            out.extend(s16((light.position[k] - offset[k]) / scale[k].max(1e-6)));
        }
        out.extend(s16(light.phase.rem_euclid(1.0)));
        let c = light.color;
        let peak = c[0].max(c[1]).max(c[2]).max(1e-6);
        // Channels above 1 move into the intensity.
        let (c, i) = if peak > 1.0 { (c.map(|x| x / peak), light.intensity * peak) } else { (c, light.intensity) };
        out.extend([crate::color::encode8(c[0]), crate::color::encode8(c[1]), crate::color::encode8(c[2]), (light.twinkle.clamp(0.0, 1.0) * 255.0).round() as u8]);
        for v in [i, light.radius, light.path[0], light.path[1], light.path[2], light.path_cycles.round()] {
            out.extend(v.to_le_bytes());
        }
        out.extend([light.blink_cycles.round().clamp(0.0, 255.0) as u8, (light.duty.clamp(0.0, 1.0) * 255.0).round() as u8, 0, 0]);
}

#[cfg(test)]
mod light_tests {
    use super::*;

    #[test]
    fn encodes_forty_bytes() {
        let l = LightPoint { position: [10.0, -5.0, 2.0], color: [2.0, 1.0, 0.0], intensity: 3.0, radius: 0.25, phase: 1.25, twinkle: 0.5, path: [0.0, 0.0, -400.0], path_cycles: 3.0, blink_cycles: 300.0, duty: 0.5 };
        let mut out = Vec::new();
        encode_light_point(&l, [0.0; 3], [20.0, 20.0, 20.0], &mut out);
        assert_eq!(out.len(), LIGHT_POINT_STRIDE);
        let i16_at = |o: usize| i16::from_le_bytes([out[o], out[o + 1]]);
        let f32_at = |o: usize| f32::from_le_bytes(out[o..o + 4].try_into().unwrap());
        assert_eq!((i16_at(0), i16_at(2), i16_at(4)), (16384, -8192, 3277));
        // Phase wraps into 0..1.
        assert_eq!(i16_at(6), 8192);
        // The colour's peak above 1 moves into the intensity.
        assert_eq!(&out[8..12], &[255, 188, 0, 128]);
        assert_eq!((f32_at(12), f32_at(16), f32_at(28), f32_at(32)), (6.0, 0.25, -400.0, 3.0));
        // Blink cycles stop at 255.
        assert_eq!(&out[36..40], &[255, 128, 0, 0]);
        assert_eq!(l.bounds(), ([10.0, -5.0, -398.0], [10.0, -5.0, 2.0]));
    }
}

// ---------------------------------------------------------------- geometry

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VertexLayout {
    /// 24 bytes: pos s16n×3 + pad, normal s8n×4, tangent s8n×4 (w = handedness),
    /// uv s16n×2, colour u8n×4.
    Static,
    /// Static + joints u8×4 + weights u8n×4 (32 bytes).
    Skinned,
    /// Static + baked diffuse irradiance, square-root RGBM u8n×4 (28 bytes):
    /// irradiance / π = (rgb · a)² · 64.
    Baked,
    /// One light of a field per vertex (40 bytes, [`encode_light_point`]):
    /// position s16n×3 + phase s16n, sRGB colour u8n×3 + twinkle u8n,
    /// intensity f32, radius f32, path f32×3 + cycles f32, blink cycles u8,
    /// duty u8n, 2 spare bytes. Drawn without an index list.
    Lights,
}

impl VertexLayout {
    pub const fn stride(self) -> u32 {
        match self {
            VertexLayout::Static => 24,
            VertexLayout::Skinned => 32,
            VertexLayout::Baked => 28,
            VertexLayout::Lights => LIGHT_POINT_STRIDE as u32,
        }
    }
}

/// One indexed draw: ≤ 65 536 vertices with u16 indices.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Draw {
    pub material: u32,
    pub layout: VertexLayout,
    pub vertices: Range,
    pub vertex_count: u32,
    pub indices: Range,
    pub index_count: u32,
    /// Dequantisation: position = q * pos_scale + pos_offset (q in [-1, 1]).
    pub pos_offset: Vec3,
    pub pos_scale: Vec3,
    /// uv = q * uv_scale + uv_offset.
    pub uv_offset: [f32; 2],
    pub uv_scale: [f32; 2],
    /// World-space bounds (for culling), after dequantisation and node transform.
    pub min: Vec3,
    pub max: Vec3,
    /// Rigid dynamic node, if this draw moves.
    pub node: Option<u32>,
    pub skin: Option<u32>,
    /// Drawn by the main camera only (not into the street reflection).
    pub no_reflect: bool,
    pub cast_shadow: bool,
    /// Reduced index lists over the same vertices (LOD1, LOD2), for draws
    /// far enough that a level's error projects below the renderer's pixel
    /// threshold.
    #[serde(default)]
    pub lods: Vec<DrawLod>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DrawLod {
    pub indices: Range,
    pub index_count: u32,
    /// Largest geometric deviation from the full mesh (m).
    pub error: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub parent: Option<u32>,
    pub translation: Vec3,
    pub rotation: [f32; 4],
    pub scale: Vec3,
    /// Uniformly sampled track in `ANIM`: frames × (t.xyz, r.xyzw) f32.
    pub track: Option<Range>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Skin {
    pub joints: Vec<u32>,
    /// Column-major 4×4 inverse bind matrices, one per joint (f32 in `ANIM`).
    pub inverse_bind: Range,
}

// ------------------------------------------------------------------ lights

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FogTrack {
    /// frames × (x, y, z, gain) f32 in `ANIM`.
    pub data: Range,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MaterialTrack {
    /// frames × emissive intensity multiplier f32 in `ANIM`.
    pub data: Range,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Meta {
    pub version: u32,
    pub name: String,
    /// Kind of place (`night-street`, `daytime-slope`, …): which rendering
    /// work it draws on.
    #[serde(default)]
    pub kind: String,
    pub min: Vec3,
    pub max: Vec3,
    pub textures: Vec<Texture>,
    pub materials: Vec<Material>,
    pub draws: Vec<Draw>,
    pub nodes: Vec<Node>,
    pub skins: Vec<Skin>,
    pub lights: Vec<Light>,
    pub fog_lights: Vec<FogLight>,
    pub fog_tracks: Vec<FogTrack>,
    pub material_tracks: Vec<MaterialTrack>,
    /// Sample rate and length of every track in `ANIM`.
    pub fps: f32,
    pub frames: u32,
    pub atmosphere: Atmosphere,
    pub rain: Rain,
    pub camera: CameraSet,
    pub doors: Option<Doors>,
    pub beacons: Vec<Vec3>,
    #[serde(default)]
    pub effects: Effects,
    #[serde(default)]
    pub sun: Option<Sun>,
    #[serde(default)]
    pub day_sky: Option<DaySky>,
    #[serde(default)]
    pub post: Post,
    /// The vista haze (`dusk-vista` places), in place of the uniform fog.
    #[serde(default)]
    pub vista_haze: Option<VistaHaze>,
    pub stats: serde_json::Value,
}
