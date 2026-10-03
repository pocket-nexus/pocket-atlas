//! Shared fixed-function daylight: authored sky/grade baked into one panorama,
//! directional diffuse light baked at vertices, static world-space shadows.
use glam::{Mat4, Quat, Vec3};
use pocket3d_place as pc;
use pocket3d_place_psp as pp;

pub(super) fn enabled(kind: &str) -> bool {
    assert!(
        matches!(kind, "night-street" | "daytime-slope" | "daytime-street"),
        "PSP supports night-street, daytime-slope and daytime-street places"
    );
    kind.starts_with("daytime-")
}

pub(super) fn graded(c: Vec3, alpha: f32, post: &pc::Post) -> u32 {
    let rgb =
        pc::color::tone(c.to_array(), post).map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
    u32::from_le_bytes([
        rgb[0],
        rgb[1],
        rgb[2],
        (alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
    ])
}

/// Dynamic objects keep a first-frame light bake. Transform their normals
/// with the inverse transpose, including nonuniformly scaled parent nodes.
pub(super) fn world_matrices(m: &pc::Meta, anim: &[u8]) -> Vec<Mat4> {
    let mut world = Vec::with_capacity(m.nodes.len());
    for n in &m.nodes {
        let (translation, rotation) = if let Some(track) = &n.track {
            let at = track.offset as usize;
            (
                Vec3::from_array(core::array::from_fn(|i| super::float(anim, at + i * 4))),
                Quat::from_array(core::array::from_fn(|i| {
                    super::float(anim, at + 12 + i * 4)
                }))
                .normalize(),
            )
        } else {
            (Vec3::from(n.translation), Quat::from_array(n.rotation))
        };
        let local =
            Mat4::from_scale_rotation_translation(Vec3::from(n.scale), rotation, translation);
        world.push(n.parent.map_or(local, |i| world[i as usize] * local));
    }
    world
}

pub(super) fn sun_light(
    sun: Option<&pc::Sun>,
    occluder: Option<&crate::occlusion::Occluder>,
    pos: Vec3,
    normal: Vec3,
    static_shadow: bool,
) -> Vec3 {
    let Some(sun) = sun else {
        return Vec3::ZERO;
    };
    let direction = Vec3::from(sun.direction).normalize_or(Vec3::Y);
    let visible = if static_shadow {
        occluder.map_or(1.0, |o| o.ray_visibility(pos, normal, direction, 2000.0))
    } else {
        1.0
    };
    Vec3::from(sun.radiance)
        * (normal.dot(direction).max(0.0) * visible * std::f32::consts::FRAC_1_PI)
}

fn sky_sample(sky: &pc::DaySky, d: Vec3, clouds: Option<&crate::textures::Rgba>) -> Vec3 {
    let base = crate::pica::sky_radiance(sky, d);
    let Some(clouds) = clouds else {
        return base;
    };
    let turn = (d.x.atan2(-d.z) / std::f32::consts::TAU).rem_euclid(1.0);
    let u = (turn * 2.0).fract();
    let elevation = (d.y.clamp(0.0, 1.0).asin() / std::f32::consts::FRAC_PI_2).sqrt();
    let v = ((turn * 2.0).floor() + elevation.clamp(0.5 / 512.0, 1.0 - 0.5 / 512.0)) * 0.5;
    let p = crate::pica::bilinear(clouds, u, v);
    let f = (d.y / sky.fade_elevation.max(1e-5)).clamp(0.0, 1.0);
    let f = f * f * (3.0 - 2.0 * f);
    base * (1.0 - p[0] * f)
        + (Vec3::from(sky.cloud_sun) * p[1] + Vec3::from(sky.cloud_ambient) * p[2]) * f
}

pub(super) fn sky(
    m: &pc::Meta,
    tex: &[u8],
    w: &mut super::Writer,
    textures: &mut Vec<pp::Texture>,
) -> (pp::Span, u32) {
    let Some(sky) = &m.day_sky else {
        return (pp::Span::default(), pp::NONE);
    };
    let clouds = sky
        .clouds
        .map(|i| crate::pica::decode(&m.textures[i as usize], tex));
    // Keep the sky in RGBA4444 like scene textures; mip 0 only because this
    // camera-centered panorama is never minified beyond the display width.
    let (width, height) = (512u32, 256u32);
    let mut pixels = Vec::with_capacity((width * height * 2) as usize);
    for y in 0..height {
        for x in 0..width {
            let az = (x as f32 + 0.5) / width as f32 * std::f32::consts::TAU;
            let el = ((y as f32 + 0.5) / height as f32 - 0.5) * std::f32::consts::PI;
            let d = Vec3::new(az.sin() * el.cos(), el.sin(), -az.cos() * el.cos());
            let c = graded(sky_sample(sky, d, clouds.as_ref()), 1.0, &m.post).to_le_bytes();
            // Ordered dither breaks 4-bit sky bands without animated noise.
            const BAYER: [[u32; 4]; 4] =
                [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
            let threshold = BAYER[y as usize % 4][x as usize % 4];
            let q = |v: u8| ((v as u32 * 15 * 16 / 255 + threshold) / 16).min(15) as u16;
            pixels.extend((q(c[0]) | q(c[1]) << 4 | q(c[2]) << 8 | 0xf000).to_le_bytes());
        }
    }
    let texture = textures.len() as u32;
    textures.push(pp::Texture {
        pixels: w.push(&super::swizzle(
            &pixels,
            width as usize * 2,
            height as usize,
        )),
        width,
        height,
        wrap: 2,
        mips: 1,
    });
    let mut vertices = Vec::new();
    let (columns, rows) = (48, 24);
    let point = |x: i32, y: i32| {
        let u = x as f32 / columns as f32;
        let v = y as f32 / rows as f32;
        let az = u * std::f32::consts::TAU;
        let el = (v - 0.5) * std::f32::consts::PI;
        pp::Vertex {
            uv: [u, v],
            color: 0xffffffff,
            pos: [az.sin() * el.cos(), el.sin(), -az.cos() * el.cos()],
        }
    };
    for y in 0..rows {
        for x in 0..columns {
            vertices.extend([
                point(x, y),
                point(x + 1, y),
                point(x, y + 1),
                point(x + 1, y),
                point(x + 1, y + 1),
                point(x, y + 1),
            ]);
        }
    }
    (w.push(&vertices), texture)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn daylight_is_kind_driven_and_night_keeps_legacy_effects() {
        assert!(!enabled("night-street"));
        assert!(enabled("daytime-slope"));
        assert!(enabled("daytime-street"));
    }
    #[test]
    fn sun_bake_respects_normal_shadow_and_dynamic_object_motion() {
        let sun = pc::Sun {
            direction: [0.0, 1.0, 0.0],
            radiance: [3.0, 2.5, 2.0],
            shadow: None,
        };
        let blocker = crate::occlusion::Occluder::new(
            vec![crate::occlusion::Tri {
                a: Vec3::new(-2.0, 1.0, -2.0),
                e1: Vec3::new(4.0, 0.0, 0.0),
                e2: Vec3::new(0.0, 0.0, 4.0),
                opacity: 1.0,
            }],
            1,
            20.0,
        );
        let pos = Vec3::new(-0.5, 0.0, -0.5);
        assert_eq!(
            sun_light(Some(&sun), Some(&blocker), pos, Vec3::Y, true),
            Vec3::ZERO
        );
        assert!(sun_light(Some(&sun), Some(&blocker), pos, Vec3::Y, false).x > 0.9);
        assert_eq!(
            sun_light(Some(&sun), None, pos, Vec3::NEG_Y, true),
            Vec3::ZERO
        );
        assert!(
            sun_light(
                Some(&sun),
                Some(&blocker),
                Vec3::new(4.0, 0.0, 0.0),
                Vec3::Y,
                true
            )
            .x > 0.9
        );
    }
}
