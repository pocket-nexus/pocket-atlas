//! A cooked place pack on the GPU: textures in video memory, geometry in
//! GPU-mapped main memory (read straight from the file, no staging copy),
//! animation tracks, and per-frame node / light / fog-light state.

use std::fs::File;
use std::io::Read;

use glam::{Mat4, Quat, Vec3, Vec4};
use pocket3d_place as pc;
use pocket3d_gxm::mem::{Arena, Kind};
use pocket3d_gxm::texture::{Format, Texture, Uploader, Wrap};

pub struct DrawGpu {
    pub vb: *const u8,
    pub ib: *const u16,
    pub count: u32,
    pub skinned: bool,
    /// Static lighting is in the vertices (Baked layout); only moving
    /// lights are evaluated per pixel.
    pub baked: bool,
    /// Coarser index lists over the same vertices, finest first:
    /// (indices, count, error m).
    pub lods: Vec<(*const u16, u32, f32)>,
    pub material: u32,
    /// Dequantisation: position = q × scale + offset.
    pub dequant: [f32; 8],
    pub uv: [f32; 4],
    pub min: Vec3,
    pub max: Vec3,
    pub node: Option<u32>,
    pub skin: Option<u32>,
    pub no_reflect: bool,
}

/// Light state for one frame, in the shader's generic form.
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
    /// Bounding radius for culling (range, or where the light falls below 1% of the brightest).
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
    pub textures: Vec<Texture>,
    pub draws: Vec<DrawGpu>,
    pub anim: Vec<f32>,
    pub node_world: Vec<Mat4>,
    pub lights: Vec<LightNow>,
    pub fog: Vec<FogNow>,
    pub emissive_gain: Vec<f32>,
    pub door_open: f32,
    pub vram: Arena,
    pub main: Arena,
    pub load_ms: u32,
    pub bytes_tex: usize,
    pub bytes_geom: usize,
}

fn fmt(f: pc::TexFormat) -> Format {
    match f {
        pc::TexFormat::Rgba8 => Format::Rgba8,
        pc::TexFormat::Bc1 => Format::Bc1,
        pc::TexFormat::Bc3 => Format::Bc3,
        pc::TexFormat::Bc5 => Format::Bc5,
        pc::TexFormat::Rgba16f => Format::Rgba16f,
    }
}

fn wrap(w: pc::Wrap) -> Wrap {
    match w {
        pc::Wrap::Repeat => Wrap::Repeat,
        pc::Wrap::Clamp => Wrap::Clamp,
        pc::Wrap::Mirror => Wrap::Mirror,
    }
}

/// Forward-only reads: the USB host file system does not seek, so a pack is
/// read in file order and a backward jump reopens the file.
struct Seq {
    path: String,
    f: File,
    pos: u64,
    scratch: Vec<u8>,
}

impl Seq {
    fn open(path: &str) -> Result<Self, String> {
        Ok(Self { path: path.into(), f: File::open(path).map_err(|e| format!("{path}: {e}"))?, pos: 0, scratch: vec![0; 64 * 1024] })
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
        if offset < self.pos {
            self.f = File::open(&self.path).map_err(|e| format!("{}: {e}", self.path))?;
            self.pos = 0;
        }
        while self.pos < offset {
            let n = ((offset - self.pos) as usize).min(self.scratch.len());
            self.f.read_exact(&mut self.scratch[..n]).map_err(|e| format!("{}: skip: {e}", self.path))?;
            self.pos += n as u64;
        }
        // Large reads in 1 MiB pieces keep each USB transfer bounded.
        for chunk in buf.chunks_mut(1 << 20) {
            self.f.read_exact(chunk).map_err(|e| format!("{}: read @{}: {e}", self.path, self.pos))?;
            self.pos += chunk.len() as u64;
        }
        Ok(())
    }
}

