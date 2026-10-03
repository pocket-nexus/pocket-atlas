//! RouteIR → route pack: the kit is cooked as a place, cells are baked,
//! reduced and quantized on their own, and the pack reads back.
use pocket3d_place as pc;
use pocket3d_place::route as rt;
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
    Command::new(env!("CARGO_BIN_EXE_pocket-atlas-cook")).args(args).env("RAYON_NUM_THREADS", "2").output().unwrap()
}

/// A kit with one lit material, `snow`, on a swatch.
fn kit(root: &Path) {
    std::fs::create_dir_all(root).unwrap();
    let pos = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let bin: Vec<u8> = pos.into_iter().flat_map(f32::to_le_bytes).collect();
    let shot = json!({"pos":[0,1,3],"target":[0,0,0],"fov":45});
    let document = json!({
        "asset":{"version":"2.0"}, "scene":0,
        "scenes":[{"nodes":[0],"extras":{"pocketAtlas":{
            "kind":"snow-road",
            "hemisphere":{"sky":[0.8,0.85,0.94],"ground":[0.7,0.7,0.8],"intensity":2.0},
            "fog":{"color":[0.8,0.8,0.8],"density":0.0004},
            "snow":{"count":100,"box":[40,24,40],"fall":1.2,"wind":[0.5,0.2],"size":0.03,"shutter":0.016,"color":[1,1,1],"opacity":0.5},
            "camera":{"shots":[{"name":"Start","from":shot,"to":shot,"duration":12}]}
        }}}], "nodes":[{"mesh":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],
        "materials":[{"name":"snow","pbrMetallicRoughness":{"baseColorFactor":[0.9,0.9,0.95,1.0],"roughnessFactor":0.8,"metallicFactor":0.0}}],
        "buffers":[{"byteLength":bin.len()}],
        "bufferViews":[{"buffer":0,"byteLength":36}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,0,1]}]
    });
    let glb = gltf::binary::Glb { header: gltf::binary::Header { magic: *b"glTF", version: 2, length: 0 }, json: Cow::Owned(serde_json::to_vec(&document).unwrap()), bin: Some(Cow::Owned(bin)) };
    std::fs::write(root.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
}

/// `cells.bin` with a 17 × 17 grid of a floor and a rise in one base cell, and an empty detail cell.
fn cells(path: &Path, material: &str) {
    let n = 17usize;
    let (mut pos, mut nrm, mut uv, mut col, mut idx) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::<u32>::new());
    for j in 0..n {
        for i in 0..n {
            // A 4 m rise down the middle of a 2 m grid: the floor at its foot sees less sky.
            let y = if i >= 8 { 4.0f32 } else { 0.0 };
            pos.extend([i as f32 * 2.0, 200.0 + y, j as f32 * 16.0]);
            nrm.extend([0.0f32, 1.0, 0.0]);
            uv.extend([i as f32 * 4.0, j as f32 * 4.0]);
            col.extend([255u8, 255, 255, 255]);
        }
    }
    for j in 0..n - 1 {
        for i in 0..n - 1 {
            let a = (j * n + i) as u32;
            idx.extend([a, a + n as u32, a + 1, a + 1, a + n as u32, a + n as u32 + 1]);
        }
    }
    let mut out: Vec<u8> = Vec::new();
    out.extend(b"RCEL");
    for v in [1u32, 1, 2, 64] {
        out.extend(v.to_le_bytes());
    }
    out.extend((material.len() as u16).to_le_bytes());
    out.extend(material.as_bytes());
    out.resize(64, 0);
    let cell = |out: &mut Vec<u8>, layer: u32, prims: u32| {
        for v in [layer, 3u32, (-2i32) as u32, prims] {
            out.extend(v.to_le_bytes());
        }
        for v in [768.0f64, 0.0, -512.0] {
            out.extend(v.to_le_bytes());
        }
    };
    cell(&mut out, 1, 1);
    for v in [0u32, (n * n) as u32, idx.len() as u32, 0] {
        out.extend(v.to_le_bytes());
    }
    for v in pos.iter().chain(&nrm).chain(&uv) {
        out.extend(v.to_le_bytes());
    }
    out.extend(&col);
    for v in &idx {
        out.extend(v.to_le_bytes());
    }
    cell(&mut out, 0, 0);
    std::fs::write(path, out).unwrap();
}

