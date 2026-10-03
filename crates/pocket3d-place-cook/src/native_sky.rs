//! Shared display-referred daylight lowering for fixed-function backends.
use crate::textures::Rgba;
use glam::Vec3;
use pc::color::decode as linear;
use pocket_atlas_model as pc;

// The same authored AgX/ACES grade as the Vita's colour LUT.
pub(crate) fn grade(c: Vec3, p: &pc::Post) -> Vec3 {
    Vec3::from(pc::color::tone(c.to_array(), p))
}
// Display-referred panoramas preserve authored day/twilight colour, sunlight
// and clouds without spending fragment instructions or an HDR target on PICA.
pub(crate) fn sky_radiance(s: &pc::DaySky, d: Vec3) -> Vec3 {
    let h = d.y;
    let mut color =
        Vec3::from(s.horizon).lerp(Vec3::from(s.zenith), h.max(0.0).powf(s.gradient_power));
    if h < 0.0 {
        color =
            Vec3::from(s.horizon).lerp(Vec3::from(s.ground), (-h * s.ground_blend).clamp(0.0, 1.0));
    }
    let mu = d.dot(Vec3::from(s.sun_direction)).max(0.0);
    let smooth =
        ((mu - s.disc_cos_outer) / (s.disc_cos_inner - s.disc_cos_outer).max(1e-6)).clamp(0.0, 1.0);
    color += Vec3::from(s.sun_color)
        * (s.glow
            * (s.glow_wide[0] * mu.powf(s.glow_wide[1])
                + s.glow_tight[0] * mu.powf(s.glow_tight[1]))
            + s.disc * smooth * smooth * (3.0 - 2.0 * smooth));
    if let Some(t) = &s.twilight {
        let a = Vec3::new(d.x, 0.0, d.z)
            .normalize_or(Vec3::Z)
            .dot(Vec3::new(s.sun_direction[0], 0.0, s.sun_direction[2]).normalize_or(Vec3::Z))
            .clamp(-1.0, 1.0);
        let toward = (a + 1.0) * 0.5;
        let away = (1.0 - a) * 0.5;
        color += Vec3::from(t.band.color)
            * ((-h.abs() / t.band.height.max(1e-5)).exp()
                * (1.0 - t.band.sun_bias + t.band.sun_bias * toward.powf(t.band.sun_power)));
        let z = (h - t.belt.elevation) / t.belt.width.max(1e-5);
        color += Vec3::from(t.belt.color) * ((-z * z).exp() * away.powf(t.belt.power));
        color *= 1.0
            - t.shadow.strength
                * (-h.abs() / t.shadow.height.max(1e-5)).exp()
                * away.powf(t.shadow.power);
    }
    color
}
// Match a filtered GPU panorama sample (repeat azimuth, clamp elevation).
fn bilinear(image: &Rgba, u: f32, v: f32) -> [f32; 4] {
    let x = u * image.w as f32 - 0.5;
    let y = v * image.h as f32 - 0.5;
    let (ix, iy) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - x.floor(), y - y.floor());
    let pixel = |a: i32, b: i32| {
        image.px[b.clamp(0, image.h as i32 - 1) as usize * image.w as usize
            + a.rem_euclid(image.w as i32) as usize]
    };
    let (a, b, c, d) = (
        pixel(ix, iy),
        pixel(ix + 1, iy),
        pixel(ix, iy + 1),
        pixel(ix + 1, iy + 1),
    );
    std::array::from_fn(|k| {
        (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy
    })
}
// Compute the premultiplied *display* contribution, after composing the
// original HDR sky + cloud radiance through the authored tone curve. Simply
// toning the cloud in isolation then blending display RGB darkens its rim.
// Empty sky texels are exactly zero, so bilinear filtering cannot
// introduce a black fringe (runtime blend is ONE, ONE_MINUS_SRC_ALPHA).
pub(crate) fn cloud_overlay(base: Vec3, radiance: Vec3, alpha: f32, post: &pc::Post) -> Vec3 {
    let target = grade(base * (1.0 - alpha) + radiance, post);
    (target - grade(base, post) * (1.0 - alpha)).max(Vec3::ZERO)
}
pub(crate) fn panorama(s: &pc::DaySky, post: &pc::Post, clouds: Option<&Rgba>) -> Rgba {
    let (w, h) = if clouds.is_some() {
        (1024, 512)
    } else {
        (512, 256)
    };
    let px = (0..h)
        .flat_map(|y| {
            (0..w).map(move |x| {
                let az = (x as f32 + 0.5) / w as f32 * std::f32::consts::TAU;
                let elevation = ((y as f32 + 0.5) / h as f32 - 0.5) * std::f32::consts::PI;
                let d = Vec3::new(
                    az.sin() * elevation.cos(),
                    elevation.sin(),
                    -az.cos() * elevation.cos(),
                );
                let (rgb, alpha) = if let Some(c) = clouds {
                    let turn = az / std::f32::consts::TAU;
                    let u = (turn * 2.0).fract();
                    let lv = (elevation.max(0.0) / std::f32::consts::FRAC_PI_2).sqrt();
                    let v = ((turn * 2.0).floor() + lv.clamp(0.5 / 512.0, 1.0 - 0.5 / 512.0)) * 0.5;
                    let p = bilinear(c, u, v);
                    let f = (d.y / s.fade_elevation.max(1e-5)).clamp(0.0, 1.0);
                    let f = f * f * (3.0 - 2.0 * f);
                    let radiance =
                        (Vec3::from(s.cloud_sun) * p[1] + Vec3::from(s.cloud_ambient) * p[2]) * f;
                    (
                        cloud_overlay(sky_radiance(s, d), radiance, p[0] * f, post),
                        p[0] * f,
                    )
                } else {
                    (grade(sky_radiance(s, d), post), 1.0)
                };
                let c = rgb.map(linear);
                [c.x, c.y, c.z, alpha]
            })
        })
        .collect();
    Rgba { w, h, px }
}
pub(crate) fn sun_occluder(scene: &crate::source::Scene) -> Option<crate::occlusion::Occluder> {
    let m = scene;
    assert!(
        m.materials.iter().all(|m| !m.vertex_pbr),
        "native lowering requires source materials, not Vita PBR palettes"
    );
    m.sun.as_ref()?.shadow.as_ref()?;
    let mut tris = Vec::new();
    for d in &m.draws {
        let mat = &m.materials[d.material as usize];
        if d.node.is_some()
            || d.skin.is_some()
            || mat.kind == pc::Kind::Glass
            || mat.kind == pc::Kind::Water
            || mat.blend != pc::Blend::Opaque
        {
            continue;
        }
        for tri in d.indices().chunks_exact(3) {
            let p: Vec<Vec3> = tri
                .iter()
                .map(|&v| scene.vertex(d, v as usize).pos)
                .collect();
            tris.push(crate::occlusion::Tri {
                a: p[0],
                e1: p[1] - p[0],
                e2: p[2] - p[0],
                opacity: if mat.alpha_test > 0.0 { 0.55 } else { 1.0 },
            });
        }
    }
    Some(crate::occlusion::Occluder::new(tris, 1, 2000.0))
}
