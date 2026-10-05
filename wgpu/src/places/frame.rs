//! The frame of a place (`vita/src/frame.rs`): a planar street reflection, the
//! HDR scene pass with several samples a pixel and the eye distance in alpha,
//! lit haze at a sixth of the resolution, a mip bloom chain and the composite
//! (tone curve and grade) into the screen.
//!
//! Passes of a frame: sun maps, reflection, its blur, main, haze, bloom
//! prefilter, two downsamples, two upsamples, composite.
//!
//! What differs from the PS Vita is what its GPU budget asked of it and a
//! desktop GPU does not: every draw takes the full program (no `LITE` and
//! `FAR` tiers, so sun shadows and detail maps reach as far as their maps
//! do), lights are per pixel on moving meshes too, the scene is drawn at the
//! screen's own size, the sun maps are depth textures compared by the
//! sampler, and textures are filtered anisotropically in place of the
//! PS Vita's level bias.

use std::collections::HashMap;

use glam::{Mat4, Vec2, Vec3, Vec4};
use pocket3d_place as pc;
use pocket3d_place::color::tone;
use pocket_web_wgpu::gpu::Gpu;
use pocket_web_wgpu::wgpu::{self, util::DeviceExt, TextureFormat};

use super::camera::{self, View};
use super::programs::{Blend, Cull, Depth, Groups, Key, Layout, Program, Programs, BONES_BYTES, DEPTH, DRAW_BYTES};
use super::scene::{texel, Scene};

const HDR: TextureFormat = TextureFormat::Rgba16Float;
const LIGHTS_MAX: usize = 4;
const REFL_LIGHTS: usize = 2;
const HAZE_LIGHTS: usize = 6;
const FX_LIGHTS: usize = 8;
const SKY_FAR: f32 = 200.0;
/// A draw switches to a coarser level once that level's error projects under this many pixels, and lit haze
/// integrates this many lights: the PS Vita's `cinematic` profile.
const LOD_PIXELS: f32 = 0.75;
/// A draw's record in the draws' buffer: its constants, on a multiple of the offset alignment.
const DRAW_STRIDE: u64 = 768;
const BONES_STRIDE: u64 = 1280;
/// Floats of a pass's constants (`Pass` in common.wgsl).
const PASS_FLOATS: usize = 380;
/// Floats of a screen pass's constants (`Post` in post.wgsl).
const POST_FLOATS: usize = 27 * 4;
/// LUT cells per axis over AgX's log2 domain [-12.47393, 4.02607].
const LUT: usize = 32;
const GRAIN: usize = 64;

/// What the visitor can switch in a place.
#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub reflection: bool,
    pub haze: bool,
    pub bloom: bool,
    pub rain: bool,
    /// A factor on the scene before the tone curve.
    pub exposure: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { reflection: true, haze: true, bloom: true, rain: true, exposure: 1.0 }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub draws: u32,
    pub tris: u32,
    pub culled: u32,
    /// Draws of the mirror and the sun maps.
    pub mirror_draws: u32,
    pub shadow_draws: u32,
    /// Lights of the light fields drawn.
    pub points: u32,
    pub fx_quads: u32,
}

/// Material resolved to a program and constants.
struct Mat {
    kind: pc::Kind,
    alpha_test: bool,
    program: Program,
    defines: Vec<&'static str>,
    lit: bool,
    blend: Blend,
    two_sided: bool,
    depth_write: bool,
    transparent: bool,
    reflect: bool,
    bias: (i32, i32),
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
    field: Option<pc::LightField>,
    vista: bool,
    /// The cooker's level bias for the material's textures.
    lod_bias: f32,
    group: wgpu::BindGroup,
}

/// `vista`: the place has the vista haze, which replaces the fog.
#[allow(clippy::too_many_arguments)]
fn material(m: &pc::Material, env_scene: f32, textures: &[pc::Texture], sun: bool, moving_shadow: bool, vista: bool, group: wgpu::BindGroup) -> Mat {
    let orm_mean = if m.kind == pc::Kind::Standard { m.orm.map(|t| textures[t as usize].mean) } else { None };
    let mut defines: Vec<&'static str> = Vec::new();
    let mut tex = [None; 4];
    let (program, lit) = match m.kind {
        pc::Kind::Standard => (Program::Standard, true),
        pc::Kind::Unlit => (Program::Unlit, false),
        pc::Kind::Glass => (Program::Glass, true),
        pc::Kind::InteriorWindow => (Program::Window, false),
        pc::Kind::Products => (Program::Products, false),
        pc::Kind::Tower => (Program::Tower, false),
        pc::Kind::Skyline => (Program::Skyline, false),
        pc::Kind::Water => (Program::Water, false),
        pc::Kind::Lights => (Program::Lights, false),
    };
    if let Some(t) = m.albedo {
        tex[0] = Some(t as usize);
        defines.push("ALBEDO_MAP");
    }
    if m.kind == pc::Kind::Standard {
        if m.vertex_pbr {
            defines.push("VERTEX_PBR");
        }
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
        if let Some(wet) = &m.wet {
            defines.push("WET");
            if wet.planar {
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
            if moving_shadow {
                defines.push("MOVING_SHADOW");
            }
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
        defines.push("WAVES");
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
        (pc::Kind::Tower | pc::Kind::Lights, _) => Blend::Additive,
        (pc::Kind::Glass, _) => Blend::Premultiplied,
        (_, pc::Blend::Opaque) => Blend::Opaque,
        (_, pc::Blend::Alpha) => Blend::Alpha,
        (_, pc::Blend::Premultiplied) => Blend::Premultiplied,
        (_, pc::Blend::Additive) => Blend::Additive,
    };
    let transparent = blend != Blend::Opaque;
    // A blended surface writes its coverage where an opaque one writes the eye distance.
    if transparent && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit) {
        defines.push("BLEND");
    }
    let w = m.wet.clone().unwrap_or_default();
    let d = m.damp.clone().unwrap_or_default();
    let base = match m.kind {
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
    Mat {
        kind: m.kind,
        alpha_test: m.alpha_test > 0.0 && matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit),
        program,
        defines,
        lit,
        blend,
        two_sided: m.double_sided || m.kind == pc::Kind::Tower,
        depth_write: m.depth_write && !transparent,
        transparent,
        // Glass is thin and mostly transparent in a blurred mirror image.
        reflect: !w.planar && !matches!(m.kind, pc::Kind::Tower | pc::Kind::Glass | pc::Kind::Water | pc::Kind::Lights),
        bias: m.polygon_offset.map_or((0, 0), |p| (-p[0] as i32, -p[1] as i32)),
        tex,
        base,
        emissive,
        // pbr.w: occlusion strength for the ORM map; without the map, the occlusion itself.
        // Water: pbr.y is the wave faces' slope toward the eye.
        pbr: [m.roughness, m.water.map_or(m.metalness, |w| w.mask), m.normal_scale, if orm_mean.is_some() { m.ao_strength } else { 1.0 }],
        // The mirror's program drops the ORM map and scales by its means instead.
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
        lod_bias: tex.iter().flatten().map(|&t| textures[t].lod_bias).fold(0.0, f32::min),
        group,
    }
}

/// The colour table: `LUT` slices of LUT x LUT side by side (blue picks the slice, red runs across it, green
/// down), RGBA8 in sRGB.
fn tone_lut(post: &pc::Post) -> Vec<u8> {
    let mut px = vec![0u8; LUT * LUT * LUT * 4];
    let at = |i: usize| (i as f32 / (LUT - 1) as f32 * 16.5 - 12.47393).exp2();
    for b in 0..LUT {
        for g in 0..LUT {
            for r in 0..LUT {
                let c = tone([at(r), at(g), at(b)], post);
                // (a row of the texture holds every slice's row g)
                let o = (g * LUT * LUT + b * LUT + r) * 4;
                px[o..o + 4].copy_from_slice(&[(c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8, 255]);
            }
        }
    }
    px
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

struct FxBuf {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    count: u32,
}

/// Particle quads: a seed a quad, four corners, two points.
fn fx_quads(gpu: &Gpu, n: usize, corners: [[f32; 2]; 4], mut per: impl FnMut(usize) -> ([f32; 4], [f32; 3], [f32; 3])) -> FxBuf {
    let n = n.min(16383);
    let mut vb = Vec::with_capacity(n * 4 * 40);
    let mut ib: Vec<u16> = Vec::with_capacity(n * 6);
    for i in 0..n {
        let (seed, a, b) = per(i);
        for c in &corners {
            for s in seed {
                vb.extend(((s.clamp(0.0, 1.0) * 65535.0) as u16).to_le_bytes());
            }
            for v in c.iter().chain(&a).chain(&b) {
                vb.extend(v.to_le_bytes());
            }
        }
        ib.extend([0u16, 1, 2, 0, 2, 3].map(|k| (i * 4) as u16 + k));
    }
    // (a buffer holds at least a word)
    vb.resize(vb.len().max(40), 0);
    ib.resize(ib.len().max(2).next_multiple_of(2), 0);
    FxBuf {
        vertices: gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("particles"), contents: &vb, usage: wgpu::BufferUsages::VERTEX }),
        indices: gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("particle indices"), contents: bytemuck::cast_slice(&ib), usage: wgpu::BufferUsages::INDEX }),
        count: (n * 6) as u32,
    }
}

