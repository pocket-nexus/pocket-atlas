//! Other vehicles on the driven road (web `routes/shared/drive/traffic.ts`):
//! a few oncoming in the far lane and now and then a slower one ahead in the
//! driver's own, from the same seed as the web.

use crate::vehicle::Car;

#[derive(Clone, Copy, Debug, Default)]
pub struct TrafficCar {
    /// Arc length and offset on the driven line (m); `s < 0`: parked off the road.
    pub s: f64,
    pub d: f64,
    /// Speed along the line (m/s): negative for oncoming.
    pub v: f64,
    /// Which of the kit's traffic bodies it wears.
    pub body: usize,
    /// Seconds it still waits after a collision.
    pub wait: f64,
}

pub const TRAFFIC_CARS: usize = 5;
pub const TRAFFIC_BODIES: usize = 4;
const LANE: f64 = 1.65;
const BEHIND: f64 = 260.0;
const AHEAD: f64 = 1500.0;

#[derive(Clone, Debug)]
pub struct Traffic {
    pub cars: [TrafficCar; TRAFFIC_CARS],
    seed: u32,
}

impl Traffic {
    pub fn new(driver: f64, length: f64) -> Self {
        let mut t = Self { cars: [TrafficCar::default(); TRAFFIC_CARS], seed: 0x51ed_270b };
        for i in 0..TRAFFIC_CARS {
            t.place(i, driver, length, true);
        }
        t
    }

    fn rnd(&mut self) -> f64 {
        let mut s = self.seed;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.seed = s;
        s as f64 / 4_294_967_296.0
    }

    fn place(&mut self, i: usize, driver: f64, length: f64, first: bool) {
        let oncoming = self.rnd() < 0.72;
        let far = if first { 250.0 + self.rnd() * (AHEAD - 250.0) } else { AHEAD - self.rnd() * 300.0 };
        let d = if oncoming { LANE } else { -LANE };
        let v = if oncoming { -(12.5 + self.rnd() * 4.5) } else { 12.5 + self.rnd() * 3.0 };
        let body = (self.rnd() * TRAFFIC_BODIES as f64).floor() as usize % TRAFFIC_BODIES;
        let s = if driver + far > length - 60.0 { -1.0 } else { driver + far };
        self.cars[i] = TrafficCar { s, d, v, body, wait: 0.0 };
    }

    /// The vehicle ahead of the driver in the driver's lane within `reach`
    /// metres: (gap, its speed along the line).
    pub fn lead(&self, driver: &Car, reach: f64) -> Option<(f64, f64)> {
        let mut best: Option<(f64, f64)> = None;
        for c in &self.cars {
            let gap = c.s - driver.s;
            if c.s >= 0.0 && gap > 0.0 && gap < reach && (c.d - driver.d).abs() < 1.5 && best.map_or(true, |b| gap < b.0) {
                best = Some((gap, if c.wait > 0.0 { 0.0 } else { c.v }));
            }
        }
        best
    }

    /// Advances the traffic; true when the driver has just run into one of them.
    pub fn step(&mut self, driver: &Car, length: f64, dt: f64) -> bool {
        let mut hit = false;
        for i in 0..TRAFFIC_CARS {
            let mut c = self.cars[i];
            if c.s < 0.0 {
                continue;
            }
            if c.wait > 0.0 {
                c.wait -= dt;
            } else {
                c.s += c.v * dt;
            }
            let ds = c.s - driver.s;
            if ds.abs() < 3.5 && (c.d - driver.d).abs() < 1.5 && c.wait <= 0.0 && (driver.vx - c.v).abs() > 1.0 {
                hit = true;
                c.wait = 4.0;
            }
            self.cars[i] = c;
            if ds < -BEHIND || ds > AHEAD + 100.0 || c.s < 20.0 || c.s > length - 20.0 {
                self.place(i, driver.s, length, false);
            }
        }
        hit
    }
}
