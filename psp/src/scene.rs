use alloc::{vec, vec::Vec};
use glam::{Mat4, Quat, Vec3};
use pocket3d_place_psp as pp;

/// Keep scene seconds independent of normal low frame rates. A debugger or
/// suspend gap above one second is excluded instead of jumping on resume.
pub fn frame_seconds(elapsed_us: u32) -> f32 {
    if elapsed_us <= 1_000_000 {
        elapsed_us as f32 / 1_000_000.0
    } else {
        0.0
    }
}
/// Scene pause/fixed-time capture stops the cinematic clock, while free
/// camera inspection remains responsive and caps each movement step.
pub fn camera_seconds(elapsed: f32, stopped: bool, navigating: bool) -> f32 {
    if navigating {
        elapsed.min(0.1)
    } else if stopped {
        0.0
    } else {
        elapsed
    }
}

/// Exact per-draw selections for one GE batch and one render pass. Models
/// and skin poses can move without changing this immutable index stream.
pub struct BatchSelection {
    pub spans: Vec<pp::Span>,
    pub count: usize,
}
impl BatchSelection {
    pub fn new(draws: usize) -> Self {
        Self {
            spans: vec![pp::Span::default(); draws],
            count: 0,
        }
    }
    /// Hidden and valid empty LODs have the same empty selection. Comparison
    /// is exact, including offsets; equal-length different LODs cannot alias.
    pub fn update(&mut self, spans: impl Iterator<Item = pp::Span>) -> bool {
        let mut changed = false;
        self.count = 0;
        for (previous, selected) in self.spans.iter_mut().zip(spans) {
            let selected = if selected.count == 0 {
                pp::Span::default()
            } else {
                selected
            };
            changed |= previous.offset != selected.offset || previous.count != selected.count;
            *previous = selected;
            self.count += selected.count as usize;
        }
        changed
    }
    pub fn copy_into(&self, bytes: &[u8], out: &mut [u16]) {
        let mut at = 0;
        for &span in &self.spans {
            if span.count != 0 {
                let source = pp::slice::<u16>(bytes, span).unwrap();
                out[at..at + source.len()].copy_from_slice(source);
                at += source.len();
            }
        }
        debug_assert_eq!(at, self.count);
    }
}

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
                    && a.vertex_format == d.vertex_format
                    && a.pos_offset == d.pos_offset
                    && a.pos_scale == d.pos_scale
                    && a.uv_offset == d.uv_offset
                    && a.uv_scale == d.uv_scale
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
        let flip = N == 7
            && (3..7)
                .map(|i| values[a * N + i] * values[b * N + i])
                .sum::<f32>()
                < 0.0;
        core::array::from_fn(|i| {
            values[a * N + i] * (1.0 - t)
                + values[b * N + i] * (if flip && i >= 3 { -t } else { t })
        })
    }
    fn node_track(&self, node: &pp::Node, time: f32) -> [f32; 7] {
        if node.track_encoding == 0 {
            return self.track::<7>(node.track, time);
        }
        let keys = pp::slice::<pp::PackedTrs>(self.bytes, node.track).unwrap();
        let f = (time * self.header.fps) % keys.len() as f32;
        let a = f as usize;
        let b = (a + 1) % keys.len();
        let t = f - a as f32;
        let (a, b) = (
            pp::decode_trs(node, &keys[a]),
            pp::decode_trs(node, &keys[b]),
        );
        let flip = (3..7).map(|i| a[i] * b[i]).sum::<f32>() < 0.0;
        core::array::from_fn(|i| a[i] * (1.0 - t) + b[i] * (if flip && i >= 3 { -t } else { t }))
    }
    #[allow(dead_code)] // Host regressions use the complete update entry point.
    pub fn update(&mut self, time: f32, eye: Vec3) {
        self.update_pose(time, eye);
        self.update_bounds();
    }
    pub fn update_pose(&mut self, time: f32, eye: Vec3) {
        let open =
            (eye - Vec3::from_array(self.header.door_trigger)).length() < self.header.door_radius;
        self.door += (if open { 1.0 } else { 0.0 } - self.door) * 0.12;
        for (i, n) in self.nodes.iter().enumerate() {
            let (mut t, r) = if n.track.count > 0 {
                let v = self.node_track(n, time);
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
    }
    pub fn update_bounds(&mut self) {
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
