//! The atlas screen: the globe of the web reference (`atlas.pack`) and the
//! places on it; the place browser beside it is `browser.rs`.
//!
//! The camera and the sun are fixed while the Earth turns, as on the web in
//! free mode, so the sky, the atmosphere halo and the atmosphere over the disc
//! come baked for this screen; the surface and the cloud shell are shaded per
//! pixel (`globe_f.cg`). HDR at 960×544 with 4× MSAA, a bloom chain, then ACES
//! filmic tone mapping, vignette and grain as on the web (`GlobePost`).

use glam::{EulerRot, Mat4, Quat, Vec3, Vec4};
use pocket3d_gxm::mem::{Arena, Kind};
use pocket3d_gxm::target::{ColorFormat, Depth, Msaa, Target};
use pocket3d_gxm::texture::{Texture, Uploader};
use pocket3d_place as pc;
use pocket3d_place::atlas::AtlasMeta;
use pocketjs_vita::input::Pad;
use vita2d_sys as g;

use crate::camera;
use crate::frame::{Rng, GRAIN, LUT, MASK_H, MASK_W};
use crate::gpu::{bind, tiled_at, tiled_u8, BlendMode, Gpu, Layout, Out, PipeKey, Pipeline, Uniforms, S, U};
use crate::scene::{find, fmt, rows4x4, wrap, Seq};
use crate::shaders::Key;

const W: u32 = 960;
const H: u32 = 544;
/// Resolution of the globe frame; the display scales it to 960×544.
const ATLAS_SIZE: (u32, u32) = (720, 408);
/// Sphere tessellation (longitude × latitude segments).
const SEG_U: usize = 128;
const SEG_V: usize = 64;
/// Longitude and latitude speed of the left stick at full tilt (degrees/s).
const SPIN: f32 = 60.0;
/// Seconds without input before the globe drifts on its own.
const IDLE_AFTER: f32 = 8.0;

pub struct Atlas {
    pub meta: AtlasMeta,
    textures: Vec<Texture>,
    vram: Arena,
    mem: Arena,
    /// Render targets live in their own arenas, rebuilt when the resolution
    /// or MSAA changes.
    rt: Targets,
    /// 3D resolution (the display scales it to 960×544) and MSAA.
    pub size: (u32, u32),
    pub msaa: Msaa,
    sphere_vb: *const u8,
    sphere_ib: *const u16,
    sphere_count: u32,
    tri_vb: *const f32,
    tri_ib: *const u16,
    quad_vb: *const f32,
    quad_ib: *const u16,
    lut: g::SceGxmTexture,
    mask: g::SceGxmTexture,
    grain: g::SceGxmTexture,
    /// Globe orientation (degrees): the point that faces the camera.
    pub lat: f32,
    pub lon: f32,
    goal: Option<(f32, f32)>,
    /// The browser's focused place (a wider, steady ring) and the places in
    /// its current list (full brightness; the rest dimmed).
    highlight: Option<usize>,
    listed: Vec<bool>,
    idle: f32,
    time: f32,
    tick: u32,
    pub load_ms: u32,
    /// Profiling switches (`{"atlas": true, "probe": {...}}`).
    pub probe: Probe,
    /// Sunlight transmittance at the ground and at the cloud shell, sampled
    /// from the baked table at cos sun zenith −0.3 … 0.5 (globe_v.cg).
    sun_curve: Vec<f32>,
}

const CURVE: usize = 16;

fn half_to_f32(h: u16) -> f32 {
    let (s, e, m) = ((h >> 15) as u32, ((h >> 10) & 31) as u32, (h & 1023) as u32);
    let bits = if e == 0 {
        if m == 0 { s << 31 } else {
            let mut e2 = 127 - 15 + 1;
            let mut m2 = m;
            while m2 & 1024 == 0 {
                m2 <<= 1;
                e2 -= 1;
            }
            (s << 31) | ((e2 as u32) << 23) | ((m2 & 1023) << 13)
        }
    } else if e == 31 {
        (s << 31) | (255 << 23) | (m << 13)
    } else {
        (s << 31) | ((e + 127 - 15) << 23) | (m << 13)
    };
    f32::from_bits(bits)
}

