//! Host regression harness for the real iPod scene loader and pack validators.
//! The scene module supplies its GLES mocks only under `cfg(test)`.
#![allow(dead_code)]

extern crate alloc;

#[path = "../../src/gl.rs"]
mod gl;
#[path = "../../src/scene.rs"]
mod scene;
#[path = "../../src/validation.rs"]
mod validation;
#[path = "../../src/gpu.rs"]
mod gpu;
#[path = "../../src/effects.rs"]
mod effects;
#[path = "../../src/state.rs"]
mod state;
#[cfg(test)]
mod state_tests;
fn read(path: &str) -> Result<alloc::vec::Vec<u8>,alloc::string::String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

// C long is 32-bit on the iPod, but may be 64-bit on the host. Keep the actual
// libc declaration correct and expose the device-sized result to the loader.
use core::ffi::{c_char, c_int, c_long, c_void};
extern "C" {
    fn fopen(path: *const c_char, mode: *const c_char) -> *mut c_void;
    fn fclose(file: *mut c_void) -> c_int;
    fn fread(data: *mut c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    #[link_name = "fseek"]
    fn host_fseek(file: *mut c_void, offset: c_long, whence: c_int) -> c_int;
    #[link_name = "ftell"]
    fn host_ftell(file: *mut c_void) -> c_long;
}

unsafe fn fseek(file: *mut c_void, offset: i32, whence: i32) -> i32 {
    host_fseek(file, c_long::from(offset), whence)
}

unsafe fn ftell(file: *mut c_void) -> i32 {
    i32::try_from(host_ftell(file)).unwrap_or(-1)
}

#[cfg(test)]
fn test_artifact_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.pocket-build/validation/ipod-scene-tests")
}
