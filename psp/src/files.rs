//! The program's files: inside its own EBOOT.PBP, beside it, or on the
//! PSPLINK share.
//!
//! A release is one EBOOT.PBP. Its DATA.PSAR section (from the eighth offset
//! of the PBP's table to the end of the file) holds the interface, the
//! globe's surface and every place: a `PKAR` index of 64-byte entries (name,
//! offset from the section's start, size), then the files, each at a
//! multiple of 64 bytes. `locate` opens the EBOOT and reads the index, and
//! every file in it is read from that one handle by offset and size.
//!
//! The PSP keeps a current directory for each thread. rust-psp changes it to
//! the EBOOT's folder on the thread it starts `psp_main` on, and Pocket Atlas
//! runs on a worker thread of its own (the guest's parser needs its stack),
//! where a relative name finds nothing. From the XMB that left the interface,
//! the globe's surface and every place unread: a blue disc and no interface.
//! Under PSPLINK the files were found on `host0:` instead, so the fault did
//! not show there. So `locate` opens the files on the starting thread, as
//! Pocket Tokyo's store does, and keeps each handle open: a handle serves
//! every thread of the process.
//!
//! Files beside the EBOOT stay a fallback for development: the interface's
//! are kept open, a place is only listed (its name and size), because the
//! Memory Stick refuses to open more than about ten files at once and a
//! handle kept for every place left the later ones "missing". The starting
//! thread then `serve`s: it opens a place's pack when the worker asks for it,
//! and the worker closes it once read. A file found in neither is looked for
//! on the PSPLINK share (`main.rs`). Nothing here allocates.

use core::sync::atomic::{AtomicBool, Ordering};
use psp::sys::*;

/// The longest file name kept, terminator included.
const NAME: usize = 64;
/// How many files are kept or listed: the interface's two, the globe's
/// surface, the interface's settings and the places.
const MAX: usize = 32;
/// The package index's magic, its entry size and the alignment of its files.
const MAGIC: &[u8; 4] = b"PKAR";
const ENTRY: usize = 64;

#[derive(Clone, Copy)]
struct Kept {
    name: [u8; NAME],
    length: usize,
    fd: SceUid,
    /// Where the file starts in `fd` (in the package), and its size.
    offset: u32,
    bytes: usize,
    packed: bool,
}

const NONE: Kept = Kept { name: [0; NAME], length: 0, fd: SceUid(-1), offset: 0, bytes: 0, packed: false };
static mut KEPT: [Kept; MAX] = [NONE; MAX];
static mut COUNT: usize = 0;

/// The settings file, kept open for reading and writing beside the EBOOT.
pub const PREFS: &str = "interface.json";

/// Where a file was found, as the status names it.
#[derive(Clone, Copy, PartialEq)]
pub enum Source {
    Package,
    Folder,
    Share,
}
impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Source::Package => "EBOOT.PBP",
            Source::Folder => "folder",
            Source::Share => "host0",
        }
    }
}

/// A file to read: its handle, where it starts, its size, and whether the
/// reader closes the handle when done.
pub struct File {
    pub fd: SceUid,
    pub offset: u32,
    pub size: usize,
    pub owned: bool,
    pub source: Source,
}

fn listed(name: &str) -> Option<&'static Kept> {
    let kept = unsafe { &*core::ptr::addr_of!(KEPT) };
    kept[..unsafe { COUNT }].iter().find(|k| &k.name[..k.length] == name.as_bytes())
}

/// Keeps `name` open beside the EBOOT, or only lists it (`flags` None).
unsafe fn keep(name: &[u8], flags: Option<IoOpenFlags>, bytes: usize) {
    if COUNT == MAX || name.len() + 1 > NAME {
        return;
    }
    let mut path = [0u8; NAME];
    path[..name.len()].copy_from_slice(name);
    let only_listed = flags.is_none();
    let fd = match flags {
        Some(flags) => sceIoOpen(path.as_ptr(), flags, 0o666),
        None => SceUid(-1),
    };
    if fd.0 < 0 && !only_listed {
        return;
    }
    KEPT[COUNT] = Kept { name: path, length: name.len(), fd, offset: 0, bytes, packed: false };
    COUNT += 1;
}

/// The files inside the EBOOT's DATA.PSAR, kept as ranges of its handle.
unsafe fn read_package() {
    let fd = sceIoOpen(b"EBOOT.PBP\0".as_ptr(), IoOpenFlags::RD_ONLY, 0);
    if fd.0 < 0 {
        return;
    }
    let mut table = [0u8; 40];
    let size = sceIoLseek32(fd, 0, IoWhence::End).max(0) as usize;
    sceIoLseek32(fd, 0, IoWhence::Set);
    let word = |b: &[u8], at: usize| u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as usize;
    let mut head = [0u8; 16];
    let found = sceIoRead(fd, table.as_mut_ptr() as _, 40) == 40 && &table[..4] == b"\0PBP" && {
        let section = word(&table, 8 + 7 * 4);
        section + 16 <= size
            && sceIoLseek32(fd, section as i32, IoWhence::Set) == section as i32
            && sceIoRead(fd, head.as_mut_ptr() as _, 16) == 16
            && &head[..4] == MAGIC
    };
    if !found {
        sceIoClose(fd);
        return;
    }
    let section = word(&table, 8 + 7 * 4);
    let count = word(&head, 8).min(MAX);
    let mut entry = [0u8; ENTRY];
    let mut kept = 0;
    for _ in 0..count {
        if sceIoRead(fd, entry.as_mut_ptr() as _, ENTRY as u32) != ENTRY as i32 || COUNT == MAX {
            break;
        }
        let length = entry[..48].iter().position(|&c| c == 0).unwrap_or(48);
        let (offset, bytes) = (section + word(&entry, 48), word(&entry, 52));
        if length == 0 || length + 1 > NAME || offset + bytes > size {
            continue;
        }
        let mut name = [0u8; NAME];
        name[..length].copy_from_slice(&entry[..length]);
        KEPT[COUNT] = Kept { name, length, fd, offset: offset as u32, bytes, packed: true };
        COUNT += 1;
        kept += 1;
    }
    if kept == 0 {
        sceIoClose(fd);
    }
}

