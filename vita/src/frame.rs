//! The frame: a planar street reflection, the 4× MSAA HDR scene pass with
//! eye distance in alpha, quarter-resolution lit haze, a mip bloom chain and
//! the composite (AgX + grade) into the display buffer.
//!
//! Scenes per frame: reflection → reflection blur ×2 → main → haze →
//! bloom prefilter → 4 downsamples → 3 upsamples → display.

use glam::{Mat4, Vec3, Vec4};
use pocket3d_city as pc;
use pocket3d_gxm::mem::{Arena, Kind};
use pocket3d_gxm::target::{ColorFormat, Depth, Msaa, Target};
use vita2d_sys as g;

use crate::camera::{self, View};
use crate::gpu::{bind, BlendMode, Gpu, Layout, Out, PipeKey, Pipeline, Uniforms, S, U};
use crate::scene::{rows4x4, Scene};
use crate::shaders::Key;

pub const W: u32 = 960;
pub const H: u32 = 544;
/// Scene resolutions (the display stays 960×544).
const SCALES: [(u32, u32); 3] = [(960, 544), (720, 408), (640, 362)];
const LIGHTS_MAX: usize = 4;
const REFL_LIGHTS: usize = 2;
const HAZE_LIGHTS: usize = 6;
/// Lit draws whose bounds start beyond this distance (m) use the FAR program
/// variant: no normal, ORM or streak maps and, off the wet ground, no
/// environment specular.
const DETAIL_DISTANCE: f32 = 12.0;
/// The mirror pass skips draws whose bounding radius is below this fraction
/// of their distance (a few pixels in the blurred half-resolution buffer).
const REFLECTION_MIN_SIZE: f32 = 0.06;
/// Camera motion per frame (m, radians) above which the reflection and the
/// haze are both redrawn instead of alternating between frames.
const STILL_MOVE: f32 = 0.25;
const STILL_TURN: f32 = 0.035;
const FX_LIGHTS: usize = 8;
const SKY_FAR: f32 = 200.0;
const UNAVAILABLE: *const Pipeline = 1 as *const Pipeline;

#[derive(Clone, Copy)]
pub struct Settings {
    pub msaa: Msaa,
    pub reflection: bool,
    pub haze: bool,
    pub bloom: bool,
    pub rain: bool,
    /// Swap if back faces show: GXM winding depends on the viewport flip.
    pub cull_cw: bool,
    pub exposure: f32,
    /// Per-draw light budget in the main pass (0, 2 or 4).
    pub max_lights: usize,
    /// Profiling: every mesh drawn with a constant-colour fragment program.
    pub flat: bool,
    /// Particle systems drawn (bit per system: curtain, streak, drip,
    /// splash, steam, beacon).
    pub fx: u32,
    /// Scene resolution, upscaled by the composite: 0 = 960×544,
    /// 1 = 720×408, 2 = 640×362, 3 = picked from the frame time.
    pub scale: u32,
    /// Profiling: material classes left out of the scene passes (bits of
    /// [`Mat::class`]; bit 7 is the sky).
    pub skip: u32,
    /// While the camera moves slowly, redraw the reflection on even frames
    /// and the haze on odd frames, reusing the other from the frame before.
    pub amortize: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { msaa: Msaa::X4, reflection: true, haze: true, bloom: true, rain: true, cull_cw: true, exposure: 1.0, max_lights: LIGHTS_MAX, flat: false, fx: 0x3f, scale: 3, skip: 0, amortize: true }
    }
}

#[derive(Clone, Copy, Default)]
pub struct PassStats {
    pub draws: u32,
    pub tris: u32,
    pub culled: u32,
    pub missing: u32,
}

/// GPU time per scene, for profiling (`profile` control setting). Each scene
/// ends with a fragment notification and the CPU waits for it before
/// recording the next one, so the measured interval is that scene's own GPU
/// work (the frame runs serialized while profiling is on).
pub struct Timeline {
    slots: Vec<g::SceGxmNotification>,
    value: u32,
    pub on: bool,
    pub passes: Vec<(&'static str, f32)>,
}

impl Timeline {
    /// # Safety
    /// Uses notification words `first..first + count`.
    unsafe fn new(first: usize, count: usize) -> Self {
        let region = g::sceGxmGetNotificationRegion();
        let slots = (0..count)
            .map(|i| {
                let address = region.add(first + i);
                *address = 0;
                g::SceGxmNotification { address, value: 0 }
            })
            .collect();
        Self { slots, value: 0, on: false, passes: Vec::new() }
    }

    /// Ends the open scene on `ctx` (drawn into `target`) and, when
    /// profiling, waits for its GPU work.
    ///
    /// # Safety
    /// A scene begun on `target` is open.
    unsafe fn end(&mut self, ctx: *mut g::SceGxmContext, target: &Target, name: &'static str) {
        if !self.on {
            target.end(ctx, None);
            return;
        }
        self.value = self.value.wrapping_add(1);
        let i = self.passes.len() % self.slots.len();
        let slot = &mut self.slots[i];
        slot.value = self.value;
        let t = std::time::Instant::now();
        target.end(ctx, Some(slot));
        g::sceGxmNotificationWait(slot);
        self.passes.push((name, t.elapsed().as_secs_f32() * 1000.0));
    }
}

#[derive(Default)]
pub struct Stats {
    pub reflection: PassStats,
    pub main: PassStats,
    pub fx_quads: u32,
    pub cpu_submit_us: u32,
}

/// Material resolved to shader programs and constants.
struct Mat {
    /// Profiling class: 0 wet ground, 1 other lit, 2 glass, 3 window,
    /// 4 products, 5 unlit, 6 skyline and tower.
    class: u32,
    fs: &'static str,
    defines: Vec<&'static str>,
    lit: bool,
    blend: BlendMode,
    two_sided: bool,
    depth_write: bool,
    transparent: bool,
    reflect: bool,
    bias: Option<(i32, i32)>,
    tex: [Option<usize>; 4],
    base: [f32; 4],
    emissive: [f32; 4],
    pbr: [f32; 4],
    envk: [f32; 4],
    wet: [f32; 4],
    wet2: [f32; 4],
}

fn material(m: &pc::Material, env_scene: f32) -> Mat {
    let mut defines: Vec<&'static str> = Vec::new();
    let mut tex = [None; 4];
    let (fs, lit) = match m.kind {
        pc::Kind::Standard => ("standard_f.cg", true),
        pc::Kind::Unlit => ("unlit_f.cg", false),
        pc::Kind::Glass => ("glass_f.cg", true),
        pc::Kind::InteriorWindow => ("window_f.cg", false),
        pc::Kind::Products => ("products_f.cg", false),
        pc::Kind::Tower => ("tower_f.cg", false),
        pc::Kind::Skyline => ("skyline_f.cg", false),
    };
    if let Some(t) = m.albedo {
        tex[0] = Some(t as usize);
        defines.push("ALBEDO_MAP");
    }
    if m.kind == pc::Kind::Standard {
        if let Some(t) = m.normal {
            tex[1] = Some(t as usize);
            defines.push("NORMAL_MAP");
        }
        if let Some(t) = m.orm {
            tex[2] = Some(t as usize);
            defines.push("ORM_MAP");
        }
        if let Some(t) = m.emission {
            tex[3] = Some(t as usize);
            defines.push("EMISSION_MAP");
        }
        if m.wet.is_some() {
            defines.push("WET");
            if m.wet.as_ref().unwrap().planar {
                defines.push("PLANAR");
            }
        }
        if m.damp.is_some() {
            defines.push("DAMP");
        }
        if m.clearcoat > 0.0 {
            defines.push("CLEARCOAT");
        }
        if m.interior {
            defines.push("INTERIOR");
        }
    }
    if m.vertex_color && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit) {
        defines.push("VERTEX_COLOR");
    }
    if m.alpha_test > 0.0 && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit) {
        defines.push("ALPHA_TEST");
    }
    if m.fog && !m.interior && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit | pc::Kind::Glass | pc::Kind::InteriorWindow) {
        defines.push("FOG");
    }
    let blend = match (m.kind, m.blend) {
        (pc::Kind::Tower, _) => BlendMode::Additive,
        (pc::Kind::Glass, _) => BlendMode::Premultiplied,
        (_, pc::Blend::Opaque) => BlendMode::Opaque,
        (_, pc::Blend::Alpha) => BlendMode::Alpha,
        (_, pc::Blend::Premultiplied) => BlendMode::Premultiplied,
        (_, pc::Blend::Additive) => BlendMode::Additive,
    };
    let transparent = blend != BlendMode::Opaque;
    let w = m.wet.clone().unwrap_or_default();
    let d = m.damp.clone().unwrap_or_default();
    let base = match m.kind {
        pc::Kind::Unlit => [m.color[0], m.color[1], m.color[2], m.color[3]],
        pc::Kind::Products => [m.color[0], m.color[1], m.color[2], m.emissive[0]],
        pc::Kind::InteriorWindow => [0.0, 0.0, 0.0, 1.0],
        _ => m.color,
    };
    let emissive = match m.kind {
        pc::Kind::InteriorWindow => [m.emissive[0], 0.0, 0.0, 0.0],
        _ => [m.emissive[0], m.emissive[1], m.emissive[2], m.alpha_test],
    };
    let class = match m.kind {
        pc::Kind::Standard if m.wet.is_some() => 0,
        pc::Kind::Standard => 1,
        pc::Kind::Glass => 2,
        pc::Kind::InteriorWindow => 3,
        pc::Kind::Products => 4,
        pc::Kind::Unlit => 5,
        pc::Kind::Tower | pc::Kind::Skyline => 6,
    };
    Mat {
        class,
        fs,
        defines,
        lit,
        blend,
        two_sided: m.double_sided || m.kind == pc::Kind::Tower,
        depth_write: m.depth_write && !transparent,
        transparent,
        // Glass is thin and mostly transparent in a blurred mirror image.
        reflect: !w.planar && !matches!(m.kind, pc::Kind::Tower | pc::Kind::Glass),
        bias: m.polygon_offset.map(|p| (-p[0] as i32, -p[1] as i32)),
        tex,
        base,
        emissive,
        pbr: [m.roughness, m.metalness, m.normal_scale, m.ao_strength],
        envk: [m.env_strength * env_scene, m.clearcoat.max(m.drops), 0.08, 1.0],
        wet: [w.puddles, w.darken, w.roughness, w.ripple],
        wet2: [1.0 / w.puddle_scale.max(0.01), d.darken, d.roughness, d.streaks],
    }
}

