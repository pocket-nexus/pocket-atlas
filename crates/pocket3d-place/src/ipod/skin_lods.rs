//! Index-only SGX skin LOD contract. A region with identical joint/weight
//! bytes has one common affine transform at every instant. Its translation
//! cancels from position differences; a conservative linear norm converts the
//! existing simplifier's bind-space error into a world-space error bound.
//! Mixed-influence triangles and all attribute/influence seams remain locked.
use crate::{content_hash::Fnv1a64, Draw, Meta, Range, VertexLayout};
use alloc::{
    collections::{BTreeMap, BTreeSet},
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};
#[cfg(not(feature = "std"))]
use num_traits::Float;

pub const VERSION: u32 = 1;
pub fn eligible(meta: &Meta, draw: &Draw) -> bool {
    draw.pos_offset == [0.0; 3]
        && draw.pos_scale == [1.0; 3]
        && meta.materials.get(draw.material as usize).is_some_and(|m| {
            m.kind == crate::Kind::Standard
                && m.blend == crate::Blend::Opaque
                && m.depth_write
                && m.alpha_test == 0.0
                && m.wet.is_none()
                && !m.vertex_pbr
                && m.emissive_track.is_none()
        })
}
// This guards f32 quaternion normalization and matrix construction. It does
// not turn meshoptimizer's measured quadric error into a Hausdorff guarantee.
const ROUNDING: f64 = 1.0 + 32.0 * f32::EPSILON as f64;

fn finite(values: &[f32]) -> bool {
    values.iter().all(|v| v.is_finite())
}
fn upward(value: f64) -> Option<f32> {
    if !value.is_finite() || value <= 0.0 || value > f32::MAX as f64 {
        return None;
    }
    let f = value as f32;
    Some(if (f as f64) < value {
        f32::from_bits(f.to_bits() + 1)
    } else {
        f
    })
}
fn rotation_bound(q: [f32; 4], normalized: bool) -> Option<f64> {
    if !finite(&q) {
        return None;
    }
    let norm: f64 = q.iter().map(|&v| (v as f64).powi(2)).sum();
    if (norm - 1.0).abs() > 0.00001 {
        return None;
    }
    // For a raw quaternion R = I + 2w[v]x + 2[v]x², the largest
    // singular value is <= max(1, abs(2*|q|²-1)). Animated nlerp
    // explicitly normalizes, including the final-to-first loop interval.
    Some(if normalized {
        ROUNDING
    } else {
        (2.0 * norm - 1.0).abs().max(1.0) * ROUNDING
    })
}

