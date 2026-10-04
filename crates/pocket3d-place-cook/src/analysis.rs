//! Atlas scene analysis. Values remain typed until a device lowering runs.
use crate::{source as pc, extras, textures, env, bake, geometry, occlusion, procedural, ir, Args};
#[path = "palette.rs"]
mod palette;
use geometry::Vertex;
use glam::{Mat3, Mat4, Quat, Vec2, Vec3};
use gltf::khr_lights_punctual::Kind as LightType;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

fn extras(raw: &gltf::json::Extras) -> Value {
    raw.as_ref().and_then(|r| serde_json::from_str::<Value>(r.get()).ok()).unwrap_or(Value::Null)
}

fn pc_of(raw: &gltf::json::Extras) -> Value {
    extras(raw).get("pocketAtlas").cloned().unwrap_or(Value::Null)
}

use extras::{f, v3};
use pc::color::encode8 as srgb8;

/// Static geometry uses distance-scaled grid cells, or one whole-primitive
/// chunk for open water. Long street-scale faces have a separate bucket
/// so they do not expand the local cells' bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Cell {
    Grid(u32, i32, i32),
    Whole,
    /// Long faces must not pull a normal cell's AABB across the scene.
    Oversized,
}

fn triangle_cell(p: [Vec3; 3], cell: f32) -> Cell {
    let lo = p[0].min(p[1]).min(p[2]);
    let hi = p[0].max(p[1]).max(p[2]);
    let center = (p[0] + p[1] + p[2]) / 3.0;
    // Rails and wires must not pull ordinary street chunks across the scene,
    // including the 256 m band beyond 140 m: a long face centred just past
    // that boundary can still reach the camera. Beyond the 1 km street LOD
    // region, terrain retains the vista's growing cells and coarser bounds.
    if center.x.abs().max(center.z.abs()) < 1024.0 && (hi.x - lo.x).max(hi.z - lo.z) > cell {
        Cell::Oversized
    } else {
        cell_at(center, cell, 0.0)
    }
}

/// Quantized skinning must remain a convex combination: both camera and
/// shadow bounds use the union of the joint-transformed bind boxes.
fn quantize_weights(w: [f32; 4]) -> [u8; 4] {
    assert!(w.iter().all(|v| v.is_finite() && *v >= 0.0), "invalid skin weights");
    let sum: f32 = w.iter().sum();
    if sum == 0.0 { return [255, 0, 0, 0]; }
    let mut q = w.map(|x| (x / sum * 255.0).round() as i32);
    let largest = (0..4).max_by_key(|&i| q[i]).unwrap();
    q[largest] += 255 - q.iter().sum::<i32>();
    q.map(|x| x as u8)
}

/// Position seams shared by triangles in different buckets, including an
/// oversized face beside a local one. Attribute seams do not break the lock.
fn chunk_boundaries(verts: &[Vertex], tris: &[[u32; 3]], cells: &[Cell]) -> HashSet<[u32; 3]> {
    let mut edge_cell: HashMap<([u32; 3], [u32; 3]), Cell> = HashMap::new();
    let mut cut = HashSet::new();
    for (t, &cell) in tris.iter().zip(cells) {
        for k in 0..3 {
            let (a, b) = (geometry::pos_bits(verts[t[k] as usize].pos), geometry::pos_bits(verts[t[(k + 1) % 3] as usize].pos));
            let edge = if a <= b { (a, b) } else { (b, a) };
            let first = *edge_cell.entry(edge).or_insert(cell);
            if first != cell {
                cut.insert(edge.0);
                cut.insert(edge.1);
            }
        }
    }
    cut
}

/// Cell edge for a point `r` metres (the larger of |x| and |z|) from the
/// origin: `near` within 140 m, 256 m to 1 km, then the power of two at or
/// below r (1 km cells from 1 to 2 km, 2 km cells from 2 to 4 km, … up to
/// 64 km), so a chunk covers a similar angle from the shots near the origin
/// and a vista to the horizon stays a few draws per material per octave of
/// distance.
fn cell_size(r: f32, near: f32) -> f32 {
    if r <= 140.0 {
        near
    } else if r <= 1024.0 {
        256.0
    } else {
        r.log2().floor().exp2().min(65536.0)
    }
}

/// The cell of a point; edges no smaller than `min`.
fn cell_at(p: Vec3, near: f32, min: f32) -> Cell {
    let size = cell_size(p.x.abs().max(p.z.abs()), near).max(min);
    Cell::Grid(size as u32, (p.x / size).floor() as i32, (p.z / size).floor() as i32)
}


/// A cell's nearest distance from the origin (the larger of |x| and |z|).
fn cell_distance(cell: Cell) -> f32 {
    match cell {
        Cell::Grid(size, ix, iz) => {
            let near = |i: i32| {
                let (lo, hi) = (i as f32 * size as f32, (i + 1) as f32 * size as f32);
                if lo <= 0.0 && hi >= 0.0 { 0.0 } else { lo.abs().min(hi.abs()) }
            };
            near(ix).max(near(iz))
        }
        Cell::Whole | Cell::Oversized => 0.0,
    }
}

