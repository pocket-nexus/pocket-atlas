//! Cell streaming: which cells the vehicle needs, a thread that reads them
//! from the pack straight into GPU-mapped memory, and the list of draws the
//! renderer walks.
//!
//! Each layer loads its cells within its radius of a point and drops them a
//! cell's edge beyond it. A cell is one read; its blob stays where it was
//! read and its draws point into it. Memory comes from a pool of mapped
//! blocks; a dropped cell's memory returns to the pool a few frames later,
//! after the GPU has finished the frames that drew it.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::mpsc::{self, Receiver, Sender};

use glam::Vec3;
use pocket3d_place as pc;
use pocket3d_place::route as rt;
use pocket_vita_gxm::mem::{Block, Kind};

use super::pack::RoutePack;
use crate::scene::DrawGpu;

/// Bytes per pool block. A cell must fit in one.
const BLOCK: usize = 8 << 20;
/// Cells being read at once.
const IN_FLIGHT: usize = 2;
/// Frames a dropped cell's memory waits before reuse (the GPU may still be reading it).
const RETIRE_FRAMES: u32 = 4;

/// First-fit allocation over GPU-mapped blocks, with coalescing frees.
struct Pool {
    blocks: Vec<Block>,
    /// Per block: free ranges (offset, length), sorted by offset.
    free: Vec<Vec<(usize, usize)>>,
}

impl Pool {
    fn new() -> Self {
        Self { blocks: Vec::new(), free: Vec::new() }
    }

    unsafe fn alloc(&mut self, len: usize) -> Result<(usize, usize), String> {
        let len = len.div_ceil(64) * 64;
        if len > BLOCK {
            return Err(format!("route cell of {len} bytes exceeds the pool's block"));
        }
        for (b, ranges) in self.free.iter_mut().enumerate() {
            if let Some(k) = ranges.iter().position(|r| r.1 >= len) {
                let (at, size) = ranges[k];
                if size == len {
                    ranges.remove(k);
                } else {
                    ranges[k] = (at + len, size - len);
                }
                return Ok((b, at));
            }
        }
        self.blocks.push(Block::with_access(Kind::Main, BLOCK, false)?);
        self.free.push(vec![(len, BLOCK - len)]);
        Ok((self.blocks.len() - 1, 0))
    }

    fn release(&mut self, block: usize, at: usize, len: usize) {
        let len = len.div_ceil(64) * 64;
        let ranges = &mut self.free[block];
        let k = ranges.partition_point(|r| r.0 < at);
        ranges.insert(k, (at, len));
        if k + 1 < ranges.len() && ranges[k].0 + ranges[k].1 == ranges[k + 1].0 {
            ranges[k].1 += ranges[k + 1].1;
            ranges.remove(k + 1);
        }
        if k > 0 && ranges[k - 1].0 + ranges[k - 1].1 == ranges[k].0 {
            ranges[k - 1].1 += ranges[k].1;
            ranges.remove(k);
        }
    }

    fn ptr(&self, block: usize, at: usize) -> *mut u8 {
        unsafe { self.blocks[block].base().add(at) }
    }

    fn reserved(&self) -> usize {
        self.blocks.len() * BLOCK
    }

    fn used(&self) -> usize {
        self.reserved() - self.free.iter().flatten().map(|r| r.1).sum::<usize>()
    }

    unsafe fn free_all(self) {
        for b in self.blocks {
            b.free();
        }
    }
}

struct Request {
    cell: usize,
    offset: u64,
    dest: *mut u8,
    len: usize,
}
// The destination is pool memory nobody else touches until the reply.
unsafe impl Send for Request {}

enum State {
    Absent,
    Loading { block: usize, at: usize },
    Ready { block: usize, at: usize, draws: Vec<rt::CellDraw>, geom: usize },
}

pub struct Streamer {
    pool: Pool,
    states: Vec<State>,
    /// Cells of each layer by (ix, iz).
    lookup: Vec<HashMap<(i16, i16), usize>>,
    tx: Option<Sender<Request>>,
    rx: Receiver<(usize, Result<(), String>)>,
    in_flight: usize,
    retired: Vec<(u32, usize, usize, usize)>,
    frame: u32,
    /// The set of ready cells changed: the draw list must be rebuilt.
    pub dirty: bool,
    pub errors: Vec<String>,
    /// Cells read so far and the bytes they held.
    pub loaded: u32,
    pub bytes: u64,
    queue: Vec<(f32, usize)>,
}

pub struct Stats {
    pub ready: usize,
    pub loading: usize,
    pub queued: usize,
    pub pool_used: usize,
    pub pool_reserved: usize,
}

