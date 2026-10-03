//! iPod SGX535 pack ABI. Independent from Vita's PLCE version and layouts.
//! Surface positions, normals, tangents and UVs are IEEE f32 source values.
use crate::{Draw, Error, Pack, Section, VertexLayout};
use alloc::{string::String, vec::Vec};
use serde::{Deserialize, Serialize};
pub mod display_environment;
pub mod display_indices;

/// Color sidecar v3 replacement for one complete source LOD. Both ranges are
/// byte ranges: `source` in GEOM, `indices` after the vertex prefix in the color
/// binary. Replacement u16 indices are local to the unchanged source draw;
/// the renderer adds its display page base. `state` disables culling only.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayIndexOverride {
    pub draw: u32,
    pub source: crate::Range,
    pub indices: crate::Range,
    pub state: u32,
}

/// SGX-specific compiler products. Shared scene semantics stay in `Meta`;
/// other backends neither produce nor interpret these texture recipes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Recipes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steam_coverage: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pvrtc: Vec<PvrtcTexture>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub display_cubes: Vec<DisplayCube>,
}

/// Display-referred environment recipe. Original ENV/TEXD remains the source
/// for Reference. All listed Water/Glass materials use this exact strength.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayCube {
    pub version: u32,
    pub source_texture: u32,
    pub source_hash: String,
    pub post_hash: String,
    pub strength: f32,
    pub materials: Vec<u32>,
    pub face_size: u32,
    pub range: crate::Range,
    pub payload_hash: String,
}
pub const TAG_DISPLAY_CUBES: [u8; 4] = *b"IPEN";

/// Optional performance-profile storage; the original RGBA texture and shared
/// Texture::format remain unchanged. Every entry is PVRTC1 RGB, four bits per
/// pixel. No PVRTC2, alpha, color-space conversion or generated mip is implied.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PvrtcTexture {
    pub texture: u32,
    pub range: crate::Range,
    pub width: u32,
    pub height: u32,
    pub mips: u32,
    pub codec_version: u32,
    pub gate_version: u32,
    pub quality_metrics: PvrtcQuality,
    /// FNV-1a64 hex of exactly this range, for accidental corruption detection.
    pub payload_hash: String,
    /// FNV-1a64 hex of the original ordered RGBA mip chain used by the gate.
    pub source_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PvrtcQuality {
    /// RGB-byte PSNR over every texel of the original complete mip chain.
    pub psnr: f32,
    pub min_mip_psnr: f32,
    pub max_channel_error: u32,
    /// Largest RGB-byte RMSE of any aligned 8x8 block, including partial blocks.
    pub max_block_rmse: f32,
}

impl PvrtcQuality {
    pub fn passes_v1(&self) -> bool {
        self.psnr.is_finite()
            && self.psnr >= 38.0
            && self.min_mip_psnr.is_finite()
            && self.min_mip_psnr >= 36.0
            && self.max_channel_error <= 32
            && self.max_block_rmse.is_finite()
            && (0.0..=8.0).contains(&self.max_block_rmse)
    }
}

pub const TAG_PVRTC: [u8; 4] = *b"IPTX";

/// Each mini-mip still occupies at least four 64-bit PVRTC blocks (32 bytes).
pub fn pvrtc_level_bytes(width: u32, height: u32) -> Option<usize> {
    usize::try_from(width.max(8))
        .ok()?
        .checked_mul(usize::try_from(height.max(8)).ok()?)?
        .checked_div(2)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Metadata {
    #[serde(flatten)]
    pub scene: crate::Meta,
    #[serde(default)]
    pub ipod_recipes: Recipes,
}

pub const MAGIC: [u8; 4] = *b"PLIP";
pub const VERSION: u32 = 1;
pub const POSITION: usize = 0;
pub const NORMAL: usize = 12;
pub const TANGENT: usize = 24;
pub const UV: usize = 40;
pub const COLOR: usize = 48;
pub const EXTRA: usize = 52;
pub const fn stride(layout: VertexLayout) -> u32 {
    match layout {
        VertexLayout::Static => 52,
        VertexLayout::Baked => 56,
        VertexLayout::Skinned => 60,
        VertexLayout::Lights => crate::LightPoint::STRIDE as u32,
    }
}

/// Validate the complete section table before allocating from its count.
/// `file_len` is separate so runtimes can stream sections without a whole-pack copy.
pub fn parse_header(bytes: &[u8], file_len: usize) -> Result<Vec<Section>, Error> {
    if bytes.get(..4) != Some(&MAGIC) {
        return Err(Error::Magic);
    }
    let word = |at| crate::u32_at(bytes, at);
    let version = word(4)?;
    if version != VERSION {
        return Err(Error::Version(version));
    }
    let count = word(8)? as usize;
    if !(4..=16).contains(&count) || word(12)? != 0 {
        return Err(Error::Truncated);
    }
    let table_end = count
        .checked_mul(16)
        .and_then(|n| n.checked_add(16))
        .ok_or(Error::Truncated)?;
    if table_end > bytes.len() || table_end > file_len {
        return Err(Error::Truncated);
    }
    let mut sections: Vec<Section> = Vec::with_capacity(count);
    for i in 0..count {
        let at = 16 + i * 16;
        let s = Section {
            tag: bytes[at..at + 4].try_into().unwrap(),
            offset: word(at + 4)?,
            size: word(at + 8)?,
            align: word(at + 12)?,
        };
        let end = s.offset.checked_add(s.size).ok_or(Error::Truncated)? as usize;
        if (s.offset as usize) < table_end
            || end > file_len
            || !s.align.is_power_of_two()
            || s.offset % s.align != 0
            || sections.iter().any(|p| {
                p.tag == s.tag
                    || (p.size > 0
                        && s.size > 0
                        && (s.offset as usize) < p.offset as usize + p.size as usize
                        && (p.offset as usize) < end)
            })
        {
            return Err(Error::Truncated);
        }
        sections.push(s);
    }
    Ok(sections)
}
pub fn parse(bytes: &[u8]) -> Result<Pack<'_>, Error> {
    Ok(Pack {
        bytes,
        sections: parse_header(bytes, bytes.len())?,
    })
}

