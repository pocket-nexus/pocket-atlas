//! A route pack on the memory card: its table, the driven line and the cell
//! index are read once; the kit is loaded as a place; cells are read by the
//! streaming thread on demand.
//!
//! Cells need seeks, which the USB host file system does not serve: a
//! development build copies a pack from the share to the data folder first
//! (`sync`), guided by a stamp file that changes when the pack does.

use pocket3d_drive::Line;
use pocket3d_place::route as rt;

use crate::hostfs;
use crate::paths;
use crate::scene::{find, Seq};

pub struct RoutePack {
    pub path: String,
    pub meta: rt::RouteMeta,
    pub cells: Vec<rt::CellEntry>,
    pub line: Line,
    /// Where the kit's place pack and the cell blobs start in the file.
    pub kit_at: u64,
    pub cells_at: u64,
}

/// Where a route's pack is looked for, in order: the package, then the data folder.
pub fn paths(id: &str) -> Vec<String> {
    vec![format!("app0:routes/{id}.route"), format!("{}/routes/{id}.route", paths::DATA)]
}

/// Whether `id` names a route: a pack in the package or the data folder, or
/// (development builds) one on the USB share.
pub fn exists(id: &str) -> bool {
    paths(id).iter().any(|p| std::fs::File::open(p).is_ok()) || (cfg!(feature = "usb-debug") && hostfs::read(&format!("host0:atlas/routes/{id}.stamp"), 256).is_some())
}

/// Development builds: copies `host0:atlas/routes/<id>.route` to the data
/// folder when the share's stamp differs from the copy's. `progress(done)`
/// is called every few megabytes.
pub fn sync(id: &str, mut progress: impl FnMut(u64)) -> Result<(), String> {
    if !cfg!(feature = "usb-debug") {
        return Ok(());
    }
    let Some(stamp) = hostfs::read(&format!("host0:atlas/routes/{id}.stamp"), 256) else { return Ok(()) };
    let dir = format!("{}/routes", paths::DATA);
    let (to, mark) = (format!("{dir}/{id}.route"), format!("{dir}/{id}.stamp"));
    if std::fs::read(&mark).ok().as_deref() == Some(&stamp[..]) && std::fs::File::open(&to).is_ok() {
        return Ok(());
    }
    use std::io::{Read, Write};
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::remove_file(&mark);
    let mut src = std::fs::File::open(format!("host0:atlas/routes/{id}.route")).map_err(|e| format!("host0:atlas/routes/{id}.route: {e}"))?;
    let tmp = format!("{to}.tmp");
    let mut dst = std::fs::File::create(&tmp).map_err(|e| format!("{tmp}: {e}"))?;
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).map_err(|e| format!("{tmp}: {e}"))?;
        done += n as u64;
        progress(done);
    }
    drop(dst);
    let _ = std::fs::remove_file(&to);
    std::fs::rename(&tmp, &to).map_err(|e| format!("{to}: {e}"))?;
    std::fs::write(&mark, &stamp).map_err(|e| format!("{mark}: {e}"))
}

impl RoutePack {
    pub fn open(path: &str) -> Result<Self, String> {
        let mut f = Seq::open(path)?;
        let sections = f.sections_versioned(rt::MAGIC, rt::VERSION)?;
        let meta_bytes = f.section(&find(&sections, rt::TAG_META)?)?;
        let meta: rt::RouteMeta = serde_json::from_slice(&meta_bytes).map_err(|e| format!("{path}: META: {e}"))?;
        let kit = find(&sections, rt::TAG_KIT)?;
        let line = Line::decode(&f.section(&find(&sections, rt::TAG_LINE)?)?)?;
        let cells = rt::CellEntry::decode_all(&f.section(&find(&sections, rt::TAG_INDEX)?)?);
        let cell_section = find(&sections, rt::TAG_CELLS)?;
        if cells.iter().any(|c| c.offset as u64 + c.size as u64 > cell_section.size as u64 || c.layer as usize >= meta.layers.len()) {
            return Err(format!("{path}: cell index out of range"));
        }
        Ok(Self { path: path.into(), meta, cells, line, kit_at: kit.offset as u64, cells_at: cell_section.offset as u64 })
    }
}
