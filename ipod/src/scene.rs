//! Streaming PLIP loader. Only one place is resident; texture staging is
//! released after each upload, and geometry lives in GL buffers. Only the
//! eligible static index ranges remain on the CPU for visible-range batching.
use crate::{gl::*, validation};
use alloc::{ffi::CString, format, string::String, vec, vec::Vec};
use core::ffi::c_void;
use glam::{Mat4, Quat, Vec3};
use pocket3d_place as pc;
#[derive(Clone, Copy, Default)]
pub struct Light {
    pub pos: Vec3,
    pub color: Vec3,
    pub dir: Vec3,
    pub reach: f32,
    pub spot: [f32; 2],
    pub dynamic: bool,
    pub right: Vec3,
    pub up: Vec3,
    pub size: [f32; 2],
}
#[derive(Clone, Copy)]
pub struct LdrColor {
    pub vao: u32,
    pub texture: Option<u32>,
    pub offset: u32,
    /// Float world-position/UV page; None uses the original geometry layout.
    pub page: Option<u32>,
    /// Canonical active display state; original materials remain unchanged.
    pub state: Option<u32>,
    /// Add to a source full/LOD/cluster index before streaming this page.
    pub base_vertex: u32,
    /// 1: frame-zero dynamic lighting; 2: weak emission shares albedo;
    /// 4: Gouraud sun; 8: diffuse-only stream with independent emission map.
    /// 16: static planar wet diffuse; 32: glass diffuse without coverage.
    /// All colors are graded before sRGB texture modulation.
    pub flags: u32,
}
/// An optional, proven two-sided display LOD. Indices stay source-local;
/// streaming adds LdrColor::base_vertex exactly as for original indices.
#[derive(Clone, Copy)]
pub struct IndexOverrideRef<'a> {
    pub indices: &'a [u16],
    pub state: u32,
}
struct DisplayIndices {
    draw: u32,
    source: pc::Range,
    state: u32,
    indices: Vec<u16>,
}
/// One affine transform applies to every vertex with the same exact UNORM8
/// influence tuple. Keep its bind-space box once; pose updates visit tuples,
/// never the full vertex stream. This also fixes culling for bodies extending
/// beyond the former joint-zero +/-2m heuristic.
struct InfluenceBounds {
    tuple: [u8; 8],
    min: Vec3,
    max: Vec3,
}
struct SkinBounds {
    source: pc::Range,
    skin: u32,
    groups: Vec<InfluenceBounds>,
    min: Vec3,
    max: Vec3,
}
impl SkinBounds {
    fn build(meta: &pc::Meta, geometry: &[u8]) -> Result<Vec<Self>, String> {
        use alloc::collections::BTreeMap;
        let mut sources = BTreeMap::new();
        for d in &meta.draws {
            if let Some(skin) = d.skin {
                sources
                    .entry((d.vertices.offset, d.vertices.size, skin))
                    .or_insert(d);
            }
        }
        let mut out = Vec::new();
        for ((_, _, skin), d) in sources {
            let mut tuples = BTreeMap::<[u8; 8], (Vec3, Vec3)>::new();
            for v in pc::parts::slice(geometry, &d.vertices)?.chunks_exact(60) {
                let p = Vec3::from(pc::ipod::floats::<3>(v, 0)?);
                let tuple = v[52..60].try_into().unwrap();
                let entry = tuples.entry(tuple).or_insert((p, p));
                entry.0 = entry.0.min(p);
                entry.1 = entry.1.max(p);
            }
            out.push(Self {
                source: d.vertices.clone(),
                skin,
                groups: tuples
                    .into_iter()
                    .map(|(tuple, (min, max))| InfluenceBounds { tuple, min, max })
                    .collect(),
                min: Vec3::ZERO,
                max: Vec3::ZERO,
            });
        }
        Ok(out)
    }
    fn update(&mut self, palette: &[f32]) {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for group in &self.groups {
            let mut rows = [[0f32; 4]; 3];
            let mut magnitude = [0f32; 3];
            let position_magnitude = group.min.abs().max(group.max.abs());
            for k in 0..4 {
                // Match the shader's normalized byte weights. Do not divide
                // by their sum: legacy source palettes need not sum to 255.
                let weight = group.tuple[k + 4] as f32 / 255.0;
                if weight == 0.0 {
                    continue;
                }
                let at = group.tuple[k] as usize * 12;
                for r in 0..3 {
                    let values = &palette[at + r * 4..at + r * 4 + 4];
                    magnitude[r] += weight
                        * (Vec3::from_slice(values).abs().dot(position_magnitude)
                            + values[3].abs());
                    for c in 0..4 {
                        rows[r][c] += weight * values[c];
                    }
                }
            }
            let center = (group.min + group.max) * 0.5;
            let extent = (group.max - group.min) * 0.5;
            let transformed =
                Vec3::from_array(rows.map(|r| Vec3::from_slice(&r).dot(center) + r[3]));
            let spread = Vec3::from_array(rows.map(|r| Vec3::from_slice(&r).abs().dot(extent)));
            // Center/extent equals union of the eight affine-transformed
            // corners. Pad f32 accumulation/interpolation rounding outward.
            // Include magnitudes before palette cancellation: averaging rows
            // and transforming is algebraically equal to the shader's sum of
            // transformed points but has a different f32 operation order.
            let pad = (Vec3::from_array(magnitude) + transformed.abs() + spread + Vec3::ONE)
                * (64.0 * f32::EPSILON);
            min = min.min(transformed - spread - pad);
            max = max.max(transformed + spread + pad);
        }
        self.min = min;
        self.max = max;
    }
}
pub struct Scene {
    /// Performance assets are loaded together and never required by Retina.
    pub performance: bool,
    pub meta: pc::Meta,
    pub textures: Vec<u32>,
    /// Material-indexed display environments for water/glass; zero for others.
    /// Atmosphere and material environment strength are included before grading.
    pub display_environments: Vec<u32>,
    index_overrides: Vec<DisplayIndices>,
    effective_lods: pc::ipod::display_lods::EffectiveLods,
    pub ipod_recipes: pc::ipod::Recipes,
    display_environment_textures: Vec<u32>,
    pub geometry: u32,
    geometry_source_bytes: usize,
    geometry_usage: Option<crate::geometry_usage::GeometryUsage>,
    /// Per-point sin/cos of the decoded phase; display fields use slot 1.
    /// The original packed LightPoint stream remains authoritative.
    pub light_phase_buffer: u32,
    /// Validated IPLF float vertices; only Optimized owns this buffer.
    pub light_page_buffer: u32,
    pub light_phase_offsets: Vec<Option<u32>>,
    pub light_lod_source: crate::light_lod::Sources,
    pub vaos: Vec<u32>,
    pub anim: Vec<f32>,
    pub world: Vec<Mat4>,
    // Fixed 3x4 row palettes; shared by all draws and passes using a skin.
    bone_palettes: Vec<Vec<f32>>,
    skin_bounds: Vec<SkinBounds>,
    pub lights: Vec<Light>,
    pub emissive: Vec<f32>,
    pub door: f32,
    pub gpu_bytes: usize,
    /// CPU index payload and lookup backing storage; excludes allocator headers.
    pub cpu_index_bytes: usize,
    pub mesh_clusters: Option<crate::mesh_clusters::MeshClusters>,
    pub ldr_colors: Vec<Option<LdrColor>>,
    pub display_states: Vec<pc::display::State>,
    pub ldr_color_bytes: usize,
    ldr_color_buffer: u32,
    package_buffer: u32,
    ldr_vaos: Vec<u32>,
    index_cache: IndexCache,
}

struct IndexRange {
    offset: u32,
    count: u32,
    start: usize,
}

/// View-independent part of the shared lights_v scintillation angle. Build
/// from the final GLES signed-normalized phase, not the original source seed.
/// Duplicate vertex ranges share one auxiliary range and never duplicate GEOM.
struct LightPhases {
    data: Vec<[f32; 2]>,
    offsets: Vec<Option<u32>>,
}
impl LightPhases {
    fn pair(packed: i16) -> [f32; 2] {
        let phase = (packed as f32 / 32767.0).max(-1.0);
        // Same rounded constant as lights_v.cg: 6.2831853 * 13.7.
        let angle = phase * (6.2831853f32 * 13.7f32);
        [libm::sinf(angle), libm::cosf(angle)]
    }

    fn new(meta: &pc::Meta, geometry: &[u8]) -> Result<Self, String> {
        use alloc::collections::BTreeMap;
        let mut ranges = BTreeMap::new();
        let mut pages = Vec::new();
        let mut offsets = Vec::new();
        offsets
            .try_reserve_exact(meta.draws.len())
            .map_err(|_| "light phase lookup allocation failed")?;
        let mut bytes = 0u32;
        for d in &meta.draws {
            if d.layout != pc::VertexLayout::Lights {
                offsets.push(None);
                continue;
            }
            if d.vertex_count.checked_mul(pc::LIGHT_POINT_STRIDE as u32) != Some(d.vertices.size) {
                return Err("invalid light phase vertex range".into());
            }
            let range = pc::parts::slice(geometry, &d.vertices)?;
            let key = (d.vertices.offset, d.vertices.size);
            let offset = if let Some(&offset) = ranges.get(&key) {
                offset
            } else {
                let offset = bytes;
                bytes = d
                    .vertex_count
                    .checked_mul(8)
                    .and_then(|n| bytes.checked_add(n))
                    .filter(|&n| n <= i32::MAX as u32)
                    .ok_or("light phase GPU buffer size overflow")?;
                ranges.insert(key, offset);
                pages.push(range);
                offset
            };
            offsets.push(Some(offset));
        }
        let mut data = Vec::new();
        data.try_reserve_exact(bytes as usize / 8)
            .map_err(|_| "light phase data allocation failed")?;
        for page in pages {
            for vertex in page.chunks_exact(pc::LIGHT_POINT_STRIDE) {
                data.push(Self::pair(i16::from_le_bytes([vertex[6], vertex[7]])));
            }
        }
        Ok(Self { data, offsets })
    }

    fn for_pages(meta: &pc::Meta, geometry: &[u8], recipe: &pc::ipod::LightPages) -> Result<Self, String> {
        let count = recipe.pages.iter().try_fold(0usize, |n, p| n.checked_add(p.vertex_count as usize))
            .ok_or("light page phase count overflow")?;
        let mut data = Vec::new();
        data.try_reserve_exact(count).map_err(|_| "light page phase allocation")?;
        let mut offsets = vec![None; meta.draws.len()];
        for page in &recipe.pages {
            for field in &page.fields {
                let draw = &meta.draws[field.draw as usize];
                offsets[field.draw as usize] = Some(u32::try_from(data.len() * 8)
                    .map_err(|_| "light page phase offset overflow")?);
                for vertex in pc::parts::slice(geometry, &draw.vertices)?.chunks_exact(pc::LIGHT_POINT_STRIDE) {
                    data.push(Self::pair(i16::from_le_bytes([vertex[6], vertex[7]])));
                }
            }
        }
        Ok(Self { data, offsets })
    }
}

/// Temporary upload data for Products; the original vertex/index payload and
/// every LOD remain untouched. Identical ranges and RGB seeds are reused.
struct PackageParameters {
    data: Vec<f32>,
    offsets: Vec<Option<u32>>,
}
impl PackageParameters {
    fn new(meta: &pc::Meta, geometry: &[u8]) -> Result<Self, String> {
        use alloc::collections::BTreeMap;
        let mut ranges = BTreeMap::new();
        let mut pages = Vec::new();
        let mut offsets = Vec::new();
        offsets
            .try_reserve_exact(meta.draws.len())
            .map_err(|_| "package lookup allocation failed")?;
        let mut bytes = 0u32;
        for d in &meta.draws {
            if d.layout != pc::VertexLayout::Static
                || meta
                    .materials
                    .get(d.material as usize)
                    .is_none_or(|m| m.kind != pc::Kind::Products)
            {
                offsets.push(None);
                continue;
            }
            if d.vertex_count.checked_mul(pc::ipod::stride(d.layout)) != Some(d.vertices.size) {
                return Err("invalid package vertex range".into());
            }
            let range = pc::parts::slice(geometry, &d.vertices)?;
            let key = (d.vertices.offset, d.vertices.size);
            let offset = if let Some(&offset) = ranges.get(&key) {
                offset
            } else {
                let offset = bytes;
                bytes = d
                    .vertex_count
                    .checked_mul(8)
                    .and_then(|n| bytes.checked_add(n))
                    .filter(|&n| n <= i32::MAX as u32)
                    .ok_or("package GPU buffer size overflow")?;
                ranges.insert(key, offset);
                pages.push(range);
                offset
            };
            offsets.push(Some(offset));
        }
        let mut data = Vec::new();
        data.try_reserve_exact(bytes as usize / 4)
            .map_err(|_| "package data allocation failed")?;
        let mut seeds = BTreeMap::new();
        for page in pages {
            for vertex in page.chunks_exact(pc::ipod::stride(pc::VertexLayout::Static) as usize) {
                let rgb: [u8; 3] = vertex[pc::ipod::COLOR..pc::ipod::COLOR + 3].try_into().unwrap();
                let params = seeds
                    .entry(rgb)
                    .or_insert_with(|| pc::products::package_params(rgb));
                data.extend_from_slice(params);
            }
        }
        Ok(Self { data, offsets })
    }
}

#[derive(Default)]
struct IndexCache {
    ranges: Vec<IndexRange>,
    data: Vec<u16>,
}

impl IndexCache {
    #[cfg(test)]
    fn new(meta: &pc::Meta, geometry: &[u8], display: &[ColorEntry]) -> Result<Self, String> {
        Self::with_lods(meta, geometry, display, &Default::default())
    }
    fn with_lods(meta: &pc::Meta, geometry: &[u8], display: &[ColorEntry], lods: &pc::ipod::display_lods::EffectiveLods) -> Result<Self, String> {
        let mut float_draws = vec![false; meta.draws.len()];
        for c in display.iter().filter(|c| c.page.is_some()) {
            float_draws[c.draw as usize] = true;
        }
        let eligible = |i: usize, d: &pc::Draw| {
            float_draws[i]
                || (d.layout == pc::VertexLayout::Baked
                    && d.node.is_none()
                    && d.skin.is_none()
                    && meta
                        .materials
                        .get(d.material as usize)
                        .is_some_and(|m| m.blend == pc::Blend::Opaque && m.depth_write))
        };
        let count = meta
            .draws
            .iter()
            .enumerate()
            .filter(|(i, d)| eligible(*i, d))
            .try_fold(0usize, |n, (i, _)| {
                n.checked_add(lods.get(meta, i).len()).and_then(|n| n.checked_add(1))
            })
            .ok_or("CPU index range count overflow")?;
        let mut ranges: Vec<pc::Range> = Vec::new();
        ranges
            .try_reserve_exact(count)
            .map_err(|_| "CPU index table allocation failed")?;
        for (i, d) in meta
            .draws
            .iter()
            .enumerate()
            .filter(|(i, d)| eligible(*i, d))
        {
            for (range, count) in core::iter::once((&d.indices, d.index_count))
                .chain(lods.get(meta,i).iter().map(|l| (&l.indices, l.index_count)))
            {
                if count.checked_mul(2) != Some(range.size) || range.offset % 2 != 0 {
                    return Err("CPU index range size/alignment mismatch".into());
                }
                let end = range
                    .offset
                    .checked_add(range.size)
                    .ok_or("CPU index range overflow")?;
                if geometry.get(range.offset as usize..end as usize).is_none() {
                    return Err("CPU index range outside GEOM".into());
                }
                if range.size > 0 {
                    ranges.push(range.clone());
                }
            }
        }
        ranges.sort_unstable_by_key(|r| r.offset);
        // Duplicate, overlapping and contiguous ranges share one CPU copy.
        // Gaps remain absent: unrelated vertices and other payloads never stay.
        let mut unique = 0;
        for i in 0..ranges.len() {
            if unique > 0 && ranges[i].offset <= ranges[unique - 1].offset + ranges[unique - 1].size
            {
                let end = (ranges[i].offset + ranges[i].size)
                    .max(ranges[unique - 1].offset + ranges[unique - 1].size);
                ranges[unique - 1].size = end - ranges[unique - 1].offset;
            } else {
                ranges.swap(unique, i);
                unique += 1;
            }
        }
        ranges.truncate(unique);
        let words = ranges
            .iter()
            .try_fold(0usize, |n, r| n.checked_add(r.size as usize / 2))
            .ok_or("CPU index payload size overflow")?;
        let mut out = Self::default();
        out.data
            .try_reserve_exact(words)
            .map_err(|_| "CPU index payload allocation failed")?;
        out.ranges
            .try_reserve_exact(ranges.len())
            .map_err(|_| "CPU index lookup allocation failed")?;
        for r in ranges {
            out.ranges.push(IndexRange {
                offset: r.offset,
                count: r.size / 2,
                start: out.data.len(),
            });
            let end = (r.offset + r.size) as usize;
            out.data.extend(
                geometry[r.offset as usize..end]
                    .chunks_exact(2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]])),
            );
        }
        Ok(out)
    }

    fn bytes(&self) -> usize {
        self.data.capacity() * core::mem::size_of::<u16>()
            + self.ranges.capacity() * core::mem::size_of::<IndexRange>()
    }

    fn get(&self, offset: u32, count: u32) -> Option<&[u16]> {
        if offset % 2 != 0 {
            return None;
        }
        offset.checked_add(count.checked_mul(2)?)?;
        let i = self
            .ranges
            .partition_point(|r| r.offset <= offset)
            .checked_sub(1)?;
        let range = &self.ranges[i];
        let relative = (offset - range.offset) / 2;
        if relative.checked_add(count)? > range.count {
            return None;
        }
        let start = range.start.checked_add(relative as usize)?;
        self.data.get(start..start.checked_add(count as usize)?)
    }
}
/// An open file remains the same inode throughout the stream. Every exit,
/// including a failed seek/short read, closes it through Drop.
struct PlaceFile {
    handle: *mut c_void,
    len: usize,
}
impl PlaceFile {
    fn open(path: &str) -> Result<Self, String> {
        Self::optional(path)?.ok_or_else(|| format!("Cannot open {path}"))
    }
    fn optional(path: &str) -> Result<Option<Self>, String> {
        let name = CString::new(path).map_err(|_| String::from("invalid place path"))?;
        let handle = unsafe { crate::fopen(name.as_ptr(), b"rb\0".as_ptr() as _) };
        if handle.is_null() {
            return Ok(None);
        }
        let mut file = Self { handle, len: 0 };
        unsafe {
            if crate::fseek(handle, 0, 2) != 0 {
                return Err("place file seek failed".into());
            }
            let size = crate::ftell(handle);
            if size < 0 {
                return Err("place file is truncated or too large to seek".into());
            }
            file.len = size as usize;
        }
        Ok(Some(file))
    }
    fn read(&mut self, offset: usize, size: usize) -> Result<Vec<u8>, String> {
        let end = offset
            .checked_add(size)
            .ok_or("place read range overflow")?;
        if end > self.len || offset > i32::MAX as usize || size > 128 * 1024 * 1024 {
            return Err("place read exceeds file or staging budget".into());
        }
        unsafe {
            if crate::fseek(self.handle, offset as i32, 0) != 0 {
                return Err("place seek failed".into());
            }
            let mut bytes = Vec::new();
            bytes
                .try_reserve_exact(size)
                .map_err(|_| String::from("place staging allocation failed"))?;
            bytes.resize(size, 0);
            if size != 0 && crate::fread(bytes.as_mut_ptr() as _, 1, size, self.handle) != size {
                return Err("place payload truncated during read".into());
            }
            Ok(bytes)
        }
    }
    fn section(&mut self, section: &pc::Section) -> Result<Vec<u8>, String> {
        self.payload(
            section,
            &pc::Range {
                offset: 0,
                size: section.size,
            },
        )
    }
    fn payload(&mut self, section: &pc::Section, range: &pc::Range) -> Result<Vec<u8>, String> {
        let absolute = validation::section_span(section, range, self.len)?;
        self.read(absolute.start, absolute.len())
    }
}
impl Drop for PlaceFile {
    fn drop(&mut self) {
        unsafe {
            crate::fclose(self.handle);
        }
    }
}

