//! `pocket-atlas-cook` — web export → PlaceIR → device-specific `.place`.
//!
//! ```text
//! pocket-atlas-cook --in .pocket-build/places/tokyo-konbini --out .pocket-build/places/tokyo-konbini/tokyo-konbini.place
//! ```
//!
//! Static geometry is baked to world space and split into spatial chunks;
//! animated subtrees (and door leaves) keep their node hierarchy; skinned
//! meshes keep joints and inverse binds. Textures are fitted to powers of two,
//! mipmapped and block-compressed; animation is resampled uniformly.

mod ir;
mod source;
mod atlas;
mod extras;
mod uifont;
mod bake;
mod env;
mod geometry;
mod occlusion;
mod pica;
mod procedural;
mod psp;
mod gles;
mod psp_products;
mod textures;

use geometry::Vertex;
use glam::{Mat3, Mat4, Quat, Vec2, Vec3, Vec4};
use gltf::khr_lights_punctual::Kind as LightType;
use pocket3d_place as pc;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

struct Args {
    input: PathBuf,
    output: PathBuf,
    cell: f32,
    tex_cap: u32,
    target: ir::Target,
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("error: {message}");
    std::process::exit(2)
}

fn args() -> Args {
    let a: Vec<String> = std::env::args().collect();
    let get = |k: &str| a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).cloned();
    let input = PathBuf::from(get("--in").unwrap_or_else(|| ".pocket-build/places/tokyo-konbini".into()));
    if a.iter().any(|v| v == "--pica-from") || a.get(1).is_some_and(|v| v == "psp") {
        fail("device packs are no longer compiler inputs; use --in <PlaceIR or web export directory> --target <vita|3ds|psp>");
    }
    let output = get("--out").map(PathBuf::from).unwrap_or_else(|| {
        if a.get(1).is_some_and(|v| v == "import") { input.join("place.ir") }
        else { input.join("scene.place") }
    });
    Args {
        target: ir::Target::parse(&get("--target").unwrap_or_else(|| "vita".into())).unwrap_or_else(|e| fail(e)),
        input,
        output,
        cell: get("--cell").and_then(|v| v.parse().ok()).unwrap_or(32.0),
        tex_cap: get("--tex").and_then(|v| v.parse().ok()).unwrap_or(1024),
    }
}

fn extras(raw: &gltf::json::Extras) -> Value {
    raw.as_ref().and_then(|r| serde_json::from_str::<Value>(r.get()).ok()).unwrap_or(Value::Null)
}

fn pc_of(raw: &gltf::json::Extras) -> Value {
    extras(raw).get("pocketAtlas").cloned().unwrap_or(Value::Null)
}

use extras::{f, v3};
use pc::color::encode8 as srgb8;

/// Where static geometry is chunked: a grid cell of the given edge (m),
/// or one chunk for the whole primitive (open water: its cost is per pixel,
/// and chunks only add draws).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Cell {
    Grid(u32, i32, i32),
    Whole,
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
        Cell::Whole => 0.0,
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

#[derive(Default)]
struct Blobs {
    tex: Vec<u8>,
    geom: Vec<u8>,
    anim: Vec<u8>,
    // Float vertices for native target lowering; never serialized as a Vita pack.
    meshes: Vec<Vec<Vertex>>,
}

impl Blobs {
    fn push(buf: &mut Vec<u8>, data: &[u8], align: usize) -> pc::Range {
        while buf.len() % align != 0 {
            buf.push(0);
        }
        let offset = buf.len() as u32;
        buf.extend_from_slice(data);
        pc::Range { offset, size: data.len() as u32 }
    }
    fn floats(buf: &mut Vec<u8>, data: &[f32]) -> pc::Range {
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        Self::push(buf, &bytes, 16)
    }
}

