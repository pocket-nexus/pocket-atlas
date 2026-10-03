//! Transient output of shared scene analysis, lighting and LOD passes.
//! This is neither PlaceIR nor a device pack. Native targets read float
//! vertices and source pixels here; only the Vita writer emits Vita layouts.
use crate::{geometry::Vertex, Blobs};
use pocket3d_place as pc;

pub struct Scene {
    pub meta: pc::Meta,
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

/// Authored texture boundaries, retained before any device encoding.
#[derive(Clone, Copy)]
pub struct TexturePolicy {
    pub cells: (u32, u32),
    pub max_mips: u32,
}
impl Default for TexturePolicy {
    fn default() -> Self {
        Self {
            cells: (1, 1),
            max_mips: 32,
        }
    }
}
impl Scene {
    pub fn texture_policy(&self, index: usize) -> TexturePolicy {
        self.blobs
            .texture_policy
            .get(&(index as u32))
            .copied()
            .unwrap_or_default()
    }
}
