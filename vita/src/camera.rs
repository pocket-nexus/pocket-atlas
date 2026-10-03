//! Camera rig: authored cinematic shots with dip-to-black cuts (the demo's
//! sequencer) and a free-fly mode on the sticks. Free mode returns to the
//! cinematic after 40 s without input.

use glam::{Mat4, Vec3};
use pocket3d_place as pc;

pub struct View {
    pub pos: Vec3,
    pub target: Vec3,
    pub fov_y: f32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Cinematic,
    Free,
}

pub struct Rig {
    pub mode: Mode,
    shots: Vec<pc::Shot>,
    walk: Vec<[f32; 6]>,
    shot: usize,
    shot_time: f32,
    pub fade: f32,
    pub bars: f32,
    yaw: f32,
    pitch: f32,
    /// Eased look rate (rad/s across, up).
    look: (f32, f32),
    pos: Vec3,
    fov: f32,
    idle: f32,
}

fn ease(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn lerp_key(a: &pc::ShotKey, b: &pc::ShotKey, t: f32) -> View {
    View {
        pos: Vec3::from(a.pos).lerp(Vec3::from(b.pos), t),
        target: Vec3::from(a.target).lerp(Vec3::from(b.target), t),
        fov_y: a.fov + (b.fov - a.fov) * t,
    }
}

impl Rig {
    pub fn new(set: &pc::CameraSet) -> Self {
        Self {
            mode: Mode::Cinematic,
            shots: set.shots.clone(),
            walk: set.walkable.clone(),
            shot: 0,
            shot_time: 0.0,
            fade: 1.0,
            bars: 1.0,
            yaw: 0.0,
            pitch: 0.0,
            look: (0.0, 0.0),
            pos: Vec3::new(4.0, 1.6, 8.0),
            fov: 50.0,
            idle: 0.0,
        }
    }

    pub fn shot_name(&self) -> &str {
        self.shots.get(self.shot).map(|s| s.name.as_str()).unwrap_or("")
    }

    pub fn shot_count(&self) -> usize {
        self.shots.len()
    }

    pub fn shot_index(&self) -> usize {
        self.shot
    }

    /// Cuts to shot `k` (cinematic).
    pub fn set_shot(&mut self, k: usize) {
        if !self.shots.is_empty() {
            self.shot = k % self.shots.len();
            self.shot_time = 0.0;
        }
        self.mode = Mode::Cinematic;
    }

    pub fn next_shot(&mut self) {
        self.set_shot(self.shot + 1);
    }

    /// Free flight from a view (a route hands the camera over from the car).
    pub fn free_from(&mut self, current: &View) {
        self.mode = Mode::Free;
        self.pos = current.pos;
        let d = (current.target - current.pos).normalize_or(Vec3::NEG_Z);
        self.yaw = d.x.atan2(-d.z);
        self.pitch = d.y.asin();
        self.fov = current.fov_y;
        self.fade = 0.0;
        self.look = (0.0, 0.0);
        self.idle = 0.0;
    }

    /// `stick`: left (move x, z), right (look x, y); `lift`: up/down in m/s.
    pub fn update(&mut self, dt: f32, time: f32, left: (f32, f32), right: (f32, f32), lift: f32, current: &View) -> View {
        let active = left.0.abs() + left.1.abs() + right.0.abs() + right.1.abs() + lift.abs() > 0.0;
        if active && self.mode == Mode::Cinematic {
            // Take over from wherever the shot is.
            self.mode = Mode::Free;
            self.pos = current.pos;
            let d = (current.target - current.pos).normalize_or(Vec3::NEG_Z);
            self.yaw = d.x.atan2(-d.z);
            self.pitch = d.y.asin();
            self.fov = current.fov_y;
            self.fade = 0.0;
            self.look = (0.0, 0.0);
        }
        let k = 1.0 - (-dt * 2.5).exp();
        match self.mode {
            Mode::Cinematic => {
                self.bars += (1.0 - self.bars) * k;
                if self.shots.is_empty() {
                    return View { pos: self.pos, target: self.pos + Vec3::NEG_Z, fov_y: self.fov };
                }
                let s = &self.shots[self.shot];
                self.shot_time += dt;
                let t = (self.shot_time / s.duration).min(1.0);
                let mut v = lerp_key(&s.from, &s.to, ease(t));
                v.pos.x += (time * 0.53).sin() * 0.025;
                v.pos.y += (time * 0.71 + 1.3).sin() * 0.018;
                let fade_len = 0.7;
                let out = ((self.shot_time - (s.duration - fade_len)) / fade_len).max(0.0);
                let inn = (1.0 - self.shot_time / fade_len).max(0.0);
                self.fade = out.max(inn).min(1.0);
                if self.shot_time >= s.duration {
                    self.shot = (self.shot + 1) % self.shots.len();
                    self.shot_time = 0.0;
                }
                v
            }
            Mode::Free => {
                self.bars += (0.0 - self.bars) * k;
                self.idle = if active { 0.0 } else { self.idle + dt };
                if self.idle > 40.0 {
                    self.idle = 0.0;
                    self.next_shot();
                }
                // Look: squared response (fine aim near the centre), at most
                // 70°/s across and 45°/s up and down, eased in over ~80 ms.
                let want = (right.0 * right.0.abs() * 1.2, right.1 * right.1.abs() * 0.8);
                let e = 1.0 - (-dt * 12.0).exp();
                self.look.0 += (want.0 - self.look.0) * e;
                self.look.1 += (want.1 - self.look.1) * e;
                self.yaw += self.look.0 * dt;
                self.pitch = (self.pitch - self.look.1 * dt).clamp(-1.3, 1.3);
                let fwd = Vec3::new(self.yaw.sin() * self.pitch.cos(), self.pitch.sin(), -self.yaw.cos() * self.pitch.cos());
                let flat = Vec3::new(self.yaw.sin(), 0.0, -self.yaw.cos());
                let side = Vec3::new(self.yaw.cos(), 0.0, self.yaw.sin());
                let speed = 4.0;
                let mut p = self.pos + (flat * -left.1 + side * left.0) * speed * dt + Vec3::Y * lift * dt * 2.0;
                p.y = p.y.max(0.25);
                if !self.walk.is_empty() && !self.walk.iter().any(|b| p.x >= b[0] && p.y >= b[1] && p.z >= b[2] && p.x <= b[3] && p.y <= b[4] && p.z <= b[5]) {
                    // Slide along the boundary: keep the axis that stays inside.
                    let inside = |q: Vec3| self.walk.iter().any(|b| q.x >= b[0] && q.y >= b[1] && q.z >= b[2] && q.x <= b[3] && q.y <= b[4] && q.z <= b[5]);
                    let px = Vec3::new(p.x, self.pos.y.max(p.y.min(self.pos.y)), self.pos.z);
                    let pz = Vec3::new(self.pos.x, px.y, p.z);
                    p = if inside(px) { px } else if inside(pz) { pz } else { self.pos };
                }
                self.pos = p;
                self.fade = 0.0;
                View { pos: self.pos, target: self.pos + fwd, fov_y: self.fov }
            }
        }
    }
}

/// Reversed-depth infinite perspective (near → 1, infinity → 0) for GXM with
/// a [0, 1] depth viewport.
pub fn projection(fov_y_deg: f32, aspect: f32, near: f32) -> Mat4 {
    let f = 1.0 / (fov_y_deg.to_radians() * 0.5).tan();
    Mat4::from_cols_array(&[f / aspect, 0.0, 0.0, 0.0, 0.0, f, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, near, 0.0])
}

/// Mirror across the street plane y = 0.
pub fn mirror() -> Mat4 {
    Mat4::from_scale(Vec3::new(1.0, -1.0, 1.0))
}

/// Six frustum planes (xyz normal pointing inside, w distance) from a
/// view-projection matrix whose depth runs 1 (near) → 0 (infinity).
pub fn planes(vp: &Mat4) -> [glam::Vec4; 5] {
    let r = vp.transpose();
    let (x, y, z, w) = (r.x_axis, r.y_axis, r.z_axis, r.w_axis);
    let n = |p: glam::Vec4| p / p.truncate().length();
    [n(w + x), n(w - x), n(w + y), n(w - y), n(w - z)]
}

pub fn visible(planes: &[glam::Vec4; 5], min: Vec3, max: Vec3) -> bool {
    for p in planes {
        let v = Vec3::new(if p.x >= 0.0 { max.x } else { min.x }, if p.y >= 0.0 { max.y } else { min.y }, if p.z >= 0.0 { max.z } else { min.z });
        if p.truncate().dot(v) + p.w < 0.0 {
            return false;
        }
    }
    true
}
