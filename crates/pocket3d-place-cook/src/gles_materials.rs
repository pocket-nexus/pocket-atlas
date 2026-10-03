//! Fold static opaque base tints into constant-per-triangle vertex colors.
//!
//! The surface shader interpolates sRGB bytes before decoding. Folding a tint
//! into gradient colors would change that interpolation, so those draws remain
//! untouched. The original material table remains intact for animated users.
use super::{pc, RawValue, Result};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Folded {
    pub meta: pc::Meta,
    pub materials: Vec<Box<RawValue>>,
    pub draws: Vec<Box<RawValue>>,
    pub geometry: Vec<u8>,
    pub canonical_materials: usize,
    pub folded_draws: usize,
    pub linear_error: f32,
    pub display_error: f32,
}

// Keep this reference aligned with vita/shaders/common.cgh (and its GLES
// translation), rather than compounding its approximation with an IEC inverse.
fn shader_decode(c: f32) -> f32 {
    c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878)
}

fn fold_byte(byte: u8, tint: f32) -> (u8, f32, f32) {
    let desired = shader_decode(byte as f32 / 255.0) * tint;
    let mut lo = 0u16;
    let mut hi = 255u16;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if shader_decode(mid as f32 / 255.0) < desired {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let upper = shader_decode(lo as f32 / 255.0);
    if lo > 0 && desired - shader_decode((lo - 1) as f32 / 255.0) < upper - desired {
        lo -= 1;
    }
    let actual = shader_decode(lo as f32 / 255.0);
    (
        lo as u8,
        (actual - desired).abs(),
        (pc::color::encode(actual) - pc::color::encode(desired)).abs(),
    )
}

fn slice<'a>(geometry: &'a [u8], r: &pc::Range) -> Result<&'a [u8]> {
    let end = r
        .offset
        .checked_add(r.size)
        .ok_or("tint geometry range overflow")?;
    geometry
        .get(r.offset as usize..end as usize)
        .ok_or_else(|| "tint geometry range outside GEOM".into())
}

fn eligible(meta: &pc::Meta, d: &pc::Draw) -> bool {
    let Some(m) = meta.materials.get(d.material as usize) else {
        return false;
    };
    d.layout == pc::VertexLayout::Baked
        && d.node.is_none()
        && d.skin.is_none()
        && m.blend == pc::Blend::Opaque
        && m.depth_write
        && m.kind == pc::Kind::Standard
        && m.emissive.iter().all(|&v| v == 0.0)
        && m.emission_shade.is_none()
        && m.color[..3].iter().all(|v| (0.0..=1.0).contains(v))
}

fn constant_triangles(geometry: &[u8], d: &pc::Draw, check_colors: bool) -> Result<bool> {
    let vertices = slice(geometry, &d.vertices)?;
    if d.vertex_count.checked_mul(28) != Some(d.vertices.size) {
        return Err("tint baked vertex stride mismatch".into());
    }
    let mut constant = true;
    for (r, count) in std::iter::once((&d.indices, d.index_count))
        .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
    {
        let indices = slice(geometry, r)?;
        if count % 3 != 0 || count.checked_mul(2) != Some(r.size) || r.offset % 2 != 0 {
            return Err("tint triangle range mismatch".into());
        }
        for triangle in indices.chunks_exact(6) {
            let mut color = None;
            for id in triangle.chunks_exact(2) {
                let id = u16::from_le_bytes(id.try_into().unwrap()) as usize;
                let vertex = vertices
                    .get(id * 28..id * 28 + 28)
                    .ok_or("tint vertex index out of bounds")?;
                let rgb = &vertex[20..23];
                if check_colors && color.is_some_and(|color| color != rgb) {
                    constant = false;
                }
                color = Some(rgb);
            }
        }
    }
    Ok(constant)
}

fn raw_fields(raw: &RawValue) -> Result<BTreeMap<String, Box<RawValue>>> {
    serde_json::from_str(raw.get()).map_err(|e| e.to_string())
}

/// Only name, RGB base tint and the vertex-color enable flag may differ.
/// The alpha lexeme and all other known/unknown fields remain part of the key.
fn key(raw: &RawValue) -> Result<(String, String)> {
    let mut fields = raw_fields(raw)?;
    let color: Vec<Box<RawValue>> = serde_json::from_str(
        fields
            .remove("color")
            .ok_or("material color missing")?
            .get(),
    )
    .map_err(|e| e.to_string())?;
    if color.len() != 4 {
        return Err("material color size mismatch".into());
    }
    fields.remove("name");
    fields.remove("vertex_color");
    Ok((
        serde_json::to_string(&fields).map_err(|e| e.to_string())?,
        color[3].get().into(),
    ))
}

