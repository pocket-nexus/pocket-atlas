//! SGX light-field pages, built during the same source lowering as GEOM.
//! Original fields remain the culling/density units; a page only removes
//! repeated buffer bindings and shares an identity world-position decode.
use super::{pc, Result};
use std::collections::BTreeMap;

pub(super) fn build(
    meta: &pc::Meta,
    geometry: &[u8],
) -> Result<(Vec<u8>, Option<pc::ipod::LightPages>)> {
    use pc::ipod::light_pages as proof;
    let mut pages = Vec::<pc::ipod::LightPage>::new();
    let mut current = BTreeMap::<Vec<u8>, usize>::new();
    for (id, draw) in meta.draws.iter().enumerate() {
        if draw.layout != pc::VertexLayout::Lights {
            continue;
        }
        let key = proof::key(meta, draw)?;
        if draw.vertex_count == 0 || draw.vertex_count > proof::MAX_VERTICES {
            return Err("light page cannot contain the complete source field".into());
        }
        let page = current.get(&key).copied().filter(|&i| {
            pages[i]
                .vertex_count
                .checked_add(draw.vertex_count)
                .is_some_and(|n| n <= proof::MAX_VERTICES)
        });
        let page = page.unwrap_or_else(|| {
            let i = pages.len();
            pages.push(pc::ipod::LightPage {
                vertices: pc::Range::default(),
                vertex_count: 0,
                fields: Vec::new(),
            });
            current.insert(key, i);
            i
        });
        let page = &mut pages[page];
        page.fields.push(pc::ipod::LightPageField {
            draw: u32::try_from(id).map_err(|_| "light field draw index overflow")?,
            first: page.vertex_count,
        });
        page.vertex_count += draw.vertex_count;
    }
    if pages.is_empty() {
        return Ok((Vec::new(), None));
    }
    let mut payload = Vec::new();
    for page in &mut pages {
        let size = (page.vertex_count as usize)
            .checked_mul(proof::STRIDE)
            .ok_or("light page byte count overflow")?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(size)
            .map_err(|_| "light page allocation failed")?;
        for field in &page.fields {
            let draw = &meta.draws[field.draw as usize];
            let source = pc::parts::slice(geometry, &draw.vertices)?;
            if source.len() != draw.vertex_count as usize * pc::LIGHT_POINT_STRIDE {
                return Err("light page source stride/count mismatch".into());
            }
            for point in source.chunks_exact(pc::LIGHT_POINT_STRIDE) {
                bytes.extend(proof::vertex(point, draw)?);
            }
        }
        debug_assert_eq!(bytes.len(), size);
        page.vertices = super::append(&mut payload, &bytes, 16)?;
    }
    let recipe = pc::ipod::LightPages {
        version: proof::VERSION,
        source_hash: proof::source_hash(meta, geometry)?,
        payload_hash: proof::payload_hash(&payload),
        pages,
    };
    proof::validate(meta, geometry, &payload, &recipe)?;
    Ok((payload, Some(recipe)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(fields: &[(usize, bool, f32, f32)]) -> (pc::Meta, Vec<u8>) {
        let (mut meta, _, mut geometry) = super::super::gles_geometry::tests::fixture();
        meta.draws.truncate(1);
        let template = meta.draws[0].clone();
        let material = meta.materials[0].clone();
        for (id, &(count, fog, gain, period)) in fields.iter().enumerate() {
            let mut m = material.clone();
            m.name = format!("independent source material {id}");
            m.kind = pc::Kind::Lights;
            m.fog = fog;
            m.lights = Some(pc::LightField {
                min_pixels: 1.5,
                max_pixels: 12.,
                gain,
                period,
                depth_pull: 0.4,
            });
            let mut d = template.clone();
            d.material = meta.materials.len() as u32;
            meta.materials.push(m);
            d.layout = pc::VertexLayout::Lights;
            d.pos_offset = [17.5 * id as f32, 2., -31.];
            d.pos_scale = [2., 4., 8.];
            d.min = [d.pos_offset[0] - 2., -2., -39.];
            d.max = [d.pos_offset[0] + 5., 6., -21.];
            d.lods.clear();
            d.indices = pc::Range::default();
            d.vertex_count = count as u32;
            d.index_count = count as u32;
            let mut bytes = Vec::new();
            for i in 0..count {
                let point = pc::LightPoint {
                    position: [d.pos_offset[0] - 1., 3., -29.],
                    color: [0.4, 0.8, 0.2],
                    intensity: 13.,
                    radius: 0.15,
                    phase: (i % 17) as f32 / 17.,
                    twinkle: 0.6,
                    path: [3., -0.25, 2.],
                    path_cycles: 2.,
                    blink_cycles: 3.,
                    duty: 0.75,
                };
                pc::encode_light_point(&point, d.pos_offset, d.pos_scale, &mut bytes);
            }
            // Exercise the negative ES2 signed-normalized endpoint that the
            // round-to-32767 source encoder does not normally produce.
            if !bytes.is_empty() {
                bytes[..2].copy_from_slice(&i16::MIN.to_le_bytes());
            }
            d.vertices = super::super::append(&mut geometry, &bytes, 16).unwrap();
            meta.draws.push(d);
        }
        (meta, geometry)
    }

    #[test]
    fn pages_group_actual_uniforms_and_preserve_every_source_point() {
        use pc::ipod::light_pages as proof;
        let (meta, geometry) = fixture(&[
            (3, false, 1., 120.),
            (5, false, 1., 120.),
            (2, false, 2., 120.),
            (4, true, 1., 120.),
            (1, false, 1., 60.),
            (2, false, 1., 120.),
        ]);
        let original_meta = serde_json::to_vec(&meta).unwrap();
        let original_geometry = geometry.clone();
        let (payload, recipe) = build(&meta, &geometry).unwrap();
        let recipe = recipe.unwrap();
        assert_eq!(recipe.pages.len(), 4);
        let ids: Vec<_> = recipe.pages[0]
            .fields
            .iter()
            .map(|f| (f.draw, f.first))
            .collect();
        assert_eq!(ids, [(1, 0), (2, 3), (6, 8)]);
        assert_eq!(recipe.pages[0].vertex_count, 10);
        for page in &recipe.pages {
            assert_eq!(page.vertices.offset % 16, 0);
            for field in &page.fields {
                let draw = &meta.draws[field.draw as usize];
                let source = pc::parts::slice(&geometry, &draw.vertices).unwrap();
                for (i, point) in source.chunks_exact(pc::LIGHT_POINT_STRIDE).enumerate() {
                    let at =
                        page.vertices.offset as usize + (field.first as usize + i) * proof::STRIDE;
                    assert_eq!(
                        &payload[at..at + proof::STRIDE],
                        proof::vertex(point, draw).unwrap()
                    );
                    assert_eq!(&payload[at + 16..at + 48], &point[8..40]);
                }
            }
        }
        assert_eq!(geometry, original_geometry);
        assert_eq!(serde_json::to_vec(&meta).unwrap(), original_meta);
        let (again, second) = build(&meta, &geometry).unwrap();
        assert_eq!(again, payload);
        assert_eq!(
            serde_json::to_vec(&second.unwrap()).unwrap(),
            serde_json::to_vec(&recipe).unwrap()
        );
        proof::validate(&meta, &geometry, &payload, &recipe).unwrap();
        let mut changed = payload.clone();
        changed[16] ^= 1;
        let mut rebound = recipe.clone();
        rebound.payload_hash = proof::payload_hash(&changed);
        assert!(proof::validate(&meta, &geometry, &changed, &rebound).is_err());
    }

    #[test]
    fn page_capacity_never_splits_a_field_or_truncates_u16_indices() {
        use pc::ipod::light_pages as proof;
        let count = pc::LIGHT_POINTS_PER_DRAW;
        let (meta, geometry) = fixture(&[(count, false, 1., 120.); 5]);
        let (payload, recipe) = build(&meta, &geometry).unwrap();
        let recipe = recipe.unwrap();
        assert_eq!(recipe.pages.len(), 2);
        assert_eq!(recipe.pages[0].vertex_count, (count * 3) as u32);
        assert_eq!(recipe.pages[1].vertex_count, (count * 2) as u32);
        assert_eq!(payload.len(), count * 5 * proof::STRIDE);
        let fields: Vec<_> = recipe
            .pages
            .iter()
            .flat_map(|p| &p.fields)
            .map(|f| f.draw)
            .collect();
        assert_eq!(fields, [1, 2, 3, 4, 5]);
        for page in &recipe.pages {
            assert!(page.vertex_count <= proof::MAX_VERTICES);
            for field in &page.fields {
                let last = field.first + meta.draws[field.draw as usize].vertex_count - 1;
                assert!(u16::try_from(last).is_ok());
            }
        }
        let mut invalid = meta.clone();
        invalid.draws[1].vertices.size -= 1;
        assert!(build(&invalid, &geometry).is_err());
        let mut overlap = recipe.clone();
        overlap.pages[1].fields[0].draw = 1;
        assert!(proof::validate(&meta, &geometry, &payload, &overlap).is_err());
        let (empty, _, _) = super::super::gles_geometry::tests::fixture();
        assert!(build(&empty, &[]).unwrap().1.is_none());
    }
}
