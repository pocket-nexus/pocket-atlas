//! Transient output of shared scene analysis, lighting and LOD passes.
//! This is neither PlaceIR nor a device pack. Native targets read float
//! vertices and source pixels here; only the Vita writer emits Vita layouts.
use crate::{geometry::Vertex, Blobs};
use pocket3d_place as pc;

pub struct Scene {
    pub meta: pc::Meta,
    /// Target analysis already included direct sun in static irradiance, before LODs.
    pub baked_sun: bool,
    pub(crate) blobs: Blobs,
}
impl Scene {
    pub fn vertex(&self, draw: &pc::Draw, index: usize) -> &Vertex {
        &self.blobs.meshes[draw.vertices.offset as usize][index]
    }
    pub fn geometry(&self) -> &[u8] {
        &self.blobs.geom
    }
    pub fn textures(&self) -> &[u8] {
        &self.blobs.tex
    }
    pub fn animation(&self) -> &[u8] {
        &self.blobs.anim
    }
}
