//! Vita pack lowering. Device layouts and quantization live here.
use crate::{artifact::Artifact, profile::Profile};
use crate::{geometry::Vertex, source, textures};
use glam::{Vec2, Vec3};
use pocket3d_place as pc;
use std::{collections::HashMap, hash::{Hash, Hasher}};
use crate::geometry::cache_order;

pub struct Built {
    pub vertices: Vec<u8>,
    pub indices: Vec<u8>,
    pub index_count: u32,
    pub vertex_count: u32,
    /// Coarser index lists over the same vertices (LOD1, LOD2), each with
    /// its error from the full mesh (m).
    pub lods: Vec<(Vec<u8>, u32, f32)>,
    pub pos_offset: [f32; 3],
    pub pos_scale: [f32; 3],
    pub uv_offset: [f32; 2],
    pub uv_scale: [f32; 2],
}

fn s16n(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32767.0).round() as i16
}
fn s8n(v: f32) -> i8 {
    (v.clamp(-1.0, 1.0) * 127.0).round() as i8
}

fn u16_indices(tris: &[[u32; 3]]) -> Vec<u8> {
    let mut idx = Vec::with_capacity(tris.len() * 6);
    for t in tris {
        for &i in t {
            idx.extend((i as u16).to_le_bytes());
        }
    }
    idx
}

/// Quantizes one draw (≤ 65 536 unique vertices) into the Static (24 B),
/// Baked (28 B) or Skinned (32 B) layout. `lods`: reduced triangles over the
/// same vertices and their errors, finest first.
fn encode_mesh(verts: &[Vertex], tris: &[[u32; 3]], layout: pocket3d_place::VertexLayout, lods: Vec<(Vec<[u32; 3]>, f32)>) -> Built {
    let skinned = layout == pocket3d_place::VertexLayout::Skinned;
    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);
    let mut uvmin = Vec2::splat(f32::MAX);
    let mut uvmax = Vec2::splat(f32::MIN);
    for v in verts {
        min = min.min(v.pos);
        max = max.max(v.pos);
        uvmin = uvmin.min(v.uv);
        uvmax = uvmax.max(v.uv);
    }
    let center = (min + max) * 0.5;
    let half = ((max - min) * 0.5).max(Vec3::splat(1e-4));
    let uvc = (uvmin + uvmax) * 0.5;
    let uvh = ((uvmax - uvmin) * 0.5).max(Vec2::splat(1e-5));
    let stride = layout.stride() as usize;
    let mut out = Vec::with_capacity(verts.len() * stride);
    for v in verts {
        let q = (v.pos - center) / half;
        for c in [q.x, q.y, q.z, 0.0] {
            out.extend(s16n(c).to_le_bytes());
        }
        let n = v.normal.normalize_or_zero();
        out.extend([s8n(n.x) as u8, s8n(n.y) as u8, s8n(n.z) as u8, 0]);
        out.extend([s8n(v.tangent[0]) as u8, s8n(v.tangent[1]) as u8, s8n(v.tangent[2]) as u8, s8n(v.tangent[3]) as u8]);
        let u = (v.uv - uvc) / uvh;
        out.extend(s16n(u.x).to_le_bytes());
        out.extend(s16n(u.y).to_le_bytes());
        out.extend(v.color);
        if layout == pocket3d_place::VertexLayout::Baked {
            out.extend(v.light);
        }
        if skinned {
            out.extend(v.joints);
            out.extend(v.weights);
        }
    }
    // Quantization makes some distinct source floats identical on the GPU
    // (notably tangents recomputed independently for triangle soup). Dedup
    // the complete packed record only after its bounds are fixed, so this
    // step changes neither decoded attributes nor quantization precision.
    let mut unique: HashMap<&[u8], u32> = HashMap::new();
    let mut packed = Vec::with_capacity(out.len());
    let remap: Vec<u32> = out.chunks_exact(stride).map(|bytes| {
        *unique.entry(bytes).or_insert_with(|| {
            let i = (packed.len() / stride) as u32;
            packed.extend_from_slice(bytes);
            i
        })
    }).collect();
    let remap_tris = |ts: &[[u32; 3]]| -> Vec<[u32; 3]> {
        ts.iter().map(|t| t.map(|i| remap[i as usize])).collect()
    };
    let vertex_count = (packed.len() / stride) as u32;
    Built {
        vertices: packed,
        indices: u16_indices(&cache_order(&remap_tris(tris), vertex_count as usize)),
        vertex_count,
        index_count: (tris.len() * 3) as u32,
        lods: lods.into_iter().map(|(t, e)| (u16_indices(&cache_order(&remap_tris(&t), vertex_count as usize)), (t.len() * 3) as u32, e)).collect(),
        pos_offset: center.to_array(),
        pos_scale: half.to_array(),
        uv_offset: uvc.to_array(),
        uv_scale: uvh.to_array(),
    }
}


