//! Bounded source-object simplification. No place IDs, camera-specific holes,
//! component removal, text simplification or skin topology changes.
use super::*;
pub(super) fn run(resolved: &mut resolve::Resolved<'_>) -> crate::recipe::Output<()> {
    let mut costs = Vec::new();
    let mut before_total = 0;
    let mut after_total = 0;
    for p in &mut resolved.prims {
        let m = &resolved.cook.materials[p.material as usize];
        let before = p.tris.len();
        let vertices_before = p.verts.len();
        let scale = if p.moving {
            resolved.scale_of[&p.mesh_node]
        } else {
            1.0
        };
        let permission = p.selection.budget - p.selection.representation_error;
        let text = [m.albedo, m.emission].into_iter().flatten().any(|id| {
            matches!(
                resolved.cook.textures[id as usize].usage,
                Some(pc::TextureUsage::TextAtlas | pc::TextureUsage::EmissiveStrip)
            )
        });
        let protected = p.selection.protected() || text;
        if text {
            p.selection.intent = Some(crate::intent::Intent {
                role: crate::intent::Role::Protected,
                max_error_meters: 0.0,
            });
        }
        let eligible = !protected
            && p.skin.is_none()
            && permission > 0.0
            && m.kind == pc::Kind::Standard
            && m.blend == pc::Blend::Opaque
            && m.alpha_test == 0.0
            && m.emission.is_none()
            && m.emissive.iter().all(|&e| e == 0.0);
        if eligible {
            let mut source = p.verts.clone();
            // PICA/GE do not consume tangent-space normals. UVs without a
            // source texture have no meaning for their fixed-function bake.
            if resolved.cook.profile.target != ir::Target::Vita {
                for v in &mut source {
                    v.tangent = [1.0, 0.0, 0.0, 1.0];
                    if m.albedo.is_none() && m.emission.is_none() {
                        v.uv = Vec2::ZERO;
                    }
                }
            }
            let (vertices, triangles) = geometry::weld(&source, &p.tris);
            let locks = if m.vertex_pbr {
                geometry::palette_locks(&vertices)
            } else {
                vec![false; vertices.len()]
            };
            if let Some((indices, error)) = geometry::simplify_with_borders(
                &vertices,
                &triangles,
                0.25,
                permission / scale,
                &locks,
                if m.vertex_pbr { 0.5 } else { 0.02 },
                true,
            ) {
                (p.verts, p.tris) = geometry::weld(&vertices, &indices);
                p.base_error = error * scale + p.selection.representation_error;
            } else {
                p.verts = vertices;
                p.tris = triangles;
            }
        }
        costs.push(json!({"sources":p.sources,"node":p.mesh_node,"material":m.name,"moving":p.moving,"role":p.selection.intent.map(|i|i.role),
            "inputTriangles":before,"outputTriangles":p.tris.len(),"inputVertices":vertices_before,"outputVertices":p.verts.len(),
            "baseErrorMeters":p.base_error,"budgetMeters":p.selection.budget,"protected":protected,"simplified":p.tris.len()<before}));
        before_total += before;
        after_total += p.tris.len();
    }
    resolved.geometry_report = serde_json::to_value(costs).unwrap();
    crate::recipe::Output::new(
        (),
        json!({"inputTriangles":before_total,"outputTriangles":after_total,"objects":resolved.prims.len(),"policy":resolved.cook.profile.recipe.geometry_error_meters,"openBorders":"locked","componentRemoval":false}),
    )
}
