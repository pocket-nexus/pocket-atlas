//! End-to-end compiler contract: a sealed source builds all targets independently.
use serde_json::json;
use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    process::Command,
};

struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn run(args: &[&str]) -> std::process::Output {
    let mut command=Command::new(env!("CARGO_BIN_EXE_pocket-atlas-cook"));
    command.args(args);
    if !args.contains(&"--cache") {command.args(["--cache","off"]);}
    command
        .env("RAYON_NUM_THREADS", "2")
        .output()
        .unwrap()
}
fn ok(args: &[&str]) {
    let out = run(args);
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
fn fixture(root: &Path, width: u32, height: u32) {
    fixture_material(root, width, height, None, "night-street");
}
fn fixture_material(root: &Path, width: u32, height: u32, roughness: Option<f32>, kind: &str) {
    std::fs::create_dir_all(root).unwrap();
    // A non-power-of-two source texture ensures native targets apply their own fit.
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(width, height, image::Rgba([170, 120, 70, 255]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let pos = [0.1234567f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let mut bin: Vec<u8> = pos.into_iter().flat_map(f32::to_le_bytes).collect();
    let image_start = bin.len();
    bin.extend(png.into_inner());
    let shot = json!({"pos":[0,1,3],"target":[0,0,0],"fov":45});
    let mut document = json!({
        "asset":{"version":"2.0"}, "scene":0,
        "scenes":[{"nodes":[0],"extras":{"pocketAtlas":{
            "kind":kind, "camera":{"shots":[{"name":"Front","from":shot,"to":shot,"duration":12}]}
        }}}], "nodes":[{"mesh":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],
        "materials":[{"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}, "extensions":{"KHR_materials_unlit":{}}}],
        "extensionsUsed":["KHR_materials_unlit"],
        "textures":[{"source":0}], "images":[{"bufferView":1,"mimeType":"image/png"}],
        "buffers":[{"byteLength":bin.len()}],
        "bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":image_start,"byteLength":bin.len()-image_start}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}]
    });
    if let Some(roughness) = roughness {
        document["materials"][0]["pbrMetallicRoughness"]["roughnessFactor"] = json!(roughness);
        document["materials"][0].as_object_mut().unwrap().remove("extensions");
        document.as_object_mut().unwrap().remove("extensionsUsed");
    }
    let glb = gltf::binary::Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        },
        json: Cow::Owned(serde_json::to_vec(&document).unwrap()),
        bin: Some(Cow::Owned(bin)),
    };
    std::fs::write(root.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
}
#[test]
fn one_ir_builds_three_repeatable_packs_without_web_export_or_vita_intermediate() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-pipeline-{}", std::process::id())));
    let export = temp.0.join("triangle");
    let ir = temp.0.join("place.ir");
    fixture(&export, 13, 7);
    ok(&[
        "import",
        "--in",
        export.to_str().unwrap(),
        "--out",
        ir.to_str().unwrap(),
    ]);
    std::fs::remove_dir_all(export).unwrap();
    let manifest = std::fs::read(ir.join("manifest.json")).unwrap();
    // Deliberately compile Vita last; every target only sees the sealed source.
    for target in ["psp", "3ds", "vita"] {
        let output = temp.0.join("target.place");
        let args = [
            "--in",
            ir.to_str().unwrap(),
            "--out",
            output.to_str().unwrap(),
            "--target",
            target,
            "--tex",
            "256",
        ];
        ok(&args);
        let first = std::fs::read(&output).unwrap();
        if target == "psp" {
            let header = pocket3d_place_psp::validate(&first).unwrap();
            let textures =
                pocket3d_place_psp::slice::<pocket3d_place_psp::Texture>(&first, header.textures)
                    .unwrap();
            assert_eq!((textures[0].width, textures[0].height), (16, 8));
            let draws = pocket3d_place_psp::slice::<pocket3d_place_psp::Draw>(&first, header.draws)
                .unwrap();
            let vertices =
                pocket3d_place_psp::slice::<pocket3d_place_psp::Vertex>(&first, draws[0].vertices)
                    .unwrap();
            assert!(vertices
                .iter()
                .any(|v| v.pos[0].to_bits() == 0.1234567f32.to_bits()));
        } else if target == "3ds" {
            let cooker = Path::new(env!("CARGO_MANIFEST_DIR"));
            let reader = temp.0.join("pica-contract");
            let compile = Command::new("cc")
                .args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-I"])
                .arg(cooker.join("../../n3ds/src"))
                .arg(cooker.join("tests/pica-contract.c"))
                .arg("-o")
                .arg(&reader)
                .output()
                .unwrap();
            assert!(
                compile.status.success(),
                "{}",
                String::from_utf8_lossy(&compile.stderr)
            );
            assert!(Command::new(&reader)
                .arg(&output)
                .status()
                .unwrap()
                .success());
            // A Vita schema bump must never leak into the PICA envelope again.
            let mut wrong_version = first.clone();
            wrong_version[4..8].copy_from_slice(&pocket3d_place::VERSION.to_le_bytes());
            std::fs::write(&output, wrong_version).unwrap();
            assert!(!Command::new(&reader)
                .arg(&output)
                .status()
                .unwrap()
                .success());
        } else {
            let pack = pocket3d_place::Pack::parse(&first).unwrap();
            assert!(pack.section(*b"PICA").is_err());
        }
        ok(&args);
        assert_eq!(
            first,
            std::fs::read(&output).unwrap(),
            "{target} is not deterministic"
        );
        std::fs::remove_file(output).unwrap();
    }
    assert_eq!(manifest, std::fs::read(ir.join("manifest.json")).unwrap());
    std::fs::write(ir.join("scene.bin"), [0; 4]).unwrap();
    let out = run(&["check", "--in", ir.to_str().unwrap(), "--target", "psp"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("resource changed"));
}

#[test]
fn pica_does_not_treat_an_ordinary_2k_source_texture_as_a_text_atlas() {
    let temp =
        Temp(std::env::temp_dir().join(format!("atlas-pica-texture-{}", std::process::id())));
    let export = temp.0.join("large-texture");
    fixture(&export, 2048, 2048);
    let output = temp.0.join("pica.place");
    ok(&[
        "--in",
        export.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
        "--target",
        "3ds",
        "--tex",
        "256",
    ]);
    let bytes = std::fs::read(output).unwrap();
    let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let section = (0..word(8) as usize)
        .map(|i| 16 + i * 16)
        .find(|&at| &bytes[at..at + 4] == b"PICA")
        .unwrap();
    let table = word(section + 4) as usize;
    assert_eq!(word(table + 4), 1, "one texture");
    assert_eq!((word(table + 120), word(table + 124)), (256, 256));
}

#[test]
fn psp_glossy_colour_preserves_source_precision_and_native_mip_layout() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-gloss-{}", std::process::id())));
    for (roughness, kind, format, bpp) in [(0.2, "daytime-street", pocket3d_place_psp::RGBA8888, 4),
        (0.8, "daytime-street", pocket3d_place_psp::RGBA4444, 2),
        (0.2, "night-street", pocket3d_place_psp::RGBA4444, 2)] {
        let source = temp.0.join("surface");
        fixture_material(&source, 32, 16, Some(roughness), kind);
        let output = temp.0.join("surface.place");
        ok(&["--in", source.to_str().unwrap(), "--target", "psp", "--out", output.to_str().unwrap()]);
        let bytes = std::fs::read(output).unwrap();
        let h = pocket3d_place_psp::validate(&bytes).unwrap();
        let t = &pocket3d_place_psp::slice::<pocket3d_place_psp::Texture>(&bytes, h.textures).unwrap()[0];
        assert_eq!(t.format, format);
        assert_eq!(t.mips, 2);
        assert_eq!(t.pixels.count, (32 * 16 + 16 * 8) * bpp);
        if format == pocket3d_place_psp::RGBA8888 {
            let pixel = t.pixels.offset as usize;
            assert_eq!(&bytes[pixel..pixel + 4], &[170, 120, 70, 255]);
            assert_eq!(&bytes[pixel + 32 * 16 * 4..pixel + 32 * 16 * 4 + 4], &[170, 120, 70, 255]);
        }
    }
}

#[test]
fn vita_palette_encoding_does_not_replace_native_material_inputs() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-palette-targets-{}", std::process::id())));
    let export = temp.0.join("solid-materials");
    let ir = temp.0.join("place.ir");
    std::fs::create_dir_all(&export).unwrap();
    let mut bin = Vec::new();
    let mut views = Vec::new();
    let mut accessors = Vec::new();
    let mut attribute = |data: &[f32], kind: &str| {
        let start = bin.len();
        bin.extend(data.iter().flat_map(|v| v.to_le_bytes()));
        let id = views.len();
        views.push(json!({"buffer":0,"byteOffset":start,"byteLength":bin.len()-start}));
        accessors.push(json!({"bufferView":id,"componentType":5126,"count":3,"type":kind}));
        id
    };
    let uv = [[0.1234567f32, 0.7654321], [0.3456789, 0.2345678]];
    let rough_metal = [[0.21f32, 0.73], [0.91, 0.03]];
    let tint = [[0.27f32, 0.55, 0.8, 1.0], [0.6, 0.12, 0.4, 1.0]];
    let primitives: Vec<_> = (0..2).map(|i| {
        let x = i as f32 * 2.0;
        let pos = attribute(&[x + 0.1234567, 0.0, 0.0, x + 1.0, 0.0, 0.0, x, 0.0, 1.0], "VEC3");
        let normal = attribute(&[0.0, 1.0, 0.0].repeat(3), "VEC3");
        let texcoord = attribute(&uv[i].repeat(3), "VEC2");
        json!({"attributes":{"POSITION":pos,"NORMAL":normal,"TEXCOORD_0":texcoord},"material":i})
    }).collect();
    let materials: Vec<_> = (0..2).map(|i| json!({
        "name":format!("solid-{i}"),
        "pbrMetallicRoughness":{"baseColorFactor":tint[i],"roughnessFactor":rough_metal[i][0],"metallicFactor":rough_metal[i][1]}
    })).collect();
    let shot = json!({"pos":[0,1,3],"target":[0,0,0],"fov":45});
    let document = json!({
        "asset":{"version":"2.0"},"scene":0,
        "scenes":[{"nodes":[0],"extras":{"pocketAtlas":{
            "kind":"night-street","hemisphere":{"sky":[1,1,1],"ground":[1,1,1]},
            "camera":{"shots":[{"name":"Front","from":shot,"to":shot,"duration":12}]}
        }}}],"nodes":[{"mesh":0}],"meshes":[{"primitives":primitives}],"materials":materials,
        "buffers":[{"byteLength":bin.len()}],"bufferViews":views,"accessors":accessors
    });
    let glb = gltf::binary::Glb {
        header: gltf::binary::Header { magic: *b"glTF", version: 2, length: 0 },
        json: Cow::Owned(serde_json::to_vec(&document).unwrap()), bin: Some(Cow::Owned(bin)),
    };
    std::fs::write(export.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
    ok(&["import", "--in", export.to_str().unwrap(), "--out", ir.to_str().unwrap()]);
    std::fs::remove_dir_all(export).unwrap();
    for target in ["psp", "3ds", "vita"] {
        let output = temp.0.join(format!("{target}.place"));
        ok(&["--in", ir.to_str().unwrap(), "--out", output.to_str().unwrap(), "--target", target, "--tex", "64"]);
        let bytes = std::fs::read(output).unwrap();
        if target == "psp" {
            let h = pocket3d_place_psp::validate(&bytes).unwrap();
            assert_eq!(h.materials.count, 2, "GE must receive authored materials");
            let draws = pocket3d_place_psp::slice::<pocket3d_place_psp::Draw>(&bytes, h.draws).unwrap();
            for d in draws {
                let vertices = pocket3d_place_psp::slice::<pocket3d_place_psp::Vertex>(&bytes, d.vertices).unwrap();
                for v in vertices {
                    let source = usize::from(v.pos[0] >= 2.0);
                    assert_eq!(v.uv.map(f32::to_bits), uv[source].map(f32::to_bits));
                }
            }
        } else if target == "3ds" {
            let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            let section = |tag: &[u8]| (0..word(8) as usize).map(|i| 16 + i * 16)
                .find(|&at| &bytes[at..at + 4] == tag).map(|at| word(at + 4) as usize).unwrap();
            assert_eq!(word(4), 5);
            let table = section(b"PICA");
            let geom = section(b"GEOM");
            assert_eq!(word(table), 3);
            let meta_section = (0..word(8) as usize).map(|i| 16 + i * 16)
                .find(|&at| &bytes[at..at + 4] == b"META").unwrap();
            let meta_at = word(meta_section + 4) as usize;
            let meta: serde_json::Value = serde_json::from_slice(&bytes[meta_at..meta_at + word(meta_section + 8) as usize]).unwrap();
            assert_eq!(meta["sourceMaterials"], 2, "PICA must receive authored materials");
            // Once their tints have been baked, identical fixed-function
            // states may merge. Roughness is unused on these dry surfaces.
            assert_eq!(word(table + 8), 1);
            let material_at = table + 120 + word(table + 4) as usize * 32;
            let draw_at = material_at + word(table + 8) as usize * 92;
            let mut colors = [None; 2];
            for i in 0..word(table + 12) as usize {
                let d = draw_at + i * 96;
                let vertices = geom + word(d + 4) as usize;
                for j in 0..word(d + 8) as usize {
                    let v = vertices + j * 24;
                    let source = usize::from(f32::from_bits(word(v)) >= 2.0);
                    // This material has no PICA texture unit: UVs are dead after
                    // target shading. They must not become Vita reflectance UVs.
                    assert_eq!([word(v + 12), word(v + 16)], [0,0]);
                    colors[source] = Some([bytes[v + 20], bytes[v + 21], bytes[v + 22]]);
                }
            }
            assert!(colors.iter().all(Option::is_some));
            assert_ne!(colors[0], colors[1], "source tints survive GPU state coalescing");
        } else {
            let pack = pocket3d_place::Pack::parse(&bytes).unwrap();
            let m = pack.meta().unwrap();
            assert_eq!(m.version, 7);
            let geom = pack.section(pocket3d_place::TAG_GEOMETRY).unwrap();
            let mut seen = [false; 2];
            for d in &m.draws {
                let material = &m.materials[d.material as usize];
                assert!(material.vertex_pbr);
                assert_eq!(material.color, [1.0; 4]);
                let source = usize::from(d.min[0] >= 2.0);
                seen[source] = true;
                for v in geom[d.vertices.offset as usize..(d.vertices.offset + d.vertices.size) as usize].chunks_exact(d.layout.stride() as usize) {
                    for k in 0..2 {
                        let q = i16::from_le_bytes(v[16 + k * 2..18 + k * 2].try_into().unwrap());
                        let factor = d.uv_offset[k] + d.uv_scale[k] * q as f32 / 32767.0;
                        assert!((factor - rough_metal[source][k]).abs() < 0.00001);
                    }
                    assert_eq!(&v[20..23], &tint[source][..3].iter().map(|&c| pocket3d_place::color::encode8(c)).collect::<Vec<_>>());
                }
            }
            assert!(seen.into_iter().all(|v| v));
        }
    }
}

fn skin_fixture(root: &Path, joint_count: usize) {
    std::fs::create_dir_all(root).unwrap();
    let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let mut bin: Vec<u8> = positions.into_iter().flat_map(f32::to_le_bytes).collect();
    // Every vertex uses the last joint, so accepting 25 joints cannot pass
    // by dropping an unused tail of the palette.
    let joints_at = bin.len();
    for _ in 0..3 {
        for j in [joint_count.saturating_sub(1) as u16, 0, 0, 0] {
            bin.extend(j.to_le_bytes());
        }
    }
    let weights_at = bin.len();
    for _ in 0..3 {
        for w in [1.0f32, 0.0, 0.0, 0.0] { bin.extend(w.to_le_bytes()); }
    }
    let mut nodes = vec![json!({"mesh":0,"skin":0})];
    nodes.extend((0..joint_count).map(|j| json!({
        "name":format!("joint-{j}"),
        "translation":[if j + 1 == joint_count { 0.25 } else { 0.0 }, 0.0, 0.0]
    })));
    let shot = json!({"pos":[0,1,3],"target":[0,0,0],"fov":45});
    let document = json!({
        "asset":{"version":"2.0"},"scene":0,
        "scenes":[{"nodes":(0..=joint_count).collect::<Vec<_>>(),"extras":{"pocketAtlas":{
            "kind":"night-street","camera":{"shots":[{"name":"Front","from":shot,"to":shot,"duration":12}]}
        }}}],"nodes":nodes,"skins":[{"name":"source-skin","joints":(1..=joint_count).collect::<Vec<_>>()}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0,"JOINTS_0":1,"WEIGHTS_0":2},"material":0}]}],
        "materials":[{"extensions":{"KHR_materials_unlit":{}}}],"extensionsUsed":["KHR_materials_unlit"],
        "buffers":[{"byteLength":bin.len()}],
        "bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":joints_at,"byteLength":24},{"buffer":0,"byteOffset":weights_at,"byteLength":48}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
            {"bufferView":1,"componentType":5123,"count":3,"type":"VEC4"},
            {"bufferView":2,"componentType":5126,"count":3,"type":"VEC4"}]
    });
    let glb = gltf::binary::Glb {
        header: gltf::binary::Header { magic: *b"glTF", version: 2, length: 0 },
        json: Cow::Owned(serde_json::to_vec(&document).unwrap()), bin: Some(Cow::Owned(bin)),
    };
    std::fs::write(root.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
}

