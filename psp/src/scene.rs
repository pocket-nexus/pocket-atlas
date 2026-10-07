use alloc::{vec, vec::Vec};
use glam::{Mat4, Quat, Vec3};
use pocket3d_place_psp as pp;

pub struct Scene<'a> {
    pub bytes: &'a [u8],
    pub header: &'a pp::Header,
    pub textures: &'a [pp::Texture],
    pub materials: &'a [pp::Material],
    pub draws: &'a [pp::Draw],
    pub nodes: &'a [pp::Node],
    pub shots: &'a [pp::Shot],
    pub dry: &'a [[f32; 6]],
    pub walkable: &'a [[f32; 6]],
    pub lights: &'a [pp::Light],
    pub sprites: &'a [pp::SpriteGroup],
    pub world: Vec<Mat4>,
    pub skinned: Vec<Vec<pp::Vertex>>,
    pub door: f32,
    pub bounds: Vec<(Vec3, Vec3)>,
    pub batches: Vec<Vec<usize>>,
}
impl<'a> Scene<'a> {
    pub fn new(bytes: &'a [u8], h: &'a pp::Header) -> Self {
        let draws = pp::slice::<pp::Draw>(bytes, h.draws).unwrap();
        let mut batches: Vec<Vec<usize>> = Vec::new();
        for (i, d) in draws.iter().enumerate() {
            if let Some(g) = batches.iter_mut().find(|g| {
                let a = &draws[g[0]];
                a.vertices.offset == d.vertices.offset
                    && a.material == d.material
                    && a.flags == d.flags
                    && a.node == d.node
                    && d.weights.count == 0
            }) {
                g.push(i);
            } else {
                batches.push(vec![i]);
            }
        }
        Self {
            bytes,
            header: h,
            textures: pp::slice(bytes, h.textures).unwrap(),
            materials: pp::slice(bytes, h.materials).unwrap(),
            draws,
            nodes: pp::slice(bytes, h.nodes).unwrap(),
            shots: pp::slice(bytes, h.shots).unwrap(),
            dry: pp::slice(bytes, h.dry_boxes).unwrap(),
            walkable: pp::slice(bytes, h.walkable).unwrap(),
            lights: pp::slice(bytes, h.lights).unwrap(),
            sprites: pp::slice(bytes, h.sprites).unwrap(),
            world: vec![Mat4::IDENTITY; h.nodes.count as usize],
            skinned: draws
                .iter()
                .map(|d| {
                    if d.weights.count > 0 {
                        pp::slice::<pp::Vertex>(bytes, d.vertices).unwrap().to_vec()
                    } else {
                        Vec::new()
                    }
                })
                .collect(),
            door: 0.0,
            bounds: draws
                .iter()
                .map(|d| (Vec3::from_array(d.min), Vec3::from_array(d.max)))
                .collect(),
            batches,
        }
    }
    pub fn track<const N: usize>(&self, span: pp::Span, time: f32) -> [f32; N] {
        let values = pp::slice::<f32>(self.bytes, span).unwrap();
        let frames = values.len() / N;
        let f = (time * self.header.fps) % frames as f32;
        let a = f as usize;
        let b = (a + 1) % frames;
        let t = f - a as f32;
        core::array::from_fn(|i| values[a * N + i] * (1.0 - t) + values[b * N + i] * t)
    }
    pub fn update(&mut self, time: f32, eye: Vec3) {
        let open =
            (eye - Vec3::from_array(self.header.door_trigger)).length() < self.header.door_radius;
        self.door += (if open { 1.0 } else { 0.0 } - self.door) * 0.12;
        for (i, n) in self.nodes.iter().enumerate() {
            let (mut t, r) = if n.track.count > 0 {
                let v = self.track::<7>(n.track, time);
                (
                    Vec3::new(v[0], v[1], v[2]),
                    Quat::from_xyzw(v[3], v[4], v[5], v[6]).normalize(),
                )
            } else {
                (
                    Vec3::from_array(n.translation),
                    Quat::from_array(n.rotation),
                )
            };
            if self.header.doors[0] == i as u32 {
                t.x -= self.door * self.header.door_travel;
            }
            if self.header.doors[1] == i as u32 {
                t.x += self.door * self.header.door_travel;
            }
            let local = Mat4::from_scale_rotation_translation(Vec3::from_array(n.scale), r, t);
            self.world[i] = if n.parent == pp::NONE {
                local
            } else {
                self.world[n.parent as usize] * local
            };
        }
        for (i, d) in self.draws.iter().enumerate() {
            if d.weights.count == 0 {
                if d.node != pp::NONE {
                    let m = self.world[d.node as usize];
                    let c = (Vec3::from_array(d.min) + Vec3::from_array(d.max)) * 0.5;
                    let e = (Vec3::from_array(d.max) - Vec3::from_array(d.min)) * 0.5;
                    let wc = m.transform_point3(c);
                    let we = m.x_axis.truncate().abs() * e.x
                        + m.y_axis.truncate().abs() * e.y
                        + m.z_axis.truncate().abs() * e.z;
                    self.bounds[i] = (wc - we, wc + we);
                }
                continue;
            }
            let joints = pp::slice::<pp::Joint>(self.bytes, d.joints).unwrap();
            let mut matrices = [Mat4::IDENTITY; 64];
            for (j, joint) in joints.iter().enumerate() {
                matrices[j] =
                    self.world[joint.node as usize] * Mat4::from_cols_array(&joint.inverse);
            }
            let weights = pp::slice::<pp::Weights>(self.bytes, d.weights).unwrap();
            let src = pp::slice::<pp::Vertex>(self.bytes, d.vertices).unwrap();
            let mut lo = Vec3::splat(f32::MAX);
            let mut hi = Vec3::splat(f32::MIN);
            for ((out, v), w) in self.skinned[i].iter_mut().zip(src).zip(weights) {
                let mut p = Vec3::ZERO;
                let pos = Vec3::from_array(v.pos);
                for k in 0..4 {
                    if w.weights[k] > 0 {
                        p += matrices[w.joints[k] as usize].transform_point3(pos)
                            * (w.weights[k] as f32 / 255.0);
                    }
                }
                out.pos = p.to_array();
                lo = lo.min(p);
                hi = hi.max(p);
            }
            self.bounds[i] = (lo, hi);
        }
    }
    pub fn model(&self, d: &pp::Draw) -> Mat4 {
        if d.weights.count == 0 && d.node != pp::NONE {
            self.world[d.node as usize]
        } else {
            Mat4::IDENTITY
        }
    }
}
