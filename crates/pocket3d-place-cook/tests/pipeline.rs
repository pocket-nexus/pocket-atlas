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
    fixture_material(root, width, height, None);
}
fn fixture_material(root: &Path, width: u32, height: u32, roughness: Option<f32>) {
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
    for (roughness, format, bpp) in [(0.2, pocket3d_place_psp::RGBA8888, 4),
        (0.8, pocket3d_place_psp::RGBA4444, 2)] {
        let source = temp.0.join("surface");
        fixture_material(&source, 32, 16, Some(roughness));
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