#[derive(Default)]
struct Blobs {
    tex: Vec<u8>,
    geom: Vec<u8>,
    anim: Vec<u8>,
    geom_ranges: HashMap<u64, Vec<pc::Range>>,
    anim_ranges: HashMap<u64, Vec<pc::Range>>,
}
impl Blobs {
    fn push(buf: &mut Vec<u8>, data: &[u8], align: usize) -> pc::Range {
        buf.resize(buf.len().div_ceil(align) * align, 0);
        let offset = u32::try_from(buf.len()).expect("Vita section offset overflow");
        buf.extend_from_slice(data);
        pc::Range {
            offset,
            size: u32::try_from(data.len()).expect("Vita section size overflow"),
        }
    }
    // Quantized draws separate their per-draw decode transform from buffer
    // bytes, so repeated geometry (or animation) may share an aligned range.
    // Hashes only find candidates: compare bytes to make collisions harmless.
    fn intern(buf: &mut Vec<u8>, ranges: &mut HashMap<u64, Vec<pc::Range>>, data: &[u8]) -> pc::Range {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        data.hash(&mut h);
        let entries = ranges.entry(h.finish()).or_default();
        if let Some(r) = entries.iter().find(|r| &buf[r.offset as usize..(r.offset + r.size) as usize] == data) {
            return r.clone();
        }
        let range = Self::push(buf, data, 16);
        entries.push(range.clone());
        range
    }
    fn geometry(&mut self, data: &[u8]) -> pc::Range {
        Self::intern(&mut self.geom, &mut self.geom_ranges, data)
    }
    fn animation(&mut self, data: impl IntoIterator<Item=f32>) -> pc::Range {
        let bytes: Vec<u8> = data.into_iter().flat_map(|v| v.to_le_bytes()).collect();
        Self::intern(&mut self.anim, &mut self.anim_ranges, &bytes)
    }
}

