//! Light fields as GE sprites. PICA's sprite colours (summed where distant
//! steady lights share a pixel and a half, through the vista haze and the
//! grade) become two corners each; the GE places them every frame from three
//! bone matrices (`pp::SpriteVertex`), so a light keeps its pixel size and
//! its pull toward the camera from any shot. Lights do not travel, blink or
//! twinkle here: a travelling light stands where its path starts, a blinking
//! one shines at its duty cycle's share.
use glam::Vec3;
use pocket_atlas_model as pc;
use pocket3d_place_psp as pp;

/// Sprites per culled group, at most.
const GROUP: usize = 2048;

pub(super) struct Lights {
    pub groups: Vec<pp::SpriteGroup>,
    pub texture: u32,
    pub sprites: usize,
    pub nearest: f32,
    pub farthest: f32,
}

pub(super) fn cook(m: &crate::source::Scene, eye: Vec3, w: &mut super::Writer, textures: &mut Vec<pp::Texture>) -> Option<Lights> {
    let shots = &m.camera.shots;
    let fov = shots.iter().map(|s| s.from.fov + s.to.fov).sum::<f32>() / (2 * shots.len().max(1)) as f32;
    let height = 272.0;
    let focal = height / (fov.to_radians() * 0.5).tan();
    let mut sprites = Vec::new();
    for d in &m.draws {
        let crate::source::Geometry::LightField(lights) = &d.geometry else { continue };
        let f = m.materials[d.material as usize].lights.unwrap_or_default();
        let records = crate::pica::sprites(
            lights,
            &f,
            eye,
            focal,
            height,
            false,
            |p, c| crate::pica::vista(m, eye, p, c, true),
            |c| Vec3::from(pc::color::tone(c.to_array(), &m.post)),
        );
        let (lo, hi) = (f.min_pixels * height / 272.0, f.max_pixels * height / 272.0);
        for r in records.chunks_exact(52) {
            let at = |i: usize| f32::from_le_bytes(r[i * 4..i * 4 + 4].try_into().unwrap());
            let path = Vec3::new(at(4), at(5), at(6));
            let (phase, blinks, duty) = (at(8), at(9), at(10));
            let p = Vec3::new(at(0), at(1), at(2)) + path * phase.fract();
            let dist = (p - eye).length().max(0.01);
            let size = (at(3) * focal / dist).clamp(lo, hi);
            let pull = (f.depth_pull * dist / 1000.0).clamp(0.002, 0.5);
            let share = if blinks > 0.0 { duty.clamp(0.0, 1.0) } else { 1.0 };
            let rgb = [r[48], r[49], r[50]].map(|c| (c as f32 * share).round() as u8);
            sprites.push((p, size, pull, u32::from_le_bytes([rgb[0], rgb[1], rgb[2], 255])));
        }
    }
    if sprites.is_empty() {
        return None;
    }
    // Groups by direction from the shots and by distance, so a frame culls
    // what lies behind it.
    let cell = |p: Vec3| {
        let v = p - eye;
        let sector = ((v.x.atan2(-v.z) / std::f32::consts::TAU + 0.5) * 32.0) as u32 % 32;
        let band = (v.length().max(1.0).log2() * 2.0) as u32;
        (sector, band)
    };
    sprites.sort_by_key(|s| cell(s.0));
    let mut groups = Vec::new();
    let mut start = 0;
    while start < sprites.len() {
        let key = cell(sprites[start].0);
        let mut end = start;
        while end < sprites.len() && end - start < GROUP && cell(sprites[end].0) == key {
            end += 1;
        }
        let run = &sprites[start..end];
        let mut vertices = Vec::with_capacity(run.len() * 2);
        let (mut min, mut max) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for &(p, size, pull, color) in run {
            for (sign, uv) in [(-1.0, [0.0, 0.0]), (1.0, [1.0, 1.0])] {
                vertices.push(pp::SpriteVertex { weights: [1.0, sign * size * (1.0 - pull) * 0.5, pull], uv, color, pos: p.to_array() });
            }
            min = min.min(p);
            max = max.max(p);
        }
        groups.push(pp::SpriteGroup { vertices: w.push(&vertices), min: min.to_array(), max: max.to_array() });
        start = end;
    }
    let (nearest, farthest) = sprites.iter().fold((f32::MAX, 0.0f32), |(a, b), s| {
        let d = (s.0 - eye).length();
        (a.min(d * (1.0 - s.2)), b.max(d))
    });
    // A light's profile (1 − r²)², as PICA's falloff texture: white light,
    // shaped by the texture and coloured by the vertex.
    let n = 16;
    let pixels: Vec<u8> = (0..n * n)
        .flat_map(|i| {
            let (x, y) = ((i % n) as f32 + 0.5, (i / n) as f32 + 0.5);
            let r2 = ((x / n as f32 * 2.0 - 1.0).powi(2) + (y / n as f32 * 2.0 - 1.0).powi(2)).min(1.0);
            let v = ((1.0 - r2).powi(2) * 255.0).round() as u8;
            [v, v, v, 255]
        })
        .collect();
    let texture = textures.len() as u32;
    textures.push(pp::Texture { pixels: w.push(&super::swizzle(&pixels, n * 4, n)), width: n as u32, height: n as u32, wrap: 3, mips: 1, format: pp::RGBA8888 });
    Some(Lights { groups, texture, sprites: sprites.len(), nearest, farthest })
}
