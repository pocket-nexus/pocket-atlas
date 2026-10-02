//! Scene-driven GLES effects using the same light fields, rain, analytic
//! scattering and thresholded bloom shaders as the Vita renderer.
use alloc::{format, string::String, vec::Vec};
use core::{mem::size_of, ptr};
use glam::{Mat4, Vec2, Vec3, Vec4};
use pocket3d_place as pc;
use serde::Deserialize;

use crate::{
    gl::*,
    gpu::{Program, Target},
    read,
    scene::Scene,
};

const FOG_LIGHTS: usize = 6;
const PARTICLE_LIGHTS: usize = 8;
const STREAKS: usize = 7000;
const SPLASHES: usize = 700;
const GL_POINTS: u32 = 0;
const GL_NEAREST: i32 = 0x2600;

extern "C" {
    fn glGetFloatv(parameter: u32, value: *mut f32);
}

#[derive(Deserialize)]
struct Pipelines {
    field: [String; 2],
    field_vista: [String; 2],
    particles: [[String; 2]; 5],
    haze: [String; 2],
    prefilter: [String; 2],
    prefilter_points: [String; 2],
    down: [String; 2],
    up: [String; 2],
}

/// Cached, place-constant vista tables. The eye-dependent density is small
/// enough to update with each mesh/point program's camera uniforms.
pub struct VistaUniforms {
    haze: pc::VistaHaze,
    density: [f32; 4],
    sun: [f32; 4],
    glow: [f32; 4],
    sky: [f32; pc::VistaHaze::SKY_KNOTS * 4],
    sun_sky: [f32; pc::VistaHaze::SKY_KNOTS * 4],
}

impl VistaUniforms {
    pub fn new(scene: &Scene) -> Option<Self> {
        let haze = scene.meta.vista_haze.as_ref()?;
        let day = scene.meta.day_sky.as_ref();
        let (base, side) = haze.sky_tables(day, scene.meta.atmosphere.sky_horizon);
        let mut sky = [0.0; pc::VistaHaze::SKY_KNOTS * 4];
        let mut sun_sky = sky;
        for k in 0..pc::VistaHaze::SKY_KNOTS {
            sky[k * 4..k * 4 + 3].copy_from_slice(&base[k]);
            sun_sky[k * 4..k * 4 + 3].copy_from_slice(&side[k]);
        }
        let s = day.map_or([0.0, 0.0, -1.0], |d| d.sun_direction);
        let h = Vec2::new(s[0], s[2]).normalize_or(Vec2::new(0.0, -1.0));
        let scale = haze.scale.max(1e-3);
        Some(Self {
            haze: haze.clone(),
            density: [
                haze.density,
                haze.inversion,
                1.0 / (scale * core::f32::consts::LN_2),
                haze.density * scale,
            ],
            sun: [h.x, h.y, 0.0, 0.0],
            glow: [haze.glow[0], haze.glow[1], haze.glow[2], haze.band],
            sky,
            sun_sky,
        })
    }

    pub unsafe fn bind(&self, program: &Program, eye: Vec3) {
        program.v("uVista", &self.density);
        program.v(
            "uVistaEye",
            &[
                eye.y,
                self.haze.column(eye.y),
                self.haze.density * self.haze.relative_density(eye.y),
                0.0,
            ],
        );
        program.v("uVistaSun", &self.sun);
        program.v("uVistaGlow", &self.glow);
        program.v("uVistaSky", &self.sky);
        program.v("uVistaSunSky", &self.sun_sky);
    }
}

#[derive(Clone, Copy, Default)]
pub struct EffectsStats {
    pub draws: u32,
    pub light_points: u32,
    pub particle_quads: u32,
}

/// Post textures are valid until the Effects object is resized or dropped.
/// Disabled effects return the supplied scene texture with a zero weight;
/// the composite shader must use these weights and never a stale buffer.
pub struct EffectTextures {
    pub bloom: u32,
    pub haze: u32,
    pub bloom_weight: f32,
    pub haze_weight: f32,
}

#[repr(C)]
struct ParticleVertex {
    seed: [u16; 4],
    corner: [f32; 2],
    a: [f32; 3],
    b: [f32; 3],
}

struct ParticleBuffer {
    vertices: u32,
    indices: [u32; 3],
    index_slot: usize,
    seeds: Vec<ParticleSeed>,
    visible: Vec<u16>,
    scratch: Vec<u16>,
    count: i32,
}

#[derive(Clone, Copy)]
struct ParticleSeed {
    seed: [u16; 4],
    a: Vec3,
    b: Vec3,
}

impl ParticleSeed {
    fn values(&self) -> [f32; 4] {
        self.seed.map(|v| v as f32 / 65535.0)
    }
}

/// Conservative geometry bounds, in the same world frame and quantized
/// seeds as fx_v.cg. These only reject invisible primitives; animation,
/// lighting and coverage continue to use the authoritative shared shader.
struct ParticleView<'a> {
    planes: [Vec4; 6],
    eye: Vec3,
    center: Vec3,
    time: f32,
    wind: [f32; 4],
    pixel: f32,
    dry: &'a [[[f32; 3]; 2]],
}

fn frac(value: f32) -> f32 {
    value - libm::floorf(value)
}

