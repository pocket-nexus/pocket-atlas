//! SGX upload storage, after original payload validation and identity hashing.
//! Keep data/normal/HDR textures and every alpha texel exact. Opaque display
//! colour may use 5/6/5 channels without reducing its spatial resolution.
use alloc::{string::String, vec::Vec};
use pocket3d_place::{self as pc, TexFormat, TexRole, Texture};

pub fn pack_opaque_color(texture: &Texture, pixels: &mut Vec<u8>) -> bool {
    if texture.format != TexFormat::Rgba8
        || texture.role != TexRole::Color
        || pixels.is_empty()
        || pixels.len() % 4 != 0
        || pixels.chunks_exact(4).any(|p| p[3] != 255)
    {
        return false;
    }
    let count = pixels.len() / 4;
    // Read each texel before overwriting its earlier two-byte destination.
    // Nearest channel quantization bounds R/B error at 255/62 display bytes
    // and G error at 255/126; alpha remains exactly one.
    for i in 0..count {
        let r = (u16::from(pixels[i * 4]) * 31 + 127) / 255;
        let g = (u16::from(pixels[i * 4 + 1]) * 63 + 127) / 255;
        let b = (u16::from(pixels[i * 4 + 2]) * 31 + 127) / 255;
        pixels[i * 2..i * 2 + 2].copy_from_slice(&((r << 11) | (g << 5) | b).to_le_bytes());
    }
    pixels.truncate(count * 2);
    true
}

/// Recipes describe target storage, never shared material semantics. Reject
/// malformed references before creating GL names, even in Reference mode.
pub fn validate_recipes(meta: &pc::Meta, recipes: &pc::ipod::Recipes) -> Result<(), String> {
    if let Some(index) = recipes.steam_coverage {
        let t = meta
            .textures
            .get(index as usize)
            .ok_or("steam coverage texture reference")?;
        if !meta.rain.active
            || meta.rain.steam_vents.is_empty()
            || t.format != pc::TexFormat::Rgba8
            || t.role != pc::TexRole::Data
            || (t.width, t.height, t.mips) != (256, 256, 9)
            || t.wrap_s != pc::Wrap::Clamp
            || t.wrap_t != pc::Wrap::Clamp
            || t.lod_bias != 0.0
            || meta.effects.puddles.is_none()
            || meta.effects.puddles == Some(index)
        {
            return Err("steam coverage recipe texture contract".into());
        }
    }
    for (i, recipe) in recipes.pvrtc.iter().enumerate() {
        let t = meta
            .textures
            .get(recipe.texture as usize)
            .ok_or("PVRTC source texture reference")?;
        if t.format != TexFormat::Rgba8
            || t.role != TexRole::Color
            || (t.width, t.height, t.mips) != (recipe.width, recipe.height, recipe.mips)
            || t.width != t.height
            || t.width < 8
            || !t.width.is_power_of_two()
            || recipe.codec_version != 1
            || recipe.gate_version != 1
            || !recipe.quality_metrics.passes_v1()
            || recipe.range.offset % 16 != 0
            || [&recipe.source_hash, &recipe.payload_hash]
                .iter()
                .any(|hash| {
                    hash.len() != 16
                        || hash
                            .bytes()
                            .any(|c| !c.is_ascii_digit() && !(b'a'..=b'f').contains(&c))
                })
            || recipes.pvrtc[..i]
                .iter()
                .any(|p| p.texture == recipe.texture)
        {
            return Err("PVRTC recipe storage contract".into());
        }
        let (mut w, mut h, mut bytes) = (t.width, t.height, 0usize);
        for _ in 0..t.mips {
            bytes = bytes
                .checked_add(pc::ipod::pvrtc_level_bytes(w, h).ok_or("PVRTC mip overflow")?)
                .ok_or("PVRTC mip overflow")?;
            w = (w / 2).max(1);
            h = (h / 2).max(1);
        }
        if bytes != recipe.range.size as usize {
            return Err("PVRTC recipe mip length".into());
        }
    }
    Ok(())
}