/// LOD errors (m) for a chunk: 6 and 25 cm within 1 km of the origin;
/// beyond, three levels that grow with the chunk's distance r: 3·10⁻⁴ r
/// (a pixel of the 5° telephoto shots at 480×272), then ×4 and ×16 (a
/// pixel of a 40° view at ×16), so far terrain thins out as it recedes
/// and the renderer's projected-error choice still holds a telephoto.
fn lod_bounds(cell: Cell) -> Vec<f32> {
    let r = cell_distance(cell);
    if r < 1024.0 { vec![0.06, 0.25] } else { vec![3e-4 * r, 1.2e-3 * r, 4.8e-3 * r] }
}


// ------------------------------------------------------------------ builder

struct Cook<'a> {
    doc: &'a gltf::Document,
    buffers: &'a [gltf::buffer::Data],
    images: &'a [gltf::image::Data],
    profile: &'a crate::profile::Profile,
    textures: Vec<pc::Texture>,
    tex_keys: HashMap<(usize, u8, bool, (u32, u32), Option<pc::TextureUsage>), u32>,
    materials: Vec<pc::Material>,
    mat_keys: HashMap<usize, u32>,
    material_names: HashMap<String, u32>,
    log: Vec<String>,
    /// The place's loop (s): what light fields repeat over unless their
    /// material names its own.
    period: f32,
    /// Materials annotated `lodBias` (pack index → bias, None = "auto").
    lod_bias: HashMap<u32, Option<f32>>,
}

impl<'a> Cook<'a> {
    /// `cells`: a flipbook's (columns, rows), (1, 1) otherwise.
    fn texture(&mut self, tex: gltf::Texture, role: pc::TexRole, alpha_wanted: bool, usage: Option<pc::TextureUsage>, cells: (u32, u32)) -> u32 {
        let image = tex.source().index();
        // A flipbook keeps a shorter mip chain than the same image elsewhere.
        let key = (image, role as u8, alpha_wanted, cells, usage);
        if let Some(&i) = self.tex_keys.get(&key) {
            return i;
        }
        let img = &self.images[image];
        let rgba: Vec<u8> = match img.format {
            gltf::image::Format::R8G8B8A8 => img.pixels.clone(),
            gltf::image::Format::R8G8B8 => img.pixels.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
            gltf::image::Format::R8 => img.pixels.iter().flat_map(|&p| [p, p, p, 255]).collect(),
            gltf::image::Format::R8G8 => img.pixels.chunks_exact(2).flat_map(|p| [p[0], p[1], 0, 255]).collect(),
            other => panic!("unsupported image format {other:?}"),
        };
        let has_alpha = alpha_wanted && rgba.chunks_exact(4).any(|p| p[3] < 250);
        let mut mean = [0.0f64; 4];
        for p in rgba.chunks_exact(4) {
            for (m, &c) in mean.iter_mut().zip(p) {
                *m += c as f64;
            }
        }
        let texels = (rgba.len() / 4).max(1) as f64;
        let mean = mean.map(|m| (m / texels / 255.0) as f32);
        let wrap = |m: gltf::texture::WrappingMode| match m {
            gltf::texture::WrappingMode::Repeat => pc::Wrap::Repeat,
            gltf::texture::WrappingMode::ClampToEdge => pc::Wrap::Clamp,
            gltf::texture::WrappingMode::MirroredRepeat => pc::Wrap::Mirror,
        };
        let sampler = tex.sampler();
        let name = img_name(self.doc, image);
        self.log.push(format!("source texture {name} {:?} {}x{}", role, img.width, img.height));
        self.textures.push(pc::Texture {
            name,
            usage,
            role,
            width: img.width,
            height: img.height,
            pixels: pc::Pixels::Image { rgba, cells },
            wrap_s: wrap(sampler.wrap_s()),
            wrap_t: wrap(sampler.wrap_t()),
            has_alpha,
            mean,
            lod_bias: 0.0,
        });
        let i = (self.textures.len() - 1) as u32;
        self.tex_keys.insert(key, i);
        i
    }

