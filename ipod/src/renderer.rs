use crate::{
    effects::{Effects, VistaUniforms},
    gl::*,
    gpu::{Objects, Program, Target},
    read,
    scene::{rows, Scene},
    shadow::SunShadow,
};
use alloc::{collections::BTreeMap, format, string::String, vec::Vec};
use core::ptr;
use glam::{Mat4, Vec3, Vec4};
use pocket3d_place as pc;
use serde::Deserialize;
#[derive(Deserialize)]
struct DrawPrograms {
    detail: [String; 2],
    far: [String; 2],
    reflection: [String; 2],
}
#[derive(Deserialize)]
struct Pipelines {
    draws: Vec<Option<DrawPrograms>>,
    sky: [String; 2],
    post: [String; 2],
    blit: [String; 2],
    down: [String; 2],
}
pub struct Renderer {
    _objects: Objects,
    mask: u32,
    shadow: Option<SunShadow>,
    pub timings: [f32; 5],
    pub submit_ms: f32,
    pub profile: bool,
    effects: Effects,
    vista: Option<VistaUniforms>,
    programs: Vec<Program>,
    draws: Vec<[usize; 3]>,
    sky: usize,
    post: usize,
    main: Target,
    present: Target,
    blit: usize,
    mirror: Target,
    mirror_blur: Target,
    down: usize,
    white: u32,
    black: u32,
    lut: u32,
    grain: u32,
    tri: u32,
    pub count: u32,
    pub triangles: u32,
    pub width: i32,
    pub height: i32,
}
fn v4(v: [f32; 3], w: f32) -> [f32; 4] {
    [v[0], v[1], v[2], w]
}
fn planes(m: Mat4) -> [Vec4; 6] {
    let r = m.transpose();
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
    p.iter().all(|q| {
        q.truncate().dot(Vec3::new(
            if q.x >= 0.0 { hi.x } else { lo.x },
            if q.y >= 0.0 { hi.y } else { lo.y },
            if q.z >= 0.0 { hi.z } else { lo.z },
        )) + q.w
            >= 0.0
    })
}
impl Renderer {
    pub unsafe fn new(root: &str, id: &str, s: &Scene) -> Result<Self, String> {
        let cfg: Pipelines = serde_json::from_slice(&read(&format!("{root}/{id}.pipelines.json"))?)
            .map_err(|e| format!("pipeline table {e}"))?;
        let mut programs = Vec::new();
        let mut cache = BTreeMap::new();
        let mut add = |pair: &[String; 2]| -> Result<usize, String> {
            let key = format!("{}:{}", pair[0], pair[1]);
            if let Some(&i) = cache.get(&key) {
                return Ok(i);
            }
            let i = programs.len();
            programs.push(Program::new(root, pair)?);
            cache.insert(key, i);
            Ok(i)
        };
        let mut draws = Vec::new();
        for d in cfg.draws {
            draws.push(if let Some(d) = d {
                [add(&d.detail)?, add(&d.far)?, add(&d.reflection)?]
            } else {
                [0; 3]
            });
        }
        let blit = add(&cfg.blit)?;
        let sky = add(&cfg.sky)?;
        let post = add(&cfg.post)?;
        let down = add(&cfg.down)?;
        let mut objects = Objects::default();
        let white = objects.image(1, 1, &[255; 4]);
        let black = objects.image(1, 1, &[0, 0, 0, 255]);
        let lut = crate::gpu::tone_lut(&s.meta.post);
        objects.textures.push(lut);
        let (mask, grain) = crate::gpu::grade_textures(&mut objects, s.meta.post.vignette);
        let tri = objects.buffer();
        glBindBuffer(GL_ARRAY_BUFFER, tri);
        let vertices = [-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0];
        glBufferData(GL_ARRAY_BUFFER, 24, vertices.as_ptr() as _, GL_STATIC_DRAW);
        Ok(Self {
            _objects: objects,
            mask,
            shadow: SunShadow::new(root, id, s, 1024)?,
            timings: [0.0; 5],
            submit_ms: 0.0,
            profile: false,
            effects: Effects::new(root, s, 640, 426)?,
            vista: VistaUniforms::new(s),
            programs,
            draws,
            sky,
            post,
            main: Target::new(640, 426, true)?,
            present: Target::new(640, 426, false)?,
            blit,
            mirror: Target::new(320, 214, true)?,
            mirror_blur: Target::new(160, 107, false)?,
            down,
            white,
            black,
            lut,
            grain,
            tri,
            count: 0,
            triangles: 0,
            width: 640,
            height: 426,
        })
    }
    pub unsafe fn resize(&mut self, w: i32, h: i32) -> Result<(), String> {
        let main = Target::new(w, h, true)?;
        let present = Target::new(w, h, false)?;
        self.effects.resize(w, h)?;
        self.mirror = Target::new((w / 2).max(160), (h / 2).max(106), true)?;
        self.mirror_blur = Target::new(self.mirror.w / 2, self.mirror.h / 2, false)?;
        self.present = present;
        self.main = main;
        self.width = w;
        self.height = h;
        Ok(())
    }
    unsafe fn fullscreen(&self, _p: &Program) {
        glBindBuffer(GL_ARRAY_BUFFER, self.tri);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, 0, 8, ptr::null());
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
    unsafe fn globals(&self, p: &Program, s: &Scene, eye: Vec3, time: f32) {
        if let Some(v) = &self.vista {
            v.bind(p, eye);
        }
        let a = &s.meta.atmosphere;
        p.v("uEye", &v4(eye.to_array(), time));
        p.v("uFog", &v4(a.fog_color, a.fog_density));
        p.v("uHaze", &[0.0103, 0.0091, 0.0194, 0.0]);
        p.v("uHemiSky", &v4(a.hemisphere_sky, 0.0));
        p.v("uHemiGround", &v4(a.hemisphere_ground, 0.0));
        if let Some(sun) = &s.meta.sun {
            p.v("uSunDir", &v4(sun.direction, 0.0));
            p.v("uSunRad", &v4(sun.radiance, 0.0));
            if self.shadow.is_none() {
                p.v("uShadowK", &[0.0, 0.00001, 0.002, 1.0]);
                p.v("uSunMat", &[0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.5]);
            }
        }
        if let Some(shadow) = &self.shadow {
            shadow.bind(p);
        }
    }
    unsafe fn sky(&self, s: &Scene, eye: Vec3, target: Vec3, fov: f32, time: f32, mirror: bool) {
        let p = &self.programs[self.sky];
        p.bind();
        glDisable(GL_DEPTH_TEST);
        glDepthMask(0);
        glDisable(GL_CULL_FACE);
        glDisable(GL_BLEND);
        let f = (target - eye).normalize();
        let side = f.cross(Vec3::Y).normalize();
        let up = side.cross(f);
        let tan = libm::tanf(fov * core::f32::consts::PI / 360.0);
        let flip = if mirror { -1.0 } else { 1.0 };
        let refl = |v: Vec3| v * Vec3::new(1.0, flip, 1.0);
        p.v("uRayZ", &v4(refl(f).to_array(), 0.0));
        p.v("uRayX", &v4(refl(side * tan * 1.5).to_array(), 0.0));
        p.v("uRayY", &v4(refl(up * tan).to_array(), 0.0));
        if let Some(d) = &s.meta.day_sky {
            let (tw, te) = if d.glow_tight[0] > 0.0 {
                (d.glow_tight[0], d.glow_tight[1])
            } else {
                (1.0, 1e4)
            };
            p.v("uZenith", &v4(d.zenith, d.gradient_power));
            p.v("uHorizon", &v4(d.horizon, d.ground_blend));
            p.v("uGlow", &v4(d.ground, 50000.0));
            p.v(
                "uSkyDay",
                &[
                    time * d.drift,
                    d.fade_elevation,
                    if d.clouds.is_some() { 1.0 } else { 0.0 },
                    te,
                ],
            );
            p.v("uSkySun", &v4(d.sun_direction, 0.0));
            p.v(
                "uSkyGlow",
                &v4(d.sun_color.map(|x| x * d.glow * tw), d.glow_wide[0] / tw),
            );
            p.v(
                "uSkyDisc",
                &v4(d.sun_color.map(|x| x * d.disc), d.disc_cos_outer),
            );
            p.v("uCloudSun", &v4(d.cloud_sun, d.glow_wide[1]));
            p.v("uCloudAmb", &v4(d.cloud_ambient, d.disc_cos_inner));
            p.tex(
                "uClouds",
                d.clouds
                    .map(|i| s.textures[i as usize])
                    .unwrap_or(self.black),
                0,
            );
            if let Some(t) = &d.twilight {
                p.v("uTwBand", &v4(t.band.color, t.band.height));
                p.v("uTwBelt", &v4(t.belt.color, t.belt.elevation));
                p.v(
                    "uTwShape",
                    &[
                        t.band.sun_bias,
                        t.band.sun_power,
                        t.belt.width,
                        t.belt.power,
                    ],
                );
                p.v(
                    "uTwShadow",
                    &[t.shadow.strength, t.shadow.height, t.shadow.power, 0.0],
                );
            }
        } else {
            let a = &s.meta.atmosphere;
            p.v("uZenith", &v4(a.sky_zenith, time));
            p.v(
                "uHorizon",
                &v4(a.sky_horizon, 1.0 / s.meta.effects.cloud_cells.max(1.0)),
            );
            p.v("uGlow", &v4(a.sky_glow, 50000.0));
            p.tex(
                "uClouds",
                s.meta
                    .effects
                    .clouds
                    .map(|i| s.textures[i as usize])
                    .unwrap_or(self.black),
                0,
            );
        }
        self.fullscreen(p);
        glEnable(GL_DEPTH_TEST);
        glDepthMask(1);
    }
    unsafe fn meshes(
        &mut self,
        s: &Scene,
        vp: Mat4,
        eye: Vec3,
        time: f32,
        mirror: bool,
        reflection: bool,
    ) {
        let reflection_matrix = Mat4::from_scale(Vec3::new(1.0, -1.0, 1.0));
        let clip = planes(if mirror { vp * reflection_matrix } else { vp });
        let mut order = Vec::new();
        for (i, d) in s.meta.draws.iter().enumerate() {
            let m = &s.meta.materials[d.material as usize];
            if d.layout == pc::VertexLayout::Lights {
                continue;
            }
            if mirror
                && (d.no_reflect
                    || m.wet.as_ref().is_some_and(|w| w.planar)
                    || matches!(
                        m.kind,
                        pc::Kind::Glass | pc::Kind::Water | pc::Kind::Lights | pc::Kind::Tower
                    ))
            {
                continue;
            }
            let (lo, hi) = s.bounds(d);
            if !visible(&clip, lo, hi) {
                continue;
            }
            let distance = eye.distance(eye.clamp(lo, hi));
            let alpha = m.blend != pc::Blend::Opaque;
            order.push((
                i,
                if alpha {
                    1e7 - eye.distance_squared((lo + hi) * 0.5)
                } else {
                    d.material as f32 + if m.alpha_test > 0.0 { 10000.0 } else { 0.0 }
                },
                distance,
            ));
        }
        order.sort_unstable_by(|a, b| a.1.total_cmp(&b.1));
        glBindBuffer(GL_ARRAY_BUFFER, s.geometry);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, s.geometry);
        glDepthFunc(GL_LEQUAL);
        glFrontFace(if mirror { 0x0900 } else { 0x0901 });
        for (i, _, distance) in order {
            let d = &s.meta.draws[i];
            let m = &s.meta.materials[d.material as usize];
            let tier = if mirror {
                2
            } else if distance > 4.0 {
                1
            } else {
                0
            };
            let p = &self.programs[self.draws[i][tier]];
            p.bind();
            self.globals(p, s, eye, time);
            p.mat("uViewProj", vp);
            let model = if d.skin.is_some() {
                Mat4::IDENTITY
            } else {
                s.model(d)
            };
            p.v(
                "uModel",
                &rows(if mirror {
                    reflection_matrix * model
                } else {
                    model
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
                p.v("uBones", &s.bones(skin));
            }
            let uv = [d.uv_scale[0], d.uv_scale[1], d.uv_offset[0], d.uv_offset[1]];
            p.v("uUv", &m.uv_anim.map(|a| a.apply(uv, time)).unwrap_or(uv));
            let gain = s.emissive[d.material as usize];
            let base = match m.kind {
                pc::Kind::Unlit => [
                    m.color[0] * gain,
                    m.color[1] * gain,
                    m.color[2] * gain,
                    m.color[3],
                ],
                pc::Kind::Products => [m.color[0], m.color[1], m.color[2], m.emissive[0]],
                pc::Kind::InteriorWindow => [0.0, 0.0, 0.0, 1.0],
                _ => m.color,
            };
            p.v("uBase", &base);
            if let Some(shade) = m.emission_shade {
                let mut values = [0.0; 8];
                values[..4].copy_from_slice(&shade.normal);
                values[4..].copy_from_slice(&shade.height);
                p.v("uEmissionShade", &values);
            }
            p.v(
                "uEmissive",
                &if m.kind == pc::Kind::InteriorWindow {
                    let tint = m.tint.unwrap_or([1.0; 3]);
                    [m.emissive[0], tint[0], tint[1], tint[2]]
                } else {
                    v4(m.emissive.map(|v| v * gain), m.alpha_test)
                },
            );
            let orm = if tier > 0 {
                m.orm
                    .map(|t| s.meta.textures[t as usize].mean)
                    .unwrap_or([1.0; 4])
            } else {
                [1.0; 4]
            };
            p.v(
                "uPbr",
                &[
                    m.roughness * orm[1],
                    m.water.map(|w| w.mask).unwrap_or(m.metalness * orm[2]),
                    m.normal_scale,
                    if tier == 0 && m.orm.is_some() {
                        m.ao_strength
                    } else {
                        (orm[0] - 1.0) * m.ao_strength + 1.0
                    },
                ],
            );
            p.v(
                "uEnvK",
                &[
                    m.env_strength * s.meta.atmosphere.environment_strength,
                    m.clearcoat.max(m.drops),
                    0.08,
                    if s.meta.rain.active { 1.0 } else { 0.0 },
                ],
            );
            let w = m.wet.clone().unwrap_or_default();
            let damp = m.damp.clone().unwrap_or_default();
            p.v("uWet", &[w.puddles, w.darken, w.roughness, w.ripple]);
            p.v(
                "uWet2",
                &[
                    1.0 / w.puddle_scale.max(0.01),
                    damp.darken,
                    damp.roughness,
                    damp.streaks,
                ],
            );
            p.v(
                "uReflOn",
                &[if reflection && !mirror { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0],
            );
            let rf = (time * 1.15 - libm::floorf(time * 1.15)) * 16.0;
            p.v(
                "uRipple",
                &[
                    libm::floorf(rf),
                    (libm::floorf(rf) + 1.0) % 16.0,
                    rf - libm::floorf(rf),
                    1.0 / s.meta.effects.ripple_tile.max(0.1),
                ],
            );
            if let Some(w) = m.water {
                p.v("uWaterK", &v4(w.body, w.distance_roughness));
                p.v(
                    "uWave",
                    &[
                        w.waves[0][0],
                        0.0,
                        time * w.waves[0][1] * w.waves[0][0],
                        time * w.waves[0][2] * w.waves[0][0],
                        w.waves[1][0],
                        0.0,
                        time * w.waves[1][1] * w.waves[1][0],
                        time * w.waves[1][2] * w.waves[1][0],
                    ],
                );
                if let Some(c) = w.shallow {
                    p.v("uWaterShallow", &v4(c, 0.0));
                }
            }
            let mut lights: Vec<_> = s
                .lights
                .iter()
                .filter(|l| d.layout != pc::VertexLayout::Baked || l.dynamic)
                .collect();
            let (lo, hi) = s.bounds(d);
            let center = (lo + hi) * 0.5;
            lights.sort_unstable_by(|a, b| {
                a.pos
                    .distance_squared(center)
                    .total_cmp(&b.pos.distance_squared(center))
            });
            let (mut positions, mut colors, mut dirs, mut rights, mut ups) =
                ([0.0; 8], [0.0; 8], [0.0; 8], [0.0; 8], [0.0; 8]);
            for (k, l) in lights.iter().take(2).enumerate() {
                positions[k * 4..k * 4 + 4].copy_from_slice(&v4(
                    l.pos.to_array(),
                    if l.reach > 0.0 { 1.0 / l.reach } else { 0.0 },
                ));
                colors[k * 4..k * 4 + 4].copy_from_slice(&v4(l.color.to_array(), l.spot[0]));
                dirs[k * 4..k * 4 + 4].copy_from_slice(&v4(l.dir.to_array(), l.spot[1]));
                rights[k * 4..k * 4 + 4].copy_from_slice(&v4(l.right.to_array(), l.size[0]));
                ups[k * 4..k * 4 + 4].copy_from_slice(&v4(l.up.to_array(), l.size[1]));
            }
            p.v("uLightPos", &positions);
            p.v("uLightCol", &colors);
            p.v("uLightDir", &dirs);
            p.v("uLightRight", &rights);
            p.v("uLightUp", &ups);
            let tex = |i: Option<u32>| i.map(|i| s.textures[i as usize]).unwrap_or(self.white);
            let mut unit = 0;
            for (name, id) in [
                ("uAlbedo", tex(m.albedo)),
                ("uNormalMap", tex(m.normal)),
                ("uOrm", tex(m.orm)),
                ("uEmission", tex(m.emission)),
                ("uEnv", tex(s.meta.atmosphere.environment)),
                ("uPuddles", tex(s.meta.effects.puddles)),
                ("uRipples", tex(s.meta.effects.ripples)),
                ("uBeads", tex(s.meta.effects.beads)),
                ("uReflSharp", self.mirror.texture),
                ("uReflBlur", self.mirror_blur.texture),
                (
                    "uShadow",
                    self.shadow
                        .as_ref()
                        .map(|s| s.texture())
                        .unwrap_or(self.white),
                ),
            ] {
                unit = p.tex(name, id, unit);
            }
            if m.double_sided {
                glDisable(GL_CULL_FACE);
            } else {
                glEnable(GL_CULL_FACE);
            }
            glDisable(GL_BLEND);
            p.v(
                "uBlend",
                &[
                    match m.blend {
                        pc::Blend::Opaque => 0.0,
                        pc::Blend::Alpha => 1.0,
                        pc::Blend::Additive => 2.0,
                        _ => 3.0,
                    },
                    0.0,
                    0.0,
                    0.0,
                ],
            );
            glDepthMask((m.depth_write && m.blend == pc::Blend::Opaque) as u8);
            if let Some(b) = m.polygon_offset {
                glEnable(0x8037);
                glPolygonOffset(b[0], b[1]);
            } else {
                glDisable(0x8037);
            }
            glBindVertexArrayOES(s.vaos[i]);
            let lod = d.lods.iter().rev().find(|l| {
                l.error
                    < (distance.max(1.0)
                        * if mirror {
                            1.6 / self.mirror.h as f32
                        } else {
                            0.8 / self.height as f32
                        })
            });
            let (count, offset) = lod
                .map(|l| (l.index_count, l.indices.offset))
                .unwrap_or((d.index_count, d.indices.offset));
            glDrawElements(
                GL_TRIANGLES,
                count as _,
                GL_UNSIGNED_SHORT,
                offset as usize as _,
            );
            self.count += 1;
            self.triangles += count / 3;
        }
        glBindVertexArrayOES(0);
        glDisable(0x8037);
        glFrontFace(0x0901);
    }
    // A completion boundary separates geometry, framebuffer fetch and
    // render-to-texture post work. Normal telemetry excludes the wait;
    // explicit profiling includes it as synchronized pass time.
    unsafe fn end_pass(&mut self, stage: usize, started: f64, complete: bool) -> f64 {
        let submitted = crate::atlas_seconds();
        if complete || self.profile {
            glFinish();
        }
        let finished = crate::atlas_seconds();
        self.timings[stage] =
            ((if self.profile { finished } else { submitted } - started) * 1000.0) as f32;
        finished
    }
    pub unsafe fn frame(
        &mut self,
        s: &Scene,
        eye: Vec3,
        target: Vec3,
        fov: f32,
        time: f32,
        fbo: u32,
        w: i32,
        h: i32,
        reflection: bool,
        bloom: bool,
        rain: bool,
    ) {
        self.count = 0;
        self.triangles = 0;
        let mut stamp = crate::atlas_seconds();
        if let Some(shadow) = &mut self.shadow {
            let stats = shadow.render(s, time);
            self.count += stats.draws;
            self.triangles += stats.triangles;
        }
        stamp = self.end_pass(0, stamp, false);
        let projection = glam::camera::rh::proj::opengl::perspective(
            fov * core::f32::consts::PI / 180.0,
            1.5,
            0.25,
            100000.0,
        );
        let vp = projection * glam::camera::rh::view::look_at_mat4(eye, target, Vec3::Y);
        if reflection
            && s.meta
                .materials
                .iter()
                .any(|m| m.wet.as_ref().is_some_and(|w| w.planar))
        {
            self.mirror.bind();
            glDepthMask(1);
            glClearColor(0.0, 0.0, 0.0, 1.0);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            self.sky(s, eye, target, fov, time, true);
            self.meshes(s, vp, eye, time, true, false);
            glBindVertexArrayOES(0);
            glDisable(GL_DEPTH_TEST);
            glDepthMask(0);
            glDisable(GL_CULL_FACE);
            glDisable(GL_BLEND);
            self.mirror_blur.bind();
            let p = &self.programs[self.down];
            p.bind();
            p.tex("uSource", self.mirror.texture, 0);
            p.v(
                "uTexel",
                &[
                    1.0 / self.mirror.w as f32,
                    1.0 / self.mirror.h as f32,
                    0.0,
                    0.0,
                ],
            );
            self.fullscreen(p);
        }
        stamp = self.end_pass(1, stamp, false);
        self.main.bind();
        glDepthMask(1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        self.sky(s, eye, target, fov, time, false);
        self.meshes(s, vp, eye, time, false, reflection);
        self.submit_ms = ((crate::atlas_seconds() - stamp) * 1000.0) as f32;
        stamp = self.end_pass(2, stamp, true);
        let stats = self
            .effects
            .draw_geometry(s, vp, eye, target, fov, time, rain);
        self.count += stats.draws;
        self.triangles += stats.particle_quads * 2;
        stamp = self.end_pass(3, stamp, true);
        let fx = self.effects.post(
            s,
            self.main.texture,
            eye,
            target,
            fov,
            time,
            rain,
            bloom,
            true,
        );
        glDisable(GL_DEPTH_TEST);
        glDepthMask(0);
        glDisable(GL_CULL_FACE);
        glDisable(GL_BLEND);
        self.present.bind();
        let p = &self.programs[self.post];
        p.bind();
        p.tex("uScene", self.main.texture, 0);
        p.tex("uBloom", fx.bloom, 1);
        p.tex("uHazeTex", fx.haze, 5);
        p.tex("uLut", self.lut, 2);
        p.tex("uMask", self.mask, 3);
        p.tex("uGrain", self.grain, 4);
        p.v(
            "uBloomK",
            &[fx.bloom_weight, s.meta.post.exposure, fx.haze_weight, 0.0],
        );
        p.v("uGrade", &[fx.haze_weight, 0.0, s.meta.post.grain, 0.0]);
        p.v(
            "uGrainK",
            &[
                self.width as f32 / 64.0,
                self.height as f32 / 64.0,
                time * 0.618034 % 1.0,
                time * 0.414214 % 1.0,
            ],
        );
        self.fullscreen(p);
        glBindFramebuffer(0x8d40, fbo);
        glViewport(0, 0, w, h);
        let p = &self.programs[self.blit];
        p.bind();
        p.tex("uSource", self.present.texture, 0);
        self.fullscreen(p);
        glDepthMask(1);
        self.end_pass(4, stamp, true);
    }
}
