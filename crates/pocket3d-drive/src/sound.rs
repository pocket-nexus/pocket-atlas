//! What the car sounds like for its state (web `routes/shared/audio.ts`,
//! `driveSound`): the numbers a device's synthesiser mixes its four voices
//! from — engine, tyres, wind, snowbank.

use crate::vehicle::Car;

#[derive(Clone, Copy, Debug)]
pub struct DriveSound {
    /// Engine speed (rev/min).
    pub rpm: f64,
    /// 0..1: how hard the engine works.
    pub load: f64,
    /// Road speed (m/s) and the share of grip in use.
    pub speed: f64,
    pub slip: f64,
    /// 0..1: the body against a bank, decaying.
    pub scrape: f64,
}

pub const QUIET: DriveSound = DriveSound { rpm: 900.0, load: 0.0, speed: 0.0, slip: 0.0, scrape: 0.0 };

/// The sound for a car state; the revs ease toward what a CVT holds.
pub fn drive_sound(c: &Car, throttle: f64, prev: &DriveSound, dt: f64) -> DriveSound {
    let speed = c.vx.abs();
    let target = 900.0 + speed * 62.0 + throttle * (1500.0 + speed * 28.0);
    let rpm = prev.rpm + (target.min(6200.0) - prev.rpm) * (1.0 - (-dt * 3.2).exp());
    let load = prev.load + (throttle - prev.load) * (1.0 - (-dt * 6.0).exp());
    let scrape = if c.scrape < 0.08 { (0.35 + c.impact * 0.12 + speed * 0.03).min(1.0) } else { prev.scrape * (-dt * 5.0).exp() };
    DriveSound { rpm, load, speed, slip: c.slip, scrape }
}
