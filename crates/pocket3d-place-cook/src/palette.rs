//! Solid PBR material batching without a texture atlas. UVs carry the two
//! PBR scalars and sRGB vertex colour carries the linear material tint.

use super::Prim;
use glam::{Mat3, Mat4, Vec2};
use pocket_atlas_model as pc;
use std::collections::{BTreeMap, HashMap, HashSet};

fn eligible(m: &pc::Material) -> bool {
    m.kind == pc::Kind::Standard && m.blend == pc::Blend::Opaque && m.depth_write
        && !m.vertex_pbr && m.alpha_test == 0.0 && !m.interior
        && m.albedo.is_none() && m.normal.is_none() && m.orm.is_none() && m.emission.is_none()
        && m.wet.is_none() && m.damp.is_none() && m.drops == 0.0 && m.clearcoat == 0.0
        && m.emissive.iter().all(|&v| v == 0.0) && m.emissive_track.is_none()
        && m.uv_anim.is_none() && m.water.is_none()
        && m.color.iter().chain([&m.roughness, &m.metalness]).all(|&v| (0.0..=1.0).contains(&v))
}

fn canonical(m: &pc::Material, moving: bool) -> pc::Material {
    let mut out = m.clone();
    out.name = "solid-pbr-palette".into();
    out.color = [1.0; 4];
    // VERTEX_PBR reads actual surface values from UVs, including FAR/LITE.
    // These canonical factors only select shader features. Match native
    // material(): SUN_SPEC iff roughness < .6 or metalness > .3. Keeping
    // rough non-metal static surfaces separate lets their draw omit GGX.
    // Moving assemblies keep one palette to avoid duplicating their draws;
    // the shader's per-surface UV branch handles their mixed reflectance.
    let sun_spec = moving || m.roughness < 0.6 || m.metalness > 0.3;
    out.roughness = 1.0;
    out.metalness = if sun_spec { 1.0 } else { 0.0 };
    out.vertex_color = true;
    out.vertex_pbr = true;
    out
}

fn paint(v: &mut super::Vertex, m: &pc::Material) {
    for k in 0..3 {
        let vertex = if m.vertex_color { pc::color::decode(v.color[k] as f32 / 255.0) } else { 1.0 };
        v.color[k] = pc::color::encode8(vertex * m.color[k]);
    }
    let alpha = if m.vertex_color { v.color[3] as f32 / 255.0 } else { 1.0 };
    v.color[3] = (alpha * m.color[3] * 255.0).round() as u8;
    v.uv = Vec2::new(m.roughness, m.metalness);
    v.tangent = [1.0, 0.0, 0.0, 1.0];
}

/// Immediate fixed siblings share their parent frame; a node with its own
/// animation remains an anchor itself. This merges car body materials while
/// preserving car-sized culling and every wheel/gate's independent motion.
fn anchor(mesh: usize, parent: &HashMap<usize, usize>, animated: &HashSet<usize>) -> usize {
    if animated.contains(&mesh) { mesh } else { parent.get(&mesh).copied().unwrap_or(mesh) }
}

