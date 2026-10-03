//! Host execution of the PSP's actual pose, skin bounds and batching code.
extern crate alloc;
#[allow(dead_code)]
#[path = "../../../psp/src/scene.rs"]
mod scene;
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use pocket3d_place_psp as pp;

struct Pack(Vec<u32>);
impl Pack {
    fn new() -> Self {
        Self(vec![0; core::mem::size_of::<pp::Header>() / 4])
    }
    fn push<T: Pod>(&mut self, values: &[T]) -> pp::Span {
        self.0.resize(self.0.len().next_multiple_of(4), 0);
        let at = self.0.len() * 4;
        let bytes = bytemuck::cast_slice::<_, u8>(values);
        self.0.resize((at + bytes.len()).div_ceil(4), 0);
        bytemuck::cast_slice_mut::<_, u8>(&mut self.0)[at..at + bytes.len()].copy_from_slice(bytes);
        pp::Span {
            offset: at as u32,
            count: values.len() as u32,
        }
    }
    fn finish(&mut self, nodes: &[pp::Node], draws: &[pp::Draw], frames: u32) {
        let mut h = pp::Header::zeroed();
        h.magic = pp::MAGIC;
        h.version = pp::VERSION;
        h.fps = 15.0;
        h.frames = frames;
        h.fog_far = 250.0;
        h.doors = [pp::NONE; 2];
        h.sky_texture = pp::NONE;
        h.cloud_texture = pp::NONE;
        h.nodes = self.push(nodes);
        h.draws = self.push(draws);
        h.materials = self.push(&[pp::Material {
            texture: pp::NONE,
            grid: [1, 1],
            ..Default::default()
        }]);
        let camera = [0.0, 1.0, 3.0, 0.0, 1.0, 0.0, 45.0];
        h.shots = self.push(&[pp::Shot {
            from: camera,
            to: camera,
            duration: 64.0,
            ..Default::default()
        }]);
        h.bytes = self.0.len() as u32 * 4;
        bytemuck::cast_slice_mut::<_, u8>(&mut self.0)[..core::mem::size_of::<pp::Header>()]
            .copy_from_slice(bytemuck::bytes_of(&h));
    }
    fn bytes(&self) -> &[u8] {
        bytemuck::cast_slice(&self.0)
    }
}
fn node() -> pp::Node {
    pp::Node {
        parent: pp::NONE,
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0; 3],
        ..Default::default()
    }
}

#[test]
fn full_64_second_packed_motion_interpolates_antipodal_quaternions_and_wraps() {
    let mut pack = Pack::new();
    let frames = 960;
    let keys: Vec<_> = (0..frames)
        .map(|i| pp::PackedTrs {
            translation: [i as i16, 0, 0],
            rotation: [0, 0, 0, if i % 2 == 0 { 32767 } else { -32767 }],
            padding: 0,
        })
        .collect();
    let motion = pp::Node {
        track: pack.push(&keys),
        track_encoding: 1,
        track_offset: [5.0, 0.0, 0.0],
        track_scale: [32767.0, 0.0, 0.0],
        ..node()
    };
    pack.finish(&[motion], &[], frames);
    let header = pp::validate(pack.bytes()).unwrap();
    let mut s = scene::Scene::new(pack.bytes(), header);
    // Samples after the old ten-second range still retain all motion.
    for (time, x) in [
        (0.0, 5.0),
        (18.0, 275.0),
        (33.0, 500.0),
        (63.9, 963.5),
        (64.0, 5.0),
        (64.5, 12.5),
    ] {
        s.update(time, Vec3::ZERO);
        assert!((s.world[0].transform_point3(Vec3::ZERO).x - x).abs() < 0.002);
        assert!((s.world[0].transform_vector3(Vec3::X) - Vec3::X).length() < 0.00001);
    }
    // At the loop boundary, q and -q represent the same orientation.
    s.update(63.966_667, Vec3::ZERO);
    assert!(s.world[0].is_finite());
    assert!((s.world[0].transform_vector3(Vec3::X) - Vec3::X).length() < 0.00001);
}

#[test]
fn skin_bounds_cover_separated_moving_joints_and_weighted_vertices() {
    let mut pack = Pack::new();
    let vertices = [pp::Vertex {
        pos: [1.0, 0.0, 0.0],
        color: 0xffffffff,
        ..Default::default()
    }; 3];
    let d = pp::Draw {
        node: pp::NONE,
        vertices: pack.push(&vertices),
        indices: pack.push(&[0u16, 1, 2]),
        joints: pack.push(&[
            pp::Joint {
                node: 0,
                inverse: Mat4::IDENTITY.to_cols_array(),
            },
            pp::Joint {
                node: 1,
                inverse: Mat4::IDENTITY.to_cols_array(),
            },
        ]),
        weights: pack.push(&[
            pp::Weights {
                joints: [0, 0, 0, 0],
                weights: [255, 0, 0, 0],
            },
            pp::Weights {
                joints: [1, 0, 0, 0],
                weights: [255, 0, 0, 0],
            },
            pp::Weights {
                joints: [0, 1, 0, 0],
                weights: [128, 127, 0, 0],
            },
        ]),
        min: [1.0, 0.0, 0.0],
        max: [1.0, 0.0, 0.0],
        ..Default::default()
    };
    let moving = pp::Node {
        track: pack.push(&[
            0.0f32, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 20.0, 0.0, 0.0, 0.0, 0.0, -1.0,
        ]),
        ..node()
    };
    let fixed = pp::Node {
        translation: [-20.0, 0.0, 0.0],
        scale: [2.0, 3.0, 0.5],
        ..node()
    };
    pack.finish(&[fixed, moving], &[d], 2);
    let mut s = scene::Scene::new(pack.bytes(), pp::validate(pack.bytes()).unwrap());
    for (t, y) in [(0.0, 10.0), (1.0 / 30.0, 15.0), (1.0 / 15.0, 20.0)] {
        s.update(t, Vec3::ZERO);
        assert_eq!(s.skinned[0][0].pos, [-18.0, 0.0, 0.0]);
        assert!((s.skinned[0][1].pos[1] - y).abs() < 0.00001);
        let blend = (Vec3::new(-18.0, 0.0, 0.0) * 128.0 + Vec3::new(1.0, y, 0.0) * 127.0) / 255.0;
        assert!((Vec3::from(s.skinned[0][2].pos) - blend).length() < 0.00001);
        let (lo, hi) = s.bounds[0];
        for v in &s.skinned[0] {
            let p = Vec3::from(v.pos);
            assert!(p.cmpge(lo).all() && p.cmple(hi).all());
        }
        assert_eq!(lo.x, -18.0);
        assert_eq!(hi.x, 1.0);
    }
}

#[test]
fn packed_content_sharing_cannot_batch_different_decode_transforms() {
    let mut pack = Pack::new();
    let vertices = pack.push(&[pp::PackedVertex::default(); 3]);
    let indices = pack.push(&[0u16, 1, 2]);
    let a = pp::Draw {
        vertices,
        indices,
        node: pp::NONE,
        vertex_format: 1,
        ..Default::default()
    };
    let b = pp::Draw {
        pos_offset: [10.0, 0.0, 0.0],
        ..a
    };
    let c = pp::Draw {
        uv_scale: [2.0, 1.0],
        ..a
    };
    pack.finish(&[], &[a, b, c, a], 1);
    let s = scene::Scene::new(pack.bytes(), pp::validate(pack.bytes()).unwrap());
    assert_eq!(s.batches, [vec![0, 3], vec![1], vec![2]]);
}
