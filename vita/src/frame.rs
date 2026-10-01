//! The frame: a planar street reflection, the 4× MSAA HDR scene pass with
//! eye distance in alpha, quarter-resolution lit haze, a mip bloom chain and
//! the composite (AgX + grade) into the display buffer.
//!
//! Scenes per frame: reflection → reflection blur ×2 → main → haze →
//! bloom prefilter → 4 downsamples → 3 upsamples → display.

use glam::{Mat4, Vec3, Vec4};
use pocket3d_place as pc;
use pocket3d_gxm::mem::{Arena, Kind};
use pocket3d_gxm::target::{ColorFormat, Depth, Msaa, Target};
use vita2d_sys as g;

use crate::camera::{self, View};
use crate::gpu::{tiled_at, tiled_u8, bind, BlendMode, Gpu, Layout, Out, PipeKey, Pipeline, Uniforms, S, U};
use crate::scene::{rows4x4, Scene};
use crate::profile::{Governor, Profile, Step};
use crate::shaders::Key;

pub const W: u32 = 960;
pub const H: u32 = 544;
/// Scene resolutions (the display stays 960×544).
pub const SCALES: [(u32, u32); 5] = [(960, 544), (720, 408), (640, 362), (544, 308), (480, 272)];
const LIGHTS_MAX: usize = 4;
const REFL_LIGHTS: usize = 2;
const HAZE_LIGHTS: usize = 6;
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
    /// Scene resolution, upscaled to the display: an index into `SCALES`
    /// (960×544, 720×408, 640×362, 544×308), or `SCALES.len()` for the
    /// profile's governor.
    pub scale: u32,
    /// Profiling: material classes left out of the scene passes (bits of
    /// [`Mat::class`]; bit 7 is the sky).
    pub skip: u32,
    /// While the camera moves slowly, redraw the reflection on even frames
    /// and the haze on odd frames, reusing the other from the frame before.
    pub amortize: bool,
    /// The profile's fixed choices (see [`Profile`]), copied so a
    /// measurement can override them; the step's haze and bloom quality
    /// likewise (`None`: the governor's step).
    pub reflection_size: usize,
    pub haze_size: Option<usize>,
    pub haze_lights: Option<usize>,
    pub bloom_full: Option<bool>,
    pub streaks: u32,
    pub steam: bool,
    pub detail_maps: bool,
    pub vertex_lights: bool,
    /// Overrides of the governor step's values.
    pub detail_m: Option<f32>,
    pub lod_pixels: Option<f32>,
    pub cull_size: Option<f32>,
    /// Light fields (measurements): overrides of every field's sprite range
    /// (pixels of a 272-pixel-high frame).
    pub field_min: Option<f32>,
    pub field_max: Option<f32>,
}

impl Settings {
    /// Every switch on, as the profile sets them; the scene resolution
    /// follows the governor.
    pub fn for_profile(p: &Profile) -> Self {
        Self {
            msaa: p.msaa,
            reflection: true,
            haze: true,
            bloom: true,
            rain: true,
            cull_cw: true,
            exposure: 1.0,
            max_lights: p.dynamic_lights,
            flat: false,
            fx: 0x3f,
            scale: SCALES.len() as u32,
            skip: 0,
            amortize: p.alternate,
            reflection_size: p.reflection_size,
            haze_size: None,
            haze_lights: None,
            bloom_full: None,
            streaks: p.streaks,
            steam: p.steam,
            detail_maps: p.detail_maps,
            vertex_lights: p.vertex_lights,
            detail_m: None,
            lod_pixels: None,
            cull_size: None,
            field_min: None,
            field_max: None,
        }
    }
}

#[derive(Clone, Copy, Default)]
pub struct PassStats {
    pub draws: u32,
    /// Draws that used their LOD1.
    pub lod: u32,
    pub tris: u32,
    pub culled: u32,
    pub missing: u32,
    /// Lit draws by per-pixel light count (0, 2, 4), and lit draws
    /// without baked lighting.
    pub lights: [u32; 3],
    pub unbaked: u32,
    /// Light-field draws and the lights they drew.
    pub fields: u32,
    pub points: u32,
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
    /// Without profiling: per scene, CPU ms recording it and ms inside its
    /// sceGxmEndScene (GPU backpressure shows up in both).
    pub cpu: Vec<(&'static str, f32, f32)>,
    mark: std::time::Instant,
    /// When the frame's first scene was handed to the GPU.
    pub first_kick: Option<std::time::Instant>,
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
        Self { slots, value: 0, on: false, passes: Vec::new(), cpu: Vec::new(), mark: std::time::Instant::now(), first_kick: None }
    }

    /// Ends the open scene on `ctx` (drawn into `target`) and, when
    /// profiling, waits for its GPU work.
    ///
    /// # Safety
    /// A scene begun on `target` is open.
    unsafe fn end(&mut self, ctx: *mut g::SceGxmContext, target: &Target, name: &'static str) {
        if !self.on {
            // CPU time recording the scene, then inside sceGxmEndScene.
            let t = std::time::Instant::now();
            target.end(ctx, None);
            self.first_kick.get_or_insert(t);
            let record = t.duration_since(self.mark).as_secs_f32() * 1000.0;
            self.cpu.push((name, record, t.elapsed().as_secs_f32() * 1000.0));
            self.mark = std::time::Instant::now();
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
    /// Main-pass triangles and draws per material index (profiling).
    pub by_material: Vec<u32>,
    pub draws_by_material: Vec<u32>,
    pub reflection: PassStats,
    pub main: PassStats,
    pub fx_quads: u32,
    pub cpu_submit_us: u32,
}

/// Material resolved to shader programs and constants.
struct Mat {
    kind: pc::Kind,
    alpha_test: bool,
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
    pbr_flat: [f32; 4],
    envk: [f32; 4],
    wet: [f32; 4],
    wet2: [f32; 4],
    uv_anim: Option<pc::UvAnim>,
    water: Option<pc::Water>,
    /// Light fields: sprite range and gain, and whether the vista haze
    /// dims them.
    field: Option<pc::LightField>,
    vista: bool,
}

/// `vista`: the place has the vista haze, which replaces the fog.
fn material(m: &pc::Material, env_scene: f32, textures: &[pc::Texture], sun: bool, vista: bool) -> Mat {
    let orm_mean = if m.kind == pc::Kind::Standard { m.orm.map(|t| textures[t as usize].mean) } else { None };
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
        pc::Kind::Water => ("water_f.cg", false),
        pc::Kind::Lights => ("lights_f.cg", false),
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
        if sun && !m.interior {
            defines.push("SUN");
            // The sun's highlight only shows on smooth or metallic surfaces.
            let rough = m.orm.map_or(m.roughness, |t| m.roughness * textures[t as usize].mean[1]);
            let metal = m.orm.map_or(m.metalness, |t| m.metalness * textures[t as usize].mean[2]);
            if rough < 0.6 || metal > 0.3 {
                defines.push("SUN_SPEC");
            }
        }
    }
    if m.kind == pc::Kind::Water {
        if let Some(t) = m.normal {
            tex[1] = Some(t as usize);
        }
        if sun {
            defines.push("SUN");
        }
        if m.water.is_some_and(|w| w.shallow.is_some()) && m.vertex_color {
            defines.push("SHALLOW");
        }
    }
    if m.vertex_color && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit) {
        defines.push("VERTEX_COLOR");
    }
    if m.alpha_test > 0.0 && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit) {
        defines.push("ALPHA_TEST");
    }
    if m.fog && !m.interior && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit | pc::Kind::Glass | pc::Kind::InteriorWindow | pc::Kind::Water) {
        defines.push(if vista { "VISTA" } else { "FOG" });
    }
    let blend = match (m.kind, m.blend) {
        (pc::Kind::Tower | pc::Kind::Lights, _) => BlendMode::Additive,
        (pc::Kind::Glass, _) => BlendMode::Premultiplied,
        (_, pc::Blend::Opaque) => BlendMode::Opaque,
        (_, pc::Blend::Alpha) => BlendMode::Alpha,
        (_, pc::Blend::Premultiplied) => BlendMode::Premultiplied,
        (_, pc::Blend::Additive) => BlendMode::Additive,
    };
    let transparent = blend != BlendMode::Opaque;
    // Alpha blending weighs by the program's alpha, which otherwise carries
    // the eye distance.
    if blend == BlendMode::Alpha && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit) {
        defines.push("BLEND");
    }
    let w = m.wet.clone().unwrap_or_default();
    let d = m.damp.clone().unwrap_or_default();
    let base = match m.kind {
        pc::Kind::Unlit => [m.color[0], m.color[1], m.color[2], m.color[3]],
        pc::Kind::Products => [m.color[0], m.color[1], m.color[2], m.emissive[0]],
        pc::Kind::InteriorWindow => [0.0, 0.0, 0.0, 1.0],
        _ => m.color,
    };
    let emissive = match m.kind {
        // Room intensity, then the tint (white without one).
        pc::Kind::InteriorWindow => {
            let t = m.tint.unwrap_or([1.0; 3]);
            [m.emissive[0], t[0], t[1], t[2]]
        }
        _ => [m.emissive[0], m.emissive[1], m.emissive[2], m.alpha_test],
    };
    let class = match m.kind {
        pc::Kind::Standard if m.wet.is_some() => 0,
        pc::Kind::Standard | pc::Kind::Water => 1,
        pc::Kind::Glass => 2,
        pc::Kind::InteriorWindow => 3,
        pc::Kind::Products => 4,
        pc::Kind::Unlit => 5,
        pc::Kind::Tower | pc::Kind::Skyline => 6,
        pc::Kind::Lights => 8,
    };
    Mat {
        kind: m.kind,
        alpha_test: m.alpha_test > 0.0 && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit),
        class,
        fs,
        defines,
        lit,
        blend,
        two_sided: m.double_sided || m.kind == pc::Kind::Tower,
        depth_write: m.depth_write && !transparent,
        transparent,
        // Glass is thin and mostly transparent in a blurred mirror image.
        reflect: !w.planar && !matches!(m.kind, pc::Kind::Tower | pc::Kind::Glass | pc::Kind::Water | pc::Kind::Lights),
        bias: m.polygon_offset.map(|p| (-p[0] as i32, -p[1] as i32)),
        tex,
        base,
        emissive,
        // uPbr.w: occlusion strength for the ORM map; without the map, the
        // occlusion itself (1 when the material has none).
        // Water: uPbr.y is the wave faces' slope toward the eye.
        pbr: [m.roughness, m.water.map_or(m.metalness, |w| w.mask), m.normal_scale, if orm_mean.is_some() { m.ao_strength } else { 1.0 }],
        // Variants that drop the ORM map (LITE, FAR, mirror) scale by its
        // means instead: most materials keep metalness 1 and mask it there.
        pbr_flat: match orm_mean {
            Some(o) => [m.roughness * o[1], m.metalness * o[2], m.normal_scale, (o[0] - 1.0) * m.ao_strength + 1.0],
            None => [m.roughness, m.metalness, m.normal_scale, 1.0],
        },
        envk: [m.env_strength * env_scene, m.clearcoat.max(m.drops), 0.08, 1.0],
        wet: [w.puddles, w.darken, w.roughness, w.ripple],
        wet2: [1.0 / w.puddle_scale.max(0.01), d.darken, d.roughness, d.streaks],
        uv_anim: m.uv_anim,
        water: m.water,
        field: m.lights,
        vista: vista && m.fog,
    }
}