/// Per-joint bounds over the *whole* animation, not selected pose samples.
/// The runtime contract is fixed TRS scale and shortest-path normalized lerp
/// of quaternion tracks. Non-unit/zero quaternions, singular scale, projective
/// or sheared inverse binds are unsupported and retain full geometry.
/// Nested nonuniform TRS may create world shear: products of operator bounds
/// still conservatively cover it. Arbitrary inverse-bind shear is rejected.
pub fn joint_bounds(meta: &Meta, skin: u32, animation: &[u8]) -> Result<Option<Vec<f32>>, String> {
    let skin = meta
        .skins
        .get(skin as usize)
        .ok_or("skin LOD palette index")?;
    let bytes = crate::parts::slice(animation, &skin.inverse_bind)?;
    if bytes.len()
        != skin
            .joints
            .len()
            .checked_mul(64)
            .ok_or("skin LOD inverse-bind overflow")?
    {
        return Err("skin LOD inverse-bind length".into());
    }
    let mut bounds = Vec::with_capacity(skin.joints.len());
    let mut local_bounds = vec![None; meta.nodes.len()];
    for (&joint, matrix) in skin.joints.iter().zip(bytes.chunks_exact(64)) {
        let m = super::floats::<16>(matrix, 0)?;
        if !finite(&m) || m[3] != 0.0 || m[7] != 0.0 || m[11] != 0.0 || m[15] != 1.0 {
            return Ok(None);
        }
        let mut gram = [[0.0f64; 3]; 3];
        for a in 0..3 {
            for b in 0..3 {
                gram[a][b] = (0..3)
                    .map(|r| m[a * 4 + r] as f64 * m[b * 4 + r] as f64)
                    .sum();
            }
        }
        for a in 0..3 {
            if gram[a][a] <= 1e-20 {
                return Ok(None);
            }
            for b in 0..a {
                if gram[a][b].abs() > 1e-6 * (gram[a][a] * gram[b][b]).sqrt() {
                    return Ok(None);
                }
            }
        }
        // Absolute row-sum of AᵀA bounds its largest eigenvalue. This
        // includes small representational non-orthogonality in an inverse bind.
        let mut bound = gram
            .iter()
            .map(|row| row.iter().map(|v| v.abs()).sum::<f64>())
            .fold(0.0, f64::max)
            .sqrt()
            * ROUNDING;
        let mut current = Some(joint);
        let mut traversed = 0;
        while let Some(index) = current {
            traversed += 1;
            if traversed > meta.nodes.len() {
                return Err("skin LOD node cycle".into());
            }
            let n = meta
                .nodes
                .get(index as usize)
                .ok_or("skin LOD joint/ancestor index")?;
            let local = if let Some(local) = local_bounds[index as usize] {
                local
            } else {
                if !finite(&n.translation)
                    || !finite(&n.scale)
                    || n.scale.iter().any(|v| v.abs() <= 1e-10)
                {
                    return Ok(None);
                }
                let Some(mut rotation) = rotation_bound(n.rotation, false) else {
                    return Ok(None);
                };
                if let Some(range) = &n.track {
                    let track = crate::parts::slice(animation, range)?;
                    if track.len()
                        != (meta.frames as usize)
                            .checked_mul(28)
                            .ok_or("skin LOD track overflow")?
                        || track.is_empty()
                    {
                        return Err("skin LOD track length".into());
                    }
                    for key in track.chunks_exact(28) {
                        let v = super::floats::<7>(key, 0)?;
                        if !finite(&v) || rotation_bound(v[3..].try_into().unwrap(), true).is_none()
                        {
                            return Ok(None);
                        }
                    }
                    rotation = ROUNDING;
                }
                let local = n.scale.iter().map(|v| v.abs() as f64).fold(0.0, f64::max)
                    * rotation
                    * ROUNDING;
                local_bounds[index as usize] = Some(local);
                local
            };
            bound *= local;
            current = n.parent;
        }
        let Some(bound) = upward(bound) else {
            return Ok(None);
        };
        bounds.push(bound);
    }
    Ok(Some(bounds))
}

/// Compute once per pack. Both interpretation and all original animation
/// bytes are bound, including inverse binds, scales and hierarchy/loop timing.
pub fn animation_hash(meta: &Meta, animation: &[u8]) -> Result<u64, String> {
    let descriptor = serde_json::to_vec(&(
        VERSION,
        &meta.nodes,
        &meta.skins,
        meta.frames,
        meta.fps,
        &meta.doors,
    ))
    .map_err(|e| e.to_string())?;
    let mut hash = Fnv1a64::default();
    hash.update(&descriptor);
    hash.update(animation);
    Ok(hash.finish())
}
pub fn source_hash(draw: &Draw, geometry: &[u8], animation: u64) -> Result<String, String> {
    let mut hash = Fnv1a64::default();
    hash.update(&animation.to_le_bytes());
    hash.update(&serde_json::to_vec(draw).map_err(|e| e.to_string())?);
    hash.update(crate::parts::slice(geometry, &draw.vertices)?);
    hash.update(crate::parts::slice(geometry, &draw.indices)?);
    Ok(format!("{:016x}", hash.finish()))
}
pub fn payload_hash(levels: &[crate::DrawLod], geometry: &[u8]) -> Result<String, String> {
    let mut hash = Fnv1a64::default();
    for level in levels {
        hash.update(crate::parts::slice(geometry, &level.indices)?);
    }
    Ok(format!("{:016x}", hash.finish()))
}
pub fn indices(
    range: &Range,
    count: u32,
    vertices: u32,
    geometry: &[u8],
) -> Result<Vec<[u32; 3]>, String> {
    if range.offset % 2 != 0
        || count == 0
        || count % 3 != 0
        || u64::from(range.size) != u64::from(count) * 2
    {
        return Err("skin LOD triangle range/count".into());
    }
    crate::parts::slice(geometry, range)?
        .chunks_exact(6)
        .map(|triangle| {
            let tri = core::array::from_fn(|i| {
                u16::from_le_bytes([triangle[i * 2], triangle[i * 2 + 1]]) as u32
            });
            if tri.iter().any(|&i| i >= vertices) {
                Err("skin LOD local index".into())
            } else {
                Ok(tri)
            }
        })
        .collect()
}
fn canonical(t: [u32; 3]) -> [u32; 3] {
    t.min([t[1], t[2], t[0]]).min([t[2], t[0], t[1]])
}