pub fn cook(scene: &source::Scene, profile: &Profile) -> Result<Artifact, String> {
    let mut blobs = Blobs::default();
    let mut textures = Vec::new();
    let counted_textures = scene.stats["textures"].as_u64().unwrap() as usize;
    let mut counted_texture_bytes = 0;
    for (i, t) in scene.textures.iter().enumerate() {
        if i == counted_textures {
            counted_texture_bytes = blobs.tex.len();
        }
        let enc = match &t.pixels {
            source::Pixels::Image { cells, .. } => {
                let cap = profile.vita_texture_cap(t);
                textures::encode_cells(&t.image(), t.role, cap, t.has_alpha, *cells)
            }
            source::Pixels::Lookup {
                image,
                channels,
                levels,
            } => {
                let format = match channels {
                    source::LookupChannels::Rgb => pc::TexFormat::Bc1,
                    source::LookupChannels::Rg => pc::TexFormat::Bc5,
                    source::LookupChannels::Rgba => pc::TexFormat::Rgba8,
                };
                textures::encode_as(image, t.role, format, 4096, *levels)
            }
            source::Pixels::Environment { rgba16f, levels } => textures::Encoded {
                format: pc::TexFormat::Rgba16f,
                width: t.width,
                height: t.height,
                mips: *levels,
                data: rgba16f.clone(),
            },
        };
        textures.push(pc::Texture {
            name: t.name.clone(),
            role: t.role,
            format: enc.format,
            width: enc.width,
            height: enc.height,
            mips: enc.mips,
            data: Blobs::push(&mut blobs.tex, &enc.data, 4096),
            wrap_s: t.wrap_s,
            wrap_t: t.wrap_t,
            has_alpha: t.has_alpha,
            mean: t.mean,
            lod_bias: t.lod_bias,
        });
    }
    if counted_textures == textures.len() {
        counted_texture_bytes = blobs.tex.len();
    }
    let mut draws = Vec::new();
    for d in &scene.draws {
        let layout = match d.class {
            source::VertexClass::Static => pc::VertexLayout::Static,
            source::VertexClass::Skinned => pc::VertexLayout::Skinned,
            source::VertexClass::Baked => pc::VertexLayout::Baked,
            source::VertexClass::Lights => pc::VertexLayout::Lights,
        };
        let (vertices, vertex_count, indices, index_count, lods, pos_offset, pos_scale, uv_offset, uv_scale) =
            match &d.geometry {
                source::Geometry::Triangles {
                    vertices,
                    indices,
                    lods,
                } => {
                    let triangles = |indices: &[u32]| {
                        indices
                            .chunks_exact(3)
                            .map(|t| [t[0], t[1], t[2]])
                            .collect::<Vec<_>>()
                    };
                    let b = encode_mesh(
                        vertices,
                        &triangles(indices),
                        layout,
                        lods.iter()
                            .map(|l| (triangles(&l.indices), l.error))
                            .collect(),
                    );
                    let vertices = blobs.geometry(&b.vertices);
                    let indices = blobs.geometry(&b.indices);
                    let lods = b
                        .lods
                        .iter()
                        .map(|(data, count, error)| pc::DrawLod {
                            indices: blobs.geometry(data),
                            index_count: *count,
                            error: *error,
                        })
                        .collect();
                    (
                        vertices,
                        b.vertex_count,
                        indices,
                        b.index_count,
                        lods,
                        b.pos_offset,
                        b.pos_scale,
                        b.uv_offset,
                        b.uv_scale,
                    )
                }
                source::Geometry::LightField(points) => {
                    let lo = points
                        .iter()
                        .fold(Vec3::splat(f32::MAX), |a, l| a.min(Vec3::from(l.position)));
                    let hi = points
                        .iter()
                        .fold(Vec3::splat(f32::MIN), |a, l| a.max(Vec3::from(l.position)));
                    let center = ((lo + hi) * 0.5).to_array();
                    let half = ((hi - lo) * 0.5).max(Vec3::splat(1e-3)).to_array();
                    let mut bytes = Vec::with_capacity(points.len() * pc::LIGHT_POINT_STRIDE);
                    for l in points {
                        pc::encode_light_point(l, center, half, &mut bytes);
                    }
                    (
                        Blobs::push(&mut blobs.geom, &bytes, 16),
                        points.len() as u32,
                        pc::Range::default(),
                        points.len() as u32,
                        Vec::new(),
                        center,
                        half,
                        [0.0; 2],
                        [1.0; 2],
                    )
                }
            };
        draws.push(pc::Draw {
            material: d.material,
            layout,
            vertices,
            vertex_count,
            indices,
            index_count,
            pos_offset,
            pos_scale,
            uv_offset,
            uv_scale,
            min: d.min,
            max: d.max,
            node: d.node,
            skin: d.skin,
            no_reflect: d.no_reflect,
            cast_shadow: d.cast_shadow,
            lods,
        });
    }
    let nodes = scene
        .nodes
        .iter()
        .map(|n| pc::Node {
            name: n.name.clone(),
            parent: n.parent,
            translation: n.translation,
            rotation: n.rotation,
            scale: n.scale,
            track: n
                .track
                .as_ref()
                .map(|t| blobs.animation( t.iter().flatten().copied())),
        })
        .collect();
    let skins = scene
        .skins
        .iter()
        .map(|s| pc::Skin {
            joints: s.joints.clone(),
            inverse_bind: blobs.animation( s.inverse_bind.iter().flatten().copied()),
        })
        .collect();
    let fog_tracks = scene
        .fog_tracks
        .iter()
        .map(|t| pc::FogTrack {
            data: blobs.animation( t.samples.iter().flatten().copied()),
        })
        .collect();
    let material_tracks = scene
        .material_tracks
        .iter()
        .map(|t| pc::MaterialTrack {
            data: blobs.animation( t.samples.iter().copied()),
        })
        .collect();
    let mut stats = scene.stats.clone();
    stats["textureBytes"] = counted_texture_bytes.into();
    stats["geometryBytes"] = blobs.geom.len().into();
    stats["animationBytes"] = blobs.anim.len().into();
    let meta = pc::Meta {
        version: pc::VERSION,
        name: scene.name.clone(),
        kind: scene.kind.clone(),
        min: scene.min,
        max: scene.max,
        textures,
        materials: scene.materials.clone(),
        draws,
        nodes,
        skins,
        lights: scene.lights.clone(),
        fog_lights: scene.fog_lights.clone(),
        fog_tracks,
        material_tracks,
        fps: scene.fps,
        frames: scene.frames,
        atmosphere: scene.atmosphere.clone(),
        rain: scene.rain.clone(),
        camera: scene.camera.clone(),
        doors: scene.doors.clone(),
        beacons: scene.beacons.clone(),
        effects: scene.effects.clone(),
        sun: scene.sun.clone(),
        day_sky: scene.day_sky.clone(),
        post: scene.post.clone(),
        vista_haze: scene.vista_haze.clone(),
        stats: stats.clone(),
    };
    let meta_json = serde_json::to_vec(&meta).unwrap();
    let pack = pc::write(&[
        (pc::TAG_META, &meta_json, 16),
        (pc::TAG_TEXTURES, &blobs.tex, 4096),
        (pc::TAG_GEOMETRY, &blobs.geom, 4096),
        (pc::TAG_ANIMATION, &blobs.anim, 16),
    ]);
    Ok(Artifact {
        sidecars: Vec::new(),
        bytes: pack, summary: stats,
        sections: [("META",meta_json.len()),("TEXD",blobs.tex.len()),("GEOM",blobs.geom.len()),("ANIM",blobs.anim.len())].into_iter().map(|(k,v)|(k.into(),v)).collect(),
        textures: meta.textures.iter().enumerate().map(|(id,t)|serde_json::json!({"id":id,"sourceTextures":[id],"sources":crate::provenance::texture_sources(scene,id),"name":t.name,"width":t.width,"height":t.height,"levels":t.mips,"bytes":t.data.size,"format":t.format})).collect(),
    })
}