#[test]
fn skin_with_25_joints_lowers_independently_for_native_targets() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-skin-targets-{}", std::process::id())));
    let export = temp.0.join("skin-25");
    let ir = temp.0.join("place.ir");
    skin_fixture(&export, 25);
    ok(&["import", "--in", export.to_str().unwrap(), "--out", ir.to_str().unwrap()]);
    std::fs::remove_dir_all(export).unwrap();
    for target in ["psp", "3ds", "vita"] {
        let output = temp.0.join(format!("{target}.place"));
        let args = ["--in", ir.to_str().unwrap(), "--out", output.to_str().unwrap(), "--target", target, "--tex", "64"];
        if target == "vita" {
            let result = run(&args);
            assert!(!result.status.success());
            let error = String::from_utf8_lossy(&result.stderr);
            assert!(error.contains("has 25 joints") && error.contains("Vita supports 1..=24"), "{error}");
            assert!(!output.exists(), "rejected input must not publish a Vita pack");
            continue;
        }
        ok(&args);
        let bytes = std::fs::read(&output).unwrap();
        if target == "psp" {
            let h = pocket3d_place_psp::validate(&bytes).unwrap();
            let draws = pocket3d_place_psp::slice::<pocket3d_place_psp::Draw>(&bytes, h.draws).unwrap();
            assert_eq!(draws.len(), 1);
            let d = &draws[0];
            let joints = pocket3d_place_psp::slice::<pocket3d_place_psp::Joint>(&bytes, d.joints).unwrap();
            assert_eq!(joints.len(), 25);
            assert_eq!(joints[24].inverse, [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
            let nodes = pocket3d_place_psp::slice::<pocket3d_place_psp::Node>(&bytes, h.nodes).unwrap();
            assert_eq!(nodes[joints[24].node as usize].translation, [0.25, 0.0, 0.0]);
            let weights = pocket3d_place_psp::slice::<pocket3d_place_psp::Weights>(&bytes, d.weights).unwrap();
            assert_eq!(weights.len(), 3);
            assert!(weights.iter().all(|w| w.joints[0] == 24 && w.weights == [255, 0, 0, 0]));
        } else {
            let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            let section = |tag: &[u8]| (0..word(8) as usize).map(|i| 16 + i * 16)
                .find(|&at| &bytes[at..at + 4] == tag).map(|at| (word(at + 4) as usize, word(at + 8) as usize)).unwrap();
            let (table, table_size) = section(b"PICA");
            let (anim, _) = section(b"ANIM");
            assert_eq!(word(4), 5);
            assert_eq!(word(table), 3);
            assert_eq!(word(table + 12), 1, "one skinned draw");
            assert_eq!(word(table + 20), 26, "one root transform plus all 25 joints");
            assert_eq!(word(table + 36), 36, "three 12-byte skin records");
            let skin = table + table_size - 36;
            for v in 0..3 {
                let at = skin + v * 12;
                assert_eq!(u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()), 25);
                assert_eq!(&bytes[at + 8..at + 12], &[255, 0, 0, 0]);
            }
            // The last referenced joint retains its transform, not a
            // truncated/clamped palette entry. Matrices use float 3x4 rows.
            assert_eq!(f32::from_bits(word(anim + 25 * 48 + 12)), 0.25);
        }
    }
}

