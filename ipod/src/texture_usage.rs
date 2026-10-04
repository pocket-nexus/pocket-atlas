//! Optional generated sampler demand for the display profile. This is a pure
//! mapping from the selected pipeline table and META to texture indices: it
//! owns no shaders or GL names, and does not depend on Scene or Renderer.
use alloc::{format, string::String, vec, vec::Vec};
use pocket3d_place as pc;
use serde::Deserialize;

#[derive(Deserialize)]
struct DrawProgram {
    main: [String; 2],
    #[serde(default)]
    reflection: Option<[String; 2]>,
    #[serde(default)]
    wet_response: Option<[String; 2]>,
    #[serde(default)]
    water_response: Option<[String; 2]>,
    #[serde(default)]
    display_color: bool,
    display_texture: Option<u32>,
}

#[derive(Deserialize)]
struct Pipelines {
    draws: Vec<Option<DrawProgram>>,
    sky: [String; 2],
    texture_usage: Manifest,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    draws: Vec<Option<Binding>>,
    sky: Binding,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    program: [String; 2],
    #[serde(default)]
    reflection_program: Option<[String; 2]>,
    #[serde(default)]
    response_program: Option<[String; 2]>,
    #[serde(default)]
    water_response_program: Option<[String; 2]>,
    samplers: Vec<String>,
}

pub struct Plan {
    needed: Vec<bool>,
    original_shadow: bool,
}

#[derive(Clone, Copy)]
enum Albedo {
    Original,
    DisplayExact(Option<u32>),
}

