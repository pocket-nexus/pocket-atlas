//! Tileable lookup textures that replace per-pixel procedural noise on
//! handheld GPUs: puddle fields, an animated rain-ripple flipbook, static
//! glass beads and the cloud deck. The functions mirror the demo's GLSL so
//! the patterns match the browser renderer.

use glam::{Vec2, Vec3};
use rayon::prelude::*;

use crate::textures::Rgba;

fn fract(x: f32) -> f32 {
    x - x.floor()
}

fn fract2(v: Vec2) -> Vec2 {
    v - v.floor()
}

fn fract3(v: Vec3) -> Vec3 {
    v - v.floor()
}

pub fn hash22(p: Vec2) -> Vec2 {
    let mut p3 = fract3(Vec3::new(p.x, p.y, p.x) * Vec3::new(0.1031, 0.1030, 0.0973));
    p3 += Vec3::splat(p3.dot(Vec3::new(p3.y, p3.z, p3.x) + 33.33));
    fract2((Vec2::new(p3.x, p3.x) + Vec2::new(p3.y, p3.z)) * Vec2::new(p3.z, p3.y))
}

pub fn hash32(p: Vec2) -> Vec3 {
    let mut p3 = fract3(Vec3::new(p.x, p.y, p.x) * Vec3::new(0.1031, 0.1030, 0.0973));
    p3 += Vec3::splat(p3.dot(Vec3::new(p3.y, p3.x, p3.z) + 33.33));
    fract3((Vec3::new(p3.x, p3.x, p3.y) + Vec3::new(p3.y, p3.z, p3.z)) * Vec3::new(p3.z, p3.y, p3.x))
}

fn wrap(c: Vec2, per: Vec2) -> Vec2 {
    if per.x > 0.0 {
        c - per * (c / per).floor()
    } else {
        c
    }
}

fn gnoise(p: Vec2, per: Vec2) -> f32 {
    let i = p.floor();
    let f = p - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let g = |o: Vec2| hash22(wrap(i + o, per)) * 2.0 - 1.0;
    let a = g(Vec2::ZERO).dot(f);
    let b = g(Vec2::X).dot(f - Vec2::X);
    let c = g(Vec2::Y).dot(f - Vec2::Y);
    let d = g(Vec2::ONE).dot(f - Vec2::ONE);
    let ab = a + (b - a) * u.x;
    let cd = c + (d - c) * u.x;
    (ab + (cd - ab) * u.y) * 1.4142
}

fn fbm(mut p: Vec2, mut per: Vec2, oct: u32) -> f32 {
    let (mut s, mut a, mut n) = (0.0, 0.5, 0.0);
    for _ in 0..oct {
        s += a * gnoise(p, per);
        n += a;
        p = p * 2.0 + if per.x <= 0.0 { Vec2::new(17.3, 9.1) } else { Vec2::ZERO };
        per *= 2.0;
        a *= 0.5;
    }
    s / n * 0.5 + 0.5
}

fn image(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 4] + Sync) -> Rgba {
    let px = (0..h).into_par_iter().flat_map_iter(|y| (0..w).map(move |x| (x, y)).collect::<Vec<_>>()).map(|(x, y)| f(x, y)).collect();
    Rgba { w, h, px }
}

/// R: puddle field `fbm(uv·4)`, G: detail `fbm(uv·9 + 3)`; one tile = 1 unit of
/// the demo's puddle UV.
pub fn puddles(size: u32) -> Rgba {
    image(size, size, |x, y| {
        let uv = Vec2::new((x as f32 + 0.5) / size as f32, (y as f32 + 0.5) / size as f32);
        let a = fbm(uv * 4.0, Vec2::splat(4.0), 6);
        let b = fbm(uv * 9.0 + 3.0, Vec2::splat(9.0), 5);
        [a, b, 0.0, 1.0]
    })
}

