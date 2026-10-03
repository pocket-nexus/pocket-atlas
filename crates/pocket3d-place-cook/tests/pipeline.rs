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
    Command::new(env!("CARGO_BIN_EXE_pocket-atlas-cook"))
        .args(args)
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
    let document = json!({
        "asset":{"version":"2.0"}, "scene":0,
        "scenes":[{"nodes":[0],"extras":{"pocketAtlas":{
            "kind":"night-street", "camera":{"shots":[{"name":"Front","from":shot,"to":shot,"duration":12}]}
        }}}], "nodes":[{"mesh":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],
        "materials":[{"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}, "extensions":{"KHR_materials_unlit":{}}}],
        "extensionsUsed":["KHR_materials_unlit"],
        "textures":[{"source":0}], "images":[{"bufferView":1,"mimeType":"image/png"}],
        "buffers":[{"byteLength":bin.len()}],
        "bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":image_start,"byteLength":bin.len()-image_start}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}]
    });
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
            let word = |at: usize| u32::from_le_bytes(first[at..at + 4].try_into().unwrap());
            let pica = (0..word(8) as usize).map(|i| 16 + i * 16)
                .find(|&at| &first[at..at + 4] == b"PICA").unwrap();
            let table = word(pica + 4) as usize;
            for old in [2u32, 3] {
                let mut legacy = first.clone();
                legacy[table..table + 4].copy_from_slice(&old.to_le_bytes());
                std::fs::write(&output, legacy).unwrap();
                assert!(!Command::new(&reader).arg(&output).status().unwrap().success(),
                        "PICA v4 must reject old frame-major matrix tables");
            }
            for length in [0, 4, 15, 16, table + 119] {
                std::fs::write(&output, &first[..length]).unwrap();
                assert!(!Command::new(&reader).arg(&output).status().unwrap().success());
            }
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
fn vita_palette_encoding_does_not_replace_native_uvs_or_material_factors() {
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
            assert_eq!(word(table), 4);
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
                    assert_eq!([word(v + 12), word(v + 16)], uv[source].map(f32::to_bits));
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
            assert_eq!(word(table), 4);
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
            // truncated/clamped palette entry. PICA v4 stores a typed track.
            let track = anim + 25 * 12;
            assert_eq!(word(track + 4), 1);
            assert_eq!(word(track + 8), 1);
            let sample = anim + word(track) as usize;
            assert_eq!(f32::from_bits(word(sample)), 0.25);
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
fn pica_runtime_animation_and_skin_bounds_contracts() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-pica-motion-{}", std::process::id())));
    std::fs::create_dir_all(&temp.0).unwrap();
    let cooker = Path::new(env!("CARGO_MANIFEST_DIR"));
    for name in ["animation", "skin_bounds", "frustum"] {
        let executable = temp.0.join(name);
        let compile = Command::new("cc")
            .args(["-std=c11", "-Wall", "-Wextra", "-Werror"])
            .arg(cooker.join(format!("../../n3ds/tests/{name}.c")))
            .args(["-lm", "-o"]).arg(&executable).output().unwrap();
        assert!(compile.status.success(), "{name}: {}", String::from_utf8_lossy(&compile.stderr));
        assert!(Command::new(executable).status().unwrap().success(), "{name}");
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
    assert_eq!(pack,std::fs::read(&dest).unwrap());assert_eq!(receipt,std::fs::read(dest.with_extension("compile.json")).unwrap());
    let conflict=run(&["check","--in",export.to_str().unwrap(),"--profile","old3ds30","--target","psp","--json"]);
    assert!(!conflict.status.success());assert!(String::from_utf8_lossy(&conflict.stderr).contains("conflicts"));
}

fn annotate_texture(root: &Path, usage: &str) {
    let bytes = std::fs::read(root.join("scene.glb")).unwrap();
    let mut glb = gltf::binary::Glb::from_slice(&bytes).unwrap();
    let mut doc: serde_json::Value = serde_json::from_slice(&glb.json).unwrap();
    doc["materials"][0]["extras"] = json!({"pocketAtlas":{"textureUsage":{"albedo":usage}}});
    glb.json = Cow::Owned(serde_json::to_vec(&doc).unwrap());
    std::fs::write(root.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
}
