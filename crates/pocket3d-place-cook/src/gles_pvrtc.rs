//! Optional, explicit PVRTexTool lowering. Original RGBA remains the reference;
//! only opaque color images that pass every mip's quality gate receive IPTX data.
use pocket3d_place as pc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
type Result<T> = std::result::Result<T, String>;
const RAW: u64 = u64::from_le_bytes(*b"rgba\x08\x08\x08\x08");
const RGB4: u64 = 2;
const PVR_VERSION: u32 = 0x0352_5650;

pub struct Encoder {
    path: PathBuf,
    work: PathBuf,
    tool: Tool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tool {
    path: String,
    sha256: String,
    version: String,
    quality: &'static str,
    format: &'static str,
    jobs: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    codec_version: u32,
    gate_version: u32,
    tool: Tool,
    textures: Vec<TextureReceipt>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextureReceipt {
    texture: u32,
    source_bytes: usize,
    compressed_bytes: usize,
    accepted: bool,
    reason: &'static str,
    quality_metrics: Option<pc::ipod::PvrtcQuality>,
}
pub struct Output {
    pub bytes: Vec<u8>,
    pub recipes: Vec<pc::ipod::PvrtcTexture>,
    pub receipt: Receipt,
}

impl Encoder {
    pub fn new(path: &Path, work: &Path) -> Result<Self> {
        let path = fs::canonicalize(path).map_err(|e| format!("PVRTexTool path: {e}"))?;
        let binary = fs::read(&path).map_err(|e| format!("PVRTexTool executable: {e}"))?;
        let help = Command::new(&path)
            .arg("-h")
            .output()
            .map_err(|e| format!("PVRTexTool version: {e}"))?;
        if !help.status.success() {
            return Err("PVRTexTool version command failed".into());
        }
        let help = String::from_utf8_lossy(&help.stdout);
        let version = help.lines().take(2).collect::<Vec<_>>().join("\n");
        if !version.starts_with("PVRTexToolCLI ") || !version.contains("PVRTexLib ") {
            return Err("PVRTexTool returned an unrecognized version".into());
        }
        fs::create_dir_all(work).map_err(|e| format!("PVRTC work directory: {e}"))?;
        let tool = Tool {
            path: path.display().to_string(),
            sha256: format!("{:x}", Sha256::digest(&binary)),
            version,
            quality: "PVRTCBEST",
            format: "PVRTCI_4BPP_RGB,UBN,lRGB",
            jobs: 2,
        };
        Ok(Self {
            path,
            work: work.into(),
            tool,
        })
    }

    pub fn bake(&self, meta: &pc::Meta, pixels: &[u8]) -> Result<Output> {
        let temp = Temp::new(&self.work)?;
        let mut out = Output {
            bytes: Vec::new(),
            recipes: Vec::new(),
            receipt: Receipt {
                codec_version: 1,
                gate_version: 1,
                tool: self.tool.clone(),
                textures: Vec::new(),
            },
        };
        for (i, texture) in meta.textures.iter().enumerate() {
            let raw = pc::parts::slice(pixels, &texture.data)?;
            let reason = eligibility(texture, raw)?;
            let mut row = TextureReceipt {
                texture: i as u32,
                source_bytes: raw.len(),
                compressed_bytes: 0,
                accepted: false,
                reason,
                quality_metrics: None,
            };
            if reason != "eligible" {
                out.receipt.textures.push(row);
                continue;
            }
            let input = temp.0.join(format!("{i}-source.pvr"));
            let encoded = temp.0.join(format!("{i}-encoded.pvr"));
            let decoded = temp.0.join(format!("{i}-decoded.pvr"));
            fs::write(&input, raw_pvr(texture, raw)).map_err(|e| e.to_string())?;
            // Never ask the tool to resize or create mips. lRGB on both input
            // and output preserves the numerical sRGB samples consumed by GLSL.
            self.run(&[
                "-i",
                input.to_str().ok_or("non-UTF8 work path")?,
                "-f",
                self.tool.format,
                "-q",
                self.tool.quality,
                "-j",
                "2",
                "-o",
                encoded.to_str().ok_or("non-UTF8 work path")?,
            ])?;
            self.run(&[
                "-i",
                encoded.to_str().ok_or("non-UTF8 work path")?,
                "-f",
                "r8g8b8a8,UBN,lRGB",
                "-o",
                decoded.to_str().ok_or("non-UTF8 work path")?,
            ])?;
            let encoded = fs::read(encoded).map_err(|e| format!("PVRTC output: {e}"))?;
            let decoded = fs::read(decoded).map_err(|e| format!("PVRTC decoded output: {e}"))?;
            let payload = pvr_payload(&encoded, texture, RGB4)?;
            let decoded = pvr_payload(&decoded, texture, RAW)?;
            let metrics = quality(texture, raw, decoded)?;
            row.compressed_bytes = payload.len();
            row.accepted = metrics.passes_v1();
            row.reason = if row.accepted {
                "accepted"
            } else {
                "quality gate"
            };
            row.quality_metrics = Some(metrics.clone());
            if row.accepted {
                let range = super::append(&mut out.bytes, payload, 16)?;
                out.recipes.push(pc::ipod::PvrtcTexture {
                    texture: i as u32,
                    range,
                    width: texture.width,
                    height: texture.height,
                    mips: texture.mips,
                    codec_version: 1,
                    gate_version: 1,
                    quality_metrics: metrics,
                    payload_hash: format!("{:016x}", pc::content_hash::hash(payload)),
                    source_hash: format!("{:016x}", pc::content_hash::hash(raw)),
                });
            }
            println!(
                "PVRTC texture {i}: {} ({:.2} dB)",
                row.reason,
                row.quality_metrics.as_ref().unwrap().psnr
            );
            out.receipt.textures.push(row);
        }
        Ok(out)
    }
    fn run(&self, args: &[&str]) -> Result<()> {
        let out = Command::new(&self.path)
            .args(args)
            .output()
            .map_err(|e| format!("PVRTexTool: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "PVRTexTool {}: {} {}",
                out.status,
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }
}

fn shape(t: &pc::Texture) -> Result<()> {
    if t.width == 0
        || t.height == 0
        || t.mips == 0
        || t.mips > 32 - t.width.max(t.height).leading_zeros()
    {
        return Err("PVRTC source mip shape is invalid".into());
    }
    Ok(())
}
fn bytes(t: &pc::Texture, format: u64) -> Result<usize> {
    shape(t)?;
    let (mut w, mut h, mut size) = (t.width, t.height, 0usize);
    for _ in 0..t.mips {
        let n = if format == RGB4 {
            pc::ipod::pvrtc_level_bytes(w, h)
        } else {
            (w as usize)
                .checked_mul(h as usize)
                .and_then(|n| n.checked_mul(4))
        }
        .ok_or("PVRTC mip size overflow")?;
        size = size.checked_add(n).ok_or("PVRTC chain size overflow")?;
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    Ok(size)
}
fn eligibility(t: &pc::Texture, raw: &[u8]) -> Result<&'static str> {
    if t.format != pc::TexFormat::Rgba8 || t.role != pc::TexRole::Color {
        return Ok("not RGBA8 color");
    }
    if raw.len() != bytes(t, RAW)? {
        return Err("PVRTC original RGBA mip payload mismatch".into());
    }
    if t.width != t.height || !t.width.is_power_of_two() || t.width < 8 {
        return Ok("not square power-of-two >= 8");
    }
    if raw.chunks_exact(4).any(|p| p[3] != 255) {
        return Ok("nonopaque source mip texel");
    }
    Ok("eligible")
}
fn raw_pvr(t: &pc::Texture, raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(52 + raw.len());
    out.extend(PVR_VERSION.to_le_bytes());
    out.extend(0u32.to_le_bytes());
    out.extend(RAW.to_le_bytes());
    for v in [0, 0, t.height, t.width, 1, 1, 1, t.mips, 0] {
        out.extend(v.to_le_bytes());
    }
    out.extend(raw);
    out
}
fn pvr_payload<'a>(data: &'a [u8], t: &pc::Texture, format: u64) -> Result<&'a [u8]> {
    if data.len() < 52 {
        return Err("truncated PVR header".into());
    }
    let u32_at = |at| u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
    let pixel_format = u64::from_le_bytes(data[8..16].try_into().unwrap());
    if u32_at(0) != PVR_VERSION
        || u32_at(4) != 0
        || pixel_format != format
        || u32_at(16) != 0
        || u32_at(20) != 0
        || u32_at(24) != t.height
        || u32_at(28) != t.width
        || u32_at(32) != 1
        || u32_at(36) != 1
        || u32_at(40) != 1
        || u32_at(44) != t.mips
    {
        return Err("PVR encoder changed format, shape or mip chain".into());
    }
    let start = 52usize
        .checked_add(u32_at(48) as usize)
        .ok_or("PVR metadata overflow")?;
    let payload = data.get(start..).ok_or("truncated PVR metadata")?;
    if payload.len() != bytes(t, format)? {
        return Err("PVR encoded payload size mismatch".into());
    }
    Ok(payload)
}
fn quality(t: &pc::Texture, original: &[u8], decoded: &[u8]) -> Result<pc::ipod::PvrtcQuality> {
    if original.len() != bytes(t, RAW)? || decoded.len() != original.len() {
        return Err("quality mip payload mismatch".into());
    }
    let psnr = |sum: f64, n: usize| {
        if sum == 0.0 {
            99.0
        } else {
            10.0 * (255.0 * 255.0 * n as f64 / sum).log10()
        }
    };
    let (mut at, mut w, mut h, mut total, mut count) =
        (0, t.width as usize, t.height as usize, 0.0f64, 0);
    let (mut min_psnr, mut max_channel, mut max_block) = (99.0f64, 0u32, 0.0f64);
    for _ in 0..t.mips {
        let mut level = 0.0;
        for by in (0..h).step_by(8) {
            for bx in (0..w).step_by(8) {
                let mut block = 0.0;
                let mut n = 0;
                for y in by..(by + 8).min(h) {
                    for x in bx..(bx + 8).min(w) {
                        for c in 0..3 {
                            let i = at + (y * w + x) * 4 + c;
                            let error = (original[i] as i32 - decoded[i] as i32).unsigned_abs();
                            max_channel = max_channel.max(error);
                            block += (error * error) as f64;
                            n += 1;
                        }
                    }
                }
                max_block = max_block.max((block / n as f64).sqrt());
                level += block;
            }
        }
        min_psnr = min_psnr.min(psnr(level, w * h * 3));
        total += level;
        count += w * h * 3;
        at += w * h * 4;
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    Ok(pc::ipod::PvrtcQuality {
        psnr: psnr(total, count) as f32,
        min_mip_psnr: min_psnr as f32,
        max_channel_error: max_channel,
        max_block_rmse: max_block as f32,
    })
}

struct Temp(PathBuf);
impl Temp {
    fn new(parent: &Path) -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = parent.join(format!(
            ".ipod-pvrtc-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).map_err(|e| format!("PVRTC temporary directory: {e}"))?;
        Ok(Self(path))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn texture() -> pc::Texture {
        serde_json::from_value(
            serde_json::json!({"name":"test","width":16,"height":16,"mips":5,
            "format":"rgba8","role":"color","data":{"offset":0,"size":1364},
            "wrap_s":"repeat","wrap_t":"repeat","has_alpha":false}),
        )
        .unwrap()
    }
    #[test]
    fn all_mips_prove_opacity_and_semantics() {
        let mut t = texture();
        let mut p = [100, 120, 140, 255].repeat(bytes(&t, RAW).unwrap() / 4);
        assert_eq!(eligibility(&t, &p).unwrap(), "eligible");
        *p.last_mut().unwrap() = 254;
        assert_eq!(eligibility(&t, &p).unwrap(), "nonopaque source mip texel");
        p.pop();
        assert!(eligibility(&t, &p).is_err());
        t.role = pc::TexRole::Data;
        assert_eq!(eligibility(&t, &p).unwrap(), "not RGBA8 color");
    }
    #[test]
    fn strict_pvr_shape_size_format_and_partial_mips() {
        let mut t = texture();
        t.mips = 3;
        let data = vec![255; bytes(&t, RAW).unwrap()];
        let good = raw_pvr(&t, &data);
        assert_eq!(pvr_payload(&good, &t, RAW).unwrap(), data);
        for (at, value) in [
            (0, 0),
            (4, 1),
            (16, 1),
            (20, 1),
            (24, 8),
            (28, 8),
            (32, 2),
            (36, 2),
            (40, 6),
            (44, 2),
            (48, u32::MAX),
        ] {
            let mut bad = good.clone();
            bad[at..at + 4].copy_from_slice(&value.to_le_bytes());
            assert!(pvr_payload(&bad, &t, RAW).is_err(), "{at}");
        }
        assert!(pvr_payload(&good[..good.len() - 1], &t, RAW).is_err());
        assert!(pvr_payload(&good, &t, RGB4).is_err());
        let mut extra = good;
        extra.push(0);
        assert!(pvr_payload(&extra, &t, RAW).is_err());
        assert_eq!(bytes(&texture(), RGB4).unwrap(), 256);
    }
    #[test]
    fn gate_catches_tiny_mip_and_local_error_hidden_by_average() {
        let mut t = texture();
        t.width = 128;
        t.height = 128;
        t.mips = 8;
        let original = vec![128; bytes(&t, RAW).unwrap()];
        let mut decoded = original.clone();
        assert!(quality(&t, &original, &decoded).unwrap().passes_v1());
        let at = decoded.len() - 4;
        decoded[at] = 160;
        decoded[at + 1] = 160;
        decoded[at + 2] = 160;
        let q = quality(&t, &original, &decoded).unwrap();
        assert!(q.psnr > 38.0);
        assert!(q.min_mip_psnr < 36.0);
        assert!(!q.passes_v1());
        decoded.clone_from(&original);
        for y in 0..8 {
            for x in 0..8 {
                for c in 0..3 {
                    decoded[(y * 128 + x) * 4 + c] = 140;
                }
            }
        }
        let q = quality(&t, &original, &decoded).unwrap();
        assert!(q.psnr > 38.0);
        assert_eq!(q.max_block_rmse, 12.0);
        assert!(!q.passes_v1());
        decoded.clone_from(&original);
        decoded[0] = 161;
        let q = quality(&t, &original, &decoded).unwrap();
        assert!(q.psnr > 38.0);
        assert_eq!(q.max_channel_error, 33);
        assert!(!q.passes_v1());
    }
    #[test]
    fn absent_or_non_encoder_executable_is_an_error() {
        assert!(Encoder::new(Path::new("/path/that/does/not/exist"), Path::new(".")).is_err());
        #[cfg(unix)]
        assert!(Encoder::new(Path::new("/usr/bin/true"), Path::new(".")).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn encoder_failure_and_missing_output_clean_temporary_resources() {
        use std::os::unix::fs::PermissionsExt;
        let parent = Path::new("../../.pocket-build/validation/ipod-pvrtc-tests");
        fs::create_dir_all(parent).unwrap();
        let temp = Temp::new(parent).unwrap();
        let path = temp.0.join("fake-tool");
        let t = texture();
        let meta: pc::Meta = serde_json::from_value(super::super::tests::fixture(&t)).unwrap();
        let data = [80, 120, 180, 255].repeat(bytes(&t, RAW).unwrap() / 4);
        for exit in [17, 0] {
            fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = -h ]; then\n  printf 'PVRTexToolCLI test\\nPVRTexLib test\\n'\n  exit 0\nfi\nexit {exit}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            let encoder = Encoder::new(&path, &temp.0).unwrap();
            assert!(encoder.bake(&meta, &data).is_err());
            assert_eq!(
                fs::read_dir(&temp.0).unwrap().count(),
                1,
                "scratch directory must be released on every error"
            );
        }
    }
}
