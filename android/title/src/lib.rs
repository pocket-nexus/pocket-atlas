//! The Pocket3D title card as the Android shell calls it. The frames are
//! `pocket3d_title::draw`'s: rows from the top, four bytes a pixel.
#![no_std]
use pocket3d_title::{Layout, Surface};

#[no_mangle]
pub extern "C" fn atlas_title_ticks() -> u32 {
    pocket3d_title::TICKS
}

/// Whether the frame at `tick` differs from the one before it.
#[no_mangle]
pub extern "C" fn atlas_title_changed(tick: u32) -> i32 {
    pocket3d_title::changed(tick) as i32
}

/// # Safety
/// `pixels` points at `length` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn atlas_title_draw(pixels: *mut u8, length: usize, width: u32, height: u32, tick: u32) -> i32 {
    if pixels.is_null() {
        return 0;
    }
    let mut surface = Surface { pixels: core::slice::from_raw_parts_mut(pixels, length), width, height, stride: width, layout: Layout::Rgba8 };
    pocket3d_title::draw(&mut surface, tick) as i32
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    extern "C" {
        fn abort() -> !;
    }
    unsafe { abort() }
}
