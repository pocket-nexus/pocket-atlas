//! Executed Atlas target recipes. Hardware policy remains visible to analysis and lowering.
use crate::{ir::Target, profile::Profile};
use serde_json::{json, Value};

/// Public dependency contract. Execution uses the same definitions as `recipe`.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Pass {
    id: &'static str,
    version: u32,
    depends_on: &'static [&'static str],
    inputs: &'static [&'static str],
    outputs: &'static [&'static str],
    cache: bool,
}
const ANALYSIS: &[Pass] = &[
    Pass {
        id: "read-source",
        version: 1,
        depends_on: &[],
        inputs: &["SealedPlaceIR"],
        outputs: &["Source"],
        cache: false,
    },
    Pass {
        id: "select-geometry",
        version: 1,
        depends_on: &["read-source"],
        inputs: &["Source", "Profile"],
        outputs: &["GeometryPlan"],
        cache: false,
    },
    Pass {
        id: "resolve-materials",
        version: 2,
        depends_on: &["select-geometry"],
        inputs: &["Source", "GeometryPlan", "Profile"],
        outputs: &["Resolved"],
        cache: false,
    },
    Pass {
        id: "texture-sampling",
        version: 1,
        depends_on: &["resolve-materials"],
        inputs: &["Resolved.prims", "Resolved.cook", "Profile"],
        outputs: &["Resolved.cook.textures"],
        cache: false,
    },
    Pass {
        id: "solid-pbr-palette",
        version: 2,
        depends_on: &["texture-sampling"],
        inputs: &["Resolved", "Profile"],
        outputs: &["Resolved.prims", "Resolved.cook.materials"],
        cache: false,
    },
    Pass {
        id: "reduce-geometry",
        version: 1,
        depends_on: &["solid-pbr-palette"],
        inputs: &["Resolved", "Profile"],
        outputs: &["Resolved.prims", "GeometryCostReport"],
        cache: false,
    },
    Pass {
        id: "sample-motion",
        version: 1,
        depends_on: &["reduce-geometry"],
        inputs: &["Source", "Resolved"],
        outputs: &["Motion"],
        cache: false,
    },
    Pass {
        id: "scene-lighting",
        version: 1,
        depends_on: &["sample-motion"],
        inputs: &["Source", "Resolved", "Motion"],
        outputs: &["Lighting", "Resolved"],
        cache: false,
    },
    Pass {
        id: "bake-lighting",
        version: 1,
        depends_on: &["scene-lighting"],
        inputs: &["Source.sx", "Resolved", "Lighting", "Profile"],
        outputs: &["Baked", "Resolved.prims"],
        cache: true,
    },
    Pass {
        id: "chunk-and-lod",
        version: 2,
        depends_on: &["bake-lighting"],
        inputs: &["Resolved", "Motion", "Baked", "Profile", "CellMeters"],
        outputs: &["Geometry"],
        cache: false,
    },
    Pass {
        id: "scene-effects",
        version: 1,
        depends_on: &["chunk-and-lod"],
        inputs: &[
            "Source", "Resolved", "Motion", "Lighting", "Baked", "Geometry",
        ],
        outputs: &["Scene"],
        cache: false,
    },
];

/// A pass publishes its typed result only after successful execution.
pub struct Output<T> {
    pub value: T,
    pub decision: Value,
    pub telemetry: Value,
}
impl<T> Output<T> {
    pub fn new(value: T, decision: Value) -> Self {
        Self {
            value,
            decision,
            telemetry: Value::Null,
        }
    }
    pub fn with_telemetry(mut self, telemetry: Value) -> Self {
        self.telemetry = telemetry;
        self
    }
}

pub struct Pipeline {
    target: Target,
    next: usize,
    pub completed: Vec<Value>,
    pub telemetry: Vec<Value>,
}
impl Pipeline {
    pub fn run<T>(&mut self, id: &str, execute: impl FnOnce() -> Output<T>) -> T {
        self.check_next(id);
        let started = std::time::Instant::now();
        let output = execute();
        self.record(id, output.decision);
        self.telemetry.push(json!({"id":id,"milliseconds":started.elapsed().as_secs_f64()*1000.0,"details":output.telemetry}));
        output.value
    }
    pub fn new(profile: &Profile) -> Self {
        Self {
            target: profile.target,
            next: 0,
            completed: Vec::new(),
            telemetry: Vec::new(),
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
            "gpu":profile.gpu,"passes":ANALYSIS.iter().map(|pass|serde_json::to_value(pass).unwrap()).chain([
                json!({"id":format!("{}-lowering",profile.target.name()),"version":if profile.target==Target::Pica {2}else{1},"dependsOn":["scene-effects"],"inputs":["Scene","Profile"],"outputs":["Artifact"],"cache":false}),
                json!({"id":"structural-budgets","version":1,"dependsOn":[format!("{}-lowering",profile.target.name())],"inputs":["Artifact","Profile"],"outputs":["BudgetVerdict"],"cache":false})]).collect::<Vec<_>>()})
    }
    fn check_next(&self, id: &str) {
        let expected = if self.next < ANALYSIS.len() {
            ANALYSIS[self.next].id.to_string()
        } else if self.next == ANALYSIS.len() {
            format!("{}-lowering", self.target.name())
        } else {
            "structural-budgets".into()
        };
        assert!(
            self.next <= ANALYSIS.len() + 1 && id == expected,
            "recipe pass order: expected {expected}, got {id}"
        );
        if let Some(pass) = ANALYSIS.get(self.next) {
            for dependency in pass.depends_on {
                assert!(
                    self.completed.iter().any(|p| p["id"] == *dependency),
                    "missing pass dependency {dependency}"
                );
            }
        }
    }
    fn record(&mut self, id: &str, decision: Value) {
        self.check_next(id);
        let version = ANALYSIS.get(self.next).map_or(
            if self.next == ANALYSIS.len() && self.target == Target::Pica {
                2
            } else {
                1
            },
            |p| p.version,
        );
        self.completed
            .push(json!({"id":id,"version":version,"result":decision}));
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