#[test]
fn skin_without_joints_is_rejected_for_every_target() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-empty-skin-{}", std::process::id())));
    let export = temp.0.join("empty-skin");
    let ir = temp.0.join("place.ir");
    skin_fixture(&export, 0);
    ok(&["import", "--in", export.to_str().unwrap(), "--out", ir.to_str().unwrap()]);
    std::fs::remove_dir_all(export).unwrap();
    for target in ["psp", "3ds", "vita"] {
        let output = temp.0.join(format!("{target}.place"));
        let result = run(&["--in", ir.to_str().unwrap(), "--out", output.to_str().unwrap(), "--target", target]);
        assert!(!result.status.success(), "{target} accepted an empty skin");
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(error.contains("has no joints"), "{target}: {error}");
        assert!(!output.exists());
    }
}

#[test]
fn psp_sun_is_refined_before_lods_and_not_added_twice() {
    use pocket3d_place_psp as pp;
    let temp = Temp(std::env::temp_dir().join(format!("atlas-sun-lod-{}", std::process::id())));
    for vertical in [false, true] {
        let export = temp.0.join(if vertical { "wall" } else { "ground" });
        std::fs::create_dir_all(&export).unwrap();
        let rotate = |[x, y, z]: [f32; 3]| if vertical { [x, -z, y] } else { [x, y, z] };
        let mut positions = Vec::new();
        for (height, right) in [(0.0, 4.0), (2.0, -1.0)] {
            let q = [[-4.0,height,-4.0],[-4.0,height,4.0],[right,height,4.0],[right,height,-4.0]];
            for i in [0,1,2,0,2,3] { positions.extend(rotate(q[i])); }
        }
        let normal = rotate([0.0,1.0,0.0]);
        let mut bin: Vec<u8> = positions.iter().flat_map(|v| v.to_le_bytes()).collect();
        let normals = bin.len();
        for _ in 0..12 { bin.extend(normal.iter().flat_map(|v| v.to_le_bytes())); }
        let key = json!({"pos":[0,4,6],"target":[0,0,0],"fov":45});
        let doc = json!({
            "asset":{"version":"2.0"},"scene":0,
            "scenes":[{"nodes":[0],"extras":{"pocketAtlas":{
                "kind":"daytime-street",
                "directionalLights":[{"color":[1,1,1],"intensity":3,"direction":normal,"castShadow":true,
                    "shadow":{"position":[0,8,0],"ortho":[-8,8,-8,8,0.1,20]}}],
                "camera":{"shots":[{"name":"Surface","from":key,"to":key,"duration":12}]}
            }}}],"nodes":[{"mesh":0}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"material":0}]}],
            "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.5,0.5,0.5,1],"metallicFactor":0,"roughnessFactor":0.8}}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":[{"buffer":0,"byteLength":normals},{"buffer":0,"byteOffset":normals,"byteLength":bin.len()-normals}],
            "accessors":[{"bufferView":0,"componentType":5126,"count":12,"type":"VEC3","min":[-4,-4,-4],"max":[4,4,4]},
                {"bufferView":1,"componentType":5126,"count":12,"type":"VEC3"}]
        });
        let glb = gltf::binary::Glb { header: gltf::binary::Header { magic: *b"glTF",version:2,length:0 }, json:Cow::Owned(serde_json::to_vec(&doc).unwrap()),bin:Some(Cow::Owned(bin)) };
        std::fs::write(export.join("scene.glb"),glb.to_vec().unwrap()).unwrap();
        let output = temp.0.join("sun.place");
        ok(&["--in",export.to_str().unwrap(),"--target","psp","--out",output.to_str().unwrap()]);
        let bytes = std::fs::read(output).unwrap();
        let h = pp::validate(&bytes).unwrap();
        let draws = pp::slice::<pp::Draw>(&bytes,h.draws).unwrap();
        let mut floor = Vec::new();
        let mut count = 0;
        for d in draws {
            let vertices = pp::slice::<pp::Vertex>(&bytes,d.vertices).unwrap();
            let indices = pp::slice::<u16>(&bytes,d.indices).unwrap();
            count += indices.len()/3;
            for &i in indices {
                let v = &vertices[i as usize];
                if v.pos[if vertical {2} else {1}].abs() < 1e-4 { floor.push(*v); }
            }
        }
        assert!(count > 4, "sun boundary must drive refinement even without sky AO (vertical={vertical}, triangles={count})");
        let shadow = pocket3d_place::color::tone([0.0;3],&Default::default())[0]*255.0;
        assert!(floor.iter().any(|v| v.pos[0] < -2.0 && (v.color.to_le_bytes()[0] as f32-shadow).abs() < 3.0), "building shadow must remain; dark={shadow}, samples={:?}", floor.iter().map(|v|(v.pos,v.color.to_le_bytes()[0])).collect::<Vec<_>>());
        let expected = pocket3d_place::color::tone([0.5*3.0/std::f32::consts::PI;3],&Default::default())[0]*255.0;
        assert!(floor.iter().any(|v| v.pos[0] > 2.0 && (v.color.to_le_bytes()[0] as f32-expected).abs() < 3.0), "sunlight must be added exactly once");
    }
}

