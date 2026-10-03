//! Exact topology proof for the normal-independent Products display shader.
//! It keeps one orientation of each reversed triangle pair; drawing that
//! orientation with culling disabled preserves the two-sided surface.
use alloc::{collections::BTreeMap, string::String, vec::Vec};

const STRIDE: usize = 24;
type Triangle = [u32; 3];

fn cyclic(t: Triangle) -> Triangle {
    t.min([t[1], t[2], t[0]]).min([t[2], t[0], t[1]])
}

/// `vertices` is one draw's final float3 position, float2 UV, RGBA8 display
/// stream. Indices are source-local, not display-page absolute. Matching uses
/// all 24 bytes, so mirrored UVs or different colors cannot disappear.
///
/// Some contains one original triangle per exact reversed pair, in first
/// occurrence order. None means the whole level must retain its original
/// indices. Degenerate geometry and unpaired triangles never partially lower.
/// Structural invalidity returns Err. This function does not establish shader
/// eligibility or the required cull=false state; those are caller contracts.
pub fn two_sided_indices(vertices: &[u8], indices: &[u16]) -> Result<Option<Vec<u16>>, String> {
    if vertices.len() % STRIDE != 0 || indices.len() % 3 != 0 {
        return Err("display triangle stride".into());
    }
    let count = vertices.len() / STRIDE;
    if count > 65535 {
        return Err("display triangle vertex limit".into());
    }
    let mut unique = BTreeMap::<[u8; STRIDE], u32>::new();
    let mut pending = BTreeMap::<Triangle, Vec<(usize, [u16; 3])>>::new();
    let mut selected = Vec::new();
    let mut degenerate = false;
    for (ordinal, tri) in indices.chunks_exact(3).enumerate() {
        let tri: [u16; 3] = tri.try_into().unwrap();
        let mut ids = [0; 3];
        let mut positions = [[0.0f64; 3]; 3];
        for k in 0..3 {
            let index = tri[k] as usize;
            if index >= count {
                return Err("display triangle index outside vertices".into());
            }
            let vertex = &vertices[index * STRIDE..(index + 1) * STRIDE];
            let floats = super::floats::<5>(vertex, 0)?;
            positions[k] = core::array::from_fn(|c| floats[c] as f64);
            let next = unique.len() as u32;
            ids[k] = *unique.entry(vertex.try_into().unwrap()).or_insert(next);
        }
        let a: [f64; 3] = core::array::from_fn(|k| positions[1][k] - positions[0][k]);
        let b: [f64; 3] = core::array::from_fn(|k| positions[2][k] - positions[0][k]);
        // f64 avoids an overflow/underflow-dependent eligibility decision for
        // finite source f32 positions. A zero-area pair must not be optimized.
        if a[1] * b[2] == a[2] * b[1] && a[2] * b[0] == a[0] * b[2] && a[0] * b[1] == a[1] * b[0] {
            degenerate = true;
        }
        let reversed = cyclic([ids[0], ids[2], ids[1]]);
        let matched = pending.get_mut(&reversed).and_then(Vec::pop);
        if let Some(first) = matched {
            selected.push(first);
        } else {
            pending.entry(cyclic(ids)).or_default().push((ordinal, tri));
        }
    }
    if indices.is_empty() || degenerate || pending.values().any(|v| !v.is_empty()) {
        return Ok(None);
    }
    selected.sort_unstable_by_key(|(ordinal, _)| *ordinal);
    Ok(Some(selected.into_iter().flat_map(|(_, t)| t).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    fn card() -> Vec<u8> {
        let mut vertices = Vec::new();
        for _ in 0..2 {
            for [x, y] in [[0.0f32, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]] {
                for f in [x, y, 0.0, x, y] {
                    vertices.extend(f.to_le_bytes());
                }
                vertices.extend([255, 128, 64, 255]);
            }
        }
        vertices
    }
    const CARD: [u16; 12] = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6];

    #[test]
    fn reversed_attributes_preserve_one_original_triangle_per_pair() {
        let vertices = card();
        assert_eq!(
            two_sided_indices(&vertices, &CARD).unwrap(),
            Some(vec![0, 1, 2, 0, 2, 3])
        );
        // Cyclic permutations and back-first order remain exact.
        let rotated = [6, 5, 4, 7, 6, 4, 1, 2, 0, 2, 3, 0];
        assert_eq!(
            two_sided_indices(&vertices, &rotated).unwrap(),
            Some(rotated[..6].to_vec())
        );
        let double: Vec<_> = CARD.into_iter().chain(CARD).collect();
        assert_eq!(
            two_sided_indices(&vertices, &double)
                .unwrap()
                .unwrap()
                .len(),
            12
        );
    }
    #[test]
    fn uv_color_position_winding_and_degeneracy_retain_whole_level() {
        for offset in [0, 12, 20, 23] {
            let mut vertices = card();
            vertices[4 * STRIDE + offset] ^= 1;
            assert!(
                two_sided_indices(&vertices, &CARD).unwrap().is_none(),
                "attribute {offset}"
            );
        }
        assert!(two_sided_indices(&card(), &CARD[..9]).unwrap().is_none());
        assert!(two_sided_indices(&card(), &[0, 1, 2, 4, 5, 6])
            .unwrap()
            .is_none());
        assert!(two_sided_indices(&card(), &[0, 0, 2, 4, 6, 4])
            .unwrap()
            .is_none());
        let mut collinear = card();
        for i in 0..8 {
            collinear[i * STRIDE + 4..i * STRIDE + 8].fill(0);
        }
        assert!(two_sided_indices(&collinear, &CARD).unwrap().is_none());
    }
    #[test]
    fn malformed_streams_are_errors_even_after_an_unpaired_triangle() {
        assert!(two_sided_indices(&card()[..191], &CARD).is_err());
        assert!(two_sided_indices(&card(), &CARD[..11]).is_err());
        assert!(two_sided_indices(&card(), &[0, 1, 2, 0, 8, 2]).is_err());
        let mut vertices = card();
        vertices[7 * STRIDE + 16..7 * STRIDE + 20].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(two_sided_indices(&vertices, &CARD).is_err());
    }
}
