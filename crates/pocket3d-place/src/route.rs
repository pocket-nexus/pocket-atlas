//! Route packs (`.route`): a road driven end to end, for one handheld GPU.
//!
//! A route is too long to hold in memory: its world is cut into square cells
//! on a few layers (small things by the road, the corridor, the country
//! around it, the far hills), each cooked on its own and read from the pack
//! when the vehicle comes within the layer's radius. What every cell shares
//! — materials and their textures, the sky, the light, the look, the car —
//! is the route's *kit*, an ordinary place pack nested in the route pack.
//!
//! Layout (little-endian), the place container with its own magic and
//! version:
//!
//! ```text
//! "ROUT" u32 version u32 section_count u32 reserved
//! section_count × { tag, offset, size, align }
//! META   UTF-8 JSON ([`RouteMeta`])
//! KIT    a `.place` pack ([`crate::Meta`], textures, the car's geometry)
//! LINE   the driven line: count × { x, y, z, half width } f32
//! CIDX   cells: count × [`CellEntry`] (32 bytes)
//! CELL   cell blobs, each at its entry's offset inside the section
//! ```
//!
//! A cell blob is one read: a header, its draw records, then vertices and
//! indices in the Vita layouts of [`crate::VertexLayout`], positions
//! relative to the cell's origin. A runtime adds the origin (less whatever
//! it renders relative to) to each draw's dequantisation offset and bounds.

use serde::{Deserialize, Serialize};

pub const MAGIC: [u8; 4] = *b"ROUT";
pub const VERSION: u32 = 1;

pub const TAG_META: [u8; 4] = *b"META";
pub const TAG_KIT: [u8; 4] = *b"KIT ";
pub const TAG_LINE: [u8; 4] = *b"LINE";
pub const TAG_INDEX: [u8; 4] = *b"CIDX";
pub const TAG_CELLS: [u8; 4] = *b"CELL";

/// A streaming layer: cells of `size` metres load within `radius` of the
/// vehicle and unload beyond `radius + size`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layer {
    pub name: String,
    pub size: f32,
    pub radius: f32,
}

/// A place on the way where a trip starts, resumes or ends.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stop {
    pub name: String,
    pub native: String,
    /// Arc length on the driven line (m).
    pub s: f32,
}

/// The car's single-track model (web `routes/shared/drive/vehicle.ts`, `KEI`).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarSpec {
    pub mass: f32,
    pub inertia: f32,
    pub wheelbase: f32,
    pub front: f32,
    pub rear: f32,
    pub half_width: f32,
    pub nose: f32,
    pub tail: f32,
    pub wheel_radius: f32,
    pub power: f32,
    pub force: f32,
    pub brake: f32,
    pub engine_brake: f32,
    pub rolling: f32,
    pub drag: f32,
    pub stiffness_front: f32,
    pub stiffness_rear: f32,
    pub lock: f32,
    pub steer_rate: f32,
    pub steer_speed: f32,
    pub top: f32,
    pub reverse: f32,
}

/// A named view beside the road (captures and measurements).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct View {
    pub name: String,
    pub pos: [f32; 3],
    pub target: [f32; 3],
    pub fov: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteMeta {
    pub version: u32,
    pub name: String,
    /// Length of the driven line (m) and the spacing of its samples.
    pub length: f32,
    pub step: f32,
    pub samples: u32,
    pub layers: Vec<Layer>,
    pub stops: Vec<Stop>,
    /// Speed limits from an arc length on: (s, km/h).
    pub limits: Vec<(f32, f32)>,
    pub car: CarSpec,
    /// Minutes after local midnight the trip departs at.
    pub departure: f32,
    pub views: Vec<View>,
    pub stats: serde_json::Value,
}

/// One cell of the index.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CellEntry {
    pub layer: u8,
    pub ix: i16,
    pub iz: i16,
    /// The blob inside `CELL`.
    pub offset: u32,
    pub size: u32,
    /// World position of the cell's local origin.
    pub origin: [f32; 3],
    /// Lowest and highest point (world y).
    pub min_y: f32,
    pub max_y: f32,
}

impl CellEntry {
    pub const SIZE: usize = 36;

    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend([self.layer, 0]);
        out.extend(self.ix.to_le_bytes());
        out.extend(self.iz.to_le_bytes());
        out.extend([0, 0]);
        out.extend(self.offset.to_le_bytes());
        out.extend(self.size.to_le_bytes());
        for v in self.origin.iter().chain([&self.min_y, &self.max_y]) {
            out.extend(v.to_le_bytes());
        }
    }

    pub fn decode(b: &[u8]) -> Self {
        let f = |o: usize| f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let u = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        Self {
            layer: b[0],
            ix: i16::from_le_bytes([b[2], b[3]]),
            iz: i16::from_le_bytes([b[4], b[5]]),
            offset: u(8),
            size: u(12),
            origin: [f(16), f(20), f(24)],
            min_y: f(28),
            max_y: f(32),
        }
    }

    pub fn decode_all(bytes: &[u8]) -> Vec<Self> {
        bytes.chunks_exact(Self::SIZE).map(Self::decode).collect()
    }
}

pub const CELL_MAGIC: [u8; 4] = *b"CELL";
/// Bytes before a blob's draw records: magic, draw count, geometry offset, geometry size.
pub const CELL_HEADER: usize = 16;
/// Reduced index lists a cell draw may carry.
pub const CELL_LODS: usize = 3;