impl Plan {
    /// Older bundles without a manifest conservatively retain every texture.
    /// Once present, a malformed or mismatched manifest is an error.
    pub fn parse(bytes: &[u8], meta: &pc::Meta) -> Result<Option<Self>, String> {
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|e| format!("texture usage pipeline JSON: {e}"))?;
        if value.get("texture_usage").is_none() {
            return Ok(None);
        }
        let pipelines: Pipelines =
            serde_json::from_value(value).map_err(|e| format!("texture usage manifest: {e}"))?;
        let manifest = &pipelines.texture_usage;
        if manifest.version != 1
            || pipelines.draws.len() != meta.draws.len()
            || manifest.draws.len() != meta.draws.len()
            || manifest.sky.program != pipelines.sky
        {
            return Err("texture usage pipeline version, count or sky mismatch".into());
        }
        let mut plan = Self {
            needed: vec![false; meta.textures.len()],
            original_shadow: false,
        };
        // Rain splash effects bind this independently of the mesh pipelines.
        // Retaining it also covers runtime rain toggles without coupling the
        // Scene loader to the Effects shader inventory.
        plan.mark(meta.effects.puddles)?;
        for (i, draw) in meta.draws.iter().enumerate() {
            let pipeline = &pipelines.draws[i];
            let binding = &manifest.draws[i];
            if draw.layout == pc::VertexLayout::Lights {
                if pipeline.is_some() || binding.is_some() {
                    return Err("texture usage light field has a mesh pipeline".into());
                }
                continue;
            }
            let (Some(pipeline), Some(binding)) = (pipeline, binding) else {
                return Err("texture usage mesh pipeline is missing".into());
            };
            if binding.program != pipeline.main || binding.reflection_program != pipeline.reflection || binding.response_program != pipeline.wet_response || binding.water_response_program != pipeline.water_response {
                return Err("texture usage selected program mismatch".into());
            }
            validate_samplers(&binding.samplers)?;
            for name in &binding.samplers {
                plan.draw(
                    meta,
                    draw,
                    name,
                    if pipeline.display_color {
                        Albedo::DisplayExact(pipeline.display_texture)
                    } else {
                        Albedo::Original
                    },
                )?;
            }
        }
        validate_samplers(&manifest.sky.samplers)?;
        for name in &manifest.sky.samplers {
            plan.global(meta, name, true)?;
        }
        Ok(Some(plan))
    }

    pub fn include_recipes(&mut self, recipes: &pc::ipod::Recipes) -> Result<(), String> {
        // Steam has its own generated effect programs, outside mesh bindings.
        self.mark(recipes.steam_coverage)
    }

    pub fn needs_original_shadow(&self) -> bool { self.original_shadow }

    pub fn needs(&self, texture: usize) -> bool {
        self.needed.get(texture).copied().unwrap_or(false)
    }

    fn mark(&mut self, texture: Option<u32>) -> Result<(), String> {
        if let Some(texture) = texture {
            *self
                .needed
                .get_mut(texture as usize)
                .ok_or("texture usage texture reference")? = true;
        }
        Ok(())
    }

    fn draw(
        &mut self,
        meta: &pc::Meta,
        draw: &pc::Draw,
        name: &str,
        albedo: Albedo,
    ) -> Result<(), String> {
        let material = meta
            .materials
            .get(draw.material as usize)
            .ok_or("texture usage material reference")?;
        match name {
            "uAlbedo" => match albedo {
                Albedo::Original => self.mark(material.albedo),
                Albedo::DisplayExact(texture) => self.mark(texture),

            },
            "uNormalMap" => self.mark(material.normal),
            "uOrm" => self.mark(material.orm),
            "uEmission" => self.mark(material.emission),
            "uShadow" => {
                self.original_shadow = true;
                for caster in meta.draws.iter().filter(|d| d.cast_shadow) {
                    let material = meta
                        .materials
                        .get(caster.material as usize)
                        .ok_or("texture usage shadow material reference")?;
                    self.mark(material.albedo)?;
                }
                Ok(())
            }
            _ => self.global(meta, name, false),
        }
    }

    fn global(&mut self, meta: &pc::Meta, name: &str, sky: bool) -> Result<(), String> {
        match name {
            "uEnv" => self.mark(meta.atmosphere.environment),
            "uClouds" if sky => self.mark(
                meta.day_sky
                    .as_ref()
                    .map_or(meta.effects.clouds, |s| s.clouds),
            ),
            "uPuddles" => self.mark(meta.effects.puddles),
            "uRipples" => self.mark(meta.effects.ripples),
            "uBeads" => self.mark(meta.effects.beads),
            // These are owned by Renderer/Effects, not the pack's TEXD. A
            // display environment is derived while its source is still read,
            // validated and hashed; its original HDR GL texture is unnecessary.
            "uDisplayEnv" | "uAtlasLut" | "uLut" | "uMask" | "uGrain" | "uReflSharp"
            | "uReflBlur" | "uDisplayReflSharp" | "uDisplayReflBlur" | "uSource" | "uSupport"
            | "uScene" | "uBloom" | "uHazeTex" | "uWetResponse" | "uWaterResponse" => Ok(()),
            _ => Err(format!("texture usage unknown or misplaced sampler {name}")),
        }
    }
}

/// Call once after linking the selected programs, before creating render
/// targets or drawing. A stale/incomplete sampler manifest must fail visibly,
/// not sample GL name zero. The planner and this check share the same binding
/// dependencies; only the source of sampler liveness differs.
pub fn validate_resident(
    meta: &pc::Meta,
    textures: &[u32],
    color_texture: impl Fn(usize) -> Option<Option<u32>>,
    draw_has: impl Fn(usize, &str) -> bool,
    sky_has: impl Fn(&str) -> bool,
) -> Result<(), String> {
    if textures.len() != meta.textures.len() {
        return Err("texture residency table length".into());
    }
    let mut required = Plan {
        needed: vec![false; meta.textures.len()],
        original_shadow: false,
    };
    required.mark(meta.effects.puddles)?;
    for (i, draw) in meta
        .draws
        .iter()
        .enumerate()
        .filter(|(_, d)| d.layout != pc::VertexLayout::Lights)
    {
        let albedo = color_texture(i).map_or(Albedo::Original, Albedo::DisplayExact);
        for name in [
            "uAlbedo",
            "uNormalMap",
            "uOrm",
            "uEmission",
            "uShadow",
            "uEnv",
            "uPuddles",
            "uRipples",
            "uBeads",
        ] {
            if draw_has(i, name) {
                required.draw(meta, draw, name, albedo)?;
            }
        }
    }
    for name in ["uEnv", "uClouds", "uPuddles", "uRipples", "uBeads"] {
        if sky_has(name) {
            required.global(meta, name, true)?;
        }
    }
    if let Some(i) = textures
        .iter()
        .enumerate()
        .position(|(i, &id)| required.needs(i) && id == 0)
    {
        return Err(format!("active sampler needs nonresident texture {i}"));
    }
    Ok(())
}

