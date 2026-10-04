//! Disposable, content-addressed bake storage. Corrupt/partial entries are misses.
//! Keys conservatively include the complete sealed source, recipe, compiler and
//! host ABI; changing upstream policy can never reuse an old lighting result.
use crate::{geometry::Vertex, Args};
use glam::{Vec2, Vec3};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

const MAGIC: &[u8; 8] = b"ATBAKE01";
const MAX_ENTRY: u64 = 512 * 1024 * 1024;
const STRIDE: usize = 64;

pub struct Cache {
    root: Option<PathBuf>,
    context: Sha256,
    pub hits: usize,
    pub misses: usize,
}
impl Cache {
    pub fn new(a: &Args) -> Self {
        let mut context = Sha256::new();
        for bytes in [
            env!("ATLAS_COMPILER_HASH").as_bytes(),
            env!("ATLAS_RUSTC").as_bytes(),
            std::env::consts::ARCH.as_bytes(),
            std::env::consts::OS.as_bytes(),
            b"bake-lighting@1/geometry-cache@1",
            &fs::read(a.input.join("manifest.json")).expect("sealed source manifest"),
            &serde_json::to_vec(&a.profile).unwrap(),
            &a.cell.to_le_bytes(),
        ] {
            context.update((bytes.len() as u64).to_le_bytes());
            context.update(bytes);
        }
        Self {
            root: a.cache.clone(),
            context,
            hits: 0,
            misses: 0,
        }
    }
    pub fn key(&self, primitive: usize) -> String {
        let mut key = self.context.clone();
        key.update((primitive as u64).to_le_bytes());
        format!("{:x}", key.finalize())
    }
    pub fn read(&mut self, key: &str) -> Option<(Vec<Vertex>, Vec<[u32; 3]>)> {
        let result = self.root.as_ref().and_then(|root| {
            let path = root.join(format!("{key}.bake"));
            if fs::metadata(&path).ok()?.len() > MAX_ENTRY {
                return None;
            }
            let bytes = fs::read(path).ok()?;
            decode(key, &bytes)
        });
        if result.is_some() {
            self.hits += 1;
        } else {
            self.misses += 1;
        }
        result
    }
    pub fn write(&self, key: &str, vertices: &[Vertex], triangles: &[[u32; 3]]) {
        let Some(root) = &self.root else {
            return;
        };
        let bytes = encode(key, vertices, triangles);
        if bytes.len() as u64 > MAX_ENTRY || fs::create_dir_all(root).is_err() {
            return;
        }
        // One entry per primitive, atomic rename. Concurrent compilers may
        // replace the same key only with the same checked deterministic bytes.
        let temporary = root.join(format!("{key}.{}.tmp", std::process::id()));
        if fs::write(&temporary, bytes).is_ok() {
            let _ = fs::rename(&temporary, root.join(format!("{key}.bake")));
        }
        let _ = fs::remove_file(temporary);
    }
}
fn encode(key: &str, vertices: &[Vertex], triangles: &[[u32; 3]]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(16 + vertices.len() * STRIDE + triangles.len() * 12);
    payload.extend((vertices.len() as u64).to_le_bytes());
    payload.extend((triangles.len() as u64).to_le_bytes());
    for v in vertices {
        for x in v
            .pos
            .to_array()
            .into_iter()
            .chain(v.normal.to_array())
            .chain(v.tangent)
            .chain(v.uv.to_array())
        {
            payload.extend(x.to_le_bytes());
        }
        payload.extend(v.color);
        payload.extend(v.joints);
        payload.extend(v.weights);
        payload.extend(v.light);
    }
    for t in triangles {
        for i in t {
            payload.extend(i.to_le_bytes());
        }
    }
    let mut bytes = Vec::with_capacity(104 + payload.len());
    bytes.extend(MAGIC);
    bytes.extend(key.as_bytes());
    bytes.extend(Sha256::digest(&payload));
    bytes.extend(payload);
    bytes
}
fn decode(key: &str, bytes: &[u8]) -> Option<(Vec<Vertex>, Vec<[u32; 3]>)> {
    if key.len() != 64
        || bytes.len() < 120
        || &bytes[..8] != MAGIC
        || &bytes[8..72] != key.as_bytes()
    {
        return None;
    }
    let payload = &bytes[104..];
    if Sha256::digest(payload).as_slice() != &bytes[72..104] {
        return None;
    }
    let nv = usize::try_from(u64::from_le_bytes(payload[..8].try_into().ok()?)).ok()?;
    let nt = usize::try_from(u64::from_le_bytes(payload[8..16].try_into().ok()?)).ok()?;
    let nbytes = 16usize
        .checked_add(nv.checked_mul(STRIDE)?)?
        .checked_add(nt.checked_mul(12)?)?;
    if nbytes != payload.len() {
        return None;
    }
    let mut vertices = Vec::with_capacity(nv);
    for v in payload[16..16 + nv * STRIDE].chunks_exact(STRIDE) {
        let f = |i: usize| f32::from_le_bytes(v[i * 4..i * 4 + 4].try_into().unwrap());
        if (0..12).any(|i| !f(i).is_finite()) {
            return None;
        }
        vertices.push(Vertex {
            pos: Vec3::new(f(0), f(1), f(2)),
            normal: Vec3::new(f(3), f(4), f(5)),
            tangent: [f(6), f(7), f(8), f(9)],
            uv: Vec2::new(f(10), f(11)),
            color: v[48..52].try_into().ok()?,
            joints: v[52..56].try_into().ok()?,
            weights: v[56..60].try_into().ok()?,
            light: v[60..64].try_into().ok()?,
        });
    }
    let mut triangles = Vec::with_capacity(nt);
    for t in payload[16 + nv * STRIDE..].chunks_exact(12) {
        let tri =
            std::array::from_fn(|i| u32::from_le_bytes(t[i * 4..i * 4 + 4].try_into().unwrap()));
        if tri.iter().any(|&i| i as usize >= nv) {
            return None;
        }
        triangles.push(tri);
    }
    Some((vertices, triangles))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_preserves_attribute_bits_and_rejects_corruption_wrong_keys_and_indices() {
        let key = "a".repeat(64);
        let v = Vertex {
            pos: Vec3::new(-0.0, 1.234567, 8.0),
            normal: Vec3::Y,
            tangent: [1.0, 0.0, 0.0, -1.0],
            uv: Vec2::new(0.42, -7.0),
            color: [0, 4, 128, 255],
            joints: [2, 1, 8, 0],
            weights: [90, 80, 85, 0],
            light: [8, 14, 18, 44],
        };
        let encoded = encode(&key, &[v], &[[0, 0, 0]]);
        let (vertices, tris) = decode(&key, &encoded).unwrap();
        assert_eq!(encode(&key, &vertices, &tris), encoded);
        assert_eq!(vertices[0].pos.x.to_bits(), (-0.0f32).to_bits());
        assert!(decode(&"b".repeat(64), &encoded).is_none());
        for n in [0, 7, 80, encoded.len() - 1] {
            assert!(decode(&key, &encoded[..n]).is_none());
        }
        let mut corrupt = encoded.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(decode(&key, &corrupt).is_none());
        assert!(decode(&key, &encode(&key, &[v], &[[0, 1, 0]])).is_none());
    }
}
