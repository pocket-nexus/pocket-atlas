//! A cooked place pack on the GPU (`vita/src/scene.rs`): its textures, its
//! geometry in one buffer, its animation tracks, and the state of its nodes,
//! lights and fog lights at a moment of its loop.
//!
//! The pack is read through PocketJS's `Source`, a range at a time: the
//! section table, `META`, the geometry and the animation, then one texture
//! after another, each handed to the GPU as it arrives.

use std::ops::Range;

use glam::{Mat4, Quat, Vec3};
use pocket3d_place as pc;
use pocket_web_wgpu::gpu::Gpu;
use pocket_web_wgpu::source::Source;
use pocket_web_wgpu::wgpu;

use super::programs::Layout;

pub struct DrawGpu {
    pub vertices: Range<u64>,
    pub indices: Range<u64>,
    pub count: u32,
    pub layout: Layout,
    /// Coarser index lists over the same vertices, finest first: (indices, count, error in metres).
    pub lods: Vec<(Range<u64>, u32, f32)>,
    pub material: u32,
    /// Dequantisation: position = q x scale + offset.
    pub dequant: [f32; 8],
    pub uv: [f32; 4],
    pub min: Vec3,
    pub max: Vec3,
    pub node: Option<u32>,
    pub skin: Option<u32>,
    pub no_reflect: bool,
    pub cast_shadow: bool,
}

/// Light state for one frame, in the programs' generic form.
#[derive(Clone, Copy, Default)]
pub struct LightNow {
    pub pos: Vec3,
    pub inv_range: f32,
    pub color: Vec3,
    pub spot_offset: f32,
    pub dir: Vec3,
    pub spot_scale: f32,
    pub right: Vec3,
    pub half_w: f32,
    pub up: Vec3,
    pub half_h: f32,
    /// Bounding radius for culling.
    pub reach: f32,
    pub power: f32,
    /// Attached to a moving node: never part of the baked vertex lighting.
    pub dynamic: bool,
}

#[derive(Clone, Copy, Default)]
pub struct FogNow {
    pub pos: Vec3,
    pub radius: f32,
    pub color: Vec3,
    pub cos_outer: f32,
    pub dir: Vec3,
    pub cos_inner: f32,
    pub gain: f32,
}

pub struct Scene {
    pub meta: pc::Meta,
    /// One view a texture of the pack; a 1 x 1 stand-in until its texels have arrived.
    pub textures: Vec<wgpu::TextureView>,
    pub geometry: wgpu::Buffer,
    pub draws: Vec<DrawGpu>,
    pub anim: Vec<f32>,
    pub node_world: Vec<Mat4>,
    pub lights: Vec<LightNow>,
    pub fog: Vec<FogNow>,
    pub emissive_gain: Vec<f32>,
    pub door_open: f32,
    pub bytes_tex: u64,
    pub bytes_geom: u64,
    /// Requests made and bytes received to read it.
    pub read: (u32, u64),
}

/// The sentence for a GPU that cannot sample the packs' textures.
pub const NEEDS_BC: &str = "Places need a desktop browser for now.";

fn format(f: pc::TexFormat) -> (wgpu::TextureFormat, u32, u32) {
    // (the format, the side of a block in texels, the bytes of a block)
    match f {
        pc::TexFormat::Rgba8 => (wgpu::TextureFormat::Rgba8Unorm, 1, 4),
        pc::TexFormat::Bc1 => (wgpu::TextureFormat::Bc1RgbaUnorm, 4, 8),
        pc::TexFormat::Bc3 => (wgpu::TextureFormat::Bc3RgbaUnorm, 4, 16),
        pc::TexFormat::Bc5 => (wgpu::TextureFormat::Bc5RgUnorm, 4, 16),
        pc::TexFormat::Rgba16f => (wgpu::TextureFormat::Rgba16Float, 1, 8),
    }
}

/// Bytes of the levels of a texture, largest first.
pub fn level_bytes(t: &pc::Texture) -> Vec<(u32, u32, u64)> {
    let (_, block, bytes) = format(t.format);
    (0..t.mips).map(|level| {
        let (w, h) = ((t.width >> level).max(1), (t.height >> level).max(1));
        (w, h, (w.div_ceil(block) as u64) * (h.div_ceil(block) as u64) * bytes as u64)
    }).collect()
}

