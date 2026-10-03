//! PlaceIR v1: a lossless glTF structural schema plus Atlas scene semantics.
//!
//! Import splits the GLB into a canonical JSON document and its original binary
//! buffer. No texture compression, quantization, lighting bake or LOD selection
//! happens here. Targets consume this sealed source directory independently.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

pub const VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Target {
    #[serde(rename="vita")]
    Vita,
    #[serde(rename="3ds")]
    Pica,
    #[serde(rename="psp")]
    Psp,
}
impl Target {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "vita" => Ok(Self::Vita),
            "3ds" => Ok(Self::Pica),
            "psp" => Ok(Self::Psp),
            _ => Err(format!("unknown target {s}")),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Vita => "vita",
            Self::Pica => "3ds",
            Self::Psp => "psp",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub name: String,
    pub kind: String,
    pub features: BTreeSet<String>,
    pub files: Vec<Resource>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub path: String,
    pub sha256: String,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn local_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." {
        return Err(format!(
            "PlaceIR resource must be a local file name: {name}"
        ));
    }
    Ok(name)
}
fn scene_meta(doc: &Value) -> Result<&Value, String> {
    let index = doc["scene"].as_u64().unwrap_or(0) as usize;
    doc["scenes"][index]["extras"]
        .get("pocketAtlas")
        .filter(|x| x.is_object())
        .ok_or_else(|| "missing scene extras.pocketAtlas".into())
}
fn features(doc: &Value) -> Result<BTreeSet<String>, String> {
    let mut out = BTreeSet::new();
    for material in doc["materials"].as_array().into_iter().flatten() {
        if let Some(usages)=material["extras"]["pocketAtlas"].get("textureUsage") {
            let usages=usages.as_object().ok_or("textureUsage must map material slots to purposes")?;
            for (slot,value) in usages {
                if !matches!(slot.as_str(),"albedo"|"normal"|"orm"|"emission") {return Err(format!("unknown textureUsage slot {slot}"));}
                serde_json::from_value::<crate::source::TextureUsage>(value.clone()).map_err(|_|format!("unknown textureUsage for {slot}: {value}"))?;
            }
        }
        if let Some(kind) = material["extras"]["pocketAtlas"]["kind"].as_str() {
            if !matches!(
                kind,
                "unlit"
                    | "sign"
                    | "glass"
                    | "interiorWindow"
                    | "products"
                    | "tower"
                    | "water"
                    | "lights"
            ) {
                return Err(format!("unsupported Atlas material kind {kind}"));
            }
            out.insert(format!("material:{kind}"));
        }
    }
    let meta = scene_meta(doc)?;
    if meta["haze"]["inversion"].is_number() {
        out.insert("vista-haze".into());
    }
    if meta["sky"]["model"].is_string() {
        out.insert("day-sky".into());
    }
    Ok(out)
}

fn required_files(document: &Value) -> Result<BTreeSet<String>, String> {
    let buffers = document["buffers"]
        .as_array()
        .ok_or("missing PlaceIR buffer")?;
    if buffers.len() != 1 || buffers[0]["uri"].as_str() != Some("scene.bin") {
        return Err("PlaceIR requires exactly one local scene.bin buffer".into());
    }
    for im in document["images"].as_array().into_iter().flatten() {
        if im.get("uri").is_some() || !im["bufferView"].is_number() {
            return Err("PlaceIR requires embedded images".into());
        }
    }
    let mut files = BTreeSet::from(["scene.gltf".into(), "scene.bin".into()]);
    let meta = scene_meta(document)?;
    if meta["environment"].is_object() {
        files.insert("env.rgba16f".into());
    }
    if let Some(name) = meta["sky"]["clouds"]["file"].as_str() {
        local_name(name)?;
        if matches!(
            name,
            "scene.gltf" | "scene.bin" | "manifest.json" | "env.rgba16f"
        ) {
            return Err("reserved PlaceIR resource name".into());
        }
        files.insert(name.into());
    }
    Ok(files)
}

impl Manifest {
    pub fn check_target(&self, target: Target) -> Result<(), String> {
        for feature in &self.features {
            if target != Target::Vita
                && matches!(feature.as_str(), "material:lights" | "vista-haze")
            {
                return Err(format!(
                    "{}: {feature} has no {} lowering; the source remains intact",
                    self.name,
                    target.name()
                ));
            }
            if target == Target::Psp && matches!(feature.as_str(), "material:water" | "day-sky") {
                return Err(format!("{}: {feature} has no PSP lowering", self.name));
            }
        }
        if target == Target::Psp && self.kind != "night-street" {
            return Err(format!(
                "{}: PSP currently supports the night-street effect set, got {}",
                self.name, self.kind
            ));
        }
        Ok(())
    }
}