pub fn floats<const N: usize>(bytes: &[u8], at: usize) -> Result<[f32; N], String> {
    let end = at.checked_add(N * 4).ok_or("iPod vertex offset overflow")?;
    let b = bytes.get(at..end).ok_or("iPod vertex truncated")?;
    let v = core::array::from_fn(|i| f32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap()));
    if v.iter().any(|v| !v.is_finite()) {
        return Err("non-finite iPod vertex".into());
    }
    Ok(v)
}
pub fn position(d: &Draw, geometry: &[u8], index: u16) -> Result<[f32; 3], String> {
    if d.layout == VertexLayout::Lights {
        return crate::parts::position(d, geometry, index);
    }
    if u32::from(index) >= d.vertex_count {
        return Err("iPod vertex index out of range".into());
    }
    floats(
        crate::parts::slice(geometry, &d.vertices)?,
        index as usize * stride(d.layout) as usize,
    )
}
pub fn components(d: &Draw, geometry: &[u8]) -> Result<Vec<u32>, String> {
    crate::parts::components_with(d, geometry, stride(d.layout), |i| position(d, geometry, i))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pvrtc_mips_and_quality_gate_are_bounded() {
        assert_eq!(pvrtc_level_bytes(512, 512), Some(131072));
        for n in [1, 2, 4, 8] {
            assert_eq!(pvrtc_level_bytes(n, n), Some(32));
        }
        let good = PvrtcQuality {
            psnr: 38.0,
            min_mip_psnr: 36.0,
            max_channel_error: 32,
            max_block_rmse: 8.0,
        };
        assert!(good.passes_v1());
        for bad in [
            PvrtcQuality {
                psnr: f32::INFINITY,
                ..good.clone()
            },
            PvrtcQuality {
                min_mip_psnr: f32::NAN,
                ..good.clone()
            },
            PvrtcQuality {
                max_channel_error: 33,
                ..good.clone()
            },
            PvrtcQuality {
                max_block_rmse: -1.0,
                ..good.clone()
            },
            PvrtcQuality {
                max_block_rmse: f32::INFINITY,
                ..good.clone()
            },
        ] {
            assert!(!bad.passes_v1());
        }
    }
    fn pack() -> Vec<u8> {
        crate::write_versioned(
            MAGIC,
            VERSION,
            &[
                (crate::TAG_META, b"{}", 16),
                (crate::TAG_TEXTURES, &[], 16),
                (crate::TAG_GEOMETRY, &[], 16),
                (crate::TAG_ANIMATION, &[], 16),
            ],
        )
    }
    #[test]
    fn target_identity_and_checked_sections() {
        let good = pack();
        assert!(parse(&good).is_ok());
        assert!(Pack::parse(&good).is_err());
        for (at, value) in [
            (4, crate::VERSION),
            (8, 0),
            (8, 17),
            (8, u32::MAX),
            (12, 1),
            (20, u32::MAX),
            (24, u32::MAX),
            (28, 3),
        ] {
            let mut bad = good.clone();
            bad[at..at + 4].copy_from_slice(&value.to_le_bytes());
            assert!(parse(&bad).is_err(), "offset {at} value {value}");
        }
        let mut alias = good.clone();
        alias[32..36].copy_from_slice(&crate::TAG_META);
        assert!(parse(&alias).is_err());
        // A zero-byte range may lie inside another section without aliasing any byte.
        let mut empty = good.clone();
        empty[36..40].copy_from_slice(&80u32.to_le_bytes());
        assert!(parse(&empty).is_ok());
        // Make the same range nonempty: it now overlaps META.
        empty[40..44].copy_from_slice(&1u32.to_le_bytes());
        assert!(parse(&empty).is_err());
    }
    #[test]
    fn float_reading_keeps_bits_and_rejects_nan_and_short_ranges() {
        let bytes = [0.1234567f32, -12.500_007, 10000.0625]
            .map(f32::to_le_bytes)
            .concat();
        assert_eq!(
            floats::<3>(&bytes, 0).unwrap().map(f32::to_bits),
            [0.1234567f32, -12.500_007, 10000.0625].map(f32::to_bits)
        );
        assert!(floats::<3>(&bytes[..11], 0).is_err());
        assert!(floats::<3>(&bytes, usize::MAX).is_err());
        assert!(floats::<1>(&f32::NAN.to_le_bytes(), 0).is_err());
    }
}
