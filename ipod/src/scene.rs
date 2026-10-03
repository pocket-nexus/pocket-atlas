//! Streaming PLCE loader. Only one place is resident; texture staging is
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
pub struct Scene {
    /// Performance assets are loaded together and never required by Retina.
    pub performance: bool,
    pub meta: pc::Meta,
    pub textures: Vec<u32>,
    /// Material-indexed display environments for water/glass; zero for others.
    /// Atmosphere and material environment strength are included before grading.
    pub display_environments: Vec<u32>,
    display_environment_textures: Vec<u32>,
    pub geometry: u32,
    /// Per-point sin/cos of the decoded phase; display fields use slot 1.
    /// The original packed LightPoint stream remains authoritative.
    pub light_phase_buffer: u32,
    pub light_phase_offsets: Vec<Option<u32>>,
    pub light_lod_source: crate::light_lod::Sources,
    pub vaos: Vec<u32>,
    pub anim: Vec<f32>,
    pub world: Vec<Mat4>,
    // Fixed 3x4 row palettes; shared by all draws and passes using a skin.
    bone_palettes: Vec<Vec<f32>>,
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
            if d.vertex_count.checked_mul(pc::LightPoint::STRIDE as u32) != Some(d.vertices.size) {
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
            for vertex in page.chunks_exact(pc::LightPoint::STRIDE) {
                data.push(Self::pair(i16::from_le_bytes([vertex[6], vertex[7]])));
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
            if d.vertex_count.checked_mul(24) != Some(d.vertices.size) {
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
            for vertex in page.chunks_exact(24) {
                let rgb: [u8; 3] = vertex[20..23].try_into().unwrap();
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
    fn new(meta: &pc::Meta, geometry: &[u8], display: &[ColorEntry]) -> Result<Self, String> {
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
            .try_fold(0usize, |n, (_, d)| {
                n.checked_add(d.lods.len()).and_then(|n| n.checked_add(1))
            })
            .ok_or("CPU index range count overflow")?;
        let mut ranges: Vec<pc::Range> = Vec::new();
        ranges
            .try_reserve_exact(count)
            .map_err(|_| "CPU index table allocation failed")?;
        for (_, d) in meta
            .draws
            .iter()
            .enumerate()
            .filter(|(i, d)| eligible(*i, d))
        {
            for (range, count) in core::iter::once((&d.indices, d.index_count))
                .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
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

// Kept local to the optional iPod sidecar, rather than changing shared PLCE.
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
struct ColorMetadata {
    version: u32,
    identity: String,
    meta_hash: String,
    geometry_hash: String,
    animation_hash: String,
    texture_hash: String,
    colors_hash: String,
    colors_bytes: u32,
    draws: Vec<ColorEntry>,
    pages: Vec<ColorPage>,
    states: Vec<pc::display::State>,
}
struct ColorFile {
    bytes: Vec<u8>,
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
                d.layout.stride(),
                decode,
            )) {
                continue;
            }
            let stride = d.layout.stride() as usize;
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
                let q = |at| (i16::from_le_bytes([v[at], v[at + 1]]) as f32 / 32767.0).max(-1.0);
                let expected = [
                    q(0) * d.pos_scale[0] + d.pos_offset[0],
                    q(2) * d.pos_scale[1] + d.pos_offset[1],
                    q(4) * d.pos_scale[2] + d.pos_offset[2],
                    q(16) * d.uv_scale[0] + d.uv_offset[0],
                    q(18) * d.uv_scale[1] + d.uv_offset[1],
                ];
                for (k, value) in expected.iter().enumerate() {
                    let at = start + i * 24 + k * 4;
                    let actual = f32::from_le_bytes(self.bytes[at..at + 4].try_into().unwrap());
                    if actual != *value {
                        return Err("LDR float position/UV differs from source geometry".into());
                    }
                }
            }
        }
        Ok(())
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
        if data.version != 2
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
        if bin.len != data.colors_bytes as usize
            || bin.len > budget
            || bin.len % 4 != 0
            || data.draws.len() > meta.draws.len()
            || data.pages.len() > data.draws.len()
            || data.states.len() > data.pages.len()
        {
            return Err("LDR color payload size mismatch".into());
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
            if page_end as usize > bin.len {
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
                || entry.flags & !63 != 0
                || (entry.flags & 8 != 0
                    && (m.kind != pc::Kind::Standard
                        || m.emission.is_none()
                        || m.emission_shade.is_some()
                        || entry.texture != m.albedo))
                || !matches!(
                    m.kind,
                    pc::Kind::Standard | pc::Kind::Unlit | pc::Kind::Glass
                )
                || ((entry.flags & 32 != 0) != (m.kind == pc::Kind::Glass))
                || (entry.flags & 32 != 0
                    && (entry.flags & (2 | 4 | 8 | 16) != 0 || entry.texture.is_some()))
                || ((entry.flags & 16 != 0) != m.wet.is_some())
                || (m.wet.is_some()
                    && !(m.kind == pc::Kind::Standard
                        && m.wet.as_ref().is_some_and(|w| w.planar)
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
                    || end as usize > bin.len
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
        let meta: pc::Meta =
            serde_json::from_slice(&meta_bytes).map_err(|e| format!("place metadata: {e}"))?;
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
        let texture_plan = if performance {
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
            display_environment_textures: Vec::new(),
            geometry: 0,
            light_phase_buffer: 0,
            light_phase_offsets: Vec::new(),
            light_lod_source: crate::light_lod::Sources::default(),
            vaos: vec![0; meta.draws.len()],
            world: vec![Mat4::IDENTITY; meta.nodes.len()],
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
            let data = file.payload(tex, &t.data)?;
            validation::validate_texture(t, &data)?;
            texture_hash.update(&data);
            if id != 0 {
                glBindTexture(GL_TEXTURE_2D, id);
                glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
                let half = t.format == pc::TexFormat::Rgba16f;
                let (mut w, mut h, mut at) = (t.width, t.height, 0usize);
                for mip in 0..t.mips {
                    let n = (w as usize)
                        .checked_mul(h as usize)
                        .and_then(|n| n.checked_mul(if half { 8 } else { 4 }))
                        .ok_or("texture mip overflow")?;
                    let end = at.checked_add(n).ok_or("texture mip offset overflow")?;
                    let level = data.get(at..end).ok_or("texture mip range")?;
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
                    glTexImage2D(
                        GL_TEXTURE_2D,
                        mip as _,
                        GL_RGBA as _,
                        w as _,
                        h as _,
                        0,
                        GL_RGBA,
                        GL_UNSIGNED_BYTE,
                        pixels as _,
                    );
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
                scene.gpu_bytes += if half { data.len() / 2 } else { data.len() };
            }
            if performance && scene.meta.atmosphere.environment == Some(index as u32) {
                let mut cache = Vec::<(u32, u32)>::new();
                for (material, m) in scene.meta.materials.iter().enumerate() {
                    if !matches!(m.kind, pc::Kind::Water | pc::Kind::Glass) {
                        continue;
                    }
                    let strength = m.env_strength * scene.meta.atmosphere.environment_strength;
                    if let Some(&(_, id)) =
                        cache.iter().find(|&&(bits, _)| bits == strength.to_bits())
                    {
                        scene.display_environments[material] = id;
                        continue;
                    }
                    let (w, h, display) =
                        display_environment_pixels(t, &data, strength, &scene.meta.post)?;
                    // Store the owner before allocation so failures always release it.
                    scene.display_environment_textures.push(0);
                    let owned = scene.display_environment_textures.last_mut().unwrap();
                    glGenTextures(1, owned);
                    check_gl("create display environment")?;
                    let id = *owned;
                    if id == 0 {
                        return Err("GLES did not allocate display environment".into());
                    }
                    glBindTexture(GL_TEXTURE_2D, id);
                    glTexImage2D(
                        GL_TEXTURE_2D,
                        0,
                        GL_RGBA as _,
                        w as _,
                        h as _,
                        0,
                        GL_RGBA,
                        GL_UNSIGNED_BYTE,
                        display.as_ptr() as _,
                    );
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                    check_gl("upload display environment")?;
                    scene.gpu_bytes += display.len();
                    scene.display_environments[material] = id;
                    cache.push((strength.to_bits(), id));
                }
            }
        }
        let data = file.section(geom)?;
        validation::validate_geometry(&scene.meta, &data)?;
        let colors = if performance {
            scene.light_lod_source = crate::light_lod::Sources::new(&scene.meta, &data)?;
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
        if let Some(colors) = &colors {
            colors.validate_float_geometry(&scene.meta, &data)?;
        }
        if performance {
            scene.index_cache = IndexCache::new(
                &scene.meta,
                &data,
                colors.as_ref().map_or(&[], |c| &c.draws),
            )?;
        }
        if let Some(colors) = &colors {
            for entry in colors.draws.iter().filter(|c| c.page.is_some()) {
                let d = &scene.meta.draws[entry.draw as usize];
                for (r, n) in core::iter::once((&d.indices, d.index_count))
                    .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
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
        scene.cpu_index_bytes = scene.index_cache.bytes();
        if let Some(mut clusters) = if performance {
            PlaceFile::optional(&sidecar_path(path, "ipod-clusters.bin"))?
        } else {
            None
        } {
            if clusters.len > crate::mesh_clusters::max_file_bytes(&scene.meta)? {
                return Err("cluster sidecar exceeds source geometry budget".into());
            }
            let bytes = clusters.read(0, clusters.len)?;
            let parsed =
                crate::mesh_clusters::MeshClusters::parse(&bytes, &scene.meta, &meta_bytes, &data)?;
            scene.cpu_index_bytes += parsed.bytes();
            scene.mesh_clusters = Some(parsed);
        }
        drop(meta_bytes);
        glGenBuffers(1, &mut scene.geometry);
        check_gl("create scene geometry")?;
        if scene.geometry == 0 {
            return Err("GLES did not allocate scene geometry".into());
        }
        glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
        glBufferData(
            GL_ARRAY_BUFFER,
            data.len() as _,
            data.as_ptr() as _,
            GL_STATIC_DRAW,
        );
        check_gl("upload scene geometry")?;
        scene.gpu_bytes += data.len();
        let phases = if performance {
            LightPhases::new(&scene.meta, &data)?
        } else {
            LightPhases {
                data: Vec::new(),
                offsets: Vec::new(),
            }
        };
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
        let packages = if performance {
            PackageParameters::new(&scene.meta, &data)?
        } else {
            PackageParameters {
                data: Vec::new(),
                offsets: Vec::new(),
            }
        };
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
        if !scene.vaos.is_empty() {
            glGenVertexArraysOES(scene.vaos.len() as _, scene.vaos.as_mut_ptr());
            check_gl("create scene vertex arrays")?;
            if scene.vaos.contains(&0) {
                return Err("GLES did not allocate scene vertex arrays".into());
            }
        }
        for (i, d) in scene.meta.draws.iter().enumerate() {
            if d.layout == pc::VertexLayout::Lights {
                continue;
            }
            glBindVertexArrayOES(scene.vaos[i]);
            glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, scene.geometry);
            let attrs = [
                (0, 3, 0x1402, 1, 0),
                (1, 3, 0x1400, 1, 8),
                (2, 4, 0x1400, 1, 12),
                (3, 2, 0x1402, 1, 16),
                (4, 4, GL_UNSIGNED_BYTE, 1, 20),
            ];
            for (k, n, t, normalize, offset) in attrs {
                glEnableVertexAttribArray(k);
                glVertexAttribPointer(
                    k,
                    n,
                    t,
                    normalize,
                    d.layout.stride() as _,
                    (d.vertices.offset as usize + offset) as _,
                );
            }
            if d.layout == pc::VertexLayout::Baked {
                glEnableVertexAttribArray(5);
                glVertexAttribPointer(
                    5,
                    4,
                    GL_UNSIGNED_BYTE,
                    1,
                    28,
                    (d.vertices.offset as usize + 24) as _,
                );
            }
            if d.layout == pc::VertexLayout::Skinned {
                for (k, normalize, offset) in [(6, 0, 24), (7, 1, 28)] {
                    glEnableVertexAttribArray(k);
                    glVertexAttribPointer(
                        k,
                        4,
                        GL_UNSIGNED_BYTE,
                        normalize,
                        32,
                        (d.vertices.offset as usize + offset) as _,
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
                colors.bytes.len() as _,
                colors.bytes.as_ptr() as _,
                GL_STATIC_DRAW,
            );
            check_gl("upload LDR colors")?;
            scene.ldr_color_bytes = colors.bytes.len();
            scene.gpu_bytes += colors.bytes.len();
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
                glBindVertexArrayOES(vao);
                glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, scene.geometry);
                // Reflection surfaces retain the authored normal; ordinary
                // diffuse shaders need only position, UV, color and skin.
                for (k, n, t, normalized, at) in [(0, 3, 0x1402, 1, 0), (3, 2, 0x1402, 1, 16)] {
                    glEnableVertexAttribArray(k);
                    glVertexAttribPointer(
                        k,
                        n,
                        t,
                        normalized,
                        d.layout.stride() as _,
                        (d.vertices.offset as usize + at) as _,
                    );
                }
                if entry.flags & (16 | 32) != 0 {
                    glEnableVertexAttribArray(1);
                    glVertexAttribPointer(
                        1,
                        3,
                        0x1400,
                        1,
                        d.layout.stride() as _,
                        (d.vertices.offset as usize + 8) as _,
                    );
                }
                if d.layout == pc::VertexLayout::Skinned {
                    for (k, normalized, at) in [(6, 0, 24), (7, 1, 28)] {
                        glEnableVertexAttribArray(k);
                        glVertexAttribPointer(
                            k,
                            4,
                            GL_UNSIGNED_BYTE,
                            normalized,
                            32,
                            (d.vertices.offset as usize + at) as _,
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
    /// Index ranges in the original GEOM address space, retained only in the
    /// performance profile for opaque, depth-writing baked draws and LODs.
    pub fn indices(&self, offset: u32, count: u32) -> Option<&[u16]> {
        self.index_cache.get(offset, count)
    }
    /// Replacing a Renderer can retain this Scene. VAOs
    /// retain element-buffer bindings, including renderer-owned stream IBOs:
    /// detach those references before deleting the old renderer's buffers.
    pub unsafe fn reset_index_bindings(&self) {
        for &vao in self.vaos.iter().chain(&self.ldr_vaos) {
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
            let root = self.world[self.meta.skins[s as usize].joints[0] as usize]
                .transform_point3(Vec3::ZERO);
            return (root - Vec3::splat(2.0), root + Vec3::splat(2.0));
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

/// Average source radiance before grading. Reusing the encoded HDR texture
/// would grade sqrt-compressed values; averaging display bytes would also bias
/// bright texels. The independent clamped level needs at most 16 KiB on GPU.
fn display_environment_pixels(
    texture: &pc::Texture,
    data: &[u8],
    strength: f32,
    post: &pc::Post,
) -> Result<(u32, u32, Vec<u8>), String> {
    let stride = match texture.format {
        pc::TexFormat::Rgba16f => 8,
        pc::TexFormat::Rgba8 => 4,
        _ => return Err("unsupported display environment format".into()),
    };
    let (sw, sh) = (texture.width as usize, texture.height as usize);
    let size = sw.checked_mul(sh).and_then(|n| n.checked_mul(stride));
    if sw == 0 || sh == 0 || size.is_none_or(|n| n > data.len()) {
        return Err("display environment source range".into());
    }
    let divisor = sw.max(sh).div_ceil(64).max(1);
    let (w, h) = (sw.div_ceil(divisor), sh.div_ceil(divisor));
    let mut pixels = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        let (y0, y1) = (
            y as f32 * sh as f32 / h as f32,
            (y + 1) as f32 * sh as f32 / h as f32,
        );
        for x in 0..w {
            let (x0, x1) = (
                x as f32 * sw as f32 / w as f32,
                (x + 1) as f32 * sw as f32 / w as f32,
            );
            let mut rgb = [0.0; 3];
            for sy in y0 as usize..(libm::ceilf(y1) as usize).min(sh) {
                let wy = (y1.min((sy + 1) as f32) - y0.max(sy as f32)).max(0.0);
                for sx in x0 as usize..(libm::ceilf(x1) as usize).min(sw) {
                    let weight = wy * (x1.min((sx + 1) as f32) - x0.max(sx as f32)).max(0.0);
                    let at = (sy * sw + sx) * stride;
                    for c in 0..3 {
                        let value = if stride == 8 {
                            half_float(u16::from_le_bytes([data[at + c * 2], data[at + c * 2 + 1]]))
                        } else {
                            data[at + c] as f32 / 255.0
                        };
                        rgb[c] += value.max(0.0) * weight;
                    }
                }
            }
            let area = (x1 - x0) * (y1 - y0);
            let display = pc::color::tone(rgb.map(|v| v / area * strength), post);
            pixels.extend(display.map(|v| (v * 255.0 + 0.5) as u8));
            pixels.push(255);
        }
    }
    Ok((w as u32, h as u32, pixels))
}

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    use std::{
        collections::{BTreeMap, BTreeSet},
        path::PathBuf,
        sync::{LazyLock, Mutex},
    };

    // These symbols satisfy the loader's GLES imports in the standalone host
    // harness. They record ownership and inject real GL error return paths;
    // they do not claim to emulate rendering or the physical GPU.
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
        array_buffer: u32,
        color_buffer: u32,
        texture: u32,
        display_texture: u32,
        color_vaos: BTreeSet<u32>,
        attributes: Vec<(u32, u32, u32, i32, i32, usize)>,
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
        if color && kind == b'B' && state.fail == Some("zero color buffer") {
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
    unsafe extern "C" fn glBindTexture(_: u32, id: u32) {
        GL.lock().unwrap().texture = id;
    }
    #[no_mangle]
    unsafe extern "C" fn glPixelStorei(_: u32, _: i32) {}
    #[no_mangle]
    unsafe extern "C" fn glTexParameteri(_: u32, _: u32, _: i32) {}
    #[no_mangle]
    unsafe extern "C" fn glEnableVertexAttribArray(_: u32) {}
    #[no_mangle]
    unsafe extern "C" fn glFinish() {}
    #[no_mangle]
    unsafe extern "C" fn glBufferData(_: u32, _: isize, _: *const c_void, _: u32) {
        let mut state = GL.lock().unwrap();
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
        _: u32,
        _: u8,
        stride: i32,
        offset: *const c_void,
    ) {
        let mut state = GL.lock().unwrap();
        let vao = state.vao;
        let buffer = state.array_buffer;
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
        _: u32,
        _: i32,
        _: i32,
        _: i32,
        _: i32,
        _: i32,
        _: u32,
        _: u32,
        p: *const c_void,
    ) {
        let mut state = GL.lock().unwrap();
        let bytes = core::slice::from_raw_parts(p as *const u8, 4);
        state.uploads.push(bytes.try_into().unwrap());
        let name = if state.texture == state.display_texture && state.texture != 0 {
            "display upload"
        } else {
            "texture upload"
        };
        stage(&mut state, name);
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
        pc::write(&[
            (pc::TAG_META, &meta, 16),
            (pc::TAG_TEXTURES, textures, 16),
            (pc::TAG_GEOMETRY, geom, 16),
            (pc::TAG_ANIMATION, &anim, 16),
        ])
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
    fn loader_rejects_malformed_container_before_allocating_gpu_names() {
        let _lock = SERIAL.lock().unwrap();
        let (m, g, a) = crate::validation::tests::fixture();
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
        geometry[84..86].copy_from_slice(&u16::MAX.to_le_bytes());
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
                assert_eq!(scene.indices(84, 3), Some(&[0, 1, 2][..]));
                drop(scene);
            } else {
                assert!(result.is_err());
            }
            released();
        }
    }

    fn baked_fixture() -> (pc::Meta, Vec<u8>, Vec<f32>) {
        let (mut m, source, animation) = crate::validation::tests::fixture();
        let mut geometry = Vec::new();
        for vertex in source[..72].chunks_exact(24) {
            geometry.extend_from_slice(vertex);
            geometry.extend_from_slice(&[128, 128, 128, 255]);
        }
        geometry.extend_from_slice(&source[72..78]);
        geometry.extend_from_slice(&[2, 0, 1, 0, 0, 0]);
        let d = &mut m.draws[0];
        d.layout = pc::VertexLayout::Baked;
        d.node = None;
        d.vertices.size = 84;
        d.indices.offset = 84;
        d.lods = vec![
            pc::DrawLod {
                indices: d.indices.clone(),
                index_count: 3,
                error: 0.1,
            },
            pc::DrawLod {
                indices: pc::Range {
                    offset: 90,
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
        let pack = pc::Pack::parse(source).unwrap();
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
        for v in g[d.vertices.offset as usize..][..d.vertices.size as usize].chunks_exact(28) {
            let q = |at| (i16::from_le_bytes([v[at], v[at + 1]]) as f32 / 32767.0).max(-1.0);
            for k in 0..3 {
                bytes.extend((q(k * 2) * d.pos_scale[k] + d.pos_offset[k]).to_le_bytes());
            }
            for k in 0..2 {
                bytes.extend((q(16 + k * 2) * d.uv_scale[k] + d.uv_offset[k]).to_le_bytes());
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
                assert_eq!(scene.indices(84, 3), Some(&[0, 1, 2][..]));
                assert_eq!(scene.indices(90, 3), Some(&[2, 1, 0][..]));
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
                                28,
                                scene.meta.draws[i].vertices.offset as usize + 8
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
                6 => json["draws"][0]["flags"] = serde_json::json!(64),
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
        let original = pc::Pack::parse(&source).unwrap();
        let replacement = pc::Pack::parse(&changed).unwrap();
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
        assert_eq!(scene.gpu_bytes, geometry.len() + 128);
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
        assert_eq!(cache.get(84, 3), Some(&[0, 1, 2][..]));
        assert_eq!(cache.get(90, 3), Some(&[2, 1, 0][..]));
        assert_eq!(cache.get(86, 4), Some(&[1, 2, 2, 1][..]));
        for (offset, count) in [(0, 3), (85, 3), (94, 2), (u32::MAX - 1, 3), (84, u32::MAX)] {
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
                0 => bad.draws[0].indices.offset = 85,
                1 => bad.draws[0].indices.size = 4,
                _ => bad.draws[0].indices.offset = u32::MAX - 1,
            }
            assert!(IndexCache::new(&bad, &geometry, &[]).is_err());
        }
        reset(None);
        let file = PackFile::write(&pack(&m, &geometry, &animation, &[255; 64]));
        let scene = unsafe { Scene::load(file.path()) }.unwrap();
        assert_eq!(scene.indices(84, 3), Some(&[0, 1, 2][..]));
        assert_eq!(scene.indices(90, 3), Some(&[2, 1, 0][..]));
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
        let (mut m, mut g, a) = crate::validation::tests::fixture();
        reset(None);
        g[76] = 3;
        let file = PackFile::write(&pack(&m, &g, &a, &[255; 64]));
        assert!(unsafe { Scene::load(file.path()) }
            .err()
            .unwrap()
            .contains("index exceeds"));
        released();
        assert_eq!(GL.lock().unwrap().next, 1);
        g[76] = 2;
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
            for d in &scene.meta.draws {
                let m = &scene.meta.materials[d.material as usize];
                if d.layout == pc::VertexLayout::Baked
                    && d.node.is_none()
                    && d.skin.is_none()
                    && m.blend == pc::Blend::Opaque
                    && m.depth_write
                {
                    for (r, n) in core::iter::once((&d.indices, d.index_count))
                        .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
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
    fn light_phases_use_final_snorm_share_ranges_and_release_failed_uploads() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, mut geometry, animation) = crate::validation::tests::fixture();
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
        d.vertices.size = 4 * pc::LightPoint::STRIDE as u32;
        let phases = [i16::MIN, -32767, 15843, i16::MAX];
        for phase in phases {
            let mut vertex = [0u8; pc::LightPoint::STRIDE];
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
        assert_eq!(scene.gpu_bytes, 64 + geometry.len() + 8 * 8);
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
                .chunks_exact_mut(pc::LightPoint::STRIDE)
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
        let (mut m, _, a) = crate::validation::tests::fixture();
        m.materials.push(m.materials[0].clone());
        m.materials[0].kind = pc::Kind::Products;
        let seeds = [[0, 0, 0], [255, 0, 0], [17, 89, 201], [255, 255, 255]];
        let mut geometry = vec![0; 96];
        for (vertex, seed) in geometry.chunks_exact_mut(24).zip(seeds) {
            vertex[20..23].copy_from_slice(&seed);
        }
        geometry.extend([0, 0, 1, 0, 2, 0, 1, 0, 2, 0, 3, 0]);
        let d = &mut m.draws[0];
        d.vertex_count = 4;
        d.vertices.size = 96;
        d.indices.offset = 96;
        d.lods.push(pc::DrawLod {
            indices: pc::Range {
                offset: 102,
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
        let mut second = geometry[..96].to_vec();
        for vertex in second.chunks_exact_mut(24) {
            vertex[20..23].copy_from_slice(&seeds[2]);
            vertex[23] = 255; // instance height must not affect the package
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
        assert_eq!(scene.gpu_bytes, 64 + geometry.len() + 8 * 8);
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
        let (mut m, g, mut a) = crate::validation::tests::fixture();
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
    #[test]
    fn successful_scene_keeps_vao_animation_and_hdr_encoding_until_drop() {
        let _lock = SERIAL.lock().unwrap();
        let (mut m, g, a) = crate::validation::tests::fixture();
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
        assert_eq!(scene.gpu_bytes, 64 + 64 + 64 + g.len());
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
        reset(None);
        let scene = unsafe { Scene::load_for_profile(file.path(), false) }.unwrap();
        assert_original_resources_only(&scene);
        assert_eq!(scene.gpu_bytes, 64 + 64 + g.len());
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
        assert_eq!(scene.gpu_bytes, 64 + g.len());
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
        let (m, _, _) = crate::validation::tests::fixture();
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
}
