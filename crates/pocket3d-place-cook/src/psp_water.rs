//! Open water on the GE (web `places/shared/water.ts`, 3DS `water.v.pica`):
//! one wave layer as a luminance texture scrolled by the material, the body
//! and the reflected sky mixed by Fresnel in the vertex colours as seen from
//! the middle of the shots. Flat water is laid again as a polar grid about
//! that point, rings 12% apart: the Fresnel term has vertices where it
//! changes, and no triangle near a camera is large enough for the GE to
//! reject it. The grid is cut into sectors so each part is culled, and so the
//! far rings fall in the vista range.
use glam::{Vec2, Vec3};
use pocket_atlas_model as pc;
use pocket3d_place_psp as pp;

/// The wave normal map as luminance (3DS: 0.65 to 1.0 linear by slope).
pub(super) fn texture(m: &crate::source::Scene, mat: &pc::Material, w: &mut super::Writer, textures: &mut Vec<pp::Texture>) -> Option<u32> {
    let t = &m.textures[mat.normal? as usize];
    let size = t.width.next_power_of_two().min(t.height.next_power_of_two()).clamp(8, 256);
    let img = image::RgbaImage::from_raw(t.width, t.height, t.rgba8()).unwrap();
    let mut level = image::imageops::resize(&img, size, size, image::imageops::FilterType::Triangle);
    let (mut chain, mut mips) = (Vec::new(), 0);
    loop {
        let n = level.width();
        let pixels: Vec<u8> = level
            .pixels()
            .flat_map(|p| {
                let slope = ((p[0] as f32 / 255.0 - 0.5) * 0.7 + (p[1] as f32 / 255.0 - 0.5) * 0.5).clamp(-0.4, 0.4);
                let v = pc::color::encode8((0.88 + slope * 0.28).clamp(0.65, 1.0));
                [v, v, v, 255]
            })
            .collect();
        chain.extend(super::swizzle(&pixels, n as usize * 4, n as usize));
        mips += 1;
        if n <= 8 || mips == 4 {
            break;
        }
        level = image::imageops::resize(&level, n / 2, n / 2, image::imageops::FilterType::Triangle);
    }
    textures.push(pp::Texture { pixels: w.push(&chain), width: size, height: size, wrap: 0, mips, format: pp::RGBA8888 });
    Some(textures.len() as u32 - 1)
}

/// The material's scroll: the first layer, in texture widths per second.
pub(super) fn scroll(mat: &pc::Material) -> [f32; 2] {
    let w = mat.water.unwrap_or_default().waves[0];
    [w[1] * w[0], w[2] * w[0]]
}

/// Display colour of the water at `p` from `eye`: body and sky by Fresnel.
fn colour(m: &crate::source::Scene, mat: &pc::Material, eye: Vec3, p: Vec3, shallow: f32) -> u32 {
    let w = mat.water.unwrap_or_default();
    let body = Vec3::from(w.body).lerp(Vec3::from(w.shallow.unwrap_or(w.body)), shallow) * Vec3::from(m.atmosphere.hemisphere_sky);
    let v = (eye - p).normalize_or(Vec3::Y);
    let flat = Vec2::new(v.x, v.z).normalize_or_zero() * w.mask;
    let n = Vec3::new(flat.x, 1.0, flat.y).normalize();
    let nv = n.dot(v).max(0.0);
    let fresnel = 0.02 + 0.98 * 2f32.powf((-5.55473 * nv - 6.98316) * nv);
    let mut r = (-v) - 2.0 * (-v).dot(n) * n;
    r.y = r.y.abs();
    let sky = m.day_sky.as_ref().map_or(Vec3::from(m.atmosphere.sky_horizon), |s| crate::pica::sky_radiance(s, r.normalize_or(Vec3::Y)))
        * mat.env_strength;
    super::daylight::graded(body.lerp(sky, fresnel), 1.0, &m.post)
}

pub(super) struct Water {
    pub vertices: Vec<pp::Vertex>,
    pub parts: Vec<Vec<u16>>,
}

