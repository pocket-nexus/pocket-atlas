//! Executed Atlas target recipes. Hardware policy remains visible to analysis and lowering.
use crate::{ir::Target, profile::Profile};
use serde_json::{json, Value};

const ANALYSIS: &[&str] = &[
    "read-source",
    "resolve-materials",
    "texture-sampling",
    "solid-pbr-palette",
    "sample-motion",
    "scene-lighting",
    "bake-lighting",
    "chunk-and-lod",
    "scene-effects",
];

pub struct Pipeline {
    target: Target,
    next: usize,
    pub completed: Vec<Value>,
}
impl Pipeline {
    pub fn new(profile: &Profile) -> Self {
        Self {
            target: profile.target,
            next: 0,
            completed: Vec::new(),
        }
    }
    pub fn solid_pbr(&self) -> bool {
        self.target == Target::Vita
    }
    pub fn native_cache_order(&self) -> bool {
        self.target != Target::Vita
    }
    pub fn describe(profile: &Profile) -> Value {
        json!({"id":format!("atlas-{}",profile.target.name()),"revision":profile.recipe.revision,
            "gpu":profile.gpu,"passes":ANALYSIS.iter().map(|id|json!({"id":id,"version":1})).chain([
                json!({"id":format!("{}-lowering",profile.target.name()),"version":1}),
                json!({"id":"structural-budgets","version":1})]).collect::<Vec<_>>()})
    }
    pub fn record(&mut self, id: &str, decision: Value) {
        let expected = if self.next < ANALYSIS.len() {
            ANALYSIS[self.next].to_string()
        } else if self.next == ANALYSIS.len() {
            format!("{}-lowering", self.target.name())
        } else {
            "structural-budgets".into()
        };
        assert!(
            self.next <= ANALYSIS.len() + 1 && id == expected,
            "recipe pass order: expected {expected}, got {id}"
        );
        self.completed
            .push(json!({"id":id,"version":1,"result":decision}));
        self.next += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_policy_and_executed_order_are_explicit() {
        let mut vita = Pipeline::new(&Profile::builtin(Target::Vita));
        assert!(vita.solid_pbr());
        assert!(!vita.native_cache_order());
        let pica = Pipeline::new(&Profile::builtin(Target::Pica));
        assert!(!pica.solid_pbr());
        assert!(pica.native_cache_order());
        vita.record("read-source", json!({"nodes":4}));
        assert_eq!(vita.completed[0]["version"], 1);
    }
    #[test]
    #[should_panic(expected = "recipe pass order")]
    fn skipped_pass_cannot_be_reported_as_executed() {
        Pipeline::new(&Profile::builtin(Target::Psp)).record("chunk-and-lod", json!({}));
    }
}
