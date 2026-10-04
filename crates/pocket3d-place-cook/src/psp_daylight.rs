//! Fixed-function daylight: a compiler-authored sky dome, graded vertex
//! lighting, and static world-space sunlight. The shared panorama and moving
//! cloud overlay are emitted separately by the PSP backend.
use glam::{Mat4, Quat, Vec3};
use pocket_atlas_model as pc;
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
pub(super) fn world_matrices(m: &crate::source::Scene) -> Vec<Mat4> {
    let mut world = Vec::with_capacity(m.nodes.len());
    for n in &m.nodes {
        let (translation, rotation) = if let Some(track) = n.track.as_ref().and_then(|t| t.first()) {
            (
                Vec3::from_array(core::array::from_fn(|i| track[i])),
                Quat::from_array(core::array::from_fn(|i| {
                    track[3 + i]
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

pub(super) fn sky_vertices(w: &mut super::Writer) -> pp::Span {
    let mut vertices = Vec::new();
    // The display resolves the panorama, not dome tessellation. Match the
    // native fixed-function sky budget and retain continuous UV seams.
    let (columns, rows) = (32, 16);
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
    w.push(&vertices)
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
