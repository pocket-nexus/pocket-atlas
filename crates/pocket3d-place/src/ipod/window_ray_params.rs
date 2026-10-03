//! Eligibility for commuting a window's constant frame with interpolation.
//! This is independent of the seed-only recipe: old declarations never imply
//! that normal/tangent interpolation can be removed. Original geometry is read
//! directly; neither display pages nor sampled camera poses prove this rule.
use crate::{Draw, Material, VertexLayout};
use alloc::string::String;

pub const VERSION: u32 = 1;

/// In addition to the seed proof, every full/LOD triangle needs exactly equal
/// normal, tangent and sign bits at its vertices. The frame need not be
/// orthogonal: the fragment still normalises its projected ray, and distance
/// uses the reflected world vector instead of the tangent-space ray.
///
/// Only static geometry is supported by v1. A later rigid/skin extension needs
/// an explicit proof of the common transformed frame, not a pose sample.
/// Malformed/non-finite records are errors; unsupported or degenerate frames
/// select the original shader. Empty coarse levels retain their usual meaning.
pub fn eligible(draw: &Draw, material: &Material, geometry: &[u8]) -> Result<bool, String> {
    if !super::window_params::eligible(draw, material, geometry)?
        || draw.node.is_some()
        || draw.skin.is_some()
        || matches!(draw.layout, VertexLayout::Lights | VertexLayout::Skinned)
    {
        return Ok(false);
    }
    let stride = super::stride(draw.layout) as usize;
    let vertices = crate::parts::slice(geometry, &draw.vertices)?;
    let mut accepted = true;
    let mut level = |range: &crate::Range| -> Result<(), String> {
        // The seed proof already checked exact range sizes and every index.
        for triangle in crate::parts::slice(geometry, range)?.chunks_exact(6) {
            let mut first: Option<&[u8]> = None;
            for index in triangle.chunks_exact(2) {
                let index = u16::from_le_bytes(index.try_into().unwrap()) as usize;
                let vertex = &vertices[index * stride..(index + 1) * stride];
                let frame = &vertex[12..40];
                if first.is_some_and(|old| old != frame) {
                    accepted = false;
                }
                first = Some(frame);
                let normal = super::floats::<3>(vertex, 12)?;
                let tangent = super::floats::<4>(vertex, 24)?;
                // Normalisation happens twice around the existing half stage
                // boundary. Unit-ish source vectors exclude overflow/underflow
                // there, while allowing arbitrary finite frame skew. The cross
                // guard leaves ample room for binary16 rounding at that boundary.
                let n = normal.map(f64::from);
                let t = [tangent[0] as f64, tangent[1] as f64, tangent[2] as f64];
                let n2 = n.iter().map(|v| v * v).sum::<f64>();
                let t2 = t.iter().map(|v| v * v).sum::<f64>();
                let c = [
                    n[1] * t[2] - n[2] * t[1],
                    n[2] * t[0] - n[0] * t[2],
                    n[0] * t[1] - n[1] * t[0],
                ];
                let c2 = c.iter().map(|v| v * v).sum::<f64>();
                if !(0.25..=4.0).contains(&n2)
                    || !(0.25..=4.0).contains(&t2)
                    || c2 < n2 * t2 * (1.0 / 256.0)
                    || !matches!(tangent[3], -1.0 | 1.0)
                {
                    accepted = false;
                }
            }
        }
        Ok(())
    };
    level(&draw.indices)?;
    for lod in &draw.lods {
        level(&lod.indices)?;
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
        for x in [0., 1.] {
            for (position, uv) in [
                ([x, 0., 0.], [0.002, 0.002]),
                ([x + 1., 0., 0.], [0.998, 0.002]),
                ([x, 1., 0.], [0.002, 0.998]),
            ] {
                for value in position
                    .into_iter()
                    .chain([0., 0., 1.])
                    .chain([1., 0., 0., 1.])
                    .chain(uv)
                {
                    geometry.extend((value as f32).to_le_bytes());
                }
                geometry.extend([17, 31, 70, 255]);
            }
        }
        let vertices = crate::Range {
            offset: 0,
            size: geometry.len() as u32,
        };
        let indices = crate::Range {
            offset: geometry.len() as u32,
            size: 12,
        };
        geometry.extend([0u16, 1, 2, 3, 4, 5].into_iter().flat_map(u16::to_le_bytes));
        let coarse = crate::Range {
            offset: geometry.len() as u32,
            size: 6,
        };
        geometry.extend([0u16, 1, 2].into_iter().flat_map(u16::to_le_bytes));
        let draw = Draw {
            material: 0,
            layout: VertexLayout::Static,
            vertices,
            vertex_count: 6,
            indices,
            index_count: 6,
            pos_offset: [0.; 3],
            pos_scale: [1.; 3],
            uv_offset: [0.; 2],
            uv_scale: [1.; 2],
            min: [0.; 3],
            max: [2.; 3],
            node: None,
            skin: None,
            no_reflect: false,
            cast_shadow: false,
            lods: vec![crate::DrawLod {
                indices: coarse,
                index_count: 3,
                error: 0.1,
            }],
        };
        (draw, material, geometry)
    }

    fn field(g: &mut [u8], vertex: usize, offset: usize, value: f32) {
        g[vertex * 52 + offset..][..4].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn full_and_every_lod_require_one_frame_but_not_orthogonality() {
        let (d, m, mut g) = fixture();
        assert!(eligible(&d, &m, &g).unwrap());
        // A second triangle may have another frame, and a skew frame is valid.
        for vertex in 3..6 {
            field(&mut g, vertex, 32, 0.5);
        }
        assert!(eligible(&d, &m, &g).unwrap());
        g[d.lods[0].indices.offset as usize..][..2].copy_from_slice(&3u16.to_le_bytes());
        assert!(
            !eligible(&d, &m, &g).unwrap(),
            "a coarse triangle cannot cross frames"
        );
        let (d, m, mut g) = fixture();
        field(&mut g, 1, 36, -1.0);
        assert!(!eligible(&d, &m, &g).unwrap());
        let (d, m, mut g) = fixture();
        field(&mut g, 1, 12, -0.0);
        assert!(
            !eligible(&d, &m, &g).unwrap(),
            "the proof compares frame bits"
        );
    }

    #[test]
    fn degenerate_frame_and_animated_semantics_fall_back() {
        for change in [(24, 0.0), (36, 0.0), (20, 0.0), (24, 65504.0)] {
            let (d, m, mut g) = fixture();
            for vertex in 0..6 {
                field(&mut g, vertex, change.0, change.1);
            }
            assert!(!eligible(&d, &m, &g).unwrap());
        }
        let (d, m, mut g) = fixture();
        for vertex in 0..6 {
            field(&mut g, vertex, 24, 0.0);
            field(&mut g, vertex, 32, 1.0);
        }
        assert!(
            !eligible(&d, &m, &g).unwrap(),
            "parallel frame cannot define a room"
        );
        let (mut d, m, g) = fixture();
        d.node = Some(0);
        assert!(!eligible(&d, &m, &g).unwrap());
        d.node = None;
        d.skin = Some(0);
        assert!(!eligible(&d, &m, &g).unwrap());
    }

    #[test]
    fn bad_data_errors_and_seed_proof_is_still_required() {
        let (d, m, g) = fixture();
        for offset in [12, 20, 24, 36] {
            let mut bad = g.clone();
            field(&mut bad, 0, offset, f32::NAN);
            assert!(eligible(&d, &m, &bad).is_err());
        }
        let mut bad = g.clone();
        field(&mut bad, 0, 40, 1.002);
        assert!(!eligible(&d, &m, &bad).unwrap());
        let mut bad = g.clone();
        bad[d.indices.offset as usize..][..2].copy_from_slice(&u16::MAX.to_le_bytes());
        assert!(eligible(&d, &m, &bad).is_err());
        let mut bad = d.clone();
        bad.lods[0].indices.size -= 1;
        assert!(eligible(&bad, &m, &g).is_err());
    }
}
