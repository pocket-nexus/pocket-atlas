//! Target results and reproducible compile receipts. Device evidence is separate.
use crate::{ir::Manifest, profile::Profile};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub struct Sidecar {
    pub extension: String,
    /// None removes an obsolete optional output from a previous build.
    pub bytes: Option<Vec<u8>>,
}
pub struct Artifact {
    pub sidecars: Vec<Sidecar>,
    pub bytes: Vec<u8>,
    pub summary: Value,
    pub sections: BTreeMap<String, usize>,
    pub textures: Vec<Value>,
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
impl Artifact {
    /// All lowering and budget checks precede this operation. Stage complete
    /// files before replacement; pack/sidecar hashes reject interrupted sets.
    pub fn publish_sidecars(&self, output: &std::path::Path) -> Result<(), String> {
        let mut names = std::collections::BTreeSet::new();
        for s in &self.sidecars {
            if s.extension.is_empty()
                || s.extension.contains(['/', '\\'])
                || !names.insert(&s.extension)
            {
                return Err("invalid or duplicate sidecar extension".into());
            }
        }
        let mut staged = Vec::new();
        let result = (|| {
            for s in &self.sidecars {
                if let Some(bytes) = &s.bytes {
                    let final_path = output.with_extension(&s.extension);
                    let temp = output.with_extension(format!(
                        "{}.{}.tmp",
                        s.extension,
                        std::process::id()
                    ));
                    staged.push((temp, final_path));
                    std::fs::write(&staged.last().unwrap().0, bytes).map_err(|e| e.to_string())?;
                }
            }
            for (temp, final_path) in &staged {
                std::fs::rename(temp, final_path).map_err(|e| e.to_string())?;
            }
            for s in &self.sidecars {
                if s.bytes.is_none() {
                    if let Err(e) = std::fs::remove_file(output.with_extension(&s.extension)) {
                        if e.kind() != std::io::ErrorKind::NotFound {
                            return Err(e.to_string());
                        }
                    }
                }
            }
            Ok(())
        })();
        for (temp, _) in staged {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
    pub fn report(
        &self,
        manifest: &Manifest,
        profile: &Profile,
        cell: f32,
        diagnostics: &[Value],
    ) -> Value {
        json!({
            "schemaVersion":1,
            "compiler":{"version":env!("CARGO_PKG_VERSION"),"sourceSha256":env!("ATLAS_COMPILER_HASH"),"rustc":env!("ATLAS_RUSTC")},
            "source":{"name":manifest.name,"irVersion":manifest.version,"manifestSha256":hash(&serde_json::to_vec(manifest).unwrap()),"resources":manifest.files},
            "profile":{"definition":profile,"sha256":hash(&serde_json::to_vec(profile).unwrap())},
            "analysis":{"cellMeters":cell},
            "artifact":{"sha256":hash(&self.bytes),"bytes":self.bytes.len(),"sections":self.sections,"summary":self.summary,"textures":self.textures,"sidecars":self.sidecars.iter().filter_map(|s|s.bytes.as_ref().map(|b|json!({"extension":s.extension,"bytes":b.len(),"sha256":hash(b)}))).collect::<Vec<_>>()},
            "diagnostics":diagnostics,
            "validation":{"compiled":true,"structuralBudgets":"passed","device":{"status":"not-recorded"},"frameBudget":{"status":"requires-device-measurement","milliseconds":1000.0/profile.presentation.target_fps as f64}}
        })
    }
}