impl ParticleView<'_> {
    fn sphere_visible(&self, center: Vec3, radius: f32) -> bool {
        self.planes
            .iter()
            .all(|p| p.truncate().dot(center) + p.w >= -radius)
    }

    fn dry(&self, p: Vec3) -> bool {
        // Keep a margin around dry boundaries: CPU and shader arithmetic
        // may round differently at the wrapping box or animated roof edge.
        self.dry.iter().take(2).any(|b| {
            p.cmpgt(Vec3::from(b[0]) + Vec3::splat(0.02)).all()
                && p.cmplt(Vec3::from(b[1]) - Vec3::splat(0.02)).all()
        })
    }

    fn bounds(&self, kind: usize, particle: &ParticleSeed) -> Option<(Vec3, f32)> {
        let seed = particle.values();
        match kind {
            0 => {
                let box_size = Vec3::new(30.0, 18.0, 30.0);
                let origin = self.eye - Vec3::new(15.0, 5.4, 15.0);
                let velocity = Vec3::new(self.wind[0], -9.5 * (0.85 + 0.3 * seed[3]), self.wind[2]);
                let unwrapped = Vec3::from_slice(&seed) * box_size + velocity * self.time;
                let cells = (unwrapped - origin) / box_size;
                let p = unwrapped
                    - box_size
                        * Vec3::new(
                            libm::floorf(cells.x),
                            libm::floorf(cells.y),
                            libm::floorf(cells.z),
                        );
                let local = p - origin;
                if local.cmplt(Vec3::splat(0.03)).any()
                    || local.cmpgt(box_size - Vec3::splat(0.03)).any()
                {
                    // A wrap is discontinuous: the driver may round onto
                    // the opposite box face. Keep both possible positions
                    // instead of using a small margin around only one.
                    return Some((origin + box_size * 0.5, box_size.length() * 0.5 + 0.5));
                }
                let distance = p.distance(self.eye);
                if p.y < -0.02 || distance > 15.02 || distance < 0.33 || self.dry(p) {
                    return None;
                }
                let width = 0.0045f32.max(distance * self.pixel * 1.3);
                let length = 0.55 * (0.7 + 0.6 * seed[3]);
                Some((p, (length + width) * 0.5 + 0.025))
            }
            1 => {
                let edge = particle.a.lerp(particle.b, seed[0]);
                let period = 0.35 + seed[1] * 1.1;
                let age = frac(self.time / period + seed[2] * 7.0) * period;
                if age < 0.002 || period - age < 0.002 {
                    let fall = 4.9 * period * period;
                    return Some((edge - Vec3::Y * (fall * 0.5), fall * 0.5 + 0.5));
                }
                let p = Vec3::new(edge.x, edge.y - 4.9 * age * age, edge.z);
                let distance = p.distance(self.eye);
                if p.y < -0.02 || distance > 30.02 || distance < 0.28 {
                    return None;
                }
                let length = ((9.8 * age + 0.5) * 0.02).clamp(0.03, 0.25);
                Some((p, (length + 0.006f32.max(distance * 0.0012)) * 0.5 + 0.025))
            }
            2 => {
                // The GPU's per-cycle hash deliberately stays on the GPU.
                // Bound the entire 26m splash field instead of duplicating
                // its precision-sensitive random placement on the CPU.
                Some((Vec3::new(self.center.x, 0.1, self.center.z), 18.7))
            }
            3 => {
                let life = 3.2 + seed[1] * 1.6;
                let age = frac(self.time / life + seed[0]) * life;
                if age < 0.002 || life - age < 0.002 {
                    let rise = life * 0.42 + life * life * 0.04;
                    let drift = life * (0.12 + 0.18 + 0.08);
                    let radius = particle.b.length() * 0.55
                        + rise
                        + drift
                        + (0.18 + life * 0.34) * core::f32::consts::SQRT_2
                        + 0.025;
                    return Some((particle.a, radius));
                }
                let mut p = particle.a + particle.b * ((1.0 - libm::expf(-age * 2.2)) * 0.55);
                p.y += age * 0.42 + age * age * 0.04;
                p.x += libm::sinf(age * 1.3 + seed[2] * 6.28) * 0.12 * age + age * 0.18;
                p.z += libm::cosf(age * 1.1 + seed[3] * 6.28) * 0.08 * age;
                Some((p, (0.18 + age * 0.34) * core::f32::consts::SQRT_2 + 0.025))
            }
            _ => {
                let distance = particle.a.distance(self.eye).max(0.001);
                let size = (900.0 / distance).clamp(1.5, 6.0) * distance * self.pixel * 0.5;
                Some((particle.a, size * core::f32::consts::SQRT_2 + 0.025))
            }
        }
    }
}

fn normalized_planes(vp: Mat4) -> [Vec4; 6] {
    let r = vp.transpose();
    [
        r.w_axis + r.x_axis,
        r.w_axis - r.x_axis,
        r.w_axis + r.y_axis,
        r.w_axis - r.y_axis,
        r.w_axis + r.z_axis,
        r.w_axis - r.z_axis,
    ]
    .map(|p| p / p.truncate().length().max(1e-8))
}

fn select_particles(
    seeds: &[ParticleSeed],
    kind: usize,
    view: &ParticleView<'_>,
    indices: &mut Vec<u16>,
) {
    indices.clear();
    for (i, particle) in seeds.iter().enumerate() {
        let Some((center, radius)) = view.bounds(kind, particle) else {
            continue;
        };
        if !view.sphere_visible(center, radius) {
            continue;
        }
        for corner in [0u16, 1, 2, 0, 2, 3] {
            indices.push(i as u16 * 4 + corner);
        }
    }
}

impl ParticleBuffer {
    unsafe fn new(
        count: usize,
        corners: [[f32; 2]; 4],
        mut seed: impl FnMut(usize) -> ([f32; 4], [f32; 3], [f32; 3]),
    ) -> Self {
        let count = count.min(16383);
        let mut vertices = Vec::with_capacity(count * 4);
        let mut seeds = Vec::with_capacity(count);
        for i in 0..count {
            let (s, a, b) = seed(i);
            let s = s.map(|v| (v.clamp(0.0, 1.0) * 65535.0) as u16);
            seeds.push(ParticleSeed {
                seed: s,
                a: Vec3::from(a),
                b: Vec3::from(b),
            });
            for corner in corners {
                vertices.push(ParticleVertex {
                    seed: s,
                    corner,
                    a,
                    b,
                });
            }
        }
        let mut ids = [0; 4];
        glGenBuffers(4, ids.as_mut_ptr());
        glBindBuffer(GL_ARRAY_BUFFER, ids[0]);
        glBufferData(
            GL_ARRAY_BUFFER,
            (vertices.len() * size_of::<ParticleVertex>()) as _,
            vertices.as_ptr() as _,
            GL_STATIC_DRAW,
        );
        Self {
            vertices: ids[0],
            indices: [ids[1], ids[2], ids[3]],
            index_slot: 0,
            seeds,
            visible: Vec::with_capacity(count * 6),
            scratch: Vec::with_capacity(count * 6),
            count: 0,
        }
    }

