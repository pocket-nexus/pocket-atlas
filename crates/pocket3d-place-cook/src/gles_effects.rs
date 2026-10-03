//! SGX effect response textures, baked from the same target's source-derived
//! RGBA pixels. Shared particle motion/lifetime/lighting remain runtime work.
use pocket3d_place as pc;

const COVERAGE_SIZE: u32 = 256;
type Result<T> = std::result::Result<T, String>;

struct Noise<'a> {
    texture: &'a pc::Texture,
    levels: Vec<(&'a [u8], u32, u32)>,
}
impl<'a> Noise<'a> {
    fn new(texture: &'a pc::Texture, blob: &'a [u8]) -> Result<Self> {
        if texture.format != pc::TexFormat::Rgba8 || texture.width == 0 || texture.height == 0 || texture.mips == 0 {
            return Err("steam coverage requires source-derived RGBA8 puddles".into());
        }
        let bytes = pc::parts::slice(blob, &texture.data)?;
        let mut levels = Vec::new();
        let (mut width, mut height, mut offset) = (texture.width, texture.height, 0usize);
        for _ in 0..texture.mips {
            let size = (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4)).ok_or("steam source mip overflow")?;
            let end = offset.checked_add(size).ok_or("steam source mip overflow")?;
            levels.push((bytes.get(offset..end).ok_or("steam source mip truncated")?, width, height));
            offset = end;
            width = (width / 2).max(1); height = (height / 2).max(1);
        }
        if offset != bytes.len() { return Err("steam source mip length".into()); }
        Ok(Self { texture, levels })
    }
    fn sample(&self, uv: [f32; 2], lod: f32, channel: usize) -> f32 {
        let lod = lod.clamp(0.0, (self.levels.len() - 1) as f32);
        let level = lod as usize;
        let sample = |level: usize| {
            let (bytes, w, h) = self.levels[level];
            let p = [uv[0] * w as f32 - 0.5, uv[1] * h as f32 - 0.5];
            let lo = [p[0].floor() as i32, p[1].floor() as i32];
            let f = [p[0] - lo[0] as f32, p[1] - lo[1] as f32];
            let pixel = |x: i32, y: i32| {
                let wrap = |v: i32, size: u32, mode| match mode {
                    pc::Wrap::Repeat => v.rem_euclid(size as i32),
                    pc::Wrap::Clamp => v.clamp(0, size as i32 - 1),
                    pc::Wrap::Mirror => { let p = v.rem_euclid(size as i32 * 2); p.min(size as i32 * 2 - 1 - p) },
                } as usize;
                let x = wrap(x, w, self.texture.wrap_s); let y = wrap(y, h, self.texture.wrap_t);
                bytes[(y * w as usize + x) * 4 + channel] as f32 / 255.0
            };
            let a = pixel(lo[0], lo[1]) * (1.0 - f[0]) + pixel(lo[0] + 1, lo[1]) * f[0];
            let b = pixel(lo[0], lo[1] + 1) * (1.0 - f[0]) + pixel(lo[0] + 1, lo[1] + 1) * f[0];
            a * (1.0 - f[1]) + b * f[1]
        };
        let a = sample(level);
        a + (sample((level + 1).min(self.levels.len() - 1)) - a) * (lod - level as f32)
    }
    fn coverage(&self, uv: [f32; 2], size: f32) -> f32 {
        // The coverage atlas spans [-1,1]. Each source read has its own UV
        // scale and therefore its own implicit mip level. Re-evaluate the
        // nonlinear shape at each mip instead of averaging sharp coverage.
        let max_dim = self.texture.width.max(self.texture.height) as f32;
        let g = self.sample([uv[0] * 0.75 + 1.25, uv[1] * 0.75 + 1.25], (max_dim * 1.5 / size).log2(), 1);
        let r = self.sample([uv[0] * 1.75, uv[1] * 1.75], (max_dim * 3.5 / size).log2(), 0);
        let v = (1.0 - (uv[0].hypot(uv[1]) + (g * 0.6 + r * 0.4 - 0.5) * 0.6)).clamp(0.0, 1.0);
        let a = v * v * (3.0 - 2.0 * v);
        a * a
    }
}

fn pixels(noise: &Noise<'_>, size: u32) -> Vec<u8> {
    let mut out = Vec::new();
    let mut width = size;
    loop {
        for y in 0..width {
            for x in 0..width {
                let uv = [(x as f32 + 0.5) * (2.0 / width as f32) - 1.0, (y as f32 + 0.5) * (2.0 / width as f32) - 1.0];
                let value = (noise.coverage(uv, width as f32) * 255.0 + 0.5) as u8;
                out.extend_from_slice(&[value, value, value, 255]);
            }
        }
        if width == 1 { break; }
        width /= 2;
    }
    out
}