#[test]
fn semantic_texture_intent_overrides_legacy_size_and_luminance_in_each_backend() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-intent-{}",std::process::id())));
    let export = temp.0.join("strip");
    fixture(&export,2048,16);
    for (usage,expect) in [("surface",[256,256,128]),("text-atlas",[2048,1024,512])] {
        annotate_texture(&export,usage);
        for (target,width) in ["vita","3ds","psp"].into_iter().zip(expect) {
            let dest=temp.0.join(format!("{usage}-{target}.place"));
            let mut args=vec!["--in",export.to_str().unwrap(),"--target",target,"--out",dest.to_str().unwrap(),"--json"];
            if target!="psp" {args.extend(["--tex","256"]);}
            let result=run(&args);assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
            let report:serde_json::Value=serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(report["artifact"]["textures"][0]["width"],width);
            assert_eq!(report["sourceTextures"][0]["usage"],usage);
            assert_eq!(report["validation"]["device"]["status"],"not-recorded");
            assert_eq!(report["validation"]["frameBudget"]["status"],"requires-device-measurement");
            assert_eq!(report["diagnostics"],json!([]));
            assert_eq!(report["artifact"]["bytes"].as_u64().unwrap(),std::fs::metadata(dest).unwrap().len());
        }
    }
    annotate_texture(&export,"guess-a-layout");
    let result=run(&["check","--in",export.to_str().unwrap(),"--json"]);
    assert!(!result.status.success());
    let error:serde_json::Value=serde_json::from_slice(&result.stderr).unwrap();
    assert!(error["diagnostics"][0]["message"].as_str().unwrap().contains("unknown textureUsage"));
}