// Kept local to the optional iPod sidecar, independent from other target ABIs.
fn color_hash(bytes: &[u8]) -> String {
    format!("{:016x}", pc::content_hash::hash(bytes))
}
fn sidecar_path(path: &str, suffix: &str) -> String {
    let slash = path.rfind('/').map_or(0, |i| i + 1);
    let stem = path
        .rfind('.')
        .filter(|&i| i >= slash)
        .map_or(path, |i| &path[..i]);
    format!("{stem}.{suffix}")
}
fn color_path(path: &str, suffix: &str) -> String {
    sidecar_path(path, &format!("ipod-color.{suffix}"))
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorEntry {
    draw: u32,
    offset: u32,
    vertex_count: u32,
    texture: Option<u32>,
    flags: u32,
    page: Option<u32>,
    base_vertex: u32,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorPage {
    offset: u32,
    vertex_count: u32,
    state: u32,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppearanceRecipe {
    kind: String,
    version: u32,
    draws: Vec<u32>,
    textures: Vec<u32>,
    tile_size: u32,
    border: u32,
    parameterization: String,
    max_vertex_height_parameter_error: f32,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorMetadata {
    version: u32,
    identity: String,
    meta_hash: String,
    geometry_hash: String,
    animation_hash: String,
    texture_hash: String,
    colors_hash: String,
    colors_bytes: u32,
    #[serde(default)]
    vertex_bytes: Option<u32>,
    #[serde(default)]
    index_overrides: Vec<pc::ipod::DisplayIndexOverride>,
    draws: Vec<ColorEntry>,
    pages: Vec<ColorPage>,
    states: Vec<pc::display::State>,
    #[serde(default)]
    recipes: Vec<AppearanceRecipe>,
}
struct ColorFile {
    bytes: Vec<u8>,
    vertex_bytes: u32,
    index_overrides: Vec<pc::ipod::DisplayIndexOverride>,
    draws: Vec<ColorEntry>,
    pages: Vec<ColorPage>,
    states: Vec<pc::display::State>,
}
impl ColorFile {
    fn validate_float_geometry(&self, meta: &pc::Meta, geometry: &[u8]) -> Result<(), String> {
        let mut checked = alloc::collections::BTreeSet::new();
        for entry in self.draws.iter().filter(|e| e.page.is_some()) {
            let d = &meta.draws[entry.draw as usize];
            let decode: Vec<u32> = d
                .pos_offset
                .iter()
                .chain(&d.pos_scale)
                .chain(&d.uv_offset)
                .chain(&d.uv_scale)
                .map(|v| v.to_bits())
                .collect();
            if !checked.insert((
                entry.page,
                entry.base_vertex,
                d.vertices.offset,
                d.vertices.size,
                pc::ipod::stride(d.layout),
                entry.flags & 64,
                decode,
            )) {
                continue;
            }
            let stride = pc::ipod::stride(d.layout) as usize;
            let start = entry.offset as usize + entry.base_vertex as usize * 24;
            let source_end = d
                .vertices
                .offset
                .checked_add(d.vertices.size)
                .ok_or("LDR source vertex overflow")?;
            let source = geometry
                .get(d.vertices.offset as usize..source_end as usize)
                .ok_or("LDR source vertex range")?;
            for (i, v) in source.chunks_exact(stride).enumerate() {
                let position = pc::ipod::floats::<3>(v, pc::ipod::POSITION)?;
                let uv = pc::ipod::floats::<2>(v, pc::ipod::UV)?;
                let expected = [position[0], position[1], position[2], uv[0], uv[1]];
                for (k, value) in expected.iter().enumerate() {
                    let at = start + i * 24 + k * 4;
                    let actual = f32::from_le_bytes(self.bytes[at..at + 4].try_into().unwrap());
                    if entry.flags & 64 != 0 && k >= 3 {
                        if !actual.is_finite() || !(0.0..=1.0).contains(&actual) {
                            return Err("LDR appearance UV outside texture".into());
                        }
                    } else if actual != *value {
                        return Err("LDR float position/UV differs from source geometry".into());
                    }
                }
            }
        }
        Ok(())
    }
    fn validate_index_overrides(&self, meta: &pc::Meta, geometry: &[u8]) -> Result<Vec<DisplayIndices>, String> {
        let mut result = Vec::new();
        for entry in &self.index_overrides {
            let draw = meta.draws.get(entry.draw as usize).ok_or("LDR override draw reference")?;
            let color = self.draws.iter().find(|c| c.draw == entry.draw).ok_or("LDR override color reference")?;
            let start = color.base_vertex.checked_mul(24).and_then(|n| color.offset.checked_add(n))
                .ok_or("LDR override vertex offset overflow")?;
            let size = draw.vertex_count.checked_mul(24).ok_or("LDR override vertex size overflow")?;
            let vertex_range = pc::Range { offset: start, size };
            let vertices = pc::parts::slice(&self.bytes[..self.vertex_bytes as usize], &vertex_range).map_err(String::from)?;
            let source = pc::parts::slice(geometry, &entry.source).map_err(String::from)?;
            let indices: Vec<_> = source.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
            let expected = pc::ipod::display_indices::two_sided_indices(vertices, &indices)?
                .ok_or("LDR override source triangles are not exact reverse pairs")?;
            let actual = pc::parts::slice(&self.bytes, &entry.indices).map_err(String::from)?;
            if actual.len() != expected.len() * 2 || actual.chunks_exact(2)
                .zip(&expected).any(|(b, &i)| u16::from_le_bytes([b[0], b[1]]) != i)
            { return Err("LDR override indices differ from exact reverse-pair selection".into()); }
            result.push(DisplayIndices { draw: entry.draw, source: entry.source.clone(), state: entry.state, indices: expected });
        }
        result.sort_unstable_by_key(|entry| (entry.draw, entry.source.offset, entry.source.size));
        Ok(result)
    }
    fn load(
        path: &str,
        meta: &pc::Meta,
        meta_hash: &str,
        geometry_hash: &str,
        animation_hash: &str,
        texture_hash: &str,
    ) -> Result<Option<Self>, String> {
        let json = PlaceFile::optional(&color_path(path, "json"))?;
        let bin = PlaceFile::optional(&color_path(path, "bin"))?;
        let (mut json, mut bin) = match (json, bin) {
            (None, None) => return Ok(None),
            (Some(json), Some(bin)) => (json, bin),
            _ => return Err("LDR color sidecar is incomplete".into()),
        };
        let json_limit = meta
            .draws
            .len()
            .checked_mul(1024)
            .and_then(|n| n.checked_add(65536))
            .ok_or("color metadata budget overflow")?;
        if json.len > json_limit {
            return Err("LDR color metadata exceeds draw budget".into());
        }
        let data: ColorMetadata = serde_json::from_slice(&json.read(0, json.len)?)
            .map_err(|e| format!("LDR color metadata: {e}"))?;
        let vertex_bytes = match data.version {
            2 if data.vertex_bytes.is_none() && data.index_overrides.is_empty() => data.colors_bytes,
            3 => data.vertex_bytes.ok_or("LDR v3 vertex boundary missing")?,
            _ => return Err("LDR color version/override contract".into()),
        };
        if !matches!(data.version, 2 | 3)
            || data.identity != "fnv1a64-v1"
            || data.meta_hash != meta_hash
            || data.geometry_hash != geometry_hash
            || data.animation_hash != animation_hash
            || data.texture_hash != texture_hash
        {
            return Err("LDR colors do not match this place".into());
        }
        let budget = meta
            .draws
            .iter()
            .try_fold(0usize, |n, d| {
                n.checked_add((d.vertex_count as usize).checked_mul(24)?)
            })
            .ok_or("LDR color byte budget overflow")?;
        let index_budget = meta.draws.iter().try_fold(0usize, |sum, draw| {
            draw.lods.iter().try_fold(sum, |sum, lod| {
                sum.checked_add(lod.indices.size as usize / 2)?.checked_add(16)
            })
        }).ok_or("LDR index override budget overflow")?;
        let total_budget = budget.checked_add(index_budget).ok_or("LDR payload budget overflow")?;
        if bin.len != data.colors_bytes as usize
            || vertex_bytes as usize > budget || vertex_bytes as usize > bin.len
            || vertex_bytes % 4 != 0 || bin.len > total_budget
            || bin.len % 2 != 0
            || (data.version == 2 && bin.len % 4 != 0)
            || data.draws.len() > meta.draws.len()
            || data.pages.len() > data.draws.len()
            || data.states.len() > data.pages.len().saturating_add(data.index_overrides.len())
            || data.index_overrides.len() > meta.draws.iter().map(|d| d.lods.len()).sum::<usize>()
        {
            return Err("LDR color payload size mismatch".into());
        }
        let mut appearance = vec![None; meta.draws.len()];
        for recipe in &data.recipes {
            if recipe.kind != "products-appearance" || recipe.version != 1
                || recipe.parameterization != "uv-height-v1" || recipe.tile_size != 32
                || recipe.border != 2 || recipe.draws.is_empty() || recipe.textures.is_empty()
                || !recipe.max_vertex_height_parameter_error.is_finite()
                || !(0.0..=1.0 / 255.0).contains(&recipe.max_vertex_height_parameter_error)
            {
                return Err("LDR appearance recipe contract mismatch".into());
            }
            let mut used_textures = alloc::collections::BTreeSet::new();
            for &draw in &recipe.draws {
                let slot = appearance.get_mut(draw as usize).ok_or("LDR recipe draw reference")?;
                let entry = data.draws.iter().find(|e| e.draw == draw)
                    .ok_or("LDR recipe color draw missing")?;
                let texture = entry.texture.ok_or("LDR recipe texture missing")?;
                if slot.is_some() || entry.flags != 64 || !recipe.textures.contains(&texture) {
                    return Err("LDR appearance recipe draw mismatch".into());
                }
                *slot = Some(texture);
                used_textures.insert(texture);
            }
            if used_textures.len() != recipe.textures.len() {
                return Err("LDR appearance recipe unused or duplicate texture".into());
            }
        }
        let mut seen = vec![false; meta.draws.len()];
        let mut page_end = 0u32;
        let mut page_used = vec![false; data.pages.len()];
        let mut state_used = vec![false; data.states.len()];
        for (i, state) in data.states.iter().enumerate() {
            if data.states[..i].contains(state) {
                return Err("LDR duplicate display state".into());
            }
        }
        for page in &data.pages {
            if page.offset != page_end
                || page.vertex_count == 0
                || page.vertex_count > 65535
                || page.state as usize >= data.states.len()
            {
                return Err("LDR float page count/offset mismatch".into());
            }
            page_end = page
                .vertex_count
                .checked_mul(24)
                .and_then(|n| page.offset.checked_add(n))
                .ok_or("LDR float page overflow")?;
            if page_end > vertex_bytes {
                return Err("LDR float page outside payload".into());
            }
        }
        for entry in &data.draws {
            let d = meta
                .draws
                .get(entry.draw as usize)
                .ok_or("LDR color draw reference")?;
            let m = &meta.materials[d.material as usize];
            if seen[entry.draw as usize]
                || d.layout == pc::VertexLayout::Lights
                || entry.vertex_count != d.vertex_count
                || entry.flags & !127 != 0
                || ((entry.flags & 64 != 0) != appearance[entry.draw as usize].is_some())
                || (entry.flags & 8 != 0
                    && (m.kind != pc::Kind::Standard
                        || m.emission.is_none()
                        || m.emission_shade.is_some()
                        || entry.texture != m.albedo))
                || (!matches!(m.kind, pc::Kind::Standard | pc::Kind::Unlit | pc::Kind::Glass)
                    && !(m.kind == pc::Kind::Products && entry.flags & 64 != 0))
                || (entry.flags & 64 != 0
                    && (m.kind != pc::Kind::Products || entry.flags != 64
                        || entry.page.is_none() || entry.texture.is_none()
                        || m.uv_anim.is_some() || m.emission.is_some()))
                || ((entry.flags & 32 != 0) != (m.kind == pc::Kind::Glass))
                || (entry.flags & 32 != 0
                    && (entry.flags & (2 | 4 | 8 | 16) != 0 || entry.texture.is_some()))
                || ((entry.flags & 16 != 0) != m.wet.is_some())
                || (m.wet.is_some()
                    && !(m.kind == pc::Kind::Standard
                        && m.wet.as_ref().is_some_and(|w| w.planar && (0.0..=1.0).contains(&w.darken))
                        && d.layout == pc::VertexLayout::Baked
                        && d.node.is_none()
                        && d.skin.is_none()))
                || m.emissive_track.is_some()
            {
                return Err("LDR color draw contract mismatch".into());
            }
            seen[entry.draw as usize] = true;
            if let Some(index) = entry.page {
                let page = data
                    .pages
                    .get(index as usize)
                    .ok_or("LDR float page reference")?;
                let state = pc::display::State::for_draw(meta, d, entry.texture, entry.flags)
                    .map_err(String::from)?;
                if entry.offset != page.offset
                    || data.states[page.state as usize] != state
                    || d.node.is_some()
                    || d.skin.is_some()
                    || m.kind == pc::Kind::Glass
                    || m.blend != pc::Blend::Opaque
                    || !m.depth_write
                    || entry
                        .base_vertex
                        .checked_add(d.vertex_count)
                        .is_none_or(|end| end > page.vertex_count)
                {
                    return Err("LDR float page draw contract mismatch".into());
                }
                page_used[index as usize] = true;
                state_used[page.state as usize] = true;
            } else {
                let end = entry
                    .offset
                    .checked_add(
                        entry
                            .vertex_count
                            .checked_mul(4)
                            .ok_or("LDR color count overflow")?,
                    )
                    .ok_or("LDR color range overflow")?;
                if entry.offset % 4 != 0
                    || entry.offset < page_end
                    || end > vertex_bytes
                    || entry.base_vertex != 0
                {
                    return Err("LDR color range outside payload".into());
                }
            }
            if let Some(texture) = entry.texture {
                if meta.textures.get(texture as usize).is_none_or(|t| {
                    t.format != pc::TexFormat::Rgba8 || t.role != pc::TexRole::Color
                }) {
                    return Err("LDR color texture reference".into());
                }
            }
        }
        let mut seen_overrides = alloc::collections::BTreeSet::new();
        let mut index_ranges = Vec::new();
        for entry in &data.index_overrides {
            let draw = meta.draws.get(entry.draw as usize).ok_or("LDR override draw reference")?;
            let color = data.draws.iter().find(|c| c.draw == entry.draw).ok_or("LDR override color draw missing")?;
            let page = color.page.and_then(|i| data.pages.get(i as usize)).ok_or("LDR override requires float page")?;
            let original = data.states.get(page.state as usize).ok_or("LDR override source state")?;
            let actual = data.states.get(entry.state as usize).ok_or("LDR override state reference")?;
            let mut expected = original.clone();
            expected.cull = false;
            let end = entry.indices.offset.checked_add(entry.indices.size).ok_or("LDR override range overflow")?;
            if color.flags != 64 || *actual != expected
                || !draw.lods.iter().any(|lod| lod.indices.offset == entry.source.offset && lod.indices.size == entry.source.size)
                || (draw.indices.offset == entry.source.offset && draw.indices.size == entry.source.size)
                || entry.source.size == 0 || entry.source.size % 12 != 0
                || entry.indices.size != entry.source.size / 2
                || entry.indices.offset < vertex_bytes || entry.indices.offset % 2 != 0 || end as usize > bin.len
                || !seen_overrides.insert((entry.draw, entry.source.offset, entry.source.size))
            { return Err("LDR index override contract mismatch".into()); }
            index_ranges.push((entry.indices.offset, end));
            state_used[entry.state as usize] = true;
        }
        index_ranges.sort_unstable();
        if index_ranges.windows(2).any(|ranges| ranges[0].1 > ranges[1].0) {
            return Err("LDR index override ranges overlap".into());
        }
        let bytes = bin.read(0, bin.len)?;
        if color_hash(&bytes) != data.colors_hash {
            return Err("LDR color payload checksum mismatch".into());
        }
        if page_used.contains(&false) || state_used.contains(&false) {
            return Err("LDR unused float page".into());
        }
        for page in &data.pages {
            let end = page.offset as usize + page.vertex_count as usize * 24;
            for v in bytes[page.offset as usize..end].chunks_exact(24) {
                if v[..20]
                    .chunks_exact(4)
                    .any(|b| !f32::from_le_bytes(b.try_into().unwrap()).is_finite())
                {
                    return Err("LDR non-finite float vertex".into());
                }
            }
        }
        if data.draws.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("LDR color payload has no draws".into())
            };
        }
        Ok(Some(Self {
            bytes,
            vertex_bytes,
            index_overrides: data.index_overrides,
            draws: data.draws,
            pages: data.pages,
            states: data.states,
        }))
    }
}

unsafe fn check_gl(operation: &str) -> Result<(), String> {
    let error = glGetError();
    if error == GL_NO_ERROR {
        Ok(())
    } else {
        Err(format!("{operation}: GLES error 0x{error:04x}"))
    }
}

impl Scene {
    /// The scene's GLES context must remain current on the calling thread
    /// through loading, use and Drop (including the error cleanup path).
    #[cfg(test)]
    pub unsafe fn load(path: &str) -> Result<Self, String> {
        Self::load_for_profile(path, true)
    }

    /// Retina retains the complete original pack while skipping display-only
    /// sidecars, CPU selection data and auxiliary GLES resources. The caller
    /// must keep this scene's GLES context current through use and Drop.
    pub unsafe fn load_for_profile(path: &str, performance: bool) -> Result<Self, String> {
        let mut file = PlaceFile::open(path)?;
        let header = file.read(0, 16)?;
        let table_size = validation::place_header_size(&header, file.len)?;
        let table = file.read(0, table_size)?;
        let sections = validation::validate_container(&table, file.len)?;
        let section = |tag| {
            sections
                .iter()
                .find(|s| s.tag == tag)
                .ok_or_else(|| format!("missing section {tag:?}"))
        };
        let meta_bytes = file.section(section(pc::TAG_META)?)?;
        let meta_hash = color_hash(&meta_bytes);
        let metadata: pc::ipod::Metadata =
            serde_json::from_slice(&meta_bytes).map_err(|e| format!("place metadata: {e}"))?;
        let meta = metadata.scene;
        let ipod_recipes = metadata.ipod_recipes;
        crate::texture_storage::validate_recipes(&meta, &ipod_recipes)?;
        let compressed_section = sections.iter().find(|s| s.tag == pc::ipod::TAG_PVRTC);
        crate::texture_storage::validate_pvrtc_ranges(&ipod_recipes, compressed_section.map(|s| s.size))?;
        crate::texture_storage::validate_display_cubes(&meta, &ipod_recipes)?;
        let cube_section = sections.iter().find(|s| s.tag == pc::ipod::TAG_DISPLAY_CUBES);
        if cube_section.is_some_and(|s| s.align < 16 || s.offset % 16 != 0) {
            return Err("display cube section alignment".into());
        }
        crate::texture_storage::validate_display_cube_ranges(&ipod_recipes, cube_section.map(|s| s.size))?;
        let light_section = sections.iter().find(|s| s.tag == pc::ipod::TAG_LIGHT_PAGES);
        match (&ipod_recipes.light_pages, light_section) {
            (None, None) => {},
            (Some(_), Some(section)) => {
                let expected = meta.draws.iter().filter(|d| d.layout == pc::VertexLayout::Lights)
                    .try_fold(0u32, |n, d| d.vertex_count.checked_mul(pc::ipod::light_pages::STRIDE as u32)
                        .and_then(|size| n.checked_add(size))).ok_or("light page section size overflow")?;
                if section.align < 16 || section.offset % 16 != 0 || section.size != expected {
                    return Err("light page section size or alignment".into());
                }
            },
            _ => return Err("light page recipe/section presence mismatch".into()),
        }
        let tex = section(pc::TAG_TEXTURES)?;
        let geom = section(pc::TAG_GEOMETRY)?;
        let animation = section(pc::TAG_ANIMATION)?;
        if animation.size % 4 != 0 {
            return Err("animation alignment".into());
        }
        let anim_bytes = file.section(animation)?;
        let animation_hash = color_hash(&anim_bytes);
        let anim: Vec<f32> = anim_bytes
            .chunks_exact(4)
            .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        drop(anim_bytes);
        validation::validate(&meta, geom.size as usize, tex.size as usize, &anim)?;
        let mut texture_plan = if performance {
            if let Some(mut pipelines) = PlaceFile::optional(&sidecar_path(path, "pipelines.json"))?
            {
                let budget = meta
                    .draws
                    .len()
                    .checked_add(1)
                    .and_then(|n| n.checked_mul(4096))
                    .ok_or("texture usage table budget overflow")?;
                if pipelines.len > budget {
                    return Err("texture usage pipeline exceeds table budget".into());
                }
                crate::texture_usage::Plan::parse(&pipelines.read(0, pipelines.len)?, &meta)?
            } else {
                None
            }
        } else {
            None
        };
        if let Some(plan) = &mut texture_plan { plan.include_recipes(&ipod_recipes)?; }
        let needs_texture = |index| texture_plan.as_ref().is_none_or(|p| p.needs(index));
        check_gl("before scene upload")?;
        let mut limit = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &mut limit);
        check_gl("query texture limit")?;
        if limit <= 0
            || meta.textures.iter().enumerate().any(|(i, t)| {
                needs_texture(i) && (t.width > limit as u32 || t.height > limit as u32)
            })
        {
            return Err(format!("texture exceeds GPU limit {limit}"));
        }

        // The final owner exists before the first GL allocation. All names
        // start at zero, so every later `?` releases exactly what was created.
        let mut scene = Self {
            performance,
            ldr_colors: vec![None; meta.draws.len()],
            display_states: Vec::new(),
            ldr_color_bytes: 0,
            ldr_color_buffer: 0,
            package_buffer: 0,
            ldr_vaos: Vec::new(),
            textures: vec![0; meta.textures.len()],
            display_environments: vec![0; meta.materials.len()],
            index_overrides: Vec::new(),
            effective_lods: Default::default(),
            display_environment_textures: Vec::new(),
            ipod_recipes,
            geometry: 0,
            geometry_source_bytes: geom.size as usize,
            geometry_usage: None,
            light_phase_buffer: 0,
            light_page_buffer: 0,
            light_phase_offsets: Vec::new(),
            light_lod_source: crate::light_lod::Sources::default(),
            vaos: vec![0; meta.draws.len()],
            world: vec![Mat4::IDENTITY; meta.nodes.len()],
            skin_bounds: Vec::new(),
            bone_palettes: meta
                .skins
                .iter()
                .map(|s| vec![0.0; s.joints.len() * 12])
                .collect(),
            lights: vec![Light::default(); meta.lights.len()],
            emissive: vec![1.0; meta.materials.len()],
            meta,
            anim,
            door: 0.0,
            gpu_bytes: 0,
            cpu_index_bytes: 0,
            mesh_clusters: None,
            index_cache: IndexCache::default(),
        };
        let texture_count = (0..scene.textures.len())
            .filter(|&i| needs_texture(i))
            .count();
        if texture_count > 0 {
            // Allocate directly into the final owner's storage, then expand
            // the dense names backwards into stable META-indexed slots. Zero
            // means deliberately nonresident, never a missing active sampler.
            glGenTextures(texture_count as _, scene.textures.as_mut_ptr());
            check_gl("create scene textures")?;
            if scene.textures[..texture_count].contains(&0) {
                return Err("GLES did not allocate scene textures".into());
            }
            let mut dense = texture_count;
            for i in (0..scene.textures.len()).rev() {
                if needs_texture(i) {
                    dense -= 1;
                    scene.textures[i] = scene.textures[dense];
                    if i != dense {
                        scene.textures[dense] = 0;
                    }
                } else {
                    scene.textures[i] = 0;
                }
            }
        }
        let mut texture_hash = pc::content_hash::Fnv1a64::default();
        for (index, (t, &id)) in scene.meta.textures.iter().zip(&scene.textures).enumerate() {
            let mut data = file.payload(tex, &t.data)?;
            validation::validate_texture(t, &data)?;
            texture_hash.update(&data);
            // Bind compiler cubes to the source pixel interpretation and every
            // original ENV mip, before conversion. Reference validates too.
            let environment_hash = if scene.meta.atmosphere.environment == Some(index as u32) {
                Some(pc::ipod::display_environment::source_hash(t, &data)?)
            } else { None };
            // Validate the optional compressed payload even when Reference or
            // sampler demand skips its upload. Original RGBA stays the source
            // identity and is checked before any lossy GPU storage conversion.
            let compressed = if let Some(recipe) = scene.ipod_recipes.pvrtc.iter().find(|r| r.texture as usize == index) {
                let bytes = file.payload(compressed_section.ok_or("PVRTC payload section missing")?, &recipe.range)?;
                crate::texture_storage::validate_pvrtc_payload(recipe, &data, &bytes)?;
                performance.then_some(bytes)
            } else { None };
            if id != 0 {
                glBindTexture(GL_TEXTURE_2D, id);
                glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
                let half = t.format == pc::TexFormat::Rgba16f;
                let rgb565 = performance && compressed.is_none() && crate::texture_storage::pack_opaque_color(t, &mut data);
                let format = if rgb565 { GL_RGB } else { GL_RGBA };
                let pixel_type = if rgb565 { GL_UNSIGNED_SHORT_5_6_5 } else { GL_UNSIGNED_BYTE };
                let (mut w, mut h, mut at) = (t.width, t.height, 0usize);
                for mip in 0..t.mips {
                    let n = if compressed.is_some() {
                        pc::ipod::pvrtc_level_bytes(w, h).ok_or("PVRTC mip overflow")?
                    } else { (w as usize)
                        .checked_mul(h as usize)
                        .and_then(|n| n.checked_mul(if half { 8 } else if rgb565 { 2 } else { 4 }))
                        .ok_or("texture mip overflow")? };
                    let end = at.checked_add(n).ok_or("texture mip offset overflow")?;
                    let level = compressed.as_ref().unwrap_or(&data).get(at..end).ok_or("texture mip range")?;
                    let encoded: Vec<u8> = if half {
                        level
                            .chunks_exact(8)
                            .flat_map(|px| {
                                let mut out = [255u8; 4];
                                for c in 0..3 {
                                    let h = u16::from_le_bytes([px[c * 2], px[c * 2 + 1]]);
                                    let value = half_float(h).max(0.0);
                                    out[c] =
                                        (libm::sqrtf(value / (1.0 + value)) * 255.0 + 0.5) as u8;
                                }
                                out
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let pixels = if half {
                        encoded.as_ptr()
                    } else {
                        level.as_ptr()
                    };
                    if compressed.is_some() {
                        glCompressedTexImage2D(GL_TEXTURE_2D, mip as _, GL_COMPRESSED_RGB_PVRTC_4BPPV1_IMG,
                            w as _, h as _, 0, n as _, pixels as _);
                    } else { glTexImage2D(
                        GL_TEXTURE_2D,
                        mip as _,
                        format as _,
                        w as _,
                        h as _,
                        0,
                        format,
                        pixel_type,
                        pixels as _,
                    ); }
                    at = end;
                    w = (w / 2).max(1);
                    h = (h / 2).max(1);
                }
                glTexParameteri(GL_TEXTURE_2D, 0x813d, t.mips as i32 - 1); // GL_APPLE_texture_max_level, checked at startup.
                glTexParameteri(
                    GL_TEXTURE_2D,
                    GL_TEXTURE_MIN_FILTER,
                    if t.mips > 1 { 0x2703 } else { GL_LINEAR },
                );
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                let wrap = |v| match v {
                    pc::Wrap::Repeat => GL_REPEAT,
                    pc::Wrap::Clamp => GL_CLAMP_TO_EDGE,
                    pc::Wrap::Mirror => 0x8370,
                };
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap(t.wrap_s));
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap(t.wrap_t));
                check_gl(&format!("upload texture {}", t.name))?;
                scene.gpu_bytes += compressed.as_ref().map_or_else(|| if half { data.len() / 2 } else { data.len() }, Vec::len);
            }
            if let Some(source_hash) = environment_hash {
                if !scene.ipod_recipes.display_cubes.is_empty() {
                    for recipe in &scene.ipod_recipes.display_cubes {
                        let pixels = file.payload(cube_section.ok_or("display cube section missing")?, &recipe.range)?;
                        crate::texture_storage::validate_display_cube_payload(recipe, &source_hash, &pixels)?;
                        if performance {
                            let id = upload_display_environment(&mut scene.display_environment_textures, &pixels)?;
                            scene.gpu_bytes += crate::display_environment::CUBE_BYTES;
                            for &material in &recipe.materials {
                                scene.display_environments[material as usize] = id;
                            }
                        }
                    }
                } else if performance {
                    // Legacy PLIP v1 packs use the compiler's same bake math.
                    // New packs upload their IPEN bytes without runtime grading.
                    let mut cache = Vec::<(u32, u32)>::new();
                    for (material, m) in scene.meta.materials.iter().enumerate() {
                        if !matches!(m.kind, pc::Kind::Water | pc::Kind::Glass) {
                            continue;
                        }
                        let strength = m.env_strength * scene.meta.atmosphere.environment_strength;
                        let id = if let Some(&(_, id)) = cache.iter().find(|&&(bits, _)| bits == strength.to_bits()) {
                            id
                        } else {
                            let pixels = crate::display_environment::bake(t, &data, strength, &scene.meta.post)?;
                            let id = upload_display_environment(&mut scene.display_environment_textures, &pixels)?;
                            scene.gpu_bytes += crate::display_environment::CUBE_BYTES;
                            cache.push((strength.to_bits(), id));
                            id
                        };
                        scene.display_environments[material] = id;
                    }
                }
            }
        }
        let mut data = file.section(geom)?;
        validation::validate_geometry(&scene.meta, &data)?;
        let light_payload = if let Some(recipe) = &scene.ipod_recipes.light_pages {
            let payload = file.section(light_section.unwrap())?;
            pc::ipod::light_pages::validate(&scene.meta, &data, &payload, recipe)?;
            if performance { Some(payload) } else { None }
        } else { None };
        scene.skin_bounds = SkinBounds::build(&scene.meta, &data)?;
        validation::validate_window_parameters(&scene.meta, &scene.ipod_recipes, &data)?;
        if scene.ipod_recipes.skin_lods.is_some()
            || scene.ipod_recipes.animated_display_lods.is_some()
        {
            // iPod ARMv7 and the host harness are little-endian. Borrow the
            // already decoded immutable f32 allocation; retaining a second
            // ANIM staging buffer would add several MiB at peak load.
            #[cfg(target_endian = "little")]
            let animation =
                core::slice::from_raw_parts(scene.anim.as_ptr().cast::<u8>(), scene.anim.len() * 4);
            #[cfg(target_endian = "big")]
            let animation_storage: Vec<u8> =
                scene.anim.iter().flat_map(|f| f.to_le_bytes()).collect();
            #[cfg(target_endian = "big")]
            let animation = &animation_storage;
            if let Some(recipe) = &scene.ipod_recipes.skin_lods {
                pc::ipod::skin_lods::validate(&scene.meta, &data, animation, recipe)?;
            }
            if let Some(recipe) = &scene.ipod_recipes.animated_display_lods {
                pc::ipod::animated_display_lods::validate(&scene.meta, &data, animation, recipe)?;
            }
        }
        pc::ipod::display_lods::validate(&scene.meta, &data, &scene.ipod_recipes)?;
        if performance {
            scene.effective_lods = pc::ipod::display_lods::EffectiveLods::new(&scene.meta, &scene.ipod_recipes)?;
        }

        let colors = if performance {
            scene.light_lod_source = crate::light_lod::Sources::new(&scene.meta, &data)?;
            if let Some(recipe) = &scene.ipod_recipes.light_pages {
                scene.light_lod_source = core::mem::take(&mut scene.light_lod_source).with_pages(recipe)?;
            }
            ColorFile::load(
                path,
                &scene.meta,
                &meta_hash,
                &color_hash(&data),
                &animation_hash,
                &format!("{:016x}", texture_hash.finish()),
            )?
        } else {
            None
        };
        if performance {
            for entry in scene.ipod_recipes.display_lods.iter().flat_map(|r| &r.draws) {
                if !colors.as_ref().is_some_and(|c| c.draws.iter().any(|d| d.draw == entry.draw && d.page.is_some() && d.flags & (16 | 32 | 64) == 0)) {
                    return Err("display LOD requires a validated dry float display page".into());
                }
            }
        }
        if performance {
            for recipe in scene
                .ipod_recipes
                .animated_display_lods
                .iter()
                .flat_map(|r| &r.draws)
            {
                let colors = colors
                    .as_ref()
                    .ok_or("animated display LOD requires color sidecar")?;
                let entry = colors
                    .draws
                    .iter()
                    .find(|d| d.draw == recipe.draw)
                    .ok_or("animated display LOD requires graded colors")?;
                if entry.page.is_some() || entry.flags & (16 | 32 | 64) != 0 {
                    return Err("animated display LOD requires ordinary skin display layout".into());
                }
                let end = (entry.offset as usize)
                    .checked_add(entry.vertex_count as usize * 4)
                    .ok_or("animated display color range overflow")?;
                let bytes = colors
                    .bytes
                    .get(entry.offset as usize..end)
                    .ok_or("animated display color range")?;
                if pc::ipod::animated_display_lods::color_hash(bytes) != recipe.colors_hash {
                    return Err("animated display LOD stale graded colors".into());
                }
            }
        }
        if let Some(colors) = &colors {
            colors.validate_float_geometry(&scene.meta, &data)?;
            scene.index_overrides = colors.validate_index_overrides(&scene.meta, &data)?;
        }
        if performance {
            scene.index_cache = IndexCache::with_lods(
                &scene.meta,
                &data,
                colors.as_ref().map_or(&[], |c| &c.draws),
                &scene.effective_lods,
            )?;
        }
        if let Some(colors) = &colors {
            for entry in colors.draws.iter().filter(|c| c.page.is_some()) {
                let d = &scene.meta.draws[entry.draw as usize];
                for (r, n) in core::iter::once((&d.indices, d.index_count))
                    .chain(scene.effective_lods.get(&scene.meta,entry.draw as usize).iter().map(|l| (&l.indices, l.index_count)))
                {
                    if n > 0 {
                        let indices = scene
                            .index_cache
                            .get(r.offset, n)
                            .ok_or("LDR float page has no retained source indices")?;
                        let page_count = colors.pages[entry.page.unwrap() as usize].vertex_count;
                        if indices.iter().any(|&i| {
                            u32::from(i)
                                .checked_add(entry.base_vertex)
                                .is_none_or(|j| j >= page_count || j > 65535)
                        }) {
                            return Err("LDR remapped index outside float page".into());
                        }
                    }
                }
            }
        }
        scene.cpu_index_bytes = scene.effective_lods.bytes() + scene.index_cache.bytes()
            + scene.index_overrides.capacity() * core::mem::size_of::<DisplayIndices>()
            + scene.index_overrides.iter().map(|o| o.indices.capacity() * 2).sum::<usize>();
        if let Some(mut clusters) = if performance {
            PlaceFile::optional(&sidecar_path(path, "ipod-clusters.bin"))?
        } else {
            None
        } {
            if clusters.len > crate::mesh_clusters::max_file_bytes_with_lods(&scene.meta, &scene.effective_lods)? {
                return Err("cluster sidecar exceeds source geometry budget".into());
            }
            let bytes = clusters.read(0, clusters.len)?;
            let parsed =
                crate::mesh_clusters::MeshClusters::parse_with_lods(&bytes, &scene.meta, &meta_bytes, &data, &scene.effective_lods)?;
            scene.cpu_index_bytes += parsed.bytes();
            scene.mesh_clusters = Some(parsed);
        }
        drop(meta_bytes);
        let phases = if performance {
            if let Some(recipe) = &scene.ipod_recipes.light_pages {
                LightPhases::for_pages(&scene.meta, &data, recipe)?
            } else { LightPhases::new(&scene.meta, &data)? }
        } else {
            LightPhases {
                data: Vec::new(),
                offsets: Vec::new(),
            }
        };
        let packages = if performance {
            PackageParameters::new(&scene.meta, &data)?
        } else {
            PackageParameters {
                data: Vec::new(),
                offsets: Vec::new(),
            }
        };
        if performance {
            let mut display_pages = vec![false; scene.meta.draws.len()];
            if let Some(colors) = &colors {
                for entry in colors.draws.iter().filter(|e| e.page.is_some()) {
                    display_pages[entry.draw as usize] = true;
                }
            }
            for field in scene.ipod_recipes.light_pages.iter().flat_map(|r| &r.pages).flat_map(|p| &p.fields) {
                display_pages[field.draw as usize] = true;
            }
            let usage = crate::geometry_usage::GeometryUsage::new(
                &scene.meta, data.len(), &display_pages,
                texture_plan.as_ref().is_none_or(|p| p.needs_original_shadow()),
                scene.ipod_recipes.skin_lods.iter().flat_map(|r| &r.draws).flat_map(|d| &d.levels)
                    .chain(scene.ipod_recipes.animated_display_lods.iter().flat_map(|r| &r.draws).flat_map(|d| &d.levels))
                    .map(|l| (&l.indices,l.index_count)),
            )?;
            usage.compact(&mut data)?;
            scene.geometry_usage = Some(usage);
        } else if scene.ipod_recipes.skin_lods.is_some() || scene.ipod_recipes.display_lods.is_some() || scene.ipod_recipes.animated_display_lods.is_some() {
            // Validation above reads the whole source plus recipe payload.
            // Reference uploads only original ranges, never derived indices.
            data.truncate(pc::ipod::display_lods::source_end(&scene.meta)? as usize);
            scene.geometry_source_bytes = data.len();
        }
        // All source hashes, vertices, LODs, clusters and auxiliary CPU data
        // were validated above. Only now may the upload discard unused bytes.
        if !data.is_empty() {
            glGenBuffers(1, &mut scene.geometry);
            check_gl("create scene geometry")?;
            if scene.geometry == 0 {
                return Err("GLES did not allocate scene geometry".into());
            }
            glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
            glBufferData(GL_ARRAY_BUFFER, data.len() as _, data.as_ptr() as _, GL_STATIC_DRAW);
            check_gl("upload scene geometry")?;
            scene.gpu_bytes += data.len();
        }
        if let Some(payload) = light_payload {
            glGenBuffers(1, &mut scene.light_page_buffer);
            check_gl("create light page buffer")?;
            if scene.light_page_buffer == 0 { return Err("GLES did not allocate light page buffer".into()); }
            glBindBuffer(GL_ARRAY_BUFFER, scene.light_page_buffer);
            glBufferData(GL_ARRAY_BUFFER, payload.len() as _, payload.as_ptr() as _, GL_STATIC_DRAW);
            check_gl("upload light pages")?;
            scene.gpu_bytes += payload.len();
        }
        if !phases.data.is_empty() {
            glGenBuffers(1, &mut scene.light_phase_buffer);
            check_gl("create light phase buffer")?;
            if scene.light_phase_buffer == 0 {
                return Err("GLES did not allocate light phase buffer".into());
            }
            glBindBuffer(GL_ARRAY_BUFFER, scene.light_phase_buffer);
            glBufferData(
                GL_ARRAY_BUFFER,
                (phases.data.len() * 8) as _,
                phases.data.as_ptr() as _,
                GL_STATIC_DRAW,
            );
            check_gl("upload light phases")?;
            scene.gpu_bytes += phases.data.len() * 8;
        }
        scene.light_phase_offsets = phases.offsets;
        drop(phases.data);
        if !packages.data.is_empty() {
            glGenBuffers(1, &mut scene.package_buffer);
            check_gl("create package parameter buffer")?;
            if scene.package_buffer == 0 {
                return Err("GLES did not allocate package parameter buffer".into());
            }
            glBindBuffer(GL_ARRAY_BUFFER, scene.package_buffer);
            glBufferData(
                GL_ARRAY_BUFFER,
                (packages.data.len() * 4) as _,
                packages.data.as_ptr() as _,
                GL_STATIC_DRAW,
            );
            check_gl("upload package parameters")?;
            scene.gpu_bytes += packages.data.len() * 4;
        }
        let package_offsets = packages.offsets;
        drop(packages.data);
        drop(data);
        let source_vao_count = (0..scene.vaos.len()).filter(|&i| scene.gpu_vertex_offset(i).is_some()).count();
        if source_vao_count > 0 {
            glGenVertexArraysOES(source_vao_count as _, scene.vaos.as_mut_ptr());
            check_gl("create scene vertex arrays")?;
            if scene.vaos[..source_vao_count].contains(&0) {
                return Err("GLES did not allocate scene vertex arrays".into());
            }
            let mut dense = source_vao_count;
            for i in (0..scene.vaos.len()).rev() {
                if scene.gpu_vertex_offset(i).is_some() {
                    dense -= 1;
                    scene.vaos[i] = scene.vaos[dense];
                    if i != dense { scene.vaos[dense] = 0; }
                } else {
                    scene.vaos[i] = 0;
                }
            }
        }
        for (i, d) in scene.meta.draws.iter().enumerate() {
            if d.layout == pc::VertexLayout::Lights || scene.vaos[i] == 0 {
                continue;
            }
            let vertex_offset = scene.gpu_vertex_offset(i).ok_or("missing resident source vertices")?;
            glBindVertexArrayOES(scene.vaos[i]);
            glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, scene.geometry);
            let attrs = [
                (0, 3, GL_FLOAT, 0, pc::ipod::POSITION),
                (1, 3, GL_FLOAT, 0, pc::ipod::NORMAL),
                (2, 4, GL_FLOAT, 0, pc::ipod::TANGENT),
                (3, 2, GL_FLOAT, 0, pc::ipod::UV),
                (4, 4, GL_UNSIGNED_BYTE, 1, pc::ipod::COLOR),
            ];
            for (k, n, t, normalize, offset) in attrs {
                glEnableVertexAttribArray(k);
                glVertexAttribPointer(
                    k,
                    n,
                    t,
                    normalize,
                    pc::ipod::stride(d.layout) as _,
                    (vertex_offset as usize + offset) as _,
                );
            }
            if d.layout == pc::VertexLayout::Baked {
                glEnableVertexAttribArray(5);
                glVertexAttribPointer(
                    5,
                    4,
                    GL_UNSIGNED_BYTE,
                    1,
                    pc::ipod::stride(d.layout) as _,
                    (vertex_offset as usize + pc::ipod::EXTRA) as _,
                );
            }
            if d.layout == pc::VertexLayout::Skinned {
                for (k, normalize, offset) in [(6, 0, pc::ipod::EXTRA), (7, 1, pc::ipod::EXTRA + 4)] {
                    glEnableVertexAttribArray(k);
                    glVertexAttribPointer(
                        k,
                        4,
                        GL_UNSIGNED_BYTE,
                        normalize,
                        pc::ipod::stride(d.layout) as _,
                        (vertex_offset as usize + offset) as _,
                    );
                }
            }
            if let Some(offset) = package_offsets.get(i).copied().flatten() {
                glBindBuffer(GL_ARRAY_BUFFER, scene.package_buffer);
                glEnableVertexAttribArray(5);
                glVertexAttribPointer(5, 2, GL_FLOAT, 0, 8, offset as usize as _);
            }
        }
        glBindVertexArrayOES(0);
        check_gl("configure scene vertex arrays")?;
        if let Some(colors) = colors {
            glGenBuffers(1, &mut scene.ldr_color_buffer);
            check_gl("create LDR color buffer")?;
            if scene.ldr_color_buffer == 0 {
                return Err("GLES did not allocate LDR colors".into());
            }
            glBindBuffer(GL_ARRAY_BUFFER, scene.ldr_color_buffer);
            glBufferData(
                GL_ARRAY_BUFFER,
                colors.vertex_bytes as _,
                colors.bytes.as_ptr() as _,
                GL_STATIC_DRAW,
            );
            check_gl("upload LDR colors")?;
            scene.ldr_color_bytes = colors.vertex_bytes as usize;
            scene.gpu_bytes += colors.vertex_bytes as usize;
            scene.ldr_vaos = vec![
                0;
                colors.pages.len()
                    + colors.draws.iter().filter(|d| d.page.is_none()).count()
            ];
            if !scene.ldr_vaos.is_empty() {
                glGenVertexArraysOES(scene.ldr_vaos.len() as _, scene.ldr_vaos.as_mut_ptr());
                check_gl("create LDR color vertex arrays")?;
                if scene.ldr_vaos.contains(&0) {
                    return Err("GLES did not allocate LDR vertex arrays".into());
                }
            }
            for (i, page) in colors.pages.iter().enumerate() {
                glBindVertexArrayOES(scene.ldr_vaos[i]);
                glBindBuffer(GL_ARRAY_BUFFER, scene.ldr_color_buffer);
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, scene.geometry);
                for (attribute, count, kind, normalized, offset) in [
                    (0, 3, 0x1406, 0, 0),
                    (3, 2, 0x1406, 0, 12),
                    (4, 4, GL_UNSIGNED_BYTE, 1, 20),
                ] {
                    glEnableVertexAttribArray(attribute);
                    glVertexAttribPointer(
                        attribute,
                        count,
                        kind,
                        normalized,
                        24,
                        (page.offset as usize + offset) as _,
                    );
                }
            }
            let mut raw_vao = colors.pages.len();
            for entry in &colors.draws {
                if let Some(page) = entry.page {
                    scene.ldr_colors[entry.draw as usize] = Some(LdrColor {
                        vao: scene.ldr_vaos[page as usize],
                        texture: entry.texture,
                        offset: entry.offset,
                        flags: entry.flags,
                        page: Some(page),
                        state: Some(colors.pages[page as usize].state),
                        base_vertex: entry.base_vertex,
                    });
                    continue;
                }
                let vao = scene.ldr_vaos[raw_vao];
                raw_vao += 1;
                let d = &scene.meta.draws[entry.draw as usize];
                let vertex_offset = scene.gpu_vertex_offset(entry.draw as usize).ok_or("missing resident LDR source vertices")?;
                glBindVertexArrayOES(vao);
                glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, scene.geometry);
                // Reflection surfaces retain the authored normal; ordinary
                // diffuse shaders need only position, UV, color and skin.
                for (k, n, t, normalized, at) in [(0, 3, GL_FLOAT, 0, pc::ipod::POSITION), (3, 2, GL_FLOAT, 0, pc::ipod::UV)] {
                    glEnableVertexAttribArray(k);
                    glVertexAttribPointer(
                        k,
                        n,
                        t,
                        normalized,
                        pc::ipod::stride(d.layout) as _,
                        (vertex_offset as usize + at) as _,
                    );
                }
                if entry.flags & (16 | 32) != 0 {
                    glEnableVertexAttribArray(1);
                    glVertexAttribPointer(
                        1,
                        3,
                        GL_FLOAT,
                        0,
                        pc::ipod::stride(d.layout) as _,
                        (vertex_offset as usize + pc::ipod::NORMAL) as _,
                    );
                }
                if d.layout == pc::VertexLayout::Skinned {
                    for (k, normalized, at) in [(6, 0, pc::ipod::EXTRA), (7, 1, pc::ipod::EXTRA + 4)] {
                        glEnableVertexAttribArray(k);
                        glVertexAttribPointer(
                            k,
                            4,
                            GL_UNSIGNED_BYTE,
                            normalized,
                            pc::ipod::stride(d.layout) as _,
                            (vertex_offset as usize + at) as _,
                        );
                    }
                }
                glBindBuffer(GL_ARRAY_BUFFER, scene.ldr_color_buffer);
                glEnableVertexAttribArray(4);
                glVertexAttribPointer(4, 4, GL_UNSIGNED_BYTE, 1, 4, entry.offset as usize as _);
                scene.ldr_colors[entry.draw as usize] = Some(LdrColor {
                    vao,
                    texture: entry.texture,
                    offset: entry.offset,
                    flags: entry.flags,
                    page: None,
                    state: None,
                    base_vertex: 0,
                });
            }
            glBindVertexArrayOES(0);
            check_gl("configure LDR vertex arrays")?;
            scene.display_states = colors.states;
        }
        scene.update(0.0, Vec3::ZERO, 0.0);
        Ok(scene)
    }
    pub fn keys(&self, r: &pc::Range, stride: usize, time: f32) -> (&[f32], &[f32], f32) {
        let count = r.size as usize / 4 / stride;
        let f = (time * self.meta.fps) % count as f32;
        let a = f as usize;
        let b = (a + 1) % count;
        let at = r.offset as usize / 4;
        (
            &self.anim[at + a * stride..at + (a + 1) * stride],
            &self.anim[at + b * stride..at + (b + 1) * stride],
            f - a as f32,
        )
    }
    pub fn track<const N: usize>(&self, r: &pc::Range, time: f32) -> [f32; N] {
        let (a, b, t) = self.keys(r, N, time);
        core::array::from_fn(|i| a[i] + (b[i] - a[i]) * t)
    }
    pub fn update(&mut self, time: f32, eye: Vec3, dt: f32) {
        if let Some(d) = &self.meta.doors {
            let target = if eye.distance(Vec3::from(d.trigger)) < d.radius {
                1.0
            } else {
                0.0
            };
            self.door += (target - self.door) * (1.0 - libm::expf(-8.0 * dt));
        }
        for (i, n) in self.meta.nodes.iter().enumerate() {
            let (mut t, mut q) = (Vec3::from(n.translation), Quat::from_array(n.rotation));
            if let Some(r) = &n.track {
                let (a, b, f) = self.keys(r, 7, time);
                t = Vec3::from_slice(a).lerp(Vec3::from_slice(b), f);
                q = Quat::from_slice(&a[3..]).lerp(Quat::from_slice(&b[3..]), f);
            }
            if let Some(d) = &self.meta.doors {
                if i as u32 == d.left {
                    t.x -= self.door * d.travel;
                }
                if i as u32 == d.right {
                    t.x += self.door * d.travel;
                }
            }
            let m = Mat4::from_scale_rotation_translation(Vec3::from(n.scale), q, t);
            self.world[i] = n.parent.map(|p| self.world[p as usize] * m).unwrap_or(m);
        }
        for (skin, palette) in self.meta.skins.iter().zip(&mut self.bone_palettes) {
            let at = skin.inverse_bind.offset as usize / 4;
            for (i, (&node, out)) in skin
                .joints
                .iter()
                .zip(palette.chunks_exact_mut(12))
                .enumerate()
            {
                let m = self.world[node as usize]
                    * Mat4::from_cols_slice(&self.anim[at + i * 16..at + i * 16 + 16]);
                out.copy_from_slice(&rows(m));
            }
        }
        for bounds in &mut self.skin_bounds { bounds.update(&self.bone_palettes[bounds.skin as usize]); }
        for (i, l) in self.meta.lights.iter().enumerate() {
            let (pos, dir) = l
                .node
                .map(|n| {
                    let m = self.world[n as usize];
                    (
                        m.transform_point3(Vec3::ZERO),
                        m.transform_vector3(Vec3::NEG_Z).normalize_or_zero(),
                    )
                })
                .unwrap_or((Vec3::from(l.position), Vec3::from(l.direction)));
            let spot = if l.kind == pc::LightKind::Spot {
                let scale = 1.0 / (l.cos_inner - l.cos_outer).max(1e-4);
                [-l.cos_outer * scale, scale]
            } else {
                [1.0, 0.0]
            };
            let mut light = Light {
                pos,
                dir,
                color: Vec3::from(l.color),
                reach: l.range,
                spot,
                dynamic: l.node.is_some(),
                ..Default::default()
            };
            if l.kind == pc::LightKind::Rect {
                light.right =
                    Vec3::from(l.right).normalize_or(Vec3::Y.cross(dir).normalize_or(Vec3::X));
                light.up = dir.cross(light.right).normalize_or(Vec3::Y);
                light.size = [l.size[0] * 0.5, l.size[1] * 0.5];
                light.color *= l.size[0] * l.size[1];
                light.spot = [0.0, 1.0];
            }
            self.lights[i] = light;
        }
        for (i, m) in self.meta.materials.iter().enumerate() {
            if let Some(t) = m.emissive_track {
                self.emissive[i] =
                    self.track::<1>(&self.meta.material_tracks[t as usize].data, time)[0];
            }
        }
    }
    pub fn model(&self, d: &pc::Draw) -> Mat4 {
        d.node
            .map(|n| self.world[n as usize])
            .unwrap_or(Mat4::IDENTITY)
    }
    /// Only Scene loading can establish this proof. Reference validates the
    /// same recipe but continues to compile its original material programs.
    pub fn window_vertex_params(&self, draw: usize) -> bool {
        u32::try_from(draw).ok().is_some_and(|draw| {
            self.ipod_recipes.window_vertex_params.as_ref()
                .is_some_and(|recipe| recipe.draws.binary_search(&draw).is_ok())
        })
    }
    pub fn window_ray_params(&self, draw: usize) -> bool {
        u32::try_from(draw).ok().is_some_and(|draw| {
            self.ipod_recipes.window_ray_params.as_ref()
                .is_some_and(|recipe| recipe.draws.binary_search(&draw).is_ok())
        })
    }
    /// Index ranges in the original GEOM address space, retained only in the
    /// performance profile for opaque, depth-writing baked draws and LODs.
    pub fn effective_lods(&self, draw: usize) -> &[pc::DrawLod] {
        self.effective_lods.get(&self.meta, draw)
    }
    pub fn indices(&self, offset: u32, count: u32) -> Option<&[u16]> {
        self.index_cache.get(offset, count)
    }
    /// GPU byte offsets are separate from the immutable source META ranges.
    pub fn index_override(&self, draw: usize, source: &pc::Range) -> Option<IndexOverrideRef<'_>> {
        self.meta.draws.get(draw)?;
        let at = self.index_overrides.binary_search_by_key(&(draw as u32, source.offset, source.size),
            |entry| (entry.draw, entry.source.offset, entry.source.size)).ok()?;
        let entry = self.index_overrides.get(at)?;
        Some(IndexOverrideRef { indices: &entry.indices, state: entry.state })
    }
    /// A display float page may intentionally have no original vertex/IBO.
    pub fn gpu_vertex_offset(&self, draw: usize) -> Option<u32> {
        let d = self.meta.draws.get(draw)?;
        match &self.geometry_usage {
            Some(usage) => usage.vertex_offset(draw),
            None => Some(d.vertices.offset),
        }
    }
    pub fn gpu_index_offset(&self, source: u32, count: u32) -> Option<u32> {
        if source % 2 != 0 || source.checked_add(count.checked_mul(2)?)? as usize > self.geometry_source_bytes {
            return None;
        }
        match &self.geometry_usage {
            Some(usage) => usage.index_offset(source, count),
            None => Some(source),
        }
    }
    /// Replacing a Renderer can retain this Scene. VAOs
    /// retain element-buffer bindings, including renderer-owned stream IBOs:
    /// detach those references before deleting the old renderer's buffers.
    pub unsafe fn reset_index_bindings(&self) {
        for &vao in self.vaos.iter().chain(&self.ldr_vaos).filter(|&&vao| vao != 0) {
            glBindVertexArrayOES(vao);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self.geometry);
        }
        glBindVertexArrayOES(0);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
    }
    pub fn bones(&self, skin: u32) -> &[f32] {
        &self.bone_palettes[skin as usize]
    }
    pub fn bounds(&self, d: &pc::Draw) -> (Vec3, Vec3) {
        if d.node.is_none() && d.skin.is_none() {
            return (Vec3::from(d.min), Vec3::from(d.max));
        }
        if let Some(s) = d.skin {
            let index = self.skin_bounds.binary_search_by_key(&(d.vertices.offset,d.vertices.size,s),
                |b|(b.source.offset,b.source.size,b.skin)).expect("validated skin bounds");
            let bounds=&self.skin_bounds[index];
            return (bounds.min,bounds.max);
        }
        let m = self.model(d);
        let c = (Vec3::from(d.min) + Vec3::from(d.max)) * 0.5;
        let e = (Vec3::from(d.max) - Vec3::from(d.min)) * 0.5;
        let wc = m.transform_point3(c);
        let we = m.x_axis.truncate().abs() * e.x
            + m.y_axis.truncate().abs() * e.y
            + m.z_axis.truncate().abs() * e.z;
        (wc - we, wc + we)
    }
}
impl Drop for Scene {
    fn drop(&mut self) {
        unsafe {
            if self.geometry == 0
                && self.light_phase_buffer == 0
                && self.light_page_buffer == 0
                && self.ldr_color_buffer == 0
                && self.package_buffer == 0
                && self
                    .textures
                    .iter()
                    .chain(&self.vaos)
                    .chain(&self.ldr_vaos)
                    .chain(&self.display_environment_textures)
                    .all(|&id| id == 0)
            {
                return;
            }
            glFinish();
            glBindVertexArrayOES(0);
            glDeleteVertexArraysOES(self.vaos.len() as _, self.vaos.as_ptr());
            glDeleteVertexArraysOES(self.ldr_vaos.len() as _, self.ldr_vaos.as_ptr());
            glDeleteBuffers(1, &self.ldr_color_buffer);
            glDeleteBuffers(1, &self.package_buffer);
            glDeleteBuffers(1, &self.light_phase_buffer);
            glDeleteBuffers(1, &self.light_page_buffer);
            // The same buffer holds vertices and indices; delete it once.
            glDeleteBuffers(1, &self.geometry);
            glDeleteTextures(self.textures.len() as _, self.textures.as_ptr());
            glDeleteTextures(
                self.display_environment_textures.len() as _,
                self.display_environment_textures.as_ptr(),
            );
        }
    }
}
pub fn rows(m: Mat4) -> [f32; 12] {
    let t = m.transpose();
    let a = t.to_cols_array();
    a[..12].try_into().unwrap()
}