impl Streamer {
    pub fn new(pack: &RoutePack) -> Result<Self, String> {
        let mut lookup: Vec<HashMap<(i16, i16), usize>> = pack.meta.layers.iter().map(|_| HashMap::new()).collect();
        for (i, c) in pack.cells.iter().enumerate() {
            lookup[c.layer as usize].insert((c.ix, c.iz), i);
        }
        let (tx, req) = mpsc::channel::<Request>();
        let (done, rx) = mpsc::channel();
        let path = pack.path.clone();
        std::thread::Builder::new()
            .name("atlas-cells".into())
            .stack_size(128 * 1024)
            .spawn(move || {
                let mut file = std::fs::File::open(&path);
                while let Ok(r) = req.recv() {
                    let result = match file.as_mut() {
                        Ok(f) => f
                            .seek(SeekFrom::Start(r.offset))
                            .and_then(|_| f.read_exact(unsafe { core::slice::from_raw_parts_mut(r.dest, r.len) }))
                            .map_err(|e| format!("{path}: cell at {}: {e}", r.offset)),
                        Err(e) => Err(format!("{path}: {e}")),
                    };
                    if done.send((r.cell, result)).is_err() {
                        return;
                    }
                }
            })
            .map_err(|e| format!("cell thread: {e}"))?;
        Ok(Self {
            pool: Pool::new(),
            states: pack.cells.iter().map(|_| State::Absent).collect(),
            lookup,
            tx: Some(tx),
            rx,
            in_flight: 0,
            retired: Vec::new(),
            frame: 0,
            dirty: true,
            errors: Vec::new(),
            loaded: 0,
            bytes: 0,
            queue: Vec::new(),
        })
    }

