//! Scene-driven GLES effects using the same light fields, rain, analytic
//! scattering and thresholded bloom shaders as the Vita renderer.
use alloc::{format, string::String, vec::Vec};
use core::ptr;
use glam::{Mat4, Vec2, Vec3, Vec4};
use pocket3d_place as pc;
use serde::Deserialize;

use crate::{
    gl::*,
    gpu::{Objects, Program, Target},
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
    fn glColorMask(red: u8, green: u8, blue: u8, alpha: u8);
}

#[derive(Deserialize)]
struct Pipelines {
    field_ldr: [String; 2],
    field_vista_ldr: [String; 2],
    particles_ldr: [[String; 2]; 5],
    #[serde(default)]
    steam_coverage_ldr: Option<[String; 2]>,
    haze_ldr: [String; 2],
    haze_bloom_ldr: [String; 2],
    tiny_ldr: [String; 2],
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

    /// Display-space approximation for a prelit draw's centre. The sky/glow
    /// are deliberately not multiplied by (1-T): the caller mixes display
    /// haze and display surface by T. Full HDR uses `bind` per vertex.
    pub fn display_at(&self, eye: Vec3, center: Vec3, post: &pc::Post) -> [f32; 4] {
        let delta = center - eye;
        let t = self.haze.transmittance(eye.to_array(), center.to_array());
        let horizontal = Vec2::new(delta.x, delta.z);
        let h = horizontal / libm::sqrtf(horizontal.length_squared().max(1e-8));
        let azimuth = h.dot(Vec2::new(self.sun[0], self.sun[1]));
        let u = libm::sqrtf((0.5 - 0.5 * azimuth).clamp(0.0, 1.0))
            * (pc::VistaHaze::SKY_KNOTS - 1) as f32;
        let k = (u as usize).min(pc::VistaHaze::SKY_KNOTS - 2);
        let f = u - k as f32;
        let sample = |table: &[f32; pc::VistaHaze::SKY_KNOTS * 4]| {
            Vec3::from_slice(&table[k * 4..]).lerp(Vec3::from_slice(&table[(k + 1) * 4..]), f)
        };
        let inscatter = sample(&self.sky)
            + sample(&self.sun_sky) * self.haze.sun_weight(t)
            + Vec3::from_slice(&self.glow) * self.haze.relative_density(center.y);
        let c = pc::color::tone(inscatter.to_array(), post);
        [c[0], c[1], c[2], t]
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
/// Display rendering returns the combined contribution through `bloom`;
/// `bloom_weight` also reverses its bounded linear storage scale.
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
    index_valid: bool,
    colors: [u32; 3],
    color_slot: usize,
    display_colors: Vec<u8>,
    display_key: Option<[u32; 11]>,
    selection_key: Option<ParticleViewKey>,
    seeds: Vec<ParticleSeed>,
    visible: Vec<u16>,
    light_samples: Vec<Option<Vec3>>,
    scratch: Vec<u16>,
    count: i32,
}

/// CPU sampling of exactly the display LUT used by the old fragment path.
/// Keeps grading out of heavily overdrawn steam/rain fragments without
/// approximating the shared tone curve with a second analytic formula.
struct ParticleGrade {
    pixels: Vec<u8>,
    black: Vec3,
}
impl ParticleGrade {
    fn new(post: &pc::Post) -> Self {
        let pixels = crate::gpu::tone_lut_pixels(post, 16, true);
        let black = Vec3::new(pixels[0] as f32, pixels[1] as f32, pixels[2] as f32) / 255.0;
        Self { pixels, black }
    }
    fn sample(&self, color: Vec3) -> Vec3 {
        let c = color.max(Vec3::ZERO);
        let q = c / (Vec3::ONE + c);
        let cell = Vec3::new(libm::sqrtf(q.x), libm::sqrtf(q.y), libm::sqrtf(q.z)) * 15.0;
        let lo = [cell.x as usize, cell.y as usize, cell.z as usize];
        let f = cell - Vec3::new(lo[0] as f32, lo[1] as f32, lo[2] as f32);
        let mut result = Vec3::ZERO;
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    let at = (((lo[1] + g).min(15) * 256
                        + (lo[2] + b).min(15) * 16
                        + (lo[0] + r).min(15))
                        * 4) as usize;
                    let w = (if r == 0 { 1.0 - f.x } else { f.x })
                        * (if g == 0 { 1.0 - f.y } else { f.y })
                        * (if b == 0 { 1.0 - f.z } else { f.z });
                    result += Vec3::new(
                        self.pixels[at] as f32,
                        self.pixels[at + 1] as f32,
                        self.pixels[at + 2] as f32,
                    ) * (w / 255.0);
                }
            }
        }
        result
    }
    fn color(&self, kind: usize, radiance: Vec3) -> [u8; 4] {
        if kind != 3 && radiance == Vec3::ZERO {
            // Additive display grading subtracts the LUT's black. Inactive
            // splash falloff therefore has an exactly black byte result.
            return [0, 0, 0, 255];
        }
        // Shared steam returns RGB=.28*a and coverage=.16*a. Grading the
        // unpremultiplied ratio then undoing it keeps that fragment unchanged.
        let c = if kind == 3 {
            self.sample(radiance * 1.75) / 1.75
        } else {
            (self.sample(radiance) - self.black).max(Vec3::ZERO)
        };
        let b = |x: f32| (x.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        [b(c.x), b(c.y), b(c.z), 255]
    }
}

const FIELD_RESPONSE_WIDTH: usize = 256;
const FIELD_RESPONSE_MAX: f32 = 65504.0;

