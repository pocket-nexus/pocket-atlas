//! Display-only density sampling of subpixel static light fields. Source
//! points and phases never move. Animated/blinking and isolated lights stay
//! complete; dense static scintillation uses stable ranks and smooth weights.
//! Expected display energy is preserved before framebuffer quantization and
//! clipping, not per-pixel radiance or exact individual-light visibility.
use alloc::{collections::BTreeMap, format, string::String, vec::Vec};
use core::{mem::size_of, ptr};
use glam::{Mat4, Vec3};
use pocket3d_place as pc;

use crate::gl::*;

const CELL: f32 = 4.0;
const MAX_POINTS: usize = 262_144;
const MAX_DIMENSION: i32 = 1024;

#[derive(Clone, Copy)]
struct Point {
    position: Vec3,
    radius: f32,
    rank: f32,
    vertex: u32,
}
struct Field {
    draw: usize,
    base: usize,
    count: usize,
    first: usize,
    end: usize,
    minimum: f32,
    maximum: f32,
}

/// One compiler page. Original field indices remain separate for culling;
/// only their final selected indices are remapped into this page.
pub struct Page {
    pub draw: usize,
    pub first: usize,
    pub count: usize,
    fields: Vec<(usize, u32)>,
}

/// Immutable compact source data retained by Scene. No full GEOM copy.
#[derive(Default)]
pub struct Sources {
    fields: Vec<Field>,
    points: Vec<Point>,
    count: usize,
    // Immutable display appearance identity, including protected/moving points.
    // Original LightPoint RGB/phase/geometry remains untouched.
    palette: Vec<[u8; 3]>,
    color_rows: Vec<u16>,
    pages: Vec<Page>,
}
impl Sources {
    pub fn new(meta: &pc::Meta, geometry: &[u8]) -> Result<Self, String> {
        let count = meta
            .draws
            .iter()
            .filter(|d| d.layout == pc::VertexLayout::Lights)
            .try_fold(0usize, |n, d| n.checked_add(d.vertex_count as usize))
            .ok_or("light LOD source count overflow")?;
        if count == 0 {
            return Ok(Self::default());
        }
        // The optional density cache stays bounded. Appearance rows are also
        // needed by protected/oversized fields drawn without density sampling.
        let density = count <= MAX_POINTS;
        let mut out = Self::default();
        out.color_rows.try_reserve_exact(count)
            .map_err(|_| "field appearance row allocation")?;
        let mut colors = BTreeMap::new();
        out.fields
            .try_reserve_exact(
                meta.draws
                    .iter()
                    .filter(|d| d.layout == pc::VertexLayout::Lights)
                    .count(),
            )
            .map_err(|_| "light LOD field allocation")?;
        // A source candidate is 24 bytes, bounded by six MiB across a scene.
        out.points
            .try_reserve_exact(if density { count } else { 0 })
            .map_err(|_| "light LOD point allocation")?;
        for (draw, d) in meta.draws.iter().enumerate() {
            if d.layout != pc::VertexLayout::Lights {
                continue;
            }
            let field = meta
                .materials
                .get(d.material as usize)
                .and_then(|m| m.lights)
                .ok_or("light LOD material missing field parameters")?;
            if d.vertex_count as usize > pc::LIGHT_POINTS_PER_DRAW
                || d.vertex_count.checked_mul(pc::LIGHT_POINT_STRIDE as u32)
                    != Some(d.vertices.size)
            {
                return Err("light LOD invalid vertex range".into());
            }
            let first = out.points.len();
            for (vertex, p) in pc::parts::slice(geometry, &d.vertices)?
                .chunks_exact(pc::LIGHT_POINT_STRIDE)
                .enumerate()
            {
                let rgb = [p[8], p[9], p[10]];
                let row = if let Some(&row) = colors.get(&rgb) {
                    row
                } else {
                    let row = u16::try_from(out.palette.len())
                        .map_err(|_| "field appearance exceeds 65536 source colours")?;
                    out.palette.try_reserve(1)
                        .map_err(|_| "field appearance palette allocation")?;
                    out.palette.push(rgb);
                    colors.insert(rgb, row);
                    row
                };
                out.color_rows.push(row);
                let f = |o| f32::from_le_bytes(p[o..o + 4].try_into().unwrap());
                let path = Vec3::new(f(20), f(24), f(28));
                let cycles = f(32);
                if !path.is_finite() || !cycles.is_finite() || !f(16).is_finite() {
                    return Err("light LOD non-finite source".into());
                }
                if !density { continue; }
                // Keep all moving lights and periodic/duty blink unchanged.
                // A zero-cycle path is a constant offset, not motion.
                if p[11] == 0
                    || p[36] != 0
                    || p[37] != 255
                    || (cycles != 0.0 && path != Vec3::ZERO)
                    || f(16) <= 0.0
                {
                    continue;
                }
                let snorm = |o| (i16::from_le_bytes([p[o], p[o + 1]]) as f32 / 32767.0).max(-1.0);
                let phase = snorm(6);
                let position = Vec3::new(snorm(0), snorm(2), snorm(4)) * Vec3::from(d.pos_scale)
                    + Vec3::from(d.pos_offset)
                    + path * (phase - libm::floorf(phase));
                if !position.is_finite() {
                    return Err("light LOD non-finite position".into());
                }
                // Local vertex identity stays fixed through camera/time changes.
                let mut h = d
                    .vertices
                    .offset
                    .wrapping_add((vertex as u32).wrapping_mul(0x9e3779b9))
                    .wrapping_add((draw as u32).wrapping_mul(0x85ebca6b));
                h ^= h >> 16;
                h = h.wrapping_mul(0x7feb352d);
                h ^= h >> 15;
                h = h.wrapping_mul(0x846ca68b);
                h ^= h >> 16;
                // 23 bits keep both endpoints strictly inside (0,1) in f32.
                let rank = ((h >> 9) as f32 + 0.5) * (1.0 / 8_388_608.0);
                out.points.push(Point {
                    position,
                    radius: f(16),
                    rank,
                    vertex: vertex as u32,
                });
            }
            out.fields.push(Field {
                draw,
                base: out.count,
                count: d.vertex_count as usize,
                first,
                end: out.points.len(),
                minimum: field.min_pixels,
                maximum: field.max_pixels,
            });
            out.count += d.vertex_count as usize;
        }
        Ok(out)
    }
    pub fn bytes(&self) -> usize {
        self.fields.capacity() * size_of::<Field>() + self.points.capacity() * size_of::<Point>()
            + self.palette.capacity() * 3 + self.color_rows.capacity() * 2
            + self.pages.capacity() * size_of::<Page>()
            + self.pages.iter().map(|p| p.fields.capacity() * size_of::<(usize, u32)>()).sum::<usize>()
    }
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }
    pub fn palette(&self) -> &[[u8; 3]] { &self.palette }
    pub fn color_rows(&self) -> &[u16] { &self.color_rows }
    pub fn color_offset(&self, draw: usize) -> Option<usize> {
        self.fields.binary_search_by_key(&draw, |f| f.draw).ok()
            .map(|i| self.fields[i].base * 2)
    }
    pub fn pages(&self) -> &[Page] { &self.pages }

    pub fn with_pages(mut self, recipe: &pc::ipod::LightPages) -> Result<Self, String> {
        let original = core::mem::take(&mut self.color_rows);
        let mut rows = Vec::new();
        rows.try_reserve_exact(original.len()).map_err(|_| "light page color rows allocation")?;
        self.pages.try_reserve_exact(recipe.pages.len()).map_err(|_| "light page lookup allocation")?;
        for page in &recipe.pages {
            let first = rows.len();
            let mut fields = Vec::new();
            fields.try_reserve_exact(page.fields.len()).map_err(|_| "light page field lookup allocation")?;
            for entry in &page.fields {
                let i = self.fields.binary_search_by_key(&(entry.draw as usize), |f| f.draw)
                    .map_err(|_| "light page source field missing")?;
                let field = &mut self.fields[i];
                if rows.len() - first != entry.first as usize { return Err("light page source order mismatch".into()); }
                rows.extend_from_slice(&original[field.base..field.base + field.count]);
                field.base = first + entry.first as usize;
                fields.push((i, entry.first));
            }
            if rows.len() - first != page.vertex_count as usize { return Err("light page source count mismatch".into()); }
            self.pages.push(Page { draw: page.fields[0].draw as usize, first,
                count: page.vertex_count as usize, fields });
        }
        if rows.len() != original.len() { return Err("light page source incomplete".into()); }
        self.color_rows = rows;
        Ok(self)
    }
}