/// Shared structural proof and the compiler's exact lock mask. All vertices
/// are original source records: this recipe never interpolates joint weights.
pub struct Topology {
    pub influences: Vec<[u8; 8]>,
    pub locked: Vec<bool>,
    pub full: Vec<[u32; 3]>,
    seams: Vec<bool>,
    preserved: BTreeMap<[u32; 3], usize>,
    seam_edges: BTreeMap<[u32; 2], usize>,
}
impl Topology {
    pub fn new(draw: &Draw, geometry: &[u8]) -> Result<Self, String> {
        if draw.layout != VertexLayout::Skinned
            || draw.skin.is_none()
            || !draw.lods.is_empty()
            || draw.vertex_count > 65535
            || draw.vertices.offset % 4 != 0
            || u64::from(draw.vertices.size) != u64::from(draw.vertex_count) * 60
        {
            return Err("skin LOD source layout".into());
        }
        let vertices = crate::parts::slice(geometry, &draw.vertices)?;
        if vertices.chunks_exact(60).any(|v| v[51] != vertices[51]) {
            return Err("skin LOD varying coverage alpha".into());
        }
        let full = indices(&draw.indices, draw.index_count, draw.vertex_count, geometry)?;
        let influences: Vec<[u8; 8]> = vertices
            .chunks_exact(60)
            .map(|v| v[52..60].try_into().unwrap())
            .collect();
        if influences
            .iter()
            .any(|v| v[4..].iter().map(|&v| u32::from(v)).sum::<u32>() != 255)
        {
            return Err("skin LOD weights must sum to 255".into());
        }
        let mut locked = vec![false; draw.vertex_count as usize];
        let mut seams = vec![false; draw.vertex_count as usize];
        let mut positions = BTreeMap::<[u32; 3], Vec<usize>>::new();
        for (i, v) in vertices.chunks_exact(60).enumerate() {
            let p = super::floats::<3>(v, 0)?;
            if !finite(&p) {
                return Err("skin LOD position is non-finite".into());
            }
            positions
                .entry(p.map(|x| if x == 0.0 { 0 } else { x.to_bits() }))
                .or_default()
                .push(i);
        }
        for ids in positions.values() {
            if ids.iter().any(|&i| {
                vertices[i * 60 + 12..i * 60 + 60] != vertices[ids[0] * 60 + 12..ids[0] * 60 + 60]
            }) {
                for &i in ids {
                    seams[i] = true;
                }
            }
        }
        // A positional simplifier can weld coincident chart aliases even
        // when their indices are locked (notably a sphere's UV poles).
        // Preserve every incident triangle, including source degenerates,
        // instead of weakening the source-attribute seam proof.
        let mut preserved = BTreeMap::new();
        for &tri in &full {
            if tri.iter().any(|&i| {
                seams[i as usize] || influences[i as usize] != influences[tri[0] as usize]
            }) {
                *preserved.entry(canonical(tri)).or_default() += 1;
                for i in tri {
                    locked[i as usize] = true;
                }
            }
        }
        // A draw may end at a material/chunk boundary represented in another
        // draw. Lock all open/non-manifold source edges; no cross-draw seam
        // database or material assumptions are needed to keep it sealed.
        let mut incidence = BTreeMap::<[u32; 2], usize>::new();
        for &tri in &full {
            for [a, b] in [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]] {
                *incidence.entry([a.min(b), a.max(b)]).or_default() += 1;
            }
        }
        for (edge, count) in incidence {
            if count != 2 {
                for i in edge {
                    locked[i as usize] = true;
                }
            }
        }
        let mut seam_edges = BTreeMap::new();
        for &tri in &full {
            for e in [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]] {
                if locked[e[0] as usize] && locked[e[1] as usize] {
                    *seam_edges.entry(e).or_default() += 1;
                }
            }
        }
        Ok(Self {
            influences,
            locked,
            full,
            seams,
            preserved,
            seam_edges,
        })
    }
    pub fn preserve(&self, triangle: [u32; 3]) -> bool {
        triangle.iter().any(|&i| {
            self.seams[i as usize]
                || self.influences[i as usize] != self.influences[triangle[0] as usize]
        })
    }
    pub fn affine_bound(&self, joints: &[f32]) -> Result<f32, String> {
        let mut max = 0.0f64;
        for tuple in &self.influences {
            let mut value = 0.0;
            for i in 0..4 {
                if tuple[i + 4] != 0 {
                    value += f64::from(
                        *joints
                            .get(tuple[i] as usize)
                            .ok_or("skin LOD vertex joint")?,
                    ) * f64::from(tuple[i + 4])
                        / 255.0;
                }
            }
            max = max.max(value);
        }
        upward(max * ROUNDING).ok_or_else(|| "skin LOD affine bound is invalid".into())
    }
    pub fn validate_level(&self, triangles: &[[u32; 3]]) -> Result<(), String> {
        let mut preserved = BTreeMap::new();
        let mut edges = BTreeMap::new();
        let mut used = BTreeSet::new();
        for &tri in triangles {
            if tri.iter().any(|&i| i as usize >= self.influences.len()) {
                return Err("skin LOD local index".into());
            }
            if self.preserve(tri) {
                *preserved.entry(canonical(tri)).or_default() += 1;
            }
            used.extend(tri);
            for e in [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]] {
                if self.locked[e[0] as usize] && self.locked[e[1] as usize] {
                    *edges.entry(e).or_default() += 1;
                }
            }
        }
        if preserved != self.preserved {
            return Err("skin LOD changed an influence/seam triangle".into());
        }
        if self
            .locked
            .iter()
            .enumerate()
            .any(|(i, &lock)| lock && !used.contains(&(i as u32)))
            || self
                .seam_edges
                .iter()
                .any(|(e, count)| edges.get(e) != Some(count))
        {
            return Err("skin LOD changed an attribute/influence seam".into());
        }
        Ok(())
    }
}