/// Two rows (ground, cloud shell) of the half-float RGBA sunlight table as
/// `CURVE` samples each over cos sun zenith −0.3 … 0.5.
fn sun_curve(px: &[u8], w: usize, h: usize) -> Vec<f32> {
    let at = |x: f32, y: f32| -> [f32; 3] {
        let (xi, yi) = (((x * (w - 1) as f32).round() as usize).min(w - 1), ((y * (h - 1) as f32).round() as usize).min(h - 1));
        let o = (yi * w + xi) * 8;
        let c = |k: usize| half_to_f32(u16::from_le_bytes([px[o + k * 2], px[o + k * 2 + 1]]));
        [c(0), c(1), c(2)]
    };
    let mut out = Vec::with_capacity(2 * CURVE * 4);
    for row in [0.0, 0.3873] {
        for i in 0..CURVE {
            let mu = -0.3 + 0.8 * i as f32 / (CURVE - 1) as f32;
            let c = at(mu * 0.5 + 0.5, row);
            out.extend_from_slice(&[c[0], c[1], c[2], 0.0]);
        }
    }
    out
}

struct Targets {
    vram: Arena,
    mem: Arena,
    hdr: Target,
    pre: Target,
    down: [Target; 2],
    up: [Target; 2],
    fin: Target,
}

impl Targets {
    unsafe fn new(w: u32, h: u32, msaa: Msaa) -> Result<Self, String> {
        let mut vram = Arena::new(Kind::Cdram, 4 << 20);
        let mut mem = Arena::new(Kind::Main, 4 << 20);
        let r = (|| -> Result<_, String> {
            let f = ColorFormat::Rgba16f;
            let hdr = Target::new(&mut vram, &mut mem, w, h, f, msaa, Depth::Transient)?;
            let pre = Target::new(&mut vram, &mut mem, w / 2, h / 2, f, Msaa::None, Depth::None)?;
            let down = [Target::new(&mut vram, &mut mem, w / 4, h / 4, f, Msaa::None, Depth::None)?, Target::new(&mut vram, &mut mem, w / 8, h / 8, f, Msaa::None, Depth::None)?];
            let up = [Target::new(&mut vram, &mut mem, w / 4, h / 4, f, Msaa::None, Depth::None)?, Target::new(&mut vram, &mut mem, w / 2, h / 2, f, Msaa::None, Depth::None)?];
            let fin = Target::new(&mut vram, &mut mem, w, h, ColorFormat::Rgba8, Msaa::None, Depth::None)?;
            Ok((hdr, pre, down, up, fin))
        })();
        match r {
            Ok((hdr, pre, down, up, fin)) => Ok(Self { vram, mem, hdr, pre, down, up, fin }),
            Err(e) => {
                vram.free();
                mem.free();
                Err(e)
            }
        }
    }

    /// # Safety
    /// GPU idle with respect to the targets.
    unsafe fn release(self) {
        self.hdr.destroy();
        self.pre.destroy();
        for t in self.down.into_iter().chain(self.up) {
            t.destroy();
        }
        self.fin.destroy();
        self.vram.free();
        self.mem.free();
    }
}

#[derive(Default, Clone, Copy)]
pub struct Probe {
    pub no_ui: bool,
    pub no_globe: bool,
    pub no_bloom: bool,
    pub no_markers: bool,
    pub no_space: bool,
}

fn tex_index(meta: &AtlasMeta, name: &str) -> Result<usize, String> {
    meta.textures.iter().position(|t| t.name == name).ok_or(format!("atlas: no texture {name}"))
}

/// Unit sphere, object space, with a duplicated seam column: position, uv.
fn sphere() -> (Vec<f32>, Vec<u16>) {
    let mut v = Vec::with_capacity((SEG_U + 1) * (SEG_V + 1) * 5);
    for j in 0..=SEG_V {
        let t = j as f32 / SEG_V as f32;
        let lat = (0.5 - t) * core::f32::consts::PI;
        for i in 0..=SEG_U {
            let s = i as f32 / SEG_U as f32;
            // u = atan2(x, z) / τ + 0.5, as the web's sphereUv.
            let lon = (s - 0.5) * core::f32::consts::TAU;
            let (sl, cl) = lat.sin_cos();
            v.extend_from_slice(&[cl * lon.sin(), sl, cl * lon.cos(), s, t]);
        }
    }
    let mut idx = Vec::with_capacity(SEG_U * SEG_V * 6);
    let row = SEG_U + 1;
    for j in 0..SEG_V {
        for i in 0..SEG_U {
            let a = (j * row + i) as u16;
            let b = a + 1;
            let c = a + row as u16;
            let d = c + 1;
            idx.extend_from_slice(&[a, c, b, b, c, d]);
        }
    }
    (v, idx)
}

