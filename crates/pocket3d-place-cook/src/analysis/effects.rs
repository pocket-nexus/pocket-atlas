//! Scene effects and final typed scene assembly.
use super::*;

pub(super) fn run(a: &Args, name: &str, source: &read::Source, resolved: resolve::Resolved<'_>, motion: motion::Motion, lighting: lighting::Lighting, baked: baking::Baked, geometry: chunk::Geometry) -> crate::recipe::Output<(pc::Scene, Vec<String>)> {
    let read::Source {doc, sx, ..} = source;
    let resolve::Resolved {mut cook, field, geometry_report, graph_report, ..} = resolved;
    let motion::Motion {node_ids, nodes, skins, fps, frames, ..} = motion;
    let lighting::Lighting {out_lights, env_meta, environment} = lighting;
    let baking::Baked {sun, baked_sun} = baked;
    let chunk::Geometry {draws, scene_min, scene_max, static_draws, field_draws} = geometry;
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
            fog_tracks.push(pc::FogTrack { samples: data.chunks_exact(4).map(|v| v.try_into().unwrap()).collect() });
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
                material_tracks.push(pc::MaterialTrack { samples: data });
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
    let wet = cook.materials.iter().any(|m| m.wet.is_some());
    let puddles = rain.active || wet || cook.materials.iter().any(|m| m.damp.is_some());
    let glass = cook.materials.iter().any(|m| m.kind == pc::Kind::Glass);
    let drops = cook.materials.iter().any(|m| m.kind == pc::Kind::Glass && m.drops > 0.0);
    let night_clouds = sx["sky"]["model"] != "gradient-sun-cloudpanorama";
    let mut effect = |name: &str, img: textures::Rgba, channels: pc::LookupChannels, mips: u32, wrap: pc::Wrap| -> u32 {
        if dump {
            let bytes: Vec<u8> = img.px.iter().flat_map(|p| p.map(|c| (c.clamp(0.0, 1.0) * 255.0) as u8)).collect();
            let _ = image::save_buffer(out_dir.join(format!("{name}.png")), &bytes, img.w, img.h, image::ColorType::Rgba8);
        }
        cook.log.push(format!("lookup {name} {}x{}", img.w, img.h));
        cook.textures.push(pc::Texture {
            name: name.into(),
            usage: None,
            role: pc::TexRole::Data,
            width: img.w,
            height: img.h,
            pixels: pc::Pixels::Lookup { image: img, channels, levels: mips },
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
        puddles: puddles.then(|| effect("fx-puddles", procedural::puddles(512), pc::LookupChannels::Rg, 12, pc::Wrap::Repeat)),
        // 16 frames of 256² over 4 drop cells; mips stop before frames bleed.
        ripples: wet.then(|| effect("fx-ripples", procedural::ripples(256, ripple_grid, 4.0), pc::LookupChannels::Rg, 4, pc::Wrap::Repeat)),
        ripple_grid,
        ripple_tile: 4.0 / 2.3,
        // Glass shaders always sample this slot. Dry glass needs a valid
        // neutral texel, not the 1024-square animated rain lookup.
        beads: glass.then(|| {
            let img = if drops { procedural::beads(1024) } else { textures::Rgba { w: 4, h: 4, px: vec![[0.5, 0.5, 0.0, 1.0]; 16] } };
            effect("fx-beads", img, pc::LookupChannels::Rgb, 12, pc::Wrap::Repeat)
        }),
        clouds: night_clouds.then(|| effect("fx-clouds", procedural::clouds(512, 16.0), pc::LookupChannels::Rg, 12, pc::Wrap::Repeat)),
        cloud_cells: 16.0,
    };
    crate::progress!("effect textures in {} ms", t_fx.elapsed().as_millis());

    let tri_count: u32 = draws.iter().filter(|d| d.class != pc::VertexClass::Lights).map(|d| d.index_count() / 3).sum();
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
    });
    // ---- sun, daytime sky, post
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
            let (w, h) = textures::pow2_fit(w, h, 1024);
            let image = textures::resize(&src, w, h);
            let rgba = textures::to_bytes(&image, pc::TexRole::Data);
            cook.textures.push(pc::Texture {
                name: "sky-clouds".into(),
                usage: None,
                role: pc::TexRole::Data,
                width: w,
                height: h,
                pixels: pc::Pixels::Lookup { image: textures::from_rgba8(w, h, &rgba, pc::TexRole::Data), channels: pc::LookupChannels::Rgba, levels: 1 },
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
    let place = name.to_string();
    let decision = json!({"effects":effects,"daySky":day_sky.is_some(),"materialTracks":material_tracks.len()});
    let mut provenance = crate::provenance::collect(&doc, &cook.mat_keys);
    provenance["geometry"] = geometry_report;
    provenance["sourceGraph"] = graph_report;
    let scene = pc::Scene {
        provenance,
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
        baked_sun,
        day_sky,
        post,
        vista_haze: extras::vista_haze(&sx["haze"]),
        stats: stats.clone(),
    };
    crate::recipe::Output::new((scene, cook.log), decision)
}
