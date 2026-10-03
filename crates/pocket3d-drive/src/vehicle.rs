//! The car: the single-track model of the web reference
//! (`web/src/routes/shared/drive/vehicle.ts`), statement for statement.
//!
//! Frame: x east, z south, heading 0 facing −Z and growing clockwise seen
//! from above. Body axes: forward, right.

use crate::line::Line;

/// The car's constants (`RouteMeta::car`, the web's `KEI`).
#[derive(Clone, Copy, Debug)]
pub struct Spec {
    pub mass: f64,
    pub inertia: f64,
    pub wheelbase: f64,
    pub front: f64,
    pub rear: f64,
    pub half_width: f64,
    pub wheel_radius: f64,
    pub power: f64,
    pub force: f64,
    pub brake: f64,
    pub engine_brake: f64,
    pub rolling: f64,
    pub drag: f64,
    pub stiffness_front: f64,
    pub stiffness_rear: f64,
    pub lock: f64,
    pub steer_rate: f64,
    pub steer_speed: f64,
    pub top: f64,
    pub reverse: f64,
}

#[derive(Clone, Copy, Default)]
pub struct Controls {
    /// −1 full left … 1 full right.
    pub steer: f64,
    pub throttle: f64,
    /// Held at rest it selects reverse.
    pub brake: f64,
}

#[derive(Clone, Copy, Default)]
pub struct Car {
    pub x: f64,
    pub z: f64,
    pub y: f64,
    pub pitch: f64,
    pub heading: f64,
    pub vx: f64,
    pub vy: f64,
    pub yaw_rate: f64,
    pub steer: f64,
    pub s: f64,
    pub d: f64,
    pub segment: usize,
    pub ax: f64,
    pub ay: f64,
    pub wheel: f64,
    pub slip: f64,
    pub scrape: f64,
    pub impact: f64,
    pub reverse: bool,
    pub odometer: f64,
}

const G: f64 = 9.81;
const SUBSTEP: f64 = 1.0 / 120.0;

/// Tyre–road friction at an arc length and offset: packed snow, ice where
/// traffic has polished it, in long patches (the web stage's `grip`).
pub fn grip(s: f64, d: f64) -> f64 {
    0.34 + 0.06 * (s * 0.013).sin() * (s * 0.0031 + d).sin()
}

fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

impl Car {
    /// At rest on the line at arc length `s`, offset `d`.
    pub fn start(line: &Line, s: f64, d: f64) -> Self {
        let p = line.at(s);
        Self { x: p.x - p.tz * d, z: p.z + p.tx * d, y: p.y, heading: p.tx.atan2(-p.tz), s, d, segment: line.segment(s), scrape: 10.0, ..Default::default() }
    }

    /// Advances by `dt` seconds in fixed substeps.
    pub fn step(&mut self, input: &Controls, line: &Line, dt: f64, k: &Spec) {
        let mut left = dt.min(0.1);
        while left > 1e-6 {
            let h = SUBSTEP.min(left);
            self.substep(input, line, h, k);
            left -= h;
        }
    }