/// A texture of the pack on the GPU, from its bytes in `TEXD`.
pub fn texture(gpu: &Gpu, t: &pc::Texture, data: &[u8]) -> Result<wgpu::TextureView, String> {
    let (format, block, bytes) = format(t.format);
    let levels = level_bytes(t);
    if levels.iter().map(|l| l.2).sum::<u64>() != data.len() as u64 {
        return Err(format!("texture {}: {} bytes for {} levels of {} by {}", t.name, data.len(), t.mips, t.width, t.height));
    }
    if block > 1 && (t.width % block != 0 || t.height % block != 0) {
        return Err(format!("texture {}: {} by {} is not whole blocks", t.name, t.width, t.height));
    }
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(&t.name),
        size: wgpu::Extent3d { width: t.width, height: t.height, depth_or_array_layers: 1 },
        mip_level_count: t.mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut at = 0usize;
    for (level, (w, h, size)) in levels.into_iter().enumerate() {
        // A level smaller than a block is written as the block that holds it.
        let (across, down) = (w.div_ceil(block), h.div_ceil(block));
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: level as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &data[at..at + size as usize],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(across * bytes), rows_per_image: Some(down) },
            wgpu::Extent3d { width: across * block, height: down * block, depth_or_array_layers: 1 },
        );
        at += size as usize;
    }
    Ok(texture.create_view(&wgpu::TextureViewDescriptor::default()))
}

/// One texel of one colour, for a texture a material does not have or whose texels have not arrived.
pub fn texel(gpu: &Gpu, rgba: [u8; 4]) -> wgpu::TextureView {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("texel"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(texture.as_image_copy(), &rgba, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) }, wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 });
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

/// What a texture stands for until its texels arrive: its mean, as its role stores it.
fn stand_in(gpu: &Gpu, t: &pc::Texture) -> wgpu::TextureView {
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    texel(gpu, match t.role {
        // (a flat normal; an environment that lights nothing yet)
        pc::TexRole::Normal => [128, 128, 255, 255],
        pc::TexRole::Environment => [0, 0, 0, 255],
        _ => [byte(t.mean[0]), byte(t.mean[1]), byte(t.mean[2]), if t.has_alpha { byte(t.mean[3]) } else { 255 }],
    })
}

/// A pack whose table and `META` have been read: what is needed to say what the place is.
pub struct Head {
    pub meta: pc::Meta,
    sections: Vec<pc::Section>,
}

fn find(sections: &[pc::Section], tag: [u8; 4]) -> Result<pc::Section, String> {
    sections.iter().copied().find(|s| s.tag == tag).ok_or_else(|| pc::Error::Missing(tag).to_string())
}

impl Head {
    pub async fn read(pack: &Source) -> Result<Head, String> {
        let length = pack.length().await?;
        let table = pack.range(0, length.min(16 + 16 * 8)).await?;
        let sections = pc::Pack::parse_header(&table).map_err(|e| e.to_string())?;
        let m = find(&sections, pc::TAG_META)?;
        let meta: pc::Meta = serde_json::from_slice(&pack.range(m.offset as u64, m.size as u64).await?).map_err(|e| format!("META: {e}"))?;
        if meta.skins.iter().any(|s| s.joints.is_empty() || s.joints.len() > 24 || s.inverse_bind.size as usize != s.joints.len() * 64) {
            return Err("skin must contain 1..24 joints and one inverse bind matrix per joint".into());
        }
        Ok(Head { meta, sections })
    }

    /// Bytes of the pack a first frame needs: the table, `META`, the geometry and the animation.
    pub fn first_frame(&self) -> u64 {
        let size = |tag| find(&self.sections, tag).map_or(0, |s| s.size as u64);
        16 + 16 * self.sections.len() as u64 + size(pc::TAG_META) + size(pc::TAG_GEOMETRY) + size(pc::TAG_ANIMATION)
    }

    /// Where a texture's bytes are in the pack.
    pub fn texels(&self, index: usize) -> Result<(u64, u64), String> {
        let s = find(&self.sections, pc::TAG_TEXTURES)?;
        let t = &self.meta.textures[index];
        Ok((s.offset as u64 + t.data.offset as u64, t.data.size as u64))
    }
}

