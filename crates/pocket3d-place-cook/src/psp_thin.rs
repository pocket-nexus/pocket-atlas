//! Long, narrow parts on a 480 × 272 screen without antialiasing. The coarse
//! level drops whole parts narrower than its error and breaks the rest into
//! pieces, which takes a street's posts, poles, wires, rails and signal arms;
//! a part narrower than a pixel breaks into dashes on the GE. A narrow part
//! (middle extent under 30 cm, at least 1.5 m long) within 150 m of the
//! middle of the shots is drawn from the finest level that has it (farther,
//! it is under a pixel and stays as the coarse level has it), and one
//! narrower than a pixel and a half as seen from the middle of the shots is
//! widened along its normals to that, at most to 50 cm across: a line a
//! pixel wide still breaks where it slants.
use glam::Vec3;

const NARROW: f32 = 0.3;
const LONG: f32 = 1.5;
const WIDEN: f32 = 0.25;
const NEAR: f32 = 150.0;

pub(super) struct Selection {
    pub indices: Vec<u32>,
    /// Per source vertex: metres to move along its normal.
    pub widen: Vec<f32>,
    pub narrow_triangles: usize,
}

/// `pixel`: metres a pixel spans per metre of distance.
pub(super) fn select(draw: &crate::source::Draw, eye: Vec3, pixel: f32) -> Selection {
    let verts = draw.vertices();
    let full: Vec<[u32; 3]> = draw.indices().chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    let (roots, extents) = crate::geometry::part_extents(verts, &full);
    let mut nearest = std::collections::HashMap::<u32, f32>::new();
    for (v, &r) in verts.iter().zip(&roots) {
        let d = nearest.entry(r).or_insert(f32::MAX);
        *d = d.min((v.pos - eye).length());
    }
    let narrow = |v: u32| {
        let e = extents[v as usize];
        e[1] < NARROW && e[2] >= LONG && nearest[&roots[v as usize]] < NEAR
    };
    let levels = draw.lods();
    let coarse = levels.last().map_or(draw.indices(), |l| l.indices.as_slice());
    let finest = levels.first().map_or(draw.indices(), |l| l.indices.as_slice());
    let in_finest: std::collections::HashSet<u32> = finest.iter().map(|&i| roots[i as usize]).collect();
    let mut indices: Vec<u32> = coarse.chunks_exact(3).filter(|t| !narrow(t[0])).flatten().copied().collect();
    let before = indices.len();
    indices.extend(finest.chunks_exact(3).filter(|t| narrow(t[0])).flatten());
    indices.extend(
        draw.indices()
            .chunks_exact(3)
            .filter(|t| narrow(t[0]) && !in_finest.contains(&roots[t[0] as usize]))
            .flatten(),
    );
    let widen = verts
        .iter()
        .enumerate()
        .map(|(i, v)| {
            if !narrow(i as u32) {
                return 0.0;
            }
            let e = extents[i];
            ((1.5 * pixel * (v.pos - eye).length() - e[1]) * 0.5).clamp(0.0, WIDEN)
        })
        .collect();
    Selection { narrow_triangles: (indices.len() - before) / 3, indices, widen }
}
