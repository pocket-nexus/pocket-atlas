//! Vita-only vertex material palette transform.
use super::*;

pub(super) fn run(cook: &mut Cook<'_>, prims: &mut Vec<Prim>, sx: &Value, hierarchy: &resolve::Hierarchy, world_of: &HashMap<usize, Mat4>, solid_pbr: bool) -> crate::recipe::Output<()> {
    let resolve::Hierarchy {parent, animated, ..} = hierarchy;
    // Solid PBR palettes are a Vita vertex encoding, not shared source
    // analysis: PICA/GE need the authored UVs, tint and material reflectance.
    // Keep named animated materials on their own path.
    let palette_before = prims.len();
    if solid_pbr {
        let material_animation: HashSet<String> = sx["tracks"]["materials"].as_array().into_iter().flatten()
            .filter_map(|t| t["material"].as_str().map(str::to_owned)).collect();
        let before = prims.len();
        palette::batch(prims, &mut cook.materials, &parent, &animated, &world_of, &material_animation);
        crate::progress!("solid PBR palette: {before} → {} primitives", prims.len());
    }

    crate::recipe::Output::new((), json!({"enabled":solid_pbr,"inputPrimitives":palette_before,"outputPrimitives":prims.len(),"reason":if solid_pbr{"GXM vertex PBR encoding"}else{"retain authored UVs and reflectance for fixed-function GPU"}}))
}

