//! Pocket Atlas place packs (`.place`).
//!
//! A pack is what a cooker produces from an authored place (glTF 2.0
//! with `extras.pocketAtlas`) for one handheld GPU: vertex and index data in
//! the renderer's quantized layouts, textures already encoded, mipmapped and
//! swizzled for the target, lights, animation tracks and the scene's
//! atmosphere parameters. A runtime maps the sections into GPU memory as-is.
//!
//! Layout (little-endian):
//!
//! ```text
//! "PLCE" u32 version u32 section_count u32 reserved
//! section_count × { tag: [u8; 4], offset: u32, size: u32, align: u32 }
//! payloads (each at `offset`, aligned to `align`)
//! ```
//!
//! `META` is UTF-8 JSON ([`Meta`]); `TEXD`, `GEOM` and `ANIM` are raw blobs
//! addressed by byte ranges inside `META`. The atlas pack ([`atlas`]) uses
//! the same container with magic "ATLS".

#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
use alloc::{vec, vec::Vec, string::{String, ToString}};

pub mod atlas;
pub mod color;
pub mod content_hash;
pub mod display;
pub mod meta;
pub mod parts;
pub mod products;

pub use meta::*;

pub const MAGIC: [u8; 4] = *b"PLCE";
/// 6: light fields (`Kind::Lights`, `VertexLayout::Lights`), the vista haze.
pub const VERSION: u32 = 6;

pub const TAG_META: [u8; 4] = *b"META";
pub const TAG_TEXTURES: [u8; 4] = *b"TEXD";
pub const TAG_GEOMETRY: [u8; 4] = *b"GEOM";
pub const TAG_ANIMATION: [u8; 4] = *b"ANIM";

#[derive(Clone, Copy, Debug)]
pub struct Section {
    pub tag: [u8; 4],
    pub offset: u32,
    pub size: u32,
    pub align: u32,
}

/// Borrowed view of a pack in memory.
pub struct Pack<'a> {
    pub bytes: &'a [u8],
    pub sections: Vec<Section>,
}

#[derive(Debug)]
pub enum Error {
    Truncated,
    Magic,
    Version(u32),
    Missing([u8; 4]),
    Json(String),
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::Truncated => write!(f, "truncated pack"),
            Error::Magic => write!(f, "not a Pocket Atlas place pack"),
            Error::Version(v) => write!(f, "unsupported pack version {v}"),
            Error::Missing(t) => write!(f, "missing section {}", String::from_utf8_lossy(t)),
            Error::Json(e) => write!(f, "META: {e}"),
        }
    }
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, Error> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or(Error::Truncated)
}

impl<'a> Pack<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, Error> {
        if bytes.get(0..4) != Some(&MAGIC[..]) {
            return Err(Error::Magic);
        }
        let version = u32_at(bytes, 4)?;
        if version != VERSION {
            return Err(Error::Version(version));
        }
        let count = u32_at(bytes, 8)? as usize;
        let mut sections = Vec::with_capacity(count);
        for i in 0..count {
            let at = 16 + i * 16;
            let tag = bytes.get(at..at + 4).ok_or(Error::Truncated)?;
            let s = Section { tag: [tag[0], tag[1], tag[2], tag[3]], offset: u32_at(bytes, at + 4)?, size: u32_at(bytes, at + 8)?, align: u32_at(bytes, at + 12)? };
            if (s.offset as usize).saturating_add(s.size as usize) > bytes.len() {
                return Err(Error::Truncated);
            }
            sections.push(s);
        }
        Ok(Self { bytes, sections })
    }

    /// Section table only (`bytes` = the first 16 + 16 × count bytes), for
    /// readers that stream payloads instead of holding the whole pack.
    pub fn parse_header(bytes: &[u8]) -> Result<Vec<Section>, Error> {
        Self::parse_header_as(bytes, MAGIC)
    }

    /// [`Pack::parse_header`] for a container with another magic.
    pub fn parse_header_as(bytes: &[u8], magic: [u8; 4]) -> Result<Vec<Section>, Error> {
        if bytes.get(0..4) != Some(&magic[..]) {
            return Err(Error::Magic);
        }
        let version = u32_at(bytes, 4)?;
        if version != VERSION {
            return Err(Error::Version(version));
        }
        let count = u32_at(bytes, 8)? as usize;
        (0..count)
            .map(|i| {
                let at = 16 + i * 16;
                let tag = bytes.get(at..at + 4).ok_or(Error::Truncated)?;
                Ok(Section { tag: [tag[0], tag[1], tag[2], tag[3]], offset: u32_at(bytes, at + 4)?, size: u32_at(bytes, at + 8)?, align: u32_at(bytes, at + 12)? })
            })
            .collect()
    }

    pub fn section(&self, tag: [u8; 4]) -> Result<&'a [u8], Error> {
        let s = self.sections.iter().find(|s| s.tag == tag).ok_or(Error::Missing(tag))?;
        Ok(&self.bytes[s.offset as usize..(s.offset + s.size) as usize])
    }

    pub fn meta(&self) -> Result<Meta, Error> {
        serde_json::from_slice(self.section(TAG_META)?).map_err(|e| Error::Json(e.to_string()))
    }
}

/// Serializes sections into a pack. Payload alignment is honoured in file
/// offsets so a runtime can map an aligned file buffer without copying.
pub fn write(sections: &[([u8; 4], &[u8], u32)]) -> Vec<u8> {
    write_as(MAGIC, sections)
}

/// [`write`] with another container magic.
pub fn write_as(magic: [u8; 4], sections: &[([u8; 4], &[u8], u32)]) -> Vec<u8> {
    let header = 16 + sections.len() * 16;
    let mut offsets = Vec::with_capacity(sections.len());
    let mut at = header;
    for (_, data, align) in sections {
        let a = (*align).max(1) as usize;
        at = at.div_ceil(a) * a;
        offsets.push(at);
        at += data.len();
    }
    let mut out = vec![0u8; at];
    out[0..4].copy_from_slice(&magic);
    out[4..8].copy_from_slice(&VERSION.to_le_bytes());
    out[8..12].copy_from_slice(&(sections.len() as u32).to_le_bytes());
    for (i, ((tag, data, align), off)) in sections.iter().zip(&offsets).enumerate() {
        let h = 16 + i * 16;
        out[h..h + 4].copy_from_slice(tag);
        out[h + 4..h + 8].copy_from_slice(&(*off as u32).to_le_bytes());
        out[h + 8..h + 12].copy_from_slice(&(data.len() as u32).to_le_bytes());
        out[h + 12..h + 16].copy_from_slice(&align.to_le_bytes());
        out[*off..*off + data.len()].copy_from_slice(data);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let meta = br#"{"version":1}"#;
        let blob = [1u8, 2, 3, 4, 5];
        let bytes = write(&[(TAG_META, meta, 4), (TAG_TEXTURES, &blob, 4096)]);
        let pack = Pack::parse(&bytes).unwrap();
        assert_eq!(pack.section(TAG_META).unwrap(), meta);
        let tex = pack.sections.iter().find(|s| s.tag == TAG_TEXTURES).unwrap();
        assert_eq!(tex.offset % 4096, 0);
        assert_eq!(pack.section(TAG_TEXTURES).unwrap(), blob);
    }
}
