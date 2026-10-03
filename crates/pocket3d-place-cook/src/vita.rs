//! Vita pack lowering. Device layouts and quantization live here.
use crate::{artifact::Artifact, profile::Profile};
use crate::{geometry::Vertex, source, textures};
use glam::{Vec2, Vec3};
use pocket3d_place as pc;

pub struct Built {
    pub vertices: Vec<u8>,
    pub indices: Vec<u8>,
    pub index_count: u32,
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
fn encode_mesh(
    verts: &[Vertex],
    tris: &[[u32; 3]],
    layout: pocket3d_place::VertexLayout,
    lods: Vec<(Vec<[u32; 3]>, f32)>,
) -> Built {
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
        out.extend([
            s8n(v.tangent[0]) as u8,
            s8n(v.tangent[1]) as u8,
            s8n(v.tangent[2]) as u8,
            s8n(v.tangent[3]) as u8,
        ]);
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
    Built {
        vertices: out,
        indices: u16_indices(&tris.to_vec()),
        index_count: (tris.len() * 3) as u32,
        lods: lods
            .into_iter()
            .map(|(t, e)| (u16_indices(&t), (t.len() * 3) as u32, e))
            .collect(),
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
    fn floats(buf: &mut Vec<u8>, data: impl IntoIterator<Item = f32>) -> pc::Range {
        let data: Vec<u8> = data.into_iter().flat_map(f32::to_le_bytes).collect();
        Self::push(buf, &data, 16)
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
        let (vertices, indices, index_count, lods, pos_offset, pos_scale, uv_offset, uv_scale) =
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
                    let vertices = Blobs::push(&mut blobs.geom, &b.vertices, 16);
                    let indices = Blobs::push(&mut blobs.geom, &b.indices, 16);
                    let lods = b
                        .lods
                        .iter()
                        .map(|(data, count, error)| pc::DrawLod {
                            indices: Blobs::push(&mut blobs.geom, data, 16),
                            index_count: *count,
                            error: *error,
                        })
                        .collect();
                    (
                        vertices,
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
            vertex_count: d.vertex_count(),
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
                .map(|t| Blobs::floats(&mut blobs.anim, t.iter().flatten().copied())),
        })
        .collect();
    let skins = scene
        .skins
        .iter()
        .map(|s| pc::Skin {
            joints: s.joints.clone(),
            inverse_bind: Blobs::floats(&mut blobs.anim, s.inverse_bind.iter().flatten().copied()),
        })
        .collect();
    let fog_tracks = scene
        .fog_tracks
        .iter()
        .map(|t| pc::FogTrack {
            data: Blobs::floats(&mut blobs.anim, t.samples.iter().flatten().copied()),
        })
        .collect();
    let material_tracks = scene
        .material_tracks
        .iter()
        .map(|t| pc::MaterialTrack {
            data: Blobs::floats(&mut blobs.anim, t.samples.iter().copied()),
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
        bytes: pack, summary: stats,
        sections: [("META",meta_json.len()),("TEXD",blobs.tex.len()),("GEOM",blobs.geom.len()),("ANIM",blobs.anim.len())].into_iter().map(|(k,v)|(k.into(),v)).collect(),
        textures: meta.textures.iter().enumerate().map(|(id,t)|serde_json::json!({"id":id,"name":t.name,"width":t.width,"height":t.height,"levels":t.mips,"bytes":t.data.size,"format":t.format})).collect(),
    })
}
