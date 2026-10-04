//! Material resolution and object traversal before target geometry decisions.
use super::*;

pub(super) struct Hierarchy {
    pub animated: HashSet<usize>,
    pub parent: HashMap<usize, usize>,
    pub door_names: Vec<String>,
}
impl Hierarchy {
    pub fn moving(&self, mut i: usize) -> bool {
        loop {
            if self.animated.contains(&i) { return true; }
            match self.parent.get(&i) { Some(&p) => i=p, None => return false }
        }
    }
}
pub(super) struct Resolved<'a> {
    pub geometry_report: Value,
    pub graph_report: Value,
    pub cook: Cook<'a>,
    pub hierarchy: Hierarchy,
    pub prims: Vec<Prim>,
    pub stock: Vec<Stock>,
    pub field: Vec<(u32, pc::LightPoint)>,
    pub lights: Vec<(usize, Mat4, gltf::khr_lights_punctual::Light<'a>)>,
    pub world_of: HashMap<usize, Mat4>,
    pub scale_of: HashMap<usize, f32>,
}
pub(super) fn run<'a>(a: &'a Args, source: &'a read::Source, plan: &crate::intent::Plan) -> crate::recipe::Output<Resolved<'a>> {
    let read::Source {doc, buffers, images, sx} = source;
    let t0 = Instant::now();
    let scene = doc.default_scene().or_else(|| doc.scenes().next()).expect("scene");
    // ---- which nodes move
    let mut animated: HashSet<usize> = HashSet::new();
    for anim in doc.animations() {
        for ch in anim.channels() {
            animated.insert(ch.target().node().index());
        }
    }
    let door_names: Vec<String> = ["left", "right"].iter().filter_map(|k| sx.get("doors").and_then(|d| d.get(*k)).and_then(|v| v.as_str()).map(String::from)).collect();
    for n in doc.nodes() {
        if n.name().is_some_and(|name| door_names.iter().any(|d| d == name)) {
            animated.insert(n.index());
        }
    }
    let mut parent: HashMap<usize, usize> = HashMap::new();
    for n in doc.nodes() {
        for c in n.children() {
            parent.insert(c.index(), n.index());
        }
    }
    let hierarchy = Hierarchy { animated, parent, door_names };
    let moving = |i| hierarchy.moving(i);


    let mut cook = Cook {
        doc: &doc,
        buffers: &buffers,
        images: &images,
        profile: &a.profile,
        textures: Vec::new(),
        tex_keys: HashMap::new(),
        materials: Vec::new(),
        mat_keys: HashMap::new(),
        material_names: HashMap::new(),
        log: Vec::new(),
        period: {
            let t = &sx["tracks"];
            let p = f(t, "frames", 0.0) / f(t, "fps", 15.0).max(1e-3);
            if p > 0.0 { p } else { 120.0 }
        },
        lod_bias: HashMap::new(),
    };

    // ---- walk the scene
    let mut prims: Vec<Prim> = Vec::new();
    let mut stock: Vec<Stock> = Vec::new();
    // Light fields: (material, light) in the place frame.
    let mut field: Vec<(u32, pc::LightPoint)> = Vec::new();
    let mut lights: Vec<(usize, Mat4, gltf::khr_lights_punctual::Light)> = Vec::new();
    let mut stack: Vec<(gltf::Node, Mat4, f32)> = scene.nodes().map(|n| (n, Mat4::IDENTITY, 1.0)).collect();
    let mut world_of: HashMap<usize, Mat4> = HashMap::new();
    let mut scale_of: HashMap<usize, f32> = HashMap::new();
    while let Some((node, pw, parent_scale)) = stack.pop() {
        let Some(&selection) = plan.nodes.get(&node.index()) else { continue; };
        let local = node_matrix(&node);
        let w = pw * local;
        // Compose per-node magnification bounds: animation may rotate a
        // child under non-uniform parent scale after this initial pose.
        let metric_scale = parent_scale * geometry::error_scale(local);
        world_of.insert(node.index(), w);
        scale_of.insert(node.index(), metric_scale);
        let is_moving = moving(node.index());
        if let Some(l) = node.light() {
            lights.push((node.index(), w, l));
        }
        if let Some(mesh) = node.mesh() {
            let inst = node.extensions().and_then(|e| e.get("EXT_mesh_gpu_instancing")).and_then(|e| e.get("attributes")).cloned();
            let skin = node.skin().map(|s| s.index());
            for prim in mesh.primitives() {
                if prim.mode() == gltf::mesh::Mode::Points {
                    read_light_field(&mut cook, &prim, w, is_moving, &mut field);
                    continue;
                }
                if let Some(attrs) = &inst {
                    // Resolve instances after target selection. A moving parent
                    // keeps the instance-local geometry attached to its track.
                    assert!(skin.is_none(), "GPU instancing with skins is unsupported");
                    let get = |k: &str| attrs.get(k).and_then(|v| v.as_u64()).map(|i| accessor_f32(&doc, &buffers, i as usize));
                    let t = get("TRANSLATION");
                    let r = get("ROTATION");
                    let s = get("SCALE");
                    let c = get("_COLOR_0");
                    let count = t.as_ref().map(|v| v.len() / 3).or(r.as_ref().map(|v| v.len() / 4)).or(s.as_ref().map(|v|v.len()/3)).unwrap_or(0);
                    let cstride = c.as_ref().map(|c| if c.len() == count * 4 { 4 } else { 3 }).unwrap_or(3);
                    // Shelf stock: thousands of lathe/cylinder items that
                    // cover a few pixels each on a handheld screen. Every
                    // instance uses one low-poly stand-in of the shape.
                    let proxy = read_primitive(&mut cook, &prim, Mat4::IDENTITY, true, None).and_then(|(v, _, m)| {
                        (!is_moving && !selection.protected() && cook.materials[m as usize].kind == pc::Kind::Products).then(|| {
                            cook.materials[m as usize].vertex_color = true;
                            (geometry::product_proxy(&v), geometry::product_card(&v), m)
                        })
                    });
                    for k in 0..count {
                        let tr = t.as_ref().map(|v| Vec3::new(v[k * 3], v[k * 3 + 1], v[k * 3 + 2])).unwrap_or(Vec3::ZERO);
                        let ro = r.as_ref().map(|v| Quat::from_xyzw(v[k * 4], v[k * 4 + 1], v[k * 4 + 2], v[k * 4 + 3])).unwrap_or(Quat::IDENTITY);
                        let sc = s.as_ref().map(|v| Vec3::new(v[k * 3], v[k * 3 + 1], v[k * 3 + 2])).unwrap_or(Vec3::ONE);
                        let ic = c.as_ref().map(|v| {
                            let b = k * cstride;
                            [v[b], v[b + 1], v[b + 2], if cstride == 4 { v[b + 3] } else { 1.0 }]
                        });
                        let instance = Mat4::from_scale_rotation_translation(sc, ro, tr);
                        let xf = w * instance;
                        if let Some(((pv, pt), (cv, ct), material)) = &proxy {
                            let nmat = Mat3::from_mat4(xf).inverse().transpose();
                            let c = ic.unwrap_or([1.0; 4]);
                            let place = |src: &Vec<Vertex>| -> Vec<Vertex> {
                                src.iter()
                                    .map(|v| Vertex {
                                        pos: xf.transform_point3(v.pos),
                                        normal: (nmat * v.normal).normalize_or_zero(),
                                        color: [srgb8(c[0]), srgb8(c[1]), srgb8(c[2]), v.color[3]],
                                        ..*v
                                    })
                                    .collect()
                            };
                            stock.push(Stock { material: *material, center: xf.transform_point3(Vec3::ZERO), full: (place(pv), pt.clone()), card: (place(cv), ct.clone()) });
                            continue;
                        }
                        if let Some((verts, tris, material)) = read_primitive(&mut cook, &prim, if is_moving {instance} else {xf}, true, ic) {
                            prims.push(Prim { mesh_node: node.index(), world: w, verts, tris, material, moving: is_moving, skin: None, no_reflect: true, baked: false, selection, base_error: selection.representation_error });
                        }
                    }
                    continue;
                }
                let bake = !is_moving && skin.is_none();
                if let Some((verts, tris, material)) = read_primitive(&mut cook, &prim, w, bake, None) {
                    prims.push(Prim { mesh_node: node.index(), world: w, verts, tris, material, moving: !bake, skin, no_reflect: false, baked: false, selection, base_error: selection.representation_error });
                }
            }
        }
        for c in node.children() {
            stack.push((c, w, metric_scale));
        }
    }
    crate::progress!("walked scene: {} primitives, {} materials, {} textures ({} ms)", prims.len(), cook.materials.len(), cook.textures.len(), t0.elapsed().as_millis());

    let decision = json!({"primitives":prims.len(),"materials":cook.materials.len(),"textures":cook.textures.len()});
    crate::recipe::Output::new(Resolved {geometry_report: Value::Null, graph_report: plan.report.clone(), cook, hierarchy, prims, stock, field, lights, world_of, scale_of}, decision)
}
