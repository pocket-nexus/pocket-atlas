//! Bounded geometry residency. I/O runs off the render thread; only completed,
//! verified pages become GPU pointers. Old pages retire after a GXM fence.
use crate::scene::DrawGpu;
use pocket3d_gxm::mem::{Block, Kind};
use pocket3d_place::{
    self as pc,
    streaming::{distance2, Driving, Page},
};
use std::{fs::File, io::Read, sync::mpsc, thread, time::Instant};

struct Resident {
    id: usize,
    block: Block,
}
struct Loaded {
    id: usize,
    data: Result<Vec<u8>, String>,
    ms: u32,
}
pub struct Stream {
    plan: Driving,
    defs: Vec<pc::Draw>,
    resident: Vec<Resident>,
    send: mpsc::SyncSender<(usize, String, Page)>,
    receive: mpsc::Receiver<Loaded>,
    dir: String,
    loading: Option<usize>,
    pub error: Option<String>,
    pub ready: bool,
    pub bytes: usize,
    pub loaded: u32,
    pub evicted: u32,
    pub stalls: u32,
    pub max_io_ms: u32,
}
impl Stream {
    pub fn new(path: &str, plan: Driving, defs: Vec<pc::Draw>) -> Result<Self, String> {
        let (tx, rx) = mpsc::sync_channel::<(usize, String, Page)>(1);
        let (done, result) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("atlas-page-io".into())
            .stack_size(128 << 10)
            .spawn(move || {
                while let Ok((id, path, page)) = rx.recv() {
                    let start = Instant::now();
                    let data = (|| -> Result<Vec<u8>, String> {
                        let f = File::open(&path).map_err(|e| format!("{path}: {e}"))?;
                        let mut b = Vec::with_capacity(page.bytes as usize);
                        f.take(page.bytes as u64 + 1)
                            .read_to_end(&mut b)
                            .map_err(|e| e.to_string())?;
                        if b.len() != page.bytes as usize
                            || pc::streaming::checksum(&b) != page.checksum
                        {
                            return Err(format!("corrupt geometry page {path}"));
                        }
                        Ok(b)
                    })();
                    if done
                        .send(Loaded {
                            id,
                            data,
                            ms: start.elapsed().as_millis() as u32,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|e| format!("page reader: {e}"))?;
        Ok(Self {
            plan,
            defs,
            resident: vec![],
            send: tx,
            receive: result,
            dir: format!("{path}.pages"),
            loading: None,
            error: None,
            ready: false,
            bytes: 0,
            loaded: 0,
            evicted: 0,
            stalls: 0,
            max_io_ms: 0,
        })
    }
    fn has(&self, id: usize) -> bool {
        self.resident.iter().any(|r| r.id == id)
    }
    unsafe fn bind(&self, id: usize, base: *mut u8, draws: &mut [DrawGpu]) {
        for &k in &self.plan.pages[id].draws {
            let d = &self.defs[k as usize];
            let gpu = &mut draws[k as usize];
            gpu.vb = if base.is_null() {
                std::ptr::null()
            } else {
                base.add(d.vertices.offset as usize)
            };
            gpu.ib = if base.is_null() {
                std::ptr::null()
            } else {
                base.add(d.indices.offset as usize).cast()
            };
            for (slot, lod) in gpu.lods.iter_mut().zip(&d.lods) {
                slot.0 = if base.is_null() {
                    std::ptr::null()
                } else {
                    base.add(lod.indices.offset as usize).cast()
                };
            }
        }
    }
    /// Call before submitting this frame. Geometry outside view_m is fogged;
    /// prefetch_m gives >10 seconds of travel at the car's maximum speed.
    pub unsafe fn update(&mut self, pos: [f32; 3], draws: &mut [DrawGpu]) {
        let mut wanted: Vec<(usize, f32)> = self
            .plan
            .pages
            .iter()
            .enumerate()
            .map(|(i, p)| (i, distance2(pos, p.min, p.max)))
            .filter(|(_, d)| *d < self.plan.prefetch_m.powi(2))
            .collect();
        wanted.sort_by(|a, b| a.1.total_cmp(&b.1));
        // Only retain hysteresis pages while there is space for the wanted set.
        let needed = wanted
            .iter()
            .map(|(i, _)| self.plan.pages[*i].bytes as usize)
            .sum::<usize>();
        let retire = self.resident.iter().any(|r| {
            !wanted.iter().any(|(id, _)| *id == r.id)
                && (needed + self.bytes > self.plan.budget_bytes as usize
                    || distance2(pos, self.plan.pages[r.id].min, self.plan.pages[r.id].max)
                        > (self.plan.prefetch_m + 180.).powi(2))
        });
        if retire {
            vita2d_sys::sceGxmFinish(vita2d_sys::vita2d_get_context());
            let mut i = 0;
            while i < self.resident.len() {
                let id = self.resident[i].id;
                if !wanted.iter().any(|(k, _)| *k == id) {
                    let old = self.resident.swap_remove(i);
                    self.bytes -= old.block.size();
                    self.bind(id, std::ptr::null_mut(), draws);
                    old.block.free();
                    self.evicted += 1;
                } else {
                    i += 1;
                }
            }
        }
        if let Ok(result) = self.receive.try_recv() {
            self.loading = None;
            self.max_io_ms = self.max_io_ms.max(result.ms);
            match result.data {
                Ok(data) => {
                    if wanted.iter().any(|(id, _)| *id == result.id) {
                        let rounded = data.len().next_multiple_of(4096);
                        if self.bytes + rounded > self.plan.budget_bytes as usize {
                            self.error = Some("geometry residency budget exceeded".into());
                        } else {
                            match Block::new(Kind::Main, data.len()) {
                                Ok(block) => {
                                    std::ptr::copy_nonoverlapping(
                                        data.as_ptr(),
                                        block.base(),
                                        data.len(),
                                    );
                                    self.bind(result.id, block.base(), draws);
                                    self.bytes += block.size();
                                    self.resident.push(Resident {
                                        id: result.id,
                                        block,
                                    });
                                    self.loaded += 1;
                                }
                                Err(e) => self.error = Some(e),
                            }
                        }
                    }
                }
                Err(e) => self.error = Some(e),
            }
        }
        if self.loading.is_none() && self.error.is_none() {
            if let Some(&(id, _)) = wanted.iter().find(|(id, _)| !self.has(*id)) {
                let page = self.plan.pages[id].clone();
                let path = format!("{}/{}", self.dir, page.file);
                if self.send.try_send((id, path, page)).is_ok() {
                    self.loading = Some(id);
                }
            }
        }
        self.ready = self.error.is_none()
            && wanted
                .iter()
                .filter(|(_, d)| *d < self.plan.view_m.powi(2))
                .all(|(i, _)| self.has(*i));
        if !self.ready {
            self.stalls += 1;
        }
    }
    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"ready":self.ready,"residentPages":self.resident.len(),"totalPages":self.plan.pages.len(),"residentBytes":self.bytes,"budgetBytes":self.plan.budget_bytes,"loaded":self.loaded,"evicted":self.evicted,"waitFrames":self.stalls,"maxIoMs":self.max_io_ms,"error":self.error})
    }
    /// Caller has finished all queued draws.
    pub unsafe fn release(self) {
        for r in self.resident {
            r.block.free();
        }
    }
}
