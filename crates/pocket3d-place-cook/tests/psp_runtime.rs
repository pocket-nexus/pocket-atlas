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
fn low_frame_rate_preserves_real_loop_seconds_but_suspend_and_free_camera_are_separate() {
    let mut left = 64_000_000u32;
    let mut elapsed = 0.0f32;
    while left != 0 {
        let step = left.min(117_647); // About 8.5 fps, formerly clamped to 100 ms.
        elapsed += scene::frame_seconds(step);
        left -= step;
    }
    assert!((elapsed - 64.0).abs() < 0.001);
    assert_eq!(scene::frame_seconds(200_000), 0.2);
    assert_eq!(scene::frame_seconds(1_000_000), 1.0);
    assert_eq!(scene::frame_seconds(1_000_001), 0.0);
    assert_eq!(scene::frame_seconds(30_000_000), 0.0);
    assert_eq!(scene::camera_seconds(0.2, false, false), 0.2);
    assert_eq!(scene::camera_seconds(0.2, true, false), 0.0);
    assert_eq!(scene::camera_seconds(0.2, true, true), 0.1);
    assert_eq!(scene::camera_seconds(0.02, true, true), 0.02);
}

#[test]
fn resident_batch_indices_match_fresh_streams_across_lod_visibility_and_pass_changes() {
    let mut pack = Pack::new();
    let base = pack.push(&[0u16, 1, 2, 2, 1, 3]);
    let lod_a = pack.push(&[0u16, 1, 2]);
    let lod_b = pack.push(&[2u16, 1, 3]); // Same count, different immutable range.
    let other = pack.push(&[4u16, 5, 6]);
    let hidden = pp::Span::default();
    let mut main = scene::BatchSelection::new(2);
    let mut reflection = scene::BatchSelection::new(2);
    let mut resident = [0u16; 12];
    let mut reflected = [0u16; 12];
    for (spans, expected_dirty) in [
        ([base, other], true),
        ([base, other], false), // Pose can move; topology remains identical.
        ([lod_a, other], true),
        ([lod_b, other], true),
        ([hidden, other], true),
        ([hidden, other], false),
        ([hidden, hidden], true),
        ([base, other], true), // Re-entry must not reuse the old empty stream.
    ] {
        let changed = main.update(spans.into_iter());
        assert_eq!(changed, expected_dirty);
        if changed {
            main.copy_into(pack.bytes(), &mut resident[..main.count]);
        }
        let expected: Vec<_> = spans
            .into_iter()
            .flat_map(|span| {
                pp::slice::<u16>(pack.bytes(), span)
                    .unwrap()
                    .iter()
                    .copied()
            })
            .collect();
        assert_eq!(&resident[..main.count], expected);
        // Reflection uses a different visibility set and owns separate bytes.
        if reflection.update([hidden, other].into_iter()) {
            reflection.copy_into(pack.bytes(), &mut reflected[..reflection.count]);
        }
        assert_eq!(&reflected[..reflection.count], [4, 5, 6]);
        assert_eq!(&resident[..main.count], expected);
    }
    let empty_lod = pp::Span {
        offset: 0xfffffff0,
        count: 0,
    };
    main.update([hidden, hidden].into_iter());
    assert!(
        !main.update([empty_lod, hidden].into_iter()),
        "empty LOD and hidden draw have identical empty topology"
    );
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

#[allow(dead_code)]
#[path = "../../../psp/src/clip.rs"]
mod clip;

fn clip_vertex(pos: [f32; 3], uv: [f32; 2], color: u32) -> pp::Vertex {
    pp::Vertex { pos, uv, color }
}
fn clip_projection() -> Mat4 {
    glam::camera::rh::proj::opengl::perspective(49.0f32.to_radians(), 480.0 / 272.0, 0.5, 300.0)
}
fn assert_guard(vertices: &[pp::Vertex], mvp: Mat4) {
    for v in vertices {
        let p = mvp * Vec3::from(v.pos).extend(1.0);
        assert!(p.is_finite() && p.w > 0.0);
        assert!(p.z + p.w > -0.0001, "near: {p:?}");
        let x = 2048.0 + p.x / p.w * 240.0;
        let y = 2048.0 - p.y / p.w * 136.0;
        assert!((15.9..=4080.1).contains(&x), "x={x}");
        assert!((15.9..=4080.1).contains(&y), "y={y}");
    }
}

#[test]
fn guard_clip_safe_and_hardware_near_clip_triangles_remain_byte_identical() {
    let mvp = clip_projection();
    let safe = [
        clip_vertex([-0.1, -0.1, -2.0], [-3.0, 2.0], 0x01020304),
        clip_vertex([0.1, -0.1, -2.0], [5.0, 7.0], 0xffabcdef),
        clip_vertex([0.0, 0.1, -2.0], [0.3, 0.9], 0x98765432),
    ];
    let mut out = [pp::Vertex::default(); clip::MAX_VERTICES];
    assert!(clip::triangle(safe, mvp, &mut out).is_none());
    let near = [
        safe[0],
        safe[1],
        clip_vertex([0.0, 0.01, -0.1], [2.0, 3.0], 0x11223344),
    ];
    assert!(
        clip::triangle(near, mvp, &mut out).is_none(),
        "GE already handles this near-plane intersection"
    );
    let guard = clip::Guard::new(mvp);
    assert!(guard.contains(Vec3::new(-0.1, -0.1, -2.0), Vec3::new(0.1, 0.1, -1.0)));
    assert!(!guard.contains(Vec3::new(-20.0, -0.1, -2.0), Vec3::new(20.0, 0.1, 1.0)));
    assert!(!guard.contains(Vec3::splat(f32::NAN), Vec3::ONE));
    let mut events = 0;
    let work = clip::walk(
        &[0, 1, 2],
        &[(0, 3)],
        mvp,
        |i| Vec3::from(safe[i as usize].pos),
        |_| panic!("safe triangle must not decode UV/colour attributes"),
        |run| {
            match run {
                clip::Run::Original(range) => {
                    assert_eq!(range, 0..3);
                }
                clip::Run::Clipped(_) => panic!("safe triangle changed"),
            }
            events += 1;
        },
    );
    assert_eq!(events, 1);
    assert_eq!(work.replaced, 0);
}

#[test]
fn guard_clip_recovers_the_roof_near_intersection_without_changing_its_plane() {
    // A 19.44 m roof triangle, with the camera beside one end. GE's own near
    // clip creates x=7804,6773 and rejects the visible part of the whole face.
    let mvp = clip_projection()
        * glam::camera::rh::view::look_at_mat4(
            Vec3::new(2.5, 2.375, 9.95),
            Vec3::new(-6.0, 2.15, 1.0),
            Vec3::Y,
        );
    let input = [
        clip_vertex([-1.6133782, 3.402023, 3.1245956], [0.0, 0.0], 0xff808080),
        clip_vertex([-1.3092918, 3.402023, 0.2285343], [0.0, 1.0], 0xff808080),
        clip_vertex([17.720112, 3.402023, 5.154612], [1.0, 0.0], 0xff808080),
    ];
    let mut out = [pp::Vertex::default(); clip::MAX_VERTICES];
    let count = clip::triangle(input, mvp, &mut out).expect("roof must use fallback");
    assert!(count >= 6);
    assert_guard(&out[..count], mvp);
    for v in &out[..count] {
        assert!((v.pos[1] - 3.402023).abs() < 0.00001);
        assert_eq!(v.color, 0xff808080);
    }
    for tri in out[..count].chunks_exact(3) {
        let p: Vec<_> = tri
            .iter()
            .map(|v| {
                let p = mvp * Vec3::from(v.pos).extend(1.0);
                p.truncate() / p.w
            })
            .collect();
        assert!(
            (p[1] - p[0]).cross(p[2] - p[0]).z >= -0.00001,
            "roof winding changed"
        );
    }
}

#[test]
fn guard_clip_interpolates_uv_rgba_before_division_and_handles_multiple_planes() {
    let input = [
        clip_vertex(
            [-1.0, 0.0, 0.0],
            [0.0, 2.0],
            u32::from_le_bytes([10, 20, 30, 40]),
        ),
        clip_vertex(
            [20.0, 0.0, 0.0],
            [1.0, 4.0],
            u32::from_le_bytes([210, 120, 70, 240]),
        ),
        clip_vertex([0.0, 1.0, 0.0], [0.0, 0.0], 0xff102030),
    ];
    let mut out = [pp::Vertex::default(); clip::MAX_VERTICES];
    let count = clip::triangle(input, Mat4::IDENTITY, &mut out).unwrap();
    let boundary = out[..count]
        .iter()
        .find(|v| v.pos[0] > 8.0 && v.pos[1].abs() < 0.00001)
        .unwrap();
    let t = (2032.0 / 240.0 + 1.0) / 21.0;
    assert!((boundary.uv[0] - t).abs() < 0.00001);
    assert!((boundary.uv[1] - (2.0 + 2.0 * t)).abs() < 0.00001);
    assert_eq!(
        boundary.color.to_le_bytes(),
        [
            10.0 + 200.0 * t,
            20.0 + 100.0 * t,
            30.0 + 40.0 * t,
            40.0 + 200.0 * t
        ]
        .map(|v| (v + 0.5) as u8)
    );
    let multiple = [
        clip_vertex([-40.0, -40.0, -2.0], [-2.0, 3.0], 0x01020304),
        clip_vertex([40.0, -40.0, -2.0], [4.0, 1.0], 0xffaabbcc),
        clip_vertex([0.0, 40.0, 0.2], [0.0, -4.0], 0x98765432),
    ];
    let count = clip::triangle(multiple, clip_projection(), &mut out).unwrap();
    assert!(count > 0 && count <= clip::MAX_VERTICES);
    assert_guard(&out[..count], clip_projection());
}

#[test]
fn guard_clip_preserves_index_run_order_across_safe_chunks_and_risk_ranges() {
    let mut vertices = Vec::new();
    for i in 0..5 {
        for p in [
            [-0.5, -0.5, 0.0],
            [if i == 1 || i == 3 { 30.0 } else { 0.5 }, -0.5, 0.0],
            [-0.5, 0.5, 0.0],
        ] {
            vertices.push(clip_vertex(p, [i as f32, 0.0], 0xff000000 + i));
        }
    }
    let indices: Vec<u16> = (0..15).collect();
    let mut events = Vec::new();
    let work = clip::walk(
        &indices,
        &[(3, 3), (9, 3)],
        Mat4::IDENTITY,
        |i| Vec3::from(vertices[i as usize].pos),
        |i| vertices[i as usize],
        |run| match run {
            clip::Run::Original(range) => events.push((false, range.start, range.end)),
            clip::Run::Clipped(v) => {
                let source = v[0].uv[0] as usize;
                assert!(v
                    .iter()
                    .all(|v| v.uv[0] == source as f32 && v.color == 0xff000000 + source as u32));
                events.push((true, source, v.len()));
            }
        },
    );
    assert_eq!(
        events,
        [
            (false, 0, 3),
            (true, 1, 6),
            (false, 6, 9),
            (true, 3, 6),
            (false, 12, 15)
        ]
    );
    assert_eq!((work.scanned, work.replaced, work.vertices), (2, 2, 12));
}

#[test]
fn guard_clip_packed_vertices_keep_signed_position_unsigned_uv_and_decode_frame() {
    let d = pp::Draw {
        pos_offset: [13.0, -2.0, 8.0],
        pos_scale: [20.0, 3.0, 1.0],
        uv_offset: [-2.0, 5.0],
        uv_scale: [3.0, 0.5],
        ..Default::default()
    };
    let p = pp::PackedVertex {
        pos: [-32768, 12345, 32767],
        uv: [65535, 43210],
        color: 0xaabbccdd,
        ..Default::default()
    };
    let normalized = clip::packed_vertex(&p);
    let decoded = pp::decode_vertex(&d, &p);
    let decode = Mat4::from_translation(Vec3::from(d.pos_offset))
        * Mat4::from_scale(Vec3::from(d.pos_scale));
    assert_eq!(
        decode
            .transform_point3(Vec3::from(normalized.pos))
            .to_array(),
        decoded.pos
    );
    assert_eq!(normalized.uv[0], 65535.0 / 32768.0);
    for i in 0..2 {
        assert_eq!(
            d.uv_offset[i] + d.uv_scale[i] * normalized.uv[i],
            decoded.uv[i]
        );
    }
    assert_eq!(normalized.color, decoded.color);
}

#[test]
fn guard_blocks_skip_safe_triangles_reuse_immutable_bounds_and_keep_exact_output() {
    let indices: Vec<u16> = (0..192).collect();
    let vertices: Vec<_> = (0..64)
        .flat_map(|i| {
            let right = if i < 32 { 0.5 } else { 30.0 };
            [[-0.5, -0.5, 0.0], [right, -0.5, 0.0], [-0.5, 0.5, 0.0]]
                .map(|p| clip_vertex(p, [i as f32, 0.0], 0xff112233))
        })
        .collect();
    let mut cache = clip::BlockCache::default();
    let mut ranges = Vec::new();
    let key = [16, 0, 1024, indices.len() as u32];
    let skipped = cache.append_ranges(
        key,
        &indices,
        0,
        &clip::Guard::new(Mat4::IDENTITY),
        |i| Vec3::from(vertices[i as usize].pos),
        &mut ranges,
    );
    assert_eq!(skipped, 32);
    assert_eq!(ranges, [(96, 96)]);
    let bytes = cache.bytes();
    assert!(bytes < 2048);
    let capture = |ranges: &[(usize, usize)]| {
        let mut events = Vec::new();
        let work = clip::walk(
            &indices,
            ranges,
            Mat4::IDENTITY,
            |i| Vec3::from(vertices[i as usize].pos),
            |i| vertices[i as usize],
            |run| match run {
                clip::Run::Original(r) => events.push((Some(r), Vec::new())),
                clip::Run::Clipped(v) => {
                    events.push((None, bytemuck::cast_slice::<_, u8>(v).to_vec()))
                }
            },
        );
        (events, work)
    };
    let (before, a) = capture(&[(0, 192)]);
    let (after, b) = capture(&ranges);
    assert_eq!(
        before, after,
        "bounds filtering must not change output or triangle order"
    );
    assert_eq!((a.replaced, a.vertices), (b.replaced, b.vertices));
    assert_eq!((a.scanned, b.scanned), (64, 32));
    ranges.clear();
    // Same immutable geometry under a different model/camera uses new planes,
    // never stale posed bounds, and no longer reads the vertex stream.
    let skipped = cache.append_ranges(
        key,
        &indices,
        0,
        &clip::Guard::new(Mat4::from_scale(Vec3::splat(0.01))),
        |_| panic!("immutable bounds already built"),
        &mut ranges,
    );
    assert_eq!(skipped, 64);
    assert!(ranges.is_empty());
    assert_eq!(cache.bytes(), bytes);
    // Identical index spans backed by another vertex buffer cannot alias.
    let skipped = cache.append_ranges(
        [32, 0, 1024, 192],
        &indices,
        0,
        &clip::Guard::new(Mat4::IDENTITY),
        |i| Vec3::from(vertices[96 + i as usize % 96].pos),
        &mut ranges,
    );
    assert_eq!(skipped, 0);
    assert_eq!(ranges, [(0, 192)]);
}

#[test]
fn guard_block_cache_budget_falls_back_to_the_complete_ordered_index_range() {
    let indices: Vec<u16> = (0..96).collect();
    let mut cache = clip::BlockCache::default();
    let mut ranges = Vec::new();
    let guard = clip::Guard::new(Mat4::IDENTITY);
    let mut exhausted = false;
    for i in 0..4000 {
        ranges.clear();
        let before = cache.bytes();
        cache.append_ranges(
            [i, 0, 0, 96],
            &indices,
            12,
            &guard,
            |_| Vec3::ZERO,
            &mut ranges,
        );
        assert!(cache.bytes() <= 256 * 1024);
        if cache.bytes() == before {
            assert_eq!(ranges, [(12, 96)]);
            exhausted = true;
            break;
        }
        assert!(ranges.is_empty());
    }
    assert!(exhausted);
}
