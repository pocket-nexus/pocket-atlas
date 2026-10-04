//! Forward-only pack reads with a digest of the complete loaded source.
use pocket3d_place as pc;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;

/// Forward-only reads: the USB host file system does not seek, so a pack is
/// read in file order and a backward jump reopens the file.
pub(crate) struct Seq {
    path: String,
    f: File,
    pos: u64,
    scratch: Vec<u8>,
    hash: Sha256,
    hashed: u64,
}

/// A section of a pack's table by tag.
pub(crate) fn find(sections: &[pc::Section], tag: [u8; 4]) -> Result<pc::Section, String> {
    sections
        .iter()
        .find(|s| s.tag == tag)
        .copied()
        .ok_or(format!("missing section {}", String::from_utf8_lossy(&tag)))
}

impl Seq {
    pub(crate) fn open(path: &str) -> Result<Self, String> {
        Ok(Self {
            path: path.into(),
            f: File::open(path).map_err(|e| format!("{path}: {e}"))?,
            pos: 0,
            scratch: vec![0; 64 * 1024],
            hash: Sha256::new(),
            hashed: 0,
        })
    }

    /// The section table of a pack container (place or atlas pack, by magic).
    pub(crate) fn sections(&mut self, magic: [u8; 4]) -> Result<Vec<pc::Section>, String> {
        let mut head = [0u8; 16];
        self.read_at(0, &mut head)?;
        let count = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
        let mut table = vec![0u8; 16 + count * 16];
        table[..16].copy_from_slice(&head);
        self.read_at(16, &mut table[16..])?;
        pc::Pack::parse_header_as(&table, magic).map_err(|e| format!("{}: {e}", self.path))
    }

    /// One section's bytes.
    pub(crate) fn section(&mut self, s: &pc::Section) -> Result<Vec<u8>, String> {
        let mut bytes = vec![0u8; s.size as usize];
        self.read_at(s.offset as u64, &mut bytes)?;
        Ok(bytes)
    }

    pub(crate) fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
        if offset < self.pos {
            self.f = File::open(&self.path).map_err(|e| format!("{}: {e}", self.path))?;
            self.pos = 0;
        }
        while self.pos < offset {
            let n = ((offset - self.pos) as usize).min(self.scratch.len());
            self.f
                .read_exact(&mut self.scratch[..n])
                .map_err(|e| format!("{}: skip: {e}", self.path))?;
            let skip = self.hashed.saturating_sub(self.pos).min(n as u64) as usize;
            self.hash.update(&self.scratch[skip..n]);
            self.hashed = self.hashed.max(self.pos + n as u64);
            self.pos += n as u64;
        }
        // Large reads in 1 MiB pieces keep each USB transfer bounded.
        for chunk in buf.chunks_mut(1 << 20) {
            self.f
                .read_exact(chunk)
                .map_err(|e| format!("{}: read @{}: {e}", self.path, self.pos))?;
            let skip = self.hashed.saturating_sub(self.pos).min(chunk.len() as u64) as usize;
            self.hash.update(&chunk[skip..]);
            self.hashed = self.hashed.max(self.pos + chunk.len() as u64);
            self.pos += chunk.len() as u64;
        }
        Ok(())
    }

    pub(crate) fn finish_digest(mut self) -> Result<String, String> {
        loop {
            let n = self
                .f
                .read(&mut self.scratch)
                .map_err(|e| format!("{}: digest: {e}", self.path))?;
            if n == 0 {
                break;
            }
            let skip = self.hashed.saturating_sub(self.pos).min(n as u64) as usize;
            self.hash.update(&self.scratch[skip..n]);
            self.pos += n as u64;
            self.hashed = self.hashed.max(self.pos);
        }
        Ok(format!("{:x}", self.hash.finalize()))
    }
}
