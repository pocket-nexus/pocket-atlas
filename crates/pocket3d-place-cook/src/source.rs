//! Transient Atlas analysis values. No device versions, byte ranges or GPU layouts.
use crate::{
    geometry::Vertex,
    textures::{self, Rgba},
};
pub use pocket_atlas_model::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VertexClass {
    Static,
    Skinned,
    Baked,
    Lights,
}

pub struct Lod {
    pub indices: Vec<u32>,
    pub error: f32,
}
pub enum Geometry {
    Triangles {
        vertices: Vec<Vertex>,
        indices: Vec<u32>,
        lods: Vec<Lod>,
    },
    LightField(Vec<LightPoint>),
}
pub struct Draw {
    pub material: u32,
    pub class: VertexClass,
    pub geometry: Geometry,
    pub min: Vec3,
    pub max: Vec3,
    pub node: Option<u32>,
    pub skin: Option<u32>,
    pub no_reflect: bool,
    pub cast_shadow: bool,
}
impl Draw {
    pub fn vertices(&self) -> &[Vertex] {
        match &self.geometry {
            Geometry::Triangles { vertices, .. } => vertices,
            Geometry::LightField(_) => panic!("light field is not a triangle mesh"),
        }
    }
    pub fn indices(&self) -> &[u32] {
        match &self.geometry {
            Geometry::Triangles { indices, .. } => indices,
            Geometry::LightField(_) => &[],
        }
    }
    pub fn lods(&self) -> &[Lod] {
        match &self.geometry {
            Geometry::Triangles { lods, .. } => lods,
            Geometry::LightField(_) => &[],
        }
    }
    pub fn vertex_count(&self) -> u32 {
        match &self.geometry {
            Geometry::Triangles { vertices, .. } => vertices.len() as u32,
            Geometry::LightField(points) => points.len() as u32,
        }
    }
    pub fn index_count(&self) -> u32 {
        self.indices().len() as u32
    }
}

/// Channel requirements of procedural lookup fields, independent of compression.
pub enum LookupChannels {
    Rgb,
    Rg,
    Rgba,
}
pub enum Pixels {
    /// Original authored pixels and flipbook sampling boundaries.
    Image { rgba: Vec<u8>, cells: (u32, u32) },
    /// Analytic effect samples. A backend chooses their storage encoding.
    Lookup {
        image: Rgba,
        channels: LookupChannels,
        levels: u32,
    },
    /// Linear half-float octahedral probe samples shared by lighting analysis.
    Environment { rgba16f: Vec<u8>, levels: u32 },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextureUsage {
    Surface,
    TextAtlas,
    Flipbook,
    EmissiveStrip,
}

pub struct Texture {
    pub usage: Option<TextureUsage>,
    pub name: String,
    pub role: TexRole,
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
    pub wrap_s: Wrap,
    pub wrap_t: Wrap,
    pub has_alpha: bool,
    pub mean: [f32; 4],
    pub lod_bias: f32,
}
impl Texture {
    pub fn rgba8(&self) -> Vec<u8> {
        match &self.pixels {
            Pixels::Image { rgba, .. } => rgba.clone(),
            Pixels::Lookup { image, .. } => image
                .px
                .iter()
                .flat_map(|p| p.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8))
                .collect(),
            Pixels::Environment { .. } => panic!("environment is not a material image"),
        }
    }
    pub fn image(&self) -> Rgba {
        textures::from_rgba8(self.width, self.height, &self.rgba8(), self.role)
    }
}

pub struct Node {
    pub name: String,
    pub parent: Option<u32>,
    pub translation: Vec3,
    pub rotation: [f32; 4],
    pub scale: Vec3,
    pub track: Option<Vec<[f32; 7]>>,
}
pub struct Skin {
    pub joints: Vec<u32>,
    pub inverse_bind: Vec<[f32; 16]>,
}
pub struct FogTrack {
    pub samples: Vec<[f32; 4]>,
}
pub struct MaterialTrack {
    pub samples: Vec<f32>,
}

pub struct Scene {
    /// Target analysis included direct sun before LOD selection.
    pub baked_sun: bool,
    pub provenance: serde_json::Value,
    pub name: String,
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
    pub fps: f32,
    pub frames: u32,
    pub atmosphere: Atmosphere,
    pub rain: Rain,
    pub camera: CameraSet,
    pub doors: Option<Doors>,
    pub beacons: Vec<Vec3>,
    pub effects: Effects,
    pub sun: Option<Sun>,
    pub day_sky: Option<DaySky>,
    pub post: Post,
    pub vista_haze: Option<VistaHaze>,
    pub stats: serde_json::Value,
}
impl Scene {
    pub fn vertex<'a>(&self, draw: &'a Draw, index: usize) -> &'a Vertex {
        &draw.vertices()[index]
    }
}