/// A source colour's scalar intensity response. This immutable preparation
/// uses the same shared grade/LUT as the reference path, once per scene. No
/// camera, light motion or animation frame causes a CPU colour-table update.
fn field_response_pixels(palette: &[[u8; 3]], grade: &ParticleGrade) -> Result<(usize, Vec<u8>), String> {
    if palette.is_empty() { return Err("field appearance has no source colours".into()); }
    let height = palette.len().checked_next_power_of_two().ok_or("field appearance size overflow")?;
    let mut pixels = Vec::new();
    pixels.try_reserve_exact(height * FIELD_RESPONSE_WIDTH * 4)
        .map_err(|_| "field appearance image allocation")?;
    pixels.resize(height * FIELD_RESPONSE_WIDTH * 4, 0);
    for (row, rgb) in palette.iter().enumerate() {
        let c = Vec3::new(rgb[0] as f32, rgb[1] as f32, rgb[2] as f32) / 255.0;
        // Exactly lights_v.cg's sRGB approximation, not a second colour decode.
        let linear = c * (c * (c * 0.305306011 + Vec3::splat(0.682171111))
            + Vec3::splat(0.012522878));
        for x in 0..FIELD_RESPONSE_WIDTH {
            let e = x as f32 / (FIELD_RESPONSE_WIDTH - 1) as f32;
            let q = e * e;
            let scalar = if x + 1 == FIELD_RESPONSE_WIDTH { FIELD_RESPONSE_MAX }
                else { q / (1.0 - q) };
            let color = (grade.sample(linear * scalar) - grade.black).max(Vec3::ZERO);
            let at = (row * FIELD_RESPONSE_WIDTH + x) * 4;
            for channel in 0..3 {
                pixels[at + channel] = (color[channel].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
            pixels[at + 3] = 255;
        }
    }
    Ok((height, pixels))
}

pub(crate) struct FieldAppearance {
    _objects: Objects,
    texture: u32,
    rows: u32,
    params: [f32; 4],
    pub(crate) gpu_bytes: usize,
}
impl FieldAppearance {
    pub(crate) unsafe fn new(source: &crate::light_lod::Sources, post: &pc::Post) -> Result<Self, String> {
        let mut limit = 0;
        glGetIntegerv(0x0d33, &mut limit); // GL_MAX_TEXTURE_SIZE
        let height = source.palette().len().checked_next_power_of_two().unwrap_or(usize::MAX);
        if source.palette().is_empty() || height > limit.max(0) as usize || FIELD_RESPONSE_WIDTH > limit.max(0) as usize {
            return Err(format!("field appearance {} colours exceeds texture limit {limit}", source.palette().len()));
        }
        let (_, pixels) = field_response_pixels(source.palette(), &ParticleGrade::new(post))?;
        let mut objects = Objects::default();
        let texture = objects.image(FIELD_RESPONSE_WIDTH as i32, height as i32, &pixels);
        let error = glGetError();
        if texture == 0 || error != 0 { return Err(format!("field appearance texture: GL {error:x}")); }
        let rows = objects.buffer();
        upload_effect_buffer(GL_ARRAY_BUFFER, rows, source.color_rows(), GL_STATIC_DRAW, "field appearance rows")?;
        Ok(Self {
            _objects: objects,
            texture,
            rows,
            params: [FIELD_RESPONSE_WIDTH as f32, 1.0 / FIELD_RESPONSE_WIDTH as f32, 1.0 / height as f32, 0.0],
            gpu_bytes: pixels.len() + source.color_rows().len() * 2,
        })
    }
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn particle_hash(p: Vec2) -> f32 {
    let mut v = Vec3::new(frac(p.x * 0.1031), frac(p.y * 0.1031), frac(p.x * 0.1031));
    v += Vec3::splat(v.dot(Vec3::new(v.y, v.z, v.x) + Vec3::splat(33.33)));
    frac((v.x + v.y) * v.z)
}

/// The lighting samples from fx_v.cg, once per particle instead of once per
/// corner. Geometry/lifetime/coverage still execute in the shared shader.
fn particle_light(
    kind: usize,
    particle: &ParticleSeed,
    view: &ParticleView<'_>,
    positions: &[f32; 32],
    colors: &[f32; 32],
    sample: Option<Vec3>,
) -> Vec3 {
    let seed = particle.values();
    if kind == 4 {
        let on = frac(view.time * 0.55 + particle.a.x * 0.0003) >= 0.45;
        return Vec3::new(6.0, 0.48, 0.24) * if on { 1.0 } else { 0.35 };
    }
    let (p, gain) = if let Some(p) = sample {
        (p, if kind == 1 { 1.4 } else { 1.0 })
    } else {
        match kind {
            0 => {
                let size = Vec3::new(30.0, 18.0, 30.0);
                let origin = view.eye - Vec3::new(15.0, 5.4, 15.0);
                let velocity = Vec3::new(view.wind[0], -9.5 * (0.85 + 0.3 * seed[3]), view.wind[2]);
                let r = Vec3::from_slice(&seed) * size + velocity * view.time - origin;
                let q = r / size;
                (
                    origin + r
                        - size * Vec3::new(libm::floorf(q.x), libm::floorf(q.y), libm::floorf(q.z)),
                    1.0,
                )
            }
            1 => {
                let edge = particle.a.lerp(particle.b, seed[0]);
                let period = 0.35 + seed[1] * 1.1;
                let age = frac(view.time / period + seed[2] * 7.0) * period;
                (Vec3::new(edge.x, edge.y - 4.9 * age * age, edge.z), 1.4)
            }
            2 => {
                let id = libm::floorf(view.time * (1.1 + seed[2] * 1.3) + seed[3] * 17.0);
                let r = Vec2::new(
                    particle_hash(Vec2::new(seed[0], seed[1]) * 131.7 + Vec2::splat(id)),
                    particle_hash(Vec2::new(seed[1], seed[0]) * 71.3 + Vec2::splat(id * 1.7)),
                );
                let p = Vec3::new(
                    view.center.x + (r.x - 0.5) * 26.0,
                    0.0,
                    view.center.z + (r.y - 0.5) * 26.0,
                );
                (
                    p + Vec3::Y * 0.1,
                    smooth(26.0 * 0.55, 26.0 * 0.3, p.distance(view.eye)),
                )
            }
            _ => {
                let life = 3.2 + seed[1] * 1.6;
                let age = frac(view.time / life + seed[0]) * life;
                let mut p = particle.a + particle.b * (1.0 - libm::expf(-age * 2.2)) * 0.55;
                p.y += age * 0.42 + age * age * 0.04;
                p.x += libm::sinf(age * 1.3 + seed[2] * 6.28) * 0.12 * age + age * 0.18;
                p.z += libm::cosf(age * 1.1 + seed[3] * 6.28) * 0.08 * age;
                (p, 1.0)
            }
        }
    };
    if gain == 0.0 {
        return Vec3::ZERO;
    }
    let mut color = Vec3::new(0.05, 0.06, 0.08);
    for k in 0..PARTICLE_LIGHTS {
        let d = Vec3::from_slice(&positions[k * 4..]) - p;
        let r2 = positions[k * 4 + 3] * positions[k * 4 + 3];
        color += Vec3::from_slice(&colors[k * 4..]) * (r2 / (d.length_squared() + r2));
    }
    color * gain
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

    fn rain_sample(&self, divisor: u32) -> bool {
        if divisor == 1 {
            return true;
        }
        // A fixed seed hash keeps exactly the same subset while the camera
        // and rain box move; never alternate drops between render frames.
        let mut hash = self.seed[0] as u32 | ((self.seed[1] as u32) << 16);
        hash ^= (self.seed[2] as u32 | ((self.seed[3] as u32) << 16)).rotate_left(13);
        hash ^= hash >> 16;
        hash = hash.wrapping_mul(0x7feb_352d);
        hash ^= hash >> 15;
        hash % divisor == 0
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
    rain_divisor: u32,
}

/// Exact inputs to conservative selection. Fixed inspection frames can reuse
/// their index list; animated frames still re-evaluate every source seed.
#[derive(Clone, Copy, Debug, PartialEq)]
struct ParticleViewKey {
    kind: usize,
    planes: [[u32; 4]; 6],
    eye: [u32; 3],
    center: [u32; 3],
    time: u32,
    wind: [u32; 4],
    pixel: u32,
    dry: [[[u32; 3]; 2]; 2],
    dry_count: usize,
    rain_divisor: u32,
}

fn frac(value: f32) -> f32 {
    value - libm::floorf(value)
}

impl ParticleView<'_> {
    fn key(&self, kind: usize) -> ParticleViewKey {
        let mut dry = [[[0; 3]; 2]; 2];
        for (out, bounds) in dry.iter_mut().zip(self.dry.iter()) {
            *out = bounds.map(|p| p.map(f32::to_bits));
        }
        ParticleViewKey {
            kind,
            planes: self.planes.map(|p| p.to_array().map(f32::to_bits)),
            eye: self.eye.to_array().map(f32::to_bits),
            center: self.center.to_array().map(f32::to_bits),
            time: self.time.to_bits(),
            wind: self.wind.map(f32::to_bits),
            pixel: self.pixel.to_bits(),
            dry,
            dry_count: self.dry.len().min(2),
            rain_divisor: self.rain_divisor,
        }
    }

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

    #[cfg(test)]
    fn bounds(&self, kind: usize, particle: &ParticleSeed) -> Option<(Vec3, f32)> {
        self.bounds_and_light(kind, particle, &mut None)
    }

    fn bounds_and_light(
        &self,
        kind: usize,
        particle: &ParticleSeed,
        light: &mut Option<Vec3>,
    ) -> Option<(Vec3, f32)> {
        *light = None;
        let seed = particle.values();
        match kind {
            0 => {
                let box_size = Vec3::new(30.0, 18.0, 30.0);
                let origin = self.eye - Vec3::new(15.0, 5.4, 15.0);
                let velocity = Vec3::new(self.wind[0], -9.5 * (0.85 + 0.3 * seed[3]), self.wind[2]);
                let unwrapped = Vec3::from_slice(&seed) * box_size + velocity * self.time;
                let relative = unwrapped - origin;
                let cells = relative / box_size;
                let wrap = box_size
                    * Vec3::new(
                        libm::floorf(cells.x),
                        libm::floorf(cells.y),
                        libm::floorf(cells.z),
                    );
                let p = unwrapped - wrap;
                // Preserve both existing operation orders: the conservative
                // bounds omit the cancellation while lighting matches fx_v.
                *light = Some(origin + relative - wrap);
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
                let p = Vec3::new(edge.x, edge.y - 4.9 * age * age, edge.z);
                *light = Some(p);
                if age < 0.002 || period - age < 0.002 {
                    let fall = 4.9 * period * period;
                    return Some((edge - Vec3::Y * (fall * 0.5), fall * 0.5 + 0.5));
                }
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
                let decay = 1.0 - libm::expf(-age * 2.2);
                let mut p = particle.a + particle.b * (decay * 0.55);
                let mut sample = particle.a + particle.b * decay * 0.55;
                let y = age * 0.42 + age * age * 0.04;
                let x = libm::sinf(age * 1.3 + seed[2] * 6.28) * 0.12 * age + age * 0.18;
                let z = libm::cosf(age * 1.1 + seed[3] * 6.28) * 0.08 * age;
                p.y += y;
                p.x += x;
                p.z += z;
                sample.y += y;
                sample.x += x;
                sample.z += z;
                *light = Some(sample);
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

#[cfg(test)]
fn select_particles(
    seeds: &[ParticleSeed],
    kind: usize,
    view: &ParticleView<'_>,
    indices: &mut Vec<u16>,
) {
    select_particle_samples(seeds, kind, view, indices, &mut Vec::new());
}

fn select_particle_samples(
    seeds: &[ParticleSeed],
    kind: usize,
    view: &ParticleView<'_>,
    indices: &mut Vec<u16>,
    samples: &mut Vec<Option<Vec3>>,
) {
    indices.clear();
    samples.clear();
    for (i, particle) in seeds.iter().enumerate() {
        if kind == 0 && !particle.rain_sample(view.rain_divisor) {
            continue;
        }
        let mut light = None;
        let Some((center, radius)) = view.bounds_and_light(kind, particle, &mut light) else {
            continue;
        };
        if !view.sphere_visible(center, radius) {
            continue;
        }
        samples.push(light);
        for corner in [0u16, 1, 2, 0, 2, 3] {
            indices.push(i as u16 * 4 + corner);
        }
    }
}

fn select_particles_cached(
    seeds: &[ParticleSeed],
    kind: usize,
    view: &ParticleView<'_>,
    visible: &mut Vec<u16>,
    scratch: &mut Vec<u16>,
    last_view: &mut Option<ParticleViewKey>,
    samples: &mut Vec<Option<Vec3>>,
) -> bool {
    let key = view.key(kind);
    if *last_view == Some(key) {
        return false;
    }
    // Refresh samples even when the visible seed IDs did not change: their
    // animated positions still did. A fixed-view cache hit preserves both.
    select_particle_samples(seeds, kind, view, scratch, samples);
    *last_view = Some(key);
    if scratch == visible {
        return false;
    }
    core::mem::swap(visible, scratch);
    true
}

unsafe fn upload_effect_buffer<T>(
    target: u32,
    buffer: u32,
    data: &[T],
    usage: u32,
    context: &str,
) -> Result<(), String> {
    glBindBuffer(target, buffer);
    glBufferData(
        target,
        core::mem::size_of_val(data) as _,
        data.as_ptr() as _,
        usage,
    );
    let error = glGetError();
    if buffer == 0 || error != 0 {
        return Err(format!("{context}: GL {error:x}"));
    }
    Ok(())
}

impl ParticleBuffer {
    unsafe fn new(
        count: usize,
        corners: [[f32; 2]; 4],
        mut seed: impl FnMut(usize) -> ([f32; 4], [f32; 3], [f32; 3]),
    ) -> Result<Self, String> {
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
        let mut ids = [0; 7];
        glGenBuffers(7, ids.as_mut_ptr());
        // Own every generated name before any fallible GPU allocation.
        let result = Self {
            vertices: ids[0],
            indices: [ids[1], ids[2], ids[3]],
            index_slot: 0,
            index_valid: false,
            colors: [ids[4], ids[5], ids[6]],
            color_slot: 0,
            display_colors: alloc::vec![0; count*16],
            display_key: None,
            selection_key: None,
            seeds,
            visible: Vec::with_capacity(count * 6),
            light_samples: Vec::new(),
            scratch: Vec::with_capacity(count * 6),
            count: 0,
        };
        if ids.iter().any(|&id| id == 0) {
            return Err(format!("particle buffer allocation: GL {:x}", glGetError()));
        }
        upload_effect_buffer(
            GL_ARRAY_BUFFER,
            ids[0],
            &vertices,
            GL_STATIC_DRAW,
            "particle vertices",
        )?;
        Ok(result)
    }

    unsafe fn prepare(&mut self, kind: usize, view: &ParticleView<'_>) -> Result<bool, String> {
        let buffers = self.indices;
        self.prepare_with_upload(kind, view, |slot, indices| {
            upload_effect_buffer(
                GL_ELEMENT_ARRAY_BUFFER,
                buffers[slot],
                indices,
                GL_DYNAMIC_DRAW,
                "particle indices",
            )
        })
    }

    fn prepare_with_upload(
        &mut self,
        kind: usize,
        view: &ParticleView<'_>,
        mut upload: impl FnMut(usize, &[u16]) -> Result<(), String>,
    ) -> Result<bool, String> {
        let changed = select_particles_cached(
            &self.seeds,
            kind,
            view,
            &mut self.visible,
            &mut self.scratch,
            &mut self.selection_key,
            &mut self.light_samples,
        );
        if !changed && self.index_valid {
            return Ok(false);
        }
        let count = self.visible.len() as i32;
        if count == 0 {
            self.count = 0;
            self.index_valid = true;
            return Ok(true);
        }
        // Rotate and orphan, then commit only a successful upload. A failed
        // upload can leave the previous slot size/data intact; never draw it
        // with this frame's count or cache it as a valid fixed view.
        let slot = (self.index_slot + 1) % self.indices.len();
        if let Err(error) = upload(slot, &self.visible) {
            self.index_valid = false;
            self.count = 0;
            self.selection_key = None;
            self.display_key = None;
            return Err(error);
        }
        self.index_slot = slot;
        self.count = count;
        self.index_valid = true;
        Ok(true)
    }

    unsafe fn grade(
        &mut self,
        kind: usize,
        view: &ParticleView<'_>,
        positions: &[f32; 32],
        colors: &[f32; 32],
        grade: &ParticleGrade,
        changed: bool,
    ) -> Result<(), String> {
        let buffers = self.colors;
        self.grade_with_upload(
            kind,
            view,
            positions,
            colors,
            grade,
            changed,
            |slot, bytes| {
                upload_effect_buffer(
                    GL_ARRAY_BUFFER,
                    buffers[slot],
                    bytes,
                    GL_DYNAMIC_DRAW,
                    "particle colors",
                )
            },
        )
    }

    fn grade_with_upload(
        &mut self,
        kind: usize,
        view: &ParticleView<'_>,
        positions: &[f32; 32],
        colors: &[f32; 32],
        grade: &ParticleGrade,
        changed: bool,
        mut upload: impl FnMut(usize, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let key = [
            view.time,
            view.eye.x,
            view.eye.y,
            view.eye.z,
            view.center.x,
            view.center.y,
            view.center.z,
            view.wind[0],
            view.wind[1],
            view.wind[2],
            view.wind[3],
        ]
        .map(f32::to_bits);
        if !changed && self.display_key == Some(key) {
            return Ok(());
        }
        for (quad, &sample) in self.visible.chunks_exact(6).zip(&self.light_samples) {
            let i = quad[0] as usize / 4;
            let color = grade.color(
                kind,
                particle_light(kind, &self.seeds[i], view, positions, colors, sample),
            );
            for corner in self.display_colors[i * 16..i * 16 + 16].chunks_exact_mut(4) {
                corner.copy_from_slice(&color);
            }
        }
        let slot = (self.color_slot + 1) % self.colors.len();
        if let Err(error) = upload(slot, &self.display_colors) {
            self.display_key = None;
            return Err(error);
        }
        self.color_slot = slot;
        self.display_key = Some(key);
        Ok(())
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
        if program.attrs[4] {
            glBindBuffer(GL_ARRAY_BUFFER, self.colors[self.color_slot]);
            glEnableVertexAttribArray(4);
            glVertexAttribPointer(4, 4, GL_UNSIGNED_BYTE, 1, 4, ptr::null());
        }
        glDrawElements(GL_TRIANGLES, self.count, GL_UNSIGNED_SHORT, ptr::null());
    }
}

impl Drop for ParticleBuffer {
    fn drop(&mut self) {
        unsafe {
            glDeleteBuffers(
                7,
                [
                    self.vertices,
                    self.indices[0],
                    self.indices[1],
                    self.indices[2],
                    self.colors[0],
                    self.colors[1],
                    self.colors[2],
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

fn haze_light_uniforms(light: FogLight, eye: Vec3, density: f32, prepared: bool)
    -> ([f32; 4], [f32; 4], [f32; 4], [f32; 4])
{
    let relative = light.pos - eye;
    (
        if prepared { v4(relative, light.radius * light.radius) } else { v4(light.pos, light.radius) },
        v4(light.color * light.gain * if prepared { density } else { 1.0 }, light.outer),
        v4(light.dir, light.inner),
        [relative.length_squared(), 0.0, 0.0, 0.0],
    )
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

pub(crate) fn in_frustum(vp: Mat4, lo: Vec3, hi: Vec3) -> bool {
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
    bloom: Target,
}

fn display_bloom_threshold(post: &pc::Post, haze_weight: f32) -> [f32; 4] {
    let luminance = |radiance: f32| {
        Vec3::from(pc::color::tone([radiance.max(0.0); 3], post))
            .dot(Vec3::new(0.2126, 0.7152, 0.0722))
    };
    // LDR has no super-white energy. Translate the authored neutral-light
    // threshold through its exact grade, with a 5% allowance for clipped
    // highlights; the remaining display headroom bounds additive glow.
    let low = (luminance(post.bloom_threshold) * 0.95).clamp(0.0, 0.9);
    let high = luminance(post.bloom_threshold + post.bloom_smoothing.max(0.0)) * 0.95;
    [
        low,
        (high - low).max(0.025).min(1.0 - low),
        haze_weight,
        (1.0 - low).max(0.08),
    ]
}

/// Both old display targets are clamped RGBA8. This scale contains their
/// weighted sum without clipping and commutes with bilinear reconstruction.
/// The one additional quantization is bounded by scale / 510 per channel.
fn display_effect_scale(bloom_intensity: f32) -> f32 {
    1.0 + bloom_intensity.max(0.0)
}

// One threshold target avoids dependent tile stores/loads on SGX535.
// Field peaks keep twice the sampling density, bounded to an 80-pixel edge.
fn bloom_divisor(w: i32, h: i32, has_fields: bool) -> i32 {
    (if has_fields { 4 } else { 8 }).max((w.max(h) + 79) / 80)
}
fn bloom_texel(w: i32, h: i32) -> [f32; 4] {
    [0.25 / w as f32, 0.25 / h as f32, 1.0, 0.0]
}
fn haze_divisor(w: i32, h: i32) -> i32 {
    8.max((w.max(h) + 39) / 40)
}
impl PostTargets {
    unsafe fn new(w: i32, h: i32, haze: bool, has_fields: bool) -> Result<Self, String> {
        let target = |d: i32| Target::new((w / d).max(1), (h / d).max(1), false);
        Ok(Self {
            haze: if haze { Some(target(haze_divisor(w, h))?) } else { None },
            bloom: target(bloom_divisor(w, h, has_fields))?,
        })
    }
}

pub struct Effects {
    fields: [Option<Program>; 2],
    field_appearance: Option<FieldAppearance>,
    light_lod: Option<crate::light_lod::LightLod>,
    particles: [Option<ParticlePass>; 5],
    particle_grade: Option<ParticleGrade>,
    haze: Option<Program>,
    haze_bloom: Option<Program>,
    tiny: Program,
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
                fields[index] = Some(Program::new(root,
                    if index == 1 { &cfg.field_vista_ldr } else { &cfg.field_ldr },
                )?);
            }
        }
        if scene.light_page_buffer != 0 && fields.iter().flatten().any(|p| {
            !p.attrs[1] || !p.attrs[3] || !p.attrs[6]
        }) {
            return Err("light pages require cached phase, appearance and density field attributes".into());
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
        let particle_programs = |i: usize| -> Result<Program, String> {
            let display = if (i == 3) && scene.ipod_recipes.steam_coverage.is_some() {
                cfg.steam_coverage_ldr.as_ref().ok_or("steam coverage recipe requires its shader pipeline")?
            } else { &cfg.particles_ldr[i] };
            Program::new(root, display)
        };
        let mut rng = Rng(0x2545_f491);
        let streak_corners = [[-0.5, 0.0], [0.5, 0.0], [0.5, 1.0], [-0.5, 1.0]];
        let full_corners = [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]];
        if scene.meta.rain.active {
            particles[0] = Some(ParticlePass {
                program: particle_programs(0)?,
                buffer: ParticleBuffer::new(STREAKS, streak_corners, |_| {
                    (rng.seed(), [0.0; 3], [0.0; 3])
                })?,
            });
            let mut edges = Vec::new();
            for edge in &scene.meta.rain.drip_edges {
                let n = libm::roundf(Vec3::from(edge[0]).distance(Vec3::from(edge[1])) * 2.5)
                    .max(1.0) as usize;
                edges.extend(core::iter::repeat(*edge).take(n));
            }
            if !edges.is_empty() {
                particles[1] = Some(ParticlePass {
                    program: particle_programs(1)?,
                    buffer: ParticleBuffer::new(edges.len(), streak_corners, |i| {
                        (rng.seed(), edges[i][0], edges[i][1])
                    })?,
                });
            }
            particles[2] = Some(ParticlePass {
                program: particle_programs(2)?,
                buffer: ParticleBuffer::new(
                    SPLASHES,
                    [[-1.0, 0.0], [1.0, 0.0], [1.0, 1.0], [-1.0, 1.0]],
                    |_| (rng.seed(), [0.0; 3], [0.0; 3]),
                )?,
            });
            let vents = &scene.meta.rain.steam_vents;
            if !vents.is_empty() {
                particles[3] = Some(ParticlePass {
                    program: particle_programs(3)?,
                    buffer: ParticleBuffer::new(vents.len() * 26, full_corners, |i| {
                        let mut seed = rng.seed();
                        seed[0] = (i % 26) as f32 / 26.0 + seed[0] * 0.02;
                        (seed, vents[i / 26][0], vents[i / 26][1])
                    })?,
                });
            }
        }
        if !scene.meta.beacons.is_empty() {
            particles[4] = Some(ParticlePass {
                program: particle_programs(4)?,
                buffer: ParticleBuffer::new(scene.meta.beacons.len(), full_corners, |i| {
                    ([0.0; 4], scene.meta.beacons[i], [0.0; 3])
                })?,
            });
        }
        let haze = if has_haze {
            Some(Program::new(root, &cfg.haze_ldr)?)
        } else {
            None
        };
        let tiny = Program::new(root, &cfg.tiny_ldr)?;
        let haze_bloom = if has_haze {
            Some(Program::new(root, &cfg.haze_bloom_ldr)?)
        } else {
            None
        };
        let targets = PostTargets::new(width, height, has_haze, has_fields)?;
        let field_appearance = if fields.iter().flatten().any(|p| p.has("uFieldAppearance")) {
            Some(FieldAppearance::new(&scene.light_lod_source, &scene.meta.post)?)
        } else { None };
        let mut triangle = 0;
        glGenBuffers(1, &mut triangle);

        let mut range = [1.0, 1.0];
        glGetFloatv(0x846d, range.as_mut_ptr()); // GL_ALIASED_POINT_SIZE_RANGE
        let result = Self {
            fields,
            field_appearance,
            light_lod: None,
            particle_grade: particles
                .iter()
                .any(Option::is_some)
                .then(|| ParticleGrade::new(&scene.meta.post)),
            particles,
            haze,
            haze_bloom,
            tiny,
            vista: VistaUniforms::new(scene),
            targets,
            triangle,
            point_limit: range[1].max(2.0),
            has_fields,
            width,
            height,
        };
        upload_effect_buffer(
            GL_ARRAY_BUFFER,
            triangle,
            &[-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0],
            GL_STATIC_DRAW,
            "effect fullscreen vertices",
        )?;
        Ok(result)
    }

    pub unsafe fn resize(&mut self, width: i32, height: i32) -> Result<(), String> {
        if width <= 0 || height <= 0 {
            return Err("effect target dimensions".into());
        }
        if (self.width, self.height) != (width, height)
        {
            self.targets = PostTargets::new(
                width,
                height,
                self.haze.is_some(),
                self.has_fields,
            )?;
            self.width = width;
            self.height = height;
        }
        Ok(())
    }

    /// Separate from Scene's immutable payload accounting: GPU, CPU bytes.
    pub fn light_lod_bytes(&self) -> (usize, usize) {
        self.light_lod.as_ref().map_or((0, 0), |lod| lod.bytes())
    }
    pub fn field_appearance_bytes(&self) -> usize {
        self.field_appearance.as_ref().map_or(0, |a| a.gpu_bytes)
    }

    /// Draw into the bound main display framebuffer after opaque/transparent
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
        display_lut: u32,
    ) -> Result<EffectsStats, String> {
        let mut stats = EffectsStats::default();
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        glDepthMask(0);
        glDisable(GL_CULL_FACE);
        glDisable(0x8037); // GL_POLYGON_OFFSET_FILL
        // Add display-space particle light while preserving depth in alpha.
        glEnable(GL_BLEND);
        glBlendFuncSeparate(GL_ONE, GL_ONE, 0, GL_ONE);
        let result = (|| -> Result<EffectsStats, String> {
            let black = crate::gpu::tone_black(&scene.meta.post);
            let tan_half = libm::tanf(fov_degrees * core::f32::consts::PI / 360.0);
            let use_lod = (!scene.light_lod_source.is_empty() || scene.light_page_buffer != 0)
                && self.fields.iter().flatten().all(|p| p.attrs[3]);
            let paged = scene.light_page_buffer != 0;
            if use_lod {
                if self.light_lod.is_none() {
                    self.light_lod =
                        Some(crate::light_lod::LightLod::new(&scene.light_lod_source)?);
                }
                self.light_lod.as_mut().unwrap().prepare(
                    &scene.light_lod_source,
                    crate::light_lod::View {
                        vp,
                        eye,
                        width: self.width,
                        height: self.height,
                        tan_half,
                        point_limit: self.point_limit,
                    },
                    |draw| {
                        let d = &scene.meta.draws[draw];
                        in_frustum(vp, Vec3::from(d.min), Vec3::from(d.max))
                    },
                )?;
            }
            let mut current_field = None;
            let mut field_globals = [false; 2];
            let mut field_parameters = [None; 2];
            let field_count = if paged { scene.light_lod_source.pages().len() } else { scene.meta.draws.len() };
            for entry in 0..field_count {
                let page = paged.then(|| &scene.light_lod_source.pages()[entry]);
                let draw = page.map_or(entry, |p| p.draw);
                let d = &scene.meta.draws[draw];
                if d.layout != pc::VertexLayout::Lights { continue; }
                // Paged selection already used each original field's frustum;
                // a representative field must never cull the entire page.
                if !paged && !in_frustum(vp, Vec3::from(d.min), Vec3::from(d.max)) {
                    continue;
                }
                let material = &scene.meta.materials[d.material as usize];
                let Some(field) = material.lights else {
                    continue;
                };
                let field_kind = (material.fog && self.vista.is_some()) as usize;
                let program = self.fields[field_kind].as_ref().unwrap();
                // Older shader tables still use the original sine/angle
                // contract. Only the cached-phase attribute changes it.
                let phase_cached = program.attrs[1];
                let lod_draw = if use_lod {
                    Some(
                        if paged { self.light_lod.as_ref().unwrap().page(entry) }
                        else { self.light_lod.as_ref().unwrap().draw(&scene.light_lod_source, draw) }
                            .ok_or_else(|| format!("missing light LOD draw {draw}"))?,
                    )
                } else {
                    None
                };
                if lod_draw.is_some_and(|d| d.count == 0) {
                    continue;
                }
                let geometry_offset = if paged {
                    scene.ipod_recipes.light_pages.as_ref().unwrap().pages[entry].vertices.offset as usize
                } else { scene.gpu_vertex_offset(draw).ok_or("missing resident light field geometry")? as usize };
                let geometry_buffer = if paged { scene.light_page_buffer } else { scene.geometry };
                let program_changed = current_field != Some(field_kind);
                if program_changed {
                    program.bind();
                    current_field = Some(field_kind);
                    glBindBuffer(GL_ARRAY_BUFFER, geometry_buffer);
                    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
                    for i in 0..8 {
                        glDisableVertexAttribArray(i);
                    }
                }
                // These depend only on this frame/program, not on a field's
                // quantized vertex page. Avoid resending both 17-knot Vista tables
                // for every static field chunk.
                if !field_globals[field_kind] {
                    {
                        program.tex("uAtlasLut", display_lut, 7);
                        program.v("uAtlasBlack", &black);
                        if program.has("uFieldAppearance") {
                            let appearance = self.field_appearance.as_ref().ok_or("missing field appearance")?;
                            program.tex("uFieldAppearance", appearance.texture, 7);
                            program.v("uAppearance", &appearance.params);
                        }
                    }
                    program.v("uBlend", &[2.0, 0.0, 0.0, 0.0]);
                    program.mat("uViewProj", vp);
                    program.v("uEye", &v4(eye, time));
                    if field_kind != 0 {
                        self.vista.as_ref().unwrap().bind(program, eye);
                    }
                    field_globals[field_kind] = true;
                }
                program.v(
                    "uDequant",
                    &if paged { [1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0] } else { [
                        d.pos_scale[0],
                        d.pos_scale[1],
                        d.pos_scale[2],
                        0.0,
                        d.pos_offset[0],
                        d.pos_offset[1],
                        d.pos_offset[2],
                        0.0,
                    ] },
                );
                let scale = self.height as f32 / 272.0;
                let min = (field.min_pixels * scale).max(2.0).min(self.point_limit);
                let max = (field.max_pixels * scale).max(min).min(self.point_limit);
                let period = field.period.max(0.001);
                let t = time - libm::floorf(time / period) * period;
                let angle = (t * 4.0 - libm::floorf(t * 4.0)) * core::f32::consts::TAU;
                let mut parameters = [
                    self.height as f32 / tan_half,
                    min,
                    max,
                    field.gain,
                    t / period,
                    angle,
                    field.depth_pull * 0.001,
                    0.0,
                ];
                let key = parameters.map(f32::to_bits);
                if field_parameters[field_kind] != Some(key) {
                    if phase_cached {
                        parameters[5] = libm::sinf(angle);
                        parameters[7] = libm::cosf(angle);
                    }
                    program.v("uField", &parameters[..4]);
                    program.v("uFieldT", &parameters[4..]);
                    field_parameters[field_kind] = Some(key);
                }
                // Slot 1 below has a separate immutable VBO. Rebind GEOM
                // every draw before defining its packed attributes.
                glBindBuffer(GL_ARRAY_BUFFER, geometry_buffer);
                for (slot, n, kind, normalized, offset) in [
                    (0, 4, if paged { GL_FLOAT } else { 0x1402 }, (!paged) as u8, 0),
                    (4, 4, GL_UNSIGNED_BYTE, 1, if paged {16} else {8}),
                    (5, 2, GL_FLOAT, 0, if paged {20} else {12}),
                    (2, 4, GL_FLOAT, 0, if paged {28} else {20}),
                    (7, 4, GL_UNSIGNED_BYTE, 0, if paged {44} else {36}),
                ] {
                    if program.attrs[slot as usize] {
                        if program_changed {
                            glEnableVertexAttribArray(slot);
                        }
                        glVertexAttribPointer(
                            slot,
                            n,
                            kind,
                            normalized,
                            if paged { pc::ipod::light_pages::STRIDE as i32 } else { pc::LIGHT_POINT_STRIDE as i32 },
                            (geometry_offset + offset) as *const _,
                        );
                    }
                }
                if phase_cached {
                    let offset = if let Some(page) = page { Some((page.first * 8) as u32) } else { scene
                        .light_phase_offsets
                        .get(draw)
                        .copied()
                        .flatten() }
                        .filter(|_| scene.light_phase_buffer != 0)
                        .ok_or_else(|| format!("missing light phases for draw {draw}"))?;
                    glBindBuffer(GL_ARRAY_BUFFER, scene.light_phase_buffer);
                    if program_changed {
                        glEnableVertexAttribArray(1);
                    }
                    glVertexAttribPointer(1, 2, GL_FLOAT, 0, 8, offset as usize as *const _);
                }
                if program.attrs[6] {
                    let appearance = self.field_appearance.as_ref().ok_or("missing field appearance rows")?;
                    let offset = page.map(|p| p.first * 2).or_else(|| scene.light_lod_source.color_offset(draw))
                        .ok_or_else(|| format!("missing field appearance offset {draw}"))?;
                    glBindBuffer(GL_ARRAY_BUFFER, appearance.rows);
                    glEnableVertexAttribArray(6);
                    glVertexAttribPointer(6, 1, GL_UNSIGNED_SHORT, 0, 2, offset as *const _);
                }
                if let Some(draw) = lod_draw {
                    let (indices, weights) = self.light_lod.as_ref().unwrap().buffers();
                    glBindBuffer(GL_ARRAY_BUFFER, weights);
                    glEnableVertexAttribArray(3);
                    glVertexAttribPointer(3, 1, GL_FLOAT, 0, 4, draw.weight_offset as *const _);
                    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, indices);
                    glDrawElements(
                        GL_POINTS,
                        draw.count,
                        GL_UNSIGNED_SHORT,
                        draw.index_offset as *const _,
                    );
                    stats.light_points += draw.count as u32;
                } else {
                    if program.attrs[3] {
                        glDisableVertexAttribArray(3);
                        glVertexAttrib4f(3, 1.0, 0.0, 0.0, 1.0);
                    }
                    glDrawArrays(GL_POINTS, 0, d.vertex_count as i32);
                    stats.light_points += d.vertex_count;
                }
                stats.draws += 1;
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
                rain_divisor: 3,
            };
            let mut lights = if rain_enabled && self.particles[..4].iter().any(Option::is_some) {
                fog_lights(scene, time)
            } else {
                Vec::new()
            };
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
                let changed = pass.buffer.prepare(k, &view)?;
                if pass.buffer.count == 0 {
                    continue;
                }
                let p = &pass.program;
                p.bind();
                {
                    pass.buffer.grade(
                        k,
                        &view,
                        &positions,
                        &colors,
                        self.particle_grade.as_ref().unwrap(),
                        changed,
                    )?;
                    glBlendFuncSeparate(GL_ONE, if k == 3 { 0x0303 } else { GL_ONE }, 0, GL_ONE); // ONE_MINUS_SRC_ALPHA
                }
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
                    // Streak blending is additive. Compensate expected light
                    // energy for the stable subset, without changing width,
                    // trajectory or the near/far coverage functions.
                    0 => 0.9 * intensity * view.rain_divisor as f32,
                    1 => 1.2,
                    2 => 1.3 * intensity,
                    _ => 1.0,
                };
                p.v("uOpacity", &[opacity, 0.0, 0.0, 0.0]);
                if let Some(texture) = scene.meta.effects.puddles {
                    p.tex("uPuddles", scene.textures[texture as usize], 0);
                }
                if p.has("uSteamCoverage") {
                    let texture = scene.ipod_recipes.steam_coverage
                        .and_then(|i| scene.textures.get(i as usize)).copied().filter(|&id| id != 0)
                        .ok_or("missing resident steam coverage")?;
                    p.tex("uSteamCoverage", texture, 0);
                }
                pass.buffer.draw(p);
                stats.draws += 1;
                stats.particle_quads += (pass.buffer.count / 6) as u32;
            }
            Ok(stats)
        })();
        // Restore pass state even when an upload aborted the draw sequence.
        glDepthMask(1);
        glDisable(GL_BLEND);
        glColorMask(1, 1, 1, 1);
        result
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
        display_lut: u32,
    ) -> EffectTextures {
        glDisable(GL_DEPTH_TEST);
        glDepthMask(0);
        glDisable(GL_CULL_FACE);
        glDisable(GL_BLEND);
        glColorMask(1, 1, 1, 1);
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
        let bloom = bloom_enabled && scene.meta.post.bloom_intensity > 0.0;
        if let (true, Some(programs), Some(haze)) = (visible_haze, &self.haze, &self.targets.haze) {
            let program = programs;
            haze.bind();
            program.bind();
            {
                program.tex("uAtlasLut", display_lut, 7);
                program.v("uAtlasBlack", &crate::gpu::tone_black(&scene.meta.post));
            }
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
            let prepared = program.has("uFogMetric");
            let dry_origin = if prepared { eye } else { Vec3::ZERO };
            program.v("uBoxMin", &v4(Vec3::from(a.dry_min) - dry_origin, 0.0));
            program.v("uBoxMax", &v4(Vec3::from(a.dry_max) - dry_origin, 0.0));
            let mut positions = [0.0; FOG_LIGHTS * 4];
            let mut colors = positions;
            let mut dirs = positions;
            let mut metrics = positions;
            for k in 0..FOG_LIGHTS {
                let (p, c, d, metric) = ranked
                    .get(k)
                    .map(|(_, l)| *l)
                    .map(|l| haze_light_uniforms(l, eye, a.haze_density, prepared))
                    .unwrap_or_else(|| haze_light_uniforms(FogLight {
                        pos: Vec3::new(0.0, -1000.0, 0.0), color: Vec3::ZERO,
                        gain: 0.0, radius: 1.0, dir: Vec3::NEG_Y, outer: -2.0, inner: 1.0,
                    }, eye, a.haze_density, prepared));
                positions[k * 4..k * 4 + 4].copy_from_slice(&p);
                colors[k * 4..k * 4 + 4].copy_from_slice(&c);
                dirs[k * 4..k * 4 + 4].copy_from_slice(&d);
                metrics[k * 4..k * 4 + 4].copy_from_slice(&metric);
            }
            program.v("uFogPos", &positions);
            program.v("uFogCol", &colors);
            program.v("uFogDir", &dirs);
            program.v("uFogMetric", &metrics);
            program.v("uCurtain", &[0.55, 0.6, 0.72, curtain]);
            program.tex("uScene", scene_texture, 0);
            // Preserve nearest scene-depth semantics at the haze target's
            // own resolution, independently of the bloom filter footprint.
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            self.fullscreen();
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            output.haze = haze.texture;
            output.haze_weight = 1.0;
            {
                output.bloom = haze.texture;
                output.bloom_weight = 1.0;
            }
        }
        if bloom {
            let bloom = &self.targets.bloom;
            bloom.bind();
            let combine = output.haze_weight > 0.0;
            let prefilter = {
                if combine { self.haze_bloom.as_ref().unwrap() } else { &self.tiny }
            };
            prefilter.bind();
            prefilter.tex("uScene", scene_texture, 0);
            prefilter.tex("uHazeTex", output.haze, 1);
            prefilter.v(
                "uTexel",
                &bloom_texel(bloom.w, bloom.h),
            );
            prefilter.v(
                "uThreshold",
                &{
                    display_bloom_threshold(&scene.meta.post, output.haze_weight)
                },
            );
            if combine {
                prefilter.v("uEffectMix", &[
                    scene.meta.post.bloom_intensity,
                    1.0 / display_effect_scale(scene.meta.post.bloom_intensity), 0.0, 0.0,
                ]);
            }
            self.fullscreen();
            output.bloom = bloom.texture;
            output.bloom_weight = if combine {
                display_effect_scale(scene.meta.post.bloom_intensity)
            } else { scene.meta.post.bloom_intensity };
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

    #[test]
    fn display_haze_keeps_its_own_low_frequency_target() {
        for (w, h) in [(480, 320), (640, 426), (960, 640)] {
            let d = haze_divisor(w, h);
            let bloom = bloom_divisor(w, h, false);
            assert_eq!(w / d, 40);
            assert_eq!(h / d, 26);
            assert_eq!(w / bloom, if w == 480 { 60 } else { 80 });
            assert!(2 * (w / d) * (h / d) <= (w / bloom) * (h / bloom));
        }
    }

    #[test]
    fn prepared_haze_uniforms_preserve_integral_geometry_and_linear_energy() {
        for i in 0..128 {
            let t = i as f32 * 0.137;
            let eye = Vec3::new(t * 4.0, 1.7, -t);
            let light = FogLight {
                pos: Vec3::new(-3.4, 4.6, 7.3) + Vec3::new(t, t * 0.2, -t * 0.4),
                color: Vec3::new(0.08, 0.71, 1.0), gain: t * 0.03,
                radius: 0.2 + t * 0.11, dir: Vec3::new(0.0, -0.8, 0.6), outer: 0.4, inner: 0.8,
            };
            let density = 0.014;
            let (p, color, direction, metric) = haze_light_uniforms(light, eye, density, true);
            let (original, original_color, original_direction, _) = haze_light_uniforms(light, eye, density, false);
            assert_eq!(Vec3::from_slice(&original), light.pos);
            assert_eq!(direction, original_direction);
            for j in 0..16 {
                let ray = Vec3::new(j as f32 * 0.11 - 0.8, 0.2, -1.0).normalize();
                let l = light.pos - eye;
                let tca = l.dot(ray);
                let reference_ih = 1.0 / libm::sqrtf((l.length_squared() - tca * tca).max(0.0) + light.radius * light.radius);
                let prepared_l = Vec3::from_slice(&p);
                let prepared_tca = prepared_l.dot(ray);
                let ih = 1.0 / libm::sqrtf((metric[0] - prepared_tca * prepared_tca).max(0.0) + p[3]);
                assert_eq!(tca, prepared_tca);
                assert_eq!(reference_ih, ih); // Identical arc inputs, including softened grazing rays.
                let dist = 0.25 + j as f32 * 4.0;
                let reference_sample = eye + ray * tca.clamp(0.0, dist) - light.pos;
                let prepared_sample = ray * prepared_tca.clamp(0.0, dist) - prepared_l;
                assert!((reference_sample - prepared_sample).abs().max_element() < 0.00001);
                let integral = (libm::atanf((dist - tca) * ih) - libm::atanf(-tca * ih)) * ih;
                let expected = Vec3::from_slice(&original_color) * integral * density;
                let actual = Vec3::from_slice(&color) * integral;
                assert!((actual - expected).abs().max_element() < 0.0000001);
            }
        }
    }

    fn sample_field_response(pixels: &[u8], row: usize, scalar: f32) -> Vec3 {
        let c = scalar.clamp(0.0, FIELD_RESPONSE_MAX);
        let x = libm::sqrtf(c / (1.0 + c)) * (FIELD_RESPONSE_WIDTH - 1) as f32;
        let lo = x as usize;
        let sample = |i: usize| {
            let at = (row * FIELD_RESPONSE_WIDTH + i.min(FIELD_RESPONSE_WIDTH - 1)) * 4;
            Vec3::new(pixels[at] as f32, pixels[at + 1] as f32, pixels[at + 2] as f32) / 255.0
        };
        sample(lo).lerp(sample(lo + 1), x - lo as f32)
    }

    #[test]
    fn field_appearance_bounds_scalar_response_error_and_keeps_zero_dark() {
        let palette = [[255, 214, 149], [240, 246, 255], [255, 50, 38], [90, 255, 206],
            [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]];
        for tone in [pc::ToneCurve::Aces, pc::ToneCurve::Agx] {
            let post = pc::Post { tone, contrast: 1.16, saturation: 1.18,
                lift: [0.1, 0.35, 0.45], gain: [1.04, 0.99, 0.94], ..Default::default() };
            let grade = ParticleGrade::new(&post);
            let (height, pixels) = field_response_pixels(&palette, &grade).unwrap();
            assert_eq!(height, 16);
            let mut maximum = 0.0f32;
            for (row, rgb) in palette.iter().enumerate() {
                let c = Vec3::new(rgb[0] as f32, rgb[1] as f32, rgb[2] as f32) / 255.0;
                let linear = c * (c * (c * 0.305306011 + Vec3::splat(0.682171111)) + Vec3::splat(0.012522878));
                assert_eq!(sample_field_response(&pixels, row, 0.0), Vec3::ZERO);
                for step in 0..4096 {
                    let e = step as f32 / 4096.0;
                    let scalar = e * e / (1.0 - e * e);
                    let expected = (grade.sample(linear * scalar) - grade.black).max(Vec3::ZERO);
                    let actual = sample_field_response(&pixels, row, scalar);
                    maximum = maximum.max((actual - expected).abs().max_element());
                    assert!(actual.is_finite() && actual.min_element() >= 0.0);
                }
            }
            assert!(maximum <= 3.0 / 255.0, "scalar response error {} display bytes", maximum * 255.0);
        }
        assert!(field_response_pixels(&[], &ParticleGrade::new(&pc::Post::default())).is_err());
    }

    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to source PLIP packs; offline response validation"]
    fn measured_real_field_appearance_error() {
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").unwrap();
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") { continue; }
            let bytes = std::fs::read(&path).unwrap();
            let pack = pc::ipod::parse(&bytes).unwrap();
            let meta = pack.meta().unwrap();
            let source = crate::light_lod::Sources::new(&meta, pack.section(pc::TAG_GEOMETRY).unwrap()).unwrap();
            if source.palette().is_empty() { continue; }
            let grade = ParticleGrade::new(&meta.post);
            let (height, pixels) = field_response_pixels(source.palette(), &grade).unwrap();
            let mut maximum = 0.0f32;
            let mut squared = 0.0f64;
            let mut samples = 0usize;
            for (row, rgb) in source.palette().iter().enumerate() {
                let c = Vec3::new(rgb[0] as f32, rgb[1] as f32, rgb[2] as f32) / 255.0;
                let linear = c * (c * (c * 0.305306011 + Vec3::splat(0.682171111)) + Vec3::splat(0.012522878));
                assert_eq!(sample_field_response(&pixels, row, 0.0), Vec3::ZERO);
                for step in 0..4097 {
                    let e = step as f32 / 4096.0;
                    let scalar = if step == 4096 { FIELD_RESPONSE_MAX } else { e * e / (1.0 - e * e) };
                    let expected = (grade.sample(linear * scalar) - grade.black).max(Vec3::ZERO);
                    let error = sample_field_response(&pixels, row, scalar) - expected;
                    maximum = maximum.max(error.abs().max_element());
                    squared += error.length_squared() as f64;
                    samples += 3;
                }
            }
            std::println!("{}: {} source colours, {} source points, {}x{} appearance, GPU {} bytes; error max {:.4}/255 RMS {:.4}/255",
                meta.name, source.palette().len(), source.color_rows().len(), FIELD_RESPONSE_WIDTH, height,
                pixels.len() + source.color_rows().len() * 2, maximum * 255.0, (squared / samples as f64).sqrt() * 255.0);
            assert!(maximum <= 3.0 / 255.0, "{} response error {} bytes", meta.name, maximum * 255.0);
            checked += 1;
        }
        assert!(checked > 0, "no source light fields tested");
    }

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
            rain_divisor: 1,
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

    fn stream_fixture() -> ParticleBuffer {
        // Zero GL names make Drop harmless; upload callbacks exercise the
        // production transaction/cache logic without a real GLES context.
        ParticleBuffer {
            vertices: 0,
            indices: [0; 3],
            index_slot: 0,
            index_valid: false,
            colors: [0; 3],
            color_slot: 0,
            display_colors: alloc::vec![0; 32],
            display_key: None,
            selection_key: None,
            seeds: alloc::vec![
                ParticleSeed {
                    seed: [0; 4],
                    a: Vec3::new(0.0, 1.7, -3.0),
                    b: Vec3::ZERO
                },
                ParticleSeed {
                    seed: [0; 4],
                    a: Vec3::new(100.0, 1.7, -3.0),
                    b: Vec3::ZERO
                },
            ],
            visible: Vec::new(),
            light_samples: Vec::new(),
            scratch: Vec::new(),
            count: 0,
        }
    }

    #[test]
    fn particle_index_upload_failure_never_commits_and_fixed_view_retries() {
        let mut buffer = stream_fixture();
        let mut v = view(Vec3::new(0.0, 1.7, 0.0), Vec3::NEG_Z, 213, 25.0);
        let fail = |_: usize, _: &[u16]| Err(String::from("injected index GL 505"));
        assert!(buffer.prepare_with_upload(4, &v, fail).is_err());
        assert_eq!((buffer.index_slot, buffer.count), (0, 0));
        assert!(!buffer.index_valid && buffer.selection_key.is_none());
        let mut attempts = 0;
        assert!(buffer
            .prepare_with_upload(4, &v, |slot, indices| {
                attempts += 1;
                assert_eq!(slot, 1);
                assert_eq!(indices, [0, 1, 2, 0, 2, 3]);
                Ok(())
            })
            .unwrap());
        assert_eq!(attempts, 1);
        assert_eq!((buffer.index_slot, buffer.count), (1, 6));
        assert!(!buffer
            .prepare_with_upload(4, &v, |_, _| panic!("valid fixed view uploaded again"))
            .unwrap());

        // Fail after a valid slot when a new visible count is larger. Drawing
        // that new count against the old data is specifically forbidden.
        v.planes = [Vec4::ZERO; 6];
        assert!(buffer.prepare_with_upload(4, &v, fail).is_err());
        assert_eq!((buffer.index_slot, buffer.count), (1, 0));
        assert!(!buffer.index_valid && buffer.selection_key.is_none());
        assert!(buffer
            .prepare_with_upload(4, &v, |slot, indices| {
                assert_eq!((slot, indices.len()), (2, 12));
                Ok(())
            })
            .unwrap());
        assert_eq!((buffer.index_slot, buffer.count), (2, 12));
    }

    #[test]
    fn particle_color_upload_failure_invalidates_key_and_keeps_previous_slot() {
        let mut buffer = stream_fixture();
        let v = view(Vec3::new(0.0, 1.7, 0.0), Vec3::NEG_Z, 213, 25.0);
        buffer.prepare_with_upload(4, &v, |_, _| Ok(())).unwrap();
        let grade = ParticleGrade::new(&pc::Post::default());
        let data = [0.0; 32];
        let fail = |_: usize, _: &[u8]| Err(String::from("injected color GL 505"));
        assert!(buffer
            .grade_with_upload(4, &v, &data, &data, &grade, true, fail)
            .is_err());
        assert_eq!(buffer.color_slot, 0);
        assert!(buffer.display_key.is_none());
        assert!(!buffer
            .prepare_with_upload(4, &v, |_, _| panic!("valid index slot uploaded again"))
            .unwrap());
        buffer
            .grade_with_upload(4, &v, &data, &data, &grade, false, |slot, bytes| {
                assert_eq!((slot, bytes.len()), (1, 32));
                Ok(())
            })
            .unwrap();
        assert_eq!(buffer.color_slot, 1);
        assert!(buffer.display_key.is_some());
        buffer
            .grade_with_upload(4, &v, &data, &data, &grade, false, |_, _| {
                panic!("valid colors uploaded again")
            })
            .unwrap();
        // A forced update can have the same time/eye key but different selected
        // primitives; failure must invalidate even that previously valid key.
        assert!(buffer
            .grade_with_upload(4, &v, &data, &data, &grade, true, fail)
            .is_err());
        assert_eq!(buffer.color_slot, 1);
        assert!(buffer.display_key.is_none());
        buffer
            .grade_with_upload(4, &v, &data, &data, &grade, false, |slot, _| {
                assert_eq!(slot, 2);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn fixed_particle_view_reuses_selection_and_every_visibility_input_invalidates_it() {
        let seeds = random_seeds(STREAKS);
        let mut v = view(Vec3::new(0.0, 1.7, 0.0), Vec3::NEG_Z, 213, 25.0);
        let mut visible = Vec::new();
        let mut scratch = Vec::new();
        let mut last = None;
        let mut samples = Vec::new();
        assert!(select_particles_cached(
            &seeds,
            0,
            &v,
            &mut visible,
            &mut scratch,
            &mut last,
            &mut samples
        ));
        let original = visible.clone();
        scratch.clear();
        scratch.push(u16::MAX);
        assert!(!select_particles_cached(
            &seeds,
            0,
            &v,
            &mut visible,
            &mut scratch,
            &mut last,
            &mut samples
        ));
        assert_eq!(visible, original);
        // A hit does not even scan/rewrite the staging list.
        assert_eq!(scratch, [u16::MAX]);

        let mut check = |v: &ParticleView<'_>, kind| {
            assert_ne!(last, Some(v.key(kind)));
            let mut expected = Vec::new();
            select_particles(&seeds, kind, v, &mut expected);
            let changed = expected != visible;
            assert_eq!(
                select_particles_cached(
                    &seeds,
                    kind,
                    v,
                    &mut visible,
                    &mut scratch,
                    &mut last,
                    &mut samples
                ),
                changed
            );
            assert_eq!(visible, expected);
            assert_eq!(last, Some(v.key(kind)));
        };
        v.time += 0.01;
        check(&v, 0);
        v.eye.x += 0.01;
        check(&v, 0);
        v.center.z -= 0.01;
        check(&v, 0);
        v.wind[2] += 0.01;
        check(&v, 0);
        v.pixel *= 2.0; // Internal render resolution.
        check(&v, 0);
        v.planes[0].w += 0.01; // FOV, aspect, orientation or clipping planes.
        check(&v, 0);
        v.rain_divisor = 3;
        check(&v, 0);
        let dry = [[[0.0, 0.0, 0.0], [5.0, 4.0, 5.0]]];
        v.dry = &dry;
        check(&v, 0);
        let key = v.key(0);
        let mut moved_dry = dry;
        moved_dry[0][1][0] += 0.01;
        v.dry = &moved_dry;
        assert_ne!(key, v.key(0));
        check(&v, 0);
        check(&v, 2);
    }

    #[test]
    fn selection_reuses_motion_without_changing_eight_light_results() {
        let mut rng = Rng(0x7281_43a9);
        let positions = core::array::from_fn(|k| {
            if k % 4 == 3 {
                0.8 + rng.next() * 5.0
            } else {
                rng.next() * 24.0 - 12.0
            }
        });
        let colors = core::array::from_fn(|_| rng.next() * 6.0);
        let mut reused = [0; 5];
        for time in [0.0, 0.0001, 0.5, 3.2, 25.0, 120.0] {
            let v = view(Vec3::new(1.0, 1.7, -2.0), Vec3::NEG_Z, 213, time);
            for _ in 0..1024 {
                let p = ParticleSeed {
                    seed: rng.seed().map(|x| (x * 65535.0) as u16),
                    a: Vec3::new(
                        rng.next() * 20.0 - 10.0,
                        rng.next() * 4.0,
                        -rng.next() * 20.0,
                    ),
                    b: Vec3::new(rng.next(), rng.next(), rng.next()),
                };
                for kind in 0..5 {
                    let mut sample = None;
                    v.bounds_and_light(kind, &p, &mut sample);
                    if sample.is_some() {
                        reused[kind] += 1;
                    }
                    let original = particle_light(kind, &p, &v, &positions, &colors, None);
                    let reused = particle_light(kind, &p, &v, &positions, &colors, sample);
                    assert_eq!(
                        original.to_array().map(f32::to_bits),
                        reused.to_array().map(f32::to_bits)
                    );
                }
            }
        }
        assert!(reused[0] > 6000 && reused[1] > 6000 && reused[3] > 6000);
        // Splash positions remain GPU-hash conservative; beacons have no
        // position-dependent lighting. Neither needs a fabricated sample.
        assert_eq!(reused[2], 0);
        assert_eq!(reused[4], 0);
    }

    #[test]
    fn unchanged_visible_ids_still_refresh_animated_lighting_samples() {
        let seeds = [ParticleSeed {
            seed: [0, 32768, 0, 0],
            a: Vec3::new(0.0, 2.0, -3.0),
            b: Vec3::new(1.0, 2.0, -3.0),
        }];
        let mut v = view(Vec3::new(0.0, 1.7, 0.0), Vec3::NEG_Z, 213, 0.1);
        let (mut visible, mut scratch, mut samples, mut last) =
            (Vec::new(), Vec::new(), Vec::new(), None);
        assert!(select_particles_cached(
            &seeds,
            1,
            &v,
            &mut visible,
            &mut scratch,
            &mut last,
            &mut samples
        ));
        let original_indices = visible.clone();
        let original_sample = samples[0];
        v.time += 0.001;
        assert!(!select_particles_cached(
            &seeds,
            1,
            &v,
            &mut visible,
            &mut scratch,
            &mut last,
            &mut samples
        ));
        assert_eq!(visible, original_indices);
        assert_ne!(samples[0], original_sample);
        assert_eq!(samples.len() * 6, visible.len());
        let refreshed = samples.clone();
        assert!(!select_particles_cached(
            &seeds,
            1,
            &v,
            &mut visible,
            &mut scratch,
            &mut last,
            &mut samples
        ));
        assert_eq!(samples, refreshed);
    }

    #[test]
    fn cpu_particle_table_matches_two_bilinear_gpu_lookups() {
        for tone in [pc::ToneCurve::Agx, pc::ToneCurve::Aces] {
            let grade = ParticleGrade::new(&pc::Post {
                tone,
                ..pc::Post::default()
            });
            for r in [0.0f32, 0.001, 0.02, 0.2, 0.65, 0.9, 0.998] {
                for g in [0.0f32, 0.04, 0.4, 0.85, 0.99] {
                    for b in [0.0f32, 0.001, 0.1, 0.6, 0.96] {
                        let encoded = Vec3::new(r, g, b);
                        let q = encoded * encoded;
                        let radiance = q / (Vec3::ONE - q);
                        let cell = encoded * 15.0;
                        let z = cell.z as usize;
                        let bilinear = |z: usize| {
                            let x = cell.x as usize;
                            let y = cell.y as usize;
                            let texel = |x: usize, y: usize| {
                                let at = (y.min(15) * 256 + z.min(15) * 16 + x.min(15)) * 4;
                                Vec3::new(
                                    grade.pixels[at] as f32,
                                    grade.pixels[at + 1] as f32,
                                    grade.pixels[at + 2] as f32,
                                ) / 255.0
                            };
                            texel(x, y).lerp(texel(x + 1, y), cell.x - x as f32).lerp(
                                texel(x, y + 1).lerp(texel(x + 1, y + 1), cell.x - x as f32),
                                cell.y - y as f32,
                            )
                        };
                        let expected = bilinear(z).lerp(bilinear(z + 1), cell.z - z as f32);
                        assert!((expected - grade.sample(radiance)).abs().max_element() < 1e-6);
                    }
                }
            }
            assert_eq!(grade.color(0, Vec3::ZERO), [0, 0, 0, 255]);
        }
    }

    #[test]
    fn cpu_particle_grade_preserves_additive_and_steam_coverage_with_bounded_quantization() {
        let grade = ParticleGrade::new(&pc::Post::default());
        for color in [
            Vec3::ZERO,
            Vec3::splat(0.01),
            Vec3::new(0.1, 0.3, 0.8),
            Vec3::new(6.0, 0.48, 0.24),
        ] {
            for kind in 0..5 {
                let b = grade.color(kind, color);
                let c = Vec3::new(b[0] as f32, b[1] as f32, b[2] as f32) / 255.;
                for coverage in [0.0f32, 0.01, 0.1, 0.5, 1.0, 3.0] {
                    let actual = c * coverage * if kind == 3 { 0.28 } else { 1.0 };
                    let expected = if kind == 3 {
                        grade.sample(color * 1.75) * coverage * 0.16
                    } else {
                        (grade.sample(color) - grade.black).max(Vec3::ZERO) * coverage
                    };
                    let bound = coverage * if kind == 3 { 0.28 } else { 1.0 } / 510.0 + 1e-6;
                    assert!((actual - expected).abs().max_element() <= bound);
                }
            }
        }
    }

    #[test]
    fn cpu_particle_lighting_matches_shared_eight_light_gain_and_sample_positions() {
        let mut v = view(Vec3::new(0.0, 1.0, 0.0), Vec3::NEG_Z, 213, 0.0);
        v.center = Vec3::new(13.0, 0.0, 13.0);
        let particle = ParticleSeed {
            seed: [0; 4],
            a: Vec3::ZERO,
            b: Vec3::ZERO,
        };
        let mut positions = [0.0; 32];
        let mut colors = [0.0; 32];
        for k in 0..8 {
            positions[k * 4 + 3] = 1.0;
            colors[k * 4..k * 4 + 3].copy_from_slice(&[0.2, 0.3, 0.4]);
        }
        let ambient = Vec3::new(0.05, 0.06, 0.08);
        let sum = Vec3::new(0.2, 0.3, 0.4) * 8.0;
        for (kind, expected) in [
            (0, ambient + sum),
            (1, (ambient + sum) * 1.4),
            (2, ambient + sum / 1.01),
            (3, ambient + sum),
            (4, Vec3::new(6.0, 0.48, 0.24) * 0.35),
        ] {
            assert!(
                (particle_light(kind, &particle, &v, &positions, &colors, None) - expected)
                    .abs()
                    .max_element()
                    < 1e-5
            );
        }
        v.time = 1.0;
        assert!(
            (particle_light(4, &particle, &v, &positions, &colors, None)
                - Vec3::new(6.0, 0.48, 0.24))
            .abs()
            .max_element()
                < 1e-6
        );
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
    fn performance_rain_is_a_stable_subset_with_compensated_mean_energy() {
        let seeds = random_seeds(STREAKS);
        let retained = seeds.iter().filter(|seed| seed.rain_sample(3)).count();
        assert!((2200..2470).contains(&retained));
        assert!(seeds.iter().all(|seed| seed.rain_sample(1)));
        let mut full = Vec::new();
        let mut reduced = Vec::new();
        let mut full_total = 0;
        let mut reduced_total = 0;
        for (forward, time) in [(Vec3::NEG_Z, 0.0), (Vec3::X, 25.0), (Vec3::Z, 79.99)] {
            let mut v = view(Vec3::new(0.0, 1.7, 0.0), forward, 320, time);
            select_particles(&seeds, 0, &v, &mut full);
            v.rain_divisor = 3;
            select_particles(&seeds, 0, &v, &mut reduced);
            let expected: Vec<_> = full
                .chunks_exact(6)
                .filter(|quad| seeds[quad[0] as usize / 4].rain_sample(3))
                .flat_map(|quad| quad.iter().copied())
                .collect();
            assert_eq!(reduced, expected);
            full_total += full.len();
            reduced_total += reduced.len();
        }
        let energy = reduced_total as f32 * 3.0 / full_total as f32;
        assert!((0.85..1.15).contains(&energy), "mean rain energy {energy}");
        // Profile changes must not reduce the splash field.
        let mut v = view(Vec3::new(0.0, 1.7, 0.0), Vec3::NEG_Z, 320, 25.0);
        select_particles(&seeds[..SPLASHES], 2, &v, &mut full);
        v.rain_divisor = 3;
        select_particles(&seeds[..SPLASHES], 2, &v, &mut reduced);
        assert!(!full.is_empty());
        assert_eq!(full, reduced);
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
    fn performance_bloom_has_one_target_and_a_resolution_bounded_footprint() {
        for (w, h) in [
            (1, 1),
            (320, 213),
            (480, 320),
            (640, 426),
            (960, 640),
            (640, 960),
        ] {
            for fields in [false, true] {
                let divisor = bloom_divisor(w, h, fields);
                let bw = (w / divisor).max(1);
                let bh = (h / divisor).max(1);
                assert!(bw <= 80 && bh <= 80);
                let texel = bloom_texel(bw, bh);
                assert!(texel.iter().all(|v| v.is_finite()));
                // The four taps stay at output-pixel quadrant centres,
                // including portrait and nonintegral scaling factors.
                assert!((texel[0] * bw as f32 - 0.25).abs() < 1e-6);
                assert!((texel[1] * bh as f32 - 0.25).abs() < 1e-6);
                assert_eq!(texel[2], 1.0);
            }
        }
        assert_eq!(320 / bloom_divisor(320, 213, false), 40);
        assert_eq!(320 / bloom_divisor(320, 213, true), 80);
    }

    #[test]
    fn empty_haze_is_skipped_but_each_independent_source_is_retained() {
        assert!(!haze_contributes(0.0, 0.0, Vec3::ONE, 6, 0.0));
        assert!(!haze_contributes(1.0, 1.0, Vec3::ZERO, 0, 0.0));
        assert!(haze_contributes(1.0, 0.0, Vec3::ZERO, 1, 0.0));
        assert!(haze_contributes(0.0, 0.1, Vec3::ONE, 0, 0.0));
        assert!(haze_contributes(0.0, 0.0, Vec3::ZERO, 0, 0.1));
    }

    #[test]
    fn display_bloom_tracks_the_authored_grade_and_has_finite_headroom() {
        for tone in [pc::ToneCurve::Agx, pc::ToneCurve::Aces] {
            for exposure in [0.1, 0.94, 1.0, 4.0] {
                let post = pc::Post {
                    tone,
                    exposure,
                    ..pc::Post::default()
                };
                let threshold = display_bloom_threshold(&post, 0.75);
                let display = Vec3::from(pc::color::tone([post.bloom_threshold; 3], &post))
                    .dot(Vec3::new(0.2126, 0.7152, 0.0722));
                assert!(threshold.iter().all(|x| x.is_finite()));
                assert!((threshold[0] - (display * 0.95).min(0.9)).abs() < 1e-6);
                assert!(threshold[1] >= 0.025 && threshold[0] + threshold[1] <= 1.0);
                assert_eq!(threshold[2], 0.75);
                assert!(threshold[3] > 0.0 && threshold[0] + threshold[3] <= 1.000001);
                let black = crate::gpu::tone_black(&post);
                let exact = pc::color::tone([0.0; 3], &post);
                for k in 0..3 {
                    assert_eq!(black[k], (exact[k] * 255.0) as u8 as f32 / 255.0);
                }
            }
        }
    }

    #[test]
    fn combined_display_storage_cannot_clip_and_bounds_reconstructed_error() {
        let byte = |x: f32| libm::floorf(x * 255.0 + 0.5) / 255.0;
        for intensity in [0.0, 0.35, 0.4, 0.85, 0.95, 4.0] {
            let scale = display_effect_scale(intensity);
            for h in [0.0, 0.01, 0.3, 0.8, 1.0] {
                for b in [0.0, 0.025, 0.2, 0.7, 1.0] {
                    // Four already-rounded old target texels. Interpolation
                    // must commute with the new linear packing scale.
                    let haze = [byte(h), byte(b), 0.0, 1.0];
                    let bloom = [byte(b), byte(h), 1.0, 0.0];
                    let sum: [f32; 4] = core::array::from_fn(|i| haze[i] + bloom[i] * intensity);
                    let packed = sum.map(|v| v / scale);
                    assert!(packed.iter().all(|&v| (0.0..=1.0).contains(&v)));
                    let unpacked = packed.map(|v| byte(v) * scale);
                    for weights in [[0.25; 4], [0.06, 0.14, 0.24, 0.56]] {
                        let expected: f32 = sum.iter().zip(weights).map(|(v, w)| v * w).sum();
                        let actual: f32 = unpacked.iter().zip(weights).map(|(v, w)| v * w).sum();
                        assert!((actual - expected).abs() <= scale / 510.0 + 1e-6);
                    }
                }
            }
        }
    }

    #[test]
    fn display_vista_matches_shader_knots_extinction_and_unweighted_inscatter() {
        let haze = pc::VistaHaze {
            density: 1.6e-4,
            inversion: -60.0,
            scale: 60.0,
            gain: 1.0,
            glow: [0.03, 0.018, 0.009],
            band: 0.25,
        };
        let mut vista = VistaUniforms {
            density: [
                haze.density,
                haze.inversion,
                1.0 / (haze.scale * core::f32::consts::LN_2),
                haze.density * haze.scale,
            ],
            sun: [1.0, 0.0, 0.0, 0.0],
            glow: [haze.glow[0], haze.glow[1], haze.glow[2], haze.band],
            haze,
            sky: [0.0; pc::VistaHaze::SKY_KNOTS * 4],
            sun_sky: [0.0; pc::VistaHaze::SKY_KNOTS * 4],
        };
        for k in 0..pc::VistaHaze::SKY_KNOTS {
            vista.sky[k * 4..k * 4 + 3].copy_from_slice(&[0.01 + 0.003 * k as f32, 0.04, 0.06]);
            vista.sun_sky[k * 4..k * 4 + 3].copy_from_slice(&[0.14 / (k + 1) as f32, 0.01, 0.003]);
        }
        let post = pc::Post::default();
        for y in [-120.0, -60.0, 0.0, 300.0] {
            let eye = Vec3::new(0.0, y, 0.0);
            for dy in [-150.0, 0.0, 0.005, 240.0] {
                for distance in [0.0, 1.0, 500.0, 12000.0] {
                    for azimuth in 0..=32 {
                        let angle = azimuth as f32 * core::f32::consts::TAU / 32.0;
                        let center = eye
                            + Vec3::new(
                                libm::cosf(angle) * distance,
                                dy,
                                libm::sinf(angle) * distance,
                            );
                        // Independent translation of vista.cgh using its
                        // exp2 uniforms and flattened table indexing.
                        let d = center.distance(eye);
                        let rho =
                            libm::exp2f(-(center.y - vista.density[1]).max(0.0) * vista.density[2]);
                        let column = if center.y > vista.density[1] {
                            vista.density[0] * vista.density[1] + vista.density[3] * (1.0 - rho)
                        } else {
                            vista.density[0] * center.y
                        };
                        let delta = center.y - eye.y;
                        let tau = if delta.abs() < 0.01 {
                            d * vista.haze.density * vista.haze.relative_density(eye.y)
                        } else {
                            d * (column - vista.haze.column(eye.y)) / delta
                        };
                        let t = libm::exp2f(-tau.max(0.0) * 1.442695);
                        let horizontal = Vec2::new(center.x - eye.x, center.z - eye.z);
                        let h = horizontal / libm::sqrtf(horizontal.length_squared().max(1e-8));
                        let u = libm::sqrtf((0.5 - 0.5 * h.x).clamp(0.0, 1.0)) * 16.0;
                        let k = (libm::floorf(u) as usize).min(15);
                        let f = u - k as f32;
                        let w = vista.glow[3] + (1.0 - vista.glow[3]) * (1.0 - t);
                        let scatter = core::array::from_fn(|c| {
                            let a =
                                vista.sky[k * 4 + c] * (1.0 - f) + vista.sky[(k + 1) * 4 + c] * f;
                            let b = vista.sun_sky[k * 4 + c] * (1.0 - f)
                                + vista.sun_sky[(k + 1) * 4 + c] * f;
                            a + w * b + vista.glow[c] * rho
                        });
                        let expected = pc::color::tone(scatter, &post);
                        let actual = vista.display_at(eye, center, &post);
                        assert!((actual[3] - t).abs() < 1e-4);
                        for c in 0..3 {
                            assert!((actual[c] - expected[c]).abs() < 2e-5);
                        }
                    }
                }
            }
        }
        let same = vista.display_at(Vec3::ZERO, Vec3::ZERO, &post);
        assert_eq!(same[3], 1.0);
        assert!(same[..3].iter().all(|c| *c > 0.0)); // no accidental (1-T)
    }
}
