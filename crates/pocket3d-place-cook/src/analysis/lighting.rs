//! Light/environment resources and skyline geometry.
use super::*;

pub(super) struct Lighting {
    pub out_lights: Vec<pc::Light>,
    pub env_meta: Value,
    pub environment: Option<u32>,
}
pub(super) fn run(a: &Args, source: &read::Source, resolved: &mut resolve::Resolved<'_>, motion: &motion::Motion) -> crate::recipe::Output<Lighting> {
    let read::Source {doc, sx, ..} = source;
    let resolve::Resolved {cook, prims, lights, hierarchy, ..} = resolved;
    let node_ids = &motion.node_ids;
    let moving = |i| hierarchy.moving(i);
    // ---- skyline boxes become static geometry
    if let Some(boxes) = sx.get("skyline").and_then(|s| s.get("boxes")).and_then(|b| b.as_array()) {
        let mat = pc::Material {
            name: "skyline".into(),
            kind: pc::Kind::Skyline,
            blend: pc::Blend::Opaque,
            double_sided: false,
            depth_write: true,
            alpha_test: 0.0,
            color: [1.0; 4],
            emissive: [0.0; 3],
            roughness: 1.0,
            metalness: 0.0,
            normal_scale: 1.0,
            ao_strength: 0.0,
            env_strength: 0.0,
            albedo: None,
            normal: None,
            orm: None,
            emission: None,
            vertex_color: true,
            vertex_pbr: false,
            interior: false,
            fog: true,
            wet: None,
            damp: None,
            drops: 0.0,
            clearcoat: 0.0,
            polygon_offset: None,
            emissive_track: None,
            uv_anim: None,
            water: None,
            lights: None,
            tint: None,
        };
        cook.materials.push(mat);
        let mi = (cook.materials.len() - 1) as u32;
        let faces: [(Vec3, Vec3, Vec3); 5] = [
            (Vec3::X, Vec3::Z, Vec3::Y),
            (-Vec3::X, -Vec3::Z, Vec3::Y),
            (Vec3::Z, -Vec3::X, Vec3::Y),
            (-Vec3::Z, Vec3::X, Vec3::Y),
            (Vec3::Y, Vec3::X, -Vec3::Z),
        ];
        let mut verts = Vec::new();
        let mut tris = Vec::new();
        for b in boxes {
            let v: Vec<f32> = b.as_array().unwrap().iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
            let m = Mat4::from_cols_array(&v[0..16].try_into().unwrap());
            let info = [v[16], v[17], v[18], v[19]];
            for (n, u, up) in faces {
                let c = n * 0.5 + Vec3::new(0.0, 0.5, 0.0);
                let base = verts.len() as u32;
                for (su, sv) in [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)] {
                    let p = c + u * su + up * sv;
                    let wp = m.transform_point3(p);
                    let wn = (Mat3::from_mat4(m).inverse().transpose() * n).normalize();
                    // Facade axis in world space: the shader measures windows along it.
                    let wu = m.transform_vector3(u).normalize();
                    verts.push(Vertex {
                        pos: wp,
                        normal: wn,
                        tangent: [wu.x, wu.y, wu.z, 1.0],
                        uv: Vec2::ZERO,
                        color: info.map(|x| (x.clamp(0.0, 1.0) * 255.0) as u8),
                        joints: [0; 4],
                        weights: [255, 0, 0, 0],
                        light: [0; 4],
                    });
                }
                tris.push([base, base + 1, base + 2]);
                tris.push([base, base + 2, base + 3]);
            }
        }
        prims.push(Prim { sources: ["generated/skyline".into()].into(), mesh_node: usize::MAX, world: Mat4::IDENTITY, verts, tris, material: mi, moving: false, skin: None, no_reflect: false, baked: false, selection: Default::default(), base_error: 0.0 });
    }

    // ---- lights
    let mut out_lights: Vec<pc::Light> = Vec::new();
    for (ni, w, l) in lights {
        let (kind, cos_outer, cos_inner) = match l.kind() {
            LightType::Point => (pc::LightKind::Point, -1.0, -1.0),
            LightType::Spot { inner_cone_angle, outer_cone_angle } => (pc::LightKind::Spot, outer_cone_angle.cos(), inner_cone_angle.cos()),
            LightType::Directional => continue,
        };
        let c = l.color();
        let i = l.intensity();
        let mv = moving(*ni);
        let (pos, dir) = if mv {
            (Vec3::ZERO, Vec3::NEG_Z)
        } else {
            (w.transform_point3(Vec3::ZERO), w.transform_vector3(Vec3::NEG_Z).normalize())
        };
        let x = pc_of(doc.nodes().nth(*ni).unwrap().extras());
        out_lights.push(pc::Light {
            kind,
            position: pos.to_array(),
            direction: dir.to_array(),
            color: [c[0] * i, c[1] * i, c[2] * i],
            range: l.range().unwrap_or(0.0),
            cos_outer,
            cos_inner,
            size: [0.0, 0.0],
            right: [0.0; 3],
            node: if mv { node_ids.get(ni).copied() } else { None },
            cast_shadow: x.get("castShadow").and_then(|v| v.as_bool()).unwrap_or(false),
        });
    }
    if let Some(rects) = sx.get("rectLights").and_then(|r| r.as_array()) {
        for r in rects {
            let c = v3(&r["color"]);
            let i = f(r, "intensity", 1.0);
            out_lights.push(pc::Light {
                kind: pc::LightKind::Rect,
                position: v3(&r["position"]),
                direction: v3(&r["normal"]),
                color: [c[0] * i, c[1] * i, c[2] * i],
                range: 0.0,
                cos_outer: 0.0,
                cos_inner: 1.0,
                size: [f(r, "width", 1.0), f(r, "height", 1.0)],
                right: v3(&r["right"]),
                node: None,
                cast_shadow: false,
            });
        }
    }

    // ---- environment
    let env_meta = sx.get("environment").cloned().unwrap_or(Value::Null);
    let environment = if env_meta.is_object() {
        let size = env_meta["size"].as_u64().unwrap_or(256) as u32;
        let raw = std::fs::read(a.input.join("env.rgba16f")).ok();
        raw.map(|raw| {
            let tex = env::octahedral(&raw, size, 128, 6);
            cook.textures.push(pc::Texture {
                name: "environment".into(),
                usage: None,
                role: pc::TexRole::Environment,
                width: tex.size,
                height: tex.size,
                pixels: pc::Pixels::Environment { rgba16f: tex.data, levels: tex.mips },
                wrap_s: pc::Wrap::Clamp,
                wrap_t: pc::Wrap::Clamp,
                has_alpha: false,
                mean: [0.0; 4],
                lod_bias: 0.0,
            });
            (cook.textures.len() - 1) as u32
        })
    } else {
        None
    };

    let decision = json!({"lights":out_lights.len(),"environment":environment});
    crate::recipe::Output::new(Lighting {out_lights, env_meta, environment}, decision)
}

