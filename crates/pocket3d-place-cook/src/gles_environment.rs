//! Immutable display-environment lowering; runtime only uploads IPEN faces.
use pocket3d_place as pc;
type Result<T> = std::result::Result<T, String>;

pub fn bake(meta: &pc::Meta, pixels: &[u8]) -> Result<(Vec<u8>, Vec<pc::ipod::DisplayCube>)> {
    let mut groups: Vec<(f32, Vec<u32>)> = Vec::new();
    for (i, material) in meta.materials.iter().enumerate() {
        if !matches!(material.kind, pc::Kind::Water | pc::Kind::Glass) {
            continue;
        }
        let strength = material.env_strength * meta.atmosphere.environment_strength;
        if !strength.is_finite() || strength < 0.0 {
            return Err("invalid display cube strength".into());
        }
        if let Some((_, materials)) = groups
            .iter_mut()
            .find(|(s, _)| s.to_bits() == strength.to_bits())
        {
            materials.push(i as u32);
        } else {
            groups.push((strength, vec![i as u32]));
        }
    }
    let mut out = Vec::new();
    let mut recipes = Vec::new();
    let Some(source_texture) = meta.atmosphere.environment else {
        return Ok((out, recipes));
    };
    if groups.is_empty() {
        return Ok((out, recipes));
    }
    let texture = meta
        .textures
        .get(source_texture as usize)
        .ok_or("display cube source reference")?;
    if texture.role != pc::TexRole::Environment {
        return Err("display cube source role".into());
    }
    let source = pc::parts::slice(pixels, &texture.data)?;
    let source_hash = pc::ipod::display_environment::source_hash(texture, source)?;
    let post_hash = pc::ipod::display_environment::post_hash(&meta.post)?;
    for (strength, materials) in groups {
        let faces = pc::ipod::display_environment::bake(texture, source, strength, &meta.post)?;
        let range = super::append(&mut out, &faces, 16)?;
        recipes.push(pc::ipod::DisplayCube {
            version: 1,
            source_texture,
            source_hash: source_hash.clone(),
            post_hash: post_hash.clone(),
            strength,
            materials,
            face_size: pc::ipod::display_environment::FACE_SIZE,
            range,
            payload_hash: format!("{:016x}", pc::content_hash::hash(&faces)),
        });
    }
    Ok((out, recipes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cubes_group_exact_strengths_keep_original_inputs_and_bind_every_dependency() {
        let texture = pc::Texture {
            name: "environment".into(),
            role: pc::TexRole::Environment,
            format: pc::TexFormat::Rgba8,
            width: 2,
            height: 2,
            mips: 2,
            data: pc::Range {
                offset: 0,
                size: 20,
            },
            wrap_s: pc::Wrap::Clamp,
            wrap_t: pc::Wrap::Clamp,
            has_alpha: false,
            mean: [0.0; 4],
            lod_bias: 0.0,
        };
        let (mut meta, _, _) = super::super::gles_geometry::tests::fixture();
        meta.textures = vec![texture];
        meta.materials.truncate(1);
        meta.atmosphere.environment = Some(0);
        meta.atmosphere.environment_strength = 0.5;
        meta.materials[0].kind = pc::Kind::Glass;
        meta.materials[0].env_strength = 0.72;
        meta.materials.push(meta.materials[0].clone());
        meta.materials[1].kind = pc::Kind::Water;
        meta.materials.push(meta.materials[0].clone());
        meta.materials[2].env_strength = 1.0;
        let source = [40, 90, 140, 255].repeat(5);
        let original = serde_json::to_vec(&meta).unwrap();
        let (payload, recipes) = bake(&meta, &source).unwrap();
        assert_eq!(serde_json::to_vec(&meta).unwrap(), original);
        assert_eq!(recipes.len(), 2);
        assert_eq!(recipes[0].materials, [0, 1]);
        assert_eq!(recipes[1].materials, [2]);
        assert_eq!(recipes[0].strength.to_bits(), (0.72f32 * 0.5).to_bits());
        assert_eq!(payload.len(), pc::ipod::display_environment::CUBE_BYTES * 2);
        for r in &recipes {
            assert_eq!(
                r.source_hash,
                pc::ipod::display_environment::source_hash(&meta.textures[0], &source).unwrap()
            );
            assert_eq!(
                r.post_hash,
                pc::ipod::display_environment::post_hash(&meta.post).unwrap()
            );
            assert_eq!(
                r.payload_hash,
                format!(
                    "{:016x}",
                    pc::content_hash::hash(pc::parts::slice(&payload, &r.range).unwrap())
                )
            );
        }
        let mut changed = source.clone();
        changed[16] ^= 1;
        let (same, new) = bake(&meta, &changed).unwrap();
        assert_eq!(same, payload);
        assert_ne!(new[0].source_hash, recipes[0].source_hash);
        meta.post.exposure = 2.0;
        let (_, new) = bake(&meta, &source).unwrap();
        assert_ne!(new[0].post_hash, recipes[0].post_hash);
        assert_ne!(new[0].payload_hash, recipes[0].payload_hash);
        meta.atmosphere.environment = None;
        assert!(bake(&meta, &source).unwrap().1.is_empty());
    }
}
