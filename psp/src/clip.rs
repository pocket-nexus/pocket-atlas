//! PSP GE guard-band clipping. This is geometry math, independent of the SDK.
//! Keep 3D vertices: through-mode would lose perspective-correct texturing.
use glam::{Mat4, Vec2, Vec3, Vec4};
use pocket3d_place_psp as pp;

// The GE discards a triangle if a post-near-clip XY leaves 0..4096. Our
// viewport is 2048 +/- (240,136). Leave room for GE's 24-bit matrix arithmetic.
const GUARD_X: f32 = 2032.0 / 240.0;
const GUARD_Y: f32 = 2032.0 / 136.0;
const PLANES: [Vec4; 5] = [
    Vec4::new(0.0, 0.0, 1.0, 1.0), // Near first, before dividing by w.
    Vec4::new(1.0, 0.0, 0.0, GUARD_X),
    Vec4::new(-1.0, 0.0, 0.0, GUARD_X),
    Vec4::new(0.0, 1.0, 0.0, GUARD_Y),
    Vec4::new(0.0, -1.0, 0.0, GUARD_Y),
];
// A triangle clipped by five half-spaces has at most eight vertices.
pub const MAX_VERTICES: usize = 18; // Six fan triangles.

pub struct Guard {
    planes: [Vec4; 5],
    view: [Vec4; 6],
}
impl Guard {
    pub fn new(vp: Mat4) -> Self {
        let transpose = vp.transpose();
        Self {
            planes: PLANES.map(|p| transpose * p),
            view: [
                transpose.w_axis + transpose.x_axis,
                transpose.w_axis - transpose.x_axis,
                transpose.w_axis + transpose.y_axis,
                transpose.w_axis - transpose.y_axis,
                transpose.w_axis + transpose.z_axis,
                transpose.w_axis - transpose.z_axis,
            ],
        }
    }
    fn block_safe(&self, bounds: &Bounds) -> bool {
        let c = bounds.center;
        let e = bounds.extent;
        self.planes
            .iter()
            .all(|p| p.truncate().dot(c) + p.w - p.truncate().abs().dot(e) >= 0.0)
            || self
                .view
                .iter()
                .any(|p| p.truncate().dot(c) + p.w + p.truncate().abs().dot(e) < 0.0)
    }
    /// Full containment, not a visibility test: intersecting bounds need the
    /// slow path. NaN is never accepted as a safe bound.
    pub fn contains(&self, lo: Vec3, hi: Vec3) -> bool {
        let center = (lo + hi) * 0.5;
        let extent = (hi - lo) * 0.5;
        self.planes
            .iter()
            .all(|p| p.truncate().dot(center) + p.w - p.truncate().abs().dot(extent) >= 0.0)
    }
}

/// Values GE sees before model/UV decode. Keep packed decode in the original
/// model and texture matrices, so generated float vertices use exactly the
/// same coordinate frame as the original signed/unsigned 16-bit stream.
pub fn packed_vertex(v: &pp::PackedVertex) -> pp::Vertex {
    pp::Vertex {
        pos: v.pos.map(|v| v as f32 / 32768.0),
        uv: v.uv.map(|v| v as f32 / 32768.0),
        color: v.color,
    }
}

#[derive(Clone, Copy, Default)]
struct Vertex {
    clip: Vec4,
    pos: Vec3,
    uv: Vec2,
    color: Vec4,
}
impl Vertex {
    fn new(v: pp::Vertex, clip: Vec4) -> Self {
        let pos = Vec3::from_array(v.pos);
        Self {
            clip,
            pos,
            uv: Vec2::from_array(v.uv),
            color: Vec4::from_array(v.color.to_le_bytes().map(|v| v as f32)),
        }
    }
    fn lerp(&self, other: &Self, t: f32) -> Self {
        Self {
            clip: self.clip.lerp(other.clip, t),
            pos: self.pos.lerp(other.pos, t),
            uv: self.uv.lerp(other.uv, t),
            color: self.color.lerp(other.color, t),
        }
    }
    fn output(self) -> pp::Vertex {
        pp::Vertex {
            pos: self.pos.to_array(),
            uv: self.uv.to_array(),
            color: u32::from_le_bytes(
                self.color
                    .to_array()
                    .map(|v| (v.clamp(0.0, 255.0) + 0.5) as u8),
            ),
        }
    }
}
fn code(p: Vec4) -> u8 {
    ((p.x < -p.w) as u8)
        | (((p.x > p.w) as u8) << 1)
        | (((p.y < -p.w) as u8) << 2)
        | (((p.y > p.w) as u8) << 3)
        | (((p.z < -p.w) as u8) << 4)
        | (((p.z > p.w) as u8) << 5)
}
fn plane(input: &[Vertex], output: &mut [Vertex; 8], p: Vec4) -> usize {
    let Some(last) = input.last() else {
        return 0;
    };
    let mut a = last;
    let mut da = p.dot(a.clip);
    let mut count = 0;
    for b in input {
        let db = p.dot(b.clip);
        if (da > 0.0 && db < 0.0) || (da < 0.0 && db > 0.0) {
            output[count] = a.lerp(b, (da / (da - db)).clamp(0.0, 1.0));
            count += 1;
        }
        if db >= 0.0 {
            output[count] = *b;
            count += 1;
        }
        a = b;
        da = db;
    }
    count
}