/// One draw of a cell. Offsets address the blob's geometry part.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CellDraw {
    /// Index into the kit's materials.
    pub material: u32,
    pub vertex_offset: u32,
    pub vertex_count: u32,
    pub index_offset: u32,
    pub index_count: u32,
    /// Dequantisation in the cell's frame: position = q × scale + offset.
    pub pos_offset: [f32; 3],
    pub pos_scale: [f32; 3],
    pub uv_offset: [f32; 2],
    pub uv_scale: [f32; 2],
    /// Bounds in the cell's frame.
    pub min: [f32; 3],
    pub max: [f32; 3],
    /// (index offset, index count, error m), finest first; count 0 marks unused entries
    /// unless its error is positive (a level at which the draw vanishes).
    pub lods: [(u32, u32, f32); CELL_LODS],
    pub lod_count: u32,
}

impl CellDraw {
    pub const SIZE: usize = 20 + 16 * 4 + 4 + CELL_LODS * 12;

    pub fn encode(&self, out: &mut Vec<u8>) {
        for v in [self.material, self.vertex_offset, self.vertex_count, self.index_offset, self.index_count] {
            out.extend(v.to_le_bytes());
        }
        for v in self.pos_offset.iter().chain(&self.pos_scale).chain(&self.uv_offset).chain(&self.uv_scale).chain(&self.min).chain(&self.max) {
            out.extend(v.to_le_bytes());
        }
        out.extend(self.lod_count.to_le_bytes());
        for l in &self.lods {
            out.extend(l.0.to_le_bytes());
            out.extend(l.1.to_le_bytes());
            out.extend(l.2.to_le_bytes());
        }
    }

    pub fn decode(b: &[u8]) -> Self {
        let f = |o: usize| f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let u = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let f3 = |o: usize| [f(o), f(o + 4), f(o + 8)];
        let f2 = |o: usize| [f(o), f(o + 4)];
        Self {
            material: u(0),
            vertex_offset: u(4),
            vertex_count: u(8),
            index_offset: u(12),
            index_count: u(16),
            pos_offset: f3(20),
            pos_scale: f3(32),
            uv_offset: f2(44),
            uv_scale: f2(52),
            min: f3(60),
            max: f3(72),
            lod_count: u(84),
            lods: core::array::from_fn(|k| (u(88 + k * 12), u(92 + k * 12), f(96 + k * 12))),
        }
    }
}

/// The header of a cell blob: (draw count, geometry offset in the blob, geometry size).
pub fn cell_header(blob: &[u8]) -> Result<(usize, usize, usize), String> {
    if blob.len() < CELL_HEADER || blob[0..4] != CELL_MAGIC {
        return Err("not a route cell".into());
    }
    let u = |o: usize| u32::from_le_bytes([blob[o], blob[o + 1], blob[o + 2], blob[o + 3]]) as usize;
    let (draws, geom, size) = (u(4), u(8), u(12));
    if CELL_HEADER + draws * CellDraw::SIZE > geom || geom + size > blob.len() {
        return Err("truncated route cell".into());
    }
    Ok((draws, geom, size))
}

/// The draw records of a cell blob.
pub fn cell_draws(blob: &[u8]) -> Result<Vec<CellDraw>, String> {
    let (draws, _, _) = cell_header(blob)?;
    Ok((0..draws).map(|i| CellDraw::decode(&blob[CELL_HEADER + i * CellDraw::SIZE..])).collect())
}

/// Serializes a cell blob; the geometry part starts on a 16-byte boundary.
pub fn write_cell(draws: &[CellDraw], geometry: &[u8]) -> Vec<u8> {
    let geom = (CELL_HEADER + draws.len() * CellDraw::SIZE).div_ceil(16) * 16;
    let mut out = Vec::with_capacity(geom + geometry.len());
    out.extend(CELL_MAGIC);
    out.extend((draws.len() as u32).to_le_bytes());
    out.extend((geom as u32).to_le_bytes());
    out.extend((geometry.len() as u32).to_le_bytes());
    for d in draws {
        d.encode(&mut out);
    }
    out.resize(geom, 0);
    out.extend_from_slice(geometry);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_and_cells_round_trip() {
        let e = CellEntry { layer: 2, ix: -7, iz: 19, offset: 4096, size: 123_456, origin: [-7168.0, 0.0, 19456.0], min_y: 181.5, max_y: 240.25 };
        let mut bytes = Vec::new();
        e.encode(&mut bytes);
        assert_eq!(bytes.len(), CellEntry::SIZE);
        assert_eq!(CellEntry::decode_all(&bytes), vec![e]);

        let d = CellDraw {
            material: 3,
            vertex_offset: 0,
            vertex_count: 4,
            index_offset: 112,
            index_count: 6,
            pos_offset: [128.0, 200.0, 128.0],
            pos_scale: [128.0, 20.0, 128.0],
            uv_offset: [32.0, 32.0],
            uv_scale: [32.0, 32.0],
            min: [0.0, 180.0, 0.0],
            max: [256.0, 220.0, 256.0],
            lods: [(124, 3, 0.5), (0, 0, 2.0), (0, 0, 0.0)],
            lod_count: 2,
        };
        let geometry = vec![7u8; 130];
        let blob = write_cell(&[d, d], &geometry);
        let (n, at, size) = cell_header(&blob).unwrap();
        assert_eq!((n, at % 16, size), (2, 0, 130));
        assert_eq!(&blob[at..], &geometry[..]);
        assert_eq!(cell_draws(&blob).unwrap(), vec![d, d]);
        assert!(cell_header(&blob[..at + 10]).is_err());
    }
}