pub fn validate_pvrtc_ranges(recipes: &pc::ipod::Recipes, size: Option<u32>) -> Result<(), String> {
    for (i, recipe) in recipes.pvrtc.iter().enumerate() {
        let end = recipe
            .range
            .offset
            .checked_add(recipe.range.size)
            .ok_or("PVRTC range overflow")?;
        if size.is_none_or(|size| end > size)
            || recipes.pvrtc[..i].iter().any(|p| {
                // Earlier ranges were already checked for overflow.
                recipe.range.offset < p.range.offset + p.range.size && p.range.offset < end
            })
        {
            return Err("PVRTC payload range or overlap".into());
        }
    }
    Ok(())
}

pub fn validate_pvrtc_payload(
    recipe: &pc::ipod::PvrtcTexture,
    source: &[u8],
    payload: &[u8],
) -> Result<(), String> {
    if source.len() % 4 != 0 || source.chunks_exact(4).any(|p| p[3] != 255) {
        return Err("PVRTC RGB source must be opaque in every mip".into());
    }
    if alloc::format!("{:016x}", pc::content_hash::hash(source)) != recipe.source_hash {
        return Err("PVRTC source identity".into());
    }
    if payload.len() != recipe.range.size as usize
        || alloc::format!("{:016x}", pc::content_hash::hash(payload)) != recipe.payload_hash
    {
        return Err("PVRTC payload identity".into());
    }
    Ok(())
}

/// Old packs have no cube recipes and keep the shared startup fallback. Once
/// present, recipes must cover every environment-consuming material exactly
/// once; a partial table must never mix a stale bake with a runtime fallback.
pub fn validate_display_cubes(meta: &pc::Meta, recipes: &pc::ipod::Recipes) -> Result<(), String> {
    use pc::ipod::display_environment::{post_hash, CUBE_BYTES, FACE_SIZE};
    if recipes.display_cubes.is_empty() {
        return Ok(());
    }
    let environment = meta
        .atmosphere
        .environment
        .ok_or("display cube source environment missing")?;
    let source = meta
        .textures
        .get(environment as usize)
        .ok_or("display cube source texture reference")?;
    if source.role != TexRole::Environment
        || !matches!(source.format, TexFormat::Rgba8 | TexFormat::Rgba16f)
    {
        return Err("display cube source texture format or role".into());
    }
    let grade_hash = post_hash(&meta.post)?;
    let mut covered = alloc::vec![false; meta.materials.len()];
    for recipe in &recipes.display_cubes {
        if recipe.version != 1
            || recipe.source_texture != environment
            || recipe.face_size != FACE_SIZE
            || recipe.range.size as usize != CUBE_BYTES
            || recipe.range.offset % 16 != 0
            || recipe.materials.is_empty()
            || !recipe.strength.is_finite()
            || recipe.strength < 0.0
            || recipe.post_hash != grade_hash
            || [&recipe.source_hash, &recipe.payload_hash]
                .iter()
                .any(|hash| {
                    hash.len() != 16
                        || hash
                            .bytes()
                            .any(|c| !c.is_ascii_digit() && !(b'a'..=b'f').contains(&c))
                })
        {
            return Err("display cube recipe contract".into());
        }
        for &index in &recipe.materials {
            let material = meta
                .materials
                .get(index as usize)
                .ok_or("display cube material reference")?;
            let strength = material.env_strength * meta.atmosphere.environment_strength;
            if !matches!(material.kind, pc::Kind::Water | pc::Kind::Glass)
                || covered[index as usize]
                || strength.to_bits() != recipe.strength.to_bits()
            {
                return Err("display cube material ownership or strength".into());
            }
            covered[index as usize] = true;
        }
    }
    if meta
        .materials
        .iter()
        .enumerate()
        .any(|(i, m)| matches!(m.kind, pc::Kind::Water | pc::Kind::Glass) != covered[i])
    {
        return Err("display cube material coverage is incomplete".into());
    }
    Ok(())
}