fn route(root: &Path, material: &str) {
    kit(&root.join("kit"));
    cells(&root.join("cells.bin"), material);
    let line: Vec<u8> = (0..40).flat_map(|i| [800.0f32, 200.0, -(i as f32) * 5.0, 4.25]).flat_map(f32::to_le_bytes).collect();
    std::fs::write(root.join("line.bin"), line).unwrap();
    let car = json!({"mass":940,"inertia":1250,"wheelbase":2.46,"front":1.1,"rear":1.36,"halfWidth":0.74,"nose":1.78,"tail":1.615,"wheelRadius":0.275,"power":31000,"force":3300,"brake":7800,"engineBrake":260,"rolling":0.028,"drag":0.52,"stiffnessFront":9.5,"stiffnessRear":11.5,"lock":0.56,"steerRate":1.5,"steerSpeed":9,"top":30.5,"reverse":6});
    let manifest = json!({
        "version":1,"id":"test-route","kit":"kit","length":195.0,"step":5,"samples":40,
        "layers":[{"name":"detail","size":256,"radius":640},{"name":"base","size":256,"radius":2400}],
        "stops":[{"name":"A","native":"あ","s":0},{"name":"B","native":"い","s":195}],
        "limits":[{"s":0,"kmh":50}],"car":car,"departure":900,
        "views":[{"name":"Start","pos":[800,202,0],"target":[800,201,-50],"fov":45}]
    });
    std::fs::write(root.join("route.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
}

#[test]
fn a_route_cooks_into_cells_that_read_back() {
    let temp = Temp(std::env::temp_dir().join(format!("atlas-route-{}", std::process::id())));
    let ir = temp.0.join("test-route");
    route(&ir, "snow");
    let out = temp.0.join("test.route");
    let args = ["route", "--in", ir.to_str().unwrap(), "--out", out.to_str().unwrap(), "--tex", "256"];
    let r = run(&args);
    assert!(r.status.success(), "{}\n{}", String::from_utf8_lossy(&r.stdout), String::from_utf8_lossy(&r.stderr));
    let pack = std::fs::read(&out).unwrap();

    let sections = pc::Pack::parse_header_versioned(&pack, rt::MAGIC, rt::VERSION).unwrap();
    let section = |tag: [u8; 4]| {
        let s = sections.iter().find(|s| s.tag == tag).unwrap();
        &pack[s.offset as usize..(s.offset + s.size) as usize]
    };
    let meta: rt::RouteMeta = serde_json::from_slice(section(rt::TAG_META)).unwrap();
    assert_eq!((meta.name.as_str(), meta.samples, meta.stops.len(), meta.layers.len()), ("test-route", 40, 2, 2));
    assert_eq!(meta.car.half_width, 0.74);
    assert_eq!(section(rt::TAG_LINE).len(), 40 * 16);

    // The kit is a place pack with the snow material and the snow annotation.
    let kit = pc::Pack::parse(section(rt::TAG_KIT)).unwrap().meta().unwrap();
    let snow = kit.materials.iter().position(|m| m.name == "snow").unwrap() as u32;
    assert_eq!(kit.snow.map(|s| s.count), Some(100));
    assert_eq!(kit.kind, "snow-road");

    // The empty cell has no entry; the other reads back as one baked draw with reduced levels.
    let index = rt::CellEntry::decode_all(section(rt::TAG_INDEX));
    assert_eq!(index.len(), 1);
    let e = index[0];
    assert_eq!((e.layer, e.ix, e.iz, e.origin), (1, 3, -2, [768.0, 0.0, -512.0]));
    assert_eq!((e.min_y, e.max_y), (200.0, 204.0));
    let blob = &section(rt::TAG_CELLS)[e.offset as usize..(e.offset + e.size) as usize];
    let (count, geom, _) = rt::cell_header(blob).unwrap();
    let draws = rt::cell_draws(blob).unwrap();
    assert_eq!(count, 1);
    let d = draws[0];
    assert_eq!((d.material, d.vertex_count, d.index_count), (snow, 289, 16 * 16 * 6));
    assert_eq!((d.min, d.max), ([0.0, 200.0, 0.0], [32.0, 204.0, 256.0]));
    assert!(d.lod_count >= 1 && d.lods[0].1 < d.index_count && d.lods[0].2 > 0.0, "{d:?}");
    // Baked layout: 28 bytes a vertex, light in the last four. Open floor is brighter than the foot of the step.
    let v = |i: usize| &blob[geom + d.vertex_offset as usize + i * 28..][..28];
    let light = |i: usize| {
        let l = &v(i)[24..28];
        (l[0] as f32 / 255.0 * l[3] as f32 / 255.0).powi(2) * 64.0
    };
    let (open, foot) = (light(8 * 17 + 2), light(8 * 17 + 7));
    assert!(open > 0.3 && foot < open * 0.9, "open {open}, foot of the step {foot}");
    // Every index addresses the draw's vertices.
    let idx = &blob[geom + d.index_offset as usize..][..d.index_count as usize * 2];
    assert!(idx.chunks_exact(2).all(|c| (u16::from_le_bytes([c[0], c[1]]) as u32) < d.vertex_count));

    // The same input cooks to the same bytes.
    let again = temp.0.join("again.route");
    assert!(run(&["route", "--in", ir.to_str().unwrap(), "--out", again.to_str().unwrap(), "--tex", "256"]).status.success());
    assert!(pack == std::fs::read(&again).unwrap(), "route cook is not repeatable");

    // Only Vita has a lowering, and a material the kit lacks fails the cook.
    let r = run(&["route", "--in", ir.to_str().unwrap(), "--out", again.to_str().unwrap(), "--target", "psp"]);
    assert!(!r.status.success() && String::from_utf8_lossy(&r.stderr).contains("no psp lowering"));
    cells(&ir.join("cells.bin"), "moss");
    let r = run(&["route", "--in", ir.to_str().unwrap(), "--out", again.to_str().unwrap()]);
    assert!(!r.status.success() && String::from_utf8_lossy(&r.stderr).contains("\"moss\""), "{}", String::from_utf8_lossy(&r.stderr));
}
