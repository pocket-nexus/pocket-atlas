//! A generic authored day street must lower to PSP independently of Vita.
use pocket3d_place_psp as pp;
use serde_json::json;
use std::{borrow::Cow, path::Path, process::Command};

fn fixture(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    image::RgbaImage::from_pixel(16, 16, image::Rgba([160, 100, 80, 255]))
        .save(path.join("cloud.png"))
        .unwrap();
    let mut bin = Vec::new();
    let mut views = Vec::new();
    let mut accessors = Vec::new();
    let mut add = |values: &[f32], count: usize, ty: &str| {
        let offset = bin.len();
        bin.extend(values.iter().flat_map(|v| v.to_le_bytes()));
        views.push(json!({"buffer":0,"byteOffset":offset,"byteLength":bin.len()-offset}));
        let id = accessors.len();
        let mut accessor = json!({"bufferView":id,"componentType":5126,"count":count,"type":ty});
        if ty == "VEC3" && count == 3 {
            accessor["min"] = json!([0, 0, 0]);
            accessor["max"] = json!([1, 1, 0]);
        }
        if ty == "SCALAR" {
            accessor["min"] = json!([0]);
            accessor["max"] = json!([64]);
        }
        accessors.push(accessor);
        id
    };
    let pos = add(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], 3, "VEC3");
    let times = add(&[0.0, 32.0, 959.0 / 15.0], 3, "SCALAR");
    let translations = add(&[0.0, 0.0, 0.0, 20.0, 4.0, 0.0, 0.0, 0.0, 0.0], 3, "VEC3");
    let weights = add(
        &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0],
        3,
        "VEC4",
    );
    let joint_id = accessors.len();
    views.push(json!({"buffer":0,"byteOffset":bin.len(),"byteLength":12}));
    bin.extend([0u8, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
    accessors.push(json!({"bufferView":joint_id,"componentType":5121,"count":3,"type":"VEC4"}));
    let camera = json!({"pos":[0,1,3],"target":[0,1,0],"fov":45});
    let j = json!({
        "asset":{"version":"2.0"},"scene":0,
        "scenes":[{"nodes":[0,1,2,3],"extras":{"pocketAtlas":{
            "kind":"daytime-street","tracks":{"fps":15,"frames":960},
            "hemisphere":{"sky":[0.4,0.5,0.8],"ground":[0.2,0.2,0.2],"intensity":0.5},
            "directionalLights":[{"direction":[0,1,0],"color":[1,0.9,0.8],"intensity":2}],
            "sky":{"model":"gradient-sun-cloudpanorama","zenith":[0.1,0.2,0.8],"horizon":[0.6,0.7,0.9],"ground":[0.2,0.2,0.2],"sunDirection":[0,1,0],"sunColor":[1,1,1],"disc":{"intensity":4,"cosInner":0.99999,"cosOuter":0.99995},"clouds":{"file":"cloud.png","sunScale":1,"sunColor":[1,1,1],"ambientColor":[0.3,0.4,0.5],"driftTurnsPerSecond":0.001}},
            "camera":{"shots":[{"name":"Day","from":camera,"to":camera,"duration":64}]},
            "audio":{"version":1,"loopSeconds":64,"windGain":0.2}
        }}}],
        "nodes":[{"mesh":0},{"name":"joint-a"},{"name":"joint-b"},{"mesh":1,"skin":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":pos},"material":0}]},{"primitives":[{"attributes":{"POSITION":pos,"JOINTS_0":joint_id,"WEIGHTS_0":weights},"material":0}]}],
        "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.8,0.6,0.4,1],"roughnessFactor":0.8}}],
        "skins":[{"joints":[1,2]}],
        "animations":[{"samplers":[{"input":times,"output":translations,"interpolation":"LINEAR"}],"channels":[{"sampler":0,"target":{"node":1,"path":"translation"}},{"sampler":0,"target":{"node":2,"path":"translation"}}]}],
        "buffers":[{"byteLength":bin.len()}],"bufferViews":views,"accessors":accessors
    });
    let glb = gltf::binary::Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        },
        json: Cow::Owned(serde_json::to_vec(&j).unwrap()),
        bin: Some(Cow::Owned(bin)),
    };
    std::fs::write(path.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
}

#[test]
fn day_sky_full_rate_skin_motion_and_audio_lower_without_vita_products() {
    let temp = std::env::temp_dir().join(format!("atlas-psp-daylight-{}", std::process::id()));
    let source = temp.join("generic-day-street");
    fixture(&source);
    let output = temp.join("day.place");
    let run = || {
        let result = Command::new(env!("CARGO_BIN_EXE_pocket-atlas-cook"))
            .args([
                "--in",
                source.to_str().unwrap(),
                "--out",
                output.to_str().unwrap(),
                "--target",
                "psp",
            ])
            .env("RAYON_NUM_THREADS", "2")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        std::fs::read(&output).unwrap()
    };
    let bytes = run();
    let receipt_path = output.with_extension("compile.json");
    let receipt = || -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap()
    };
    assert_eq!(receipt()["analysis"]["cellMeters"], 8.0);
    let h = pp::validate(&bytes).unwrap();
    assert_eq!(h.version, 4);
    assert_eq!(h.sky_vertices.count, 32 * 16 * 6);
    for v in pp::slice::<pp::Vertex>(&bytes, h.sky_vertices).unwrap() {
        let radius2: f32 = v.pos.iter().map(|x| x * x).sum();
        assert!((radius2 - 1.0).abs() < 1e-5);
    }
    assert_eq!((h.frames, h.fps), (960, 15.0));
    assert_eq!(h.lod_pixels, 1.0);
    assert_eq!(h.cloud_drift, 0.001);
    let textures = pp::slice::<pp::Texture>(&bytes, h.textures).unwrap();
    for id in [h.sky_texture, h.cloud_texture] {
        let t = &textures[id as usize];
        assert_eq!(
            (t.width, t.height, t.format, t.pixels.count),
            (512, 256, pp::RGBA8888, 512 * 256 * 4)
        );
    }
    let nodes = pp::slice::<pp::Node>(&bytes, h.nodes).unwrap();
    let tracks: Vec<_> = nodes.iter().filter(|n| n.track.count > 0).collect();
    assert_eq!(tracks.len(), 2);
    assert_eq!(
        tracks[0].track.offset, tracks[1].track.offset,
        "identical motion should share encoded samples"
    );
    for node in tracks {
        assert_eq!((node.track.count, node.track_encoding), (960, 1));
        let keys = pp::slice::<pp::PackedTrs>(&bytes, node.track).unwrap();
        for (frame, key) in keys.iter().enumerate() {
            let t = frame as f32 / 15.0;
            let x = if t <= 32.0 {
                t * 20.0 / 32.0
            } else {
                (959.0 / 15.0 - t) * 20.0 / (959.0 / 15.0 - 32.0)
            };
            let decoded = pp::decode_trs(node, key);
            assert!(
                (decoded[0] - x).abs() < 0.001,
                "frame {frame}: {} vs {x}",
                decoded[0]
            );
        }
    }
    let draws = pp::slice::<pp::Draw>(&bytes, h.draws).unwrap();
    assert!(draws
        .iter()
        .any(|d| d.vertex_format == 1 && d.weights.count == 0));
    let skin = draws.iter().find(|d| d.weights.count != 0).unwrap();
    assert_eq!(skin.vertex_format, 0);
    assert_eq!((skin.indices.count, skin.joints.count), (3, 2));
    let audio = pp::slice::<f32>(&bytes, h.audio).unwrap();
    assert_eq!(audio.len(), 32);
    assert_eq!(&audio[..3], &[1.0, 64.0, 0.2]);
    assert_eq!(bytes, run(), "PSP daytime lowering must be deterministic");
    // A stricter target recipe falls back to original float geometry and
    // every original motion sample; it never silently exceeds its limit.
    let mut profile: serde_json::Value =
        serde_json::from_str(include_str!("../../../profiles/psp30.json")).unwrap();
    profile["recipe"]["pspGeometry"]["vertexPositionErrorMeters"] = json!(0.0);
    profile["recipe"]["pspGeometry"]["trackPositionErrorMeters"] = json!(0.0);
    profile["recipe"]["pspGeometry"]["lodPixels"] = json!(0.0);
    let profile_path = temp.join("exact-profile.json");
    std::fs::write(&profile_path, serde_json::to_vec(&profile).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_pocket-atlas-cook"))
        .args([
            "--in",
            source.to_str().unwrap(),
            "--out",
            output.to_str().unwrap(),
            "--profile",
            profile_path.to_str().unwrap(),
        ])
        .env("RAYON_NUM_THREADS", "2")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let exact = std::fs::read(&output).unwrap();
    let h = pp::validate(&exact).unwrap();
    assert_eq!(h.lod_pixels, 0.0);
    assert!(pp::slice::<pp::Draw>(&exact, h.draws)
        .unwrap()
        .iter()
        .all(|d| d.vertex_format == 0));
    for node in pp::slice::<pp::Node>(&exact, h.nodes)
        .unwrap()
        .iter()
        .filter(|n| n.track.count > 0)
    {
        assert_eq!((node.track_encoding, node.track.count), (0, 960 * 7));
    }
    let result = Command::new(env!("CARGO_BIN_EXE_pocket-atlas-cook"))
        .args([
            "--in",
            source.to_str().unwrap(),
            "--out",
            output.to_str().unwrap(),
            "--target",
            "psp",
            "--cell",
            "16",
        ])
        .env("RAYON_NUM_THREADS", "2")
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(
        receipt()["analysis"]["cellMeters"],
        16.0,
        "explicit CLI analysis cell overrides the target recipe"
    );
    let glb_bytes = std::fs::read(source.join("scene.glb")).unwrap();
    let glb = gltf::binary::Glb::from_slice(&glb_bytes).unwrap();
    let mut document: serde_json::Value = serde_json::from_slice(&glb.json).unwrap();
    let extras = &mut document["scenes"][0]["extras"]["pocketAtlas"];
    extras["kind"] = json!("night-street");
    extras.as_object_mut().unwrap().remove("sky");
    let night = gltf::binary::Glb {
        header: glb.header,
        json: Cow::Owned(serde_json::to_vec(&document).unwrap()),
        bin: glb.bin,
    };
    std::fs::write(source.join("scene.glb"), night.to_vec().unwrap()).unwrap();
    // --in export reimports the sealed IR when authoring metadata changes.
    let bytes = run();
    assert_eq!(
        receipt()["analysis"]["cellMeters"],
        32.0,
        "legacy night profile keeps its existing spatial policy"
    );
    let h = pp::validate(&bytes).unwrap();
    assert_eq!((h.sky_texture, h.lod_pixels), (pp::NONE, 0.0));
    std::fs::remove_dir_all(temp).unwrap();
}
