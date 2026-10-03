//! Small scene-time driven procedural ambience. The recipe is authored data,
//! not a scene ID or a recording. The blocking mixer never touches storage.
use core::sync::atomic::AtomicU32;

pub static LEVEL: AtomicU32 = AtomicU32::new(0);
pub static CHIME: AtomicU32 = AtomicU32::new(0);
const RATE: f32 = 44100.0;
const FRAMES: usize = 1024;
const CONTROL: usize = 256;
const TABLE: usize = 1024;

#[cfg(target_os = "psp")]
fn sin(v: f32) -> f32 {
    libm::sinf(v)
}
#[cfg(not(target_os = "psp"))]
fn sin(v: f32) -> f32 {
    v.sin()
}
#[cfg(target_os = "psp")]
fn floor(v: f32) -> f32 {
    libm::floorf(v)
}
#[cfg(not(target_os = "psp"))]
fn floor(v: f32) -> f32 {
    v.floor()
}
#[cfg(target_os = "psp")]
fn sqrt(v: f32) -> f32 {
    libm::sqrtf(v)
}
#[cfg(not(target_os = "psp"))]
fn sqrt(v: f32) -> f32 {
    v.sqrt()
}
#[cfg(target_os = "psp")]
fn pow(v: f32, n: f32) -> f32 {
    libm::powf(v, n)
}
#[cfg(not(target_os = "psp"))]
fn pow(v: f32, n: f32) -> f32 {
    v.powf(n)
}
fn phase(t: f32, period: f32) -> f32 {
    t - floor(t / period) * period
}
fn hash(mut n: u32) -> u32 {
    n ^= n >> 16;
    n = n.wrapping_mul(0x7feb352d);
    n ^= n >> 15;
    n = n.wrapping_mul(0x846ca68b);
    n ^ (n >> 16)
}

/// Native audio record v1: 32 little-endian floats. Reject corrupt or future
/// descriptors before starting a thread; absent records keep the rain bed.
fn valid(r: &[f32]) -> bool {
    if r.len() != 32
        || r.iter().any(|v| !v.is_finite())
        || r[0] != 1.0
        || !(1.0..=3600.0).contains(&r[1])
        || !(0.0..=1.0).contains(&r[2])
        || !(0.0..=1.0).contains(&r[3])
        || !(0.0..=r[1]).contains(&r[4])
        || !(0.0..=16777215.0).contains(&r[6])
        || floor(r[6]) != r[6]
        || (r[3] > 0.0 && r[5] < 1.0)
        || (r[7] != 0.0 && r[7] != 1.0)
        || r[21..].iter().any(|v| *v != 0.0)
    {
        return false;
    }
    r[7] == 0.0
        || (r[8..11]
            .iter()
            .chain(r[13..15].iter())
            .all(|v| (0.0..=r[1]).contains(v))
            && r[8] < r[9]
            && r[13] < r[14]
            && r[11] > 0.0
            && r[12] > 0.0
            && (0.0..=1.0).contains(&r[19])
            && (0.0..=1.0).contains(&r[20]))
}

