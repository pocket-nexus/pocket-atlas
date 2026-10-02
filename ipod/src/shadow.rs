//! Authored sun shadows in packed RGB24, sharing the surface transforms and
//! alpha-tested shadow fragment algorithm with the Vita renderer.
use alloc::{collections::BTreeMap, format, string::String, vec::Vec};
use core::ptr;
use glam::{Mat4, Vec3, Vec4};
use pocket3d_place as pc;
use serde::Deserialize;

use crate::{
    gl::*,
    gpu::{rgba, Program, Target},
    read,
    scene::{rows, Scene},
};

#[derive(Deserialize)]
struct Pipelines {
    draws: Vec<Option<[String; 2]>>,
    copy: [String; 2],
}

extern "C" {
    fn glCopyTexSubImage2D(
        target: u32,
        level: i32,
        x_offset: i32,
        y_offset: i32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    );
}

/// Static packed depths, without another depth buffer. This cache exists
/// only when moving casters require a shadow update after the first frame.
struct StaticCache {
    texture: u32,
    triangle: u32,
    copy: Program,
}
impl StaticCache {
    unsafe fn new(root: &str, pair: &[String; 2], size: i32) -> Result<Self, String> {
        let copy = Program::new(root, pair)?;
        let mut texture = 0;
        glGenTextures(1, &mut texture);
        glBindTexture(GL_TEXTURE_2D, texture);
        glTexImage2D(
            GL_TEXTURE_2D,
            0,
            GL_RGBA as i32,
            size,
            size,
            0,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            ptr::null(),
        );
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, 0x2600);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, 0x2600);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        let mut triangle = 0;
        glGenBuffers(1, &mut triangle);
        glBindBuffer(GL_ARRAY_BUFFER, triangle);
        let vertices = [-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0];
        glBufferData(
            GL_ARRAY_BUFFER,
            core::mem::size_of_val(&vertices) as _,
            vertices.as_ptr() as _,
            GL_STATIC_DRAW,
        );
        Ok(Self {
            texture,
            triangle,
            copy,
        })
    }

    unsafe fn save(&self, size: i32) {
        glBindTexture(GL_TEXTURE_2D, self.texture);
        glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, size, size);
    }

    unsafe fn restore(&self) {
        glDisable(GL_DEPTH_TEST);
        glDepthMask(0);
        self.copy.bind();
        self.copy.tex("uSource", self.texture, 0);
        glBindBuffer(GL_ARRAY_BUFFER, self.triangle);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, 0, 8, ptr::null());
        glDrawArrays(GL_TRIANGLES, 0, 3);
        glDepthMask(1);
        glEnable(GL_DEPTH_TEST);
    }
}
impl Drop for StaticCache {
    fn drop(&mut self) {
        unsafe {
            glDeleteTextures(1, &self.texture);
            glDeleteBuffers(1, &self.triangle);
        }
    }
}

#[derive(Clone, Copy, Default)]
pub struct ShadowStats {
    pub draws: u32,
    pub triangles: u32,
}

pub struct SunShadow {
    target: Target,
    programs: Vec<Program>,
    draws: Vec<(usize, usize)>,
    dynamic: Vec<(usize, usize)>,
    static_cache: Option<StaticCache>,
    vp: Mat4,
    planes: [Vec4; 6],
    direction: [f32; 4],
    radiance: [f32; 4],
    uv_rows: [f32; 8],
    depth: [f32; 4],
    lod_error: f32,
    white: u32,
    signature: Option<u64>,
}

