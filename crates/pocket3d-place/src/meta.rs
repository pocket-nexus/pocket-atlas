//! The `META` table: everything a renderer needs besides raw GPU payloads.

use serde::{Deserialize, Serialize};

pub type Vec3 = [f32; 3];

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Wrap {
    Repeat,
    Clamp,
    Mirror,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TexRole {
    /// sRGB colour (albedo, emission); shaders decode to linear.
    Color,
    /// Tangent-space normal, X in R and Y in G (BC5); shaders rebuild Z.
    Normal,
    /// Occlusion / roughness / metalness in R / G / B.
    Orm,
    /// Linear data.
    Data,
    /// Octahedral HDR environment map; mip n is prefiltered for roughness n/(mips-1).
    Environment,
}

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
}

// --------------------------------------------------------------- materials

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Lit surface: albedo / normal / ORM / emission, optional wet or damp film.
    Standard,
    /// HDR colour × texture, no lighting.
    Unlit,
    /// Premultiplied glass with rain beads and running drops.
    Glass,
    /// Window pane over a parallax room (UV integer part = room seed).
    InteriorWindow,
    /// Shop stock: vertex colour picks a design from the packaging atlas.
    Products,
    /// Distant tower lattice (procedural).
    Tower,
    /// Distant skyline boxes (procedural windows; vertex colour = per-box info).
    Skyline,
    /// Open water (sea, lake, river): `Material::water`, the normal map as
    /// the wave texture, `roughness` near the camera.
    Water,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blend {
    Opaque,
    Alpha,
    Premultiplied,
    Additive,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Wet {
    pub puddles: f32,
    pub darken: f32,
    pub roughness: f32,
    pub planar: bool,
    pub ripple: f32,
    pub puddle_scale: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Damp {
    pub darken: f32,
    pub roughness: f32,
    pub streaks: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Material {
    pub name: String,
    pub kind: Kind,
    pub blend: Blend,
    pub double_sided: bool,
    pub depth_write: bool,
    pub alpha_test: f32,
    /// Linear RGBA (alpha = opacity).
    pub color: [f32; 4],
    /// Linear HDR emission (already multiplied by intensity). Products:
    /// (light level, packaging mix, 0); interior windows: (room intensity, 0, 0).
    pub emissive: Vec3,
    pub roughness: f32,
    pub metalness: f32,
    pub normal_scale: f32,
    pub ao_strength: f32,
    pub env_strength: f32,
    pub albedo: Option<u32>,
    pub normal: Option<u32>,
    pub orm: Option<u32>,
    pub emission: Option<u32>,
    pub vertex_color: bool,
    /// Interior surface: emission carries its lighting (no scene lights, no fog).
    pub interior: bool,
    pub fog: bool,
    pub wet: Option<Wet>,
    pub damp: Option<Damp>,
    /// Glass bead density, 0..1.
    pub drops: f32,
    pub clearcoat: f32,
    pub polygon_offset: Option<[f32; 2]>,
    /// Index into `Meta::material_tracks` driving emission (neon flicker).
    pub emissive_track: Option<u32>,
    /// Animated texture coordinates (LED signs, screens, tickers).
    #[serde(default)]
    pub uv_anim: Option<UvAnim>,
    #[serde(default)]
    pub water: Option<Water>,
}

/// Open water: two layers of the normal map laid on the world's x/z plane
/// and scrolled, the environment reflected by Fresnel, the sun's highlight
/// and light scattered out of the body.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Water {
    /// Per layer: repeats per metre, scroll (m/s along x, along z).
    pub waves: [[f32; 3]; 2],
    /// Linear colour of the light the body scatters back, × sky irradiance.
    pub body: [f32; 3],
    /// Roughness² added per metre of distance: waves smaller than a pixel
    /// widen the sun's reflection into a glitter path.
    pub distance_roughness: f32,
}

/// A material's texture coordinates over time: a flipbook of `frames`
/// cells in a `cols` × `rows` grid (cell `f` at column `f % cols`, row
/// `f / cols`, from the top left) played at `fps`, then a scroll in texture
/// widths per second. The mesh's coordinates span one cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UvAnim {
    pub cols: u32,
    pub rows: u32,
    pub frames: u32,
    pub fps: f32,
    pub scroll: [f32; 2],
    /// Seconds added to the place's clock.
    #[serde(default)]
    pub phase: f32,
}

impl UvAnim {
    /// `uv` = (scale u, scale v, offset u, offset v) at `time` seconds.
    pub fn apply(&self, uv: [f32; 4], time: f32) -> [f32; 4] {
        let time = time + self.phase;
        let mut uv = uv;
        if self.frames > 1 {
            let (cols, rows) = (self.cols.max(1), self.rows.max(1));
            let f = ((time * self.fps).floor() as i64).rem_euclid(self.frames as i64) as u32;
            let (cw, ch) = (1.0 / cols as f32, 1.0 / rows as f32);
            uv = [uv[0] * cw, uv[1] * ch, uv[2] * cw + (f % cols) as f32 * cw, uv[3] * ch + (f / cols) as f32 * ch];
        }
        uv[2] += (time * self.scroll[0]).fract();
        uv[3] += (time * self.scroll[1]).fract();
        uv
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
}

impl VertexLayout {
    pub const fn stride(self) -> u32 {
        match self {
            VertexLayout::Static => 24,
            VertexLayout::Skinned => 32,
            VertexLayout::Baked => 28,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LightKind {
    Point,
    Spot,
    /// Rectangular emitter approximated by the shaders as a soft spot.
    Rect,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Light {
    pub kind: LightKind,
    pub position: Vec3,
    pub direction: Vec3,
    /// Linear colour × intensity (candela-like units as authored).
    pub color: Vec3,
    pub range: f32,
    pub cos_outer: f32,
    pub cos_inner: f32,
    pub size: [f32; 2],
    /// Rect lights: the emitter's width axis (height axis = direction × right).
    #[serde(default)]
    pub right: Vec3,
    pub node: Option<u32>,
    pub cast_shadow: bool,
}

/// A light that scatters in the rain haze (and tints nearby drops).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FogLight {
    pub position: Vec3,
    pub color: Vec3,
    pub intensity: f32,
    pub radius: f32,
    pub spot: Option<(Vec3, f32, f32)>,
    /// Index into `Meta::fog_tracks`.
    pub track: Option<u32>,
}

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

// -------------------------------------------------------------- atmosphere

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Atmosphere {
    pub fog_color: Vec3,
    pub fog_density: f32,
    pub haze_density: f32,
    pub haze_ambient: Vec3,
    pub haze_ambient_density: f32,
    /// Dry interior box excluded from haze and rain.
    pub dry_min: Vec3,
    pub dry_max: Vec3,
    pub hemisphere_sky: Vec3,
    pub hemisphere_ground: Vec3,
    pub sky_zenith: Vec3,
    pub sky_horizon: Vec3,
    pub sky_glow: Vec3,
    pub environment: Option<u32>,
    pub environment_strength: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Rain {
    /// The place has rain: streaks, splashes, the wet film's rain factor.
    #[serde(default)]
    pub active: bool,
    pub dry_boxes: Vec<[Vec3; 2]>,
    pub drip_edges: Vec<[Vec3; 2]>,
    pub steam_vents: Vec<[Vec3; 2]>,
}

// --------------------------------------------------------------------- sun

/// A directional light evaluated per pixel with a shadow map, not baked.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sun {
    /// Direction towards the sun.
    pub direction: Vec3,
    /// Linear colour × intensity.
    pub radiance: Vec3,
    pub shadow: Option<SunShadow>,
}

/// The sun's orthographic shadow camera, as authored (three.js conventions).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SunShadow {
    /// Camera position; it looks along −`Sun::direction`.
    pub position: Vec3,
    /// left, right, bottom, top, near, far (metres, camera space).
    pub ortho: [f32; 6],
    pub map_size: u32,
    pub bias: f32,
    pub normal_bias: f32,
    /// Filter radius in shadow-map texels.
    pub radius: f32,
}

/// Daytime sky: a zenith/horizon gradient, the sun's glow and disc, and a
/// cloud panorama (two 180° halves side by side in v, rows by the square
/// root of elevation; R opacity, G sunlit / `cloud_sun`, B skylit).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DaySky {
    pub zenith: Vec3,
    pub horizon: Vec3,
    pub ground: Vec3,
    pub gradient_power: f32,
    pub ground_blend: f32,
    pub sun_direction: Vec3,
    pub sun_color: Vec3,
    pub glow: f32,
    /// (weight, exponent) of the wide and tight glow lobes.
    pub glow_wide: [f32; 2],
    pub glow_tight: [f32; 2],
    pub disc: f32,
    pub disc_cos_inner: f32,
    pub disc_cos_outer: f32,
    pub clouds: Option<u32>,
    /// Sunlit cloud colour (× the panorama's G) and skylit colour (× B).
    pub cloud_sun: Vec3,
    pub cloud_ambient: Vec3,
    pub fade_elevation: f32,
    /// Panorama turns per second.
    pub drift: f32,
    /// After sunset: afterglow, anti-twilight arch and the Earth's shadow.
    #[serde(default)]
    pub twilight: Option<Twilight>,
}

/// Twilight terms over the daytime sky (web `places/shared/sky.ts`), with
/// h the ray's elevation sine and a the cosine of its azimuth to the sun:
/// `band · e^(−|h|/height) · mix(1, ((a+1)/2)^sun_power, sun_bias)` along the
/// horizon, `belt · e^(−((h−elevation)/width)²) · ((1−a)/2)^power` opposite
/// the sun, and the sky scaled by `1 − strength · e^(−|h|/height) · ((1−a)/2)^power`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Twilight {
    pub band: Vec3,
    /// height, sun bias, sun power
    pub band_shape: [f32; 3],
    pub belt: Vec3,
    /// elevation, width, power
    pub belt_shape: [f32; 3],
    /// strength, height, power
    pub shadow: [f32; 3],
}

// -------------------------------------------------------------------- post

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToneCurve {
    Agx,
    Aces,
}

/// Tone mapping and grade after the scene (the web's grade effect), and bloom.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Post {
    pub tone: ToneCurve,
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub lift: Vec3,
    pub gain: Vec3,
    /// Darkening at the corners (1 − vignette at full strength).
    pub vignette: f32,
    pub grain: f32,
    pub bloom_threshold: f32,
    pub bloom_smoothing: f32,
    pub bloom_intensity: f32,
}

impl Default for Post {
    /// The first place's look (Rainy Night Konbini), as the renderer had it
    /// before places carried their own.
    fn default() -> Self {
        Self {
            tone: ToneCurve::Agx,
            exposure: 1.0,
            contrast: 1.16,
            saturation: 1.18,
            lift: [0.1, 0.35, 0.45],
            gain: [1.04, 0.99, 0.94],
            vignette: 0.2475,
            grain: 0.03,
            bloom_threshold: 1.1,
            bloom_smoothing: 0.4,
            bloom_intensity: 0.85,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShotKey {
    pub pos: Vec3,
    pub target: Vec3,
    pub fov: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shot {
    pub name: String,
    pub from: ShotKey,
    pub to: ShotKey,
    pub duration: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CameraSet {
    pub shots: Vec<Shot>,
    /// [min.xyz, max.xyz] boxes the free camera may occupy.
    pub walkable: Vec<[f32; 6]>,
    pub intro: ShotKey,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Doors {
    pub left: u32,
    pub right: u32,
    pub travel: f32,
    pub trigger: Vec3,
    pub radius: f32,
}

/// Tileable lookup textures baked by the cooker for effects that would
/// otherwise evaluate noise per pixel.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Effects {
    /// RG: puddle field and detail noise; one tile per puddle-UV unit.
    pub puddles: Option<u32>,
    /// Rain-ripple flipbook: `ripple_grid`² frames, RG = normal offset.
    pub ripples: Option<u32>,
    pub ripple_grid: u32,
    /// World metres covered by one ripple frame.
    pub ripple_tile: f32,
    /// Static glass beads for a 1 m tile: RG = normal offset, B = coverage.
    pub beads: Option<u32>,
    /// Cloud deck: R, G = two fbm fields periodic over `cloud_cells` cells.
    pub clouds: Option<u32>,
    pub cloud_cells: f32,
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
    pub stats: serde_json::Value,
}