#[derive(Clone, Copy, Default)]
struct Controls {
    train: [f32; 2],
    bell: [f32; 2],
    bird_gain: f32,
    bird_hz: f32,
}
fn spatial(delta: [f32; 3], right: [f32; 3], spread: f32) -> (f32, [f32; 2]) {
    let distance = sqrt(delta.iter().map(|v| v * v).sum());
    let pan = if distance > 0.0001 {
        (delta.iter().zip(right).map(|(v, r)| v * r).sum::<f32>() / distance * spread)
            .clamp(-1.0, 1.0)
    } else {
        0.0
    };
    // StereoPanner's equal-power law, computed per control block, not sample.
    (distance, [sqrt((1.0 - pan) * 0.5), sqrt((1.0 + pan) * 0.5)])
}
fn controls(r: &[f32; 32], t: f32, eye: [f32; 3], right: [f32; 3]) -> Controls {
    let t = phase(t, r[1]);
    let mut out = Controls::default();
    if r[7] != 0.0 {
        let (s, c) = (sin(r[18]), sin(r[18] + core::f32::consts::FRAC_PI_2));
        let front = (t - r[10]) * r[11];
        let x = ((eye[0] - r[15]) * c - (eye[2] - r[17]) * s).clamp(front - r[12], front);
        let (distance, pan) = spatial(
            [
                r[15] + x * c - eye[0],
                r[16] + 0.7 - eye[1],
                r[17] - x * s - eye[2],
            ],
            right,
            0.85,
        );
        let clatter =
            sin(front * core::f32::consts::PI / 10.0 + core::f32::consts::FRAC_PI_2).max(0.0);
        let clatter2 = clatter * clatter;
        let clatter4 = clatter2 * clatter2;
        let gain = if t >= r[13] && t < r[14] {
            r[19] * (0.88 + 0.12 * clatter4 * clatter4) / pow(1.0 + distance / 13.0, 1.6)
        } else {
            0.0
        };
        out.train = [gain * pan[0], gain * pan[1]];
        let (distance, pan) = spatial([r[15] - eye[0], r[16] - eye[1], r[17] - eye[2]], right, 0.8);
        let pulse = pow(core::f32::consts::E, -phase(t * 2.2, 1.0) * 5.0);
        let gain = if t >= r[8] && t < r[9] {
            r[20] * pulse / (1.0 + distance / 22.0)
        } else {
            0.0
        };
        out.bell = [gain * pan[0], gain * pan[1]];
    }
    if r[3] > 0.0 {
        let base = floor((t - r[4]) / r[5]) as i32;
        for index in (base - 1)..=(base + 1) {
            if index < 0 {
                continue;
            }
            let random = hash((index as u32).wrapping_add(r[6] as u32));
            let jitter = if index == 0 {
                0.0
            } else {
                ((random & 65535) as f32 / 65535.0 - 0.5) * (r[5] * 0.4).min(4.0)
            };
            let start = r[4] + index as f32 * r[5] + jitter;
            let elapsed = t - start;
            if !(0.0..0.58).contains(&elapsed) {
                continue;
            }
            let note = floor(elapsed / 0.2);
            let age = elapsed - note * 0.2;
            if age >= 0.16 {
                continue;
            }
            let base_hz = 2500.0 + note * 200.0;
            out.bird_hz = if age < 0.085 {
                base_hz * pow(4100.0 / base_hz, age / 0.085)
            } else {
                4100.0 * pow(2700.0 / 4100.0, (age - 0.085) / 0.065)
            };
            let envelope = if age < 0.02 {
                age / 0.02
            } else {
                pow(0.004, (age - 0.02) / 0.14)
            };
            out.bird_gain = r[3] * envelope * ((r[1] - t) / 0.02).clamp(0.0, 1.0);
        }
    }
    out
}

