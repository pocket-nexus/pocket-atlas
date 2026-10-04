//! Source-equivalent float pages for SGX light-field submission. The source
//! field boundaries remain authoritative for visibility and density weights.
use super::LightPages;
use crate::{Draw, Meta, VertexLayout};
use alloc::{
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};

pub const VERSION: u32 = 1;
pub const STRIDE: usize = 48;
pub const MAX_VERTICES: u32 = 65_535;

/// Only values consumed by the field program may determine compatibility.
/// Color, path, phase, blinking and appearance identity remain per vertex.
pub fn key(meta: &Meta, draw: &Draw) -> Result<Vec<u8>, String> {
    let material = meta
        .materials
        .get(draw.material as usize)
        .ok_or("light page material outside table")?;
    if draw.layout != VertexLayout::Lights
        || draw.node.is_some()
        || draw.skin.is_some()
        || material.kind != crate::Kind::Lights
        || material.lights.is_none()
        || draw.vertex_count == 0
        || draw.vertex_count > MAX_VERTICES
        || draw
            .vertex_count
            .checked_mul(crate::LIGHT_POINT_STRIDE as u32)
            != Some(draw.vertices.size)
        || draw
            .pos_scale
            .iter()
            .chain(&draw.pos_offset)
            .any(|x| !x.is_finite())
    {
        return Err("light page source is not a static light field".into());
    }
    let field = material.lights.unwrap();
    if [
        field.min_pixels,
        field.max_pixels,
        field.gain,
        field.depth_pull,
        field.period,
    ]
    .iter()
    .any(|x| !x.is_finite())
    {
        return Err("light page non-finite field parameters".into());
    }
    serde_json::to_vec(&(material.lights, material.fog)).map_err(|e| e.to_string())
}

