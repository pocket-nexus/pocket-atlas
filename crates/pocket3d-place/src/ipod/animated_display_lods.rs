//! Versioned, explicitly approximate SGX animation/display index tiers.
//! Validation proves source identity, source-local vertices/components and
//! unchanged geometric boundaries. The measured error receipt is empirical:
//! it does not certify unsampled triangle interiors or continuous-time poses.
use crate::{content_hash::Fnv1a64, Draw, Meta, VertexLayout};
use alloc::{
    collections::{BTreeMap, BTreeSet},
    format,
    string::{String, ToString},
    vec,
    vec::Vec,
};
pub const VERSION: u32 = 1;
pub const SUBFRAMES: u32 = 2;
pub const MAX_SAMPLES: u32 = 4096;
pub const SPARSE_SAMPLES: usize = 64;
pub const DENSE_POSES: usize = 32;
pub const REPRESENTATIVE_POSES: usize = 8;
pub fn guarded_error(measured: f32) -> Option<f32> {
    if !measured.is_finite() || measured < 0. {
        return None;
    }
    let x = measured as f64 * 1.1 + 0.001;
    let mut y = x as f32;
    if (y as f64) < x {
        y = f32::from_bits(y.to_bits() + 1)
    }
    y.is_finite().then_some(y)
}
pub fn eligible(meta: &Meta, d: &Draw) -> bool {
    if d.layout != VertexLayout::Skinned
        || d.node.is_some()
        || d.skin.is_none()
        || d.vertex_count > 65535
        || !super::skin_lods::eligible(meta, d)
    {
        return false;
    }
    let Some(skin) = meta.skins.get(d.skin.unwrap() as usize) else {
        return false;
    };
    if skin.joints.is_empty()
        || skin.joints.len() > 256
        || meta.frames == 0
        || meta
            .frames
            .checked_mul(SUBFRAMES)
            .is_none_or(|n| n > MAX_SAMPLES)
    {
        return false;
    }
    // User-operated doors are not determined by the authored animation loop.
    if let Some(doors) = &meta.doors {
        for &joint in &skin.joints {
            let mut node = Some(joint);
            let mut left = meta.nodes.len();
            while let Some(i) = node {
                if i == doors.left || i == doors.right || left == 0 {
                    return false;
                }
                let Some(n) = meta.nodes.get(i as usize) else {
                    return false;
                };
                node = n.parent;
                left -= 1;
            }
        }
    }
    true
}
pub fn color_hash(bytes: &[u8]) -> String {
    let mut h = Fnv1a64::default();
    h.update(bytes);
    format!("{:016x}", h.finish())
}
pub fn source_hash(meta: &Meta, d: &Draw, g: &[u8], animation_hash: u64) -> Result<String, String> {
    let m = meta
        .materials
        .get(d.material as usize)
        .ok_or("animated LOD material")?;
    let mut h = Fnv1a64::default();
    h.update(
        &serde_json::to_vec(&(
            VERSION,
            d,
            m,
            &meta.post,
            &meta.atmosphere,
            &meta.lights,
            &meta.sun,
        ))
        .map_err(|e| e.to_string())?,
    );
    h.update(&animation_hash.to_le_bytes());
    h.update(crate::parts::slice(g, &d.vertices)?);
    h.update(crate::parts::slice(g, &d.indices)?);
    for l in &d.lods {
        h.update(crate::parts::slice(g, &l.indices)?);
    }
    Ok(format!("{:016x}", h.finish()))
}
pub fn dense_schedule(samples: u32, representatives: &[u32]) -> Vec<u32> {
    let step = (samples as usize).div_ceil(DENSE_POSES).max(1);
    (0..samples)
        .step_by(step)
        .chain(representatives.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
type Position = [u32; 3];
fn position(v: &[u8]) -> Result<Position, String> {
    let p = super::floats::<3>(v, 0)?;
    if p.iter().any(|x| !x.is_finite()) {
        return Err("animated LOD nonfinite vertex".into());
    }
    Ok(p.map(|x| if x == 0. { 0 } else { x.to_bits() }))
}
pub fn dense_weights(v: &[u8], bones: usize) -> Result<Vec<u8>, String> {
    if v.len() != 60 || bones == 0 || bones > 256 {
        return Err("animated LOD skin stride/palette".into());
    }
    let mut out = vec![0u8; bones];
    let mut sum = 0u16;
    for k in 0..4 {
        let j = v[52 + k] as usize;
        let w = v[56 + k];
        let p = out.get_mut(j).ok_or("animated LOD joint index")?;
        *p = p
            .checked_add(w)
            .ok_or("animated LOD duplicate weight overflow")?;
        sum += w as u16;
    }
    if sum != 255 {
        return Err("animated LOD weights must sum to 255".into());
    }
    Ok(out)
}
/// Cross-draw positions are locked even when the neighboring material is not
/// eligible. Identical joint-node and inverse-bind descriptors share a palette.
pub fn boundary_locks(meta: &Meta, g: &[u8], animation: &[u8]) -> Result<Vec<Vec<bool>>, String> {
    let mut keys = Vec::<Vec<u8>>::new();
    let mut palettes = Vec::new();
    for sk in &meta.skins {
        let mut key = serde_json::to_vec(&sk.joints).map_err(|e| e.to_string())?;
        key.extend(crate::parts::slice(animation, &sk.inverse_bind)?);
        let id = keys.iter().position(|k| *k == key).unwrap_or_else(|| {
            keys.push(key);
            keys.len() - 1
        });
        palettes.push(id);
    }
    let mut owners = BTreeMap::<(usize, Position), u32>::new();
    for (di, d) in meta.draws.iter().enumerate() {
        let Some(skin) = d.skin else { continue };
        let palette = *palettes
            .get(skin as usize)
            .ok_or("animated LOD skin index")?;
        if d.layout != VertexLayout::Skinned
            || d.vertices.size
                != d.vertex_count
                    .checked_mul(60)
                    .ok_or("animated LOD vertices overflow")?
        {
            return Err("animated LOD skin layout".into());
        }
        for v in crate::parts::slice(g, &d.vertices)?.chunks_exact(60) {
            let owner = owners.entry((palette, position(v)?)).or_insert(di as u32);
            if *owner != di as u32 {
                *owner = u32::MAX;
            }
        }
    }
    let mut result = vec![Vec::new(); meta.draws.len()];
    for (di, d) in meta.draws.iter().enumerate() {
        if !eligible(meta, d) {
            continue;
        }
        let palette = palettes[d.skin.unwrap() as usize];
        result[di] = crate::parts::slice(g, &d.vertices)?
            .chunks_exact(60)
            .map(|v| Ok(owners[&(palette, position(v)?)] == u32::MAX))
            .collect::<Result<_, String>>()?;
    }
    Ok(result)
}
fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i]
    }
    i
}
fn union(parent: &mut [usize], a: usize, b: usize) {
    let a = root(parent, a);
    let b = root(parent, b);
    parent[a] = b;
}
pub struct Topology {
    pub full: Vec<[u32; 3]>,
    pub locked: Vec<bool>,
    component: Vec<usize>,
    referenced: Vec<bool>,
    motions: Vec<usize>,
    required: BTreeSet<(usize, usize)>,
}
impl Topology {
    pub fn new(meta: &Meta, d: &Draw, g: &[u8], cross: &[bool]) -> Result<Self, String> {
        let count = d.vertex_count as usize;
        if cross.len() != count {
            return Err("animated LOD boundary length".into());
        }
        let bones = meta
            .skins
            .get(d.skin.ok_or("animated LOD skin")? as usize)
            .ok_or("animated LOD skin")?
            .joints
            .len();
        let full = super::display_lods::triangles(&d.indices, d.index_count, d.vertex_count, g)?;
        let data = crate::parts::slice(g, &d.vertices)?;
        if data.len()
            != count
                .checked_mul(60)
                .ok_or("animated LOD vertex overflow")?
        {
            return Err("animated LOD vertex stride".into());
        }
        let mut motions = Vec::with_capacity(count);
        let mut parent: Vec<_> = (0..count).collect();
        let mut coincident = BTreeMap::new();
        for (i, v) in data.chunks_exact(60).enumerate() {
            let p = position(v)?;
            let weights = dense_weights(v, bones)?;
            if let Some(&other) = coincident.get(&(p, weights.clone())) {
                union(&mut parent, i, other);
                motions.push(other)
            } else {
                coincident.insert((p, weights), i);
                motions.push(i);
            }
        }
        let mut referenced = vec![false; count];
        let mut edges = BTreeMap::<(usize, usize), usize>::new();
        for t in &full {
            union(&mut parent, t[0] as usize, t[1] as usize);
            union(&mut parent, t[0] as usize, t[2] as usize);
            for &i in t {
                referenced[i as usize] = true
            }
            for k in 0..3 {
                let a = motions[t[k] as usize];
                let b = motions[t[(k + 1) % 3] as usize];
                if a != b {
                    *edges.entry((a.min(b), a.max(b))).or_default() += 1;
                }
            }
        }
        let mut boundary = BTreeSet::new();
        for (&(a, b), &n) in &edges {
            if n != 2 {
                boundary.insert(a);
                boundary.insert(b);
            }
        }
        let locked: Vec<_> = motions
            .iter()
            .zip(cross)
            .map(|(p, &c)| c || boundary.contains(p))
            .collect();
        let mut required = BTreeSet::new();
        for t in &full {
            for k in 0..3 {
                let i = t[k] as usize;
                let j = t[(k + 1) % 3] as usize;
                let a = motions[i];
                let b = motions[j];
                if a != b && locked[i] && locked[j] {
                    required.insert((a.min(b), a.max(b)));
                }
            }
        }
        let component = (0..count).map(|i| root(&mut parent, i)).collect();
        Ok(Self {
            full,
            locked,
            component,
            referenced,
            motions,
            required,
        })
    }
    pub fn validate_level(&self, tris: &[[u32; 3]]) -> Result<(), String> {
        if tris.is_empty() || tris.len() >= self.full.len() {
            return Err("animated LOD must reduce a nonempty mesh".into());
        }
        let mut edges = BTreeSet::new();
        let mut components = BTreeSet::new();
        for t in tris {
            for &i in t {
                if !self.referenced.get(i as usize).copied().unwrap_or(false) {
                    return Err("animated LOD references unused/outside vertex".into());
                }
            }
            if self.component[t[0] as usize] != self.component[t[1] as usize]
                || self.component[t[0] as usize] != self.component[t[2] as usize]
            {
                return Err("animated LOD crosses source component".into());
            }
            components.insert(self.component[t[0] as usize]);
            for k in 0..3 {
                let a = self.motions[t[k] as usize];
                let b = self.motions[t[(k + 1) % 3] as usize];
                if a != b {
                    edges.insert((a.min(b), a.max(b)));
                }
            }
        }
        if components
            != self
                .full
                .iter()
                .map(|t| self.component[t[0] as usize])
                .collect()
        {
            return Err("animated LOD dropped a source component".into());
        }
        if !self.required.is_subset(&edges) {
            return Err("animated LOD changed open/cross-draw boundary".into());
        }
        Ok(())
    }
}
fn hex(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn validate(
    meta: &Meta,
    g: &[u8],
    animation: &[u8],
    recipe: &super::AnimatedDisplayLods,
) -> Result<(), String> {
    if recipe.version != VERSION || recipe.draws.is_empty() || recipe.draws.len() > meta.draws.len()
    {
        return Err("animated LOD recipe version/count".into());
    }
    let locks = boundary_locks(meta, g, animation)?;
    let ah = super::skin_lods::animation_hash(meta, animation)?;
    let mut previous = None;
    let mut supported_skins = BTreeSet::new();
    for entry in &recipe.draws {
        if previous.is_some_and(|p| entry.draw <= p) {
            return Err("animated LOD draws not unique/sorted".into());
        }
        previous = Some(entry.draw);
        let d = meta
            .draws
            .get(entry.draw as usize)
            .ok_or("animated LOD draw index")?;
        if !eligible(meta, d)
            || entry.levels.is_empty()
            || entry.levels.len() != entry.measurements.len()
            || entry.levels.len() > 8
        {
            return Err("animated LOD unsupported/count".into());
        }
        let skin = d.skin.unwrap();
        if supported_skins.insert(skin)
            && super::skin_lods::joint_bounds(meta, skin, animation)?.is_none()
        {
            return Err("animated LOD unsupported transform contract".into());
        }
        let samples = meta
            .frames
            .checked_mul(SUBFRAMES)
            .ok_or("animated LOD sample overflow")?;
        if entry.sample_count != samples
            || entry.representative_samples.is_empty()
            || entry.representative_samples.len() > REPRESENTATIVE_POSES
            || entry.dense_samples.is_empty()
            || entry.dense_samples.len() > DENSE_POSES + REPRESENTATIVE_POSES + 1
        {
            return Err("animated LOD sampling policy".into());
        }
        for list in [&entry.representative_samples, &entry.dense_samples] {
            if list.iter().any(|&i| i >= samples) || list.windows(2).any(|p| p[0] >= p[1]) {
                return Err("animated LOD sample order/range".into());
            }
        }
        let required = dense_schedule(samples, &entry.representative_samples);
        if entry.dense_samples != required {
            return Err("animated LOD incomplete dense sampling schedule".into());
        }
        if entry.source_hash != source_hash(meta, d, g, ah)?
            || entry.payload_hash != super::skin_lods::payload_hash(&entry.levels, g)?
            || !hex(&entry.colors_hash)
        {
            return Err("animated LOD source/color/payload identity".into());
        }
        let topology = Topology::new(meta, d, g, &locks[entry.draw as usize])?;
        let (mut count, mut error) = (d.index_count, 0f32);
        for (l, m) in entry.levels.iter().zip(&entry.measurements) {
            if !m.qem_error.is_finite()
                || m.qem_error < 0.
                || !m.dense_rms.is_finite()
                || m.dense_rms < 0.
                || m.dense_rms > m.sampled_max + 1e-6
                || m.samples < m.dense_point_samples
                || m.dense_point_samples == 0
                || m.samples == 0
                || guarded_error(m.sampled_max) != Some(l.error)
                || l.error <= error
                || l.index_count >= count
            {
                return Err("animated LOD measurement/error/count".into());
            }
            let triangles =
                super::display_lods::triangles(&l.indices, l.index_count, d.vertex_count, g)?;
            topology.validate_level(&triangles)?;
            let dense_n = entry.dense_samples.len() as u64;
            let dense_points =
                (d.vertex_count as u64 + d.index_count as u64 / 3 + l.index_count as u64 / 3)
                    * dense_n;
            let sparse_points = (d.vertex_count.min(SPARSE_SAMPLES as u32) as u64
                + (d.index_count / 3).min(SPARSE_SAMPLES as u32) as u64
                + (l.index_count / 3).min(SPARSE_SAMPLES as u32) as u64)
                * (samples as u64 - dense_n);
            if m.dense_point_samples != dense_points || m.samples != dense_points + sparse_points {
                return Err("animated LOD measurement sample counts".into());
            }
            count = l.index_count;
            error = l.error;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sampling_schedule_is_bounded_and_covers_the_loop() {
        for n in [2, 60, 64, 126, 3600] {
            let reps = [0, n - 1];
            let s = dense_schedule(n, &reps);
            assert!(s.len() <= DENSE_POSES + 2);
            assert_eq!(s.first(), Some(&0));
            assert_eq!(s.last(), Some(&(n - 1)));
            assert!(s.windows(2).all(|x| x[0] < x[1]));
        }
    }
    #[test]
    fn guarded_error_rounds_up_and_rejects_invalid_values() {
        for x in [0., 0.01, 1., 1e30] {
            assert!(guarded_error(x).unwrap() as f64 >= x as f64 * 1.1 + 0.001);
        }
        for x in [-1., f32::NAN, f32::INFINITY] {
            assert!(guarded_error(x).is_none());
        }
    }
}