/// None preserves the original indexed triangle byte-for-byte. Some(n)
/// replaces it with n float vertices in the same winding/order (n may be 0).
/// UV and colour are interpolated before division, not in screen space.
#[allow(dead_code)] // Direct entry point for host geometry regressions/offline QA.
pub fn triangle(
    input: [pp::Vertex; 3],
    mvp: Mat4,
    out: &mut [pp::Vertex; MAX_VERTICES],
) -> Option<usize> {
    let coordinates = input.map(|v| mvp * Vec3::from_array(v.pos).extend(1.0));
    if !needs_clip(&coordinates) {
        return None;
    }
    clipped_triangle(input, coordinates, out)
}
fn needs_clip(coordinates: &[Vec4; 3]) -> bool {
    // The hardware/rasterizer already rejects these; retain the original
    // stream rather than manufacturing offscreen replacement geometry.
    if code(coordinates[0]) & code(coordinates[1]) & code(coordinates[2]) != 0 {
        return false;
    }
    // Most triangles in an intersecting AABB are themselves wholly safe.
    // Avoid colour conversion, polygon initialization and near clipping for
    // those. On PSP even small aggregate copies can lower to bytewise memcpy.
    if coordinates
        .iter()
        .all(|p| p.z + p.w >= 0.0 && p.x.abs() <= GUARD_X * p.w && p.y.abs() <= GUARD_Y * p.w)
    {
        return false;
    }
    true
}
fn clipped_triangle(
    input: [pp::Vertex; 3],
    coordinates: [Vec4; 3],
    out: &mut [pp::Vertex; MAX_VERTICES],
) -> Option<usize> {
    let vertices = core::array::from_fn::<_, 3, _>(|i| Vertex::new(input[i], coordinates[i]));
    let mut first = [Vertex::default(); 8];
    let mut second = [Vertex::default(); 8];
    let (mut a, mut b) = (&mut first, &mut second);
    let mut count = plane(&vertices, a, PLANES[0]);
    if a[..count]
        .iter()
        .all(|v| PLANES[1..].iter().all(|p| p.dot(v.clip) >= 0.0))
    {
        // Includes near intersections GE can already clip correctly.
        return None;
    }
    for p in &PLANES[1..] {
        count = plane(&a[..count], b, *p);
        core::mem::swap(&mut a, &mut b);
    }
    let mut written = 0;
    for i in 1..count.saturating_sub(1) {
        for v in [a[0], a[i], a[i + 1]] {
            out[written] = v.output();
            written += 1;
        }
    }
    Some(written)
}

