//! Streaming cache identity, not an authenticity/security signature.
//! Color sidecars bind textures in META order: every referenced raw mip payload
//! is included, including aliases; unreferenced TEXD padding is irrelevant.
use crate::Texture;

pub struct Fnv1a64(u64);
impl Default for Fnv1a64 {
    fn default() -> Self {
        Self(0xcbf29ce484222325)
    }
}
impl Fnv1a64 {
    pub fn update(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = (self.0 ^ byte as u64).wrapping_mul(0x100000001b3);
        }
    }
    pub fn finish(self) -> u64 {
        self.0
    }
}
pub fn hash(bytes: &[u8]) -> u64 {
    let mut hash = Fnv1a64::default();
    hash.update(bytes);
    hash.finish()
}
pub fn textures(textures: &[Texture], data: &[u8]) -> Result<u64, &'static str> {
    let mut hash = Fnv1a64::default();
    for texture in textures {
        let end = texture
            .data
            .offset
            .checked_add(texture.data.size)
            .ok_or("texture identity range overflow")?;
        let bytes = data
            .get(texture.data.offset as usize..end as usize)
            .ok_or("texture identity outside TEXD")?;
        hash.update(bytes);
    }
    Ok(hash.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_is_independent_of_read_boundaries() {
        let mut value = Fnv1a64::default();
        value.update(b"a");
        value.update(b"");
        value.update(b"bc");
        assert_eq!(value.finish(), hash(b"abc"));
        assert_eq!(hash(b""), 0xcbf29ce484222325);
        assert_eq!(hash(b"a"), 0xaf63dc4c8601ec8c);
        assert_ne!(hash(b"abc"), hash(b"abd"));
    }
}
