//! Performance-only float vertex pages. Original GEOM, draw identities, every
//! LOD and cluster index remain unchanged; a source index gains one page base.
use super::{pc, Result};
use std::collections::BTreeMap;

pub(super) struct Draw {
    pub draw: u32,
    pub offset: u32,
    pub vertex_count: u32,
    pub texture: Option<u32>,
    pub flags: u32,
    pub page: Option<u32>,
    pub base_vertex: u32,
}
pub(super) struct Page {
    pub offset: u32,
    pub vertex_count: u32,
    pub state: u32,
}
struct Source {
    entry: usize,
    aliases: Vec<usize>,
}
fn word(n: usize) -> Result<u32> {
    u32::try_from(n).map_err(|_| "display page exceeds u32".into())
}
fn source_key(d: &pc::Draw, color: u32) -> String {
    serde_json::to_string(&(
        &d.vertices,
        d.vertex_count,
        d.layout,
        d.pos_offset,
        d.pos_scale,
        d.uv_offset,
        d.uv_scale,
        color,
    ))
    .unwrap()
}

pub(super) fn pack(
    meta: &pc::Meta,
    geometry: &[u8],
    colors: &[u8],
    draws: &mut [Draw],
) -> Result<(Vec<u8>, Vec<Page>, Vec<pc::display::State>)> {
    let mut groups = BTreeMap::<String, (pc::display::State, BTreeMap<String, Source>)>::new();
    let mut raw = Vec::new();
    for (entry, c) in draws.iter().enumerate() {
        let d = meta
            .draws
            .get(c.draw as usize)
            .ok_or("display draw reference")?;
        let m = meta
            .materials
            .get(d.material as usize)
            .ok_or("display material reference")?;
        if d.node.is_some()
            || d.skin.is_some()
            || m.blend != pc::Blend::Opaque
            || !m.depth_write
            || m.kind == pc::Kind::Glass
            || d.vertex_count > 65535
        {
            raw.push(entry);
            continue;
        }
        let state = pc::display::State::for_draw(meta, d, c.texture, c.flags)?;
        let key = serde_json::to_string(&state).map_err(|e| e.to_string())?;
        let (_, group) = groups
            .entry(key)
            .or_insert_with(|| (state, BTreeMap::new()));
        group
            .entry(source_key(d, c.offset))
            .and_modify(|s| s.aliases.push(entry))
            .or_insert(Source {
                entry,
                aliases: vec![entry],
            });
    }
    let mut bytes = Vec::new();
    let mut pages = Vec::new();
    let mut states = Vec::new();
    for (_, (state, group)) in groups {
        let state_index = word(states.len())?;
        states.push(state);
        let mut sources: Vec<_> = group.into_values().collect();
        sources.sort_by_key(|s| {
            (
                core::cmp::Reverse(draws[s.entry].vertex_count),
                draws[s.entry].draw,
            )
        });
        // First-fit decreasing keeps whole source pages together. The index
        // remap is a base addition, so no per-index lookup table is resident.
        let mut bins = Vec::<(u32, Vec<Source>)>::new();
        for s in sources {
            let count = draws[s.entry].vertex_count;
            if let Some((n, members)) = bins.iter_mut().find(|(n, _)| *n <= 65535 - count) {
                *n += count;
                members.push(s);
            } else {
                bins.push((count, vec![s]));
            }
        }
        for (count, sources) in bins {
            let page = word(pages.len())?;
            let offset = word(bytes.len())?;
            pages.push(Page {
                offset,
                vertex_count: count,
                state: state_index,
            });
            let mut base_vertex = 0;
            for source in sources {
                let c = &draws[source.entry];
                let d = &meta.draws[c.draw as usize];
                let stride = d.layout.stride() as usize;
                let end = d
                    .vertices
                    .offset
                    .checked_add(d.vertices.size)
                    .ok_or("display source range overflow")?;
                let vertices = geometry
                    .get(d.vertices.offset as usize..end as usize)
                    .ok_or("display source geometry range")?;
                if stride < 24 || d.vertex_count.checked_mul(stride as u32) != Some(d.vertices.size)
                {
                    return Err("display source vertex stride".into());
                }
                let color_end = c
                    .vertex_count
                    .checked_mul(4)
                    .and_then(|n| c.offset.checked_add(n))
                    .ok_or("display source color overflow")?;
                let color = colors
                    .get(c.offset as usize..color_end as usize)
                    .ok_or("display source colors range")?;
                for (v, rgba) in vertices.chunks_exact(stride).zip(color.chunks_exact(4)) {
                    let q =
                        |at| (i16::from_le_bytes([v[at], v[at + 1]]) as f32 / 32767.0).max(-1.0);
                    for k in 0..3 {
                        let value = q(k * 2) * d.pos_scale[k] + d.pos_offset[k];
                        if !value.is_finite() {
                            return Err("non-finite display position".into());
                        }
                        bytes.extend(value.to_le_bytes());
                    }
                    for k in 0..2 {
                        let value = q(16 + k * 2) * d.uv_scale[k] + d.uv_offset[k];
                        if !value.is_finite() {
                            return Err("non-finite display UV".into());
                        }
                        bytes.extend(value.to_le_bytes());
                    }
                    bytes.extend(rgba);
                }
                for alias in source.aliases {
                    let c = &mut draws[alias];
                    c.page = Some(page);
                    c.base_vertex = base_vertex;
                    c.offset = offset;
                }
                base_vertex += d.vertex_count;
            }
            debug_assert_eq!(base_vertex, count);
        }
    }
    let mut copied = BTreeMap::new();
    for entry in raw {
        let c = &mut draws[entry];
        let key = (c.offset, c.vertex_count);
        let offset = if let Some(&offset) = copied.get(&key) {
            offset
        } else {
            let end = c
                .vertex_count
                .checked_mul(4)
                .and_then(|n| c.offset.checked_add(n))
                .ok_or("display color range overflow")?;
            let data = colors
                .get(c.offset as usize..end as usize)
                .ok_or("display color range")?;
            let offset = word(bytes.len())?;
            bytes.extend(data);
            copied.insert(key, offset);
            offset
        };
        c.offset = offset;
        c.page = None;
        c.base_vertex = 0;
    }
    Ok((bytes, pages, states))
}

