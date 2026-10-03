//! Optional display-referred colors for the GLES throughput renderer.
//! Original geometry, materials and animation remain in PLCE for full quality.
//! Like PICA, grading precedes texture modulation and light interpolation;
//! this is an explicit LDR/Gouraud approximation, not an HDR-equivalent bake.
use super::{pc, Result};
use glam::{Mat4, Quat, Vec2, Vec3, Vec4};
use serde_json::json;
use std::{collections::BTreeMap, path::Path};
#[path = "gles_display_pages.rs"]
mod display_pages;

use pc::display::{
    FRAME_ZERO_LIGHTING, GLASS_DIFFUSE, GOURAUD_SUN, INDEPENDENT_EMISSION, PLANAR_WET,
    SHARED_EMISSION_APPROX,
};
const MAX_WEAK_EMISSION: f32 = 1.0 / 12.0;
const MAX_VISIBLE_EMISSION_ERROR: f32 = 1.0 / 32.0;

pub(super) fn hash(bytes: &[u8]) -> String {
    // A cache identity, not an authenticity/security signature. Hex avoids
    // truncating u64 values in the JavaScript pipeline generator.
    format!("{:016x}", pc::content_hash::hash(bytes))
}
fn slice<'a>(bytes: &'a [u8], r: &pc::Range) -> Result<&'a [u8]> {
    let end = r.offset.checked_add(r.size).ok_or("color range overflow")?;
    bytes
        .get(r.offset as usize..end as usize)
        .ok_or_else(|| "color range outside payload".into())
}
fn decode(c: f32) -> f32 {
    c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878)
}
fn color(v: &[u8], enabled: bool) -> Vec3 {
    if enabled {
        Vec3::new(
            decode(v[20] as f32 / 255.0),
            decode(v[21] as f32 / 255.0),
            decode(v[22] as f32 / 255.0),
        )
    } else {
        Vec3::ONE
    }
}
/// The last authored roughness mip, sampled in linear radiance. Unlike the
/// common Baker's mip walker, this accepts GLES tails smaller than four texels.
struct Environment<'a> {
    pixels: &'a [u8],
    width: usize,
    height: usize,
    stride: usize,
}
impl<'a> Environment<'a> {
    fn new(meta: &pc::Meta, textures: &'a [u8]) -> Result<Option<Self>> {
        let Some(index) = meta.atmosphere.environment else {
            return Ok(None);
        };
        let t = meta
            .textures
            .get(index as usize)
            .ok_or("color environment reference")?;
        let stride = match t.format {
            pc::TexFormat::Rgba16f => 8,
            pc::TexFormat::Rgba8 => 4,
            _ => return Err("color environment format".into()),
        };
        if t.width == 0 || t.height == 0 || t.mips == 0 {
            return Err("color environment dimensions".into());
        }
        let data = slice(textures, &t.data)?;
        let (mut width, mut height, mut at) = (t.width as usize, t.height as usize, 0usize);
        for level in 0..t.mips {
            let size = width
                .checked_mul(height)
                .and_then(|n| n.checked_mul(stride))
                .ok_or("color environment mip overflow")?;
            let end = at
                .checked_add(size)
                .ok_or("color environment offset overflow")?;
            let pixels = data.get(at..end).ok_or("color environment mip range")?;
            if level + 1 == t.mips {
                return Ok(Some(Self {
                    pixels,
                    width,
                    height,
                    stride,
                }));
            }
            at = end;
            width = (width / 2).max(1);
            height = (height / 2).max(1);
        }
        unreachable!()
    }
    fn sample(&self, n: Vec3) -> Vec3 {
        let n = n / (n.x.abs() + n.y.abs() + n.z.abs()).max(1e-6);
        let mut p = Vec2::new(n.x, n.z);
        if n.y < 0.0 {
            p = (Vec2::ONE - Vec2::new(p.y.abs(), p.x.abs()))
                * Vec2::new(
                    if p.x >= 0.0 { 1.0 } else { -1.0 },
                    if p.y >= 0.0 { 1.0 } else { -1.0 },
                );
        }
        let uv = (p * 0.5 + Vec2::splat(0.5)) * Vec2::new(self.width as f32, self.height as f32)
            - Vec2::splat(0.5);
        let lo = uv.floor();
        let f = uv - lo;
        let at = |x: f32, y: f32| {
            let i = (y.clamp(0.0, self.height as f32 - 1.0) as usize * self.width
                + x.clamp(0.0, self.width as f32 - 1.0) as usize)
                * self.stride;
            Vec3::from_array(core::array::from_fn(|c| {
                if self.stride == 8 {
                    half::f16::from_le_bytes([self.pixels[i + c * 2], self.pixels[i + c * 2 + 1]])
                        .to_f32()
                } else {
                    self.pixels[i + c] as f32 / 255.0
                }
            }))
        };
        at(lo.x, lo.y).lerp(at(lo.x + 1.0, lo.y), f.x).lerp(
            at(lo.x, lo.y + 1.0).lerp(at(lo.x + 1.0, lo.y + 1.0), f.x),
            f.y,
        )
    }
}
fn f32s<const N: usize>(bytes: &[u8], at: usize) -> Result<[f32; N]> {
    let bytes = bytes
        .get(at..at.checked_add(N * 4).ok_or("color float range overflow")?)
        .ok_or("color float payload truncated")?;
    let v =
        std::array::from_fn(|i| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()));
    if v.iter().any(|v| !v.is_finite()) {
        return Err("non-finite color transform".into());
    }
    Ok(v)
}
fn world(meta: &pc::Meta, anim: &[u8]) -> Result<Vec<Mat4>> {
    let mut out = Vec::new();
    for (i, n) in meta.nodes.iter().enumerate() {
        let (t, q) = if let Some(r) = &n.track {
            let v = f32s::<7>(slice(anim, r)?, 0)?;
            (
                Vec3::new(v[0], v[1], v[2]),
                Quat::from_xyzw(v[3], v[4], v[5], v[6]),
            )
        } else {
            (Vec3::from(n.translation), Quat::from_array(n.rotation))
        };
        if q.length_squared() < 1e-12 {
            return Err("zero color node quaternion".into());
        }
        let local = Mat4::from_scale_rotation_translation(Vec3::from(n.scale), q.normalize(), t);
        let transform = if let Some(parent) = n.parent {
            if parent as usize >= i {
                return Err("color node parent order".into());
            }
            out[parent as usize] * local
        } else {
            local
        };
        out.push(transform);
    }
    Ok(out)
}
struct Mapping {
    texture: Option<u32>,
    flags: u32,
    visible_error: f32,
    all_error: f32,
    samples: usize,
}
fn mapping(meta: &pc::Meta, tex: &[u8], m: &pc::Material) -> Result<Option<Mapping>> {
    let plain = |texture| {
        Some(Mapping {
            texture,
            flags: 0,
            visible_error: 0.0,
            all_error: 0.0,
            samples: 0,
        })
    };
    if m.kind == pc::Kind::Glass {
        return Ok(plain(None));
    }
    if m.kind == pc::Kind::Unlit || m.emissive.iter().all(|&v| v == 0.0) || m.emission.is_none() {
        return Ok(plain(m.albedo));
    }
    let emission = m.emission.unwrap();
    let independent = || {
        m.emission_shade.is_none().then_some(Mapping {
            texture: m.albedo,
            flags: INDEPENDENT_EMISSION,
            visible_error: 0.0,
            all_error: 0.0,
            samples: 0,
        })
    };
    let Some(albedo) = m.albedo else {
        return Ok(if m.color[..3].iter().all(|&v| v == 0.0) {
            plain(Some(emission))
        } else {
            independent()
        });
    };
    if albedo == emission {
        return Ok(plain(Some(albedo)));
    }
    let a = meta
        .textures
        .get(albedo as usize)
        .ok_or("color albedo reference")?;
    let e = meta
        .textures
        .get(emission as usize)
        .ok_or("color emission reference")?;
    if a.format != pc::TexFormat::Rgba8
        || e.format != pc::TexFormat::Rgba8
        || a.role != pc::TexRole::Color
        || e.role != pc::TexRole::Color
        || (a.width, a.height, a.mips, a.wrap_s, a.wrap_t, a.lod_bias)
            != (e.width, e.height, e.mips, e.wrap_s, e.wrap_t, e.lod_bias)
    {
        return Ok(independent());
    }
    let aa = slice(tex, &a.data)?;
    let ee = slice(tex, &e.data)?;
    if aa.len() != ee.len() || aa.len() % 4 != 0 {
        return Err("color texture shape mismatch".into());
    }
    let mut exact = true;
    let mut visible = 0.0f32;
    let mut all = 0.0f32;
    let mut samples = 0;
    for (a, e) in aa.chunks_exact(4).zip(ee.chunks_exact(4)) {
        exact &= a[..3] == e[..3];
        let err = (0..3)
            .map(|k| {
                (decode(a[k] as f32 / 255.0) - decode(e[k] as f32 / 255.0)).abs() * m.emissive[k]
            })
            .fold(0.0, f32::max);
        all = all.max(err);
        if a[3] as f32 / 255.0 * m.color[3] >= m.alpha_test {
            visible = visible.max(err);
            samples += 1;
        }
    }
    if exact {
        return Ok(plain(Some(albedo)));
    }
    // Names provide provenance only alongside matching sampling state and a
    // measured weak-emission bound over every stored mip. The error is an
    // observed texel bound, not a bound on all bilinear/anisotropic footprints.
    if m.alpha_test > 0.0
        && a.name == e.name
        && a.has_alpha
        && samples > 0
        && m.emissive
            .iter()
            .all(|&v| (0.0..=MAX_WEAK_EMISSION).contains(&v))
        && visible <= MAX_VISIBLE_EMISSION_ERROR
    {
        Ok(Some(Mapping {
            texture: Some(albedo),
            flags: SHARED_EMISSION_APPROX,
            visible_error: visible,
            all_error: all,
            samples,
        }))
    } else {
        Ok(independent())
    }
}

