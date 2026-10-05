//! `pocket-atlas-cook atlas`: the web globe export (`scripts/export-atlas.ts`)
//! → `atlas.pack` for the handheld's place picker.

use crate::textures;
use half::f16;
use pocket3d_place as pc;
use pocket3d_place::atlas::{AtlasMeta, AtlasPlace, Globe};
use serde_json::Value;
use std::path::Path;

struct Raw {
    width: u32,
    height: u32,
    channels: usize,
    f32: bool,
    bytes: Vec<u8>,
}

fn raw(dir: &Path, globe: &Value, name: &str) -> Raw {
    let files = globe["files"].as_array().expect("globe.json: files");
    let f = files.iter().find(|f| f["name"] == name).unwrap_or_else(|| panic!("globe.json: no {name}"));
    let path = dir.join(f["file"].as_str().unwrap());
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let r = Raw {
        width: f["width"].as_u64().unwrap() as u32,
        height: f["height"].as_u64().unwrap() as u32,
        channels: f["channels"].as_u64().unwrap() as usize,
        f32: f["format"] == "f32",
        bytes,
    };
    let texel = r.channels * if r.f32 { 4 } else { 1 };
    assert_eq!(r.bytes.len(), (r.width * r.height) as usize * texel, "{name}: size");
    r
}

/// 8-bit maps as RGBA8 texels (missing channels 0, alpha 255).
fn rgba8(r: &Raw) -> Vec<u8> {
    r.bytes
        .chunks_exact(r.channels)
        .flat_map(|p| [p[0], *p.get(1).unwrap_or(&0), *p.get(2).unwrap_or(&0), if r.channels == 4 { p[3] } else { 255 }])
        .collect()
}

/// Float maps as half-float RGBA rows (linear textures, any size).
fn rgba16f(r: &Raw) -> Vec<u8> {
    r.bytes.chunks_exact(4).flat_map(|c| f16::from_f32(f32::from_le_bytes([c[0], c[1], c[2], c[3]])).to_le_bytes()).collect()
}

fn hex_linear(s: &str) -> [f32; 3] {
    let v = u32::from_str_radix(s.trim_start_matches('#'), 16).unwrap_or(0xffffff);
    let lin = |c: u32| pc::color::decode(c as f32 / 255.0);
    [lin(v >> 16 & 255), lin(v >> 8 & 255), lin(v & 255)]
}