#[test]
fn profile_budget_failure_preserves_old_artifact_and_receipts_are_repeatable() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-profile-{}",std::process::id())));
    let export=temp.0.join("triangle");fixture(&export,13,7);
    let dest=temp.0.join("scene.place");
    let args=["--in",export.to_str().unwrap(),"--profile","old3ds30","--out",dest.to_str().unwrap(),"--json"];
    let first=run(&args);assert!(first.status.success(),"{}",String::from_utf8_lossy(&first.stderr));
    let second=run(&args);assert!(second.status.success());assert_eq!(first.stdout,second.stdout);
    let report:serde_json::Value=serde_json::from_slice(&first.stdout).unwrap();
    let pack=std::fs::read(&dest).unwrap();let receipt=std::fs::read(dest.with_extension("compile.json")).unwrap();
    let mut profile=report["profile"]["definition"].clone();profile["id"]="tiny-budget".into();profile["budgets"]["sections"]["GEOM"]=1.into();
    let custom=temp.0.join("tiny.json");std::fs::write(&custom,serde_json::to_vec(&profile).unwrap()).unwrap();
    let rejected=run(&["--in",export.to_str().unwrap(),"--profile",custom.to_str().unwrap(),"--out",dest.to_str().unwrap(),"--json"]);
    assert!(!rejected.status.success());assert!(String::from_utf8_lossy(&rejected.stderr).contains("GEOM budget exceeded"));
    let failure:serde_json::Value=serde_json::from_slice(&rejected.stderr).unwrap();
    assert_eq!(failure["validation"]["published"],false);
    assert_eq!(failure["passes"].as_array().unwrap().last().unwrap()["result"]["status"],"failed");
    assert_eq!(failure["diagnostics"].as_array().unwrap().last().unwrap()["code"],"ATLAS_STRUCTURAL_BUDGET");
    assert_eq!(pack,std::fs::read(&dest).unwrap());assert_eq!(receipt,std::fs::read(dest.with_extension("compile.json")).unwrap());
    // All individual sections still fit; reject the combined residency before
    // replacing a previously valid pack or its publication receipt.
    let mut profile = report["profile"]["definition"].clone();
    profile["id"] = "tiny-residency".into();
    profile["budgets"]["maxResidentLinearBytes"] = 1.into();
    std::fs::write(&custom, serde_json::to_vec(&profile).unwrap()).unwrap();
    let rejected = run(&["--in", export.to_str().unwrap(), "--profile", custom.to_str().unwrap(), "--out", dest.to_str().unwrap(), "--json"]);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("resident linear-memory budget exceeded"));
    assert_eq!(pack, std::fs::read(&dest).unwrap());
    assert_eq!(receipt, std::fs::read(dest.with_extension("compile.json")).unwrap());
    let conflict=run(&["check","--in",export.to_str().unwrap(),"--profile","old3ds30","--target","psp","--json"]);
    assert!(!conflict.status.success());assert!(String::from_utf8_lossy(&conflict.stderr).contains("conflicts"));
}

fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest,Sha256};
    format!("{:x}",Sha256::digest(bytes))
}
fn authored_fixture(root: &Path, kind: &str, layout: usize) {
    fixture(root,13,7);
    let raw=std::fs::read(root.join("scene.glb")).unwrap();
    let mut glb=gltf::binary::Glb::from_slice(&raw).unwrap();
    let mut doc:serde_json::Value=serde_json::from_slice(&glb.json).unwrap();
    let authoring=json!({"version":1,"id":format!("test-{kind}-{layout}"),"kind":kind,"seed":42,
        "geometry":"full","resources":[],"sampling":{"startSeconds":0,"durationSeconds":1,"fps":15}});
    let meta=&mut doc["scenes"][0]["extras"]["pocketAtlas"];
    meta["kind"]=kind.into();meta["authoring"]=authoring.clone();
    meta["tracks"]=json!({"fps":15,"frames":15});
    if kind.starts_with("daytime") {meta["sky"]=json!({"model":"test-daylight","horizon":[0.6,0.7,0.8],"zenith":[0.2,0.3,0.5]});}
    // The second layout moves and duplicates geometry; the same recipes must handle both.
    doc["nodes"][0]["extras"]=json!({"pocketAtlas":{"sourceId":"layout/road"}});
    if layout==1 {
        doc["nodes"].as_array_mut().unwrap().push(json!({"mesh":0,"translation":[3.0,0.4,-2.0],"extras":{"pocketAtlas":{"sourceId":"layout/shop"}}}));
        doc["scenes"][0]["nodes"]=json!([0,1]);
    }
    doc["materials"][0]["extras"]=json!({"pocketAtlas":{"textureUsage":{"albedo":"surface"}}});
    glb.json=Cow::Owned(serde_json::to_vec(&doc).unwrap());
    let bytes=glb.to_vec().unwrap();
    std::fs::write(root.join("scene.glb"),&bytes).unwrap();
    let files=json!([{"path":"src/test.ts","sha256":hash(b"synthetic layout fixture")}]);
    let receipt=json!({"schemaVersion":1,"authoring":authoring,"source":{"sha256":hash(&serde_json::to_vec(&files).unwrap()),"files":files},
        "resources":[{"path":"scene.glb","sha256":hash(&bytes)}],"toolchain":{"fixture":true}});
    std::fs::write(root.join("export.json"),serde_json::to_vec(&receipt).unwrap()).unwrap();
}

#[test]
fn two_layouts_per_family_keep_source_ownership_through_each_supported_recipe() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-families-{}",std::process::id())));
    for family in ["night-street","daytime-street"] {
        for layout in 0..2 {
            let export=temp.0.join(format!("{family}-{layout}"));authored_fixture(&export,family,layout);
            for target in ["vita","3ds","psp"] {
                let output=temp.0.join("result.place");
                let result=run(&["--in",export.to_str().unwrap(),"--out",output.to_str().unwrap(),"--target",target,"--json"]);
                assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
                let report:serde_json::Value=serde_json::from_slice(&result.stdout).unwrap();
                assert_eq!(report["export"]["authoring"]["id"],format!("test-{family}-{layout}"));
                assert_eq!(report["passes"].as_array().unwrap().len(),report["recipe"]["passes"].as_array().unwrap().len());
                let owners=&report["artifact"]["textures"][0]["sources"];
                assert!(owners.as_array().unwrap().contains(&json!("layout/road")));
                if layout==1 {assert!(owners.as_array().unwrap().contains(&json!("layout/shop")));}
                let again=run(&["--in",export.to_str().unwrap(),"--out",output.to_str().unwrap(),"--target",target,"--json"]);
                assert_eq!(result.stdout,again.stdout);
            }
        }
    }
}

#[test]
fn partial_or_tampered_authoring_exports_fail_before_replacing_a_sealed_ir() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-export-seal-{}",std::process::id())));
    let export=temp.0.join("export");let ir=temp.0.join("place.ir");
    authored_fixture(&export,"night-street",0);
    let args=["import","--in",export.to_str().unwrap(),"--out",ir.to_str().unwrap(),"--json"];
    ok(&args);
    let sealed=std::fs::read(ir.join("manifest.json")).unwrap();
    let original=std::fs::read(export.join("export.json")).unwrap();
    for mode in ["identity","resource","sampling","source","missing"] {
        let mut receipt:serde_json::Value=serde_json::from_slice(&original).unwrap();
        match mode {
            "identity"=>receipt["authoring"]["id"]="another-place".into(),
            "resource"=>receipt["resources"][0]["sha256"]="0".repeat(64).into(),
            "sampling"=>receipt["authoring"]["sampling"]["durationSeconds"]=20.into(),
            "source"=>receipt["source"]["files"][0]["sha256"]="1".repeat(64).into(),
            _=>receipt["resources"]=json!([]),
        }
        std::fs::write(export.join("export.json"),serde_json::to_vec(&receipt).unwrap()).unwrap();
        assert!(!run(&args).status.success(),"accepted {mode}");
        assert_eq!(sealed,std::fs::read(ir.join("manifest.json")).unwrap());
        ok(&["check","--in",ir.to_str().unwrap(),"--target","psp"]);
    }
    std::fs::remove_file(export.join("export.json")).unwrap();
    assert!(!run(&args).status.success());
}