impl Scene {
    /// Loads `path`, calling `progress(done, total, what)` between steps.
    ///
    /// # Safety
    /// GXM initialised; call from the render thread.
    pub unsafe fn load(path: &str, mut progress: impl FnMut(usize, usize, &str)) -> Result<Self, String> {
        let t0 = std::time::Instant::now();
        let mut f = Seq::open(path)?;
        let mut head = [0u8; 16];
        f.read_at(0, &mut head)?;
        let count = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
        let mut table = vec![0u8; 16 + count * 16];
        table[..16].copy_from_slice(&head);
        f.read_at(16, &mut table[16..])?;
        let pack = pc::Pack::parse_header(&table).map_err(|e| e.to_string())?;
        let find = |tag: [u8; 4]| pack.iter().find(|s| s.tag == tag).copied().ok_or(format!("missing {}", String::from_utf8_lossy(&tag)));
        let (s_meta, s_tex, s_geom, s_anim) = (find(pc::TAG_META)?, find(pc::TAG_TEXTURES)?, find(pc::TAG_GEOMETRY)?, find(pc::TAG_ANIMATION)?);

        let mut meta_bytes = vec![0u8; s_meta.size as usize];
        f.read_at(s_meta.offset as u64, &mut meta_bytes)?;
        let meta: pc::Meta = serde_json::from_slice(&meta_bytes).map_err(|e| format!("META: {e}"))?;
        drop(meta_bytes);
        let total = meta.textures.len() + 3;

        let mut vram = Arena::new(Kind::Cdram, 16 << 20);
        let mut main = Arena::new(Kind::Main, 8 << 20);
        let mut up = Uploader::new(4 << 20)?;
        let mut order: Vec<usize> = (0..meta.textures.len()).collect();
        order.sort_by_key(|&i| meta.textures[i].data.offset);
        let mut slots: Vec<Option<Texture>> = (0..meta.textures.len()).map(|_| None).collect();
        let mut buf = Vec::new();
        let mut bytes_tex = 0;
        for (k, &i) in order.iter().enumerate() {
            let t = &meta.textures[i];
            progress(1 + k, total, &t.name);
            buf.resize(t.data.size as usize, 0);
            f.read_at((s_tex.offset + t.data.offset) as u64, &mut buf)?;
            let mut tex = up.texture(&mut vram, fmt(t.format), t.width, t.height, t.mips, &buf).map_err(|e| format!("texture {}: {e}", t.name))?;
            tex.set_wrap(wrap(t.wrap_s), wrap(t.wrap_t));
            if matches!(t.role, pc::TexRole::Color | pc::TexRole::Normal | pc::TexRole::Orm) {
                // No anisotropic filtering on GXM: keep ground textures crisp at grazing angles.
                tex.set_lod_bias(-0.375);
            }
            bytes_tex += tex.bytes;
            slots[i] = Some(tex);
        }
        up.free();
        drop(buf);
        let textures: Vec<Texture> = slots.into_iter().map(|t| t.unwrap()).collect();

        progress(total - 2, total, "geometry");
        let geom = main.alloc(s_geom.size as usize, 4096)?;
        f.read_at(s_geom.offset as u64, core::slice::from_raw_parts_mut(geom, s_geom.size as usize))?;
        progress(total - 1, total, "animation");
        let mut anim_bytes = vec![0u8; s_anim.size as usize];
        f.read_at(s_anim.offset as u64, &mut anim_bytes)?;
        let anim: Vec<f32> = anim_bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        drop(anim_bytes);

        let draws = meta
            .draws
            .iter()
            .map(|d| DrawGpu {
                vb: geom.add(d.vertices.offset as usize),
                ib: geom.add(d.indices.offset as usize).cast(),
                count: d.index_count,
                skinned: d.layout == pc::VertexLayout::Skinned,
                baked: d.layout == pc::VertexLayout::Baked,
                lods: d.lods.iter().map(|l| (geom.add(l.indices.offset as usize).cast::<u16>() as *const u16, l.index_count, l.error)).collect(),
                material: d.material,
                dequant: [d.pos_scale[0], d.pos_scale[1], d.pos_scale[2], 0.0, d.pos_offset[0], d.pos_offset[1], d.pos_offset[2], 0.0],
                uv: [d.uv_scale[0], d.uv_scale[1], d.uv_offset[0], d.uv_offset[1]],
                min: Vec3::from(d.min),
                max: Vec3::from(d.max),
                node: d.node,
                skin: d.skin,
                no_reflect: d.no_reflect,
            })
            .collect();

        let n = meta.nodes.len();
        let mut scene = Self {
            node_world: vec![Mat4::IDENTITY; n],
            lights: vec![LightNow::default(); meta.lights.len()],
            fog: vec![FogNow::default(); meta.fog_lights.len()],
            emissive_gain: vec![1.0; meta.materials.len()],
            door_open: 0.0,
            meta,
            textures,
            draws,
            anim,
            vram,
            main,
            load_ms: 0,
            bytes_tex,
            bytes_geom: s_geom.size as usize,
        };
        scene.update(0.0);
        scene.load_ms = t0.elapsed().as_millis() as u32;
        Ok(scene)
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
                    // Lambertian panel: radiant intensity = luminance × area along the normal.
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
            // Where irradiance drops to ~0.002 (a dark wet street's visible floor).
            let p = now.color.max_element();
            now.reach = if l.range > 0.0 { l.range } else { (p / 0.002).sqrt().min(60.0) };
            now.power = power;
            now.dynamic = l.node.is_some();
            self.lights[i] = now;
        }
        // A car's two headlights (moving spots a lamp-width apart with the
        // same colour and aim) light as one spot at their midpoint: moving
        // lights are evaluated per pixel, the renderer's largest variable
        // cost. The volumetric beams stay two (fog lights).
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