impl Scene {
    /// The place without its textures' texels: the geometry and the animation on the GPU, every texture a
    /// stand-in of its mean colour. [`Scene::arrive`] replaces them as their texels come.
    pub async fn open(gpu: &Gpu, pack: &Source, head: &Head) -> Result<Scene, String> {
        if !gpu.features.contains(wgpu::Features::TEXTURE_COMPRESSION_BC) && head.meta.textures.iter().any(|t| matches!(t.format, pc::TexFormat::Bc1 | pc::TexFormat::Bc3 | pc::TexFormat::Bc5)) {
            return Err(NEEDS_BC.into());
        }
        let meta = head.meta.clone();
        let (g, a) = (find(&head.sections, pc::TAG_GEOMETRY)?, find(&head.sections, pc::TAG_ANIMATION)?);
        let geometry_bytes = pack.range(g.offset as u64, g.size as u64).await?;
        // Vertices and indices are ranges of one buffer, as they are of the pack's section.
        let geometry = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("place geometry"), size: (g.size as u64).next_multiple_of(4).max(4), usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let whole = geometry_bytes.len() / 4 * 4;
        gpu.queue.write_buffer(&geometry, 0, &geometry_bytes[..whole]);
        if whole < geometry_bytes.len() {
            let mut last = [0u8; 4];
            last[..geometry_bytes.len() - whole].copy_from_slice(&geometry_bytes[whole..]);
            gpu.queue.write_buffer(&geometry, whole as u64, &last);
        }
        drop(geometry_bytes);
        let anim: Vec<f32> = pack.range(a.offset as u64, a.size as u64).await?.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();

        let mut draws = Vec::with_capacity(meta.draws.len());
        for d in &meta.draws {
            let layout = match d.layout {
                pc::VertexLayout::Static => Layout::Static,
                pc::VertexLayout::Skinned => Layout::Skinned,
                pc::VertexLayout::Baked => Layout::Baked,
                pc::VertexLayout::Lights => Layout::Lights,
            };
            let range = |r: &pc::Range| r.offset as u64..r.offset as u64 + r.size as u64;
            if d.vertices.offset % 4 != 0 || d.indices.offset % 2 != 0 || d.lods.iter().any(|l| l.indices.offset % 2 != 0) {
                return Err("a draw's vertices or indices do not start on a whole word".into());
            }
            draws.push(DrawGpu {
                vertices: range(&d.vertices),
                indices: range(&d.indices),
                count: if layout == Layout::Lights { d.vertex_count } else { d.index_count },
                layout,
                lods: d.lods.iter().map(|l| (range(&l.indices), l.index_count, l.error)).collect(),
                material: d.material,
                dequant: [d.pos_scale[0], d.pos_scale[1], d.pos_scale[2], 0.0, d.pos_offset[0], d.pos_offset[1], d.pos_offset[2], 0.0],
                uv: [d.uv_scale[0], d.uv_scale[1], d.uv_offset[0], d.uv_offset[1]],
                min: Vec3::from(d.min),
                max: Vec3::from(d.max),
                node: d.node,
                skin: d.skin,
                no_reflect: d.no_reflect,
                cast_shadow: d.cast_shadow,
            });
        }
        let textures = meta.textures.iter().map(|t| stand_in(gpu, t)).collect();
        let read = pack.read_so_far();
        let mut scene = Scene {
            node_world: vec![Mat4::IDENTITY; meta.nodes.len()],
            lights: vec![LightNow::default(); meta.lights.len()],
            fog: vec![FogNow::default(); meta.fog_lights.len()],
            emissive_gain: vec![1.0; meta.materials.len()],
            door_open: 0.0,
            textures,
            geometry,
            draws,
            anim,
            bytes_tex: 0,
            bytes_geom: g.size as u64,
            read: (read.requests, read.bytes),
            meta,
        };
        scene.update(0.0);
        Ok(scene)
    }

    /// A texture's texels have arrived.
    pub fn arrive(&mut self, gpu: &Gpu, index: usize, data: &[u8]) -> Result<(), String> {
        self.textures[index] = texture(gpu, &self.meta.textures[index], data)?;
        self.bytes_tex += data.len() as u64;
        Ok(())
    }

