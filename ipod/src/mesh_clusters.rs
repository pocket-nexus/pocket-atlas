//! Optional original-LOD selection per complete connected-part group.
//! IPCL v3: 56-byte header, draw pairs, 32-byte groups, 12-byte levels,
//! 56-byte clusters and u16 indices. Version 2's 32-byte clusters remain
//! readable with facing rejection disabled. No PLIP geometry/error is replaced.
extern crate alloc;
use self::alloc::{string::String, sync::Arc, vec::Vec};
use pocket3d_place as pc;
const HEADER: usize = 56;
pub fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    })
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or("truncated clusters")?
            .try_into()
            .unwrap(),
    ))
}
fn u64_at(bytes: &[u8], at: usize) -> Result<u64, String> {
    Ok(u64::from_le_bytes(
        bytes
            .get(at..at + 8)
            .ok_or("truncated clusters")?
            .try_into()
            .unwrap(),
    ))
}
fn span(first: u32, count: u32, length: usize) -> Result<core::ops::Range<usize>, String> {
    let end = first.checked_add(count).ok_or("cluster range overflow")? as usize;
    if end > length {
        return Err("cluster range outside payload".into());
    }
    Ok(first as usize..end)
}
fn reserve<T>(n: usize) -> Result<Vec<T>, String> {
    let mut v = Vec::new();
    v.try_reserve_exact(n)
        .map_err(|_| "cluster allocation failed")?;
    Ok(v)
}
pub fn eligible(meta: &pc::Meta, d: &pc::Draw) -> bool {
    d.layout == pc::VertexLayout::Baked
        && d.node.is_none()
        && d.skin.is_none()
        && meta.materials.get(d.material as usize).is_some_and(|m| {
            m.kind == pc::Kind::Standard && m.blend == pc::Blend::Opaque && m.depth_write
        })
}
fn budget(
    meta: &pc::Meta,
    lods: &pc::ipod::display_lods::EffectiveLods,
) -> Result<[usize; 5], String> {
    let mut sizes = [meta.draws.len(), 0, 0, 0, 0];
    for (i, d) in meta
        .draws
        .iter()
        .enumerate()
        .filter(|(_, d)| eligible(meta, d))
    {
        let levels = lods.get(meta, i);
        let groups = d.index_count as usize / 3;
        sizes[1] = sizes[1]
            .checked_add(groups)
            .ok_or("group budget overflow")?;
        sizes[2] = sizes[2]
            .checked_add(
                groups
                    .checked_mul(levels.len() + 1)
                    .ok_or("level budget overflow")?,
            )
            .ok_or("level budget overflow")?;
        for n in core::iter::once(d.index_count).chain(levels.iter().map(|l| l.index_count)) {
            sizes[3] = sizes[3]
                .checked_add(n as usize / 3)
                .ok_or("cluster budget overflow")?;
            sizes[4] = sizes[4]
                .checked_add(n as usize)
                .ok_or("index budget overflow")?;
        }
    }
    Ok(sizes)
}
fn file_bytes(sizes: [usize; 5], cluster_stride: usize) -> Result<usize, String> {
    sizes
        .into_iter()
        .zip([8usize, 32, 12, cluster_stride, 2])
        .try_fold(HEADER, |sum, (n, stride)| {
            n.checked_mul(stride).and_then(|v| sum.checked_add(v))
        })
        .ok_or_else(|| "cluster file budget overflow".into())
}
#[cfg(test)]
pub fn max_file_bytes(meta: &pc::Meta) -> Result<usize, String> {
    max_file_bytes_with_lods(meta, &Default::default())
}
pub fn max_file_bytes_with_lods(
    meta: &pc::Meta,
    lods: &pc::ipod::display_lods::EffectiveLods,
) -> Result<usize, String> {
    file_bytes(budget(meta, lods)?, 56)
}
#[derive(Clone, Copy)]
pub struct Cluster {
    facing: pc::ipod::backface::PreparedCone,
    first: u32,
    count: u32,
    pub min: [f32; 3],
    pub max: [f32; 3],
}
pub struct Level {
    pub error: f32,
    first: u32,
    count: u32,
}
pub struct Group {
    first: u32,
    count: u32,
    pub min: [f32; 3],
    pub max: [f32; 3],
}
/// One view shared by all draw queries in a pass. Plane dot arithmetic matches
/// the renderer's original AABB test; reflected passes supply reflected planes.
pub struct Query {
    planes: [[f32; 4]; 6],
    eye: glam::Vec3,
    cull_eye: [f32; 3],
    scale: f32,
    scale_squared: f32,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct QueryKey {
    planes: [[u32; 4]; 6],
    eye: [u32; 3],
    cull_eye: [u32; 3],
    scale: u32,
}
impl Query {
    pub fn new(planes: [[f32; 4]; 6], eye: [f32; 3], lod_scale: f32) -> Self {
        Self {
            planes,
            eye: glam::Vec3::from(eye),
            cull_eye: eye,
            scale: lod_scale,
            scale_squared: lod_scale * lod_scale,
        }
    }
    pub fn with_cull_eye(mut self, eye: [f32; 3]) -> Self {
        self.cull_eye = eye;
        self
    }
    fn key(&self) -> QueryKey {
        QueryKey {
            planes: self.planes.map(|p| p.map(f32::to_bits)),
            eye: self.eye.to_array().map(f32::to_bits),
            cull_eye: self.cull_eye.map(f32::to_bits),
            scale: self.scale.to_bits(),
        }
    }
    #[inline]
    fn plane(&self, k: usize, lo: [f32; 3], hi: [f32; 3], positive: bool) -> f32 {
        let p = self.planes[k];
        glam::Vec3::new(p[0], p[1], p[2]).dot(glam::Vec3::new(
            if (p[0] >= 0.0) == positive {
                hi[0]
            } else {
                lo[0]
            },
            if (p[1] >= 0.0) == positive {
                hi[1]
            } else {
                lo[1]
            },
            if (p[2] >= 0.0) == positive {
                hi[2]
            } else {
                lo[2]
            },
        )) + p[3]
    }
    /// Remaining intersecting planes; None means outside. A parent that is
    /// wholly inside a plane makes all descendants' tests for it redundant.
    fn classify(&self, lo: [f32; 3], hi: [f32; 3], mut mask: u8) -> Option<u8> {
        for k in 0..6 {
            if mask & (1 << k) == 0 {
                continue;
            }
            if !(self.plane(k, lo, hi, true) >= 0.0) {
                return None;
            }
            if self.plane(k, lo, hi, false) >= 0.0 {
                mask &= !(1 << k);
            }
        }
        Some(mask)
    }
    #[inline]
    fn visible(&self, lo: [f32; 3], hi: [f32; 3], mask: u8) -> bool {
        (0..6).all(|k| mask & (1 << k) == 0 || self.plane(k, lo, hi, true) >= 0.0)
    }
    fn level(&self, group: &Group, levels: &[Level]) -> usize {
        if levels.len() == 1 {
            return 0;
        }
        let nearest = self
            .eye
            .clamp(glam::Vec3::from(group.min), glam::Vec3::from(group.max));
        let distance_squared = self.eye.distance_squared(nearest).max(1.0);
        let threshold = distance_squared * self.scale_squared;
        for (i, level) in levels.iter().enumerate().skip(1).rev() {
            let error = level.error * level.error;
            // Squaring avoids libm sqrt for ordinary comparisons. Around a
            // rounding boundary (or overflow/underflow) use the exact previous
            // expression, retaining strict `<` and its level selection.
            let margin = error.abs().max(threshold.abs()) * (32.0 * f32::EPSILON);
            if self.scale > 0.0
                && self.scale_squared.is_normal()
                && (error.is_normal() || level.error == 0.0)
                && threshold.is_normal()
                && (error - threshold).abs() > margin
            {
                if error < threshold {
                    return i;
                }
            } else {
                let tolerance = self.eye.distance(nearest).max(1.0) * self.scale;
                return levels
                    .iter()
                    .rposition(|l| l.error < tolerance)
                    .unwrap_or(0);
            }
        }
        0
    }
}
struct QueryNode {
    min: [f32; 3],
    max: [f32; 3],
    /// Original contiguous group range, never a spatial reorder.
    first: u32,
    count: u32,
    /// Left is the next node; MAX denotes a leaf of at most four groups.
    right: u32,
}
pub struct MeshClusters {
    draws: Vec<(u32, u32)>,
    groups: Vec<Group>,
    levels: Vec<Level>,
    clusters: Vec<Cluster>,
    indices: Vec<u16>,
    query_roots: Vec<u32>,
    query_nodes: Vec<QueryNode>,
    // A cache retains this token, so a dropped mesh's address cannot be reused
    // to produce a false identity match. Tokens never identify asset contents.
    query_identity: Arc<()>,
}
#[derive(Clone, Copy)]
struct SelectedCluster {
    group: u32,
    level: u32,
    ordinal: u32,
    index: u32,
}
#[derive(Default)]
struct CachedDraw {
    generation: u64,
    selected: Vec<SelectedCluster>,
    max_selected: usize,
}
/// Renderer-owned, per-pass cache for immutable IPCL geometry. Every exact
/// view change invalidates entries lazily; their capacities survive movement.
/// A distinct mesh instance always invalidates and releases the old entries.
#[derive(Default)]
pub struct QueryCache {
    identity: Option<Arc<()>>,
    key: Option<QueryKey>,
    generation: u64,
    draws: Vec<CachedDraw>,
    #[cfg(test)]
    evaluations: usize,
}
impl QueryCache {
    pub fn query(
        &mut self,
        mesh: &MeshClusters,
        draw: usize,
        view: &Query,
        mut emit: impl FnMut(u32, u32, u32, Cluster),
    ) -> bool {
        let Some(groups) = mesh.groups(draw) else {
            return false;
        };
        if !self
            .identity
            .as_ref()
            .is_some_and(|id| Arc::ptr_eq(id, &mesh.query_identity))
        {
            // Reclaim the previous scene before allocating a replacement.
            self.draws = Vec::new();
            self.identity = None;
            self.key = None;
            self.generation = 0;
            if self.draws.try_reserve_exact(mesh.draws.len()).is_err() {
                return mesh.query(draw, view, emit);
            }
            self.draws
                .resize_with(mesh.draws.len(), CachedDraw::default);
            self.identity = Some(Arc::clone(&mesh.query_identity));
        }
        let key = view.key();
        if self.key != Some(key) {
            self.key = Some(key);
            self.generation = self.generation.wrapping_add(1);
            if self.generation == 0 {
                for cached in &mut self.draws {
                    cached.generation = 0;
                }
                self.generation = 1;
            }
        }
        let cached = &mut self.draws[draw];
        if cached.generation != self.generation {
            cached.selected.clear();
            // At most one level is selected per group. Reserving this exact
            // immutable maximum prevents geometric capacity growth over time.
            // Across draws this is <= the sidecar's total cluster count.
            if cached.max_selected == 0 {
                cached.max_selected = groups
                    .iter()
                    .map(|g| {
                        mesh.levels(g)
                            .iter()
                            .map(|l| l.count as usize)
                            .max()
                            .unwrap_or(0)
                    })
                    .sum();
            }
            if cached
                .selected
                .try_reserve_exact(cached.max_selected)
                .is_err()
            {
                return mesh.query(draw, view, emit);
            }
            #[cfg(test)]
            {
                self.evaluations += 1;
            }
            mesh.query(draw, view, |group, level, ordinal, _| {
                let index = mesh.levels(&groups[group as usize])[level as usize].first + ordinal;
                cached.selected.push(SelectedCluster {
                    group,
                    level,
                    ordinal,
                    index,
                });
            });
            cached.generation = self.generation;
        }
        for c in &cached.selected {
            emit(c.group, c.level, c.ordinal, mesh.clusters[c.index as usize]);
        }
        true
    }
    /// Additional retained CPU allocation; shared mesh/token storage is counted
    /// by MeshClusters. No GL objects or source geometry are held by this cache.
    pub fn bytes(&self) -> usize {
        self.draws.capacity() * core::mem::size_of::<CachedDraw>()
            + self
                .draws
                .iter()
                .map(|d| d.selected.capacity() * core::mem::size_of::<SelectedCluster>())
                .sum::<usize>()
    }
}
fn bounds(bytes: &[u8], at: usize) -> Result<([f32; 3], [f32; 3]), String> {
    let mut values = [0.0; 6];
    for (k, v) in values.iter_mut().enumerate() {
        *v = f32::from_bits(u32_at(bytes, at + k * 4)?);
    }
    if values.iter().any(|v| !v.is_finite()) || (0..3).any(|k| values[k] > values[k + 3]) {
        return Err("invalid cluster bounds".into());
    }
    Ok((
        values[..3].try_into().unwrap(),
        values[3..].try_into().unwrap(),
    ))
}
fn contains(lo: [f32; 3], hi: [f32; 3], p: [f32; 3]) -> bool {
    (0..3).all(|k| p[k] >= lo[k] && p[k] <= hi[k])
}
impl MeshClusters {
    #[cfg(test)]
    pub fn parse(
        bytes: &[u8],
        meta: &pc::Meta,
        meta_bytes: &[u8],
        geometry: &[u8],
    ) -> Result<Self, String> {
        Self::parse_with_lods(bytes, meta, meta_bytes, geometry, &Default::default())
    }
    /// Source identity is raw META + complete GEOM. Selection may additionally
    /// contain validated target recipe tiers; Meta is never rewritten to fake
    /// the header identity or the original full-component ownership proof.
    pub fn parse_with_lods(
        bytes: &[u8],
        meta: &pc::Meta,
        meta_bytes: &[u8],
        geometry: &[u8],
        lods: &pc::ipod::display_lods::EffectiveLods,
    ) -> Result<Self, String> {
        if bytes.len() < HEADER
            || &bytes[..4] != b"IPCL"
            || !matches!(u32_at(bytes, 4)?, 2 | 3)
            || u32_at(bytes, 52)? != 0
        {
            return Err("invalid cluster header".into());
        }
        let version = u32_at(bytes, 4)?;
        let cluster_stride = if version == 3 { 56 } else { 32 };
        if bytes.len() > max_file_bytes_with_lods(meta, lods)? {
            return Err("cluster file exceeds geometry budget".into());
        }
        if u64_at(bytes, 8)? != hash(meta_bytes)
            || u64_at(bytes, 16)? != hash(geometry)
            || u64_at(bytes, 24)? != hash(&bytes[HEADER..])
        {
            return Err("stale or corrupt cluster sidecar".into());
        }
        let mut sizes = [0usize; 5];
        for (k, n) in sizes.iter_mut().enumerate() {
            *n = u32_at(bytes, 32 + k * 4)? as usize;
        }
        if sizes[0] != meta.draws.len()
            || sizes
                .into_iter()
                .zip(budget(meta, lods)?)
                .any(|(n, max)| n > max)
            || file_bytes(sizes, cluster_stride)? != bytes.len()
        {
            return Err("cluster payload size/count mismatch".into());
        }
        let mut out = Self {
            draws: reserve(sizes[0])?,
            groups: reserve(sizes[1])?,
            levels: reserve(sizes[2])?,
            clusters: reserve(sizes[3])?,
            indices: reserve(sizes[4])?,
            query_roots: Vec::new(),
            query_nodes: Vec::new(),
            query_identity: Arc::new(()),
        };
        let mut at = HEADER;
        for _ in 0..sizes[0] {
            out.draws.push((u32_at(bytes, at)?, u32_at(bytes, at + 4)?));
            at += 8;
        }
        for _ in 0..sizes[1] {
            let (min, max) = bounds(bytes, at + 8)?;
            out.groups.push(Group {
                first: u32_at(bytes, at)?,
                count: u32_at(bytes, at + 4)?,
                min,
                max,
            });
            at += 32;
        }
        for _ in 0..sizes[2] {
            let error = f32::from_bits(u32_at(bytes, at)?);
            if !error.is_finite() || error < 0.0 {
                return Err("invalid group LOD error".into());
            }
            out.levels.push(Level {
                error,
                first: u32_at(bytes, at + 4)?,
                count: u32_at(bytes, at + 8)?,
            });
            at += 12;
        }
        let cluster_records = at;
        for _ in 0..sizes[3] {
            let (min, max) = bounds(bytes, at + 8)?;
            let count = u32_at(bytes, at + 4)?;
            if count == 0 || count % 3 != 0 {
                return Err("invalid cluster index count".into());
            }
            out.clusters.push(Cluster {
                facing: Default::default(),
                first: u32_at(bytes, at)?,
                count,
                min,
                max,
            });
            at += cluster_stride;
        }
        for _ in 0..sizes[4] {
            out.indices
                .push(u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()));
            at += 2;
        }
        let (mut gc, mut lc, mut cc, mut ic) = (0u32, 0u32, 0u32, 0u32);
        for (di, &(first, count)) in out.draws.iter().enumerate() {
            if first != gc {
                return Err("groups are not contiguous".into());
            }
            if count == 0 {
                continue;
            }
            let d = &meta.draws[di];
            if !eligible(meta, d) {
                return Err("ineligible cluster draw".into());
            }
            let roots = pc::ipod::components(d, geometry)?;
            let mut owners = reserve::<u32>(roots.len())?;
            owners.resize(roots.len(), u32::MAX);
            let sources: Vec<_> = core::iter::once((&d.indices, d.index_count, 0.0))
                .chain(
                    lods.get(meta, di)
                        .iter()
                        .map(|l| (&l.indices, l.index_count, l.error)),
                )
                .collect();
            let mut actual = reserve::<Vec<[u16; 3]>>(sources.len())?;
            for (_, n, _) in &sources {
                actual.push(reserve(*n as usize / 3)?);
            }
            for (gi, group) in out.groups[span(first, count, out.groups.len())?]
                .iter()
                .enumerate()
            {
                if group.first != lc || group.count as usize != sources.len() {
                    return Err("incomplete/noncontiguous group LODs".into());
                }
                for (k, (level, (source, n, error))) in out.levels
                    [span(group.first, group.count, out.levels.len())?]
                .iter()
                .zip(&sources)
                .enumerate()
                {
                    if source.size != n.checked_mul(2).ok_or("source index overflow")?
                        || n % 3 != 0
                        || level.error.to_bits() != error.to_bits()
                        || level.first != cc
                    {
                        return Err("group LOD differs from original".into());
                    }
                    let start = ic;
                    let cluster_range = span(level.first, level.count, out.clusters.len())?;
                    for (local, cluster) in out.clusters[cluster_range].iter_mut().enumerate() {
                        if cluster.first != ic {
                            return Err("cluster indices are not contiguous".into());
                        }
                        let indices =
                            &out.indices[span(cluster.first, cluster.count, out.indices.len())?];
                        if version == 3 {
                            let at =
                                cluster_records + (level.first as usize + local) * cluster_stride;
                            let mut values = [0.; 6];
                            for (k, value) in values.iter_mut().enumerate() {
                                *value = f32::from_bits(u32_at(bytes, at + 32 + k * 4)?);
                            }
                            let cone = pc::ipod::backface::Cone::from_values(values);
                            if pc::ipod::backface::eligible(meta, d) {
                                pc::ipod::backface::validate(
                                    cone,
                                    d,
                                    geometry,
                                    indices,
                                    cluster.min,
                                    cluster.max,
                                )?
                            } else if !cone.disabled() {
                                return Err("ineligible cluster backface descriptor".into());
                            }
                            cluster.facing = cone.prepare();
                        }
                        if actual[k]
                            .len()
                            .checked_add(indices.len() / 3)
                            .is_none_or(|len| len > *n as usize / 3)
                        {
                            return Err("group triangles exceed original count".into());
                        }
                        for tri in indices.chunks_exact(3) {
                            let root = *roots
                                .get(tri[0] as usize)
                                .ok_or("cluster index exceeds vertices")?;
                            if root == u32::MAX
                                || tri.iter().any(|&i| roots.get(i as usize) != Some(&root))
                            {
                                return Err("LOD triangle crosses full connected components".into());
                            }
                            if k == 0 {
                                let owner = &mut owners[root as usize];
                                if *owner == u32::MAX {
                                    *owner = gi as u32;
                                } else if *owner != gi as u32 {
                                    return Err(
                                        "full connected component split between groups".into()
                                    );
                                }
                            } else if owners[root as usize] != gi as u32 {
                                return Err("LOD component changes group".into());
                            }
                            for &i in tri {
                                let p = pc::ipod::position(d, geometry, i)?;
                                if !contains(group.min, group.max, p)
                                    || !contains(cluster.min, cluster.max, p)
                                {
                                    return Err("group/cluster bounds exclude geometry".into());
                                }
                            }
                            actual[k].push([tri[0], tri[1], tri[2]]);
                        }
                        ic = ic
                            .checked_add(cluster.count)
                            .ok_or("cluster index overflow")?;
                    }
                    if k == 0 && start == ic {
                        return Err("group has no full geometry".into());
                    }
                    cc = cc
                        .checked_add(level.count)
                        .ok_or("cluster count overflow")?;
                }
                lc = lc.checked_add(group.count).ok_or("level count overflow")?;
            }
            for (k, (source, n, _)) in sources.iter().enumerate() {
                let original = pc::parts::slice(geometry, source)?;
                let mut expected = reserve::<[u16; 3]>(*n as usize / 3)?;
                expected.extend(original.chunks_exact(6).map(|b| {
                    core::array::from_fn(|k| u16::from_le_bytes([b[k * 2], b[k * 2 + 1]]))
                }));
                expected.sort_unstable();
                actual[k].sort_unstable();
                if actual[k] != expected {
                    return Err("group triangles differ from original LOD".into());
                }
            }
            gc = gc.checked_add(count).ok_or("group count overflow")?;
        }
        if gc as usize != out.groups.len()
            || lc as usize != out.levels.len()
            || cc as usize != out.clusters.len()
            || ic as usize != out.indices.len()
        {
            return Err("unused cluster payload".into());
        }
        out.build_query_index()?;
        Ok(out)
    }
    fn build_query_index(&mut self) -> Result<(), String> {
        fn count(n: usize) -> usize {
            if n <= 4 {
                1
            } else {
                1 + count(n / 2) + count(n - n / 2)
            }
        }
        let n = self
            .draws
            .iter()
            .filter(|(_, n)| *n > 4)
            .try_fold(0usize, |sum, (_, n)| {
                sum.checked_add(count(*n as usize))
                    .ok_or("query tree count overflow")
            })?;
        self.query_roots = reserve(self.draws.len())?;
        self.query_nodes = reserve(n)?;
        for i in 0..self.draws.len() {
            let (first, count) = self.draws[i];
            let node = if count > 4 {
                self.build_query_node(first, count)?
            } else {
                u32::MAX
            };
            self.query_roots.push(node);
        }
        Ok(())
    }
    fn build_query_node(&mut self, first: u32, count: u32) -> Result<u32, String> {
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for g in &self.groups[first as usize..(first + count) as usize] {
            for k in 0..3 {
                min[k] = min[k].min(g.min[k]);
                max[k] = max[k].max(g.max[k]);
            }
        }
        let index = u32::try_from(self.query_nodes.len()).map_err(|_| "query tree exceeds u32")?;
        self.query_nodes.push(QueryNode {
            min,
            max,
            first,
            count,
            right: u32::MAX,
        });
        if count > 4 {
            self.build_query_node(first, count / 2)?;
            let right = self.build_query_node(first + count / 2, count - count / 2)?;
            self.query_nodes[index as usize].right = right;
        }
        Ok(index)
    }
    /// Emit exactly the original ordered (group, level, cluster) selection.
    /// No frame allocation or index copying occurs here. False means the draw
    /// has no sidecar groups; true also covers a completely culled draw.
    pub fn query(
        &self,
        draw: usize,
        view: &Query,
        mut emit: impl FnMut(u32, u32, u32, Cluster),
    ) -> bool {
        let Some(&(first, count)) = self.draws.get(draw).filter(|(_, n)| *n > 0) else {
            return false;
        };
        let node = self.query_roots[draw];
        if node != u32::MAX {
            self.query_node(node, first, view, 63, &mut emit);
        } else {
            self.query_groups(first, count, first, view, 63, &mut emit);
        }
        true
    }
    fn query_node(
        &self,
        index: u32,
        origin: u32,
        view: &Query,
        mask: u8,
        emit: &mut impl FnMut(u32, u32, u32, Cluster),
    ) {
        let node = &self.query_nodes[index as usize];
        let Some(mask) = view.classify(node.min, node.max, mask) else {
            return;
        };
        if mask == 0 {
            for i in node.first..node.first + node.count {
                self.query_group(i, origin, view, 0, emit);
            }
        } else if node.right == u32::MAX {
            self.query_groups(node.first, node.count, origin, view, mask, emit);
        } else {
            self.query_node(index + 1, origin, view, mask, emit);
            self.query_node(node.right, origin, view, mask, emit);
        }
    }
    fn query_groups(
        &self,
        first: u32,
        count: u32,
        origin: u32,
        view: &Query,
        mask: u8,
        emit: &mut impl FnMut(u32, u32, u32, Cluster),
    ) {
        for i in first..first + count {
            let g = &self.groups[i as usize];
            if let Some(mask) = view.classify(g.min, g.max, mask) {
                self.query_group(i, origin, view, mask, emit);
            }
        }
    }
    fn query_group(
        &self,
        index: u32,
        origin: u32,
        view: &Query,
        mask: u8,
        emit: &mut impl FnMut(u32, u32, u32, Cluster),
    ) {
        let group = &self.groups[index as usize];
        let levels = self.levels(group);
        let selected = view.level(group, levels);
        for (i, c) in self.clusters(&levels[selected]).iter().enumerate() {
            if (mask == 0 || view.visible(c.min, c.max, mask))
                && !c.facing.backfacing(c.min, c.max, view.cull_eye)
            {
                emit(index - origin, selected as u32, i as u32, *c);
            }
        }
    }
    pub fn query_bytes(&self) -> usize {
        self.query_roots.capacity() * core::mem::size_of::<u32>()
            + self.query_nodes.capacity() * core::mem::size_of::<QueryNode>()
            + 2 * core::mem::size_of::<usize>() // shared Arc identity allocation
    }
    pub fn groups(&self, draw: usize) -> Option<&[Group]> {
        let &(first, count) = self.draws.get(draw)?;
        (count > 0).then(|| &self.groups[first as usize..(first + count) as usize])
    }
    pub fn levels(&self, group: &Group) -> &[Level] {
        &self.levels[group.first as usize..(group.first + group.count) as usize]
    }
    pub fn clusters(&self, level: &Level) -> &[Cluster] {
        &self.clusters[level.first as usize..(level.first + level.count) as usize]
    }
    pub fn indices(&self, cluster: &Cluster) -> &[u16] {
        &self.indices[cluster.first as usize..(cluster.first + cluster.count) as usize]
    }
    pub fn bytes(&self) -> usize {
        self.draws.len() * core::mem::size_of::<(u32, u32)>()
            + self.groups.len() * core::mem::size_of::<Group>()
            + self.levels.len() * core::mem::size_of::<Level>()
            + self.clusters.len() * core::mem::size_of::<Cluster>()
            + self.indices.len() * 2
            + self.query_bytes()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    type Selection = (u32, u32, u32, u32, u32);
    // Deliberately retain the pre-query renderer's linear algorithm as an
    // independent oracle, including sqrt and all six planes at every level.
    fn linear(mesh: &MeshClusters, draw: usize, view: &Query) -> Vec<Selection> {
        fn visible(view: &Query, lo: [f32; 3], hi: [f32; 3]) -> bool {
            view.planes.iter().all(|p| {
                glam::Vec3::new(p[0], p[1], p[2]).dot(glam::Vec3::new(
                    if p[0] >= 0.0 { hi[0] } else { lo[0] },
                    if p[1] >= 0.0 { hi[1] } else { lo[1] },
                    if p[2] >= 0.0 { hi[2] } else { lo[2] },
                )) + p[3]
                    >= 0.0
            })
        }
        let mut out = Vec::new();
        for (gi, g) in mesh.groups(draw).unwrap_or(&[]).iter().enumerate() {
            if !visible(view, g.min, g.max) {
                continue;
            }
            let li = original_level(view, g, mesh.levels(g));
            for (ci, c) in mesh.clusters(&mesh.levels(g)[li]).iter().enumerate() {
                if visible(view, c.min, c.max) && !c.facing.backfacing(c.min, c.max, view.cull_eye)
                {
                    out.push((gi as u32, li as u32, ci as u32, c.first, c.count));
                }
            }
        }
        out
    }
    fn original_level(view: &Query, g: &Group, levels: &[Level]) -> usize {
        let distance = view
            .eye
            .distance(view.eye.clamp(g.min.into(), g.max.into()));
        let tolerance = distance.max(1.0) * view.scale;
        levels
            .iter()
            .rposition(|l| l.error < tolerance)
            .unwrap_or(0)
    }
    fn accelerated(mesh: &MeshClusters, draw: usize, view: &Query) -> Vec<Selection> {
        let mut out = Vec::new();
        assert_eq!(
            mesh.query(draw, view, |g, l, i, c| {
                out.push((g, l, i, c.first, c.count));
            }),
            mesh.groups(draw).is_some()
        );
        out
    }
    fn planes(center: [f32; 3], extent: f32) -> [[f32; 4]; 6] {
        [
            [1.0, 0.0, 0.0, extent - center[0]],
            [-1.0, 0.0, 0.0, extent + center[0]],
            [0.0, 1.0, 0.0, extent - center[1]],
            [0.0, -1.0, 0.0, extent + center[1]],
            [0.0, 0.0, 1.0, extent - center[2]],
            [0.0, 0.0, -1.0, extent + center[2]],
        ]
    }
    fn query_fixture() -> MeshClusters {
        let mut mesh = MeshClusters {
            draws: Vec::new(),
            groups: Vec::new(),
            levels: Vec::new(),
            clusters: Vec::new(),
            indices: Vec::new(),
            query_roots: Vec::new(),
            query_nodes: Vec::new(),
            query_identity: Arc::new(()),
        };
        for count in [0, 1, 4, 5, 41, 79] {
            mesh.draws.push((mesh.groups.len() as u32, count));
            for i in 0..count {
                let lo = [((i * 13) % 19) as f32 - 9.0, (i % 3) as f32, (i / 3) as f32];
                let hi = [lo[0] + 0.75, lo[1] + 0.75, lo[2] + 0.75];
                let levels = if i % 4 == 0 { 1 } else { 3 };
                mesh.groups.push(Group {
                    first: mesh.levels.len() as u32,
                    count: levels,
                    min: lo,
                    max: hi,
                });
                for li in 0..levels {
                    // Empty coarsest levels are valid component removal.
                    let clusters = if li == 2 && i % 3 == 0 { 0 } else { 2 };
                    mesh.levels.push(Level {
                        error: [0.0, 0.06, 0.25][li as usize],
                        first: mesh.clusters.len() as u32,
                        count: clusters,
                    });
                    for ci in 0..clusters {
                        let mut c_lo = lo;
                        let mut c_hi = hi;
                        c_lo[0] += ci as f32 * 0.4;
                        c_hi[0] -= (1 - ci) as f32 * 0.4;
                        mesh.clusters.push(Cluster {
                            facing: Default::default(),
                            first: mesh.indices.len() as u32,
                            count: 3,
                            min: c_lo,
                            max: c_hi,
                        });
                        mesh.indices.extend([0, 1, 2]);
                    }
                }
            }
        }
        mesh.build_query_index().unwrap();
        mesh
    }
    #[test]
    fn query_matches_ordered_linear_selection_for_moving_and_grazing_views() {
        let mesh = query_fixture();
        for step in -80..120 {
            let center = [step as f32 * 0.25, 1.25, 8.0];
            for extent in [0.0, 0.5, 7.0, 100.0] {
                for scale in [0.8 / 106.0, 0.8 / 213.0, 1.6 / 42.0] {
                    let view = Query::new(planes(center, extent), center, scale);
                    for draw in 0..=mesh.draws.len() {
                        assert_eq!(
                            accelerated(&mesh, draw, &view),
                            linear(&mesh, draw, &view),
                            "step={step}, extent={extent}, draw={draw}"
                        );
                    }
                }
            }
        }
        assert_eq!(&mesh.query_roots[..3], &[u32::MAX; 3]);
        assert!(mesh.query_roots[3..].iter().all(|&r| r != u32::MAX));
        assert!(mesh.query_bytes() > 0);
    }
    #[test]
    fn reflected_cull_eye_changes_cache_selection_but_not_lod_distance() {
        let mut mesh = query_fixture();
        for c in &mut mesh.clusters {
            c.facing = pc::ipod::backface::Cone {
                axis: [0., 1., 0.],
                cosine: 0.9999,
                offset: 0.,
                condition: 2.,
            }
            .prepare();
        }
        let original = [0., 50., 0.];
        let view = Query::new(planes([0.; 3], 1000.), original, 0.001);
        let reflected = Query::new(view.planes, original, view.scale).with_cull_eye([0., -50., 0.]);
        for g in &mesh.groups {
            assert_eq!(
                view.level(g, mesh.levels(g)),
                reflected.level(g, mesh.levels(g))
            );
        }
        let mut cache = QueryCache::default();
        let main = cached_selection(&mut cache, &mesh, 5, &view);
        assert!(!main.is_empty());
        let n = cache.evaluations;
        assert!(cached_selection(&mut cache, &mesh, 5, &reflected).is_empty());
        assert_eq!(cache.evaluations, n + 1);
        assert!(cached_selection(&mut cache, &mesh, 5, &reflected).is_empty());
        assert_eq!(cache.evaluations, n + 1);
        assert_eq!(main, cached_selection(&mut cache, &mesh, 5, &view));
    }
    #[test]
    fn squared_lod_keeps_strict_sqrt_boundary_and_extreme_scales() {
        let group = Group {
            first: 0,
            count: 2,
            min: [0.0; 3],
            max: [0.0; 3],
        };
        for distance in [0.0, 0.99999994, 1.0, 1.0000001, 7.25, 12345.0, 1e-20, 1e20] {
            for scale in [
                0.0,
                1e-30,
                1e-20,
                0.8 / 106.0,
                0.8 / 213.0,
                1.6 / 42.0,
                1e10,
                1e30,
            ] {
                let view = Query::new(
                    planes([0.0; 3], 1.0),
                    [distance, distance * 0.3, 0.0],
                    scale,
                );
                let threshold = view.eye.length().max(1.0) * scale;
                let bits = threshold.to_bits();
                for delta in -48i64..=48 {
                    let candidate = (bits as i64 + delta).clamp(0, 0x7f7fffff) as u32;
                    let levels = [
                        Level {
                            error: 0.0,
                            first: 0,
                            count: 0,
                        },
                        Level {
                            error: f32::from_bits(candidate),
                            first: 0,
                            count: 0,
                        },
                    ];
                    assert_eq!(
                        view.level(&group, &levels),
                        original_level(&view, &group, &levels),
                        "distance={distance}, scale={scale}, delta={delta}"
                    );
                }
            }
        }
    }
    fn cached_selection(
        cache: &mut QueryCache,
        mesh: &MeshClusters,
        draw: usize,
        view: &Query,
    ) -> Vec<Selection> {
        let mut out = Vec::new();
        assert_eq!(
            cache.query(mesh, draw, view, |g, l, i, c| {
                out.push((g, l, i, c.first, c.count));
            }),
            mesh.groups(draw).is_some()
        );
        out
    }
    #[test]
    fn query_cache_reuses_empty_and_populated_draws_and_invalidates_exact_view_bits() {
        let mesh = query_fixture();
        let mut cache = QueryCache::default();
        let mut view = Query::new(planes([0.0; 3], 100.0), [0.0; 3], 0.8 / 106.0);
        for draw in 0..=mesh.draws.len() {
            let expected = linear(&mesh, draw, &view);
            assert_eq!(cached_selection(&mut cache, &mesh, draw, &view), expected);
            let evaluated = cache.evaluations;
            for _ in 0..3 {
                assert_eq!(cached_selection(&mut cache, &mesh, draw, &view), expected);
                assert_eq!(cache.evaluations, evaluated);
            }
        }
        let bytes = cache.bytes();
        let capacity: usize = cache.draws.iter().map(|d| d.max_selected).sum();
        assert!(capacity <= mesh.clusters.len());
        assert_eq!(
            bytes,
            cache.draws.len() * core::mem::size_of::<CachedDraw>()
                + capacity * core::mem::size_of::<SelectedCluster>()
        );
        let other_generation = cache.draws[4].generation;
        // Every plane/eye component and scale affect the exact key, including
        // +0/-0. No quantized camera cache or time-dependent input exists.
        for component in 0..31 {
            let mut next = Query::new(view.planes, view.eye.to_array(), view.scale);
            if component < 24 {
                let value = &mut next.planes[component / 4][component % 4];
                *value = f32::from_bits(value.to_bits() ^ 1);
            } else if component < 27 {
                next.eye[component - 24] = -0.0;
            } else if component < 30 {
                next.cull_eye[component - 27] = -0.0;
            } else {
                next.scale = f32::from_bits(next.scale.to_bits() + 1);
                next.scale_squared = next.scale * next.scale;
            }
            let evaluated = cache.evaluations;
            assert_eq!(
                cached_selection(&mut cache, &mesh, 5, &next),
                linear(&mesh, 5, &next)
            );
            assert_eq!(cache.evaluations, evaluated + 1);
            assert_eq!(cache.draws[4].generation, other_generation); // lazy invalidation
            assert_eq!(
                cached_selection(&mut cache, &mesh, 5, &next),
                linear(&mesh, 5, &next)
            );
            assert_eq!(cache.evaluations, evaluated + 1);
        }
        view = Query::new(planes([1000.0; 3], 0.1), [1000.0; 3], 0.8 / 106.0);
        assert!(cached_selection(&mut cache, &mesh, 5, &view).is_empty());
        let evaluated = cache.evaluations;
        assert!(cached_selection(&mut cache, &mesh, 5, &view).is_empty());
        assert_eq!(cache.evaluations, evaluated); // cached empty result
        assert_eq!(cache.bytes(), bytes); // movement retains fixed capacity
        cache.generation = u64::MAX;
        view.eye.x += 1.0;
        assert_eq!(
            cached_selection(&mut cache, &mesh, 5, &view),
            linear(&mesh, 5, &view)
        );
        assert_eq!(cache.generation, 1);
        assert_eq!(cache.draws[4].generation, 0);
        // Byte-identical meshes still have distinct lifetimes/identities.
        let replacement = query_fixture();
        let evaluated = cache.evaluations;
        assert_eq!(
            cached_selection(&mut cache, &replacement, 5, &view),
            linear(&replacement, 5, &view)
        );
        assert_eq!(cache.evaluations, evaluated + 1);
        assert!(Arc::ptr_eq(
            cache.identity.as_ref().unwrap(),
            &replacement.query_identity
        ));
        assert!(!Arc::ptr_eq(
            cache.identity.as_ref().unwrap(),
            &mesh.query_identity
        ));
    }
    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to existing GLES packs; no GPU"]
    fn real_pack_queries_match_linear_at_authored_camera_samples() {
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").expect("pack directory");
        let mut packs = 0;
        let mut shots = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let pack = pc::ipod::parse(&bytes).unwrap();
            let meta = pack.meta().unwrap();
            let metadata: pc::ipod::Metadata =
                serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
            let lods =
                pc::ipod::display_lods::EffectiveLods::new(&meta, &metadata.ipod_recipes).unwrap();
            let clusters = std::fs::read(path.with_extension("ipod-clusters.bin")).unwrap();
            let mesh = MeshClusters::parse_with_lods(
                &clusters,
                &meta,
                pack.section(pc::TAG_META).unwrap(),
                pack.section(pc::TAG_GEOMETRY).unwrap(),
                &lods,
            )
            .unwrap();
            let mut cases = 0;
            let mut cache = QueryCache::default();
            for shot in &meta.camera.shots {
                shots += 1;
                for t in [0.0, 0.125, 0.5, 0.875, 1.0] {
                    let eye = glam::Vec3::from(shot.from.pos).lerp(shot.to.pos.into(), t);
                    let target = glam::Vec3::from(shot.from.target).lerp(shot.to.target.into(), t);
                    let fov = shot.from.fov + (shot.to.fov - shot.from.fov) * t;
                    let vp = glam::camera::rh::proj::opengl::perspective(
                        fov.to_radians(),
                        1.5,
                        0.25,
                        100000.0,
                    ) * glam::camera::rh::view::look_at_mat4(eye, target, glam::Vec3::Y);
                    for mirror in [false, true] {
                        let clip = if mirror {
                            vp * glam::Mat4::from_scale(glam::Vec3::new(1.0, -1.0, 1.0))
                        } else {
                            vp
                        };
                        let m = clip.transpose();
                        let p = [
                            m.w_axis + m.x_axis,
                            m.w_axis - m.x_axis,
                            m.w_axis + m.y_axis,
                            m.w_axis - m.y_axis,
                            m.w_axis + m.z_axis,
                            m.w_axis - m.z_axis,
                        ]
                        .map(|v| v.to_array());
                        for height in [106u32, 213, 320] {
                            let scale = if mirror {
                                1.6 / (height / 3).max(42) as f32
                            } else {
                                0.8 / height as f32
                            };
                            let view =
                                Query::new(p, eye.to_array(), scale).with_cull_eye(if mirror {
                                    [eye.x, -eye.y, eye.z]
                                } else {
                                    eye.to_array()
                                });
                            for draw in 0..meta.draws.len() {
                                assert_eq!(
                                    accelerated(&mesh, draw, &view),
                                    linear(&mesh, draw, &view),
                                    "{} {} t={t} mirror={mirror} height={height} draw={draw}",
                                    path.display(),
                                    shot.name
                                );
                                let expected = linear(&mesh, draw, &view);
                                assert_eq!(
                                    cached_selection(&mut cache, &mesh, draw, &view),
                                    expected
                                );
                                let evaluated = cache.evaluations;
                                assert_eq!(
                                    cached_selection(&mut cache, &mesh, draw, &view),
                                    expected
                                );
                                assert_eq!(cache.evaluations, evaluated);
                                cases += 1;
                            }
                        }
                    }
                }
            }
            std::println!(
                "{}: {cases} ordered query comparisons, query RAM {} bytes, cache RAM {} bytes",
                path.display(),
                mesh.query_bytes(),
                cache.bytes()
            );
            packs += 1;
        }
        assert!(packs > 0 && shots > 0);
    }
    #[test]
    fn plip_clusters_preserve_float_bounds_components_original_lods_and_empty_levels() {
        use pc::ipod::{parse, position, stride};
        // This module is also compiled by the cooker. Keep its format fixture
        // independent of the application's validator and GL test harness.
        let mut meta: pc::Meta = serde_json::from_str(r#"{
            "version":1,"name":"PLIP grouped float triangles","min":[0,0,0],"max":[1,1,1],
            "textures":[],"materials":[{"name":"opaque","kind":"standard","blend":"opaque",
                "double_sided":false,"depth_write":true,"alpha_test":0,"color":[1,1,1,1],"emissive":[0,0,0],
                "roughness":0.5,"metalness":0,"normal_scale":1,"ao_strength":1,"env_strength":0,
                "vertex_color":false,"interior":false,"fog":false,"drops":0,"clearcoat":0}],
            "draws":[{"material":0,"layout":"baked","vertices":{"offset":0,"size":0},"vertex_count":0,
                "indices":{"offset":0,"size":0},"index_count":0,"pos_offset":[0,0,0],"pos_scale":[1,1,1],
                "uv_offset":[0,0],"uv_scale":[1,1],"min":[0,0,0],"max":[1,1,1],
                "no_reflect":false,"cast_shadow":true}],
            "nodes":[],"skins":[],"lights":[],"fog_lights":[],"fog_tracks":[],"material_tracks":[],
            "fps":30,"frames":1,"beacons":[],"stats":{},
            "atmosphere":{"fog_color":[0,0,0],"fog_density":0,"haze_density":0,"haze_ambient":[0,0,0],"haze_ambient_density":0,
                "dry_min":[0,0,0],"dry_max":[0,0,0],"hemisphere_sky":[0,0,0],"hemisphere_ground":[0,0,0],
                "sky_zenith":[0,0,0],"sky_horizon":[0,0,0],"sky_glow":[0,0,0],"environment_strength":0},
            "rain":{"dry_boxes":[],"drip_edges":[],"steam_vents":[]},
            "camera":{"shots":[],"walkable":[],"intro":{"pos":[0,1,2],"target":[0,1,0],"fov":40}}
        }"#).unwrap();
        let d = &mut meta.draws[0];
        d.layout = pc::VertexLayout::Baked;
        d.node = None;
        d.vertex_count = 6;
        d.vertices = pc::Range {
            offset: 0,
            size: 6 * stride(d.layout),
        };
        d.indices = pc::Range {
            offset: d.vertices.size,
            size: 12,
        };
        d.index_count = 6;
        d.lods = vec![
            pc::DrawLod {
                indices: pc::Range {
                    offset: d.vertices.size + 12,
                    size: 6,
                },
                index_count: 3,
                error: 0.25,
            },
            pc::DrawLod {
                indices: pc::Range {
                    offset: d.vertices.size + 18,
                    size: 0,
                },
                index_count: 0,
                error: 1.0,
            },
        ];
        d.min = [10.125, 0.25, -0.5];
        d.max = [701.125, 1.25, -0.5];
        // Legacy normalization parameters deliberately cannot decode this
        // source. Cluster bounds must use PLIP's exact f32 positions.
        d.pos_offset = [-100.0; 3];
        d.pos_scale = [2.0; 3];
        let mut geometry = Vec::new();
        let group_bounds = [
            ([10.125, 0.25, -0.5], [11.125, 1.25, -0.5]),
            ([700.125, 0.25, -0.5], [701.125, 1.25, -0.5]),
        ];
        for &(lo, hi) in &group_bounds {
            for (pos, uv) in [
                (lo, [0.0f32, 0.0]),
                ([hi[0], lo[1], lo[2]], [1.0, 0.0]),
                ([lo[0], hi[1], lo[2]], [0.0, 1.0]),
            ] {
                for value in pos
                    .into_iter()
                    .chain([0.0, 0.0, 1.0])
                    .chain([1.0, 0.0, 0.0, 1.0])
                    .chain(uv)
                {
                    geometry.extend(value.to_le_bytes());
                }
                geometry.extend([17, 89, 201, 255, 128, 128, 128, 255]);
            }
        }
        assert_eq!(geometry.len(), d.vertices.size as usize);
        geometry.extend(
            [0u16, 1, 2, 3, 4, 5, 0, 1, 2]
                .into_iter()
                .flat_map(u16::to_le_bytes),
        );
        meta.min = meta.draws[0].min;
        meta.max = meta.draws[0].max;
        let meta_bytes = serde_json::to_vec(&meta).unwrap();
        let pack_bytes = pc::write_versioned(
            pc::ipod::MAGIC,
            pc::ipod::VERSION,
            &[
                (pc::TAG_META, &meta_bytes, 16),
                (pc::TAG_GEOMETRY, &geometry, 16),
                (pc::TAG_TEXTURES, &[], 16),
                (pc::TAG_ANIMATION, &[], 16),
            ],
        );
        let pack = parse(&pack_bytes).unwrap();
        let geometry = pack.section(pc::TAG_GEOMETRY).unwrap();
        assert_eq!(
            position(&meta.draws[0], geometry, 3).unwrap(),
            [700.125, 0.25, -0.5]
        );
        let mut bytes = vec![0; HEADER];
        bytes[..4].copy_from_slice(b"IPCL");
        bytes[4..8].copy_from_slice(&2u32.to_le_bytes());
        for (i, count) in [1u32, 2, 6, 3, 9].into_iter().enumerate() {
            bytes[32 + i * 4..36 + i * 4].copy_from_slice(&count.to_le_bytes());
        }
        let words = |b: &mut Vec<u8>, values: &[u32]| {
            for v in values {
                b.extend(v.to_le_bytes());
            }
        };
        words(&mut bytes, &[0, 2]);
        for (i, &(lo, hi)) in group_bounds.iter().enumerate() {
            words(&mut bytes, &[i as u32 * 3, 3]);
            words(
                &mut bytes,
                &lo.into_iter()
                    .chain(hi)
                    .map(f32::to_bits)
                    .collect::<Vec<_>>(),
            );
        }
        for (error, first, count) in [
            (0.0f32, 0, 1),
            (0.25, 1, 1),
            (1.0, 2, 0),
            (0.0, 2, 1),
            (0.25, 3, 0),
            (1.0, 3, 0),
        ] {
            words(&mut bytes, &[error.to_bits(), first, count]);
        }
        for (i, group) in [0usize, 0, 1].into_iter().enumerate() {
            words(&mut bytes, &[i as u32 * 3, 3]);
            let (lo, hi) = group_bounds[group];
            words(
                &mut bytes,
                &lo.into_iter()
                    .chain(hi)
                    .map(f32::to_bits)
                    .collect::<Vec<_>>(),
            );
        }
        let index_start = bytes.len();
        bytes.extend(
            [0u16, 1, 2, 0, 1, 2, 3, 4, 5]
                .into_iter()
                .flat_map(u16::to_le_bytes),
        );
        let identity = |b: &mut [u8], g: &[u8]| {
            for (at, value) in [
                (8, hash(&meta_bytes)),
                (16, hash(g)),
                (24, hash(&b[HEADER..])),
            ] {
                b[at..at + 8].copy_from_slice(&value.to_le_bytes());
            }
        };
        identity(&mut bytes, geometry);
        let mesh = MeshClusters::parse(&bytes, &meta, &meta_bytes, geometry).unwrap();
        let groups = mesh.groups(0).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(
            mesh.indices(&mesh.clusters(&mesh.levels(&groups[1])[0])[0]),
            [3, 4, 5]
        );
        assert!(mesh.clusters(&mesh.levels(&groups[1])[1]).is_empty());
        for group in groups {
            assert!(mesh.clusters(&mesh.levels(group)[2]).is_empty());
        }
        for (mode, expected) in [
            (0, "bounds exclude geometry"),
            (1, "triangles differ"),
            (2, "cluster index exceeds"),
            (3, "component changes group"),
            (4, "non-finite"),
        ] {
            let mut invalid = bytes.clone();
            let mut g = geometry.to_vec();
            match mode {
                0 => invalid[HEADER + 8 + 8..HEADER + 8 + 12]
                    .copy_from_slice(&10.25f32.to_le_bytes()),
                1 => invalid[index_start..index_start + 4].copy_from_slice(&[1, 0, 0, 0]),
                2 => invalid[index_start..index_start + 2].copy_from_slice(&6u16.to_le_bytes()),
                3 => {
                    invalid[index_start + 6..index_start + 12].copy_from_slice(&[3, 0, 4, 0, 5, 0])
                }
                _ => g[..4].copy_from_slice(&f32::NAN.to_le_bytes()),
            }
            // Recompute identities so these cases test geometry and topology,
            // not merely the checksum gate.
            identity(&mut invalid, &g);
            let error = MeshClusters::parse(&invalid, &meta, &meta_bytes, &g)
                .err()
                .unwrap();
            assert!(error.contains(expected), "mode {mode}: {error}");
        }
    }

    #[test]
    fn identity_and_checked_ranges() {
        assert_eq!(hash(b""), 0xcbf29ce484222325);
        assert_eq!(hash(b"a"), 0xaf63dc4c8601ec8c);
        assert!(span(u32::MAX, 1, usize::MAX).is_err());
        assert!(span(3, 4, 6).is_err());
        assert_eq!(span(2, 4, 6).unwrap(), 2..6);
        assert!(u32_at(&[0; 3], 0).is_err());
    }
}
