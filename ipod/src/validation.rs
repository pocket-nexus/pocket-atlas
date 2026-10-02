//! Semantic checks before a place allocates GPU resources. Container section
//! offsets / lengths must be checked by the reader before calling this module.
//! `validate_geometry` additionally checks indices and vertex payload fields;
//! their values cannot be verified from section lengths alone.
//!
//! Host tests (no UIKit, GLES or device required):
//! ```sh
//! cargo build -p pocket3d-place --locked
//! mkdir -p .pocket-build/validation
//! rustc --edition=2021 --test ipod/src/validation.rs --extern pocket3d_place=target/debug/libpocket3d_place.rlib -L dependency=target/debug/deps -o .pocket-build/validation/ipod-semantic-tests
//! .pocket-build/validation/ipod-semantic-tests
//! ```
extern crate alloc;
use alloc::{format, string::String, vec::Vec};
use core::ops::Range;
use pocket3d_place as pc;

type Result<T = ()> = core::result::Result<T, String>;

/// Bound the section count before the shared parser allocates its table.
pub fn place_header_size(header: &[u8], file_len: usize) -> Result<usize> {
    require(
        header.len() >= 16 && file_len >= 16,
        "PLCE",
        "truncated header",
    )?;
    require(header[..4] == pc::MAGIC, "PLCE", "bad magic")?;
    let word = |at| u32::from_le_bytes(header[at..at + 4].try_into().unwrap());
    require(word(4) == pc::VERSION, "PLCE", "unsupported version")?;
    require(word(12) == 0, "PLCE", "reserved header field is not zero")?;
    let count = word(8) as usize;
    require((4..=16).contains(&count), "PLCE", "invalid section count")?;
    let size = count
        .checked_mul(16)
        .and_then(|n| n.checked_add(16))
        .ok_or("PLCE header overflow")?;
    require(size <= file_len, "PLCE", "truncated section table")?;
    Ok(size)
}

/// Checks the complete container table against the actual open file's length.
/// Empty sections occupy no bytes; nonempty sections may never alias.
pub fn validate_container(table: &[u8], file_len: usize) -> Result<Vec<pc::Section>> {
    let table_size = place_header_size(table, file_len)?;
    require(
        table.len() == table_size,
        "PLCE",
        "section table length mismatch",
    )?;
    let sections = pc::Pack::parse_header(table).map_err(|e| format!("PLCE: {e}"))?;
    for (i, s) in sections.iter().enumerate() {
        let label = format!("section {:?}", s.tag);
        require(s.align.is_power_of_two(), &label, "invalid alignment")?;
        require(
            s.offset as usize >= table_size && s.offset % s.align == 0,
            &label,
            "invalid absolute offset",
        )?;
        let end = s
            .offset
            .checked_add(s.size)
            .ok_or_else(|| format!("{label}: absolute range overflow"))?;
        require(
            end as usize <= file_len,
            &label,
            "range exceeds file length",
        )?;
        for previous in &sections[..i] {
            require(previous.tag != s.tag, &label, "duplicate section tag")?;
            // The previous end has already been checked for overflow.
            let previous_end = previous.offset + previous.size;
            require(
                s.size == 0
                    || previous.size == 0
                    || end <= previous.offset
                    || s.offset >= previous_end,
                &label,
                "overlapping sections",
            )?;
        }
    }
    for tag in [
        pc::TAG_META,
        pc::TAG_TEXTURES,
        pc::TAG_GEOMETRY,
        pc::TAG_ANIMATION,
    ] {
        require(
            sections.iter().any(|s| s.tag == tag),
            "PLCE",
            "missing required section",
        )?;
    }
    Ok(sections)
}

/// Converts a section-relative payload range without u32 wraparound and
/// checks both the parent section and actual file length.
pub fn section_span(
    section: &pc::Section,
    range: &pc::Range,
    file_len: usize,
) -> Result<Range<usize>> {
    let local_end = range
        .offset
        .checked_add(range.size)
        .ok_or("section-relative range overflow")?;
    require(
        local_end <= section.size,
        "payload",
        "range exceeds parent section",
    )?;
    let start = section
        .offset
        .checked_add(range.offset)
        .ok_or("absolute payload offset overflow")?;
    let end = start
        .checked_add(range.size)
        .ok_or("absolute payload end overflow")?;
    require(
        end as usize <= file_len,
        "payload",
        "range exceeds file length",
    )?;
    Ok(start as usize..end as usize)
}

