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
fn one_image_preserves_distinct_wrap_modes_and_reuses_equivalent_samplers() {
    use pocket3d_place as pc;
    let temp = Temp(std::env::temp_dir().join(format!("atlas-samplers-{}", std::process::id())));
    let export = temp.0.join("same-image");
    let ir = temp.0.join("source.ir");
    fixture(&export, 4, 4);
    let source = std::fs::read(export.join("scene.glb")).unwrap();
    let mut glb = gltf::binary::Glb::from_slice(&source).unwrap();
    let mut document: serde_json::Value = serde_json::from_slice(&glb.json).unwrap();
    document["samplers"] = json!([
        {"wrapS":33071, "wrapT":10497},
        {"wrapS":10497, "wrapT":33648},
        {"wrapS":10497, "wrapT":10497}
    ]);
    document["textures"] = json!([
        {"source":0}, // Default repeat on both axes.
        {"source":0,"sampler":0},
        {"source":0,"sampler":1},
        {"source":0,"sampler":2} // Explicit repeat is equivalent to default.
    ]);
    document["materials"] = (0..4)
        .map(|i| {
            json!({
                "name":format!("sampler-{i}"),
                "pbrMetallicRoughness":{"baseColorTexture":{"index":i}},
                "extensions":{"KHR_materials_unlit":{}}
            })
        })
        .collect();
    document["meshes"][0]["primitives"] = (0..4)
        .map(|i| {
            json!({
                "attributes":{"POSITION":0},"material":i
            })
        })
        .collect();
    glb.json = Cow::Owned(serde_json::to_vec(&document).unwrap());
    std::fs::write(export.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
    ok(&[
        "import",
        "--in",
        export.to_str().unwrap(),
        "--out",
        ir.to_str().unwrap(),
    ]);
    std::fs::remove_dir_all(export).unwrap();
    let manifest = std::fs::read(ir.join("manifest.json")).unwrap();
    // The shared analysis must preserve the distinction before either target
    // writes its own pixels/layouts; device-encoder behavior is irrelevant.
    for target in ["ipod", "vita"] {
        let output = temp.0.join(format!("{target}.place"));
        ok(&[
            "--in",
            ir.to_str().unwrap(),
            "--out",
            output.to_str().unwrap(),
            "--target",
            target,
        ]);
        let bytes = std::fs::read(output).unwrap();
        let pack = if target == "ipod" {
            pc::ipod::parse(&bytes)
        } else {
            pc::Pack::parse(&bytes)
        }
        .unwrap();
        let meta = pack.meta().unwrap();
        let indices: Vec<_> = (0..4)
            .map(|i| {
                meta.materials
                    .iter()
                    .find(|m| m.name == format!("sampler-{i}"))
                    .unwrap()
                    .albedo
                    .unwrap()
            })
            .collect();
        assert_eq!(indices[0], indices[3]);
        assert_ne!(indices[0], indices[1]);
        assert_ne!(indices[0], indices[2]);
        assert_ne!(indices[1], indices[2]);
        let expected = [
            (pc::Wrap::Repeat, pc::Wrap::Repeat),
            (pc::Wrap::Clamp, pc::Wrap::Repeat),
            (pc::Wrap::Repeat, pc::Wrap::Mirror),
            (pc::Wrap::Repeat, pc::Wrap::Repeat),
        ];
        let pixels = pack.section(pc::TAG_TEXTURES).unwrap();
        let original = pc::parts::slice(pixels, &meta.textures[indices[0] as usize].data).unwrap();
        for (&index, wrap) in indices.iter().zip(expected) {
            let texture = &meta.textures[index as usize];
            assert_eq!((texture.wrap_s, texture.wrap_t), wrap);
            assert_eq!(pc::parts::slice(pixels, &texture.data).unwrap(), original);
        }
    }
    assert_eq!(manifest, std::fs::read(ir.join("manifest.json")).unwrap());
}

#[test]
fn one_ir_builds_four_repeatable_packs_without_web_export_or_vita_intermediate() {
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
    for target in ["ipod", "psp", "3ds", "vita"] {
        let output = temp.0.join("target.place");
        if target == "ipod" {
            // Rebuilding without an optional encoder must not publish an old
            // compression receipt beside the newly uncompressed target pack.
            std::fs::write(
                output.with_extension("ipod-texture-receipt.json"),
                b"obsolete encoder receipt",
            )
            .unwrap();
        }
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
        } else if target == "ipod" {
            assert!(!output.with_extension("ipod-texture-receipt.json").exists());
            use pocket3d_place as pc;
            let pack = pc::ipod::parse(&first).unwrap();
            assert!(pc::Pack::parse(&first).is_err());
            let m = pack.meta().unwrap();
            assert_eq!(m.version, 1);
            let g = pack.section(pc::TAG_GEOMETRY).unwrap();
            assert!(m
                .draws
                .iter()
                .any(|d| (0..d.vertex_count)
                    .any(|i| pc::ipod::position(d, g, i as u16).unwrap()[0].to_bits()
                        == 0.1234567f32.to_bits())));
            assert_eq!((m.textures[0].width, m.textures[0].height), (8, 4));
            let t = &m.textures[0];
            let pixels = pack.section(pc::TAG_TEXTURES).unwrap();
            assert_eq!(
                &pixels[t.data.offset as usize..][..8 * 4 * 4],
                [170, 120, 70, 255].repeat(32)
            );
            let suffixes = ["ipod-color.bin", "ipod-color.json", "ipod-clusters.bin"];
            let sidecars: Vec<_> = suffixes
                .iter()
                .map(|s| std::fs::read(output.with_extension(s)).unwrap())
                .collect();
            ok(&args);
            for (suffix, before) in suffixes.iter().zip(sidecars) {
                assert_eq!(
                    before,
                    std::fs::read(output.with_extension(suffix)).unwrap(),
                    "{suffix} not reproducible"
                );
            }
            let mut corrupt = first.clone();
            corrupt[4..8].copy_from_slice(&pc::VERSION.to_le_bytes());
            assert!(pc::ipod::parse(&corrupt).is_err());
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
