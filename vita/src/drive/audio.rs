//! The car's sound on the handheld: four voices mixed on a thread of their
//! own from the numbers the drive publishes each frame (`DriveSound`) — the
//! engine (a saw at the firing frequency and a square an octave below, under
//! a low-pass that opens with load), the tyres on snow, the wind and the
//! snowbank. The web reference builds the same voices from WebAudio nodes
//! (`routes/shared/audio.ts`).
//!
//! The port is opened and released on the render thread; the mixer thread
//! only writes to it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use pocket3d_drive::DriveSound;
use vitasdk_sys::{sceAudioOutOpenPort, sceAudioOutOutput, sceAudioOutReleasePort, SCE_AUDIO_OUT_MODE_STEREO, SCE_AUDIO_OUT_PORT_TYPE_BGM};

const RATE: f32 = 24_000.0;
const GRAIN: usize = 512;

#[derive(Default)]
struct Shared {
    rpm: AtomicU32,
    load: AtomicU32,
    speed: AtomicU32,
    slip: AtomicU32,
    scrape: AtomicU32,
    /// 0..1 master level (0 while paused or looking around).
    level: AtomicU32,
    run: AtomicBool,
}

pub struct Audio {
    shared: Arc<Shared>,
    port: i32,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn put(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed);
}

fn get(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}

/// One-pole low-pass coefficient for a cutoff (Hz).
fn pole(hz: f32) -> f32 {
    1.0 - (-core::f32::consts::TAU * hz / RATE).exp()
}

impl Audio {
    /// Opens the port and starts the mixer; `None` when the system has no port to give.
    ///
    /// # Safety
    /// Render thread.
    pub unsafe fn start() -> Option<Self> {
        let port = sceAudioOutOpenPort(SCE_AUDIO_OUT_PORT_TYPE_BGM, GRAIN as i32, RATE as i32, SCE_AUDIO_OUT_MODE_STEREO);
        if port < 0 {
            return None;
        }
        let shared = Arc::new(Shared::default());
        put(&shared.rpm, 900.0);
        shared.run.store(true, Ordering::Release);
        let s = shared.clone();
        let thread = std::thread::Builder::new().name("atlas-car-audio".into()).stack_size(64 * 1024).spawn(move || mix(port, &s)).ok();
        Some(Self { shared, port, thread })
    }

    /// Publishes the car's sound for the mixer; `level` fades the whole mix.
    pub fn update(&self, s: &DriveSound, level: f32) {
        put(&self.shared.rpm, s.rpm as f32);
        put(&self.shared.load, s.load as f32);
        put(&self.shared.speed, s.speed as f32);
        put(&self.shared.slip, s.slip as f32);
        put(&self.shared.scrape, s.scrape as f32);
        put(&self.shared.level, level);
    }

    /// Stops the mixer and releases the port.
    ///
    /// # Safety
    /// Render thread.
    pub unsafe fn stop(mut self) {
        self.shared.run.store(false, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        sceAudioOutReleasePort(self.port);
    }
}

fn mix(port: i32, s: &Shared) {
    let mut out = [0i16; GRAIN * 2];
    let mut noise = 0x1234_5678u32;
    // Oscillator phases, filter states and the smoothed controls.
    let (mut saw, mut sub) = (0.0f32, 0.0f32);
    let (mut engine_lp, mut tyre_lp) = (0.0f32, 0.0f32);
    let (mut wind_lp, mut wind_bp, mut scrape_lp, mut scrape_bp) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let (mut rpm, mut load, mut speed, mut slip, mut scrape, mut level) = (900.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
    while s.run.load(Ordering::Acquire) {
        // Controls move once per block, eased so a 30 Hz update does not step.
        let ease = 0.35;
        rpm += (get(&s.rpm) - rpm) * ease;
        load += (get(&s.load) - load) * ease;
        speed += (get(&s.speed) - speed) * ease;
        slip += (get(&s.slip) - slip) * ease;
        scrape += (get(&s.scrape) - scrape) * ease;
        level += (get(&s.level) - level) * 0.2;
        // Three cylinders, four strokes: 1.5 firings per revolution.
        let f = rpm / 60.0 * 1.5;
        let (d_saw, d_sub) = (f / RATE, f * 0.5 / RATE);
        let k_engine = pole(260.0 + load * 900.0 + rpm * 0.08);
        let g_engine = 0.05 + load * 0.09 + (rpm / 100_000.0).min(0.04);
        let v = (speed / 28.0).min(1.0);
        let slide = (slip - 0.75).max(0.0);
        let k_tyre = pole(160.0 + v * 380.0 + slide * 1800.0);
        let g_tyre = 0.02 + v * 0.3 + slide * 0.25 * (speed / 4.0).min(1.0);
        let g_wind = v * v * 0.16;
        let g_scrape = scrape * 0.7;
        let (k_wind_hi, k_wind_lo, k_scrape_hi, k_scrape_lo) = (pole(1400.0), pole(500.0), pole(700.0), pole(240.0));
        for i in 0..GRAIN {
            saw += d_saw;
            if saw >= 1.0 {
                saw -= 1.0;
            }
            sub += d_sub;
            if sub >= 1.0 {
                sub -= 1.0;
            }
            let raw = (saw * 2.0 - 1.0) + if sub < 0.5 { 0.5 } else { -0.5 };
            engine_lp += (raw - engine_lp) * k_engine;
            noise ^= noise << 13;
            noise ^= noise >> 17;
            noise ^= noise << 5;
            let n = (noise >> 8) as f32 / 8_388_608.0 - 1.0;
            tyre_lp += (n - tyre_lp) * k_tyre;
            // Band-pass as the difference of two low-passes.
            wind_lp += (n - wind_lp) * k_wind_hi;
            wind_bp += (wind_lp - wind_bp) * k_wind_lo;
            scrape_lp += (n - scrape_lp) * k_scrape_hi;
            scrape_bp += (scrape_lp - scrape_bp) * k_scrape_lo;
            let m = engine_lp * g_engine + tyre_lp * g_tyre * 2.2 + (wind_lp - wind_bp) * g_wind * 1.6 + (scrape_lp - scrape_bp) * g_scrape * 2.4;
            let q = ((m * level * 0.9).clamp(-1.0, 1.0) * 30_000.0) as i16;
            out[i * 2] = q;
            out[i * 2 + 1] = q;
        }
        // Blocks until the previous block has played.
        unsafe { sceAudioOutOutput(port, out.as_ptr().cast()) };
    }
}