    unsafe fn prepare(&mut self, kind: usize, view: &ParticleView<'_>) {
        select_particles(&self.seeds, kind, view, &mut self.scratch);
        self.count = self.scratch.len() as i32;
        if self.scratch == self.visible {
            return;
        }
        core::mem::swap(&mut self.visible, &mut self.scratch);
        if self.count == 0 {
            return;
        }
        // Rotate and orphan the small index stream; never overwrite a
        // buffer still consumed by the deferred tile renderer. The much
        // larger seeded vertex stream remains immutable and shared.
        self.index_slot = (self.index_slot + 1) % self.indices.len();
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self.indices[self.index_slot]);
        glBufferData(
            GL_ELEMENT_ARRAY_BUFFER,
            (self.visible.len() * 2) as _,
            self.visible.as_ptr() as _,
            GL_DYNAMIC_DRAW,
        );
    }

    unsafe fn draw(&self, program: &Program) {
        glBindBuffer(GL_ARRAY_BUFFER, self.vertices);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self.indices[self.index_slot]);
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        // atlas-ipod-effects.ts maps seed/corner/A/B to these stable slots.
        for (slot, n, kind, normalized, offset) in [
            (0, 4, GL_UNSIGNED_SHORT, 1, 0),
            (3, 2, GL_FLOAT, 0, 8),
            (1, 3, GL_FLOAT, 0, 16),
            (2, 3, GL_FLOAT, 0, 28),
        ] {
            if program.attrs[slot as usize] {
                glEnableVertexAttribArray(slot);
                glVertexAttribPointer(slot, n, kind, normalized, 40, offset as *const _);
            }
        }
        glDrawElements(GL_TRIANGLES, self.count, GL_UNSIGNED_SHORT, ptr::null());
    }
}

impl Drop for ParticleBuffer {
    fn drop(&mut self) {
        unsafe {
            glDeleteBuffers(
                4,
                [
                    self.vertices,
                    self.indices[0],
                    self.indices[1],
                    self.indices[2],
                ]
                .as_ptr(),
            );
        }
    }
}

struct ParticlePass {
    program: Program,
    buffer: ParticleBuffer,
}

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / 16_777_216.0
    }
    fn seed(&mut self) -> [f32; 4] {
        core::array::from_fn(|_| self.next())
    }
}

#[derive(Clone, Copy)]
struct FogLight {
    pos: Vec3,
    color: Vec3,
    gain: f32,
    radius: f32,
    dir: Vec3,
    outer: f32,
    inner: f32,
}

fn fog_lights(scene: &Scene, time: f32) -> Vec<FogLight> {
    scene
        .meta
        .fog_lights
        .iter()
        .map(|l| {
            let (pos, gain) = l
                .track
                .map(|t| {
                    let v = scene.track::<4>(&scene.meta.fog_tracks[t as usize].data, time);
                    (Vec3::from_slice(&v), v[3])
                })
                .unwrap_or((Vec3::from(l.position), 1.0));
            let (dir, outer, inner) =
                l.spot
                    .map(|(d, o, i)| (Vec3::from(d), o, i))
                    .unwrap_or((Vec3::NEG_Y, -2.0, 1.0));
            FogLight {
                pos,
                color: Vec3::from(l.color) * l.intensity,
                gain,
                radius: l.radius.max(0.001),
                dir,
                outer,
                inner,
            }
        })
        .collect()
}

fn haze_contributes(
    density: f32,
    ambient_density: f32,
    ambient: Vec3,
    lights: usize,
    curtain: f32,
) -> bool {
    (density > 0.0 && lights > 0)
        || (ambient_density > 0.0 && ambient.max_element() > 0.0)
        || curtain > 0.0
}

fn weather(time: f32) -> (f32, [f32; 4]) {
    let swell = 0.5 + 0.5 * libm::sinf(time * 0.09) * libm::sinf(time * 0.037 + 1.3);
    let gust = (libm::sinf(time * 0.21) * libm::sinf(time * 0.083 + 0.7)).max(0.0);
    (
        0.85 + 0.35 * swell,
        [0.7 + 2.2 * gust, 0.0, 0.3 + 0.6 * gust, 0.0],
    )
}

fn v4(value: Vec3, w: f32) -> [f32; 4] {
    [value.x, value.y, value.z, w]
}

fn in_frustum(vp: Mat4, lo: Vec3, hi: Vec3) -> bool {
    let r = vp.transpose();
    [
        r.w_axis + r.x_axis,
        r.w_axis - r.x_axis,
        r.w_axis + r.y_axis,
        r.w_axis - r.y_axis,
        r.w_axis + r.z_axis,
        r.w_axis - r.z_axis,
    ]
    .iter()
    .all(|p| {
        let corner = Vec3::new(
            if p.x >= 0.0 { hi.x } else { lo.x },
            if p.y >= 0.0 { hi.y } else { lo.y },
            if p.z >= 0.0 { hi.z } else { lo.z },
        );
        p.truncate().dot(corner) + p.w >= 0.0
    })
}

struct PostTargets {
    haze: Option<Target>,
    levels: Vec<Target>,
    up: Vec<Target>,
    spread: f32,
}

#[derive(Clone, Copy)]
struct BloomPlan {
    divisor: i32,
    levels: usize,
    spread: f32,
}