/// Grade applied through the colour LUT: contrast, saturation, lift, gain.
const GRADE: [f32; 2] = [1.16, 1.18];
const LIFT: [f32; 3] = [0.1, 0.35, 0.45];
const GAIN: [f32; 3] = [1.04, 0.99, 0.94];
/// LUT cells per axis over AgX's log2 domain [-12.47393, 4.02607].
const LUT: usize = 32;

/// AgX (as three.js) followed by the grade and sRGB encoding, for one
/// scene-linear colour: what the composite program looked up per pixel.
fn tone(c: [f32; 3]) -> [f32; 3] {
    let mul = |v: [f32; 3], m: [[f32; 3]; 3]| -> [f32; 3] { std::array::from_fn(|j| v[0] * m[0][j] + v[1] * m[1][j] + v[2] * m[2][j]) };
    let to2020 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
    let inset = [[0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]];
    let outset = [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]];
    let to_srgb = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
    let mut v = mul(mul(c, to2020), inset);
    for x in &mut v {
        let l = ((x.max(1e-10).log2() + 12.47393) / 16.5).clamp(0.0, 1.0);
        let (x2, x4) = (l * l, l * l * l * l);
        *x = 15.5 * x4 * x2 - 40.14 * x4 * l + 31.96 * x4 - 6.868 * x2 * l + 0.4298 * x2 + 0.1191 * l - 0.00232;
    }
    v = mul(v, outset).map(|x| x.max(0.0).powf(2.2));
    v = mul(v, to_srgb).map(|x| x.clamp(0.0, 1.0));
    v = v.map(|x| 0.18 * (x / 0.18).powf(GRADE[0]));
    let l = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    let smooth = |a: f32, b: f32, x: f32| {
        let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let (sh, hi) = (1.0 - smooth(0.0, 0.35, l), smooth(0.35, 1.0, l));
    std::array::from_fn(|k| {
        let x = (l + (v[k] - l) * GRADE[1] + LIFT[k] * sh * 0.04) * (1.0 + (GAIN[k] - 1.0) * hi);
        let x = x.clamp(0.0, 1.0);
        if x < 0.0031308 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 }
    })
}

/// LUT texels: `LUT` slices of LUT×LUT side by side (blue picks the slice,
/// red runs across it, green down), RGBA8 in sRGB.
fn tone_lut() -> Vec<u8> {
    let mut px = vec![0u8; LUT * LUT * LUT * 4];
    let at = |i: usize| (i as f32 / (LUT - 1) as f32 * 16.5 - 12.47393).exp2();
    for b in 0..LUT {
        for g in 0..LUT {
            for r in 0..LUT {
                let c = tone([at(r), at(g), at(b)]);
                let o = (g * LUT * LUT + b * LUT + r) * 4;
                px[o..o + 4].copy_from_slice(&[(c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8, 255]);
            }
        }
    }
    px
}

struct FxBuf {
    vb: *const u8,
    ib: *const u16,
    count: u32,
}

pub struct Renderer {
    pub settings: Settings,
    mats: Vec<Mat>,
    _vram: Arena,
    _mem: Arena,
    refl: Target,
    refl_blur: Target,
    /// Scene targets per resolution in `SCALES`, 4× MSAA then single-sampled;
    /// `Settings::msaa` and the current scale level pick one.
    mains: Vec<Target>,
    main_points: Vec<g::SceGxmTexture>,
    haze: Target,
    prefilter: Target,
    /// Tone-mapped 8-bit frame per scene resolution; the display scene
    /// scales it to 960×544.
    finals: Vec<Target>,
    down: Vec<Target>,
    up: Vec<Target>,
    tri_vb: *const f32,
    tri_ib: *const u16,
    lut: g::SceGxmTexture,
    streaks: FxBuf,
    splashes: FxBuf,
    drips: FxBuf,
    steam: FxBuf,
    beacons: FxBuf,
    bones: Vec<f32>,
    cur_vp: *mut g::SceGxmVertexProgram,
    cur_fp: *mut g::SceGxmFragmentProgram,
    pub stats: Stats,
    pub timeline: Timeline,
    order: Vec<(u32, f32, Vec3, Vec3)>,
    /// Resolved pipelines per (material, vertex variant, mirror, light count):
    /// null until resolved; revalidated when `Gpu::epoch` changes.
    pipe_cache: Vec<*const Pipeline>,
    pipe_epoch: u32,
    /// Settings the cached pipelines were resolved for (MSAA, flat).
    pipe_mode: (Msaa, bool),
    /// Frame counter and previous view for the reflection/haze alternation.
    tick: u32,
    auto_level: usize,
    auto_held: u32,
    prev_view: Option<(Vec3, Vec3)>,
    refl_ready: bool,
    haze_ready: bool,
}

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / 16_777_216.0
    }
}