pub enum Run<'a> {
    Original(core::ops::Range<usize>),
    Clipped(&'a [pp::Vertex]),
}
#[derive(Default)]
pub struct Work {
    pub scanned: u32,
    pub replaced: u32,
    pub vertices: u32,
}
/// Walk disjoint, ordered index ranges selected by the AABB slow-path test.
/// Emit unchanged index spans and replacement fans in original triangle order.
/// The caller consumes each temporary fan before the next callback.
pub fn walk(
    indices: &[u16],
    ranges: &[(usize, usize)],
    mvp: Mat4,
    mut position: impl FnMut(u16) -> Vec3,
    mut decode: impl FnMut(u16) -> pp::Vertex,
    mut emit: impl FnMut(Run<'_>),
) -> Work {
    let mut work = Work::default();
    let mut output = [pp::Vertex::default(); MAX_VERTICES];
    let mut safe_start = 0;
    let mut previous_end = 0;
    for &(start, count) in ranges {
        debug_assert!(start >= previous_end && (start + count) <= indices.len());
        debug_assert!(start % 3 == 0 && count % 3 == 0);
        previous_end = start + count;
        work.scanned += count as u32 / 3;
        for at in (start..start + count).step_by(3) {
            let coordinates = core::array::from_fn(|i| mvp * position(indices[at + i]).extend(1.0));
            if !needs_clip(&coordinates) {
                continue;
            }
            let input = [
                decode(indices[at]),
                decode(indices[at + 1]),
                decode(indices[at + 2]),
            ];
            if let Some(n) = clipped_triangle(input, coordinates, &mut output) {
                if safe_start < at {
                    emit(Run::Original(safe_start..at));
                }
                if n != 0 {
                    emit(Run::Clipped(&output[..n]));
                }
                safe_start = at + 3;
                work.replaced += 1;
                work.vertices += n as u32;
            }
        }
    }
    if safe_start < indices.len() {
        emit(Run::Original(safe_start..indices.len()));
    }
    work
}

/// Immutable index-stream blocks. Bounds are in the GE input frame (packed
/// positions normalized by 32768, before their model decode), never posed skin
/// space. Keys distinguish vertex storage, layout and exact LOD index span.
const BLOCK_INDICES: usize = 16 * 3;
const CACHE_BUDGET: usize = 256 * 1024;
const MAP_RESERVE: usize = 1024; // Initial root capacity / node split slack.
#[derive(Clone, Copy)]
struct Bounds {
    center: Vec3,
    extent: Vec3,
}
#[derive(Default)]
pub struct BlockCache {
    entries: alloc::collections::BTreeMap<[u32; 4], alloc::boxed::Box<[Bounds]>>,
    bytes: usize,
}
impl BlockCache {
    pub fn bytes(&self) -> u32 {
        // Accounted budget, including metadata slack; not allocator telemetry.
        (self.bytes
            + if self.entries.is_empty() {
                0
            } else {
                MAP_RESERVE
            }) as u32
    }
    /// Append only risk blocks, retaining source order and merging adjacent
    /// blocks. No cache admission may turn into missing geometry: when full,
    /// the original whole range remains on the slow path.
    pub fn append_ranges(
        &mut self,
        key: [u32; 4],
        indices: &[u16],
        offset: usize,
        guard: &Guard,
        mut position: impl FnMut(u16) -> Vec3,
        out: &mut alloc::vec::Vec<(usize, usize)>,
    ) -> u32 {
        let count = indices.len().div_ceil(BLOCK_INDICES);
        if !self.entries.contains_key(&key) {
            // 64 bytes conservatively covers the key, boxed slice and B-tree
            // node/bookkeeping per entry on the 32-bit target.
            let cost = count * core::mem::size_of::<Bounds>() + 64;
            if cost > CACHE_BUDGET - MAP_RESERVE - self.bytes {
                append_range(out, offset, indices.len());
                return 0;
            }
            let blocks: alloc::vec::Vec<_> = indices
                .chunks(BLOCK_INDICES)
                .map(|chunk| {
                    let mut lo = Vec3::splat(f32::INFINITY);
                    let mut hi = Vec3::splat(f32::NEG_INFINITY);
                    for &i in chunk {
                        let p = position(i);
                        lo = lo.min(p);
                        hi = hi.max(p);
                    }
                    let center = (lo + hi) * 0.5;
                    let extent = (hi - lo) * 0.5;
                    Bounds {
                        center,
                        extent: extent
                            + center.abs() * (4.0 * f32::EPSILON)
                            + Vec3::splat(0.000001),
                    }
                })
                .collect();
            self.entries.insert(key, blocks.into_boxed_slice());
            self.bytes += cost;
        }
        let mut skipped = 0;
        for (i, bounds) in self.entries[&key].iter().enumerate() {
            let start = i * BLOCK_INDICES;
            let count = BLOCK_INDICES.min(indices.len() - start);
            if guard.block_safe(bounds) {
                skipped += count as u32 / 3;
            } else {
                append_range(out, offset + start, count);
            }
        }
        skipped
    }
}
fn append_range(out: &mut alloc::vec::Vec<(usize, usize)>, start: usize, count: usize) {
    if count == 0 {
        return;
    }
    if let Some((previous, length)) = out.last_mut() {
        if *previous + *length == start {
            *length += count;
            return;
        }
    }
    out.push((start, count));
}