    fn substep(&mut self, input: &Controls, line: &Line, h: f64, k: &Spec) {
        let c = self;
        let speed = c.vx.abs();
        let lock = k.lock / (1.0 + (speed / k.steer_speed) * (speed / k.steer_speed));
        let want = input.steer.clamp(-1.0, 1.0) * lock;
        let turn = k.steer_rate * h;
        c.steer += (want - c.steer).clamp(-turn, turn);

        if speed < 0.3 {
            if input.brake > 0.5 && input.throttle < 0.1 {
                c.reverse = true;
            } else if input.throttle > 0.1 {
                c.reverse = false;
            }
        }
        let dir = if c.reverse { -1.0 } else { 1.0 };
        let throttle = if c.reverse { input.brake } else { input.throttle };
        let brake = if c.reverse { input.throttle } else { input.brake };

        let mu = grip(c.s, c.d);
        let weight = k.mass * G;
        let fzf = (weight * k.rear) / k.wheelbase;
        let fzr = (weight * k.front) / k.wheelbase;

        let limit = if c.reverse { k.reverse } else { k.top };
        let along = c.vx * dir;
        let mut drive = throttle * k.force.min(k.power / along.max(2.5));
        if along > limit {
            drive = 0.0;
        }
        let mut fx = dir * drive;
        if brake > 0.0 && speed > 0.05 {
            fx -= sign(c.vx) * brake * k.brake;
        }
        let grip_force = mu * weight;
        let fx_use = fx.clamp(-grip_force, grip_force);
        let spin = if fx.abs() > grip_force { 1.0 } else { fx.abs() / grip_force };
        let side = (1.0 - spin * spin * 0.85).max(0.05).sqrt();

        let vxs = speed.max(1.2);
        let sgn = if c.vx < 0.0 { -1.0 } else { 1.0 };
        let af = (c.vy + k.front * c.yaw_rate).atan2(vxs) - c.steer * sgn;
        let ar = (c.vy - k.rear * c.yaw_rate).atan2(vxs);
        let fyf = -mu * fzf * side * (k.stiffness_front * af).tanh();
        let fyr = -mu * fzr * side * (k.stiffness_rear * ar).tanh();
        c.slip = spin.max((k.stiffness_front * af).tanh().abs()).max((k.stiffness_rear * ar).tanh().abs());

        let mut point = line.at(c.s);
        let hx = c.heading.sin();
        let hz = -c.heading.cos();
        let slope = point.grade * (hx * point.tx + hz * point.tz);
        let mut resist = k.rolling * weight + k.drag * c.vx * c.vx + if throttle < 0.05 { k.engine_brake } else { 0.0 };
        let half = line.half_at(c.s) as f64;
        let room = half - k.half_width - c.d.abs();
        let loose = (1.0 - room / 0.5).clamp(0.0, 1.0);
        resist += loose * 0.05 * weight;
        let fx_net = fx_use - if speed > 0.05 { sign(c.vx) * resist } else { 0.0 } - weight * slope;

        let cs = c.steer.cos();
        let sn = c.steer.sin();
        let ax = (fx_net - fyf * sn) / k.mass + c.vy * c.yaw_rate;
        let mut ay = (fyf * cs + fyr) / k.mass - c.vx * c.yaw_rate;
        let mut yaw_acc = (k.front * fyf * cs - k.rear * fyr) / k.inertia;
        yaw_acc += loose * sign(c.d) * 0.25 * (speed / 8.0).min(1.0);

        let crawl = (1.0 - speed / 2.5).max(0.0);
        if crawl > 0.0 {
            let kin = (c.vx * c.steer.tan()) / k.wheelbase;
            c.yaw_rate += (kin - c.yaw_rate) * crawl * (h * 12.0).min(1.0);
            c.vy += (0.0 - c.vy) * crawl * (h * 12.0).min(1.0);
            yaw_acc *= 1.0 - crawl;
            ay *= 1.0 - crawl;
        }
        c.vx += ax * h;
        c.vy += ay * h;
        c.yaw_rate += yaw_acc * h;
        if brake > 0.0 && c.vx.abs() < 0.15 && throttle < 0.05 {
            c.vx = 0.0;
        }
        if speed < 0.05 && throttle < 0.02 && slope.abs() < 0.03 {
            c.vx = 0.0;
        }
        c.heading += c.yaw_rate * h;

        let rx = -hz;
        let rz = hx;
        let wx = hx * c.vx + rx * c.vy;
        let wz = hz * c.vx + rz * c.vy;
        c.x += wx * h;
        c.z += wz * h;
        c.odometer += c.vx.abs() * h;
        c.wheel += (c.vx / k.wheel_radius) * h;

        let proj = line.track(c.x, c.z, c.segment, 12);
        c.segment = proj.i;
        c.s = proj.s;
        c.d = proj.d;
        c.scrape += h;
        c.impact = 0.0;
        let max_d = half - k.half_width;
        if c.d.abs() > max_d {
            point = line.at(c.s);
            let nx = -point.tz * sign(c.d);
            let nz = point.tx * sign(c.d);
            let over = c.d.abs() - max_d;
            c.x -= nx * over;
            c.z -= nz * over;
            c.d = sign(c.d) * max_d;
            let into = wx * nx + wz * nz;
            if into > 0.0 {
                let tx = wx - nx * into;
                let tz = wz - nz * into;
                let keep = (1.0 - 0.9 * h - (into * 0.06).min(0.5)).max(0.0);
                let ux = tx * keep;
                let uz = tz * keep;
                c.vx = hx * ux + hz * uz;
                c.vy = rx * ux + rz * uz;
                let along_bank = point.tx.atan2(-point.tz) + if c.vx < 0.0 { core::f64::consts::PI } else { 0.0 };
                let off = along_bank - c.heading;
                let off = off.sin().atan2(off.cos());
                if off.abs() < 1.2 {
                    c.heading += off * (h * 2.5).min(1.0);
                    c.yaw_rate *= (1.0 - h * 6.0).max(0.0);
                }
                c.scrape = 0.0;
                c.impact = into;
            }
        }
        if c.s <= 0.5 && wx * point.tx + wz * point.tz < 0.0 {
            c.vx = c.vx.max(0.0);
        }
        point = line.at(c.s);
        c.y = point.y - 0.02 * c.d.abs();
        c.pitch = (point.grade * (hx * point.tx + hz * point.tz)).atan();
        c.ax = ax - c.vy * c.yaw_rate;
        c.ay = ay + c.vx * c.yaw_rate;
    }
}
