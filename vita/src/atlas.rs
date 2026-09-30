//! The atlas screen: the globe of the web reference (`atlas.pack`), the
//! places on it and the list to pick one from.
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
use pocket3d_place::atlas::{AtlasMeta, AtlasPlace};
use pocketjs_vita::input::Pad;
use vita2d_sys as g;

use crate::camera;
use crate::frame::{tiled_at, tiled_u8, Rng, GRAIN, LUT, MASK_H, MASK_W};
use crate::gpu::{bind, BlendMode, Gpu, Layout, Out, PipeKey, Pipeline, Uniforms, S, U};
use crate::scene::{fmt, rows4x4, wrap, Seq};
use crate::shaders::Key;

const W: u32 = 960;
const H: u32 = 544;
/// Sphere tessellation (longitude × latitude segments).
const SEG_U: usize = 128;
const SEG_V: usize = 64;
/// Longitude and latitude speed of the left stick at full tilt (degrees/s).
const SPIN: f32 = 60.0;
/// Seconds without input before the globe drifts on its own.
const IDLE_AFTER: f32 = 8.0;

/// What the player asked for on the atlas screen.
pub enum Pick {
    Place(String),
}

pub struct Atlas {
    pub meta: AtlasMeta,
    textures: Vec<Texture>,
    vram: Arena,
    mem: Arena,
    hdr: Target,
    pre: Target,
    down: [Target; 2],
    up: [Target; 2],
    fin: Target,
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
    /// Places in list order (enterable first) and the selected row.
    pub order: Vec<usize>,
    pub selected: usize,
    idle: f32,
    time: f32,
    tick: u32,
    toast: Option<(String, f32)>,
    pub load_ms: u32,
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
        let t0 = std::time::Instant::now();
        let mut f = Seq::open(path)?;
        let mut head = [0u8; 16];
        f.read_at(0, &mut head)?;
        let count = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
        let mut table = vec![0u8; 16 + count * 16];
        table[..16].copy_from_slice(&head);
        f.read_at(16, &mut table[16..])?;
        let sections = pc::Pack::parse_header_as(&table, pc::atlas::MAGIC).map_err(|e| format!("{path}: {e}"))?;
        let find = |tag: [u8; 4]| sections.iter().find(|s| s.tag == tag).copied().ok_or(format!("{path}: missing section"));
        let (s_meta, s_tex) = (find(pc::TAG_META)?, find(pc::TAG_TEXTURES)?);
        let mut meta_bytes = vec![0u8; s_meta.size as usize];
        f.read_at(s_meta.offset as u64, &mut meta_bytes)?;
        let meta: AtlasMeta = serde_json::from_slice(&meta_bytes).map_err(|e| format!("atlas META: {e}"))?;

        let mut vram = Arena::new(Kind::Cdram, 16 << 20);
        let mut mem = Arena::new(Kind::Main, 2 << 20);
        let mut up = Uploader::new(4 << 20)?;
        let mut order: Vec<usize> = (0..meta.textures.len()).collect();
        order.sort_by_key(|&i| meta.textures[i].data.offset);
        let mut slots: Vec<Option<Texture>> = (0..meta.textures.len()).map(|_| None).collect();
        let mut buf = Vec::new();
        for &i in &order {
            let t = &meta.textures[i];
            buf.resize(t.data.size as usize, 0);
            f.read_at((s_tex.offset + t.data.offset) as u64, &mut buf)?;
            let mut tex = up.texture(&mut vram, fmt(t.format), t.width, t.height, t.mips, &buf).map_err(|e| format!("atlas texture {}: {e}", t.name))?;
            tex.set_wrap(wrap(t.wrap_s), wrap(t.wrap_t));
            tex.set_filter(true, t.mips > 1);
            slots[i] = Some(tex);
        }
        up.free();
        let textures: Vec<Texture> = slots.into_iter().map(|t| t.unwrap()).collect();
        for n in ["albedo", "normals", "lights", "clouds", "space", "inscatter", "transmittance", "sun_transmittance"] {
            tex_index(&meta, n)?;
        }

        let hdr = Target::new(&mut vram, &mut mem, W, H, ColorFormat::Rgba16f, Msaa::X4, Depth::Transient)?;
        let pre = Target::new(&mut vram, &mut mem, W / 2, H / 2, ColorFormat::Rgba16f, Msaa::None, Depth::None)?;
        let down = [
            Target::new(&mut vram, &mut mem, W / 4, H / 4, ColorFormat::Rgba16f, Msaa::None, Depth::None)?,
            Target::new(&mut vram, &mut mem, W / 8, H / 8, ColorFormat::Rgba16f, Msaa::None, Depth::None)?,
        ];
        let up_t = [
            Target::new(&mut vram, &mut mem, W / 4, H / 4, ColorFormat::Rgba16f, Msaa::None, Depth::None)?,
            Target::new(&mut vram, &mut mem, W / 2, H / 2, ColorFormat::Rgba16f, Msaa::None, Depth::None)?,
        ];
        let fin = Target::new(&mut vram, &mut mem, W, H, ColorFormat::Rgba8, Msaa::None, Depth::None)?;

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