/// `vista.cgh` constants that hold for the whole place.
struct VistaConsts {
    k: [f32; 4],
    sun: [f32; 4],
    glow: [f32; 4],
    sky: [f32; 4 * pc::VistaHaze::SKY_KNOTS],
    sun_sky: [f32; 4 * pc::VistaHaze::SKY_KNOTS],
}

impl VistaConsts {
    fn new(haze: &pc::VistaHaze, meta: &pc::Meta) -> Self {
        let day = meta.day_sky.as_ref();
        let (base, side) = haze.sky_tables(day, meta.atmosphere.sky_horizon);
        let (mut sky, mut sun_sky) = ([0.0; 4 * pc::VistaHaze::SKY_KNOTS], [0.0; 4 * pc::VistaHaze::SKY_KNOTS]);
        for k in 0..pc::VistaHaze::SKY_KNOTS {
            sky[k * 4..k * 4 + 3].copy_from_slice(&base[k]);
            sun_sky[k * 4..k * 4 + 3].copy_from_slice(&side[k]);
        }
        let s = day.map_or([0.0, 0.0, -1.0], |d| d.sun_direction);
        let h = Vec2::new(s[0], s[2]).normalize_or(Vec2::new(0.0, -1.0));
        let s = haze.scale.max(1e-3);
        Self { k: [haze.density, haze.inversion, 1.0 / (s * core::f32::consts::LN_2), haze.density * s], sun: [h.x, h.y, 0.0, 0.0], glow: [haze.glow[0], haze.glow[1], haze.glow[2], haze.band], sky, sun_sky }
    }
}

/// Orthographic sunlight depth: a map of the static casters, drawn once, and one of the rigid moving casters,
/// drawn every frame.
struct SunPass {
    map: wgpu::TextureView,
    moving: Option<wgpu::TextureView>,
    vp: Mat4,
    dir: [f32; 4],
    rad: [f32; 4],
    mat: [f32; 8],
    k: [f32; 4],
    moving_k: [f32; 4],
    planes: [Vec4; 6],
    /// World size of a texel of the moving map: its casters take the level of detail that fits it.
    moving_error: f32,
    ready: bool,
}

const MOVING_MAP: u32 = 1024;