    fn track(&self, r: &pc::Range, stride: usize, frame: f32, out: &mut [f32]) {
        let base = r.offset as usize / 4;
        let frames = (r.size as usize / 4) / stride;
        if frames == 0 {
            return;
        }
        let f0 = (frame.floor() as usize) % frames;
        let f1 = (f0 + 1) % frames;
        let t = frame.fract();
        for k in 0..stride {
            let a = self.anim[base + f0 * stride + k];
            let b = self.anim[base + f1 * stride + k];
            out[k] = a + (b - a) * t;
        }
    }

    /// Advances animation, doors, lights and fog lights to `time` seconds.
    pub fn update(&mut self, time: f32) {
        let frames = self.meta.frames.max(1) as f32;
        let frame = (time * self.meta.fps).rem_euclid(frames);
        let door = self.meta.doors.as_ref().map(|d| (d.left, d.right, d.travel));
        for i in 0..self.meta.nodes.len() {
            let node = &self.meta.nodes[i];
            let mut t = Vec3::from(node.translation);
            let mut r = Quat::from_array(node.rotation);
            if let Some(track) = &node.track {
                let mut v = [0.0f32; 7];
                self.track(track, 7, frame, &mut v);
                t = Vec3::new(v[0], v[1], v[2]);
                r = Quat::from_xyzw(v[3], v[4], v[5], v[6]).normalize();
            }
            if let Some((l, rt, travel)) = door {
                if i as u32 == l {
                    t.x -= self.door_open * travel;
                } else if i as u32 == rt {
                    t.x += self.door_open * travel;
                }
            }
            let local = Mat4::from_scale_rotation_translation(Vec3::from(node.scale), r, t);
            self.node_world[i] = match node.parent {
                Some(p) => self.node_world[p as usize] * local,
                None => local,
            };
        }

        for (i, l) in self.meta.lights.iter().enumerate() {
            let (pos, dir) = match l.node {
                Some(n) => {
                    let m = self.node_world[n as usize];
                    (m.transform_point3(Vec3::ZERO), m.transform_vector3(Vec3::NEG_Z).normalize_or_zero())
                }
                None => (Vec3::from(l.position), Vec3::from(l.direction)),
            };
            let color = Vec3::from(l.color);
            let mut now = LightNow { pos, color, dir, inv_range: if l.range > 0.0 { 1.0 / l.range } else { 0.0 }, ..Default::default() };
            let power = color.max_element();
            match l.kind {
                pc::LightKind::Point => {
                    now.spot_scale = 0.0;
                    now.spot_offset = 1.0;
                }
                pc::LightKind::Spot => {
                    let span = (l.cos_inner - l.cos_outer).max(1e-4);
                    now.spot_scale = 1.0 / span;
                    now.spot_offset = -l.cos_outer / span;
                }
                pc::LightKind::Rect => {
                    // Lambertian panel: radiant intensity = luminance x area along the normal.
                    let right = Vec3::from(l.right).normalize_or(Vec3::Y.cross(dir).normalize_or(Vec3::X));
                    now.right = right;
                    now.up = dir.cross(right).normalize_or(Vec3::Y);
                    now.half_w = l.size[0] * 0.5;
                    now.half_h = l.size[1] * 0.5;
                    now.color = color * (l.size[0] * l.size[1]);
                    now.spot_scale = 1.0;
                    now.spot_offset = 0.0;
                }
            }
            // Where irradiance drops to about 0.002 (a dark wet street's visible floor).
            let p = now.color.max_element();
            now.reach = if l.range > 0.0 { l.range } else { (p / 0.002).sqrt().min(60.0) };
            now.power = power;
            now.dynamic = l.node.is_some();
            self.lights[i] = now;
        }
        // A car's two headlights (moving spots a lamp-width apart with the same colour and aim) light as
        // one spot at their midpoint, as on the PS Vita. The volumetric beams stay two (fog lights).
        for i in 0..self.lights.len() {
            let a = self.lights[i];
            if !a.dynamic || a.spot_scale == 0.0 || a.power <= 0.0 {
                continue;
            }
            for j in i + 1..self.lights.len() {
                let b = self.lights[j];
                if b.dynamic && b.power > 0.0 && b.spot_scale == a.spot_scale && b.color == a.color && a.dir.dot(b.dir) > 0.99 && a.pos.distance(b.pos) < 2.0 {
                    self.lights[i].pos = (a.pos + b.pos) * 0.5;
                    self.lights[i].color = a.color * 2.0;
                    self.lights[i].power = a.power * 2.0;
                    self.lights[j].color = Vec3::ZERO;
                    self.lights[j].power = 0.0;
                    break;
                }
            }
        }

        for (i, fl) in self.meta.fog_lights.iter().enumerate() {
            let mut pos = Vec3::from(fl.position);
            let mut gain = 1.0;
            if let Some(t) = fl.track {
                let mut v = [0.0f32; 4];
                let r = self.meta.fog_tracks[t as usize].data.clone();
                self.track(&r, 4, frame, &mut v);
                pos = Vec3::new(v[0], v[1], v[2]);
                gain = v[3];
            }
            let (dir, co, ci) = match fl.spot {
                Some((d, co, ci)) => (Vec3::from(d), co, ci),
                None => (Vec3::NEG_Y, -2.0, 1.0),
            };
            self.fog[i] = FogNow { pos, radius: fl.radius, color: Vec3::from(fl.color) * fl.intensity, cos_outer: co, dir, cos_inner: ci, gain };
        }

        for (i, m) in self.meta.materials.iter().enumerate() {
            if let Some(t) = m.emissive_track {
                let mut v = [1.0f32];
                let r = self.meta.material_tracks[t as usize].data.clone();
                self.track(&r, 1, frame, &mut v);
                self.emissive_gain[i] = v[0];
            }
        }
    }