impl Draw {
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::json!({"draw":self.draw,"offset":self.offset,"vertexCount":self.vertex_count,"texture":self.texture,"flags":self.flags,"page":self.page,"baseVertex":self.base_vertex})
    }
}
impl Page {
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::json!({"offset":self.offset,"vertexCount":self.vertex_count,"state":self.state})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entries(meta: &pc::Meta) -> Vec<Draw> {
        let mut at = 0;
        meta.draws
            .iter()
            .enumerate()
            .map(|(i, d)| {
                let out = Draw {
                    draw: i as u32,
                    offset: at,
                    vertex_count: d.vertex_count,
                    texture: Some(0),
                    flags: 0,
                    page: None,
                    base_vertex: 0,
                };
                at += d.vertex_count * 4;
                out
            })
            .collect()
    }
    #[test]
    fn merged_pages_keep_every_position_uv_color_and_lod_index_exact() {
        let (mut m, g, _) = super::super::tests::fixture();
        m.draws[1].pos_offset = [10000.25, -123.5, 0.0625];
        m.draws[1].uv_scale = [37.125, -8.875];
        let original = g.clone();
        let mut draws = entries(&m);
        let colors = vec![137; draws.iter().map(|d| d.vertex_count as usize * 4).sum()];
        let (bytes, pages, _) = pack(&m, &g, &colors, &mut draws).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(g, original);
        for (d, c) in m.draws.iter().zip(&draws) {
            assert_eq!(c.page, Some(0));
            for (range, count) in core::iter::once((&d.indices, d.index_count))
                .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
            {
                let indices = &g[range.offset as usize..(range.offset + range.size) as usize];
                assert_eq!(indices.len(), count as usize * 2);
                for i in indices.chunks_exact(2) {
                    let index = u16::from_le_bytes(i.try_into().unwrap()) as usize;
                    let remapped = index + c.base_vertex as usize;
                    assert!(remapped < pages[0].vertex_count as usize);
                    let v = &g[d.vertices.offset as usize + index * d.layout.stride() as usize..];
                    let q = |at| (i16::from_le_bytes([v[at], v[at + 1]]) as f32 / 32767.).max(-1.);
                    let expected = [
                        q(0) * d.pos_scale[0] + d.pos_offset[0],
                        q(2) * d.pos_scale[1] + d.pos_offset[1],
                        q(4) * d.pos_scale[2] + d.pos_offset[2],
                        q(16) * d.uv_scale[0] + d.uv_offset[0],
                        q(18) * d.uv_scale[1] + d.uv_offset[1],
                    ];
                    let at = pages[0].offset as usize + remapped * 24;
                    for k in 0..5 {
                        assert_eq!(
                            f32::from_le_bytes(
                                bytes[at + k * 4..at + k * 4 + 4].try_into().unwrap()
                            ),
                            expected[k]
                        );
                    }
                    assert_eq!(&bytes[at + 20..at + 24], &[137; 4]);
                }
            }
        }
    }
    #[test]
    fn u16_page_limit_aliases_and_nonstatic_layout_are_explicit() {
        let (mut m, mut g, _) = super::super::tests::fixture();
        let stride = m.draws[0].layout.stride();
        for (i, d) in m.draws.iter_mut().enumerate() {
            d.vertex_count = if i == 0 { 60000 } else { 6000 };
            d.vertices.offset = if i == 0 { 0 } else { 60000 * stride };
            d.vertices.size = d.vertex_count * stride;
        }
        g.resize(66000 * stride as usize, 0);
        let mut draws = entries(&m);
        let colors = vec![251; 66000 * 4];
        let (_, pages, _) = pack(&m, &g, &colors, &mut draws).unwrap();
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|p| p.vertex_count <= 65535));
        m.draws[1] = m.draws[0].clone();
        let mut draws = entries(&m);
        draws[1].offset = draws[0].offset;
        let (bytes, pages, _) = pack(&m, &g, &colors, &mut draws).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(bytes.len(), 60000 * 24);
        assert_eq!(draws[0].base_vertex, draws[1].base_vertex);
        m.draws[0].node = Some(0);
        let mut draws = entries(&m);
        draws[1].offset = 0;
        let (_, pages, _) = pack(&m, &g, &colors, &mut draws).unwrap();
        assert_eq!(pages.len(), 1);
        assert!(draws[0].page.is_none());
        assert!(draws[1].page.is_some());
        m.materials[0].blend = pc::Blend::Alpha;
        let mut draws = entries(&m);
        draws[1].offset = 0;
        let (_, pages, _) = pack(&m, &g, &colors, &mut draws).unwrap();
        assert!(pages.is_empty());
        assert!(draws.iter().all(|d| d.page.is_none()));
    }

    #[test]
    fn display_state_merges_baked_material_differences_but_retains_diagnostic_flags_and_colors() {
        let (mut m, g, _) = super::super::tests::fixture();
        m.materials.push(m.materials[0].clone());
        m.draws[1].material = 1;
        m.materials[1].kind = pc::Kind::Unlit;
        m.materials[1].color = [0.2, 0.4, 0.6, 0.5];
        m.materials[1].metalness = 0.8;
        m.materials[1].ao_strength = 0.25;
        m.materials[1].emissive = [5.0, 2.0, 1.0];
        let mut draws = entries(&m);
        draws[0].flags = pc::display::GOURAUD_SUN;
        draws[1].flags = pc::display::SHARED_EMISSION_APPROX;
        let mut colors = vec![31; draws[0].vertex_count as usize * 4];
        colors.extend(vec![173; draws[1].vertex_count as usize * 4]);
        let (bytes, pages, states) = pack(&m, &g, &colors, &mut draws).unwrap();
        assert_eq!((pages.len(), states.len()), (1, 1));
        assert_eq!((draws[0].flags, draws[1].flags), (4, 2));
        for (entry, value) in draws.iter().zip([31, 173]) {
            for i in 0..entry.vertex_count as usize {
                let at = entry.offset as usize + (entry.base_vertex as usize + i) * 24;
                assert_eq!(&bytes[at + 20..at + 24], &[value; 4]);
            }
        }
        assert_eq!(m.draws[1].material, 1);
    }

    #[test]
    fn display_state_separates_every_live_alpha_uv_emission_wet_and_fixed_state() {
        for mode in 0..12 {
            let (mut m, g, _) = super::super::tests::fixture();
            m.materials.push(m.materials[0].clone());
            m.draws[1].material = 1;
            let mut draws = entries(&m);
            match mode {
                0 => m.materials[1].alpha_test = 0.5,
                1 => {
                    for mat in &mut m.materials {
                        mat.alpha_test = 0.5;
                    }
                    m.materials[1].color[3] = 0.75;
                }
                2 => {
                    m.materials[1].uv_anim = Some(pc::UvAnim {
                        scroll: [0.25, 0.0],
                        ..Default::default()
                    })
                }
                3 => m.materials[1].double_sided = !m.materials[0].double_sided,
                4 => m.materials[1].polygon_offset = Some([1.0, 2.0]),
                5 => m.materials[1].fog = !m.materials[0].fog,
                6 => {
                    m.textures.push(m.textures[0].clone());
                    draws[1].texture = Some(1);
                }
                7 | 8 => {
                    m.textures.push(m.textures[0].clone());
                    for (mat, d) in m.materials.iter_mut().zip(&mut draws) {
                        mat.albedo = Some(0);
                        mat.emission = Some(0);
                        mat.emissive = [1.0; 3];
                        d.flags = pc::display::INDEPENDENT_EMISSION;
                    }
                    if mode == 7 {
                        m.materials[1].emissive[1] = 2.0;
                    } else {
                        m.materials[1].emission = Some(1);
                    }
                }
                9..=11 => {
                    for (mat, d) in m.materials.iter_mut().zip(&mut draws) {
                        mat.wet = Some(pc::Wet {
                            planar: true,
                            darken: 0.5,
                            puddle_scale: 2.0,
                            ..Default::default()
                        });
                        d.flags = pc::display::PLANAR_WET;
                    }
                    match mode {
                        9 => m.materials[1].wet.as_mut().unwrap().ripple = 0.5,
                        10 => m.materials[1].wet.as_mut().unwrap().puddle_scale = 3.0,
                        _ => m.materials[1].roughness *= 0.5,
                    }
                }
                _ => unreachable!(),
            }
            let colors = vec![137; draws.iter().map(|d| d.vertex_count as usize * 4).sum()];
            let (_, pages, states) = pack(&m, &g, &colors, &mut draws).unwrap();
            assert_eq!((pages.len(), states.len()), (2, 2), "state mode {mode}");
        }
    }

    #[test]
    fn display_state_rejects_motion_blending_tracks_and_unknown_shader_contracts() {
        for mode in 0..10 {
            let (mut m, _, _) = super::super::tests::fixture();
            let mut flags = 0;
            match mode {
                0 => m.draws[0].node = Some(0),
                1 => m.draws[0].skin = Some(0),
                2 => m.materials[0].blend = pc::Blend::Alpha,
                3 => m.materials[0].depth_write = false,
                4 => m.materials[0].emissive_track = Some(0),
                5 => m.materials[0].kind = pc::Kind::Products,
                6 => flags = 64,
                7 => flags = pc::display::GLASS_DIFFUSE,
                8 => flags = pc::display::PLANAR_WET,
                9 => flags = pc::display::INDEPENDENT_EMISSION,
                _ => unreachable!(),
            }
            assert!(
                pc::display::State::for_draw(&m, &m.draws[0], Some(0), flags).is_err(),
                "reject mode {mode}"
            );
        }
    }
}
