//! Static lighting baked into vertices. The runtime's per-pixel light loop is
//! the most expensive part of a material program on the Vita GPU, and the
//! city's lights and surfaces do not move, so the cooker evaluates the same
//! lighting model per vertex: every static light (rect-panel closest point,
//! spot cone, distance falloff), the hemisphere light and the environment's
//! diffuse term. Large triangles are subdivided where the lighting across
//! an edge is not linear, so lamp pools on the street keep their shape.
//!
//! The result is diffuse irradiance already divided by π (what the shader
//! multiplies by the diffuse colour), stored as square-root RGBM.

use std::collections::HashMap;

use glam::{Vec2, Vec3};
use pocket3d_city as pc;
use rayon::prelude::*;

use crate::geometry::Vertex;

/// Decoded irradiance = (rgb · m)² · RANGE.
pub const RANGE: f32 = 64.0;

/// Refinement: edges shorter than this are never split.
const MIN_EDGE: f32 = 0.4;
/// Refinement rounds; each halves the longest edges that fail the test.
const ROUNDS: u32 = 6;
/// Split when the midpoint differs from linear interpolation by more than
/// ABS + REL × the local level (luminance, irradiance units).
const ABS: f32 = 0.0015;
const REL: f32 = 0.15;

struct Light {
    pos: Vec3,
    color: Vec3,
    dir: Vec3,
    inv_range: f32,
    spot_scale: f32,
    spot_offset: f32,
    right: Vec3,
    up: Vec3,
    half_w: f32,
    half_h: f32,
}

pub struct Baker {
    lights: Vec<Light>,
    hemi_sky: Vec3,
    hemi_ground: Vec3,
    /// Environment's last (diffuse) mip, linear RGB, `env_size`².
    env: Vec<Vec3>,
    env_size: u32,
}

fn luminance(c: Vec3) -> f32 {
    c.dot(Vec3::new(0.2126, 0.7152, 0.0722))
}

/// Inverse of `env::oct_decode` (y is the folded axis).
fn oct_uv(d: Vec3) -> Vec2 {
    let d = d / (d.x.abs() + d.y.abs() + d.z.abs()).max(1e-6);
    let mut p = Vec2::new(d.x, d.z);
    if d.y < 0.0 {
        let s = Vec2::new(if p.x >= 0.0 { 1.0 } else { -1.0 }, if p.y >= 0.0 { 1.0 } else { -1.0 });
        p = (Vec2::ONE - Vec2::new(p.y.abs(), p.x.abs())) * s;
    }
    p * 0.5 + Vec2::splat(0.5)
}

impl Baker {
    /// `env`: the cooked octahedral environment (RGBA16F, all mips).
    pub fn new(lights: &[pc::Light], atmosphere_hemi: ([f32; 3], [f32; 3]), env: Option<(&[u8], u32, u32)>) -> Self {
        let lights = lights
            .iter()
            .filter(|l| l.node.is_none())
            .map(|l| {
                let dir = Vec3::from(l.direction).normalize_or(Vec3::NEG_Y);
                let mut out = Light {
                    pos: Vec3::from(l.position),
                    color: Vec3::from(l.color),
                    dir,
                    inv_range: if l.range > 0.0 { 1.0 / l.range } else { 0.0 },
                    spot_scale: 0.0,
                    spot_offset: 1.0,
                    right: Vec3::ZERO,
                    up: Vec3::ZERO,
                    half_w: 0.0,
                    half_h: 0.0,
                };
                // Same derivation as the runtime (city-vita scene.rs).
                match l.kind {
                    pc::LightKind::Point => {}
                    pc::LightKind::Spot => {
                        let span = (l.cos_inner - l.cos_outer).max(1e-4);
                        out.spot_scale = 1.0 / span;
                        out.spot_offset = -l.cos_outer / span;
                    }
                    pc::LightKind::Rect => {
                        let right = Vec3::from(l.right).normalize_or(Vec3::Y.cross(dir).normalize_or(Vec3::X));
                        out.right = right;
                        out.up = dir.cross(right).normalize_or(Vec3::Y);
                        out.half_w = l.size[0] * 0.5;
                        out.half_h = l.size[1] * 0.5;
                        out.color *= l.size[0] * l.size[1];
                        out.spot_scale = 1.0;
                        out.spot_offset = 0.0;
                    }
                }
                out
            })
            .collect();
        let (mut env_px, mut env_size) = (Vec::new(), 0);
        if let Some((data, size, mips)) = env {
            let mut at = 0usize;
            for level in 0..mips {
                let s = (size >> level).max(4);
                if level == mips - 1 {
                    let h = |o: usize| half::f16::from_le_bytes([data[o], data[o + 1]]).to_f32();
                    env_px = (0..(s * s) as usize).map(|i| Vec3::new(h(at + i * 8), h(at + i * 8 + 2), h(at + i * 8 + 4))).collect();
                    env_size = s;
                }
                at += (s * s * 8) as usize;
            }
        }
        Self { lights, hemi_sky: Vec3::from(atmosphere_hemi.0), hemi_ground: Vec3::from(atmosphere_hemi.1), env: env_px, env_size }
    }