impl SunShadow {
    /// `max_map_size` is a renderer quality setting (normally 512 or 1024),
    /// capped by the authored size. A sun below the horizon casts no shadow.
    pub unsafe fn new(
        root: &str,
        id: &str,
        scene: &Scene,
        max_map_size: u32,
    ) -> Result<Option<Self>, String> {
        let Some(sun) = scene.meta.sun.as_ref().filter(|sun| sun.direction[1] > 0.0) else {
            return Ok(None);
        };
        let direction = Vec3::from(sun.direction).normalize_or(Vec3::Y);
        let settings = sun.shadow.clone().unwrap_or(pc::SunShadow {
            position: (direction * 80.0).to_array(),
            ortho: [-40.0, 40.0, -40.0, 40.0, 1.0, 160.0],
            map_size: 2048,
            bias: 0.0,
            normal_bias: 0.02,
            radius: 1.0,
        });
        let size = settings.map_size.clamp(512, max_map_size.clamp(512, 2048));
        let position = Vec3::from(settings.position);
        let up = if direction.y.abs() > 0.99 {
            Vec3::Z
        } else {
            Vec3::Y
        };
        let view = glam::camera::rh::view::look_at_mat4(position, position - direction, up);
        let o = settings.ortho;
        if !o.iter().all(|v| v.is_finite()) || o[1] <= o[0] || o[3] <= o[2] || o[5] <= o[4] {
            return Err("invalid sun shadow camera".into());
        }
        let projection =
            glam::camera::rh::proj::opengl::orthographic(o[0], o[1], o[2], o[3], o[4], o[5]);
        let vp = projection * view;
        let r = vp.transpose();
        // GLES framebuffer rows rise with +Y, unlike GXM's top-left target.
        let u = (r.x_axis + r.w_axis) * 0.5;
        let v = (r.y_axis + r.w_axis) * 0.5;
        let range = (o[5] - o[4]).max(1.0);
        let depth = [
            position.dot(-direction) + o[4],
            1.0 / range,
            settings.bias.abs().max(0.02 / range),
            size as f32,
        ];
        let cfg: Pipelines = serde_json::from_slice(&read(&format!("{root}/{id}.shadow.json"))?)
            .map_err(|e| format!("shadow pipelines: {e}"))?;
        if cfg.draws.len() != scene.meta.draws.len() {
            return Err("shadow pipeline count differs from scene".into());
        }
        let mut programs = Vec::new();
        let mut cache = BTreeMap::new();
        let mut draws = Vec::new();
        let mut dynamic = Vec::new();
        for (i, pair) in cfg.draws.iter().enumerate() {
            let Some(pair) = pair else { continue };
            let d = &scene.meta.draws[i];
            if !d.cast_shadow || d.layout == pc::VertexLayout::Lights {
                return Err("invalid shadow caster pipeline".into());
            }
            let key = format!("{}:{}", pair[0], pair[1]);
            let index = if let Some(&index) = cache.get(&key) {
                index
            } else {
                let index = programs.len();
                programs.push(Program::new(root, pair)?);
                cache.insert(key, index);
                index
            };
            if d.node.is_some()
                || d.skin.is_some()
                || scene.meta.materials[d.material as usize].uv_anim.is_some()
            {
                dynamic.push((i, index));
            } else {
                draws.push((i, index));
            }
        }
        let target = Target::new(size as i32, size as i32, false)?;
        glBindTexture(GL_TEXTURE_2D, target.texture);
        // Each channel is one part of a packed number. The shared shader
        // compares four point samples itself; filtering the bytes is invalid.
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, 0x2600);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, 0x2600);
        let static_cache = if dynamic.is_empty() {
            None
        } else {
            Some(StaticCache::new(root, &cfg.copy, size as i32)?)
        };
        let white = rgba(1, 1, &[255; 4]);
        Ok(Some(Self {
            target,
            programs,
            draws,
            dynamic,
            static_cache,
            vp,
            planes: [
                r.w_axis + r.x_axis,
                r.w_axis - r.x_axis,
                r.w_axis + r.y_axis,
                r.w_axis - r.y_axis,
                r.w_axis + r.z_axis,
                r.w_axis - r.z_axis,
            ],
            direction: [direction.x, direction.y, direction.z, 0.0],
            radiance: [
                sun.radiance[0],
                sun.radiance[1],
                sun.radiance[2],
                settings.normal_bias.max(0.01),
            ],
            uv_rows: [u.x, u.y, u.z, u.w, v.x, v.y, v.z, v.w],
            depth,
            lod_error: ((o[1] - o[0]).max(o[3] - o[2]) / size as f32) * 0.35,
            white,
            signature: None,
        }))
    }

    pub fn texture(&self) -> u32 {
        self.target.texture
    }

    /// Bind the sunlight/shadow constants on the receiving material program.
    /// The caller includes texture() in its normal sampler unit assignment.
    pub unsafe fn bind(&self, program: &Program) {
        program.v("uSunDir", &self.direction);
        program.v("uSunRad", &self.radiance);
        program.v("uSunMat", &self.uv_rows);
        program.v("uShadowK", &self.depth);
    }

    fn signature(&self, scene: &Scene, time: f32) -> u64 {
        let mut hash = 0xcbf29ce484222325u64;
        let mut append = |value: u32| {
            hash = (hash ^ value as u64).wrapping_mul(0x100000001b3);
        };
        for &(index, _) in &self.dynamic {
            let d = &scene.meta.draws[index];
            if let Some(skin) = d.skin {
                for &joint in &scene.meta.skins[skin as usize].joints {
                    for value in scene.world[joint as usize].to_cols_array() {
                        append(value.to_bits());
                    }
                }
            } else {
                for value in scene.model(d).to_cols_array() {
                    append(value.to_bits());
                }
            }
            if scene.meta.materials[d.material as usize].uv_anim.is_some() {
                append(time.to_bits());
            }
        }
        hash
    }

    /// Call after Scene::update and before the main/reflection passes. A
    /// static scene or paused animation reuses its map. A moving scene keeps
    /// the static map in a color-only cache and redraws only moving casters.
    pub unsafe fn render(&mut self, scene: &Scene, time: f32) -> ShadowStats {
        let signature = self.signature(scene, time);
        if self.signature == Some(signature) {
            return ShadowStats::default();
        }
        self.target.bind();
        glDisable(GL_BLEND);
        glDisable(GL_CULL_FACE);
        glDisable(GL_SCISSOR_TEST);
        glDisable(0x8037); // GL_POLYGON_OFFSET_FILL
                           // Dither can change a packed depth byte; preserve the caller's
                           // setting while forcing exact RGBA8 stores for this pass.
        let mut dither = 0;
        glGetIntegerv(0x0bd0, &mut dither);
        glDisable(0x0bd0); // GL_DITHER
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        glDepthMask(1);
        glClearDepthf(1.0);
        glClearColor(1.0, 1.0, 1.0, 1.0);
        let mut stats = ShadowStats::default();
        if self.signature.is_none() {
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            self.draw_casters(scene, time, &self.draws, &mut stats);
            if let Some(cache) = &self.static_cache {
                cache.save(self.target.w);
            }
        } else if let Some(cache) = &self.static_cache {
            cache.restore();
            stats.draws += 1;
            stats.triangles += 1;
        }
        if !self.dynamic.is_empty() {
            // Static occlusion is held in packed color and compared by the
            // dynamic fragment via framebuffer fetch. Depth now orders only
            // moving geometry, so static meshes need not be submitted again.
            glClear(GL_DEPTH_BUFFER_BIT);
            self.draw_casters(scene, time, &self.dynamic, &mut stats);
        }
        self.signature = Some(signature);
        if dither != 0 {
            glEnable(0x0bd0);
        }
        stats
    }

    unsafe fn draw_casters(
        &self,
        scene: &Scene,
        time: f32,
        draws: &[(usize, usize)],
        stats: &mut ShadowStats,
    ) {
        glBindBuffer(GL_ARRAY_BUFFER, scene.geometry);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, scene.geometry);
        for &(index, program_index) in draws {
            let d = &scene.meta.draws[index];
            let (lo, hi) = scene.bounds(d);
            if !self.planes.iter().all(|p| {
                let corner = Vec3::new(
                    if p.x >= 0.0 { hi.x } else { lo.x },
                    if p.y >= 0.0 { hi.y } else { lo.y },
                    if p.z >= 0.0 { hi.z } else { lo.z },
                );
                p.truncate().dot(corner) + p.w >= 0.0
            }) {
                continue;
            }
            let p = &self.programs[program_index];
            let material = &scene.meta.materials[d.material as usize];
            p.bind();
            p.mat("uViewProj", self.vp);
            p.v(
                "uModel",
                &rows(if d.skin.is_some() {
                    Mat4::IDENTITY
                } else {
                    scene.model(d)
                }),
            );
            p.v(
                "uDequant",
                &[
                    d.pos_scale[0],
                    d.pos_scale[1],
                    d.pos_scale[2],
                    0.0,
                    d.pos_offset[0],
                    d.pos_offset[1],
                    d.pos_offset[2],
                    0.0,
                ],
            );
            if let Some(skin) = d.skin {
                p.v("uBones", &scene.bones(skin));
            }
            let uv = [d.uv_scale[0], d.uv_scale[1], d.uv_offset[0], d.uv_offset[1]];
            p.v(
                "uUv",
                &material
                    .uv_anim
                    .map(|anim| anim.apply(uv, time))
                    .unwrap_or(uv),
            );
            p.v("uSunDir", &self.direction);
            p.v("uShadowK", &self.depth);
            p.v("uBase", &material.color);
            p.v("uEmissive", &[0.0, 0.0, 0.0, material.alpha_test]);
            p.tex(
                "uAlbedo",
                material
                    .albedo
                    .map(|i| scene.textures[i as usize])
                    .unwrap_or(self.white),
                0,
            );
            for i in 0..8 {
                glDisableVertexAttribArray(i);
            }
            for (slot, n, kind, normalized, offset) in [
                (0, 3, 0x1402, 1, 0),
                (3, 2, 0x1402, 1, 16),
                (6, 4, GL_UNSIGNED_BYTE, 0, 24),
                (7, 4, GL_UNSIGNED_BYTE, 1, 28),
            ] {
                if p.attrs[slot as usize] {
                    glEnableVertexAttribArray(slot);
                    glVertexAttribPointer(
                        slot,
                        n,
                        kind,
                        normalized,
                        d.layout.stride() as i32,
                        (d.vertices.offset as usize + offset) as *const _,
                    );
                }
            }
            let lod = d.lods.iter().rev().find(|lod| lod.error < self.lod_error);
            let (count, offset) = lod
                .map(|lod| (lod.index_count, lod.indices.offset))
                .unwrap_or((d.index_count, d.indices.offset));
            glDrawElements(
                GL_TRIANGLES,
                count as i32,
                GL_UNSIGNED_SHORT,
                offset as usize as *const _,
            );
            stats.draws += 1;
            stats.triangles += count / 3;
        }
    }
}

impl Drop for SunShadow {
    fn drop(&mut self) {
        unsafe {
            glDeleteTextures(1, &self.white);
        }
    }
}