    /// Converts a glTF material; returns (pack index, uv transform to bake).
    fn material(&mut self, m: gltf::Material) -> (u32, Option<([f32; 2], [f32; 2])>) {
        let key = m.index().unwrap_or(usize::MAX);
        let transform = uv_transform(&m);
        if let Some(&i) = self.mat_keys.get(&key) {
            return (i, transform);
        }
        let x = pc_of(m.extras());
        let pbr = m.pbr_metallic_roughness();
        let kind = match x.get("kind").and_then(|k| k.as_str()) {
            // Signs are unlit HDR surfaces, often with animated coordinates.
            Some("unlit") | Some("sign") => pc::Kind::Unlit,
            Some("glass") => pc::Kind::Glass,
            Some("interiorWindow") => pc::Kind::InteriorWindow,
            Some("products") => pc::Kind::Products,
            Some("tower") => pc::Kind::Tower,
            Some("water") => pc::Kind::Water,
            Some("lights") => pc::Kind::Lights,
            _ if m.unlit() => pc::Kind::Unlit,
            _ => pc::Kind::Standard,
        };
        let blend = match m.alpha_mode() {
            _ if kind == pc::Kind::Lights => pc::Blend::Additive,
            gltf::material::AlphaMode::Blend if kind == pc::Kind::Glass => pc::Blend::Premultiplied,
            gltf::material::AlphaMode::Blend => pc::Blend::Alpha,
            _ => pc::Blend::Opaque,
        };
        let alpha_test = if m.alpha_mode() == gltf::material::AlphaMode::Mask { m.alpha_cutoff().unwrap_or(0.5) } else { 0.0 };
        let wants_alpha = blend != pc::Blend::Opaque || alpha_test > 0.0;
        let uv_anim = extras::uv_anim(&x);
        let usage = |slot: &str| x.get("textureUsage").and_then(|v| v.get(slot)).map(|v| serde_json::from_value(v.clone()).expect("checked texture usage"));
        let cells = uv_anim.filter(|a| a.frames > 1).map_or((1, 1), |a| (a.cols, a.rows));
        let albedo = pbr.base_color_texture().map(|t| self.texture(t.texture(), pc::TexRole::Color, wants_alpha, usage("albedo"), cells));
        let normal = m.normal_texture().map(|t| self.texture(t.texture(), pc::TexRole::Normal, false, usage("normal"), (1, 1)));
        let orm = pbr.metallic_roughness_texture().map(|t| self.texture(t.texture(), pc::TexRole::Orm, false, usage("orm"), (1, 1)));
        let emission = m.emissive_texture().map(|t| self.texture(t.texture(), pc::TexRole::Color, false, usage("emission"), cells));
        let strength = m.emissive_strength().unwrap_or(1.0);
        let e = m.emissive_factor();
        let mut color = pbr.base_color_factor();
        let mut emissive = [e[0] * strength, e[1] * strength, e[2] * strength];
        if kind == pc::Kind::Unlit {
            // Unlit HDR colour travels in extras (glTF clamps base colour).
            if let Some(c) = x.get("color") {
                let c = v3(c);
                color = [c[0], c[1], c[2], color[3]];
            }
            emissive = [0.0; 3];
        }
        // Kinds without PBR emission carry their own light level here.
        match kind {
            pc::Kind::Products => emissive = [f(&x, "lit", 1.0), f(&x, "packMix", 0.85), 0.0],
            pc::Kind::InteriorWindow => emissive = [f(&x, "intensity", 1.4), 0.0, 0.0],
            _ => {}
        }
        let wet = x.get("wet").map(|w| pc::Wet {
            puddles: f(w, "puddles", 0.0),
            darken: f(w, "darken", 1.0),
            roughness: f(w, "roughness", 1.0),
            planar: w.get("planar").and_then(|p| p.as_bool()).unwrap_or(false),
            ripple: f(w, "ripple", 0.55),
            puddle_scale: f(w, "puddleScale", 14.0),
        });
        let damp = x.get("damp").map(|d| pc::Damp { darken: f(d, "darken", 1.0), roughness: f(d, "roughness", 1.0), streaks: f(d, "streaks", 1.0) });
        let clearcoat = m
            .extensions()
            .and_then(|e| e.get("KHR_materials_clearcoat"))
            .and_then(|c| c.get("clearcoatFactor"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;
        let water = (kind == pc::Kind::Water).then(|| extras::water(&x, m.name().unwrap_or("material")));
        let lights = (kind == pc::Kind::Lights).then(|| extras::light_field(&x, self.period));
        let name = m.name().unwrap_or("material").to_string();
        let out = pc::Material {
            name: name.clone(),
            kind,
            blend,
            double_sided: m.double_sided(),
            depth_write: blend == pc::Blend::Opaque,
            alpha_test,
            color,
            emissive,
            roughness: pbr.roughness_factor(),
            metalness: pbr.metallic_factor(),
            normal_scale: m.normal_texture().map(|t| t.scale()).unwrap_or(1.0),
            ao_strength: m.occlusion_texture().map(|t| t.strength()).unwrap_or(0.0),
            env_strength: f(&x, "envMapIntensity", 1.0),
            albedo,
            normal,
            orm,
            emission,
            vertex_color: false,
            vertex_pbr: false,
            interior: x.get("interior").and_then(|v| v.as_bool()).unwrap_or(false),
            fog: x.get("fog").and_then(|v| v.as_bool()).unwrap_or(true),
            wet,
            damp,
            drops: x.get("glass").map(|g| f(g, "drops", 0.0)).unwrap_or(0.0),
            clearcoat,
            polygon_offset: x.get("polygonOffset").filter(|p| p.is_array()).map(|p| extras::arr(p, [0.0; 2]))
                .or_else(|| (self.profile.target == ir::Target::Psp && x["window"].is_string()).then_some([-1.0, -4.0])),
            emissive_track: None,
            uv_anim,
            water,
            lights,
            tint: (kind == pc::Kind::InteriorWindow).then(|| extras::tint(&x)).flatten(),
        };
        self.materials.push(out);
        let i = (self.materials.len() - 1) as u32;
        if let Some(b) = extras::lod_bias(&x) {
            self.lod_bias.insert(i, b);
        }
        self.mat_keys.insert(key, i);
        self.material_names.insert(name, i);
        (i, transform)
    }
}

fn img_name(doc: &gltf::Document, i: usize) -> String {
    doc.images().nth(i).and_then(|im| im.name().map(String::from)).unwrap_or_else(|| format!("image{i}"))
}

fn uv_transform(m: &gltf::Material) -> Option<([f32; 2], [f32; 2])> {
    let pbr = m.pbr_metallic_roughness();
    let infos = [
        pbr.base_color_texture().and_then(|t| t.texture_transform()),
        m.emissive_texture().and_then(|t| t.texture_transform()),
        pbr.metallic_roughness_texture().and_then(|t| t.texture_transform()),
    ];
    for t in infos.into_iter().flatten() {
        return Some((t.scale(), t.offset()));
    }
    // Normal maps expose the transform only through raw JSON in this crate.
    if let Some(nt) = m.normal_texture() {
        let _ = nt;
    }
    None
}

// -------------------------------------------------------------- scene walk

/// One shelf item: full stand-in and its LOD1 card, world space.
struct Stock {
    material: u32,
    center: Vec3,
    full: (Vec<Vertex>, Vec<[u32; 3]>),
    card: (Vec<Vertex>, Vec<[u32; 3]>),
}

struct Prim {
    mesh_node: usize,
    world: Mat4,
    /// Mesh-local vertices (skinned) or world-space (static).
    verts: Vec<Vertex>,
    tris: Vec<[u32; 3]>,
    material: u32,
    moving: bool,
    skin: Option<usize>,
    no_reflect: bool,
    /// Lighting baked into the vertices (Baked layout).
    baked: bool,
    selection: crate::intent::Selection,
    base_error: f32,
}

fn read_primitive(
    cook: &mut Cook,
    prim: &gltf::Primitive,
    xf: Mat4,
    bake: bool,
    instance_color: Option<[f32; 4]>,
) -> Option<(Vec<Vertex>, Vec<[u32; 3]>, u32)> {
    if prim.mode() != gltf::mesh::Mode::Triangles {
        return None;
    }
    let reader = prim.reader(|b| Some(&cook.buffers[b.index()]));
    let pos: Vec<Vec3> = reader.read_positions()?.map(Vec3::from).collect();
    let nrm: Vec<Vec3> = reader.read_normals().map(|n| n.map(Vec3::from).collect()).unwrap_or_else(|| vec![Vec3::Y; pos.len()]);
    let mut uv: Vec<Vec2> = reader.read_tex_coords(0).map(|t| t.into_f32().map(Vec2::from).collect()).unwrap_or_else(|| vec![Vec2::ZERO; pos.len()]);
    let colors: Option<Vec<[f32; 4]>> = reader.read_colors(0).map(|c| c.into_rgba_f32().collect());
    let joints: Option<Vec<[u16; 4]>> = reader.read_joints(0).map(|j| j.into_u16().collect());
    let weights: Option<Vec<[f32; 4]>> = reader.read_weights(0).map(|w| w.into_f32().collect());
    let idx: Vec<u32> = reader.read_indices().map(|i| i.into_u32().collect()).unwrap_or_else(|| (0..pos.len() as u32).collect());
    let tris: Vec<[u32; 3]> = idx.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    let (material, transform) = cook.material(prim.material());
    if let Some((scale, offset)) = transform {
        for t in &mut uv {
            *t = Vec2::new(t.x * scale[0] + offset[0], t.y * scale[1] + offset[1]);
        }
    }
    let tan = geometry::tangents(&pos, &nrm, &uv, &tris);
    let nmat = Mat3::from_mat4(xf).inverse().transpose();
    let has_color = colors.is_some() || instance_color.is_some();
    let products = cook.materials[material as usize].kind == pc::Kind::Products;
    if has_color {
        cook.materials[material as usize].vertex_color = true;
    }
    let mut verts: Vec<Vertex> = (0..pos.len())
        .map(|i| {
            let (p, n, t) = if bake {
                let t = nmat * Vec3::new(tan[i][0], tan[i][1], tan[i][2]);
                (xf.transform_point3(pos[i]), (nmat * nrm[i]).normalize_or_zero(), [t.x, t.y, t.z, tan[i][3]])
            } else {
                (pos[i], nrm[i], tan[i])
            };
            let t3 = Vec3::new(t[0], t[1], t[2]).normalize_or_zero();
            let mut c = colors.as_ref().map(|c| c[i]).unwrap_or([1.0; 4]);
            if let Some(ic) = instance_color {
                for k in 0..4 {
                    c[k] *= ic[k];
                }
            }
            if products {
                // Shelf stock shades by height within the item: keep the
                // pre-instance local y (unit-height shapes) in alpha.
                c[3] = pos[i].y.clamp(0.0, 1.0);
            }
            let (jn, wt) = match (&joints, &weights) {
                (Some(j), Some(w)) => {
                    (j[i].map(|x| x.min(255) as u8), quantize_weights(w[i]))
                }
                _ => ([0; 4], [255, 0, 0, 0]),
            };
            Vertex {
                pos: p,
                normal: n,
                tangent: [t3.x, t3.y, t3.z, t[3]],
                uv: uv[i],
                color: [srgb8(c[0]), srgb8(c[1]), srgb8(c[2]), (c[3].clamp(0.0, 1.0) * 255.0) as u8],
                joints: jn,
                weights: wt,
                light: [0; 4],
            }
        })
        .collect();
    if cook.materials[material as usize].kind == pc::Kind::InteriorWindow {
        // The room tracer needs the pane size in metres: colour carries
        // (width, height) / 16 m, measured from the UV gradients.
        cook.materials[material as usize].vertex_color = false;
        for t in &tris {
            let [a, b, c] = t.map(|i| i as usize);
            let (e1, e2) = (verts[b].pos - verts[a].pos, verts[c].pos - verts[a].pos);
            let (d1, d2) = (verts[b].uv - verts[a].uv, verts[c].uv - verts[a].uv);
            let det = d1.x * d2.y - d1.y * d2.x;
            if det.abs() < 1e-9 {
                continue;
            }
            let w = ((e1 * d2.y - e2 * d1.y) / det).length();
            let h = ((e2 * d1.x - e1 * d2.x) / det).length();
            let q = |v: f32| ((v / 16.0).clamp(0.0, 1.0) * 255.0).round() as u8;
            for i in [a, b, c] {
                verts[i].color = [q(w), q(h), 0, 255];
            }
        }
    }
    Some((verts, tris, material))
}

/// A POINTS primitive of a light field (`kind: "lights"`): every point in
/// the place frame, with its custom attributes (`_LIGHT`, `_PATH`, `_BLINK`).
/// Other point primitives are skipped.
fn read_light_field(cook: &mut Cook, prim: &gltf::Primitive, xf: Mat4, moving: bool, out: &mut Vec<(u32, pc::LightPoint)>) {
    let (material, _) = cook.material(prim.material());
    let name = cook.materials[material as usize].name.clone();
    if cook.materials[material as usize].kind != pc::Kind::Lights {
        cook.log.push(format!("skipped POINTS of {name}: not a light field"));
        return;
    }
    let reader = prim.reader(|b| Some(&cook.buffers[b.index()]));
    let Some(pos) = reader.read_positions() else { return };
    let pos: Vec<Vec3> = pos.map(Vec3::from).collect();
    let colors: Vec<[f32; 3]> = reader.read_colors(0).map(|c| c.into_rgb_f32().collect()).unwrap_or_else(|| vec![[1.0; 3]; pos.len()]);
    let custom = |key: &str| {
        prim.get(&gltf::Semantic::Extras(key.into())).map(|a| (accessor_f32(cook.doc, cook.buffers, a.index()), a.dimensions().multiplicity()))
    };
    let (light, path, blink) = (custom("LIGHT"), custom("PATH"), custom("BLINK"));
    if light.is_none() {
        cook.log.push(format!("light field {name}: no _LIGHT attribute (every light dark)"));
    }
    if moving {
        cook.log.push(format!("light field {name}: under a moving node, cooked at its rest pose"));
    }
    // Paths turn with the node; radii stay as authored (the web's sprites
    // do not scale them either).
    let lin = Mat3::from_mat4(xf);
    let n = pos.len();
    let blinks = blink.as_ref().map(|(v, m)| (0..n).filter(|i| v.get(i * m).copied().unwrap_or(0.0) > 0.0).count()).unwrap_or(0);
    for (i, p) in pos.iter().enumerate() {
        fn at(c: &Option<(Vec<f32>, usize)>, i: usize) -> Option<&[f32]> {
            c.as_ref().and_then(|(v, m)| v.get(i * m..i * m + m))
        }
        let mut l = extras::light_point(xf.transform_point3(*p).to_array(), colors[i], at(&light, i), at(&path, i), at(&blink, i));
        l.path = (lin * Vec3::from(l.path)).to_array();
        out.push((material, l));
    }
    let moving_n = path.as_ref().map(|(v, m)| (0..n).filter(|i| (0..3).any(|k| v.get(i * m + k).copied().unwrap_or(0.0) != 0.0)).count()).unwrap_or(0);
    cook.log.push(format!("light field {name}: {n} lights ({moving_n} moving, {blinks} blinking)"));
}

/// The LOD bias for a texture whose mapping averages `log2_ratio` (log2 of
/// its texel densities' ratio): the full difference, so the mip follows the
/// sparser direction, from a ratio of 1.5 up to a bias of −2. Below 1.5 the
/// texture keeps the renderer's own bias.
fn anisotropy_bias(log2_ratio: f32) -> Option<f32> {
    (log2_ratio >= 1.5f32.log2()).then(|| -log2_ratio.min(2.0))
}

fn node_matrix(n: &gltf::Node) -> Mat4 {
    Mat4::from_cols_array_2d(&n.transform().matrix())
}

fn accessor_f32(doc: &gltf::Document, buffers: &[gltf::buffer::Data], index: usize) -> Vec<f32> {
    let acc = doc.accessors().nth(index).expect("accessor");
    let view = acc.view().expect("sparse accessors unsupported");
    let buf = &buffers[view.buffer().index()];
    let comps = acc.dimensions().multiplicity();
    let stride = view.stride().unwrap_or(acc.size());
    let base = view.offset() + acc.offset();
    let mut out = Vec::with_capacity(acc.count() * comps);
    for i in 0..acc.count() {
        for c in 0..comps {
            let at = base + i * stride;
            let v = match acc.data_type() {
                gltf::accessor::DataType::F32 => f32::from_le_bytes(buf[at + c * 4..at + c * 4 + 4].try_into().unwrap()),
                gltf::accessor::DataType::U8 => {
                    let v = buf[at + c] as f32;
                    if acc.normalized() { v / 255.0 } else { v }
                }
                gltf::accessor::DataType::U16 => {
                    let v = u16::from_le_bytes(buf[at + c * 2..at + c * 2 + 2].try_into().unwrap()) as f32;
                    if acc.normalized() { v / 65535.0 } else { v }
                }
                other => panic!("unsupported instancing accessor {other:?}"),
            };
            out.push(v);
        }
    }
    out
}

/// Retains float vertices and logical indices until target lowering.
#[allow(clippy::too_many_arguments)]
fn push_draw(verts: &[Vertex], tris: &[[u32; 3]], lods: Vec<(Vec<[u32; 3]>, f32)>, material: u32, class: pc::VertexClass, node: Option<u32>, skin: Option<u32>, no_reflect: bool, native_order: bool, draws: &mut Vec<pc::Draw>) {
    let min = verts.iter().fold(Vec3::splat(f32::MAX), |a, v| a.min(v.pos));
    let max = verts.iter().fold(Vec3::splat(f32::MIN), |a, v| a.max(v.pos));
    draws.push(pc::Draw {
        material, class,
        geometry: pc::Geometry::Triangles {
            vertices: verts.to_vec(),
            indices: (if native_order { geometry::cache_order(tris, verts.len()) } else { tris.to_vec() }).into_iter().flatten().collect(),
            lods: lods.into_iter().map(|(tris, error)| pc::Lod { indices: (if native_order { geometry::cache_order(&tris, verts.len()) } else { tris }).into_iter().flatten().collect(), error }).collect(),
        },
        min: min.to_array(), max: max.to_array(), node, skin, no_reflect, cast_shadow: true, protected: false,
    });
}

mod read;
mod resolve;
mod sampling;
mod reduce;
mod palette_pass;
mod motion;
mod lighting;
mod baking;
mod chunk;
mod effects;

/// The target recipe executes real typed transformations. Resources remain
/// borrowed from the sealed source until scene assembly; target packing never
/// becomes an input to another backend.
pub fn analyze(a: &Args, name: &str, pipeline: &mut crate::recipe::Pipeline) -> (pc::Scene, Vec<String>) {
    let solid_pbr = pipeline.solid_pbr();
    let native_cache_order = pipeline.native_cache_order();
    let source = pipeline.run("read-source", || read::run(a));
    let plan = pipeline.run("select-geometry", || crate::intent::plan(&source.doc, &a.profile));
    let mut resolved = pipeline.run("resolve-materials", || resolve::run(a, &source, &plan));
    pipeline.run("texture-sampling", || sampling::run(&mut resolved.cook, &resolved.prims, solid_pbr));
    pipeline.run("solid-pbr-palette", || palette_pass::run(&mut resolved.cook, &mut resolved.prims, &source.sx, &resolved.hierarchy, &resolved.world_of, solid_pbr));
    pipeline.run("reduce-geometry", || reduce::run(&mut resolved));
    let motion = pipeline.run("sample-motion", || motion::run(a, &source, &resolved));
    let lighting = pipeline.run("scene-lighting", || lighting::run(a, &source, &mut resolved, &motion));
    let baked = pipeline.run("bake-lighting", || baking::run(a, &source.sx, &mut resolved.cook, &mut resolved.prims, &lighting));
    let geometry = pipeline.run("chunk-and-lod", || chunk::run(a, &resolved, &motion, baked.baked_sun, native_cache_order));
    pipeline.run("scene-effects", || effects::run(a, name, &source, resolved, motion, lighting, baked, geometry))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_draw_retains_source_precision_and_lod_index_space() {
        let a = Vertex { normal: Vec3::Y, tangent: [1.0, 0.0, 0.0, 1.0], color: [255; 4], weights: [255, 0, 0, 0], ..Default::default() };
        let mut close = a;
        close.pos.x = 0.0000001;
        close.normal.x = 0.000001;
        close.tangent[2] = 0.000001;
        close.uv.x = 0.0000001;
        let verts = [a, Vertex { pos: Vec3::X, ..a }, Vertex { pos: Vec3::Z, ..a }, close];
        for native_order in [false, true] {
            let mut draws = Vec::new();
            push_draw(&verts, &[[0, 1, 2], [3, 1, 2]], vec![(vec![[3, 1, 2]], 0.06)], 0, pc::VertexClass::Skinned, None, None, false, native_order, &mut draws);
            let draw = &draws[0];
            assert_eq!(draw.vertex_count(), 4);
            for (actual, original) in draw.vertices().iter().zip(verts) {
                assert_eq!(actual.pos.to_array().map(f32::to_bits), original.pos.to_array().map(f32::to_bits));
                assert_eq!(actual.normal.to_array().map(f32::to_bits), original.normal.to_array().map(f32::to_bits));
                assert_eq!(actual.tangent.map(f32::to_bits), original.tangent.map(f32::to_bits));
                assert_eq!(actual.uv.to_array().map(f32::to_bits), original.uv.to_array().map(f32::to_bits));
                assert_eq!((actual.color, actual.joints, actual.weights, actual.light), (original.color, original.joints, original.weights, original.light));
            }
            assert_eq!(draw.lods()[0].indices, [3, 1, 2]);
        }
    }

    #[test]
    fn cells_grow_with_distance() {
        // 32 m near the middle, 256 m to 1 km, then octaves up to 16 km.
        assert_eq!(cell_at(Vec3::new(100.0, 0.0, -20.0), 32.0, 0.0), Cell::Grid(32, 3, -1));
        assert_eq!(cell_at(Vec3::new(-300.0, 0.0, 900.0), 32.0, 0.0), Cell::Grid(256, -2, 3));
        assert_eq!(cell_at(Vec3::new(1500.0, 0.0, 0.0), 32.0, 0.0), Cell::Grid(1024, 1, 0));
        assert_eq!(cell_at(Vec3::new(0.0, 0.0, 30_000.0), 32.0, 0.0), Cell::Grid(16384, 0, 1));
        assert_eq!(cell_at(Vec3::new(0.0, 0.0, 45_000.0), 32.0, 0.0), Cell::Grid(32768, 0, 1));
        assert_eq!(cell_at(Vec3::new(-110_000.0, 0.0, 5_000.0), 32.0, 0.0), Cell::Grid(65536, -2, 0));
        // Light fields: no cell under 512 m.
        assert_eq!(cell_at(Vec3::new(100.0, 0.0, 100.0), 32.0, 512.0), Cell::Grid(512, 0, 0));
    }

    #[test]
    fn anisotropic_mappings_get_a_bias() {
        // A wall 48 m wide and 128 m tall over a 256² window grid: 5.3
        // texels per metre across, 2 up.
        let p = [Vec3::ZERO, Vec3::new(48.0, 0.0, 0.0), Vec3::new(48.0, 128.0, 0.0)];
        let uv = [Vec2::ZERO, Vec2::new(1.0, 0.0), Vec2::new(1.0, 1.0)];
        let (r, area) = geometry::texel_anisotropy(p, uv, Vec2::splat(256.0)).unwrap();
        assert!((r - (8.0f32 / 3.0).log2()).abs() < 1e-4, "{r}");
        assert!((area - 48.0 * 64.0).abs() < 1e-2);
        assert!((anisotropy_bias(r).unwrap() + 1.415).abs() < 1e-3);
        // Square texels on a slanted face; a ratio under 1.5 keeps no bias.
        let q = [Vec3::ZERO, Vec3::new(2.0, 0.0, 0.0), Vec3::new(2.0, 2.0, 1.0)];
        let (r, _) = geometry::texel_anisotropy(q, [Vec2::ZERO, Vec2::new(0.5, 0.0), Vec2::new(0.5, 0.5)], Vec2::splat(256.0)).unwrap();
        assert!((r - (5.0f32.sqrt() / 2.0).log2()).abs() < 1e-4, "{r}");
        assert_eq!(anisotropy_bias(r), None);
        assert_eq!(anisotropy_bias(3.0), Some(-2.0));
        // A constant UV (roofs reading one texel) has no mapping.
        assert!(geometry::texel_anisotropy(p, [Vec2::splat(0.1); 3], Vec2::splat(256.0)).is_none());
    }

    #[test]
    fn far_chunks_get_coarser_levels() {
        assert_eq!(lod_bounds(Cell::Grid(256, 3, -4)), vec![0.06, 0.25]);
        assert_eq!(lod_bounds(Cell::Whole), vec![0.06, 0.25]);
        // A 2 km cell from 4 to 6 km east: errors from its near edge.
        assert_eq!(cell_distance(Cell::Grid(2048, 2, -1)), 4096.0);
        let b = lod_bounds(Cell::Grid(2048, 2, -1));
        assert!((b[0] - 1.2288).abs() < 1e-4 && (b[2] / b[0] - 16.0).abs() < 1e-4, "{b:?}");
        // A cell straddling an axis is as near as its other coordinate.
        assert_eq!(cell_distance(Cell::Grid(1024, -1, 1)), 1024.0);
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::*;

    #[test]
    fn quantized_skin_weights_stay_inside_joint_bounds() {
        for w in [[0.0, 0.5, 0.5, 0.0], [0.0, 0.333, 0.333, 0.334], [0.25; 4], [0.0, 0.0, 0.0, 1.0], [0.0; 4]] {
            let q = quantize_weights(w);
            assert_eq!(q.iter().map(|&x| x as u32).sum::<u32>(), 255);
            let points = [-120.0, -40.0, 80.0, 140.0];
            let position: f64 = points.into_iter().zip(q).map(|(p, q)| p * q as f64 / 255.0).sum();
            assert!((-120.0..=140.0).contains(&position));
            if w.iter().sum::<f32>() > 0.0 {
                for (source, encoded) in w.into_iter().zip(q) { if source == 0.0 { assert_eq!(encoded, 0); } }
            }
        }
    }

    #[test]
    fn long_faces_keep_their_geometry_without_expanding_local_bounds() {
        let long = [Vec3::new(-210.0, 5.6, 0.0), Vec3::new(210.0, 5.6, 0.0), Vec3::new(210.0, 5.62, 0.0)];
        let local = [Vec3::new(60.0, 0.0, 0.0), Vec3::new(61.0, 0.0, 0.0), Vec3::new(60.0, 1.0, 0.0)];
        let input = [long, local];
        let mut groups: BTreeMap<Cell, Vec<[Vec3; 3]>> = BTreeMap::new();
        for triangle in input { groups.entry(triangle_cell(triangle, 32.0)).or_default().push(triangle); }
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[&Cell::Oversized], [long]);
        assert_eq!(groups[&Cell::Grid(32, 1, 0)], [local]);
        assert_eq!(groups.values().map(Vec::len).sum::<usize>(), input.len());
        let local_max = groups[&Cell::Grid(32, 1, 0)].iter().flatten().map(|v| v.x).fold(f32::MIN, f32::max);
        assert_eq!(local_max, 61.0);
    }

    #[test]
    fn oversized_boundaries_lock_shared_positions_across_attribute_seams() {
        let mut verts: Vec<Vertex> = [Vec3::ZERO, Vec3::new(0.5, 0.0, 0.5), Vec3::new(0.5, 0.0, 1.0), Vec3::new(-100.0, 0.0, 0.0), Vec3::ZERO, Vec3::new(0.5, 0.0, 0.5)]
            .into_iter().map(|pos| Vertex { pos, ..Vertex::default() }).collect();
        verts[4].uv = Vec2::new(0.3, 0.9);
        verts[5].normal = Vec3::X;
        let tris = [[0, 1, 2], [3, 5, 4]];
        let cells: Vec<_> = tris.iter().map(|tri| triangle_cell(tri.map(|i| verts[i as usize].pos), 32.0)).collect();
        assert_eq!(cells, [Cell::Grid(32, 0, 0), Cell::Oversized]);
        let cut = chunk_boundaries(&verts, &tris, &cells);
        assert_eq!(cut, HashSet::from([geometry::pos_bits(verts[0].pos), geometry::pos_bits(verts[1].pos)]));
        // The same edge is not a chunk boundary when both triangles share a bucket.
        assert!(chunk_boundaries(&verts, &tris, &[Cell::Whole, Cell::Whole]).is_empty());
    }

    #[test]
    fn oversized_threshold_follows_horizontal_cell_size() {
        let triangle = [Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0), Vec3::new(10.0, 80.0, 0.0)];
        assert_eq!(triangle_cell(triangle, 8.0), Cell::Oversized);
        assert_eq!(triangle_cell(triangle, 32.0), Cell::Grid(32, 0, 0));
        let distant = triangle.map(|p| p + Vec3::X * 200.0);
        assert_eq!(triangle_cell(distant, 32.0), Cell::Grid(256, 0, 0));
    }

    #[test]
    fn distant_terrain_keeps_vista_cells_and_lod_errors() {
        // A face centred in the first far band still extends back into the
        // street: it must not widen the ordinary 256 m palette bucket.
        let street = [Vec3::new(4.0, 0.0, 0.0), Vec3::new(210.0, 0.0, 0.0), Vec3::new(210.0, 1.0, 0.0)];
        assert_eq!(triangle_cell(street, 32.0), Cell::Oversized);
        let terrain = [Vec3::new(4100.0, 0.0, 0.0), Vec3::new(5100.0, 0.0, 0.0), Vec3::new(5100.0, 100.0, 10.0)];
        let cell = triangle_cell(terrain, 32.0);
        assert_eq!(cell, Cell::Grid(4096, 1, 0));
        assert_eq!(lod_bounds(cell), vec![1.2288, 4.9152, 19.6608]);
        assert_eq!(lod_bounds(Cell::Oversized), vec![0.06, 0.25]);
    }
}