fn annotate_texture(root: &Path, usage: &str) {
    let bytes = std::fs::read(root.join("scene.glb")).unwrap();
    let mut glb = gltf::binary::Glb::from_slice(&bytes).unwrap();
    let mut doc: serde_json::Value = serde_json::from_slice(&glb.json).unwrap();
    doc["materials"][0]["extras"] = json!({"pocketAtlas":{"textureUsage":{"albedo":usage}}});
    glb.json = Cow::Owned(serde_json::to_vec(&doc).unwrap());
    std::fs::write(root.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
}

#[test]
fn cold_warm_disabled_and_corrupt_bake_cache_have_identical_packs_and_receipts() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-cache-{}",std::process::id())));
    let export=temp.0.join("source"); fixture_material(&export,13,7,Some(0.7),"daytime-street");
    let output=temp.0.join("scene.place"); let cache=temp.0.join("cache"); let telemetry=temp.0.join("timing.json");
    let cook=|cache_arg:&str| {
        let result=run(&["--in",export.to_str().unwrap(),"--out",output.to_str().unwrap(),"--target","3ds",
            "--cache",cache_arg,"--telemetry",telemetry.to_str().unwrap(),"--json"]);
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        let timing:serde_json::Value=serde_json::from_slice(&std::fs::read(&telemetry).unwrap()).unwrap();
        let bake=timing.as_array().unwrap().iter().find(|x|x["id"]=="bake-lighting").unwrap()["details"].clone();
        (std::fs::read(&output).unwrap(),result.stdout,bake)
    };
    let cold=cook(cache.to_str().unwrap()); let warm=cook(cache.to_str().unwrap()); let disabled=cook("off");
    assert_eq!((&cold.0,&cold.1),(&warm.0,&warm.1)); assert_eq!((&cold.0,&cold.1),(&disabled.0,&disabled.1));
    assert_eq!(cold.2["cacheMisses"],1); assert_eq!(warm.2["cacheHits"],1);
    let entry=std::fs::read_dir(&cache).unwrap().next().unwrap().unwrap().path();
    std::fs::write(entry,b"truncated entry").unwrap(); let repaired=cook(cache.to_str().unwrap());
    assert_eq!((&cold.0,&cold.1),(&repaired.0,&repaired.1));assert_eq!(repaired.2["cacheMisses"],1);
    // A changed light/occluder/source closure cannot reuse old irradiance.
    fixture_material(&export,17,7,Some(0.9),"daytime-street");
    let changed=cook(cache.to_str().unwrap());assert_eq!(changed.2["cacheHits"],0);
}

#[test]
fn target_selects_source_representations_before_baking_and_respects_world_scale() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-geometry-intent-{}",std::process::id())));
    let export=temp.0.join("source"); fixture_material(&export,13,7,Some(0.7),"daytime-street");
    let raw=std::fs::read(export.join("scene.glb")).unwrap();
    let mut glb=gltf::binary::Glb::from_slice(&raw).unwrap();
    let mut doc:serde_json::Value=serde_json::from_slice(&glb.json).unwrap();
    doc["nodes"]=json!([
        {"children":[1,2],"extras":{"pocketAtlas":{"sourceId":"landmark","geometry":{"role":"detail","maxErrorMeters":0.075},"lodGroup":{"version":1}}}},
        {"mesh":0,"extras":{"pocketAtlas":{"sourceId":"reference","alternative":{"id":"reference","errorMeters":0}}}},
        {"mesh":0,"extras":{"pocketAtlas":{"sourceId":"compact","alternative":{"id":"surface","errorMeters":0.07}}}}
    ]);
    let output=temp.0.join("scene.place");
    for (target,scale,selected) in [("3ds",1.0,"surface"),("vita",1.0,"reference"),("3ds",2.0,"reference")] {
        doc["nodes"][0]["scale"]=json!([scale,scale,scale]);
        glb.json=Cow::Owned(serde_json::to_vec(&doc).unwrap()); std::fs::write(export.join("scene.glb"),glb.to_vec().unwrap()).unwrap();
        let result=run(&["--in",export.to_str().unwrap(),"--out",output.to_str().unwrap(),"--target",target,"--json"]);
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        let report:serde_json::Value=serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(report["provenance"]["sourceGraph"]["alternatives"][0]["selected"],selected);
        assert_eq!(report["provenance"]["geometry"].as_array().unwrap().len(),1);
        assert_eq!(report["recipe"]["passes"][1]["id"],"select-geometry");
    }
    // A malformed unselected alternative is still an error at import/check.
    doc["nodes"][2]["extras"]["pocketAtlas"]["alternative"]["errorMeters"]=(-1).into();
    glb.json=Cow::Owned(serde_json::to_vec(&doc).unwrap());std::fs::write(export.join("scene.glb"),glb.to_vec().unwrap()).unwrap();
    assert!(!run(&["check","--in",export.to_str().unwrap(),"--target","vita"]).status.success());
}

#[test]
fn pica_consumed_texture_uvs_survive_encoded_vertex_compaction() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-pica-used-uv-{}",std::process::id())));
    let export=temp.0.join("source");fixture(&export,13,7);
    let raw=std::fs::read(export.join("scene.glb")).unwrap();
    let mut glb=gltf::binary::Glb::from_slice(&raw).unwrap();
    let mut doc:serde_json::Value=serde_json::from_slice(&glb.json).unwrap();
    let mut bin=glb.bin.as_ref().unwrap().to_vec();while bin.len()%4!=0 {bin.push(0);}
    let offset=bin.len();let uv=[0.1234567f32,0.7654321];
    for _ in 0..3 {for x in uv {bin.extend(x.to_le_bytes());}}
    doc["bufferViews"].as_array_mut().unwrap().push(json!({"buffer":0,"byteOffset":offset,"byteLength":24}));
    doc["accessors"].as_array_mut().unwrap().push(json!({"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"}));
    doc["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"]=1.into();
    doc["buffers"][0]["byteLength"]=bin.len().into();
    glb.json=Cow::Owned(serde_json::to_vec(&doc).unwrap());glb.bin=Some(Cow::Owned(bin));
    std::fs::write(export.join("scene.glb"),glb.to_vec().unwrap()).unwrap();
    let output=temp.0.join("scene.place");ok(&["--in",export.to_str().unwrap(),"--out",output.to_str().unwrap(),"--target","3ds"]);
    let bytes=std::fs::read(output).unwrap();let word=|at:usize|u32::from_le_bytes(bytes[at..at+4].try_into().unwrap());
    let section=|tag:&[u8]|{let header=(0..word(8) as usize).map(|i|16+i*16).find(|&at|&bytes[at..at+4]==tag).unwrap();word(header+4) as usize};
    let table=section(b"PICA");let geometry=section(b"GEOM");
    let draws=table+120+word(table+4) as usize*32+word(table+8) as usize*92;
    for i in 0..word(table+12) as usize {
        let d=draws+i*96;let vertices=geometry+word(d+4) as usize;
        for j in 0..word(d+8) as usize {let v=vertices+j*24;assert_eq!([word(v+12),word(v+16)],uv.map(f32::to_bits));}
    }
}

