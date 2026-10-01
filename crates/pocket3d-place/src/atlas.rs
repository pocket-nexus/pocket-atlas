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

use crate::meta::Texture;
use serde::{Deserialize, Serialize};

pub const MAGIC: [u8; 4] = *b"ATLS";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AtlasMeta {
    pub version: u32,
    pub places: Vec<AtlasPlace>,
    pub textures: Vec<Texture>,
    pub globe: Globe,
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