/// Verify this optional recipe before runtime selection. The
/// caller still performs ordinary META/GEOM/ANIM validation. Source proofs use
/// the original draw ranges, regardless of the recipe being present.
pub fn validate(
    meta: &Meta,
    geometry: &[u8],
    animation: &[u8],
    recipe: &super::SkinLods,
) -> Result<(), String> {
    if recipe.version != VERSION || recipe.draws.is_empty() {
        return Err("skin LOD recipe version/empty draws".into());
    }
    let animation = animation_hash(meta, animation).map(|hash| (animation, hash))?;
    let mut end = 0;
    for d in &meta.draws {
        for range in core::iter::once(&d.vertices)
            .chain(core::iter::once(&d.indices))
            .chain(d.lods.iter().map(|l| &l.indices))
        {
            end = end.max(
                range
                    .offset
                    .checked_add(range.size)
                    .ok_or("skin LOD source range overflow")?,
            );
        }
    }
    let mut prior_draw = None;
    let mut palettes = BTreeMap::new();
    for entry in &recipe.draws {
        if prior_draw.is_some_and(|i| i >= entry.draw) {
            return Err("skin LOD draw order".into());
        }
        prior_draw = Some(entry.draw);
        let draw = meta
            .draws
            .get(entry.draw as usize)
            .ok_or("skin LOD draw index")?;
        if !eligible(meta, draw) {
            return Err("skin LOD unsupported material".into());
        }
        let topology = Topology::new(draw, geometry)?;
        let skin = draw.skin.unwrap();
        if !palettes.contains_key(&skin) {
            palettes.insert(
                skin,
                joint_bounds(meta, skin, animation.0)?
                    .ok_or("unsupported skin LOD animation transform")?,
            );
        }
        if entry.affine_bound.to_bits() != topology.affine_bound(&palettes[&skin])?.to_bits()
            || entry.source_hash != source_hash(draw, geometry, animation.1)?
            || entry.payload_hash != payload_hash(&entry.levels, geometry)?
        {
            return Err("skin LOD source/payload/affine identity".into());
        }
        if entry.levels.is_empty() {
            return Err("skin LOD empty levels".into());
        }
        let (mut count, mut error) = (draw.index_count, 0.0);
        for level in &entry.levels {
            if !level.error.is_finite()
                || level.error <= error
                || level.index_count >= count
                || level.indices.offset < end
            {
                return Err("skin LOD range/order/error".into());
            }
            end = level
                .indices
                .offset
                .checked_add(level.indices.size)
                .ok_or("skin LOD range overflow")?;
            topology.validate_level(&indices(
                &level.indices,
                level.index_count,
                draw.vertex_count,
                geometry,
            )?)?;
            count = level.index_count;
            error = level.error;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Meta, Vec<u8>) {
        let mut meta:Meta=serde_json::from_value(serde_json::json!({
            "version":1,"name":"skin proof","kind":"night-street","min":[0,0,0],"max":[1,1,1],
            "textures":[],"materials":[],"draws":[],"nodes":[],"skins":[],"lights":[],"fog_lights":[],"fog_tracks":[],"material_tracks":[],"fps":30,"frames":2,
            "atmosphere":{"fog_color":[0,0,0],"fog_density":0,"haze_density":0,"haze_ambient":[0,0,0],"haze_ambient_density":0,"dry_min":[0,0,0],"dry_max":[0,0,0],"hemisphere_sky":[0,0,0],"hemisphere_ground":[0,0,0],"sky_zenith":[0,0,0],"sky_horizon":[0,0,0],"sky_glow":[0,0,0],"environment":null,"environment_strength":1},
            "rain":{"active":false,"dry_boxes":[],"drip_edges":[],"steam_vents":[]},"camera":{"shots":[],"walkable":[],"intro":{"pos":[0,1,2],"target":[0,1,0],"fov":40}},"doors":null,"beacons":[],"stats":{}
        })).unwrap();
        let mut animation = Vec::new();
        for scale in [[1., 1., 1.], [0.5, 1., 2.]] {
            for x in [
                scale[0], 0., 0., 0., 0., scale[1], 0., 0., 0., 0., scale[2], 0., 0., 0., 0., 1.,
            ] {
                animation.extend((x as f32).to_le_bytes());
            }
        }
        for v in [
            0f32, 0., 0., 0., 0., 0., 1., 100., -30., 17., 0., 0.70710677, 0., 0.70710677,
        ] {
            animation.extend(v.to_le_bytes());
        }
        for i in 0..2 {
            meta.nodes.push(crate::Node {
                name: format!("joint{i}"),
                parent: if i == 1 { Some(0) } else { None },
                translation: [0.; 3],
                rotation: [0., 0., 0., 1.],
                scale: [1.; 3],
                track: Some(Range {
                    offset: 128,
                    size: 56,
                }),
            });
        }
        meta.skins.push(crate::Skin {
            joints: vec![0, 1],
            inverse_bind: Range {
                offset: 0,
                size: 128,
            },
        });
        (meta, animation)
    }
    fn rotate(mut q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
        let len = q.iter().map(|x| x * x).sum::<f64>().sqrt();
        for x in &mut q {
            *x /= len;
        }
        let [x, y, z, w] = q;
        let [a, b, c] = v;
        [
            (1. - 2. * (y * y + z * z)) * a + 2. * (x * y - w * z) * b + 2. * (x * z + w * y) * c,
            2. * (x * y + w * z) * a + (1. - 2. * (x * x + z * z)) * b + 2. * (y * z - w * x) * c,
            2. * (x * z - w * y) * a + 2. * (y * z + w * x) * b + (1. - 2. * (x * x + y * y)) * c,
        ]
    }
    #[test]
    fn bound_covers_two_joint_scaled_hierarchies_and_every_loop_interval() {
        for scales in [
            [[1., 1., 1.], [1., 1., 1.]],
            [[2., 0.75, -1.], [0.5, 3., 1.5]],
        ] {
            let (mut meta, animation) = fixture();
            for (n, s) in meta.nodes.iter_mut().zip(scales) {
                n.scale = s;
            }
            let bounds = joint_bounds(&meta, 0, &animation).unwrap().unwrap();
            let bound = (bounds[0] as f64 * 128. + bounds[1] as f64 * 127.) / 255.;
            for reverse in [false, true] {
                for step in 0..=100 {
                    let mut t = step as f64 / 100.;
                    if reverse {
                        t = 1. - t;
                    }
                    let q = [0., t * 0.70710677, 0., 1. - t + t * 0.70710677];
                    for delta in [
                        [0.01, 0., 0.],
                        [0., 0.01, 0.],
                        [0., 0., 0.01],
                        [0.003, -0.009, 0.002],
                    ] {
                        let local_len = delta.iter().map(|v| v * v).sum::<f64>().sqrt();
                        let a = rotate(q, core::array::from_fn(|i| delta[i] * scales[0][i] as f64));
                        let b = rotate(
                            q,
                            core::array::from_fn(|i| {
                                delta[i] * [0.5, 1., 2.][i] * scales[1][i] as f64
                            }),
                        );
                        let b = rotate(q, core::array::from_fn(|i| b[i] * scales[0][i] as f64));
                        let actual = (0..3)
                            .map(|i| ((a[i] * 128. + b[i] * 127.) / 255.).powi(2))
                            .sum::<f64>()
                            .sqrt();
                        assert!(
                            actual <= local_len * bound,
                            "{actual} > {}",
                            local_len * bound
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn unsupported_transforms_fall_back_and_animation_identity_binds_semantics() {
        let (meta, animation) = fixture();
        let hash = animation_hash(&meta, &animation).unwrap();
        let mut bad = animation.clone();
        bad[4 * 4..5 * 4].copy_from_slice(&0.4f32.to_le_bytes());
        assert!(joint_bounds(&meta, 0, &bad).unwrap().is_none(), "IB shear");
        let mut bad = animation.clone();
        bad[128 + 6 * 4..128 + 7 * 4].copy_from_slice(&0f32.to_le_bytes());
        assert!(
            joint_bounds(&meta, 0, &bad).unwrap().is_none(),
            "zero quaternion"
        );
        let mut bad = meta.clone();
        bad.nodes[0].scale[1] = f32::NAN;
        assert!(joint_bounds(&bad, 0, &animation).unwrap().is_none());
        let mut changed = meta.clone();
        changed.nodes[1].scale[1] = 2.;
        assert_ne!(hash, animation_hash(&changed, &animation).unwrap());
        changed = meta.clone();
        changed.fps = 60.;
        assert_ne!(hash, animation_hash(&changed, &animation).unwrap());
        let mut changed = animation.clone();
        changed[128..132].copy_from_slice(&1f32.to_le_bytes());
        assert_ne!(hash, animation_hash(&meta, &changed).unwrap());
        let mut bad = meta;
        bad.nodes[0].parent = Some(1);
        assert!(joint_bounds(&bad, 0, &animation).is_err());
    }
}