/// Opens the files inside and beside the EBOOT. Call on the thread
/// `psp_main` runs on, before the worker starts.
pub unsafe fn locate() {
    read_package();
    for name in ["atlas.js", "atlas.pak", "globe.psp"] {
        if listed(name).is_none() {
            keep(name.as_bytes(), Some(IoOpenFlags::RD_ONLY), 0);
        }
    }
    // Only where the interface is: the settings are made on the first save.
    if listed("atlas.pak").is_some() {
        keep(PREFS.as_bytes(), Some(IoOpenFlags::RD_WR | IoOpenFlags::CREAT), 0);
    }
    let dir = sceIoDopen(b".\0".as_ptr());
    if dir.0 < 0 {
        return;
    }
    let mut entry: SceIoDirent = core::mem::zeroed();
    while sceIoDread(dir, &mut entry) > 0 {
        let length = entry.d_name.iter().position(|&c| c == 0).unwrap_or(0);
        let name = &entry.d_name[..length];
        if name.ends_with(b".place") && core::str::from_utf8(name).is_ok_and(|n| listed(n).is_none()) {
            keep(name, None, entry.d_stat.st_size as usize);
        }
        entry = core::mem::zeroed();
    }
    sceIoDclose(dir);
}

/// `name` inside or beside the EBOOT, at its start. A place beside it is
/// opened by the starting thread while it `serve`s, or here when the
/// program runs on it; the reader closes that one.
pub unsafe fn open(name: &str) -> Option<File> {
    let k = listed(name)?;
    if k.packed {
        sceIoLseek32(k.fd, k.offset as i32, IoWhence::Set);
        return Some(File { fd: k.fd, offset: k.offset, size: k.bytes, owned: false, source: Source::Package });
    }
    let (fd, owned) = if k.fd.0 >= 0 {
        (k.fd, false)
    } else if SERVING.load(Ordering::Acquire) {
        *core::ptr::addr_of_mut!(ASKED) = k.name;
        sceKernelSignalSema(REQUEST, 1);
        sceKernelWaitSema(REPLY, 1, core::ptr::null_mut());
        (*core::ptr::addr_of!(OPENED), true)
    } else {
        (sceIoOpen(k.name.as_ptr(), IoOpenFlags::RD_ONLY, 0o666), true)
    };
    if fd.0 < 0 {
        return None;
    }
    let size = sceIoLseek32(fd, 0, IoWhence::End).max(0) as usize;
    sceIoLseek32(fd, 0, IoWhence::Set);
    Some(File { fd, offset: 0, size, owned, source: Source::Folder })
}

static SERVING: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);
static mut REQUEST: SceUid = SceUid(-1);
static mut REPLY: SceUid = SceUid(-1);
static mut ASKED: [u8; NAME] = [0; NAME];
static mut OPENED: SceUid = SceUid(-1);

/// Runs `entry` on a thread of its own (`pocketjs_main`: 1 MB of stack for
/// the guest's parser) and opens places for it on this thread, which has the
/// EBOOT's folder, until it returns. False when the thread could not start.
pub unsafe fn serve(entry: unsafe extern "C" fn(usize, *mut core::ffi::c_void) -> i32) -> bool {
    REQUEST = sceKernelCreateSema(b"atlas_open\0".as_ptr(), 0, 0, 1, core::ptr::null_mut());
    REPLY = sceKernelCreateSema(b"atlas_opened\0".as_ptr(), 0, 0, 1, core::ptr::null_mut());
    let id = sceKernelCreateThread(
        b"pocketjs_main\0".as_ptr(),
        entry,
        32,
        1024 * 1024,
        ThreadAttributes::USER | ThreadAttributes::VFPU,
        core::ptr::null_mut(),
    );
    if REQUEST.0 < 0 || REPLY.0 < 0 || id.0 < 0 {
        return false;
    }
    SERVING.store(true, Ordering::Release);
    sceKernelStartThread(id, 0, core::ptr::null_mut());
    loop {
        sceKernelWaitSema(REQUEST, 1, core::ptr::null_mut());
        if DONE.load(Ordering::Acquire) {
            break;
        }
        OPENED = sceIoOpen(core::ptr::addr_of!(ASKED) as *const u8, IoOpenFlags::RD_ONLY, 0o666);
        sceKernelSignalSema(REPLY, 1);
    }
    sceKernelWaitThreadEnd(id, core::ptr::null_mut());
    true
}

/// Ends `serve`: the worker's last call.
pub unsafe fn finished() {
    if SERVING.load(Ordering::Acquire) {
        DONE.store(true, Ordering::Release);
        sceKernelSignalSema(REQUEST, 1);
    }
}

/// The places inside and beside the EBOOT: each id and the size of its pack.
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
    let Some(k) = listed(PREFS).filter(|k| !k.packed && k.fd.0 >= 0) else { return false };
    let fd = k.fd;
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
