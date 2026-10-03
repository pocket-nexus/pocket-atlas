#![no_std]
extern crate alloc;
mod app;
mod effects;
mod gl;
mod globe;
mod gpu;
mod light_lod;
mod mesh_batch;
mod mesh_clusters;
mod performance;
mod pipelines;
mod renderer;
mod scene;
mod shadow;
mod state;
mod texture_usage;
mod validation;
use alloc::{ffi::CString, format, string::String, vec, vec::Vec};
use core::{
    alloc::{GlobalAlloc, Layout},
    ffi::{c_char, c_void},
    ptr,
};
struct Allocator;
extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(p: *mut c_void);
    fn posix_memalign(p: *mut *mut c_void, align: usize, size: usize) -> i32;
    pub fn atlas_seconds() -> f64;
    fn abort() -> !;
    fn atlas_log(s: *const c_char);
    fn fopen(path: *const c_char, mode: *const c_char) -> *mut c_void;
    fn fclose(f: *mut c_void) -> i32;
    fn fseek(f: *mut c_void, n: i32, whence: i32) -> i32;
    fn ftell(f: *mut c_void) -> i32;
    fn fread(p: *mut c_void, size: usize, n: usize, f: *mut c_void) -> usize;
}
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if l.align() <= 16 {
            malloc(l.size()) as _
        } else {
            let mut p = ptr::null_mut();
            if posix_memalign(&mut p, l.align(), l.size()) == 0 {
                p as _
            } else {
                ptr::null_mut()
            }
        }
    }
    unsafe fn dealloc(&self, p: *mut u8, _: Layout) {
        free(p as _);
    }
}
#[global_allocator]
static ALLOC: Allocator = Allocator;
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    unsafe {
        let s = CString::new(format!("{info}")).unwrap();
        atlas_log(s.as_ptr());
        abort()
    }
}
pub fn read(path: &str) -> Result<Vec<u8>, String> {
    unsafe {
        let p = CString::new(path).map_err(|_| String::from("file path"))?;
        let f = fopen(p.as_ptr(), b"rb\0".as_ptr() as _);
        if f.is_null() {
            return Err(format!("Cannot open {path}"));
        }
        fseek(f, 0, 2);
        let n = ftell(f);
        fseek(f, 0, 0);
        if n < 0 || n > 192 * 1024 * 1024 {
            fclose(f);
            return Err(String::from("file size"));
        }
        let mut b = vec![0u8; n as usize];
        let got = fread(b.as_mut_ptr() as _, 1, b.len(), f);
        fclose(f);
        if got != b.len() {
            return Err(String::from("file read"));
        }
        Ok(b)
    }
}
struct RenderOwner(core::cell::UnsafeCell<Option<app::App>>);
// The platform serializes all entries on its render worker. Initialization and
// shutdown may transfer ownership only while the worker is stopped/joined.
// UIKit reads copied snapshots; it never accesses App or these CString pointers.
unsafe impl Sync for RenderOwner {}
static APP: RenderOwner = RenderOwner(core::cell::UnsafeCell::new(None));
#[no_mangle]
pub unsafe extern "C" fn atlas_init(root: *const c_char) -> i32 {
    *APP.0.get() = Some(app::App::new(
        core::ffi::CStr::from_ptr(root)
            .to_string_lossy()
            .into_owned(),
    ));
    1
}
#[no_mangle]
pub unsafe extern "C" fn atlas_frame(dt: f32, w: i32, h: i32, fbo: u32) {
    if let Some(a) = &mut *APP.0.get() {
        a.frame(dt, w, h, fbo);
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_frame_completed(render_ms: f32, present_ms: f32, interval_ms: f32) {
    if let Some(a) = &mut *APP.0.get() {
        a.frame_completed(render_ms, present_ms, interval_ms);
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_drawable_changed() {
    if let Some(a) = &mut *APP.0.get() {
        a.drawable_changed();
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_hdr_target(fbo: *mut u32, width: *mut i32, height: *mut i32) -> i32 {
    if fbo.is_null() || width.is_null() || height.is_null() { return 0; }
    if let Some((target,w,h,performance)) = (*APP.0.get()).as_ref().and_then(|a|a.hdr_target()) {
        // Preserve the C signature: 0 absent, 1 full HDR, 2 display-prelit.
        *fbo=target; *width=w; *height=h; if performance {2} else {1}
    } else {0}
}
#[no_mangle]
pub unsafe extern "C" fn atlas_memory_warning() {
    if let Some(a) = &mut *APP.0.get() { a.memory_warning(); }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_suspend() {
    if let Some(a) = &mut *APP.0.get() {
        a.suspend();
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_status() -> *const c_char {
    if let Some(a) = &mut *APP.0.get() {
        a.refresh_status();
        a.status.as_ptr()
    } else {
        b"{}\0".as_ptr() as _
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_text(i: i32, field: i32) -> *const c_char {
    (*APP.0.get())
        .as_ref()
        .map(|a| a.text(i, field))
        .unwrap_or(b"\0".as_ptr() as _)
}
#[no_mangle]
pub unsafe extern "C" fn atlas_action(action: i32) {
    if let Some(a) = &mut *APP.0.get() {
        a.action(action);
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_command(command: *const c_char) {
    if let Some(a) = &mut *APP.0.get() {
        a.command(core::ffi::CStr::from_ptr(command).to_bytes());
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_touch(phase: i32, x: f32, y: f32, id: i32) {
    if let Some(a) = &mut *APP.0.get() {
        a.touch(phase, x, y, id);
    }
}
#[no_mangle]
pub unsafe extern "C" fn atlas_shutdown() {
    if let Some(a) = &mut *APP.0.get() {
        a.save_user_state();
    }
    *APP.0.get() = None;
}

#[no_mangle]
pub unsafe extern "C" fn atlas_value(field: i32) -> i32 {
    (*APP.0.get()).as_ref().map(|a| a.value(field)).unwrap_or(0)
}