/// Builds particle quads: `seed(i)` per quad, 4 corners, optional A/B.
unsafe fn fx_quads(mem: &mut Arena, n: usize, corners: [[f32; 2]; 4], mut per: impl FnMut(usize) -> ([f32; 4], [f32; 3], [f32; 3])) -> Result<FxBuf, String> {
    let n = n.min(16383);
    let vb = mem.alloc(n * 4 * 40, 16)?;
    let ib = mem.alloc(n * 6 * 2, 16)? as *mut u16;
    for i in 0..n {
        let (seed, a, b) = per(i);
        let s: [u16; 4] = seed.map(|v| (v.clamp(0.0, 1.0) * 65535.0) as u16);
        for (k, c) in corners.iter().enumerate() {
            let v = vb.add((i * 4 + k) * 40);
            core::ptr::copy_nonoverlapping(s.as_ptr().cast::<u8>(), v, 8);
            let f = v.add(8).cast::<f32>();
            *f = c[0];
            *f.add(1) = c[1];
            for j in 0..3 {
                *f.add(2 + j) = a[j];
                *f.add(5 + j) = b[j];
            }
        }
        for (k, idx) in [0u16, 1, 2, 0, 2, 3].iter().enumerate() {
            *ib.add(i * 6 + k) = (i * 4) as u16 + idx;
        }
    }
    Ok(FxBuf { vb, ib, count: (n * 6) as u32 })
}

fn key_v(file: &'static str, defs: &[&str]) -> Key {
    Key::new(file, defs)
}