pub fn cook(input: &Path, output: &Path) {
    let t0 = std::time::Instant::now();
    let read_json = |n: &str| -> Value {
        let p = input.join(n);
        serde_json::from_slice(&std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).expect("json")
    };
    let g = read_json("globe.json");
    let places = read_json("places.json");

    let mut blob = Vec::new();
    let mut textures = Vec::new();
    let mut push = |name: &str, role: pc::TexRole, format: pc::TexFormat, width: u32, height: u32, mips: u32, data: &[u8], wrap_s: pc::Wrap, alpha: bool| -> u32 {
        while blob.len() % 256 != 0 {
            blob.push(0);
        }
        let range = pc::Range { offset: blob.len() as u32, size: data.len() as u32 };
        blob.extend_from_slice(data);
        println!("  {name:18} {format:?} {width}x{height} ×{mips}  {} KiB", data.len() / 1024);
        textures.push(pc::Texture { name: name.into(), role, format, width, height, mips, data: range, wrap_s, wrap_t: pc::Wrap::Clamp, has_alpha: alpha, mean: [0.0; 4], lod_bias: 0.0 });
        (textures.len() - 1) as u32
    };

    // Surface maps: equirectangular, wrapping in longitude.
    for (name, role, format, cap) in [
        ("albedo", pc::TexRole::Color, pc::TexFormat::Bc3, 2048),
        ("normals", pc::TexRole::Data, pc::TexFormat::Bc3, 1024),
        ("lights", pc::TexRole::Data, pc::TexFormat::Bc5, 2048),
        ("clouds", pc::TexRole::Data, pc::TexFormat::Bc1, 2048),
    ] {
        let r = raw(input, &g, name);
        let src = textures::from_rgba8(r.width, r.height, &rgba8(&r), role);
        // Keep the 2:1 equirectangular aspect (the size fit would square it at the cap).
        let src = textures::resize(&src, cap, cap / 2);
        let e = textures::encode_as(&src, role, format, cap, 12);
        push(name, role, e.format, e.width, e.height, e.mips, &e.data, pc::Wrap::Repeat, format == pc::TexFormat::Bc3);
    }
    // View-ray bakes and the sunlight table: half-float, one level.
    for name in ["space", "inscatter", "transmittance", "sun-transmittance"] {
        let r = raw(input, &g, name);
        assert!(r.f32 && r.channels == 4, "{name}: expected f32 RGBA");
        push(&name.replace('-', "_"), pc::TexRole::Data, pc::TexFormat::Rgba16f, r.width, r.height, 1, &rgba16f(&r), pc::Wrap::Clamp, false);
    }

    let n = |k: &str| g[k].as_f64().unwrap_or_else(|| panic!("globe.json: {k}")) as f32;
    let fr = &g["framing"];
    let cam = &g["camera"];
    let sun: Vec<f32> = g["sun"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
    let globe = Globe {
        width: fr["width"].as_u64().unwrap() as u32,
        height: fr["height"].as_u64().unwrap() as u32,
        fov: cam["fov"].as_f64().unwrap() as f32,
        distance: cam["distance"].as_f64().unwrap() as f32,
        shift_ndc: cam["shiftNdc"].as_f64().unwrap() as f32,
        radius_px: fr["radiusPx"].as_f64().unwrap() as f32,
        center_x: fr["centerX"].as_f64().unwrap() as f32,
        sun: [sun[0], sun[1], sun[2]],
        sun_i: n("sunI"),
        surface: n("surface"),
        lights_max: n("lightsMax"),
        lights_gain: n("lightsGain"),
        night: n("night"),
        cloud_shadow: n("cloudShadow"),
        specular: n("specular"),
        cloud_opacity: n("cloudOpacity"),
        cloud_glow: n("cloudGlow"),
        cloud_drift_per_s: n("cloudDriftPerS"),
        idle_deg_per_s: n("idleDegPerS"),
        start_lat: n("startLat"),
        start_lon: n("startLon"),
        bloom_threshold: n("bloomThreshold"),
        bloom_smoothing: n("bloomSmoothing"),
        bloom_intensity: n("bloomIntensity"),
        vignette_offset: n("vignetteOffset"),
        vignette_darkness: n("vignetteDarkness"),
        grain: n("grain"),
    };
    let s = |p: &Value, k: &str| p[k].as_str().unwrap_or("").to_string();
    let places: Vec<AtlasPlace> = places
        .as_array()
        .expect("places.json")
        .iter()
        .map(|p| AtlasPlace {
            id: s(p, "id"),
            name: s(p, "name"),
            native: s(p, "native"),
            locality: s(p, "locality"),
            locality_native: s(p, "localityNative"),
            country: s(p, "country"),
            lat: p["lat"].as_f64().unwrap_or(0.0) as f32,
            lon: p["lon"].as_f64().unwrap_or(0.0) as f32,
            time_zone: s(p, "timeZone"),
            weather: s(p, "weather"),
            accent: hex_linear(&s(p, "accent")),
            enterable: p["enterable"].as_bool().unwrap_or(false),
            author: s(p, "author"),
            kind: s(p, "kind"),
            tags: p["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
            summary: s(p, "summary"),
            featured: p["featured"].as_bool().unwrap_or(false),
        })
        .collect();
    let meta = AtlasMeta { version: 1, places, textures, globe };
    let json = serde_json::to_vec(&meta).unwrap();
    let bytes = pc::write_as(pc::atlas::MAGIC, &[(pc::TAG_META, &json, 4), (pc::TAG_TEXTURES, &blob, 4096)]);
    std::fs::write(output, &bytes).unwrap_or_else(|e| panic!("{}: {e}", output.display()));
    println!("wrote {} ({:.1} MiB, {} places) in {} ms", output.display(), bytes.len() as f32 / 1048576.0, meta.places.len(), t0.elapsed().as_millis());
}
