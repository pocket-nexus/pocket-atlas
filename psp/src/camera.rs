use glam::Vec3;
use pocket3d_place_psp::Shot;
pub struct Rig {
    pub pos: Vec3,
    pub target: Vec3,
    pub fov: f32,
    pub shot: usize,
    pub shot_time: f32,
    pub cinematic: bool,
    yaw: f32,
    pitch: f32,
}
impl Rig {
    pub fn new(s: Shot) -> Self {
        Self {
            pos: Vec3::new(s.from[0], s.from[1], s.from[2]),
            target: Vec3::new(s.from[3], s.from[4], s.from[5]),
            fov: s.from[6],
            shot: 0,
            shot_time: 0.0,
            cinematic: true,
            yaw: 0.0,
            pitch: 0.0,
        }
    }
    pub fn cut(&mut self, k: usize, shots: &[Shot]) {
        *self = Self::new(shots[k]);
        self.shot = k;
    }
    /// Hands the camera to the visitor where the shot has it.
    pub fn release(&mut self) {
        if self.cinematic {
            let d = (self.target - self.pos).normalize();
            self.yaw = libm::atan2f(d.x, -d.z);
            self.pitch = libm::asinf(d.y);
            self.cinematic = false;
        }
    }
    pub fn update(
        &mut self,
        dt: f32,
        movement: (f32, f32),
        look: (f32, f32),
        shots: &[Shot],
        walk: &[[f32; 6]],
    ) {
        if movement.0.abs() + movement.1.abs() + look.0.abs() + look.1.abs() > 0.0 {
            self.release();
        }
        if self.cinematic {
            self.shot_time += dt;
            let s = shots[self.shot];
            let t = (self.shot_time / s.duration).min(1.0);
            let e = t * t * (3.0 - 2.0 * t);
            let key: [f32; 7] = core::array::from_fn(|i| s.from[i] + (s.to[i] - s.from[i]) * e);
            self.pos = Vec3::new(key[0], key[1], key[2]);
            self.target = Vec3::new(key[3], key[4], key[5]);
            self.fov = key[6];
            if t >= 1.0 {
                self.cut((self.shot + 1) % shots.len(), shots);
            }
        } else {
            self.yaw += look.0 * dt;
            self.pitch = (self.pitch - look.1 * dt * 0.75).clamp(-1.3, 1.3);
            let fwd = Vec3::new(libm::sinf(self.yaw), 0.0, -libm::cosf(self.yaw));
            let side = Vec3::new(-fwd.z, 0.0, fwd.x);
            let p = self.pos + (side * movement.0 - fwd * movement.1) * dt * 3.0;
            if walk.is_empty()
                || walk
                    .iter()
                    .any(|b| (0..3).all(|i| p[i] >= b[i] && p[i] <= b[i + 3]))
            {
                self.pos = p;
            }
            self.target = self.pos
                + Vec3::new(
                    fwd.x * libm::cosf(self.pitch),
                    libm::sinf(self.pitch),
                    fwd.z * libm::cosf(self.pitch),
                );
        }
    }
}