fn validate_samplers(names: &[String]) -> Result<(), String> {
    if names.len() > 32 || names.iter().any(|s| s.len() > 64) {
        return Err("texture usage sampler budget".into());
    }
    for (i, name) in names.iter().enumerate() {
        if names[..i].contains(name) {
            return Err("texture usage duplicate sampler".into());
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn manifest(meta: &pc::Meta, samplers: &[&str]) -> serde_json::Value {
        let draws: Vec<_> = meta
            .draws
            .iter()
            .map(|d| {
                if d.layout == pc::VertexLayout::Lights {
                    serde_json::Value::Null
                } else {
                    json!({"main":["v","f"],"display_color":false})
                }
            })
            .collect();
        let bindings: Vec<_> = meta
            .draws
            .iter()
            .map(|d| {
                if d.layout == pc::VertexLayout::Lights {
                    serde_json::Value::Null
                } else {
                    json!({"program":["v","f"],"samplers":samplers})
                }
            })
            .collect();
        json!({"draws":draws,"sky":["sv","sf"],"texture_usage":{
            "version":1,"draws":bindings,"sky":{"program":["sv","sf"],"samplers":[]}
        }})
    }

    #[test]
    fn missing_manifest_is_conservative_present_errors_never_silently_fallback() {
        let (meta, _, _) = crate::validation::tests::fixture();
        assert!(Plan::parse(b"{}", &meta).unwrap().is_none());
        for mode in 0..7 {
            let mut value = manifest(&meta, &["uAlbedo"]);
            match mode {
                0 => value["texture_usage"] = serde_json::Value::Null,
                1 => value["texture_usage"]["version"] = 2.into(),
                2 => value["texture_usage"]["draws"] = json!([]),
                3 => value["texture_usage"]["draws"][0] = serde_json::Value::Null,
                4 => value["texture_usage"]["draws"][0]["program"] = json!(["wrong", "f"]),
                5 => value["texture_usage"]["draws"][0]["samplers"] = json!(["uNewTexture"]),
                _ => value["texture_usage"]["draws"][0]["samplers"] = json!(["uAlbedo", "uAlbedo"]),
            }
            assert!(
                Plan::parse(&serde_json::to_vec(&value).unwrap(), &meta).is_err(),
                "mode {mode}"
            );
        }
    }

    #[test]
    fn sampler_union_preserves_material_global_and_display_texture_dependencies() {
        let (mut meta, _, _) = crate::validation::tests::fixture();
        meta.textures.resize(8, meta.textures[0].clone());
        meta.materials[0].normal = Some(1);
        meta.materials[0].orm = Some(2);
        meta.materials[0].emission = Some(3);
        meta.effects.puddles = Some(4);
        meta.effects.ripples = Some(5);
        meta.effects.clouds = Some(6);
        meta.atmosphere.environment = Some(7);
        let mut value = manifest(&meta, &["uAlbedo", "uNormalMap", "uRipples", "uDisplayEnv"]);
        value["draws"][0]["display_color"] = true.into();
        value["draws"][0]["display_texture"] = 3.into();
        value["texture_usage"]["sky"]["samplers"] = json!(["uClouds"]);
        let plan = Plan::parse(&serde_json::to_vec(&value).unwrap(), &meta)
            .unwrap()
            .unwrap();
        assert_eq!(
            (0..8).filter(|&i| plan.needs(i)).collect::<Vec<_>>(),
            [1, 3, 4, 5, 6]
        );
        value["draws"][0]["display_texture"] = 9.into();
        assert!(Plan::parse(&serde_json::to_vec(&value).unwrap(), &meta).is_err());
        value["draws"][0]["display_texture"] = 3.into();
        value["texture_usage"]["draws"][0]["samplers"] = json!(["uOrm", "uEmission", "uEnv"]);
        let plan = Plan::parse(&serde_json::to_vec(&value).unwrap(), &meta)
            .unwrap()
            .unwrap();
        assert!(plan.needs(2) && plan.needs(3) && plan.needs(7));
    }

    #[test]
    fn response_binding_identity_and_sampler_union_are_required() {
        let (mut meta, _, _) = crate::validation::tests::fixture();
        meta.textures.resize(4, meta.textures[0].clone());
        meta.effects.puddles = Some(1);
        meta.effects.ripples = Some(2);
        for (recipe_field, binding_field, response_sampler) in [
            ("wet_response", "response_program", "uWetResponse"),
            ("water_response", "water_response_program", "uWaterResponse"),
            ("reflection", "reflection_program", "uSource"),
        ] {
        let mut value = manifest(&meta, &["uAlbedo", response_sampler, "uPuddles", "uRipples", "uDisplayReflSharp"]);
        value["draws"][0][recipe_field] = json!(["wv", "response"]);
        value["texture_usage"]["draws"][0][binding_field] = json!(["wv", "response"]);
        let parse = |v: &serde_json::Value| Plan::parse(&serde_json::to_vec(v).unwrap(), &meta);
        let plan = parse(&value).unwrap().unwrap();
        assert_eq!((0..4).filter(|&i| plan.needs(i)).collect::<Vec<_>>(), [0, 1, 2]);
        for fault in 0..4 {
            let mut bad = value.clone();
            match fault {
                0 => { bad["texture_usage"]["draws"][0].as_object_mut().unwrap().remove(binding_field); },
                1 => bad["texture_usage"]["draws"][0][binding_field] = json!(["wv", "stale"]),
                2 => bad["draws"][0][recipe_field] = serde_json::Value::Null,
                _ => bad["texture_usage"]["draws"][0][binding_field] = json!(["wv"]),
            }
            assert!(parse(&bad).is_err(), "response binding fault {fault}");
        }
        // Manifest omissions cannot silently remove a response-only texture:
        // the linked-program union used by Renderer rejects nonresidency.
        value["texture_usage"]["draws"][0]["samplers"] = json!(["uAlbedo", response_sampler]);
        let plan = parse(&value).unwrap().unwrap();
        let textures: Vec<_> = (0..4).map(|i| if plan.needs(i) { i as u32 + 1 } else { 0 }).collect();
        assert!(!plan.needs(2));
        assert!(validate_resident(&meta, &textures, |_| None,
            |_, name| name == "uAlbedo" || name == "uRipples", |_| false).is_err());
        }
    }

    #[test]
    fn linked_sampler_guard_rejects_omissions_and_checks_exact_display_texture() {
        let (mut meta, _, _) = crate::validation::tests::fixture();
        meta.textures.resize(3, meta.textures[0].clone());
        meta.materials[0].normal = Some(1);
        let value = manifest(&meta, &["uAlbedo"]);
        let plan = Plan::parse(&serde_json::to_vec(&value).unwrap(), &meta)
            .unwrap()
            .unwrap();
        let textures: Vec<u32> = (0..3)
            .map(|i| if plan.needs(i) { i as u32 + 1 } else { 0 })
            .collect();
        let no_sky = |_: &str| false;
        assert!(validate_resident(
            &meta,
            &textures,
            |_| None,
            |_, name| name == "uAlbedo",
            no_sky
        )
        .is_ok());
        assert!(validate_resident(
            &meta,
            &textures,
            |_| None,
            |_, name| name == "uNormalMap",
            no_sky
        )
        .is_err());
        assert!(validate_resident(
            &meta,
            &textures,
            |_| Some(Some(2)),
            |_, name| name == "uAlbedo",
            no_sky
        )
        .is_err());
        assert!(validate_resident(
            &meta,
            &textures,
            |_| Some(None),
            |_, name| name == "uAlbedo",
            no_sky
        )
        .is_ok());
    }
}