impl Renderer {
    /// # Safety
    /// GXM initialised; render thread.
    pub unsafe fn new(settings: Settings, scene: &Scene) -> Result<Self, String> {
        let mut vram = Arena::new(Kind::Cdram, 8 << 20);
        let mut mem = Arena::new(Kind::Main, 4 << 20);
        let hdr = ColorFormat::Rgba16f;
        let refl = Target::new(&mut vram, &mut mem, W / 2, H / 2, hdr, Msaa::None, Depth::Transient)?;
        let refl_blur = Target::new(&mut vram, &mut mem, W / 4, H / 4, hdr, Msaa::None, Depth::None)?;
        let mut mains = Vec::new();
        let mut main_points = Vec::new();
        for (w, h) in SCALES {
          for msaa in [Msaa::X4, Msaa::None] {
            let t = Target::new(&mut vram, &mut mem, w, h, hdr, msaa, Depth::Transient)?;
            let mut point = t.texture;
            g::sceGxmTextureSetMinFilter(&mut point, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT);
            g::sceGxmTextureSetMagFilter(&mut point, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT);
            mains.push(t);
            main_points.push(point);
          }
        }
        // Haze is smooth and costs ~1.3 ms per light per 32k pixels: 160×90.
        let haze = Target::new(&mut vram, &mut mem, W / 6, H / 6, hdr, Msaa::None, Depth::None)?;
        // Bloom starts at quarter resolution.
        let prefilter = Target::new(&mut vram, &mut mem, W / 4, H / 4, hdr, Msaa::None, Depth::None)?;
        let mut down = Vec::new();
        for s in [8, 16] {
            down.push(Target::new(&mut vram, &mut mem, W / s, H / s, hdr, Msaa::None, Depth::None)?);
        }
        let mut up = Vec::new();
        for s in [8, 4] {
            up.push(Target::new(&mut vram, &mut mem, W / s, H / s, hdr, Msaa::None, Depth::None)?);
        }

        let mut finals = Vec::new();
        for (w, h) in SCALES {
            finals.push(Target::new(&mut vram, &mut mem, w, h, ColorFormat::Rgba8, Msaa::None, Depth::None)?);
        }

        let lut_px = tone_lut();
        let lut_mem = vram.alloc(lut_px.len(), 512)?;
        core::ptr::copy_nonoverlapping(lut_px.as_ptr(), lut_mem, lut_px.len());
        let mut lut: g::SceGxmTexture = core::mem::zeroed();
        let r = g::sceGxmTextureInitLinear(&mut lut, lut_mem.cast(), g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR, (LUT * LUT) as u32, LUT as u32, 0);
        if r < 0 {
            return Err(format!("LUT texture 0x{:08x}", r as u32));
        }
        g::sceGxmTextureSetMinFilter(&mut lut, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR);
        g::sceGxmTextureSetMagFilter(&mut lut, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR);
        g::sceGxmTextureSetUAddrMode(&mut lut, g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP);
        g::sceGxmTextureSetVAddrMode(&mut lut, g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP);

        let tri = mem.alloc(3 * 8, 16)?.cast::<f32>();
        for (i, v) in [-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0].iter().enumerate() {
            *tri.add(i) = *v;
        }
        let tri_ib = mem.alloc(8, 16)?.cast::<u16>();
        for i in 0..3 {
            *tri_ib.add(i) = i as u16;
        }

        let mut rng = Rng(0x2545_f491);
        let streaks = fx_quads(&mut mem, 7000, [[-0.5, 0.0], [0.5, 0.0], [0.5, 1.0], [-0.5, 1.0]], |_| ([rng.next(), rng.next(), rng.next(), rng.next()], [0.0; 3], [0.0; 3]))?;
        let splashes = fx_quads(&mut mem, 700, [[-1.0, 0.0], [1.0, 0.0], [1.0, 1.0], [-1.0, 1.0]], |_| ([rng.next(), rng.next(), rng.next(), rng.next()], [0.0; 3], [0.0; 3]))?;
        let mut edges: Vec<([f32; 3], [f32; 3])> = Vec::new();
        for e in &scene.meta.rain.drip_edges {
            let n = ((Vec3::from(e[0]) - Vec3::from(e[1])).length() * 2.5).round().max(1.0) as usize;
            for _ in 0..n {
                edges.push((e[0], e[1]));
            }
        }
        let drips = fx_quads(&mut mem, edges.len(), [[-0.5, 0.0], [0.5, 0.0], [0.5, 1.0], [-0.5, 1.0]], |i| ([rng.next(), rng.next(), rng.next(), rng.next()], edges[i].0, edges[i].1))?;
        let vents = &scene.meta.rain.steam_vents;
        let per_vent = 26;
        let steam = fx_quads(&mut mem, vents.len() * per_vent, [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]], |i| {
            let v = &vents[i / per_vent];
            ([(i % per_vent) as f32 / per_vent as f32 + rng.next() * 0.02, rng.next(), rng.next(), rng.next()], v[0], v[1])
        })?;
        let beacons = &scene.meta.beacons;
        let beacons = fx_quads(&mut mem, beacons.len(), [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]], |i| ([0.0; 4], beacons[i], [0.0; 3]))?;

        let env_scene = scene.meta.atmosphere.environment_strength;
        let mats = scene.meta.materials.iter().map(|m| material(m, env_scene)).collect();
        Ok(Self {
            settings,
            mats,
            _vram: vram,
            _mem: mem,
            refl,
            refl_blur,
            mains,
            main_points,
            haze,
            prefilter,
            finals,
            down,
            up,
            tri_vb: tri,
            tri_ib,
            lut,
            streaks,
            splashes,
            drips,
            steam,
            beacons,
            bones: Vec::with_capacity(64 * 12),
            cur_vp: core::ptr::null_mut(),
            cur_fp: core::ptr::null_mut(),
            stats: Stats::default(),
            // Words 0..2 belong to the frame fence in main.rs.
            timeline: Timeline::new(8, 32),
            order: Vec::new(),
            pipe_cache: vec![core::ptr::null(); scene.meta.materials.len() * 36],
            pipe_epoch: u32::MAX,
            pipe_mode: (Msaa::X4, false),
            tick: 0,
            auto_level: 1,
            auto_held: 0,
            prev_view: None,
            refl_ready: false,
            haze_ready: false,
        })
    }

    /// Every program the scene needs, so compiles start before the first frame.
    pub fn warm(&self, gpu: &mut Gpu, scene: &Scene) {
        let mut seen = std::collections::BTreeSet::new();
        for d in &scene.draws {
            seen.insert((variant(d), d.material));
        }
        for (v, mi) in seen {
            let m = &self.mats[mi as usize];
            let baked = v == 2;
            gpu.want(&surface_key(v, false));
            // Baked surfaces light only moving sources per pixel (at most 2).
            let main: &[usize] = if !m.lit { &[0] } else if baked { &[0, 2] } else { &[0, 2, 4] };
            for n in main {
                gpu.want(&frag_key(m, *n, false, baked, false));
                if m.lit {
                    gpu.want(&frag_key(m, *n, false, baked, true));
                }
            }
            if m.reflect {
                for n in if m.lit { &[0usize, 2][..] } else { &[0usize][..] } {
                    gpu.want(&frag_key(m, *n, true, baked, false));
                }
            }
        }
        for k in fixed_keys() {
            gpu.want(&k);
        }
    }

    fn mi(&self) -> usize {
        self.level() * 2 + (self.settings.msaa != Msaa::X4) as usize
    }

    /// Resolution level in use: the fixed setting, or the automatic one.
    pub fn level(&self) -> usize {
        if self.settings.scale < 3 { self.settings.scale as usize } else { self.auto_level }
    }

    /// Automatic resolution: step down when frames take longer than 55 ms,
    /// back up when they take under 38 ms, holding each level at least 1.5 s.
    pub fn feedback(&mut self, frame_ms: f32) {
        self.auto_held += 1;
        if self.auto_held < 30 {
            return;
        }
        if frame_ms > 55.0 && self.auto_level + 1 < SCALES.len() {
            self.auto_level += 1;
            self.auto_held = 0;
        } else if frame_ms < 38.0 && self.auto_level > 0 {
            self.auto_level -= 1;
            self.auto_held = 0;
        }
    }

    unsafe fn use_pipeline(&mut self, ctx: *mut g::SceGxmContext, p: &Pipeline) {
        if self.cur_vp != p.vp {
            g::sceGxmSetVertexProgram(ctx, p.vp);
            self.cur_vp = p.vp;
        }
        if self.cur_fp != p.fp {
            g::sceGxmSetFragmentProgram(ctx, p.fp);
            self.cur_fp = p.fp;
        }
    }

    unsafe fn viewport(ctx: *mut g::SceGxmContext, w: u32, h: u32) {
        let (hw, hh) = (w as f32 * 0.5, h as f32 * 0.5);
        g::sceGxmSetViewport(ctx, hw, hw, hh, -hh, 0.0, 1.0);
        g::sceGxmSetRegionClip(ctx, g::SceGxmRegionClipMode_SCE_GXM_REGION_CLIP_OUTSIDE, 0, 0, w - 1, h - 1);
    }

    unsafe fn cull(&self, ctx: *mut g::SceGxmContext, two_sided: bool, mirrored: bool) {
        let mode = if two_sided {
            g::SceGxmCullMode_SCE_GXM_CULL_NONE
        } else if self.settings.cull_cw != mirrored {
            g::SceGxmCullMode_SCE_GXM_CULL_CW
        } else {
            g::SceGxmCullMode_SCE_GXM_CULL_CCW
        };
        g::sceGxmSetCullMode(ctx, mode);
    }

    /// Records one frame's offscreen scenes. The display scene (composite +
    /// HUD) follows in [`Renderer::composite`].
    ///
    /// # Safety
    /// Render thread, no scene open.
    pub unsafe fn render(&mut self, gpu: &mut Gpu, scene: &Scene, view: &View, time: f32, rain: &Weather, fade: f32, bars: f32) -> Result<(), String> {
        let t0 = std::time::Instant::now();
        let ctx = g::vita2d_get_context();
        self.cur_vp = core::ptr::null_mut();
        self.cur_fp = core::ptr::null_mut();
        self.stats = Stats::default();
        self.timeline.passes.clear();

        let aspect = W as f32 / H as f32;
        let proj = camera::projection(view.fov_y, aspect, 0.1);
        let v = glam::camera::rh::view::look_at_mat4(view.pos, view.target, Vec3::Y);
        let vp = proj * v;
        let frame = FrameConsts::new(scene, view, time, rain, vp, aspect);

        // Which of the two view-dependent buffers to redraw this frame.
        let fwd = (view.target - view.pos).normalize_or(Vec3::NEG_Z);
        let moving = self.prev_view.map_or(true, |(p, d)| (p - view.pos).length() > STILL_MOVE || d.angle_between(fwd) > STILL_TURN);
        self.prev_view = Some((view.pos, fwd));
        self.tick = self.tick.wrapping_add(1);
        let all = !self.settings.amortize || moving;
        let draw_refl = all || !self.refl_ready || self.tick % 2 == 0;
        let draw_haze = all || !self.haze_ready || self.tick % 2 == 1;
        self.refl_ready &= self.settings.reflection;

        // ---------------------------------------------------- reflection
        if self.settings.reflection && draw_refl {
            self.refl_ready = true;
            let vpm = vp * camera::mirror();
            let mut eye = view.pos;
            eye.y = -eye.y;
            let mview = View { pos: eye, target: Vec3::new(view.target.x, -view.target.y, view.target.z), fov_y: view.fov_y };
            let mconsts = FrameConsts::new(scene, &mview, time, rain, vpm, aspect);
            self.refl.begin(ctx, 0.0)?;
            Self::viewport(ctx, self.refl.width, self.refl.height);
            let planes = camera::planes(&vpm);
            let mut st = PassStats::default();
            self.draw_meshes(ctx, gpu, scene, &mconsts, &planes, true, false, &mut st);
            self.sky(ctx, gpu, &mconsts, Out::Half4, Msaa::None.gxm());
            self.draw_meshes(ctx, gpu, scene, &mconsts, &planes, true, true, &mut st);
            self.timeline.end(ctx, &self.refl, "reflection");
            self.stats.reflection = st;
            let (src, dst) = (&self.refl.texture as *const _, &mut self.refl_blur as *mut Target);
            self.post(ctx, gpu, &mut *dst, "down_f.cg", &[(S::Source, src)], &[(U::Texel, [1.0 / self.refl.width as f32, 1.0 / self.refl.height as f32, 0.0, 0.0])], &frame)?;
        }

        // ---------------------------------------------------- main
        let mi = self.mi();
        self.mains[mi].begin(ctx, 0.0)?;
        Self::viewport(ctx, self.mains[mi].width, self.mains[mi].height);
        let planes = camera::planes(&vp);
        let mut st = PassStats::default();
        let msaa = self.settings.msaa.gxm();
        self.draw_meshes(ctx, gpu, scene, &frame, &planes, false, false, &mut st);
        if self.settings.skip & 0x80 == 0 {
            self.sky(ctx, gpu, &frame, Out::Half4, msaa);
        }
        self.draw_meshes(ctx, gpu, scene, &frame, &planes, false, true, &mut st);
        if self.settings.rain {
            self.particles(ctx, gpu, scene, &frame, rain);
        }
        self.timeline.end(ctx, &self.mains[mi], "main");
        self.stats.main = st;

        // ---------------------------------------------------- haze, bloom
        let hz = &frame.haze;
        let mut haze_u: Vec<(U, [f32; 4])> = vec![(U::Eye, frame.eye), (U::Haze, hz.params), (U::Ambient, hz.ambient), (U::BoxMin, hz.box_min), (U::BoxMax, hz.box_max)];
        if !self.settings.haze {
            haze_u[1].1 = [0.0, 0.0, 0.0, SKY_FAR];
        }
        // Far rain curtain, traced in the haze pass (bit 0 of `fx`).
        let curtain = if self.settings.rain && self.settings.fx & 1 != 0 { 0.08 * rain.intensity } else { 0.0 };
        haze_u.push((U::Curtain, [0.55, 0.6, 0.72, curtain]));
        if draw_haze {
            self.haze_ready = true;
            let (src, dst) = (&self.main_points[mi] as *const _, &mut self.haze as *mut Target);
            self.post_arrays(ctx, gpu, &mut *dst, "haze_f.cg", &[(S::Scene, src)], &haze_u, &[(U::FogPos, &hz.pos[..]), (U::FogCol, &hz.col[..]), (U::FogDir, &hz.dir[..])], &frame)?;
        }

        let (a, b, dst) = (&self.mains[mi].texture as *const _, &self.haze.texture as *const _, &mut self.prefilter as *mut Target);
        let texel = [1.0 / self.mains[mi].width as f32, 1.0 / self.mains[mi].height as f32, 0.0, 0.0];
        self.post(ctx, gpu, &mut *dst, "prefilter_f.cg", &[(S::Scene, a), (S::HazeTex, b)], &[(U::Texel, texel), (U::Threshold, [1.1, 0.4, 0.0, 0.0])], &frame)?;
        if self.settings.bloom {
            let mut src: *const g::SceGxmTexture = &self.prefilter.texture;
            let mut sw = self.prefilter.width;
            let mut sh = self.prefilter.height;
            for i in 0..self.down.len() {
                let dst = &mut self.down[i] as *mut Target;
                self.post(ctx, gpu, &mut *dst, "down_f.cg", &[(S::Source, src)], &[(U::Texel, [1.0 / sw as f32, 1.0 / sh as f32, 0.0, 0.0])], &frame)?;
                src = &self.down[i].texture;
                sw = self.down[i].width;
                sh = self.down[i].height;
            }
            for i in 0..self.up.len() {
                // Each upsample blends in the level of its own size.
                let support: *const g::SceGxmTexture = if i + 1 < self.down.len() { &self.down[self.down.len() - 2 - i].texture } else { &self.prefilter.texture };
                let dst = &mut self.up[i] as *mut Target;
                self.post(ctx, gpu, &mut *dst, "up_f.cg", &[(S::Source, src), (S::Support, support)], &[(U::Texel, [1.0 / sw as f32, 1.0 / sh as f32, 0.7, 0.0])], &frame)?;
                src = &self.up[i].texture;
                sw = self.up[i].width;
                sh = self.up[i].height;
            }
        }
        // ---------------------------------------------------- composite
        // Tone map and grade at scene resolution; the display scene scales.
        let lv = self.level();
        let (fw, fh) = (self.finals[lv].width as f32, self.finals[lv].height as f32);
        let bloom_on = if self.settings.bloom { 0.85 } else { 0.0 };
        let (scene_tex, bloom_tex) = (&self.mains[mi].texture as *const _, &self.up[self.up.len() - 1].texture as *const _);
        let (haze_tex, lut) = (&self.haze.texture as *const _, &self.lut as *const _);
        let dst = &mut self.finals[lv] as *mut Target;
        self.post(
            ctx,
            gpu,
            &mut *dst,
            "composite_f.cg",
            &[(S::Scene, scene_tex), (S::HazeTex, haze_tex), (S::Bloom, bloom_tex), (S::Lut, lut)],
            &[(U::BloomK, [bloom_on, self.settings.exposure, time, W as f32 / H as f32]), (U::Grade, [GRADE[0], GRADE[1], 0.03, 0.45]), (U::Grade2, [fade, bars, fw, fh])],
            &frame,
        )?;
        self.stats.cpu_submit_us = t0.elapsed().as_micros() as u32;
        Ok(())
    }

    /// Scales the finished frame into the open display scene.
    ///
    /// # Safety
    /// Inside the vita2d display scene.
    pub unsafe fn present(&mut self, gpu: &mut Gpu) {
        let ctx = g::vita2d_get_context();
        let key = PipeKey { vs: key_v("post_v.cg", &[]), fs: Key::new("blit_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Opaque, output: Out::Uchar4, msaa: Msaa::None.gxm() };
        let Some(p) = gpu.pipeline(&key) else { return };
        let p = &*(p as *const Pipeline);
        g::sceGxmSetViewport(ctx, 480.0, 480.0, 272.0, -272.0, 0.5, 0.5);
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
        g::sceGxmSetVertexProgram(ctx, p.vp);
        g::sceGxmSetFragmentProgram(ctx, p.fp);
        let u = Uniforms::reserve(ctx, p);
        u.set(p, U::RayZ, &[0.0; 4]);
        bind(ctx, p, S::Source, &self.finals[self.level()].texture);
        g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
        g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
    }

    /// A full-screen pass into `dst` with the given textures and uniforms.
    #[allow(clippy::too_many_arguments)]
    unsafe fn post(&mut self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, dst: &mut Target, fs: &'static str, tex: &[(S, *const g::SceGxmTexture)], uniforms: &[(U, [f32; 4])], frame: &FrameConsts) -> Result<(), String> {
        self.post_arrays(ctx, gpu, dst, fs, tex, uniforms, &[], frame)
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn post_arrays(
        &mut self,
        ctx: *mut g::SceGxmContext,
        gpu: &mut Gpu,
        dst: &mut Target,
        fs: &'static str,
        tex: &[(S, *const g::SceGxmTexture)],
        uniforms: &[(U, [f32; 4])],
        arrays: &[(U, &[f32])],
        frame: &FrameConsts,
    ) -> Result<(), String> {
        dst.begin(ctx, 0.0)?;
        Self::viewport(ctx, dst.width, dst.height);
        let output = if dst.format == ColorFormat::Rgba8 { Out::Uchar4 } else { Out::Half4 };
        let key = PipeKey { vs: key_v("post_v.cg", &[]), fs: Key::new(fs, &[]), layout: Layout::Pos2, blend: BlendMode::Opaque, output, msaa: Msaa::None.gxm() };
        if let Some(p) = gpu.pipeline(&key) {
            let p = &*(p as *const Pipeline);
            self.use_pipeline(ctx, p);
            g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
            g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
            g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::RayZ, &frame.ray_z);
            u.set(p, U::RayX, &frame.ray_x);
            u.set(p, U::RayY, &frame.ray_y);
            for (k, v) in uniforms {
                u.set(p, *k, v);
            }
            for (k, v) in arrays {
                u.set(p, *k, v);
            }
            for (s, t) in tex {
                bind(ctx, p, *s, *t);
            }
            g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
        }
        self.timeline.end(ctx, dst, fs);
        Ok(())
    }

    unsafe fn sky(&mut self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, f: &FrameConsts, out: Out, msaa: u32) {
        let key = PipeKey { vs: key_v("sky_v.cg", &[]), fs: Key::new("sky_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Opaque, output: out, msaa };
        let Some(p) = gpu.pipeline(&key) else { return };
        let p = &*(p as *const Pipeline);
        self.use_pipeline(ctx, p);
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_GREATER_EQUAL);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_ENABLED);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
        let u = Uniforms::reserve(ctx, p);
        u.set(p, U::RayZ, &f.ray_z);
        u.set(p, U::RayX, &f.ray_x);
        u.set(p, U::RayY, &f.ray_y);
        u.set(p, U::Zenith, &f.zenith);
        u.set(p, U::Horizon, &f.horizon);
        u.set(p, U::Glow, &f.glow);
        bind(ctx, p, S::Clouds, f.clouds);
        g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
        g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
    }

    /// Opaque (`transparent == false`, sorted by material) or blended draws
    /// (back to front) of the scene for the main or mirror camera.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_meshes(&mut self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, scene: &Scene, f: &FrameConsts, planes: &[Vec4; 5], mirror: bool, transparent: bool, st: &mut PassStats) {
        let mut order = core::mem::take(&mut self.order);
        order.clear();
        for (i, d) in scene.draws.iter().enumerate() {
            let m = &self.mats[d.material as usize];
            if m.transparent != transparent || self.settings.skip & (1 << m.class) != 0 {
                continue;
            }
            if mirror && (!m.reflect || d.no_reflect || d.max.y < 0.05) {
                continue;
            }
            let (lo, hi) = scene.bounds(d);
            if !camera::visible(planes, lo, hi) {
                st.culled += 1;
                continue;
            }
            let c = (lo + hi) * 0.5;
            let dist = (c - f.eye3).length_squared();
            if mirror && (hi - lo).length_squared() * 0.25 < dist * REFLECTION_MIN_SIZE * REFLECTION_MIN_SIZE {
                st.culled += 1;
                continue;
            }
            order.push((i as u32, if transparent { -dist } else { d.material as f32 }, lo, hi));
        }
        let mode = (self.settings.msaa, self.settings.flat);
        if self.pipe_epoch != gpu.epoch || self.pipe_mode != mode {
            self.pipe_cache.iter_mut().for_each(|p| *p = core::ptr::null());
            self.pipe_epoch = gpu.epoch;
            self.pipe_mode = mode;
        }
        order.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal));
        let msaa = if mirror { Msaa::None.gxm() } else { self.settings.msaa.gxm() };
        let mut last_state: Option<(bool, bool, Option<(i32, i32)>)> = None;
        for &(i, _, lo, hi) in &order {
            let d = &scene.draws[i as usize];
            let mi = d.material as usize;
            let max_n = if mirror { REFL_LIGHTS.min(self.settings.max_lights) } else { self.settings.max_lights.min(LIGHTS_MAX) };
            let v = variant(d);
            let far = !mirror && self.mats[mi].lit && (f.eye3.clamp(lo, hi) - f.eye3).length_squared() > DETAIL_DISTANCE * DETAIL_DISTANCE;
            let max_n = if d.baked { max_n.min(2) } else { max_n };
            let lights = if self.mats[mi].lit { select_lights(scene, lo, hi, max_n, d.baked) } else { LightSet::default() };
            let n = if lights.n == 0 { 0 } else if lights.n <= 2 { 2 } else { 4 };
            let slot = (((mi * 3 + v) * 2 + mirror as usize) * 2 + far as usize) * 3 + n / 2;
            let mut pp = self.pipe_cache[slot];
            if pp.is_null() {
                let key = PipeKey {
                    vs: surface_key(v, self.settings.flat),
                    fs: if self.settings.flat { Key::new("debug_f.cg", &[]) } else { frag_key(&self.mats[mi], n, mirror, d.baked, far) },
                    layout: [Layout::Static, Layout::Skinned, Layout::Baked][v],
                    blend: self.mats[mi].blend,
                    output: Out::Half4,
                    msaa,
                };
                // Unavailable (compiling or failed) stays cached until the epoch moves.
                pp = gpu.pipeline(&key).map_or(UNAVAILABLE, |p| p as *const Pipeline);
                self.pipe_cache[slot] = pp;
            }
            if pp == UNAVAILABLE {
                st.missing += 1;
                continue;
            }
            let p = &*pp;
            self.use_pipeline(ctx, p);
            let m = &self.mats[mi];
            let state = (m.two_sided, m.depth_write, m.bias);
            if last_state != Some(state) {
                self.cull(ctx, m.two_sided, mirror);
                g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_GREATER_EQUAL);
                g::sceGxmSetFrontDepthWriteEnable(
                    ctx,
                    if m.depth_write { g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_ENABLED } else { g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED },
                );
                let (bf, bu) = m.bias.unwrap_or((0, 0));
                g::sceGxmSetFrontDepthBias(ctx, bf, bu);
                last_state = Some(state);
            }
            let m = &self.mats[mi];
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::Model, &scene.model_rows(d));
            u.set(p, U::Dequant, &d.dequant);
            u.set(p, U::ViewProj, &f.vp);
            u.set(p, U::Uv, &d.uv);
            if let Some(s) = d.skin {
                let mut bones = core::mem::take(&mut self.bones);
                scene.bone_rows(s, &mut bones);
                u.set(p, U::Bones, &bones);
                self.bones = bones;
            }
            let gain = scene.emissive_gain[mi];
            let mut base = m.base;
            let mut emissive = m.emissive;
            if matches!(scene.meta.materials[mi].kind, pc::Kind::Unlit) {
                for c in &mut base[..3] {
                    *c *= gain;
                }
            } else {
                for c in &mut emissive[..3] {
                    *c *= gain;
                }
            }
            u.set(p, U::Base, &base);
            u.set(p, U::Emissive, &emissive);
            u.set(p, U::Pbr, &m.pbr);
            let mut envk = m.envk;
            envk[3] = f.rain;
            u.set(p, U::EnvK, &envk);
            u.set(p, U::Wet, &m.wet);
            u.set(p, U::Wet2, &m.wet2);
            u.set(p, U::Eye, &f.eye);
            u.set(p, U::Fog, &f.fog);
            u.set(p, U::HemiSky, &f.hemi_sky);
            u.set(p, U::HemiGround, &f.hemi_ground);
            u.set(p, U::Ripple, &f.ripple);
            u.set(p, U::ReflOn, &[if self.settings.reflection { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0]);
            u.set(p, U::Haze, &f.skyline_haze);
            if n > 0 {
                let k = n * 4;
                u.set(p, U::LightPos, &lights.pos[..k]);
                u.set(p, U::LightCol, &lights.col[..k]);
                u.set(p, U::LightDir, &lights.dir[..k]);
                u.set(p, U::LightRight, &lights.right[..k]);
                u.set(p, U::LightUp, &lights.up[..k]);
            }
            for (slot, s) in [S::Albedo, S::NormalMap, S::Orm, S::Emission].iter().enumerate() {
                if let Some(t) = m.tex[slot] {
                    bind(ctx, p, *s, &scene.textures[t].gxm);
                }
            }
            bind(ctx, p, S::Env, f.env);
            bind(ctx, p, S::Puddles, f.puddles);
            bind(ctx, p, S::Ripples, f.ripples);
            bind(ctx, p, S::Beads, f.beads);
            if !mirror {
                bind(ctx, p, S::ReflSharp, &self.refl.texture);
                bind(ctx, p, S::ReflBlur, &self.refl_blur.texture);
            }
            g::sceGxmSetVertexStream(ctx, 0, d.vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, d.ib.cast(), d.count);
            st.draws += 1;
            st.tris += d.count / 3;
        }
        g::sceGxmSetFrontDepthBias(ctx, 0, 0);
        self.order = order;
    }

    unsafe fn particles(&mut self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, scene: &Scene, f: &FrameConsts, w: &Weather) {
        let msaa = self.settings.msaa.gxm();
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_GREATER_EQUAL);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);

        let fx = &f.fx;
        let passes: [(&str, &str, BlendMode, *const FxBuf, f32); 5] = [
            ("STREAK", "STREAK", BlendMode::Additive, &self.streaks, 0.9 * w.intensity),
            ("DRIP", "STREAK", BlendMode::Additive, &self.drips, 1.2),
            ("SPLASH", "SPLASH", BlendMode::Additive, &self.splashes, 1.3 * w.intensity),
            ("STEAM", "STEAM", BlendMode::Premultiplied, &self.steam, 1.0),
            ("BEACON", "BEACON", BlendMode::Additive, &self.beacons, 1.0),
        ];
        for (k, (vdef, fdef, blend, buf, opacity)) in passes.into_iter().enumerate() {
            let buf = &*buf;
            if buf.count == 0 || self.settings.fx & (2 << k) == 0 {
                continue;
            }
            let key = PipeKey { vs: key_v("fx_v.cg", &[vdef]), fs: Key::new("fx_f.cg", &[fdef]), layout: Layout::Fx, blend, output: Out::Half4, msaa };
            let Some(p) = gpu.pipeline(&key) else { continue };
            let p = &*(p as *const Pipeline);
            self.use_pipeline(ctx, p);
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::ViewProj, &f.vp);
            u.set(p, U::Cam, &[f.eye[0], f.eye[1], f.eye[2], f.pixel]);
            u.set(p, U::Time, &[f.eye[3], 9.5, 0.55, 0.0045]);
            u.set(p, U::Box, &[30.0, 18.0, 30.0, 0.0]);
            u.set(p, U::Wind, &[w.wind.0, 0.0, w.wind.1, 0.0]);
            u.set(p, U::Center, &[fx.center.x, 0.0, fx.center.z, 26.0]);
            u.set(p, U::Ambient, &[0.05, 0.06, 0.08, 0.0]);
            u.set(p, U::Dry, &fx.dry);
            u.set(p, U::FogPos, &fx.pos);
            u.set(p, U::FogCol, &fx.col);
            u.set(p, U::Opacity, &[opacity, 0.0, 0.0, 0.0]);
            bind(ctx, p, S::Puddles, f.puddles);
            g::sceGxmSetVertexStream(ctx, 0, buf.vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, buf.ib.cast(), buf.count);
            self.stats.fx_quads += buf.count / 6;
        }
        let _ = scene;
    }
}

