//! Static Products appearance recipe. Bake the material function, retaining
//! every original mesh/LOD triangle; this is not a shelf impostor.
use super::{pc, Result};
use crate::source::{Scene, TexturePolicy};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

const TILE: u32 = 32;
const BORDER: u32 = 2;
const INNER: u32 = TILE - BORDER * 2;
#[derive(Default)]
pub(super) struct Recipe {
    pub draws: BTreeMap<usize, Mapping>,
    pub receipts: Vec<serde_json::Value>,
}
pub(super) struct Mapping {
    pub texture: u32,
    pub uv: Vec<[f32; 2]>,
}
fn decode(s: f32) -> f32 {
    s * (s * (s * 0.305306011 + 0.682171111) + 0.012522878)
}
struct Art<'a> {
    texture: &'a pc::Texture,
    bytes: &'a [u8],
}
impl Art<'_> {
    fn sample(&self, uv: [f32; 2]) -> [f32; 3] {
        let t = self.texture;
        let wrap = |v: i32, n: u32, w: pc::Wrap| -> usize {
            match w {
                pc::Wrap::Clamp => v.clamp(0, n as i32 - 1) as usize,
                pc::Wrap::Repeat => v.rem_euclid(n as i32) as usize,
                pc::Wrap::Mirror => {
                    let v = v.rem_euclid(n as i32 * 2);
                    if v < n as i32 {
                        v as usize
                    } else {
                        (n as i32 * 2 - 1 - v) as usize
                    }
                }
            }
        };
        let p = [uv[0] * t.width as f32 - 0.5, uv[1] * t.height as f32 - 0.5];
        let lo = p.map(|v| v.floor());
        let f = [p[0] - lo[0], p[1] - lo[1]];
        let pixel = |x, y, k| {
            self.bytes[(wrap(y, t.height, t.wrap_t) * t.width as usize
                + wrap(x, t.width, t.wrap_s))
                * 4
                + k] as f32
                / 255.
        };
        core::array::from_fn(|k| {
            let row =
                |y| pixel(lo[0] as i32, y, k) * (1. - f[0]) + pixel(lo[0] as i32 + 1, y, k) * f[0];
            decode(row(lo[1] as i32) * (1. - f[1]) + row(lo[1] as i32 + 1) * f[1])
        })
    }
}
fn shade(
    seed: [u8; 3],
    m: &pc::Material,
    art: &Art<'_>,
    u: f32,
    v: f32,
    height: f32,
    post: &pc::Post,
) -> [f32; 3] {
    let [h, band] = pc::products::package_params(seed);
    let package = art.sample([
        h * 0.93 + (u - u.floor()) * 0.055,
        (band + 0.08 + v.clamp(0., 1.) * 0.8) / 8.,
    ]);
    let side = if (0.004..=0.996).contains(&height) {
        1.
    } else {
        0.
    };
    let mix = 0.85 * side * (0.75 + 0.25 * h);
    let radiance = core::array::from_fn(|k| {
        let base = m.color[k] * decode(seed[k] as f32 / 255.);
        (base * (1. - mix) + package[k] * 1.15 * mix)
            * (0.78 + 0.22 * height.clamp(0., 1.))
            * m.emissive[0]
    });
    pc::color::tone(radiance, post)
}

