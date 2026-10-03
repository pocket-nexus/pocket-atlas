//! Full-mesh connected components for optional visibility/LOD sidecars.
//! Equal decoded positions join attribute seams. Only full-index vertices
//! participate; LOD membership must be checked separately by the caller.
use crate::{Draw, Range};
use alloc::{collections::BTreeMap, string::String, vec::Vec};

pub fn slice<'a>(bytes: &'a [u8], r: &Range) -> Result<&'a [u8], String> {
    let end = r.offset.checked_add(r.size).ok_or("part range overflow")?;
    bytes
        .get(r.offset as usize..end as usize)
        .ok_or_else(|| "part range outside geometry".into())
}

pub fn position(d: &Draw, geometry: &[u8], index: u16) -> Result<[f32; 3], String> {
    if u32::from(index) >= d.vertex_count {
        return Err("part index exceeds vertex count".into());
    }
    let vertices = slice(geometry, &d.vertices)?;
    let at = index as usize * d.layout.stride() as usize;
    let b = vertices
        .get(at..at + 6)
        .ok_or("part vertex outside range")?;
    let p = core::array::from_fn(|k| {
        let q = (i16::from_le_bytes([b[k * 2], b[k * 2 + 1]]) as f32 / 32767.).max(-1.);
        q * d.pos_scale[k] + d.pos_offset[k]
    });
    if p.iter().any(|x| !x.is_finite()) {
        return Err("non-finite part position".into());
    }
    Ok(p)
}

/// Unreferenced vertices are `u32::MAX`. Returned roots are vertex indices.
pub fn components(d: &Draw, geometry: &[u8]) -> Result<Vec<u32>, String> {
    if d.vertex_count > 65536
        || d.vertex_count.checked_mul(d.layout.stride()) != Some(d.vertices.size)
        || d.index_count.checked_mul(2) != Some(d.indices.size)
        || d.index_count % 3 != 0
    {
        return Err("invalid part source geometry".into());
    }
    slice(geometry, &d.vertices)?;
    let indices = slice(geometry, &d.indices)?;
    let mut parent = Vec::new();
    parent
        .try_reserve_exact(d.vertex_count as usize)
        .map_err(|_| "part allocation failed")?;
    parent.resize(d.vertex_count as usize, u32::MAX);
    fn root(p: &mut [u32], mut i: u32) -> u32 {
        while p[i as usize] != i {
            p[i as usize] = p[p[i as usize] as usize];
            i = p[i as usize];
        }
        i
    }
    fn join(p: &mut [u32], a: u32, b: u32) {
        let (a, b) = (root(p, a), root(p, b));
        p[a as usize] = b;
    }
    for tri in indices.chunks_exact(6) {
        let ids: [u32; 3] =
            core::array::from_fn(|k| u16::from_le_bytes([tri[k * 2], tri[k * 2 + 1]]) as u32);
        for i in ids {
            let p = parent
                .get_mut(i as usize)
                .ok_or("part index out of range")?;
            if *p == u32::MAX {
                *p = i;
            }
        }
        join(&mut parent, ids[0], ids[1]);
        join(&mut parent, ids[1], ids[2]);
    }
    let mut seams = BTreeMap::new();
    for i in 0..parent.len() {
        if parent[i] == u32::MAX {
            continue;
        }
        let key = position(d, geometry, i as u16)?.map(|v| if v == 0.0 { 0 } else { v.to_bits() });
        if let Some(&j) = seams.get(&key) {
            join(&mut parent, i as u32, j);
        } else {
            seams.insert(key, i as u32);
        }
    }
    for i in 0..parent.len() {
        if parent[i] != u32::MAX {
            parent[i] = root(&mut parent, i as u32);
        }
    }
    Ok(parent)
}