fn half_float(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = (h >> 10) & 31;
    let m = h & 1023;
    if e == 0 {
        sign * (m as f32) * libm::exp2f(-24.0)
    } else if e == 31 {
        sign * 65504.0
    } else {
        sign * (1.0 + m as f32 / 1024.0) * libm::exp2f(e as f32 - 15.0)
    }
}

unsafe fn upload_display_environment(owner: &mut Vec<u32>, pixels: &[u8]) -> Result<u32, String> {
    if pixels.len() != crate::display_environment::CUBE_BYTES {
        return Err("display cube upload size".into());
    }
    // Record ownership before allocation: partial face uploads and GL errors
    // release this name along with every earlier scene resource.
    owner.push(0);
    let owned = owner.last_mut().unwrap();
    glGenTextures(1, owned);
    check_gl("create display environment")?;
    let id = *owned;
    if id == 0 {
        return Err("GLES did not allocate display environment".into());
    }
    glBindTexture(GL_TEXTURE_CUBE_MAP, id);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    for (face, pixels) in pixels.chunks_exact(crate::display_environment::CUBE_BYTES / 6).enumerate() {
        glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X + face as u32, 0, GL_RGBA as _,
            crate::display_environment::FACE_SIZE as _, crate::display_environment::FACE_SIZE as _,
            0, GL_RGBA, GL_UNSIGNED_BYTE, pixels.as_ptr() as _);
        check_gl("upload display environment face")?;
    }
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    check_gl("upload display environment")?;
    Ok(id)
}

#[cfg(test)]
use crate::display_environment::oct_pixels as display_environment_pixels;

#[cfg(test)]
mod tests {
    use super::*;
    use pc::ipod::{parse, position, stride};
    extern crate std;
    use std::{
        collections::{BTreeMap, BTreeSet},
        path::PathBuf,
        sync::{LazyLock, Mutex},
    };

    // These symbols satisfy the loader's GLES imports in the standalone host
    // harness. They record ownership and inject real GL error return paths;
    // they do not claim to emulate rendering or the physical GPU.
    #[derive(Clone, Debug)]
    struct TextureUpload {
        texture: u32,
        target: u32,
        level: i32,
        internal_format: i32,
        width: i32,
        height: i32,
        format: u32,
        pixel_type: u32,
        unpack_alignment: i32,
        byte_len: usize,
        data: Vec<u8>,
    }
    #[derive(Clone, Debug)]
    struct CompressedUpload {
        texture: u32,
        target: u32,
        level: i32,
        format: u32,
        width: i32,
        height: i32,
        data: Vec<u8>,
    }
    #[derive(Default)]
    struct GlState {
        next: u32,
        live: BTreeSet<(u8, u32)>,
        deleted: Vec<(u8, u32)>,
        invalid_deletes: Vec<(u8, u32)>,
        error: u32,
        fail: Option<&'static str>,
        vao: u32,
        element_buffers: BTreeMap<u32, u32>,
        uploads: Vec<[u8; 4]>,
        texture_uploads: Vec<TextureUpload>,
        compressed_uploads: Vec<CompressedUpload>,
        fail_compressed_mip: Option<i32>,
        capture_textures: bool,
        fail_cube_face: Option<usize>,
        texture_parameters: Vec<(u32, u32, i32)>,
        unpack_alignment: i32,
        array_buffer: u32,
        color_buffer: u32,
        texture: u32,
        texture_targets: BTreeMap<u32, u32>,
        active_texture: u32,
        active_texture_calls: Vec<u32>,
        texture_bind_calls: Vec<(u32, u32, u32)>,
        sampler_uniforms: Vec<(u32, i32, i32)>,
        program: u32,
        display_texture: u32,
        color_vaos: BTreeSet<u32>,
        attributes: Vec<(u32, u32, u32, i32, i32, usize)>,
        attribute_formats: Vec<(u32, u32, u32, u8)>,
        capture_buffers: bool,
        buffer_data: BTreeMap<u32, Vec<u8>>,
    }
    static SERIAL: Mutex<()> = Mutex::new(());
    static GL: LazyLock<Mutex<GlState>> = LazyLock::new(|| Mutex::new(GlState::default()));
    fn stage(state: &mut GlState, name: &'static str) {
        if state.fail == Some(name) {
            state.error = 0x0505;
            state.fail = None;
        }
    }
    unsafe fn generate(kind: u8, count: i32, names: *mut u32, name: &'static str) {
        let mut state = GL.lock().unwrap();
        let color = (kind == b'B' || kind == b'V') && state.live.iter().any(|&(k, _)| k == kind);
        let display = kind == b'T' && state.live.iter().any(|&(k, _)| k == kind);
        if (color && kind == b'B' && state.fail == Some("zero color buffer"))
            || (display && state.fail == Some("zero display texture"))
            || (kind == b'T' && state.fail == Some("zero texture"))
            || (kind == b'B' && state.fail == Some("zero buffer"))
        {
            state.fail = None;
            for i in 0..count as usize {
                names.add(i).write(0);
            }
            return;
        }
        for i in 0..count as usize {
            state.next += 1;
            let id = state.next;
            names.add(i).write(id);
            state.live.insert((kind, id));
            if display {
                state.display_texture = id;
            }
            if color && kind == b'B' {
                state.color_buffer = id;
            }
            if color && kind == b'V' {
                state.color_vaos.insert(id);
            }
        }
        stage(
            &mut state,
            if display {
                "display texture"
            } else if color {
                if kind == b'B' {
                    "color buffer"
                } else {
                    "color vaos"
                }
            } else {
                name
            },
        );
    }
    unsafe fn delete(kind: u8, count: i32, names: *const u32) {
        let mut state = GL.lock().unwrap();
        for &id in core::slice::from_raw_parts(names, count as usize) {
            if id == 0 {
                continue;
            }
            if !state.live.remove(&(kind, id)) {
                state.invalid_deletes.push((kind, id));
            }
            state.deleted.push((kind, id));
        }
    }
    #[no_mangle]
    unsafe extern "C" fn glGenTextures(n: i32, p: *mut u32) {
        generate(b'T', n, p, "textures");
    }
    #[no_mangle]
    unsafe extern "C" fn glGenBuffers(n: i32, p: *mut u32) {
        generate(b'B', n, p, "buffer");
    }
    #[no_mangle]
    unsafe extern "C" fn glGenVertexArraysOES(n: i32, p: *mut u32) {
        generate(b'V', n, p, "vaos");
    }
    #[no_mangle]
    unsafe extern "C" fn glDeleteTextures(n: i32, p: *const u32) {
        delete(b'T', n, p);
    }
    #[no_mangle]
    unsafe extern "C" fn glDeleteBuffers(n: i32, p: *const u32) {
        delete(b'B', n, p);
    }
    #[no_mangle]
    unsafe extern "C" fn glDeleteVertexArraysOES(n: i32, p: *const u32) {
        delete(b'V', n, p);
    }
    #[no_mangle]
    unsafe extern "C" fn glGetError() -> u32 {
        core::mem::take(&mut GL.lock().unwrap().error)
    }
    #[no_mangle]
    unsafe extern "C" fn glGetIntegerv(_: u32, p: *mut i32) {
        p.write(4096);
        stage(&mut GL.lock().unwrap(), "limit");
    }
    #[no_mangle]
    unsafe extern "C" fn glBindVertexArrayOES(id: u32) {
        GL.lock().unwrap().vao = id;
    }
    #[no_mangle]
    unsafe extern "C" fn glBindBuffer(target: u32, id: u32) {
        let mut state = GL.lock().unwrap();
        if target == GL_ARRAY_BUFFER {
            state.array_buffer = id;
        } else if target == GL_ELEMENT_ARRAY_BUFFER {
            let vao = state.vao;
            state.element_buffers.insert(vao, id);
        }
    }
    #[no_mangle]
    unsafe extern "C" fn glBindTexture(target: u32, id: u32) {
        let mut state = GL.lock().unwrap();
        if id != 0 {
            if let Some(previous) = state.texture_targets.insert(id, target) {
                assert_eq!(previous, target, "texture names cannot change target type");
            }
        }
        let unit = state.active_texture;
        state.texture_bind_calls.push((unit, target, id));
        state.texture = id;
    }
    #[no_mangle]
    unsafe extern "C" fn glActiveTexture(unit: u32) {
        let mut state = GL.lock().unwrap();
        state.active_texture = unit - GL_TEXTURE0;
        state.active_texture_calls.push(unit - GL_TEXTURE0);
    }
    #[no_mangle]
    unsafe extern "C" fn glUseProgram(program: u32) { GL.lock().unwrap().program = program; }
    #[no_mangle]
    unsafe extern "C" fn glUniform1i(location: i32, unit: i32) {
        let mut state = GL.lock().unwrap();
        let program = state.program;
        state.sampler_uniforms.push((program, location, unit));
    }
    #[no_mangle]
    unsafe extern "C" fn glDeleteProgram(_: u32) {}
    #[no_mangle]
    unsafe extern "C" fn glPixelStorei(parameter: u32, value: i32) {
        if parameter == GL_UNPACK_ALIGNMENT {
            GL.lock().unwrap().unpack_alignment = value;
        }
    }
    #[no_mangle]
    unsafe extern "C" fn glTexParameteri(target: u32, parameter: u32, value: i32) {
        GL.lock().unwrap().texture_parameters.push((target, parameter, value));
    }
    #[no_mangle]
    unsafe extern "C" fn glEnableVertexAttribArray(_: u32) {}
    #[no_mangle]
    unsafe extern "C" fn glFinish() {}
    #[no_mangle]
    unsafe extern "C" fn glBufferData(target: u32, size: isize, data: *const c_void, _: u32) {
        let mut state = GL.lock().unwrap();
        if state.capture_buffers && size >= 0 {
            let buffer = if target == GL_ARRAY_BUFFER {
                state.array_buffer
            } else {
                *state.element_buffers.get(&state.vao).unwrap_or(&0)
            };
            if buffer != 0 && !data.is_null() {
                state.buffer_data.insert(
                    buffer,
                    core::slice::from_raw_parts(data as *const u8, size as usize).to_vec(),
                );
            }
        }
        let name = if state.array_buffer == state.color_buffer && state.color_buffer != 0 {
            "color upload"
        } else {
            "geometry upload"
        };
        stage(&mut state, name);
    }
    #[no_mangle]
    unsafe extern "C" fn glVertexAttribPointer(
        attribute: u32,
        size: i32,
        kind: u32,
        normalized: u8,
        stride: i32,
        offset: *const c_void,
    ) {
        let mut state = GL.lock().unwrap();
        let vao = state.vao;
        let buffer = state.array_buffer;
        state
            .attribute_formats
            .push((vao, attribute, kind, normalized));
        state
            .attributes
            .push((vao, attribute, buffer, size, stride, offset as usize));
        let name = if attribute == 5 && size == 2 && stride == 8 {
            "package attributes"
        } else if state.color_vaos.contains(&vao) {
            "color attributes"
        } else {
            "attributes"
        };
        stage(&mut state, name);
    }
    #[no_mangle]
    unsafe extern "C" fn glTexImage2D(
        target: u32,
        level: i32,
        internal_format: i32,
        width: i32,
        height: i32,
        border: i32,
        format: u32,
        pixel_type: u32,
        p: *const c_void,
    ) {
        assert!(target == GL_TEXTURE_2D
            || (GL_TEXTURE_CUBE_MAP_POSITIVE_X..GL_TEXTURE_CUBE_MAP_POSITIVE_X + 6).contains(&target));
        assert_eq!(border, 0);
        let bytes_per_pixel = match (format, pixel_type) {
            (GL_LUMINANCE, GL_UNSIGNED_BYTE) => 1,
            (GL_RGB, GL_UNSIGNED_SHORT_5_6_5) => 2,
            (GL_RGBA, GL_UNSIGNED_BYTE) => 4,
            _ => panic!("unexpected upload format/type: {format:x}/{pixel_type:x}"),
        };
        assert!(width > 0 && height > 0);
        let byte_len = width as usize * height as usize * bytes_per_pixel;
        let mut state = GL.lock().unwrap();
        // A final 1x1 RGB565 mip contains only two bytes. Never inspect the
        // old four-byte RGBA sample beyond that valid input allocation.
        let bytes = if p.is_null() {
            &[][..]
        } else {
            core::slice::from_raw_parts(p as *const u8, byte_len)
        };
        if format == GL_RGBA && bytes.len() >= 4 {
            state.uploads.push(bytes[..4].try_into().unwrap());
        }
        let texture = state.texture;
        let unpack_alignment = state.unpack_alignment;
        let data = if state.capture_textures {
            bytes.to_vec()
        } else {
            Vec::new()
        };
        state.texture_uploads.push(TextureUpload {
            texture,
            target,
            level,
            internal_format,
            width,
            height,
            format,
            pixel_type,
            unpack_alignment,
            byte_len,
            data,
        });
        if state.fail_cube_face.is_some_and(|face| target == GL_TEXTURE_CUBE_MAP_POSITIVE_X + face as u32) {
            state.error = 0x0505;
            state.fail_cube_face = None;
        }
        let name = if state.texture == state.display_texture && state.texture != 0 {
            "display upload"
        } else {
            "texture upload"
        };
        stage(&mut state, name);
    }
    #[no_mangle]
    unsafe extern "C" fn glCompressedTexImage2D(
        target: u32, level: i32, format: u32, width: i32, height: i32,
        border: i32, size: i32, pixels: *const c_void,
    ) {
        assert_eq!(target, GL_TEXTURE_2D);
        assert_eq!(format, GL_COMPRESSED_RGB_PVRTC_4BPPV1_IMG);
        assert_eq!(border, 0);
        assert!(width > 0 && height > 0 && level >= 0 && !pixels.is_null());
        assert_eq!(size as usize, pc::ipod::pvrtc_level_bytes(width as u32, height as u32).unwrap());
        let mut state = GL.lock().unwrap();
        let texture = state.texture;
        state.compressed_uploads.push(CompressedUpload {
            texture, target, level, format, width, height,
            data: core::slice::from_raw_parts(pixels as *const u8, size as usize).to_vec(),
        });
        if state.fail_compressed_mip == Some(level) {
            state.error = 0x0505;
            state.fail_compressed_mip = None;
        }
    }