pub fn import(input: &Path, output: &Path) -> Result<Manifest, String> {
    let bytes = std::fs::read(input.join("scene.glb")).map_err(|e| e.to_string())?;
    // Keep even extension fields unknown to the current glTF reader. Target
    // analysis, rather than the archival frontend, decides what it can lower.
    let source = gltf::binary::Glb::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut document: Value = serde_json::from_slice(&source.json).map_err(|e| e.to_string())?;
    let buffers = document["buffers"]
        .as_array_mut()
        .ok_or("missing GLB buffer")?;
    if buffers.len() != 1 || buffers[0].get("uri").is_some() {
        return Err("PlaceIR GLB frontend requires one embedded buffer".into());
    }
    buffers[0]["uri"] = Value::String("scene.bin".into());
    for im in document["images"].as_array().into_iter().flatten() {
        if im.get("uri").is_some() {
            return Err("PlaceIR GLB frontend requires embedded images".into());
        }
    }
    let meta = scene_meta(&document)?;
    let kind = meta["kind"]
        .as_str()
        .ok_or("missing place kind")?
        .to_string();
    let mut resources = vec![
        (
            "scene.gltf".to_string(),
            serde_json::to_vec(&document).unwrap(),
        ),
        (
            "scene.bin".to_string(),
            source.bin.ok_or("missing GLB binary data")?.into_owned(),
        ),
    ];
    if meta["environment"].is_object() {
        resources.push((
            "env.rgba16f".into(),
            std::fs::read(input.join("env.rgba16f")).map_err(|e| format!("environment: {e}"))?,
        ));
    }
    if let Some(name) = meta["sky"]["clouds"]["file"].as_str() {
        local_name(name)?;
        if matches!(
            name,
            "scene.gltf" | "scene.bin" | "manifest.json" | "env.rgba16f"
        ) {
            return Err("reserved PlaceIR resource name".into());
        }
        resources.push((
            name.into(),
            std::fs::read(input.join(name)).map_err(|e| e.to_string())?,
        ));
    }
    resources.sort_by(|a, b| a.0.cmp(&b.0));
    let manifest = Manifest {
        version: VERSION,
        name: input
            .file_name()
            .and_then(|x| x.to_str())
            .ok_or("missing place name")?
            .into(),
        kind,
        features: features(&document)?,
        files: resources
            .iter()
            .map(|(path, bytes)| Resource {
                path: path.clone(),
                sha256: digest(bytes),
            })
            .collect(),
    };
    std::fs::create_dir_all(output).map_err(|e| e.to_string())?;
    for (name, bytes) in resources {
        std::fs::write(output.join(name), bytes).map_err(|e| e.to_string())?;
    }
    // The manifest is written last, so readers reject interrupted imports.
    std::fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    open(output)
}