fn require(ok: bool, label: &str, reason: &str) -> Result {
    if ok {
        Ok(())
    } else {
        Err(format!("{label}: {reason}"))
    }
}
fn finite(values: &[f32], label: &str) -> Result {
    require(
        values.iter().all(|v| v.is_finite()),
        label,
        "non-finite value",
    )
}
macro_rules! finite_fields {
    ($label:expr; $($value:expr),+ $(,)?) => { $(finite(&$value, $label)?;)+ };
}
fn reference(index: Option<u32>, count: usize, label: &str) -> Result {
    require(
        index.map_or(true, |i| (i as usize) < count),
        label,
        "reference out of bounds",
    )
}
fn span(range: &pc::Range, bytes: usize, alignment: u32, label: &str) -> Result<Range<usize>> {
    require(
        range.offset % alignment == 0 && range.size % alignment == 0,
        label,
        "unaligned range",
    )?;
    let end = range
        .offset
        .checked_add(range.size)
        .ok_or_else(|| format!("{label}: range overflow"))? as usize;
    require(end <= bytes, label, "range exceeds section")?;
    Ok(range.offset as usize..end)
}
fn exact_span(
    range: &pc::Range,
    count: u32,
    stride: u32,
    bytes: usize,
    alignment: u32,
    label: &str,
) -> Result<Range<usize>> {
    let expected = count
        .checked_mul(stride)
        .ok_or_else(|| format!("{label}: count overflow"))?;
    require(
        range.size == expected,
        label,
        "count and byte size disagree",
    )?;
    span(range, bytes, alignment, label)
}
fn bounds(min: [f32; 3], max: [f32; 3], label: &str) -> Result {
    finite_fields!(label; min, max);
    require((0..3).all(|i| min[i] <= max[i]), label, "inverted bounds")
}
fn quaternion(q: &[f32], label: &str) -> Result {
    finite(q, label)?;
    let norm: f32 = q.iter().map(|v| v * v).sum();
    require(
        (norm - 1.0).abs() < 0.02,
        label,
        "rotation is not a unit quaternion",
    )
}
fn camera(key: &pc::ShotKey, label: &str) -> Result {
    finite_fields!(label; key.pos, key.target, [key.fov]);
    require(
        key.fov > 0.0 && key.fov < 180.0,
        label,
        "invalid camera FOV",
    )?;
    let x = key.target[0] - key.pos[0];
    let z = key.target[2] - key.pos[2];
    require(
        x * x + z * z > 1e-12,
        label,
        "camera direction parallel to its Y up axis",
    )
}

