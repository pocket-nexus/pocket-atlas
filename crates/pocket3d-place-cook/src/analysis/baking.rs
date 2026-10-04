//! Static irradiance refinement; no device SDK dependencies.
use super::*;

pub(super) struct Baked {
    pub sun: Option<pc::Sun>,
    pub baked_sun: bool,
}
pub(super) fn run(a: &Args, sx: &Value, cook: &mut Cook<'_>, prims: &mut [Prim], lighting: &lighting::Lighting) -> crate::recipe::Output<Baked> {
    let lighting::Lighting {out_lights, env_meta, environment} = lighting;
    let sun = sx["directionalLights"].as_array().and_then(|a| a.first()).map(|d| {
        let c = v3(&d["color"]);
        let i = f(d, "intensity", 1.0);
        let sh = &d["shadow"];
        pc::Sun {
            direction: v3(&d["direction"]),
            radiance: [c[0] * i, c[1] * i, c[2] * i],
            shadow: (d["castShadow"].as_bool() == Some(true) && sh.is_object()).then(|| {
                let o: Vec<f32> = sh["ortho"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
                pc::SunShadow {
                    position: v3(&sh["position"]),
                    ortho: [o[0], o[1], o[2], o[3], o[4], o[5]],
                    map_size: sh["mapSize"].as_u64().unwrap_or(2048) as u32,
                    bias: f(sh, "bias", 0.0),
                    normal_bias: f(sh, "normalBias", 0.0),
                    radius: f(sh, "radius", 1.0),
                }
            }),
        }
    });
    // ---- static lighting baked into lit static surfaces
    let t_bake = Instant::now();
    let hemi = &sx["hemisphere"];
    let hemi_k = f(hemi, "intensity", 1.0);
    let env_scene = f(&env_meta, "intensity", 0.4);
    let env_arg = environment.map(|i| {
        let t = &cook.textures[i as usize];
        match &t.pixels { pc::Pixels::Environment { rgba16f, levels } => (rgba16f.as_slice(), t.width, *levels), _ => unreachable!() }
    });
    let baker = bake::Baker::new(&out_lights, (v3(&hemi["sky"]).map(|c| c * hemi_k), v3(&hemi["ground"]).map(|c| c * hemi_k)), env_arg);
    // Sky occlusion (`extras.bake.skyOcclusion`): every static surface that is
    // not glass or blended blocks the sky; cut-out foliage blocks part of it.
    let so = &sx["bake"]["skyOcclusion"];
    let baked_sun = a.target == ir::Target::Psp
        && sx["kind"].as_str().is_some_and(|k| k.starts_with("daytime-")) && sun.is_some();
    let occluder = (so.is_object() || (baked_sun && sun.as_ref().is_some_and(|s| s.shadow.is_some()))).then(|| {
        let t_occ = Instant::now();
        let mut tris = Vec::new();
        for p in prims.iter() {
            let m = &cook.materials[p.material as usize];
            if p.moving || p.skin.is_some() || m.kind == pc::Kind::Glass || m.blend != pc::Blend::Opaque {
                continue;
            }
            let opacity = if m.alpha_test > 0.0 { f(so, "foliage", 0.55) } else { 1.0 };
            for t in &p.tris {
                let (a, b, c) = (p.verts[t[0] as usize].pos, p.verts[t[1] as usize].pos, p.verts[t[2] as usize].pos);
                tris.push(occlusion::Tri { a, e1: b - a, e2: c - a, opacity });
            }
        }
        let n = tris.len();
        let occ = occlusion::Occluder::new(tris, f(so, "rays", 48.0) as usize, f(so, "reach", 8.0));
        crate::progress!("sky occlusion over {n} triangles (BVH in {} ms)", t_occ.elapsed().as_millis());
        occ
    });
    // Occlusion varies everywhere a surface meets another; split for it
    // only down to a coarser edge than for lamp pools.
    let mut tolerance = if so.is_object() {
        // Where the camera goes: the walkable boxes and every shot's ends.
        let cam = &sx["camera"];
        let mut lo = Vec3::splat(f32::MAX);
        let mut hi = Vec3::splat(f32::MIN);
        for b in cam["walkable"].as_array().into_iter().flatten() {
            let v: Vec<f32> = b.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
            if v.len() == 6 {
                lo = lo.min(Vec3::new(v[0], v[1], v[2]));
                hi = hi.max(Vec3::new(v[3], v[4], v[5]));
            }
        }
        for s in cam["shots"].as_array().into_iter().flatten() {
            for k in ["from", "to"] {
                let p = Vec3::from(v3(&s[k]["pos"]));
                lo = lo.min(p);
                hi = hi.max(p);
            }
        }
        bake::Tolerance {
            min_edge: f(so, "minEdge", 1.0),
            abs: f(so, "abs", 0.004),
            rel: f(so, "rel", 0.25),
            rounds: f(so, "rounds", 4.0) as u32,
            focus: (lo.x <= hi.x).then_some((lo, hi)),
            grow: f(so, "grow", 0.2),
        }
    } else {
        bake::LIGHTS
    };
    if baked_sun { tolerance = crate::psp::daylight_tolerance(tolerance.focus); }
    let (mut baked_prims, mut tris_before, mut tris_after) = (0usize, 0usize, 0usize);
    let mut cache = crate::cache::Cache::new(a);
    for (primitive, p) in prims.iter_mut().enumerate() {
        let m = &cook.materials[p.material as usize];
        if p.moving || p.skin.is_some() || !matches!(m.kind, pc::Kind::Standard | pc::Kind::Glass) {
            continue;
        }
        // Shop interiors are shaded without the lights (as at runtime).
        let (env_k, direct) = (m.env_strength * env_scene, !m.interior);
        tris_before += p.tris.len();
        let before = p.tris.len();
        let key = cache.key(primitive);
        let (vertices, triangles) = if let Some(hit) = cache.read(&key) { hit } else {
        let r = bake::refine(
            std::mem::take(&mut p.verts),
            std::mem::take(&mut p.tris),
            &|pos, n| {
                let sky = if so.is_object() { occluder.as_ref().map_or(1.0, |o| o.visibility(pos, n)) } else { 1.0 };
                let mut light = baker.irradiance(pos, n, env_k, direct, sky);
                if baked_sun && !m.interior {
                    light += crate::psp::static_sun_light(sun.as_ref(), occluder.as_ref(), pos, n);
                }
                light
            },
            tolerance,
        );
        cache.write(&key, &r.verts, &r.tris);
        (r.verts, r.tris)
        };
        p.verts = vertices;
        p.tris = triangles;
        p.baked = true;
        if std::env::var_os("POCKET_ATLAS_BAKE_REPORT").is_some() {
            let (lo, hi) = p.verts.iter().fold((Vec3::splat(f32::MAX), Vec3::splat(f32::MIN)), |(lo, hi), v| (lo.min(v.pos), hi.max(v.pos)));
            crate::progress!("  bake {:>7} → {:>7}  {:40}  {:?}..{:?}", before, p.tris.len(), cook.materials[p.material as usize].name, lo.round(), hi.round());
        }
        tris_after += p.tris.len();
        baked_prims += 1;
    }
    crate::progress!("baked {baked_prims} primitives: {tris_before} → {tris_after} triangles ({} ms)", t_bake.elapsed().as_millis());
    cook.log.push(format!("bake {baked_prims} primitives, {tris_before} → {tris_after} triangles"));

    crate::recipe::Output::new(Baked {sun, baked_sun}, json!({"primitives":baked_prims,"inputTriangles":tris_before,"outputTriangles":tris_after,"skyOcclusion":so,"directionalSun":baked_sun}))
        .with_telemetry(json!({"cacheHits":cache.hits,"cacheMisses":cache.misses,"cacheEnabled":a.cache.is_some()}))
}
