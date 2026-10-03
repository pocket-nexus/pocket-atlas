//! Eligibility for moving only window-seed work from fragment to vertex.
//! The shader still evaluates parallax, clock-driven TV and view-dependent
//! reflection. This proof never substitutes an average seed or pane size.
use crate::{Draw, Kind, Material, VertexLayout};
use alloc::string::String;
#[cfg(not(feature = "std"))]
use num_traits::Float;

pub const VERSION: u32 = 1;
/// Keep authored samples away from floor's discontinuities. The relative
/// guard also rejects seed magnitudes whose float spacing eats this margin.
/// This is a recipe boundary, not a claim of bit-identical GPU interpolation.
pub const MIN_MARGIN: f32 = 1.0 / 1024.0;
pub const RELATIVE_MARGIN: f32 = 16.0 * f32::EPSILON;

/// `geometry` is the original PLIP GEOM, never the remapped display pages.
/// The caller supplies this draw's material after ordinary metadata validation.
/// UV uses the same float multiply/add as the non-animated runtime uUv decode.
/// Both full geometry and every authored LOD must satisfy the complete proof.
/// Empty coarse levels are valid; an empty full draw does not select the recipe.
/// Bad ranges/indices/non-finite inputs return Err; unsupported semantics or a
/// triangle crossing a seed/dimension boundary return Ok(false).
pub fn eligible(draw: &Draw, material: &Material, geometry: &[u8]) -> Result<bool, String> {
    if material.kind != Kind::InteriorWindow
        || material.uv_anim.is_some()
        || material.vertex_pbr
        || draw.layout == VertexLayout::Lights
    {
        return Ok(false);
    }
    if draw
        .uv_offset
        .iter()
        .chain(&draw.uv_scale)
        .any(|v| !v.is_finite())
    {
        return Err("window UV decode is non-finite".into());
    }
    let stride = super::stride(draw.layout) as usize;
    let length = (draw.vertex_count as usize)
        .checked_mul(stride)
        .ok_or("window vertex size overflow")?;
    if draw.vertices.offset % 4 != 0 || draw.vertices.size as usize != length {
        return Err("window vertex range/stride mismatch".into());
    }
    let vertices = crate::parts::slice(geometry, &draw.vertices)?;
    let mut accepted = draw.index_count != 0;
    let mut level = |range: &crate::Range, count: u32| -> Result<(), String> {
        let bytes = (count as usize)
            .checked_mul(2)
            .ok_or("window index size overflow")?;
        if range.offset % 2 != 0 || count % 3 != 0 || range.size as usize != bytes {
            return Err("window triangle range/count mismatch".into());
        }
        for triangle in crate::parts::slice(geometry, range)?.chunks_exact(6) {
            let mut first = None;
            for index in triangle.chunks_exact(2) {
                let index = u16::from_le_bytes(index.try_into().unwrap()) as usize;
                if index >= draw.vertex_count as usize {
                    return Err("window triangle index outside vertices".into());
                }
                let vertex = &vertices[index * stride..(index + 1) * stride];
                let uv = super::floats::<2>(vertex, 40)?;
                let mut seed = [0.0; 2];
                for k in 0..2 {
                    let value = uv[k] * draw.uv_scale[k] + draw.uv_offset[k];
                    if !value.is_finite() {
                        return Err("window final UV is non-finite".into());
                    }
                    seed[k] = value.floor();
                    let fraction = value - seed[k];
                    let margin = MIN_MARGIN.max(RELATIVE_MARGIN * value.abs().max(1.0));
                    if fraction < margin || 1.0 - fraction < margin {
                        accepted = false;
                    }
                }
                // Equal source bytes remain equal under the normalized-byte
                // attribute conversion and the original half COLOR varying.
                let key = (seed, [vertex[48], vertex[49]]);
                if first.is_some_and(|first| first != key) {
                    accepted = false;
                }
                first = Some(key);
            }
        }
        Ok(())
    };
    level(&draw.indices, draw.index_count)?;
    for lod in &draw.lods {
        level(&lod.indices, lod.index_count)?;
    }
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;
    fn fixture() -> (Draw, Material, Vec<u8>) {
        let material = serde_json::from_value(serde_json::json!({
            "name":"window","kind":"interior_window","blend":"opaque","double_sided":false,"depth_write":true,"alpha_test":0,
            "color":[1,1,1,1],"emissive":[1,0,0],"roughness":0.5,"metalness":0,"normal_scale":1,"ao_strength":1,"env_strength":1,
            "albedo":null,"normal":null,"orm":null,"emission":null,"vertex_color":true,"interior":false,"fog":true,
            "wet":null,"damp":null,"drops":0,"clearcoat":0,"polygon_offset":null,"emissive_track":null
        })).unwrap();
        let mut geometry = Vec::new();
        // Two separate seed cells may coexist in one draw. Full triangles
        // keep each seed independent; a coarse triangle crossing them cannot.
        for seed in [3.0, 7.0] {
            for uv in [[0.002, 0.002], [0.998, 0.002], [0.002, 0.998]] {
                geometry.extend([0u8; 40]);
                for v in uv {
                    geometry.extend((seed + v as f32).to_le_bytes());
                }
                geometry.extend([17, 31, 70, 255]);
            }
        }
        let count = 6;
        let vertices = crate::Range {
            offset: 0,
            size: geometry.len() as u32,
        };
        let indices = crate::Range {
            offset: geometry.len() as u32,
            size: 12,
        };
        geometry.extend([0u16, 1, 2, 3, 4, 5].into_iter().flat_map(u16::to_le_bytes));
        let lod = crate::Range {
            offset: geometry.len() as u32,
            size: 6,
        };
        geometry.extend([3u16, 4, 5].into_iter().flat_map(u16::to_le_bytes));
        let empty = crate::Range {
            offset: geometry.len() as u32,
            size: 0,
        };
        let draw = Draw {
            material: 0,
            layout: VertexLayout::Static,
            vertices,
            vertex_count: count,
            indices,
            index_count: 6,
            pos_offset: [0.; 3],
            pos_scale: [1.; 3],
            uv_offset: [0.; 2],
            uv_scale: [1.; 2],
            min: [0.; 3],
            max: [1.; 3],
            node: None,
            skin: None,
            no_reflect: false,
            cast_shadow: false,
            lods: vec![
                crate::DrawLod {
                    indices: lod,
                    index_count: 3,
                    error: 0.1,
                },
                crate::DrawLod {
                    indices: empty,
                    index_count: 0,
                    error: 0.2,
                },
            ],
        };
        (draw, material, geometry)
    }
    #[test]
    fn full_and_each_lod_prove_seed_and_dimensions_without_averaging() {
        let (d, m, g) = fixture();
        assert!(eligible(&d, &m, &g).unwrap());
        let mut bad = g.clone();
        bad[d.lods[0].indices.offset as usize..][..2].copy_from_slice(&0u16.to_le_bytes());
        assert!(
            !eligible(&d, &m, &bad).unwrap(),
            "coarse crossing cannot reuse full proof"
        );
        let mut bad = g.clone();
        bad[52 + 48] ^= 1;
        assert!(!eligible(&d, &m, &bad).unwrap());
        let mut bad = g.clone();
        bad[52 + 49] ^= 1;
        assert!(!eligible(&d, &m, &bad).unwrap());
        let mut other = m.clone();
        other.kind = Kind::Standard;
        assert!(!eligible(&d, &other, &g).unwrap());
        other = m.clone();
        other.uv_anim = Some(
            serde_json::from_value(
                serde_json::json!({"scroll":[0.1,0],"cols":1,"rows":1,"fps":1,"frames":1}),
            )
            .unwrap(),
        );
        assert!(!eligible(&d, &other, &g).unwrap());
    }
    #[test]
    fn decode_and_integer_margins_are_part_of_the_proof() {
        let (mut d, m, mut g) = fixture();
        d.uv_offset = [1., -2.];
        assert!(eligible(&d, &m, &g).unwrap());
        d.uv_scale = [2., 1.];
        assert!(!eligible(&d, &m, &g).unwrap());
        d.uv_scale = [1.; 2];
        g[40..44].copy_from_slice(&3.0f32.to_le_bytes());
        assert!(!eligible(&d, &m, &g).unwrap());
        g[40..44].copy_from_slice(&3.00001f32.to_le_bytes());
        assert!(!eligible(&d, &m, &g).unwrap());
        let (mut d, m, g) = fixture();
        d.uv_offset = [16384.; 2];
        assert!(!eligible(&d, &m, &g).unwrap());
        let (mut d, m, g) = fixture();
        d.uv_scale = [f32::MAX; 2];
        assert!(eligible(&d, &m, &g).is_err());
    }
    #[test]
    fn bad_strides_ranges_indices_and_finite_values_fail_closed() {
        let (d, m, g) = fixture();
        let mut bad = d.clone();
        bad.vertices.size -= 1;
        assert!(eligible(&bad, &m, &g).is_err());
        let mut bad = d.clone();
        bad.lods[0].indices.size += 2;
        assert!(eligible(&bad, &m, &g).is_err());
        let mut bad = d.clone();
        bad.lods[0].indices.offset = u32::MAX - 1;
        assert!(eligible(&bad, &m, &g).is_err());
        let mut bad = g.clone();
        bad[d.indices.offset as usize..][..2].copy_from_slice(&6u16.to_le_bytes());
        assert!(eligible(&d, &m, &bad).is_err());
        let mut bad = g.clone();
        bad[40..44].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(eligible(&d, &m, &bad).is_err());
    }
}
