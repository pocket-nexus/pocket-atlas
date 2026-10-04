//! Spatial partitioning and bounded geometry LODs.
use super::*;

pub(super) struct Geometry {
    pub draws: Vec<pc::Draw>,
    pub scene_min: Vec3,
    pub scene_max: Vec3,
    pub static_draws: usize,
    pub field_draws: usize,
}
pub(super) fn run(a: &Args, resolved: &resolve::Resolved<'_>, motion: &motion::Motion, baked_sun: bool, native_cache_order: bool) -> crate::recipe::Output<Geometry> {
    let resolve::Resolved {cook, prims, stock, field, scale_of, ..} = resolved;
    let motion::Motion {node_ids, skin_ids, ..} = motion;
    // ---- static chunking and draw building
    let mut draws: Vec<pc::Draw> = Vec::new();
    // Per bucket: vertices, triangles, and the positions on edges the chunk
    // shares with another chunk of the same primitive (locked in its LODs).
    type Bucket = (Vec<Vertex>, Vec<[u32; 3]>, HashSet<[u32; 3]>, f32);
    let mut static_buckets: BTreeMap<(u32, Cell, bool, bool, bool), Bucket> = BTreeMap::new();
    let mut scene_min = Vec3::splat(f32::MAX);
    let mut scene_max = Vec3::splat(f32::MIN);
    for p in prims {
        if p.moving || p.skin.is_some() {
            continue;
        }
        // Open water is one draw however far it reaches: its cost is per
        // pixel, and chunks of it only add draws.
        let water = cook.materials[p.material as usize].kind == pc::Kind::Water;
        let cells: Vec<Cell> = p
            .tris
            .iter()
            .map(|t| if water { Cell::Whole } else { triangle_cell(t.map(|i| p.verts[i as usize].pos), a.cell) })
            .collect();
        // Edges (by position, across attribute seams) whose triangles land in
        // different chunks.
        let cut = chunk_boundaries(&p.verts, &p.tris, &cells);
        for (t, &cell) in p.tris.iter().zip(&cells) {
            let e = static_buckets.entry((p.material, cell, p.no_reflect, p.baked, p.selection.protected())).or_default();
            e.3 = e.3.max(p.base_error);
            let base = e.0.len() as u32;
            for &i in t {
                let pos = p.verts[i as usize].pos;
                e.0.push(p.verts[i as usize]);
                if cut.contains(&geometry::pos_bits(pos)) {
                    e.2.insert(geometry::pos_bits(pos));
                }
                scene_min = scene_min.min(pos);
                scene_max = scene_max.max(pos);
            }
            e.1.push([base, base + 1, base + 2]);
        }
    }
    let mats = cook.materials.clone();
    #[allow(clippy::too_many_arguments)]
    let emit = |verts: &[Vertex], tris: &[[u32; 3]], locks: Option<&HashSet<[u32; 3]>>, bounds: &[f32], material: u32, layout: pc::VertexClass, node: Option<u32>, skin: Option<u32>, metric_scale: f32, no_reflect: bool, error_world: f32, protected: bool, resolved_intent: bool, draws: &mut Vec<pc::Draw>| {
        // Whole thin parts may vanish at distance from rigid lit surfaces
        // without emission. Animated rigid meshes use the same local-space
        // error bound; signs and lamps stay, and skinned people keep limbs.
        let m = &mats[material as usize];
        let drop_parts = !protected && skin.is_none() && m.kind == pc::Kind::Standard && m.emissive.iter().all(|&e| e <= 0.0) && m.emission.is_none();
        // The standard shader only consumes tangents for normal mapping and
        // UVs for material maps. Authored primitives often retain both on
        // plain metal/paint; remove those unused seams before simplification.
        let mut source = verts.to_vec();
        if a.target == ir::Target::Vita && m.kind == pc::Kind::Standard {
            for v in &mut source {
                if m.normal.is_none() { v.tangent = [1.0, 0.0, 0.0, 1.0]; }
                if !m.vertex_pbr && m.albedo.is_none() && m.normal.is_none() && m.orm.is_none() && m.emission.is_none() { v.uv = Vec2::ZERO; }
            }
        }
        let (mut verts, mut tris) = geometry::weld(&source, tris);
        // Palette UVs encode reflectance, so protect their discontinuities
        // as strongly as vertex colour instead of ordinary texture coords.
        let uv_weight = if m.vertex_pbr { 0.5 } else { 0.02 };
        // Rigid motion keeps detailed source meshes unbaked. Remove redundant
        // tessellation within 4 mm (including normal/UV/colour error) before
        // shipping them; emissive parts and skin weights remain untouched.
        let mut base_error = error_world / metric_scale;
        if node.is_some() && drop_parts && !resolved_intent {
            let locked = if m.vertex_pbr { geometry::palette_locks(&verts) } else { vec![false; verts.len()] };
            if let Some((reduced, error)) = geometry::simplify(&verts, &tris, 0.4, 0.004 / metric_scale, &locked, uv_weight) {
                (verts, tris) = geometry::weld(&verts, &reduced);
                base_error = error;
            }
        }
        // Preserve the GE daylight solid-surface budget without coarsening pane outlines.
        let ge_static = baked_sun && node.is_none() && skin.is_none()
            && m.kind == pc::Kind::Standard && m.alpha_test == 0.0 && m.polygon_offset.is_none();
        let bounds: Vec<f32> = bounds.iter().filter(|_| !protected).map(|e| e * if ge_static { 2.0 } else { 1.0 } / metric_scale).collect();
        for (v, t) in geometry::split(&verts, &tris) {
            let mut locked: Vec<bool> = v.iter().map(|v| locks.is_some_and(|l| l.contains(&geometry::pos_bits(v.pos)))).collect();
            if m.vertex_pbr {
                for (lock, seam) in locked.iter_mut().zip(geometry::palette_locks(&v)) { *lock |= seam; }
            }
            let levels = geometry::lods(&v, &t, layout, &locked, drop_parts, &bounds, uv_weight).into_iter().map(|(t, e)| (t, (e + base_error) * metric_scale)).collect();
            push_draw(&v, &t, levels, material, layout, node, skin, no_reflect, native_cache_order, draws);
            draws.last_mut().unwrap().protected = protected;
        }
    };
    // Shelf stock: groups of items near each other, full stand-ins plus the
    // LOD1 cards in one vertex buffer.
    let mut stock_groups: BTreeMap<(u32, i32, i32), Vec<&Stock>> = BTreeMap::new();
    for s in stock {
        stock_groups.entry((s.material, (s.center.x / 4.0).floor() as i32, (s.center.z / 4.0).floor() as i32)).or_default().push(s);
    }
    let emit_stock = |draws: &mut Vec<pc::Draw>| {
        for ((material, _, _), items) in &stock_groups {
            let mut start = 0;
            while start < items.len() {
                let (mut verts, mut tris, mut cards) = (Vec::new(), Vec::new(), Vec::new());
                let (mut end, mut count) = (start, 0);
                while end < items.len() && count + items[end].full.0.len() + items[end].card.0.len() <= 65535 {
                    count += items[end].full.0.len() + items[end].card.0.len();
                    end += 1;
                }
                // Full stand-ins first, then the cards, all in one buffer.
                for s in &items[start..end] {
                    let base = verts.len() as u32;
                    verts.extend_from_slice(&s.full.0);
                    tris.extend(s.full.1.iter().map(|t| t.map(|i| i + base)));
                }
                for s in &items[start..end] {
                    let base = verts.len() as u32;
                    verts.extend_from_slice(&s.card.0);
                    cards.extend(s.card.1.iter().map(|t| t.map(|i| i + base)));
                }
                let cards = geometry::cache_order(&cards, verts.len());
                // Cards replace items beyond a few metres (a small nominal
                // error puts the switch at ~4 m at 640×362).
                push_draw(&verts, &tris, vec![(cards, 0.012)], *material, pc::VertexClass::Static, None, None, true, native_cache_order, draws);
                start = end;
            }
        }
    };
    for ((material, cell, no_reflect, baked, protected), (verts, tris, locks, error)) in &static_buckets {
        let layout = if *baked { pc::VertexClass::Baked } else { pc::VertexClass::Static };
        emit(verts, tris, Some(locks), &lod_bounds(*cell), *material, layout, None, None, 1.0, *no_reflect, *error, *protected, true, &mut draws);
    }
    emit_stock(&mut draws);
    let static_draws = draws.len();
    for p in prims {
        if !(p.moving || p.skin.is_some()) {
            continue;
        }
        let skin = p.skin.map(|s| skin_ids[&s]);
        let node = if skin.is_none() { node_ids.get(&p.mesh_node).copied() } else { None };
        let layout = if skin.is_some() { pc::VertexClass::Skinned } else { pc::VertexClass::Static };
        emit(&p.verts, &p.tris, None, &[0.01, 0.025, 0.06, 0.25], p.material, layout, node, skin, scale_of[&p.mesh_node], false, p.base_error, p.selection.protected(), p.selection.intent.is_some(), &mut draws);
    }
    let _ = &prims.iter().map(|p| p.world).count();

    // ---- light fields: one vertex per light, by geometry's cells (no
    // smaller than 512 m), at most `LightPoint::PER_DRAW` per draw. Twice
    // those cells drew 32 instead of 47 field draws at Griffith
    // Observatory's Lawn but cost 0.64 ms more GPU: the clipper's work on
    // 20 000 more lights outside the view outweighs 15 draws.
    let mut field_cells: BTreeMap<(u32, Cell), Vec<pc::LightPoint>> = BTreeMap::new();
    for (material, l) in field {
        let (lo, hi) = l.bounds();
        field_cells.entry((*material, cell_at((Vec3::from(lo) + Vec3::from(hi)) * 0.5, a.cell, 512.0))).or_default().push(*l);
    }
    let field_draws = draws.len();
    for ((material, _), lights) in &field_cells {
        for chunk in lights.chunks(a.profile.recipe.max_field_points) {
            let (mut plo, mut phi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
            let (mut lo, mut hi) = (plo, phi);
            for l in chunk {
                plo = plo.min(Vec3::from(l.position));
                phi = phi.max(Vec3::from(l.position));
                let (a, b) = l.bounds();
                lo = lo.min(Vec3::from(a));
                hi = hi.max(Vec3::from(b));
            }
            scene_min = scene_min.min(lo);
            scene_max = scene_max.max(hi);
            draws.push(pc::Draw {
                material: *material,
                class: pc::VertexClass::Lights,
                geometry: pc::Geometry::LightField(chunk.to_vec()),
                min: lo.to_array(),
                max: hi.to_array(),
                node: None,
                skin: None,
                no_reflect: true,
                cast_shadow: false,
                protected: false,
            });
        }
    }
    let field_draws = draws.len() - field_draws;

    let decision = json!({"cellMeters":a.cell,"draws":draws.len(),"lods":draws.iter().map(|d|d.lods().len()).sum::<usize>(),"nativeCacheOrder":native_cache_order});
    crate::recipe::Output::new(Geometry {draws, scene_min, scene_max, static_draws, field_draws}, decision)
}