/// Vertex variant of a draw: 0 static, 1 skinned, 2 baked lighting.
fn variant(d: &crate::scene::DrawGpu) -> usize {
    if d.skinned {
        1
    } else if d.baked {
        2
    } else {
        0
    }
}

/// `flat`: profiling variant that outputs position and world only (pairs
/// with debug_f.cg).
fn surface_key(variant: usize, flat: bool) -> Key {
    let mut defs: Vec<&str> = match variant {
        1 => vec!["SKINNED", "MAX_BONES=24"],
        2 => vec!["BAKED"],
        _ => vec![],
    };
    if flat {
        defs.push("FLAT");
    }
    Key::new("surface_v.cg", &defs)
}

fn frag_key(m: &Mat, lights: usize, reflection: bool, baked: bool, far: bool) -> Key {
    let mut defs: Vec<&str> = m.defines.clone();
    let l = format!("LIGHTS={lights}");
    let l: &'static str = match lights {
        0 => "LIGHTS=0",
        2 => "LIGHTS=2",
        4 => "LIGHTS=4",
        _ => Box::leak(l.into_boxed_str()),
    };
    if m.lit {
        defs.push(l);
    }
    if reflection {
        defs.push("REFLECTION");
    }
    if baked {
        defs.push("BAKED");
    }
    // Only the standard program has a far variant.
    if far && m.fs == "standard_f.cg" {
        defs.push("FAR");
    }
    Key::new(m.fs, &defs)
}

