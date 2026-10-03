//! Target results and reproducible compile receipts. Device evidence is separate.
use crate::{ir::Manifest, profile::Profile};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub struct Artifact {
    pub bytes: Vec<u8>,
    pub summary: Value,
    pub sections: BTreeMap<String, usize>,
    pub textures: Vec<Value>,
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
impl Artifact {
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
            "artifact":{"sha256":hash(&self.bytes),"bytes":self.bytes.len(),"sections":self.sections,"summary":self.summary,"textures":self.textures},
            "diagnostics":diagnostics,
            "validation":{"compiled":true,"structuralBudgets":"passed","device":{"status":"not-recorded"},"frameBudget":{"status":"requires-device-measurement","milliseconds":1000.0/profile.presentation.target_fps as f64}}
        })
    }
}