pub(super) fn bake(source: &Scene, meta: &mut pc::Meta, pixels: &mut Vec<u8>) -> Result<Recipe> {
    let mut recipe = Recipe::default();
    for (mi, m) in source.meta.materials.iter().enumerate() {
        if m.kind != pc::Kind::Products
            || m.blend != pc::Blend::Opaque
            || !m.depth_write
            || m.alpha_test > 0.
            || m.uv_anim.is_some()
            || m.emissive_track.is_some()
            || m.emission.is_some()
            || m.emission_shade.is_some()
            || m.wet.is_some()
        {
            continue;
        }
        let Some(ti) = m.albedo else { continue };
        let t = &source.meta.textures[ti as usize];
        if t.format != pc::TexFormat::Rgba8 || t.mips != 1 {
            return Err("Products requires original RGBA source".into());
        }
        let data = pc::parts::slice(source.textures(), &t.data)?;
        if data.len() != t.width as usize * t.height as usize * 4 {
            return Err("Products source texture range".into());
        }
        let art = Art {
            texture: t,
            bytes: data,
        };
        let mut draws = Vec::new();
        let mut seeds = BTreeSet::new();
        for (di, d) in source.meta.draws.iter().enumerate() {
            if d.material as usize != mi
                || d.node.is_some()
                || d.skin.is_some()
                || d.layout != pc::VertexLayout::Static
            {
                continue;
            }
            let vertices = &source.blobs.meshes[d.vertices.offset as usize];
            // The recipe has two surface parameters, u and normalized item
            // height. Reject arbitrary authored Products meshes that need an
            // independent third alpha coordinate or cross-seed interpolation.
            if vertices.iter().any(|v| {
                v.uv.x < 0.
                    || v.uv.x > 1.
                    || v.uv.y < 0.
                    || v.uv.y > 1.
                    || (v.uv.y - v.color[3] as f32 / 255.).abs() > 0.5 / 255. + 1e-6
            }) {
                continue;
            }
            let mut valid = true;
            for range in core::iter::once(&d.indices).chain(d.lods.iter().map(|l| &l.indices)) {
                for tri in pc::parts::slice(source.geometry(), range)?.chunks_exact(6) {
                    let ids: [usize; 3] = core::array::from_fn(|k| {
                        u16::from_le_bytes([tri[k * 2], tri[k * 2 + 1]]) as usize
                    });
                    let seed = vertices[ids[0]].color[..3].to_vec();
                    if ids.iter().any(|&i| vertices[i].color[..3] != seed) {
                        valid = false;
                        break;
                    }
                }
            }
            if !valid {
                continue;
            }
            for v in vertices {
                seeds.insert(<[u8; 3]>::try_from(&v.color[..3]).unwrap());
            }
            draws.push(di);
        }
        if draws.is_empty() || seeds.len() > 1024 {
            continue;
        }
        let cols = (seeds.len() as f64).sqrt().ceil() as u32;
        let cols = cols.next_power_of_two();
        let rows = (seeds.len() as u32).div_ceil(cols).next_power_of_two();
        let (w, h) = (cols * TILE, rows * TILE);
        let mut bytes = vec![0; w as usize * h as usize * 4];
        let mut tiles = BTreeMap::new();
        for (i, seed) in seeds.into_iter().enumerate() {
            let (tx, ty) = (i as u32 % cols * TILE, i as u32 / cols * TILE);
            tiles.insert(seed, (tx, ty));
            for y in 0..TILE {
                for x in 0..TILE {
                    let u = (x as i32 - BORDER as i32).clamp(0, INNER as i32 - 1) as f32
                        / (INNER - 1) as f32;
                    let v = (y as i32 - BORDER as i32).clamp(0, INNER as i32 - 1) as f32
                        / (INNER - 1) as f32;
                    let color = shade(seed, m, &art, u, v, v, &meta.post);
                    let at = (((ty + y) * w + tx + x) * 4) as usize;
                    for k in 0..3 {
                        bytes[at + k] = (color[k].clamp(0., 1.) * 255. + 0.5) as u8;
                    }
                    bytes[at + 3] = 255;
                }
            }
        }
        // Report observed display-space interpolation error, including the
        // shader's discontinuous cap/side and wrap boundaries. This is a
        // deterministic sample receipt, not a global error bound.
        let mut square_error = 0.0f64;
        let mut max_error = 0.0f32;
        let mut samples = 0usize;
        for (&seed, &(x, y)) in &tiles {
            let coordinates = (0..16)
                .flat_map(|v| {
                    (0..16).map(move |u| ((u as f32 + 0.5) / 16., (v as f32 + 0.5) / 16.))
                })
                .chain(
                    [0., 0.002, 0.004, 0.01, 0.5, 0.99, 0.996, 0.998, 1.]
                        .into_iter()
                        .map(|v| (0.5, v)),
                );
            for (u, v) in coordinates {
                let p = [
                    x as f32 + BORDER as f32 + u * (INNER - 1) as f32,
                    y as f32 + BORDER as f32 + v * (INNER - 1) as f32,
                ];
                let lo = p.map(|x| x.floor() as u32);
                let f = [p[0] - lo[0] as f32, p[1] - lo[1] as f32];
                let exact = shade(seed, m, &art, u, v, v, &meta.post);
                for k in 0..3 {
                    let at = |x, y| bytes[((y * w + x) * 4) as usize + k] as f32 / 255.;
                    let row = |y| at(lo[0], y) * (1. - f[0]) + at(lo[0] + 1, y) * f[0];
                    let approx = row(lo[1]) * (1. - f[1]) + row(lo[1] + 1) * f[1];
                    let error = (approx - exact[k]).abs();
                    max_error = max_error.max(error);
                    square_error += (error * error) as f64;
                    samples += 1;
                }
            }
        }
        let mut texture = t.clone();
        texture.name = format!("products-appearance-v1-{mi}");
        texture.width = w;
        texture.height = h;
        texture.mips = 1;
        texture.data = pc::Range {
            offset: 0,
            size: bytes.len() as u32,
        };
        texture.wrap_s = pc::Wrap::Clamp;
        texture.wrap_t = pc::Wrap::Clamp;
        texture.has_alpha = false;
        let (mut texture, bytes) = super::lower_texture(
            &texture,
            &bytes,
            1024,
            TexturePolicy {
                cells: (cols, rows),
                max_mips: 32,
            },
        )?;
        texture.data = super::append(pixels, &bytes, 16)?;
        let texture_index = meta.textures.len() as u32;
        meta.textures.push(texture);
        for &di in &draws {
            let d = &source.meta.draws[di];
            let vertices = &source.blobs.meshes[d.vertices.offset as usize];
            let uv = vertices
                .iter()
                .map(|v| {
                    let seed = <[u8; 3]>::try_from(&v.color[..3]).unwrap();
                    let (x, y) = tiles[&seed];
                    [
                        (x as f32 + BORDER as f32 + 0.5 + v.uv.x * (INNER - 1) as f32) / w as f32,
                        (y as f32 + BORDER as f32 + 0.5 + v.uv.y * (INNER - 1) as f32) / h as f32,
                    ]
                })
                .collect();
            recipe.draws.insert(
                di,
                Mapping {
                    texture: texture_index,
                    uv,
                },
            );
        }
        recipe.receipts.push(json!({"kind":"products-appearance","version":1,"draws":draws,"textures":[texture_index],"tileSize":TILE,"border":BORDER,"parameterization":"uv-height-v1","seeds":tiles.len(),"maxVertexHeightParameterError":0.5/255.0,"sampledRgbRmse":(square_error/samples as f64).sqrt(),"sampledRgbMaxError":max_error,"errorSamples":samples,"approximation":"finite 28x28 appearance samples; CPU package hash and Gouraud height; source geometry and all LODs retained"}));
    }
    Ok(recipe)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Scene {
        let (mut meta, _, mut geometry) = super::super::gles_geometry::tests::fixture();
        meta.nodes.clear();
        meta.draws.truncate(1);
        let m = &mut meta.materials[0];
        m.kind = pc::Kind::Products;
        m.emissive = [1.2, 0.85, 0.];
        m.color = [0.8, 0.7, 0.6, 1.];
        let t = &mut meta.textures[0];
        t.width = 4;
        t.height = 4;
        t.data = pc::Range {
            offset: 0,
            size: 64,
        };
        let d = &mut meta.draws[0];
        d.layout = pc::VertexLayout::Static;
        let mut vertices = Vec::new();
        for (x, y) in [(0., 0.), (1., 0.), (1., 1.), (0., 1.)] {
            vertices.push(crate::geometry::Vertex {
                pos: glam::Vec3::new(x, y, 0.),
                uv: glam::Vec2::new(x, y),
                normal: glam::Vec3::Z,
                tangent: [1., 0., 0., 1.],
                color: [80, 160, 210, (y * 255.) as u8],
                ..Default::default()
            });
        }
        d.vertices = pc::Range { offset: 0, size: 0 };
        // Existing indices/LODs remain byte-for-byte source analysis output.
        let mut blobs = crate::Blobs::default();
        blobs.geom = core::mem::take(&mut geometry);
        blobs.meshes.push(vertices);
        blobs.tex = [230, 90, 40, 255].repeat(16);
        Scene { meta, blobs }
    }
    #[test]
    fn products_preserve_mesh_and_lods_with_declared_uv_recipe() {
        let src = source();
        let (bytes, recipe, _) = super::super::lower(&src, 512, None).unwrap();
        assert_eq!(recipe.draws.len(), 1);
        let pack = pc::ipod::parse(&bytes).unwrap();
        let meta = pack.meta().unwrap();
        let d = &meta.draws[0];
        let geom = pack.section(pc::TAG_GEOMETRY).unwrap();
        for i in 0..d.vertex_count {
            assert_eq!(
                pc::ipod::position(d, geom, i as u16).unwrap(),
                src.vertex(&src.meta.draws[0], i as usize).pos.to_array()
            );
        }
        for (a, b) in core::iter::once((&d.indices, &src.meta.draws[0].indices)).chain(
            d.lods
                .iter()
                .zip(&src.meta.draws[0].lods)
                .map(|(a, b)| (&a.indices, &b.indices)),
        ) {
            assert_eq!(
                pc::parts::slice(geom, a).unwrap(),
                pc::parts::slice(src.geometry(), b).unwrap()
            );
        }
        let colors = super::super::gles_colors::adapt_with_recipe(&bytes, &recipe).unwrap();
        let j: serde_json::Value = serde_json::from_slice(&colors.json).unwrap();
        assert_eq!(j["draws"][0]["flags"], 64);
        assert_eq!(j["recipes"][0]["version"], 1);
        assert!(recipe.draws[&0]
            .uv
            .iter()
            .flatten()
            .all(|x| x.is_finite() && *x >= 0. && *x <= 1.));
        for v in colors.bytes.chunks_exact(24) {
            assert_eq!(&v[20..24], &[255; 4]);
        }
        let texture = &meta.textures[recipe.draws[&0].texture as usize];
        let atlas =
            pc::parts::slice(pack.section(pc::TAG_TEXTURES).unwrap(), &texture.data).unwrap();
        let art = Art {
            texture: &src.meta.textures[0],
            bytes: src.textures(),
        };
        // At all stored tile centers, exact material shade + tone is the
        // texel definition. Top and bottom caps do not sample packaging art.
        for (x, y) in [(0, 0), (7, 13), (27, 27)] {
            let exact = shade(
                [80, 160, 210],
                &src.meta.materials[0],
                &art,
                x as f32 / 27.,
                y as f32 / 27.,
                y as f32 / 27.,
                &meta.post,
            );
            let at = (((y + BORDER) * texture.width + x + BORDER) * 4) as usize;
            assert_eq!(
                &atlas[at..at + 3],
                &exact.map(|v| (v.clamp(0., 1.) * 255. + 0.5) as u8)
            );
        }
    }
    #[test]
    fn unsupported_parameter_or_animation_uses_original_material() {
        for mode in 0..3 {
            let mut src = source();
            if mode == 0 {
                src.blobs.meshes[0][0].color[3] = 128;
            } else if mode == 1 {
                src.meta.materials[0].emissive_track = Some(0);
            } else {
                src.blobs.meshes[0][0].color[0] = 5;
            }
            let mut meta = src.meta.clone();
            let mut pixels = Vec::new();
            assert!(bake(&src, &mut meta, &mut pixels).unwrap().draws.is_empty());
            assert!(pixels.is_empty());
        }
    }
}