#[derive(Clone, Copy)]
pub struct View {
    pub vp: Mat4,
    pub eye: Vec3,
    pub width: i32,
    pub height: i32,
    pub tan_half: f32,
    pub point_limit: f32,
}
impl View {
    fn key(self) -> [u32; 23] {
        let mut key = [0; 23];
        key[..16].copy_from_slice(&self.vp.to_cols_array().map(f32::to_bits));
        key[16..19].copy_from_slice(&self.eye.to_array().map(f32::to_bits));
        key[19..].copy_from_slice(&[
            self.width as u32,
            self.height as u32,
            self.tan_half.to_bits(),
            self.point_limit.to_bits(),
        ]);
        key
    }
}

#[derive(Clone, Copy, Default)]
pub struct Draw {
    pub weight_offset: usize,
    pub index_offset: usize,
    pub count: i32,
}
#[derive(Clone, Copy)]
struct Projection {
    vertex: usize,
    cell: usize,
    x: f32,
    y: f32,
    diameter: f32,
    rank: f32,
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn retention(density: f32, diameter: f32) -> f32 {
    1.0 - (2.0 / 3.0) * smooth(8.0, 24.0, density) * (1.0 - smooth(0.75, 1.0, diameter))
}
fn display_weight(rank: f32, probability: f32) -> f32 {
    if probability >= 1.0 {
        return 1.0;
    }
    // A symmetric smooth threshold has integral p over uniform ranks, as
    // its support stays inside [0,1]. Thus expected weight = integral/p = 1.
    let band = (probability * 0.15).min(1.0 - probability);
    smooth(-band, band, probability - rank) / probability
}

/// Performance Effects owns this cache and the three mutable buffer pairs.
/// Full profile never constructs it. Animated time is deliberately not a key:
/// movement/blink streams remain unchanged and GPU scintillation keeps time.
pub struct LightLod {
    buffers: [u32; 6],
    slot: usize,
    valid: bool,
    key: Option<[u32; 23]>,
    gpu_sizes: [usize; 3],
    weights: Vec<f32>,
    indices: Vec<u16>,
    draws: Vec<Draw>,
    page_draws: Vec<Draw>,
    remapped: Vec<u16>,
    visible: Vec<bool>,
    density: Vec<f32>,
    projected: Vec<Projection>,
}
impl LightLod {
    fn cpu(source: &Sources) -> Result<Self, String> {
        let mut out = Self {
            buffers: [0; 6],
            slot: 0,
            valid: false,
            key: None,
            gpu_sizes: [0; 3],
            weights: Vec::new(),
            indices: Vec::new(),
            draws: Vec::new(),
            page_draws: Vec::new(),
            remapped: Vec::new(),
            visible: Vec::new(),
            density: Vec::new(),
            projected: Vec::new(),
        };
        out.weights
            .try_reserve_exact(source.count)
            .map_err(|_| "light LOD weights allocation")?;
        out.weights.resize(source.count, 1.0);
        out.indices
            .try_reserve_exact(source.count)
            .map_err(|_| "light LOD indices allocation")?;
        out.draws
            .try_reserve_exact(source.fields.len())
            .map_err(|_| "light LOD draws allocation")?;
        out.draws.resize(source.fields.len(), Draw::default());
        if !source.pages.is_empty() {
            out.page_draws.try_reserve_exact(source.pages.len()).map_err(|_| "light page draw allocation")?;
            out.page_draws.resize(source.pages.len(), Draw::default());
            out.remapped.try_reserve_exact(source.count).map_err(|_| "light page index allocation")?;
        }
        out.visible
            .try_reserve_exact(source.fields.len())
            .map_err(|_| "light LOD visibility allocation")?;
        out.visible.resize(source.fields.len(), false);
        out.projected
            .try_reserve_exact(source.points.len())
            .map_err(|_| "light LOD projection allocation")?;
        Ok(out)
    }
    pub unsafe fn new(source: &Sources) -> Result<Self, String> {
        let mut out = Self::cpu(source)?;
        glGenBuffers(6, out.buffers.as_mut_ptr());
        let error = glGetError();
        if error != 0 || out.buffers.contains(&0) {
            return Err(format!("create light LOD buffers: GL {error:x}"));
        }
        Ok(out)
    }
    pub fn bytes(&self) -> (usize, usize) {
        (
            self.gpu_sizes.iter().sum(),
            self.weights.capacity() * 4
                + self.indices.capacity() * 2
                + self.draws.capacity() * size_of::<Draw>()
                + self.page_draws.capacity() * size_of::<Draw>() + self.remapped.capacity() * 2
                + self.visible.capacity() * size_of::<bool>()
                + self.density.capacity() * 4
                + self.projected.capacity() * size_of::<Projection>(),
        )
    }
    fn select(
        &mut self,
        source: &Sources,
        view: View,
        mut visible: impl FnMut(usize) -> bool,
    ) -> Result<(), String> {
        if !view.vp.is_finite()
            || !view.eye.is_finite()
            || !view.tan_half.is_finite()
            || view.tan_half <= 0.0
            || !view.point_limit.is_finite()
            || view.point_limit < 1.0
            || view.width <= 0
            || view.height <= 0
        {
            return Err("light LOD invalid view".into());
        }
        self.weights.fill(1.0);
        self.indices.clear();
        self.projected.clear();
        let bounded = view.width <= MAX_DIMENSION && view.height <= MAX_DIMENSION;
        let columns = (view.width as usize + 3) / 4 + 3;
        if bounded {
            let cells = columns * ((view.height as usize + 3) / 4 + 3);
            if cells > self.density.len() {
                self.density
                    .try_reserve_exact(cells - self.density.len())
                    .map_err(|_| "light LOD density allocation")?;
            }
            self.density.resize(cells, 0.0);
            self.density.fill(0.0);
        }
        for (i, field) in source.fields.iter().enumerate() {
            self.visible[i] = visible(field.draw);
            if !self.visible[i] || !bounded {
                continue;
            }
            let minimum = (field.minimum * view.height as f32 / 272.0)
                .max(2.0)
                .min(view.point_limit);
            let maximum = (field.maximum * view.height as f32 / 272.0)
                .max(minimum)
                .min(view.point_limit);
            for point in &source.points[field.first..field.end] {
                let vertex = field.base + point.vertex as usize;
                let clip = view.vp * point.position.extend(1.0);
                if !clip.is_finite() {
                    continue;
                }
                if clip.w <= 0.0 {
                    self.weights[vertex] = 0.0;
                    continue;
                }
                let x = (clip.x / clip.w * 0.5 + 0.5) * view.width as f32;
                let y = (clip.y / clip.w * 0.5 + 0.5) * view.height as f32;
                let d = point.position.distance(view.eye).max(0.01);
                let diameter = point.radius * (view.height as f32 / view.tan_half) / d;
                let half = diameter.clamp(minimum, maximum) * 0.5 + 1.0;
                // One extra pixel keeps floating-point clip boundaries safe.
                if x < -half
                    || x > view.width as f32 + half
                    || y < -half
                    || y > view.height as f32 + half
                {
                    self.weights[vertex] = 0.0;
                    continue;
                }
                if diameter >= 1.0
                    || x < 0.0
                    || x >= view.width as f32
                    || y < 0.0
                    || y >= view.height as f32
                {
                    continue;
                }
                let gx = x / CELL + 1.0;
                let gy = y / CELL + 1.0;
                let ix = gx as usize;
                let iy = gy as usize;
                let fx = gx - ix as f32;
                let fy = gy - iy as f32;
                let cell = iy * columns + ix;
                let w = [
                    (1.0 - fx) * (1.0 - fy),
                    fx * (1.0 - fy),
                    (1.0 - fx) * fy,
                    fx * fy,
                ];
                for (offset, weight) in [0, 1, columns, columns + 1].into_iter().zip(w) {
                    self.density[cell + offset] += weight;
                }
                self.projected.push(Projection {
                    vertex,
                    cell,
                    x: fx,
                    y: fy,
                    diameter,
                    rank: point.rank,
                });
            }
        }
        for p in &self.projected {
            let row0 = self.density[p.cell] * (1.0 - p.x) + self.density[p.cell + 1] * p.x;
            let row1 = self.density[p.cell + columns] * (1.0 - p.x)
                + self.density[p.cell + columns + 1] * p.x;
            let density = row0 * (1.0 - p.y) + row1 * p.y;
            self.weights[p.vertex] = display_weight(p.rank, retention(density, p.diameter));
        }
        for (i, field) in source.fields.iter().enumerate() {
            let first = self.indices.len();
            if self.visible[i] {
                for vertex in 0..field.count {
                    if self.weights[field.base + vertex] > 0.0 {
                        self.indices.push(vertex as u16);
                    }
                }
            }
            self.draws[i] = Draw {
                weight_offset: field.base * 4,
                index_offset: first * 2,
                count: (self.indices.len() - first) as i32,
            };
        }
        if !source.pages.is_empty() {
            self.remapped.clear();
            for (i, page) in source.pages.iter().enumerate() {
                let first = self.remapped.len();
                for &(field, base) in &page.fields {
                    let draw = self.draws[field];
                    let start = draw.index_offset / 2;
                    for &index in &self.indices[start..start + draw.count as usize] {
                        let mapped = (index as u32).checked_add(base)
                            .filter(|&v| v < page.count as u32)
                            .ok_or("light page remap outside vertices")?;
                        self.remapped.push(u16::try_from(mapped).map_err(|_| "light page index overflow")?);
                    }
                }
                self.page_draws[i] = Draw { weight_offset: page.first * 4,
                    index_offset: first * 2, count: (self.remapped.len() - first) as i32 };
            }
            core::mem::swap(&mut self.indices, &mut self.remapped);
        }
        Ok(())
    }
    fn prepare_with(
        &mut self,
        source: &Sources,
        view: View,
        visible: impl FnMut(usize) -> bool,
        mut upload: impl FnMut(usize, &[u16], &[f32]) -> Result<(), String>,
    ) -> Result<bool, String> {
        let key = view.key();
        if self.valid && self.key == Some(key) {
            return Ok(false);
        }
        // Failed selection/upload must not leave old ranges usable or cache a
        // new key. The caller returns the error before any field draw.
        self.valid = false;
        self.key = None;
        self.select(source, view, visible)?;
        let next = (self.slot + 1) % 3;
        upload(next, &self.indices, &self.weights)?;
        self.gpu_sizes[next] = self.indices.len() * 2 + self.weights.len() * 4;
        self.slot = next;
        self.key = Some(key);
        self.valid = true;
        Ok(true)
    }
    pub unsafe fn prepare(
        &mut self,
        source: &Sources,
        view: View,
        visible: impl FnMut(usize) -> bool,
    ) -> Result<bool, String> {
        let buffers = self.buffers;
        self.prepare_with(source, view, visible, |slot, indices, weights| {
            for (target, name, size, data) in [
                (
                    GL_ELEMENT_ARRAY_BUFFER,
                    buffers[slot * 2],
                    indices.len() * 2,
                    indices.as_ptr() as *const core::ffi::c_void,
                ),
                (
                    GL_ARRAY_BUFFER,
                    buffers[slot * 2 + 1],
                    weights.len() * 4,
                    weights.as_ptr() as *const core::ffi::c_void,
                ),
            ] {
                glBindBuffer(target, name);
                glBufferData(
                    target,
                    size as _,
                    if size == 0 { ptr::null() } else { data },
                    GL_DYNAMIC_DRAW,
                );
                let error = glGetError();
                if error != 0 || name == 0 {
                    return Err(format!("upload light LOD buffer: GL {error:x}"));
                }
            }
            Ok(())
        })
    }
    pub fn draw(&self, source: &Sources, draw: usize) -> Option<Draw> {
        if !self.valid || !source.pages.is_empty() {
            return None;
        }
        source
            .fields
            .binary_search_by_key(&draw, |f| f.draw)
            .ok()
            .map(|i| self.draws[i])
    }
    pub fn page(&self, page: usize) -> Option<Draw> {
        self.valid.then(|| self.page_draws.get(page).copied()).flatten()
    }
    pub fn buffers(&self) -> (u32, u32) {
        (self.buffers[self.slot * 2], self.buffers[self.slot * 2 + 1])
    }
}
impl Drop for LightLod {
    fn drop(&mut self) {
        if self.buffers.iter().any(|&v| v != 0) {
            unsafe {
                glDeleteBuffers(6, self.buffers.as_ptr());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    use alloc::vec;

    fn view() -> View {
        View {
            vp: Mat4::IDENTITY,
            eye: Vec3::new(0.0, 0.0, 2.0),
            width: 64,
            height: 64,
            tan_half: 1.0,
            point_limit: 64.0,
        }
    }
    fn cloud(n: usize) -> Sources {
        Sources {
            fields: vec![Field {
                draw: 0,
                base: 0,
                count: n,
                first: 0,
                end: n,
                minimum: 2.0,
                maximum: 10.0,
            }],
            points: (0..n)
                .map(|i| Point {
                    position: Vec3::ZERO,
                    radius: 0.001,
                    rank: (i as f32 + 0.5) / n as f32,
                    vertex: i as u32,
                })
                .collect(),
            count: n,
            palette: Vec::new(),
            color_rows: Vec::new(),
            pages: Vec::new(),
        }
    }
    #[test]
    fn page_remap_preserves_original_visibility_density_weights_and_failed_uploads() {
        fn fields() -> Sources {
            let mut source = cloud(96);
            source.fields = (0..3).map(|i| Field { draw: i, base: i*32, count: 32,
                first: i*32, end: (i+1)*32, minimum: 2.0, maximum: 10.0 }).collect();
            for (i, point) in source.points.iter_mut().enumerate() {
                point.vertex = (i % 32) as u32;
                point.position.x = (i / 32) as f32 * 0.01;
            }
            source.color_rows = (0..96).collect();
            source
        }
        let original = fields();
        let recipe = pc::ipod::LightPages { version: 1, source_hash: String::new(), payload_hash: String::new(),
            pages: vec![
                pc::ipod::LightPage { vertices: pc::Range { offset:0, size:64*48 }, vertex_count:64,
                    fields: vec![pc::ipod::LightPageField {draw:0,first:0},pc::ipod::LightPageField {draw:2,first:32}] },
                pc::ipod::LightPage { vertices: pc::Range {offset:64*48,size:32*48},vertex_count:32,
                    fields:vec![pc::ipod::LightPageField {draw:1,first:0}] },
            ] };
        let paged = fields().with_pages(&recipe).unwrap();
        assert_eq!(paged.color_rows(), (0..32).chain(64..96).chain(32..64).collect::<Vec<_>>());
        let mut old_lod = LightLod::cpu(&original).unwrap();
        let mut new_lod = LightLod::cpu(&paged).unwrap();
        for (step, hidden) in [None,Some(0),Some(2),Some(1),None].into_iter().enumerate() {
            let mut camera = view();
            camera.eye.x = step as f32 * 0.002;
            camera.vp.w_axis.x = step as f32 * 0.003;
            old_lod.prepare_with(&original,camera,|draw| Some(draw)!=hidden,|_,_,_|Ok(())).unwrap();
            new_lod.prepare_with(&paged,camera,|draw| Some(draw)!=hidden,|_,_,_|Ok(())).unwrap();
            for (i, field) in original.fields.iter().enumerate() {
                let mapped = &paged.fields[i];
                assert_eq!(&old_lod.weights[field.base..field.base+field.count],
                    &new_lod.weights[mapped.base..mapped.base+mapped.count]);
            }
            for (page_index, page) in paged.pages().iter().enumerate() {
                let actual = new_lod.page(page_index).unwrap();
                let expected:Vec<_> = page.fields.iter().flat_map(|&(field,base)| {
                    let draw = old_lod.draw(&original,field).unwrap();
                    old_lod.indices[draw.index_offset/2..draw.index_offset/2+draw.count as usize]
                        .iter().map(move |&i| i+base as u16)
                }).collect();
                assert_eq!(&new_lod.indices[actual.index_offset/2..actual.index_offset/2+actual.count as usize], &expected);
                assert_eq!(actual.weight_offset,page.first*4);
            }
            assert!(new_lod.draw(&paged,0).is_none(), "source-local ranges must never index a paged buffer");
        }
        let mut camera=view();camera.eye.x=2.0;
        assert!(new_lod.prepare_with(&paged,camera,|_|true,|_,_,_|Err("injected upload".into())).is_err());
        assert!(new_lod.page(0).is_none());
        let mut uploads=0;
        new_lod.prepare_with(&paged,camera,|_|true,|_,_,_|{uploads+=1;Ok(())}).unwrap();
        assert_eq!(uploads,1);
        assert!(new_lod.page(0).is_some());
    }

    #[test]
    fn source_classification_preserves_motion_blink_and_snorm_constant_paths() {
        let (mut meta, _, _) = crate::validation::tests::fixture();
        meta.materials[0].kind = pc::Kind::Lights;
        meta.materials[0].lights = Some(pc::LightField {
            min_pixels: 2.0,
            max_pixels: 10.0,
            period: 120.0,
            ..Default::default()
        });
        let draw = &mut meta.draws[0];
        draw.layout = pc::VertexLayout::Lights;
        draw.vertex_count = 6;
        draw.vertices = pc::Range {
            offset: 0,
            size: 240,
        };
        draw.pos_offset = [0.0; 3];
        draw.pos_scale = [1.0; 3];
        let mut geometry = vec![0u8; 240];
        for p in geometry.chunks_exact_mut(40) {
            p[11] = 255;
            p[37] = 255;
            p[16..20].copy_from_slice(&0.5f32.to_le_bytes());
        }
        geometry[40 + 20..40 + 24].copy_from_slice(&10.0f32.to_le_bytes());
        geometry[40 + 32..40 + 36].copy_from_slice(&1.0f32.to_le_bytes()); // moving
        geometry[80 + 36] = 1; // periodic blink, even when full duty
        geometry[120 + 37] = 128; // duty mask, even with zero cycles
        geometry[160 + 11] = 0; // non-twinkle landmark
        geometry[200 + 6..200 + 8].copy_from_slice(&16384i16.to_le_bytes());
        geometry[200 + 20..200 + 24].copy_from_slice(&10.0f32.to_le_bytes()); // constant path
        let source = Sources::new(&meta, &geometry).unwrap();
        assert_eq!(source.palette(), [[0, 0, 0]]);
        assert_eq!(source.color_rows(), [0; 6]);
        assert_eq!(source.color_offset(0), Some(0));
        assert_eq!(
            source.points.iter().map(|p| p.vertex).collect::<Vec<_>>(),
            [0, 5]
        );
        assert_eq!(source.points[1].position.x, 16384.0 / 32767.0 * 10.0);
        let original = geometry.clone();
        assert_eq!(
            Sources::new(&meta, &geometry).unwrap().points[0].rank,
            source.points[0].rank
        );
        assert_eq!(geometry, original);
        meta.draws.push(meta.draws[0].clone());
        let aliases = Sources::new(&meta, &geometry).unwrap();
        assert_eq!(aliases.palette(), [[0, 0, 0]]);
        assert_eq!(aliases.color_rows().len(), 12);
        assert_eq!(aliases.color_offset(1), Some(12));
        assert_ne!(aliases.points[0].rank, aliases.points[2].rank);
        assert!(aliases.points.iter().all(|p| p.rank > 0.0 && p.rank < 1.0));
        meta.draws.pop();
        meta.draws[0].vertices.size = 239;
        assert!(Sources::new(&meta, &geometry).is_err());
        meta.draws[0].vertex_count = MAX_POINTS as u32 + 1;
        assert!(Sources::new(&meta, &geometry).is_err()); // per-draw bounds still validated
        meta.draws[0].vertex_count = pc::LIGHT_POINTS_PER_DRAW as u32;
        meta.draws[0].vertices.size = (pc::LIGHT_POINTS_PER_DRAW * pc::LIGHT_POINT_STRIDE) as u32;
        let geometry = geometry[..40].repeat(pc::LIGHT_POINTS_PER_DRAW);
        meta.draws = vec![meta.draws[0].clone(); MAX_POINTS / pc::LIGHT_POINTS_PER_DRAW + 1];
        let oversized = Sources::new(&meta, &geometry).unwrap();
        assert!(oversized.is_empty()); // bounded optional density optimization
        assert_eq!(oversized.points.capacity(), 0);
        assert_eq!(oversized.color_rows().len(), meta.draws.len() * pc::LIGHT_POINTS_PER_DRAW);
        assert_eq!(oversized.palette(), [[0, 0, 0]]); // appearance and all lights remain usable
    }
    #[test]
    fn only_dense_subpixel_candidates_are_sampled_and_protected_vertices_survive() {
        let mut source = cloud(400);
        // Protected animated/blinking/non-twinkle vertices have no Point entry.
        source.count += 10;
        source.fields[0].count += 10;
        source.points.extend([
            Point {
                position: Vec3::new(-0.8, 0.0, 0.0),
                radius: 0.001,
                rank: 0.99,
                vertex: 410,
            },
            Point {
                position: Vec3::new(0.8, 0.0, 0.0),
                radius: 0.001,
                rank: 0.99,
                vertex: 411,
            },
            Point {
                position: Vec3::ZERO,
                radius: 1.0,
                rank: 0.99,
                vertex: 412,
            },
        ]);
        source.count += 3;
        source.fields[0].count += 3;
        source.fields[0].end = source.points.len();
        let mut lod = LightLod::cpu(&source).unwrap();
        lod.select(&source, view(), |_| true).unwrap();
        assert!(lod.indices.len() < 180);
        for i in 400..413 {
            assert!(lod.indices.contains(&i));
            assert_eq!(lod.weights[i as usize], 1.0);
        }
        let energy: f64 = lod.weights[..400].iter().map(|&x| x as f64).sum();
        assert!((energy / 400.0 - 1.0).abs() < 0.001);
        assert_eq!(lod.draws[0].count, lod.indices.len() as i32);
        assert!(lod.indices.windows(2).all(|p| p[0] < p[1]));
    }
    #[test]
    fn density_grid_and_rank_threshold_are_continuous_across_camera_cell_boundaries() {
        let source = cloud(48);
        let mut lod = LightLod::cpu(&source).unwrap();
        let mut a = view();
        a.vp.w_axis.x = -0.000001;
        lod.select(&source, a, |_| true).unwrap();
        let before = lod.weights.clone();
        a.vp.w_axis.x = 0.000001;
        lod.select(&source, a, |_| true).unwrap();
        assert!(before
            .iter()
            .zip(&lod.weights)
            .all(|(a, b)| (a - b).abs() < 0.001));
        for density in [7.99999, 8.0, 8.00001, 23.99999, 24.0, 24.00001] {
            let p = retention(density, 0.5);
            assert!((1.0 / 3.0 - 1e-6..=1.0).contains(&p));
            for i in 0..1000 {
                let rank = (i as f32 + 0.5) / 1000.0;
                let before = display_weight(rank, p);
                let after = display_weight(rank, retention(density + 0.00001, 0.5));
                assert!((before - after).abs() < 0.001);
            }
        }
    }

    #[test]
    fn sparse_sprite_crossing_the_view_edge_is_kept_with_a_full_pixel_margin() {
        let mut source = cloud(1);
        let mut lod = LightLod::cpu(&source).unwrap();
        source.points[0].position.x = 1.02;
        lod.select(&source, view(), |_| true).unwrap();
        assert_eq!(lod.indices, [0]);
        assert_eq!(lod.weights, [1.0]);
        source.points[0].position.x = 1.08;
        lod.select(&source, view(), |_| true).unwrap();
        assert!(lod.indices.is_empty());
        // A large sprite receives its own actual extent rather than the
        // subpixel density footprint. The visible edge stays in the stream.
        source.points[0].radius = 1.0;
        source.fields[0].maximum = 64.0;
        lod.select(&source, view(), |_| true).unwrap();
        assert_eq!(lod.indices, [0]);
    }
    #[test]
    fn soft_selection_has_unit_expected_display_energy_and_bounded_gain() {
        for p in [1.0, 0.999, 0.95, 0.9, 0.7, 0.5, 1.0 / 3.0] {
            let mut sum = 0.0f64;
            for i in 0..100_000 {
                let w = display_weight((i as f32 + 0.5) / 100_000.0, p);
                assert!(w.is_finite() && (0.0..=3.000001).contains(&w));
                sum += w as f64;
            }
            assert!((sum / 100_000.0 - 1.0).abs() < 0.00001, "p={p}: {sum}");
        }
    }
    #[test]
    fn exact_view_cache_ignores_animation_and_upload_failure_invalidates_all_ranges() {
        let source = cloud(100);
        let mut lod = LightLod::cpu(&source).unwrap();
        let mut v = view();
        assert!(lod
            .prepare_with(&source, v, |_| true, |_, _, _| Ok(()))
            .unwrap());
        let original = lod.indices.clone();
        let old_slot = lod.slot;
        for _ in 0..20 {
            assert!(!lod
                .prepare_with(
                    &source,
                    v,
                    |_| panic!("cached visibility"),
                    |_, _, _| panic!("cached upload")
                )
                .unwrap());
        }
        assert_eq!(lod.indices, original);
        v.eye.x = 0.1;
        assert!(lod
            .prepare_with(
                &source,
                v,
                |_| true,
                |_, _, _| Err("injected upload".into())
            )
            .is_err());
        assert_eq!(lod.slot, old_slot);
        assert!(lod.key.is_none());
        assert!(lod.draw(&source, 0).is_none());
        assert!(lod
            .prepare_with(&source, v, |_| true, |_, _, _| Ok(()))
            .unwrap());
        assert!(lod.draw(&source, 0).is_some());
        v.width = 2048;
        lod.select(&source, v, |_| true).unwrap();
        assert_eq!(lod.indices.len(), source.count);
        assert!(lod.weights.iter().all(|&w| w == 1.0));
        v.vp.x_axis.x = f32::NAN;
        assert!(lod
            .prepare_with(&source, v, |_| true, |_, _, _| panic!("invalid upload"))
            .is_err());
        assert!(lod.draw(&source, 0).is_none());
    }
    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to cooked packs; offline selection only"]
    fn real_light_pages_preserve_every_selected_point_and_weight_while_camera_moves() {
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").unwrap();
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") { continue; }
            let bytes=std::fs::read(&path).unwrap();
            let pack=pc::ipod::parse(&bytes).unwrap();
            let metadata:pc::ipod::Metadata=serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
            let Some(recipe)=&metadata.ipod_recipes.light_pages else {continue};
            let meta=&metadata.scene;
            let geometry=pack.section(pc::TAG_GEOMETRY).unwrap();
            pc::ipod::light_pages::validate(meta,geometry,pack.section(pc::ipod::TAG_LIGHT_PAGES).unwrap(),recipe).unwrap();
            let source=Sources::new(meta,geometry).unwrap();
            let paged=Sources::new(meta,geometry).unwrap().with_pages(recipe).unwrap();
            let mut old=LightLod::cpu(&source).unwrap();let mut new=LightLod::cpu(&paged).unwrap();
            for shot in &meta.camera.shots {for fraction in [0.0f32,0.5,1.0] {
                let eye=Vec3::from(shot.from.pos).lerp(Vec3::from(shot.to.pos),fraction);
                let target=Vec3::from(shot.from.target).lerp(Vec3::from(shot.to.target),fraction);
                let fov=shot.from.fov+(shot.to.fov-shot.from.fov)*fraction;
                let vp=glam::camera::rh::proj::opengl::perspective(fov.to_radians(),1.5,0.25,100000.0)
                    *glam::camera::rh::view::look_at_mat4(eye,target,Vec3::Y);
                let view=View{vp,eye,width:480,height:320,tan_half:libm::tanf(fov.to_radians()*0.5),point_limit:64.0};
                let visible=|i:usize|{let d=&meta.draws[i];crate::effects::in_frustum(vp,Vec3::from(d.min),Vec3::from(d.max))};
                old.select(&source,view,visible).unwrap();new.select(&paged,view,visible).unwrap();
                assert_eq!(old.indices.len(),new.indices.len());
                for (i, field) in source.fields.iter().enumerate() {
                    let mapped=&paged.fields[i];
                    assert_eq!(&old.weights[field.base..field.base+field.count],&new.weights[mapped.base..mapped.base+mapped.count]);
                }
                for (page_index,page) in paged.pages.iter().enumerate() {
                    let mut expected=Vec::new();
                    for &(i,base) in &page.fields {
                        let range=old.draws[i];
                        expected.extend(old.indices[range.index_offset/2..range.index_offset/2+range.count as usize]
                            .iter().map(|&v|v+base as u16));
                    }
                    let range=new.page_draws[page_index];
                    assert_eq!(&new.indices[range.index_offset/2..range.index_offset/2+range.count as usize],&expected);
                }
                std::println!("{} {} fraction {}: {} identical points/weights, {} fields -> {} pages",
                    meta.name,shot.name,fraction,new.indices.len(),old.draws.iter().filter(|d|d.count>0).count(),
                    new.page_draws.iter().filter(|d|d.count>0).count());
                checked+=1;
            }}
        }
        assert!(checked>0);
    }

    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to cooked packs; offline selection only"]
    fn measured_real_field_reduction_and_selection_cost() {
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").unwrap();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let pack = pc::ipod::parse(&bytes).unwrap();
            let meta = pack.meta().unwrap();
            let source = Sources::new(&meta, pack.section(pc::TAG_GEOMETRY).unwrap()).unwrap();
            if source.is_empty() {
                continue;
            }
            let mut lod = LightLod::cpu(&source).unwrap();
            std::println!(
                "{} source bytes {}, fields {}, candidates {}, source points {}",
                meta.name,
                source.bytes(),
                source.fields.len(),
                source.points.len(),
                source.count
            );
            for width in [160, 192, 320] {
                for shot in &meta.camera.shots {
                    for fraction in [0.0f32, 0.5, 1.0] {
                        let height = width * 2 / 3;
                        let eye = Vec3::from(shot.from.pos).lerp(Vec3::from(shot.to.pos), fraction);
                        let target =
                            Vec3::from(shot.from.target).lerp(Vec3::from(shot.to.target), fraction);
                        let fov = shot.from.fov + (shot.to.fov - shot.from.fov) * fraction;
                        let tan_half = libm::tanf(fov * core::f32::consts::PI / 360.0);
                        let vp = glam::camera::rh::proj::opengl::perspective(
                            fov * core::f32::consts::PI / 180.0,
                            width as f32 / height as f32,
                            0.25,
                            100000.0,
                        ) * glam::camera::rh::view::look_at_mat4(eye, target, Vec3::Y);
                        let v = View {
                            vp,
                            eye,
                            width,
                            height,
                            tan_half,
                            point_limit: 64.0,
                        };
                        let visible = |i: usize| {
                            let d = &meta.draws[i];
                            crate::effects::in_frustum(vp, Vec3::from(d.min), Vec3::from(d.max))
                        };
                        let before: usize = source
                            .fields
                            .iter()
                            .filter(|f| visible(f.draw))
                            .map(|f| f.count)
                            .sum();
                        let started = std::time::Instant::now();
                        for _ in 0..10 {
                            lod.select(&source, v, visible).unwrap();
                        }
                        let elapsed = started.elapsed().as_secs_f64() * 100.0;
                        std::println!(
                            "{} f{} {}x{}: {} -> {}, CPU select {:.3}ms, cache CPU {}",
                            shot.name,
                            fraction,
                            width,
                            height,
                            before,
                            lod.indices.len(),
                            elapsed,
                            lod.bytes().1
                        );
                        assert!(lod.indices.len() <= before);
                        for (i, f) in source.fields.iter().enumerate() {
                            if !visible(f.draw) {
                                continue;
                            }
                            let range = lod.draws[i];
                            let indices = &lod.indices[range.index_offset / 2
                                ..range.index_offset / 2 + range.count as usize];
                            assert!(indices.iter().all(|&v| v < f.count as u16));
                            let candidates = &source.points[f.first..f.end];
                            for vertex in 0..f.count {
                                if candidates
                                    .binary_search_by_key(&(vertex as u32), |p| p.vertex)
                                    .is_err()
                                {
                                    assert!(
                                        indices.binary_search(&(vertex as u16)).is_ok(),
                                        "protected source point dropped"
                                    );
                                    assert_eq!(lod.weights[f.base + vertex], 1.0);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