impl BloomPlan {
    fn new(w: i32, h: i32, has_fields: bool) -> Self {
        // Preserve isolated point-light peaks before any downsampling.
        let divisor = if has_fields { 2 } else { 4 };
        // A tiny final mip carries no useful spatial detail. At these
        // sizes use one broad blur instead of two narrow blurs, retaining
        // the thresholded support image and approximately the same halo.
        let levels = if w.min(h) / (divisor * 4) < 24 { 2 } else { 3 };
        Self {
            divisor,
            levels,
            spread: if levels == 2 { 2.0 } else { 1.0 },
        }
    }
}
impl PostTargets {
    unsafe fn new(w: i32, h: i32, haze: bool, has_fields: bool) -> Result<Self, String> {
        let plan = BloomPlan::new(w, h, has_fields);
        let size = |d: i32| ((w / d).max(1), (h / d).max(1));
        let target = |d| {
            let (w, h) = size(d);
            Target::new(w, h, false)
        };
        let mut levels = Vec::with_capacity(plan.levels);
        let mut up = Vec::with_capacity(plan.levels - 1);
        for i in 0..plan.levels {
            levels.push(target(plan.divisor << i)?);
            if i + 1 < plan.levels {
                up.push(target(plan.divisor << i)?);
            }
        }
        Ok(Self {
            haze: if haze { Some(target(4)?) } else { None },
            levels,
            up,
            spread: plan.spread,
        })
    }
}

pub struct Effects {
    fields: [Option<Program>; 2],
    particles: [Option<ParticlePass>; 5],
    haze: Option<Program>,
    prefilter: Program,
    down: Program,
    up: Program,
    vista: Option<VistaUniforms>,
    targets: PostTargets,
    triangle: u32,
    point_limit: f32,
    has_fields: bool,
    width: i32,
    height: i32,
}

