//! Procedural driving audio: a small three-cylinder engine, tyre texture and
//! stereo wind/snow through the cabin. No sampled assets or frame-thread DSP.
//! The device owner opens/releases its port; its joined worker only outputs PCM.

const SAMPLE_RATE: u32 = 48_000;
const BLOCK_FRAMES: usize = 1024;
const TABLE_LEN: usize = 1024;
const PAUSED: u32 = 1 << 31;

#[derive(Clone, Copy)]
struct Control {
    speed: f32,
    throttle: f32,
    paused: bool,
}

/// Publish all controls in one 32-bit atomic: speed in 1/256 m/s, 15-bit
/// throttle, and pause. Reverse has the same drivetrain/wind sound as forward.
fn encode(speed: f32, throttle: f32, paused: bool) -> u32 {
    let speed = if speed.is_finite() { speed.abs().min(60.0) } else { 0.0 };
    let throttle = if throttle.is_finite() { throttle.clamp(0.0, 1.0) } else { 0.0 };
    ((speed * 256.0) as u32) | (((throttle * 32767.0) as u32) << 16) | if paused { PAUSED } else { 0 }
}

fn decode(word: u32) -> Control {
    Control { speed: (word & 0xffff) as f32 / 256.0, throttle: ((word >> 16) & 0x7fff) as f32 / 32767.0, paused: word & PAUSED != 0 }
}

struct Synth {
    wave: [f32; TABLE_LEN],
    phase: f32,
    wheel_phase: f32,
    gust_phase: f32,
    rpm: f32,
    load: f32,
    speed: f32,
    gain: f32,
    engine_low: f32,
    noise: [u32; 2],
    wind_low: [f32; 2],
    wind_mid: [f32; 2],
    tyre_low: [f32; 2],
}

impl Synth {
    fn new() -> Self {
        // Harmonics of the firing cycle retain the little engine's body on
        // small speakers. Trigonometry runs once, never in the sample loop.
        let wave = std::array::from_fn(|i| {
            let a = i as f32 * core::f32::consts::TAU / TABLE_LEN as f32;
            (a.sin() + 0.5 * (a * 2.0).sin() + 0.22 * (a * 3.0).sin() + 0.12 * (a * 6.0).sin()) * 0.54
        });
        Self {
            wave, phase: 0.0, wheel_phase: 0.0, gust_phase: 0.0,
            rpm: 920.0, load: 0.0, speed: 0.0, gain: 0.0, engine_low: 0.0,
            noise: [0x6d2b_79f5, 0xa341_316c], wind_low: [0.0; 2], wind_mid: [0.0; 2], tyre_low: [0.0; 2],
        }
    }