/// One ripple layer (the demo's `rippleLayer`) on a periodic cell grid, with
/// a time loop of one unit: every drop restarts once per loop.
fn ripple(p: Vec2, t: f32, per: f32) -> Vec2 {
    let cell = p.floor();
    let f = p - cell;
    let mut acc = Vec2::ZERO;
    for j in -1..=1 {
        for i in -1..=1 {
            let o = Vec2::new(i as f32, j as f32);
            let c = wrap(cell + o, Vec2::splat(per));
            let h = hash32(c);
            let center = o + Vec2::new(h.x, h.y);
            let phase = fract(t + h.x * 7.0 + h.z * 3.0);
            let d = f - center;
            let dist = d.length();
            let radius = phase * 0.55;
            let ring = dist - radius;
            let env = (1.0 - phase) * (1.0 - phase);
            let wave = (ring * 42.0).sin() * (-ring * ring * 520.0).exp() * env;
            acc += d / dist.max(1e-3) * wave;
        }
    }
    acc
}

/// Rain-ripple flipbook: `frames` frames of `cells`×`cells` drop cells in a
/// square atlas; RG = ripple normal offset × 0.5 + 0.5.
pub fn ripples(frame: u32, grid: u32, cells: f32) -> Rgba {
    let size = frame * grid;
    let frames = grid * grid;
    image(size, size, |x, y| {
        let k = (y / frame) * grid + x / frame;
        let t = k as f32 / frames as f32;
        let uv = Vec2::new(((x % frame) as f32 + 0.5) / frame as f32, ((y % frame) as f32 + 0.5) / frame as f32);
        let r = ripple(uv * cells, t, cells);
        [(r.x * 0.5 + 0.5).clamp(0.0, 1.0), (r.y * 0.5 + 0.5).clamp(0.0, 1.0), 0.0, 1.0]
    })
}

fn beads_at(uv: Vec2, scale: f32, seed: f32) -> Vec3 {
    let p = uv * scale;
    let i = p.floor();
    let f = p - i;
    let mut acc = Vec3::ZERO;
    for y in -1..=1 {
        for x in -1..=1 {
            let o = Vec2::new(x as f32, y as f32);
            let c = wrap(i + o, Vec2::splat(scale));
            let h = hash32(c + seed);
            if h.z < 0.35 {
                continue;
            }
            let center = o + 0.15 + Vec2::new(h.x, h.y) * 0.7;
            let mut d = f - center;
            d.y *= 1.0 + h.z * 0.4;
            let r = 0.12 + 0.2 * h.z * h.x;
            let l = d.length();
            if l < r {
                let k = l / r;
                let n = d / r * (1.0 - k * k).sqrt() * 1.4;
                acc.x += n.x;
                acc.y += n.y;
                acc.z = acc.z.max(((1.0 - k) / 0.3).clamp(0.0, 1.0));
            }
        }
    }
    acc
}

/// Static rain beads on glass for a 1 m tile: RG = refraction normal offset
/// × 0.25 + 0.5, B = coverage.
pub fn beads(size: u32) -> Rgba {
    image(size, size, |x, y| {
        let uv = Vec2::new((x as f32 + 0.5) / size as f32, (y as f32 + 0.5) / size as f32);
        let b = beads_at(uv, 38.0, 0.0) + beads_at(uv, 71.0, 13.0) * 0.6;
        [(b.x * 0.25 + 0.5).clamp(0.0, 1.0), (b.y * 0.25 + 0.5).clamp(0.0, 1.0), b.z.clamp(0.0, 1.0), 1.0]
    })
}

/// Cloud deck: R = 6-octave fbm, G = 5-octave fbm, each periodic over
/// `cells` noise cells per tile.
pub fn clouds(size: u32, cells: f32) -> Rgba {
    image(size, size, |x, y| {
        let uv = Vec2::new((x as f32 + 0.5) / size as f32, (y as f32 + 0.5) / size as f32);
        let a = fbm(uv * cells, Vec2::splat(cells), 6);
        let b = fbm(uv * cells + 5.0, Vec2::splat(cells), 5);
        [a, b, 0.0, 1.0]
    })
}
