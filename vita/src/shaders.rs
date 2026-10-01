//! Shader programs. Cg sources are embedded in the executable and, during
//! development, replaced by the copies in the USB share (`host0:atlas/shaders`)
//! so edits on the computer recompile on the device without a rebuild. A
//! worker thread compiles with SceShaccCg and caches every GXP by a hash of
//! its expanded source and defines: `host0:atlas/gxp/<hash>.gxp` in
//! development, `app0:gxp/<hash>.gxp` in packaged builds, which therefore run
//! without the runtime compiler.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pocket3d_gxm::shacccg::{Compiler, Stage};

pub const SOURCES: &[(&str, &str)] = &[
    ("common.cgh", include_str!("../shaders/common.cgh")),
    ("surface_v.cg", include_str!("../shaders/surface_v.cg")),
    ("standard_f.cg", include_str!("../shaders/standard_f.cg")),
    ("unlit_f.cg", include_str!("../shaders/unlit_f.cg")),
    ("glass_f.cg", include_str!("../shaders/glass_f.cg")),
    ("window_f.cg", include_str!("../shaders/window_f.cg")),
    ("products_f.cg", include_str!("../shaders/products_f.cg")),
    ("skyline_f.cg", include_str!("../shaders/skyline_f.cg")),
    ("tower_f.cg", include_str!("../shaders/tower_f.cg")),
    ("sky_v.cg", include_str!("../shaders/sky_v.cg")),
    ("sky_f.cg", include_str!("../shaders/sky_f.cg")),
    ("fx_v.cg", include_str!("../shaders/fx_v.cg")),
    ("fx_f.cg", include_str!("../shaders/fx_f.cg")),
    ("post_v.cg", include_str!("../shaders/post_v.cg")),
    ("haze_f.cg", include_str!("../shaders/haze_f.cg")),
    ("prefilter_f.cg", include_str!("../shaders/prefilter_f.cg")),
    ("down_f.cg", include_str!("../shaders/down_f.cg")),
    ("up_f.cg", include_str!("../shaders/up_f.cg")),
    ("composite_f.cg", include_str!("../shaders/composite_f.cg")),
    ("globe_v.cg", include_str!("../shaders/globe_v.cg")),
    ("globe_f.cg", include_str!("../shaders/globe_f.cg")),
    ("marker_v.cg", include_str!("../shaders/marker_v.cg")),
    ("marker_f.cg", include_str!("../shaders/marker_f.cg")),
    ("ui_v.cg", include_str!("../shaders/ui_v.cg")),
    ("ui_f.cg", include_str!("../shaders/ui_f.cg")),
    ("shadow_f.cg", include_str!("../shaders/shadow_f.cg")),
    ("fill_f.cg", include_str!("../shaders/fill_f.cg")),
    ("sky_day_f.cg", include_str!("../shaders/sky_day_f.cg")),
    ("blit_f.cg", include_str!("../shaders/blit_f.cg")),
    ("debug_f.cg", include_str!("../shaders/debug_f.cg")),
];

const SHARE: &str = "host0:atlas";

/// A program: source file plus preprocessor definitions ("NAME" or "NAME=V").
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Key {
    pub file: &'static str,
    pub defines: Vec<String>,
}

impl Key {
    pub fn new(file: &'static str, defines: &[&str]) -> Self {
        let mut defines: Vec<String> = defines.iter().map(|d| d.to_string()).collect();
        defines.sort();
        defines.dedup();
        Self { file, defines }
    }

    /// This key with one more definition.
    pub fn with(mut self, define: &str) -> Self {
        self.defines.push(define.to_string());
        self.defines.sort();
        self.defines.dedup();
        self
    }

    pub fn stage(&self) -> Stage {
        if self.file.ends_with("_v.cg") {
            Stage::Vertex
        } else {
            Stage::Fragment
        }
    }

    pub fn label(&self) -> String {
        if self.defines.is_empty() {
            self.file.to_string()
        } else {
            format!("{}[{}]", self.file, self.defines.join(","))
        }
    }
}

pub enum Event {
    Ready { key: Key, gxp: Arc<Vec<u8>>, hash: u64, compiled_ms: Option<u32> },
    Failed { key: Key, error: String },
    /// Compiler state after start-up: version or why it is missing.
    Compiler(Result<String, String>),
}