pub fn validate(meta: &pc::Meta, geom_bytes: usize, tex_bytes: usize, anim: &[f32]) -> Result {
    require(
        meta.version == pc::VERSION,
        "metadata",
        "unsupported version",
    )?;
    require(
        geom_bytes <= i32::MAX as usize && tex_bytes <= u32::MAX as usize,
        "sections",
        "size exceeds format / GLES integer range",
    )?;
    let anim_bytes = anim
        .len()
        .checked_mul(4)
        .filter(|&n| n <= u32::MAX as usize)
        .ok_or("ANIM size overflow")?;
    if let Some(i) = anim.iter().position(|v| !v.is_finite()) {
        return Err(format!("ANIM[{i}]: non-finite value"));
    }
    require(
        meta.draws.len() <= 16384
            && meta.nodes.len() <= 4096
            && meta.textures.len() <= i32::MAX as usize,
        "scene",
        "table limits exceeded",
    )?;
    finite(&[meta.fps], "animation")?;
    require(
        meta.frames > 0 && meta.fps > 0.0 && (meta.frames as f32 / meta.fps).is_finite(),
        "animation",
        "invalid frame count or sample rate",
    )?;
    bounds(meta.min, meta.max, "scene bounds")?;

    for (i, t) in meta.textures.iter().enumerate() {
        let label = format!("texture[{i}]");
        finite_fields!(&label; t.mean, [t.lod_bias]);
        require(
            t.width > 0
                && t.height > 0
                && t.width <= i32::MAX as u32
                && t.height <= i32::MAX as u32,
            &label,
            "invalid GLES dimensions",
        )?;
        require(
            t.mips > 0 && t.mips <= 32 - t.width.max(t.height).leading_zeros(),
            &label,
            "invalid mip count",
        )?;
        let stride = match t.format {
            pc::TexFormat::Rgba8 => 4u32,
            pc::TexFormat::Rgba16f => 8,
            _ => return Err(format!("{label}: unsupported GLES texture format")),
        };
        if t.format == pc::TexFormat::Rgba16f {
            require(
                t.role == pc::TexRole::Environment,
                &label,
                "half-float upload encoding is only defined for environment radiance",
            )?;
        }
        if !t.width.is_power_of_two() || !t.height.is_power_of_two() {
            require(
                t.mips == 1 && t.wrap_s == pc::Wrap::Clamp && t.wrap_t == pc::Wrap::Clamp,
                &label,
                "NPOT texture needs one clamped level on GLES2",
            )?;
        }
        let (mut w, mut h, mut size) = (t.width, t.height, 0u32);
        for _ in 0..t.mips {
            size = w
                .checked_mul(h)
                .and_then(|n| n.checked_mul(stride))
                .and_then(|n| size.checked_add(n))
                .ok_or_else(|| format!("{label}: mip size overflow"))?;
            w = (w / 2).max(1);
            h = (h / 2).max(1);
        }
        require(t.data.size == size, &label, "mip chain byte size mismatch")?;
        span(&t.data, tex_bytes, 4, &label)?;
    }
    for (i, m) in meta.materials.iter().enumerate() {
        let label = format!("material[{i}]");
        finite_fields!(&label; m.color, m.emissive, [m.alpha_test,m.roughness,m.metalness,m.normal_scale,m.ao_strength,m.env_strength,m.drops,m.clearcoat]);
        if let Some(shade) = m.emission_shade {
            finite_fields!(&label; shade.normal, shade.height);
            require(
                shade.height[0] < shade.height[1],
                &label,
                "invalid emission shade height range",
            )?;
        }
        for index in [m.albedo, m.normal, m.orm, m.emission] {
            reference(index, meta.textures.len(), &label)?;
        }
        reference(m.emissive_track, meta.material_tracks.len(), &label)?;
        if let Some(v) = m.polygon_offset {
            finite(&v, &label)?;
        }
        if let Some(v) = m.tint {
            finite(&v, &label)?;
        }
        if let Some(w) = &m.wet {
            finite(
                &[w.puddles, w.darken, w.roughness, w.ripple, w.puddle_scale],
                &label,
            )?;
        }
        if let Some(d) = &m.damp {
            finite(&[d.darken, d.roughness, d.streaks], &label)?;
        }
        if let Some(w) = &m.water {
            finite_fields!(&label; w.waves[0],w.waves[1],w.body,[w.distance_roughness,w.mask]);
            if let Some(v) = w.shallow {
                finite(&v, &label)?;
            }
        }
        if let Some(l) = &m.lights {
            finite(
                &[l.min_pixels, l.max_pixels, l.gain, l.depth_pull, l.period],
                &label,
            )?;
            require(
                l.min_pixels >= 0.0 && l.max_pixels >= l.min_pixels && l.period > 0.0,
                &label,
                "invalid light field size or period",
            )?;
        }
        require(
            m.kind != pc::Kind::Lights || m.lights.is_some(),
            &label,
            "light field parameters missing",
        )?;
        if let Some(a) = m.uv_anim {
            finite_fields!(&label; a.scroll,[a.fps,a.phase]);
            require(a.fps >= 0.0, &label, "negative flipbook frame rate")?;
            if a.frames > 1 {
                require(
                    a.cols > 0
                        && a.rows > 0
                        && a.cols.checked_mul(a.rows).map_or(false, |n| a.frames <= n),
                    &label,
                    "invalid flipbook grid",
                )?;
            }
        }
    }
    for (i, d) in meta.draws.iter().enumerate() {
        let label = format!("draw[{i}]");
        reference(Some(d.material), meta.materials.len(), &label)?;
        reference(d.node, meta.nodes.len(), &label)?;
        reference(d.skin, meta.skins.len(), &label)?;
        finite_fields!(&label; d.pos_offset,d.pos_scale,d.uv_offset,d.uv_scale);
        bounds(d.min, d.max, &label)?;
        require(
            d.vertex_count > 0 && d.vertex_count <= 65536,
            &label,
            "invalid u16 vertex count",
        )?;
        exact_span(
            &d.vertices,
            d.vertex_count,
            d.layout.stride(),
            geom_bytes,
            4,
            &label,
        )?;
        if d.layout == pc::VertexLayout::Lights {
            span(&d.indices, geom_bytes, 2, &label)?;
        } else {
            exact_span(&d.indices, d.index_count, 2, geom_bytes, 2, &label)?;
        }
        require(
            (d.layout == pc::VertexLayout::Skinned) == d.skin.is_some(),
            &label,
            "skin/layout mismatch",
        )?;
        require(
            d.skin.is_none() || d.node.is_none(),
            &label,
            "skinned draw also has a rigid transform",
        )?;
        let points = d.layout == pc::VertexLayout::Lights;
        require(
            points == (meta.materials[d.material as usize].kind == pc::Kind::Lights),
            &label,
            "light material/layout mismatch",
        )?;
        if points {
            require(
                d.vertex_count as usize <= pc::LightPoint::PER_DRAW
                    && d.index_count == d.vertex_count
                    && d.indices.size == 0
                    && d.lods.is_empty()
                    && d.node.is_none(),
                &label,
                "invalid light point draw",
            )?;
        } else {
            require(
                d.index_count > 0 && d.index_count % 3 == 0 && d.index_count <= i32::MAX as u32,
                &label,
                "invalid triangle index count",
            )?;
        }
        for lod in &d.lods {
            finite(&[lod.error], &label)?;
            require(
                lod.error >= 0.0 && lod.index_count % 3 == 0 && lod.index_count <= d.index_count,
                &label,
                "invalid LOD",
            )?;
            exact_span(&lod.indices, lod.index_count, 2, geom_bytes, 2, &label)?;
        }
    }
    for (i, n) in meta.nodes.iter().enumerate() {
        let label = format!("node[{i}]");
        reference(n.parent, i, &label)?; // Parent-before-child also excludes cycles.
        finite_fields!(&label; n.translation,n.scale);
        quaternion(&n.rotation, &label)?;
        if let Some(r) = &n.track {
            let data = exact_span(r, meta.frames, 7 * 4, anim_bytes, 4, &label)?;
            for key in anim[data.start / 4..data.end / 4].chunks_exact(7) {
                quaternion(&key[3..7], &label)?;
            }
        }
    }
    for (i, s) in meta.skins.iter().enumerate() {
        let label = format!("skin[{i}]");
        require(
            !s.joints.is_empty() && s.joints.len() <= 256,
            &label,
            "invalid u8 joint palette",
        )?;
        for (j, &node) in s.joints.iter().enumerate() {
            reference(Some(node), meta.nodes.len(), &label)?;
            require(!s.joints[..j].contains(&node), &label, "duplicate joint")?;
        }
        let data = exact_span(
            &s.inverse_bind,
            s.joints.len() as u32,
            64,
            anim_bytes,
            4,
            &label,
        )?;
        for matrix in anim[data.start / 4..data.end / 4].chunks_exact(16) {
            require(
                matrix[3].abs() < 1e-5
                    && matrix[7].abs() < 1e-5
                    && matrix[11].abs() < 1e-5
                    && (matrix[15] - 1.0).abs() < 1e-5,
                &label,
                "inverse bind is not affine",
            )?;
        }
    }
    for (i, t) in meta.material_tracks.iter().enumerate() {
        exact_span(
            &t.data,
            meta.frames,
            4,
            anim_bytes,
            4,
            &format!("material track[{i}]"),
        )?;
    }
    for (i, t) in meta.fog_tracks.iter().enumerate() {
        exact_span(
            &t.data,
            meta.frames,
            16,
            anim_bytes,
            4,
            &format!("fog track[{i}]"),
        )?;
    }
    for (i, l) in meta.lights.iter().enumerate() {
        let label = format!("light[{i}]");
        reference(l.node, meta.nodes.len(), &label)?;
        finite_fields!(&label; l.position,l.direction,l.color,l.size,l.right,[l.range,l.cos_inner,l.cos_outer]);
        require(l.range >= 0.0, &label, "negative light range")?;
        if l.kind == pc::LightKind::Spot {
            require(
                l.cos_outer >= -1.0 && l.cos_inner <= 1.0 && l.cos_outer <= l.cos_inner,
                &label,
                "invalid spot cone",
            )?;
        }
    }
    for (i, l) in meta.fog_lights.iter().enumerate() {
        let label = format!("fog light[{i}]");
        reference(l.track, meta.fog_tracks.len(), &label)?;
        finite_fields!(&label; l.position,l.color,[l.intensity,l.radius]);
        if let Some((direction, inner, outer)) = l.spot {
            finite_fields!(&label; direction,[inner,outer]);
        }
    }
    require(!meta.camera.shots.is_empty(), "camera", "no shots")?;
    camera(&meta.camera.intro, "camera intro")?;
    for (i, s) in meta.camera.shots.iter().enumerate() {
        let label = format!("shot[{i}]");
        camera(&s.from, &label)?;
        camera(&s.to, &label)?;
        finite(&[s.duration], &label)?;
        require(s.duration > 0.0, &label, "non-positive duration")?;
        // A valid endpoint pair can still pass through a vertical/zero look
        // direction mid-shot, where look_at's fixed Y-up basis degenerates.
        let a = [
            s.from.target[0] - s.from.pos[0],
            s.from.target[2] - s.from.pos[2],
        ];
        let b = [
            s.to.target[0] - s.to.pos[0] - a[0],
            s.to.target[2] - s.to.pos[2] - a[1],
        ];
        let bb = b[0] * b[0] + b[1] * b[1];
        let t = if bb > 0.0 {
            (-(a[0] * b[0] + a[1] * b[1]) / bb).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let d = [a[0] + b[0] * t, a[1] + b[1] * t];
        require(
            d[0] * d[0] + d[1] * d[1] > 1e-12,
            &label,
            "camera crosses its Y up axis",
        )?;
    }
    for b in &meta.camera.walkable {
        bounds([b[0], b[1], b[2]], [b[3], b[4], b[5]], "walkable")?;
    }
    if let Some(d) = &meta.doors {
        reference(Some(d.left), meta.nodes.len(), "doors")?;
        reference(Some(d.right), meta.nodes.len(), "doors")?;
        finite_fields!("doors"; d.trigger,[d.travel,d.radius]);
        require(
            d.left != d.right && d.radius > 0.0 && d.travel >= 0.0,
            "doors",
            "invalid door pair / dimensions",
        )?;
    }
    for v in &meta.beacons {
        finite(v, "beacon")?;
    }
    let a = &meta.atmosphere;
    finite_fields!("atmosphere"; a.fog_color,a.haze_ambient,a.hemisphere_sky,a.hemisphere_ground,a.sky_zenith,a.sky_horizon,a.sky_glow,[a.fog_density,a.haze_density,a.haze_ambient_density,a.environment_strength]);
    bounds(a.dry_min, a.dry_max, "dry box")?;
    reference(a.environment, meta.textures.len(), "environment")?;
    if let Some(i) = a.environment {
        require(
            meta.textures[i as usize].role == pc::TexRole::Environment,
            "environment",
            "texture role mismatch",
        )?;
    }
    for b in &meta.rain.dry_boxes {
        bounds(b[0], b[1], "rain dry box")?;
    }
    for pair in meta.rain.drip_edges.iter().chain(&meta.rain.steam_vents) {
        finite_fields!("rain effects"; pair[0],pair[1]);
    }
    let e = &meta.effects;
    for i in [e.puddles, e.ripples, e.beads, e.clouds] {
        reference(i, meta.textures.len(), "effects")?;
    }
    finite(&[e.ripple_tile, e.cloud_cells], "effects")?;
    if e.ripples.is_some() {
        require(
            e.ripple_grid > 0
                && e.ripple_grid.checked_mul(e.ripple_grid).is_some()
                && e.ripple_tile > 0.0,
            "effects",
            "invalid ripple grid / tile",
        )?;
    }
    if let Some(s) = &meta.sun {
        finite_fields!("sun"; s.direction,s.radiance);
        if let Some(h) = &s.shadow {
            finite_fields!("sun shadow"; h.position,h.ortho,[h.bias,h.normal_bias,h.radius]);
            require(
                h.map_size > 0
                    && h.ortho[0] < h.ortho[1]
                    && h.ortho[2] < h.ortho[3]
                    && h.ortho[4] < h.ortho[5],
                "sun shadow",
                "invalid projection",
            )?;
        }
    }
    if let Some(d) = &meta.day_sky {
        reference(d.clouds, meta.textures.len(), "day sky")?;
        finite_fields!("day sky"; d.zenith,d.horizon,d.ground,d.sun_direction,d.sun_color,d.glow_wide,d.glow_tight,d.cloud_sun,d.cloud_ambient,[d.gradient_power,d.ground_blend,d.glow,d.disc,d.disc_cos_inner,d.disc_cos_outer,d.fade_elevation,d.drift]);
        if let Some(t) = &d.twilight {
            finite_fields!("twilight"; t.band.color,t.belt.color,[t.band.height,t.band.sun_bias,t.band.sun_power,t.belt.elevation,t.belt.width,t.belt.power,t.shadow.strength,t.shadow.height,t.shadow.power]);
        }
    }
    if let Some(h) = &meta.vista_haze {
        finite_fields!("vista haze"; h.glow,[h.density,h.inversion,h.scale,h.gain,h.band]);
    }
    let p = &meta.post;
    finite_fields!("post"; p.lift,p.gain,[p.exposure,p.contrast,p.saturation,p.vignette,p.grain,p.bloom_threshold,p.bloom_smoothing,p.bloom_intensity]);
    Ok(())
}

/// Optional pixel validation on each staging buffer, before texture upload.
/// RGBA8 permits every bit pattern; half-float radiance must remain finite.
pub fn validate_texture(texture: &pc::Texture, data: &[u8]) -> Result {
    require(
        data.len() == texture.data.size as usize,
        "texture payload",
        "byte size mismatch",
    )?;
    if texture.format == pc::TexFormat::Rgba16f {
        require(
            data.len() % 8 == 0,
            "texture payload",
            "incomplete half-float texel",
        )?;
        require(
            data.chunks_exact(2)
                .all(|b| u16::from_le_bytes([b[0], b[1]]) & 0x7c00 != 0x7c00),
            "texture payload",
            "non-finite half-float value",
        )?;
    }
    Ok(())
}

/// Run on the geometry staging bytes before uploading them. Metadata range
/// checks are repeated here so this helper is safe to call independently.
pub fn validate_geometry(meta: &pc::Meta, geometry: &[u8]) -> Result {
    for (i, d) in meta.draws.iter().enumerate() {
        let label = format!("draw[{i}] geometry");
        let vertices = exact_span(
            &d.vertices,
            d.vertex_count,
            d.layout.stride(),
            geometry.len(),
            4,
            &label,
        )?;
        let count = if d.layout == pc::VertexLayout::Lights {
            0
        } else {
            d.index_count
        };
        for (r, count) in core::iter::once((&d.indices, count))
            .chain(d.lods.iter().map(|l| (&l.indices, l.index_count)))
        {
            let range = exact_span(r, count, 2, geometry.len(), 2, &label)?;
            for bytes in geometry[range].chunks_exact(2) {
                require(
                    (u16::from_le_bytes([bytes[0], bytes[1]]) as u32) < d.vertex_count,
                    &label,
                    "index exceeds vertex count",
                )?;
            }
        }
        if d.layout == pc::VertexLayout::Skinned {
            let skin = d
                .skin
                .and_then(|s| meta.skins.get(s as usize))
                .ok_or_else(|| format!("{label}: missing skin"))?;
            for vertex in geometry[vertices].chunks_exact(d.layout.stride() as usize) {
                require(
                    vertex[24..28]
                        .iter()
                        .all(|&j| (j as usize) < skin.joints.len()),
                    &label,
                    "joint index exceeds palette",
                )?;
                require(
                    vertex[28..32].iter().any(|&w| w != 0),
                    &label,
                    "zero skin weights",
                )?;
            }
        } else if d.layout == pc::VertexLayout::Lights {
            for vertex in geometry[vertices].chunks_exact(pc::LightPoint::STRIDE) {
                for value in vertex[12..36].chunks_exact(4) {
                    finite(&[f32::from_le_bytes(value.try_into().unwrap())], &label)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    extern crate std;
    use alloc::{vec, vec::Vec};

    pub(crate) fn fixture() -> (pc::Meta, Vec<u8>, Vec<f32>) {
        let json = br#"{
            "version":6,"name":"validator fixture","kind":"night-street",
            "min":[0,0,0],"max":[1,1,1],
            "textures":[{"name":"rgba","role":"color","format":"rgba8","width":4,"height":4,"mips":1,
                "data":{"offset":0,"size":64},"wrap_s":"repeat","wrap_t":"clamp","has_alpha":false,"mean":[1,1,1,1]}],
            "materials":[{"name":"surface","kind":"standard","blend":"opaque","double_sided":false,
                "depth_write":true,"alpha_test":0,"color":[1,1,1,1],"emissive":[0,0,0],
                "roughness":0.5,"metalness":0,"normal_scale":1,"ao_strength":1,"env_strength":1,
                "albedo":0,"normal":null,"orm":null,"emission":null,"vertex_color":false,"interior":false,
                "fog":true,"wet":null,"damp":null,"drops":0,"clearcoat":0,"polygon_offset":null,"emissive_track":null}],
            "draws":[{"material":0,"layout":"static","vertices":{"offset":0,"size":72},"vertex_count":3,
                "indices":{"offset":72,"size":6},"index_count":3,"pos_offset":[0,0,0],"pos_scale":[1,1,1],
                "uv_offset":[0,0],"uv_scale":[1,1],"min":[0,0,0],"max":[1,1,1],"node":0,"skin":null,
                "no_reflect":false,"cast_shadow":true}],
            "nodes":[{"name":"rigid","parent":null,"translation":[0,0,0],"rotation":[0,0,0,1],"scale":[1,1,1],"track":{"offset":0,"size":56}}],
            "skins":[],"lights":[],"fog_lights":[],"fog_tracks":[],"material_tracks":[],"fps":30,"frames":2,
            "atmosphere":{"fog_color":[0,0,0],"fog_density":0,"haze_density":0,"haze_ambient":[0,0,0],"haze_ambient_density":0,
                "dry_min":[0,0,0],"dry_max":[0,0,0],"hemisphere_sky":[0,0,0],"hemisphere_ground":[0,0,0],
                "sky_zenith":[0,0,0],"sky_horizon":[0,0,0],"sky_glow":[0,0,0],"environment":null,"environment_strength":1},
            "rain":{"active":false,"dry_boxes":[],"drip_edges":[],"steam_vents":[]},
            "camera":{"shots":[{"name":"fixed","from":{"pos":[0,1,2],"target":[0,1,0],"fov":40},
                "to":{"pos":[0,1,2],"target":[0,1,0],"fov":40},"duration":1}],"walkable":[],
                "intro":{"pos":[0,1,2],"target":[0,1,0],"fov":40}},"doors":null,"beacons":[],"stats":{}
        }"#;
        let pack = pc::write(&[(pc::TAG_META, json, 16)]);
        let meta = pc::Pack::parse(&pack).unwrap().meta().unwrap();
        let mut geom = vec![0; 72];
        geom.extend([0, 0, 1, 0, 2, 0]);
        let anim = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0].repeat(2);
        (meta, geom, anim)
    }
    fn bad(mut change: impl FnMut(&mut pc::Meta)) {
        let (mut m, g, a) = fixture();
        change(&mut m);
        assert!(validate(&m, g.len(), 64, &a).is_err());
    }
    #[test]
    fn container_checks_actual_lengths_alignment_aliases_and_required_tags() {
        let bytes = pc::write(&[
            (pc::TAG_META, b"{}", 16),
            (pc::TAG_TEXTURES, &[], 16),
            (pc::TAG_GEOMETRY, &[1, 2, 3, 4], 16),
            (pc::TAG_ANIMATION, &[], 16),
        ]);
        let size = place_header_size(&bytes[..16], bytes.len()).unwrap();
        validate_container(&bytes[..size], bytes.len()).unwrap();
        assert!(validate_container(&bytes[..size], bytes.len() - 1).is_err());
        let invalid = |offset: usize, value: u32| {
            let mut table = bytes[..size].to_vec();
            table[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(validate_container(&table, bytes.len()).is_err());
        };
        invalid(8, u32::MAX); // Bound the count before allocating a Vec.
        invalid(12, 1); // Reserved flag cannot change the format silently.
        invalid(16 + 4, 0); // META points inside the container header.
        invalid(16 + 12, 0); // Zero alignment must not cause modulo-by-zero.
        invalid(16 + 12, 3);
        invalid(16 + 4, bytes.len() as u32 + 16);
        invalid(16 + 4, 0xfffffff0); // end overflows u32 below
        let mut overflow = bytes[..size].to_vec();
        overflow[20..24].copy_from_slice(&0xfffffff0u32.to_le_bytes());
        overflow[24..28].copy_from_slice(&32u32.to_le_bytes());
        assert!(validate_container(&overflow, u32::MAX as usize).is_err());
        let mut duplicate = bytes[..size].to_vec();
        duplicate[32..36].copy_from_slice(&pc::TAG_META);
        assert!(validate_container(&duplicate, bytes.len()).is_err());
        let mut missing = bytes[..size].to_vec();
        missing[32..36].copy_from_slice(b"XTRA");
        assert!(validate_container(&missing, bytes.len()).is_err());
        let mut overlap = bytes[..size].to_vec();
        overlap[52..56].copy_from_slice(&bytes[20..24]);
        assert!(validate_container(&overlap, bytes.len()).is_err());
        for len in 0..16 {
            assert!(place_header_size(&bytes[..len], bytes.len()).is_err());
        }
    }
    #[test]
    fn absolute_payload_ranges_cannot_wrap_or_escape_their_section() {
        let section = pc::Section {
            tag: pc::TAG_TEXTURES,
            offset: 128,
            size: 64,
            align: 16,
        };
        assert_eq!(
            section_span(
                &section,
                &pc::Range {
                    offset: 8,
                    size: 16
                },
                192
            )
            .unwrap(),
            136..152
        );
        assert!(section_span(
            &section,
            &pc::Range {
                offset: 48,
                size: 32
            },
            256
        )
        .is_err());
        assert!(section_span(
            &section,
            &pc::Range {
                offset: u32::MAX,
                size: 8
            },
            256
        )
        .is_err());
        assert!(section_span(
            &section,
            &pc::Range {
                offset: 0,
                size: 64
            },
            191
        )
        .is_err());
        let section = pc::Section {
            offset: u32::MAX - 3,
            size: 16,
            ..section
        };
        assert!(section_span(&section, &pc::Range { offset: 4, size: 4 }, usize::MAX).is_err());
        assert!(section_span(&section, &pc::Range { offset: 0, size: 8 }, usize::MAX).is_err());
    }

    #[test]
    fn accepts_static_and_rigid_payload() {
        let (m, g, a) = fixture();
        validate(&m, g.len(), 64, &a).unwrap();
        validate_geometry(&m, &g).unwrap();
    }
    #[test]
    fn rejects_reference_cycles_ranges_and_truncated_tracks() {
        bad(|m| m.draws[0].material = 1);
        bad(|m| m.materials[0].normal = Some(1));
        bad(|m| m.draws[0].node = Some(1));
        bad(|m| m.nodes[0].parent = Some(0));
        bad(|m| m.draws[0].vertices.offset = 2);
        bad(|m| m.draws[0].indices.offset = 74);
        bad(|m| m.draws[0].indices.offset = u32::MAX - 1);
        bad(|m| m.draws[0].vertices.size = 71);
        bad(|m| m.nodes[0].track.as_mut().unwrap().size = 28);
        bad(|m| m.nodes[0].track.as_mut().unwrap().offset = 4);
        bad(|m| m.frames = 0);
        bad(|m| m.frames = u32::MAX);
        bad(|m| m.fps = 0.0);
        bad(|m| m.materials[0].emissive_track = Some(0));
        bad(|m| {
            m.materials[0].uv_anim = Some(pc::UvAnim {
                cols: u32::MAX,
                rows: u32::MAX,
                frames: 2,
                ..Default::default()
            })
        });
    }
    #[test]
    fn rejects_non_finite_and_degenerate_camera_values() {
        bad(|m| m.materials[0].roughness = f32::NAN);
        bad(|m| m.post.bloom_intensity = f32::INFINITY);
        bad(|m| m.camera.shots[0].duration = 0.0);
        bad(|m| m.camera.intro.fov = 180.0);
        bad(|m| m.camera.intro.target = m.camera.intro.pos);
        bad(|m| m.camera.shots[0].to.target = [0.0, 1.0, 4.0]);
        bad(|m| m.nodes[0].rotation = [0.0; 4]);
        let (m, g, mut a) = fixture();
        a[0] = f32::NAN;
        assert!(validate(&m, g.len(), 64, &a).is_err());
        a[0] = 0.0;
        a[6] = 0.0;
        assert!(validate(&m, g.len(), 64, &a).is_err());
    }
    #[test]
    fn checks_gles_texture_layout_and_npot_restrictions() {
        bad(|m| m.textures[0].format = pc::TexFormat::Bc1);
        bad(|m| m.textures[0].mips = 0);
        bad(|m| m.textures[0].mips = 33);
        bad(|m| m.textures[0].width = 0);
        bad(|m| m.textures[0].data.size = 60);
        bad(|m| m.textures[0].data.offset = 4);
        let (mut m, g, a) = fixture();
        m.textures[0].width = 3;
        m.textures[0].data.size = 48;
        assert!(validate(&m, g.len(), 48, &a).is_err());
        m.textures[0].wrap_s = pc::Wrap::Clamp;
        validate(&m, g.len(), 48, &a).unwrap();
    }
    #[test]
    fn half_float_pixel_payload_rejects_infinity_and_nan() {
        let (mut m, _, _) = fixture();
        let t = &mut m.textures[0];
        t.format = pc::TexFormat::Rgba16f;
        t.role = pc::TexRole::Environment;
        t.data.size = 128;
        let mut pixels = [0x00, 0x3c].repeat(64);
        validate_texture(t, &pixels).unwrap();
        pixels[1] = 0x7c;
        assert!(validate_texture(t, &pixels).is_err());
        pixels[1] = 0x7e;
        assert!(validate_texture(t, &pixels).is_err());
        assert!(validate_texture(t, &pixels[..127]).is_err());
    }
    #[test]
    fn validates_index_and_joint_payload_before_gpu_upload() {
        let (mut m, mut g, mut a) = fixture();
        g[76] = 3;
        assert!(validate_geometry(&m, &g).is_err());
        g[76] = 2;
        m.draws[0].skin = Some(0);
        m.draws[0].node = None;
        m.draws[0].layout = pc::VertexLayout::Skinned;
        m.draws[0].vertices.size = 96;
        m.draws[0].indices.offset = 96;
        m.skins.push(pc::Skin {
            joints: vec![0],
            inverse_bind: pc::Range {
                offset: 56,
                size: 64,
            },
        });
        a.extend([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ]);
        g = vec![0; 96];
        g.extend([0, 0, 1, 0, 2, 0]);
        for i in 0..3 {
            g[i * 32 + 28] = 255;
        }
        validate(&m, g.len(), 64, &a).unwrap();
        validate_geometry(&m, &g).unwrap();
        g[24] = 1;
        assert!(validate_geometry(&m, &g).is_err());
        g[24] = 0;
        g[28] = 0;
        assert!(validate_geometry(&m, &g).is_err());
        m.skins[0].joints.clear();
        assert!(validate(&m, g.len(), 64, &a).is_err());
    }
    #[test]
    fn empty_lods_and_nonindexed_light_fields_keep_the_common_contract() {
        let (mut m, g, a) = fixture();
        m.draws[0].lods.push(pc::DrawLod {
            indices: pc::Range {
                offset: g.len() as u32,
                size: 0,
            },
            index_count: 0,
            error: 0.25,
        });
        validate(&m, g.len(), 64, &a).unwrap();
        validate_geometry(&m, &g).unwrap();
        m.materials[0].kind = pc::Kind::Lights;
        m.materials[0].lights = Some(pc::LightField {
            min_pixels: 1.0,
            max_pixels: 8.0,
            period: 2.0,
            ..Default::default()
        });
        let d = &mut m.draws[0];
        d.layout = pc::VertexLayout::Lights;
        d.vertices = pc::Range {
            offset: 0,
            size: pc::LightPoint::STRIDE as u32,
        };
        d.vertex_count = 1;
        d.indices = pc::Range::default();
        d.index_count = 1; // For a point draw the count is vertex count.
        d.node = None;
        d.lods.clear();
        let mut g = vec![0; pc::LightPoint::STRIDE];
        validate(&m, g.len(), 64, &a).unwrap();
        validate_geometry(&m, &g).unwrap();
        g[12..16].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(validate_geometry(&m, &g).is_err());
    }
    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to an existing GLES pack directory"]
    fn validates_cooked_packs() {
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").expect("pack directory");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) != Some("place") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let pack = pc::Pack::parse(&bytes).unwrap();
            let m = pack.meta().unwrap();
            let g = pack.section(pc::TAG_GEOMETRY).unwrap();
            let tex = pack.section(pc::TAG_TEXTURES).unwrap();
            let raw = pack.section(pc::TAG_ANIMATION).unwrap();
            assert_eq!(raw.len() % 4, 0);
            let a: Vec<f32> = raw
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            validate(&m, g.len(), tex.len(), &a)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            for texture in &m.textures {
                let offset = texture.data.offset as usize;
                validate_texture(texture, &tex[offset..offset + texture.data.size as usize])
                    .unwrap_or_else(|e| panic!("{} {}: {e}", path.display(), texture.name));
            }
            validate_geometry(&m, g).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            std::println!("validated {}", path.display());
            count += 1;
        }
        assert!(count > 0);
    }
}
