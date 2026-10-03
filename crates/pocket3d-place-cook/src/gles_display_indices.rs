//! Optional exact two-sided Products LODs in the color sidecar's index tail.
//! Full/reference geometry and the complete display vertex prefix stay intact.
use super::{display_pages, pc, Result};
use std::collections::BTreeSet;

pub(super) fn append(
    meta: &pc::Meta,
    geometry: &[u8],
    bytes: &mut Vec<u8>,
    draws: &[display_pages::Draw],
    pages: &[display_pages::Page],
    states: &mut Vec<pc::display::State>,
) -> Result<Vec<pc::ipod::DisplayIndexOverride>> {
    let vertex_bytes = bytes.len();
    let mut overrides = Vec::new();
    for c in draws {
        if c.flags != pc::display::PRODUCTS_APPEARANCE {
            continue;
        }
        let d = meta
            .draws
            .get(c.draw as usize)
            .ok_or("display index draw")?;
        // This shared derivation also rejects animated/transparent/special
        // material variants. Only the baked Products shader ignores normals
        // and front-facingness; other display shader kinds are not inferred.
        let original = pc::display::State::for_draw(meta, d, c.texture, c.flags)?;
        let page = pages
            .get(c.page.ok_or("Products display index requires float page")? as usize)
            .ok_or("display index page")?;
        if states.get(page.state as usize) != Some(&original) {
            return Err("display index source state mismatch".into());
        }
        let start = (c.base_vertex as usize)
            .checked_mul(24)
            .and_then(|n| n.checked_add(page.offset as usize))
            .ok_or("display index vertex overflow")?;
        let end = (c.vertex_count as usize)
            .checked_mul(24)
            .and_then(|n| start.checked_add(n))
            .ok_or("display index vertex overflow")?;
        if end > vertex_bytes {
            return Err("display index vertex prefix range".into());
        }
        let mut seen = BTreeSet::new();
        for lod in &d.lods {
            if lod.index_count.checked_mul(2) != Some(lod.indices.size)
                || lod.indices.offset % 2 != 0
            {
                return Err("display index source stride".into());
            }
            // A range aliased by the full level cannot be selected separately
            // by the runtime. Leave it intact, and emit shared LOD ranges once.
            if (lod.indices.offset == d.indices.offset && lod.indices.size == d.indices.size)
                || !seen.insert((lod.indices.offset, lod.indices.size))
            {
                continue;
            }
            let source = super::slice(geometry, &lod.indices)?;
            let indices: Vec<_> = source
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes(v.try_into().unwrap()))
                .collect();
            let Some(reduced) =
                pc::ipod::display_indices::two_sided_indices(&bytes[start..end], &indices)?
            else {
                continue;
            };
            let mut double_sided = original.clone();
            double_sided.cull = false;
            let state = if let Some(index) = states.iter().position(|s| *s == double_sided) {
                index
            } else {
                let index = states.len();
                states.push(double_sided);
                index
            };
            let offset = u32::try_from(bytes.len()).map_err(|_| "display index offset overflow")?;
            let size = u32::try_from(reduced.len())
                .ok()
                .and_then(|n| n.checked_mul(2))
                .ok_or("display index size overflow")?;
            offset
                .checked_add(size)
                .ok_or("display index end overflow")?;
            bytes.extend(reduced.into_iter().flat_map(u16::to_le_bytes));
            overrides.push(pc::ipod::DisplayIndexOverride {
                draw: c.draw,
                source: lod.indices.clone(),
                indices: pc::Range { offset, size },
                state: u32::try_from(state).map_err(|_| "display index state overflow")?,
            });
        }
    }
    Ok(overrides)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_lod_reduces_only_the_sidecar_tail_and_overrides_only_culling() {
        let (mut meta, _, _) = super::super::tests::fixture();
        meta.draws.truncate(1);
        let d = &mut meta.draws[0];
        d.layout = pc::VertexLayout::Static;
        d.vertex_count = 8;
        d.vertices = pc::Range {
            offset: 0,
            size: 8 * 52,
        };
        d.indices = pc::Range {
            offset: 8 * 52,
            size: 6,
        };
        d.index_count = 3;
        d.lods = vec![pc::DrawLod {
            indices: pc::Range {
                offset: 8 * 52 + 6,
                size: 24,
            },
            index_count: 12,
            error: 0.012,
        }];
        meta.materials[0].kind = pc::Kind::Products;
        meta.materials[0].double_sided = false;
        meta.materials[0].alpha_test = 0.0;
        let mut geometry = vec![0; 8 * 52];
        geometry.extend(
            [0u16, 1, 2, 0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]
                .into_iter()
                .flat_map(u16::to_le_bytes),
        );
        let mut bytes = Vec::new();
        for _ in 0..2 {
            for [x, y] in [[0.0f32, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]] {
                for f in [x, y, 0.0, x, y] {
                    bytes.extend(f.to_le_bytes());
                }
                bytes.extend([255; 4]);
            }
        }
        let prefix = bytes.clone();
        let geom_before = geometry.clone();
        let meta_before = serde_json::to_vec(&meta).unwrap();
        let original = pc::display::State::for_draw(&meta, &meta.draws[0], Some(0), 64).unwrap();
        let mut states = vec![original.clone()];
        let draws = [display_pages::Draw {
            draw: 0,
            offset: 0,
            vertex_count: 8,
            texture: Some(0),
            flags: 64,
            page: Some(0),
            base_vertex: 0,
        }];
        let pages = [display_pages::Page {
            offset: 0,
            vertex_count: 8,
            state: 0,
        }];
        let out = append(&meta, &geometry, &mut bytes, &draws, &pages, &mut states).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source.offset, meta.draws[0].lods[0].indices.offset);
        assert_eq!(out[0].indices.offset, prefix.len() as u32);
        assert_eq!(out[0].indices.size, 12);
        assert_eq!(&bytes[..prefix.len()], prefix);
        assert_eq!(
            &bytes[prefix.len()..],
            &[0u16, 1, 2, 0, 2, 3]
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>()
        );
        let mut expected = original.clone();
        expected.cull = false;
        assert_eq!(states, vec![original, expected]);
        assert_eq!(geometry, geom_before);
        assert_eq!(serde_json::to_vec(&meta).unwrap(), meta_before);
        // Different back UV makes the whole original level remain untouched.
        let mut changed = prefix;
        changed[4 * 24 + 12] ^= 1;
        let before = changed.clone();
        assert!(
            append(&meta, &geometry, &mut changed, &draws, &pages, &mut states)
                .unwrap()
                .is_empty()
        );
        assert_eq!(changed, before);
    }
}