fn fnv(bytes: &[u8], mut h: u64) -> u64 {
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// Inlines `#include "name"` lines (one level deep is all the library uses,
/// recursion is supported anyway).
fn expand(name: &str, sources: &HashMap<String, String>, depth: u32) -> Result<String, String> {
    let src = sources.get(name).ok_or_else(|| format!("missing shader source {name}"))?;
    if depth > 4 {
        return Err(format!("{name}: include depth"));
    }
    let mut out = String::with_capacity(src.len() + 4096);
    for (i, line) in src.lines().enumerate() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("#include") {
            let inc = rest.trim().trim_matches('"');
            out.push_str(&format!("#line 1 \"{inc}\"\n"));
            out.push_str(&expand(inc, sources, depth + 1)?);
            // Keep diagnostics' line numbers pointing into the including file.
            out.push_str(&format!("\n#line {} \"{}\"\n", i + 2, name));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    Ok(out)
}

fn read_share(path: &str) -> Option<Vec<u8>> {
    crate::hostfs::read(path, 4 << 20)
}

fn write_share(path: &str, bytes: &[u8]) {
    let _ = crate::hostfs::write(path, bytes);
}

pub struct Service {
    requests: Sender<Key>,
    pub events: Receiver<Event>,
    /// Programs the worker is still rebuilding after a source change.
    pub rebuilding: Arc<AtomicUsize>,
}

impl Service {
    /// `live`: read sources from the USB share and watch them for changes.
    pub fn start(live: bool) -> Self {
        let (req_tx, req_rx) = mpsc::channel::<Key>();
        let (ev_tx, ev_rx) = mpsc::channel::<Event>();
        let rebuilding = Arc::new(AtomicUsize::new(0));
        let busy = rebuilding.clone();
        let _ = std::thread::Builder::new()
            .name("atlas-shaders".into())
            .stack_size(1024 * 1024)
            .spawn(move || worker(live, req_rx, ev_tx, busy));
        Self { requests: req_tx, events: ev_rx, rebuilding }
    }

    pub fn request(&self, key: Key) {
        let _ = self.requests.send(key);
    }
}

fn load_sources(live: bool) -> HashMap<String, String> {
    let mut sources: HashMap<String, String> = SOURCES.iter().map(|(n, s)| (n.to_string(), s.to_string())).collect();
    if live {
        for (name, _) in SOURCES {
            if let Some(bytes) = read_share(&format!("{SHARE}/shaders/{name}")) {
                if let Ok(text) = String::from_utf8(bytes) {
                    sources.insert(name.to_string(), text);
                }
            }
        }
    }
    sources
}

fn build(compiler: Option<&Compiler>, key: &Key, sources: &HashMap<String, String>, memo: &mut HashMap<u64, Arc<Vec<u8>>>) -> (Option<u64>, Event) {
    let src = match expand(key.file, sources, 0) {
        Ok(s) => s,
        Err(error) => return (None, Event::Failed { key: key.clone(), error }),
    };
    let mut h = fnv(src.as_bytes(), 0xcbf2_9ce4_8422_2325);
    for d in &key.defines {
        h = fnv(d.as_bytes(), fnv(b"\0", h));
    }
    h = fnv(if key.stage() == Stage::Vertex { b"v" } else { b"f" }, h);
    if let Some(gxp) = memo.get(&h) {
        return (Some(h), Event::Ready { key: key.clone(), gxp: gxp.clone(), hash: h, compiled_ms: None });
    }
    for dir in [format!("{SHARE}/gxp"), "app0:gxp".to_string()] {
        if let Some(bytes) = read_share(&format!("{dir}/{h:016x}.gxp")) {
            let gxp = Arc::new(bytes);
            memo.insert(h, gxp.clone());
            return (Some(h), Event::Ready { key: key.clone(), gxp, hash: h, compiled_ms: None });
        }
    }
    let Some(compiler) = compiler else {
        return (Some(h), Event::Failed { key: key.clone(), error: format!("{}: no compiler and no cached {h:016x}.gxp", key.label()) });
    };
    let defines: Vec<&str> = key.defines.iter().map(|s| s.as_str()).collect();
    let t = Instant::now();
    match compiler.compile(key.file, &src, key.stage(), &defines) {
        Ok(out) => {
            let ms = t.elapsed().as_millis() as u32;
            let warnings: Vec<String> = out.diagnostics.iter().map(|d| format!("{}:{}:{} {} {}", key.file, d.line, d.column, d.level, d.message)).collect();
            if !warnings.is_empty() {
                write_share(&format!("{SHARE}/gxp/{h:016x}.log"), warnings.join("\n").as_bytes());
            }
            write_share(&format!("{SHARE}/gxp/{h:016x}.gxp"), &out.program);
            write_share(&format!("{SHARE}/gxp/{h:016x}.key"), key.label().as_bytes());
            let gxp = Arc::new(out.program);
            memo.insert(h, gxp.clone());
            (Some(h), Event::Ready { key: key.clone(), gxp, hash: h, compiled_ms: Some(ms) })
        }
        Err(diags) => {
            let text: Vec<String> = diags.iter().map(|d| format!("{}:{}:{} {} {}", key.file, d.line, d.column, d.level, d.message)).collect();
            let error = format!("{}: {}", key.label(), text.join(" | "));
            write_share(&format!("{SHARE}/errors/{}.txt", key.label().replace(['[', ']', ',', '='], "_")), text.join("\n").as_bytes());
            (Some(h), Event::Failed { key: key.clone(), error })
        }
    }
}

/// `build`, loading the compiler again and retrying once when it hit an
/// internal error (it then fails every later program until reloaded).
fn build_retry(compiler: &mut Option<Compiler>, key: &Key, sources: &HashMap<String, String>, memo: &mut HashMap<u64, Arc<Vec<u8>>>) -> (Option<u64>, Event) {
    let first = build(compiler.as_ref(), key, sources, memo);
    if !matches!(&first.1, Event::Failed { error, .. } if error.contains("fatal internal error")) {
        return first;
    }
    if let Some(c) = compiler.take() {
        c.unload();
    }
    *compiler = Compiler::load().ok();
    build(compiler.as_ref(), key, sources, memo)
}

fn worker(live: bool, requests: Receiver<Key>, events: Sender<Event>, rebuilding: Arc<AtomicUsize>) {
    let compiler = Compiler::load();
    let _ = events.send(Event::Compiler(compiler.as_ref().map(|c| c.version.clone()).map_err(|e| e.clone())));
    let mut compiler = compiler.ok();
    let mut last_provision = Instant::now();
    let mut sources = load_sources(live);
    let mut known: Vec<(Key, u64)> = Vec::new();
    let mut memo: HashMap<u64, Arc<Vec<u8>>> = HashMap::new();
    let mut last_watch = Instant::now();
    // One small stamp file (written by `atlas.ts sync`) is polled instead of
    // every source: the USB channel is shared with the debug link.
    let mut stamp = if live { read_share(&format!("{SHARE}/shaders/stamp")) } else { None };

    loop {
        match requests.recv_timeout(Duration::from_millis(250)) {
            Ok(key) => {
                if known.iter().any(|(k, _)| *k == key) {
                    continue;
                }
                let (h, ev) = build_retry(&mut compiler, &key, &sources, &mut memo);
                known.push((key, h.unwrap_or(0)));
                if events.send(ev).is_err() {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        // Without the runtime compiler, keep provisioning it; once it loads,
        // every program seen so far is built again.
        if live && compiler.is_none() && last_provision.elapsed() > Duration::from_secs(2) {
            last_provision = Instant::now();
            let status = crate::provision::step();
            match Compiler::load() {
                Ok(c) => {
                    let _ = events.send(Event::Compiler(Ok(c.version.clone())));
                    compiler = Some(c);
                    for i in 0..known.len() {
                        let key = known[i].0.clone();
                        let (h, ev) = build_retry(&mut compiler, &key, &sources, &mut memo);
                        known[i].1 = h.unwrap_or(0);
                        if events.send(ev).is_err() {
                            return;
                        }
                    }
                }
                Err(e) => {
                    let _ = events.send(Event::Compiler(Err(format!("{e}; {status}"))));
                }
            }
        }
        if live && last_watch.elapsed() > Duration::from_millis(1000) {
            last_watch = Instant::now();
            let now = read_share(&format!("{SHARE}/shaders/stamp"));
            if now.is_none() || now == stamp {
                continue;
            }
            stamp = now;
            let fresh = load_sources(true);
            if fresh != sources {
                sources = fresh;
                for i in 0..known.len() {
                    rebuilding.store(known.len() - i, Ordering::Relaxed);
                    let key = known[i].0.clone();
                    let (h, ev) = build_retry(&mut compiler, &key, &sources, &mut memo);
                    if let Some(h) = h {
                        if h == known[i].1 {
                            continue;
                        }
                        known[i].1 = h;
                    }
                    if events.send(ev).is_err() {
                        return;
                    }
                }
                rebuilding.store(0, Ordering::Relaxed);
            }
        }
    }
}