fn fixed_keys() -> Vec<Key> {
    let mut v = vec![
        Key::new("post_v.cg", &[]),
        Key::new("sky_v.cg", &[]),
        Key::new("sky_f.cg", &[]),
        Key::new("haze_f.cg", &[]),
        Key::new("prefilter_f.cg", &[]),
        Key::new("down_f.cg", &[]),
        Key::new("up_f.cg", &[]),
        Key::new("composite_f.cg", &[]),
        Key::new("blit_f.cg", &[]),
        Key::new("debug_f.cg", &[]),
    ];
    for d in ["STREAK", "DRIP", "SPLASH", "STEAM", "BEACON"] {
        v.push(Key::new("fx_v.cg", &[d]));
    }
    for d in ["STREAK", "SPLASH", "STEAM", "BEACON"] {
        v.push(Key::new("fx_f.cg", &[d]));
    }
    v
}

#[derive(Default)]
struct LightSet {
    n: usize,
    pos: [f32; 16],
    col: [f32; 16],
    dir: [f32; 16],
    right: [f32; 16],
    up: [f32; 16],
}

/// The (up to) `max` lights that matter most for a box: brightness over
/// distance to the box, restricted to lights whose reach touches it.
/// `dynamic_only`: the box's static lighting is baked into its vertices.
fn select_lights(scene: &Scene, lo: Vec3, hi: Vec3, max: usize, dynamic_only: bool) -> LightSet {
    let mut best: [(f32, usize); LIGHTS_MAX] = [(0.0, usize::MAX); LIGHTS_MAX];
    for (i, l) in scene.lights.iter().enumerate() {
        if dynamic_only && !l.dynamic {
            continue;
        }
        let q = l.pos.clamp(lo, hi);
        let d2 = (q - l.pos).length_squared();
        if d2 > l.reach * l.reach {
            continue;
        }
        // Spots and panels: skip boxes entirely behind the emitter.
        if l.spot_scale > 0.0 && l.half_w == 0.0 {
            let c = (lo + hi) * 0.5;
            let r = (hi - lo).length() * 0.5;
            let to = c - l.pos;
            let dist = to.length();
            if dist > r && to.dot(l.dir) / dist < -l.spot_offset / l.spot_scale - r / dist {
                continue;
            }
        }
        let score = l.color.max_element() / d2.max(1.0);
        let mut k = max;
        while k > 0 && best[k - 1].0 < score {
            k -= 1;
        }
        if k < max {
            for j in (k + 1..max).rev() {
                best[j] = best[j - 1];
            }
            best[k] = (score, i);
        }
    }
    let mut set = LightSet::default();
    let n = best[..max].iter().filter(|b| b.1 != usize::MAX).count();
    let padded = if n == 0 { 0 } else if n <= 2 { 2 } else { 4 };
    for k in 0..padded {
        let o = k * 4;
        if k < n {
            let l = &scene.lights[best[k].1];
            set.pos[o..o + 4].copy_from_slice(&[l.pos.x, l.pos.y, l.pos.z, l.inv_range]);
            set.col[o..o + 4].copy_from_slice(&[l.color.x, l.color.y, l.color.z, l.spot_offset]);
            set.dir[o..o + 4].copy_from_slice(&[l.dir.x, l.dir.y, l.dir.z, l.spot_scale]);
            set.right[o..o + 4].copy_from_slice(&[l.right.x, l.right.y, l.right.z, l.half_w]);
            set.up[o..o + 4].copy_from_slice(&[l.up.x, l.up.y, l.up.z, l.half_h]);
        } else {
            set.pos[o..o + 4].copy_from_slice(&[0.0, -1000.0, 0.0, 0.0]);
            set.col[o..o + 4].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
            set.dir[o..o + 4].copy_from_slice(&[0.0, -1.0, 0.0, 0.0]);
        }
    }
    set.n = n;
    set
}