    /// Row-major 3×4 world transform of a draw (identity for baked geometry).
    pub fn model_rows(&self, d: &DrawGpu) -> [f32; 12] {
        let m = match d.node {
            Some(n) => self.node_world[n as usize],
            None => Mat4::IDENTITY,
        };
        rows3x4(&m)
    }

    /// Joint rows (3 × float4 per joint) for a skinned draw.
    pub fn bone_rows(&self, skin: u32, out: &mut Vec<f32>) {
        out.clear();
        let s = &self.meta.skins[skin as usize];
        let base = s.inverse_bind.offset as usize / 4;
        for (j, &node) in s.joints.iter().enumerate() {
            let ibm = Mat4::from_cols_slice(&self.anim[base + j * 16..base + j * 16 + 16]);
            let m = self.node_world[node as usize] * ibm;
            out.extend_from_slice(&rows3x4(&m));
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
            let we = Vec3::new(
                m.x_axis.x.abs() * e.x + m.y_axis.x.abs() * e.y + m.z_axis.x.abs() * e.z,
                m.x_axis.y.abs() * e.x + m.y_axis.y.abs() * e.y + m.z_axis.y.abs() * e.z,
                m.x_axis.z.abs() * e.x + m.y_axis.z.abs() * e.y + m.z_axis.z.abs() * e.z,
            );
            (wc - we, wc + we)
        } else if d.skin.is_some() {
            // People walk the whole street: bounds from the root joint each frame.
            let s = &self.meta.skins[d.skin.unwrap() as usize];
            let root = self.node_world[s.joints[0] as usize].transform_point3(Vec3::ZERO);
            (root - Vec3::new(1.2, 0.2, 1.2), root + Vec3::new(1.2, 2.2, 1.2))
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

pub fn rows4x4(m: &Mat4) -> [f32; 16] {
    m.transpose().to_cols_array()
}

#[allow(dead_code)]
pub fn v4(v: Vec3, w: f32) -> [f32; 4] {
    Vec4::new(v.x, v.y, v.z, w).to_array()
}