struct Synth {
    sine: [f32; TABLE],
    oscillators: [f32; 5],
    seed: u32,
    wind_low: f32,
    wind_body: f32,
    train_low: f32,
    fade: f32,
}
impl Synth {
    fn new() -> Self {
        let mut s = Self {
            sine: [0.0; TABLE],
            oscillators: [0.0; 5],
            seed: 1,
            wind_low: 0.0,
            wind_body: 0.0,
            train_low: 0.0,
            fade: 0.0,
        };
        for (i, v) in s.sine.iter_mut().enumerate() {
            *v = sin(i as f32 * core::f32::consts::TAU / TABLE as f32);
        }
        s
    }
    fn seek(&mut self, t: f32, r: &[f32; 32]) {
        let t = phase(t, r[1]);
        self.seed = hash((t * RATE) as u32 ^ r[6] as u32).max(1);
        for (p, hz) in self
            .oscillators
            .iter_mut()
            .zip([126.0, 251.0, 1046.0, 1568.0, 3000.0])
        {
            *p = phase(t * hz, 1.0) * TABLE as f32;
        }
        self.wind_low = 0.0;
        self.wind_body = 0.0;
        self.train_low = 0.0;
        self.fade = 0.0;
    }
    fn oscillator(&mut self, index: usize, hz: f32) -> f32 {
        let p = self.oscillators[index];
        let i = p as usize;
        let f = p - i as f32;
        let v = self.sine[i & (TABLE - 1)] * (1.0 - f) + self.sine[(i + 1) & (TABLE - 1)] * f;
        let p = p + hz * (TABLE as f32 / RATE);
        self.oscillators[index] = if p >= TABLE as f32 {
            p - TABLE as f32
        } else {
            p
        };
        v
    }
    fn render(
        &mut self,
        r: &[f32; 32],
        time: f32,
        eye: [f32; 3],
        right: [f32; 3],
        out: &mut [i16; FRAMES * 2],
    ) {
        for block in 0..FRAMES / CONTROL {
            let t = time + (block * CONTROL) as f32 / RATE;
            let a = controls(r, t, eye, right);
            let b = controls(r, t + CONTROL as f32 / RATE, eye, right);
            for j in 0..CONTROL {
                let f = j as f32 / CONTROL as f32;
                let mix = |x: f32, y: f32| x + (y - x) * f;
                self.seed ^= self.seed << 13;
                self.seed ^= self.seed >> 17;
                self.seed ^= self.seed << 5;
                let white = self.seed as i32 as f32 / 2147483648.0;
                self.wind_low += 0.1266 * (white - self.wind_low);
                self.wind_body += 0.01835 * (white - self.wind_body);
                self.train_low += 0.1153 * (white - self.train_low);
                let wind = (self.wind_low * 0.05 + self.wind_body * 0.06) * r[2];
                let train = self.train_low
                    + self.oscillator(0, 126.0) * 0.08
                    + self.oscillator(1, 251.0) * 0.023;
                let bell = self.oscillator(2, 1046.0) * 0.055 + self.oscillator(3, 1568.0) * 0.014;
                let bird =
                    self.oscillator(4, mix(a.bird_hz, b.bird_hz)) * mix(a.bird_gain, b.bird_gain);
                self.fade = (self.fade + 1.0 / (RATE * 0.015)).min(1.0);
                for ch in 0..2 {
                    let v = wind
                        + bird
                        + train * mix(a.train[ch], b.train[ch])
                        + bell * mix(a.bell[ch], b.bell[ch]);
                    out[(block * CONTROL + j) * 2 + ch] =
                        (v.clamp(-0.95, 0.95) * self.fade * 32767.0) as i16;
                }
            }
        }
    }
}