pub struct Weather {
    pub intensity: f32,
    pub wind: (f32, f32),
    pub rain: f32,
}

impl Weather {
    /// Rain swells and eases over a minute or so; gusts lean the streaks.
    pub fn at(t: f32) -> Self {
        let swell = 0.5 + 0.5 * (t * 0.09).sin() * (t * 0.037 + 1.3).sin();
        let gust = ((t * 0.21).sin() * (t * 0.083 + 0.7).sin()).max(0.0);
        Self { intensity: 0.85 + 0.35 * swell, wind: (0.7 + 2.2 * gust, 0.3 + 0.6 * gust), rain: 0.9 + 0.1 * swell }
    }
}

struct HazeConsts {
    params: [f32; 4],
    ambient: [f32; 4],
    box_min: [f32; 4],
    box_max: [f32; 4],
    pos: [f32; HAZE_LIGHTS * 4],
    col: [f32; HAZE_LIGHTS * 4],
    dir: [f32; HAZE_LIGHTS * 4],
}

struct FxConsts {
    center: Vec3,
    dry: [f32; 16],
    pos: [f32; FX_LIGHTS * 4],
    col: [f32; FX_LIGHTS * 4],
}

/// Per-camera constants shared by every draw of a pass.
struct FrameConsts {
    vp: [f32; 16],
    eye: [f32; 4],
    eye3: Vec3,
    fog: [f32; 4],
    hemi_sky: [f32; 4],
    hemi_ground: [f32; 4],
    ripple: [f32; 4],
    rain: f32,
    skyline_haze: [f32; 4],
    ray_x: [f32; 4],
    ray_y: [f32; 4],
    ray_z: [f32; 4],
    zenith: [f32; 4],
    horizon: [f32; 4],
    glow: [f32; 4],
    pixel: f32,
    env: *const g::SceGxmTexture,
    puddles: *const g::SceGxmTexture,
    ripples: *const g::SceGxmTexture,
    beads: *const g::SceGxmTexture,
    clouds: *const g::SceGxmTexture,
    haze: HazeConsts,
    fx: FxConsts,
}

