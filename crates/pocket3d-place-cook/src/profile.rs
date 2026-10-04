//! Versioned compiler inputs for the three existing native targets.
use crate::{
    artifact::Artifact,
    ir::{Manifest, Target},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub schema_version: u32,
    pub id: String,
    pub revision: u32,
    pub target: Target,
    pub host: Host,
    pub gpu: String,
    pub presentation: Presentation,
    pub recipe: Recipe,
    pub budgets: Budgets,
    pub disabled_features: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Host {
    pub os: String,
    pub abi: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    pub render_width: u32,
    pub render_height: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub auxiliary: Option<[u32; 2]>,
    pub target_fps: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipe {
    pub revision: u32,
    pub texture_cap: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daylight_texture_cap: Option<u32>,
    pub detail_texture_cap: u32,
    pub emissive_texture_cap: u32,
    pub animation_palette_bytes: u32,
    pub max_mesh_vertices: usize,
    pub max_field_points: usize,
    #[serde(default)]
    pub geometry_error_meters: GeometryErrors,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeometryErrors { pub structure: f32, pub detail: f32, pub background: f32 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budgets {
    pub max_pack_bytes: Option<usize>,
    pub sections: BTreeMap<String, usize>,
}

const BUILTINS: [&str; 3] = [
    include_str!("../../../profiles/vita30.json"),
    include_str!("../../../profiles/old3ds30.json"),
    include_str!("../../../profiles/psp30.json"),
];
impl Profile {
    pub fn builtin(target: Target) -> Self {
        serde_json::from_str(
            BUILTINS[match target {
                Target::Vita => 0,
                Target::Pica => 1,
                Target::Psp => 2,
            }],
        )
        .unwrap()
    }
    pub fn load(name: &str) -> Result<Self, String> {
        for target in [Target::Vita, Target::Pica, Target::Psp] {
            let p = Self::builtin(target);
            if p.id == name {
                return Ok(p);
            }
        }
        let p: Self = serde_json::from_slice(
            &std::fs::read(Path::new(name)).map_err(|e| format!("profile {name}: {e}"))?,
        )
        .map_err(|e| format!("profile: {e}"))?;
        p.validate()?;
        Ok(p)
    }
    pub fn validate(&self) -> Result<(), String> {
        let base = Self::builtin(self.target);
        let errors = &self.recipe.geometry_error_meters;
        if [errors.structure,errors.detail,errors.background].iter().any(|v|!v.is_finite() || !(0.0..=1.0).contains(v)) {
            return Err("invalid geometry error policy".into());
        }
        if self.schema_version != 1 || self.recipe.revision != 2 || self.revision == 0 {
            return Err("unsupported profile or recipe version (current recipe revision is 2; migrate custom profiles explicitly)".into());
        }
        if self.id.is_empty()
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("invalid profile id".into());
        }
        if self.host.os != base.host.os || self.host.abi != base.host.abi || self.gpu != base.gpu {
            return Err("profile cannot change a backend's host ABI or GPU implementation".into());
        }
        if self.presentation.render_width != base.presentation.render_width
            || self.presentation.render_height != base.presentation.render_height
            || self.presentation.display_width != base.presentation.display_width
            || self.presentation.display_height != base.presentation.display_height
            || self.presentation.auxiliary != base.presentation.auxiliary
            || self.presentation.target_fps != base.presentation.target_fps
        {
            return Err("presentation requires a matching runtime implementation; current profiles use the existing 30 fps contract".into());
        }
        let (min, max) = match self.target {
            Target::Vita => (4, 4096),
            Target::Pica => (64, 1024),
            Target::Psp => (8, 512),
        };
        for cap in [
            self.recipe.texture_cap,
            self.recipe.detail_texture_cap,
            self.recipe.emissive_texture_cap,
        ].into_iter().chain(self.recipe.daylight_texture_cap) {
            if !cap.is_power_of_two() || !(min..=max).contains(&cap) {
                return Err(format!(
                    "texture cap {cap} outside backend limits {min}..{max}"
                ));
            }
        }
        if self.recipe.detail_texture_cap < self.recipe.texture_cap
            || self.recipe.emissive_texture_cap < self.recipe.texture_cap
        {
            return Err("detail and emissive caps cannot be lower than the surface cap".into());
        }
        if self.recipe.max_mesh_vertices != 65535
            || !(1..=16384).contains(&self.recipe.max_field_points)
            || self.recipe.animation_palette_bytes == 0
            || self.recipe.animation_palette_bytes > 16 * 1024 * 1024
        {
            return Err("recipe exceeds vertex, point or animation limits".into());
        }
        if self.budgets.max_pack_bytes == Some(0)
            || base
                .budgets
                .max_pack_bytes
                .is_some_and(|limit| self.budgets.max_pack_bytes.is_none_or(|n| n > limit))
        {
            return Err("profile cannot relax the reader's pack limit".into());
        }
        for (tag, limit) in &base.budgets.sections {
            if self
                .budgets
                .sections
                .get(tag)
                .is_none_or(|n| *n == 0 || n > limit)
            {
                return Err(format!("profile cannot relax the reader's {tag} limit"));
            }
        }
        for (tag, n) in &self.budgets.sections {
            if *n == 0
                || !matches!(tag.as_str(), "META" | "PICA" | "TEXD" | "GEOM" | "ANIM")
                || (tag == "PICA" && self.target != Target::Pica)
                || self.target == Target::Psp
            {
                return Err(format!("invalid section budget {tag}"));
            }
        }
        Ok(())
    }
    pub fn check(&self, m: &Manifest) -> Result<(), String> {
        self.validate()?;
        // Backend capability is intrinsic; a profile can only restrict it.
        m.check_target(self.target)?;
        for f in m.features.intersection(&self.disabled_features) {
            return Err(format!(
                "{}: feature {f} disabled by profile {}",
                m.name, self.id
            ));
        }
        Ok(())
    }
    pub fn vita_texture_cap(&self, t: &crate::source::Texture) -> u32 {
        use crate::source::TextureUsage as U;
        match t.usage {
            Some(U::TextAtlas) => self.recipe.detail_texture_cap,
            Some(U::EmissiveStrip) => self.recipe.emissive_texture_cap,
            Some(U::Surface | U::Flipbook) => self.recipe.texture_cap,
            None if t.width.max(t.height) >= 4096 => self.recipe.detail_texture_cap,
            None => self.recipe.texture_cap,
        }
    }
    pub fn pica_texture_cap(
        &self,
        usage: Option<crate::source::TextureUsage>,
        legacy_detail: bool,
    ) -> u32 {
        use crate::source::TextureUsage as U;
        match usage {
            Some(U::Surface) => self.recipe.texture_cap,
            Some(U::EmissiveStrip) => self.recipe.emissive_texture_cap,
            Some(U::TextAtlas | U::Flipbook) => self.recipe.detail_texture_cap,
            None if legacy_detail => self.recipe.detail_texture_cap,
            None => self.recipe.texture_cap,
        }
    }
    pub fn psp_texture_cap(
        &self,
        usage: Option<crate::source::TextureUsage>,
        luminous: bool,
        daytime: bool,
    ) -> u32 {
        use crate::source::TextureUsage as U;
        let surface = if daytime { self.recipe.daylight_texture_cap.unwrap_or(self.recipe.texture_cap) } else { self.recipe.texture_cap };
        match usage {
            Some(U::Surface) => surface,
            Some(U::TextAtlas | U::Flipbook) => self.recipe.detail_texture_cap,
            Some(U::EmissiveStrip) => self.recipe.emissive_texture_cap,
            None if luminous => self.recipe.emissive_texture_cap,
            None => surface,
        }
    }
    pub fn check_artifact(&self, a: &Artifact) -> Result<(), String> {
        if self
            .budgets
            .max_pack_bytes
            .is_some_and(|n| a.bytes.len() > n)
        {
            return Err(format!(
                "pack budget exceeded: {} > {} bytes",
                a.bytes.len(),
                self.budgets.max_pack_bytes.unwrap()
            ));
        }
        for (tag, limit) in &self.budgets.sections {
            let actual = a
                .sections
                .get(tag)
                .ok_or_else(|| format!("missing budgeted section {tag}"))?;
            if actual > limit {
                return Err(format!("{tag} budget exceeded: {actual} > {limit} bytes"));
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ge_surface_caps_follow_daylight_and_explicit_texture_intent() {
        use crate::source::TextureUsage as U;
        let p = Profile::builtin(Target::Psp);
        assert_eq!(p.psp_texture_cap(Some(U::Surface), true, false), 128);
        assert_eq!(p.psp_texture_cap(Some(U::Surface), true, true), 256);
        assert_eq!(p.psp_texture_cap(None, false, true), 256);
        assert_eq!(p.psp_texture_cap(Some(U::TextAtlas), false, true), 512);
        let mut invalid = p;
        invalid.recipe.daylight_texture_cap = Some(1024);
        assert!(invalid.validate().is_err());
    }
    #[test]
    fn profiles_cannot_claim_unimplemented_devices_or_relax_reader_limits() {
        for target in [Target::Vita, Target::Pica, Target::Psp] {
            Profile::builtin(target).validate().unwrap();
        }
        let mut p = Profile::builtin(Target::Pica);
        p.budgets.sections.insert("TEXD".into(), 13 * 1024 * 1024);
        assert!(p.validate().is_err());
        let mut p = Profile::builtin(Target::Psp);
        p.budgets.max_pack_bytes = None;
        assert!(p.validate().is_err());
        let mut p = Profile::builtin(Target::Vita);
        p.gpu = "pica200".into();
        assert!(p.validate().is_err());
    }
}