/// three.js ACESFilmicToneMapping (exposure 1) and sRGB encoding for one
/// scene-linear colour, over the same log2 domain as the place renderer's
/// colour table (`composite_f.cg`).
fn aces(c: [f32; 3]) -> [f32; 3] {
    let x = c.map(|v| v / 0.6);
    // Column vectors, as the GLSL mat3 constructors.
    let input = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
    let output = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
    let mul = |m: [[f32; 3]; 3], v: [f32; 3]| -> [f32; 3] { core::array::from_fn(|j| m[0][j] * v[0] + m[1][j] * v[1] + m[2][j] * v[2]) };
    let v = mul(input, x).map(|v| (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081));
    mul(output, v).map(|v| {
        let v = v.clamp(0.0, 1.0);
        if v < 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
    })
}

fn aces_lut() -> Vec<u8> {
    let mut px = vec![0u8; LUT * LUT * LUT * 4];
    let at = |i: usize| (i as f32 / (LUT - 1) as f32 * 16.5 - 12.47393).exp2();
    for b in 0..LUT {
        for gg in 0..LUT {
            for r in 0..LUT {
                let c = aces([at(r), at(gg), at(b)]);
                let o = (b * LUT * LUT + gg * LUT + r) * 4;
                px[o..o + 4].copy_from_slice(&[(c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8, 255]);
            }
        }
    }
    px
}

/// postprocessing's VignetteEffect (default technique) with the globe's
/// offset and darkness, on screen UV.
fn write_vignette(px: *mut u8, offset: f32, darkness: f32) {
    for y in 0..MASK_H {
        let v = (y as f32 + 0.5) / MASK_H as f32;
        for x in 0..MASK_W {
            let u = (x as f32 + 0.5) / MASK_W as f32;
            let d = ((u - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt() * (darkness + offset);
            let (e0, e1) = (0.8, offset * 0.799);
            let t = ((d - e0) / (e1 - e0)).clamp(0.0, 1.0);
            let m = t * t * (3.0 - 2.0 * t);
            unsafe { *px.add(tiled_at(x, y, MASK_W)) = (m * 255.0).round() as u8 };
        }
    }
}

/// Direction of a latitude / longitude on the unit sphere (web `latLonToVec`).
fn lat_lon(lat: f32, lon: f32) -> Vec3 {
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    Vec3::new(la.cos() * lo.sin(), la.sin(), la.cos() * lo.cos())
}

fn wrap_deg(a: f32) -> f32 {
    (a + 180.0).rem_euclid(360.0) - 180.0
}

impl Atlas {
    /// # Safety
    /// GXM initialised; render thread.
    pub unsafe fn load(path: &str) -> Result<Self, String> {
        let mut vram = Arena::new(Kind::Cdram, 16 << 20);
        let mut mem = Arena::new(Kind::Main, 2 << 20);
        match Self::load_in(path, &mut vram, &mut mem) {
            Ok(mut a) => {
                a.vram = vram;
                a.mem = mem;
                Ok(a)
            }
            Err(e) => {
                // Uploads may still be in flight into these blocks.
                g::sceGxmTransferFinish();
                vram.free();
                mem.free();
                Err(e)
            }
        }
    }

    unsafe fn load_in(path: &str, vram: &mut Arena, mem: &mut Arena) -> Result<Self, String> {
        let t0 = std::time::Instant::now();
        let mut f = Seq::open(path)?;
        let sections = f.sections(pc::atlas::MAGIC)?;
        let (s_meta, s_tex) = (find(&sections, pc::TAG_META)?, find(&sections, pc::TAG_TEXTURES)?);
        let meta_bytes = f.section(&s_meta)?;
        let meta: AtlasMeta = serde_json::from_slice(&meta_bytes).map_err(|e| format!("atlas META: {e}"))?;

        let mut up = Uploader::new(4 << 20)?;
        let mut order: Vec<usize> = (0..meta.textures.len()).collect();
        order.sort_by_key(|&i| meta.textures[i].data.offset);
        let mut slots: Vec<Option<Texture>> = (0..meta.textures.len()).map(|_| None).collect();
        let mut buf = Vec::new();
        let mut curve = Vec::new();
        for &i in &order {
            let t = &meta.textures[i];
            buf.resize(t.data.size as usize, 0);
            f.read_at((s_tex.offset + t.data.offset) as u64, &mut buf)?;
            if t.name == "sun_transmittance" {
                curve = sun_curve(&buf, t.width as usize, t.height as usize);
            }
            let mut tex = up.texture(vram, fmt(t.format), t.width, t.height, t.mips, &buf).map_err(|e| format!("atlas texture {}: {e}", t.name))?;
            tex.set_wrap(wrap(t.wrap_s), wrap(t.wrap_t));
            tex.set_filter(true, t.mips > 1);
            slots[i] = Some(tex);
        }
        up.free();
        let textures: Vec<Texture> = slots.into_iter().map(|t| t.unwrap()).collect();
        for n in ["albedo", "normals", "lights", "clouds", "space", "inscatter", "transmittance", "sun_transmittance"] {
            tex_index(&meta, n)?;
        }

        // 720×408 with 4× MSAA holds 30 fps with margin; 960×544 fits only
        // without MSAA and with under a millisecond to spare.
        let rt = Targets::new(ATLAS_SIZE.0, ATLAS_SIZE.1, Msaa::X4)?;

        let (sv, si) = sphere();
        let sphere_vb = mem.alloc(sv.len() * 4, 16)?;
        core::ptr::copy_nonoverlapping(sv.as_ptr().cast::<u8>(), sphere_vb, sv.len() * 4);
        let sphere_ib = mem.alloc(si.len() * 2, 16)?.cast::<u16>();
        core::ptr::copy_nonoverlapping(si.as_ptr(), sphere_ib, si.len());

        let tri = mem.alloc(6 * 4, 16)?.cast::<f32>();
        for (i, v) in [-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0].iter().enumerate() {
            *tri.add(i) = *v;
        }
        let quad = mem.alloc(8 * 4, 16)?.cast::<f32>();
        for (i, v) in [-1.0f32, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0].iter().enumerate() {
            *quad.add(i) = *v;
        }
        let idx = mem.alloc(16, 16)?.cast::<u16>();
        for (i, v) in [0u16, 1, 2, 2, 1, 3].iter().enumerate() {
            *idx.add(i) = *v;
        }

        let lut_px = aces_lut();
        let lut_mem = vram.alloc(lut_px.len(), 512)?;
        core::ptr::copy_nonoverlapping(lut_px.as_ptr(), lut_mem, lut_px.len());
        let mut lut: g::SceGxmTexture = core::mem::zeroed();
        let r = g::sceGxmTextureInitTiled(&mut lut, lut_mem.cast(), g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR, (LUT * LUT) as u32, LUT as u32, 0);
        if r < 0 {
            return Err(format!("atlas LUT 0x{:08x}", r as u32));
        }
        g::sceGxmTextureSetMinFilter(&mut lut, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR);
        g::sceGxmTextureSetMagFilter(&mut lut, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR);
        g::sceGxmTextureSetUAddrMode(&mut lut, g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP);
        g::sceGxmTextureSetVAddrMode(&mut lut, g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP);
        let mask_px = vram.alloc(MASK_W * MASK_H, 512)?;
        write_vignette(mask_px, meta.globe.vignette_offset, meta.globe.vignette_darkness);
        let mask = tiled_u8(mask_px, MASK_W, MASK_H, true, false)?;
        let grain_px = vram.alloc(GRAIN * GRAIN, 512)?;
        let mut rng = Rng(0x9e37_79b9);
        for i in 0..GRAIN * GRAIN {
            *grain_px.add(i) = (rng.next() * 255.0) as u8;
        }
        let grain = tiled_u8(grain_px, GRAIN, GRAIN, false, true)?;

        let (lat, lon) = (meta.globe.start_lat, meta.globe.start_lon);
        let mut atlas = Self {
            textures,
            vram: Arena::new(Kind::Cdram, 16 << 20),
            mem: Arena::new(Kind::Main, 2 << 20),
            rt,
            size: ATLAS_SIZE,
            msaa: Msaa::X4,
            sphere_vb,
            sphere_ib,
            sphere_count: si.len() as u32,
            tri_vb: tri,
            tri_ib: idx,
            quad_vb: quad,
            quad_ib: idx,
            lut,
            mask,
            grain,
            lat,
            lon,
            goal: None,
            highlight: None,
            listed: vec![true; meta.places.len()],
            idle: 0.0,
            time: 0.0,
            tick: 0,
            load_ms: 0,
            probe: Probe::default(),
            sun_curve: curve,
            meta,
        };
        atlas.load_ms = t0.elapsed().as_millis() as u32;
        Ok(atlas)
    }

    /// Turns place `i` into the lit-limb-free part of the disc without
    /// centring it (the web's card hover).
    pub fn turn_to(&mut self, i: usize) {
        let p = &self.meta.places[i];
        self.goal = Some(((p.lat * 0.75).clamp(-40.0, 55.0), p.lon - 4.0));
        self.idle = 0.0;
    }

    /// Marks the browser's focused place and the places in its list.
    pub fn mark(&mut self, focus: Option<usize>, list: &[usize]) {
        self.highlight = focus;
        self.listed = (0..self.meta.places.len()).map(|i| list.contains(&i)).collect();
    }

    /// A pack texture (place previews), if `i` names one.
    pub fn texture(&self, i: u32) -> Option<*const g::SceGxmTexture> {
        self.textures.get(i as usize).map(|t| &t.gxm as *const _)
    }

    /// The globe for one frame: the left stick spins it, otherwise it eases
    /// to the browser's place and drifts after a while. Returns whether the
    /// stick turned it.
    pub fn update(&mut self, dt: f32, pad: &Pad) -> bool {
        self.time += dt;
        let axis = |v: u8| {
            let f = ((v as f32 - 128.0) / 127.0).clamp(-1.0, 1.0);
            ((f.abs() - 0.18) / 0.82).max(0.0).copysign(f)
        };
        let (sx, sy) = (axis(pad.lx), axis(pad.ly));
        let spun = sx != 0.0 || sy != 0.0;
        if spun {
            self.goal = None;
            self.lon = wrap_deg(self.lon + sx * SPIN * dt);
            self.lat = (self.lat - sy * SPIN * dt).clamp(-60.0, 70.0);
            self.idle = 0.0;
        } else {
            self.idle += dt;
        }
        match self.goal {
            Some((glat, glon)) => {
                let k = 1.0 - (-dt * 3.2).exp();
                self.lat += (glat - self.lat) * k;
                self.lon = wrap_deg(self.lon + wrap_deg(glon - self.lon) * k);
                if (glat - self.lat).abs() < 0.05 && wrap_deg(glon - self.lon).abs() < 0.05 && self.idle > IDLE_AFTER {
                    self.goal = None;
                }
            }
            None if self.idle > IDLE_AFTER => self.lon = wrap_deg(self.lon + self.meta.globe.idle_deg_per_s * dt),
            None => {}
        }
        spun
    }

    fn earth_rot(&self) -> Mat4 {
        Mat4::from_quat(Quat::from_euler(EulerRot::XYZ, self.lat.to_radians(), -self.lon.to_radians(), 0.0))
    }

    fn view_proj(&self) -> (Mat4, Vec3) {
        let gl = &self.meta.globe;
        let eye = Vec3::new(0.0, 0.0, gl.distance);
        let view = glam::camera::rh::view::look_at_mat4(eye, Vec3::ZERO, Vec3::Y);
        let proj = camera::projection(gl.fov, W as f32 / H as f32, gl.distance - 1.2);
        let shift = Mat4::from_cols(Vec4::X, Vec4::Y, Vec4::Z, Vec4::new(gl.shift_ndc, 0.0, 0.0, 1.0));
        (shift * proj * view, eye)
    }

    unsafe fn viewport(ctx: *mut g::SceGxmContext, w: u32, h: u32) {
        let (hw, hh) = (w as f32 * 0.5, h as f32 * 0.5);
        g::sceGxmSetViewport(ctx, hw, hw, hh, -hh, 0.0, 1.0);
        g::sceGxmSetRegionClip(ctx, g::SceGxmRegionClipMode_SCE_GXM_REGION_CLIP_OUTSIDE, 0, 0, w - 1, h - 1);
    }

    unsafe fn tex(&self, name: &str) -> *const g::SceGxmTexture {
        &self.textures[tex_index(&self.meta, name).unwrap()].gxm
    }

    unsafe fn use_pipeline(ctx: *mut g::SceGxmContext, p: &Pipeline) {
        g::sceGxmSetVertexProgram(ctx, p.vp);
        g::sceGxmSetFragmentProgram(ctx, p.fp);
    }

    /// A full-screen pass into `dst`.
    unsafe fn post(&self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, dst: &mut Target, vs: Key, fs: Key, tex: &[(S, *const g::SceGxmTexture)], uniforms: &[(U, [f32; 4])]) -> Result<(), String> {
        dst.begin(ctx, 0.0)?;
        Self::viewport(ctx, dst.width, dst.height);
        let output = if dst.format == ColorFormat::Rgba8 { Out::Uchar4 } else { Out::Half4 };
        let key = PipeKey { vs, fs, layout: Layout::Pos2, blend: BlendMode::Opaque, output, msaa: Msaa::None.gxm() };
        if let Some(p) = gpu.pipeline(&key) {
            let p = &*(p as *const Pipeline);
            Self::use_pipeline(ctx, p);
            g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
            g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
            g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::RayZ, &[0.0; 4]);
            for (k, v) in uniforms {
                u.set(p, *k, v);
            }
            for (s, t) in tex {
                bind(ctx, p, *s, *t);
            }
            g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
        }
        dst.end(ctx, None);
        Ok(())
    }

    /// Programs the atlas uses, so they compile before it is first drawn.
    pub fn warm(gpu: &mut Gpu) {
        for (f, d) in [
            ("globe_v.cg", &[][..]),
            ("globe_f.cg", &[]),
            ("marker_v.cg", &[]),
            ("marker_f.cg", &[]),
            ("post_v.cg", &[]),
            ("post_v.cg", &["GRAIN"]),
            ("blit_f.cg", &[]),
            ("prefilter_f.cg", &[]),
            ("down_f.cg", &[]),
            ("up_f.cg", &[]),
            ("composite_f.cg", &["BLOOM"]),
        ] {
            gpu.want(&Key::new(f, d));
        }
    }

    /// Draws the frame into the 8-bit target `present` shows.
    ///
    /// # Safety
    /// Render thread, outside any scene.
    pub unsafe fn render(&mut self, gpu: &mut Gpu) -> Result<(), String> {
        let ctx = g::vita2d_get_context();
        let gl = self.meta.globe.clone();
        self.tick = self.tick.wrapping_add(1);
        let (vp, eye) = self.view_proj();
        let rot = self.earth_rot();
        let rows = rot.transpose();
        let earth_rot = [rows.x_axis.to_array(), rows.y_axis.to_array(), rows.z_axis.to_array()].concat();
        let msaa = self.msaa.gxm();

        // ------------------------------------------------ globe (HDR, MSAA)
        let hdr = &mut self.rt.hdr as *mut Target;
        let (w, h) = self.size;
        (*hdr).begin(ctx, 0.0)?;
        Self::viewport(ctx, w, h);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
        // Sky, stars and the halo, baked for this camera.
        let key = PipeKey { vs: Key::new("post_v.cg", &[]), fs: Key::new("blit_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Opaque, output: Out::Half4, msaa };
        if let Some(p) = gpu.pipeline(&key).filter(|_| !self.probe.no_space) {
            let p = &*(p as *const Pipeline);
            Self::use_pipeline(ctx, p);
            g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
            g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::RayZ, &[0.0; 4]);
            bind(ctx, p, S::Source, self.tex("space"));
            g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
        }
        // The Earth and its cloud shell.
        let key = PipeKey { vs: Key::new("globe_v.cg", &[]), fs: Key::new("globe_f.cg", &[]), layout: Layout::Globe, blend: BlendMode::Opaque, output: Out::Half4, msaa };
        if let Some(p) = gpu.pipeline(&key).filter(|_| !self.probe.no_globe) {
            let p = &*(p as *const Pipeline);
            Self::use_pipeline(ctx, p);
            g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_GREATER_EQUAL);
            g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_ENABLED);
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::ViewProj, &rows4x4(&vp));
            u.set(p, U::EarthRot, &earth_rot);
            u.set(p, U::Sun, &[gl.sun[0], gl.sun[1], gl.sun[2], 0.0]);
            u.set(p, U::Eye, &[eye.x, eye.y, eye.z, 0.0]);
            u.set(p, U::GlobeK, &[gl.sun_i * gl.surface, gl.lights_max, gl.lights_gain, gl.night]);
            u.set(p, U::GlobeK2, &[gl.cloud_shadow, gl.specular, gl.cloud_opacity, gl.cloud_glow]);
            u.set(p, U::CloudOff, &[(self.time * gl.cloud_drift_per_s).fract(), gl.sun_i, 0.0, 0.0]);
            u.set(p, U::SunCurve, &self.sun_curve);
            bind(ctx, p, S::Albedo, self.tex("albedo"));
            bind(ctx, p, S::NormalMap, self.tex("normals"));
            bind(ctx, p, S::Lights, self.tex("lights"));
            bind(ctx, p, S::Clouds, self.tex("clouds"));
            bind(ctx, p, S::Inscatter, self.tex("inscatter"));
            bind(ctx, p, S::Transmit, self.tex("transmittance"));
            g::sceGxmSetVertexStream(ctx, 0, self.sphere_vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.sphere_ib.cast(), self.sphere_count);
        }
        // Place markers, added over the frame.
        let key = PipeKey { vs: Key::new("marker_v.cg", &[]), fs: Key::new("marker_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Additive, output: Out::Half4, msaa };
        if let Some(p) = gpu.pipeline(&key).filter(|_| !self.probe.no_markers) {
            let p = &*(p as *const Pipeline);
            Self::use_pipeline(ctx, p);
            g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
            g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
            g::sceGxmSetVertexStream(ctx, 0, self.quad_vb.cast());
            let pulse = (self.time * 1.4).fract();
            for (i, pl) in self.meta.places.iter().enumerate() {
                let world = rot.transform_point3(lat_lon(pl.lat, pl.lon) * 1.004);
                let facing = world.normalize().dot((eye - world).normalize());
                let vis = ((facing - 0.05) / 0.2).clamp(0.0, 1.0);
                if vis <= 0.0 {
                    continue;
                }
                let c = vp * world.extend(1.0);
                let (x, y) = (c.x / c.w, c.y / c.w);
                let selected = self.highlight == Some(i);
                let dim = if self.listed.get(i).copied().unwrap_or(true) { 1.0 } else { 0.3 };
                let px = if selected { 26.0 } else if pl.enterable { 18.0 } else { 11.0 };
                let (hx, hy) = (px * 2.0 / W as f32, px * 2.0 / H as f32);
                let gain = vis * dim * if pl.enterable { 5.0 } else { 1.6 } * if selected { 1.6 } else { 1.0 };
                let (ring_r, ring_s) = if selected { (0.62, 0.8) } else if pl.enterable { (0.2 + 0.7 * pulse, 0.9 * (1.0 - pulse)) } else { (0.5, 0.0) };
                let u = Uniforms::reserve(ctx, p);
                u.set(p, U::Marker, &[x, y, hx, hy]);
                u.set(p, U::MarkerCol, &[pl.accent[0] * gain, pl.accent[1] * gain, pl.accent[2] * gain, 0.0]);
                u.set(p, U::MarkerK, &[if pl.enterable { 0.16 } else { 0.22 }, ring_r, 0.07, ring_s]);
                g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.quad_ib.cast(), 6);
            }
        }
        (*hdr).end(ctx, None);

        // ------------------------------------------------ bloom
        let v = |f: &'static str| Key::new(f, &[]);
        let scene = &(*hdr).texture as *const _;
        let texel = [1.0 / w as f32, 1.0 / h as f32, 0.0, 0.0];
        let pre = &mut self.rt.pre as *mut Target;
        let bloom_on = !self.probe.no_bloom;
        let (d0, d1) = (&mut self.rt.down[0] as *mut Target, &mut self.rt.down[1] as *mut Target);
        let (u0, u1) = (&mut self.rt.up[0] as *mut Target, &mut self.rt.up[1] as *mut Target);
        if bloom_on {
        self.post(ctx, gpu, &mut *pre, v("post_v.cg"), v("prefilter_f.cg"), &[(S::Scene, scene), (S::HazeTex, scene)], &[(U::Texel, texel), (U::Threshold, [gl.bloom_threshold, gl.bloom_smoothing, 0.0, 0.0])])?;
        for (src, dst, support) in [(pre, d0, None), (d0, d1, None), (d1, u0, Some(d0)), (u0, u1, Some(pre))] {
            let texel = [1.0 / (*src).width as f32, 1.0 / (*src).height as f32, 0.7, 0.0];
            match support {
                None => self.post(ctx, gpu, &mut *dst, v("post_v.cg"), v("down_f.cg"), &[(S::Source, &(*src).texture)], &[(U::Texel, texel)])?,
                Some(s) => self.post(ctx, gpu, &mut *dst, v("post_v.cg"), v("up_f.cg"), &[(S::Source, &(*src).texture), (S::Support, &(*s).texture)], &[(U::Texel, texel)])?,
            }
        }
        }

        // ------------------------------------------------ composite
        let o = (self.tick as f32 * 0.618_034).fract();
        let grain_k = [w as f32 / GRAIN as f32, h as f32 / GRAIN as f32, o, (self.tick as f32 * 0.414_214 + o).fract()];
        let fin = &mut self.rt.fin as *mut Target;
        let bloom = &(*u1).texture as *const _;
        self.post(
            ctx,
            gpu,
            &mut *fin,
            Key::new("post_v.cg", &["GRAIN"]),
            Key::new("composite_f.cg", &["BLOOM"]),
            &[(S::Scene, scene), (S::Bloom, bloom), (S::Lut, &self.lut), (S::Mask, &self.mask), (S::Grain, &self.grain)],
            &[(U::BloomK, [if bloom_on { gl.bloom_intensity } else { 0.0 }, 1.0, 0.0, 0.0]), (U::Grade, [0.0, 0.0, gl.grain, 0.0]), (U::GrainK, grain_k)],
        )?;
        Ok(())
    }

    /// Scales the finished frame into the open display scene.
    ///
    /// # Safety
    /// Inside the vita2d display scene.
    pub unsafe fn present(&self, gpu: &mut Gpu) {
        let ctx = g::vita2d_get_context();
        let key = PipeKey { vs: Key::new("post_v.cg", &[]), fs: Key::new("blit_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Opaque, output: Out::Uchar4, msaa: Msaa::None.gxm() };
        let Some(p) = gpu.pipeline(&key) else { return };
        let p = &*(p as *const Pipeline);
        g::sceGxmSetViewport(ctx, 480.0, 480.0, 272.0, -272.0, 0.5, 0.5);
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
        Self::use_pipeline(ctx, p);
        let u = Uniforms::reserve(ctx, p);
        u.set(p, U::RayZ, &[0.0; 4]);
        bind(ctx, p, S::Source, &self.rt.fin.texture);
        g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
        g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
    }

    /// # Safety
    /// GPU idle with respect to every atlas resource.
    pub unsafe fn release(self) {
        let Self { rt, vram, mem, .. } = self;
        rt.release();
        vram.free();
        mem.free();
    }

    /// Rebuilds the render targets at another 3D resolution or MSAA mode.
    ///
    /// # Safety
    /// Render thread, outside any scene.
    pub unsafe fn resize(&mut self, w: u32, h: u32, msaa: Msaa) -> Result<(), String> {
        if (w, h) == self.size && msaa == self.msaa {
            return Ok(());
        }
        g::sceGxmFinish(g::vita2d_get_context());
        let rt = core::ptr::read(&self.rt);
        rt.release();
        match Targets::new(w, h, msaa) {
            Ok(t) => core::ptr::write(&mut self.rt, t),
            Err(e) => {
                // Back to the smallest set, which fits wherever the first one did.
                core::ptr::write(&mut self.rt, Targets::new(480, 272, Msaa::None)?);
                self.size = (480, 272);
                self.msaa = Msaa::None;
                return Err(e);
            }
        }
        self.size = (w, h);
        self.msaa = msaa;
        Ok(())
    }
}

/// Where the atlas pack is looked for, in order.
pub fn pack_paths() -> Vec<String> {
    crate::paths::candidates("atlas.pack")
}

/// Where a place's pack is looked for, in order.
pub fn place_paths(id: &str) -> Vec<String> {
    crate::paths::candidates(&format!("places/{id}.place"))
}