    fn render(&mut self, control: Control, out: &mut [i16; BLOCK_FRAMES * 2]) {
        let target_rpm = 920.0 + (control.speed * 95.0).min(2700.0) + control.throttle * (1450.0 + control.speed.min(30.0) * 12.0);
        // Exactly one block to fade the entire mix, including stationary wind,
        // to silence on pause/exit. The final sample and next block are zero.
        let target_gain = if control.paused { 0.0 } else { 1.0 };
        let start_gain = self.gain;
        for (i, stereo) in out.chunks_exact_mut(2).enumerate() {
            self.rpm += (target_rpm - self.rpm) * 0.00025;
            self.load += (control.throttle - self.load) * 0.0004;
            self.speed += (control.speed - self.speed) * 0.0004;
            // A four-stroke three-cylinder engine fires three times per two
            // revolutions. The continuous pitch suits an automatic kei car.
            self.phase += self.rpm * (3.0 / 120.0) * TABLE_LEN as f32 / SAMPLE_RATE as f32;
            if self.phase >= TABLE_LEN as f32 { self.phase -= TABLE_LEN as f32; }
            let at = self.phase as usize;
            let blend = self.phase - at as f32;
            let wave = self.wave[at] + (self.wave[(at + 1) & (TABLE_LEN - 1)] - self.wave[at]) * blend;
            self.engine_low += (wave - self.engine_low) * 0.13;
            let speed = (self.speed / 25.0).min(1.0);
            let engine = self.engine_low * (0.075 + 0.105 * self.load + 0.025 * speed);
            self.wheel_phase += self.speed / (1.7 * SAMPLE_RATE as f32);
            if self.wheel_phase >= 1.0 { self.wheel_phase -= 1.0; }
            self.gust_phase += 0.085 / SAMPLE_RATE as f32;
            if self.gust_phase >= 1.0 { self.gust_phase -= 1.0; }
            let wheel = 0.85 + 0.15 * (1.0 - (self.wheel_phase * 2.0 - 1.0).abs());
            let gust = 0.7 + 0.3 * (1.0 - (self.gust_phase * 2.0 - 1.0).abs());
            let gain = start_gain + (target_gain - start_gain) * ((i + 1) as f32 / BLOCK_FRAMES as f32);
            for channel in 0..2 {
                let mut bits = self.noise[channel];
                bits ^= bits << 13;
                bits ^= bits >> 17;
                bits ^= bits << 5;
                self.noise[channel] = bits;
                let noise = (bits >> 8) as f32 * (2.0 / 16_777_215.0) - 1.0;
                self.wind_low[channel] += (noise - self.wind_low[channel]) * 0.014;
                self.wind_mid[channel] += (noise - self.wind_mid[channel]) * 0.09;
                self.tyre_low[channel] += (noise - self.tyre_low[channel]) * 0.24;
                let wind = (self.wind_low[channel] * 1.5 + self.wind_mid[channel] * 0.35) * (0.016 + speed * speed * 0.22) * gust;
                let tyre = (self.tyre_low[channel] - self.wind_low[channel]) * speed * 0.12 * wheel;
                // Quiet roughness follows engine load; wind/tyres remain wider
                // than the centered engine. Conservative headroom needs no ALC.
                let engine_noise = self.wind_mid[channel] * self.load * 0.012;
                let sample = (engine + engine_noise + wind + tyre) * gain;
                stereo[channel] = (sample.clamp(-0.9, 0.9) * i16::MAX as f32).round() as i16;
            }
        }
        self.gain = target_gain;
    }
}

#[cfg(target_os = "vita")]
mod device {
    use super::{decode, encode, Synth, BLOCK_FRAMES, PAUSED, SAMPLE_RATE};
    use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::marker::PhantomData;
    use std::rc::Rc;
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use vitasdk_sys::{sceAudioOutOpenPort, sceAudioOutOutput, sceAudioOutReleasePort, SCE_AUDIO_OUT_MODE_STEREO, SCE_AUDIO_OUT_PORT_TYPE_MAIN};

    struct Shared {
        run: AtomicBool,
        control: AtomicU32,
    }

    #[repr(align(64))]
    struct Pcm([i16; BLOCK_FRAMES * 2]);

    /// Own on the thread that calls `new` (normally the render/main thread).
    /// Only atomics and the port number cross to the audio worker; GPU state
    /// and the owning port's release never do. Dropping joins before release.
    pub struct DriveAudio {
        shared: Arc<Shared>,
        worker: Option<JoinHandle<()>>,
        port: i32,
        _owner_thread: PhantomData<Rc<()>>,
    }

    impl DriveAudio {
        /// Open a 48 kHz stereo MAIN port. Starts silent until `update`.
        pub fn new() -> Result<Self, String> {
            let port = unsafe { sceAudioOutOpenPort(SCE_AUDIO_OUT_PORT_TYPE_MAIN as _, BLOCK_FRAMES as i32, SAMPLE_RATE as i32, SCE_AUDIO_OUT_MODE_STEREO as _) };
            if port < 0 { return Err(format!("driving audio open 0x{:08x}", port as u32)); }
            let shared = Arc::new(Shared { run: AtomicBool::new(true), control: AtomicU32::new(PAUSED) });
            let audio = Arc::clone(&shared);
            let worker = std::thread::Builder::new().name("atlas-drive-audio".into()).stack_size(64 * 1024).spawn(move || {
                let mut synth = Synth::new();
                let mut buffers = [Pcm([0; BLOCK_FRAMES * 2]), Pcm([0; BLOCK_FRAMES * 2])];
                let mut next = 0;
                loop {
                    let running = audio.run.load(Ordering::Acquire);
                    let mut control = decode(audio.control.load(Ordering::Relaxed));
                    control.paused |= !running;
                    synth.render(control, &mut buffers[next].0);
                    // Blocking output paces synthesis; two buffers keep the
                    // previous block untouched while the device drains it.
                    let result = unsafe { sceAudioOutOutput(port, buffers[next].0.as_ptr().cast()) };
                    if result < 0 {
                        eprintln!("driving audio output 0x{:08x}", result as u32);
                        break;
                    }
                    if !running { break; }
                    next ^= 1;
                }
                // The SDK documents NULL output as draining the last buffer.
                // Keep both buffers alive until this completes, then join.
                unsafe { sceAudioOutOutput(port, core::ptr::null()) };
            });
            match worker {
                Ok(worker) => Ok(Self { shared, worker: Some(worker), port, _owner_thread: PhantomData }),
                Err(error) => {
                    unsafe { sceAudioOutReleasePort(port) };
                    Err(format!("driving audio worker: {error}"))
                }
            }
        }