    /// Bilinear, clamped: what `tex2Dlod(uEnv, octUv(n), last mip)` returns.
    fn env_diffuse(&self, n: Vec3) -> Vec3 {
        if self.env_size == 0 {
            return Vec3::ZERO;
        }
        let s = self.env_size as f32;
        let uv = oct_uv(n) * s - Vec2::splat(0.5);
        let (x0, y0) = (uv.x.floor(), uv.y.floor());
        let (fx, fy) = (uv.x - x0, uv.y - y0);
        let at = |x: f32, y: f32| {
            let xi = x.clamp(0.0, s - 1.0) as usize;
            let yi = y.clamp(0.0, s - 1.0) as usize;
            self.env[yi * self.env_size as usize + xi]
        };
        let top = at(x0, y0).lerp(at(x0 + 1.0, y0), fx);
        let bottom = at(x0, y0 + 1.0).lerp(at(x0 + 1.0, y0 + 1.0), fx);
        top.lerp(bottom, fy)
    }

    /// Diffuse irradiance / π at `p` with normal `n`. `direct` = false skips
    /// the lights (materials the runtime shades as shop interiors).
    pub fn irradiance(&self, p: Vec3, n: Vec3, env_k: f32, direct: bool) -> Vec3 {
        let n = n.normalize_or(Vec3::Y);
        let hemi = n.y * 0.5 + 0.5;
        let mut e = self.hemi_ground.lerp(self.hemi_sky, hemi) * std::f32::consts::FRAC_1_PI + self.env_diffuse(n) * env_k;
        if !direct {
            return e;
        }
        for l in &self.lights {
            let d = p - l.pos;
            let q = l.pos + l.right * d.dot(l.right).clamp(-l.half_w, l.half_w) + l.up * d.dot(l.up).clamp(-l.half_h, l.half_h);
            let lv = q - p;
            let d2 = lv.length_squared();
            let ld = lv / d2.max(1e-12).sqrt();
            let ndl = n.dot(ld);
            if ndl <= 0.0 {
                continue;
            }
            let mut s = ((-ld).dot(l.dir) * l.spot_scale + l.spot_offset).clamp(0.0, 1.0);
            s = s * s * (3.0 - 2.0 * s);
            let d2a = d2 + l.half_w * l.half_h;
            let x = d2a * l.inv_range * l.inv_range;
            let w = (1.0 - x * x).clamp(0.0, 1.0);
            let att = w * w / d2a.max(0.01) * s;
            e += l.color * (att * ndl * std::f32::consts::FRAC_1_PI);
        }
        e
    }
}

/// Square-root RGBM: decode as (rgb · a)² · RANGE.
pub fn encode(c: Vec3) -> [u8; 4] {
    let s = (c.max(Vec3::ZERO) / RANGE).min(Vec3::ONE);
    let s = Vec3::new(s.x.sqrt(), s.y.sqrt(), s.z.sqrt());
    let m = (s.max_element().max(1e-6) * 255.0).ceil().clamp(1.0, 255.0) / 255.0;
    let q = |v: f32| ((v / m).clamp(0.0, 1.0) * 255.0).round() as u8;
    [q(s.x), q(s.y), q(s.z), (m * 255.0).round() as u8]
}

fn midpoint(a: &Vertex, b: &Vertex) -> Vertex {
    let n = (a.normal + b.normal).normalize_or(a.normal);
    let t = Vec3::new(a.tangent[0] + b.tangent[0], a.tangent[1] + b.tangent[1], a.tangent[2] + b.tangent[2]).normalize_or(Vec3::X);
    let mut color = [0u8; 4];
    for k in 0..4 {
        color[k] = ((a.color[k] as u16 + b.color[k] as u16) / 2) as u8;
    }
    Vertex { pos: (a.pos + b.pos) * 0.5, normal: n, tangent: [t.x, t.y, t.z, a.tangent[3]], uv: (a.uv + b.uv) * 0.5, color, joints: a.joints, weights: a.weights, light: [0; 4] }
}

type PosKey = [i32; 3];