#[cfg(test)]
mod packed_tests {
    use super::*;
    use crate::geometry::weld;
    use pc::VertexLayout;
    fn vertex(pos: Vec3) -> Vertex {
        Vertex {
            pos,
            normal: Vec3::Y,
            tangent: [1.0, 0.0, 0.0, 1.0],
            color: [255; 4],
            weights: [255, 0, 0, 0],
            ..Vertex::default()
        }
    }

    #[test]
    fn weld_indexes_triangle_soup_without_changing_packed_vertices() {
        let (a, b, c) = (vertex(Vec3::ZERO), vertex(Vec3::X), vertex(Vec3::Z));
        let input = [a, b, c, a, b, c, vertex(Vec3::splat(100.0))];
        let tris = [[0, 1, 2], [3, 4, 5]];
        let (verts, indexed) = weld(&input, &tris);
        assert_eq!(verts.len(), 3);
        assert_eq!(indexed, [[0, 1, 2], [0, 1, 2]]);
        // Across every packed layout, the indexed stream fetches exactly the
        // bytes the original soup did. Ignore its unreferenced seventh vertex.
        for layout in [VertexLayout::Static, VertexLayout::Baked, VertexLayout::Skinned] {
            let old = encode_mesh(&input[..6], &tris, layout, Vec::new());
            let new = encode_mesh(&verts, &indexed, layout, Vec::new());
            let stride = layout.stride() as usize;
            for (before, after) in old.indices.chunks_exact(2).zip(new.indices.chunks_exact(2)) {
                let before = u16::from_le_bytes(before.try_into().unwrap()) as usize;
                let after = u16::from_le_bytes(after.try_into().unwrap()) as usize;
                assert_eq!(
                    &old.vertices[before * stride..(before + 1) * stride],
                    &new.vertices[after * stride..(after + 1) * stride],
                );
            }
        }
    }