/// Grade applied through the colour LUT: contrast, saturation, lift, gain.
/// LUT cells per axis over AgX's log2 domain [-12.47393, 4.02607].
pub(crate) const LUT: usize = 32;

use pocket3d_place::color::tone;

/// LUT texels: `LUT` slices of LUT×LUT side by side (blue picks the slice,
/// red runs across it, green down), RGBA8 in sRGB.
/// The colour table as a tiled texture: each 32×32 tile is one blue slice,
/// stored row by row, so a lookup's two slices are 4 KiB blocks.
fn tone_lut(post: &pc::Post) -> Vec<u8> {
    let mut px = vec![0u8; LUT * LUT * LUT * 4];
    let at = |i: usize| (i as f32 / (LUT - 1) as f32 * 16.5 - 12.47393).exp2();
    for b in 0..LUT {
        for g in 0..LUT {
            for r in 0..LUT {
                let c = tone([at(r), at(g), at(b)], post);
                let o = (b * LUT * LUT + g * LUT + r) * 4;
                px[o..o + 4].copy_from_slice(&[(c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8, 255]);
            }
        }
    }
    px
}

pub(crate) const MASK_W: usize = 64;
pub(crate) const MASK_H: usize = 256;
/// The GPU may still read the two frames before this one.
const MASK_BUFFERS: usize = 3;
pub(crate) const GRAIN: usize = 64;

/// The screen mask the composite multiplies by: vignette, letterbox bars
/// (`bars` = how far they have closed) and the dip to black.
fn write_mask(px: *mut u8, fade: f32, bars: f32, vignette: f32) {
    let aspect = W as f32 / H as f32;
    let bar = bars * (0.5 - (aspect / 2.39) * 0.5).max(0.0);
    for y in 0..MASK_H {
        let v = (y as f32 + 0.5) / MASK_H as f32;
        // Row coverage outside the bars, antialiased over one row.
        let open = ((v.min(1.0 - v) - bar) * MASK_H as f32 + 0.5).clamp(0.0, 1.0) * (1.0 - fade);
        for x in 0..MASK_W {
            let u = (x as f32 + 0.5) / MASK_W as f32;
            let q = ((u - 0.5) * aspect, v - 0.5);
            let r = (q.0 * q.0 + q.1 * q.1).sqrt();
            let t = ((r - 1.05) / (0.25 - 1.05)).clamp(0.0, 1.0);
            let vig = t * t * (3.0 - 2.0 * t);
            let m = (1.0 - vignette) + vignette * vig;
            unsafe { *px.add(tiled_at(x, y, MASK_W)) = (m * open * 255.0).round() as u8 };
        }
    }
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
    /// Render profile in use and the quality step its governor holds.
    pub profile: &'static Profile,
    pub governor: Governor,
    /// Mirror target and its blurred copy per `Profile::reflection_size`.
    refls: Vec<(Target, Target)>,
    /// Scene targets per resolution in `SCALES`, 4× MSAA then single-sampled;
    /// `Settings::msaa` and the current scale level pick one.
    mains: Vec<Option<Target>>,
    main_points: Vec<g::SceGxmTexture>,
    /// Haze buffer per `Step::haze_size`.
    hazes: Vec<Target>,
    /// Bloom chain: prefilter at W/4 and W/8, downsamples W/8 and W/16,
    /// upsamples W/8 and W/4 (`Step::bloom_full` uses all of them).
    prefilters: Vec<Target>,
    /// Tone-mapped 8-bit frame per scene resolution; the display scene
    /// scales it to 960×544.
    finals: Vec<Option<Target>>,
    down: Vec<Target>,
    up: Vec<Target>,
    /// Screen mask (vignette × letterbox × fade), rewritten into the next
    /// buffer when the letterbox or fade moves; `mask_at` = (buffer, key).
    masks: Vec<(*mut u8, g::SceGxmTexture)>,
    mask_at: Option<(usize, (u32, u32))>,
    grain: g::SceGxmTexture,
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
    pipe_mode: (Msaa, bool, bool),
    /// Frame counter and previous view for the reflection/haze alternation.
    tick: u32,
    prev_view: Option<(Vec3, Vec3)>,
    refl_ready: bool,
    haze_ready: bool,
    haze_index: usize,
    /// The place's tone, grade and bloom.
    post: pc::Post,
    /// The sun's shadow map (places with a sun).
    sun: Option<SunPass>,
    has_rain: bool,
    has_haze: bool,
    has_reflection: bool,
    day_sky: bool,
    /// The day sky carries twilight terms (`TWILIGHT`).
    twilight: bool,
    /// The vista haze's constant uniforms, when the place has it.
    vista: Option<VistaConsts>,
    /// 0, 1, 2, …: the index list every light-field draw shares.
    field_ib: *const u16,
    has_fields: bool,
}

/// `vista.cgh` uniforms that hold for the whole place.
struct VistaConsts {
    /// ρ0, H, 1 / (s · ln 2), ρ0 · s.
    k: [f32; 4],
    /// Horizontal direction toward the sun.
    sun: [f32; 4],
    /// Glow, band.
    glow: [f32; 4],
    /// `gain` × the horizon's base part and sun side at the tables' knots.
    sky: [f32; 4 * pc::VistaHaze::SKY_KNOTS],
    sun_sky: [f32; 4 * pc::VistaHaze::SKY_KNOTS],
}

impl VistaConsts {
    fn new(haze: &pc::VistaHaze, scene: &Scene) -> Self {
        let a = &scene.meta.atmosphere;
        let day = scene.meta.day_sky.as_ref();
        let (base, side) = haze.sky_tables(day, a.sky_horizon);
        let (mut sky, mut sun_sky) = ([0.0; 4 * pc::VistaHaze::SKY_KNOTS], [0.0; 4 * pc::VistaHaze::SKY_KNOTS]);
        for k in 0..pc::VistaHaze::SKY_KNOTS {
            sky[k * 4..k * 4 + 3].copy_from_slice(&base[k]);
            sun_sky[k * 4..k * 4 + 3].copy_from_slice(&side[k]);
        }
        let s = day.map_or([0.0, 0.0, -1.0], |d| d.sun_direction);
        let h = glam::Vec2::new(s[0], s[2]).normalize_or(glam::Vec2::new(0.0, -1.0));
        let s = haze.scale.max(1e-3);
        Self {
            k: [haze.density, haze.inversion, 1.0 / (s * core::f32::consts::LN_2), haze.density * s],
            sun: [h.x, h.y, 0.0, 0.0],
            glow: [haze.glow[0], haze.glow[1], haze.glow[2], haze.band],
            sky,
            sun_sky,
        }
    }
}

/// The sun's shadow map: the static scene rendered once from the sun, its
/// distance along the light packed into RGB (`shadow_f.cg`).
struct SunPass {
    target: Target,
    /// Point-sampled view of the map (the packed depth must not be filtered).
    map: g::SceGxmTexture,
    vp: [f32; 16],
    dir: [f32; 4],
    rad: [f32; 4],
    mat: [f32; 8],
    k: [f32; 4],
    ready: bool,
}

impl SunPass {
    unsafe fn new(vram: &mut Arena, mem: &mut Arena, sun: &pc::Sun) -> Result<Self, String> {
        let l = Vec3::from(sun.direction).normalize_or(Vec3::Y);
        let sh = sun.shadow.clone().unwrap_or(pc::SunShadow { position: (l * 80.0).to_array(), ortho: [-40.0, 40.0, -40.0, 40.0, 1.0, 160.0], map_size: 2048, bias: 0.0, normal_bias: 0.02, radius: 1.0 });
        let size = sh.map_size.clamp(512, 2048);
        let target = Target::new(vram, mem, size, size, ColorFormat::Rgba8, Msaa::None, Depth::Transient)?;
        let mut map = target.texture;
        g::sceGxmTextureSetMinFilter(&mut map, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT);
        g::sceGxmTextureSetMagFilter(&mut map, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT);
        let pos = Vec3::from(sh.position);
        let up = if l.y.abs() > 0.99 { Vec3::Z } else { Vec3::Y };
        let view = glam::camera::rh::view::look_at_mat4(pos, pos - l, up);
        let o = sh.ortho;
        let proj = glam::camera::rh::proj::directx::orthographic(o[0], o[1], o[2], o[3], o[4], o[5]);
        let vp = proj * view;
        let r = vp.transpose();
        // World → uv: u = x·½ + ½, v = ½ − y·½ (the viewport puts NDC +y on row 0).
        let (rx, ry, rw) = (r.x_axis, r.y_axis, r.w_axis);
        let urow = rx * 0.5 + rw * 0.5;
        let vrow = ry * -0.5 + rw * 0.5;
        let near = pos.dot(-l) + o[4];
        let range = (o[5] - o[4]).max(1.0);
        Ok(Self {
            target,
            map,
            vp: rows4x4(&vp),
            dir: [l.x, l.y, l.z, 0.0],
            rad: [sun.radiance[0], sun.radiance[1], sun.radiance[2], sh.normal_bias.max(0.01)],
            mat: [urow.x, urow.y, urow.z, urow.w, vrow.x, vrow.y, vrow.z, vrow.w],
            // Bias: the authored depth bias over the range, at least ~2 cm.
            k: [near, 1.0 / range, sh.bias.abs().max(0.02 / range), size as f32],
            ready: false,
        })
    }
}

pub(crate) struct Rng(pub(crate) u32);

impl Rng {
    pub(crate) fn next(&mut self) -> f32 {
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
    pub unsafe fn new(profile: &'static Profile, scene: &Scene) -> Result<Self, String> {
        let settings = Settings::for_profile(profile);
        let mut vram = Arena::new(Kind::Cdram, 8 << 20);
        let mut mem = Arena::new(Kind::Main, 4 << 20);
        let hdr = ColorFormat::Rgba16f;
        // What this place has: the rain, its haze and the street mirror.
        let has_planar = scene.meta.materials.iter().any(|m| m.wet.as_ref().is_some_and(|w| w.planar));
        let has_haze = !scene.meta.fog_lights.is_empty();
        let mut refls = Vec::new();
        if has_planar {
            for d in [2, 4] {
                let sharp = Target::new(&mut vram, &mut mem, W / d, H / d, hdr, Msaa::None, Depth::Transient)?;
                let blur = Target::new(&mut vram, &mut mem, W / (d * 2), H / (d * 2), hdr, Msaa::None, Depth::None)?;
                refls.push((sharp, blur));
            }
        }
        // Scene targets per resolution level are made when a level is first
        // used (`ensure_level`): most places only ever use one.
        let mains = (0..SCALES.len() * 2).map(|_| None).collect();
        let main_points = (0..SCALES.len() * 2).map(|_| core::mem::zeroed()).collect();
        // Haze is smooth and costs ~1.3 ms per light per 32k pixels.
        let mut hazes = Vec::new();
        if has_haze {
            for d in [6, 8] {
                hazes.push(Target::new(&mut vram, &mut mem, W / d, H / d, hdr, Msaa::None, Depth::None)?);
            }
        }
        let mut prefilters = Vec::new();
        for d in [4, 8] {
            prefilters.push(Target::new(&mut vram, &mut mem, W / d, H / d, hdr, Msaa::None, Depth::None)?);
        }
        let mut down = Vec::new();
        for s in [8, 16] {
            down.push(Target::new(&mut vram, &mut mem, W / s, H / s, hdr, Msaa::None, Depth::None)?);
        }
        let mut up = Vec::new();
        for s in [8, 4] {
            up.push(Target::new(&mut vram, &mut mem, W / s, H / s, hdr, Msaa::None, Depth::None)?);
        }

        let finals = (0..SCALES.len()).map(|_| None).collect();

        let lut_px = tone_lut(&scene.meta.post);
        let lut_mem = vram.alloc(lut_px.len(), 512)?;
        core::ptr::copy_nonoverlapping(lut_px.as_ptr(), lut_mem, lut_px.len());
        let mut lut: g::SceGxmTexture = core::mem::zeroed();
        let r = g::sceGxmTextureInitTiled(&mut lut, lut_mem.cast(), g::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR, (LUT * LUT) as u32, LUT as u32, 0);
        if r < 0 {
            return Err(format!("LUT texture 0x{:08x}", r as u32));
        }
        g::sceGxmTextureSetMinFilter(&mut lut, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR);
        g::sceGxmTextureSetMagFilter(&mut lut, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR);
        g::sceGxmTextureSetUAddrMode(&mut lut, g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP);
        g::sceGxmTextureSetVAddrMode(&mut lut, g::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP);

        let mut masks = Vec::new();
        for _ in 0..MASK_BUFFERS {
            let px = vram.alloc(MASK_W * MASK_H, 512)?;
            masks.push((px, tiled_u8(px, MASK_W, MASK_H, true, false)?));
        }
        let grain_px = vram.alloc(GRAIN * GRAIN, 512)?;
        let mut rng = Rng(0x9e37_79b9);
        for i in 0..GRAIN * GRAIN {
            *grain_px.add(i) = (rng.next() * 255.0) as u8;
        }
        let grain = tiled_u8(grain_px, GRAIN, GRAIN, false, true)?;

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
        // A sun below the horizon (blue hour) lights nothing directly.
        let lit_sun = scene.meta.sun.as_ref().filter(|s| s.direction[1] > 0.0);
        let has_sun = lit_sun.is_some();
        let vista = scene.meta.vista_haze.as_ref().map(|h| VistaConsts::new(h, scene));
        let mats: Vec<Mat> = scene.meta.materials.iter().map(|m| material(m, env_scene, &scene.meta.textures, has_sun, vista.is_some())).collect();
        let sun = match lit_sun {
            Some(s) => Some(SunPass::new(&mut vram, &mut mem, s)?),
            None => None,
        };
        let has_fields = scene.draws.iter().any(|d| d.lights);
        let field_ib = if has_fields {
            let ib = mem.alloc(pc::LightPoint::PER_DRAW * 2, 16)?.cast::<u16>();
            for i in 0..pc::LightPoint::PER_DRAW {
                *ib.add(i) = i as u16;
            }
            ib as *const u16
        } else {
            core::ptr::null()
        };
        let has_rain = scene.meta.rain.active;
        let has_reflection = has_planar;
        Ok(Self {
            settings,
            mats,
            _vram: vram,
            _mem: mem,
            profile,
            governor: Governor::new(),
            refls,
            mains,
            main_points,
            hazes,
            prefilters,
            finals,
            down,
            up,
            tri_vb: tri,
            tri_ib,
            lut,
            masks,
            mask_at: None,
            grain,
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
            pipe_cache: vec![core::ptr::null(); scene.meta.materials.len() * 54],
            pipe_epoch: u32::MAX,
            pipe_mode: (Msaa::X4, false, false),
            tick: 0,
            prev_view: None,
            refl_ready: false,
            haze_ready: false,
            haze_index: 0,
            post: scene.meta.post.clone(),
            sun,
            has_rain,
            has_haze,
            has_reflection,
            day_sky: scene.meta.day_sky.is_some(),
            twilight: scene.meta.day_sky.as_ref().is_some_and(|d| d.twilight.is_some()),
            vista,
            field_ib,
            has_fields,
        })
    }

    /// Frees the renderer's targets and memory.
    ///
    /// # Safety
    /// GPU idle with respect to every resource of this renderer.
    pub unsafe fn release(self) {
        let Self { refls, mains, hazes, prefilters, finals, down, up, _vram, _mem, sun, .. } = self;
        if let Some(s) = sun {
            s.target.destroy();
        }
        for (a, b) in refls {
            a.destroy();
            b.destroy();
        }
        for t in mains.into_iter().flatten().chain(hazes).chain(prefilters).chain(finals.into_iter().flatten()).chain(down).chain(up) {
            t.destroy();
        }
        _vram.free();
        _mem.free();
    }

    /// Every program the scene needs, so compiles start before the first frame.
    pub fn warm(&self, gpu: &mut Gpu, scene: &Scene) {
        let mut seen = std::collections::BTreeSet::new();
        for d in &scene.draws {
            if d.lights {
                let (vs, fs) = self.field_keys(d.material);
                gpu.want(&vs);
                gpu.want(&fs);
                continue;
            }
            seen.insert((variant(d), d.material));
        }
        for (v, mi) in seen {
            let m = &self.mats[mi as usize];
            let baked = v == 2;
            for tier in if m.lit { &[0usize, 1, 2][..] } else { &[0usize][..] } {
                gpu.want(&surface_key(v, false, vs_needs(m, *tier, false)));
            }
            if m.reflect {
                gpu.want(&surface_key(v, false, vs_needs(m, 0, true)));
            }
            // Baked surfaces light only moving sources per pixel (at most 2);
            // with vertex lights, moving meshes light per vertex.
            let vlit = !baked && m.lit && self.settings.vertex_lights && m.kind == pc::Kind::Standard;
            let main: &[usize] = if !m.lit { &[0] } else if baked { &[0, 1] } else { &[0, 2, 4] };
            for n in main {
                for tier in if m.lit { &[0usize, 1, 2][..] } else { &[0usize][..] } {
                    if vlit && *n > 0 {
                        let vs = surface_key(v, false, vs_needs(m, *tier, false));
                        gpu.want(&vs.with(if *n == 2 { "VERTEX_LIGHTS=2" } else { "VERTEX_LIGHTS=4" }));
                        gpu.want(&frag_key(m, 0, false, baked, *tier).with("VERTEX_LIGHTS"));
                    } else {
                        gpu.want(&frag_key(m, *n, false, baked, *tier));
                    }
                }
            }
            if m.reflect {
                for n in if !m.lit { &[0usize][..] } else if baked { &[0usize, 1][..] } else { &[0usize, 2][..] } {
                    if vlit && *n > 0 {
                        gpu.want(&surface_key(v, false, vs_needs(m, 0, true)).with("VERTEX_LIGHTS=2"));
                        gpu.want(&frag_key(m, 0, true, baked, 0).with("VERTEX_LIGHTS"));
                    } else {
                        gpu.want(&frag_key(m, *n, true, baked, 0));
                    }
                }
            }
        }
        for k in fixed_keys() {
            gpu.want(&k);
        }
        if self.sun.is_some() {
            for d in &scene.draws {
                if let Some((vs, fs, _)) = self.shadow_keys(d) {
                    gpu.want(&vs);
                    gpu.want(&fs);
                }
            }
            gpu.want(&Key::new("fill_f.cg", &[]));
        }
        if self.day_sky {
            gpu.want(&self.sky_key());
        }
    }

    /// A light field's programs: the point sprite, dimmed by the vista haze
    /// when the place has it.
    fn field_keys(&self, material: u32) -> (Key, Key) {
        let vs = if self.mats[material as usize].vista { Key::new("lights_v.cg", &["VISTA"]) } else { Key::new("lights_v.cg", &[]) };
        (vs, Key::new("lights_f.cg", &[]))
    }

    /// The light fields: one point sprite per light (`lights_v.cg`), added
    /// to the scene, depth-tested against it without writing depth. The
    /// POINT_01UV polygon mode generates the sprite coordinate the fragment
    /// program reads (POINTCOORD). `target_h` is the scene target's height
    /// in pixels (the sprites' unit).
    #[allow(clippy::too_many_arguments)]
    unsafe fn light_fields(&mut self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, scene: &Scene, f: &FrameConsts, planes: &[Vec4; 5], msaa: u32, target_h: f32, st: &mut PassStats) {
        if !self.has_fields || self.settings.skip & 0x100 != 0 {
            return;
        }
        let mut state = false;
        for d in scene.draws.iter().filter(|d| d.lights) {
            let Some(field) = self.mats[d.material as usize].field else { continue };
            if !camera::visible(planes, d.min, d.max) {
                st.culled += 1;
                continue;
            }
            let (vs, fs) = self.field_keys(d.material);
            let key = PipeKey { vs, fs, layout: Layout::Lights, blend: BlendMode::Additive, output: Out::Half4, msaa };
            let Some(p) = gpu.pipeline(&key).map(|p| p as *const Pipeline) else {
                st.missing += 1;
                continue;
            };
            let p = &*p;
            if !state {
                g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_GREATER_EQUAL);
                g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
                g::sceGxmSetFrontDepthBias(ctx, 0, 0);
                g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
                g::sceGxmSetFrontPolygonMode(ctx, g::SceGxmPolygonMode_SCE_GXM_POLYGON_MODE_POINT_01UV);
                state = true;
            }
            self.use_pipeline(ctx, p);
            // The range is in pixels of a 272-pixel-high frame. Under 2
            // pixels a sprite's samples at pixel centres no longer add up to
            // its area: the light would flicker as it moves.
            let k = target_h / 272.0;
            let min = (self.settings.field_min.unwrap_or(field.min_pixels) * k).max(2.0);
            let max = (self.settings.field_max.unwrap_or(field.max_pixels) * k).max(min);
            let t = f.eye[3].rem_euclid(field.period);
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::Dequant, &d.dequant);
            u.set(p, U::ViewProj, &f.vp);
            u.set(p, U::Eye, &f.eye);
            u.set(p, U::Field, &[target_h / f.tan_half, min, max, field.gain]);
            u.set(p, U::FieldT, &[t / field.period, (t * 4.0).fract() * core::f32::consts::TAU, field.depth_pull * 0.001, 0.0]);
            if let Some(v) = &self.vista {
                u.set(p, U::Vista, &v.k);
                u.set(p, U::VistaEye, &f.vista_eye);
            }
            g::sceGxmSetVertexStream(ctx, 0, d.vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_POINTS, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.field_ib.cast(), d.count.min(pc::LightPoint::PER_DRAW as u32));
            st.fields += 1;
            st.points += d.count;
        }
        if state {
            g::sceGxmSetFrontPolygonMode(ctx, g::SceGxmPolygonMode_SCE_GXM_POLYGON_MODE_TRIANGLE_FILL);
        }
    }

    /// Shadow-pass programs for a draw that casts: static, opaque or cut out.
    fn shadow_keys(&self, d: &crate::scene::DrawGpu) -> Option<(Key, Key, Layout)> {
        let m = &self.mats[d.material as usize];
        let v = variant(d);
        if v == 1 || d.node.is_some() || m.transparent || m.class == 2 || m.class == 3 || m.water.is_some() {
            return None;
        }
        let vs = surface_key(v, !m.alpha_test, VsNeeds::default());
        let fs = Key::new("shadow_f.cg", if m.alpha_test { &["ALPHA_TEST"][..] } else { &[] });
        Some((vs, fs, [Layout::Static, Layout::Skinned, Layout::Baked][v]))
    }

    /// Draws the sun's shadow map once every program it needs is ready.
    unsafe fn shadow_pass(&mut self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, scene: &Scene) -> Result<(), String> {
        let Some(sp) = self.sun.as_mut().map(|s| s as *mut SunPass) else { return Ok(()) };
        let fill = PipeKey { vs: key_v("post_v.cg", &[]), fs: Key::new("fill_f.cg", &[]), layout: Layout::Pos2, blend: BlendMode::Opaque, output: Out::Uchar4, msaa: Msaa::None.gxm() };
        let Some(fill) = gpu.pipeline(&fill).map(|p| p as *const Pipeline) else { return Ok(()) };
        let mut draws = Vec::new();
        for (i, d) in scene.draws.iter().enumerate() {
            let Some((vs, fs, layout)) = self.shadow_keys(d) else { continue };
            let key = PipeKey { vs, fs, layout, blend: BlendMode::Opaque, output: Out::Uchar4, msaa: Msaa::None.gxm() };
            match gpu.pipeline(&key) {
                Some(p) => draws.push((i, p as *const Pipeline)),
                None => return Ok(()),
            }
        }
        let size = (*sp).target.width;
        (*sp).target.begin(ctx, 1.0)?;
        Self::viewport(ctx, size, size);
        g::sceGxmSetCullMode(ctx, g::SceGxmCullMode_SCE_GXM_CULL_NONE);
        g::sceGxmSetFrontDepthBias(ctx, 0, 0);
        // Everything starts at the far end of the light (lit).
        self.use_pipeline(ctx, &*fill);
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED);
        let u = Uniforms::reserve(ctx, &*fill);
        u.set(&*fill, U::RayZ, &[0.0; 4]);
        u.set(&*fill, U::Base, &[1.0; 4]);
        g::sceGxmSetVertexStream(ctx, 0, self.tri_vb.cast());
        g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, self.tri_ib.cast(), 3);
        g::sceGxmSetFrontDepthFunc(ctx, g::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_LESS_EQUAL);
        g::sceGxmSetFrontDepthWriteEnable(ctx, g::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_ENABLED);
        for (i, p) in draws {
            let d = &scene.draws[i];
            let p = &*p;
            self.use_pipeline(ctx, p);
            let m = &self.mats[d.material as usize];
            let u = Uniforms::reserve(ctx, p);
            u.set(p, U::Model, &scene.model_rows(d));
            u.set(p, U::Dequant, &d.dequant);
            u.set(p, U::ViewProj, &(*sp).vp);
            u.set(p, U::Uv, &d.uv);
            u.set(p, U::SunDir, &(*sp).dir);
            u.set(p, U::ShadowK, &(*sp).k);
            u.set(p, U::Base, &m.base);
            u.set(p, U::Emissive, &m.emissive);
            if let Some(t) = m.tex[0] {
                bind(ctx, p, S::Albedo, &scene.textures[t].gxm);
            }
            g::sceGxmSetVertexStream(ctx, 0, d.vb.cast());
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, d.ib.cast(), d.count);
        }
        (*sp).target.end(ctx, None);
        (*sp).ready = true;
        Ok(())
    }

    /// Makes the scene targets of resolution `level` (both MSAA modes) and
    /// its 8-bit frame on first use.
    unsafe fn ensure_level(&mut self, level: usize) -> Result<(), String> {
        let (w, h) = SCALES[level];
        for (k, msaa) in [Msaa::X4, Msaa::None].into_iter().enumerate() {
            let i = level * 2 + k;
            if self.mains[i].is_none() {
                let t = Target::new(&mut self._vram, &mut self._mem, w, h, ColorFormat::Rgba16f, msaa, Depth::Transient)?;
                let mut point = t.texture;
                g::sceGxmTextureSetMinFilter(&mut point, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT);
                g::sceGxmTextureSetMagFilter(&mut point, g::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT);
                self.main_points[i] = point;
                self.mains[i] = Some(t);
            }
        }
        if self.finals[level].is_none() {
            self.finals[level] = Some(Target::new(&mut self._vram, &mut self._mem, w, h, ColorFormat::Rgba8, Msaa::None, Depth::None)?);
        }
        Ok(())
    }

    fn main_t(&self, mi: usize) -> &Target {
        self.mains[mi].as_ref().expect("scene target made by ensure_level")
    }

    fn final_t(&self, level: usize) -> &Target {
        self.finals[level].as_ref().expect("frame target made by ensure_level")
    }

    fn mi(&self) -> usize {
        self.level() * 2 + (self.settings.msaa != Msaa::X4) as usize
    }

    /// Effects this place has (the settings sheet offers only these).
    pub fn has_rain(&self) -> bool {
        self.has_rain
    }

    pub fn has_haze(&self) -> bool {
        self.has_haze
    }

    pub fn has_reflection(&self) -> bool {
        self.has_reflection
    }

    /// Makes the targets of a resolution level, so a change of resolution
    /// can be refused when video memory does not hold them.
    ///
    /// # Safety
    /// Render thread, outside any scene.
    pub unsafe fn prepare_level(&mut self, level: usize) -> Result<(), String> {
        self.ensure_level(level.min(SCALES.len() - 1))
    }

    /// Quality step the governor holds.
    pub fn step(&self) -> Step {
        let mut step = self.profile.steps[self.governor.step.min(self.profile.steps.len() - 1)];
        let o = &self.settings;
        step.detail_m = o.detail_m.unwrap_or(step.detail_m);
        step.lod_pixels = o.lod_pixels.unwrap_or(step.lod_pixels);
        step.cull_size = o.cull_size.unwrap_or(step.cull_size);
        step.haze_size = o.haze_size.unwrap_or(step.haze_size).min(1);
        step.haze_lights = o.haze_lights.unwrap_or(step.haze_lights);
        step.bloom_full = o.bloom_full.unwrap_or(step.bloom_full);
        step
    }

    /// Resolution level in use: the fixed setting, or the governor's (a
    /// boost level above step 0, or the step's).
    pub fn level(&self) -> usize {
        if (self.settings.scale as usize) < SCALES.len() { self.settings.scale as usize } else { self.governor.level(self.profile) }
    }

    /// Feeds the governor a frame (see `Governor::feedback`); a boost level
    /// whose targets do not fit in video memory becomes the cap.
    ///
    /// # Safety
    /// Render thread, outside any scene.
    pub unsafe fn feedback(&mut self, frame_ms: f32, gpu_ms: Option<f32>, raw_ms: f32) {
        let p = self.profile;
        if self.governor.feedback(p, frame_ms, gpu_ms, raw_ms) && (self.settings.scale as usize) >= SCALES.len() {
            let level = self.governor.level(p);
            if self.ensure_level(level).is_err() {
                self.governor.boost -= 1;
                self.governor.boost_cap = self.governor.boost;
            }
        }
    }

    /// Switches profile: settings back to the profile's, governor to its
    /// best step, view-dependent buffers redrawn.
    pub fn set_profile(&mut self, profile: &'static Profile) {
        self.profile = profile;
        self.settings = Settings::for_profile(profile);
        self.governor = Governor::new();
        self.refl_ready = false;
        self.haze_ready = false;
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
        self.timeline.cpu.clear();
        self.timeline.mark = t0;
        self.timeline.first_kick = None;

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
        let reflection = self.settings.reflection && self.has_reflection;
        self.refl_ready &= reflection;

        // ---------------------------------------------------- sun shadow
        if self.sun.as_ref().is_some_and(|s| !s.ready) {
            self.shadow_pass(ctx, gpu, scene)?;
        }

        // ---------------------------------------------------- reflection
        if reflection && draw_refl {
            self.refl_ready = true;
            let vpm = vp * camera::mirror();
            let mut eye = view.pos;
            eye.y = -eye.y;
            let mview = View { pos: eye, target: Vec3::new(view.target.x, -view.target.y, view.target.z), fov_y: view.fov_y };
            let mconsts = FrameConsts::new(scene, &mview, time, rain, vpm, aspect);
            let ri = self.settings.reflection_size;
            let refl = &mut self.refls[ri].0 as *mut Target;
            (*refl).begin(ctx, 0.0)?;
            Self::viewport(ctx, (*refl).width, (*refl).height);
            let planes = camera::planes(&vpm);
            let mut st = PassStats::default();
            self.draw_meshes(ctx, gpu, scene, &mconsts, &planes, true, false, &mut st);
            self.sky(ctx, gpu, &mconsts, Out::Half4, Msaa::None.gxm());
            self.draw_meshes(ctx, gpu, scene, &mconsts, &planes, true, true, &mut st);
            self.timeline.end(ctx, &*refl, "reflection");
            self.stats.reflection = st;
            let (src, dst) = (&(*refl).texture as *const _, &mut self.refls[ri].1 as *mut Target);
            self.post(ctx, gpu, &mut *dst, "down_f.cg", &[(S::Source, src)], &[(U::Texel, [1.0 / (*refl).width as f32, 1.0 / (*refl).height as f32, 0.0, 0.0])], &frame)?;
        }

        // ---------------------------------------------------- main
        self.ensure_level(self.level())?;
        let mi = self.mi();
        self.mains[mi].as_mut().expect("scene target").begin(ctx, 0.0)?;
        Self::viewport(ctx, self.main_t(mi).width, self.main_t(mi).height);
        let planes = camera::planes(&vp);
        let mut st = PassStats::default();
        let msaa = self.settings.msaa.gxm();
        self.draw_meshes(ctx, gpu, scene, &frame, &planes, false, false, &mut st);
        if self.settings.skip & 0x80 == 0 {
            self.sky(ctx, gpu, &frame, Out::Half4, msaa);
        }
        // Lights in front of the opaque scene and the sky; glass and other
        // blended surfaces drawn after them cover them.
        let target_h = self.main_t(mi).height as f32;
        self.light_fields(ctx, gpu, scene, &frame, &planes, msaa, target_h, &mut st);
        self.draw_meshes(ctx, gpu, scene, &frame, &planes, false, true, &mut st);
        if self.settings.rain && self.has_rain {
            self.particles(ctx, gpu, scene, &frame, rain);
        }
        let main_target = self.main_t(mi) as *const Target;
        self.timeline.end(ctx, &*main_target, "main");
        self.stats.main = st;

        // ---------------------------------------------------- haze, bloom
        let hz = &frame.haze;
        let mut haze_u: Vec<(U, [f32; 4])> = vec![(U::Eye, frame.eye), (U::Haze, hz.params), (U::Ambient, hz.ambient), (U::BoxMin, hz.box_min), (U::BoxMax, hz.box_max)];
        if !self.settings.haze {
            haze_u[1].1 = [0.0, 0.0, 0.0, SKY_FAR];
        }
        // Far rain curtain, traced in the haze pass (bit 0 of `fx`).
        let curtain = if self.settings.rain && self.has_rain && self.settings.fx & 1 != 0 { 0.08 * rain.intensity } else { 0.0 };
        haze_u.push((U::Curtain, [0.55, 0.6, 0.72, curtain]));
        let step = self.step();
        let hi = step.haze_size;
        // A different haze buffer holds nothing yet.
        if self.haze_index != hi {
            self.haze_index = hi;
            self.haze_ready = false;
        }
        // Lights integrated per pixel, compiled in (the most important first).
        let (haze_lights, haze_n) = match step.haze_lights {
            0..=2 => ("HAZE_LIGHTS=2", 2),
            3 | 4 => ("HAZE_LIGHTS=4", 4),
            _ => ("HAZE_LIGHTS=6", 6),
        };
        // A step without haze skips the pass; its buffer is weighted out and
        // redrawn in full when haze returns.
        let haze_on = step.haze && self.has_haze;
        let haze_w = if haze_on { 1.0 } else { 0.0 };
        self.haze_ready &= haze_on;
        if haze_on && draw_haze {
            self.haze_ready = true;
            let (src, dst) = (&self.main_points[mi] as *const _, &mut self.hazes[hi] as *mut Target);
            // Exactly the program's array length: a longer upload writes past
            // the parameter into the rest of the uniform buffer.
            let k = haze_n * 4;
            let arrays = [(U::FogPos, &hz.pos[..k]), (U::FogCol, &hz.col[..k]), (U::FogDir, &hz.dir[..k])];
            self.post_keyed(ctx, gpu, &mut *dst, key_v("post_v.cg", &[]), Key::new("haze_f.cg", &[haze_lights]), &[(S::Scene, src)], &haze_u, &arrays, &frame)?;
        }

        // Bloom: prefilter (bright scene + haze), then a mip blur. The full
        // chain runs W/4 → W/8 → W/16 → W/8 → W/4, the short one W/8 → W/16 → W/8.
        let mut bloom_tex: *const g::SceGxmTexture = &self.up[0].texture;
        let bloom = self.settings.bloom && step.bloom;
        if bloom {
            let full = step.bloom_full;
            let pre = &mut self.prefilters[if full { 0 } else { 1 }] as *mut Target;
            let a = &self.main_t(mi).texture as *const _;
            // Without haze buffers the prefilter's haze input is weighted out.
            let b = self.hazes.get(hi).map_or(a, |t| &t.texture as *const _);
            // Places with light fields threshold each scene pixel (PER_PIXEL):
            // at a 2×2 block per output pixel the taps sit on pixel centres,
            // at larger blocks they average 2×2 each.
            let ratio = self.main_t(mi).width as f32 / (*pre).width as f32;
            let texel = [1.0 / self.main_t(mi).width as f32, 1.0 / self.main_t(mi).height as f32, if ratio <= 2.0 { 0.5 } else { 1.0 }, 0.0];
            let fs = if self.has_fields { Key::new("prefilter_f.cg", &["PER_PIXEL"]) } else { Key::new("prefilter_f.cg", &[]) };
            self.post_keyed(
                ctx,
                gpu,
                &mut *pre,
                key_v("post_v.cg", &[]),
                fs,
                &[(S::Scene, a), (S::HazeTex, b)],
                &[(U::Texel, texel), (U::Threshold, [self.post.bloom_threshold, self.post.bloom_smoothing, haze_w, 0.0])],
                &[],
                &frame,
            )?;
            let (d8, d16) = (&mut self.down[0] as *mut Target, &mut self.down[1] as *mut Target);
            let (u8_, u4) = (&mut self.up[0] as *mut Target, &mut self.up[1] as *mut Target);
            // (source, destination, support for upsamples)
            let chain: Vec<(*mut Target, *mut Target, Option<*mut Target>)> = if full {
                vec![(pre, d8, None), (d8, d16, None), (d16, u8_, Some(d8)), (u8_, u4, Some(pre))]
            } else {
                vec![(pre, d16, None), (d16, u8_, Some(pre))]
            };
            for (src, dst, support) in chain {
                let texel = [1.0 / (*src).width as f32, 1.0 / (*src).height as f32, 0.7, 0.0];
                match support {
                    None => self.post(ctx, gpu, &mut *dst, "down_f.cg", &[(S::Source, &(*src).texture)], &[(U::Texel, texel)], &frame)?,
                    Some(sup) => self.post(ctx, gpu, &mut *dst, "up_f.cg", &[(S::Source, &(*src).texture), (S::Support, &(*sup).texture)], &[(U::Texel, texel)], &frame)?,
                }
                bloom_tex = &(*dst).texture;
            }
        }
        // ---------------------------------------------------- composite
        // Tone map and grade at scene resolution; the display scene scales.
        let lv = self.level();
        let (fw, fh) = (self.final_t(lv).width as f32, self.final_t(lv).height as f32);
        let mask = self.mask(fade, bars);
        let scene_tex = &self.main_t(mi).texture as *const _;
        let haze_tex = self.hazes.get(hi).map_or(scene_tex, |t| &t.texture as *const _);
        let (lut, grain) = (&self.lut as *const _, &self.grain as *const _);
        let dst = self.finals[lv].as_mut().expect("frame target") as *mut Target;
        let mut defs: Vec<&'static str> = Vec::new();
        if haze_on {
            defs.push("HAZE");
        }
        if bloom {
            defs.push("BLOOM");
        }
        // Grain moves to a new offset of its noise tile every frame.
        let o = (self.tick as f32 * 0.618_034).fract();
        let grain_k = [fw / GRAIN as f32, fh / GRAIN as f32, o, (self.tick as f32 * 0.414_214 + o).fract()];
        self.post_keyed(
            ctx,
            gpu,
            &mut *dst,
            key_v("post_v.cg", &["GRAIN"]),
            Key::new("composite_f.cg", &defs),
            &[(S::Scene, scene_tex), (S::HazeTex, haze_tex), (S::Bloom, bloom_tex), (S::Lut, lut), (S::Mask, mask), (S::Grain, grain)],
            &[(U::BloomK, [self.post.bloom_intensity, self.settings.exposure, 0.0, 0.0]), (U::Grade, [haze_w, 0.0, self.post.grain, 0.0]), (U::GrainK, grain_k)],
            &[],
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
        let Some(fin) = self.finals[self.level()].as_ref() else { return };
        bind(ctx, p, S::Source, &fin.texture);
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
        self.post_keyed(ctx, gpu, dst, key_v("post_v.cg", &[]), Key::new(fs, &[]), tex, uniforms, arrays, frame)
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn post_keyed(
        &mut self,
        ctx: *mut g::SceGxmContext,
        gpu: &mut Gpu,
        dst: &mut Target,
        vs: Key,
        fs: Key,
        tex: &[(S, *const g::SceGxmTexture)],
        uniforms: &[(U, [f32; 4])],
        arrays: &[(U, &[f32])],
        frame: &FrameConsts,
    ) -> Result<(), String> {
        dst.begin(ctx, 0.0)?;
        Self::viewport(ctx, dst.width, dst.height);
        let output = if dst.format == ColorFormat::Rgba8 { Out::Uchar4 } else { Out::Half4 };
        let label = fs.file;
        let key = PipeKey { vs, fs, layout: Layout::Pos2, blend: BlendMode::Opaque, output, msaa: Msaa::None.gxm() };
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
        self.timeline.end(ctx, dst, label);
        Ok(())
    }

    /// The screen mask for this frame's letterbox and fade.
    fn mask(&mut self, fade: f32, bars: f32) -> *const g::SceGxmTexture {
        let key = ((fade.clamp(0.0, 1.0) * 255.0).round() as u32, (bars.clamp(0.0, 1.0) * 1023.0).round() as u32);
        let i = match self.mask_at {
            Some((i, k)) if k == key => i,
            prev => {
                let i = prev.map_or(0, |(i, _)| (i + 1) % MASK_BUFFERS);
                write_mask(self.masks[i].0, key.0 as f32 / 255.0, key.1 as f32 / 1023.0, self.post.vignette);
                self.mask_at = Some((i, key));
                i
            }
        };
        &self.masks[i].1
    }

    /// The sky's fragment program: the night gradient, or the day sky (with
    /// its twilight terms after sunset).
    fn sky_key(&self) -> Key {
        match (self.day_sky, self.twilight) {
            (true, true) => Key::new("sky_day_f.cg", &["TWILIGHT"]),
            (true, false) => Key::new("sky_day_f.cg", &[]),
            _ => Key::new("sky_f.cg", &[]),
        }
    }

    unsafe fn sky(&mut self, ctx: *mut g::SceGxmContext, gpu: &mut Gpu, f: &FrameConsts, out: Out, msaa: u32) {
        let key = PipeKey { vs: key_v("sky_v.cg", &[]), fs: self.sky_key(), layout: Layout::Pos2, blend: BlendMode::Opaque, output: out, msaa };
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
        if let Some(d) = &f.day {
            u.set(p, U::SkyDay, &d.day);
            u.set(p, U::SkySun, &d.sun);
            u.set(p, U::SkyGlow, &d.glow);
            u.set(p, U::SkyDisc, &d.disc);
            u.set(p, U::CloudSun, &d.cloud_sun);
            u.set(p, U::CloudAmb, &d.cloud_amb);
            u.set(p, U::TwBand, &d.tw[0]);
            u.set(p, U::TwBelt, &d.tw[1]);
            u.set(p, U::TwShape, &d.tw[2]);
            u.set(p, U::TwShadow, &d.tw[3]);
        }
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
            if d.lights || m.transparent != transparent || self.settings.skip & (1 << m.class) != 0 {
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
            let min_size = if mirror { self.profile.reflection_min_size } else { self.step().cull_size };
            if min_size > 0.0 && (hi - lo).length_squared() * 0.25 < dist * min_size * min_size {
                st.culled += 1;
                continue;
            }
            // Solid opaque first, alpha-tested after (hidden-surface removal
            // on the tiler resolves the solid ones before any shading).
            let key = if transparent { -dist } else { d.material as f32 + if m.alpha_test { 1.0e4 } else { 0.0 } };
            order.push((i as u32, key, lo, hi));
        }
        let mode = (self.settings.msaa, self.settings.flat, self.settings.vertex_lights);
        if self.pipe_epoch != gpu.epoch || self.pipe_mode != mode {
            self.pipe_cache.iter_mut().for_each(|p| *p = core::ptr::null());
            self.pipe_epoch = gpu.epoch;
            self.pipe_mode = mode;
        }
        order.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal));
        let msaa = if mirror { Msaa::None.gxm() } else { self.settings.msaa.gxm() };
        let step = self.step();
        // World size of one target pixel at 1 m, for LOD errors.
        let target_h = if mirror { self.refls[self.settings.reflection_size].0.height } else { self.main_t(self.mi()).height };
        let pixel = f.pixel * H as f32 / target_h as f32;
        let mut last_state: Option<(bool, bool, Option<(i32, i32)>)> = None;
        for &(i, _, lo, hi) in &order {
            let d = &scene.draws[i as usize];
            let mi = d.material as usize;
            let max_n = if mirror { REFL_LIGHTS.min(self.settings.max_lights) } else { self.settings.max_lights.min(LIGHTS_MAX) };
            let v = variant(d);
            let near_dist = (f.eye3.clamp(lo, hi) - f.eye3).length();
            let far = !mirror && self.mats[mi].lit && near_dist > step.detail_m;
            // 0 full detail, 1 LITE (no detail maps), 2 FAR.
            let tier = if far { 2 } else if !mirror && self.mats[mi].lit && !self.settings.detail_maps { 1 } else { 0 };
            // The coarsest level whose error projects under the step's pixel
            // threshold. The mirror image is small and blurred: twice the
            // threshold there, and never finer than LOD1.
            let limit = near_dist.max(0.1) * pixel * step.lod_pixels;
            let lod = if mirror { d.lods.iter().rev().find(|l| l.2 < limit * 2.0).or(d.lods.first()) } else { d.lods.iter().rev().find(|l| l.2 < limit) };
            // Every part of the draw is narrower than the level's error.
            if lod.is_some_and(|l| l.1 == 0) {
                st.culled += 1;
                continue;
            }
            // Baked draws light only moving sources per pixel. Beyond the
            // detail distance only the wet ground keeps them (a passing car's
            // beam on the street): a car's headlights reach whole 32 m chunks
            // of walls, and per-pixel lights there cost ~25 ms at 480×272.
            // One per baked draw: the car's merged headlights, or its tail light.
            let max_n = if d.baked { if far && self.mats[mi].class != 0 { 0 } else { max_n.min(1) } } else { max_n };
            let lights = if self.mats[mi].lit { select_lights(scene, lo, hi, max_n, d.baked) } else { LightSet::default() };
            let n = lights.n;
            // Light-count class: 0 none; 1 one (baked) or two; 2 four.
            let lc = match n {
                0 => 0,
                1 | 2 => 1,
                _ => 2,
            };
            let slot = (((mi * 3 + v) * 2 + mirror as usize) * 3 + tier) * 3 + lc;
            let mut pp = self.pipe_cache[slot];
            if pp.is_null() {
                // Moving and skinned standard meshes: lights per vertex.
                let vlit = n > 0 && !d.baked && self.settings.vertex_lights && self.mats[mi].kind == pc::Kind::Standard;
                let mut vs = surface_key(v, self.settings.flat, vs_needs(&self.mats[mi], tier, mirror));
                let mut fs = if self.settings.flat { Key::new("debug_f.cg", &[]) } else { frag_key(&self.mats[mi], if vlit { 0 } else { n }, mirror, d.baked, tier) };
                if vlit && !self.settings.flat {
                    vs = vs.with(if n == 2 { "VERTEX_LIGHTS=2" } else { "VERTEX_LIGHTS=4" });
                    fs = fs.with("VERTEX_LIGHTS");
                }
                let key = PipeKey {
                    vs,
                    fs,
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
            match m.uv_anim {
                Some(a) => u.set(p, U::Uv, &a.apply(d.uv, f.eye[3])),
                None => u.set(p, U::Uv, &d.uv),
            }
            if let Some(s) = d.skin {
                let mut bones = core::mem::take(&mut self.bones);
                scene.bone_rows(s, &mut bones);
                // The skinned program holds MAX_BONES = 24 bones (3 rows each).
                u.set(p, U::Bones, &bones[..bones.len().min(24 * 12)]);
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
            u.set(p, U::Pbr, if mirror || tier > 0 { &m.pbr_flat } else { &m.pbr });
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
            u.set(p, U::ReflOn, &[if self.settings.reflection && self.has_reflection { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0]);
            u.set(p, U::Haze, &f.skyline_haze);
            if let Some(v) = &self.vista {
                u.set(p, U::Vista, &v.k);
                u.set(p, U::VistaEye, &f.vista_eye);
                u.set(p, U::VistaSun, &v.sun);
                u.set(p, U::VistaGlow, &v.glow);
                u.set(p, U::VistaSky, &v.sky);
                u.set(p, U::VistaSunSky, &v.sun_sky);
            }
            if let Some(w) = &m.water {
                // Offsets wrap: the wave texture repeats.
                let t = f.eye[3];
                let layer = |l: &[f32; 3]| [l[0], 0.0, (t * l[1] * l[0]).rem_euclid(1.0), (t * l[2] * l[0]).rem_euclid(1.0)];
                let (a, b) = (layer(&w.waves[0]), layer(&w.waves[1]));
                u.set(p, U::Wave, &[a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]]);
                u.set(p, U::WaterK, &[w.body[0], w.body[1], w.body[2], w.distance_roughness]);
                if let Some(s) = w.shallow {
                    u.set(p, U::WaterShallow, &[s[0], s[1], s[2], 0.0]);
                }
            }
            if let Some(sp) = &self.sun {
                u.set(p, U::SunDir, &sp.dir);
                u.set(p, U::SunRad, &sp.rad);
                u.set(p, U::SunMat, &sp.mat);
                u.set(p, U::ShadowK, &sp.k);
                bind(ctx, p, S::Shadow, &sp.map);
            }
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
                if let Some((sharp, blur)) = self.refls.get(self.settings.reflection_size) {
                    bind(ctx, p, S::ReflSharp, &sharp.texture);
                    bind(ctx, p, S::ReflBlur, &blur.texture);
                }
            }
            g::sceGxmSetVertexStream(ctx, 0, d.vb.cast());
            let (ib, count) = lod.map_or((d.ib, d.count), |l| (l.0, l.1));
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, ib.cast(), count);
            st.draws += 1;
            st.tris += count / 3;
            st.lod += lod.is_some() as u32;
            if self.mats[mi].lit {
                st.lights[lc] += 1;
                st.unbaked += !d.baked as u32;
            }
            if !mirror {
                if self.stats.by_material.len() <= mi {
                    self.stats.by_material.resize(mi + 1, 0);
                    self.stats.draws_by_material.resize(mi + 1, 0);
                }
                self.stats.by_material[mi] += count / 3;
                self.stats.draws_by_material[mi] += 1;
            }
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
            if buf.count == 0 || self.settings.fx & (2 << k) == 0 || (k == 3 && !self.settings.steam) {
                continue;
            }
            // Streaks are seeded uniformly in their box: a prefix is a
            // uniformly thinner rain.
            let count = if k == 0 { buf.count.min(self.settings.streaks * 6) } else { buf.count };
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
            g::sceGxmDraw(ctx, g::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES, g::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16, buf.ib.cast(), count);
            self.stats.fx_quads += count / 6;
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

/// Varyings a material program reads beyond world position, normal and
/// UV. The vertex program writes only these; unread varyings cost
/// parameter-buffer bandwidth on the tiler.
#[derive(Clone, Copy, Default)]
struct VsNeeds {
    tangent: bool,
    color: bool,
    /// Clip position, for the mirror lookup.
    screen: bool,
    /// World-plane wave coordinates instead of the mesh UV (water).
    waves: bool,
    /// The vista haze (inscatter, transmittance).
    vista: bool,
}

fn vs_needs(m: &Mat, tier: usize, mirror: bool) -> VsNeeds {
    let has = |d: &str| m.defines.contains(&d);
    let n = match m.kind {
        pc::Kind::Standard => VsNeeds { tangent: has("NORMAL_MAP") && tier == 0 && !mirror, color: has("VERTEX_COLOR"), screen: has("PLANAR") && !mirror, ..VsNeeds::default() },
        pc::Kind::InteriorWindow | pc::Kind::Skyline => VsNeeds { tangent: true, color: true, ..VsNeeds::default() },
        pc::Kind::Unlit | pc::Kind::Products => VsNeeds { color: true, ..VsNeeds::default() },
        pc::Kind::Water => VsNeeds { color: has("SHALLOW"), waves: true, ..VsNeeds::default() },
        pc::Kind::Glass | pc::Kind::Tower | pc::Kind::Lights => VsNeeds::default(),
    };
    VsNeeds { vista: has("VISTA"), ..n }
}

/// `flat`: profiling variant that outputs position and world only (pairs
/// with debug_f.cg).
fn surface_key(variant: usize, flat: bool, n: VsNeeds) -> Key {
    let mut defs: Vec<&str> = match variant {
        1 => vec!["SKINNED", "MAX_BONES=24"],
        2 => vec!["BAKED"],
        _ => vec![],
    };
    if flat {
        defs.push("FLAT");
    } else {
        for (on, d) in [(n.tangent, "TANGENT"), (n.color, "COLOR"), (n.screen, "SCREEN"), (n.waves, "WAVES"), (n.vista, "VISTA")] {
            if on {
                defs.push(d);
            }
        }
    }
    Key::new("surface_v.cg", &defs)
}

/// `tier`: 0 full detail, 1 LITE (no normal, ORM or streak maps), 2 FAR.
fn frag_key(m: &Mat, lights: usize, reflection: bool, baked: bool, tier: usize) -> Key {
    let mut defs: Vec<&str> = m.defines.clone();
    let l = format!("LIGHTS={lights}");
    let l: &'static str = match lights {
        0 => "LIGHTS=0",
        1 => "LIGHTS=1",
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
    // The standard and glass programs have the reduced tiers.
    if matches!(m.kind, pc::Kind::Standard | pc::Kind::Glass) {
        match tier {
            1 => defs.push("LITE"),
            2 => defs.push("FAR"),
            _ => {}
        }
    }
    Key::new(m.fs, &defs)
}

fn fixed_keys() -> Vec<Key> {
    let mut v = vec![
        Key::new("post_v.cg", &[]),
        Key::new("sky_v.cg", &[]),
        Key::new("sky_f.cg", &[]),
        Key::new("haze_f.cg", &["HAZE_LIGHTS=2"]),
        Key::new("haze_f.cg", &["HAZE_LIGHTS=4"]),
        Key::new("haze_f.cg", &["HAZE_LIGHTS=6"]),
        Key::new("prefilter_f.cg", &[]),
        Key::new("prefilter_f.cg", &["PER_PIXEL"]),
        Key::new("down_f.cg", &[]),
        Key::new("up_f.cg", &[]),
        Key::new("post_v.cg", &["GRAIN"]),
        Key::new("composite_f.cg", &[]),
        Key::new("composite_f.cg", &["BLOOM"]),
        Key::new("composite_f.cg", &["HAZE", "BLOOM"]),
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
    /// Lights in the set, padded to the program's count (0, 1, 2 or 4).
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
    let padded = if n == 0 { 0 } else if max == 1 { 1 } else if n <= 2 { 2 } else { 4 };
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
    set.n = padded;
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
    /// tan(fovY / 2).
    tan_half: f32,
    /// `uVistaEye` (the vista haze at the eye's height).
    vista_eye: [f32; 4],
    env: *const g::SceGxmTexture,
    puddles: *const g::SceGxmTexture,
    ripples: *const g::SceGxmTexture,
    beads: *const g::SceGxmTexture,
    clouds: *const g::SceGxmTexture,
    haze: HazeConsts,
    fx: FxConsts,
    day: Option<DaySkyConsts>,
}

/// `sky_day_f.cg` uniforms.
struct DaySkyConsts {
    day: [f32; 4],
    sun: [f32; 4],
    glow: [f32; 4],
    disc: [f32; 4],
    cloud_sun: [f32; 4],
    cloud_amb: [f32; 4],
    /// Twilight: band colour + height, belt colour + elevation, (band sun
    /// bias, band sun power, belt width, belt power), shadow terms.
    tw: [[f32; 4]; 4],
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
            zenith: match &scene.meta.day_sky {
                Some(d) => [d.zenith[0], d.zenith[1], d.zenith[2], d.gradient_power],
                None => [a.sky_zenith[0], a.sky_zenith[1], a.sky_zenith[2], time],
            },
            horizon: match &scene.meta.day_sky {
                Some(d) => [d.horizon[0], d.horizon[1], d.horizon[2], d.ground_blend],
                None => [a.sky_horizon[0], a.sky_horizon[1], a.sky_horizon[2], 1.0 / fx_meta.cloud_cells.max(1.0)],
            },
            glow: match &scene.meta.day_sky {
                Some(d) => [d.ground[0], d.ground[1], d.ground[2], SKY_FAR],
                None => [a.sky_glow[0], a.sky_glow[1], a.sky_glow[2], SKY_FAR],
            },
            day: scene.meta.day_sky.as_ref().map(|d| {
                let sc = |k: f32| [d.sun_color[0] * k, d.sun_color[1] * k, d.sun_color[2] * k];
                // The program weighs the tight lobe by 1: its weight moves
                // into the colour and divides the wide lobe's.
                let (tw, te) = if d.glow_tight[0] > 0.0 { (d.glow_tight[0], d.glow_tight[1]) } else { (1.0, 1.0e4) };
                let g = sc(d.glow * tw);
                let c = sc(d.disc);
                DaySkyConsts {
                    day: [(time * d.drift).fract(), d.fade_elevation.max(1e-3), d.clouds.is_some() as u32 as f32, te],
                    sun: [d.sun_direction[0], d.sun_direction[1], d.sun_direction[2], 0.0],
                    glow: [g[0], g[1], g[2], d.glow_wide[0] / tw],
                    disc: [c[0], c[1], c[2], d.disc_cos_outer],
                    cloud_sun: [d.cloud_sun[0], d.cloud_sun[1], d.cloud_sun[2], d.glow_wide[1]],
                    cloud_amb: [d.cloud_ambient[0], d.cloud_ambient[1], d.cloud_ambient[2], d.disc_cos_inner],
                    tw: d.twilight.as_ref().map_or([[0.0; 4]; 4], |t| {
                        let (b, l, s) = (&t.band, &t.belt, &t.shadow);
                        [
                            [b.color[0], b.color[1], b.color[2], b.height],
                            [l.color[0], l.color[1], l.color[2], l.elevation],
                            [b.sun_bias, b.sun_power, l.width, l.power],
                            [s.strength, s.height, s.power, 0.0],
                        ]
                    }),
                }
            }),
            pixel: 2.0 * ty / H as f32,
            tan_half: ty,
            vista_eye: scene.meta.vista_haze.as_ref().map_or([0.0; 4], |h| [view.pos.y, h.column(view.pos.y), h.density * h.relative_density(view.pos.y), 0.0]),
            env: tex(a.environment),
            puddles: tex(fx_meta.puddles),
            ripples: tex(fx_meta.ripples),
            beads: tex(fx_meta.beads),
            clouds: tex(scene.meta.day_sky.as_ref().and_then(|d| d.clouds).or(fx_meta.clouds)),
            haze,
            fx,
        }
    }
}
