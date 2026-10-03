//! Procedural rain bed on its own blocking audio thread. No file streaming
//! or USB work occurs on the mixer; walking indoors muffles the rain.
use core::{
    ffi::c_void,
    ptr,
    sync::atomic::{AtomicU32, Ordering},
};
use psp::{sys::*, Align16};
pub static LEVEL: AtomicU32 = AtomicU32::new(0);
pub static CHIME: AtomicU32 = AtomicU32::new(0);
pub unsafe fn start() {
    let id = sceKernelCreateThread(
        b"atlas_rain\0".as_ptr(),
        mix,
        24,
        16384,
        ThreadAttributes::USER,
        ptr::null_mut(),
    );
    if id.0 >= 0 {
        sceKernelStartThread(id, 0, ptr::null_mut());
    }
}
unsafe extern "C" fn mix(_: usize, _: *mut c_void) -> i32 {
    let channel = sceAudioChReserve(-1, 1024, AudioFormat::Stereo);
    if channel < 0 {
        return 0;
    }
    let mut buffer = Align16([0i16; 2048]);
    let mut seed = 0x192fe3u32;
    let mut low = 0.0f32;
    let mut body = 0.0f32;
    let mut gain = 0.0f32;
    let mut chime = 0u32;
    let mut elapsed = 50000usize;
    loop {
        let target = LEVEL.load(Ordering::Relaxed) as f32 / 255.0;
        let current = CHIME.load(Ordering::Relaxed);
        if current != chime {
            chime = current;
            elapsed = 0;
        }
        for i in 0..1024 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let white = (seed as i32 as f32) / 2147483648.0;
            low += 0.18 * (white - low);
            body += 0.006 * (white - body);
            gain += (target - gain) * 0.0008;
            let mut value = ((white - low) * 0.15 + low * 0.15 + body * 0.9) * gain;
            if elapsed < 40000 {
                let t = elapsed as f32 / 44100.0;
                let note = if elapsed < 16000 { 880.0 } else { 659.25 };
                let env = if elapsed < 16000 {
                    1.0 - elapsed as f32 / 16000.0
                } else {
                    1.0 - (elapsed - 16000) as f32 / 24000.0
                };
                value += libm::sinf(t * note * core::f32::consts::TAU) * env * 0.07 * gain.max(0.4);
                elapsed += 1;
            }
            let v = (value.clamp(-0.8, 0.8) * 32767.0) as i16;
            buffer.0[i * 2] = v;
            buffer.0[i * 2 + 1] = v;
        }
        sceAudioOutputBlocking(channel, 0x6000, buffer.0.as_mut_ptr() as _);
    }
}