impl FrameConsts {
    fn new(scene: &Scene, view: &View, time: f32, w: &Weather, vp: Mat4, aspect: f32) -> Self {
        let a = &scene.meta.atmosphere;
        let fx_meta = &scene.meta.effects;
        let tex = |i: Option<u32>| i.map_or(core::ptr::null(), |i| &scene.textures[i as usize].gxm as *const _);
        let fwd = (view.target - view.pos).normalize_or(Vec3::NEG_Z);
        let right = fwd.cross(Vec3::Y).normalize_or(Vec3::X);
        let up = right.cross(fwd);
        let ty = (view.fov_y.to_radians() * 0.5).tan();
        let tx = ty * aspect;
        let rf = (time * 1.15).fract() * 16.0;
        let frames = (fx_meta.ripple_grid * fx_meta.ripple_grid).max(1) as f32;
        let _ = frames;
        let ripple = [rf.floor(), (rf.floor() + 1.0) % 16.0, rf.fract(), 1.0 / fx_meta.ripple_tile.max(0.1)];

        // Haze lights: strength over distance from the camera, best 16.
        let cam = view.pos;
        let mut ranked: Vec<(f32, usize, f32)> = scene
            .fog
            .iter()
            .enumerate()
            .filter_map(|(i, l)| {
                let g = l.gain;
                let d2 = (l.pos - cam).length_squared();
                let score = g * (1.0 + l.radius * l.radius) / (1.0 + d2 * 0.02) * l.color.max_element();
                (g > 1e-4 && score > 0.0015).then_some((score, i, g))
            })
            .collect();
        ranked.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(core::cmp::Ordering::Equal));
        let mut haze = HazeConsts {
            params: [a.haze_density, a.haze_ambient_density, ranked.len().min(HAZE_LIGHTS) as f32, SKY_FAR],
            ambient: [a.haze_ambient[0], a.haze_ambient[1], a.haze_ambient[2], 0.0],
            box_min: [a.dry_min[0], a.dry_min[1], a.dry_min[2], 0.0],
            box_max: [a.dry_max[0], a.dry_max[1], a.dry_max[2], 0.0],
            pos: [0.0; HAZE_LIGHTS * 4],
            col: [0.0; HAZE_LIGHTS * 4],
            dir: [0.0; HAZE_LIGHTS * 4],
        };
        for k in 0..HAZE_LIGHTS {
            let o = k * 4;
            if let Some(&(_, i, g)) = ranked.get(k) {
                let l = &scene.fog[i];
                haze.pos[o..o + 4].copy_from_slice(&[l.pos.x, l.pos.y, l.pos.z, l.radius]);
                haze.col[o..o + 4].copy_from_slice(&[l.color.x * g, l.color.y * g, l.color.z * g, l.cos_outer]);
                haze.dir[o..o + 4].copy_from_slice(&[l.dir.x, l.dir.y, l.dir.z, l.cos_inner]);
            } else {
                haze.pos[o..o + 4].copy_from_slice(&[0.0, -1000.0, 0.0, 1.0]);
                haze.col[o..o + 4].copy_from_slice(&[0.0, 0.0, 0.0, -2.0]);
                haze.dir[o..o + 4].copy_from_slice(&[0.0, -1.0, 0.0, 1.0]);
            }
        }

        // Drops: nearest fog lights to the camera.
        let mut near: Vec<(f32, usize)> = scene.fog.iter().enumerate().filter(|(_, l)| l.gain > 1e-3).map(|(i, l)| ((l.pos - cam).length_squared(), i)).collect();
        near.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(core::cmp::Ordering::Equal));
        let mut fx = FxConsts { center: (cam + view.target) * 0.5, dry: [0.0; 16], pos: [0.0; FX_LIGHTS * 4], col: [0.0; FX_LIGHTS * 4] };
        for k in 0..FX_LIGHTS {
            let o = k * 4;
            if let Some(&(_, i)) = near.get(k) {
                let l = &scene.fog[i];
                let g = l.gain * 2.2 * w.intensity;
                fx.pos[o..o + 4].copy_from_slice(&[l.pos.x, l.pos.y, l.pos.z, (l.radius * 2.5).max(0.8)]);
                fx.col[o..o + 4].copy_from_slice(&[l.color.x * g, l.color.y * g, l.color.z * g, 0.0]);
            } else {
                fx.pos[o..o + 4].copy_from_slice(&[0.0, -1000.0, 0.0, 1.0]);
            }
        }
        for (k, b) in scene.meta.rain.dry_boxes.iter().take(2).enumerate() {
            fx.dry[k * 8..k * 8 + 4].copy_from_slice(&[b[0][0], b[0][1], b[0][2], 0.0]);
            fx.dry[k * 8 + 4..k * 8 + 8].copy_from_slice(&[b[1][0], b[1][1], b[1][2], 0.0]);
        }

        Self {
            vp: rows4x4(&vp),
            eye: [view.pos.x, view.pos.y, view.pos.z, time],
            eye3: view.pos,
            fog: [a.fog_color[0], a.fog_color[1], a.fog_color[2], a.fog_density],
            hemi_sky: [a.hemisphere_sky[0], a.hemisphere_sky[1], a.hemisphere_sky[2], 0.0],
            hemi_ground: [a.hemisphere_ground[0], a.hemisphere_ground[1], a.hemisphere_ground[2], 0.0],
            ripple,
            rain: w.rain,
            skyline_haze: [0.0103, 0.0091, 0.0194, 0.0],
            ray_x: [right.x * tx, right.y * tx, right.z * tx, 0.0],
            ray_y: [up.x * ty, up.y * ty, up.z * ty, 0.0],
            ray_z: [fwd.x, fwd.y, fwd.z, 0.0],
            zenith: [a.sky_zenith[0], a.sky_zenith[1], a.sky_zenith[2], time],
            horizon: [a.sky_horizon[0], a.sky_horizon[1], a.sky_horizon[2], 1.0 / fx_meta.cloud_cells.max(1.0)],
            glow: [a.sky_glow[0], a.sky_glow[1], a.sky_glow[2], SKY_FAR],
            pixel: 2.0 * ty / H as f32,
            env: tex(a.environment),
            puddles: tex(fx_meta.puddles),
            ripples: tex(fx_meta.ripples),
            beads: tex(fx_meta.beads),
            clouds: tex(fx_meta.clouds),
            haze,
            fx,
        }
    }
}
