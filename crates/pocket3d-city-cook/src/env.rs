//! HDR environment: WebGL cube faces (+X −X +Y −Y +Z −Z, rows as read back
//! with readPixels) → an octahedral map whose mip n is prefiltered for
//! roughness n / (mips − 1). A 2D map avoids cube-face conventions on the
//! target and keeps filtering continuous across the former face seams.

use glam::{Vec2, Vec3};
use half::f16;
use rayon::prelude::*;

pub struct Env {
    pub size: u32,
    pub mips: u32,
    /// RGBA16F rows, all mips contiguous.
    pub data: Vec<u8>,
}

struct Cube<'a> {
    raw: &'a [u8],
    size: usize,
}

impl Cube<'_> {
    fn texel(&self, face: usize, x: usize, y: usize) -> Vec3 {
        let i = ((face * self.size + y) * self.size + x) * 8;
        let h = |o: usize| f16::from_le_bytes([self.raw[i + o], self.raw[i + o + 1]]).to_f32();
        Vec3::new(h(0), h(2), h(4))
    }

    /// OpenGL cube lookup (the convention three.js render-target cubes use).
    fn sample(&self, d: Vec3) -> Vec3 {
        let a = d.abs();
        let (face, sc, tc, ma) = if a.x >= a.y && a.x >= a.z {
            if d.x > 0.0 { (0, -d.z, -d.y, a.x) } else { (1, d.z, -d.y, a.x) }
        } else if a.y >= a.z {
            if d.y > 0.0 { (2, d.x, d.z, a.y) } else { (3, d.x, -d.z, a.y) }
        } else if d.z > 0.0 {
            (4, d.x, -d.y, a.z)
        } else {
            (5, -d.x, -d.y, a.z)
        };
        let s = (sc / ma + 1.0) * 0.5;
        let t = (tc / ma + 1.0) * 0.5;
        let n = self.size as f32;
        let x = ((s * n - 0.5).max(0.0) as usize).min(self.size - 1);
        let y = ((t * n - 0.5).max(0.0) as usize).min(self.size - 1);
        self.texel(face, x, y)
    }
}

/// Octahedral decode: uv in [0,1]² → unit direction (y is the folded axis).
pub fn oct_decode(uv: Vec2) -> Vec3 {
    let p = uv * 2.0 - Vec2::ONE;
    let mut d = Vec3::new(p.x, 1.0 - p.x.abs() - p.y.abs(), p.y);
    if d.y < 0.0 {
        let x = (1.0 - d.z.abs()) * d.x.signum();
        let z = (1.0 - d.x.abs()) * d.z.signum();
        d.x = x;
        d.z = z;
    }
    d.normalize()
}

fn basis(n: Vec3) -> (Vec3, Vec3) {
    let up = if n.y.abs() < 0.99 { Vec3::Y } else { Vec3::X };
    let t = up.cross(n).normalize();
    (t, n.cross(t))
}

pub fn octahedral(raw: &[u8], face: u32, size: u32, mips: u32) -> Env {
    let cube = Cube { raw, size: face as usize };
    let mut data = Vec::new();
    for level in 0..mips {
        let s = (size >> level).max(4);
        let rough = level as f32 / (mips - 1).max(1) as f32;
        // Lobe half-angle grows with roughness (approximates GGX spread).
        let spread = (rough * rough * 1.4).min(1.5);
        let samples: Vec<(Vec2, f32)> = if level == 0 {
            vec![(Vec2::ZERO, 1.0)]
        } else {
            let n = 96;
            (0..n)
                .map(|i| {
                    let u = (i as f32 + 0.5) / n as f32;
                    let v = (i as f32 * 0.618_034).fract();
                    let r = u.sqrt() * spread;
                    let a = v * std::f32::consts::TAU;
                    (Vec2::new(r * a.cos(), r * a.sin()), (1.0 - u).max(0.05))
                })
                .collect()
        };
        let rows: Vec<Vec<u8>> = (0..s)
            .into_par_iter()
            .map(|y| {
                let mut row = Vec::with_capacity(s as usize * 8);
                for x in 0..s {
                    let uv = Vec2::new((x as f32 + 0.5) / s as f32, (y as f32 + 0.5) / s as f32);
                    let n = oct_decode(uv);
                    let (t, b) = basis(n);
                    let mut acc = Vec3::ZERO;
                    let mut wsum = 0.0;
                    for &(o, w) in &samples {
                        let d = (n + t * o.x.tan().clamp(-4.0, 4.0) + b * o.y.tan().clamp(-4.0, 4.0)).normalize();
                        acc += cube.sample(d) * w;
                        wsum += w;
                    }
                    let c = acc / wsum;
                    for v in [c.x, c.y, c.z, 1.0] {
                        row.extend(f16::from_f32(v).to_le_bytes());
                    }
                }
                row
            })
            .collect();
        for r in rows {
            data.extend(r);
        }
    }
    Env { size, mips, data }
}