impl Effects {
    /// Requires a current GLES context and the generated effects.json table.
    pub unsafe fn new(root: &str, scene: &Scene, width: i32, height: i32) -> Result<Self, String> {
        if width <= 0 || height <= 0 {
            return Err("effect target dimensions".into());
        }
        let cfg: Pipelines = serde_json::from_slice(&read(&format!("{root}/effects.json"))?)
            .map_err(|e| format!("effect pipelines: {e}"))?;
        let mut fields = [None, None];
        for d in scene
            .meta
            .draws
            .iter()
            .filter(|d| d.layout == pc::VertexLayout::Lights)
        {
            let m = &scene.meta.materials[d.material as usize];
            let index = (m.fog && scene.meta.vista_haze.is_some()) as usize;
            if fields[index].is_none() {
                fields[index] = Some(Program::new(
                    root,
                    if index == 1 {
                        &cfg.field_vista
                    } else {
                        &cfg.field
                    },
                )?);
            }
        }
        let has_fields = fields.iter().any(Option::is_some);
        let atmosphere = &scene.meta.atmosphere;
        let has_haze = haze_contributes(
            atmosphere.haze_density,
            atmosphere.haze_ambient_density,
            Vec3::from(atmosphere.haze_ambient),
            scene.meta.fog_lights.len(),
            if scene.meta.rain.active { 1.0 } else { 0.0 },
        );
        let mut particles: [Option<ParticlePass>; 5] = core::array::from_fn(|_| None);
        let mut rng = Rng(0x2545_f491);
        let streak_corners = [[-0.5, 0.0], [0.5, 0.0], [0.5, 1.0], [-0.5, 1.0]];
        let full_corners = [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]];
        if scene.meta.rain.active {
            particles[0] = Some(ParticlePass {
                program: Program::new(root, &cfg.particles[0])?,
                buffer: ParticleBuffer::new(STREAKS, streak_corners, |_| {
                    (rng.seed(), [0.0; 3], [0.0; 3])
                }),
            });
            let mut edges = Vec::new();
            for edge in &scene.meta.rain.drip_edges {
                let n = libm::roundf(Vec3::from(edge[0]).distance(Vec3::from(edge[1])) * 2.5)
                    .max(1.0) as usize;
                edges.extend(core::iter::repeat(*edge).take(n));
            }
            if !edges.is_empty() {
                particles[1] = Some(ParticlePass {
                    program: Program::new(root, &cfg.particles[1])?,
                    buffer: ParticleBuffer::new(edges.len(), streak_corners, |i| {
                        (rng.seed(), edges[i][0], edges[i][1])
                    }),
                });
            }
            particles[2] = Some(ParticlePass {
                program: Program::new(root, &cfg.particles[2])?,
                buffer: ParticleBuffer::new(
                    SPLASHES,
                    [[-1.0, 0.0], [1.0, 0.0], [1.0, 1.0], [-1.0, 1.0]],
                    |_| (rng.seed(), [0.0; 3], [0.0; 3]),
                ),
            });
            let vents = &scene.meta.rain.steam_vents;
            if !vents.is_empty() {
                particles[3] = Some(ParticlePass {
                    program: Program::new(root, &cfg.particles[3])?,
                    buffer: ParticleBuffer::new(vents.len() * 26, full_corners, |i| {
                        let mut seed = rng.seed();
                        seed[0] = (i % 26) as f32 / 26.0 + seed[0] * 0.02;
                        (seed, vents[i / 26][0], vents[i / 26][1])
                    }),
                });
            }
        }
        if !scene.meta.beacons.is_empty() {
            particles[4] = Some(ParticlePass {
                program: Program::new(root, &cfg.particles[4])?,
                buffer: ParticleBuffer::new(scene.meta.beacons.len(), full_corners, |i| {
                    ([0.0; 4], scene.meta.beacons[i], [0.0; 3])
                }),
            });
        }
        let haze = if has_haze {
            Some(Program::new(root, &cfg.haze)?)
        } else {
            None
        };
        let prefilter = Program::new(
            root,
            if has_fields {
                &cfg.prefilter_points
            } else {
                &cfg.prefilter
            },
        )?;
        let down = Program::new(root, &cfg.down)?;
        let up = Program::new(root, &cfg.up)?;
        let targets = PostTargets::new(width, height, has_haze, has_fields)?;
        let mut triangle = 0;
        glGenBuffers(1, &mut triangle);
        glBindBuffer(GL_ARRAY_BUFFER, triangle);
        let vertices = [-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0];
        glBufferData(
            GL_ARRAY_BUFFER,
            size_of::<[f32; 6]>() as _,
            vertices.as_ptr() as _,
            GL_STATIC_DRAW,
        );
        let mut range = [1.0, 1.0];
        glGetFloatv(0x846d, range.as_mut_ptr()); // GL_ALIASED_POINT_SIZE_RANGE
        Ok(Self {
            fields,
            particles,
            haze,
            prefilter,
            down,
            up,
            vista: VistaUniforms::new(scene),
            targets,
            triangle,
            point_limit: range[1].max(2.0),
            has_fields,
            width,
            height,
        })
    }

    pub unsafe fn resize(&mut self, width: i32, height: i32) -> Result<(), String> {
        if width <= 0 || height <= 0 {
            return Err("effect target dimensions".into());
        }
        if (self.width, self.height) != (width, height) {
            self.targets = PostTargets::new(width, height, self.haze.is_some(), self.has_fields)?;
            self.width = width;
            self.height = height;
        }
        Ok(())
    }

    /// Draw into the bound main HDR framebuffer after opaque/transparent
    /// meshes. Depth tests occlude particles while alpha retains eye distance.
    pub unsafe fn draw_geometry(
        &mut self,
        scene: &Scene,
        vp: Mat4,
        eye: Vec3,
        target: Vec3,
        fov_degrees: f32,
        time: f32,
        rain_enabled: bool,
    ) -> EffectsStats {
        let mut stats = EffectsStats::default();
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        glDepthMask(0);
        glDisable(GL_CULL_FACE);
        glDisable(0x8037); // GL_POLYGON_OFFSET_FILL
                           // SGX535 stores reversible HDR in RGBA8. The shared shader adapter
                           // composites in linear radiance with framebuffer fetch, retaining
                           // the destination's depth alpha; hardware blending must stay off.
        glDisable(GL_BLEND);
        let tan_half = libm::tanf(fov_degrees * core::f32::consts::PI / 360.0);
        for d in scene
            .meta
            .draws
            .iter()
            .filter(|d| d.layout == pc::VertexLayout::Lights)
        {
            if !in_frustum(vp, Vec3::from(d.min), Vec3::from(d.max)) {
                continue;
            }
            let material = &scene.meta.materials[d.material as usize];
            let Some(field) = material.lights else {
                continue;
            };
            let program = self.fields[(material.fog && self.vista.is_some()) as usize]
                .as_ref()
                .unwrap();
            program.bind();
            program.v("uBlend", &[2.0, 0.0, 0.0, 0.0]);
            program.mat("uViewProj", vp);
            program.v("uEye", &v4(eye, time));
            program.v(
                "uDequant",
                &[
                    d.pos_scale[0],
                    d.pos_scale[1],
                    d.pos_scale[2],
                    0.0,
                    d.pos_offset[0],
                    d.pos_offset[1],
                    d.pos_offset[2],
                    0.0,
                ],
            );
            let scale = self.height as f32 / 272.0;
            let min = (field.min_pixels * scale).max(2.0).min(self.point_limit);
            let max = (field.max_pixels * scale).max(min).min(self.point_limit);
            let period = field.period.max(0.001);
            let t = time - libm::floorf(time / period) * period;
            program.v(
                "uField",
                &[self.height as f32 / tan_half, min, max, field.gain],
            );
            program.v(
                "uFieldT",
                &[
                    t / period,
                    (t * 4.0 - libm::floorf(t * 4.0)) * core::f32::consts::TAU,
                    field.depth_pull * 0.001,
                    0.0,
                ],
            );
            if let Some(vista) = &self.vista {
                vista.bind(program, eye);
            }
            glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
            for i in 0..8 {
                glDisableVertexAttribArray(i);
            }
            for (slot, n, kind, normalized, offset) in [
                (0, 4, 0x1402, 1, 0),
                (4, 4, GL_UNSIGNED_BYTE, 1, 8),
                (5, 2, GL_FLOAT, 0, 12),
                (2, 4, GL_FLOAT, 0, 20),
                (7, 4, GL_UNSIGNED_BYTE, 0, 36),
            ] {
                if program.attrs[slot as usize] {
                    glEnableVertexAttribArray(slot);
                    glVertexAttribPointer(
                        slot,
                        n,
                        kind,
                        normalized,
                        pc::LightPoint::STRIDE as i32,
                        (d.vertices.offset as usize + offset) as *const _,
                    );
                }
            }
            glDrawArrays(GL_POINTS, 0, d.vertex_count as i32);
            stats.draws += 1;
            stats.light_points += d.vertex_count;
        }
        let (intensity, wind) = weather(time);
        let view = ParticleView {
            planes: normalized_planes(vp),
            eye,
            center: (eye + target) * 0.5,
            time,
            wind,
            pixel: 2.0 * tan_half / self.height as f32,
            dry: &scene.meta.rain.dry_boxes,
        };
        let mut lights = fog_lights(scene, time);
        lights.retain(|l| l.gain > 1e-3);
        lights.sort_unstable_by(|a, b| {
            a.pos
                .distance_squared(eye)
                .total_cmp(&b.pos.distance_squared(eye))
        });
        let mut positions = [0.0; PARTICLE_LIGHTS * 4];
        let mut colors = positions;
        for k in 0..PARTICLE_LIGHTS {
            let (p, c) = lights
                .get(k)
                .map(|l| {
                    (
                        v4(l.pos, (l.radius * 2.5).max(0.8)),
                        v4(l.color * (l.gain * 2.2 * intensity), 0.0),
                    )
                })
                .unwrap_or(([0.0, -1000.0, 0.0, 1.0], [0.0; 4]));
            positions[k * 4..k * 4 + 4].copy_from_slice(&p);
            colors[k * 4..k * 4 + 4].copy_from_slice(&c);
        }
        let mut dry = [0.0; 16];
        for (k, b) in scene.meta.rain.dry_boxes.iter().take(2).enumerate() {
            dry[k * 8..k * 8 + 4].copy_from_slice(&v4(Vec3::from(b[0]), 0.0));
            dry[k * 8 + 4..k * 8 + 8].copy_from_slice(&v4(Vec3::from(b[1]), 0.0));
        }
        for (k, pass) in self.particles.iter_mut().enumerate() {
            let Some(pass) = pass else { continue };
            if k < 4 && !rain_enabled {
                continue;
            }
            pass.buffer.prepare(k, &view);
            if pass.buffer.count == 0 {
                continue;
            }
            let p = &pass.program;
            p.bind();
            p.v("uBlend", &[if k == 3 { 3.0 } else { 2.0 }, 0.0, 0.0, 0.0]);
            p.mat("uViewProj", vp);
            p.v("uCam", &v4(eye, 2.0 * tan_half / self.height as f32));
            p.v("uTime", &[time, 9.5, 0.55, 0.0045]);
            p.v("uBox", &[30.0, 18.0, 30.0, 0.0]);
            p.v("uWind", &wind);
            p.v("uCenter", &v4((eye + target) * 0.5, 26.0));
            p.v("uAmbient", &[0.05, 0.06, 0.08, 0.0]);
            p.v("uDry", &dry);
            p.v("uFogPos", &positions);
            p.v("uFogCol", &colors);
            let opacity = match k {
                0 => 0.9 * intensity,
                1 => 1.2,
                2 => 1.3 * intensity,
                _ => 1.0,
            };
            p.v("uOpacity", &[opacity, 0.0, 0.0, 0.0]);
            if let Some(texture) = scene.meta.effects.puddles {
                p.tex("uPuddles", scene.textures[texture as usize], 0);
            }
            pass.buffer.draw(p);
            stats.draws += 1;
            stats.particle_quads += (pass.buffer.count / 6) as u32;
        }
        glDepthMask(1);
        glDisable(GL_BLEND);
        stats
    }

    unsafe fn fullscreen(&self) {
        glBindBuffer(GL_ARRAY_BUFFER, self.triangle);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, 0, 8, ptr::null());
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }

    /// Run analytic fog and the authored soft-threshold bloom. The caller
    /// binds its display target afterwards and composites returned textures.
    pub unsafe fn post(
        &self,
        scene: &Scene,
        scene_texture: u32,
        eye: Vec3,
        target: Vec3,
        fov_degrees: f32,
        time: f32,
        rain_enabled: bool,
        bloom_enabled: bool,
        haze_enabled: bool,
    ) -> EffectTextures {
        glDisable(GL_DEPTH_TEST);
        glDepthMask(0);
        glDisable(GL_CULL_FACE);
        glDisable(GL_BLEND);
        let mut output = EffectTextures {
            bloom: scene_texture,
            haze: scene_texture,
            bloom_weight: 0.0,
            haze_weight: 0.0,
        };
        let a = &scene.meta.atmosphere;
        let curtain = if rain_enabled && scene.meta.rain.active {
            0.08 * weather(time).0
        } else {
            0.0
        };
        let mut ranked: Vec<_> = if haze_enabled && self.haze.is_some() && a.haze_density > 0.0 {
            fog_lights(scene, time)
                .into_iter()
                .filter_map(|l| {
                    let score = l.gain * (1.0 + l.radius * l.radius)
                        / (1.0 + l.pos.distance_squared(eye) * 0.02)
                        * l.color.max_element();
                    (l.gain > 1e-4 && score > 0.0015).then_some((score, l))
                })
                .collect()
        } else {
            Vec::new()
        };
        ranked.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
        let visible_haze = haze_enabled
            && haze_contributes(
                a.haze_density,
                a.haze_ambient_density,
                Vec3::from(a.haze_ambient),
                ranked.len(),
                curtain,
            );
        if let (true, Some(program), Some(haze)) = (visible_haze, &self.haze, &self.targets.haze) {
            haze.bind();
            program.bind();
            let fwd = (target - eye).normalize_or(Vec3::NEG_Z);
            let right = fwd.cross(Vec3::Y).normalize_or(Vec3::X);
            let up = right.cross(fwd);
            let ty = libm::tanf(fov_degrees * core::f32::consts::PI / 360.0);
            let tx = ty * self.width as f32 / self.height as f32;
            program.v("uRayZ", &v4(fwd, 0.0));
            program.v("uRayX", &v4(right * tx, 0.0));
            program.v("uRayY", &v4(up * ty, 0.0));
            program.v("uEye", &v4(eye, time));
            program.v(
                "uHaze",
                &[
                    a.haze_density,
                    a.haze_ambient_density,
                    FOG_LIGHTS as f32,
                    50000.0,
                ],
            );
            program.v("uAmbient", &v4(Vec3::from(a.haze_ambient), 0.0));
            program.v("uBoxMin", &v4(Vec3::from(a.dry_min), 0.0));
            program.v("uBoxMax", &v4(Vec3::from(a.dry_max), 0.0));
            let mut positions = [0.0; FOG_LIGHTS * 4];
            let mut colors = positions;
            let mut dirs = positions;
            for k in 0..FOG_LIGHTS {
                let (p, c, d) = ranked
                    .get(k)
                    .map(|(_, l)| {
                        (
                            v4(l.pos, l.radius),
                            v4(l.color * l.gain, l.outer),
                            v4(l.dir, l.inner),
                        )
                    })
                    .unwrap_or((
                        [0.0, -1000.0, 0.0, 1.0],
                        [0.0, 0.0, 0.0, -2.0],
                        [0.0, -1.0, 0.0, 1.0],
                    ));
                positions[k * 4..k * 4 + 4].copy_from_slice(&p);
                colors[k * 4..k * 4 + 4].copy_from_slice(&c);
                dirs[k * 4..k * 4 + 4].copy_from_slice(&d);
            }
            program.v("uFogPos", &positions);
            program.v("uFogCol", &colors);
            program.v("uFogDir", &dirs);
            program.v("uCurtain", &[0.55, 0.6, 0.72, curtain]);
            program.tex("uScene", scene_texture, 0);
            // Bilinear depth would leak haze across foreground silhouettes.
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            self.fullscreen();
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            output.haze = haze.texture;
            output.haze_weight = 1.0;
        }
        if bloom_enabled && scene.meta.post.bloom_intensity > 0.0 {
            let levels = &self.targets.levels;
            levels[0].bind();
            self.prefilter.bind();
            self.prefilter.tex("uScene", scene_texture, 0);
            self.prefilter.tex("uHazeTex", output.haze, 1);
            let ratio = self.width as f32 / levels[0].w as f32;
            self.prefilter.v(
                "uTexel",
                &[
                    1.0 / self.width as f32,
                    1.0 / self.height as f32,
                    if ratio <= 2.0 { 0.5 } else { 1.0 },
                    0.0,
                ],
            );
            self.prefilter.v(
                "uThreshold",
                &[
                    scene.meta.post.bloom_threshold,
                    scene.meta.post.bloom_smoothing,
                    output.haze_weight,
                    0.0,
                ],
            );
            self.fullscreen();
            let spread = self.targets.spread;
            for i in 1..levels.len() {
                let src = &levels[i - 1];
                levels[i].bind();
                self.down.bind();
                self.down.tex("uSource", src.texture, 0);
                self.down.v(
                    "uTexel",
                    &[spread / src.w as f32, spread / src.h as f32, 0.0, 0.0],
                );
                self.fullscreen();
            }
            for i in (0..self.targets.up.len()).rev() {
                let src = if i + 1 == self.targets.up.len() {
                    &levels[i + 1]
                } else {
                    &self.targets.up[i + 1]
                };
                self.targets.up[i].bind();
                self.up.bind();
                self.up.tex("uSource", src.texture, 0);
                self.up.tex("uSupport", levels[i].texture, 1);
                self.up.v(
                    "uTexel",
                    &[spread / src.w as f32, spread / src.h as f32, 0.7, 0.0],
                );
                self.fullscreen();
            }
            output.bloom = self.targets.up[0].texture;
            output.bloom_weight = scene.meta.post.bloom_intensity;
        }
        glDepthMask(1);
        output
    }
}