fn depth_target(gpu: &Gpu, label: &str, width: u32, height: u32, samples: u32, sampled: bool) -> wgpu::TextureView {
    gpu.device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | if sampled { wgpu::TextureUsages::TEXTURE_BINDING } else { wgpu::TextureUsages::empty() },
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

fn colour_target(gpu: &Gpu, label: &str, width: u32, height: u32, samples: u32) -> wgpu::TextureView {
    gpu.device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: width.max(1), height: height.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format: HDR,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | if samples == 1 { wgpu::TextureUsages::TEXTURE_BINDING } else { wgpu::TextureUsages::empty() },
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

impl SunPass {
    fn new(gpu: &Gpu, sun: &pc::Sun, moving: bool) -> Self {
        let l = Vec3::from(sun.direction).normalize_or(Vec3::Y);
        let sh = sun.shadow.clone().unwrap_or(pc::SunShadow { position: (l * 80.0).to_array(), ortho: [-40.0, 40.0, -40.0, 40.0, 1.0, 160.0], map_size: 2048, bias: 0.0, normal_bias: 0.02, radius: 1.0 });
        let size = sh.map_size.clamp(512, 2048);
        let pos = Vec3::from(sh.position);
        let up = if l.y.abs() > 0.99 { Vec3::Z } else { Vec3::Y };
        let view = glam::camera::rh::view::look_at_mat4(pos, pos - l, up);
        let o = sh.ortho;
        let vp = glam::camera::rh::proj::directx::orthographic(o[0], o[1], o[2], o[3], o[4], o[5]) * view;
        let r = vp.transpose();
        // World to uv: u = x/2 + 1/2, v = 1/2 - y/2 (NDC +y is row 0).
        let (rx, ry, rw) = (r.x_axis, r.y_axis, r.w_axis);
        let urow = rx * 0.5 + rw * 0.5;
        let vrow = ry * -0.5 + rw * 0.5;
        let near = pos.dot(-l) + o[4];
        let range = (o[5] - o[4]).max(1.0);
        let extent = (o[1] - o[0]).max(o[3] - o[2]);
        Self {
            map: depth_target(gpu, "sun map", size, size, 1, true),
            moving: moving.then(|| depth_target(gpu, "moving casters' map", MOVING_MAP, MOVING_MAP, 1, true)),
            vp,
            dir: [l.x, l.y, l.z, 0.0],
            rad: [sun.radiance[0], sun.radiance[1], sun.radiance[2], sh.normal_bias.max(0.01)],
            mat: [urow.x, urow.y, urow.z, urow.w, vrow.x, vrow.y, vrow.z, vrow.w],
            // Bias: the authored depth bias over the range, at least about 2 cm.
            k: [near, 1.0 / range, sh.bias.abs().max(0.02 / range), size as f32],
            // The moving map's bias follows its coarser texels.
            moving_k: [near, 1.0 / range, sh.bias.abs().max(1.5 * extent / MOVING_MAP as f32 / range), if moving { MOVING_MAP as f32 } else { 0.0 }],
            planes: [r.w_axis + r.x_axis, r.w_axis - r.x_axis, r.w_axis + r.y_axis, r.w_axis - r.y_axis, r.z_axis, r.w_axis - r.z_axis],
            moving_error: extent / MOVING_MAP as f32,
            ready: false,
        }
    }
}

/// The targets of a screen size.
struct Targets {
    width: u32,
    height: u32,
    samples: u32,
    /// The scene with several samples a pixel (when there are several) and its resolved picture.
    several: Option<wgpu::TextureView>,
    scene: wgpu::TextureView,
    depth: wgpu::TextureView,
    /// The mirror image at half the size, its depth, and its blurred copy at a quarter.
    mirror: Option<(wgpu::TextureView, wgpu::TextureView, wgpu::TextureView)>,
    haze: Option<wgpu::TextureView>,
    /// Bloom: prefilter at a quarter, downsamples at an eighth and a sixteenth, upsamples at an eighth and a quarter.
    bloom: [wgpu::TextureView; 5],
}

impl Targets {
    fn new(gpu: &Gpu, width: u32, height: u32, samples: u32, mirror: bool, haze: bool) -> Self {
        let hdr = |label, div: u32| colour_target(gpu, label, width / div, height / div, 1);
        Self {
            width,
            height,
            samples,
            several: (samples > 1).then(|| colour_target(gpu, "scene samples", width, height, samples)),
            scene: hdr("scene", 1),
            depth: depth_target(gpu, "scene depth", width, height, samples, false),
            mirror: mirror.then(|| (hdr("mirror", 2), depth_target(gpu, "mirror depth", (width / 2).max(1), (height / 2).max(1), 1, false), hdr("mirror blur", 4))),
            haze: haze.then(|| hdr("haze", 6)),
            bloom: [hdr("bloom prefilter", 4), hdr("bloom down 8", 8), hdr("bloom down 16", 16), hdr("bloom up 8", 8), hdr("bloom up 4", 4)],
        }
    }
}

/// The constants of a pass, in the order of `Pass` in common.wgsl.
struct PassData(Vec<f32>);

impl PassData {
    fn put(&mut self, values: &[f32]) {
        self.0.extend_from_slice(values);
    }
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

/// Per-camera constants shared by every draw of a pass.
struct FrameConsts {
    eye: [f32; 4],
    eye3: Vec3,
    ripple: [f32; 4],
    rain: f32,
    ray_x: [f32; 4],
    ray_y: [f32; 4],
    ray_z: [f32; 4],
    /// World size of a target pixel at 1 m.
    pixel: f32,
    tan_half: f32,
    vista_eye: [f32; 4],
    haze_params: [f32; 4],
    haze_pos: [f32; HAZE_LIGHTS * 4],
    haze_col: [f32; HAZE_LIGHTS * 4],
    haze_dir: [f32; HAZE_LIGHTS * 4],
    fx_center: Vec3,
    fx_dry: [f32; 16],
    fx_pos: [f32; FX_LIGHTS * 4],
    fx_col: [f32; FX_LIGHTS * 4],
}

impl FrameConsts {
    fn new(scene: &Scene, view: &View, time: f32, w: &Weather, vp: Mat4, aspect: f32, target_h: f32) -> Self {
        let a = &scene.meta.atmosphere;
        let fwd = (view.target - view.pos).normalize_or(Vec3::NEG_Z);
        let right = fwd.cross(Vec3::Y).normalize_or(Vec3::X);
        let up = right.cross(fwd);
        let ty = (view.fov_y.to_radians() * 0.5).tan();
        let tx = ty * aspect;
        let rf = (time * 1.15).fract() * 16.0;
        let ripple = [rf.floor(), (rf.floor() + 1.0) % 16.0, rf.fract(), 1.0 / scene.meta.effects.ripple_tile.max(0.1)];

        // Haze lights: strength over distance from the camera, the best first.
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
        let (mut haze_pos, mut haze_col, mut haze_dir) = ([0.0; HAZE_LIGHTS * 4], [0.0; HAZE_LIGHTS * 4], [0.0; HAZE_LIGHTS * 4]);
        for k in 0..HAZE_LIGHTS {
            let o = k * 4;
            if let Some(&(_, i, g)) = ranked.get(k) {
                let l = &scene.fog[i];
                haze_pos[o..o + 4].copy_from_slice(&[l.pos.x, l.pos.y, l.pos.z, l.radius]);
                haze_col[o..o + 4].copy_from_slice(&[l.color.x * g, l.color.y * g, l.color.z * g, l.cos_outer]);
                haze_dir[o..o + 4].copy_from_slice(&[l.dir.x, l.dir.y, l.dir.z, l.cos_inner]);
            } else {
                haze_pos[o..o + 4].copy_from_slice(&[0.0, -1000.0, 0.0, 1.0]);
                haze_col[o..o + 4].copy_from_slice(&[0.0, 0.0, 0.0, -2.0]);
                haze_dir[o..o + 4].copy_from_slice(&[0.0, -1.0, 0.0, 1.0]);
            }
        }

        // Drops: nearest fog lights to the camera.
        let mut near: Vec<(f32, usize)> = scene.fog.iter().enumerate().filter(|(_, l)| l.gain > 1e-3).map(|(i, l)| ((l.pos - cam).length_squared(), i)).collect();
        near.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(core::cmp::Ordering::Equal));
        let (mut fx_pos, mut fx_col, mut fx_dry) = ([0.0; FX_LIGHTS * 4], [0.0; FX_LIGHTS * 4], [0.0; 16]);
        for k in 0..FX_LIGHTS {
            let o = k * 4;
            if let Some(&(_, i)) = near.get(k) {
                let l = &scene.fog[i];
                let g = l.gain * 2.2 * w.intensity;
                fx_pos[o..o + 4].copy_from_slice(&[l.pos.x, l.pos.y, l.pos.z, (l.radius * 2.5).max(0.8)]);
                fx_col[o..o + 4].copy_from_slice(&[l.color.x * g, l.color.y * g, l.color.z * g, 0.0]);
            } else {
                fx_pos[o..o + 4].copy_from_slice(&[0.0, -1000.0, 0.0, 1.0]);
            }
        }
        for (k, b) in scene.meta.rain.dry_boxes.iter().take(2).enumerate() {
            fx_dry[k * 8..k * 8 + 3].copy_from_slice(&b[0]);
            fx_dry[k * 8 + 4..k * 8 + 7].copy_from_slice(&b[1]);
        }

        let _ = vp;
        Self {
            eye: [view.pos.x, view.pos.y, view.pos.z, time],
            eye3: view.pos,
            ripple,
            rain: w.rain,
            ray_x: [right.x * tx, right.y * tx, right.z * tx, 0.0],
            ray_y: [up.x * ty, up.y * ty, up.z * ty, 0.0],
            ray_z: [fwd.x, fwd.y, fwd.z, 0.0],
            pixel: 2.0 * ty / target_h,
            tan_half: ty,
            vista_eye: scene.meta.vista_haze.as_ref().map_or([0.0; 4], |h| [view.pos.y, h.column(view.pos.y), h.density * h.relative_density(view.pos.y), 0.0]),
            haze_params: [a.haze_density, a.haze_ambient_density, ranked.len().min(HAZE_LIGHTS) as f32, SKY_FAR],
            haze_pos,
            haze_col,
            haze_dir,
            fx_center: (cam + view.target) * 0.5,
            fx_dry,
            fx_pos,
            fx_col,
        }
    }
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

/// The (up to) `max` lights that matter most for a box: brightness over distance to the box, restricted to
/// lights whose reach touches it. `dynamic_only`: the box's static lighting is baked into its vertices.
fn select_lights(scene: &Scene, lo: Vec3, hi: Vec3, max: usize, dynamic_only: bool) -> LightSet {
    let mut best: [(f32, usize); LIGHTS_MAX] = [(0.0, usize::MAX); LIGHTS_MAX];
    for (i, l) in scene.lights.iter().enumerate() {
        if (dynamic_only && !l.dynamic) || l.power <= 0.0 {
            continue;
        }
        let q = l.pos.clamp(lo, hi);
        let d2 = (q - l.pos).length_squared();
        if d2 > l.reach * l.reach {
            continue;
        }
        // Spots: skip boxes entirely behind the emitter.
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
    for (k, &(_, i)) in best[..max].iter().enumerate().filter(|(_, b)| b.1 != usize::MAX) {
        let l = &scene.lights[i];
        let o = k * 4;
        set.pos[o..o + 4].copy_from_slice(&[l.pos.x, l.pos.y, l.pos.z, l.inv_range]);
        set.col[o..o + 4].copy_from_slice(&[l.color.x, l.color.y, l.color.z, l.spot_offset]);
        set.dir[o..o + 4].copy_from_slice(&[l.dir.x, l.dir.y, l.dir.z, l.spot_scale]);
        set.right[o..o + 4].copy_from_slice(&[l.right.x, l.right.y, l.right.z, l.half_w]);
        set.up[o..o + 4].copy_from_slice(&[l.up.x, l.up.y, l.up.z, l.half_h]);
        set.n = k + 1;
    }
    set
}

/// A draw's constants, as `Draw` in common.wgsl lays them out.
#[derive(Default)]
struct DrawData {
    model: [f32; 12],
    dequant: [f32; 8],
    uv: [f32; 4],
    base: [f32; 4],
    emissive: [f32; 4],
    pbr: [f32; 4],
    env_k: [f32; 4],
    wet: [f32; 4],
    wet2: [f32; 4],
    wave: [f32; 8],
    water_k: [f32; 4],
    water_shallow: [f32; 4],
    field: [f32; 4],
    field_t: [f32; 4],
    counts: [f32; 4],
    lights: LightSet,
}

/// The textures every pass binds from the pack, by where `Pass` has them.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PassKind {
    Main,
    Mirror,
    Sun,
}

pub struct Renderer {
    groups: Groups,
    pub programs: Programs,
    pub settings: Settings,
    mats: Vec<Mat>,
    targets: Targets,
    /// The screen's format: the composite's target.
    screen: TextureFormat,
    pass_buffers: [wgpu::Buffer; 3],
    pass_groups: Option<[wgpu::BindGroup; 3]>,
    draws: wgpu::Buffer,
    bones: wgpu::Buffer,
    draw_group: wgpu::BindGroup,
    /// This frame's draws and bones, written to their buffers when every pass is recorded.
    staged: Vec<u8>,
    staged_bones: Vec<u8>,
    post_buffers: Vec<wgpu::Buffer>,
    posts: usize,
    s_repeat: wgpu::Sampler,
    s_clamp: wgpu::Sampler,
    s_compare: wgpu::Sampler,
    s_point: wgpu::Sampler,
    samplers: HashMap<(u8, u8), wgpu::Sampler>,
    white: wgpu::TextureView,
    no_depth: wgpu::TextureView,
    lut: wgpu::TextureView,
    grain: wgpu::TextureView,
    blank: wgpu::BindGroup,
    streaks: FxBuf,
    splashes: FxBuf,
    drips: FxBuf,
    steam: FxBuf,
    beacons: FxBuf,
    sun: Option<SunPass>,
    vista: Option<VistaConsts>,
    /// The pipeline of a (material, vertex layout, mirror) once a draw has needed it; `None`: it did not build.
    cache: HashMap<(u32, Layout, bool), Option<usize>>,
    order: Vec<(u32, f32, Vec3, Vec3)>,
    bone_rows: Vec<f32>,
    tick: u32,
    post: pc::Post,
    has_rain: bool,
    has_haze: bool,
    has_reflection: bool,
    has_fields: bool,
    day_sky: bool,
    twilight: bool,
    /// The first thing a frame could not draw, for the status.
    pub trouble: String,
    pub stats: Stats,
}

fn sampler(gpu: &Gpu, label: &str, address: wgpu::AddressMode, filter: wgpu::FilterMode, anisotropy: u16) -> wgpu::Sampler {
    gpu.device.create_sampler(&wgpu::SamplerDescriptor { label: Some(label), address_mode_u: address, address_mode_v: address, address_mode_w: address, mag_filter: filter, min_filter: filter, mipmap_filter: filter, anisotropy_clamp: anisotropy, ..Default::default() })
}

fn wrap(w: pc::Wrap) -> (u8, wgpu::AddressMode) {
    match w {
        pc::Wrap::Repeat => (0, wgpu::AddressMode::Repeat),
        pc::Wrap::Clamp => (1, wgpu::AddressMode::ClampToEdge),
        pc::Wrap::Mirror => (2, wgpu::AddressMode::MirrorRepeat),
    }
}

impl Renderer {
    /// The renderer of `scene` for a screen of `format`, `width` by `height` pixels with `samples` samples each.
    pub fn new(gpu: &Gpu, scene: &Scene, format: TextureFormat, width: u32, height: u32, samples: u32) -> Self {
        let device = &gpu.device;
        let groups = Groups::new(gpu);
        let meta = &scene.meta;
        let has_reflection = meta.materials.iter().any(|m| m.wet.as_ref().is_some_and(|w| w.planar));
        let has_haze = !meta.fog_lights.is_empty();
        let uniform = |label, bytes: u64| device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: bytes, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let pass_buffers = [uniform("main pass", PASS_FLOATS as u64 * 4), uniform("mirror pass", PASS_FLOATS as u64 * 4), uniform("sun pass", PASS_FLOATS as u64 * 4)];
        // Every draw may be in the main pass, the mirror and a sun map; the first frame draws the static map too.
        let draw_room = (meta.draws.len() as u64 * 4 + 64) * DRAW_STRIDE;
        let bones_room = (meta.skins.len() as u64 * 3 + 1) * BONES_STRIDE;
        let draws = uniform("draws", draw_room);
        let bones = uniform("bones", bones_room);
        let draw_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("draw"),
            layout: &groups.draw,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &draws, offset: 0, size: wgpu::BufferSize::new(DRAW_BYTES) }) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &bones, offset: 0, size: wgpu::BufferSize::new(BONES_BYTES) }) },
            ],
        });
        let white = texel(gpu, [255; 4]);
        let no_depth = depth_target(gpu, "no sun map", 1, 1, 1, true);

        let data = |label, width: u32, height: u32, format, bytes: &[u8], row: u32| {
            device.create_texture_with_data(&gpu.queue, &wgpu::TextureDescriptor { label: Some(label), size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] }, wgpu::util::TextureDataOrder::LayerMajor, &bytes[..(row * height) as usize]).create_view(&wgpu::TextureViewDescriptor::default())
        };
        let lut = data("colour table", (LUT * LUT) as u32, LUT as u32, TextureFormat::Rgba8Unorm, &tone_lut(&meta.post), (LUT * LUT * 4) as u32);
        let mut rng = Rng(0x9e37_79b9);
        let noise: Vec<u8> = (0..GRAIN * GRAIN).map(|_| (rng.next() * 255.0) as u8).collect();
        let grain = data("grain", GRAIN as u32, GRAIN as u32, TextureFormat::R8Unorm, &noise, GRAIN as u32);

        let mut rng = Rng(0x2545_f491);
        let streaks = fx_quads(gpu, 7000, [[-0.5, 0.0], [0.5, 0.0], [0.5, 1.0], [-0.5, 1.0]], |_| ([rng.next(), rng.next(), rng.next(), rng.next()], [0.0; 3], [0.0; 3]));
        let splashes = fx_quads(gpu, 700, [[-1.0, 0.0], [1.0, 0.0], [1.0, 1.0], [-1.0, 1.0]], |_| ([rng.next(), rng.next(), rng.next(), rng.next()], [0.0; 3], [0.0; 3]));
        let mut edges: Vec<([f32; 3], [f32; 3])> = Vec::new();
        for e in &meta.rain.drip_edges {
            let n = ((Vec3::from(e[0]) - Vec3::from(e[1])).length() * 2.5).round().max(1.0) as usize;
            edges.extend(std::iter::repeat_n((e[0], e[1]), n));
        }
        let drips = fx_quads(gpu, edges.len(), [[-0.5, 0.0], [0.5, 0.0], [0.5, 1.0], [-0.5, 1.0]], |i| ([rng.next(), rng.next(), rng.next(), rng.next()], edges[i].0, edges[i].1));
        let vents = &meta.rain.steam_vents;
        let per_vent = 26;
        let steam = fx_quads(gpu, vents.len() * per_vent, [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]], |i| {
            let v = &vents[i / per_vent];
            ([(i % per_vent) as f32 / per_vent as f32 + rng.next() * 0.02, rng.next(), rng.next(), rng.next()], v[0], v[1])
        });
        let beacons = fx_quads(gpu, meta.beacons.len(), [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]], |i| ([0.0; 4], meta.beacons[i], [0.0; 3]));

        // A sun below the horizon (blue hour) lights nothing directly.
        let lit_sun = meta.sun.as_ref().filter(|s| s.direction[1] > 0.0);
        let moving_shadow = lit_sun.is_some() && meta.draws.iter().any(|d| d.node.is_some() && d.cast_shadow && meta.materials[d.material as usize].blend == pc::Blend::Opaque);
        let s_repeat = sampler(gpu, "repeat", wgpu::AddressMode::Repeat, wgpu::FilterMode::Linear, 1);
        let blank = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("no material"),
            layout: &groups.material,
            entries: &(0..8).map(|binding| wgpu::BindGroupEntry { binding, resource: if binding < 4 { wgpu::BindingResource::TextureView(&white) } else { wgpu::BindingResource::Sampler(&s_repeat) } }).collect::<Vec<_>>(),
        });
        let mut renderer = Self {
            programs: Programs::default(),
            settings: Settings::default(),
            mats: Vec::new(),
            targets: Targets::new(gpu, width, height, samples, has_reflection, has_haze),
            screen: format,
            pass_buffers,
            pass_groups: None,
            draws,
            bones,
            draw_group,
            staged: Vec::with_capacity(draw_room as usize),
            staged_bones: Vec::with_capacity(bones_room as usize),
            post_buffers: Vec::new(),
            posts: 0,
            s_repeat,
            s_clamp: sampler(gpu, "clamp", wgpu::AddressMode::ClampToEdge, wgpu::FilterMode::Linear, 1),
            s_compare: device.create_sampler(&wgpu::SamplerDescriptor { label: Some("sun map"), mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, compare: Some(wgpu::CompareFunction::LessEqual), ..Default::default() }),
            s_point: sampler(gpu, "point", wgpu::AddressMode::ClampToEdge, wgpu::FilterMode::Nearest, 1),
            samplers: HashMap::new(),
            white,
            no_depth,
            lut,
            grain,
            blank,
            streaks,
            splashes,
            drips,
            steam,
            beacons,
            sun: lit_sun.map(|s| SunPass::new(gpu, s, moving_shadow)),
            vista: meta.vista_haze.as_ref().map(|h| VistaConsts::new(h, meta)),
            cache: HashMap::new(),
            order: Vec::new(),
            bone_rows: Vec::with_capacity(24 * 12),
            tick: 0,
            post: meta.post.clone(),
            has_rain: meta.rain.active,
            has_haze,
            has_reflection,
            has_fields: scene.draws.iter().any(|d| d.layout == Layout::Lights),
            day_sky: meta.day_sky.is_some(),
            twilight: meta.day_sky.as_ref().is_some_and(|d| d.twilight.is_some()),
            groups,
            trouble: String::new(),
            stats: Stats::default(),
        };
        let has_sun = lit_sun.is_some();
        for index in 0..meta.materials.len() {
            let group = renderer.material_group(gpu, scene, index);
            let mat = material(&meta.materials[index], meta.atmosphere.environment_strength, &meta.textures, has_sun, moving_shadow, renderer.vista.is_some(), group);
            renderer.mats.push(mat);
        }
        renderer
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

    /// Bytes of the targets the passes draw into: the scene with its samples and its depth, the mirror, the
    /// haze, the bloom chain and the sun's maps. HDR is 8 bytes a texel and depth 4.
    pub fn target_bytes(&self) -> u64 {
        let t = &self.targets;
        let (w, h, samples) = (t.width as u64, t.height as u64, t.samples as u64);
        let hdr = |div: u64| (w / div) * (h / div) * 8;
        let mut bytes = hdr(1) + w * h * 4 * samples + if samples > 1 { w * h * 8 * samples } else { 0 };
        if t.mirror.is_some() {
            bytes += hdr(2) + (w / 2) * (h / 2) * 4 + hdr(4);
        }
        if t.haze.is_some() {
            bytes += hdr(6);
        }
        bytes += hdr(4) * 2 + hdr(8) * 2 + hdr(16);
        if let Some(sun) = &self.sun {
            let size = sun.k[3] as u64;
            bytes += size * size * 4 + if sun.moving.is_some() { (MOVING_MAP as u64).pow(2) * 4 } else { 0 };
        }
        bytes
    }

    /// The scene's size and samples.
    pub fn size(&self) -> (u32, u32, u32) {
        (self.targets.width, self.targets.height, self.targets.samples)
    }

    /// Another screen from the next frame on.
    pub fn resize(&mut self, gpu: &Gpu, format: TextureFormat, width: u32, height: u32, samples: u32) {
        if (format, width, height, samples) == (self.screen, self.targets.width, self.targets.height, self.targets.samples) {
            return;
        }
        self.targets = Targets::new(gpu, width, height, samples, self.has_reflection, self.has_haze);
        self.screen = format;
        self.pass_groups = None;
        // (a pipeline is for a target's samples)
        self.cache.clear();
    }

    /// The four textures of a material and their samplers.
    fn material_group(&mut self, gpu: &Gpu, scene: &Scene, index: usize) -> wgpu::BindGroup {
        let m = &scene.meta.materials[index];
        let slots = [m.albedo, m.normal, m.orm, m.emission];
        let mut keys = [(0u8, 0u8); 4];
        for (slot, texture) in slots.iter().enumerate() {
            if let Some(t) = texture {
                let t = &scene.meta.textures[*t as usize];
                let (s, t_) = (wrap(t.wrap_s), wrap(t.wrap_t));
                keys[slot] = (s.0, t_.0);
                self.samplers.entry(keys[slot]).or_insert_with(|| {
                    // Anisotropic filtering keeps ground textures crisp at grazing angles.
                    gpu.device.create_sampler(&wgpu::SamplerDescriptor { label: Some("material"), address_mode_u: s.1, address_mode_v: t_.1, mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::FilterMode::Linear, anisotropy_clamp: 8, ..Default::default() })
                });
            } else {
                self.samplers.entry((0, 0)).or_insert_with(|| sampler(gpu, "material", wgpu::AddressMode::Repeat, wgpu::FilterMode::Linear, 8));
            }
        }
        let mut entries = Vec::with_capacity(8);
        for (slot, texture) in slots.iter().enumerate() {
            entries.push(wgpu::BindGroupEntry { binding: slot as u32, resource: wgpu::BindingResource::TextureView(texture.map_or(&self.white, |t| &scene.textures[t as usize])) });
            entries.push(wgpu::BindGroupEntry { binding: 4 + slot as u32, resource: wgpu::BindingResource::Sampler(&self.samplers[&keys[slot]]) });
        }
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(&m.name), layout: &self.groups.material, entries: &entries })
    }

    /// A texture's texels have arrived in `scene`: what binds it binds the new one.
    pub fn arrived(&mut self, gpu: &Gpu, scene: &Scene, texture: usize) {
        let t = Some(texture as u32);
        for index in 0..self.mats.len() {
            let m = &scene.meta.materials[index];
            if [m.albedo, m.normal, m.orm, m.emission].contains(&t) {
                let group = self.material_group(gpu, scene, index);
                self.mats[index].group = group;
            }
        }
        self.pass_groups = None;
        // A cut-out caster's shape is its texture's alpha.
        if let Some(sun) = &mut self.sun {
            sun.ready = false;
        }
    }

    fn pass_groups(&mut self, gpu: &Gpu, scene: &Scene) {
        if self.pass_groups.is_some() {
            return;
        }
        let meta = &scene.meta;
        let texture = |index: Option<u32>| index.map_or(&self.white, |i| &scene.textures[i as usize]);
        let fx = &meta.effects;
        let clouds = meta.day_sky.as_ref().and_then(|d| d.clouds).or(fx.clouds);
        let make = |kind: PassKind| {
            let sun = self.sun.as_ref().filter(|_| kind != PassKind::Sun);
            let mirror = self.targets.mirror.as_ref().filter(|_| kind == PassKind::Main);
            let views: [&wgpu::TextureView; 9] = [
                texture(meta.atmosphere.environment),
                texture(fx.puddles),
                texture(fx.ripples),
                texture(fx.beads),
                texture(clouds),
                sun.map_or(&self.no_depth, |s| &s.map),
                sun.and_then(|s| s.moving.as_ref()).unwrap_or(&self.no_depth),
                mirror.map_or(&self.white, |m| &m.0),
                mirror.map_or(&self.white, |m| &m.2),
            ];
            let mut entries = vec![wgpu::BindGroupEntry { binding: 0, resource: self.pass_buffers[kind as usize].as_entire_binding() }];
            entries.extend(views.iter().enumerate().map(|(i, view)| wgpu::BindGroupEntry { binding: 1 + i as u32, resource: wgpu::BindingResource::TextureView(view) }));
            entries.push(wgpu::BindGroupEntry { binding: 10, resource: wgpu::BindingResource::Sampler(&self.s_repeat) });
            entries.push(wgpu::BindGroupEntry { binding: 11, resource: wgpu::BindingResource::Sampler(&self.s_clamp) });
            entries.push(wgpu::BindGroupEntry { binding: 12, resource: wgpu::BindingResource::Sampler(&self.s_compare) });
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("pass"), layout: &self.groups.pass, entries: &entries })
        };
        self.pass_groups = Some([make(PassKind::Main), make(PassKind::Mirror), make(PassKind::Sun)]);
    }

    /// The constants of a pass.
    #[allow(clippy::too_many_arguments)]
    fn pass_data(&self, scene: &Scene, f: &FrameConsts, vp: Mat4, viewport: (u32, u32), weather: &Weather, time: f32) -> Vec<f32> {
        let a = &scene.meta.atmosphere;
        let fx = &scene.meta.effects;
        let mut p = PassData(Vec::with_capacity(PASS_FLOATS));
        p.put(&vp.to_cols_array());
        p.put(&f.eye);
        p.put(&[a.fog_color[0], a.fog_color[1], a.fog_color[2], a.fog_density]);
        p.put(&[a.hemisphere_sky[0], a.hemisphere_sky[1], a.hemisphere_sky[2], 0.0]);
        p.put(&[a.hemisphere_ground[0], a.hemisphere_ground[1], a.hemisphere_ground[2], 0.0]);
        p.put(&f.ripple);
        p.put(&[if self.settings.reflection && self.has_reflection { 1.0 } else { 0.0 }, f.rain, viewport.1 as f32 / f.tan_half, f.pixel]);
        p.put(&[0.0103, 0.0091, 0.0194, 0.0]);
        match &self.sun {
            Some(s) => {
                p.put(&s.dir);
                p.put(&s.rad);
                p.put(&s.mat);
                p.put(&s.k);
                p.put(&s.moving_k);
            }
            None => p.put(&[0.0; 24]),
        }
        match &self.vista {
            Some(v) => {
                p.put(&v.k);
                p.put(&f.vista_eye);
                p.put(&v.sun);
                p.put(&v.glow);
                p.put(&v.sky);
                p.put(&v.sun_sky);
            }
            None => p.put(&[0.0; 16 + 8 * pc::VistaHaze::SKY_KNOTS]),
        }
        p.put(&f.ray_x);
        p.put(&f.ray_y);
        p.put(&f.ray_z);
        match &scene.meta.day_sky {
            Some(d) => {
                p.put(&[d.zenith[0], d.zenith[1], d.zenith[2], d.gradient_power]);
                p.put(&[d.horizon[0], d.horizon[1], d.horizon[2], d.ground_blend]);
                p.put(&[d.ground[0], d.ground[1], d.ground[2], SKY_FAR]);
                let sc = |k: f32| [d.sun_color[0] * k, d.sun_color[1] * k, d.sun_color[2] * k];
                // The program weighs the tight lobe by 1: its weight moves into the colour and divides the
                // wide lobe's.
                let (tw, te) = if d.glow_tight[0] > 0.0 { (d.glow_tight[0], d.glow_tight[1]) } else { (1.0, 1.0e4) };
                let (g, c) = (sc(d.glow * tw), sc(d.disc));
                p.put(&[(time * d.drift).fract(), d.fade_elevation.max(1e-3), d.clouds.is_some() as u32 as f32, te]);
                p.put(&[d.sun_direction[0], d.sun_direction[1], d.sun_direction[2], 0.0]);
                p.put(&[g[0], g[1], g[2], d.glow_wide[0] / tw]);
                p.put(&[c[0], c[1], c[2], d.disc_cos_outer]);
                p.put(&[d.cloud_sun[0], d.cloud_sun[1], d.cloud_sun[2], d.glow_wide[1]]);
                p.put(&[d.cloud_ambient[0], d.cloud_ambient[1], d.cloud_ambient[2], d.disc_cos_inner]);
                match &d.twilight {
                    Some(t) => {
                        let (b, l, s) = (&t.band, &t.belt, &t.shadow);
                        p.put(&[b.color[0], b.color[1], b.color[2], b.height]);
                        p.put(&[l.color[0], l.color[1], l.color[2], l.elevation]);
                        p.put(&[b.sun_bias, b.sun_power, l.width, l.power]);
                        p.put(&[s.strength, s.height, s.power, 0.0]);
                    }
                    None => p.put(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0]),
                }
            }
            None => {
                p.put(&[a.sky_zenith[0], a.sky_zenith[1], a.sky_zenith[2], time]);
                p.put(&[a.sky_horizon[0], a.sky_horizon[1], a.sky_horizon[2], 1.0 / fx.cloud_cells.max(1.0)]);
                p.put(&[a.sky_glow[0], a.sky_glow[1], a.sky_glow[2], SKY_FAR]);
                p.put(&[0.0; 40]);
            }
        }
        p.put(&[viewport.0 as f32, viewport.1 as f32, 1.0 / viewport.0 as f32, 1.0 / viewport.1 as f32]);
        p.put(&[time, 9.5, 0.55, 0.0045]);
        p.put(&[weather.wind.0, 0.0, weather.wind.1, 0.0]);
        p.put(&[f.fx_center.x, 0.0, f.fx_center.z, 26.0]);
        p.put(&f.fx_dry);
        p.put(&f.fx_pos);
        p.put(&f.fx_col);
        debug_assert_eq!(p.0.len(), PASS_FLOATS);
        p.0
    }

    /// Stages a draw's constants and returns where in the draws' buffer they are.
    fn stage(&mut self, d: &DrawData) -> u32 {
        let at = self.staged.len();
        if at as u64 + DRAW_STRIDE > self.draws.size() {
            // (the buffer holds four times the place's draws: a frame never has more)
            return 0;
        }
        let l = &d.lights;
        for values in [&d.model[..], &d.dequant, &d.uv, &d.base, &d.emissive, &d.pbr, &d.env_k, &d.wet, &d.wet2, &d.wave, &d.water_k, &d.water_shallow, &d.field, &d.field_t, &d.counts, &l.pos, &l.col, &l.dir, &l.right, &l.up] {
            self.staged.extend_from_slice(bytemuck::cast_slice(values));
        }
        debug_assert_eq!(self.staged.len() - at, DRAW_BYTES as usize);
        self.staged.resize(at + DRAW_STRIDE as usize, 0);
        at as u32
    }

    fn stage_bones(&mut self, scene: &Scene, skin: u32) -> u32 {
        let at = self.staged_bones.len();
        if at as u64 + BONES_STRIDE > self.bones.size() {
            return 0;
        }
        let mut rows = core::mem::take(&mut self.bone_rows);
        scene.bone_rows(skin, &mut rows);
        rows.resize(24 * 12, 0.0);
        self.staged_bones.extend_from_slice(bytemuck::cast_slice(&rows));
        self.staged_bones.resize(at + BONES_STRIDE as usize, 0);
        self.bone_rows = rows;
        at as u32
    }

    /// The pipeline of a material's draws of one vertex layout in the main pass or the mirror.
    fn surface(&mut self, gpu: &Gpu, material: u32, layout: Layout, mirror: bool) -> Option<usize> {
        if let Some(&made) = self.cache.get(&(material, layout, mirror)) {
            return made;
        }
        let m = &self.mats[material as usize];
        let mut defines = m.defines.clone();
        match layout {
            Layout::Skinned => defines.push("SKINNED"),
            Layout::Baked => defines.push("BAKED"),
            _ => {}
        }
        if mirror {
            defines.push("REFLECTION");
        }
        defines.sort();
        let key = Key {
            program: m.program,
            defines,
            layout,
            blend: m.blend,
            // The mirror turns every triangle round.
            cull: if m.two_sided { Cull::None } else if mirror { Cull::Front } else { Cull::Back },
            depth: if m.depth_write { Depth::TestWrite } else { Depth::Test },
            bias: m.bias,
            format: Some(HDR),
            samples: if mirror { 1 } else { self.targets.samples },
        };
        let made = match self.programs.pipeline(gpu, &self.groups, &key) {
            Ok(index) => Some(index),
            Err(why) => {
                if self.trouble.is_empty() {
                    self.trouble = why;
                }
                None
            }
        };
        self.cache.insert((material, layout, mirror), made);
        made
    }

    fn fixed(&mut self, gpu: &Gpu, program: Program, defines: &[&'static str], layout: Layout, blend: Blend, depth: Depth, format: Option<TextureFormat>, samples: u32) -> Option<usize> {
        let mut defines = defines.to_vec();
        defines.sort();
        let key = Key { program, defines, layout, blend, cull: Cull::None, depth, bias: (0, 0), format, samples };
        match self.programs.pipeline(gpu, &self.groups, &key) {
            Ok(index) => Some(index),
            Err(why) => {
                if self.trouble.is_empty() {
                    self.trouble = why;
                }
                None
            }
        }
    }

    /// Opaque (sorted by material) or blended draws (back to front) of the scene for the main or mirror camera.
    #[allow(clippy::too_many_arguments)]
    fn draw_meshes(&mut self, gpu: &Gpu, pass: &mut wgpu::RenderPass<'_>, scene: &Scene, f: &FrameConsts, planes: &[Vec4; 5], mirror: bool, transparent: bool, target_h: u32) {
        let mut order = core::mem::take(&mut self.order);
        order.clear();
        for (i, d) in scene.draws.iter().enumerate() {
            let m = &self.mats[d.material as usize];
            if d.layout == Layout::Lights || m.transparent != transparent {
                continue;
            }
            if mirror && (!m.reflect || d.no_reflect || d.max.y < 0.05) {
                continue;
            }
            let (lo, hi) = scene.bounds(d);
            if !camera::visible(planes, lo, hi) {
                self.stats.culled += 1;
                continue;
            }
            let c = (lo + hi) * 0.5;
            let dist = (c - f.eye3).length_squared();
            // The mirror image is small and blurred: draws a few pixels wide are left out of it.
            if mirror && (hi - lo).length_squared() * 0.25 < dist * 0.06 * 0.06 {
                self.stats.culled += 1;
                continue;
            }
            // Solid opaque first, cut-outs after.
            let key = if transparent { -dist } else { d.material as f32 + if m.alpha_test { 1.0e4 } else { 0.0 } };
            order.push((i as u32, key, lo, hi));
        }
        order.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal));
        // World size of one target pixel at 1 m, for the levels of detail.
        let pixel = 2.0 * f.tan_half / target_h as f32;
        let mut bound: Option<usize> = None;
        for &(i, _, lo, hi) in &order {
            let d = &scene.draws[i as usize];
            let mi = d.material as usize;
            let near_dist = (f.eye3.clamp(lo, hi) - f.eye3).length();
            // The coarsest level whose error projects under the pixel threshold. The mirror image takes twice
            // the threshold, and never the full mesh where there is a coarser one.
            let limit = near_dist.max(0.1) * pixel * LOD_PIXELS;
            let lod = if mirror { d.lods.iter().rev().find(|l| l.2 < limit * 2.0).or(d.lods.first()) } else { d.lods.iter().rev().find(|l| l.2 < limit) };
            // Every part of the draw is narrower than the level's error.
            if lod.is_some_and(|l| l.1 == 0) {
                self.stats.culled += 1;
                continue;
            }
            let Some(pipeline) = self.surface(gpu, d.material, d.layout, mirror) else { continue };
            let m = &self.mats[mi];
            let baked = d.layout == Layout::Baked;
            // Baked draws light only moving sources per pixel: one, a car's merged headlights or its tail light.
            let max_n = if !m.lit { 0 } else if baked { 1 } else if mirror { REFL_LIGHTS } else { LIGHTS_MAX };
            let lights = if max_n > 0 { select_lights(scene, lo, hi, max_n, baked) } else { LightSet::default() };
            let gain = scene.emissive_gain[mi];
            let (mut base, mut emissive) = (m.base, m.emissive);
            for c in if m.kind == pc::Kind::Unlit { &mut base[..3] } else { &mut emissive[..3] } {
                *c *= gain;
            }
            let mut data = DrawData {
                model: scene.model_rows(d),
                dequant: d.dequant,
                uv: m.uv_anim.map_or(d.uv, |a| a.apply(d.uv, f.eye[3])),
                base,
                emissive,
                pbr: if mirror { m.pbr_flat } else { m.pbr },
                env_k: [m.envk[0], m.envk[1], m.envk[2], f.rain],
                wet: m.wet,
                wet2: m.wet2,
                counts: [lights.n as f32, m.lod_bias, 0.0, 0.0],
                lights,
                ..Default::default()
            };
            if let Some(w) = &m.water {
                // Offsets wrap: the wave texture repeats.
                let t = f.eye[3];
                let layer = |l: &[f32; 3]| [l[0], 0.0, (t * l[1] * l[0]).rem_euclid(1.0), (t * l[2] * l[0]).rem_euclid(1.0)];
                let (a, b) = (layer(&w.waves[0]), layer(&w.waves[1]));
                data.wave = [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]];
                data.water_k = [w.body[0], w.body[1], w.body[2], w.distance_roughness];
                if let Some(s) = w.shallow {
                    data.water_shallow = [s[0], s[1], s[2], 0.0];
                }
            }
            let at = self.stage(&data);
            let bones = d.skin.map_or(0, |s| self.stage_bones(scene, s));
            if bound != Some(pipeline) {
                pass.set_pipeline(self.programs.get(pipeline));
                bound = Some(pipeline);
            }
            pass.set_bind_group(1, &self.mats[mi].group, &[]);
            pass.set_bind_group(2, &self.draw_group, &[at, bones]);
            pass.set_vertex_buffer(0, scene.geometry.slice(d.vertices.clone()));
            let (indices, count) = lod.map_or((d.indices.clone(), d.count), |l| (l.0.clone(), l.1));
            pass.set_index_buffer(scene.geometry.slice(indices), wgpu::IndexFormat::Uint16);
            pass.draw_indexed(0..count, 0, 0..1);
            if mirror {
                self.stats.mirror_draws += 1;
            } else {
                self.stats.draws += 1;
                self.stats.tris += count / 3;
            }
        }
        self.order = order;
    }

    fn sky(&mut self, gpu: &Gpu, pass: &mut wgpu::RenderPass<'_>, samples: u32) {
        let defines: &[&'static str] = match (self.day_sky, self.twilight) {
            (true, true) => &["DAY", "TWILIGHT"],
            (true, false) => &["DAY"],
            _ => &[],
        };
        let Some(pipeline) = self.fixed(gpu, Program::Sky, defines, Layout::None, Blend::Opaque, Depth::TestWrite, Some(HDR), samples) else { return };
        let at = self.stage(&DrawData::default());
        pass.set_pipeline(self.programs.get(pipeline));
        pass.set_bind_group(1, &self.blank, &[]);
        pass.set_bind_group(2, &self.draw_group, &[at, 0]);
        pass.draw(0..3, 0..1);
    }

    /// The light fields: a square a light, added to the scene, depth-tested against it without writing depth.
    fn light_fields(&mut self, gpu: &Gpu, pass: &mut wgpu::RenderPass<'_>, scene: &Scene, f: &FrameConsts, planes: &[Vec4; 5], target_h: u32) {
        if !self.has_fields {
            return;
        }
        for d in scene.draws.iter().filter(|d| d.layout == Layout::Lights) {
            let m = &self.mats[d.material as usize];
            let Some(field) = m.field else { continue };
            if !camera::visible(planes, d.min, d.max) {
                self.stats.culled += 1;
                continue;
            }
            let defines: &[&'static str] = if m.vista { &["VISTA"] } else { &[] };
            let Some(pipeline) = self.fixed(gpu, Program::Lights, defines, Layout::Lights, Blend::Additive, Depth::Test, Some(HDR), self.targets.samples) else { continue };
            // The range is in pixels of a 272-pixel-high frame. Under 2 pixels a sprite's samples at pixel
            // centres no longer add up to its area: the light would flicker as it moves.
            let k = target_h as f32 / 272.0;
            let min = (field.min_pixels * k).max(2.0);
            let max = (field.max_pixels * k).max(min);
            let t = f.eye[3].rem_euclid(field.period);
            let at = self.stage(&DrawData {
                dequant: d.dequant,
                field: [min, max, field.gain, 0.0],
                field_t: [t / field.period, (t * 4.0).fract() * core::f32::consts::TAU, field.depth_pull * 0.001, 0.0],
                ..Default::default()
            });
            let count = d.count.min(pc::LIGHT_POINTS_PER_DRAW as u32);
            pass.set_pipeline(self.programs.get(pipeline));
            pass.set_bind_group(1, &self.blank, &[]);
            pass.set_bind_group(2, &self.draw_group, &[at, 0]);
            pass.set_vertex_buffer(0, scene.geometry.slice(d.vertices.clone()));
            pass.draw(0..4, 0..count);
            self.stats.points += count;
        }
    }

    fn particles(&mut self, gpu: &Gpu, pass: &mut wgpu::RenderPass<'_>, w: &Weather) {
        let passes: [(&'static str, Blend, f32); 5] = [("STREAK", Blend::Additive, 0.9 * w.intensity), ("DRIP", Blend::Additive, 1.2), ("SPLASH", Blend::Additive, 1.3 * w.intensity), ("STEAM", Blend::Premultiplied, 1.0), ("BEACON", Blend::Additive, 1.0)];
        for (k, (define, blend, opacity)) in passes.into_iter().enumerate() {
            let count = [&self.streaks, &self.drips, &self.splashes, &self.steam, &self.beacons][k].count;
            if count == 0 {
                continue;
            }
            let Some(pipeline) = self.fixed(gpu, Program::Fx, &[define], Layout::Fx, blend, Depth::Test, Some(HDR), self.targets.samples) else { continue };
            let at = self.stage(&DrawData { field: [0.0, 0.0, 0.0, opacity], ..Default::default() });
            let buffer = [&self.streaks, &self.drips, &self.splashes, &self.steam, &self.beacons][k];
            pass.set_pipeline(self.programs.get(pipeline));
            pass.set_bind_group(1, &self.blank, &[]);
            pass.set_bind_group(2, &self.draw_group, &[at, 0]);
            pass.set_vertex_buffer(0, buffer.vertices.slice(..));
            pass.set_index_buffer(buffer.indices.slice(..), wgpu::IndexFormat::Uint16);
            pass.draw_indexed(0..count, 0, 0..1);
            self.stats.fx_quads += count / 6;
        }
    }

    /// The static casters' map (once) or the rigid moving casters' (every frame).
    fn shadow_pass(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, scene: &Scene, moving: bool) {
        let Some(sun) = &self.sun else { return };
        let Some(map) = (if moving { sun.moving.clone() } else { Some(sun.map.clone()) }) else { return };
        let (planes, error) = (sun.planes, sun.moving_error);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(if moving { "moving casters" } else { "sun map" }),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &map, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_bind_group(0, &self.pass_groups.as_ref().expect("the pass groups are made before a frame")[PassKind::Sun as usize], &[]);
        let mut bound = None;
        for d in scene.draws.iter() {
            if d.node.is_some() != moving || !d.cast_shadow || d.layout == Layout::Skinned || d.layout == Layout::Lights {
                continue;
            }
            let m = &self.mats[d.material as usize];
            if m.transparent || matches!(m.kind, pc::Kind::Glass | pc::Kind::InteriorWindow | pc::Kind::Water) {
                continue;
            }
            if moving {
                let (lo, hi) = scene.bounds(d);
                if !camera::visible(&planes, lo, hi) {
                    continue;
                }
            }
            let cut = m.alpha_test && m.tex[0].is_some();
            let (group, base, emissive) = (m.group.clone(), m.base, m.emissive);
            let defines: &[&'static str] = match d.layout {
                Layout::Baked => &["BAKED"],
                _ => &[],
            };
            let Some(pipeline) = self.fixed(gpu, if cut { Program::ShadowCut } else { Program::Shadow }, defines, d.layout, Blend::Opaque, Depth::Sun, None, 1) else { continue };
            let at = self.stage(&DrawData { model: scene.model_rows(d), dequant: d.dequant, uv: d.uv, base, emissive, ..Default::default() });
            if bound != Some(pipeline) {
                pass.set_pipeline(self.programs.get(pipeline));
                bound = Some(pipeline);
            }
            pass.set_bind_group(1, if cut { &group } else { &self.blank }, &[]);
            pass.set_bind_group(2, &self.draw_group, &[at, 0]);
            pass.set_vertex_buffer(0, scene.geometry.slice(d.vertices.clone()));
            let lod = if moving { d.lods.iter().rev().find(|l| l.2 <= error) } else { None };
            let (indices, count) = lod.map_or((d.indices.clone(), d.count), |l| (l.0.clone(), l.1));
            if count > 0 {
                pass.set_index_buffer(scene.geometry.slice(indices), wgpu::IndexFormat::Uint16);
                pass.draw_indexed(0..count, 0, 0..1);
                self.stats.shadow_draws += 1;
            }
        }
    }

    /// A pass over the whole of `target` with a screen program.
    #[allow(clippy::too_many_arguments)]
    fn screen_pass(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, format: TextureFormat, defines: &[&'static str], textures: &[&wgpu::TextureView], f: &FrameConsts, k: [[f32; 4]; 5]) {
        let Some(pipeline) = self.fixed(gpu, Program::Post, defines, Layout::None, Blend::Opaque, Depth::None, Some(format), 1) else { return };
        if self.posts == self.post_buffers.len() {
            self.post_buffers.push(gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("screen pass"), size: POST_FLOATS as u64 * 4, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        }
        let buffer = &self.post_buffers[self.posts];
        self.posts += 1;
        let mut data: Vec<f32> = Vec::with_capacity(POST_FLOATS);
        for values in [&f.ray_x[..], &f.ray_y, &f.ray_z, &f.eye, &k[0], &k[1], &k[2], &k[3], &k[4], &f.haze_pos, &f.haze_col, &f.haze_dir] {
            data.extend_from_slice(values);
        }
        gpu.queue.write_buffer(buffer, 0, bytemuck::cast_slice(&data));
        let mut entries = vec![wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() }];
        entries.extend((0..5).map(|i| wgpu::BindGroupEntry { binding: 1 + i as u32, resource: wgpu::BindingResource::TextureView(textures.get(i).copied().unwrap_or(&self.white)) }));
        entries.push(wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::Sampler(&self.s_clamp) });
        entries.push(wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&self.s_point) });
        entries.push(wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::Sampler(&self.s_repeat) });
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("screen pass"), layout: &self.groups.post, entries: &entries });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("screen pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(self.programs.get(pipeline));
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }

    /// Records one frame of `scene` from `view` into `out`, the screen's picture of one sample a pixel.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, scene: &Scene, view: &View, time: f32, weather: &Weather, fade: f32, bars: f32, out: &wgpu::TextureView) {
        self.stats = Stats::default();
        self.staged.clear();
        self.staged_bones.clear();
        // (offset 0 of the bones is every draw's that has none)
        self.staged_bones.resize(BONES_STRIDE as usize, 0);
        self.posts = 0;
        self.tick = self.tick.wrapping_add(1);
        self.pass_groups(gpu, scene);
        let (width, height, samples) = (self.targets.width, self.targets.height, self.targets.samples);
        let aspect = width as f32 / height as f32;
        let proj = camera::projection(view.fov_y, aspect, 0.1);
        let vp = proj * glam::camera::rh::view::look_at_mat4(view.pos, view.target, Vec3::Y);
        let frame = FrameConsts::new(scene, view, time, weather, vp, aspect, height as f32);
        gpu.queue.write_buffer(&self.pass_buffers[PassKind::Main as usize], 0, bytemuck::cast_slice(&self.pass_data(scene, &frame, vp, (width, height), weather, time)));

        // ---------------------------------------------------- sun maps
        if let Some(sun_vp) = self.sun.as_ref().map(|s| s.vp) {
            gpu.queue.write_buffer(&self.pass_buffers[PassKind::Sun as usize], 0, bytemuck::cast_slice(&self.pass_data(scene, &frame, sun_vp, (1, 1), weather, time)));
            if !self.sun.as_ref().is_some_and(|s| s.ready) {
                self.shadow_pass(gpu, encoder, scene, false);
                if let Some(sun) = &mut self.sun {
                    sun.ready = true;
                }
            }
            self.shadow_pass(gpu, encoder, scene, true);
        }

        // ---------------------------------------------------- reflection
        let reflection = self.settings.reflection && self.has_reflection;
        if let Some((sharp, depth, blur)) = self.targets.mirror.clone().filter(|_| reflection) {
            let vpm = vp * camera::mirror();
            let mut eye = view.pos;
            eye.y = -eye.y;
            let mirrored = View { pos: eye, target: Vec3::new(view.target.x, -view.target.y, view.target.z), fov_y: view.fov_y };
            let (mw, mh) = ((width / 2).max(1), (height / 2).max(1));
            let consts = FrameConsts::new(scene, &mirrored, time, weather, vpm, aspect, mh as f32);
            gpu.queue.write_buffer(&self.pass_buffers[PassKind::Mirror as usize], 0, bytemuck::cast_slice(&self.pass_data(scene, &consts, vpm, (mw, mh), weather, time)));
            let planes = camera::planes(&vpm);
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("reflection"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &sharp, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_bind_group(0, &self.pass_groups.as_ref().expect("made above")[PassKind::Mirror as usize], &[]);
                self.draw_meshes(gpu, &mut pass, scene, &consts, &planes, true, false, mh);
                self.sky(gpu, &mut pass, 1);
                self.draw_meshes(gpu, &mut pass, scene, &consts, &planes, true, true, mh);
            }
            self.screen_pass(gpu, encoder, &blur, HDR, &["DOWN"], &[&sharp], &frame, [[1.0 / mw as f32, 1.0 / mh as f32, 0.0, 0.0], [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4]]);
        }

        // ---------------------------------------------------- main
        let planes = camera::planes(&vp);
        let scene_view = self.targets.scene.clone();
        {
            let several = self.targets.several.clone();
            let depth = self.targets.depth.clone();
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: several.as_ref().unwrap_or(&scene_view),
                    resolve_target: several.as_ref().map(|_| &scene_view),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: if several.is_some() { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store } },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_bind_group(0, &self.pass_groups.as_ref().expect("made above")[PassKind::Main as usize], &[]);
            self.draw_meshes(gpu, &mut pass, scene, &frame, &planes, false, false, height);
            self.sky(gpu, &mut pass, samples);
            // Lights in front of the opaque scene and the sky; glass and other blended surfaces drawn after
            // them cover them.
            self.light_fields(gpu, &mut pass, scene, &frame, &planes, height);
            self.draw_meshes(gpu, &mut pass, scene, &frame, &planes, false, true, height);
            if self.settings.rain && self.has_rain {
                self.particles(gpu, &mut pass, weather);
            }
        }

        // ---------------------------------------------------- haze, bloom
        let a = &scene.meta.atmosphere;
        let haze = self.targets.haze.clone().filter(|_| self.settings.haze && self.has_haze);
        if let Some(target) = &haze {
            // The far rain curtain is traced in the haze pass.
            let curtain = if self.settings.rain && self.has_rain { 0.08 * weather.intensity } else { 0.0 };
            let k = [frame.haze_params, [a.haze_ambient[0], a.haze_ambient[1], a.haze_ambient[2], 0.0], [a.dry_min[0], a.dry_min[1], a.dry_min[2], 0.0], [a.dry_max[0], a.dry_max[1], a.dry_max[2], 0.0], [0.55, 0.6, 0.72, curtain]];
            self.screen_pass(gpu, encoder, target, HDR, &["LIT_HAZE"], &[&scene_view], &frame, k);
        }
        let haze_w = if haze.is_some() { 1.0 } else { 0.0 };
        let bloom = self.settings.bloom;
        let [pre, d8, d16, u8_, u4] = self.targets.bloom.clone();
        if bloom {
            // Places with light fields threshold each scene pixel (PER_PIXEL).
            let mut defines = vec!["PREFILTER"];
            if self.has_fields {
                defines.push("PER_PIXEL");
            }
            if haze.is_some() {
                defines.push("HAZE");
            }
            let pre_w = (width / 4).max(1);
            let ratio = width as f32 / pre_w as f32;
            let texel = [1.0 / width as f32, 1.0 / height as f32, if ratio <= 2.0 { 0.5 } else { 1.0 }, 0.0];
            let none = [0.0; 4];
            self.screen_pass(gpu, encoder, &pre, HDR, &defines, &[&scene_view, haze.as_ref().unwrap_or(&scene_view)], &frame, [texel, [self.post.bloom_threshold, self.post.bloom_smoothing, haze_w, 0.0], none, none, none]);
            // The chain runs W/4, W/8, W/16, W/8, W/4: (source, its divisor, destination, support for an upsample).
            let chain: [(&wgpu::TextureView, u32, &wgpu::TextureView, Option<&wgpu::TextureView>); 4] = [(&pre, 4, &d8, None), (&d8, 8, &d16, None), (&d16, 16, &u8_, Some(&d8)), (&u8_, 8, &u4, Some(&pre))];
            for (source, div, target, support) in chain {
                let texel = [1.0 / (width / div).max(1) as f32, 1.0 / (height / div).max(1) as f32, 0.7, 0.0];
                match support {
                    None => self.screen_pass(gpu, encoder, target, HDR, &["DOWN"], &[source], &frame, [texel, none, none, none, none]),
                    Some(support) => self.screen_pass(gpu, encoder, target, HDR, &["UP"], &[source, support], &frame, [texel, none, none, none, none]),
                }
            }
        }

        // ---------------------------------------------------- composite
        let mut defines = vec!["COMPOSITE"];
        if haze.is_some() {
            defines.push("HAZE");
        }
        if bloom {
            defines.push("BLOOM");
        }
        // Grain moves to a new offset of its noise tile every frame.
        let o = (self.tick as f32 * 0.618_034).fract();
        let grain_k = [width as f32 / GRAIN as f32, height as f32 / GRAIN as f32, o, (self.tick as f32 * 0.414_214 + o).fract()];
        // The letterbox closes to 2.39 : 1.
        let bar = bars.clamp(0.0, 1.0) * (0.5 - (aspect / 2.39) * 0.5).max(0.0);
        let k = [[self.post.bloom_intensity, self.settings.exposure, 0.0, 0.0], [haze_w, 0.0, self.post.grain, 0.0], grain_k, [fade.clamp(0.0, 1.0), bar, self.post.vignette, aspect], [0.0; 4]];
        let (lut, grain) = (self.lut.clone(), self.grain.clone());
        self.screen_pass(gpu, encoder, out, self.screen, &defines, &[&scene_view, haze.as_ref().unwrap_or(&scene_view), &u4, &lut, &grain], &frame, k);

        gpu.queue.write_buffer(&self.draws, 0, &self.staged);
        gpu.queue.write_buffer(&self.bones, 0, &self.staged_bones);
    }
}