pub fn validate_display_cube_ranges(
    recipes: &pc::ipod::Recipes,
    size: Option<u32>,
) -> Result<(), String> {
    if recipes.display_cubes.is_empty() && size.is_some_and(|size| size != 0) {
        return Err("display cube payload has no recipes".into());
    }
    for (i, recipe) in recipes.display_cubes.iter().enumerate() {
        let end = recipe
            .range
            .offset
            .checked_add(recipe.range.size)
            .ok_or("display cube range overflow")?;
        if size.is_none_or(|size| end > size)
            || recipes.display_cubes[..i].iter().any(|p| {
                recipe.range.offset < p.range.offset + p.range.size && p.range.offset < end
            })
        {
            return Err("display cube payload range or overlap".into());
        }
    }
    Ok(())
}

/// `source_hash` uses the shared compiler helper before upload conversion. It
/// binds format/dimensions/mip count/role and every original ENV mip, including
/// roughness levels not sampled by this bake.
pub fn validate_display_cube_payload(
    recipe: &pc::ipod::DisplayCube,
    source_hash: &str,
    payload: &[u8],
) -> Result<(), String> {
    if recipe.source_hash != source_hash {
        return Err("display cube source identity".into());
    }
    if payload.len() != recipe.range.size as usize
        || alloc::format!("{:016x}", pc::content_hash::hash(payload)) != recipe.payload_hash
    {
        return Err("display cube payload identity".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn cube_fixture() -> (pc::Meta, pc::ipod::Recipes, Vec<u8>, Vec<u8>) {
        use pc::ipod::display_environment::{bake, post_hash, CUBE_BYTES, FACE_SIZE};
        let (mut meta, _, _) = crate::validation::tests::fixture();
        let original = meta.materials[0].clone();
        meta.materials[0].kind = pc::Kind::Water;
        meta.materials[0].env_strength = 0.72;
        let mut glass = meta.materials[0].clone();
        glass.kind = pc::Kind::Glass;
        let mut other_water = meta.materials[0].clone();
        other_water.env_strength = 1.0;
        meta.materials.extend([glass, other_water, original]);
        let mut environment = meta.textures[0].clone();
        environment.role = TexRole::Environment;
        environment.format = TexFormat::Rgba16f;
        environment.mips = 3;
        environment.data = pc::Range {
            offset: 64,
            size: 168,
        };
        meta.textures.push(environment);
        meta.atmosphere.environment = Some(1);
        meta.atmosphere.environment_strength = 0.5;
        let mut source = alloc::vec![255; 64];
        for _ in 0..21 {
            for half in [0x3800u16, 0x3a00, 0x3c00, 0x3c00] {
                source.extend(half.to_le_bytes());
            }
        }
        let mut recipes = pc::ipod::Recipes::default();
        let mut payload = Vec::new();
        for materials in [alloc::vec![0, 1], alloc::vec![2]] {
            let strength = meta.materials[materials[0] as usize].env_strength
                * meta.atmosphere.environment_strength;
            let pixels = bake(&meta.textures[1], &source[64..], strength, &meta.post).unwrap();
            recipes.display_cubes.push(pc::ipod::DisplayCube {
                version: 1,
                source_texture: 1,
                source_hash: pc::ipod::display_environment::source_hash(
                    &meta.textures[1],
                    &source[64..],
                )
                .unwrap(),
                post_hash: post_hash(&meta.post).unwrap(),
                strength,
                materials,
                face_size: FACE_SIZE,
                range: pc::Range {
                    offset: payload.len() as u32,
                    size: CUBE_BYTES as u32,
                },
                payload_hash: alloc::format!("{:016x}", pc::content_hash::hash(&pixels)),
            });
            payload.extend(pixels);
        }
        (meta, recipes, source, payload)
    }

    #[test]
    fn cube_recipe_binds_complete_materials_source_grade_strength_and_fixed_abi() {
        let (meta, recipes, source, payload) = cube_fixture();
        validate_display_cubes(&meta, &recipes).unwrap();
        validate_display_cube_ranges(&recipes, Some(payload.len() as u32)).unwrap();
        for r in &recipes.display_cubes {
            validate_display_cube_payload(
                r,
                &pc::ipod::display_environment::source_hash(&meta.textures[1], &source[64..])
                    .unwrap(),
                &payload[r.range.offset as usize..(r.range.offset + r.range.size) as usize],
            )
            .unwrap();
        }
        for fault in 0..23 {
            let mut m = meta.clone();
            let mut r = recipes.clone();
            match fault {
                0 => r.display_cubes[0].version = 2,
                1 => r.display_cubes[0].face_size = 32,
                2 => r.display_cubes[0].range.size -= 1,
                3 => r.display_cubes[0].range.offset = 1,
                4 => r.display_cubes[0].source_texture = 0,
                5 => m.atmosphere.environment = None,
                6 => m.atmosphere.environment = Some(99),
                7 => m.textures[1].role = TexRole::Data,
                8 => m.textures[1].format = TexFormat::Bc1,
                9 => r.display_cubes[0].post_hash = "0000000000000000".into(),
                10 => m.post.exposure += 0.01,
                11 => {
                    r.display_cubes[0].strength =
                        f32::from_bits(r.display_cubes[0].strength.to_bits() + 1)
                }
                12 => r.display_cubes[0].strength = f32::NAN,
                13 => r.display_cubes[0].strength = -1.0,
                14 => r.display_cubes[0].materials.clear(),
                15 => r.display_cubes[0].materials.push(99),
                16 => r.display_cubes[0].materials.push(3),
                17 => r.display_cubes[0].materials.push(0),
                18 => r.display_cubes[1].materials = alloc::vec![0],
                19 => r.display_cubes[0].materials.pop().map(|_| ()).unwrap(),
                20 => r.display_cubes[0].source_hash = "FFFFFFFFFFFFFFFF".into(),
                21 => r.display_cubes[0].payload_hash = "x".into(),
                _ => m.atmosphere.environment_strength = f32::INFINITY,
            }
            assert!(
                validate_display_cubes(&m, &r).is_err(),
                "cube recipe fault {fault}"
            );
        }
        // Recipe-free PLIP remains valid, with the shared startup fallback.
        validate_display_cubes(&meta, &pc::ipod::Recipes::default()).unwrap();
        let mut rgba = meta.clone();
        rgba.textures[1].format = TexFormat::Rgba8;
        validate_display_cubes(&rgba, &recipes).unwrap();
    }

    #[test]
    fn cube_ranges_and_all_mip_identity_reject_stale_or_truncated_payloads() {
        let (meta, recipes, source, payload) = cube_fixture();
        assert!(validate_display_cube_ranges(&recipes, None).is_err());
        assert!(validate_display_cube_ranges(&recipes, Some(payload.len() as u32 - 1)).is_err());
        for offset in [
            0,
            16,
            recipes.display_cubes[0].range.size - 16,
            u32::MAX - 15,
        ] {
            let mut bad = recipes.clone();
            bad.display_cubes[1].range.offset = offset;
            assert!(
                validate_display_cube_ranges(&bad, Some(u32::MAX)).is_err(),
                "offset {offset}"
            );
        }
        assert!(validate_display_cube_ranges(&pc::ipod::Recipes::default(), Some(16)).is_err());
        validate_display_cube_ranges(&pc::ipod::Recipes::default(), None).unwrap();
        let r = &recipes.display_cubes[0];
        let mut pixels = payload[..r.range.size as usize].to_vec();
        pixels[17] ^= 1;
        assert!(validate_display_cube_payload(r, &r.source_hash, &pixels)
            .unwrap_err()
            .contains("payload identity"));
        assert!(
            validate_display_cube_payload(r, &r.source_hash, &pixels[..pixels.len() - 1]).is_err()
        );
        let mut last_mip = source[64..].to_vec();
        last_mip[160] ^= 1;
        let changed =
            pc::ipod::display_environment::source_hash(&meta.textures[1], &last_mip).unwrap();
        assert!(
            validate_display_cube_payload(r, &changed, &payload[..r.range.size as usize])
                .unwrap_err()
                .contains("source identity")
        );
    }

    pub(crate) fn pvrtc_fixture() -> (pc::Meta, pc::ipod::Recipes, Vec<u8>, Vec<u8>) {
        let (mut meta, _, _) = crate::validation::tests::fixture();
        let t = &mut meta.textures[0];
        t.width = 8;
        t.height = 8;
        t.mips = 4;
        t.data = pc::Range {
            offset: 0,
            size: 340,
        };
        // Four real constant-color PVRTC1 RGB mip images. Each tiny mip owns
        // the minimum 2x2 blocks. Both opaque endpoints carry the same color,
        // so zero modulation reconstructs white/red/green/black exactly.
        let mut source = Vec::new();
        let mut payload = Vec::new();
        for (size, rgba, endpoints) in [
            (8, [255, 255, 255, 255], 0xffff_fffeu32),
            (4, [255, 0, 0, 255], 0xfc00_fc00),
            (2, [0, 255, 0, 255], 0x83e0_83e0),
            (1, [0, 0, 0, 255], 0x8000_8000),
        ] {
            for _ in 0..size * size {
                source.extend_from_slice(&rgba);
            }
            for _ in 0..4 {
                payload.extend_from_slice(&0u32.to_le_bytes());
                payload.extend_from_slice(&endpoints.to_le_bytes());
            }
        }
        let mut recipes = pc::ipod::Recipes::default();
        recipes.pvrtc.push(pc::ipod::PvrtcTexture {
            texture: 0,
            range: pc::Range {
                offset: 0,
                size: 128,
            },
            width: 8,
            height: 8,
            mips: 4,
            codec_version: 1,
            gate_version: 1,
            quality_metrics: pc::ipod::PvrtcQuality {
                psnr: 100.0,
                min_mip_psnr: 100.0,
                max_channel_error: 0,
                max_block_rmse: 0.0,
            },
            payload_hash: alloc::format!("{:016x}", pc::content_hash::hash(&payload)),
            source_hash: alloc::format!("{:016x}", pc::content_hash::hash(&source)),
        });
        (meta, recipes, source, payload)
    }

    #[test]
    fn pvrtc_recipes_validate_versions_quality_dimensions_and_ranges() {
        let (meta, recipes, source, payload) = pvrtc_fixture();
        assert_eq!((source.len(), payload.len()), (340, 128));
        validate_recipes(&meta, &recipes).unwrap();
        validate_pvrtc_ranges(&recipes, Some(128)).unwrap();
        validate_pvrtc_payload(&recipes.pvrtc[0], &source, &payload).unwrap();
        for fault in 0..20 {
            let mut m = meta.clone();
            let mut r = recipes.clone();
            match fault {
                0 => r.pvrtc[0].texture = 1,
                1 => m.textures[0].role = TexRole::Data,
                2 => m.textures[0].format = TexFormat::Rgba16f,
                3 => r.pvrtc[0].width = 4,
                4 => {
                    m.textures[0].width = 12;
                    r.pvrtc[0].width = 12;
                }
                5 => r.pvrtc[0].mips = 3,
                6 => r.pvrtc[0].codec_version = 2,
                7 => r.pvrtc[0].gate_version = 2,
                8 => r.pvrtc[0].quality_metrics.psnr = 37.99,
                9 => r.pvrtc[0].quality_metrics.min_mip_psnr = 35.99,
                10 => r.pvrtc[0].quality_metrics.max_channel_error = 33,
                11 => r.pvrtc[0].quality_metrics.max_block_rmse = 8.01,
                12 => r.pvrtc[0].quality_metrics.psnr = f32::INFINITY,
                13 => r.pvrtc[0].quality_metrics.min_mip_psnr = f32::NAN,
                14 => r.pvrtc[0].quality_metrics.max_block_rmse = -0.1,
                15 => r.pvrtc[0].range.offset = 1,
                16 => r.pvrtc[0].range.size = 127,
                17 => r.pvrtc[0].payload_hash = "NOT-A-HASH".into(),
                18 => r.pvrtc[0].source_hash = "FFFFFFFFFFFFFFFF".into(),
                _ => r.pvrtc.push(r.pvrtc[0].clone()),
            }
            assert!(validate_recipes(&m, &r).is_err(), "recipe fault {fault}");
        }
        assert!(validate_pvrtc_ranges(&recipes, None).is_err());
        assert!(validate_pvrtc_ranges(&recipes, Some(127)).is_err());
        let mut two = recipes.clone();
        two.pvrtc.push(two.pvrtc[0].clone());
        two.pvrtc[1].texture = 1;
        for offset in [0, 16, 112, u32::MAX - 15] {
            two.pvrtc[1].range.offset = offset;
            assert!(
                validate_pvrtc_ranges(&two, Some(u32::MAX)).is_err(),
                "range {offset}"
            );
        }
        two.pvrtc[1].range.offset = 128;
        validate_pvrtc_ranges(&two, Some(256)).unwrap();
        let mut changed = payload.clone();
        changed[127] ^= 1;
        assert!(validate_pvrtc_payload(&recipes.pvrtc[0], &source, &changed).is_err());
        assert!(validate_pvrtc_payload(&recipes.pvrtc[0], &source, &payload[..127]).is_err());
        let mut changed_source = source.clone();
        changed_source[336] = 1;
        assert!(validate_pvrtc_payload(&recipes.pvrtc[0], &changed_source, &payload).is_err());
        let mut alpha = source.clone();
        alpha[339] = 254;
        assert!(validate_pvrtc_payload(&recipes.pvrtc[0], &alpha, &payload)
            .unwrap_err()
            .contains("every mip"));
    }
    #[test]
    fn steam_recipe_requires_its_target_texture_and_source_effect() {
        let (mut meta, _, _) = crate::validation::tests::fixture();
        meta.rain.active = true;
        meta.rain.steam_vents = alloc::vec![[[0.0; 3]; 2]];
        meta.effects.puddles = Some(0);
        let mut coverage = meta.textures[0].clone();
        coverage.role = TexRole::Data;
        coverage.width = 256;
        coverage.height = 256;
        coverage.mips = 9;
        coverage.wrap_s = pc::Wrap::Clamp;
        coverage.wrap_t = pc::Wrap::Clamp;
        coverage.lod_bias = 0.0;
        meta.textures.push(coverage);
        let mut recipe = pc::ipod::Recipes::default();
        recipe.steam_coverage = Some(1);
        assert!(validate_recipes(&meta, &recipe).is_ok());
        for fault in 0..8 {
            let mut bad = meta.clone();
            let mut r = recipe.clone();
            match fault {
                0 => r.steam_coverage = Some(2),
                1 => bad.rain.steam_vents.clear(),
                2 => bad.effects.puddles = None,
                3 => bad.effects.puddles = Some(1),
                4 => bad.textures[1].role = TexRole::Color,
                5 => bad.textures[1].mips = 8,
                6 => bad.textures[1].wrap_s = pc::Wrap::Repeat,
                _ => bad.textures[1].lod_bias = f32::NAN,
            }
            assert!(validate_recipes(&bad, &r).is_err(), "fault {fault}");
        }
        // Old PLIP v1 packs retain the original procedural Steam path.
        assert!(validate_recipes(&meta, &pc::ipod::Recipes::default()).is_ok());
    }
    #[test]
    fn all_byte_values_fit_the_channel_error_bound_without_reallocating() {
        let (meta, _, _) = crate::validation::tests::fixture();
        let mut bytes: Vec<_> = (0..=255).flat_map(|v| [v, v, v, 255]).collect();
        let pointer = bytes.as_ptr();
        assert!(pack_opaque_color(&meta.textures[0], &mut bytes));
        assert_eq!(pointer, bytes.as_ptr());
        assert_eq!(bytes.len(), 512);
        for (v, b) in bytes.chunks_exact(2).enumerate() {
            let p = u16::from_le_bytes(b.try_into().unwrap());
            for (value, range) in [((p >> 11) & 31, 31), ((p >> 5) & 63, 63), (p & 31, 31)] {
                assert!(
                    (value as f32 * 255.0 / range as f32 - v as f32).abs()
                        <= 255.0 / range as f32 / 2.0
                );
            }
        }
    }
    #[test]
    fn every_mip_alpha_and_semantic_role_controls_eligibility() {
        let (meta, _, _) = crate::validation::tests::fixture();
        for mode in 0..4 {
            let mut texture = meta.textures[0].clone();
            let mut bytes = alloc::vec![255; 20];
            match mode {
                0 => bytes[19] = 254,
                1 => texture.role = TexRole::Data,
                2 => texture.role = TexRole::Normal,
                _ => texture.format = TexFormat::Rgba16f,
            }
            let original = bytes.clone();
            assert!(!pack_opaque_color(&texture, &mut bytes));
            assert_eq!(bytes, original);
        }
    }
}