    /// Takes finished reads, asks for the cells missing around (x, z), drops
    /// the ones left behind and returns retired memory to the pool. Returns
    /// how many wanted cells are not ready yet.
    ///
    /// # Safety
    /// Render thread, GXM initialised.
    pub unsafe fn update(&mut self, pack: &RoutePack, x: f64, z: f64) -> usize {
        self.frame = self.frame.wrapping_add(1);
        while let Ok((cell, result)) = self.rx.try_recv() {
            self.in_flight -= 1;
            let State::Loading { block, at } = self.states[cell] else { continue };
            let entry = &pack.cells[cell];
            let blob = core::slice::from_raw_parts(self.pool.ptr(block, at), entry.size as usize);
            match result.and_then(|_| rt::cell_draws(blob).and_then(|d| rt::cell_header(blob).map(|h| (d, h.1)))) {
                Ok((draws, geom)) => {
                    self.states[cell] = State::Ready { block, at, draws, geom };
                    self.loaded += 1;
                    self.bytes += entry.size as u64;
                    self.dirty = true;
                }
                Err(e) => {
                    self.pool.release(block, at, entry.size as usize);
                    self.states[cell] = State::Absent;
                    if self.errors.len() < 8 {
                        self.errors.push(e);
                    }
                }
            }
        }
        // What each layer wants and what it may keep.
        self.queue.clear();
        let mut missing = 0;
        for (li, layer) in pack.meta.layers.iter().enumerate() {
            let size = layer.size as f64;
            let r = layer.radius as f64;
            let (x0, x1) = (((x - r) / size).floor() as i32, ((x + r) / size).floor() as i32);
            let (z0, z1) = (((z - r) / size).floor() as i32, ((z + r) / size).floor() as i32);
            for ix in x0..=x1 {
                for iz in z0..=z1 {
                    let Some(&cell) = self.lookup[li].get(&(ix as i16, iz as i16)) else { continue };
                    let dx = (ix as f64 * size - x).max(0.0).max(x - (ix + 1) as f64 * size);
                    let dz = (iz as f64 * size - z).max(0.0).max(z - (iz + 1) as f64 * size);
                    let d2 = dx * dx + dz * dz;
                    if d2 > r * r {
                        continue;
                    }
                    match self.states[cell] {
                        State::Ready { .. } => {}
                        State::Loading { .. } => missing += 1,
                        State::Absent => {
                            missing += 1;
                            // The corridor's ground before what stands on it and what lies beyond.
                            let rank = match layer.name.as_str() {
                                "base" => 1.0,
                                "detail" => 1.5,
                                _ => 2.0,
                            };
                            self.queue.push(((d2.sqrt() as f32 + 64.0) * rank, cell));
                        }
                    }
                }
            }
        }
        self.queue.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(core::cmp::Ordering::Equal));
        let mut k = 0;
        while self.in_flight < IN_FLIGHT && k < self.queue.len() {
            let cell = self.queue[k].1;
            k += 1;
            let entry = &pack.cells[cell];
            match self.pool.alloc(entry.size as usize) {
                Ok((block, at)) => {
                    let dest = self.pool.ptr(block, at);
                    if let Some(tx) = &self.tx {
                        if tx.send(Request { cell, offset: pack.cells_at + entry.offset as u64, dest, len: entry.size as usize }).is_ok() {
                            self.states[cell] = State::Loading { block, at };
                            self.in_flight += 1;
                            continue;
                        }
                    }
                    self.pool.release(block, at, entry.size as usize);
                }
                Err(e) => {
                    if self.errors.len() < 8 {
                        self.errors.push(e);
                    }
                    break;
                }
            }
        }
        // Left behind: beyond the radius by more than a cell.
        for (cell, entry) in pack.cells.iter().enumerate() {
            let State::Ready { block, at, .. } = self.states[cell] else { continue };
            let layer = &pack.meta.layers[entry.layer as usize];
            let size = layer.size as f64;
            let dx = (entry.ix as f64 * size - x).max(0.0).max(x - (entry.ix as f64 + 1.0) * size);
            let dz = (entry.iz as f64 * size - z).max(0.0).max(z - (entry.iz as f64 + 1.0) * size);
            let keep = layer.radius as f64 + size;
            if dx * dx + dz * dz > keep * keep {
                self.states[cell] = State::Absent;
                self.retired.push((self.frame, block, at, entry.size as usize));
                self.dirty = true;
            }
        }
        let frame = self.frame;
        let pool = &mut self.pool;
        self.retired.retain(|&(f, block, at, len)| {
            if frame.wrapping_sub(f) < RETIRE_FRAMES {
                return true;
            }
            pool.release(block, at, len);
            false
        });
        missing
    }

    /// Appends every ready cell's draws to `out`, positioned relative to `origin`.
    pub fn draws(&self, pack: &RoutePack, materials: &[pc::Material], origin: [f64; 3], out: &mut Vec<DrawGpu>) {
        for (cell, state) in self.states.iter().enumerate() {
            let State::Ready { block, at, draws, geom } = state else { continue };
            let entry = &pack.cells[cell];
            let base = unsafe { self.pool.ptr(*block, *at).add(*geom) };
            let shift = Vec3::new((entry.origin[0] as f64 - origin[0]) as f32, (entry.origin[1] as f64 - origin[1]) as f32, (entry.origin[2] as f64 - origin[2]) as f32);
            for d in draws {
                let Some(m) = materials.get(d.material as usize) else { continue };
                let lit = matches!(m.kind, pc::Kind::Standard | pc::Kind::Glass);
                let at = |o: u32| unsafe { base.add(o as usize) };
                out.push(DrawGpu {
                    vb: at(d.vertex_offset),
                    ib: at(d.index_offset).cast(),
                    count: d.index_count,
                    skinned: false,
                    baked: lit,
                    lights: false,
                    lods: d.lods[..(d.lod_count as usize).min(rt::CELL_LODS)].iter().map(|l| (at(l.0).cast::<u16>() as *const u16, l.1, l.2)).collect(),
                    material: d.material,
                    dequant: [d.pos_scale[0], d.pos_scale[1], d.pos_scale[2], 0.0, d.pos_offset[0] + shift.x, d.pos_offset[1] + shift.y, d.pos_offset[2] + shift.z, 0.0],
                    uv: [d.uv_scale[0], d.uv_scale[1], d.uv_offset[0], d.uv_offset[1]],
                    min: Vec3::from(d.min) + shift,
                    max: Vec3::from(d.max) + shift,
                    node: None,
                    skin: None,
                    no_reflect: true,
                });
            }
        }
    }

    pub fn stats(&self) -> Stats {
        let (mut ready, mut loading) = (0, 0);
        for s in &self.states {
            match s {
                State::Ready { .. } => ready += 1,
                State::Loading { .. } => loading += 1,
                State::Absent => {}
            }
        }
        Stats { ready, loading, queued: self.queue.len().saturating_sub(loading), pool_used: self.pool.used(), pool_reserved: self.pool.reserved() }
    }

    /// Stops the reader and frees the pool.
    ///
    /// # Safety
    /// GPU idle with respect to every cell.
    pub unsafe fn release(mut self) {
        // Closing the request channel ends the thread once its current read returns;
        // reads in flight still write into the pool, so wait for their replies.
        self.tx = None;
        while self.in_flight > 0 {
            match self.rx.recv() {
                Ok(_) => self.in_flight -= 1,
                Err(_) => break,
            }
        }
        self.pool.free_all();
    }
}
