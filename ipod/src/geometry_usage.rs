//! GPU residency of validated source geometry. META and CPU index caches keep
//! their original address space; only the uploaded byte ranges are compacted.
//! Display float pages already own positions/UVs and stream every source LOD.
use alloc::{string::String, vec::Vec};
use pocket3d_place as pc;

#[derive(Clone, Copy, Debug)]
struct Span {
    source: u32,
    size: u32,
    gpu: u32,
}

pub struct GeometryUsage {
    source_len: usize,
    bytes: usize,
    copies: Vec<Span>,
    vertices: Vec<Option<u32>>,
    indices: Vec<Span>,
}

fn checked_range(range: &pc::Range, source_len: usize) -> Result<(), String> {
    let end = range
        .offset
        .checked_add(range.size)
        .ok_or("geometry residency range overflow")?;
    if end as usize > source_len {
        return Err("geometry residency range outside source".into());
    }
    Ok(())
}

fn merge(ranges: &mut Vec<pc::Range>) {
    ranges.sort_unstable_by_key(|r| r.offset);
    let mut used = 0;
    for i in 0..ranges.len() {
        if used > 0 && ranges[i].offset <= ranges[used - 1].offset + ranges[used - 1].size {
            let end = (ranges[i].offset + ranges[i].size)
                .max(ranges[used - 1].offset + ranges[used - 1].size);
            ranges[used - 1].size = end - ranges[used - 1].offset;
        } else {
            ranges.swap(used, i);
            used += 1;
        }
    }
    ranges.truncate(used);
}

fn map(spans: &[Span], offset: u32, size: u32) -> Option<u32> {
    let i = spans
        .partition_point(|s| s.source <= offset)
        .checked_sub(1)?;
    let span = spans[i];
    let relative = offset.checked_sub(span.source)?;
    if relative.checked_add(size)? > span.size {
        return None;
    }
    span.gpu.checked_add(relative)
}

impl GeometryUsage {
    /// `display_pages` is derived only from validated ColorFile page entries.
    /// If shader demand is unavailable, retain original shadow casters. No
    /// missing or stale manifest may remove geometry a future pass can read.
    pub fn new(
        meta: &pc::Meta,
        source_len: usize,
        display_pages: &[bool],
        needs_original_shadow: bool,
    ) -> Result<Self, String> {
        if display_pages.len() != meta.draws.len() || source_len > i32::MAX as usize {
            return Err("geometry residency draw count or byte limit".into());
        }
        let count = meta
            .draws
            .iter()
            .try_fold(0usize, |n, d| n.checked_add(d.lods.len() + 2))
            .ok_or("geometry residency range count overflow")?;
        let mut copies = Vec::new();
        copies
            .try_reserve_exact(count)
            .map_err(|_| "geometry residency range allocation")?;
        let mut indices = Vec::new();
        indices
            .try_reserve_exact(count)
            .map_err(|_| "geometry residency index allocation")?;
        let mut vertices = Vec::new();
        vertices
            .try_reserve_exact(meta.draws.len())
            .map_err(|_| "geometry residency vertex allocation")?;
        for (d, &display) in meta.draws.iter().zip(display_pages) {
            if display
                && (d.node.is_some()
                    || d.skin.is_some()
                    || !matches!(d.layout, pc::VertexLayout::Static | pc::VertexLayout::Baked))
            {
                return Err("geometry residency display page is not static".into());
            }
            checked_range(&d.vertices, source_len)?;
            if d.vertices.offset % 4 != 0
                || d.vertex_count.checked_mul(pc::ipod::stride(d.layout)) != Some(d.vertices.size)
            {
                return Err("geometry residency vertex layout mismatch".into());
            }
            let retain = !display || (needs_original_shadow && d.cast_shadow);
            vertices.push(retain.then_some(d.vertices.offset));
            if retain && d.vertices.size > 0 {
                copies.push(d.vertices.clone());
            }
            if d.layout == pc::VertexLayout::Lights {
                continue;
            }
            for (range, count) in core::iter::once((&d.indices, d.index_count))
                .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
            {
                checked_range(range, source_len)?;
                if range.offset % 2 != 0 || count.checked_mul(2) != Some(range.size) {
                    return Err("geometry residency index layout mismatch".into());
                }
                if retain && range.size > 0 {
                    indices.push(range.clone());
                    // Preserve source modulo-four alignment, including an
                    // index range beginning at byte 2 before a float vertex.
                    let start = range.offset & !3;
                    copies.push(pc::Range {
                        offset: start,
                        size: range.size + range.offset - start,
                    });
                }
            }
        }
        merge(&mut copies);
        merge(&mut indices);
        let mut spans = Vec::new();
        spans
            .try_reserve_exact(copies.len())
            .map_err(|_| "geometry residency upload map allocation")?;
        let mut bytes = 0u32;
        for range in copies {
            let gpu = bytes
                .checked_add(3)
                .ok_or("geometry residency alignment overflow")?
                & !3;
            bytes = gpu
                .checked_add(range.size)
                .ok_or("geometry residency byte overflow")?;
            if gpu > range.offset || bytes as usize > source_len {
                return Err("geometry residency compaction exceeds source".into());
            }
            spans.push(Span {
                source: range.offset,
                size: range.size,
                gpu,
            });
        }
        for (offset, d) in vertices.iter_mut().zip(&meta.draws) {
            if let Some(source) = *offset {
                *offset = Some(
                    map(&spans, source, d.vertices.size)
                        .ok_or("geometry residency vertex missing from upload")?,
                );
            }
        }
        let mut mapped_indices = Vec::new();
        mapped_indices
            .try_reserve_exact(indices.len())
            .map_err(|_| "geometry residency index map allocation")?;
        for range in indices {
            let gpu = map(&spans, range.offset, range.size)
                .ok_or("geometry residency indices missing from upload")?;
            mapped_indices.push(Span {
                source: range.offset,
                size: range.size,
                gpu,
            });
        }
        Ok(Self {
            source_len,
            bytes: bytes as usize,
            copies: spans,
            vertices,
            indices: mapped_indices,
        })
    }

    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn vertex_offset(&self, draw: usize) -> Option<u32> {
        self.vertices.get(draw).copied().flatten()
    }
    pub fn index_offset(&self, source: u32, count: u32) -> Option<u32> {
        if source % 2 != 0 {
            return None;
        }
        if count == 0 {
            return ((source as usize) <= self.source_len).then_some(0);
        }
        map(&self.indices, source, count.checked_mul(2)?)
    }