pub(super) fn adapt(
    meta: &pc::Meta,
    materials: &[Box<RawValue>],
    draws: &[Box<RawValue>],
    geometry: &[u8],
) -> Result<Option<Folded>> {
    if materials.len() != meta.materials.len() || draws.len() != meta.draws.len() {
        return Err("tint metadata table length mismatch".into());
    }
    let mut eligible_draws = vec![false; draws.len()];
    let mut users = BTreeMap::<(u32, u32), Vec<usize>>::new();
    for (i, d) in meta.draws.iter().enumerate() {
        users
            .entry((d.vertices.offset, d.vertices.size))
            .or_default()
            .push(i);
        if eligible(meta, d) {
            eligible_draws[i] = constant_triangles(
                geometry,
                d,
                meta.materials[d.material as usize].vertex_color,
            )?;
        }
    }
    // Vertex-color writes must never alias an index payload, including ranges
    // owned by excluded draws. Prefix maxima make this interval check linear
    // after sorting, without a quadratic scan on large places.
    let mut indices: Vec<_> = meta
        .draws
        .iter()
        .flat_map(|d| std::iter::once(&d.indices).chain(d.lods.iter().map(|l| &l.indices)))
        .filter(|r| r.size != 0)
        .map(|r| (u64::from(r.offset), u64::from(r.offset) + u64::from(r.size)))
        .collect();
    indices.sort_unstable();
    let mut end = 0;
    for range in &mut indices {
        end = end.max(range.1);
        range.1 = end;
    }
    for (i, d) in meta
        .draws
        .iter()
        .enumerate()
        .filter(|(i, _)| eligible_draws[*i])
    {
        let start = u64::from(d.vertices.offset);
        let end = start + u64::from(d.vertices.size);
        let at = indices.partition_point(|r| r.0 < end);
        if at != 0 && indices[at - 1].1 > start {
            return Err(format!("tint draw {i} vertex/index ranges overlap"));
        }
    }
    // Nonidentical overlapping vertex ranges cannot be folded independently.
    // Track the farthest preceding end, which also catches nested intervals.
    let mut overlaps = BTreeSet::new();
    let mut previous = None;
    for &range in users.keys().filter(|r| r.1 != 0) {
        let start = u64::from(range.0);
        let end = start + u64::from(range.1);
        if let Some((prior, prior_end)) = previous {
            if start < prior_end {
                overlaps.insert(prior);
                overlaps.insert(range);
            }
            if end <= prior_end {
                continue;
            }
        }
        previous = Some((range, end));
    }
    // Modify a shared vertex range only when every user needs the same fold.
    // This also protects dynamic draws that happen to reference static bytes.
    for (range, group) in &users {
        let material = meta.draws[group[0]].material;
        if overlaps.contains(range)
            || group
                .iter()
                .any(|&i| !eligible_draws[i] || meta.draws[i].material != material)
        {
            for &i in group {
                eligible_draws[i] = false;
            }
        }
    }
    let mut groups = BTreeMap::<(String, String), Vec<usize>>::new();
    for (i, d) in meta.draws.iter().enumerate() {
        if eligible_draws[i] {
            groups
                .entry(key(&materials[d.material as usize])?)
                .or_default()
                .push(i);
        }
    }
    groups.retain(|_, g| {
        g.iter()
            .map(|&i| meta.draws[i].material)
            .collect::<BTreeSet<_>>()
            .len()
            > 1
    });
    if groups.is_empty() {
        return Ok(None);
    }
    let mut out = Folded {
        meta: meta.clone(),
        materials: materials.to_vec(),
        draws: draws.to_vec(),
        geometry: geometry.to_vec(),
        canonical_materials: groups.len(),
        folded_draws: 0,
        linear_error: 0.0,
        display_error: 0.0,
    };
    let mut done = BTreeSet::new();
    for group in groups.values() {
        let first = meta.draws[group[0]].material as usize;
        let mut canonical = meta.materials[first].clone();
        canonical.name = format!("{} (GLES vertex tint)", canonical.name);
        canonical.color[..3].fill(1.0);
        canonical.vertex_color = true;
        let id = u32::try_from(out.materials.len()).map_err(|_| "material table exceeds u32")?;
        let mut fields = raw_fields(&materials[first])?;
        let mut color: Vec<Box<RawValue>> =
            serde_json::from_str(fields["color"].get()).map_err(|e| e.to_string())?;
        for channel in &mut color[..3] {
            *channel = RawValue::from_string("1".into()).unwrap();
        }
        fields.insert(
            "name".into(),
            serde_json::value::to_raw_value(&canonical.name).map_err(|e| e.to_string())?,
        );
        fields.insert(
            "color".into(),
            serde_json::value::to_raw_value(&color).map_err(|e| e.to_string())?,
        );
        fields.insert(
            "vertex_color".into(),
            RawValue::from_string("true".into()).unwrap(),
        );
        out.materials
            .push(serde_json::value::to_raw_value(&fields).map_err(|e| e.to_string())?);
        out.meta.materials.push(canonical);
        for &i in group {
            let d = &meta.draws[i];
            let m = &meta.materials[d.material as usize];
            if done.insert((d.vertices.offset, d.vertices.size)) {
                let start = d.vertices.offset as usize;
                let end = start + d.vertices.size as usize;
                for v in out.geometry[start..end].chunks_exact_mut(28) {
                    for c in 0..3 {
                        let (byte, linear, display) =
                            fold_byte(if m.vertex_color { v[20 + c] } else { 255 }, m.color[c]);
                        v[20 + c] = byte;
                        out.linear_error = out.linear_error.max(linear);
                        out.display_error = out.display_error.max(display);
                    }
                    if !m.vertex_color {
                        v[23] = 255;
                    }
                }
            }
            out.meta.draws[i].material = id;
            let mut fields = raw_fields(&draws[i])?;
            fields.insert(
                "material".into(),
                serde_json::value::to_raw_value(&id).map_err(|e| e.to_string())?,
            );
            out.draws[i] = serde_json::value::to_raw_value(&fields).map_err(|e| e.to_string())?;
            out.folded_draws += 1;
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::super::{gles_geometry, GeometryProfile};
    use super::*;
    use serde_json::json;

    macro_rules! raw {
        ($value:expr) => {
            serde_json::value::to_raw_value($value).unwrap()
        };
    }

    fn fixture() -> (pc::Meta, Vec<Box<RawValue>>, Vec<Box<RawValue>>, Vec<u8>) {
        let (mut meta, draws, mut geometry) = gles_geometry::tests::fixture();
        meta.materials[0].color = [0.3, 0.6, 0.9, 0.8];
        let mut second = meta.materials[0].clone();
        second.name = "second tint".into();
        second.color[..3].copy_from_slice(&[0.15, 0.55, 1.0]);
        meta.materials.push(second);
        meta.draws[1].material = 1;
        let mut draws = draws;
        let mut fields = raw_fields(&draws[1]).unwrap();
        fields.insert("material".into(), raw!(&1));
        draws[1] = raw!(&fields);
        for d in &meta.draws {
            for vertex in geometry[d.vertices.offset as usize..][..d.vertices.size as usize]
                .chunks_exact_mut(28)
            {
                vertex[20..23].copy_from_slice(&[61, 143, 231]);
            }
        }
        let materials = meta
            .materials
            .iter()
            .map(|m| {
                let mut fields = raw_fields(&raw!(m)).unwrap();
                fields.insert(
                    "future_material".into(),
                    RawValue::from_string(
                        "{\"tiny\":-2.4492937e-16,\"big\":9007199254740993}".into(),
                    )
                    .unwrap(),
                );
                raw!(&fields)
            })
            .collect();
        (meta, materials, draws, geometry)
    }

    fn run(meta: &pc::Meta, geometry: &[u8]) -> Result<Option<Folded>> {
        adapt(
            meta,
            &meta.materials.iter().map(|v| raw!(v)).collect::<Vec<_>>(),
            &meta.draws.iter().map(|v| raw!(v)).collect::<Vec<_>>(),
            geometry,
        )
    }

    fn assert_colors(meta: &pc::Meta, geometry: &[u8], out: &Folded) {
        assert_eq!(geometry.len(), out.geometry.len());
        let mut expected = geometry.to_vec();
        for (d, next) in meta.draws.iter().zip(&out.meta.draws) {
            let mut old_fields = serde_json::to_value(d).unwrap();
            old_fields["material"] = json!(next.material);
            assert_eq!(old_fields, serde_json::to_value(next).unwrap());
            if d.material == next.material {
                continue;
            }
            let m = &meta.materials[d.material as usize];
            assert!(constant_triangles(geometry, d, m.vertex_color).unwrap());
            let new = &out.meta.materials[next.material as usize];
            assert_eq!(new.color, [1.0, 1.0, 1.0, m.color[3]]);
            assert!(new.vertex_color);
            let old = slice(geometry, &d.vertices).unwrap();
            let now = slice(&out.geometry, &d.vertices).unwrap();
            for ((a, b), e) in old.chunks_exact(28).zip(now.chunks_exact(28)).zip(
                expected[d.vertices.offset as usize..][..d.vertices.size as usize]
                    .chunks_exact_mut(28),
            ) {
                for c in 0..3 {
                    let wanted = m.color[c]
                        * if m.vertex_color {
                            shader_decode(a[20 + c] as f32 / 255.0)
                        } else {
                            1.0
                        };
                    let actual = shader_decode(b[20 + c] as f32 / 255.0);
                    assert!((wanted - actual).abs() <= 0.0044841);
                    assert!(
                        (pc::color::encode(wanted) - pc::color::encode(actual)).abs() <= 0.0024071
                    );
                }
                assert_eq!(b[23], if m.vertex_color { a[23] } else { 255 });
                e[20..24].copy_from_slice(&b[20..24]);
            }
        }
        assert_eq!(
            expected, out.geometry,
            "only vertex RGB/unused alpha may change"
        );
    }

    #[test]
    fn appends_materials_preserving_raw_fields_and_alpha_and_geometry() {
        let (meta, materials, draws, geometry) = fixture();
        let out = adapt(&meta, &materials, &draws, &geometry)
            .unwrap()
            .unwrap();
        assert_eq!((out.canonical_materials, out.folded_draws), (1, 2));
        assert_eq!(out.meta.materials.len(), 3);
        for (a, b) in materials.iter().zip(&out.materials) {
            assert_eq!(a.get(), b.get());
        }
        let original = raw_fields(&materials[0]).unwrap();
        let canonical = raw_fields(&out.materials[2]).unwrap();
        for (k, v) in original {
            if !["name", "color", "vertex_color"].contains(&k.as_str()) {
                assert_eq!(v.get(), canonical[&k].get(), "{k}");
            }
        }
        for (a, b) in draws.iter().zip(&out.draws) {
            let b = raw_fields(b).unwrap();
            for (k, v) in raw_fields(a).unwrap() {
                if k != "material" {
                    assert_eq!(v.get(), b[&k].get(), "{k}");
                }
            }
        }
        assert_colors(&meta, &geometry, &out);
    }

    #[test]
    fn disabled_vertex_colors_ignore_gradient_and_make_alpha_opaque() {
        let (mut meta, _, _, mut geometry) = fixture();
        meta.materials[0].vertex_color = false;
        let start = meta.draws[0].vertices.offset as usize;
        geometry[start + 20] = 255;
        geometry[start + 23] = 0;
        let out = run(&meta, &geometry).unwrap().unwrap();
        assert_colors(&meta, &geometry, &out);
    }

    #[test]
    fn gradient_in_any_lod_prevents_folding() {
        let (meta, _, _, mut geometry) = fixture();
        geometry[meta.draws[0].vertices.offset as usize + 20] += 1;
        assert!(run(&meta, &geometry).unwrap().is_none());
        let (mut meta, _, _, mut geometry) = fixture();
        // Base L0 references only constant vertices; the LOD introduces vertex3.
        meta.draws[0].indices = meta.draws[0].lods[0].indices.clone();
        meta.draws[0].index_count = 3;
        meta.draws[0].lods[1].indices = pc::Range {
            offset: geometry.len() as u32,
            size: 6,
        };
        meta.draws[0].lods[1].index_count = 3;
        geometry.extend([0u16, 2, 3].into_iter().flat_map(u16::to_le_bytes));
        geometry[meta.draws[0].vertices.offset as usize + 3 * 28 + 20] += 1;
        assert!(run(&meta, &geometry).unwrap().is_none());
    }

    #[test]
    fn dynamic_transparent_emissive_and_special_materials_are_excluded() {
        for case in 0..10 {
            let (mut meta, _, _, geometry) = fixture();
            match case {
                0 => meta.draws[0].node = Some(0),
                1 => meta.draws[0].skin = Some(0),
                2 => meta.draws[0].layout = pc::VertexLayout::Static,
                3 => meta.materials[0].blend = pc::Blend::Alpha,
                4 => meta.materials[0].depth_write = false,
                5 => meta.materials[0].kind = pc::Kind::Unlit,
                6 => meta.materials[0].emissive[0] = 0.1,
                7 => meta.materials[0].color[0] = 1.1,
                8 => meta.materials[0].color[0] = f32::NAN,
                9 => {
                    meta.materials[0].emission_shade = Some(
                        serde_json::from_value(json!({"normal":[0,0,0,0],"height":[0,0,0,0]}))
                            .unwrap(),
                    )
                }
                _ => unreachable!(),
            }
            // NaN cannot be read back from JSON but the eligibility test still
            // must reject it before touching material serialization fields.
            assert!(!eligible(&meta, &meta.draws[0]), "case {case}");
            assert!(run(&meta, &geometry).unwrap().is_none(), "case {case}");
        }
    }

    #[test]
    fn differing_unknown_state_or_alpha_lexeme_never_merge() {
        for (field, value) in [
            ("future_material", "{\"different\":true}"),
            ("roughness", "0.7"),
            ("color", "[0.15,0.55,1.0,0.8000000000000001]"),
        ] {
            let (meta, mut materials, draws, geometry) = fixture();
            let mut fields = raw_fields(&materials[1]).unwrap();
            fields.insert(field.into(), RawValue::from_string(value.into()).unwrap());
            materials[1] = raw!(&fields);
            assert!(
                adapt(&meta, &materials, &draws, &geometry)
                    .unwrap()
                    .is_none(),
                "{field}"
            );
        }
    }

    #[test]
    fn aliased_dynamic_or_partially_overlapping_vertices_are_not_mutated() {
        for partial in [false, true] {
            let (mut meta, _, _, geometry) = fixture();
            let mut alias = meta.draws[0].clone();
            alias.node = Some(0);
            if partial {
                alias.vertices.offset += 28;
                alias.vertices.size -= 28;
                alias.vertex_count -= 1;
            }
            meta.draws.push(alias);
            assert!(run(&meta, &geometry).unwrap().is_none());
        }
    }

    #[test]
    fn malformed_indices_are_rejected_even_without_vertex_colors() {
        for case in 0..5 {
            let (mut meta, _, _, mut geometry) = fixture();
            meta.materials[0].vertex_color = false;
            let d = &mut meta.draws[0];
            match case {
                0 => d.indices.size -= 2,
                1 => d.lods[1].indices.offset = u32::MAX,
                2 => d.vertex_count = u32::MAX,
                3 => {
                    geometry[d.indices.offset as usize..][..2].copy_from_slice(&4u16.to_le_bytes())
                }
                4 => d.lods[0].index_count = 2,
                _ => unreachable!(),
            }
            assert!(run(&meta, &geometry).is_err(), "case {case}");
        }
    }

    #[test]
    fn vertices_cannot_alias_an_excluded_draws_index_payload() {
        let (mut meta, _, _, geometry) = fixture();
        let mut alias = meta.draws[0].clone();
        alias.node = Some(0);
        alias.indices.offset = meta.draws[1].vertices.offset + 20;
        meta.draws.push(alias);
        assert!(run(&meta, &geometry)
            .err()
            .unwrap()
            .contains("vertex/index ranges overlap"));
    }

    #[test]
    fn nearest_shader_byte_has_bounded_linear_and_base_display_error() {
        for byte in 0..=255 {
            assert_eq!(fold_byte(byte, 1.0).0, byte);
            assert_eq!(fold_byte(byte, 0.0), (0, 0.0, 0.0));
            for step in 0..=1024 {
                let (_, linear, display) = fold_byte(byte, step as f32 / 1024.0);
                assert!(linear <= 0.0044841);
                assert!(display <= 0.0024071);
            }
        }
        // Every decision boundary is the worst error within that quantizer bin.
        for byte in 0..255 {
            let midpoint = (shader_decode(byte as f32 / 255.0)
                + shader_decode((byte + 1) as f32 / 255.0))
                * 0.5;
            let (_, linear, display) = fold_byte(255, midpoint);
            assert!(linear <= 0.0044841);
            assert!(display <= 0.0024071);
        }
    }

    #[test]
    fn full_pack_enables_tint_only_for_throughput_and_keeps_animation_raw() {
        let (meta, materials, draws, geometry) = fixture();
        let mut fields = raw_fields(&raw!(&meta)).unwrap();
        fields.insert("materials".into(), raw!(&materials));
        fields.insert("draws".into(), raw!(&draws));
        fields.insert(
            "future".into(),
            RawValue::from_string("1.234567891234567890123456789".into()).unwrap(),
        );
        let texels = vec![255; 512 * 512 * 4];
        let animation = vec![0; meta.frames as usize * 7 * 4];
        let source = pc::write(&[
            (pc::TAG_META, raw!(&fields).get().as_bytes(), 16),
            (pc::TAG_TEXTURES, &texels, 16),
            (pc::TAG_GEOMETRY, &geometry, 16),
            (pc::TAG_ANIMATION, &animation, 16),
            (*b"XTRA", b"future payload", 16),
        ]);
        for profile in [GeometryProfile::Balanced, GeometryProfile::Throughput] {
            let out = super::super::adapt_with_profile(&source, 512, profile).unwrap();
            let pack = pc::Pack::parse(&out.bytes).unwrap();
            assert_eq!(pack.section(pc::TAG_ANIMATION).unwrap(), animation);
            assert_eq!(pack.section(*b"XTRA").unwrap(), b"future payload");
            let after: BTreeMap<String, Box<RawValue>> =
                serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
            for (key, before) in &fields {
                if !["draws", "materials", "textures"].contains(&key.as_str()) {
                    assert_eq!(before.get(), after[key].get(), "{key}");
                }
            }
            let material_array: Vec<Box<RawValue>> =
                serde_json::from_str(after["materials"].get()).unwrap();
            for (a, b) in materials.iter().zip(&material_array) {
                assert_eq!(a.get(), b.get());
            }
            assert_eq!(
                out.tint_draws,
                if profile == GeometryProfile::Throughput {
                    2
                } else {
                    0
                }
            );
            assert_eq!(
                material_array.len(),
                if profile == GeometryProfile::Throughput {
                    3
                } else {
                    2
                }
            );
        }
    }

    #[test]
    #[ignore = "set POCKET_ATLAS_GLES_SOURCES to the canonical places directory"]
    fn verifies_real_scene_tints_and_combined_page_precision() {
        let root = std::env::var("POCKET_ATLAS_GLES_SOURCES").expect("source directory");
        let mut count = 0;
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            let path = entry
                .path()
                .join(format!("{}.place", entry.file_name().to_string_lossy()));
            if !path.is_file() {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let pack = pc::Pack::parse(&bytes).unwrap();
            let meta = pack.meta().unwrap();
            let fields: BTreeMap<String, Box<RawValue>> =
                serde_json::from_slice(pack.section(pc::TAG_META).unwrap()).unwrap();
            let materials: Vec<Box<RawValue>> =
                serde_json::from_str(fields["materials"].get()).unwrap();
            let draws: Vec<Box<RawValue>> = serde_json::from_str(fields["draws"].get()).unwrap();
            let geometry = pack.section(pc::TAG_GEOMETRY).unwrap();
            if let Some(tint) = adapt(&meta, &materials, &draws, geometry).unwrap() {
                assert_colors(&meta, geometry, &tint);
                for (a, b) in materials.iter().zip(&tint.materials) {
                    assert_eq!(a.get(), b.get());
                }
                if let Some(batch) = gles_geometry::adapt_with_profile(
                    &tint.meta,
                    &tint.draws,
                    &tint.geometry,
                    512,
                    GeometryProfile::Throughput,
                )
                .unwrap()
                {
                    let mut after = tint.meta.clone();
                    after.draws = batch
                        .draws
                        .iter()
                        .map(|d| serde_json::from_str(d.get()).unwrap())
                        .collect();
                    gles_geometry::tests::assert_shape_with_profile(
                        &tint.meta,
                        &tint.geometry,
                        &after,
                        &batch.bytes,
                        GeometryProfile::Throughput,
                    );
                }
                println!(
                    "{}: {} tint materials / {} draws; max {:.7} linear / {:.4} sRGB byte levels",
                    path.display(),
                    tint.canonical_materials,
                    tint.folded_draws,
                    tint.linear_error,
                    tint.display_error * 255.0
                );
            }
            count += 1;
        }
        assert!(count > 0, "no source packs found");
    }
}