pub(super) fn bake(meta: &mut pc::Meta, blob: &mut Vec<u8>) -> Result<pc::ipod::Recipes> {
    if !meta.rain.active || meta.rain.steam_vents.is_empty() { return Ok(pc::ipod::Recipes::default()); }
    let index = meta.effects.puddles.ok_or("steam vents require a puddle noise source")?;
    let source = meta.textures.get(index as usize).ok_or("steam puddle source index")?;
    let noise = Noise::new(source, blob)?;
    let bytes = pixels(&noise, COVERAGE_SIZE);
    let steam_coverage = u32::try_from(meta.textures.len()).map_err(|_| "steam texture index overflow")?;
    let data = super::append(blob, &bytes, 16)?;
    meta.textures.push(pc::Texture {
        name: "ipod-steam-coverage".into(), role: pc::TexRole::Data, format: pc::TexFormat::Rgba8,
        width: COVERAGE_SIZE, height: COVERAGE_SIZE, mips: COVERAGE_SIZE.ilog2() + 1, data,
        wrap_s: pc::Wrap::Clamp, wrap_t: pc::Wrap::Clamp, has_alpha: false, mean: [0.0; 4], lod_bias: 0.0,
    });
    Ok(pc::ipod::Recipes { steam_coverage: Some(steam_coverage), ..Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn texture(size: u32, bytes: usize) -> pc::Texture {
        pc::Texture { name: "noise".into(), role: pc::TexRole::Data, format: pc::TexFormat::Rgba8,
            width: size, height: size, mips: 1, data: pc::Range { offset: 0, size: bytes as u32 },
            wrap_s: pc::Wrap::Repeat, wrap_t: pc::Wrap::Repeat, has_alpha: false, mean: [0.0; 4], lod_bias: 0.0 }
    }
    fn meta() -> pc::Meta {
        serde_json::from_value(super::super::tests::fixture(&texture(1, 4))).unwrap()
    }
    #[test]
    fn recipe_is_optional_and_bad_sources_fail_before_mutating_payload() {
        let mut meta = meta(); let mut bytes = vec![128; 4];
        assert!(bake(&mut meta, &mut bytes).unwrap().steam_coverage.is_none());
        meta.rain.steam_vents.push([[0.0; 3], [0.0, 1.0, 0.0]]);
        assert!(bake(&mut meta, &mut bytes).unwrap_err().contains("puddle noise source"));
        meta.effects.puddles = Some(0); meta.textures[0].data.size = 3;
        assert!(bake(&mut meta, &mut bytes).unwrap_err().contains("truncated"));
        meta.rain.active = false;
        assert!(bake(&mut meta, &mut bytes).unwrap().steam_coverage.is_none());
        assert_eq!(bytes, [128; 4]); assert_eq!(meta.textures.len(), 1);
    }
    #[test]
    fn compiler_recipe_keeps_the_original_source_and_publishes_complete_clamped_mips() {
        let mut meta = meta(); let mut bytes = vec![128; 4];
        meta.rain.steam_vents.push([[0.0; 3], [0.0, 1.0, 0.0]]);
        meta.effects.puddles = Some(0);
        let original = serde_json::to_vec(&meta.textures[0]).unwrap();
        let recipe = bake(&mut meta, &mut bytes).unwrap();
        assert_eq!(recipe.steam_coverage, Some(1));
        assert_eq!(&bytes[..4], [128; 4]);
        assert_eq!(serde_json::to_vec(&meta.textures[0]).unwrap(), original);
        let t = &meta.textures[1];
        assert_eq!((t.width, t.height, t.mips), (256, 256, 9));
        assert_eq!((t.role, t.format, t.wrap_s, t.wrap_t), (pc::TexRole::Data, pc::TexFormat::Rgba8, pc::Wrap::Clamp, pc::Wrap::Clamp));
        assert_eq!((t.data.offset, t.data.size), (16, 349524));
        assert_eq!(t.lod_bias, 0.0); assert!(!t.has_alpha);
        assert_eq!(Noise::new(t, &bytes).unwrap().levels.len(), 9);
        assert_eq!(meta.effects.puddles, Some(0));
    }
    #[test]
    fn source_sampling_wraps_filters_and_rejects_bad_payloads() {
        let bytes = [0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255];
        let t = texture(2, bytes.len()); let noise = Noise::new(&t, &bytes).unwrap();
        assert_eq!(noise.sample([0.25, 0.25], 0.0, 0), 0.0);
        assert_eq!(noise.sample([0.75, 0.25], 0.0, 0), 1.0);
        assert_eq!(noise.sample([-0.25, 1.25], 0.0, 0), 1.0);
        assert_eq!(noise.sample([0.5, 0.5], 0.0, 0), 0.5);
        assert!(Noise::new(&texture(2, 15), &bytes).is_err());
    }
    #[test]
    fn response_mips_preserve_radial_shape_and_bound_byte_quantization() {
        let bytes = [128; 4]; let t = texture(1, 4); let source = Noise::new(&t, &bytes).unwrap();
        let data = pixels(&source, 64);
        let mut t = texture(64, data.len()); t.mips = 7; t.wrap_s = pc::Wrap::Clamp; t.wrap_t = pc::Wrap::Clamp;
        let response = Noise::new(&t, &data).unwrap();
        for mip in 0..7 {
            let size = 64 >> mip;
            for y in 0..size { for x in 0..size {
                let uv = [(x as f32 + 0.5) / size as f32, (y as f32 + 0.5) / size as f32];
                let expected = source.coverage(uv.map(|v| v * 2.0 - 1.0), size as f32);
                assert!((response.sample(uv, mip as f32, 0) - expected).abs() <= 0.501 / 255.0);
            }}
        }
        assert!(response.sample([0.5, 0.5], 0.0, 0) > 0.99);
        assert!(response.sample([0.0, 0.0], 0.0, 0) < 0.001);
    }

    #[test]
    #[ignore = "set POCKET_ATLAS_VALIDATION_PACKS to source PLIP packs; offline appearance error"]
    fn measured_real_steam_response_error() {
        let dir = std::env::var("POCKET_ATLAS_VALIDATION_PACKS").unwrap();
        let mut measured = 0;
        for path in std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()) {
            if path.extension().and_then(|s| s.to_str()) != Some("place") { continue; }
            let bytes = std::fs::read(path).unwrap(); let pack = pc::ipod::parse(&bytes).unwrap(); let meta = pack.meta().unwrap();
            if meta.rain.steam_vents.is_empty() { continue; }
            let t = &meta.textures[meta.effects.puddles.unwrap() as usize];
            let noise = Noise::new(t, pack.section(pc::TAG_TEXTURES).unwrap()).unwrap();
            let data = pixels(&noise, COVERAGE_SIZE);
            let mut t = texture(COVERAGE_SIZE, data.len()); t.mips = COVERAGE_SIZE.ilog2() + 1; t.wrap_s = pc::Wrap::Clamp; t.wrap_t = pc::Wrap::Clamp;
            let response = Noise::new(&t, &data).unwrap();
            for width in [8.0f32, 16.0, 24.0, 32.0, 48.0, 64.0, 96.0, 128.0, 192.0, 256.0, 384.0, 512.0] {
                let mut maximum = 0.0f32; let mut squared = 0.0f64;
                for i in 0..65536u32 {
                    let x = i.wrapping_mul(2654435761); let y = i.wrapping_mul(2246822519).wrapping_add(1971);
                    let uv = [x as f32 / u32::MAX as f32, y as f32 / u32::MAX as f32]
                        .map(|v| half::f16::from_f32(v * 2.0 - 1.0).to_f32());
                    let coord = uv.map(|v| half::f16::from_f32(v * 0.5 + 0.5).to_f32());
                    let expected = noise.coverage(uv, width);
                    let actual = response.sample(coord, (COVERAGE_SIZE as f32 / width).log2(), 0);
                    let error = (actual - expected).abs(); maximum = maximum.max(error); squared += (error * error) as f64;
                }
                std::println!("{} steam width{}: max {:.4}/255 rms {:.4}/255; premult alpha max {:.4}/255", meta.name, width, maximum * 255.0, (squared / 65536.0).sqrt() * 255.0, maximum * 0.16 * 255.0);
                // This is an appearance approximation, not pixel identity.
                // The tiny 8 px sprite has the largest mip-transition error;
                // retain an explicit regression ceiling for this source pack.
                assert!(maximum * 0.16 * 255.0 < if width == 8.0 { 7.0 } else { 2.3 });
                assert!((squared / 65536.0).sqrt() * 255.0 < 6.0);
            }
            measured += 1;
        }
        assert!(measured > 0);
    }
}
