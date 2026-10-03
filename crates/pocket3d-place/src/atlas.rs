//! The atlas pack (`atlas.pack`, magic "ATLS"): the globe a handheld shows
//! to pick a place, and the list of places. Same container as a place pack:
//! `META` ([`AtlasMeta`]) and `TEXD` (the textures, as in a place pack).
//!
//! The globe's camera and sun are fixed while the Earth turns under them, so
//! the maps that depend only on the view ray are baked for the handheld's
//! screen: `space` (sky and atmosphere halo), `inscatter` and
//! `transmittance` (atmosphere over the disc). The rotating surface is shaded
//! on the device from `albedo` (water in alpha), `normals` (elevation in
//! alpha), `lights` and `clouds`; `sun_transmittance` is the sunlight table
//! (x: cosine of the sun zenith angle, y: square root of height).
//!
//! The interface font travels in the same pack: [`FontMeta`] in `META` and
//! its 8-bit coverage atlas in the `FONT` section (top row first).

use crate::meta::Texture;
use serde::{Deserialize, Serialize};

pub const MAGIC: [u8; 4] = *b"ATLS";
pub const TAG_FONT: [u8; 4] = *b"FONT";

/// Interface text styles, (name, em size px, bold); the index is the style
/// a glyph belongs to and what the handheld's `ui::T` names.
pub const STYLES: [(&str, f32, bool); 8] = [
    ("caption", 15.0, false),
    ("label", 13.0, true),
    ("body", 17.0, false),
    ("strong", 17.0, true),
    ("title", 21.0, true),
    ("heading", 27.0, true),
    ("brand", 34.0, true),
    ("small", 15.0, true),
];

/// Characters the interface writes beyond ASCII and Latin-1 (button
/// glyphs, punctuation, units).
pub const UI_EXTRA: &str = "·•…“”‘’–—×★☆‹›°±²³½→←↑↓⇄✓△□○";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AtlasMeta {
    pub version: u32,
    pub places: Vec<AtlasPlace>,
    pub textures: Vec<Texture>,
    pub globe: Globe,
    #[serde(default)]
    pub font: Option<FontMeta>,
}

/// The baked interface font: glyphs of every [`STYLES`] entry in one
/// coverage atlas (`FONT`, `width` × `height` bytes).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FontMeta {
    pub width: u32,
    pub height: u32,
    pub styles: Vec<FontStyle>,
    pub glyphs: Vec<Glyph>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FontStyle {
    pub name: String,
    pub px: f32,
    pub bold: bool,
    pub ascent: f32,
    pub descent: f32,
    pub line: f32,
}

/// One glyph: its cell in the atlas, the cell's offset from the pen on the
/// baseline (y down) and the advance.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Glyph {
    pub style: u8,
    pub cp: u32,
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub left: i16,
    pub top: i16,
    pub advance: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasPlace {
    pub id: String,
    pub name: String,
    pub native: String,
    pub locality: String,
    pub locality_native: String,
    pub country: String,
    pub lat: f32,
    pub lon: f32,
    pub time_zone: String,
    pub weather: String,
    /// Linear-light sRGB accent colour.
    pub accent: [f32; 3],
    /// A pack exists and the place can be entered.
    pub enterable: bool,
    #[serde(default)]
    pub author: String,
    /// Kind of place (night-street, daytime-slope, …).
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub featured: bool,
    /// Preview card (texture index): the place's preview shot, 16:9 stored
    /// in a 2:1 texture.
    #[serde(default)]
    pub preview: Option<u32>,
    /// A route (a road driven end to end) rather than a single spot.
    #[serde(default)]
    pub route: Option<AtlasRoute>,
}

/// What the browser shows of a route: its ends, its length and its stops' names.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AtlasRoute {
    pub from: String,
    pub to: String,
    pub km: f32,
    /// (name, native name) of every stop, in driving order.
    pub stops: Vec<(String, String)>,
}

/// Camera, sun and shading constants of the web globe, for the fixed atlas view.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Globe {
    pub width: u32,
    pub height: u32,
    /// Vertical field of view (degrees), camera distance from the centre
    /// (planet radii) and the horizontal image shift in NDC.
    pub fov: f32,
    pub distance: f32,
    pub shift_ndc: f32,
    pub radius_px: f32,
    pub center_x: f32,
    /// Direction towards the sun (camera on +Z).
    pub sun: [f32; 3],
    pub sun_i: f32,
    pub surface: f32,
    pub lights_max: f32,
    pub lights_gain: f32,
    pub night: f32,
    pub cloud_shadow: f32,
    pub specular: f32,
    pub cloud_opacity: f32,
    pub cloud_glow: f32,
    pub cloud_drift_per_s: f32,
    pub idle_deg_per_s: f32,
    pub start_lat: f32,
    pub start_lon: f32,
    pub bloom_threshold: f32,
    pub bloom_smoothing: f32,
    pub bloom_intensity: f32,
    pub vignette_offset: f32,
    pub vignette_darkness: f32,
    pub grain: f32,
}
