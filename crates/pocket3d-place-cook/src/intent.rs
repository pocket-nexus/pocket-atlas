//! Atlas geometry intent and representation selection. This runs while the
//! source still has object/prototype/instance boundaries, before Web batching.
use crate::{geometry, profile::Profile};
use glam::Mat4;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Protected,
    Structure,
    Detail,
    Background,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub role: Role,
    pub max_error_meters: f32,
}
impl Intent {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let intent: Self =
            serde_json::from_value(value.clone()).map_err(|e| format!("geometry intent: {e}"))?;
        if !intent.max_error_meters.is_finite()
            || !(0.0..=1.0).contains(&intent.max_error_meters)
            || (intent.role == Role::Protected && intent.max_error_meters != 0.0)
        {
            return Err("invalid geometry error budget".into());
        }
        Ok(intent)
    }
    pub fn budget(self, profile: &Profile) -> f32 {
        let policy = &profile.recipe.geometry_error_meters;
        self.max_error_meters.min(match self.role {
            Role::Protected => 0.0,
            Role::Structure => policy.structure,
            Role::Detail => policy.detail,
            Role::Background => policy.background,
        })
    }
}
#[derive(Clone, Copy, Default)]
pub struct Selection {
    pub intent: Option<Intent>,
    /// Admissible permanent error, in world metres. Distance LODs are separate.
    pub budget: f32,
    pub representation_error: f32,
}
impl Selection {
    pub fn protected(self) -> bool {
        self.intent.is_some_and(|i| i.role == Role::Protected)
    }
    pub fn batch_key(self) -> (u8, u32, u32, u32) {
        (
            self.intent.map_or(0, |i| match i.role {
                Role::Protected => 1,
                Role::Structure => 2,
                Role::Detail => 3,
                Role::Background => 4,
            }),
            self.intent.map_or(0, |i| i.max_error_meters.to_bits()),
            self.budget.to_bits(),
            self.representation_error.to_bits(),
        )
    }
}
pub struct Plan {
    pub nodes: BTreeMap<usize, Selection>,
    pub report: Value,
}
fn pc(node: &gltf::Node) -> Value {
    node.extras()
        .as_ref()
        .and_then(|x| serde_json::from_str::<Value>(x.get()).ok())
        .unwrap_or(Value::Null)["pocketAtlas"]
        .clone()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Alternative {
    id: String,
    error_meters: f32,
}
fn alternative(value: &Value) -> Result<Alternative, String> {
    let alt: Alternative =
        serde_json::from_value(value.clone()).map_err(|e| format!("geometry alternative: {e}"))?;
    if alt.id.is_empty()
        || !alt.error_meters.is_finite()
        || !(0.0..=1.0).contains(&alt.error_meters)
    {
        return Err("invalid geometry alternative".into());
    }
    Ok(alt)
}
/// Import/check rejects malformed intent even when its branch is not selected.
pub fn validate(doc: &Value) -> Result<(), String> {
    let mut alternatives = BTreeSet::new();
    let nodes = doc["nodes"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for node in doc["nodes"].as_array().into_iter().flatten() {
        let x = &node["extras"]["pocketAtlas"];
        if let Some(v) = x.get("geometry") {
            Intent::parse(v)?;
        }
        if let Some(v) = x.get("alternative") {
            alternative(v)?;
        }
        if let Some(v) = x.get("lodGroup") {
            if v != &json!({"version":1}) {
                return Err("unsupported geometry LOD group".into());
            }
            if node.get("mesh").is_some()
                || node.get("skin").is_some()
                || node["extensions"].get("EXT_mesh_gpu_instancing").is_some()
            {
                return Err("LOD group must be a transform-only container".into());
            }
            let children = node["children"]
                .as_array()
                .ok_or("LOD group needs children")?;
            if children.len() < 2 {
                return Err("LOD group needs a reference and alternatives".into());
            }
            let mut ids = BTreeSet::new();
            let mut last = -1.0;
            for (i, child) in children.iter().enumerate() {
                let index = child.as_u64().ok_or("invalid LOD child")? as usize;
                if !alternatives.insert(index) {
                    return Err("geometry alternative belongs to multiple LOD groups".into());
                }
                let alt =
                    alternative(&doc["nodes"][index]["extras"]["pocketAtlas"]["alternative"])?;
                if !ids.insert(alt.id)
                    || alt.error_meters <= last
                    || (i == 0 && alt.error_meters != 0.0)
                {
                    return Err("LOD alternatives need unique ids, increasing error and a zero-error reference".into());
                }
                last = alt.error_meters;
            }
            // v1 alternatives are static/rigid. A removed branch must never
            // leave a live skin or an externally referenced joint behind.
            let mut pending: Vec<_> = children
                .iter()
                .filter_map(Value::as_u64)
                .map(|i| i as usize)
                .collect();
            let mut visited = BTreeSet::new();
            while let Some(i) = pending.pop() {
                if !visited.insert(i) {
                    return Err("cyclic or shared LOD subtree".into());
                }
                let n = nodes.get(i).ok_or("invalid LOD descendant")?;
                let joint = doc["skins"].as_array().into_iter().flatten().any(|s| {
                    s["joints"]
                        .as_array()
                        .is_some_and(|j| j.contains(&json!(i)))
                        || s["skeleton"] == json!(i)
                });
                if n.get("skin").is_some() || joint {
                    return Err("geometry alternatives v1 do not support skins or joints".into());
                }
                pending.extend(
                    n["children"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_u64)
                        .map(|i| i as usize),
                );
            }
        }
    }
    for (i, node) in nodes.iter().enumerate() {
        if node["extras"]["pocketAtlas"].get("alternative").is_some() && !alternatives.contains(&i)
        {
            return Err("geometry alternative must be a direct LOD group child".into());
        }
    }
    Ok(())
}

fn selection(node: &gltf::Node, inherited: Selection, profile: &Profile) -> Selection {
    let intent = pc(node)
        .get("geometry")
        .map(|v| Intent::parse(v).expect("checked geometry intent"))
        .or(inherited.intent);
    Selection {
        intent,
        budget: intent.map_or(0.0, |i| i.budget(profile)),
        ..inherited
    }
}
// Check descendants before choosing an alternative. A stricter child or a
// protected landmark makes this candidate inadmissible; try the reference.
fn admissible(
    node: &gltf::Node,
    inherited: Selection,
    parent_scale: f32,
    profile: &Profile,
) -> bool {
    let s = selection(node, inherited, profile);
    if s.representation_error > s.budget {
        return false;
    }
    let scale =
        parent_scale * geometry::error_scale(Mat4::from_cols_array_2d(&node.transform().matrix()));
    if pc(node).get("lodGroup").is_some() {
        node.children().any(|child| {
            let alt = alternative(&pc(&child)["alternative"]).expect("checked alternative");
            let next = Selection {
                representation_error: s.representation_error + alt.error_meters * scale,
                ..s
            };
            next.representation_error <= s.budget && admissible(&child, next, scale, profile)
        })
    } else {
        node.children()
            .all(|child| admissible(&child, s, scale, profile))
    }
}
pub fn plan(doc: &gltf::Document, profile: &Profile) -> crate::recipe::Output<Plan> {
    let scene = doc
        .default_scene()
        .or_else(|| doc.scenes().next())
        .expect("scene");
    let mut stack: Vec<_> = scene
        .nodes()
        .map(|n| (n, Selection::default(), 1.0f32))
        .collect();
    let mut nodes = BTreeMap::new();
    let mut decisions = Vec::new();
    let mut prototypes: BTreeMap<usize, usize> = BTreeMap::new();
    while let Some((node, inherited, parent_scale)) = stack.pop() {
        let x = pc(&node);
        let selection = selection(&node, inherited, profile);
        let budget = selection.budget;
        let scale = parent_scale
            * geometry::error_scale(Mat4::from_cols_array_2d(&node.transform().matrix()));
        nodes.insert(node.index(), selection);
        if let Some(mesh) = node.mesh() {
            let count = node
                .extensions()
                .and_then(|e| e.get("EXT_mesh_gpu_instancing"))
                .and_then(|e| e["attributes"].as_object())
                .and_then(|attrs| attrs.values().find_map(|v| v.as_u64()))
                .and_then(|i| doc.accessors().nth(i as usize))
                .map_or(1, |a| a.count());
            *prototypes.entry(mesh.index()).or_default() += count;
        }
        if x.get("lodGroup").is_some() {
            let candidates: Vec<_> = node
                .children()
                .map(|n| {
                    let alt = alternative(&pc(&n)["alternative"]).expect("checked alternative");
                    (n, alt)
                })
                .collect();
            let chosen = candidates
                .iter()
                .rposition(|(child, alt)| {
                    let next = Selection {
                        representation_error: selection.representation_error
                            + alt.error_meters * scale,
                        ..selection
                    };
                    next.representation_error <= budget && admissible(child, next, scale, profile)
                })
                .expect("zero-error reference is admissible");
            let (child, alt) = &candidates[chosen];
            decisions.push(json!({"source":x["sourceId"],"selected":alt.id,"declaredErrorMeters":alt.error_meters*scale,"budgetMeters":budget,"errorBasis":"author-declared"}));
            stack.push((
                child.clone(),
                Selection {
                    representation_error: selection.representation_error + alt.error_meters * scale,
                    ..selection
                },
                scale,
            ));
        } else {
            for child in node.children() {
                stack.push((child, selection, scale));
            }
        }
    }
    let report = json!({"objects":nodes.len(),"prototypes":prototypes.len(),"reusedPrototypes":prototypes.iter().filter(|(_,n)|**n>1).count(),
        "prototypeInstances":prototypes,"alternatives":decisions,"target":profile.target.name(),"nativeInstances":"resolved after representation selection"});
    crate::recipe::Output::new(
        Plan {
            nodes,
            report: report.clone(),
        },
        report,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[
            {"children":[1,2],"extras":{"pocketAtlas":{"geometry":{"role":"detail","maxErrorMeters":0.075},"lodGroup":{"version":1}}}},
            {"extras":{"pocketAtlas":{"alternative":{"id":"reference","errorMeters":0}}}},
            {"children":[3],"extras":{"pocketAtlas":{"alternative":{"id":"surface","errorMeters":0.07}}}},
            {}
        ]})
    }
    #[test]
    fn stricter_descendant_falls_back_instead_of_panicking_or_exceeding_permission() {
        let mut source = fixture();
        let profile = Profile::builtin(crate::ir::Target::Pica);
        let selected = |source: &Value| {
            validate(source).unwrap();
            let doc = gltf::Gltf::from_slice(&serde_json::to_vec(source).unwrap())
                .unwrap()
                .document;
            plan(&doc, &profile).decision["alternatives"][0]["selected"].clone()
        };
        assert_eq!(selected(&source), "surface");
        source["nodes"][3]["extras"] =
            json!({"pocketAtlas":{"geometry":{"role":"protected","maxErrorMeters":0}}});
        assert_eq!(selected(&source), "reference");
        source["nodes"][3]["extras"]["pocketAtlas"]["geometry"] =
            json!({"role":"detail","maxErrorMeters":0.01});
        assert_eq!(selected(&source), "reference");
    }
    #[test]
    fn malformed_unselected_alternatives_and_unsupported_skin_ownership_are_rejected() {
        let mut source = fixture();
        source["nodes"][0]["mesh"] = json!(0);
        assert!(validate(&source).unwrap_err().contains("transform-only"));
        source = fixture();
        source["nodes"][3]["skin"] = json!(0);
        assert!(validate(&source).unwrap_err().contains("skins or joints"));
        source = fixture();
        source["skins"] = json!([{"joints":[3]}]);
        assert!(validate(&source).unwrap_err().contains("skins or joints"));
        source = fixture();
        source["nodes"][3]["extras"] =
            json!({"pocketAtlas":{"alternative":{"id":"orphan","errorMeters":0}}});
        assert!(validate(&source)
            .unwrap_err()
            .contains("direct LOD group child"));
        source = fixture();
        source["nodes"][2]["extras"]["pocketAtlas"]["alternative"]["errorMeters"] = json!(0);
        assert!(validate(&source).unwrap_err().contains("increasing error"));
    }
}
