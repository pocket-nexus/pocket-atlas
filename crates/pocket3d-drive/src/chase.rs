//! The driving cameras (web `routes/shared/drive/chase.ts`): `Chase` trails
//! the car and swings behind it with a lag; `Hood` rides on the bonnet.

use crate::vehicle::Car;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveView {
    Chase,
    Hood,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Eye {
    pub pos: [f64; 3],
    pub target: [f64; 3],
    pub fov: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Chase {
    /// The heading the camera trails along.
    pub yaw: f64,
    /// Smoothed speed (m/s).
    pub speed: f64,
    pub ready: bool,
}

impl Chase {
    pub fn step(&mut self, c: &Car, view: DriveView, dt: f64) -> Eye {
        if !self.ready {
            self.yaw = c.heading;
            self.speed = c.vx.abs();
            self.ready = true;
        }
        let drift = if c.vx.abs() > 2.0 { c.vy.atan2(c.vx.abs()) * 0.5 } else { 0.0 };
        let off = c.heading + drift - self.yaw;
        let off = off.sin().atan2(off.cos());
        self.yaw += off * (1.0 - (-dt * 3.4).exp());
        self.speed += (c.vx.abs() - self.speed) * (1.0 - (-dt * 1.5).exp());
        let (fx, fz) = (self.yaw.sin(), -self.yaw.cos());
        let (hx, hz) = (c.heading.sin(), -c.heading.cos());
        if view == DriveView::Hood {
            return Eye {
                pos: [c.x + hx * 0.15, c.y + 1.32, c.z + hz * 0.15],
                target: [c.x + hx * 30.0, c.y + 1.32 + c.pitch.sin() * 30.0 - 1.4, c.z + hz * 30.0],
                fov: 58.0 + (self.speed * 0.25).min(8.0),
            };
        }
        let back = 5.4 + (self.speed * 0.05).min(1.6);
        Eye {
            pos: [c.x - fx * back, c.y + 2.25 + c.pitch.sin() * -back * 0.4, c.z - fz * back],
            target: [c.x + fx * 7.0, c.y + 1.05 + c.pitch.sin() * 7.0, c.z + fz * 7.0],
            fov: 50.0 + (self.speed * 0.3).min(9.0),
        }
    }
}
