//! Native PSP GE renderer. Geometry and textures stay in main RAM; VRAM
//! holds two 8888 framebuffers and depth. Reflection uses the wet surfaces'
//! stencil, so reflected buildings never bleed onto the dry pavement.
use crate::{camera::Rig, scene::Scene};
use core::{ffi::c_void, ptr};
use glam::{Mat4, Vec3, Vec4};
use pocket3d_place_psp as pp;
use psp::{sys::*, Align16};

static mut LIST: Align16<[u32; 262144]> = Align16([0; 262144]);
const FB: usize = 512 * 272 * 4;
pub struct Renderer {
    hot_texture: u32,
    hot_address: *const u8,
    bound_texture: u32,
    indices: alloc::vec::Vec<Align16<[u16; 8]>>,
    index_cursor: usize,
}
pub struct Stats {
    pub draws: u32,
    pub triangles: u32,
    pub gpu_us: u32,
}
/// Each pass owns one purpose; stencil/reflection state is set by frame().
#[derive(Clone, Copy, PartialEq)]
enum Pass {
    WetMask,
    Reflection,
    WetSurface,
    Opaque,
    Transparent,
}
impl Pass {
    fn includes(self, draw: &pp::Draw, material: &pp::Material) -> bool {
        let wet = material.flags & pp::WET != 0;
        let alpha = material.flags & pp::ALPHA != 0;
        match self {
            Self::WetMask => wet,
            Self::Reflection => !wet && !alpha && draw.flags & pp::NO_REFLECT == 0,
            Self::WetSurface => wet && !alpha,
            Self::Opaque => !wet && !alpha,
            Self::Transparent => alpha,
        }
    }
}

unsafe fn matrix(kind: MatrixMode, m: Mat4) {
    let data = Align16(m.to_cols_array());
    sceGuSetMatrix(kind, &*(data.0.as_ptr() as *const ScePspFMatrix4));
}
fn planes(vp: Mat4) -> [Vec4; 6] {
    let r = vp.transpose();
    [
        r.w_axis + r.x_axis,
        r.w_axis - r.x_axis,
        r.w_axis + r.y_axis,
        r.w_axis - r.y_axis,
        r.w_axis + r.z_axis,
        r.w_axis - r.z_axis,
    ]
}
fn visible(p: &[Vec4; 6], lo: Vec3, hi: Vec3) -> bool {
    p.iter().all(|v| {
        v.truncate().dot(Vec3::new(
            if v.x >= 0.0 { hi.x } else { lo.x },
            if v.y >= 0.0 { hi.y } else { lo.y },
            if v.z >= 0.0 { hi.z } else { lo.z },
        )) + v.w
            >= 0.0
    })
}
fn hash(mut n: u32) -> f32 {
    n = n.wrapping_mul(747796405).wrapping_add(2891336453);
    n = ((n >> ((n >> 28) + 4)) ^ n).wrapping_mul(277803737);
    ((n >> 22) ^ n) as f32 / 4294967296.0
}

