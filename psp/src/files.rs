//! The files beside the EBOOT, opened on the thread the program starts on.
//!
//! The PSP keeps a current directory for each thread. rust-psp changes it to
//! the EBOOT's folder on the thread it starts `psp_main` on, and Pocket Atlas
//! runs on a worker thread of its own (the guest's parser needs its stack),
//! where a relative name finds nothing. From the XMB that left the interface,
//! the globe's surface and every place unread: a blue disc and no interface.
//! Under PSPLINK the files were found on `host0:` instead, so the fault did
//! not show there.
//!
//! So `locate` opens them on the starting thread, as Pocket Tokyo's store
//! does, and keeps each handle open: a handle serves every thread of the
//! process. It allocates nothing. A file not found beside the EBOOT is looked
//! for on the PSPLINK share when it is asked for (`main.rs`).

use psp::sys::*;

/// The longest file name kept, terminator included.
const NAME: usize = 64;
/// How many files are kept open: the interface's two, the globe's surface,
/// the interface's settings and the places.
const MAX: usize = 32;

#[derive(Clone, Copy)]
struct Kept {
    name: [u8; NAME],
    length: usize,
    fd: SceUid,
    /// The size the directory listed, for a place.
    bytes: usize,
}

const NONE: Kept = Kept { name: [0; NAME], length: 0, fd: SceUid(-1), bytes: 0 };
static mut KEPT: [Kept; MAX] = [NONE; MAX];
static mut COUNT: usize = 0;

/// The settings file, kept open for reading and writing.
pub const PREFS: &str = "interface.json";

unsafe fn keep(name: &[u8], flags: IoOpenFlags, bytes: usize) {
    if COUNT == MAX || name.len() + 1 > NAME {
        return;
    }
    let mut path = [0u8; NAME];
    path[..name.len()].copy_from_slice(name);
    let fd = sceIoOpen(path.as_ptr(), flags, 0o666);
    if fd.0 < 0 {
        return;
    }
    KEPT[COUNT] = Kept { name: path, length: name.len(), fd, bytes };
    COUNT += 1;
}

/// Opens the files beside the EBOOT. Call on the thread `psp_main` runs on,
/// before the worker starts.
pub unsafe fn locate() {
    for name in [&b"atlas.js"[..], b"atlas.pak", b"globe.psp"] {
        keep(name, IoOpenFlags::RD_ONLY, 0);
    }
    // Only where the interface is: the settings are made on the first save.
    if kept("atlas.pak").is_some() {
        keep(PREFS.as_bytes(), IoOpenFlags::RD_WR | IoOpenFlags::CREAT, 0);
    }
    let dir = sceIoDopen(b".\0".as_ptr());
    if dir.0 < 0 {
        return;
    }
    let mut entry: SceIoDirent = core::mem::zeroed();
    while sceIoDread(dir, &mut entry) > 0 {
        let length = entry.d_name.iter().position(|&c| c == 0).unwrap_or(0);
        let name = &entry.d_name[..length];
        if name.ends_with(b".place") {
            keep(name, IoOpenFlags::RD_ONLY, entry.d_stat.st_size as usize);
        }
        entry = core::mem::zeroed();
    }
    sceIoDclose(dir);
}

/// The handle of a file kept beside the EBOOT, at its start.
pub unsafe fn kept(name: &str) -> Option<SceUid> {
    let kept = &*core::ptr::addr_of!(KEPT);
    let found = kept[..COUNT].iter().find(|k| &k.name[..k.length] == name.as_bytes())?;
    sceIoLseek32(found.fd, 0, IoWhence::Set);
    Some(found.fd)
}

/// The places kept beside the EBOOT: each id and the size of its pack.
pub unsafe fn places() -> impl Iterator<Item = (&'static str, usize)> {
    let kept = &*core::ptr::addr_of!(KEPT);
    kept[..COUNT].iter().filter_map(|k| {
        let name = core::str::from_utf8(&k.name[..k.length]).ok()?;
        Some((name.strip_suffix(".place")?, k.bytes))
    })
}

/// Writes the settings over the kept file. A shorter text than the last is
/// followed by spaces to the old length, which the interface's JSON reader
/// skips: the PSP has no call that shortens an open file. False when the
/// settings are not kept here.
pub unsafe fn write_prefs(bytes: &[u8]) -> bool {
    let Some(fd) = kept(PREFS) else { return false };
    let old = sceIoLseek32(fd, 0, IoWhence::End).max(0) as usize;
    sceIoLseek32(fd, 0, IoWhence::Set);
    sceIoWrite(fd, bytes.as_ptr() as _, bytes.len());
    let mut left = old.saturating_sub(bytes.len());
    let spaces = [b' '; 64];
    while left > 0 {
        let n = left.min(spaces.len());
        sceIoWrite(fd, spaces.as_ptr() as _, n);
        left -= n;
    }
    true
}
