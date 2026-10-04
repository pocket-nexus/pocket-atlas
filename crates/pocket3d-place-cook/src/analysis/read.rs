//! Sealed source loading; owns glTF storage borrowed by later passes.
use super::*;

pub(super) struct Source {
    pub doc: gltf::Document,
    pub buffers: Vec<gltf::buffer::Data>,
    pub images: Vec<gltf::image::Data>,
    pub sx: Value,
}
pub(super) fn run(a: &Args) -> crate::recipe::Output<Source> {
    let t0 = Instant::now();
    let glb = a.input.join("scene.gltf");
    // EXT_mesh_gpu_instancing is listed as required; the crate does not know
    // it, so skip validation and expand instances here.
    let bytes = std::fs::read(&glb).unwrap_or_else(|e| panic!("{}: {e}", glb.display()));
    let gltf::Gltf { document: doc, blob } = gltf::Gltf::from_slice_without_validation(&bytes).unwrap_or_else(|e| panic!("{}: {e}", glb.display()));
    let buffers = gltf::import_buffers(&doc, Some(&a.input), blob).expect("buffers");
    let images = gltf::import_images(&doc, Some(&a.input), &buffers).expect("images");
    crate::progress!("loaded {} ({} nodes, {} images) in {} ms", glb.display(), doc.nodes().count(), images.len(), t0.elapsed().as_millis());
    let sx = pc_of(doc.default_scene().or_else(|| doc.scenes().next()).expect("scene").extras());

    let decision = json!({"nodes":doc.nodes().count(),"images":images.len()});
    crate::recipe::Output::new(Source { doc, buffers, images, sx }, decision)
}