    #[test]
    fn packed_weld_merges_only_gpu_identical_attributes_and_remaps_lods() {
        let a = vertex(Vec3::ZERO);
        let mut tangent_noise = a;
        tangent_noise.tangent[2] = 0.000001;
        let mut other_joint = a;
        other_joint.joints[0] = 1;
        let verts = [a, vertex(Vec3::X), vertex(Vec3::Z), tangent_noise, other_joint];
        let tris = [[0, 1, 2], [3, 1, 2], [4, 1, 2]];
        let b = encode_mesh(&verts, &tris, VertexLayout::Skinned, vec![(vec![[3, 1, 2], [4, 1, 2]], 0.06)]);
        assert_eq!(b.vertex_count, 4);
        assert_eq!(b.index_count, 9);
        let lod_indices: Vec<u16> = b.lods[0].0.chunks_exact(2).map(|i| u16::from_le_bytes(i.try_into().unwrap())).collect();
        assert_eq!(lod_indices, [0, 1, 2, 3, 1, 2]);
        // Joint index is the first byte following the 24-byte rigid layout.
        assert_eq!(b.vertices[24], 0);
        assert_eq!(b.vertices[3 * 32 + 24], 1);
    }

}

#[cfg(test)]
mod blob_tests {
    use super::*;

    #[test]
    fn identical_geometry_and_animation_share_aligned_ranges() {
        let mut b = Blobs::default();
        let first = b.geometry(&[1, 2, 3]);
        let other = b.geometry(&[4, 5, 6]);
        let same = b.geometry(&[1, 2, 3]);
        assert_eq!((first.offset, first.size), (same.offset, same.size));
        assert_eq!(other.offset, 16);
        assert_eq!(b.geom.len(), 19);
        assert_eq!(&b.geom[other.offset as usize..][..3], &[4, 5, 6]);
        let a = b.animation([1.0, 2.0, 3.0]);
        let c = b.animation([1.0, 2.0, 3.0]);
        assert_eq!((a.offset, a.size), (c.offset, c.size));
        assert_eq!(b.anim.len(), 12);
        // Sharing must not cross the independent GEOM and ANIM sections.
        assert_eq!(a.offset, 0);
    }

    #[test]
    fn hash_collision_cannot_alias_different_buffer_contents() {
        let mut buf = vec![1, 2, 3];
        let mut h = std::collections::hash_map::DefaultHasher::new();
        [4u8, 5, 6].as_slice().hash(&mut h);
        let mut ranges = HashMap::from([(h.finish(), vec![pc::Range { offset: 0, size: 3 }])]);
        let r = Blobs::intern(&mut buf, &mut ranges, &[4, 5, 6]);
        assert_eq!(r.offset, 16);
        assert_eq!(&buf[r.offset as usize..][..3], &[4, 5, 6]);
    }
}