struct Cook<'a> {
    doc: &'a gltf::Document,
    buffers: &'a [gltf::buffer::Data],
    images: &'a [gltf::image::Data],
    tex_cap: u32,
    target: ir::Target,
    blobs: Blobs,
    textures: Vec<pc::Texture>,
    tex_keys: HashMap<(usize, u8, bool, (u32, u32)), u32>,
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
    fn texture(&mut self, tex: gltf::Texture, role: pc::TexRole, alpha_wanted: bool, cap: u32, cells: (u32, u32)) -> u32 {
        let image = tex.source().index();
        // A flipbook keeps a shorter mip chain than the same image elsewhere.
        let key = (image, role as u8, alpha_wanted, cells);
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
        let src = textures::from_rgba8(img.width, img.height, &rgba, role);
        let cap = if img.width.max(img.height) >= 4096 { cap.max(2048) } else { cap };
        let enc = if self.target == ir::Target::Vita {
            textures::encode_cells(&src, role, cap, has_alpha, cells)
        } else { textures::Encoded { format: pc::TexFormat::Rgba8, width: img.width, height: img.height, mips: 1, data: rgba } };
        let data = Blobs::push(&mut self.blobs.tex, &enc.data, 4096);
        let wrap = |m: gltf::texture::WrappingMode| match m {
            gltf::texture::WrappingMode::Repeat => pc::Wrap::Repeat,
            gltf::texture::WrappingMode::ClampToEdge => pc::Wrap::Clamp,
            gltf::texture::WrappingMode::MirroredRepeat => pc::Wrap::Mirror,
        };
        let sampler = tex.sampler();
        let name = img_name(self.doc, image);
        self.log.push(format!("texture {name} {:?} {}x{} → {:?} {}x{} ×{} ({} KiB)", role, img.width, img.height, enc.format, enc.width, enc.height, enc.mips, enc.data.len() / 1024));
        self.textures.push(pc::Texture {
            name,
            role,
            format: enc.format,
            width: enc.width,
            height: enc.height,
            mips: enc.mips,
            data,
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
        let cap = self.tex_cap;
        let cells = uv_anim.filter(|a| a.frames > 1).map_or((1, 1), |a| (a.cols, a.rows));
        let albedo = pbr.base_color_texture().map(|t| self.texture(t.texture(), pc::TexRole::Color, wants_alpha, cap, cells));
        let normal = m.normal_texture().map(|t| self.texture(t.texture(), pc::TexRole::Normal, false, cap, (1, 1)));
        let orm = pbr.metallic_roughness_texture().map(|t| self.texture(t.texture(), pc::TexRole::Orm, false, cap, (1, 1)));
        let emission = m.emissive_texture().map(|t| self.texture(t.texture(), pc::TexRole::Color, false, cap, cells));
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
            emission_shade: extras::emission_shade(&x),
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
            interior: x.get("interior").and_then(|v| v.as_bool()).unwrap_or(false),
            fog: x.get("fog").and_then(|v| v.as_bool()).unwrap_or(true),
            wet,
            damp,
            drops: x.get("glass").map(|g| f(g, "drops", 0.0)).unwrap_or(0.0),
            clearcoat,
            polygon_offset: x.get("polygonOffset").filter(|p| p.is_array()).map(|p| extras::arr(p, [0.0; 2])),
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
                    let w = w[i];
                    let sum = (w[0] + w[1] + w[2] + w[3]).max(1e-6);
                    let mut q = w.map(|x| (x / sum * 255.0).round() as i32);
                    let diff = 255 - q.iter().sum::<i32>();
                    q[0] += diff;
                    (j[i].map(|x| x.min(255) as u8), q.map(|x| x.clamp(0, 255) as u8))
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

/// Stores one built draw's buffers and records it.
#[allow(clippy::too_many_arguments)]
fn push_draw(b: geometry::Built, material: u32, layout: pc::VertexLayout, node: Option<u32>, skin: Option<u32>, no_reflect: bool, blobs: &mut Blobs, draws: &mut Vec<pc::Draw>) {
    let vertices = if b.source.is_empty() { Blobs::push(&mut blobs.geom, &b.vertices, 16) } else {
        let id = blobs.meshes.len() as u32;
        blobs.meshes.push(b.source);
        pc::Range { offset: id, size: 0 }
    };
    let indices = Blobs::push(&mut blobs.geom, &b.indices, 16);
    let lods = b.lods.iter().map(|(idx, count, error)| pc::DrawLod { indices: Blobs::push(&mut blobs.geom, idx, 16), index_count: *count, error: *error }).collect();
    draws.push(pc::Draw {
        material,
        layout,
        vertices,
        vertex_count: b.vertex_count,
        indices,
        index_count: b.index_count,
        pos_offset: b.pos_offset,
        pos_scale: b.pos_scale,
        uv_offset: b.uv_offset,
        uv_scale: b.uv_scale,
        min: b.min,
        max: b.max,
        node,
        skin,
        no_reflect,
        cast_shadow: true,
        lods,
    });
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("gles") {
        let argv: Vec<String> = std::env::args().collect();
        let get = |k: &str| argv.iter().position(|x| x == k).and_then(|i| argv.get(i + 1));
        let input = std::path::Path::new(get("--in").expect("gles --in PATH"));
        let output = std::path::Path::new(get("--out").expect("gles --out PATH"));
        let cap = get("--tex").and_then(|s| s.parse().ok()).unwrap_or(1024);
        if let Some(profile) = get("--geometry") {
            let profile = gles::GeometryProfile::parse(profile).unwrap_or_else(|e| panic!("{e}"));
            gles::cook_with_profile(input, output, cap, profile);
        } else {
            gles::cook(input, output, cap);
        }
        return;
    }

    let cli: Vec<String> = std::env::args().collect();
    if cli.get(1).is_some_and(|s| s == "import" || s == "check") {
        let a = args();
        if cli[1] == "import" {
            let m = ir::import(&a.input, &a.output).unwrap_or_else(|e| fail(e));
            println!("{}", serde_json::to_string_pretty(&m).unwrap());
        } else {
            let (_, m) = ir::prepare(&a.input).unwrap_or_else(|e| fail(e));
            m.check_target(a.target).unwrap_or_else(|e| fail(e));
            println!("{}: {} supported", m.name, a.target.name());
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("atlas") {
        let argv: Vec<String> = std::env::args().collect();
        let get = |k: &str| argv.iter().position(|x| x == k).and_then(|i| argv.get(i + 1)).cloned();
        let need = |k: &str| PathBuf::from(get(k).unwrap_or_else(|| panic!("atlas: missing {k} (the interface font's faces)")));
        let input = PathBuf::from(get("--in").unwrap_or_else(|| ".pocket-build/atlas/globe".into()));
        let output = get("--out").map(PathBuf::from).unwrap_or_else(|| input.parent().unwrap_or(&input).join("atlas.pack"));
        let faces = uifont::Faces { latin: [need("--latin"), need("--latin-bold")], cjk: [need("--cjk"), need("--cjk-bold")] };
        atlas::cook(&input, &output, &faces);
        return;
    }
    let mut a = args();
    let (root, manifest) = ir::prepare(&a.input).unwrap_or_else(|e| fail(e));
    manifest.check_target(a.target).unwrap_or_else(|e| fail(e));
    if !std::env::args().any(|v| v == "--out") {
        let suffix = match a.target { ir::Target::Vita => "", ir::Target::Pica => ".3ds", ir::Target::Psp => ".psp" };
        a.output = a.input.join(format!("{}{suffix}.place", manifest.name));
    }
    std::fs::create_dir_all(a.output.parent().unwrap_or(std::path::Path::new("."))).expect("output directory");
    a.input = root;
    let t0 = Instant::now();
    let glb = a.input.join("scene.gltf");
    // EXT_mesh_gpu_instancing is listed as required; the crate does not know
    // it, so skip validation and expand instances here.
    let bytes = std::fs::read(&glb).unwrap_or_else(|e| panic!("{}: {e}", glb.display()));
    let gltf::Gltf { document: doc, blob } = gltf::Gltf::from_slice_without_validation(&bytes).unwrap_or_else(|e| panic!("{}: {e}", glb.display()));
    let buffers = gltf::import_buffers(&doc, Some(&a.input), blob).expect("buffers");
    let images = gltf::import_images(&doc, Some(&a.input), &buffers).expect("images");
    println!("loaded {} ({} nodes, {} images) in {} ms", glb.display(), doc.nodes().count(), images.len(), t0.elapsed().as_millis());
    let scene = doc.default_scene().or_else(|| doc.scenes().next()).expect("scene");
    let sx = pc_of(scene.extras());

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
    let moving = |mut i: usize| -> bool {
        loop {
            if animated.contains(&i) {
                return true;
            }
            match parent.get(&i) {
                Some(&p) => i = p,
                None => return false,
            }
        }
    };

    let mut cook = Cook {
        doc: &doc,
        buffers: &buffers,
        images: &images,
        tex_cap: a.tex_cap,
        target: a.target,
        blobs: Blobs::default(),
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
    let mut stack: Vec<(gltf::Node, Mat4)> = scene.nodes().map(|n| (n, Mat4::IDENTITY)).collect();
    let mut world_of: HashMap<usize, Mat4> = HashMap::new();
    while let Some((node, pw)) = stack.pop() {
        let w = pw * node_matrix(&node);
        world_of.insert(node.index(), w);
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
                    // Expand GPU instancing into static geometry (shop stock).
                    let get = |k: &str| attrs.get(k).and_then(|v| v.as_u64()).map(|i| accessor_f32(&doc, &buffers, i as usize));
                    let t = get("TRANSLATION");
                    let r = get("ROTATION");
                    let s = get("SCALE");
                    let c = get("_COLOR_0");
                    let count = t.as_ref().map(|v| v.len() / 3).or(r.as_ref().map(|v| v.len() / 4)).unwrap_or(0);
                    let cstride = c.as_ref().map(|c| if c.len() == count * 4 { 4 } else { 3 }).unwrap_or(3);
                    // Shelf stock: thousands of lathe/cylinder items that
                    // cover a few pixels each on a handheld screen. Every
                    // instance uses one low-poly stand-in of the shape.
                    let proxy = read_primitive(&mut cook, &prim, Mat4::IDENTITY, true, None).and_then(|(v, _, m)| {
                        (cook.materials[m as usize].kind == pc::Kind::Products).then(|| {
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
                        let xf = w * Mat4::from_scale_rotation_translation(sc, ro, tr);
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
                        if let Some((verts, tris, material)) = read_primitive(&mut cook, &prim, xf, true, ic) {
                            prims.push(Prim { mesh_node: node.index(), world: xf, verts, tris, material, moving: false, skin: None, no_reflect: true, baked: false });
                        }
                    }
                    continue;
                }
                let bake = !is_moving && skin.is_none();
                if let Some((verts, tris, material)) = read_primitive(&mut cook, &prim, w, bake, None) {
                    prims.push(Prim { mesh_node: node.index(), world: w, verts, tris, material, moving: !bake, skin, no_reflect: false, baked: false });
                }
            }
        }
        for c in node.children() {
            stack.push((c, w));
        }
    }
    println!("walked scene: {} primitives, {} materials, {} textures ({} ms)", prims.len(), cook.materials.len(), cook.textures.len(), t0.elapsed().as_millis());

    // ---- `lodBias` (materials that ask for it): a number, or "auto" — a
    // texture whose mapping lays more texels per metre one way than the
    // other (mean over the area it covers) gets a negative bias, so the
    // GPU's isotropic mip choice follows the sparser direction instead of
    // blurring it (window grids whose floors blur at 480×272).
    let mut aniso: HashMap<u32, (f64, f64)> = HashMap::new();
    let mut manual: HashMap<u32, f32> = HashMap::new();
    for (&mi, &b) in &cook.lod_bias {
        let m = &cook.materials[mi as usize];
        for t in [m.albedo, m.emission].into_iter().flatten() {
            match b {
                Some(b) => {
                    let e = manual.entry(t).or_insert(b);
                    *e = e.min(b);
                }
                None => {
                    aniso.entry(t).or_default();
                }
            }
        }
    }
    for p in &prims {
        if !cook.lod_bias.contains_key(&p.material) {
            continue;
        }
        let m = &cook.materials[p.material as usize];
        for t in [m.albedo, m.emission].into_iter().flatten() {
            if !aniso.contains_key(&t) {
                continue;
            }
            let tex = &cook.textures[t as usize];
            let texels = Vec2::new(tex.width as f32, tex.height as f32);
            let e = aniso.entry(t).or_default();
            for tri in &p.tris {
                let v = tri.map(|i| p.verts[i as usize]);
                if let Some((log2_ratio, area)) = geometry::texel_anisotropy(v.map(|v| v.pos), v.map(|v| v.uv), texels) {
                    e.0 += (log2_ratio * area) as f64;
                    e.1 += area as f64;
                }
            }
        }
    }
    for (t, (sum, area)) in aniso {
        let mean = if area > 0.0 { (sum / area) as f32 } else { 0.0 };
        let bias = anisotropy_bias(mean).unwrap_or(0.0);
        let tex = &mut cook.textures[t as usize];
        tex.lod_bias = bias;
        cook.log.push(format!("texture {}: texels {:.2}:1 across its {:.0} m², LOD bias {bias:.2}", tex.name, mean.exp2(), area));
    }
    for (t, bias) in manual {
        let tex = &mut cook.textures[t as usize];
        tex.lod_bias = tex.lod_bias.min(bias);
        cook.log.push(format!("texture {}: LOD bias {:.2}", tex.name, tex.lod_bias));
    }

    // ---- node table for moving content (ancestors included for hierarchy)
    let mut node_ids: BTreeMap<usize, u32> = BTreeMap::new();
    let mut need: Vec<usize> = Vec::new();
    for p in &prims {
        if p.moving && p.skin.is_none() {
            need.push(p.mesh_node);
        }
    }
    for s in doc.skins() {
        for j in s.joints() {
            need.push(j.index());
        }
    }
    for (ni, _, _) in &lights {
        if moving(*ni) {
            need.push(*ni);
        }
    }
    for n in doc.nodes() {
        if n.name().is_some_and(|name| door_names.iter().any(|d| d == name)) {
            need.push(n.index());
        }
    }
    let mut ordered: Vec<usize> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    fn add(i: usize, parent: &HashMap<usize, usize>, seen: &mut HashSet<usize>, ordered: &mut Vec<usize>) {
        if seen.contains(&i) {
            return;
        }
        if let Some(&p) = parent.get(&i) {
            add(p, parent, seen, ordered);
        }
        seen.insert(i);
        ordered.push(i);
    }
    for &i in &need {
        add(i, &parent, &mut seen, &mut ordered);
    }
    for (k, &i) in ordered.iter().enumerate() {
        node_ids.insert(i, k as u32);
    }

    // ---- animation: resample every animated node uniformly
    let fps = sx.get("tracks").map(|t| f(t, "fps", 15.0)).unwrap_or(15.0);
    let mut duration = 0.0f32;
    let mut chans: HashMap<usize, (Option<(Vec<f32>, Vec<[f32; 3]>)>, Option<(Vec<f32>, Vec<[f32; 4]>)>)> = HashMap::new();
    for anim in doc.animations() {
        for ch in anim.channels() {
            let r = ch.reader(|b| Some(&buffers[b.index()]));
            let times: Vec<f32> = r.read_inputs().map(|i| i.collect()).unwrap_or_default();
            if let Some(&t) = times.last() {
                duration = duration.max(t);
            }
            let e = chans.entry(ch.target().node().index()).or_default();
            match r.read_outputs() {
                Some(gltf::animation::util::ReadOutputs::Translations(v)) => e.0 = Some((times, v.collect())),
                Some(gltf::animation::util::ReadOutputs::Rotations(v)) => e.1 = Some((times, v.into_f32().collect())),
                _ => {}
            }
        }
    }
    let frames = if duration > 0.0 { (duration * fps).round() as u32 + 1 } else { 1 };
    let sample3 = |k: &(Vec<f32>, Vec<[f32; 3]>), t: f32| -> Vec3 {
        let (ts, vs) = k;
        let i = ts.partition_point(|&x| x <= t);
        if i == 0 {
            return Vec3::from(vs[0]);
        }
        if i >= ts.len() {
            return Vec3::from(*vs.last().unwrap());
        }
        let u = (t - ts[i - 1]) / (ts[i] - ts[i - 1]).max(1e-6);
        Vec3::from(vs[i - 1]).lerp(Vec3::from(vs[i]), u)
    };
    let sample4 = |k: &(Vec<f32>, Vec<[f32; 4]>), t: f32| -> Quat {
        let (ts, vs) = k;
        let i = ts.partition_point(|&x| x <= t);
        if i == 0 {
            return Quat::from_array(vs[0]);
        }
        if i >= ts.len() {
            return Quat::from_array(*vs.last().unwrap());
        }
        let u = (t - ts[i - 1]) / (ts[i] - ts[i - 1]).max(1e-6);
        Quat::from_array(vs[i - 1]).slerp(Quat::from_array(vs[i]), u)
    };
    let mut nodes: Vec<pc::Node> = Vec::new();
    for &i in &ordered {
        let n = doc.nodes().nth(i).unwrap();
        let (t, r, s) = n.transform().decomposed();
        let track = chans.get(&i).map(|(tc, rc)| {
            let mut data = Vec::with_capacity(frames as usize * 7);
            for fr in 0..frames {
                let time = fr as f32 / fps;
                let tt = tc.as_ref().map(|k| sample3(k, time)).unwrap_or(Vec3::from(t));
                let rr = rc.as_ref().map(|k| sample4(k, time)).unwrap_or(Quat::from_array(r));
                data.extend([tt.x, tt.y, tt.z, rr.x, rr.y, rr.z, rr.w]);
            }
            Blobs::floats(&mut cook.blobs.anim, &data)
        });
        nodes.push(pc::Node {
            name: n.name().unwrap_or("").to_string(),
            parent: parent.get(&i).and_then(|p| node_ids.get(p)).copied(),
            translation: t,
            rotation: r,
            scale: s,
            track,
        });
    }

    // ---- skins
    let mut skins: Vec<pc::Skin> = Vec::new();
    let mut skin_ids: HashMap<usize, u32> = HashMap::new();
    for s in doc.skins() {
        let r = s.reader(|b| Some(&buffers[b.index()]));
        let ibm: Vec<f32> = r.read_inverse_bind_matrices().map(|m| m.flat_map(|c| c.into_iter().flatten()).collect()).unwrap_or_default();
        let joints: Vec<u32> = s.joints().map(|j| node_ids[&j.index()]).collect();
        skins.push(pc::Skin { joints, inverse_bind: Blobs::floats(&mut cook.blobs.anim, &ibm) });
        skin_ids.insert(s.index(), (skins.len() - 1) as u32);
    }

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
            emission_shade: None,
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
        prims.push(Prim { mesh_node: usize::MAX, world: Mat4::IDENTITY, verts, tris, material: mi, moving: false, skin: None, no_reflect: false, baked: false });
    }

    // ---- lights
    let mut out_lights: Vec<pc::Light> = Vec::new();
    for (ni, w, l) in &lights {
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
            let data = Blobs::push(&mut cook.blobs.tex, &tex.data, 4096);
            cook.textures.push(pc::Texture {
                name: "environment".into(),
                role: pc::TexRole::Environment,
                format: pc::TexFormat::Rgba16f,
                width: tex.size,
                height: tex.size,
                mips: tex.mips,
                data,
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

    // ---- static lighting baked into lit static surfaces
    let t_bake = Instant::now();
    let hemi = &sx["hemisphere"];
    let hemi_k = f(hemi, "intensity", 1.0);
    let env_scene = f(&env_meta, "intensity", 0.4);
    let env_arg = environment.map(|i| {
        let t = &cook.textures[i as usize];
        (&cook.blobs.tex[t.data.offset as usize..(t.data.offset + t.data.size) as usize], t.width, t.mips)
    });
    let baker = bake::Baker::new(&out_lights, (v3(&hemi["sky"]).map(|c| c * hemi_k), v3(&hemi["ground"]).map(|c| c * hemi_k)), env_arg);
    // Sky occlusion (`extras.bake.skyOcclusion`): every static surface that is
    // not glass or blended blocks the sky; cut-out foliage blocks part of it.
    let so = &sx["bake"]["skyOcclusion"];
    let occluder = so.is_object().then(|| {
        let t_occ = Instant::now();
        let mut tris = Vec::new();
        for p in prims.iter() {
            let m = &cook.materials[p.material as usize];
            if p.moving || p.skin.is_some() || m.kind == pc::Kind::Glass || m.blend != pc::Blend::Opaque {
                continue;
            }
            let opacity = if m.alpha_test > 0.0 { f(so, "foliage", 0.55) } else { 1.0 };
            for t in &p.tris {
                let (a, b, c) = (p.verts[t[0] as usize].pos, p.verts[t[1] as usize].pos, p.verts[t[2] as usize].pos);
                tris.push(occlusion::Tri { a, e1: b - a, e2: c - a, opacity });
            }
        }
        let n = tris.len();
        let occ = occlusion::Occluder::new(tris, f(so, "rays", 48.0) as usize, f(so, "reach", 8.0));
        println!("sky occlusion over {n} triangles (BVH in {} ms)", t_occ.elapsed().as_millis());
        occ
    });
    // Occlusion varies everywhere a surface meets another; split for it
    // only down to a coarser edge than for lamp pools.
    let tolerance = if occluder.is_some() {
        // Where the camera goes: the walkable boxes and every shot's ends.
        let cam = &sx["camera"];
        let mut lo = Vec3::splat(f32::MAX);
        let mut hi = Vec3::splat(f32::MIN);
        for b in cam["walkable"].as_array().into_iter().flatten() {
            let v: Vec<f32> = b.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
            if v.len() == 6 {
                lo = lo.min(Vec3::new(v[0], v[1], v[2]));
                hi = hi.max(Vec3::new(v[3], v[4], v[5]));
            }
        }
        for s in cam["shots"].as_array().into_iter().flatten() {
            for k in ["from", "to"] {
                let p = Vec3::from(v3(&s[k]["pos"]));
                lo = lo.min(p);
                hi = hi.max(p);
            }
        }
        bake::Tolerance {
            min_edge: f(so, "minEdge", 1.0),
            abs: f(so, "abs", 0.004),
            rel: f(so, "rel", 0.25),
            rounds: f(so, "rounds", 4.0) as u32,
            focus: (lo.x <= hi.x).then_some((lo, hi)),
            grow: f(so, "grow", 0.2),
        }
    } else {
        bake::LIGHTS
    };
    let (mut baked_prims, mut tris_before, mut tris_after) = (0usize, 0usize, 0usize);
    for p in prims.iter_mut() {
        let m = &cook.materials[p.material as usize];
        if p.moving || p.skin.is_some() || !matches!(m.kind, pc::Kind::Standard | pc::Kind::Glass) {
            continue;
        }
        // Shop interiors are shaded without the lights (as at runtime).
        let (env_k, direct) = (m.env_strength * env_scene, !m.interior);
        tris_before += p.tris.len();
        let before = p.tris.len();
        let r = bake::refine(
            std::mem::take(&mut p.verts),
            std::mem::take(&mut p.tris),
            &|pos, n| {
                let sky = occluder.as_ref().map_or(1.0, |o| o.visibility(pos, n));
                baker.irradiance(pos, n, env_k, direct, sky)
            },
            tolerance,
        );
        p.verts = r.verts;
        p.tris = r.tris;
        p.baked = true;
        if std::env::var_os("POCKET_ATLAS_BAKE_REPORT").is_some() {
            let (lo, hi) = p.verts.iter().fold((Vec3::splat(f32::MAX), Vec3::splat(f32::MIN)), |(lo, hi), v| (lo.min(v.pos), hi.max(v.pos)));
            println!("  bake {:>7} → {:>7}  {:40}  {:?}..{:?}", before, p.tris.len(), cook.materials[p.material as usize].name, lo.round(), hi.round());
        }
        tris_after += p.tris.len();
        baked_prims += 1;
    }
    println!("baked {baked_prims} primitives: {tris_before} → {tris_after} triangles ({} ms)", t_bake.elapsed().as_millis());
    cook.log.push(format!("bake {baked_prims} primitives, {tris_before} → {tris_after} triangles"));

    // ---- static chunking and draw building
    let mut draws: Vec<pc::Draw> = Vec::new();
    // Per bucket: vertices, triangles, and the positions on edges the chunk
    // shares with another chunk of the same primitive (locked in its LODs).
    type Bucket = (Vec<Vertex>, Vec<[u32; 3]>, HashSet<[u32; 3]>);
    let mut static_buckets: BTreeMap<(u32, Cell, bool, bool), Bucket> = BTreeMap::new();
    let mut scene_min = Vec3::splat(f32::MAX);
    let mut scene_max = Vec3::splat(f32::MIN);
    for p in &prims {
        if p.moving || p.skin.is_some() {
            continue;
        }
        // Open water is one draw however far it reaches: its cost is per
        // pixel, and chunks of it only add draws.
        let water = cook.materials[p.material as usize].kind == pc::Kind::Water;
        let cells: Vec<Cell> = p
            .tris
            .iter()
            .map(|t| if water { Cell::Whole } else { cell_at((p.verts[t[0] as usize].pos + p.verts[t[1] as usize].pos + p.verts[t[2] as usize].pos) / 3.0, a.cell, 0.0) })
            .collect();
        // Edges (by position, across attribute seams) whose triangles land in
        // different chunks.
        let mut edge_cell: HashMap<([u32; 3], [u32; 3]), Cell> = HashMap::new();
        let mut cut: HashSet<[u32; 3]> = HashSet::new();
        for (t, &cell) in p.tris.iter().zip(&cells) {
            for k in 0..3 {
                let (ka, kb) = (geometry::pos_bits(p.verts[t[k] as usize].pos), geometry::pos_bits(p.verts[t[(k + 1) % 3] as usize].pos));
                let e = if ka <= kb { (ka, kb) } else { (kb, ka) };
                let first = *edge_cell.entry(e).or_insert(cell);
                if first != cell {
                    cut.insert(e.0);
                    cut.insert(e.1);
                }
            }
        }
        for (t, &cell) in p.tris.iter().zip(&cells) {
            let e = static_buckets.entry((p.material, cell, p.no_reflect, p.baked)).or_default();
            let base = e.0.len() as u32;
            for &i in t {
                let pos = p.verts[i as usize].pos;
                e.0.push(p.verts[i as usize]);
                if cut.contains(&geometry::pos_bits(pos)) {
                    e.2.insert(geometry::pos_bits(pos));
                }
                scene_min = scene_min.min(pos);
                scene_max = scene_max.max(pos);
            }
            e.1.push([base, base + 1, base + 2]);
        }
    }
    let mats = cook.materials.clone();
    #[allow(clippy::too_many_arguments)]
    let emit = |verts: &[Vertex], tris: &[[u32; 3]], locks: Option<&HashSet<[u32; 3]>>, bounds: &[f32], material: u32, layout: pc::VertexLayout, node: Option<u32>, skin: Option<u32>, no_reflect: bool, blobs: &mut Blobs, draws: &mut Vec<pc::Draw>| {
        // Whole thin parts may vanish at distance only from static lit surfaces
        // without emission: signs and lamps stay, and people keep their limbs.
        let m = &mats[material as usize];
        let drop_parts = locks.is_some() && m.kind == pc::Kind::Standard && m.emissive.iter().all(|&e| e <= 0.0) && m.emission.is_none();
        for (v, t) in geometry::split(verts, tris) {
            let locked: Vec<bool> = v.iter().map(|v| locks.is_some_and(|l| l.contains(&geometry::pos_bits(v.pos)))).collect();
            let b = geometry::build(&v, &t, layout, geometry::lods(&v, &t, &locked, drop_parts, bounds), a.target == ir::Target::Vita);
            push_draw(b, material, layout, node, skin, no_reflect, blobs, draws);
        }
    };
    // Shelf stock: groups of items near each other, full stand-ins plus the
    // LOD1 cards in one vertex buffer.
    let mut stock_groups: BTreeMap<(u32, i32, i32), Vec<&Stock>> = BTreeMap::new();
    for s in &stock {
        stock_groups.entry((s.material, (s.center.x / 4.0).floor() as i32, (s.center.z / 4.0).floor() as i32)).or_default().push(s);
    }
    let emit_stock = |blobs: &mut Blobs, draws: &mut Vec<pc::Draw>| {
        for ((material, _, _), items) in &stock_groups {
            let mut start = 0;
            while start < items.len() {
                let (mut verts, mut tris, mut cards) = (Vec::new(), Vec::new(), Vec::new());
                let (mut end, mut count) = (start, 0);
                while end < items.len() && count + items[end].full.0.len() + items[end].card.0.len() <= 65535 {
                    count += items[end].full.0.len() + items[end].card.0.len();
                    end += 1;
                }
                // Full stand-ins first, then the cards, all in one buffer.
                for s in &items[start..end] {
                    let base = verts.len() as u32;
                    verts.extend_from_slice(&s.full.0);
                    tris.extend(s.full.1.iter().map(|t| t.map(|i| i + base)));
                }
                for s in &items[start..end] {
                    let base = verts.len() as u32;
                    verts.extend_from_slice(&s.card.0);
                    cards.extend(s.card.1.iter().map(|t| t.map(|i| i + base)));
                }
                let cards = geometry::cache_order(&cards, verts.len());
                // Cards replace items beyond a few metres (a small nominal
                // error puts the switch at ~4 m at 640×362).
                let b = geometry::build(&verts, &tris, pc::VertexLayout::Static, vec![(cards, 0.012)], a.target == ir::Target::Vita);
                push_draw(b, *material, pc::VertexLayout::Static, None, None, true, blobs, draws);
                start = end;
            }
        }
    };
    for ((material, cell, no_reflect, baked), (verts, tris, locks)) in &static_buckets {
        // Weld identical vertices inside the bucket.
        let mut map: HashMap<[u32; 11], u32> = HashMap::new();
        let mut uv: Vec<Vertex> = Vec::new();
        let mut ut: Vec<[u32; 3]> = Vec::with_capacity(tris.len());
        for t in tris {
            let mut r = [0; 3];
            for (k, &i) in t.iter().enumerate() {
                let v = verts[i as usize];
                let key = [
                    v.pos.x.to_bits(),
                    v.pos.y.to_bits(),
                    v.pos.z.to_bits(),
                    v.normal.x.to_bits(),
                    v.normal.y.to_bits(),
                    v.normal.z.to_bits(),
                    v.uv.x.to_bits(),
                    v.uv.y.to_bits(),
                    u32::from_le_bytes(v.color),
                    v.tangent[3].to_bits(),
                    u32::from_le_bytes(v.light),
                ];
                r[k] = *map.entry(key).or_insert_with(|| {
                    uv.push(v);
                    (uv.len() - 1) as u32
                });
            }
            ut.push(r);
        }
        let layout = if *baked { pc::VertexLayout::Baked } else { pc::VertexLayout::Static };
        emit(&uv, &ut, Some(locks), &lod_bounds(*cell), *material, layout, None, None, *no_reflect, &mut cook.blobs, &mut draws);
    }
    emit_stock(&mut cook.blobs, &mut draws);
    let static_draws = draws.len();
    for p in &prims {
        if !(p.moving || p.skin.is_some()) {
            continue;
        }
        let skin = p.skin.map(|s| skin_ids[&s]);
        let node = if skin.is_none() { node_ids.get(&p.mesh_node).copied() } else { None };
        let layout = if skin.is_some() { pc::VertexLayout::Skinned } else { pc::VertexLayout::Static };
        emit(&p.verts, &p.tris, None, &lod_bounds(Cell::Whole), p.material, layout, node, skin, false, &mut cook.blobs, &mut draws);
    }
    let _ = &prims.iter().map(|p| p.world).count();

    // ---- light fields: one vertex per light, by geometry's cells (no
    // smaller than 512 m), at most `LightPoint::PER_DRAW` per draw. Twice
    // those cells drew 32 instead of 47 field draws at Griffith
    // Observatory's Lawn but cost 0.64 ms more GPU: the clipper's work on
    // 20 000 more lights outside the view outweighs 15 draws.
    let mut field_cells: BTreeMap<(u32, Cell), Vec<pc::LightPoint>> = BTreeMap::new();
    for (material, l) in &field {
        let (lo, hi) = l.bounds();
        field_cells.entry((*material, cell_at((Vec3::from(lo) + Vec3::from(hi)) * 0.5, a.cell, 512.0))).or_default().push(*l);
    }
    let field_draws = draws.len();
    for ((material, _), lights) in &field_cells {
        for chunk in lights.chunks(pc::LightPoint::PER_DRAW) {
            let (mut plo, mut phi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
            let (mut lo, mut hi) = (plo, phi);
            for l in chunk {
                plo = plo.min(Vec3::from(l.position));
                phi = phi.max(Vec3::from(l.position));
                let (a, b) = l.bounds();
                lo = lo.min(Vec3::from(a));
                hi = hi.max(Vec3::from(b));
            }
            let (center, half) = ((plo + phi) * 0.5, ((phi - plo) * 0.5).max(Vec3::splat(1e-3)));
            let mut bytes = Vec::with_capacity(chunk.len() * pc::LightPoint::STRIDE);
            for l in chunk {
                l.encode(center.to_array(), half.to_array(), &mut bytes);
            }
            scene_min = scene_min.min(lo);
            scene_max = scene_max.max(hi);
            draws.push(pc::Draw {
                material: *material,
                layout: pc::VertexLayout::Lights,
                vertices: Blobs::push(&mut cook.blobs.geom, &bytes, 16),
                vertex_count: chunk.len() as u32,
                indices: pc::Range::default(),
                index_count: chunk.len() as u32,
                pos_offset: center.to_array(),
                pos_scale: half.to_array(),
                uv_offset: [0.0; 2],
                uv_scale: [1.0; 2],
                min: lo.to_array(),
                max: hi.to_array(),
                node: None,
                skin: None,
                no_reflect: true,
                cast_shadow: false,
                lods: Vec::new(),
            });
        }
    }
    let field_draws = draws.len() - field_draws;

    // ---- fog lights and scalar tracks
    let tracks = sx.get("tracks").cloned().unwrap_or(Value::Null);
    let mut fog_tracks = Vec::new();
    let mut fog_track_of: HashMap<usize, u32> = HashMap::new();
    if let Some(ft) = tracks.get("fogs").and_then(|v| v.as_array()) {
        for t in ft {
            let fi = t["fog"].as_u64().unwrap_or(0) as usize;
            let p: Vec<f32> = t["position"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
            let g: Vec<f32> = t["gain"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
            let n = g.len();
            let mut data = Vec::with_capacity(n * 4);
            for k in 0..n {
                data.extend([p[k * 3], p[k * 3 + 1], p[k * 3 + 2], g[k]]);
            }
            fog_tracks.push(pc::FogTrack { data: Blobs::floats(&mut cook.blobs.anim, &data) });
            fog_track_of.insert(fi, (fog_tracks.len() - 1) as u32);
        }
    }
    let fog_lights: Vec<pc::FogLight> = sx
        .get("fogLights")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .enumerate()
                .map(|(i, l)| pc::FogLight {
                    position: v3(&l["position"]),
                    color: v3(&l["color"]),
                    intensity: f(l, "intensity", 1.0),
                    radius: f(l, "radius", 1.0),
                    spot: l.get("spot").filter(|s| !s.is_null()).map(|s| (v3(&s["direction"]), f(s, "cosOuter", 0.5), f(s, "cosInner", 0.9))),
                    track: fog_track_of.get(&i).copied(),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut material_tracks = Vec::new();
    if let Some(mt) = tracks.get("materials").and_then(|v| v.as_array()) {
        for t in mt {
            let name = t["material"].as_str().unwrap_or("");
            let vals: Vec<f32> = t["emissiveIntensity"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
            if let Some(&mi) = cook.material_names.get(name) {
                let base = vals.iter().cloned().fold(0.0f32, f32::max).max(1e-4);
                let data: Vec<f32> = vals.iter().map(|v| v / base).collect();
                material_tracks.push(pc::MaterialTrack { data: Blobs::floats(&mut cook.blobs.anim, &data) });
                cook.materials[mi as usize].emissive_track = Some((material_tracks.len() - 1) as u32);
            }
        }
    }
    let track_frames = tracks.get("frames").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    // ---- atmosphere, rain, camera, doors
    let fog = &sx["fog"];
    let haze = &sx["haze"];
    let hemi = &sx["hemisphere"];
    let sky = &sx["sky"];
    let atmosphere = pc::Atmosphere {
        fog_color: v3(&fog["color"]),
        fog_density: f(fog, "density", 0.02),
        haze_density: f(haze, "density", 0.015),
        haze_ambient: v3(&haze["ambient"]),
        haze_ambient_density: f(haze, "ambientDensity", 0.01),
        dry_min: v3(&haze["dryBox"]["min"]),
        dry_max: v3(&haze["dryBox"]["max"]),
        hemisphere_sky: v3(&hemi["sky"]).map(|c| c * f(hemi, "intensity", 1.0)),
        hemisphere_ground: v3(&hemi["ground"]).map(|c| c * f(hemi, "intensity", 1.0)),
        sky_zenith: v3(&sky["zenith"]),
        sky_horizon: v3(&sky["horizon"]),
        sky_glow: v3(&sky["glow"]),
        environment,
        environment_strength: f(&env_meta, "intensity", 0.4),
    };
    let pairs = |k: &str| -> Vec<[[f32; 3]; 2]> { sx["rain"][k].as_array().map(|a| a.iter().map(|p| [v3(&p[0]), v3(&p[1])]).collect()).unwrap_or_default() };
    let rain = pc::Rain {
        active: sx["rain"].is_object(),
        dry_boxes: pairs("dryBoxes"),
        drip_edges: pairs("dripEdges"),
        steam_vents: sx["rain"]["steamVents"].as_array().map(|a| a.iter().map(|v| [v3(&v["origin"]), v3(&v["dir"])]).collect()).unwrap_or_default(),
    };
    let key = |k: &Value| pc::ShotKey { pos: v3(&k["pos"]), target: v3(&k["target"]), fov: f(k, "fov", 40.0) };
    let cam = &sx["camera"];
    let camera = pc::CameraSet {
        shots: cam["shots"].as_array().map(|a| a.iter().map(|s| pc::Shot { name: s["name"].as_str().unwrap_or("").into(), from: key(&s["from"]), to: key(&s["to"]), duration: f(s, "duration", 10.0) }).collect()).unwrap_or_default(),
        walkable: cam["walkable"].as_array().map(|a| a.iter().map(|b| {
            let v: Vec<f32> = b.as_array().unwrap().iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
            [v[0], v[1], v[2], v[3], v[4], v[5]]
        }).collect()).unwrap_or_default(),
        intro: key(&cam["intro"]),
    };
    let node_by_name = |name: &str| -> Option<u32> { doc.nodes().find(|n| n.name() == Some(name)).and_then(|n| node_ids.get(&n.index()).copied()) };
    let doors = sx.get("doors").and_then(|d| {
        Some(pc::Doors {
            left: node_by_name(d["left"].as_str()?)?,
            right: node_by_name(d["right"].as_str()?)?,
            travel: f(d, "travel", 1.0),
            trigger: v3(&d["trigger"]),
            radius: f(d, "radius", 3.0),
        })
    });
    let beacons = sx["beacons"].as_array().map(|a| a.iter().map(v3).collect()).unwrap_or_default();

    // ---- effect lookup textures
    let t_fx = Instant::now();
    let dump = std::env::var_os("POCKET_ATLAS_DUMP_EFFECTS").is_some();
    let out_dir = a.output.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut effect = |name: &str, img: textures::Rgba, format: pc::TexFormat, mips: u32, wrap: pc::Wrap| -> u32 {
        if dump {
            let bytes: Vec<u8> = img.px.iter().flat_map(|p| p.map(|c| (c.clamp(0.0, 1.0) * 255.0) as u8)).collect();
            let _ = image::save_buffer(out_dir.join(format!("{name}.png")), &bytes, img.w, img.h, image::ColorType::Rgba8);
        }
        let enc = if a.target == ir::Target::Vita { textures::encode_as(&img, pc::TexRole::Data, format, 4096, mips) } else {
            textures::Encoded { format: pc::TexFormat::Rgba8, width: img.w, height: img.h, mips: 1,
                data: img.px.iter().flat_map(|p| p.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)).collect() }
        };
        let data = Blobs::push(&mut cook.blobs.tex, &enc.data, 4096);
        cook.log.push(format!("effect {name} {:?} {}x{} ×{} ({} KiB)", enc.format, enc.width, enc.height, enc.mips, enc.data.len() / 1024));
        cook.textures.push(pc::Texture {
            name: name.into(),
            role: pc::TexRole::Data,
            format: enc.format,
            width: enc.width,
            height: enc.height,
            mips: enc.mips,
            data,
            wrap_s: wrap,
            wrap_t: wrap,
            has_alpha: false,
            mean: [0.0; 4],
                lod_bias: 0.0,
        });
        (cook.textures.len() - 1) as u32
    };
    let ripple_grid = 4;
    let effects = pc::Effects {
        puddles: Some(effect("fx-puddles", procedural::puddles(512), pc::TexFormat::Bc5, 12, pc::Wrap::Repeat)),
        // 16 frames of 256² over 4 drop cells; mips stop before frames bleed.
        ripples: Some(effect("fx-ripples", procedural::ripples(256, ripple_grid, 4.0), pc::TexFormat::Bc5, 4, pc::Wrap::Repeat)),
        ripple_grid,
        ripple_tile: 4.0 / 2.3,
        beads: Some(effect("fx-beads", procedural::beads(1024), pc::TexFormat::Bc1, 12, pc::Wrap::Repeat)),
        clouds: Some(effect("fx-clouds", procedural::clouds(512, 16.0), pc::TexFormat::Bc5, 12, pc::Wrap::Repeat)),
        cloud_cells: 16.0,
    };
    println!("effect textures in {} ms", t_fx.elapsed().as_millis());

    let tri_count: u32 = draws.iter().filter(|d| d.layout != pc::VertexLayout::Lights).map(|d| d.index_count / 3).sum();
    let stats = json!({
        "draws": draws.len(),
        "staticDraws": static_draws,
        "triangles": tri_count,
        "textures": cook.textures.len(),
        "materials": cook.materials.len(),
        "nodes": nodes.len(),
        "animatedNodes": nodes.iter().filter(|n| n.track.is_some()).count(),
        "skins": skins.len(),
        "lights": out_lights.len(),
        "fieldLights": field.len(),
        "fieldDraws": field_draws,
        "fogLights": fog_lights.len(),
        "textureBytes": cook.blobs.tex.len(),
        "geometryBytes": cook.blobs.geom.len(),
        "animationBytes": cook.blobs.anim.len(),
    });
    // ---- sun, daytime sky, post
    let sun = sx["directionalLights"].as_array().and_then(|a| a.first()).map(|d| {
        let c = v3(&d["color"]);
        let i = f(d, "intensity", 1.0);
        let sh = &d["shadow"];
        pc::Sun {
            direction: v3(&d["direction"]),
            radiance: [c[0] * i, c[1] * i, c[2] * i],
            shadow: (d["castShadow"].as_bool() == Some(true) && sh.is_object()).then(|| {
                let o: Vec<f32> = sh["ortho"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
                pc::SunShadow {
                    position: v3(&sh["position"]),
                    ortho: [o[0], o[1], o[2], o[3], o[4], o[5]],
                    map_size: sh["mapSize"].as_u64().unwrap_or(2048) as u32,
                    bias: f(sh, "bias", 0.0),
                    normal_bias: f(sh, "normalBias", 0.0),
                    radius: f(sh, "radius", 1.0),
                }
            }),
        }
    });
    let sky_day = &sx["sky"];
    let day_sky = (sky_day["model"] == "gradient-sun-cloudpanorama").then(|| {
        let cl = &sky_day["clouds"];
        let clouds = cl["file"].as_str().and_then(|file| {
            let img = image::open(a.input.join(file)).ok()?.to_rgba8();
            let (w, h) = img.dimensions();
            // The panorama's rows run bottom-up (three.js flipY); texture rows here run top-down.
            let mut rows = Vec::with_capacity((w * h * 4) as usize);
            for y in (0..h).rev() {
                rows.extend_from_slice(&img.as_raw()[(y * w * 4) as usize..((y + 1) * w * 4) as usize]);
            }
            let src = textures::from_rgba8(w, h, &rows, pc::TexRole::Data);
            let e = textures::encode_as(&src, pc::TexRole::Data, pc::TexFormat::Rgba8, 1024, 1);
            let data = Blobs::push(&mut cook.blobs.tex, &e.data, 4096);
            cook.textures.push(pc::Texture {
                name: "sky-clouds".into(),
                role: pc::TexRole::Data,
                format: e.format,
                width: e.width,
                height: e.height,
                mips: e.mips,
                data,
                wrap_s: pc::Wrap::Repeat,
                wrap_t: pc::Wrap::Clamp,
                has_alpha: false,
                mean: [0.0; 4],
                lod_bias: 0.0,
            });
            Some((cook.textures.len() - 1) as u32)
        });
        let pair = |v: &Value| [v[0].as_f64().unwrap_or(0.0) as f32, v[1].as_f64().unwrap_or(1.0) as f32];
        let sun_scale = f(cl, "sunScale", 1.0);
        let cs = v3(&cl["sunColor"]);
        pc::DaySky {
            zenith: v3(&sky_day["zenith"]),
            horizon: v3(&sky_day["horizon"]),
            ground: v3(&sky_day["ground"]),
            gradient_power: f(sky_day, "gradientPower", 0.5),
            ground_blend: f(sky_day, "groundBlend", 6.0),
            sun_direction: v3(&sky_day["sunDirection"]),
            sun_color: v3(&sky_day["sunColor"]),
            glow: f(&sky_day["glow"], "intensity", 0.0),
            glow_wide: pair(&sky_day["glow"]["wide"]),
            glow_tight: pair(&sky_day["glow"]["tight"]),
            disc: f(&sky_day["disc"], "intensity", 0.0),
            disc_cos_inner: f(&sky_day["disc"], "cosInner", 1.0),
            disc_cos_outer: f(&sky_day["disc"], "cosOuter", 1.0),
            clouds,
            cloud_sun: [cs[0] * sun_scale, cs[1] * sun_scale, cs[2] * sun_scale],
            cloud_ambient: v3(&cl["ambientColor"]),
            fade_elevation: f(cl, "fadeElevation", 0.04),
            drift: f(cl, "driftTurnsPerSecond", 0.0),
            twilight: sky_day["twilight"].is_object().then(|| extras::twilight(&sky_day["twilight"])),
        }
    });
    let px = &sx["post"];
    let post = if px.is_object() {
        let d = pc::Post::default();
        pc::Post {
            tone: if px["tone"] == "aces" { pc::ToneCurve::Aces } else { pc::ToneCurve::Agx },
            exposure: f(px, "exposure", d.exposure),
            contrast: f(px, "contrast", d.contrast),
            saturation: f(px, "saturation", d.saturation),
            lift: if px["lift"].is_array() { v3(&px["lift"]) } else { d.lift },
            gain: if px["gain"].is_array() { v3(&px["gain"]) } else { d.gain },
            vignette: f(px, "vignette", d.vignette),
            grain: f(px, "grain", d.grain),
            bloom_threshold: f(px, "bloomThreshold", d.bloom_threshold),
            bloom_smoothing: f(px, "bloomSmoothing", d.bloom_smoothing),
            bloom_intensity: f(px, "bloomIntensity", d.bloom_intensity),
        }
    } else {
        pc::Post::default()
    };
    let place = manifest.name;
    let meta = pc::Meta {
        version: pc::VERSION,
        name: place,
        kind: sx["kind"].as_str().unwrap_or("night-street").to_string(),
        min: scene_min.to_array(),
        max: scene_max.to_array(),
        textures: cook.textures,
        materials: cook.materials,
        draws,
        nodes,
        skins,
        lights: out_lights,
        fog_lights,
        fog_tracks,
        material_tracks,
        fps,
        frames: frames.max(track_frames),
        atmosphere,
        rain,
        camera,
        doors,
        beacons,
        effects,
        sun,
        day_sky,
        post,
        vista_haze: extras::vista_haze(&sx["haze"]),
        stats: stats.clone(),
    };
    if a.target != ir::Target::Vita {
        let source = source::Scene { meta, blobs: cook.blobs };
        match a.target {
            ir::Target::Pica => pica::cook(&source, &a.output, a.tex_cap.min(1024)),
            ir::Target::Psp => psp::cook(&source, &a.output),
            ir::Target::Vita => unreachable!(),
        }
        std::fs::write(a.output.with_extension("log"), cook.log.join("\n") + "\n").unwrap();
        return;
    }
    let meta_json = serde_json::to_vec(&meta).unwrap();
    let pack = pc::write(&[
        (pc::TAG_META, &meta_json, 16),
        (pc::TAG_TEXTURES, &cook.blobs.tex, 4096),
        (pc::TAG_GEOMETRY, &cook.blobs.geom, 4096),
        (pc::TAG_ANIMATION, &cook.blobs.anim, 16),
    ]);
    std::fs::write(&a.output, &pack).unwrap();
    std::fs::write(a.output.with_extension("log"), cook.log.join("\n") + "\n").unwrap();
    println!("{}", serde_json::to_string_pretty(&stats).unwrap());
    println!("wrote {} ({:.1} MiB)", a.output.display(), pack.len() as f64 / 1048576.0);
    let _ = Vec4::ZERO;
}

#[cfg(test)]
mod tests {
    use super::*;

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