fn pos_key(p: Vec3) -> PosKey {
    // Millimetre grid: vertices duplicated at UV seams share edge decisions.
    [(p.x * 1000.0).round() as i32, (p.y * 1000.0).round() as i32, (p.z * 1000.0).round() as i32]
}

pub struct Refined {
    pub verts: Vec<Vertex>,
    pub tris: Vec<[u32; 3]>,
}

/// Bakes `eval` into every vertex, splitting edges (consistently for both
/// triangles that share them, so no T-junctions) where the lighting is not
/// linear across them.
pub fn refine(mut verts: Vec<Vertex>, mut tris: Vec<[u32; 3]>, eval: &(dyn Fn(Vec3, Vec3) -> Vec3 + Sync)) -> Refined {
    let mut light: Vec<Vec3> = verts.par_iter().map(|v| eval(v.pos, v.normal)).collect();
    for _ in 0..ROUNDS {
        // Unique geometric edges and one representative index pair each.
        let mut edge_of: HashMap<(PosKey, PosKey), usize> = HashMap::new();
        let mut reps: Vec<(u32, u32)> = Vec::new();
        for t in &tris {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let (ka, kb) = (pos_key(verts[a as usize].pos), pos_key(verts[b as usize].pos));
                let key = if ka <= kb { (ka, kb) } else { (kb, ka) };
                edge_of.entry(key).or_insert_with(|| {
                    reps.push((a, b));
                    reps.len() - 1
                });
            }
        }
        let split: Vec<bool> = reps
            .par_iter()
            .map(|&(a, b)| {
                let (va, vb) = (&verts[a as usize], &verts[b as usize]);
                if va.pos.distance(vb.pos) < MIN_EDGE {
                    return false;
                }
                let m = midpoint(va, vb);
                let lm = luminance(eval(m.pos, m.normal));
                let avg = luminance((light[a as usize] + light[b as usize]) * 0.5);
                (lm - avg).abs() > ABS + REL * lm.max(avg)
            })
            .collect();
        if !split.iter().any(|&s| s) {
            break;
        }
        // Midpoint vertices per index pair (sides of a UV seam keep their UVs).
        let mut mids: HashMap<(u32, u32), u32> = HashMap::new();
        let mut added: Vec<Vertex> = Vec::new();
        let mut mid = |a: u32, b: u32, verts: &Vec<Vertex>, added: &mut Vec<Vertex>| -> u32 {
            let key = if a < b { (a, b) } else { (b, a) };
            *mids.entry(key).or_insert_with(|| {
                added.push(midpoint(&verts[a as usize], &verts[b as usize]));
                (verts.len() + added.len() - 1) as u32
            })
        };
        let mut out: Vec<[u32; 3]> = Vec::with_capacity(tris.len() * 2);
        for t in &tris {
            let s: [Option<u32>; 3] = std::array::from_fn(|k| {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let (ka, kb) = (pos_key(verts[a as usize].pos), pos_key(verts[b as usize].pos));
                let key = if ka <= kb { (ka, kb) } else { (kb, ka) };
                split[edge_of[&key]].then(|| mid(a, b, &verts, &mut added))
            });
            match s.iter().filter(|m| m.is_some()).count() {
                0 => out.push(*t),
                3 => {
                    let (m01, m12, m20) = (s[0].unwrap(), s[1].unwrap(), s[2].unwrap());
                    out.extend([[t[0], m01, m20], [m01, t[1], m12], [m20, m12, t[2]], [m01, m12, m20]]);
                }
                n => {
                    // Rotate so the pattern starts at edge 0: one split on
                    // (v0,v1), or two on (v0,v1) and (v1,v2).
                    let r = (0..3)
                        .find(|&r| if n == 1 { s[r].is_some() } else { s[r].is_some() && s[(r + 1) % 3].is_some() })
                        .unwrap();
                    let v = [t[r], t[(r + 1) % 3], t[(r + 2) % 3]];
                    let m0 = s[r].unwrap();
                    if n == 1 {
                        out.extend([[v[0], m0, v[2]], [m0, v[1], v[2]]]);
                    } else {
                        let m1 = s[(r + 1) % 3].unwrap();
                        out.push([m0, v[1], m1]);
                        out.extend([[v[0], m0, m1], [v[0], m1, v[2]]]);
                    }
                }
            }
        }
        let fresh: Vec<Vec3> = added.par_iter().map(|v| eval(v.pos, v.normal)).collect();
        verts.extend(added);
        light.extend(fresh);
        tris = out;
    }
    for (v, l) in verts.iter_mut().zip(&light) {
        v.light = encode(*l);
    }
    Refined { verts, tris }
}