impl Renderer {
    pub unsafe fn new(scene: &Scene) -> Self {
        sceGuInit();
        sceGuStart(GuContextType::Direct, ptr::addr_of_mut!(LIST.0) as *mut _);
        sceGuDrawBuffer(DisplayPixelFormat::Psm8888, ptr::null_mut(), 512);
        sceGuDispBuffer(480, 272, FB as *mut c_void, 512);
        sceGuDepthBuffer((FB * 2) as *mut c_void, 512);
        sceGuOffset(2048 - 240, 2048 - 136);
        sceGuViewport(2048, 2048, 480, 272);
        sceGuDepthRange(65535, 0);
        sceGuDepthFunc(DepthFunc::GreaterOrEqual);
        sceGuScissor(0, 0, 480, 272);
        sceGuEnable(GuState::ScissorTest);
        sceGuEnable(GuState::DepthTest);
        sceGuEnable(GuState::ClipPlanes);
        sceGuFrontFace(FrontFaceDirection::CounterClockwise);
        sceGuShadeModel(ShadingModel::Smooth);
        sceGuTexFilter(TextureFilter::LinearMipmapNearest, TextureFilter::Linear);
        sceGuTexLevelMode(TextureLevelMode::Auto, -0.5);
        sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
        sceGuFinish();
        sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sceDisplayWaitVblankStart();
        sceGuDisplay(true);
        // Keep the most frequently referenced atlas in the remaining EDRAM.
        let mut uses = alloc::vec![0usize;scene.textures.len()];
        for d in scene.draws {
            let t = scene.materials[d.material as usize].texture;
            if t != pp::NONE {
                uses[t as usize] += d.indices.count as usize;
            }
        }
        let offset = FB * 2 + 512 * 272 * 2;
        let hot_texture = scene
            .textures
            .iter()
            .enumerate()
            .filter(|(_, t)| t.pixels.count as usize <= 2 * 1024 * 1024 - offset)
            .max_by_key(|(i, _)| uses[*i])
            .map(|(i, _)| i as u32)
            .unwrap_or(pp::NONE);
        let hot_address = (0x04000000usize + offset) as *mut u8;
        if hot_texture != pp::NONE {
            let t = &scene.textures[hot_texture as usize];
            ptr::copy_nonoverlapping(
                scene.bytes.as_ptr().add(t.pixels.offset as usize),
                hot_address,
                t.pixels.count as usize,
            );
            sceKernelDcacheWritebackAll();
        }
        Self {
            hot_texture,
            hot_address,
            bound_texture: pp::NONE,
            indices: alloc::vec![Align16([0u16;8]);scene.draws.iter().map(|d|d.indices.count as usize).sum::<usize>()*3/8+scene.batches.len()*3+8],
            index_cursor: 0,
        }
    }
    unsafe fn draw(
        &mut self,
        s: &Scene,
        index: usize,
        time: f32,
        pass: Pass,
        reflect: bool,
        stats: &mut Stats,
        indices: (u32, *const c_void),
    ) {
        let d = &s.draws[index];
        let mat = &s.materials[d.material as usize];
        if d.indices.count == 0 {
            return;
        }
        let mirror = pass == Pass::Reflection;
        let mask = pass == Pass::WetMask;
        sceGuDepthOffset(mat.depth_bias as i32);
        let wet = mat.flags & pp::WET != 0;
        let mut model = s.model(d);
        if mirror {
            model = Mat4::from_scale(Vec3::new(1.0, -1.0, 1.0)) * model;
        }
        matrix(MatrixMode::Model, model);
        if mat.flags & pp::DOUBLE_SIDED != 0 {
            sceGuDisable(GuState::CullFace);
        } else {
            sceGuEnable(GuState::CullFace);
        }
        sceGuFrontFace(if mirror {
            FrontFaceDirection::Clockwise
        } else {
            FrontFaceDirection::CounterClockwise
        });
        if mat.alpha_test > 0 {
            sceGuEnable(GuState::AlphaTest);
            sceGuAlphaFunc(AlphaFunc::Greater, mat.alpha_test as i32, 255);
        } else {
            sceGuDisable(GuState::AlphaTest);
        }
        if mask {
            sceGuDisable(GuState::Blend);
            sceGuDepthMask(1);
        } else if mat.flags & pp::ALPHA != 0 {
            sceGuEnable(GuState::Blend);
            sceGuBlendFunc(
                BlendOp::Add,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
                0,
                0,
            );
            sceGuDepthMask(1);
        } else if wet && reflect {
            sceGuEnable(GuState::Blend);
            sceGuBlendFunc(
                BlendOp::Add,
                BlendFactor::Fix,
                BlendFactor::Fix,
                0xcccccc,
                0x333333,
            );
            sceGuDepthMask(0);
        } else {
            sceGuDisable(GuState::Blend);
            sceGuDepthMask(if mat.flags & pp::NO_DEPTH_WRITE != 0 {
                1
            } else {
                0
            });
        }
        if mat.texture != pp::NONE {
            let t = &s.textures[mat.texture as usize];
            sceGuEnable(GuState::Texture2D);
            if self.bound_texture != mat.texture {
                self.bound_texture = mat.texture;
                sceGuTexMode(TexturePixelFormat::Psm4444, t.mips as i32 - 1, 0, 1);
                let levels = [
                    MipmapLevel::None,
                    MipmapLevel::Level1,
                    MipmapLevel::Level2,
                    MipmapLevel::Level3,
                    MipmapLevel::Level4,
                    MipmapLevel::Level5,
                    MipmapLevel::Level6,
                ];
                let base = if mat.texture == self.hot_texture {
                    self.hot_address
                } else {
                    s.bytes.as_ptr().add(t.pixels.offset as usize)
                };
                let mut offset = 0;
                for level in 0..t.mips {
                    let (w, h) = (t.width >> level, t.height >> level);
                    sceGuTexImage(
                        levels[level as usize],
                        w as i32,
                        h as i32,
                        w as i32,
                        base.add(offset) as _,
                    );
                    offset += (w * h * 2) as usize;
                }
                sceGuTexWrap(
                    if t.wrap & 1 != 0 {
                        GuTexWrapMode::Clamp
                    } else {
                        GuTexWrapMode::Repeat
                    },
                    if t.wrap & 2 != 0 {
                        GuTexWrapMode::Clamp
                    } else {
                        GuTexWrapMode::Repeat
                    },
                );
            }
            let f = if mat.frames > 0 {
                (time * mat.fps) as u32 % mat.frames
            } else {
                0
            };
            sceGuTexScale(1.0 / mat.grid[0] as f32, 1.0 / mat.grid[1] as f32);
            sceGuTexOffset(
                (f % mat.grid[0]) as f32 / mat.grid[0] as f32 + time * mat.uv_speed[0],
                (f / mat.grid[0]) as f32 / mat.grid[1] as f32 + time * mat.uv_speed[1],
            );
        } else {
            sceGuDisable(GuState::Texture2D);
        }
        let vertex = if d.weights.count > 0 {
            s.skinned[index].as_ptr() as *const c_void
        } else {
            s.bytes.as_ptr().add(d.vertices.offset as usize) as *const c_void
        };
        sceGuDrawArray(
            GuPrimitive::Triangles,
            VertexType::TEXTURE_32BITF
                | VertexType::COLOR_8888
                | VertexType::VERTEX_32BITF
                | VertexType::INDEX_16BIT
                | VertexType::TRANSFORM_3D,
            indices.0 as i32,
            indices.1,
            vertex,
        );
        stats.draws += 1;
        stats.triangles += indices.0 / 3;
    }
    unsafe fn pass(
        &mut self,
        s: &Scene,
        clip: &[Vec4; 6],
        time: f32,
        pass: Pass,
        reflect: bool,
        stats: &mut Stats,
    ) {
        for group in &s.batches {
            let d = &s.draws[group[0]];
            let m = &s.materials[d.material as usize];
            if !pass.includes(d, m) {
                continue;
            }
            let is_visible = |i: usize| {
                let (lo, hi) = s.bounds[i];
                visible(clip, lo, hi)
            };
            let count: u32 = group
                .iter()
                .filter(|&&i| is_visible(i))
                .map(|&i| s.draws[i].indices.count)
                .sum();
            if count == 0 {
                continue;
            }
            if group.len() == 1 || count as usize > pp::MAX_INDICES {
                for &i in group {
                    if is_visible(i) {
                        let d = &s.draws[i];
                        self.draw(
                            s,
                            i,
                            time,
                            pass,
                            reflect,
                            stats,
                            (
                                d.indices.count,
                                s.bytes.as_ptr().add(d.indices.offset as usize) as _,
                            ),
                        );
                    }
                }
            } else {
                let indices = (self.indices.as_mut_ptr() as *mut u16).add(self.index_cursor);
                self.index_cursor += (count as usize + 7) & !7;
                let mut at = 0;
                for &i in group {
                    if is_visible(i) {
                        let d = &s.draws[i];
                        ptr::copy_nonoverlapping(
                            s.bytes.as_ptr().add(d.indices.offset as usize) as *const u16,
                            indices.add(at),
                            d.indices.count as usize,
                        );
                        at += d.indices.count as usize;
                    }
                }
                pocket_psp_ge::cache::writeback_range(indices as *const c_void, count as usize * 2);
                self.draw(
                    s,
                    group[0],
                    time,
                    pass,
                    reflect,
                    stats,
                    (count, indices as _),
                );
            }
        }
    }
    pub unsafe fn frame(
        &mut self,
        s: &Scene,
        rig: &Rig,
        time: f32,
        rain: bool,
        reflect: bool,
    ) -> Stats {
        let mut stats = Stats {
            draws: 0,
            triangles: 0,
            gpu_us: 0,
        };
        self.index_cursor = 0;
        sceKernelDcacheWritebackAll();
        sceGuStart(GuContextType::Direct, ptr::addr_of_mut!(LIST.0) as *mut _);
        sceGuDepthMask(0);
        sceGuPixelMask(0);
        sceGuDisable(GuState::StencilTest);
        sceGuClearColor(s.header.sky_color);
        sceGuClearDepth(0);
        sceGuClearStencil(0);
        sceGuClear(
            ClearBuffer::COLOR_BUFFER_BIT
                | ClearBuffer::DEPTH_BUFFER_BIT
                | ClearBuffer::STENCIL_BUFFER_BIT,
        );
        let projection = glam::camera::rh::proj::opengl::perspective(
            rig.fov * core::f32::consts::PI / 180.0,
            480.0 / 272.0,
            0.5,
            300.0,
        );
        let view = glam::camera::rh::view::look_at_mat4(rig.pos, rig.target, Vec3::Y);
        matrix(MatrixMode::Projection, projection);
        matrix(MatrixMode::View, view);
        let vp = projection * view;
        let clip = planes(vp);
        let mirror_clip = planes(vp * Mat4::from_scale(Vec3::new(1.0, -1.0, 1.0)));
        sceGuEnable(GuState::Fog);
        sceGuFog(s.header.fog_near, s.header.fog_far, s.header.fog_color);
        sceGuEnable(GuState::DepthTest);
        if reflect {
            sceGuEnable(GuState::StencilTest);
            sceGuStencilFunc(StencilFunc::Always, 1, 255);
            sceGuStencilOp(
                StencilOperation::Keep,
                StencilOperation::Keep,
                StencilOperation::Replace,
            );
            sceGuPixelMask(0x00ffffff);
            self.pass(s, &clip, time, Pass::WetMask, reflect, &mut stats);
            sceGuPixelMask(0);
            sceGuDepthMask(0);
            sceGuClear(ClearBuffer::DEPTH_BUFFER_BIT);
            sceGuStencilFunc(StencilFunc::Equal, 1, 255);
            sceGuStencilOp(
                StencilOperation::Keep,
                StencilOperation::Keep,
                StencilOperation::Keep,
            );
            self.pass(s, &mirror_clip, time, Pass::Reflection, reflect, &mut stats);
            sceGuDisable(GuState::StencilTest);
            sceGuDepthMask(0);
            sceGuClear(ClearBuffer::DEPTH_BUFFER_BIT);
        }
        self.pass(s, &clip, time, Pass::WetSurface, reflect, &mut stats);
        self.pass(s, &clip, time, Pass::Opaque, reflect, &mut stats);
        self.pass(s, &clip, time, Pass::Transparent, reflect, &mut stats);
        sceGuDepthOffset(0);
        self.halos(s, rig, time);
        if rain {
            self.rain(s, rig, time);
        }
        sceGuDepthMask(0);
        sceGuDisable(GuState::Blend);
        sceGuDisable(GuState::Fog);
        sceGuFinish();
        let wait = sceKernelGetSystemTimeLow();
        sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        stats.gpu_us = sceKernelGetSystemTimeLow().wrapping_sub(wait);
        stats
    }
    unsafe fn rain(&self, s: &Scene, rig: &Rig, time: f32) {
        const COUNT: usize = 850;
        let raw = sceGuGetMemory((COUNT * 2 * core::mem::size_of::<pp::Vertex>()) as i32)
            as *mut pp::Vertex;
        let mut count = 0;
        let center = Vec3::new(
            libm::floorf(rig.pos.x / 8.0) * 8.0,
            0.0,
            libm::floorf(rig.pos.z / 8.0) * 8.0,
        );
        for i in 0..COUNT {
            let p = center
                + Vec3::new(
                    hash(i as u32 * 3) * 40.0 - 20.0,
                    18.0 - (hash(i as u32 * 3 + 1) * 18.0 + time * 11.0) % 18.0,
                    hash(i as u32 * 3 + 2) * 40.0 - 20.0,
                );
            if s.dry
                .iter()
                .any(|b| (0..3).all(|j| p[j] >= b[j] && p[j] <= b[j + 3]))
            {
                continue;
            }
            let a = pp::Vertex {
                uv: [0.0; 2],
                color: 0x487f898c,
                pos: p.to_array(),
            };
            let b = pp::Vertex {
                uv: [0.0; 2],
                color: 0x087f898c,
                pos: (p + Vec3::new(-0.025, 0.42, 0.01)).to_array(),
            };
            raw.add(count).write(a);
            raw.add(count + 1).write(b);
            count += 2;
        }
        matrix(MatrixMode::Model, Mat4::IDENTITY);
        sceGuDisable(GuState::Texture2D);
        sceGuDisable(GuState::AlphaTest);
        sceGuDisable(GuState::CullFace);
        sceGuDepthMask(1);
        sceGuEnable(GuState::Blend);
        sceGuBlendFunc(
            BlendOp::Add,
            BlendFactor::SrcAlpha,
            BlendFactor::OneMinusSrcAlpha,
            0,
            0,
        );
        sceGuDrawArray(
            GuPrimitive::Lines,
            VertexType::TEXTURE_32BITF
                | VertexType::COLOR_8888
                | VertexType::VERTEX_32BITF
                | VertexType::TRANSFORM_3D,
            count as i32,
            ptr::null(),
            raw as _,
        );
    }
    unsafe fn halos(&self, s: &Scene, rig: &Rig, time: f32) {
        matrix(MatrixMode::Model, Mat4::IDENTITY);
        sceGuDisable(GuState::Texture2D);
        sceGuDisable(GuState::AlphaTest);
        sceGuDisable(GuState::CullFace);
        sceGuDepthMask(1);
        sceGuEnable(GuState::Blend);
        sceGuBlendFunc(
            BlendOp::Add,
            BlendFactor::SrcAlpha,
            BlendFactor::Fix,
            0,
            0xffffff,
        );
        let f = (rig.target - rig.pos).normalize();
        let side = f.cross(Vec3::Y).normalize();
        let up = side.cross(f);
        let raw = sceGuGetMemory((s.lights.len() * 24 * core::mem::size_of::<pp::Vertex>()) as i32)
            as *mut pp::Vertex;
        let mut count = 0;
        for l in s.lights {
            let (p, gain) = if l.track.count > 0 {
                let a = s.track::<4>(l.track, time);
                (Vec3::new(a[0], a[1], a[2]), a[3])
            } else {
                (Vec3::from_array(l.pos), 1.0)
            };
            if gain < 0.01 || (p - rig.pos).dot(f) < 0.5 {
                continue;
            }
            let radius = (l.radius * 0.08).clamp(0.12, 1.1);
            let rgb = l.color & 0xffffff;
            let center = pp::Vertex {
                uv: [0.0; 2],
                color: rgb | ((gain.min(1.0) * 42.0) as u32) << 24,
                pos: p.to_array(),
            };
            for i in 0..8 {
                let edge = |k: usize| {
                    const RING: [[f32; 2]; 8] = [
                        [1.0, 0.0],
                        [0.70710677, 0.70710677],
                        [0.0, 1.0],
                        [-0.70710677, 0.70710677],
                        [-1.0, 0.0],
                        [-0.70710677, -0.70710677],
                        [0.0, -1.0],
                        [0.70710677, -0.70710677],
                    ];
                    let [x, y] = RING[k % 8];
                    pp::Vertex {
                        uv: [0.0; 2],
                        color: rgb,
                        pos: (p + (side * x + up * y) * radius).to_array(),
                    }
                };
                raw.add(count).write(center);
                raw.add(count + 1).write(edge(i));
                raw.add(count + 2).write(edge(i + 1));
                count += 3;
            }
        }
        sceGuDrawArray(
            GuPrimitive::Triangles,
            VertexType::TEXTURE_32BITF
                | VertexType::COLOR_8888
                | VertexType::VERTEX_32BITF
                | VertexType::TRANSFORM_3D,
            count as i32,
            ptr::null(),
            raw as _,
        );
    }
}
