//! Target-native float vertices. No quantized device geometry is an input.
use super::{pc, Result};
use crate::geometry::Vertex;
pub(super) fn vertex(v: &Vertex, layout: pc::VertexLayout, out: &mut Vec<u8>) -> Result<()> {
    for f in v
        .pos
        .to_array()
        .into_iter()
        .chain(v.normal.to_array())
        .chain(v.tangent)
        .chain(v.uv.to_array())
    {
        if !f.is_finite() {
            return Err("non-finite source vertex".into());
        }
        out.extend(f.to_le_bytes());
    }
    out.extend(v.color);
    match layout {
        pc::VertexLayout::Baked => out.extend(v.light),
        pc::VertexLayout::Skinned => {
            out.extend(v.joints);
            out.extend(v.weights);
        }
        pc::VertexLayout::Static => {}
        pc::VertexLayout::Lights => return Err("surface vertex used for light field".into()),
    }
    Ok(())
}
pub(super) fn lower(source: &crate::source::Scene, meta: &mut pc::Meta) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for (src, d) in source.meta.draws.iter().zip(&mut meta.draws) {
        if d.layout == pc::VertexLayout::Lights {
            d.vertices = super::append(
                &mut out,
                pc::parts::slice(source.geometry(), &src.vertices)?,
                16,
            )?;
        } else {
            let vertices = source
                .blobs
                .meshes
                .get(src.vertices.offset as usize)
                .ok_or("missing source mesh")?;
            if vertices.len() != d.vertex_count as usize {
                return Err("source vertex count mismatch".into());
            }
            let mut bytes =
                Vec::with_capacity(vertices.len() * pc::ipod::stride(d.layout) as usize);
            for v in vertices {
                vertex(v, d.layout, &mut bytes)?;
            }
            d.vertices = super::append(&mut out, &bytes, 16)?;
            d.pos_offset = [0.0; 3];
            d.pos_scale = [1.0; 3];
            d.uv_offset = [0.0; 2];
            d.uv_scale = [1.0; 2];
        }
        let mut copy = |r: &mut pc::Range, count: u32| -> Result<()> {
            let bytes = pc::parts::slice(source.geometry(), r)?;
            if bytes.len() != count as usize * 2
                || count % 3 != 0
                || bytes
                    .chunks_exact(2)
                    .any(|b| u32::from(u16::from_le_bytes(b.try_into().unwrap())) >= d.vertex_count)
            {
                return Err("invalid source triangle indices".into());
            }
            *r = super::append(&mut out, bytes, 2)?;
            Ok(())
        };
        if d.layout != pc::VertexLayout::Lights {
            copy(&mut d.indices, d.index_count)?;
            for lod in &mut d.lods {
                copy(&mut lod.indices, lod.index_count)?;
            }
        }
    }
    Ok(out)
}
#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::{json, value::RawValue};

    #[test]
    fn source_float_attributes_and_weights_are_not_requantized() {
        let v = Vertex {
            pos: glam::Vec3::new(0.1234567, -12.500_007, 10000.0625),
            normal: glam::Vec3::new(0.12345, 0.45678, 0.98765),
            tangent: [-0.456789, 0.7654321, 0.0234567, -1.0],
            uv: glam::Vec2::new(-37.123_455, 0.062500015),
            color: [7, 29, 131, 253],
            joints: [0, 1, 5, 13],
            weights: [127, 63, 63, 2],
            light: [121, 37, 219, 57],
        };
        for layout in [
            pc::VertexLayout::Static,
            pc::VertexLayout::Baked,
            pc::VertexLayout::Skinned,
        ] {
            let mut bytes = Vec::new();
            vertex(&v, layout, &mut bytes).unwrap();
            assert_eq!(bytes.len(), pc::ipod::stride(layout) as usize);
            let floats: Vec<_> = v
                .pos
                .to_array()
                .into_iter()
                .chain(v.normal.to_array())
                .chain(v.tangent)
                .chain(v.uv.to_array())
                .collect();
            assert_eq!(
                &bytes[..48],
                floats
                    .into_iter()
                    .flat_map(f32::to_le_bytes)
                    .collect::<Vec<_>>()
            );
            assert_eq!(&bytes[48..52], &v.color);
            match layout {
                pc::VertexLayout::Baked => assert_eq!(&bytes[52..], &v.light),
                pc::VertexLayout::Skinned => {
                    assert_eq!(&bytes[52..], &[v.joints, v.weights].concat())
                }
                _ => {}
            }
        }
        let mut bad = v;
        bad.normal.x = f32::NAN;
        assert!(vertex(&bad, pc::VertexLayout::Static, &mut Vec::new()).is_err());
    }
    pub(crate) fn fixture() -> (pc::Meta, Vec<Box<RawValue>>, Vec<u8>) {
        let texture = super::super::tests::texture(pc::TexRole::Color, 512, 512);
        let mut m = super::super::tests::fixture(&texture);
        m["materials"] = json!([{
            "name":"baked", "kind":"standard", "blend":"opaque", "double_sided":false,
            "depth_write":true,"alpha_test":0,"color":[1,1,1,1],"emissive":[0,0,0],
            "roughness":1,"metalness":0,"normal_scale":1,"ao_strength":1,"env_strength":1,
            "albedo":0,"normal":null,"orm":null,"emission":null,"vertex_color":true,
            "interior":false,"fog":true,"wet":null,"damp":null,"drops":0,"clearcoat":0,
            "polygon_offset":null,"emissive_track":null
        }]);
        m["camera"]["intro"] = json!({"pos":[1,10,50],"target":[0,0,0],"fov":50});

        let mut geometry = Vec::new();
        let mut draws = Vec::new();
        for x in [1.0, 3.0] {
            let mut vertices = Vec::new();
            for (i, (px, py)) in [(-1., -1.), (1., -1.), (1., 1.), (-1., 1.)]
                .into_iter()
                .enumerate()
            {
                let v = Vertex {
                    pos: glam::Vec3::new(x + px, 1. + py, 1.),
                    normal: glam::Vec3::Y,
                    tangent: [1., 0., 0., 1.],
                    uv: glam::Vec2::new((px + 1.) * 0.5, (py + 1.) * 0.5),
                    color: [20 + i as u8, 21, 22, 23],
                    light: [255, 255, 255, 32],
                    ..Default::default()
                };
                vertex(&v, pc::VertexLayout::Baked, &mut vertices).unwrap();
            }
            let vr = super::super::append(&mut geometry, &vertices, 16).unwrap();
            let idx: Vec<_> = [0u16, 1, 2, 0, 2, 3]
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect();
            let ir = super::super::append(&mut geometry, &idx, 2).unwrap();
            let lr = super::super::append(&mut geometry, &idx[..6], 2).unwrap();
            let empty = super::super::append(&mut geometry, &[], 2).unwrap();
            draws.push(json!({"material":0,"layout":"baked","vertices":vr,"vertex_count":4,"indices":ir,"index_count":6,"pos_offset":[0,0,0],"pos_scale":[1,1,1],"uv_offset":[0,0],"uv_scale":[1,1],"min":[x-1.0,0,1],"max":[x+1.0,2,1],"node":null,"skin":null,"no_reflect":false,"cast_shadow":true,"lods":[{"indices":lr,"index_count":3,"error":0.06},{"indices":empty,"index_count":0,"error":0.25}]}));
        }
        m["draws"] = json!(draws);
        let raw = draws
            .iter()
            .map(|d| serde_json::value::to_raw_value(d).unwrap())
            .collect();
        (serde_json::from_value(m).unwrap(), raw, geometry)
    }
}