impl Drop for Effects {
    fn drop(&mut self) {
        unsafe {
            glDeleteBuffers(1, &self.triangle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(eye: Vec3, forward: Vec3, height: i32, time: f32) -> ParticleView<'static> {
        let vp =
            glam::camera::rh::proj::opengl::perspective(60.0f32.to_radians(), 1.5, 0.05, 50000.0)
                * glam::camera::rh::view::look_at_mat4(eye, eye + forward, Vec3::Y);
        ParticleView {
            planes: normalized_planes(vp),
            eye,
            center: eye + forward * 3.0,
            time,
            wind: weather(time).1,
            pixel: 2.0 * libm::tanf(30.0f32.to_radians()) / height as f32,
            dry: &[],
        }
    }

    fn random_seeds(count: usize) -> Vec<ParticleSeed> {
        let mut rng = Rng(0x2545_f491);
        (0..count)
            .map(|_| ParticleSeed {
                seed: rng.seed().map(|v| (v * 65535.0) as u16),
                a: Vec3::ZERO,
                b: Vec3::ZERO,
            })
            .collect()
    }

    #[test]
    fn frustum_keeps_crossing_spheres_and_rejects_separated_ones() {
        let v = view(Vec3::ZERO, Vec3::NEG_Z, 320, 0.0);
        let edge = 10.0 * libm::tanf(30.0f32.to_radians()) * 1.5;
        let crossing = Vec3::new(edge + 0.1, 0.0, -10.0);
        assert!(!v.sphere_visible(crossing, 0.0));
        assert!(v.sphere_visible(crossing, 0.2));
        assert!(!v.sphere_visible(Vec3::new(edge + 1.0, 0.0, -10.0), 0.2));
        assert!(!v.sphere_visible(Vec3::new(0.0, 0.0, 2.0), 0.2));
        assert!(v.sphere_visible(Vec3::new(0.0, 0.0, -0.05), 0.1));
    }

    #[test]
    fn rain_bounds_contain_shader_corners_across_time_and_camera_motion() {
        let seeds = random_seeds(7000);
        for (eye, forward, time) in [
            (Vec3::new(0.0, 1.7, 0.0), Vec3::NEG_Z, 0.0),
            (Vec3::new(7.2, 1.2, -3.1), Vec3::X, 25.0),
            (Vec3::new(-18.0, 12.0, 16.0), Vec3::Z, 79.99),
        ] {
            let v = view(eye, forward, 213, time);
            let box_size = Vec3::new(30.0, 18.0, 30.0);
            let origin = eye - Vec3::new(15.0, 5.4, 15.0);
            for seed in &seeds {
                // Follow the shader's operation order, independently from
                // the simplified CPU bounds expression, including wrap.
                let s = seed.values();
                let velocity = Vec3::new(v.wind[0], -9.5 * (0.85 + 0.3 * s[3]), v.wind[2]);
                let raw = Vec3::from_slice(&s) * box_size + velocity * time;
                let r = raw - origin;
                let cell = r / box_size;
                let center = origin + r
                    - box_size
                        * Vec3::new(
                            libm::floorf(cell.x),
                            libm::floorf(cell.y),
                            libm::floorf(cell.z),
                        );
                assert!(center.cmpge(origin - Vec3::splat(0.001)).all());
                assert!(center.cmple(origin + box_size + Vec3::splat(0.001)).all());
                let distance = center.distance(eye);
                if center.y < 0.0 || distance <= 0.35 || distance >= 15.0 {
                    continue;
                }
                let (bound_center, radius) = v
                    .bounds(0, seed)
                    .expect("nonzero shader rain cannot be rejected by alpha bounds");
                let axis = velocity.normalize();
                let side = axis.cross((eye - center) / distance).normalize();
                let width = 0.0045f32.max(distance * v.pixel * 1.3);
                let length = 0.55 * (0.7 + 0.6 * s[3]);
                for x in [-0.5, 0.5] {
                    for y in [-0.5, 0.5] {
                        let corner = center + side * x * width + axis * y * length;
                        assert!(corner.distance(bound_center) < radius);
                        // If any rendered corner enters the view, the
                        // conservative whole-quad test must keep it.
                        if v.sphere_visible(corner, 0.0) {
                            assert!(v.sphere_visible(bound_center, radius));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn sparse_submission_preserves_visible_ids_winding_and_density() {
        let seeds = random_seeds(STREAKS);
        let mut indices = Vec::new();
        for (forward, time) in [(Vec3::NEG_Z, 0.0), (Vec3::X, 25.0), (Vec3::Z, 79.99)] {
            let v = view(Vec3::new(0.0, 1.7, 0.0), forward, 320, time);
            select_particles(&seeds, 0, &v, &mut indices);
            let visible = indices.len() / 6;
            assert!(
                (100..STREAKS / 3).contains(&visible),
                "unexpected visible count {visible}"
            );
            let mut submitted = indices.chunks_exact(6);
            for (id, seed) in seeds.iter().enumerate() {
                let expected = v
                    .bounds(0, seed)
                    .map_or(false, |(p, r)| v.sphere_visible(p, r));
                if expected {
                    let base = id as u16 * 4;
                    assert_eq!(
                        submitted.next().unwrap(),
                        [base, base + 1, base + 2, base, base + 2, base + 3]
                    );
                }
            }
            assert!(submitted.next().is_none());
        }
    }

    #[test]
    fn dry_boundaries_and_all_effect_types_stay_conservative() {
        let boxes = [[[0.0, 0.0, 0.0], [2.0, 3.0, 2.0]]];
        let mut v = view(Vec3::new(0.0, 1.7, 5.0), Vec3::NEG_Z, 213, 0.0);
        v.dry = &boxes;
        assert!(!v.dry(Vec3::new(0.01, 1.0, 1.0)));
        assert!(v.dry(Vec3::new(1.0, 1.0, 1.0)));
        let seed = ParticleSeed {
            seed: [8192; 4],
            a: Vec3::new(0.0, 2.5, 0.0),
            b: Vec3::new(1.0, 2.5, 0.0),
        };
        for kind in 1..5 {
            let (center, radius) = v.bounds(kind, &seed).unwrap();
            assert!(radius.is_finite() && radius > 0.0);
            assert!(v.sphere_visible(center, radius), "effect kind {kind} lost");
        }
        // Wider minimum-pixel streaks must not receive tighter bounds
        // when the internal resolution is reduced.
        let seeds = random_seeds(1000);
        let low = view(v.eye, Vec3::NEG_Z, 213, 0.0);
        let high = view(v.eye, Vec3::NEG_Z, 640, 0.0);
        for seed in seeds {
            if let (Some((_, lo)), Some((_, hi))) = (low.bounds(0, &seed), high.bounds(0, &seed)) {
                assert!(lo >= hi);
            }
        }
    }

    #[test]
    fn discontinuous_wraps_keep_both_possible_sides() {
        let v = view(Vec3::new(15.0, 5.4, 15.0), Vec3::NEG_Z, 213, 0.0);
        let seed = ParticleSeed {
            seed: [0; 4],
            a: Vec3::new(0.0, 2.5, 0.0),
            b: Vec3::X,
        };
        let (center, radius) = v.bounds(0, &seed).unwrap();
        assert!(Vec3::ZERO.distance(center) < radius);
        assert!(Vec3::new(30.0, 18.0, 30.0).distance(center) < radius);
        let (center, radius) = v.bounds(1, &seed).unwrap();
        assert!(seed.a.distance(center) < radius);
        assert!((seed.a - Vec3::Y * (4.9 * 0.35 * 0.35)).distance(center) < radius);
        let (center, radius) = v.bounds(3, &seed).unwrap();
        assert!(seed.a.distance(center) < radius);
        let mut last = v;
        last.time = 3.2 - 0.003;
        let (last_center, last_radius) = last.bounds(3, &seed).unwrap();
        assert!(last_center.distance(center) + last_radius <= radius);
    }

    #[test]
    fn bloom_keeps_peak_prefilter_and_omits_only_tiny_last_mips() {
        for (w, h, fields, divisor, levels) in [
            (320, 213, false, 4, 2),
            (480, 320, false, 4, 2),
            (640, 426, false, 4, 3),
            (320, 213, true, 2, 3),
            (1, 1, true, 2, 2),
        ] {
            let plan = BloomPlan::new(w, h, fields);
            assert_eq!((plan.divisor, plan.levels), (divisor, levels));
            assert_eq!(plan.spread, if levels == 2 { 2.0 } else { 1.0 });
            for level in 0..levels {
                assert!((w / (plan.divisor << level)).max(1) >= 1);
                assert!((h / (plan.divisor << level)).max(1) >= 1);
            }
        }
    }

    #[test]
    fn empty_haze_is_skipped_but_each_independent_source_is_retained() {
        assert!(!haze_contributes(0.0, 0.0, Vec3::ONE, 6, 0.0));
        assert!(!haze_contributes(1.0, 1.0, Vec3::ZERO, 0, 0.0));
        assert!(haze_contributes(1.0, 0.0, Vec3::ZERO, 1, 0.0));
        assert!(haze_contributes(0.0, 0.1, Vec3::ONE, 0, 0.0));
        assert!(haze_contributes(0.0, 0.0, Vec3::ZERO, 0, 0.1));
    }
}