pub fn batch(
    prims: &mut Vec<Prim>, materials: &mut Vec<pc::Material>, parent: &HashMap<usize, usize>,
    animated: &HashSet<usize>, world: &HashMap<usize, Mat4>, material_animation: &HashSet<String>,
) {
    let mut palettes: HashMap<Vec<u8>, u32> = HashMap::new();
    let mut batches: BTreeMap<(usize, u32, bool, (u8,u32,u32,u32)), Prim> = BTreeMap::new();
    let mut out = Vec::new();
    for mut p in std::mem::take(prims) {
        let m = materials[p.material as usize].clone();
        if p.selection.protected() || p.skin.is_some() || !eligible(&m) || material_animation.contains(&m.name) {
            out.push(p);
            continue;
        }
        let frame = anchor(p.mesh_node, parent, animated);
        let frame_world = if p.moving { world[&frame] } else { Mat4::IDENTITY };
        // Singular transforms cannot be rebased safely. Leave their original
        // material and draw intact instead of guessing an inverse.
        if p.moving && (frame_world.determinant().abs() < 1e-8 || p.world.determinant().abs() < 1e-8) {
            out.push(p);
            continue;
        }
        let palette = canonical(&m, p.moving);
        // Serialize every retained feature, so sidedness, fog, env strength,
        // polygon offset and any future fields remain exact batch boundaries.
        let key = serde_json::to_vec(&palette).unwrap();
        p.material = *palettes.entry(key).or_insert_with(|| {
            materials.push(palette);
            (materials.len() - 1) as u32
        });
        for v in &mut p.verts { paint(v, &m); }
        if !p.moving {
            // World-space static primitives join the existing spatial
            // buckets later; never merge across those visibility cells here.
            out.push(p);
            continue;
        }
        let local = frame_world.inverse() * p.world;
        let normal = Mat3::from_mat4(local).inverse().transpose();
        for v in &mut p.verts {
            v.pos = local.transform_point3(v.pos);
            v.normal = (normal * v.normal).normalize_or_zero();
        }
        p.mesh_node = frame;
        p.world = frame_world;
        let key = (frame, p.material, p.no_reflect, p.selection.batch_key());
        if let Some(batch) = batches.get_mut(&key) {
            let base = batch.verts.len() as u32;
            batch.verts.extend(p.verts);
            batch.tris.extend(p.tris.into_iter().map(|tri| tri.map(|i| i + base)));
        } else {
            batches.insert(key, p);
        }
    }
    out.extend(batches.into_values());
    *prims = out;
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;
    use crate::geometry::Vertex;

    fn material() -> pc::Material {
        pc::Material {
            name: "paint".into(), kind: pc::Kind::Standard, blend: pc::Blend::Opaque,
            double_sided: false, depth_write: true, alpha_test: 0.0, color: [1.0; 4],
            emissive: [0.0; 3], roughness: 0.3, metalness: 0.8, normal_scale: 1.0,
            ao_strength: 0.0, env_strength: 0.9, albedo: None, normal: None, orm: None,
            emission: None, vertex_color: false, vertex_pbr: false, interior: false,
            fog: true, wet: None, damp: None, drops: 0.0, clearcoat: 0.0,
            polygon_offset: None, emissive_track: None, uv_anim: None, water: None, lights: None, tint: None,
        }
    }

    fn triangle(node: usize, world: Mat4, mat: u32) -> Prim {
        Prim {
            mesh_node: node, world,
            verts: [Vec3::ZERO, Vec3::X, Vec3::Y].into_iter().map(|pos| Vertex {
                pos, normal: Vec3::new(1.0, 0.0, 1.0).normalize(), color: [128, 64, 200, 255],
                uv: Vec2::new(7.0, 8.0), ..Vertex::default()
            }).collect(),
            tris: vec![[0, 1, 2]], material: mat, moving: true, skin: None,
            no_reflect: false, baked: false, selection: Default::default(), base_error: 0.0,
        }
    }

    #[test]
    fn solid_palette_keeps_linear_tints_and_distinct_pbr_values() {
        let mut red = material();
        red.color = [0.25, 0.5, 0.75, 1.0];
        red.vertex_color = true;
        let mut blue = material();
        blue.color = [0.8, 0.2, 0.1, 1.0];
        blue.roughness = 0.9;
        blue.metalness = 0.0;
        let original = [red.clone(), blue.clone()];
        let mut mats = original.to_vec();
        let mut prims = vec![triangle(1, Mat4::IDENTITY, 0), triangle(2, Mat4::IDENTITY, 1)];
        batch(&mut prims, &mut mats, &HashMap::from([(1, 0), (2, 0)]), &HashSet::from([0]), &HashMap::from([(0, Mat4::IDENTITY)]), &HashSet::new());
        assert_eq!(prims.len(), 1);
        let p = &prims[0];
        assert_eq!(p.tris.len(), 2);
        let m = &mats[p.material as usize];
        assert!(m.vertex_pbr && m.vertex_color);
        assert_eq!(m.color, [1.0; 4]);
        assert_eq!((m.roughness, m.metalness), (1.0, 1.0));
        for (i, src) in original.iter().enumerate() {
            let v = &p.verts[i * 3];
            assert_eq!(v.uv, Vec2::new(src.roughness, src.metalness));
            for (k, old) in [128u8, 64, 200].into_iter().enumerate() {
                let c = if src.vertex_color { pc::color::decode(old as f32 / 255.0) } else { 1.0 };
                assert_eq!(v.color[k], pc::color::encode8(c * src.color[k]));
            }
        }
    }

    #[test]
    fn retained_render_features_are_exact_palette_boundaries() {
        let base = material();
        let mut two_sided = base.clone(); two_sided.double_sided = true;
        let mut dim_env = base.clone(); dim_env.env_strength = 0.5;
        let mut mats = vec![base, two_sided, dim_env];
        let mut prims: Vec<Prim> = (1..=3).map(|i| triangle(i, Mat4::IDENTITY, i as u32 - 1)).collect();
        batch(&mut prims, &mut mats, &HashMap::from([(1, 0), (2, 0), (3, 0)]), &HashSet::from([0]), &HashMap::from([(0, Mat4::IDENTITY)]), &HashSet::new());
        assert_eq!(prims.len(), 3);
        let ids: HashSet<_> = prims.iter().map(|p| p.material).collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(prims.iter().filter(|p| mats[p.material as usize].double_sided).count(), 1);
    }

    #[test]
    fn static_sun_spec_split_keeps_boundary_values_and_vertex_attributes() {
        let below_rough = f32::from_bits(0.6f32.to_bits() - 1);
        let above_metal = f32::from_bits(0.3f32.to_bits() + 1);
        let cases = [
            (0.6, 0.3, false), (below_rough, 0.3, true),
            (0.6, above_metal, true), (1.0, 0.3, false),
            (0.6, 0.0, false), (0.0, 0.0, true),
        ];
        let original: Vec<_> = cases.iter().enumerate().map(|(i, &(rough, metal, _))| {
            let mut m = material();
            m.roughness = rough;
            m.metalness = metal;
            m.color = [0.25 + i as f32 * 0.05, 0.4, 0.7, 1.0];
            m.vertex_color = i % 2 == 0;
            m
        }).collect();
        let mut mats = original.clone();
        let mut prims: Vec<_> = (0..cases.len()).map(|i| {
            let mut p = triangle(i + 1, Mat4::IDENTITY, i as u32);
            p.moving = false;
            for v in &mut p.verts { v.pos.x += i as f32 * 2.0; }
            p
        }).collect();
        let parent = (1..=cases.len()).map(|i| (i, 0)).collect();
        batch(&mut prims, &mut mats, &parent, &HashSet::from([0]), &HashMap::from([(0, Mat4::IDENTITY)]), &HashSet::new());
        // Static primitives remain separate until the existing spatial
        // chunker, but share exactly two shader-compatible material IDs.
        assert_eq!(prims.len(), cases.len());
        assert_eq!(prims.iter().map(|p| p.material).collect::<HashSet<_>>().len(), 2);
        assert_eq!(prims.iter().map(|p| p.tris.len()).sum::<usize>(), cases.len());
        let mut seen = HashSet::new();
        for p in &prims {
            let m = &mats[p.material as usize];
            // Same feature selection used by vita/src/frame.rs material().
            let selected_spec = m.roughness < 0.6 || m.metalness > 0.3;
            for triangle in p.verts.chunks_exact(3) {
                let i = (triangle[0].pos.x / 2.0) as usize;
                let source = &original[i];
                seen.insert(i);
                assert_eq!(selected_spec, cases[i].2);
                for (v, expected_pos) in triangle.iter().zip([Vec3::ZERO, Vec3::X, Vec3::Y]) {
                    assert_eq!(v.pos, expected_pos + Vec3::X * i as f32 * 2.0);
                    assert_eq!(v.uv, Vec2::new(source.roughness, source.metalness));
                    for (k, encoded) in [128u8, 64, 200].into_iter().enumerate() {
                        let linear = if source.vertex_color { pc::color::decode(encoded as f32 / 255.0) } else { 1.0 };
                        assert_eq!(v.color[k], pc::color::encode8(linear * source.color[k]));
                    }
                    assert_eq!(v.color[3], 255);
                }
            }
        }
        assert_eq!(seen.len(), cases.len());
    }

    #[test]
    fn textured_animated_uv_and_skinned_surfaces_are_not_reinterpreted() {
        let mut textured = material(); textured.albedo = Some(0);
        let mut normal = material(); normal.normal = Some(0);
        let mut animated = material();
        animated.uv_anim = Some(pc::UvAnim { scroll: [1.0, 0.0], ..pc::UvAnim::default() });
        let mut wet = material(); wet.wet = Some(pc::Wet::default());
        let mut emissive = material(); emissive.emissive[0] = 1.0;
        let mut mats = vec![textured, normal, animated, wet, emissive, material()];
        let mut prims: Vec<Prim> = (0..6).map(|i| triangle(i, Mat4::IDENTITY, i as u32)).collect();
        prims[5].skin = Some(0);
        batch(&mut prims, &mut mats, &HashMap::new(), &HashSet::new(), &HashMap::new(), &HashSet::new());
        assert_eq!(mats.len(), 6);
        for (i, p) in prims.iter().enumerate() {
            assert_eq!(p.material, i as u32);
            assert_eq!(p.verts[0].uv, Vec2::new(7.0, 8.0));
            assert_eq!(p.verts[0].color, [128, 64, 200, 255]);
        }
    }

    #[test]
    fn fixed_siblings_rebase_positions_and_inverse_transpose_normals() {
        let root = Mat4::from_translation(Vec3::new(20.0, 0.0, 0.0));
        let local_a = Mat4::from_translation(Vec3::X * 3.0) * Mat4::from_rotation_y(0.4);
        let local_b = Mat4::from_translation(Vec3::Z * 2.0) * Mat4::from_scale(Vec3::new(2.0, 1.0, 0.5));
        let original = [triangle(1, root * local_a, 0), triangle(2, root * local_b, 0)];
        let expected: Vec<_> = original.iter().flat_map(|p| p.verts.iter().map(|v| (p.world.transform_point3(v.pos), (Mat3::from_mat4(p.world).inverse().transpose() * v.normal).normalize()))).collect();
        let mut prims = original.into_iter().collect();
        let mut mats = vec![material()];
        batch(&mut prims, &mut mats, &HashMap::from([(1, 0), (2, 0)]), &HashSet::from([0]), &HashMap::from([(0, root)]), &HashSet::new());
        assert_eq!(prims.len(), 1);
        assert_eq!(prims[0].mesh_node, 0);
        for (v, (position, normal)) in prims[0].verts.iter().zip(expected) {
            assert!(root.transform_point3(v.pos).distance(position) < 1e-5);
            assert!((Mat3::from_mat4(root) * v.normal).normalize().distance(normal) < 1e-5);
        }
    }

    #[test]
    fn animated_siblings_keep_their_own_transform_tracks() {
        let worlds = HashMap::from([(0, Mat4::IDENTITY), (1, Mat4::from_translation(Vec3::X)), (2, Mat4::from_translation(Vec3::Y))]);
        let mut prims = vec![triangle(1, worlds[&1], 0), triangle(2, worlds[&2], 0)];
        let mut mats = vec![material()];
        batch(&mut prims, &mut mats, &HashMap::from([(1, 0), (2, 0)]), &HashSet::from([1, 2]), &worlds, &HashSet::new());
        assert_eq!(prims.len(), 2);
        assert_eq!(prims.iter().map(|p| p.mesh_node).collect::<Vec<_>>(), [1, 2]);
        for p in prims { assert_eq!(p.verts[0].pos, Vec3::ZERO); }
    }
}