        let mut list: Vec<usize> = (0..meta.places.len()).collect();
        list.sort_by_key(|&i| !meta.places[i].enterable);
        let (lat, lon) = (meta.globe.start_lat, meta.globe.start_lon);
        let mut atlas = Self {
            textures,
            vram,
            mem,
            hdr,
            pre,
            down,
            up: up_t,
            fin,
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
            order: list,
            selected: 0,
            idle: 0.0,
            time: 0.0,
            tick: 0,
            toast: None,
            load_ms: 0,
            meta,
        };
        atlas.focus_selected();
        atlas.load_ms = t0.elapsed().as_millis() as u32;
        Ok(atlas)
    }

    pub fn place(&self, row: usize) -> &AtlasPlace {
        &self.meta.places[self.order[row]]
    }

    /// Turns the selected place into the lit-limb-free part of the disc
    /// without centring it (the web's card hover).
    fn focus_selected(&mut self) {
        let p = self.place(self.selected);
        self.goal = Some(((p.lat * 0.75).clamp(-40.0, 55.0), p.lon - 4.0));
    }

    /// Selects the row of place `id` (control or deep link).
    pub fn select(&mut self, id: &str) -> bool {
        match self.order.iter().position(|&i| self.meta.places[i].id == id) {
            Some(r) => {
                self.selected = r;
                self.focus_selected();
                true
            }
            None => false,
        }
    }

    /// Input and animation for one frame.
    pub fn update(&mut self, dt: f32, pad: &Pad, pressed: u32) -> Option<Pick> {
        use vitasdk_sys::*;
        self.time += dt;
        if let Some((_, t)) = &mut self.toast {
            *t -= dt;
        }
        if self.toast.as_ref().is_some_and(|t| t.1 <= 0.0) {
            self.toast = None;
        }
        let n = self.order.len();
        let mut touched = false;
        if pressed & SCE_CTRL_DOWN != 0 {
            self.selected = (self.selected + 1) % n;
            self.focus_selected();
            touched = true;
        }
        if pressed & SCE_CTRL_UP != 0 {
            self.selected = (self.selected + n - 1) % n;
            self.focus_selected();
            touched = true;
        }
        let axis = |v: u8| {
            let f = ((v as f32 - 128.0) / 127.0).clamp(-1.0, 1.0);
            ((f.abs() - 0.18) / 0.82).max(0.0).copysign(f)
        };
        let (sx, sy) = (axis(pad.lx), axis(pad.ly));
        if sx != 0.0 || sy != 0.0 {
            self.goal = None;
            self.lon = wrap_deg(self.lon + sx * SPIN * dt);
            self.lat = (self.lat - sy * SPIN * dt).clamp(-60.0, 70.0);
            touched = true;
        }
        if touched {
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
        if pressed & (SCE_CTRL_CROSS | SCE_CTRL_CIRCLE) != 0 {
            let p = self.place(self.selected);
            if p.enterable {
                return Some(Pick::Place(p.id.clone()));
            }
            self.toast = Some((format!("{} ({}) is under construction", p.name, p.locality), 2.5));
        }
        None
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
        let msaa = Msaa::X4.gxm();

        // ------------------------------------------------ globe (HDR, MSAA)
        let hdr = &mut self.hdr as *mut Target;
        (*hdr).begin(ctx, 0.0)?;
        Self::viewport(ctx, W, H);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
        // Sky, stars and the halo, baked for this camera.
        let key = PipeKey { vs: Key::new("post_v.cg", &[]), fs: Key::new("blit_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Opaque, output: Out::Half4, msaa };
        if let Some(p) = gpu.pipeline(&key) {
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
        if let Some(p) = gpu.pipeline(&key) {
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
            bind(ctx, p, S::Albedo, self.tex("albedo"));
            bind(ctx, p, S::NormalMap, self.tex("normals"));
            bind(ctx, p, S::Lights, self.tex("lights"));
            bind(ctx, p, S::Clouds, self.tex("clouds"));
            bind(ctx, p, S::SunTrans, self.tex("sun_transmittance"));
            bind(ctx, p, S::Inscatter, self.tex("inscatter"));
            bind(ctx, p, S::Transmit, self.tex("transmittance"));
            g::sceGxmSetVertexStream(ctx, 0, self.sphere_vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.sphere_ib.cast(), self.sphere_count);
        }
        // Place markers, added over the frame.
        let key = PipeKey { vs: Key::new("marker_v.cg", &[]), fs: Key::new("marker_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Additive, output: Out::Half4, msaa };
        if let Some(p) = gpu.pipeline(&key) {
            let p = &*(p as *const Pipeline);
            Self::use_pipeline(ctx, p);
            g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
            g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
            g::sceGxmSetVertexStream(ctx, 0, self.quad_vb.cast());
            let pulse = (self.time * 1.4).fract();
            for (row, &i) in self.order.iter().enumerate() {
                let pl = &self.meta.places[i];
                let world = rot.transform_point3(lat_lon(pl.lat, pl.lon) * 1.004);
                let facing = world.normalize().dot((eye - world).normalize());
                let vis = ((facing - 0.05) / 0.2).clamp(0.0, 1.0);
                if vis <= 0.0 {
                    continue;
                }
                let c = vp * world.extend(1.0);
                let (x, y) = (c.x / c.w, c.y / c.w);
                let selected = row == self.selected;
                let px = if selected { 26.0 } else if pl.enterable { 18.0 } else { 11.0 };
                let (hx, hy) = (px * 2.0 / W as f32, px * 2.0 / H as f32);
                let gain = vis * if pl.enterable { 5.0 } else { 1.6 } * if selected { 1.6 } else { 1.0 };
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
        let texel = [1.0 / W as f32, 1.0 / H as f32, 0.0, 0.0];
        let pre = &mut self.pre as *mut Target;
        self.post(ctx, gpu, &mut *pre, v("post_v.cg"), v("prefilter_f.cg"), &[(S::Scene, scene), (S::HazeTex, scene)], &[(U::Texel, texel), (U::Threshold, [gl.bloom_threshold, gl.bloom_smoothing, 0.0, 0.0])])?;
        let (d0, d1) = (&mut self.down[0] as *mut Target, &mut self.down[1] as *mut Target);
        let (u0, u1) = (&mut self.up[0] as *mut Target, &mut self.up[1] as *mut Target);
        for (src, dst, support) in [(pre, d0, None), (d0, d1, None), (d1, u0, Some(d0)), (u0, u1, Some(pre))] {
            let texel = [1.0 / (*src).width as f32, 1.0 / (*src).height as f32, 0.7, 0.0];
            match support {
                None => self.post(ctx, gpu, &mut *dst, v("post_v.cg"), v("down_f.cg"), &[(S::Source, &(*src).texture)], &[(U::Texel, texel)])?,
                Some(s) => self.post(ctx, gpu, &mut *dst, v("post_v.cg"), v("up_f.cg"), &[(S::Source, &(*src).texture), (S::Support, &(*s).texture)], &[(U::Texel, texel)])?,
            }
        }

        // ------------------------------------------------ composite
        let o = (self.tick as f32 * 0.618_034).fract();
        let grain_k = [W as f32 / GRAIN as f32, H as f32 / GRAIN as f32, o, (self.tick as f32 * 0.414_214 + o).fract()];
        let fin = &mut self.fin as *mut Target;
        let bloom = &(*u1).texture as *const _;
        self.post(
            ctx,
            gpu,
            &mut *fin,
            Key::new("post_v.cg", &["GRAIN"]),
            Key::new("composite_f.cg", &["BLOOM"]),
            &[(S::Scene, scene), (S::Bloom, bloom), (S::Lut, &self.lut), (S::Mask, &self.mask), (S::Grain, &self.grain)],
            &[(U::BloomK, [gl.bloom_intensity, 1.0, 0.0, 0.0]), (U::Grade, [0.0, 0.0, gl.grain, 0.0]), (U::GrainK, grain_k)],
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
        bind(ctx, p, S::Source, &self.fin.texture);
        g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
        g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
    }

    /// The brand, the place list and the hints, drawn with vita2d over the
    /// presented frame (the web overlay's layout at 960×544).
    ///
    /// # Safety
    /// Inside the vita2d display scene.
    pub unsafe fn ui(&self, font: *mut g::vita2d_pgf) {
        let text = |x: i32, y: i32, color: u32, scale: f32, s: &str| {
            let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
            g::vita2d_pgf_draw_text(font, x, y, color, scale, c.as_ptr());
        };
        let width = |scale: f32, s: &str| {
            let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
            g::vita2d_pgf_text_width(font, scale, c.as_ptr())
        };
        // Colours are 0xAABBGGRR.
        let abgr = |c: [f32; 3], a: u8| -> u32 {
            let s = |v: f32| {
                let v = v.clamp(0.0, 1.0);
                ((if v < 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }) * 255.0).round() as u32
            };
            (a as u32) << 24 | s(c[2]) << 16 | s(c[1]) << 8 | s(c[0])
        };
        // Brand.
        text(40, 58, 0xffff_ffff, 1.25, "P O C K E T   A T L A S");
        text(40, 86, 0xb0d8_d8d8, 0.72, "Pick a place on the night side of the planet. Step inside.");

        // Place list.
        let (x0, y0, w) = (600, 28, 332);
        let open = self.meta.places.iter().filter(|p| p.enterable).count();
        g::vita2d_draw_rectangle(x0 as f32, y0 as f32, w as f32, 488.0, 0xa010_0c0a);
        text(x0 + 16, y0 + 24, 0x90c8_c8c8, 0.62, "PLACES");
        let count = format!("{open} / {} OPEN", self.meta.places.len());
        text(x0 + w - 16 - width(0.62, &count), y0 + 24, 0x90c8_c8c8, 0.62, &count);
        let card_h = 74;
        let rows = 6usize;
        let first = self.selected.saturating_sub(rows - 2).min(self.order.len().saturating_sub(rows));
        for (k, row) in (first..self.order.len().min(first + rows)).enumerate() {
            let p = self.place(row);
            let y = y0 + 40 + k as i32 * card_h;
            let sel = row == self.selected;
            if sel {
                g::vita2d_draw_rectangle((x0 + 8) as f32, y as f32, (w - 16) as f32, (card_h - 6) as f32, abgr(p.accent.map(|c| c * 0.35), 0x70));
                g::vita2d_draw_rectangle((x0 + 8) as f32, y as f32, 3.0, (card_h - 6) as f32, abgr(p.accent, 0xff));
            }
            let head = if sel { 0xffff_ffff } else { 0xd0e8_e8e8 };
            text(x0 + 20, y + 24, head, 0.95, &p.locality);
            text(x0 + 24 + width(0.95, &p.locality), y + 24, 0x90b8_b8b8, 0.72, &p.locality_native);
            text(x0 + 20, y + 44, 0xc0d0_d0d0, 0.72, &p.name);
            let (status, sc) = if p.enterable { ("OPEN NOW  ·  ENTER", abgr(p.accent, 0xff)) } else { ("UNDER CONSTRUCTION", 0x80a0_a0a0) };
            text(x0 + 20, y + 62, sc, 0.55, status);
            let wx = p.weather.to_uppercase();
            text(x0 + w - 20 - width(0.55, &wx), y + 62, 0x80a0_a0a0, 0.55, &wx);
        }
        // Hints and the toast.
        text(40, 522, 0xa0c8_c8c8, 0.62, "UP / DOWN  place     X  enter     LEFT STICK  spin     START  back to the atlas (in a place)");
        if let Some((msg, t)) = &self.toast {
            let a = (t.min(0.5) / 0.5 * 255.0) as u32;
            let tw = width(0.72, msg);
            g::vita2d_draw_rectangle((300 - tw / 2 - 14) as f32, 452.0, (tw + 28) as f32, 30.0, (a * 0xa0 / 255) << 24 | 0x100c0a);
            text(300 - tw / 2, 473, a << 24 | 0xe8e8e8, 0.72, msg);
        }
    }

    /// # Safety
    /// GPU idle with respect to every atlas resource.
    pub unsafe fn release(self) {
        let Self { hdr, pre, down, up, fin, vram, mem, .. } = self;
        hdr.destroy();
        pre.destroy();
        for t in down.into_iter().chain(up) {
            t.destroy();
        }
        fin.destroy();
        vram.free();
        mem.free();
    }
}

/// The atlas pack of a development build (USB share) or a packaged one.
pub fn pack_paths() -> &'static [&'static str] {
    if cfg!(feature = "usb-debug") {
        &["host0:atlas/atlas.pack", "ux0:data/pocket-atlas/atlas.pack", "app0:atlas.pack"]
    } else {
        &["app0:atlas.pack", "ux0:data/pocket-atlas/atlas.pack"]
    }
}

/// Where a place's pack is looked for, in order.
pub fn place_paths(id: &str) -> Vec<String> {
    let mut v = Vec::new();
    if cfg!(feature = "usb-debug") {
        v.push(format!("host0:atlas/places/{id}.place"));
    }
    v.push(format!("app0:places/{id}.place"));
    v.push(format!("ux0:data/pocket-atlas/places/{id}.place"));
    v
}