    /// Rows of a draw's world transform (the identity for baked geometry).
    pub fn model_rows(&self, d: &DrawGpu) -> [f32; 12] {
        rows3x4(&d.node.map_or(Mat4::IDENTITY, |n| self.node_world[n as usize]))
    }

    /// Joint rows (three a joint) for a skinned draw.
    pub fn bone_rows(&self, skin: u32, out: &mut Vec<f32>) {
        out.clear();
        let s = &self.meta.skins[skin as usize];
        let base = s.inverse_bind.offset as usize / 4;
        for (j, &node) in s.joints.iter().enumerate() {
            let ibm = Mat4::from_cols_slice(&self.anim[base + j * 16..base + j * 16 + 16]);
            out.extend_from_slice(&rows3x4(&(self.node_world[node as usize] * ibm)));
        }
    }

    /// World bounds of a draw this frame.
    pub fn bounds(&self, d: &DrawGpu) -> (Vec3, Vec3) {
        if let Some(n) = d.node {
            let m = self.node_world[n as usize];
            // Local bounds from the dequantisation box, transformed conservatively.
            let c = Vec3::new(d.dequant[4], d.dequant[5], d.dequant[6]);
            let e = Vec3::new(d.dequant[0], d.dequant[1], d.dequant[2]);
            let wc = m.transform_point3(c);
            let we = m.x_axis.truncate().abs() * e.x + m.y_axis.truncate().abs() * e.y + m.z_axis.truncate().abs() * e.z;
            (wc - we, wc + we)
        } else if let Some(skin) = d.skin {
            // The union of every joint-transformed bind box contains all nonnegative weighted blends.
            let s = &self.meta.skins[skin as usize];
            let base = s.inverse_bind.offset as usize / 4;
            let c = (d.min + d.max) * 0.5;
            let e = (d.max - d.min) * 0.5;
            let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
            for (j, &node) in s.joints.iter().enumerate() {
                let ibm = Mat4::from_cols_slice(&self.anim[base + j * 16..base + j * 16 + 16]);
                let m = self.node_world[node as usize] * ibm;
                let wc = m.transform_point3(c);
                let we = m.x_axis.truncate().abs() * e.x + m.y_axis.truncate().abs() * e.y + m.z_axis.truncate().abs() * e.z;
                lo = lo.min(wc - we);
                hi = hi.max(wc + we);
            }
            (lo, hi)
        } else {
            (d.min, d.max)
        }
    }
}

pub fn rows3x4(m: &Mat4) -> [f32; 12] {
    let r = m.transpose();
    let (a, b, c) = (r.x_axis, r.y_axis, r.z_axis);
    [a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, c.x, c.y, c.z, c.w]
}