#[test]
fn output_aliases_are_rejected_without_clobbering_source_or_previous_pack() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-output-alias-{}",std::process::id())));
    let export=temp.0.join("source");fixture(&export,13,7);
    let ir=temp.0.join("place.ir");ok(&["import","--in",export.to_str().unwrap(),"--out",ir.to_str().unwrap()]);
    let output=temp.0.join("scene.place");std::fs::write(&output,b"previous accepted artifact").unwrap();
    let manifest=std::fs::read(ir.join("manifest.json")).unwrap();
    for (flag,path) in [("--telemetry",output.clone()),("--telemetry",ir.join("manifest.json")),("--report",output.clone()),("--report",ir.join("scene.bin"))] {
        let result=run(&["--in",ir.to_str().unwrap(),"--out",output.to_str().unwrap(),flag,path.to_str().unwrap()]);
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("output path aliases"));
        assert_eq!(std::fs::read(&output).unwrap(),b"previous accepted artifact");
        assert_eq!(std::fs::read(ir.join("manifest.json")).unwrap(),manifest);
    }
    #[cfg(unix)] {
        let link=temp.0.join("linked.json");std::os::unix::fs::symlink(&output,&link).unwrap();
        assert!(!run(&["--in",ir.to_str().unwrap(),"--out",output.to_str().unwrap(),"--telemetry",link.to_str().unwrap()]).status.success());
        assert_eq!(std::fs::read(&output).unwrap(),b"previous accepted artifact");
    }
}

#[test]
fn legacy_ir_remains_readable_but_new_semantics_require_version_two() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-ir-version-{}",std::process::id())));
    let export=temp.0.join("source");fixture(&export,13,7);
    let ir=temp.0.join("place.ir");ok(&["import","--in",export.to_str().unwrap(),"--out",ir.to_str().unwrap()]);
    let path=ir.join("manifest.json");
    let mut manifest:serde_json::Value=serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(manifest["version"],2);
    manifest["version"]=1.into();std::fs::write(&path,serde_json::to_vec(&manifest).unwrap()).unwrap();
    ok(&["check","--in",ir.to_str().unwrap()]);
    manifest["features"].as_array_mut().unwrap().push(json!("geometry-intent-v1"));
    std::fs::write(&path,serde_json::to_vec(&manifest).unwrap()).unwrap();
    let result=run(&["check","--in",ir.to_str().unwrap()]);
    assert!(String::from_utf8_lossy(&result.stderr).contains("require PlaceIR v2"));
}

#[test]
fn preserved_instances_follow_rigid_motion_instead_of_becoming_static_copies() {
    let temp=Temp(std::env::temp_dir().join(format!("atlas-moving-instances-{}",std::process::id())));
    let export=temp.0.join("source");fixture(&export,13,7);
    let raw=std::fs::read(export.join("scene.glb")).unwrap();let mut glb=gltf::binary::Glb::from_slice(&raw).unwrap();
    let mut doc:serde_json::Value=serde_json::from_slice(&glb.json).unwrap();let mut bin=glb.bin.as_ref().unwrap().to_vec();
    while bin.len()%4!=0 {bin.push(0);}
    let mut attribute=|data:&[f32],kind:&str,count:usize| {
        let offset=bin.len();bin.extend(data.iter().flat_map(|v|v.to_le_bytes()));
        let view=doc["bufferViews"].as_array().unwrap().len();
        doc["bufferViews"].as_array_mut().unwrap().push(json!({"buffer":0,"byteOffset":offset,"byteLength":bin.len()-offset}));
        let id=doc["accessors"].as_array().unwrap().len();
        doc["accessors"].as_array_mut().unwrap().push(json!({"bufferView":view,"componentType":5126,"count":count,"type":kind}));
        id
    };
    let instances=attribute(&[0.,0.,0.,3.,0.,0.],"VEC3",2);
    let times=attribute(&[0.,1.],"SCALAR",2);let translations=attribute(&[0.,0.,0.,5.,0.,0.],"VEC3",2);
    doc["accessors"][times]["min"]=json!([0]);doc["accessors"][times]["max"]=json!([1]);
    doc["nodes"][0]["extensions"]=json!({"EXT_mesh_gpu_instancing":{"attributes":{"TRANSLATION":instances}}});
    doc["extensionsUsed"].as_array_mut().unwrap().push(json!("EXT_mesh_gpu_instancing"));
    doc["animations"]=json!([{"samplers":[{"input":times,"output":translations}],"channels":[{"sampler":0,"target":{"node":0,"path":"translation"}}]}]);
    doc["buffers"][0]["byteLength"]=bin.len().into();glb.json=Cow::Owned(serde_json::to_vec(&doc).unwrap());glb.bin=Some(Cow::Owned(bin));
    std::fs::write(export.join("scene.glb"),glb.to_vec().unwrap()).unwrap();
    let output=temp.0.join("scene.place");
    let result=run(&["--in",export.to_str().unwrap(),"--out",output.to_str().unwrap(),"--target","vita","--json"]);
    assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
    let receipt:serde_json::Value=serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(receipt["provenance"]["sourceGraph"]["prototypeInstances"]["0"],2);
    let bytes=std::fs::read(&output).unwrap();let pack=pocket3d_place::Pack::parse(&bytes).unwrap();let meta=pack.meta().unwrap();
    assert_eq!(meta.draws.len(),2);
    assert!(meta.draws.iter().all(|d|d.node==Some(0)),"instances must retain the parent animation");
    assert!(meta.draws.iter().any(|d|d.min[0]>=3.0));
    assert_eq!(meta.nodes.len(),1);
    assert!(meta.nodes[0].track.is_some());
}