pub fn open(root: &Path) -> Result<Manifest, String> {
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(root.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    local_name(&manifest.name)?;
    if manifest.version != VERSION {
        return Err(format!("unsupported PlaceIR version {}", manifest.version));
    }
    let mut seen = BTreeSet::new();
    for f in &manifest.files {
        local_name(&f.path)?;
        if !seen.insert(f.path.as_str()) {
            return Err(format!("duplicate resource {}", f.path));
        }
        let bytes = std::fs::read(root.join(&f.path)).map_err(|e| e.to_string())?;
        if digest(&bytes) != f.sha256 {
            return Err(format!("PlaceIR resource changed: {}", f.path));
        }
    }
    if !seen.contains("scene.gltf") || !seen.contains("scene.bin") {
        return Err("missing PlaceIR scene resources".into());
    }
    let document: Value =
        serde_json::from_slice(&std::fs::read(root.join("scene.gltf")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let required = required_files(&document)?;
    if required != seen.iter().map(|s| s.to_string()).collect() {
        return Err("PlaceIR resource table disagrees with the scene".into());
    }
    let declared = document["buffers"][0]["byteLength"]
        .as_u64()
        .ok_or("missing buffer length")?;
    let actual = std::fs::metadata(root.join("scene.bin"))
        .map_err(|e| e.to_string())?
        .len();
    if actual < declared || actual > declared + 3 {
        return Err("PlaceIR buffer length mismatch".into());
    }

    if features(&document)? != manifest.features
        || scene_meta(&document)?["kind"].as_str() != Some(&manifest.kind)
    {
        return Err("PlaceIR capability manifest disagrees with the scene".into());
    }
    Ok(manifest)
}

pub fn prepare(input: &Path) -> Result<(PathBuf, Manifest), String> {
    if input.join("manifest.json").exists() {
        return Ok((input.into(), open(input)?));
    }
    if !input.is_dir() {
        return Err(
            "expected PlaceIR directory or web export directory, not a device .place pack".into(),
        );
    }
    let output = input.join("place.ir");
    let manifest = import(input, &output)?;
    Ok((output, manifest))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let p = std::env::temp_dir().join(format!(
                "atlas-ir-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(p.join("source")).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fixture(root: &Path) -> Vec<u8> {
        use std::borrow::Cow;
        let binary = vec![0x12, 0x34, 0x56, 0x78];
        let document = serde_json::json!({
            "asset": {"version":"2.0"}, "scene":0,
            "scenes":[{"extras":{"pocketAtlas":{"kind":"night-street", "futureField":{"keep":42}}}}],
            "buffers":[{"byteLength":4}],
            "extensions":{"VENDOR_future":{"value":"preserve"}}
        });
        let glb = gltf::binary::Glb {
            header: gltf::binary::Header {
                magic: *b"glTF",
                version: 2,
                length: 0,
            },
            json: Cow::Owned(serde_json::to_vec(&document).unwrap()),
            bin: Some(Cow::Borrowed(&binary)),
        };
        std::fs::write(root.join("scene.glb"), glb.to_vec().unwrap()).unwrap();
        binary
    }
    #[test]
    fn sealed_ir_is_deterministic_lossless_and_independent_of_the_export() {
        let temp = Temp::new();
        let source = temp.0.join("source");
        let ir = temp.0.join("place.ir");
        let binary = fixture(&source);
        import(&source, &ir).unwrap();
        let first = std::fs::read(ir.join("manifest.json")).unwrap();
        import(&source, &ir).unwrap();
        assert_eq!(first, std::fs::read(ir.join("manifest.json")).unwrap());
        assert_eq!(binary, std::fs::read(ir.join("scene.bin")).unwrap());
        let document: Value =
            serde_json::from_slice(&std::fs::read(ir.join("scene.gltf")).unwrap()).unwrap();
        assert_eq!(document["extensions"]["VENDOR_future"]["value"], "preserve");
        assert_eq!(scene_meta(&document).unwrap()["futureField"]["keep"], 42);
        std::fs::remove_dir_all(source).unwrap();
        for target in [Target::Vita, Target::Pica, Target::Psp] {
            open(&ir).unwrap().check_target(target).unwrap();
        }
        std::fs::write(ir.join("scene.bin"), [0; 4]).unwrap();
        assert!(open(&ir).unwrap_err().contains("resource changed"));
    }
    #[test]
    fn rejects_unknown_ir_version_before_reading_resources() {
        let temp = Temp::new();
        let m = Manifest {
            version: VERSION + 1,
            name: "scene".into(),
            kind: "night-street".into(),
            features: BTreeSet::new(),
            files: vec![],
        };
        std::fs::write(
            temp.0.join("manifest.json"),
            serde_json::to_vec(&m).unwrap(),
        )
        .unwrap();
        assert!(open(&temp.0)
            .unwrap_err()
            .contains("unsupported PlaceIR version"));
    }

    #[test]
    fn external_or_unlisted_resources_are_rejected() {
        let document = serde_json::json!({"buffers":[{"uri":"../secret"}]});
        assert!(required_files(&document).is_err());
        let document = serde_json::json!({"buffers":[{"uri":"scene.bin"}],"images":[{"uri":"file:///secret"}]});
        assert!(required_files(&document).is_err());
    }
    #[test]
    fn rejects_missing_lowerings_instead_of_treating_web_live_as_supported() {
        let m = Manifest {
            version: VERSION,
            name: "vista".into(),
            kind: "dusk-vista".into(),
            features: ["material:lights".into(), "vista-haze".into()].into(),
            files: vec![],
        };
        assert!(m.check_target(Target::Vita).is_ok());
        assert!(m
            .check_target(Target::Pica)
            .unwrap_err()
            .contains("no 3ds lowering"));
        assert!(m.check_target(Target::Psp).is_err());
    }
    #[test]
    fn resources_cannot_escape_the_ir() {
        for path in ["../key", "/tmp/file", "https:x", "a\\b", "..", ""] {
            assert!(local_name(path).is_err());
        }
        assert!(local_name("sky-clouds.png").is_ok());
    }
}