#[cfg(target_os = "psp")]
mod backend {
    use super::*;
    use core::{
        ffi::c_void,
        ptr,
        sync::atomic::{AtomicBool, Ordering},
    };
    use psp::{sys::*, Align16};
    static SEQUENCE: AtomicU32 = AtomicU32::new(0);
    static DATA: [AtomicU32; 42] = [const { AtomicU32::new(0) }; 42];
    static MODE: AtomicU32 = AtomicU32::new(0); // 0 legacy, 1 authored, 2 stopped
    static STARTED: AtomicBool = AtomicBool::new(false);
    static READY: AtomicBool = AtomicBool::new(false);
    pub fn configure(recipe: Option<&[f32]>) -> bool {
        if recipe.is_some_and(|r| !valid(r)) {
            stop();
            return false;
        }
        SEQUENCE.fetch_add(1, Ordering::SeqCst);
        for i in 0..32 {
            DATA[i].store(recipe.map_or(0.0, |r| r[i]).to_bits(), Ordering::SeqCst);
        }
        DATA[40].store(3, Ordering::SeqCst); // silence until first clock update
        DATA[41].fetch_add(1, Ordering::SeqCst);
        MODE.store(if recipe.is_some() { 1 } else { 0 }, Ordering::SeqCst);
        SEQUENCE.fetch_add(1, Ordering::SeqCst);
        true
    }
    pub fn update(time: f32, eye: [f32; 3], right: [f32; 3], muted: bool, paused: bool) {
        let sane = time.is_finite() && eye.into_iter().chain(right).all(f32::is_finite);
        SEQUENCE.fetch_add(1, Ordering::SeqCst);
        DATA[32].store(time.to_bits(), Ordering::SeqCst);
        for i in 0..3 {
            DATA[33 + i].store(eye[i].to_bits(), Ordering::SeqCst);
            DATA[36 + i].store(right[i].to_bits(), Ordering::SeqCst);
        }
        DATA[39].store(unsafe { sceKernelGetSystemTimeLow() }, Ordering::SeqCst);
        DATA[40].store(
            (muted || !sane) as u32 | ((paused as u32) << 1),
            Ordering::SeqCst,
        );
        SEQUENCE.fetch_add(1, Ordering::SeqCst);
    }
    pub fn stop() {
        MODE.store(2, Ordering::SeqCst);
        LEVEL.store(0, Ordering::Relaxed);
    }
    pub fn ready() -> bool {
        READY.load(Ordering::Acquire)
    }
    pub unsafe fn start() {
        if STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        let id = sceKernelCreateThread(
            b"atlas_ambience\0".as_ptr(),
            mix,
            24,
            32768,
            ThreadAttributes::USER,
            ptr::null_mut(),
        );
        if id.0 < 0 || sceKernelStartThread(id, 0, ptr::null_mut()) < 0 {
            STARTED.store(false, Ordering::Release);
        }
    }
    fn snapshot() -> Option<[u32; 42]> {
        // A high-priority audio thread must never spin on a preempted writer.
        let v = SEQUENCE.load(Ordering::SeqCst);
        if v & 1 != 0 {
            return None;
        }
        let data = core::array::from_fn(|i| DATA[i].load(Ordering::SeqCst));
        if v == SEQUENCE.load(Ordering::SeqCst) {
            Some(data)
        } else {
            None
        }
    }
    unsafe extern "C" fn mix(_: usize, _: *mut c_void) -> i32 {
        let channel = sceAudioChReserve(-1, FRAMES as i32, AudioFormat::Stereo);
        if channel < 0 {
            STARTED.store(false, Ordering::Release);
            return 0;
        }
        READY.store(true, Ordering::Release);
        let mut buffer = Align16([0i16; FRAMES * 2]);
        let mut synth = Synth::new();
        let mut previous_time = f32::NAN;
        let mut generation = u32::MAX;
        let (mut seed, mut low, mut body, mut gain, mut chime, mut elapsed) =
            (0x192fe3u32, 0.0f32, 0.0f32, 0.0f32, 0u32, 50000usize);
        loop {
            let mode = MODE.load(Ordering::SeqCst);
            if mode == 1 {
                let Some(data) = snapshot() else {
                    buffer.0.fill(0);
                    sceAudioOutputBlocking(channel, 0x6000, buffer.0.as_mut_ptr() as _);
                    continue;
                };
                let r = core::array::from_fn(|i| f32::from_bits(data[i]));
                let age = sceKernelGetSystemTimeLow().wrapping_sub(data[39]);
                if data[40] != 0 || age > 250_000 {
                    buffer.0.fill(0);
                    previous_time = f32::NAN;
                } else {
                    let time = f32::from_bits(data[32]) + age as f32 / 1_000_000.0;
                    if generation != data[41]
                        || !previous_time.is_finite()
                        || (time - previous_time - FRAMES as f32 / RATE).abs() > 0.08
                    {
                        synth.seek(time, &r);
                    }
                    generation = data[41];
                    previous_time = time;
                    synth.render(
                        &r,
                        time,
                        core::array::from_fn(|i| f32::from_bits(data[33 + i])),
                        core::array::from_fn(|i| f32::from_bits(data[36 + i])),
                        &mut buffer.0,
                    );
                }
            } else if mode == 0 {
                // Preserve the original rain/chime source for packs without AUDI.
                let muted = DATA[40].load(Ordering::SeqCst) != 0;
                let target = if muted {
                    0.0
                } else {
                    LEVEL.load(Ordering::Relaxed) as f32 / 255.0
                };
                let current = CHIME.load(Ordering::Relaxed);
                if current != chime {
                    chime = current;
                    elapsed = 0;
                }
                for i in 0..FRAMES {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    let white = seed as i32 as f32 / 2147483648.0;
                    low += 0.18 * (white - low);
                    body += 0.006 * (white - body);
                    gain += (target - gain) * 0.0008;
                    let mut value = ((white - low) * 0.15 + low * 0.15 + body * 0.9) * gain;
                    if elapsed < 40000 {
                        let (note, env) = if elapsed < 16000 {
                            (880.0, 1.0 - elapsed as f32 / 16000.0)
                        } else {
                            (659.25, 1.0 - (elapsed - 16000) as f32 / 24000.0)
                        };
                        value += synth.oscillator(4, note) * env * 0.07 * gain.max(0.4);
                        elapsed += 1;
                    }
                    let v = if muted {
                        0
                    } else {
                        (value.clamp(-0.8, 0.8) * 32767.0) as i16
                    };
                    buffer.0[i * 2] = v;
                    buffer.0[i * 2 + 1] = v;
                }
            } else {
                buffer.0.fill(0);
                previous_time = f32::NAN;
            }
            sceAudioOutputBlocking(channel, 0x6000, buffer.0.as_mut_ptr() as _);
        }
    }
}
#[cfg(target_os = "psp")]
pub use backend::{configure, ready, start, update};

