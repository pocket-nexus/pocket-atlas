//! A driver for measurements, captures and the attract loop (web
//! `routes/shared/drive/autopilot.ts`): pure pursuit of a point ahead in the
//! lane, at a speed held below what the bends allow on snow.

use crate::line::Line;
use crate::vehicle::{Car, Controls, Spec};

/// Controls that keep the car `lane` metres right of the centre line (the
/// left lane is negative) at up to `speed` m/s.
///
/// `lead`: the vehicle ahead in the lane, as (gap m, its speed m/s): the car
/// settles behind it instead of running into it.
pub fn autopilot(c: &Car, line: &Line, k: &Spec, speed: f64, lane: f64, lead: Option<(f64, f64)>) -> Controls {
    let v = c.vx.abs();
    let look = 7.0 + v * 0.9;
    let p = line.at(c.s + look);
    let (tx, tz) = (p.x - p.tz * lane, p.z + p.tx * lane);
    let (dx, dz) = (tx - c.x, tz - c.z);
    let err = dx.atan2(-dz) - c.heading;
    let err = err.sin().atan2(err.cos());
    // The wheel angle whose arc passes through the point.
    let wheel = (2.0 * k.wheelbase * err.sin() / look.max(1.0)).atan();
    let lock = k.lock / (1.0 + (v / k.steer_speed) * (v / k.steer_speed));
    let steer = (wheel / lock).clamp(-1.0, 1.0);
    // The bend ahead: heading change over the next 60 m.
    let a = line.at(c.s + 10.0);
    let b = line.at(c.s + 70.0);
    let turn = (a.tx * b.tz - a.tz * b.tx).atan2(a.tx * b.tx + a.tz * b.tz).abs() / 60.0;
    let bend = if turn > 1e-5 { (0.16 * 9.81 / turn).sqrt() } else { f64::INFINITY };
    let follow = lead.map_or(f64::INFINITY, |(gap, v)| (v + (gap - 14.0) * 0.4).max(0.0));
    let want = speed.min(bend).min(follow);
    let e = want - c.vx;
    Controls { steer, throttle: (e * 0.6).clamp(0.0, 1.0), brake: if c.vx > 1.0 { (-e * 0.35 - 0.1).clamp(0.0, 1.0) } else { 0.0 } }
}