        /// `speed` is metres/second (signed); `throttle` is 0..1. Pause fades
        /// engine, tyres and weather together without stopping the PCM clock.
        pub fn update(&self, speed: f32, throttle: f32, paused: bool) {
            self.shared.control.store(encode(speed, throttle, paused), Ordering::Relaxed);
        }
    }

    impl Drop for DriveAudio {
        fn drop(&mut self) {
            self.shared.run.store(false, Ordering::Release);
            if let Some(worker) = self.worker.take() { let _ = worker.join(); }
            unsafe { sceAudioOutReleasePort(self.port) };
        }
    }
}

#[cfg(target_os = "vita")]
pub use device::DriveAudio;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_are_finite_and_reverse_uses_absolute_speed() {
        assert_eq!(encode(-18.5, 0.7, false), encode(18.5, 0.7, false));
        let invalid = decode(encode(f32::NAN, f32::INFINITY, true));
        assert_eq!(invalid.speed, 0.0);
        assert_eq!(invalid.throttle, 0.0);
        assert!(invalid.paused);
        let limit = decode(encode(f32::MAX, -3.0, false));
        assert_eq!(limit.speed, 60.0);
        assert_eq!(limit.throttle, 0.0);
    }

    #[test]
    fn sustained_drive_has_headroom_stereo_and_no_dc_build_up() {
        let mut synth = Synth::new();
        let mut pcm = [0; BLOCK_FRAMES * 2];
        let mut peak = 0i32;
        let mut sum = 0i64;
        let mut energy = 0u64;
        let mut stereo_differences = 0;
        for block in 0..480 {
            let control = decode(encode(if block < 80 { 0.0 } else { 28.0 }, if block < 160 { 0.0 } else { 1.0 }, false));
            synth.render(control, &mut pcm);
            for frame in pcm.chunks_exact(2) {
                stereo_differences += (frame[0] != frame[1]) as usize;
                for &sample in frame {
                    peak = peak.max((sample as i32).abs());
                    sum += sample as i64;
                    energy += (sample as i64 * sample as i64) as u64;
                }
            }
        }
        let samples = 480 * BLOCK_FRAMES * 2;
        assert!(peak > 3000 && peak < 20_000, "peak={peak}");
        assert!((sum as f64 / samples as f64).abs() < 80.0);
        assert!(energy / samples as u64 > 10_000);
        assert!(stereo_differences > samples / 4);
    }

    #[test]
    fn pause_fades_then_holds_exact_silence_and_can_resume() {
        let mut synth = Synth::new();
        let mut pcm = [0; BLOCK_FRAMES * 2];
        let drive = decode(encode(20.0, 0.8, false));
        for _ in 0..50 { synth.render(drive, &mut pcm); }
        let paused = decode(encode(20.0, 0.8, true));
        synth.render(paused, &mut pcm);
        assert_eq!(&pcm[pcm.len() - 2..], &[0, 0]);
        synth.render(paused, &mut pcm);
        assert!(pcm.iter().all(|&sample| sample == 0));
        synth.render(drive, &mut pcm);
        assert!(pcm.iter().any(|sample| sample.abs() > 100));
    }
}