pub(super) struct Colors {
    pub json: Vec<u8>,
    pub bytes: Vec<u8>,
    pub draws: usize,
}
pub(super) fn adapt(source: &[u8]) -> Result<Colors> {
    let pack = pc::Pack::parse(source).map_err(|e| e.to_string())?;
    let meta_bytes = pack.section(pc::TAG_META).map_err(|e| e.to_string())?;
    let meta = pack.meta().map_err(|e| e.to_string())?;
    let geom = pack.section(pc::TAG_GEOMETRY).map_err(|e| e.to_string())?;
    let tex = pack.section(pc::TAG_TEXTURES).map_err(|e| e.to_string())?;
    let texture_hash = format!("{:016x}", pc::content_hash::textures(&meta.textures, tex)?);
    let anim = pack.section(pc::TAG_ANIMATION).map_err(|e| e.to_string())?;
    let world = world(&meta, anim)?;
    let mut skins = Vec::new();
    for skin in &meta.skins {
        let bind = slice(anim, &skin.inverse_bind)?;
        let mut bones = Vec::new();
        for (i, &joint) in skin.joints.iter().enumerate() {
            let w = world
                .get(joint as usize)
                .ok_or("color skin joint reference")?;
            bones.push(*w * Mat4::from_cols_array(&f32s::<16>(bind, i * 64)?));
        }
        skins.push(bones);
    }
    // PICA's frame-zero hemisphere + static light approximation. Baked
    // vertices already retain the original occluded environment irradiance.
    let baker = crate::bake::Baker::new(
        &meta.lights,
        (
            meta.atmosphere.hemisphere_sky,
            meta.atmosphere.hemisphere_ground,
        ),
        None,
    );
    let environment = Environment::new(&meta, tex)?;
    let mut maps = Vec::new();
    for m in &meta.materials {
        maps.push(mapping(&meta, tex, m)?);
    }
    let mut pages = BTreeMap::<String, u32>::new();
    let mut bytes = Vec::new();
    let mut draws = Vec::new();
    let mut fallback = BTreeMap::<String, usize>::new();
    let mut approximation = Vec::new();
    for (i, d) in meta.draws.iter().enumerate() {
        let m = meta
            .materials
            .get(d.material as usize)
            .ok_or("color material reference")?;
        let planar_wet = m.kind == pc::Kind::Standard
            && m.wet.as_ref().is_some_and(|w| w.planar)
            && d.layout == pc::VertexLayout::Baked
            && d.node.is_none()
            && d.skin.is_none();
        let why = if !matches!(
            m.kind,
            pc::Kind::Standard | pc::Kind::Unlit | pc::Kind::Glass
        ) {
            Some("special-material")
        } else if d.layout == pc::VertexLayout::Lights {
            Some("light-field")
        } else if m.wet.is_some() && !planar_wet {
            Some("wet-surface")
        } else if m.emissive_track.is_some() {
            Some("animated-emission")
        } else if maps[d.material as usize].is_none() {
            Some("independent-emission-map")
        } else {
            None
        };
        if let Some(why) = why {
            *fallback.entry(why.into()).or_default() += 1;
            continue;
        }
        let map = maps[d.material as usize].as_ref().unwrap();
        let mut flags = map.flags;
        if planar_wet {
            flags |= PLANAR_WET;
        }
        if m.kind == pc::Kind::Glass {
            flags |= GLASS_DIFFUSE;
        }
        if matches!(m.kind, pc::Kind::Standard | pc::Kind::Glass)
            && (d.layout != pc::VertexLayout::Baked || d.node.is_some() || d.skin.is_some())
        {
            flags |= FRAME_ZERO_LIGHTING;
        }
        if m.kind == pc::Kind::Standard && !m.interior && meta.sun.is_some() {
            flags |= GOURAUD_SUN;
        }
        let key = serde_json::to_string(&(
            d.material,
            &d.vertices,
            d.layout,
            d.node,
            d.skin,
            d.pos_offset,
            d.pos_scale,
        ))
        .map_err(|e| e.to_string())?;
        let offset = if let Some(&offset) = pages.get(&key) {
            offset
        } else {
            let offset = u32::try_from(bytes.len()).map_err(|_| "color stream exceeds 4GiB")?;
            let input = slice(geom, &d.vertices)?;
            let stride = d.layout.stride() as usize;
            if d.vertex_count.checked_mul(stride as u32) != Some(d.vertices.size) || stride < 24 {
                return Err("color vertex stride mismatch".into());
            }
            let model = if let Some(n) = d.node {
                *world.get(n as usize).ok_or("color draw node reference")?
            } else {
                Mat4::IDENTITY
            };
            for v in input.chunks_exact(stride) {
                let q = |at| i16::from_le_bytes([v[at], v[at + 1]]) as f32 / 32767.0;
                let mut p = Vec3::from(d.pos_offset)
                    + Vec3::new(q(0), q(2), q(4)) * Vec3::from(d.pos_scale);
                let mut n = Vec3::new(v[8] as i8 as f32, v[9] as i8 as f32, v[10] as i8 as f32)
                    .normalize_or(Vec3::Y);
                if let Some(si) = d.skin {
                    if d.layout != pc::VertexLayout::Skinned {
                        return Err("color skin layout mismatch".into());
                    }
                    let bones = skins.get(si as usize).ok_or("color skin reference")?;
                    let mut sp = Vec3::ZERO;
                    let mut sn = Vec3::ZERO;
                    for k in 0..4 {
                        let bone = bones
                            .get(v[24 + k] as usize)
                            .ok_or("color skin vertex joint")?;
                        let weight = v[28 + k] as f32 / 255.0;
                        sp += bone.transform_point3(p) * weight;
                        sn += bone.transform_vector3(n) * weight;
                    }
                    p = sp;
                    n = sn.normalize_or(n);
                }
                p = model.transform_point3(p);
                n = model.transform_vector3(n).normalize_or(Vec3::Y);
                let vc = color(v, m.vertex_color && m.kind != pc::Kind::Glass);
                let base = Vec3::from_array(m.color[..3].try_into().unwrap()) * vc;
                let rgb = if m.kind == pc::Kind::Unlit {
                    base
                } else {
                    let mut light = if d.layout == pc::VertexLayout::Baked {
                        let s = Vec3::new(v[24] as f32, v[25] as f32, v[26] as f32)
                            * (v[27] as f32 / (255.0 * 255.0));
                        s * s * 64.0
                    } else if m.kind == pc::Kind::Glass {
                        baker.irradiance(p, n, 0.0, true, 1.0)
                            + environment.as_ref().map_or(Vec3::ZERO, |e| e.sample(n))
                                * (m.env_strength * meta.atmosphere.environment_strength)
                    } else {
                        baker.irradiance(p, n, m.env_strength, !m.interior, 1.0) + Vec3::splat(0.08)
                    };
                    if m.kind == pc::Kind::Glass {
                        // Coverage, view Fresnel and beads stay in the shader.
                        // Glass diffuse has no AO, metalness, emission or sun.
                        base * light
                    } else {
                        let orm = m
                            .orm
                            .map(|i| meta.textures[i as usize].mean)
                            .unwrap_or([1.0; 4]);
                        light *= (orm[0] - 1.0) * m.ao_strength + 1.0;
                        if !m.interior {
                            if let Some(sun) = &meta.sun {
                                light += Vec3::from(sun.radiance)
                                    * (n.dot(Vec3::from(sun.direction)).clamp(0.0, 1.0)
                                        * std::f32::consts::FRAC_1_PI);
                            }
                        }
                        // The dual-map fast shader adds graded emission separately.
                        // Keep it out of this diffuse stream to avoid double light.
                        let mut emission = if flags & INDEPENDENT_EMISSION != 0 {
                            Vec3::ZERO
                        } else {
                            Vec3::from(m.emissive)
                        };
                        if let Some(shade) = m.emission_shade {
                            let normal = Vec4::new(n.x.abs(), n.y, n.z.abs(), 1.0)
                                .dot(Vec4::from(shade.normal));
                            let h = ((p.y - shade.height[0]) / (shade.height[1] - shade.height[0]))
                                .clamp(0.0, 1.0);
                            emission *= normal
                                * (shade.height[2]
                                    + (shade.height[3] - shade.height[2])
                                        * h
                                        * h
                                        * (3.0 - 2.0 * h));
                            if m.vertex_color {
                                emission *= vc;
                            }
                        }
                        base * light * (1.0 - m.metalness * orm[2]) + emission
                    }
                };
                if !rgb.is_finite() {
                    return Err("non-finite prelit radiance".into());
                }
                let display = pc::color::tone(rgb.to_array(), &meta.post);
                for c in display {
                    bytes.push((c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
                }
                bytes.push(if m.vertex_color && m.kind != pc::Kind::Glass {
                    v[23]
                } else {
                    255
                });
            }
            pages.insert(key, offset);
            offset
        };
        draws.push(display_pages::Draw {
            draw: i as u32,
            offset,
            vertex_count: d.vertex_count,
            texture: map.texture,
            flags,
            page: None,
            base_vertex: 0,
        });
        if map.flags & SHARED_EMISSION_APPROX != 0 {
            approximation.push(json!({"draw":i,"material":d.material,"visibleMipTexels":map.samples,"maxVisibleEmissionError":map.visible_error,"maxAllTexelEmissionError":map.all_error}));
        }
    }
    let (bytes, pages, states) = display_pages::pack(&meta, geom, &bytes, &mut draws)?;
    let json = json!({"version":2,"identity":"fnv1a64-v1","metaHash":hash(meta_bytes),"geometryHash":hash(geom),"animationHash":hash(anim),"textureHash":texture_hash,"colorsHash":hash(&bytes),"colorsBytes":bytes.len(),"states":states,"pages":pages.iter().map(|p|p.json()).collect::<Vec<_>>(),"draws":draws.iter().map(|d|d.json()).collect::<Vec<_>>(),"approximation":{"gradeBeforeSrgbTextureModulation":true,"flags":{"1":"frame-zero dynamic lighting","2":"weak emission shares albedo sample","4":"Gouraud sun without runtime shadows","8":"diffuse-only color; independent emission sample remains in shader","16":"static planar wet diffuse; wet effects remain in shader","32":"glass diffuse only; coverage Fresnel beads remain in shader"},"weakEmissionLimit":MAX_WEAK_EMISSION,"visibleEmissionErrorLimit":MAX_VISIBLE_EMISSION_ERROR,"emissionSamples":approximation,"fallbackDraws":fallback}});
    Ok(Colors {
        json: serde_json::to_vec_pretty(&json).map_err(|e| e.to_string())?,
        bytes,
        draws: draws.len(),
    })
}
pub(super) fn write(source: &[u8], path: &Path) -> Result<()> {
    let colors = adapt(source)?;
    std::fs::write(path.with_extension("ipod-color.bin"), &colors.bytes)
        .map_err(|e| e.to_string())?;
    std::fs::write(path.with_extension("ipod-color.json"), &colors.json)
        .map_err(|e| e.to_string())?;
    println!(
        "  optional LDR colors: {} draws, {:.2} MiB (original GEOM retained)",
        colors.draws,
        colors.bytes.len() as f64 / 1048576.0
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn texture_identity_binds_data_order_aliases_and_all_mips() {
        let (mut m, geometry, mut tex) = fixture();
        let original = adapt(&source(&m, &geometry, &tex)).unwrap();
        let before: serde_json::Value = serde_json::from_slice(&original.json).unwrap();
        tex[0] ^= 1;
        let changed = adapt(&source(&m, &geometry, &tex)).unwrap();
        let after: serde_json::Value = serde_json::from_slice(&changed.json).unwrap();
        assert_eq!(before["metaHash"], after["metaHash"]);
        assert_ne!(before["textureHash"], after["textureHash"]);
        assert_eq!(original.bytes, changed.bytes); // this fixture has no sampled lighting dependency
        let t = m.textures[0].clone();
        m.textures.push(t.clone());
        let mut h = pc::content_hash::Fnv1a64::default();
        h.update(slice(&tex, &t.data).unwrap());
        h.update(slice(&tex, &t.data).unwrap());
        assert_eq!(
            pc::content_hash::textures(&m.textures, &tex).unwrap(),
            h.finish()
        );
        m.textures[1].data.offset = u32::MAX;
        assert!(pc::content_hash::textures(&m.textures, &tex).is_err());
    }
    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS; optional POCKET_ATLAS_COLOR_OUTPUT writes candidate sidecars"]
    fn existing_packs_regenerate_identical_color_payload_and_texture_binding() {
        let root = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").expect("pack directory");
        let output = std::env::var_os("POCKET_ATLAS_COLOR_OUTPUT").map(std::path::PathBuf::from);
        if let Some(output) = &output {
            std::fs::create_dir_all(output).unwrap();
        }
        let mut count = 0;
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("place") {
                continue;
            }
            let source = std::fs::read(&path).unwrap();
            let result = adapt(&source).unwrap();
            assert_eq!(
                result.bytes,
                std::fs::read(path.with_extension("ipod-color.bin")).unwrap(),
                "{}: color payload changed",
                path.display()
            );
            let mut old: serde_json::Value = serde_json::from_slice(
                &std::fs::read(path.with_extension("ipod-color.json")).unwrap(),
            )
            .unwrap();
            let mut new: serde_json::Value = serde_json::from_slice(&result.json).unwrap();
            let binding = new.as_object_mut().unwrap().remove("textureHash").unwrap();
            old.as_object_mut().unwrap().remove("textureHash");
            assert_eq!(
                new,
                old,
                "{}: unrelated color metadata changed",
                path.display()
            );
            if let Some(output) = &output {
                let stem = output.join(path.file_name().unwrap());
                std::fs::write(stem.with_extension("ipod-color.json"), &result.json).unwrap();
                std::fs::write(stem.with_extension("ipod-color.bin"), &result.bytes).unwrap();
            }
            println!(
                "{}: identical color payload; textureHash={binding}",
                path.display()
            );
            count += 1;
        }
        assert!(count > 0);
    }
    pub(super) fn fixture() -> (pc::Meta, Vec<u8>, Vec<u8>) {
        let (mut m, _, mut g) = super::super::gles_geometry::tests::fixture();
        m.nodes.clear();
        m.materials[0].vertex_color = false;
        m.textures[0].width = 4;
        m.textures[0].height = 4;
        m.textures[0].data.size = 64;
        for d in &m.draws {
            for v in
                g[d.vertices.offset as usize..][..d.vertices.size as usize].chunks_exact_mut(28)
            {
                v[24..28].copy_from_slice(&[255, 255, 255, 32]);
            }
        }
        (m, g, [255; 4].repeat(16))
    }
    fn source(m: &pc::Meta, g: &[u8], t: &[u8]) -> Vec<u8> {
        pc::write(&[
            (pc::TAG_META, &serde_json::to_vec(m).unwrap(), 16),
            (pc::TAG_GEOMETRY, g, 16),
            (pc::TAG_TEXTURES, t, 16),
            (pc::TAG_ANIMATION, &[], 16),
        ])
    }
    #[test]
    fn grades_once_into_a_deduplicated_stream_without_changing_original_pack() {
        let (mut m, g, t) = fixture();
        m.materials[0].color = [1.0, 0.5, 0.25, 0.7];
        m.draws[1] = m.draws[0].clone();
        let input = source(&m, &g, &t);
        let original = input.clone();
        let out = adapt(&input).unwrap();
        assert_eq!(input, original);
        assert_eq!(out.bytes.len(), 4 * 24);
        assert_eq!(out.draws, 2);
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert_eq!(json["draws"][0]["offset"], json["draws"][1]["offset"]);
        let rgb = pc::color::tone(
            [1.0, 0.5, 0.25].map(|v| v * (32.0f32 / 255.0).powi(2) * 64.0),
            &m.post,
        );
        assert_eq!(&out.bytes[20..23], &rgb.map(|v| (v * 255.0 + 0.5) as u8));
        assert_eq!(out.bytes[23], 255);
        let pack = pc::Pack::parse(&input).unwrap();
        assert_eq!(json["metaHash"], hash(pack.section(pc::TAG_META).unwrap()));
        assert_eq!(json["colorsHash"], hash(&out.bytes));
        assert_eq!(hash(b""), "cbf29ce484222325");
        assert_eq!(hash(b"a"), "af63dc4c8601ec8c");
    }
    #[test]
    fn planar_wet_preserves_dry_diffuse_and_excludes_unsupported_motion() {
        let (mut m, g, t) = fixture();
        let dry = adapt(&source(&m, &g, &t)).unwrap();
        m.materials[0].wet = Some(pc::Wet {
            planar: true,
            darken: 0.5,
            puddles: 1.0,
            ripple: 0.7,
            ..Default::default()
        });
        let wet = adapt(&source(&m, &g, &t)).unwrap();
        assert_eq!(wet.bytes, dry.bytes, "wet shading belongs to the runtime");
        let json: Value = serde_json::from_slice(&wet.json).unwrap();
        assert!(json["draws"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["flags"] == PLANAR_WET));
        m.materials[0].wet.as_mut().unwrap().planar = false;
        assert_eq!(adapt(&source(&m, &g, &t)).unwrap().draws, 0);
        m.materials[0].wet.as_mut().unwrap().planar = true;
        m.draws[0].node = Some(0);
        assert_eq!(adapt(&source(&m, &g, &t)).unwrap().draws, 1);
    }
    #[test]
    fn glass_diffuse_excludes_coverage_vertex_color_sun_orm_and_emission() {
        let (mut m, g, t) = fixture();
        let mat = &mut m.materials[0];
        mat.kind = pc::Kind::Glass;
        mat.color = [0.3, 0.5, 0.7, 0.1];
        mat.vertex_color = true;
        mat.metalness = 1.0;
        mat.emissive = [100.0; 3];
        mat.emission = Some(0);
        m.sun = Some(pc::Sun {
            direction: [0.0, 1.0, 0.0],
            radiance: [100.0; 3],
            shadow: None,
        });
        let out = adapt(&source(&m, &g, &t)).unwrap();
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert!(json["draws"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["flags"] == GLASS_DIFFUSE && d["texture"].is_null()));
        let expected = pc::color::tone(
            [0.3, 0.5, 0.7].map(|v| v * (32.0f32 / 255.0).powi(2) * 64.0),
            &m.post,
        )
        .map(|v| (v * 255.0 + 0.5) as u8);
        assert!(out
            .bytes
            .chunks_exact(4)
            .all(|p| p == [expected[0], expected[1], expected[2], 255]));
    }
    #[test]
    fn glass_environment_reads_last_gles_mip_including_one_texel_tail() {
        let (mut m, _, mut pixels) = fixture();
        let mut t = m.textures[0].clone();
        t.role = pc::TexRole::Environment;
        t.format = pc::TexFormat::Rgba16f;
        t.width = 2;
        t.height = 2;
        t.mips = 2;
        t.data = pc::Range {
            offset: 64,
            size: 40,
        };
        pixels.extend([0; 32]);
        for v in [1.0, 2.0, 3.0, 1.0] {
            pixels.extend(half::f16::from_f32(v).to_le_bytes());
        }
        m.atmosphere.environment = Some(m.textures.len() as u32);
        m.textures.push(t);
        let env = Environment::new(&m, &pixels).unwrap().unwrap();
        assert_eq!(env.sample(Vec3::Y), Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(env.sample(Vec3::NEG_Y), Vec3::new(1.0, 2.0, 3.0));
        assert!(Environment::new(&m, &pixels[..pixels.len() - 1]).is_err());
    }
    #[test]
    fn preserves_vertex_alpha_and_marks_sun_and_frame_zero_lighting() {
        let (mut m, g, t) = fixture();
        m.materials[0].vertex_color = true;
        m.sun = Some(pc::Sun {
            direction: [0.0, 1.0, 0.0],
            radiance: [1.0; 3],
            shadow: None,
        });
        let out = adapt(&source(&m, &g, &t)).unwrap();
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert_eq!(json["draws"][0]["flags"], GOURAUD_SUN);
        assert_eq!(out.bytes[23], g[m.draws[0].vertices.offset as usize + 23]);
        // A rigid object keeps its runtime transform; the sidecar labels its
        // fixed lighting instead of removing its node or animation contract.
        let texture = m.textures[0].clone();
        let raw = super::super::tests::fixture(&texture);
        let base: pc::Meta = serde_json::from_value(raw).unwrap();
        m.nodes = base.nodes;
        m.nodes[0].track = None;
        m.draws[0].node = Some(0);
        let out = adapt(&source(&m, &g, &t)).unwrap();
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert_eq!(json["draws"][0]["flags"], GOURAUD_SUN | FRAME_ZERO_LIGHTING);
        m.materials[0].emissive_track = Some(0);
        assert_eq!(adapt(&source(&m, &g, &t)).unwrap().draws, 0);
    }
    #[test]
    fn weak_shared_image_emission_requires_provenance_sampling_and_error_limits() {
        let (mut m, g, mut t) = fixture();
        let mut second = m.textures[0].clone();
        second.data.offset = 64;
        m.textures[0].has_alpha = true;
        second.has_alpha = false;
        m.textures.push(second);
        for p in t.chunks_exact_mut(4) {
            p.copy_from_slice(&[128, 128, 128, 255]);
        }
        t.extend([130, 128, 128, 255].repeat(16));
        let mat = &mut m.materials[0];
        mat.alpha_test = 0.5;
        mat.emission = Some(1);
        mat.emissive = [0.05; 3];
        let out = adapt(&source(&m, &g, &t)).unwrap();
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert_eq!(out.draws, 2);
        assert_eq!(json["draws"][0]["flags"], SHARED_EMISSION_APPROX);
        assert_eq!(json["draws"][0]["texture"], 0);
        for case in 0..4 {
            let mut bad = m.clone();
            match case {
                0 => bad.textures[1].name = "unrelated".into(),
                1 => bad.textures[1].wrap_s = pc::Wrap::Mirror,
                2 => bad.materials[0].emissive = [1.0; 3],
                _ => bad.materials[0].alpha_test = 0.0,
            }
            let out = adapt(&source(&bad, &g, &t)).unwrap();
            let json: Value = serde_json::from_slice(&out.json).unwrap();
            assert_eq!(out.draws, 2, "case {case}");
            assert_eq!(
                json["draws"][0]["flags"], INDEPENDENT_EMISSION,
                "case {case}"
            );
        }
        // Identical RGB is a valid shared sample even if alpha/provenance differ.
        t[64..].copy_from_slice(&[128, 128, 128, 0].repeat(16));
        m.textures[1].name = "different-name".into();
        let out = adapt(&source(&m, &g, &t)).unwrap();
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert_eq!(json["draws"][0]["flags"], 0);
    }
    #[test]
    fn independent_emission_keeps_only_diffuse_in_colors_and_retains_both_maps() {
        let (mut m, g, mut t) = fixture();
        let diffuse = adapt(&source(&m, &g, &t)).unwrap();
        let mut emission = m.textures[0].clone();
        emission.name = "independent-emission".into();
        emission.width = 2;
        emission.height = 2;
        emission.data = pc::Range {
            offset: 64,
            size: 16,
        };
        m.textures.push(emission);
        t.extend([31, 63, 127, 255].repeat(4));
        m.materials[0].emission = Some(1);
        m.materials[0].emissive = [4.0, 2.0, 1.0];
        let out = adapt(&source(&m, &g, &t)).unwrap();
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert_eq!(
            out.bytes, diffuse.bytes,
            "independent emission must not be baked twice"
        );
        assert_eq!(json["draws"][0]["texture"], 0);
        assert_eq!(json["draws"][0]["flags"], INDEPENDENT_EMISSION);
        assert_eq!(m.materials[0].emission, Some(1));
        m.materials[0].emission_shade = Some(pc::EmissionShade {
            normal: [0.0, 1.0, 0.0, 0.0],
            height: [0.0, 1.0, 0.5, 1.0],
        });
        assert_eq!(adapt(&source(&m, &g, &t)).unwrap().draws, 0);
        m.materials[0].emission_shade = None;
        m.materials[0].emissive_track = Some(0);
        assert_eq!(adapt(&source(&m, &g, &t)).unwrap().draws, 0);
        m.materials[0].emissive_track = None;
        m.materials[0].albedo = None;
        let out = adapt(&source(&m, &g, &t)).unwrap();
        let json: Value = serde_json::from_slice(&out.json).unwrap();
        assert!(json["draws"][0]["texture"].is_null());
        assert_eq!(json["draws"][0]["flags"], INDEPENDENT_EMISSION);
    }

    #[test]
    fn malformed_color_geometry_and_skin_data_fail_without_truncation() {
        let (mut m, g, t) = fixture();
        m.draws[0].vertices.size -= 1;
        assert!(adapt(&source(&m, &g, &t)).is_err());
        let (mut m, g, t) = fixture();
        m.draws[0].vertices.offset = u32::MAX - 2;
        assert!(adapt(&source(&m, &g, &t)).is_err());
        let (mut m, g, t) = fixture();
        m.draws[0].skin = Some(0);
        assert!(adapt(&source(&m, &g, &t)).is_err());
    }
    use serde_json::Value;
}
