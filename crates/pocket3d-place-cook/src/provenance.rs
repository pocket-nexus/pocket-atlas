//! Source IDs survive Web batching. Material ownership is a contributor set, not per-triangle attribution.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

fn annotation(raw: &gltf::json::Extras) -> Value {
    raw.as_ref()
        .and_then(|v| serde_json::from_str::<Value>(v.get()).ok())
        .unwrap_or(Value::Null)["pocketAtlas"]
        .clone()
}
fn ids(value: &Value, fallback: String) -> BTreeSet<String> {
    let mut result: BTreeSet<_> = value["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    if result.is_empty() {
        result.insert(value["sourceId"].as_str().unwrap_or(&fallback).into());
    }
    result
}
pub fn collect(doc: &gltf::Document, material_keys: &HashMap<usize, u32>) -> Value {
    let mut sources: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    let mut objects = Vec::new();
    for node in doc.nodes() {
        let own = ids(
            &annotation(node.extras()),
            format!("gltf/node/{}", node.index()),
        );
        if let Some(mesh) = node.mesh() {
            let materials: BTreeSet<_> = mesh
                .primitives()
                .map(|p| p.material().index().unwrap_or(usize::MAX))
                .collect();
            for material in &materials {
                sources.entry(*material).or_default().extend(own.clone());
            }
            objects.push(json!({"node":node.index(),"name":node.name(),"sources":own,
                "materials":materials.iter().filter_map(|id|material_keys.get(id)).collect::<Vec<_>>()}));
        }
    }
    let materials: Vec<_> = doc
        .materials()
        .filter_map(|m| {
            let index = m.index()?;
            let cooked = material_keys.get(&index)?;
            let mut owners = ids(&annotation(m.extras()), format!("gltf/material/{index}"));
            owners.extend(sources.get(&index).into_iter().flatten().cloned());
            Some(json!({"sourceMaterial":index,"material":cooked,"name":m.name(),"sources":owners}))
        })
        .collect();
    json!({"objects":objects,"materials":materials,"attribution":"material-contributors"})
}

pub fn texture_sources(scene: &crate::source::Scene, texture: usize) -> Vec<String> {
    let mats: BTreeSet<_> = scene
        .materials
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            [m.albedo, m.normal, m.orm, m.emission]
                .into_iter()
                .flatten()
                .any(|t| t as usize == texture)
                .then_some(i as u64)
        })
        .collect();
    scene.provenance["materials"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["material"].as_u64().is_some_and(|i| mats.contains(&i)))
        .flat_map(|m| m["sources"].as_array().into_iter().flatten())
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