#[cfg(test)]
mod tests {
    use super::*;
    fn recipe() -> [f32; 32] {
        let mut r = [0.0; 32];
        r[..21].copy_from_slice(&[
            1.0, 64.0, 0.55, 0.01375, 3.0, 11.0, 500.0, 1.0, 3.0, 39.0, 18.0, 10.5, 160.4, 3.0,
            48.0, 0.0, 0.102, 1.82, -0.1, 0.28, 1.0,
        ]);
        r
    }
    #[test]
    fn recipe_rejects_bad_records() {
        let mut r = recipe();
        assert!(valid(&r));
        r[1] = f32::NAN;
        assert!(!valid(&r));
        r = recipe();
        r[9] = 2.0;
        assert!(!valid(&r));
        r = recipe();
        r[31] = 1.0;
        assert!(!valid(&r));
        assert!(!valid(&r[..31]));
    }
    #[test]
    fn railway_warning_window_and_loop_are_seekable() {
        let r = recipe();
        let eye = [0.0, 1.7, 3.0];
        let right = [1.0, 0.0, 0.0];
        assert_eq!(controls(&r, 2.99, eye, right).bell, [0.0; 2]);
        assert!(controls(&r, 3.01, eye, right).bell[0] > 0.0);
        assert_eq!(controls(&r, 39.01, eye, right).bell, [0.0; 2]);
        let a = controls(&r, 19.75, eye, right);
        let b = controls(&r, 83.75, eye, right);
        assert_eq!(a.train, b.train);
        assert_eq!(a.bell, b.bell);
        assert!(a.train[0] > controls(&r, 4.0, eye, right).train[0] * 10.0);
    }
    #[test]
    fn seek_restarts_deterministically_and_pcm_has_headroom() {
        let r = recipe();
        let mut a = Synth::new();
        let mut b = Synth::new();
        let mut x = [0; FRAMES * 2];
        let mut y = x;
        a.seek(19.73, &r);
        a.render(&r, 19.73, [0.0, 1.7, 3.0], [1.0, 0.0, 0.0], &mut x);
        b.seek(19.73, &r);
        b.render(&r, 19.73, [0.0, 1.7, 3.0], [1.0, 0.0, 0.0], &mut y);
        assert_eq!(x, y);
        assert!(x.iter().any(|v| v.abs() > 300));
        assert!(x.iter().all(|v| v.abs() < 16000));
    }
}