    struct PackFile(PathBuf);
    impl PackFile {
        fn write(bytes: &[u8]) -> Self {
            let folder = crate::test_artifact_dir();
            std::fs::create_dir_all(&folder).unwrap();
            let path = folder.join(format!("loader-{}.place", std::process::id()));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for PackFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            for suffix in ["json", "bin"] {
                let _ = std::fs::remove_file(color_path(self.path(), suffix));
            }
            let _ = std::fs::remove_file(sidecar_path(self.path(), "ipod-clusters.bin"));
            let _ = std::fs::remove_file(sidecar_path(self.path(), "pipelines.json"));
        }
    }
    fn pack(m: &pc::Meta, geom: &[u8], anim: &[f32], textures: &[u8]) -> Vec<u8> {
        let meta = serde_json::to_vec(m).unwrap();
        let anim: Vec<u8> = anim.iter().flat_map(|v| v.to_le_bytes()).collect();
        pc::write_versioned(
            pc::ipod::MAGIC,
            pc::ipod::VERSION,
            &[
                (pc::TAG_META, &meta, 16),
                (pc::TAG_TEXTURES, textures, 16),
                (pc::TAG_GEOMETRY, geom, 16),
                (pc::TAG_ANIMATION, &anim, 16),
            ],
        )
    }
    const BAKED_VERTEX_BYTES: u32 = 3 * stride(pc::VertexLayout::Baked);

    fn float_vertex(
        layout: pc::VertexLayout,
        pos: [f32; 3],
        uv: [f32; 2],
        color: [u8; 4],
    ) -> Vec<u8> {
        assert_ne!(layout, pc::VertexLayout::Lights);
        let mut vertex = vec![0; stride(layout) as usize];
        for (at, values) in [
            (pc::ipod::POSITION, pos.as_slice()),
            (pc::ipod::NORMAL, [0.0, 0.0, 1.0].as_slice()),
            (pc::ipod::TANGENT, [1.0, 0.0, 0.0, 1.0].as_slice()),
            (pc::ipod::UV, uv.as_slice()),
        ] {
            for (i, value) in values.iter().enumerate() {
                vertex[at + i * 4..at + (i + 1) * 4].copy_from_slice(&value.to_le_bytes());
            }
        }
        vertex[pc::ipod::COLOR..pc::ipod::COLOR + 4].copy_from_slice(&color);
        match layout {
            pc::VertexLayout::Baked => {
                vertex[pc::ipod::EXTRA..].copy_from_slice(&[128, 128, 128, 255])
            }
            pc::VertexLayout::Skinned => vertex[pc::ipod::EXTRA + 4] = 255,
            _ => {}
        }
        vertex
    }

    fn float_fixture() -> (pc::Meta, Vec<u8>, Vec<f32>) {
        let (mut meta, _, animation) = crate::validation::tests::fixture();
        let draw = &mut meta.draws[0];
        // Nonzero source floats distinguish the float ABI from old snorm.
        // PLIP surface positions have identity decode; UV decode is retained.
        draw.pos_offset = [0.0;3];
        draw.pos_scale = [1.0;3];
        draw.uv_offset = [9.0, -2.0];
        draw.uv_scale = [4.0, 8.0];
        let mut geometry = Vec::new();
        for (pos, uv) in [
            ([0.125, 0.25, 0.375], [-0.25, 0.5]),
            ([0.875, 0.25, 0.375], [1.25, 0.5]),
            ([0.125, 0.875, 0.625], [-0.25, 1.5]),
        ] {
            geometry.extend(float_vertex(
                pc::VertexLayout::Static,
                pos,
                uv,
                [17, 89, 201, 255],
            ));
        }
        draw.vertices = pc::Range {
            offset: 0,
            size: geometry.len() as u32,
        };
        draw.indices = pc::Range {
            offset: geometry.len() as u32,
            size: 6,
        };
        geometry.extend([0, 0, 1, 0, 2, 0]);
        (meta, geometry, animation)
    }

    fn window_fixture() -> (pc::Meta, Vec<u8>, Vec<f32>, pc::ipod::Recipes) {
        let (mut meta, _, animation) = float_fixture();
        meta.materials[0].kind = pc::Kind::InteriorWindow;
        meta.materials[0].vertex_color = true;
        let draw = &mut meta.draws[0];
        draw.uv_scale = [1.0; 2];
        draw.uv_offset = [0.0; 2];
        draw.vertex_count = 4;
        let mut geometry = Vec::new();
        for (pos, uv) in [
            ([0.125, 0.25, 0.375], [3.1, 7.1]),
            ([0.875, 0.25, 0.375], [3.9, 7.1]),
            ([0.125, 0.875, 0.625], [3.1, 7.9]),
            // Referenced only by the coarse LOD, so corrupting this vertex
            // must fail despite a valid full-resolution triangle.
            ([0.125, 0.875, 0.625], [3.2, 7.8]),
        ] {
            geometry.extend(float_vertex(pc::VertexLayout::Static, pos, uv, [17, 89, 201, 255]));
        }
        draw.vertices.size = geometry.len() as u32;
        draw.indices = pc::Range { offset: geometry.len() as u32, size: 6 };
        geometry.extend([0u16, 1, 2].into_iter().flat_map(u16::to_le_bytes));
        draw.lods = vec![pc::DrawLod {
            indices: pc::Range { offset: geometry.len() as u32, size: 6 },
            index_count: 3, error: 0.1,
        }];
        geometry.extend([0u16, 1, 3].into_iter().flat_map(u16::to_le_bytes));
        draw.lods.push(pc::DrawLod {
            indices: pc::Range { offset: geometry.len() as u32, size: 0 },
            index_count: 0, error: 0.2,
        });
        let mut recipes = pc::ipod::Recipes::default();
        recipes.window_vertex_params = Some(pc::ipod::WindowVertexParams {
            version: pc::ipod::window_params::VERSION, draws: vec![0],
        });
        (meta, geometry, animation, recipes)
    }

    fn window_pack(meta: &pc::Meta, geometry: &[u8], animation: &[f32], recipes: &pc::ipod::Recipes) -> Vec<u8> {
        let metadata = serde_json::to_vec(&pc::ipod::Metadata {
            scene: meta.clone(), ipod_recipes: recipes.clone(),
        }).unwrap();
        let animation: Vec<u8> = animation.iter().flat_map(|v| v.to_le_bytes()).collect();
        pc::write_versioned(pc::ipod::MAGIC, pc::ipod::VERSION, &[
            (pc::TAG_META, &metadata, 16),
            (pc::TAG_TEXTURES, &[255; 64], 16),
            (pc::TAG_GEOMETRY, geometry, 16),
            (pc::TAG_ANIMATION, &animation, 16),
        ])
    }