/// Same ES2 signed-normalized decode used by the original field attribute.
/// ES 2.0 section 2.1.2 specifies (2*c+1)/(2^16-1), unlike ES3 SNORM.
/// Keep the source's explicit multiply/add order; phase caches stay separate.
pub fn vertex(source: &[u8], draw: &Draw) -> Result<[u8; STRIDE], String> {
    if source.len() != crate::LIGHT_POINT_STRIDE {
        return Err("light page source stride".into());
    }
    let mut out = [0; STRIDE];
    for axis in 0..4 {
        let packed = i16::from_le_bytes(source[axis * 2..axis * 2 + 2].try_into().unwrap());
        let value = (2 * packed as i32 + 1) as f32 / 65535.0;
        let value = if axis < 3 {
            value * draw.pos_scale[axis] + draw.pos_offset[axis]
        } else {
            value
        };
        if !value.is_finite() {
            return Err("light page non-finite position".into());
        }
        out[axis * 4..axis * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    out[16..].copy_from_slice(&source[8..]);
    Ok(out)
}

pub fn source_hash(meta: &Meta, geometry: &[u8]) -> Result<String, String> {
    let mut hash = crate::content_hash::Fnv1a64::default();
    hash.update(b"ipod-light-pages-v1");
    for (index, draw) in meta
        .draws
        .iter()
        .enumerate()
        .filter(|(_, d)| d.layout == VertexLayout::Lights)
    {
        let interpretation = serde_json::to_vec(&(index, draw)).map_err(|e| e.to_string())?;
        hash.update(&interpretation);
        hash.update(&key(meta, draw)?);
        hash.update(crate::parts::slice(geometry, &draw.vertices)?);
    }
    Ok(format!("{:016x}", hash.finish()))
}

pub fn payload_hash(payload: &[u8]) -> String {
    format!("{:016x}", crate::content_hash::hash(payload))
}

/// Validate before using the recipe. Hashes bind identity; byte comparison
/// independently proves that grouping did not alter any source point.
pub fn validate(
    meta: &Meta,
    geometry: &[u8],
    payload: &[u8],
    recipe: &LightPages,
) -> Result<(), String> {
    if recipe.version != VERSION
        || recipe.pages.is_empty()
        || recipe.source_hash != source_hash(meta, geometry)?
        || recipe.payload_hash != payload_hash(payload)
    {
        return Err("light page version or source/payload identity".into());
    }
    let mut seen = vec![false; meta.draws.len()];
    let mut end = 0usize;
    for page in &recipe.pages {
        if page.vertex_count == 0
            || page.vertex_count > MAX_VERTICES
            || page.fields.is_empty()
            || page.vertex_count.checked_mul(STRIDE as u32) != Some(page.vertices.size)
            || page.vertices.offset % 16 != 0
            || (page.vertices.offset as usize) != (end + 15) & !15
        {
            return Err("light page vertex range/count/alignment".into());
        }
        let bytes = crate::parts::slice(payload, &page.vertices)?;
        if payload[end..page.vertices.offset as usize]
            .iter()
            .any(|&b| b != 0)
        {
            return Err("light page nonzero alignment padding".into());
        }
        end = page.vertices.offset as usize + bytes.len();
        let mut count = 0u32;
        let mut group = None;
        let mut previous = None;
        for field in &page.fields {
            let index = field.draw as usize;
            let draw = meta
                .draws
                .get(index)
                .ok_or("light page source draw outside table")?;
            if seen[index] || field.first != count || previous.is_some_and(|p| p >= field.draw) {
                return Err("light page duplicate, unordered or noncontiguous field".into());
            }
            let field_key = key(meta, draw)?;
            if group.as_ref().is_some_and(|key| key != &field_key) {
                return Err("light page incompatible field parameters".into());
            }
            group = Some(field_key);
            previous = Some(field.draw);
            seen[index] = true;
            let next = count
                .checked_add(draw.vertex_count)
                .filter(|&n| n <= page.vertex_count)
                .ok_or("light page field exceeds vertices")?;
            let source = crate::parts::slice(geometry, &draw.vertices)?;
            for (original, actual) in source
                .chunks_exact(crate::LIGHT_POINT_STRIDE)
                .zip(bytes[count as usize * STRIDE..next as usize * STRIDE].chunks_exact(STRIDE))
            {
                if actual != vertex(original, draw)? {
                    return Err("light page vertex differs from source".into());
                }
            }
            count = next;
        }
        if count != page.vertex_count {
            return Err("light page incomplete vertex coverage".into());
        }
    }
    if end != payload.len()
        || meta
            .draws
            .iter()
            .enumerate()
            .any(|(i, d)| (d.layout == VertexLayout::Lights) != seen[i])
    {
        return Err("light page incomplete source/payload coverage".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_normalized_endpoints_and_nonposition_bytes_are_preserved() {
        let draw: Draw = serde_json::from_value(serde_json::json!({
            "material":0,"layout":"lights","vertices":{"offset":0,"size":40},"vertex_count":1,
            "indices":{"offset":0,"size":0},"index_count":1,"pos_offset":[12,-9,1],"pos_scale":[3,2,4],
            "uv_offset":[0,0],"uv_scale":[1,1],"min":[0,0,0],"max":[1,1,1],
            "no_reflect":false,"cast_shadow":false
        })).unwrap();
        let mut source = [0; 40];
        for (i, x) in [i16::MIN, -32767, 32767, 15843].into_iter().enumerate() {
            source[i * 2..i * 2 + 2].copy_from_slice(&x.to_le_bytes());
        }
        for i in 8..40 {
            source[i] = (i * 7) as u8;
        }
        let converted = vertex(&source, &draw).unwrap();
        let f = |i: usize| f32::from_le_bytes(converted[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!(
            [f(0), f(1), f(2), f(3)],
            [9., -65533. / 65535. * 2. - 9., 5., 31687. / 65535.]
        );
        assert_eq!(&converted[16..], &source[8..]);
        assert!(vertex(&source[..39], &draw).is_err());
        let mut invalid = draw;
        invalid.pos_scale[0] = f32::INFINITY;
        assert!(vertex(&source, &invalid).is_err());
    }
}