/// The draw's triangles, or for flat water the polar grid, with colours and
/// world-anchored wave coordinates. `split`: the radius from which rings go
/// to sector parts of their own.
pub(super) fn lay(m: &crate::source::Scene, draw: &crate::source::Draw, mat: &pc::Material, eye: Vec3, split: f32) -> Water {
    let rpm = mat.water.unwrap_or_default().waves[0][0].max(1e-6);
    let origin = (Vec2::new(eye.x, eye.z) * rpm).floor() / rpm;
    let vertex = |p: Vec3, shallow: f32| pp::Vertex {
        uv: ((Vec2::new(p.x, p.z) - origin) * rpm).to_array(),
        color: colour(m, mat, eye, p, shallow),
        pos: p.to_array(),
    };
    let ids = draw.indices();
    let points: Vec<(Vec3, f32)> = (0..draw.vertex_count() as usize)
        .map(|i| {
            let v = m.vertex(draw, i);
            (v.pos, if mat.vertex_color { pc::color::decode(v.color[0] as f32 / 255.0) } else { 0.0 })
        })
        .collect();
    let y = points.first().map_or(0.0, |p| p.0.y);
    if draw.node.is_some() || draw.skin.is_some() || points.iter().any(|p| (p.0.y - y).abs() > 0.05) {
        let vertices = points.iter().map(|&(p, s)| vertex(p, s)).collect();
        return Water { vertices, parts: vec![ids.iter().map(|&i| i as u16).collect()] };
    }
    let tris: Vec<[(Vec2, f32); 3]> = ids
        .chunks_exact(3)
        .map(|t| core::array::from_fn(|k| {
            let (p, shallow) = points[t[k] as usize];
            (Vec2::new(p.x, p.z), shallow)
        }))
        .collect();
    // Inside the water's outline, and the shallow weight there.
    let sample = |q: Vec2| -> Option<f32> {
        tris.iter().find_map(|t| {
            let (a, b, c) = (t[0].0, t[1].0, t[2].0);
            let d = (b - a).perp_dot(c - a);
            if d.abs() < 1e-9 {
                return None;
            }
            let u = (b - q).perp_dot(c - q) / d;
            let v = (c - q).perp_dot(a - q) / d;
            let w = 1.0 - u - v;
            (u >= -1e-4 && v >= -1e-4 && w >= -1e-4).then(|| t[0].1 * u + t[1].1 * v + t[2].1 * w)
        })
    };
    let centre = Vec2::new(eye.x, eye.z);
    let reach = tris.iter().flatten().map(|p| (p.0 - centre).length()).fold(0.0, f32::max);
    let (r0, q, n) = (6.0f32, 1.12f32, 64usize);
    let rings = ((reach / r0).max(1.0).ln() / q.ln()).ceil() as usize + 1;
    let radius = |k: usize| r0 * q.powi(k as i32);
    let at = |k: usize, j: usize| {
        let a = (j % n) as f32 / n as f32 * std::f32::consts::TAU;
        centre + Vec2::new(a.sin(), -a.cos()) * radius(k)
    };
    let mut vertices = vec![vertex(Vec3::new(centre.x, y, centre.y), sample(centre).unwrap_or(0.0))];
    for k in 0..=rings {
        for j in 0..n {
            let p = at(k, j);
            vertices.push(vertex(Vec3::new(p.x, y, p.y), sample(p).unwrap_or(0.0)));
        }
    }
    let index = |k: usize, j: usize| (1 + k * n + j % n) as u16;
    // Sectors of 22.5° from the split on; one part inside it.
    let sectors = 16;
    let mut parts = vec![Vec::new(); 1 + sectors];
    let keep = |ps: &[Vec2]| ps.iter().any(|&p| sample(p).is_some());
    for j in 0..n {
        if keep(&[centre, at(0, j), at(0, j + 1)]) {
            parts[0].extend([0, index(0, j + 1), index(0, j)]);
        }
    }
    for k in 0..rings {
        for j in 0..n {
            let corners = [at(k, j), at(k, j + 1), at(k + 1, j), at(k + 1, j + 1)];
            let middle = corners.iter().copied().sum::<Vec2>() / 4.0;
            if !keep(&corners) && sample(middle).is_none() {
                continue;
            }
            let part = if radius(k) >= split { 1 + j * sectors / n } else { 0 };
            // Facing up: (b − a) × (c − a) along +y.
            parts[part].extend([index(k, j), index(k + 1, j + 1), index(k + 1, j), index(k, j), index(k, j + 1), index(k + 1, j + 1)]);
        }
    }
    parts.retain(|p| !p.is_empty());
    Water { vertices, parts }
}