    #[test]
    fn window_recipe_proves_all_original_lods_in_both_profiles_and_preserves_geometry() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, animation, recipes) = window_fixture();
        for performance in [false, true] {
            reset(None);
            GL.lock().unwrap().capture_buffers = true;
            let file = PackFile::write(&window_pack(&meta, &geometry, &animation, &recipes));
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert!(scene.window_vertex_params(0));
            assert!(!scene.window_vertex_params(1));
            assert!(!scene.window_vertex_params(usize::MAX));
            assert_eq!(serde_json::to_vec(&scene.meta).unwrap(), serde_json::to_vec(&meta).unwrap());
            assert_eq!(GL.lock().unwrap().buffer_data[&scene.geometry], geometry);
            drop(scene);
            released();
        }
        // No recipe remains compatible, including geometry outside the proof.
        let mut outside = geometry;
        outside[40..44].copy_from_slice(&3.0f32.to_le_bytes());
        for performance in [false, true] {
            reset(None);
            let file = PackFile::write(&window_pack(&meta, &outside, &animation, &pc::ipod::Recipes::default()));
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert!(!scene.window_vertex_params(0));
            drop(scene);
            released();
        }
    }

    #[test]
    fn window_recipe_corruption_is_rejected_instead_of_trusting_the_draw_list() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, animation, recipes) = window_fixture();
        for performance in [false, true] {
            for fault in 0..11 {
                let mut m = meta.clone();
                let mut g = geometry.clone();
                let mut r = recipes.clone();
                let recipe = r.window_vertex_params.as_mut().unwrap();
                match fault {
                    0 => recipe.version += 1,
                    1 => recipe.draws.clear(),
                    2 => recipe.draws.push(0),
                    3 => recipe.draws = vec![1, 0],
                    4 => recipe.draws = vec![u32::MAX],
                    5 => m.materials[0].kind = pc::Kind::Standard,
                    6 => m.materials[0].uv_anim = Some(pc::UvAnim {
                        cols: 1, rows: 1, frames: 1, fps: 1.0,
                        scroll: [0.1, 0.0], phase: 0.0,
                    }),
                    7 => g[40..44].copy_from_slice(&3.0f32.to_le_bytes()),
                    8 => g[3 * 52 + 40..3 * 52 + 44].copy_from_slice(&4.2f32.to_le_bytes()),
                    9 => g[3 * 52 + 48] ^= 1,
                    10 => g[3 * 52 + 49] ^= 1,
                    _ => unreachable!(),
                }
                reset(None);
                let file = PackFile::write(&window_pack(&m, &g, &animation, &r));
                let error = unsafe { Scene::load_for_profile(file.path(), performance) }.err().unwrap();
                assert!(error.contains("window parameters"), "profile {performance}, fault {fault}: {error}");
                released();
            }
        }
    }

    fn reset(fail: Option<&'static str>) {
        *GL.lock().unwrap() = GlState {
            fail,
            ..Default::default()
        };
    }
    fn released() {
        let state = GL.lock().unwrap();
        assert!(state.live.is_empty(), "leaked {:?}", state.live);
        assert!(
            state.invalid_deletes.is_empty(),
            "duplicate deletion {:?}",
            state.invalid_deletes
        );
        assert_eq!(state.vao, 0);
    }

    #[test]
    fn plip_float_layouts_bind_exact_source_attributes_and_keep_joint_bytes() {
        let _lock = SERIAL.lock().unwrap();
        for layout in [
            pc::VertexLayout::Static,
            pc::VertexLayout::Baked,
            pc::VertexLayout::Skinned,
        ] {
            let (mut meta, source, mut animation) = float_fixture();
            let draw = &mut meta.draws[0];
            let source_draw = draw.clone();
            let mut geometry = Vec::new();
            for i in 0..draw.vertex_count {
                let pos = position(&source_draw, &source, i as u16).unwrap();
                let at = i as usize * stride(source_draw.layout) as usize;
                let uv = pc::ipod::floats::<2>(&source, at + pc::ipod::UV).unwrap();
                geometry.extend(float_vertex(layout, pos, uv, [17, 89, 201, 255]));
            }
            draw.layout = layout;
            draw.vertices.size = geometry.len() as u32;
            draw.indices.offset = geometry.len() as u32;
            geometry.extend(pc::parts::slice(&source, &source_draw.indices).unwrap());
            if layout == pc::VertexLayout::Skinned {
                draw.node = None;
                draw.skin = Some(0);
                meta.skins.push(pc::Skin {
                    joints: vec![0],
                    inverse_bind: pc::Range {
                        offset: animation.len() as u32 * 4,
                        size: 64,
                    },
                });
                animation.extend(Mat4::IDENTITY.to_cols_array());
            }
            let bytes = pack(&meta, &geometry, &animation, &[255; 64]);
            assert!(
                pc::Pack::parse(&bytes).is_err(),
                "PLIP must not masquerade as PLCE"
            );
            let parsed = parse(&bytes).unwrap();
            assert_eq!(parsed.section(pc::TAG_GEOMETRY).unwrap(), geometry);
            let d = &meta.draws[0];
            assert_eq!(position(d, &geometry, 1).unwrap(), [0.875, 0.25, 0.375]);
            assert_eq!(
                pc::ipod::floats::<2>(&geometry, pc::ipod::UV).unwrap(),
                [-0.25, 0.5]
            );
            for performance in [false, true] {
                reset(None);
                let file = PackFile::write(&bytes);
                let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
                let mut expected = vec![
                    (0, 3, GL_FLOAT, 0, pc::ipod::POSITION),
                    (1, 3, GL_FLOAT, 0, pc::ipod::NORMAL),
                    (2, 4, GL_FLOAT, 0, pc::ipod::TANGENT),
                    (3, 2, GL_FLOAT, 0, pc::ipod::UV),
                    (4, 4, GL_UNSIGNED_BYTE, 1, pc::ipod::COLOR),
                ];
                match layout {
                    pc::VertexLayout::Baked => {
                        expected.push((5, 4, GL_UNSIGNED_BYTE, 1, pc::ipod::EXTRA))
                    }
                    pc::VertexLayout::Skinned => expected.extend([
                        (6, 4, GL_UNSIGNED_BYTE, 0, pc::ipod::EXTRA),
                        (7, 4, GL_UNSIGNED_BYTE, 1, pc::ipod::EXTRA + 4),
                    ]),
                    _ => {}
                }
                {
                    let gl = GL.lock().unwrap();
                    let vao = scene.vaos[0];
                    assert_eq!(gl.attributes.len(), expected.len());
                    for (attribute, count, kind, normalized, offset) in expected {
                        assert!(gl.attributes.contains(&(
                            vao,
                            attribute,
                            scene.geometry,
                            count,
                            stride(layout) as i32,
                            offset
                        )));
                        assert!(gl
                            .attribute_formats
                            .contains(&(vao, attribute, kind, normalized)));
                    }
                }
                drop(scene);
                released();
            }
        }
    }

    #[test]
    fn loader_rejects_malformed_container_before_allocating_gpu_names() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = float_fixture();
        let source = pack(&m, &g, &a, &[255; 64]);
        for mode in 0..3 {
            reset(None);
            let mut bytes = source.clone();
            match mode {
                0 => bytes[32..36].copy_from_slice(&pc::TAG_META),
                1 => {
                    bytes.pop();
                }
                _ => bytes[20..24].copy_from_slice(&0xfffffff0u32.to_le_bytes()),
            }
            let file = PackFile::write(&bytes);
            assert!(unsafe { Scene::load(file.path()) }.is_err());
            released();
            assert_eq!(GL.lock().unwrap().next, 0);
        }
    }
    #[test]
    fn every_gpu_failure_path_releases_textures_buffer_and_vaos_once() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = baked_fixture();
        let file = PackFile::write(&pack(&m, &g, &a, &[255; 64]));
        for performance in [false, true] {
            for operation in [
                "limit",
                "textures",
                "texture upload",
                "buffer",
                "geometry upload",
                "vaos",
                "attributes",
            ] {
                reset(Some(operation));
                let error = unsafe { Scene::load_for_profile(file.path(), performance) }
                    .err()
                    .expect(operation);
                assert!(error.contains("GLES error"), "{operation}: {error}");
                released();
            }
        }
    }

    fn assert_original_resources_only(scene: &Scene) {
        assert!(!scene.performance);
        assert_eq!(scene.textures.len(), scene.meta.textures.len());
        assert_eq!(scene.vaos.len(), scene.meta.draws.len());
        assert!(scene.textures.iter().chain(&scene.vaos).all(|&id| id != 0));
        assert_ne!(scene.geometry, 0);
        assert_eq!(scene.cpu_index_bytes, 0);
        assert_eq!(scene.index_cache.bytes(), 0);
        assert!(scene.mesh_clusters.is_none());
        assert!(scene.ldr_colors.iter().all(Option::is_none));
        assert!(scene.display_states.is_empty());
        assert!(scene.display_environment_textures.is_empty());
        assert!(scene.display_environments.iter().all(|&id| id == 0));
        assert_eq!(scene.ldr_color_bytes, 0);
        assert_eq!(scene.ldr_color_buffer, 0);
        assert!(scene.ldr_vaos.is_empty());
        assert_eq!(scene.package_buffer, 0);
        assert_eq!(scene.light_phase_buffer, 0);
        assert!(scene.light_phase_offsets.is_empty());
        assert!(scene.light_lod_source.is_empty());
        assert_eq!(scene.light_lod_source.bytes(), 0);
        let state = GL.lock().unwrap();
        assert_eq!(
            state.live.len(),
            scene.textures.len() + scene.vaos.len() + 1
        );
        for (i, draw) in scene.meta.draws.iter().enumerate() {
            for (range, count) in core::iter::once((&draw.indices, draw.index_count))
                .chain(draw.lods.iter().map(|l| (&l.indices, l.index_count)))
            {
                // Renderer keeps the original range/GEOM binding when this
                // query returns None, including a previously cached raw run.
                assert!(scene.indices(range.offset, count).is_none());
            }
            if draw.layout != pc::VertexLayout::Lights {
                assert_eq!(state.element_buffers[&scene.vaos[i]], scene.geometry);
                assert!(state
                    .attributes
                    .iter()
                    .filter(|a| a.0 == scene.vaos[i])
                    .all(|a| a.2 == scene.geometry));
            }
        }
    }

    #[test]
    fn retina_ignores_display_sidecars_but_validates_original_geometry() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, mut geometry, animation) = baked_fixture();
        let file = PackFile::write(&pack(&meta, &geometry, &animation, &[255; 64]));
        for path in [
            color_path(file.path(), "json"),
            color_path(file.path(), "bin"),
            sidecar_path(file.path(), "ipod-clusters.bin"),
        ] {
            std::fs::write(path, b"invalid optional performance asset").unwrap();
        }
        reset(None);
        let mut scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
        assert_original_resources_only(&scene);
        assert_eq!(scene.gpu_bytes, 64 + geometry.len());
        assert_eq!(scene.anim, animation);
        scene.update(0.25, Vec3::ZERO, 1.0 / 60.0);
        assert!(scene.world.iter().all(|m| m.is_finite()));
        drop(scene);
        released();
        reset(None);
        assert!(unsafe { Scene::load(file.path()) }.is_err());
        released();
        geometry[BAKED_VERTEX_BYTES as usize..BAKED_VERTEX_BYTES as usize + 2]
            .copy_from_slice(&u16::MAX.to_le_bytes());
        let bad = PackFile::write(&pack(&meta, &geometry, &animation, &[255; 64]));
        reset(None);
        assert!(unsafe { Scene::load_for_profile(bad.path(), false) }
            .err()
            .unwrap()
            .contains("index exceeds"));
        released();
    }

    #[test]
    fn optional_clusters_validate_identity_budget_and_release_prior_gpu_uploads() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, animation) = baked_fixture();
        let file = PackFile::write(&pack(&meta, &geometry, &animation, &[255; 64]));
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert!(scene.mesh_clusters.is_none());
        let prior_cpu_bytes = scene.cpu_index_bytes;
        drop(scene);
        released();
        // A valid sidecar may find no useful splits, retaining empty draw ranges.
        let mut bytes = vec![0; 56 + meta.draws.len() * 8];
        bytes[..4].copy_from_slice(b"IPCL");
        bytes[4..8].copy_from_slice(&2u32.to_le_bytes());
        bytes[32..36].copy_from_slice(&(meta.draws.len() as u32).to_le_bytes());
        let hash = crate::mesh_clusters::hash;
        for (at, value) in [
            (8, hash(&serde_json::to_vec(&meta).unwrap())),
            (16, hash(&geometry)),
            (24, hash(&bytes[56..])),
        ] {
            bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
        }
        for mode in 0..4 {
            let mut input = bytes.clone();
            match mode {
                1 => input[8] ^= 1,
                2 => input.resize(crate::mesh_clusters::max_file_bytes(&meta).unwrap() + 1, 0),
                3 => input.truncate(3),
                _ => {}
            }
            std::fs::write(sidecar_path(file.path(), "ipod-clusters.bin"), &input).unwrap();
            reset(None);
            let result = unsafe { Scene::load(file.path()) };
            if mode == 0 {
                let scene = result.unwrap();
                let clusters = scene.mesh_clusters.as_ref().unwrap();
                assert_eq!(scene.cpu_index_bytes, prior_cpu_bytes + clusters.bytes());
                assert!(clusters.groups(0).is_none());
                assert_eq!(scene.indices(BAKED_VERTEX_BYTES, 3), Some(&[0, 1, 2][..]));
                drop(scene);
            } else {
                assert!(result.is_err());
            }
            released();
        }
    }

    fn baked_fixture() -> (pc::Meta, Vec<u8>, Vec<f32>) {
        let (mut m, source, animation) = float_fixture();
        let d = &mut m.draws[0];
        let mut geometry = Vec::new();
        for vertex in pc::parts::slice(&source, &d.vertices)
            .unwrap()
            .chunks_exact(stride(d.layout) as usize)
        {
            geometry.extend_from_slice(vertex);
            geometry.extend_from_slice(&[128, 128, 128, 255]);
        }
        assert_eq!(geometry.len(), BAKED_VERTEX_BYTES as usize);
        let index_offset = geometry.len() as u32;
        geometry.extend_from_slice(pc::parts::slice(&source, &d.indices).unwrap());
        geometry.extend_from_slice(&[2, 0, 1, 0, 0, 0]);
        d.layout = pc::VertexLayout::Baked;
        d.node = None;
        d.vertices.size = index_offset;
        d.indices.offset = index_offset;
        d.lods = vec![
            pc::DrawLod {
                indices: d.indices.clone(),
                index_count: 3,
                error: 0.1,
            },
            pc::DrawLod {
                indices: pc::Range {
                    offset: index_offset + 6,
                    size: 6,
                },
                index_count: 3,
                error: 0.2,
            },
        ];
        m.draws.push(m.draws[0].clone());
        (m, geometry, animation)
    }

    fn color_sidecar(source: &[u8]) -> (serde_json::Value, Vec<u8>) {
        let pack = parse(source).unwrap();
        let m = pack.meta().unwrap();
        let bytes = [42, 84, 126, 255].repeat(m.draws[0].vertex_count as usize);
        let draws:Vec<_>=m.draws.iter().enumerate().map(|(i,d)|serde_json::json!({"draw":i,"offset":0,"vertexCount":d.vertex_count,"texture":0,"flags":0,"page":null,"baseVertex":0})).collect();
        (
            serde_json::json!({"version":2,"pages":[],"states":[],"identity":"fnv1a64-v1","metaHash":color_hash(pack.section(pc::TAG_META).unwrap()),"geometryHash":color_hash(pack.section(pc::TAG_GEOMETRY).unwrap()),"animationHash":color_hash(pack.section(pc::TAG_ANIMATION).unwrap()),"textureHash":format!("{:016x}",pc::content_hash::textures(&m.textures,pack.section(pc::TAG_TEXTURES).unwrap()).unwrap()),"colorsHash":color_hash(&bytes),"colorsBytes":bytes.len(),"draws":draws}),
            bytes,
        )
    }
    fn write_colors(file: &PackFile, json: &serde_json::Value, bytes: &[u8]) {
        std::fs::write(
            color_path(file.path(), "json"),
            serde_json::to_vec(json).unwrap(),
        )
        .unwrap();
        std::fs::write(color_path(file.path(), "bin"), bytes).unwrap();
    }
    #[test]
    fn optional_ldr_colors_share_payload_and_keep_full_vaos() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = baked_fixture();
        let source = pack(&m, &g, &a, &[255; 64]);
        let file = PackFile::write(&source);
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert!(scene.ldr_colors.iter().all(Option::is_none));
        assert_eq!(scene.ldr_color_bytes, 0);
        let old_bytes = scene.gpu_bytes;
        drop(scene);
        released();
        let (json, bytes) = color_sidecar(&source);
        write_colors(&file, &json, &bytes);
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_eq!(scene.ldr_color_bytes, 12);
        assert_eq!(scene.gpu_bytes, old_bytes + 12);
        assert_eq!(scene.anim, a);
        assert_eq!(scene.ldr_colors.len(), 2);
        for (i, color) in scene.ldr_colors.iter().enumerate() {
            let color = color.unwrap();
            assert_ne!(color.vao, scene.vaos[i]);
            assert_eq!((color.offset, color.texture, color.flags), (0, Some(0), 0));
            let state = GL.lock().unwrap();
            let attrs: Vec<_> = state
                .attributes
                .iter()
                .filter(|a| a.0 == color.vao)
                .collect();
            assert_eq!(attrs.iter().map(|a| a.1).collect::<Vec<_>>(), [0, 3, 4]);
            assert_eq!(
                (attrs[2].2, attrs[2].3, attrs[2].4, attrs[2].5),
                (scene.ldr_color_buffer, 4, 4, 0)
            );
            assert!(attrs[..2].iter().all(|a| a.2 == scene.geometry));
        }
        drop(scene);
        released();
    }
    #[test]
    fn retained_scene_releases_renderer_index_bindings_without_changing_vertices() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, animation) = baked_fixture();
        let source = pack(&meta, &geometry, &animation, &[255; 64]);
        let file = PackFile::write(&source);
        let (json, bytes) = color_sidecar(&source);
        write_colors(&file, &json, &bytes);
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        let attributes = GL.lock().unwrap().attributes.clone();
        let mut streams = [0; 2];
        unsafe {
            glGenBuffers(2, streams.as_mut_ptr());
            for (i, &vao) in scene.vaos.iter().chain(&scene.ldr_vaos).enumerate() {
                glBindVertexArrayOES(vao);
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, streams[i % 2]);
            }
            glBindVertexArrayOES(0);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, streams[0]);
            scene.reset_index_bindings();
        }
        {
            let state = GL.lock().unwrap();
            assert_eq!(state.vao, 0);
            assert_eq!(state.element_buffers[&0], 0);
            for vao in scene.vaos.iter().chain(&scene.ldr_vaos) {
                assert_eq!(state.element_buffers[vao], scene.geometry);
                assert!(state.live.contains(&(b'V', *vao)));
            }
            assert!(!state
                .element_buffers
                .values()
                .any(|id| streams.contains(id)));
            assert_eq!(
                state.attributes, attributes,
                "vertex ownership/layout must survive profile changes"
            );
        }
        unsafe {
            glDeleteBuffers(2, streams.as_ptr());
        }
        drop(scene);
        released();
    }
    #[test]
    fn float_pages_share_vaos_keep_all_source_lods_and_reject_corrupt_positions_or_uv() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, g, a) = baked_fixture();
        m.materials.push(m.materials[0].clone());
        m.draws[1].material = 1;
        // These values are already represented by the separate baked colors;
        // the display shader consumes the same remaining state for both.
        m.materials[1].color[0] = 0.25;
        m.materials[1].metalness = 0.75;
        let source = pack(&m, &g, &a, &[255; 64]);
        let file = PackFile::write(&source);
        let (mut json, _) = color_sidecar(&source);
        let d = &m.draws[0];
        let mut bytes = Vec::new();
        for i in 0..d.vertex_count {
            let pos = position(d, &g, i as u16).unwrap();
            let at = d.vertices.offset as usize + i as usize * stride(d.layout) as usize;
            let uv = pc::ipod::floats::<2>(&g, at + pc::ipod::UV).unwrap();
            for value in pos.into_iter().chain(uv) {
                bytes.extend(value.to_le_bytes());
            }
            bytes.extend([42, 84, 126, 255]);
        }
        json["pages"] = serde_json::json!([{"offset":0,"vertexCount":d.vertex_count,"state":0}]);
        json["states"] =
            serde_json::json!([pc::display::State::for_draw(&m, d, Some(0), 0).unwrap()]);
        for c in json["draws"].as_array_mut().unwrap() {
            c["page"] = serde_json::json!(0);
        }
        json["draws"][1]["flags"] = serde_json::json!(pc::display::GOURAUD_SUN);
        json["colorsBytes"] = serde_json::json!(bytes.len());
        json["colorsHash"] = serde_json::json!(color_hash(&bytes));
        for mode in 0..12 {
            let mut j = json.clone();
            let mut b = bytes.clone();
            match mode {
                1 => j["pages"][0]["vertexCount"] = serde_json::json!(65536),
                2 => j["draws"][0]["page"] = serde_json::json!(1),
                3 => j["draws"][0]["baseVertex"] = serde_json::json!(1),
                4 => b[..4].copy_from_slice(&f32::NAN.to_le_bytes()),
                5 => b[..4].copy_from_slice(&1234.0f32.to_le_bytes()),
                6 => b[12..16].copy_from_slice(&1234.0f32.to_le_bytes()),
                7 => j["states"][0]["cull"] = serde_json::json!(false),
                8 => j["pages"][0]["state"] = serde_json::json!(1),
                9 => j["states"][0]["alpha"] = serde_json::json!([1.0, 0.5]),
                10 => {
                    j["states"][0]["uvAnim"] = serde_json::json!({"cols":1,"rows":1,"frames":1,"fps":1.0,"scroll":[0.25,0.0],"phase":0.0})
                }
                11 => j["states"] = serde_json::json!([j["states"][0], j["states"][0]]),
                _ => {}
            }
            j["colorsHash"] = serde_json::json!(color_hash(&b));
            write_colors(&file, &j, &b);
            reset(None);
            let result = unsafe { Scene::load(file.path()) };
            if mode == 0 {
                let scene = result.unwrap();
                assert_eq!(scene.ldr_vaos.len(), 1);
                assert_eq!(scene.display_states.len(), 1);
                assert_eq!(scene.ldr_colors[1].unwrap().flags, pc::display::GOURAUD_SUN);
                assert_eq!(
                    scene.ldr_colors[0].unwrap().vao,
                    scene.ldr_colors[1].unwrap().vao
                );
                for c in scene.ldr_colors.iter().flatten() {
                    assert_eq!(c.page, Some(0));
                    assert_eq!(c.state, Some(0));
                    assert_eq!(c.base_vertex, 0);
                }
                assert_eq!(scene.indices(BAKED_VERTEX_BYTES, 3), Some(&[0, 1, 2][..]));
                assert_eq!(
                    scene.indices(BAKED_VERTEX_BYTES + 6, 3),
                    Some(&[2, 1, 0][..])
                );
                {
                    let state = GL.lock().unwrap();
                    let attrs: Vec<_> = state
                        .attributes
                        .iter()
                        .filter(|v| v.0 == scene.ldr_vaos[0])
                        .collect();
                    assert_eq!(
                        attrs
                            .iter()
                            .map(|v| (v.1, v.2, v.4, v.5))
                            .collect::<Vec<_>>(),
                        [
                            (0, scene.ldr_color_buffer, 24, 0),
                            (3, scene.ldr_color_buffer, 24, 12),
                            (4, scene.ldr_color_buffer, 24, 20)
                        ]
                    );
                }
                drop(scene);
            } else {
                assert!(result.is_err(), "mode {mode}");
            }
            released();
        }
        write_colors(&file, &json, &bytes);
        for operation in ["color vaos", "color attributes"] {
            reset(Some(operation));
            assert!(unsafe { Scene::load(file.path()) }.is_err());
            released();
        }
    }
    #[test]
    fn product_appearance_pages_require_recipe_identity_and_preserve_source_positions() {
        let _lock = SERIAL.lock().unwrap();
        let (mut meta, geometry, animation) = baked_fixture();
        meta.materials[0].kind = pc::Kind::Products;
        let source = pack(&meta, &geometry, &animation, &[255; 64]);
        let file = PackFile::write(&source);
        let (mut json, _) = color_sidecar(&source);
        let draw = &meta.draws[0];
        let mut bytes = Vec::new();
        for (i, uv) in [[0.0f32, 0.0], [1.0, 0.0], [0.0, 1.0]]
            .into_iter()
            .enumerate()
        {
            for value in position(draw, &geometry, i as u16)
                .unwrap()
                .into_iter()
                .chain(uv)
            {
                bytes.extend(value.to_le_bytes());
            }
            bytes.extend([42, 84, 126, 255]);
        }
        for entry in json["draws"].as_array_mut().unwrap() {
            entry["flags"] = 64.into();
            entry["page"] = 0.into();
        }
        json["pages"] = serde_json::json!([{"offset":0,"vertexCount":draw.vertex_count,"state":0}]);
        json["states"] =
            serde_json::json!([pc::display::State::for_draw(&meta, draw, Some(0), 64).unwrap()]);
        json["recipes"] = serde_json::json!([{
            "kind":"products-appearance", "version":1, "draws":[0,1], "textures":[0],
            "tileSize":32, "border":2, "parameterization":"uv-height-v1",
            "maxVertexHeightParameterError":1.0 / 255.0,
        }]);
        json["colorsBytes"] = bytes.len().into();
        for mode in 0..15 {
            let mut input = json.clone();
            let mut colors = bytes.clone();
            match mode {
                1 => {
                    input.as_object_mut().unwrap().remove("recipes");
                }
                2 => input["recipes"][0]["kind"] = "unrecognized".into(),
                3 => input["recipes"][0]["version"] = 2.into(),
                4 => input["recipes"][0]["parameterization"] = "unknown".into(),
                5 => input["recipes"][0]["tileSize"] = 64.into(),
                6 => input["recipes"][0]["border"] = 0.into(),
                7 => input["recipes"][0]["maxVertexHeightParameterError"] = (2.0 / 255.0).into(),
                8 => input["recipes"][0]["draws"] = serde_json::json!([0]),
                9 => input["recipes"][0]["textures"] = serde_json::json!([9]),
                10 => input["recipes"][0]["textures"] = serde_json::json!([0, 0]),
                11 => input["recipes"][0]["draws"] = serde_json::json!([0, 1, 1]),
                12 => colors[12..16].copy_from_slice(&(1.0 + f32::EPSILON).to_le_bytes()),
                13 => colors[..4]
                    .copy_from_slice(&f32::from_bits(0.125f32.to_bits() + 1).to_le_bytes()),
                14 => input["draws"][0]["flags"] = 65.into(),
                _ => {}
            }
            input["colorsHash"] = color_hash(&colors).into();
            write_colors(&file, &input, &colors);
            reset(None);
            let result = unsafe { Scene::load(file.path()) };
            if mode == 0 {
                let scene = result.unwrap();
                assert_eq!(scene.ldr_vaos.len(), 1);
                assert!(scene
                    .ldr_colors
                    .iter()
                    .all(|entry| entry.unwrap().flags == 64));
                assert_eq!(
                    scene.indices(draw.indices.offset, draw.index_count),
                    Some(&[0, 1, 2][..])
                );
                drop(scene);
            } else {
                let error = result.err().expect("invalid appearance sidecar");
                assert!(error.contains("LDR"), "mode {mode}: {error}");
            }
            released();
        }
    }

    fn product_indices_fixture() -> (pc::Meta, Vec<u8>, Vec<f32>, Vec<u8>, serde_json::Value, Vec<u8>) {
        let (mut meta, original, animation) = float_fixture();
        meta.materials[0].kind = pc::Kind::Products;
        let draw = &mut meta.draws[0];
        draw.node = None; draw.skin = None;
        let vertices = pc::parts::slice(&original, &draw.vertices).unwrap();
        let mut geometry = vertices.repeat(2);
        draw.vertex_count = 6; draw.vertices.size = geometry.len() as u32;
        draw.index_count = 6;
        draw.indices = pc::Range { offset: geometry.len() as u32, size: 12 };
        let original_indices = [0u16, 1, 2, 3, 5, 4];
        for index in original_indices { geometry.extend(index.to_le_bytes()); }
        draw.lods.clear();
        for error in [0.1, 0.2] {
            draw.lods.push(pc::DrawLod { indices: pc::Range { offset: geometry.len() as u32, size: 12 }, index_count: 6, error });
            for index in original_indices { geometry.extend(index.to_le_bytes()); }
        }
        // A second original draw contributes three vertices before this
        // display draw's page base; no page padding exceeds the source budget.
        let mut prefix_draw = meta.draws[0].clone();
        prefix_draw.vertex_count = 3; prefix_draw.vertices.size = 3 * stride(prefix_draw.layout);
        prefix_draw.index_count = 3; prefix_draw.indices.size = 6; prefix_draw.lods.clear();
        meta.draws.push(prefix_draw);
        let source = pack(&meta, &geometry, &animation, &[255; 64]);
        let (mut json, _) = color_sidecar(&source);
        let draw = &meta.draws[0];
        // Nonzero page base proves override u16 values stay source-local.
        let mut colors = Vec::new();
        for index in [0, 1, 2].into_iter().chain(0..6) {
            for value in position(draw, &geometry, index as u16).unwrap().into_iter()
                .chain([[0.0f32,0.0], [1.0,0.0], [0.0,1.0]][index % 3])
            { colors.extend(value.to_le_bytes()); }
            colors.extend([255; 4]);
        }
        let vertex_bytes = colors.len();
        for index in [0u16, 1, 2] { colors.extend(index.to_le_bytes()); }
        let original_state = pc::display::State::for_draw(&meta, draw, Some(0), 64).unwrap();
        let mut override_state = original_state.clone(); override_state.cull = false;
        json["version"] = 3.into(); json["vertexBytes"] = vertex_bytes.into();
        for entry in json["draws"].as_array_mut().unwrap() {
            entry["flags"] = 64.into(); entry["page"] = 0.into();
        }
        json["draws"][0]["baseVertex"] = 3.into();
        json["pages"] = serde_json::json!([{"offset":0,"vertexCount":9,"state":0}]);
        json["states"] = serde_json::json!([original_state, override_state]);
        json["indexOverrides"] = serde_json::json!([{ "draw":0, "source":draw.lods[0].indices,
            "indices":{"offset":vertex_bytes,"size":6}, "state":1 }]);
        json["recipes"] = serde_json::json!([{"kind":"products-appearance","version":1,"draws":[0,1],
            "textures":[0],"tileSize":32,"border":2,"parameterization":"uv-height-v1",
            "maxVertexHeightParameterError":1.0 / 255.0}]);
        json["colorsBytes"] = colors.len().into(); json["colorsHash"] = color_hash(&colors).into();
        (meta, geometry, animation, source, json, colors)
    }

    #[test]
    fn products_reverse_lod_uses_source_local_indices_and_cull_only_state_without_gpu_tail() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, _, source, json, colors) = product_indices_fixture();
        let file = PackFile::write(&source); write_colors(&file, &json, &colors);
        let range = &meta.draws[0].lods[0].indices;
        for performance in [true, false] {
            reset(None); GL.lock().unwrap().capture_buffers = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert_eq!(serde_json::to_vec(&scene.meta).unwrap(), serde_json::to_vec(&meta).unwrap());
            if performance {
                let replaced = scene.index_override(0, range).unwrap();
                assert_eq!(replaced.indices, [0, 1, 2]);
                assert_eq!(replaced.state, 1);
                assert_eq!(scene.ldr_colors[0].unwrap().base_vertex, 3);
                assert!(scene.display_states[0].cull);
                assert!(!scene.display_states[replaced.state as usize].cull);
                assert_eq!(scene.indices(range.offset, 6), Some(&[0, 1, 2, 3, 5, 4][..]));
                assert_eq!(scene.ldr_color_bytes, 216);
                assert_eq!(GL.lock().unwrap().buffer_data[&scene.ldr_color_buffer], colors[..216]);
                assert!(scene.cpu_index_bytes >= replaced.indices.len() * 2);
            } else {
                assert!(scene.index_override(0, range).is_none());
                assert_original_resources_only(&scene);
                assert_eq!(GL.lock().unwrap().buffer_data[&scene.geometry], geometry);
            }
            assert!(scene.index_override(1, range).is_none());
            assert!(scene.index_override(usize::MAX, range).is_none());
            assert!(scene.index_override(0, &meta.draws[0].indices).is_none());
            assert!(scene.index_override(0, &meta.draws[0].lods[1].indices).is_none());
            assert!(scene.index_override(0, &pc::Range { offset:range.offset, size:6 }).is_none());
            drop(scene); released();
        }
        // V2 retains every source triangle and has no derived state override.
        let mut legacy = json.clone();
        legacy["version"] = 2.into(); legacy.as_object_mut().unwrap().remove("vertexBytes");
        legacy.as_object_mut().unwrap().remove("indexOverrides");
        legacy["states"].as_array_mut().unwrap().truncate(1);
        legacy["colorsBytes"] = 216.into(); legacy["colorsHash"] = color_hash(&colors[..216]).into();
        write_colors(&file, &legacy, &colors[..216]);
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert!(scene.index_override(0, range).is_none());
        assert_eq!(scene.indices(range.offset, 6), Some(&[0, 1, 2, 3, 5, 4][..]));
        drop(scene); released();
    }

    #[test]
    fn products_reverse_lod_reuses_existing_two_sided_state() {
        let _lock = SERIAL.lock().unwrap();
        let (mut meta, geometry, animation, _, mut json, colors) = product_indices_fixture();
        meta.materials[0].double_sided = true;
        let source = pack(&meta, &geometry, &animation, &[255; 64]);
        let parsed = pc::ipod::parse(&source).unwrap();
        json["metaHash"] = color_hash(parsed.section(pc::TAG_META).unwrap()).into();
        let state = pc::display::State::for_draw(&meta, &meta.draws[0], Some(0), 64).unwrap();
        assert!(!state.cull);
        json["states"] = serde_json::json!([state]);
        json["indexOverrides"][0]["state"] = 0.into();
        let file = PackFile::write(&source);
        write_colors(&file, &json, &colors);
        let range = &meta.draws[0].lods[0].indices;
        for performance in [true, false] {
            reset(None);
            GL.lock().unwrap().capture_buffers = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert_eq!(serde_json::to_vec(&scene.meta).unwrap(), serde_json::to_vec(&meta).unwrap());
            if performance {
                assert_eq!(scene.indices(range.offset, 6), Some(&[0, 1, 2, 3, 5, 4][..]));
                let replaced = scene.index_override(0, range).unwrap();
                assert_eq!(replaced.indices, [0, 1, 2]);
                assert_eq!(replaced.state, 0);
                assert_eq!(scene.display_states.len(), 1);
                assert!(!scene.display_states[0].cull);
            } else {
                assert!(scene.index_override(0, range).is_none());
                assert_original_resources_only(&scene);
                assert_eq!(GL.lock().unwrap().buffer_data[&scene.geometry], geometry);
            }
            drop(scene);
            released();
        }
    }

    #[test]
    fn products_reverse_lod_rejects_partial_topology_wrong_state_ranges_and_tail_corruption() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, animation, source, json, colors) = product_indices_fixture();
        let file = PackFile::write(&source);
        for fault in 0..20 {
            let mut input = json.clone(); let mut bytes = colors.clone();
            let mut original = geometry.clone();
            match fault {
                0 => { input.as_object_mut().unwrap().remove("vertexBytes"); },
                1 => input["vertexBytes"] = 212.into(),
                2 => input["indexOverrides"][0]["draw"] = 99.into(),
                3 => input["indexOverrides"][0]["state"] = 99.into(),
                4 => input["indexOverrides"][0]["source"] = serde_json::json!(meta.draws[0].indices),
                5 => input["indexOverrides"][0]["source"]["offset"] = (meta.draws[0].lods[0].indices.offset + 2).into(),
                6 => input["indexOverrides"][0]["indices"]["offset"] = 214.into(),
                7 => input["indexOverrides"][0]["indices"]["offset"] = 217.into(),
                8 => input["indexOverrides"][0]["indices"]["size"] = 4.into(),
                9 => input["states"][1]["cull"] = true.into(),
                10 => input["states"][1]["polygonOffset"] = serde_json::json!([1.0,1.0]),
                11 => { let entry = input["indexOverrides"][0].clone(); input["indexOverrides"].as_array_mut().unwrap().push(entry); },
                12 => { let mut entry = input["indexOverrides"][0].clone(); entry["source"] = serde_json::json!(meta.draws[0].lods[1].indices);
                    input["indexOverrides"].as_array_mut().unwrap().push(entry); },
                13 => bytes[216..218].copy_from_slice(&6u16.to_le_bytes()),
                14 => bytes[218..220].copy_from_slice(&2u16.to_le_bytes()),
                15 => bytes[(3 + 3) * 24 + 12..(3 + 3) * 24 + 16].copy_from_slice(&0.5f32.to_le_bytes()),
                16 => bytes[(3 + 3) * 24 + 20] = 254,
                17 => { let at = meta.draws[0].lods[0].indices.offset as usize;
                    original[at + 8..at + 10].copy_from_slice(&4u16.to_le_bytes()); },
                18 => input["version"] = 2.into(),
                _ => bytes[220] ^= 1, // Keep the stale whole-bin hash.
            }
            if fault != 19 { input["colorsHash"] = color_hash(&bytes).into(); }
            input["geometryHash"] = color_hash(&original).into();
            std::fs::write(file.path(), pack(&meta, &original, &animation, &[255; 64])).unwrap();
            write_colors(&file, &input, &bytes);
            reset(None);
            let error = unsafe { Scene::load(file.path()) }.err().unwrap_or_else(|| panic!("accepted fault {fault}"));
            assert!(error.contains("LDR"), "fault {fault}: {error}");
            released();
            // Optional optimized recipes never replace or mutate Reference.
            reset(None); GL.lock().unwrap().capture_buffers = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
            assert!(scene.index_overrides.is_empty());
            assert_eq!(GL.lock().unwrap().buffer_data[&scene.geometry], original);
            drop(scene); released();
        }
        std::fs::write(file.path(), source).unwrap(); write_colors(&file, &json, &colors);
        for stage in ["color buffer", "color upload", "color vaos", "color attributes"] {
            reset(Some(stage));
            assert!(unsafe { Scene::load(file.path()) }.is_err(), "{stage}");
            released();
        }
    }

    #[test]
    fn compact_residency_keeps_raw_bytes_lods_and_shadow_demand_without_source_aliasing() {
        let _lock = SERIAL.lock().unwrap();
        let (mut meta, mut geometry, animation) = baked_fixture();
        let source_copy = geometry.clone();
        let second = geometry.len() as u32;
        geometry.extend(&source_copy);
        meta.draws[1].vertices.offset += second;
        meta.draws[1].indices.offset += second;
        for lod in &mut meta.draws[1].lods {
            lod.indices.offset += second;
        }
        let source_meta = serde_json::to_vec(&meta).unwrap();
        let source = pack(&meta, &geometry, &animation, &[255; 64]);
        let file = PackFile::write(&source);
        let (mut json, _) = color_sidecar(&source);
        let mut colors = Vec::new();
        let draw = &meta.draws[0];
        for i in 0..draw.vertex_count {
            let uv = pc::ipod::floats::<2>(
                &geometry,
                i as usize * stride(draw.layout) as usize + pc::ipod::UV,
            )
            .unwrap();
            for value in position(draw, &geometry, i as u16)
                .unwrap()
                .into_iter()
                .chain(uv)
            {
                colors.extend(value.to_le_bytes());
            }
            colors.extend([42, 84, 126, 255]);
        }
        for entry in json["draws"].as_array_mut().unwrap() {
            entry["page"] = 0.into();
        }
        json["pages"] = serde_json::json!([{"offset":0,"vertexCount":3,"state":0}]);
        json["states"] =
            serde_json::json!([pc::display::State::for_draw(&meta, draw, Some(0), 0).unwrap()]);
        json["colorsBytes"] = colors.len().into();
        json["colorsHash"] = color_hash(&colors).into();
        for (both_pages, shadow, performance) in [
            (false, false, true),
            (true, false, true),
            (true, true, true),
            (true, false, false),
        ] {
            let mut entries = json.clone();
            if !both_pages {
                entries["draws"].as_array_mut().unwrap().truncate(1);
            }
            write_colors(&file, &entries, &colors);
            let mut manifest = crate::texture_usage::tests::manifest(
                &meta,
                if shadow {
                    &["uAlbedo", "uShadow"]
                } else {
                    &["uAlbedo"]
                },
            );
            for (i, d) in manifest["draws"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .enumerate()
            {
                d["display_color"] = (i == 0 || both_pages).into();
                d["display_float"] = (i == 0 || both_pages).into();
                d["display_texture"] = 0.into();
            }
            std::fs::write(
                sidecar_path(file.path(), "pipelines.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            reset(None);
            GL.lock().unwrap().capture_buffers = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert_eq!(serde_json::to_vec(&scene.meta).unwrap(), source_meta);
            let all_resident = !performance || shadow;
            let uploaded = if all_resident {
                &geometry[..]
            } else if both_pages {
                &[][..]
            } else {
                &geometry[second as usize..]
            };
            assert_eq!(
                scene.gpu_bytes,
                uploaded.len() + if performance { 32 + colors.len() } else { 64 }
            );
            {
                let gl = GL.lock().unwrap();
                if uploaded.is_empty() {
                    assert_eq!(scene.geometry, 0);
                    assert!(scene.vaos.iter().all(|&v| v == 0));
                } else {
                    assert_eq!(gl.buffer_data[&scene.geometry], uploaded);
                }
                for (i, d) in meta.draws.iter().enumerate() {
                    let retained = all_resident || (i == 1 && !both_pages);
                    let base = if all_resident { d.vertices.offset } else { 0 };
                    assert_eq!(scene.gpu_vertex_offset(i), retained.then_some(base));
                    assert_eq!(scene.vaos[i] != 0, retained);
                    if retained {
                        assert!(gl.attributes.contains(&(
                            scene.vaos[i],
                            0,
                            scene.geometry,
                            3,
                            stride(d.layout) as i32,
                            base as usize
                        )));
                    }
                    for (r, count) in core::iter::once((&d.indices, d.index_count))
                        .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
                    {
                        let expected = if all_resident {
                            r.offset
                        } else {
                            r.offset - if i == 1 { second } else { 0 }
                        };
                        assert_eq!(
                            scene.gpu_index_offset(r.offset, count),
                            retained.then_some(expected)
                        );
                        if performance {
                            let expected: Vec<_> = pc::parts::slice(&geometry, r)
                                .unwrap()
                                .chunks_exact(2)
                                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                                .collect();
                            assert_eq!(scene.indices(r.offset, count), Some(expected.as_slice()));
                        }
                    }
                }
            }
            assert!(scene.gpu_index_offset(geometry.len() as u32, 0).is_some());
            unsafe {
                scene.reset_index_bindings();
            }
            drop(scene);
            released();
        }
        // The last manifest has no shadow demand. Cover every partially
        // created mixed-residency object and the all-display/no-source case.
        for both_pages in [false, true] {
            let mut entries = json.clone();
            if !both_pages {
                entries["draws"].as_array_mut().unwrap().truncate(1);
            }
            write_colors(&file, &entries, &colors);
            let stages: &[&str] = if both_pages {
                &[
                    "buffer",
                    "zero buffer",
                    "geometry upload",
                    "vaos",
                    "attributes",
                ]
            } else {
                &[
                    "buffer",
                    "zero buffer",
                    "geometry upload",
                    "vaos",
                    "attributes",
                    "color buffer",
                    "color upload",
                    "color vaos",
                    "color attributes",
                ]
            };
            for &failure in stages {
                reset(Some(failure));
                assert!(
                    unsafe { Scene::load(file.path()) }.is_err(),
                    "{both_pages}: {failure}"
                );
                released();
            }
        }
        for indices in [false, true] {
            let mut corrupt = geometry.clone();
            if indices {
                let at = meta.draws[0].indices.offset as usize;
                corrupt[at..at + 2].copy_from_slice(&u16::MAX.to_le_bytes());
            } else {
                corrupt[..4].copy_from_slice(&f32::NAN.to_le_bytes());
            }
            std::fs::write(file.path(), pack(&meta, &corrupt, &animation, &[255; 64])).unwrap();
            reset(None);
            let error = unsafe { Scene::load(file.path()) }.err().unwrap();
            assert!(
                error.contains(if indices {
                    "index exceeds"
                } else {
                    "non-finite"
                }),
                "{error}"
            );
            released();
        }
    }

    #[test]
    fn appearance_pages_remap_only_uv_and_do_not_skip_ordinary_alias_validation() {
        let (meta, geometry, _) = baked_fixture();
        let d = &meta.draws[0];
        let make = |flags: &[u32]| {
            let mut bytes = Vec::new();
            for (i, uv) in [[0.0f32, 0.0], [1.0, 0.0], [0.0, 1.0]]
                .into_iter()
                .enumerate()
            {
                for value in position(d, &geometry, i as u16)
                    .unwrap()
                    .into_iter()
                    .chain(uv)
                {
                    bytes.extend(value.to_le_bytes());
                }
                bytes.extend([42, 84, 126, 255]);
            }
            ColorFile {
                vertex_bytes: bytes.len() as u32,
                index_overrides: Vec::new(),
                bytes,
                draws: flags
                    .iter()
                    .enumerate()
                    .map(|(i, &flags)| ColorEntry {
                        draw: i as u32,
                        offset: 0,
                        vertex_count: d.vertex_count,
                        texture: Some(0),
                        flags,
                        page: Some(0),
                        base_vertex: 0,
                    })
                    .collect(),
                pages: vec![ColorPage {
                    offset: 0,
                    vertex_count: d.vertex_count,
                    state: 0,
                }],
                states: Vec::new(),
            }
        };
        make(&[64, 64])
            .validate_float_geometry(&meta, &geometry)
            .unwrap();
        // Positions stay bit-exact source values: even one representable step
        // fails. The appearance recipe changes only finite normalized UVs.
        for (offset, value) in [
            (0, f32::from_bits(0.125f32.to_bits() + 1)),
            (0, f32::NAN),
            (12, -f32::EPSILON),
            (16, 1.0 + f32::EPSILON),
            (12, f32::INFINITY),
            (16, f32::NAN),
        ] {
            let mut colors = make(&[64]);
            colors.bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(
                colors.validate_float_geometry(&meta, &geometry).is_err(),
                "offset {offset}, value {value}"
            );
        }
        for flags in [&[0][..], &[64, 0][..], &[0, 64][..]] {
            assert!(
                make(flags)
                    .validate_float_geometry(&meta, &geometry)
                    .is_err(),
                "ordinary alias flags {flags:?}"
            );
        }
    }

    #[test]
    fn wet_and_glass_colors_retain_normals_and_require_their_material_contract() {
        let _lock = SERIAL.lock().unwrap();
        for flags in [16, 32] {
            for invalid in [false, true] {
                let (mut m, g, a) = baked_fixture();
                if flags == 16 {
                    m.materials[0].wet = Some(pc::Wet {
                        planar: !invalid,
                        ..Default::default()
                    });
                } else {
                    m.materials[0].kind = if invalid {
                        pc::Kind::Standard
                    } else {
                        pc::Kind::Glass
                    };
                }
                let source = pack(&m, &g, &a, &[255; 64]);
                let file = PackFile::write(&source);
                let (mut json, bytes) = color_sidecar(&source);
                for d in json["draws"].as_array_mut().unwrap() {
                    d["flags"] = serde_json::json!(flags);
                    if flags == 32 {
                        d["texture"] = serde_json::Value::Null;
                    }
                }
                write_colors(&file, &json, &bytes);
                reset(None);
                let result = unsafe { Scene::load(file.path()) };
                if invalid {
                    assert!(result.is_err());
                } else {
                    let scene = result.unwrap();
                    for (i, c) in scene.ldr_colors.iter().enumerate() {
                        let state = GL.lock().unwrap();
                        let normal = state
                            .attributes
                            .iter()
                            .find(|a| a.0 == c.unwrap().vao && a.1 == 1)
                            .unwrap();
                        assert_eq!(
                            (normal.2, normal.3, normal.4, normal.5),
                            (
                                scene.geometry,
                                3,
                                stride(scene.meta.draws[i].layout) as i32,
                                scene.meta.draws[i].vertices.offset as usize + pc::ipod::NORMAL
                            )
                        );
                    }
                    drop(scene);
                }
                released();
            }
        }
    }

    #[test]
    fn wet_response_requires_a_bounded_multiplier_without_changing_source_fallback() {
        let _lock = SERIAL.lock().unwrap();
        for darken in [0.0, 1.0, -0.01, 1.01] {
            let (mut m, g, a) = baked_fixture();
            m.materials[0].wet = Some(pc::Wet { planar: true, darken, ..Default::default() });
            let source = pack(&m, &g, &a, &[255; 64]);
            let file = PackFile::write(&source);
            // Source and Reference remain valid. Only the RGBA8 response
            // approximation rejects a multiplier outside its encoded range.
            for performance in [true, false] {
                reset(None);
                let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
                assert_eq!(scene.meta.materials[0].wet.as_ref().unwrap().darken, darken);
                assert!(scene.ldr_colors.iter().all(Option::is_none));
                drop(scene);
                released();
            }
            let (mut json, bytes) = color_sidecar(&source);
            for d in json["draws"].as_array_mut().unwrap() { d["flags"] = 16.into(); }
            write_colors(&file, &json, &bytes);
            reset(None);
            let result = unsafe { Scene::load(file.path()) };
            assert_eq!(result.is_ok(), (0.0..=1.0).contains(&darken));
            drop(result);
            released();
        }
    }

    #[test]
    fn mesh_texture_cache_tracks_units_targets_and_program_samplers_with_unknown_pass_state() {
        let _lock = SERIAL.lock().unwrap();
        reset(None);
        let a = crate::gpu::Program::test_samplers(101, &[("color", 2, GL_TEXTURE_2D), ("env", 3, GL_TEXTURE_CUBE_MAP)]);
        let b = crate::gpu::Program::test_samplers(102, &[("color", 7, GL_TEXTURE_2D), ("env", 9, GL_TEXTURE_CUBE_MAP)]);
        let mut cache = crate::gpu::TextureBindings::default();
        unsafe {
            a.bind();
            assert_eq!(a.tex_cached("absent", 99, 0, &mut cache), 0);
            a.tex_cached("color", 10, 0, &mut cache);
            a.tex_cached("color", 10, 0, &mut cache);
            a.tex_cached("env", 11, 0, &mut cache);
            a.tex_cached("color", 10, 0, &mut cache);
            a.tex_cached("env", 11, 0, &mut cache);
            // Binding state is shared, but b's two sampler uniforms are new.
            b.bind();
            b.tex_cached("color", 10, 0, &mut cache);
            b.tex_cached("env", 11, 0, &mut cache);
            b.tex_cached("color", 12, 1, &mut cache);
            b.tex_cached("env", 11, 0, &mut cache); // A hit does not activate unit 0.
            b.tex_cached("color", 13, 1, &mut cache); // Still active: no redundant activation.
            b.tex_cached("color", 10, 0, &mut cache); // Binding hit, sampler changes unit.
        }
        {
            let state = GL.lock().unwrap();
            assert_eq!(state.active_texture_calls, [0, 1]);
            assert_eq!(state.texture_bind_calls, [(0, GL_TEXTURE_2D, 10),
                (0, GL_TEXTURE_CUBE_MAP, 11), (1, GL_TEXTURE_2D, 12), (1, GL_TEXTURE_2D, 13)]);
            assert_eq!(state.sampler_uniforms, [(101, 2, 0), (101, 3, 0),
                (102, 7, 0), (102, 9, 0), (102, 7, 1), (102, 7, 0)]);
        }
        unsafe {
            // Effects can overwrite context state between passes. A new cache
            // must bind even when the program's sampler value is unchanged.
            b.tex("color", 14, 0);
            let mut next_pass = crate::gpu::TextureBindings::default();
            b.tex_cached("color", 10, 0, &mut next_pass);
            b.tex_cached("color", 10, 0, &mut next_pass);
            // Beyond the bounded table, retain ordinary bind semantics.
            b.tex_cached("color", 15, 8, &mut next_pass);
            b.tex_cached("color", 15, 8, &mut next_pass);
            b.tex_cached("env", 11, 0, &mut next_pass);
        }
        let state = GL.lock().unwrap();
        assert_eq!(&state.texture_bind_calls[4..], [(0, GL_TEXTURE_2D, 14), (0, GL_TEXTURE_2D, 10),
            (8, GL_TEXTURE_2D, 15), (8, GL_TEXTURE_2D, 15), (0, GL_TEXTURE_CUBE_MAP, 11)]);
        assert_eq!(&state.active_texture_calls[2..], [0, 0, 8, 0]);
        assert_eq!(&state.sampler_uniforms[6..], [(102, 7, 8)]);
    }

    #[test]
    fn solid_cube_fallback_owns_six_faces_and_never_reuses_a_2d_texture_name() {
        let _lock = SERIAL.lock().unwrap();
        reset(None);
        GL.lock().unwrap().capture_textures = true;
        let mut objects = crate::gpu::Objects::default();
        let image = unsafe { objects.image(1, 1, &[255; 4]) };
        let cube = unsafe { objects.solid_cube([255; 4]) };
        assert_ne!(image, cube);
        {
            let state = GL.lock().unwrap();
            assert_eq!(state.texture_targets[&image], GL_TEXTURE_2D);
            assert_eq!(state.texture_targets[&cube], GL_TEXTURE_CUBE_MAP);
            let faces: Vec<_> = state.texture_uploads.iter().filter(|u| u.texture == cube).collect();
            assert_eq!(faces.len(), 6);
            for (face, upload) in faces.iter().enumerate() {
                assert_eq!(upload.target, GL_TEXTURE_CUBE_MAP_POSITIVE_X + face as u32);
                assert_eq!((upload.width, upload.height, upload.level), (1, 1, 0));
                assert_eq!(upload.data, [255; 4]);
            }
        }
        drop(objects);
        released();
    }
    #[test]
    fn malformed_and_stale_color_sidecars_fail_without_gpu_leaks() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = baked_fixture();
        let source = pack(&m, &g, &a, &[255; 64]);
        let file = PackFile::write(&source);
        for mode in 0..13 {
            let (mut json, mut bytes) = color_sidecar(&source);
            match mode {
                0 => json["metaHash"] = serde_json::json!("stale"),
                1 => json["geometryHash"] = serde_json::json!("stale"),
                2 => json["animationHash"] = serde_json::json!("stale"),
                3 => json["draws"][0]["offset"] = serde_json::json!(4294967292u32),
                4 => json["draws"][0]["vertexCount"] = serde_json::json!(4),
                5 => json["draws"][1]["draw"] = serde_json::json!(0),
                6 => json["draws"][0]["flags"] = serde_json::json!(128),
                7 => json["draws"][0]["texture"] = serde_json::json!(999),
                8 => bytes[0] ^= 1,
                9 => {
                    bytes.pop();
                }
                11 => json["textureHash"] = serde_json::json!("stale"),
                12 => {
                    json.as_object_mut().unwrap().remove("textureHash");
                }
                _ => {}
            }
            write_colors(&file, &json, &bytes);
            if mode == 10 {
                std::fs::remove_file(color_path(file.path(), "bin")).unwrap();
            }
            reset(None);
            let error = unsafe { Scene::load(file.path()) }
                .err()
                .expect("invalid sidecar");
            assert!(error.contains("LDR"), "{mode}: {error}");
            released();
        }
    }
    #[test]
    fn changed_texture_payload_invalidates_colors_with_unchanged_metadata() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = baked_fixture();
        let source = pack(&m, &g, &a, &[255; 64]);
        let (json, colors) = color_sidecar(&source);
        let mut texture = [255; 64];
        texture[0] = 17;
        let changed = pack(&m, &g, &a, &texture);
        let original = parse(&source).unwrap();
        let replacement = parse(&changed).unwrap();
        for tag in [pc::TAG_META, pc::TAG_GEOMETRY, pc::TAG_ANIMATION] {
            assert_eq!(
                original.section(tag).unwrap(),
                replacement.section(tag).unwrap()
            );
        }
        let file = PackFile::write(&changed);
        write_colors(&file, &json, &colors);
        reset(None);
        let error = unsafe { Scene::load(file.path()) }.err().unwrap();
        assert!(error.contains("LDR colors do not match"), "{error}");
        released();
    }

    #[test]
    fn display_texture_residency_skips_only_uploads_and_preserves_identity_and_cleanup() {
        let _lock = SERIAL.lock().unwrap();
        let (mut meta, geometry, animation) = baked_fixture();
        meta.textures.resize(4, meta.textures[0].clone());
        for (i, texture) in meta.textures.iter_mut().enumerate() {
            texture.data.offset = (i * 64) as u32;
        }
        meta.materials[0].albedo = Some(1);
        meta.materials[0].emission = Some(3);
        meta.materials[0].normal = Some(0);
        meta.materials[0].orm = Some(2);
        let pixels = [255; 256];
        let source = pack(&meta, &geometry, &animation, &pixels);
        let file = PackFile::write(&source);
        let manifest = crate::texture_usage::tests::manifest(&meta, &["uAlbedo", "uEmission"]);
        let pipeline_path = sidecar_path(file.path(), "pipelines.json");
        for mask in 0..16 {
            let samplers: Vec<_> = ["uNormalMap", "uAlbedo", "uOrm", "uEmission"]
                .into_iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, name)| name)
                .collect();
            let demand = crate::texture_usage::tests::manifest(&meta, &samplers);
            std::fs::write(&pipeline_path, serde_json::to_vec(&demand).unwrap()).unwrap();
            reset(None);
            let scene = unsafe { Scene::load(file.path()) }.unwrap();
            for (i, &id) in scene.textures.iter().enumerate() {
                assert_eq!(id != 0, mask & (1 << i) != 0);
            }
            drop(scene);
            released();
        }
        std::fs::write(&pipeline_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_eq!(
            scene.textures.iter().map(|&id| id != 0).collect::<Vec<_>>(),
            [false, true, false, true]
        );
        assert_ne!(scene.textures[1], scene.textures[3]);
        assert_eq!(scene.gpu_bytes, geometry.len() + 64);
        drop(scene);
        released();
        // Every source upload failure still belongs to Scene, even with holes
        // in the META-indexed texture names.
        for failure in ["textures", "texture upload", "buffer", "vaos"] {
            reset(Some(failure));
            assert!(unsafe { Scene::load(file.path()) }.is_err());
            released();
        }
        // A missing manifest remains backwards compatible; Retina disregards
        // this optional optimization and still uploads all four textures.
        reset(None);
        let scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
        assert_original_resources_only(&scene);
        assert_eq!(scene.gpu_bytes, geometry.len() + pixels.len());
        drop(scene);
        released();
        let (mut colors, bytes) = color_sidecar(&source);
        for draw in colors["draws"].as_array_mut().unwrap() {
            draw["texture"] = 1.into();
        }
        write_colors(&file, &colors, &bytes);
        let mut changed = pixels;
        changed[0] = 17; // Unresident texture zero remains part of textureHash.
        std::fs::write(file.path(), pack(&meta, &geometry, &animation, &changed)).unwrap();
        reset(None);
        let error = unsafe { Scene::load(file.path()) }.err().unwrap();
        assert!(error.contains("LDR colors do not match"), "{error}");
        released();
        let mut bad_manifest = manifest;
        bad_manifest["texture_usage"]["draws"][0]["program"] = serde_json::json!(["wrong", "f"]);
        std::fs::write(pipeline_path, serde_json::to_vec(&bad_manifest).unwrap()).unwrap();
        reset(None);
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("texture usage"));
        assert_eq!(GL.lock().unwrap().next, 0);
        released();
    }
    #[test]
    fn independent_emission_flag_requires_matching_material_capability() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, g, a) = baked_fixture();
        for mode in 0..4 {
            m.materials[0].emission = if mode == 1 { None } else { Some(0) };
            m.materials[0].emission_shade = if mode == 2 {
                Some(pc::EmissionShade {
                    normal: [0.0, 1.0, 0.0, 0.0],
                    height: [0.0, 1.0, 0.5, 1.0],
                })
            } else {
                None
            };
            let source = pack(&m, &g, &a, &[255; 64]);
            let file = PackFile::write(&source);
            let (mut json, bytes) = color_sidecar(&source);
            for d in json["draws"].as_array_mut().unwrap() {
                d["flags"] = serde_json::json!(8);
                if mode == 3 {
                    d["texture"] = serde_json::Value::Null;
                }
            }
            write_colors(&file, &json, &bytes);
            reset(None);
            let result = unsafe { Scene::load(file.path()) };
            if mode == 0 {
                let scene = result.unwrap();
                assert!(scene.ldr_colors.iter().all(|c| c.unwrap().flags == 8));
                drop(scene);
            } else {
                assert!(result.is_err());
            }
            released();
        }
    }

    #[test]
    fn ldr_gpu_failure_paths_release_both_buffers_and_all_vaos() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = baked_fixture();
        let source = pack(&m, &g, &a, &[255; 64]);
        let file = PackFile::write(&source);
        let (json, bytes) = color_sidecar(&source);
        write_colors(&file, &json, &bytes);
        for stage in [
            "color buffer",
            "color upload",
            "color vaos",
            "color attributes",
        ] {
            reset(Some(stage));
            let error = unsafe { Scene::load(file.path()) }.err().expect(stage);
            assert!(error.contains("GLES error"), "{stage}: {error}");
            released();
        }
    }

    #[test]
    fn static_index_cache_deduplicates_lods_and_excludes_vertex_payloads() {
        let (m, geometry, _) = baked_fixture();
        let cache = IndexCache::new(&m, &geometry, &[]).unwrap();
        assert_eq!(cache.data, [0, 1, 2, 2, 1, 0]);
        assert_eq!(cache.ranges.len(), 1);
        assert_eq!(cache.get(BAKED_VERTEX_BYTES, 3), Some(&[0, 1, 2][..]));
        assert_eq!(cache.get(BAKED_VERTEX_BYTES + 6, 3), Some(&[2, 1, 0][..]));
        assert_eq!(
            cache.get(BAKED_VERTEX_BYTES + 2, 4),
            Some(&[1, 2, 2, 1][..])
        );
        for (offset, count) in [
            (0, 3),
            (BAKED_VERTEX_BYTES + 1, 3),
            (BAKED_VERTEX_BYTES + 10, 2),
            (u32::MAX - 1, 3),
            (BAKED_VERTEX_BYTES, u32::MAX),
        ] {
            assert!(cache.get(offset, count).is_none());
        }
        assert_eq!(cache.bytes(), 12 + core::mem::size_of::<IndexRange>());
        for mode in 0..4 {
            let mut meta = m.clone();
            for d in &mut meta.draws {
                match mode {
                    0 => d.node = Some(0),
                    1 => d.skin = Some(0),
                    _ => {}
                }
            }
            match mode {
                2 => meta.materials[0].blend = pc::Blend::Alpha,
                3 => meta.materials[0].depth_write = false,
                _ => {}
            }
            assert_eq!(IndexCache::new(&meta, &geometry, &[]).unwrap().bytes(), 0);
        }
    }

    #[test]
    fn index_cache_rejects_bad_ranges_and_scene_exposes_only_retained_indices() {
        let _lock = SERIAL.lock().unwrap();
        let (m, geometry, animation) = baked_fixture();
        for mode in 0..3 {
            let mut bad = m.clone();
            match mode {
                0 => bad.draws[0].indices.offset = BAKED_VERTEX_BYTES + 1,
                1 => bad.draws[0].indices.size = 4,
                _ => bad.draws[0].indices.offset = u32::MAX - 1,
            }
            assert!(IndexCache::new(&bad, &geometry, &[]).is_err());
        }
        reset(None);
        let file = PackFile::write(&pack(&m, &geometry, &animation, &[255; 64]));
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_eq!(scene.indices(BAKED_VERTEX_BYTES, 3), Some(&[0, 1, 2][..]));
        assert_eq!(
            scene.indices(BAKED_VERTEX_BYTES + 6, 3),
            Some(&[2, 1, 0][..])
        );
        assert!(scene.indices(0, 3).is_none());
        assert_eq!(
            scene.cpu_index_bytes,
            12 + core::mem::size_of::<IndexRange>()
        );
        drop(scene);
        released();
    }
    #[test]
    fn late_payload_errors_also_release_previously_uploaded_textures() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, mut g, a) = float_fixture();
        reset(None);
        let last_index = m.draws[0].indices.offset as usize + 4;
        g[last_index] = 3;
        let file = PackFile::write(&pack(&m, &g, &a, &[255; 64]));
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("index exceeds"));
        released();
        assert_eq!(GL.lock().unwrap().next, 1);
        g[last_index] = 2;
        let mut hdr = m.textures[0].clone();
        hdr.role = pc::TexRole::Environment;
        hdr.format = pc::TexFormat::Rgba16f;
        hdr.data = pc::Range {
            offset: 64,
            size: 128,
        };
        m.textures.push(hdr);
        let mut pixels = vec![255; 64];
        pixels.extend([0, 0x7e].repeat(64));
        reset(None);
        let file = PackFile::write(&pack(&m, &g, &a, &pixels));
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("non-finite half-float"));
        released();
        assert_eq!(GL.lock().unwrap().next, 2);
    }
    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to existing GLES packs; GL is mocked"]
    fn streaming_load_and_drop_real_packs_keeps_no_gpu_names() {
        let _lock = SERIAL.lock().unwrap();
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").expect("pack directory");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") {
                continue;
            }
            reset(None);
            let mut scene = unsafe { Scene::load(path.to_str().unwrap()) }
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert!(scene.performance);
            assert_eq!(scene.vaos.len(), scene.meta.draws.len());
            assert_eq!(scene.textures.len(), scene.meta.textures.len());
            // Independently inspect the actual emitted shader declarations,
            // rather than trusting the manifest used by the loader. This is
            // conservative relative to driver-active uniform reflection.
            let pipeline_path = path.with_extension("pipelines.json");
            if pipeline_path.exists() {
                let pipelines: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(pipeline_path).unwrap()).unwrap();
                let cfg: crate::pipelines::Pipelines = serde_json::from_value(pipelines.clone()).unwrap();
                cfg.validate_windows(scene.meta.draws.len(), |i| scene.window_vertex_params(i)).unwrap();
                let mut cache = BTreeMap::<String, BTreeSet<String>>::new();
                let mut declarations = |pair: &serde_json::Value| {
                    let mut names = BTreeSet::new();
                    for name in pair.as_array().unwrap().iter().map(|v| v.as_str().unwrap()) {
                        let found = cache.entry(name.into()).or_insert_with(|| {
                            let source = std::fs::read_to_string(
                                path.parent()
                                    .unwrap()
                                    .join("shaders")
                                    .join(format!("{name}.glsl")),
                            )
                            .unwrap();
                            source
                                .lines()
                                .filter(|line| line.trim_start().starts_with("uniform "))
                                .filter_map(|line| {
                                    let mut words = line.split_whitespace();
                                    words.find(|&word| word == "sampler2D")?;
                                    Some(words.next().unwrap().trim_end_matches(';').into())
                                })
                                .collect()
                        });
                        names.extend(found.iter().cloned());
                    }
                    names
                };
                let draws: Vec<_> = pipelines["draws"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|draw| {
                        if draw.is_null() {
                            BTreeSet::new()
                        } else {
                            declarations(&draw["performance"])
                        }
                    })
                    .collect();
                let sky = declarations(&pipelines["sky_performance"]);
                crate::texture_usage::validate_resident(
                    &scene.meta,
                    &scene.textures,
                    |i| scene.ldr_colors[i].map(|c| c.texture),
                    |i, name| draws[i].contains(name),
                    |name| sky.contains(name),
                )
                .unwrap();
            }
            let performance_gpu = scene.gpu_bytes;
            let skipped_texture_bytes: usize = scene
                .meta
                .textures
                .iter()
                .zip(&scene.textures)
                .filter(|(_, &id)| id == 0)
                .map(|(t, _)| {
                    t.data.size as usize
                        / if t.format == pc::TexFormat::Rgba16f {
                            2
                        } else {
                            1
                        }
                })
                .sum();
            let indices_cpu = scene.cpu_index_bytes;
            let light_cpu = scene.light_lod_source.bytes();
            let display_cpu = scene.display_states.capacity()
                * core::mem::size_of::<pc::display::State>()
                + scene.light_phase_offsets.capacity() * core::mem::size_of::<Option<u32>>()
                + scene.ldr_vaos.capacity() * 4
                + scene.display_environment_textures.capacity() * 4;
            for (di,d) in scene.meta.draws.iter().enumerate() {
                let m = &scene.meta.materials[d.material as usize];
                if d.layout == pc::VertexLayout::Baked
                    && d.node.is_none()
                    && d.skin.is_none()
                    && m.blend == pc::Blend::Opaque
                    && m.depth_write
                {
                    for (r, n) in core::iter::once((&d.indices, d.index_count))
                        .chain(scene.effective_lods(di).iter().map(|l| (&l.indices, l.index_count)))
                    {
                        if n > 0 {
                            assert_eq!(scene.indices(r.offset, n).unwrap().len(), n as usize);
                        }
                    }
                }
            }
            scene.update(3.25, Vec3::new(1.0, 2.0, 3.0), 1.0 / 60.0);
            let original = (
                serde_json::to_vec(&scene.meta).unwrap(),
                scene.anim.clone(),
                scene.world.clone(),
                scene.bone_palettes.clone(),
                scene.emissive.clone(),
            );
            drop(scene);
            released();
            reset(None);
            let mut scene = unsafe { Scene::load_for_profile(path.to_str().unwrap(), false) }
                .unwrap_or_else(|e| panic!("{} Retina: {e}", path.display()));
            assert_original_resources_only(&scene);
            scene.update(3.25, Vec3::new(1.0, 2.0, 3.0), 1.0 / 60.0);
            assert_eq!(serde_json::to_vec(&scene.meta).unwrap(), original.0);
            assert_eq!(scene.anim, original.1);
            assert_eq!(scene.world, original.2);
            assert_eq!(scene.bone_palettes, original.3);
            assert_eq!(scene.emissive, original.4);
            std::println!(
                "profiles {}: GPU performance={} Retina={} difference={}; skippedTextureBytes={}; CPU dropped index={} light={} display_tables={} bytes (host backing storage, excludes allocator overhead)",
                path.display(), performance_gpu, scene.gpu_bytes, performance_gpu as isize - scene.gpu_bytes as isize,
                skipped_texture_bytes, indices_cpu, light_cpu, display_cpu,
            );
            drop(scene);
            released();
            count += 1;
        }
        assert!(count > 0);
    }

    #[test]
    fn window_ray_recipe_requires_its_source_proof_in_both_profiles() {
        let _lock = SERIAL.lock().unwrap();
        let (mut meta, mut geometry, animation, mut recipes) = window_fixture();
        meta.draws[0].node = None;
        for vertex in geometry[..meta.draws[0].vertices.size as usize].chunks_exact_mut(52) {
            for (offset,value) in [(12,0.0f32),(16,0.0),(20,1.0),(24,1.0),(28,0.0),(32,0.0),(36,1.0)] {
                vertex[offset..offset+4].copy_from_slice(&value.to_le_bytes());
            }
        }
        recipes.window_ray_params = Some(pc::ipod::WindowRayParams { version:1, draws:vec![0] });
        for performance in [false,true] {
            reset(None);
            let file=PackFile::write(&window_pack(&meta,&geometry,&animation,&recipes));
            let scene=unsafe { Scene::load_for_profile(file.path(),performance) }.unwrap();
            assert!(scene.window_ray_params(0));assert!(!scene.window_ray_params(usize::MAX));
            drop(scene);released();
            for fault in 0..6 {
                let mut r=recipes.clone();let mut g=geometry.clone();
                match fault {
                    0=>r.window_vertex_params=None,
                    1=>r.window_ray_params.as_mut().unwrap().version=2,
                    2=>r.window_ray_params.as_mut().unwrap().draws.clear(),
                    3=>r.window_ray_params.as_mut().unwrap().draws.push(0),
                    4=>r.window_ray_params.as_mut().unwrap().draws=vec![u32::MAX],
                    5=>g[3*52+24..3*52+28].copy_from_slice(&0.5f32.to_le_bytes()),
                    _=>unreachable!(),
                }
                reset(None);
                let file=PackFile::write(&window_pack(&meta,&g,&animation,&r));
                let error=unsafe {Scene::load_for_profile(file.path(),performance)}.err().unwrap();
                assert!(error.contains("window rays"),"{fault}: {error}");released();
            }
        }
    }

    fn light_page_fixture() -> (pc::Meta, Vec<u8>, Vec<f32>, pc::ipod::Recipes, Vec<u8>) {
        let (mut meta, mut geometry, animation)=float_fixture();
        let mut material=meta.materials[0].clone();
        material.kind=pc::Kind::Lights;material.lights=Some(pc::LightField {
            min_pixels:2.0,max_pixels:8.0,period:120.0,gain:1.0,..Default::default() });
        meta.materials.push(material.clone());
        material.lights.as_mut().unwrap().gain=2.0;meta.materials.push(material);
        for field in 0..3 {
            while geometry.len()%4!=0 {geometry.push(0);}
            let mut draw=meta.draws[0].clone();
            draw.material=if field==1 {2}else{1};draw.layout=pc::VertexLayout::Lights;
            draw.node=None;draw.skin=None;draw.cast_shadow=false;draw.lods.clear();
            draw.indices=pc::Range::default();draw.index_count=2;draw.vertex_count=2;
            draw.vertices=pc::Range {offset:geometry.len() as u32,size:80};
            draw.pos_scale=[1.;3];draw.pos_offset=[field as f32,0.,0.];
            draw.min=[-1.;3];draw.max=[4.;3];
            for i in 0..2 {
                let mut point=[0u8;40];
                point[6..8].copy_from_slice(&((field*1000+i*327) as i16).to_le_bytes());
                point[8..12].copy_from_slice(&[field as u8 *60,i as u8*80,100,255]);
                point[12..16].copy_from_slice(&1.0f32.to_le_bytes());
                point[16..20].copy_from_slice(&0.01f32.to_le_bytes());
                point[20..24].copy_from_slice(&(field as f32*0.2).to_le_bytes());
                point[32..36].copy_from_slice(&(i as f32).to_le_bytes());
                point[36]=i as u8;point[37]=if i==0{255}else{128};
                geometry.extend(point);
            }
            meta.draws.push(draw);
        }
        let mut recipe=pc::ipod::LightPages {version:1,source_hash:pc::ipod::light_pages::source_hash(&meta,&geometry).unwrap(),
            payload_hash:String::new(),pages:Vec::new()};
        let mut payload=Vec::new();
        for fields in [vec![1u32,3],vec![2]] {
            let start=payload.len();let mut entries=Vec::new();let mut count=0;
            for index in fields {
                let d=&meta.draws[index as usize];
                entries.push(pc::ipod::LightPageField {draw:index,first:count});
                for original in pc::parts::slice(&geometry,&d.vertices).unwrap().chunks_exact(40) {
                    payload.extend(pc::ipod::light_pages::vertex(original,d).unwrap());
                }
                count+=d.vertex_count;
            }
            recipe.pages.push(pc::ipod::LightPage {vertices:pc::Range {offset:start as u32,size:(payload.len()-start) as u32},
                vertex_count:count,fields:entries});
        }
        recipe.payload_hash=pc::ipod::light_pages::payload_hash(&payload);
        let recipes=pc::ipod::Recipes {light_pages:Some(recipe),..Default::default()};
        (meta,geometry,animation,recipes,payload)
    }
    fn light_page_pack(meta:&pc::Meta,geometry:&[u8],animation:&[f32],recipes:&pc::ipod::Recipes,payload:Option<&[u8]>) -> Vec<u8> {
        let metadata=serde_json::to_vec(&pc::ipod::Metadata {scene:meta.clone(),ipod_recipes:recipes.clone()}).unwrap();
        let anim:Vec<_>=animation.iter().flat_map(|x|x.to_le_bytes()).collect();
        let mut sections=vec![(pc::TAG_META,metadata.as_slice(),16),(pc::TAG_GEOMETRY,geometry,16),
            (pc::TAG_TEXTURES,&[255u8;64],16),(pc::TAG_ANIMATION,anim.as_slice(),16)];
        if let Some(data)=payload {sections.push((pc::ipod::TAG_LIGHT_PAGES,data,16));}
        pc::write_versioned(pc::ipod::MAGIC,pc::ipod::VERSION,&sections)
    }
    #[test]
    fn compiler_light_pages_replace_only_optimized_geometry_and_reorder_original_phases() {
        let _lock=SERIAL.lock().unwrap();
        let (meta,geometry,animation,recipes,payload)=light_page_fixture();
        for performance in [true,false] {
            reset(None);GL.lock().unwrap().capture_buffers=true;
            let file=PackFile::write(&light_page_pack(&meta,&geometry,&animation,&recipes,Some(&payload)));
            let scene=unsafe{Scene::load_for_profile(file.path(),performance)}.unwrap();
            let state=GL.lock().unwrap();
            if performance {
                assert_eq!(state.buffer_data[&scene.light_page_buffer],payload);
                assert_eq!(state.buffer_data[&scene.geometry],geometry[..162]);
                assert_eq!(scene.light_phase_offsets,[None,Some(0),Some(32),Some(16)]);
                let expected:Vec<_>=[1usize,3,2].into_iter().flat_map(|i| {
                    pc::parts::slice(&geometry,&meta.draws[i].vertices).unwrap().chunks_exact(40)
                        .flat_map(|p|LightPhases::pair(i16::from_le_bytes([p[6],p[7]])).into_iter().flat_map(f32::to_le_bytes))
                }).collect();
                assert_eq!(state.buffer_data[&scene.light_phase_buffer],expected);
                assert!(scene.gpu_vertex_offset(1).is_none());
                assert!(scene.gpu_vertex_offset(2).is_none());
                assert_eq!(scene.light_lod_source.pages().len(),2);
            } else {
                assert_eq!(scene.light_page_buffer,0);assert_eq!(scene.light_phase_buffer,0);
                assert_eq!(state.buffer_data[&scene.geometry],geometry);
                assert_eq!(scene.gpu_vertex_offset(1),Some(meta.draws[1].vertices.offset));
            }
            assert_eq!(serde_json::to_vec(&scene.meta).unwrap(),serde_json::to_vec(&meta).unwrap());
            drop(state);drop(scene);released();
        }
        for fail in ["zero color buffer","color buffer","color upload"] {
            reset(Some(fail));
            let file=PackFile::write(&light_page_pack(&meta,&geometry,&animation,&recipes,Some(&payload)));
            assert!(unsafe {Scene::load(file.path())}.is_err(),"{fail}");released();
        }
    }
    #[test]
    fn light_page_source_payload_and_group_proofs_are_required_in_both_profiles() {
        let _lock=SERIAL.lock().unwrap();
        let (meta,geometry,animation,recipes,payload)=light_page_fixture();
        for performance in [false,true] { for fault in 0..11 {
            let mut r=recipes.clone();let mut p=payload.clone();let mut m=meta.clone();
            let recipe=r.light_pages.as_mut().unwrap();
            match fault {
                0=>recipe.version=2,
                1=>recipe.source_hash="bad".into(),
                2=>recipe.payload_hash="bad".into(),
                3=>recipe.pages[1].vertices.offset=0,
                4=>recipe.pages[0].fields[1].draw=1,
                5=>recipe.pages[0].fields[1].first=1,
                6=>{p[16]^=1;recipe.payload_hash=pc::ipod::light_pages::payload_hash(&p);},
                7=>{m.materials[1].lights.as_mut().unwrap().gain=3.0;recipe.source_hash=pc::ipod::light_pages::source_hash(&m,&geometry).unwrap();recipe.pages[0].fields[1].draw=2;recipe.pages[1].fields[0].draw=3;},
                8=>r.light_pages=None,
                9=>{},
                10=>{m.draws[1].pos_offset[0]+=1.0;recipe.source_hash=pc::ipod::light_pages::source_hash(&m,&geometry).unwrap();},
                _=>unreachable!(),
            }
            reset(None);
            let file=PackFile::write(&light_page_pack(&m,&geometry,&animation,&r,if fault==9{None}else{Some(&p)}));
            let error=unsafe{Scene::load_for_profile(file.path(),performance)}.err().unwrap();
            assert!(error.contains("light page"),"{fault}: {error}");released();
        }}
    }

    #[test]
    fn light_phases_use_final_snorm_share_ranges_and_release_failed_uploads() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, mut geometry, animation) = float_fixture();
        let mut material = m.materials[0].clone();
        material.kind = pc::Kind::Lights;
        material.lights = Some(pc::LightField {
            min_pixels: 2.0,
            max_pixels: 8.0,
            period: 120.0,
            gain: 1.0,
            ..Default::default()
        });
        m.materials.push(material);
        while geometry.len() % 4 != 0 {
            geometry.push(0);
        }
        let mut d = m.draws[0].clone();
        d.layout = pc::VertexLayout::Lights;
        d.material = 1;
        d.node = None;
        d.skin = None;
        d.lods.clear();
        d.indices = pc::Range::default();
        d.index_count = 4;
        d.vertex_count = 4;
        d.vertices.offset = geometry.len() as u32;
        d.vertices.size = 4 * pc::LIGHT_POINT_STRIDE as u32;
        let phases = [i16::MIN, -32767, 15843, i16::MAX];
        for phase in phases {
            let mut vertex = [0u8; pc::LIGHT_POINT_STRIDE];
            vertex[6..8].copy_from_slice(&phase.to_le_bytes());
            vertex[11] = 123;
            vertex[24..28].copy_from_slice(&(-3.25f32).to_le_bytes());
            vertex[36] = 7;
            vertex[37] = 91;
            geometry.extend(vertex);
        }
        m.draws.extend([d.clone(), d.clone()]);
        d.vertices.offset = geometry.len() as u32;
        let second = geometry[geometry.len() - d.vertices.size as usize..].to_vec();
        geometry.extend(second);
        m.draws.push(d);
        let original = geometry.clone();
        let cache = LightPhases::new(&m, &geometry).unwrap();
        assert_eq!(cache.offsets, [None, Some(0), Some(0), Some(32)]);
        assert_eq!(cache.data.len(), 8);
        assert_eq!(cache.data[0], cache.data[1]); // -32768 clamps to -1, like ES2.
        for (i, &phase) in phases.iter().cycle().take(8).enumerate() {
            assert_eq!(cache.data[i], LightPhases::pair(phase));
        }
        assert_eq!(geometry, original);
        for (offset, size, count) in [
            (u32::MAX, 160, 4),
            (geometry.len() as u32, 160, 4),
            (0, 159, 4),
            (0, 160, u32::MAX),
        ] {
            let mut bad = m.clone();
            bad.draws[1].vertices = pc::Range { offset, size };
            bad.draws[1].vertex_count = count;
            assert!(LightPhases::new(&bad, &geometry).is_err());
        }
        let file = PackFile::write(&pack(&m, &geometry, &animation, &[255; 64]));
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_ne!(scene.light_phase_buffer, 0);
        assert_eq!(scene.light_phase_offsets, cache.offsets);
        assert_eq!(scene.gpu_bytes, 32 + geometry.len() + 8 * 8);
        drop(scene);
        released();
        reset(None);
        let scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
        assert_original_resources_only(&scene);
        assert_eq!(scene.gpu_bytes, 64 + geometry.len());
        drop(scene);
        released();
        // No Products or display sidecar: the mock's second VBO is phases.
        for (failure, context) in [
            ("color buffer", "create light phase buffer"),
            ("zero color buffer", "allocate light phase buffer"),
            ("color upload", "upload light phases"),
            ("vaos", "create scene vertex arrays"),
            ("attributes", "configure scene vertex arrays"),
        ] {
            reset(Some(failure));
            let error = unsafe { Scene::load(file.path()) }.err().unwrap();
            assert!(error.contains(context), "{failure}: {error}");
            released();
        }
        // Make this otherwise identical field eligible for the display light
        // density cache, then exercise its separate renderer-owned allocation.
        for draw in m
            .draws
            .iter()
            .filter(|d| d.layout == pc::VertexLayout::Lights)
        {
            for vertex in geometry[draw.vertices.offset as usize..][..draw.vertices.size as usize]
                .chunks_exact_mut(pc::LIGHT_POINT_STRIDE)
            {
                vertex[36] = 0;
                vertex[37] = 255;
                vertex[16..20].copy_from_slice(&0.5f32.to_le_bytes());
            }
        }
        let file = PackFile::write(&pack(&m, &geometry, &animation, &[255; 64]));
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert!(!scene.light_lod_source.is_empty());
        let baseline = GL.lock().unwrap().live.clone();
        for failure in [None, Some("color buffer"), Some("zero color buffer")] {
            GL.lock().unwrap().fail = failure;
            let result = unsafe { crate::light_lod::LightLod::new(&scene.light_lod_source) };
            assert_eq!(result.is_err(), failure.is_some());
            drop(result);
            let state = GL.lock().unwrap();
            assert_eq!(state.live, baseline);
            assert!(state.invalid_deletes.is_empty());
        }
        drop(scene);
        released();
        reset(None);
        let scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
        assert_original_resources_only(&scene);
        drop(scene);
        released();
    }

    #[test]
    fn field_appearance_releases_texture_and_row_buffer_on_every_partial_failure() {
        let _lock = SERIAL.lock().unwrap();
        let (mut meta, mut geometry, _) = float_fixture();
        let mut material = meta.materials[0].clone();
        material.kind = pc::Kind::Lights;
        material.lights = Some(pc::LightField {
            min_pixels: 2.0,
            max_pixels: 8.0,
            period: 120.0,
            gain: 1.0,
            ..Default::default()
        });
        meta.materials.push(material);
        while geometry.len() % 4 != 0 {
            geometry.push(0);
        }
        let mut draw = meta.draws[0].clone();
        draw.layout = pc::VertexLayout::Lights;
        draw.material = 1;
        draw.node = None;
        draw.vertices = pc::Range {
            offset: geometry.len() as u32,
            size: 4 * pc::LIGHT_POINT_STRIDE as u32,
        };
        draw.vertex_count = 4;
        draw.indices = pc::Range::default();
        draw.index_count = 4;
        for rgb in [
            [255, 128, 32],
            [16, 128, 255],
            [255, 128, 32],
            [89, 17, 201],
        ] {
            let mut vertex = [0u8; pc::LIGHT_POINT_STRIDE];
            vertex[8..11].copy_from_slice(&rgb);
            vertex[11] = 123;
            vertex[16..20].copy_from_slice(&0.5f32.to_le_bytes());
            vertex[37] = 255;
            geometry.extend(vertex);
        }
        meta.draws.push(draw);
        let source = crate::light_lod::Sources::new(&meta, &geometry).unwrap();
        assert_eq!(source.palette().len(), 3);
        assert_eq!(source.color_rows(), [0, 1, 0, 2]);
        reset(None);
        let appearance =
            unsafe { crate::effects::FieldAppearance::new(&source, &meta.post) }.unwrap();
        assert_eq!(appearance.gpu_bytes, 4 * 256 * 4 + 4 * 2);
        assert_eq!(GL.lock().unwrap().live.len(), 2);
        drop(appearance);
        released();
        for (failure, context, textures, buffers) in [
            ("textures", "field appearance texture", 1, 0),
            ("texture upload", "field appearance texture", 1, 0),
            ("zero texture", "field appearance texture", 0, 0),
            ("buffer", "field appearance rows", 1, 1),
            ("geometry upload", "field appearance rows", 1, 1),
            ("zero buffer", "field appearance rows", 1, 0),
        ] {
            reset(Some(failure));
            let error = unsafe { crate::effects::FieldAppearance::new(&source, &meta.post) }
                .err()
                .unwrap();
            assert!(error.contains(context), "{failure}: {error}");
            released();
            let state = GL.lock().unwrap();
            assert_eq!(
                state
                    .deleted
                    .iter()
                    .filter(|(kind, _)| *kind == b'T')
                    .count(),
                textures,
                "{failure}"
            );
            assert_eq!(
                state
                    .deleted
                    .iter()
                    .filter(|(kind, _)| *kind == b'B')
                    .count(),
                buffers,
                "{failure}"
            );
        }
    }

    #[test]
    fn light_phase_angle_addition_bounds_all_packed_phases_and_time_quadrants() {
        let mut max_error = 0.0f32;
        // Include exact quadrants and both sides of the periodic boundary.
        let times: Vec<_> = (0..=64)
            .map(|i| i as f32 * core::f32::consts::TAU / 64.0)
            .chain([f32::EPSILON, core::f32::consts::TAU - f32::EPSILON])
            .map(|angle| (angle, libm::sinf(angle), libm::cosf(angle)))
            .collect();
        for packed in i16::MIN..=i16::MAX {
            let [s, c] = LightPhases::pair(packed);
            let phase = (packed as f32 / 32767.0).max(-1.0);
            let angle = phase * (6.2831853f32 * 13.7f32);
            for &(time, st, ct) in &times {
                let reference = libm::sinf(angle + time);
                let cached = s * ct + c * st;
                max_error = max_error.max((reference - cached).abs());
                assert!(cached.is_finite());
            }
        }
        // Float angle addition can lose up to ~4e-6 radians at this range.
        // The shared twinkle multiplier attenuates this by at most 0.35.
        assert!(max_error < 4.1e-6, "scintillation error {max_error}");
        std::println!(
            "all snorm phases: max sin error {max_error}, twinkle error {}",
            max_error * 0.35
        );
    }

    #[test]
    fn product_parameters_cover_lod_only_vertices_aliases_and_gpu_cleanup() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, _, a) = float_fixture();
        m.materials.push(m.materials[0].clone());
        m.materials[0].kind = pc::Kind::Products;
        let seeds = [[0, 0, 0], [255, 0, 0], [17, 89, 201], [255, 255, 255]];
        let mut geometry = Vec::new();
        for (i, seed) in seeds.into_iter().enumerate() {
            geometry.extend(float_vertex(
                pc::VertexLayout::Static,
                [i as f32 / 4.0, 0.25, 0.5],
                [i as f32 / 4.0, 0.5],
                [seed[0], seed[1], seed[2], 0],
            ));
        }
        let vertex_bytes = geometry.len();
        geometry.extend([0, 0, 1, 0, 2, 0, 1, 0, 2, 0, 3, 0]);
        let d = &mut m.draws[0];
        d.vertex_count = 4;
        d.vertices.size = vertex_bytes as u32;
        d.indices.offset = vertex_bytes as u32;
        d.lods.push(pc::DrawLod {
            indices: pc::Range {
                offset: vertex_bytes as u32 + 6,
                size: 6,
            },
            index_count: 3,
            error: 0.1,
        });
        // Same range is shared even with different material/node transforms.
        m.draws.push(m.draws[0].clone());
        m.draws[1].node = None;
        let mut other = m.draws[0].clone();
        other.vertices.offset = geometry.len() as u32;
        let mut second = geometry[..vertex_bytes].to_vec();
        for vertex in second.chunks_exact_mut(stride(pc::VertexLayout::Static) as usize) {
            vertex[pc::ipod::COLOR..pc::ipod::COLOR + 3].copy_from_slice(&seeds[2]);
            vertex[pc::ipod::COLOR + 3] = 255; // instance height must not affect the package
        }
        geometry.extend(second);
        m.draws.push(other);
        let mut ordinary = m.draws[0].clone();
        ordinary.material = 1;
        m.draws.push(ordinary);
        let parameters = PackageParameters::new(&m, &geometry).unwrap();
        assert_eq!(parameters.offsets, [Some(0), Some(0), Some(32), None]);
        assert_eq!(parameters.data.len(), 16);
        for (i, seed) in seeds.into_iter().enumerate() {
            assert_eq!(
                &parameters.data[i * 2..i * 2 + 2],
                &pc::products::package_params(seed)
            );
        }
        for pair in parameters.data[8..].chunks_exact(2) {
            assert_eq!(pair, pc::products::package_params(seeds[2]));
        }
        for bad in [u32::MAX, geometry.len() as u32] {
            let mut invalid = m.clone();
            invalid.draws[0].vertices.offset = bad;
            assert!(PackageParameters::new(&invalid, &geometry).is_err());
        }
        let file = PackFile::write(&pack(&m, &geometry, &a, &[255; 64]));
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_ne!(scene.package_buffer, 0);
        assert_eq!(scene.gpu_bytes, 32 + geometry.len() + 8 * 8);
        {
            let state = GL.lock().unwrap();
            for (i, offset) in parameters.offsets.iter().enumerate() {
                let attrs: Vec<_> = state
                    .attributes
                    .iter()
                    .filter(|a| a.0 == scene.vaos[i] && a.1 == 5)
                    .collect();
                if let Some(offset) = offset {
                    assert_eq!(
                        attrs,
                        [&(
                            scene.vaos[i],
                            5,
                            scene.package_buffer,
                            2,
                            8,
                            *offset as usize
                        )]
                    );
                } else {
                    assert!(attrs.is_empty());
                }
                assert!(state
                    .attributes
                    .iter()
                    .any(|a| a.0 == scene.vaos[i] && a.1 == 4 && a.2 == scene.geometry));
            }
        }
        drop(scene);
        released();
        reset(None);
        let scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
        assert_original_resources_only(&scene);
        assert_eq!(scene.gpu_bytes, 64 + geometry.len());
        drop(scene);
        released();
        // The mock calls every second VBO a color buffer; here it is the
        // package VBO, so these failures specifically cover its ownership.
        for (failure, context) in [
            ("color buffer", "create package parameter buffer"),
            ("color upload", "upload package parameters"),
            ("package attributes", "configure scene vertex arrays"),
            ("vaos", "create scene vertex arrays"),
        ] {
            reset(Some(failure));
            let error = unsafe { Scene::load(file.path()) }.err().unwrap();
            assert!(error.contains(context), "{failure}: {error}");
            released();
        }
    }
    #[test]
    fn bone_palettes_keep_exact_rows_across_skins_updates_and_repeated_passes() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, g, mut a) = float_fixture();
        a[7..10].copy_from_slice(&[4.0, -2.0, 3.0]);
        a[10..14].copy_from_slice(&Quat::from_rotation_z(1.25).to_array());
        for (parent, translation, rotation, scale) in [
            (
                0,
                [1.0, 2.0, -1.0],
                Quat::from_rotation_y(0.5),
                [2.0, 1.0, 0.5],
            ),
            (1, [-3.0, 1.0, 2.0], Quat::from_rotation_x(-0.3), [1.0; 3]),
        ] {
            m.nodes.push(pc::Node {
                name: "joint".into(),
                parent: Some(parent),
                translation,
                rotation: rotation.to_array(),
                scale,
                track: None,
            });
        }
        for joints in [vec![0, 2], vec![1, 0, 2]] {
            let offset = a.len() as u32 * 4;
            for (i, _) in joints.iter().enumerate() {
                a.extend(
                    Mat4::from_scale_rotation_translation(
                        Vec3::new(0.5, 1.0, 2.0),
                        Quat::from_rotation_y(i as f32 * 0.3),
                        Vec3::new(-1.0, i as f32, 0.25),
                    )
                    .to_cols_array(),
                );
            }
            m.skins.push(pc::Skin {
                inverse_bind: pc::Range {
                    offset,
                    size: joints.len() as u32 * 64,
                },
                joints,
            });
        }
        reset(None);
        let file = PackFile::write(&pack(&m, &g, &a, &[255; 64]));
        let mut scene = unsafe { Scene::load(file.path()) }.unwrap();
        let pointers: Vec<_> = scene
            .bone_palettes
            .iter()
            .map(|p| (p.as_ptr(), p.capacity()))
            .collect();
        let initial = scene.bones(0).to_vec();
        for frame in [0.0, 0.5, 1.0, 1.5, 2.0] {
            scene.update(frame / m.fps, Vec3::ZERO, 1.0 / m.fps);
            for (skin_id, skin) in m.skins.iter().enumerate() {
                let at = skin.inverse_bind.offset as usize / 4;
                let expected: Vec<f32> = skin
                    .joints
                    .iter()
                    .enumerate()
                    .flat_map(|(i, &node)| {
                        rows(
                            scene.world[node as usize]
                                * Mat4::from_cols_slice(&a[at + i * 16..at + i * 16 + 16]),
                        )
                    })
                    .collect();
                for _pass in 0..3 {
                    assert_eq!(scene.bones(skin_id as u32), expected);
                    assert_eq!(scene.bones(skin_id as u32).len(), skin.joints.len() * 12);
                    assert_eq!(scene.bones(skin_id as u32).as_ptr(), pointers[skin_id].0);
                    assert_eq!(scene.bone_palettes[skin_id].capacity(), pointers[skin_id].1);
                }
            }
            if frame == 1.0 {
                assert_ne!(scene.bones(0), initial);
            }
        }
        assert_eq!(scene.bones(0), initial); // animation wraps to frame zero
        assert_eq!(
            scene
                .bone_palettes
                .iter()
                .map(|p| p.len() * 4)
                .sum::<usize>(),
            5 * 12 * 4
        );
        drop(scene);
        released();
    }
    fn pvrtc_pack(meta: &pc::Meta, geometry: &[u8], animation: &[f32], source: &[u8],
        recipes: &pc::ipod::Recipes, payload: Option<&[u8]>) -> Vec<u8> {
        let metadata = serde_json::to_vec(&pc::ipod::Metadata {
            scene: meta.clone(), ipod_recipes: recipes.clone(),
        }).unwrap();
        let anim: Vec<_> = animation.iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut sections = vec![(pc::TAG_META, metadata.as_slice(), 16),
            (pc::TAG_TEXTURES, source, 16), (pc::TAG_GEOMETRY, geometry, 16),
            (pc::TAG_ANIMATION, anim.as_slice(), 16)];
        if let Some(payload) = payload { sections.push((pc::ipod::TAG_PVRTC, payload, 16)); }
        pc::write_versioned(pc::ipod::MAGIC, pc::ipod::VERSION, &sections)
    }

    #[test]
    fn pvrtc_mini_mips_upload_exact_blocks_at_logical_dimensions_and_release_failures() {
        let _lock = SERIAL.lock().unwrap();
        let (texture_meta, recipes, source, payload) = crate::texture_storage::tests::pvrtc_fixture();
        let (mut meta, geometry, animation) = float_fixture();
        meta.textures[0] = texture_meta.textures[0].clone();
        let file = PackFile::write(&pvrtc_pack(&meta, &geometry, &animation, &source, &recipes, Some(&payload)));
        for performance in [true, false] {
            reset(None);
            GL.lock().unwrap().capture_textures = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert_eq!(scene.meta.textures[0].format, pc::TexFormat::Rgba8);
            assert_eq!(scene.gpu_bytes, geometry.len() + if performance { 128 } else { 340 });
            {
                let state = GL.lock().unwrap();
                if performance {
                    assert!(state.texture_uploads.is_empty());
                    assert_eq!(state.compressed_uploads.len(), 4);
                    for (i, upload) in state.compressed_uploads.iter().enumerate() {
                        assert_eq!(upload.texture, scene.textures[0]);
                        assert_eq!((upload.target, upload.format), (GL_TEXTURE_2D, GL_COMPRESSED_RGB_PVRTC_4BPPV1_IMG));
                        assert_eq!((upload.level, upload.width, upload.height), (i as i32, 8 >> i, 8 >> i));
                        assert_eq!(upload.data, payload[i * 32..(i + 1) * 32]);
                    }
                } else {
                    assert!(state.compressed_uploads.is_empty());
                    assert_eq!(state.texture_uploads.len(), 4);
                    let mut at = 0;
                    for (i, upload) in state.texture_uploads.iter().enumerate() {
                        let dimension = 8 >> i;
                        let size = dimension * dimension * 4;
                        assert_eq!((upload.level, upload.width, upload.height), (i as i32, dimension as i32, dimension as i32));
                        assert_eq!((upload.internal_format, upload.format, upload.pixel_type), (GL_RGBA as i32, GL_RGBA, GL_UNSIGNED_BYTE));
                        assert_eq!(upload.data, source[at..at + size]);
                        at += size;
                    }
                    assert_eq!(at, 340);
                }
                assert!(state.texture_parameters.contains(&(GL_TEXTURE_2D, 0x813d, 3)));
                assert!(state.texture_parameters.contains(&(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, 0x2703)));
            }
            drop(scene);
            released();
        }
        for mip in 0..4 {
            reset(None);
            GL.lock().unwrap().fail_compressed_mip = Some(mip);
            let error = unsafe { Scene::load(file.path()) }.err().unwrap();
            assert!(error.contains("upload texture"), "mip {mip}: {error}");
            released();
            assert_eq!(GL.lock().unwrap().deleted.iter().filter(|(kind, _)| *kind == b'T').count(), 1);
        }
        reset(Some("zero texture"));
        assert!(unsafe { Scene::load(file.path()) }.err().unwrap().contains("allocate scene textures"));
        released();
    }

    #[test]
    fn pvrtc_validation_is_required_in_reference_and_without_color_sidecars() {
        let _lock = SERIAL.lock().unwrap();
        let (texture_meta, recipes, source, payload) = crate::texture_storage::tests::pvrtc_fixture();
        let (mut meta, geometry, animation) = float_fixture();
        meta.textures[0] = texture_meta.textures[0].clone();
        for performance in [true, false] {
            for fault in 0..11 {
                let mut r = recipes.clone(); let mut src = source.clone(); let mut bytes = payload.clone();
                match fault {
                    0 => bytes[127] ^= 1,
                    1 => src[336] = 1, // Opaque source RGB changes, no color sidecar to catch it.
                    2 => { // Even a freshly rehashed source must not bypass RGB-only alpha.
                        src[339] = 254;
                        r.pvrtc[0].source_hash = color_hash(&src);
                    },
                    3 => r.pvrtc[0].codec_version = 2,
                    4 => r.pvrtc[0].gate_version = 2,
                    5 => r.pvrtc[0].quality_metrics.max_block_rmse = 8.01,
                    6 => r.pvrtc.push(r.pvrtc[0].clone()),
                    7 => r.pvrtc[0].range.offset = 16,
                    8 => { bytes.truncate(127); },
                    9 => r.pvrtc[0].payload_hash = "0000000000000000".into(),
                    _ => {}, // Missing IPTX section with an otherwise valid recipe.
                }
                let file = PackFile::write(&pvrtc_pack(&meta, &geometry, &animation, &src, &r,
                    if fault == 10 { None } else { Some(&bytes) }));
                assert!(!std::path::Path::new(&color_path(file.path(), "json")).exists());
                reset(None);
                let error = unsafe { Scene::load_for_profile(file.path(), performance) }.err().unwrap();
                assert!(error.contains("PVRTC"), "profile {performance}, fault {fault}: {error}");
                assert!(GL.lock().unwrap().compressed_uploads.is_empty());
                assert!(GL.lock().unwrap().texture_uploads.is_empty());
                released();
                if (3..=8).contains(&fault) || fault == 10 {
                    assert_eq!(GL.lock().unwrap().next, 0, "structural fault must fail before GL allocations");
                }
            }
        }
    }

    #[test]
    fn opaque_display_textures_upload_two_exact_rgb565_mips_without_changing_other_storage() {
        let _lock = SERIAL.lock().unwrap();
        let original = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 128, 64, 32, 255,
        ];
        // Independent expected packed words for red, green, blue, white,
        // followed by the single 1x1 texel (R=16/31,G=16/63,B=4/31).
        let packed = [0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0xff, 0xff, 0x04, 0x82];
        for mode in 0..7 {
            let (mut meta, geometry, animation) = float_fixture();
            let texture = &mut meta.textures[0];
            texture.width = 2;
            texture.height = 2;
            texture.mips = 2;
            texture.data.size = original.len() as u32;
            let mut pixels = original;
            match mode {
                2 => texture.role = pc::TexRole::Data,
                3 => texture.role = pc::TexRole::Normal,
                4 => pixels[19] = 254, // Only the final mip has alpha.
                5 => pixels[3] = 0,
                6 => texture.has_alpha = true, // Actual payload remains opaque.
                _ => {}
            }
            let performance = mode != 1;
            let is_565 = mode == 0 || mode == 6;
            let source_meta = serde_json::to_vec(&meta).unwrap();
            let file = PackFile::write(&pack(&meta, &geometry, &animation, &pixels));
            reset(None);
            GL.lock().unwrap().capture_textures = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert_eq!(serde_json::to_vec(&scene.meta).unwrap(), source_meta);
            assert_eq!(
                scene.gpu_bytes,
                geometry.len() + if is_565 { 10 } else { 20 }
            );
            {
                let uploads = GL.lock().unwrap().texture_uploads.clone();
                assert_eq!(uploads.len(), 2);
                for (i, upload) in uploads.iter().enumerate() {
                    assert_eq!(upload.texture, scene.textures[0]);
                    assert_eq!(upload.level, i as i32);
                    assert_eq!(
                        (upload.width, upload.height),
                        if i == 0 { (2, 2) } else { (1, 1) }
                    );
                    assert_eq!(upload.unpack_alignment, 1);
                    assert_eq!(
                        upload.internal_format,
                        if is_565 { GL_RGB } else { GL_RGBA } as i32
                    );
                    assert_eq!(upload.format, if is_565 { GL_RGB } else { GL_RGBA });
                    assert_eq!(
                        upload.pixel_type,
                        if is_565 {
                            GL_UNSIGNED_SHORT_5_6_5
                        } else {
                            GL_UNSIGNED_BYTE
                        }
                    );
                    let expected = if is_565 {
                        if i == 0 {
                            &packed[..8]
                        } else {
                            &packed[8..]
                        }
                    } else if i == 0 {
                        &pixels[..16]
                    } else {
                        &pixels[16..]
                    };
                    assert_eq!(upload.byte_len, expected.len());
                    assert_eq!(upload.data, expected, "mode {mode}, mip {i}");
                }
            }
            drop(scene);
            released();
        }
    }

    #[test]
    fn rgb565_quantization_does_not_replace_original_texture_hash_identity() {
        let _lock = SERIAL.lock().unwrap();
        let (mut meta, geometry, animation) = baked_fixture();
        meta.textures[0].width = 2;
        meta.textures[0].height = 2;
        meta.textures[0].mips = 2;
        meta.textures[0].data.size = 20;
        let mut pixels = [255u8; 20];
        pixels[16..20].copy_from_slice(&[128, 64, 32, 255]);
        let source = pack(&meta, &geometry, &animation, &pixels);
        let file = PackFile::write(&source);
        let (json, colors) = color_sidecar(&source);
        write_colors(&file, &json, &colors);
        reset(None);
        GL.lock().unwrap().capture_textures = true;
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        let last_mip = GL.lock().unwrap().texture_uploads[1].data.clone();
        assert_eq!(last_mip, [0x04, 0x82]);
        drop(scene);
        released();
        // 128 and 129 quantize to the same five-bit channel. A stale sidecar
        // must still reject the different original source bytes.
        pixels[16] = 129;
        std::fs::write(file.path(), pack(&meta, &geometry, &animation, &pixels)).unwrap();
        reset(None);
        GL.lock().unwrap().capture_textures = true;
        let error = unsafe { Scene::load(file.path()) }.err().unwrap();
        assert!(error.contains("LDR colors do not match"), "{error}");
        let last_mip = GL.lock().unwrap().texture_uploads[1].data.clone();
        assert_eq!(last_mip, [0x04, 0x82]);
        released();
    }

    fn cube_pack(meta: &pc::Meta, geometry: &[u8], animation: &[f32], source: &[u8],
        recipes: &pc::ipod::Recipes, payload: Option<&[u8]>) -> Vec<u8> {
        let metadata = serde_json::to_vec(&pc::ipod::Metadata {
            scene: meta.clone(), ipod_recipes: recipes.clone(),
        }).unwrap();
        let anim: Vec<_> = animation.iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut sections = vec![(pc::TAG_META, metadata.as_slice(), 16),
            (pc::TAG_TEXTURES, source, 16), (pc::TAG_GEOMETRY, geometry, 16),
            (pc::TAG_ANIMATION, anim.as_slice(), 16)];
        if let Some(payload) = payload { sections.push((pc::ipod::TAG_DISPLAY_CUBES, payload, 16)); }
        pc::write_versioned(pc::ipod::MAGIC, pc::ipod::VERSION, &sections)
    }

    #[test]
    fn compiled_cubes_upload_exact_faces_share_materials_and_leave_reference_original() {
        let _lock = SERIAL.lock().unwrap();
        let (template, mut recipes, source, mut payload) = crate::texture_storage::tests::cube_fixture();
        let (mut meta, geometry, animation) = float_fixture();
        meta.textures = template.textures; meta.materials = template.materials;
        meta.atmosphere = template.atmosphere;
        // A valid payload identity is authoritative. This deliberate changed
        // texel proves the loader uploads IPEN rather than silently rebaking.
        let face_bytes = crate::display_environment::CUBE_BYTES / 6;
        payload[face_bytes - 4] ^= 1;
        recipes.display_cubes[0].payload_hash = color_hash(&payload[..crate::display_environment::CUBE_BYTES]);
        let file = PackFile::write(&cube_pack(&meta, &geometry, &animation, &source, &recipes, Some(&payload)));
        for performance in [true, false] {
            reset(None); GL.lock().unwrap().capture_textures = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            if performance {
                assert_eq!(scene.display_environment_textures.len(), 2);
                assert_eq!(scene.display_environments[0], scene.display_environments[1]);
                assert_ne!(scene.display_environments[0], scene.display_environments[2]);
                assert_eq!(scene.display_environments[3], 0);
                assert_eq!(scene.gpu_bytes, geometry.len() + 32 + 84 + 2 * crate::display_environment::CUBE_BYTES);
                let state = GL.lock().unwrap();
                let faces: Vec<_> = state.texture_uploads.iter().filter(|u| u.target != GL_TEXTURE_2D).collect();
                assert_eq!(faces.len(), 12);
                for (i, face) in faces.iter().enumerate() {
                    assert_eq!((face.target, face.level, face.width, face.height),
                        (GL_TEXTURE_CUBE_MAP_POSITIVE_X + (i % 6) as u32, 0, 64, 64));
                    assert_eq!(face.texture, scene.display_environment_textures[i / 6]);
                    assert_eq!(face.data, payload[i * face_bytes..(i + 1) * face_bytes]);
                }
            } else {
                assert_original_resources_only(&scene);
                assert_eq!(scene.gpu_bytes, geometry.len() + 64 + 84);
                assert!(GL.lock().unwrap().texture_uploads.iter().all(|u| u.target == GL_TEXTURE_2D));
            }
            drop(scene); released();
        }
        // ENV need not be resident as a 2D texture to validate and upload IPEN.
        let manifest = crate::texture_usage::tests::manifest(&meta, &["uDisplayEnv"]);
        std::fs::write(sidecar_path(file.path(), "pipelines.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert!(scene.textures.iter().all(|&id| id == 0));
        assert_eq!(scene.gpu_bytes, geometry.len() + 2 * crate::display_environment::CUBE_BYTES);
        drop(scene); released();
    }

    #[test]
    fn compiled_cube_corruption_is_rejected_in_both_profiles_and_releases_partial_uploads() {
        let _lock = SERIAL.lock().unwrap();
        let (template, recipes, source, payload) = crate::texture_storage::tests::cube_fixture();
        let (mut meta, geometry, animation) = float_fixture();
        meta.textures = template.textures; meta.materials = template.materials;
        meta.atmosphere = template.atmosphere;
        for performance in [true, false] {
            for fault in 0..11 {
                let mut m = meta.clone(); let mut r = recipes.clone();
                let mut src = source.clone(); let mut bytes = payload.clone();
                let expected = match fault {
                    0 => { src[224] ^= 1; "source identity" }, // Last ENV mip, not used by bake.
                    1 => { bytes[crate::display_environment::CUBE_BYTES + 4] ^= 1; "payload identity" },
                    2 => { m.post.exposure += 0.1; "recipe contract" },
                    3 => { m.materials[0].env_strength += 0.01; "ownership or strength" },
                    4 => { r.display_cubes[0].materials.pop(); "coverage" },
                    5 => { r.display_cubes[1].range.offset = 16; "range or overlap" },
                    6 => "range or overlap", // No IPEN section.
                    7 => { r.display_cubes[0].version = 2; "recipe contract" },
                    8 => { r.display_cubes[0].source_texture = 0; "recipe contract" },
                    9 => { bytes.pop(); "range or overlap" },
                    _ => {
                        // Both layouts are valid and consume exactly 168 bytes:
                        // HDR 4x4+2x2+1x1 and RGBA8 8x4+4x2+2x1.
                        // A byte-only source hash would incorrectly accept it.
                        m.textures[1].format = pc::TexFormat::Rgba8;
                        m.textures[1].width = 8;
                        "source identity"
                    },
                };
                let file = PackFile::write(&cube_pack(&m, &geometry, &animation, &src, &r,
                    (fault != 6).then_some(bytes.as_slice())));
                reset(None);
                let error = unsafe { Scene::load_for_profile(file.path(), performance) }.err().unwrap();
                assert!(error.contains(expected), "profile {performance}, fault {fault}: {error}");
                if performance && fault == 1 {
                    assert_eq!(GL.lock().unwrap().texture_uploads.iter().filter(|u| u.target != GL_TEXTURE_2D).count(), 6);
                }
                released();
            }
        }
        let file = PackFile::write(&cube_pack(&meta, &geometry, &animation, &source, &recipes, Some(&payload)));
        // Even a valid container with weaker declared alignment cannot bypass
        // the IPEN ABI. The payload itself remains unchanged and in bounds.
        let mut misaligned = std::fs::read(file.path()).unwrap();
        let table_index = (0..u32::from_le_bytes(misaligned[8..12].try_into().unwrap()) as usize)
            .find(|&i| misaligned[16 + i * 16..20 + i * 16] == pc::ipod::TAG_DISPLAY_CUBES).unwrap();
        misaligned[28 + table_index * 16..32 + table_index * 16].copy_from_slice(&4u32.to_le_bytes());
        std::fs::write(file.path(), &misaligned).unwrap();
        for performance in [true, false] {
            reset(None);
            let error = unsafe { Scene::load_for_profile(file.path(), performance) }.err().unwrap();
            assert!(error.contains("display cube section alignment"), "{error}");
            assert_eq!(GL.lock().unwrap().next, 0);
            released();
        }
        std::fs::write(file.path(), cube_pack(&meta, &geometry, &animation, &source, &recipes, Some(&payload))).unwrap();
        for face in 0..6 {
            reset(None); GL.lock().unwrap().fail_cube_face = Some(face);
            let error = unsafe { Scene::load(file.path()) }.err().unwrap();
            assert!(error.contains("upload display environment face"), "{error}");
            assert_eq!(GL.lock().unwrap().texture_uploads.iter().filter(|u| u.target != GL_TEXTURE_2D).count(), face + 1);
            released();
        }
        for failure in ["display texture", "zero display texture", "display upload"] {
            reset(Some(failure));
            assert!(unsafe { Scene::load(file.path()) }.is_err(), "{failure}");
            released();
        }
    }

    #[test]
    fn successful_scene_keeps_vao_animation_and_hdr_encoding_until_drop() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, g, a) = float_fixture();
        let mut hdr = m.textures[0].clone();
        hdr.role = pc::TexRole::Environment;
        hdr.format = pc::TexFormat::Rgba16f;
        hdr.data = pc::Range {
            offset: 64,
            size: 128,
        };
        m.textures.push(hdr);
        m.atmosphere.environment = Some(1);
        m.atmosphere.environment_strength = 0.5;
        let nonwater = m.materials[0].clone();
        m.materials[0].kind = pc::Kind::Water;
        m.materials[0].env_strength = 0.72;
        m.materials.push(m.materials[0].clone());
        m.materials.push(nonwater);
        let mut pixels = vec![255; 64];
        pixels.extend([0, 0x3c].repeat(64));
        let file = PackFile::write(&pack(&m, &g, &a, &pixels));
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_eq!(scene.textures.len(), 2);
        assert_eq!(scene.vaos.len(), 1);
        assert_eq!(scene.anim, a);
        assert_eq!(scene.world[0], Mat4::IDENTITY);
        assert_eq!(scene.gpu_bytes, 32 + 64 + crate::display_environment::CUBE_BYTES + g.len());
        assert_eq!(scene.cpu_index_bytes, 0);
        assert_ne!(scene.display_environments[0], 0);
        assert_eq!(scene.display_environments[0], scene.display_environments[1]);
        assert_eq!(scene.display_environments[2], 0);
        assert_eq!(scene.display_environment_textures.len(), 1);
        {
            let state = GL.lock().unwrap();
            assert_eq!(state.live.len(), 5);
            assert!(state.deleted.is_empty());
            assert!(state.uploads.contains(&[180, 180, 180, 255]));
            let graded = pc::color::tone([0.36; 3], &m.post).map(|v| (v * 255.0 + 0.5) as u8);
            assert!(state
                .uploads
                .contains(&[graded[0], graded[1], graded[2], 255]));
            assert_eq!(state.vao, 0);
            let faces: Vec<_> = state.texture_uploads.iter()
                .filter(|upload| upload.texture == scene.display_environments[0]).collect();
            assert_eq!(faces.len(), 6);
            for (face, upload) in faces.iter().enumerate() {
                assert_eq!(upload.target, GL_TEXTURE_CUBE_MAP_POSITIVE_X + face as u32);
                assert_eq!((upload.level, upload.width, upload.height), (0, 64, 64));
                assert_eq!((upload.internal_format, upload.format, upload.pixel_type),
                    (GL_RGBA as i32, GL_RGBA, GL_UNSIGNED_BYTE));
                assert_eq!(upload.byte_len, 64 * 64 * 4);
            }
            for (parameter, value) in [(GL_TEXTURE_MIN_FILTER, GL_LINEAR),
                (GL_TEXTURE_MAG_FILTER, GL_LINEAR), (GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE),
                (GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE)] {
                assert!(state.texture_parameters.contains(&(GL_TEXTURE_CUBE_MAP, parameter, value)));
            }
        }
        drop(scene);
        released();
        assert_eq!(
            GL.lock()
                .unwrap()
                .deleted
                .iter()
                .filter(|(kind, _)| *kind == b'B')
                .count(),
            1
        );
        for operation in ["display texture", "display upload"] {
            reset(Some(operation));
            assert!(unsafe { Scene::load(file.path()) }
                .err()
                .unwrap()
                .contains("GLES error"));
            released();
        }
        for face in 0..6 {
            reset(None);
            GL.lock().unwrap().fail_cube_face = Some(face);
            assert!(unsafe { Scene::load(file.path()) }.err().unwrap()
                .contains("upload display environment face"));
            let uploads = GL.lock().unwrap().texture_uploads.iter()
                .filter(|upload| upload.target != GL_TEXTURE_2D).count();
            assert_eq!(uploads, face + 1, "stop at failing face {face}");
            released();
        }
        reset(Some("zero display texture"));
        assert!(unsafe { Scene::load(file.path()) }.err().unwrap()
            .contains("did not allocate display environment"));
        released();
        reset(None);
        let scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
        assert_original_resources_only(&scene);
        assert_eq!(scene.gpu_bytes, 64 + 64 + g.len());
        assert!(GL.lock().unwrap().texture_uploads.iter().all(|u| u.target == GL_TEXTURE_2D));
        assert!(GL.lock().unwrap().uploads.contains(&[180, 180, 180, 255]));
        drop(scene);
        released();
        let manifest = crate::texture_usage::tests::manifest(&m, &["uDisplayEnv"]);
        std::fs::write(
            sidecar_path(file.path(), "pipelines.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        reset(None);
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert!(scene.textures.iter().all(|&id| id == 0));
        assert_ne!(scene.display_environments[0], 0);
        assert_eq!(scene.display_environments[0], scene.display_environments[1]);
        assert_eq!(scene.gpu_bytes, crate::display_environment::CUBE_BYTES + g.len());
        drop(scene);
        released();
        pixels[64..66].copy_from_slice(&0x7e00u16.to_le_bytes());
        std::fs::write(file.path(), pack(&m, &g, &a, &pixels)).unwrap();
        reset(None);
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("non-finite half-float"));
        released();
    }

    #[test]
    fn display_environment_averages_linear_radiance_before_grade_at_bounded_size() {
        let (m, _, _) = float_fixture();
        let mut texture = m.textures[0].clone();
        texture.width = 128;
        texture.height = 64;
        texture.format = pc::TexFormat::Rgba16f;
        let mut data = Vec::new();
        for x in 0..128 * 64 {
            // Every output footprint has equal black and radiance=4 texels.
            let value: u16 = if x % 2 == 0 { 0 } else { 0x4400 };
            for _ in 0..3 {
                data.extend(value.to_le_bytes());
            }
            data.extend(0x3c00u16.to_le_bytes());
        }
        // Later roughness mips are not part of the base environment average.
        data.extend([0; 32]);
        let (w, h, pixels) = display_environment_pixels(&texture, &data, 0.25, &m.post).unwrap();
        assert_eq!((w, h, pixels.len()), (64, 32, 64 * 32 * 4));
        let expected = pc::color::tone([0.5; 3], &m.post).map(|v| (v * 255.0 + 0.5) as u8);
        assert!(pixels
            .chunks_exact(4)
            .all(|p| p == [expected[0], expected[1], expected[2], 255]));
        assert!(display_environment_pixels(&texture, &data[..8], 1.0, &m.post).is_err());
        texture.width = 1;
        texture.height = 1;
        texture.format = pc::TexFormat::Rgba8;
        let (w, h, pixels) = display_environment_pixels(&texture, &[255; 4], 0.5, &m.post).unwrap();
        assert_eq!((w, h), (1, 1));
        assert_eq!(pixels, [expected[0], expected[1], expected[2], 255]);
    }

    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS; compares CPU sampling, not GPU precision"]
    fn display_cube_real_pack_reprojection_error() {
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").expect("pack directory");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") { continue; }
            let bytes = std::fs::read(&path).unwrap();
            let pack = parse(&bytes).unwrap();
            let meta: pc::Meta = serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
            let Some(index) = meta.atmosphere.environment else { continue; };
            let texture = &meta.textures[index as usize];
            let data = pc::parts::slice(pack.section(pc::TAG_TEXTURES).unwrap(), &texture.data).unwrap();
            let mut strengths = BTreeSet::new();
            for material in &meta.materials {
                if !matches!(material.kind, pc::Kind::Water | pc::Kind::Glass) { continue; }
                let strength = material.env_strength * meta.atmosphere.environment_strength;
                if !strengths.insert(strength.to_bits()) { continue; }
                let (w, h, pixels) = display_environment_pixels(texture, data, strength, &meta.post).unwrap();
                for size in [32, 64, 128] {
                    let (rmse, max, samples) = crate::display_environment::tests::error_at_size(w, h, &pixels, size);
                    std::println!("cube {} strength={strength} oct={w}x{h} cube=6x{size}x{size} samples={samples} RGB byte RMSE={rmse:.6} max={max:.6}", path.display());
                    assert!(rmse.is_finite() && max.is_finite());
                }
                count += 1;
            }
        }
        assert!(count > 0, "no eligible scene environment");
    }    fn skin_recipe_fixture() -> (pc::Meta, Vec<u8>, Vec<f32>, pc::ipod::Recipes) {
        let (mut meta, _, mut animation) = float_fixture();
        let mut geometry = Vec::new();
        for p in [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]] {
            geometry.extend(float_vertex(
                pc::VertexLayout::Skinned,
                p,
                [0., 0.],
                [255; 4],
            ));
        }
        let d = &mut meta.draws[0];
        d.layout = pc::VertexLayout::Skinned;
        d.node = None;
        d.skin = Some(0);
        d.vertices.size = geometry.len() as u32;
        d.indices = pc::Range {
            offset: geometry.len() as u32,
            size: 12,
        };
        d.index_count = 6;
        d.lods.clear();
        geometry.extend([0u16, 1, 2, 0, 1, 2].into_iter().flat_map(u16::to_le_bytes));
        meta.skins.push(pc::Skin {
            joints: vec![0],
            inverse_bind: pc::Range {
                offset: animation.len() as u32 * 4,
                size: 64,
            },
        });
        animation.extend(Mat4::IDENTITY.to_cols_array());
        let bytes: Vec<_> = animation.iter().flat_map(|f| f.to_le_bytes()).collect();
        let d = &meta.draws[0];
        let topology = pc::ipod::skin_lods::Topology::new(d, &geometry).unwrap();
        let affine_bound = topology
            .affine_bound(
                &pc::ipod::skin_lods::joint_bounds(&meta, 0, &bytes)
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
        let hash = pc::ipod::skin_lods::animation_hash(&meta, &bytes).unwrap();
        let source_hash = pc::ipod::skin_lods::source_hash(d, &geometry, hash).unwrap();
        let level = pc::DrawLod {
            indices: pc::Range {
                offset: geometry.len() as u32,
                size: 6,
            },
            index_count: 3,
            error: 0.01,
        };
        geometry.extend([0u16, 1, 2].into_iter().flat_map(u16::to_le_bytes));
        let levels = vec![level];
        let payload_hash = pc::ipod::skin_lods::payload_hash(&levels, &geometry).unwrap();
        let recipe = pc::ipod::SkinLods {
            version: 1,
            draws: vec![pc::ipod::SkinLodDraw {
                draw: 0,
                source_hash,
                payload_hash,
                affine_bound,
                levels,
            }],
        };
        pc::ipod::skin_lods::validate(&meta, &geometry, &bytes, &recipe).unwrap();
        (
            meta,
            geometry,
            animation,
            pc::ipod::Recipes {
                skin_lods: Some(recipe),
                ..Default::default()
            },
        )
    }
    #[test]
    fn derived_skin_lods_map_tail_gpu_ranges_and_reference_keeps_original_only() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, animation, recipes) = skin_recipe_fixture();
        let tail = &recipes.skin_lods.as_ref().unwrap().draws[0].levels[0].indices;
        let file = PackFile::write(&window_pack(&meta, &geometry, &animation, &recipes));
        for performance in [true, false] {
            reset(None);
            GL.lock().unwrap().capture_buffers = true;
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert!(scene.meta.draws[0].lods.is_empty());
            assert_eq!(
                scene.effective_lods(0).len(),
                if performance { 1 } else { 0 }
            );
            let state = GL.lock().unwrap();
            let uploaded = &state.buffer_data[&scene.geometry];
            assert_eq!(
                uploaded,
                &geometry[..if performance {
                    geometry.len()
                } else {
                    tail.offset as usize
                }]
            );
            assert_eq!(
                scene.gpu_index_offset(tail.offset, 3),
                if performance { Some(tail.offset) } else { None }
            );
            drop(state);
            drop(scene);
            released();
        }
        for fail in ["buffer", "geometry upload", "vaos", "attributes"] {
            reset(Some(fail));
            assert!(unsafe { Scene::load(file.path()) }.is_err(), "{fail}");
            released();
        }
        for mode in 0..4 {
            let mut bad = recipes.clone();
            let draw = &mut bad.skin_lods.as_mut().unwrap().draws[0];
            match mode {
                0 => draw.levels[0].indices.offset = 0,
                1 => draw.payload_hash = "0".repeat(16),
                2 => draw.affine_bound *= 0.5,
                _ => draw.draw = u32::MAX,
            }
            let bad = PackFile::write(&window_pack(&meta, &geometry, &animation, &bad));
            for performance in [true, false] {
                reset(None);
                assert!(unsafe { Scene::load_for_profile(bad.path(), performance) }.is_err());
                released();
            }
        }
    }
    #[test]
    fn animation_display_recipe_binds_colors_preserves_reference_and_releases_failed_loads() {
        let _lock = SERIAL.lock().unwrap();
        let (meta, geometry, animation, mut recipes) = skin_recipe_fixture();
        let old = recipes.skin_lods.take().unwrap();
        let mut levels = old.draws[0].levels.clone();
        levels[0].error = pc::ipod::animated_display_lods::guarded_error(0.).unwrap();
        let anim: Vec<u8> = animation.iter().flat_map(|v| v.to_le_bytes()).collect();
        let sample_count = meta.frames * pc::ipod::animated_display_lods::SUBFRAMES;
        let reps = vec![0];
        let dense = pc::ipod::animated_display_lods::dense_schedule(sample_count, &reps);
        let dense_points =
            (meta.draws[0].vertex_count as u64 + meta.draws[0].index_count as u64 / 3 + 1)
                * dense.len() as u64;
        let sparse_points =
            (meta.draws[0].vertex_count as u64 + meta.draws[0].index_count as u64 / 3 + 1)
                * (sample_count as u64 - dense.len() as u64);
        let colors = [42, 84, 126, 255].repeat(meta.draws[0].vertex_count as usize);
        recipes.animated_display_lods = Some(pc::ipod::AnimatedDisplayLods {
            version: 1,
            draws: vec![pc::ipod::AnimatedDisplayLodDraw {
                draw: 0,
                source_hash: pc::ipod::animated_display_lods::source_hash(
                    &meta,
                    &meta.draws[0],
                    &geometry,
                    pc::ipod::skin_lods::animation_hash(&meta, &anim).unwrap(),
                )
                .unwrap(),
                colors_hash: pc::ipod::animated_display_lods::color_hash(&colors),
                payload_hash: pc::ipod::skin_lods::payload_hash(&levels, &geometry).unwrap(),
                sample_count,
                representative_samples: reps,
                dense_samples: dense,
                levels: levels.clone(),
                measurements: vec![pc::ipod::AnimatedLodMeasurement {
                    qem_error: 0.,
                    sampled_max: 0.,
                    dense_rms: 0.,
                    samples: dense_points + sparse_points,
                    dense_point_samples: dense_points,
                }],
            }],
        });
        let source = window_pack(&meta, &geometry, &animation, &recipes);
        let file = PackFile::write(&source);
        let (json, bytes) = color_sidecar(&source);
        write_colors(&file, &json, &bytes);
        for performance in [true, false] {
            reset(None);
            let scene = unsafe { Scene::load_for_profile(file.path(), performance) }.unwrap();
            assert_eq!(scene.effective_lods(0).len(), usize::from(performance));
            assert!(scene.meta.draws[0].lods.is_empty());
            assert_eq!(
                scene
                    .gpu_index_offset(levels[0].indices.offset, 3)
                    .is_some(),
                performance
            );
            drop(scene);
            released();
        }
        for fail in [
            "buffer",
            "geometry upload",
            "color buffer",
            "color upload",
            "color vaos",
            "color attributes",
        ] {
            reset(Some(fail));
            assert!(unsafe { Scene::load(file.path()) }.is_err(), "{fail}");
            released();
        }
        let mut changed = bytes.clone();
        changed[0] ^= 1;
        let mut j = json.clone();
        j["colorsHash"] = serde_json::json!(color_hash(&changed));
        write_colors(&file, &j, &changed);
        reset(None);
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("stale graded"));
        released();
        std::fs::remove_file(color_path(file.path(), "json")).unwrap();
        reset(None);
        assert!(unsafe { Scene::load(file.path()) }.is_err());
        released();
        reset(None);
        drop(unsafe { Scene::load_for_profile(file.path(), false) }.unwrap());
        released();
    }
    #[test]
    fn skin_pose_bounds_enclose_mixed_influences_nonuniform_scale_and_stretched_limbs() {
        let (mut meta, mut geometry, _, _) = skin_recipe_fixture();
        meta.skins[0].joints.push(0);
        let positions = [
            Vec3::new(-3., 1., 2.),
            Vec3::new(4., -2., 1.),
            Vec3::new(1., 5., -3.),
        ];
        let tuples = [
            [0, 1, 0, 0, 128, 127, 0, 0],
            [0, 1, 0, 0, 128, 127, 0, 0],
            [1, 0, 0, 0, 255, 0, 0, 0],
        ];
        for (i, p) in positions.iter().enumerate() {
            for (k, f) in p.to_array().iter().enumerate() {
                geometry[i * 60 + k * 4..i * 60 + k * 4 + 4].copy_from_slice(&f.to_le_bytes());
            }
            geometry[i * 60 + 52..i * 60 + 60].copy_from_slice(&tuples[i]);
        }
        let mut bounds = SkinBounds::build(&meta, &geometry).unwrap();
        assert_eq!(bounds[0].groups.len(), 2);
        for t in [0., 0.3, 0.7, 1.] {
            let matrices = [
                Mat4::from_scale_rotation_translation(
                    Vec3::new(2., 0.5, 1.),
                    Quat::from_rotation_y(t),
                    Vec3::new(30., 0., 0.),
                ),
                Mat4::from_scale_rotation_translation(
                    Vec3::new(0.25, 3., 1.5),
                    Quat::from_rotation_z(t * 2.),
                    Vec3::new(-10., 20., 0.),
                ),
            ];
            let palette: Vec<_> = matrices.into_iter().flat_map(rows).collect();
            bounds[0].update(&palette);
            for (p, tuple) in positions.iter().zip(tuples) {
                let mut expected = Vec3::ZERO;
                for k in 0..4 {
                    expected +=
                        matrices[tuple[k] as usize].transform_point3(*p) * (tuple[k + 4] as f32 / 255.);
                }
                assert!(
                    expected.cmpge(bounds[0].min).all() && expected.cmple(bounds[0].max).all(),
                    "{expected:?} outside {:?}..{:?}",
                    bounds[0].min,
                    bounds[0].max
                );
            }
            assert!(bounds[0].max.x > 2. && bounds[0].max.y > 2.);
        }
        // A zero-weight slot has no influence, even with a distant palette.
        let old = (bounds[0].min, bounds[0].max);
        let capacity = bounds[0].groups.capacity();
        assert!(old.0.is_finite() && old.1.is_finite());
        assert_eq!(bounds[0].groups.capacity(), capacity);
    }

    #[test]
    fn skin_pose_bounds_pad_pre_cancellation_magnitudes() {
        let x = f32::from_bits(1.0f32.to_bits() + 1);
        let mut b = SkinBounds {
            source: pc::Range {
                offset: 0,
                size: 60,
            },
            skin: 0,
            groups: vec![InfluenceBounds {
                tuple: [0, 1, 0, 0, 128, 127, 0, 0],
                min: Vec3::new(x, 0., 0.),
                max: Vec3::new(x, 0., 0.),
            }],
            min: Vec3::ZERO,
            max: Vec3::ZERO,
        };
        let palette = [
            1e8, 0., 0., -1e8, 0., 1., 0., 0., 0., 0., 1., 0., -1e8, 0., 0., 1e8, 0., 1., 0., 0., 0.,
            0., 1., 0.,
        ];
        b.update(&palette);
        let expected = (1e8 * x - 1e8) * (128.0 / 255.0) + (-1e8 * x + 1e8) * (127.0 / 255.0);
        assert!(
            b.min.x <= expected && b.max.x >= expected,
            "{}..{} excludes {expected}",
            b.min.x,
            b.max.x
        );
    }

    #[test]
    fn target_lod_view_keeps_reference_tiers_and_rejects_cross_recipe_overlap() {
        let (mut meta, mut geometry, _, mut recipes) = skin_recipe_fixture();
        let original = serde_json::to_vec(&meta).unwrap();
        let view = pc::ipod::display_lods::EffectiveLods::new(&meta, &recipes).unwrap();
        assert_eq!(view.get(&meta, 0).len(), 1);
        assert_eq!(serde_json::to_vec(&meta).unwrap(), original);
        let source = recipes.skin_lods.as_ref().unwrap().draws[0].levels[0].indices.clone();
        let mut display = pc::ipod::DisplayLodDraw {
            draw: 1, source_hash: String::new(), payload_hash: String::new(),
            levels: vec![pc::DrawLod {indices:source.clone(),index_count:3,error:0.1}],
        };
        recipes.display_lods=Some(pc::ipod::DisplayLods{version:1,draws:vec![display.clone()]});
        assert!(pc::ipod::display_lods::validate_ranges(&meta,&geometry,&recipes).unwrap_err().contains("overlap"));
        display.levels[0].indices.offset += source.size;
        geometry.extend([0u8;6]);
        recipes.display_lods.as_mut().unwrap().draws[0]=display;
        pc::ipod::display_lods::validate_ranges(&meta,&geometry,&recipes).unwrap();
        // The immutable source levels remain available to Reference. Only
        // the Optimized view drops a tier dominated by a lower-error recipe.
        meta.draws[0].index_count=18;
        meta.draws[0].lods=vec![pc::DrawLod{indices:source.clone(),index_count:12,error:0.02},pc::DrawLod{indices:source.clone(),index_count:6,error:0.08}];
        recipes.skin_lods=None;
        recipes.display_lods=Some(pc::ipod::DisplayLods{version:1,draws:vec![pc::ipod::DisplayLodDraw{draw:0,source_hash:String::new(),payload_hash:String::new(),levels:vec![pc::DrawLod{indices:source.clone(),index_count:9,error:0.03},pc::DrawLod{indices:source,index_count:3,error:0.05}]}]});
        let view=pc::ipod::display_lods::EffectiveLods::new(&meta,&recipes).unwrap();
        assert_eq!(view.get(&meta,0).iter().map(|l|l.index_count).collect::<Vec<_>>(),[12,9,3]);
        assert_eq!(meta.draws[0].lods.iter().map(|l|l.index_count).collect::<Vec<_>>(),[12,6]);
    }

}