    /// Reuse the validated source allocation; never allocate a second GEOM.
    /// All source-derived CPU data must be built before this call. Spans are
    /// sorted and only move left, so no unread source bytes are overwritten.
    pub fn compact(&self, data: &mut Vec<u8>) -> Result<(), String> {
        if data.len() != self.source_len {
            return Err("geometry residency source length changed".into());
        }
        let mut end = 0;
        for span in &self.copies {
            let start = span.source as usize;
            let destination = span.gpu as usize;
            data[end..destination].fill(0);
            data.copy_within(start..start + span.size as usize, destination);
            end = destination + span.size as usize;
        }
        data.truncate(self.bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn fixture() -> (pc::Meta, Vec<u8>) {
        let (mut meta, _, _) = crate::validation::tests::fixture();
        let mut first = meta.draws[0].clone();
        first.node = None;
        first.vertices = pc::Range {
            offset: 0,
            size: 3 * pc::ipod::stride(first.layout),
        };
        first.indices = pc::Range {
            offset: 156,
            size: 6,
        };
        first.lods = vec![pc::DrawLod {
            indices: pc::Range {
                offset: 162,
                size: 6,
            },
            index_count: 3,
            error: 0.25,
        }];
        let mut second = first.clone();
        second.vertices.offset = 168;
        second.indices.offset = 324;
        second.lods[0].indices.offset = 330;
        meta.draws = vec![first, second];
        (meta, (0..336).map(|i| (i % 251) as u8).collect())
    }

    #[test]
    fn removes_only_display_sources_keeps_all_raw_lods_and_aliases_exact() {
        let (mut meta, source) = fixture();
        meta.draws.push(meta.draws[1].clone());
        let original = serde_json::to_vec(&meta).unwrap();
        let usage = GeometryUsage::new(&meta, source.len(), &[true, false, false], false).unwrap();
        assert_eq!(usage.bytes(), 168);
        assert_eq!(usage.vertex_offset(0), None);
        assert_eq!(usage.vertex_offset(1), Some(0));
        assert_eq!(usage.vertex_offset(2), Some(0));
        assert_eq!(usage.index_offset(156, 3), None);
        assert_eq!(usage.index_offset(162, 3), None);
        assert_eq!(usage.index_offset(324, 3), Some(156));
        assert_eq!(usage.index_offset(330, 3), Some(162));
        assert_eq!(usage.index_offset(326, 4), Some(158));
        assert_eq!(usage.index_offset(324, 7), None);
        assert_eq!(usage.index_offset(325, 1), None);
        assert_eq!(usage.index_offset(0, 3), None);
        let mut compacted = source.clone();
        let allocation = compacted.as_ptr();
        usage.compact(&mut compacted).unwrap();
        assert_eq!(compacted, source[168..]);
        assert_eq!(compacted.as_ptr(), allocation);
        assert_eq!(serde_json::to_vec(&meta).unwrap(), original);
    }

    #[test]
    fn shadow_demand_retains_casters_and_all_display_geometry_can_be_absent() {
        let (mut meta, source) = fixture();
        meta.draws[1].cast_shadow = false;
        let usage = GeometryUsage::new(&meta, source.len(), &[true, true], true).unwrap();
        assert_eq!(usage.vertex_offset(0), Some(0));
        assert_eq!(usage.vertex_offset(1), None);
        assert_eq!(usage.index_offset(162, 3), Some(162));
        assert_eq!(usage.bytes(), 168);
        let usage = GeometryUsage::new(&meta, source.len(), &[true, true], false).unwrap();
        let mut compacted = source;
        usage.compact(&mut compacted).unwrap();
        assert!(compacted.is_empty());
        assert_eq!(usage.bytes(), 0);
        assert_eq!(usage.index_offset(0, 0), Some(0));
        assert_eq!(usage.index_offset(337, 0), None);
    }

    #[test]
    fn index_halfword_alignment_shared_vertices_and_lightpoint_bytes_survive() {
        let (mut meta, mut source) = fixture();
        meta.draws[1].indices.offset = 162;
        meta.draws[1].lods.clear();
        meta.draws[1].vertices.offset = 168;
        meta.draws[1].layout = pc::VertexLayout::Lights;
        meta.draws[1].vertex_count = 3;
        meta.draws[1].vertices.size = 3 * pc::LIGHT_POINT_STRIDE as u32;
        // A raw triangle shares retained source vertices with a display draw,
        // while its index halfword begins two bytes into a four-byte word.
        let mut raw = meta.draws[0].clone();
        raw.indices.offset = 162;
        raw.lods.clear();
        meta.draws.push(raw);
        source.resize(336, 0);
        let usage = GeometryUsage::new(&meta, source.len(), &[true, false, false], false).unwrap();
        let mut compacted = source.clone();
        usage.compact(&mut compacted).unwrap();
        assert_eq!(usage.vertex_offset(0), None);
        assert_eq!(usage.vertex_offset(2), Some(0));
        let index = usage.index_offset(162, 3).unwrap() as usize;
        assert_eq!(index % 4, 2);
        assert_eq!(&compacted[index..index + 6], &source[162..168]);
        let lights = usage.vertex_offset(1).unwrap() as usize;
        assert_eq!(lights % 4, 0);
        assert_eq!(&compacted[lights..lights + 120], &source[168..288]);
    }

    #[test]
    fn rejects_bad_masks_ranges_layouts_and_changed_source_without_writing() {
        let (meta, source) = fixture();
        assert!(GeometryUsage::new(&meta, source.len(), &[true], false).is_err());
        for mode in 0..5 {
            let mut bad = meta.clone();
            match mode {
                0 => bad.draws[0].node = Some(0),
                1 => bad.draws[0].vertices.offset = u32::MAX - 3,
                2 => bad.draws[0].vertices.size -= 1,
                3 => bad.draws[1].lods[0].indices.offset += 1,
                _ => bad.draws[1].lods[0].indices.size = u32::MAX,
            }
            assert!(GeometryUsage::new(&bad, source.len(), &[true, false], false).is_err());
        }
        let usage = GeometryUsage::new(&meta, source.len(), &[true, false], false).unwrap();
        let mut short = source[..source.len() - 1].to_vec();
        let original = short.clone();
        assert!(usage.compact(&mut short).is_err());
        assert_eq!(short, original);
    }
}
