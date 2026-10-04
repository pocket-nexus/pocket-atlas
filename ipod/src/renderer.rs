use crate::pipelines::{Compiled, Pipelines};
use crate::reflection_region::{ReflectionRegion, WetBounds};
use crate::{
    effects::{Effects, VistaUniforms},
    gl::*,
    gpu::{Objects, Program, Target},
    read,
    scene::{rows, Scene},
    shadow::SunShadow,
};
use alloc::{format, string::String, vec::Vec};
use core::ptr;
use glam::{Mat4, Vec3, Vec4};
use pocket3d_place as pc;
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
enum MeshPass { Mirror = 0, Main = 1, WetResponse = 2, WaterResponse = 3 }
const MESH_PASSES: usize = 4;
pub struct Renderer {
    _objects: Objects,
    mask: u32,
    display_fog: [f32; 4],
    display_black: [f32; 4],
    shadow: Option<SunShadow>,
    pub timings: [f32; 5],
    pub submit_ms: f32,
    pub gl_error: u32,
    pub profile: bool,
    pub profile_class: u8,
    pub sky_ms: f32,
    pub mesh_ms: f32,
    pub wet_response_ms: f32,
    pub water_response_ms: f32,
    pub mesh_steps_ms: [[f32; 5]; MESH_PASSES],
    pub post_steps_ms: [f32; 3],
    effects: Effects,
    vista: Option<VistaUniforms>,
    // Atmosphere and grade are immutable for this renderer. Static centres
    // depend only on the eye, not camera rotation or scene animation time.
    haze_eye: [Option<[u32; 3]>; MESH_PASSES],
    haze_values: [Vec<Option<[f32; 4]>>; MESH_PASSES],
    haze_keys: [Vec<Option<[u8; 4]>>; MESH_PASSES],
    programs: Vec<Program>,
    draws: Vec<[usize; 2]>,
    wet_programs: Vec<Option<usize>>,
    wet_response: Option<Target>,
    water_programs: Vec<Option<usize>>,
    water_response: Option<Target>,
    sky: usize,
    post: usize,
    main: Target,
    sky_low: Target,
    blit: usize,
    copy: usize,
    mirror: Target,
    mirror_blur: Target,
    // Only the validated static wet recipe uses this cache. Animation still
    // renders every frame; an identical view only reuses its read footprint.
    mirror_region_cache: Option<([u32; 16], ReflectionRegion)>,
    white: u32,
    white_cube: u32,
    black: u32,
    lut: u32,
    grain: u32,
    tri: u32,
    stream_indices: [[u32; 3]; MESH_PASSES],
    stream_slot: [usize; MESH_PASSES],
    stream_valid: [bool; MESH_PASSES],
    selection_keys: [Vec<u32>; MESH_PASSES],
    selection_scratch: Vec<u32>,
    stream_ranges: [Vec<StreamRange>; MESH_PASSES],
    cluster_scratch: Vec<crate::mesh_clusters::Cluster>,
    query_cache: [crate::mesh_clusters::QueryCache; MESH_PASSES],
    index_scratch: Vec<u16>,
    pub count: u32,
    pub triangles: u32,
    pub light_points: u32,
    pub width: i32,
    pub height: i32,
}
/// One visible, selected LOD. Streaming changes only the index source; the
/// original draw still supplies material, decoding and vertex-array state.
struct DrawRun {
    index: usize,
    transparent: bool,
    sort_key: f32,
    center: Vec3,
    count: u32,
    offset: u32,
    streaming: bool,
    mergeable: bool,
    page_key: (bool, u32),
    material_key: (bool, u32),
    haze: Option<[u8; 4]>,
    display_haze: Option<[f32; 4]>,
    cluster_span: Option<(usize, usize)>,
    index_override: Option<pc::Range>,
}
#[derive(Clone, Copy, Default)]
struct StreamRange {
    offset: u32,
    count: u32,
    streaming: bool,
}
impl DrawRun {
    fn stream_key(&self, key: &mut Vec<u32>, clustered: bool) {
        if self.streaming {
            key.extend_from_slice(&[self.index as u32, clustered as u32, self.index_override.is_some() as u32]);
            // Cluster selections append their own complete LOD/index identity.
            // The original whole-draw LOD range is unused in that path.
            if !clustered {
                key.extend_from_slice(&[self.offset, self.count]);
            }
        }
    }
}
impl StreamRange {
    fn restore(self, run: &mut DrawRun) {
        if run.streaming {
            run.offset = self.offset;
            run.count = self.count;
            run.streaming = self.streaming;
        }
    }
}
fn v4(v: [f32; 3], w: f32) -> [f32; 4] {
    [v[0], v[1], v[2], w]
}
fn material_blend(m: &pc::Material) -> pc::Blend {
    match m.kind {
        pc::Kind::Glass => pc::Blend::Premultiplied,
        pc::Kind::Tower | pc::Kind::Lights => pc::Blend::Additive,
        _ => m.blend,
    }
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
    pub fn field_appearance_bytes(&self) -> usize { self.effects.field_appearance_bytes() }

    pub fn light_lod_bytes(&self) -> (usize, usize) { self.effects.light_lod_bytes() }

    pub fn cpu_index_bytes(&self) -> usize {
        self.index_scratch.capacity() * core::mem::size_of::<u16>()
            + self.selection_scratch.capacity() * core::mem::size_of::<u32>()
            + self.cluster_scratch.capacity()
                * core::mem::size_of::<crate::mesh_clusters::Cluster>()
            + self
                .selection_keys
                .iter()
                .map(|v| v.capacity() * core::mem::size_of::<u32>())
                .sum::<usize>()
            + self
                .stream_ranges
                .iter()
                .map(|v| v.capacity() * core::mem::size_of::<StreamRange>())
                .sum::<usize>()
            + self.query_cache.iter().map(|c| c.bytes()).sum::<usize>()
    }
    pub unsafe fn new(root: &str, id: &str, s: &Scene) -> Result<Self, String> {
        let cfg: Pipelines = serde_json::from_slice(&read(&format!("{root}/{id}.pipelines.json"))?)
            .map_err(|e| format!("pipeline table {e}"))?;
        cfg.validate_draws(s.meta.draws.len(), |i| {
            s.meta.draws[i].layout == pc::VertexLayout::Lights
        })?;
        {
            cfg.validate_colors(s.meta.draws.len(), |i| {
                s.ldr_colors[i].map(|c| (c.flags, c.page.is_some(), c.texture))
            })?;
        }
        cfg.validate_water(s.meta.draws.len(), |i| {
            let m = &s.meta.materials[s.meta.draws[i].material as usize];
            m.kind == pc::Kind::Water && m.blend == pc::Blend::Opaque && m.depth_write
        })?;
        cfg.validate_windows(s.meta.draws.len(), |i| s.window_vertex_params(i))?;
        cfg.validate_window_rays(s.meta.draws.len(), |i| s.window_ray_params(i))?;
        let Compiled {
            programs,
            draws,
            wet_response: wet_programs,
            water_response: water_programs,
            sky,
            post,
            blit,
            copy,
        } = cfg.compile( |pair| Program::new(root, pair))?;
        {
            // Driver-active samplers are the final authority. An incomplete
            // demand manifest must fail loading instead of sampling texture 0.
            crate::texture_usage::validate_resident(
                &s.meta, &s.textures,
                |i| s.ldr_colors[i].map(|c| c.texture),
                |i, name| programs[draws[i][0]].has(name) || programs[draws[i][1]].has(name) || wet_programs[i].is_some_and(|p| programs[p].has(name)) || water_programs[i].is_some_and(|p| programs[p].has(name)),
                |name| programs[sky].has(name),
            )?;
        }
        let shadow = if programs.iter().any(|p| p.has("uShadow")) {
            SunShadow::new(root, id, s, 1024)?
        } else {
            None
        };
        let width = 480;
        let height = width * 2 / 3;
        let mirror_width = (width / 3).max(64);
        let mirror_height = (height / 3).max(42);
        let sky_width = (width / 4).clamp(64, 128);
        let mut objects = Objects::default();
        let white = objects.image(1, 1, &[255; 4]);
        let white_cube = objects.solid_cube([255; 4]);
        let black = objects.image(1, 1, &[0, 0, 0, 255]);
        let lut = crate::gpu::tone_lut_sized(&s.meta.post, 16, true);
        objects.textures.push(lut);
        let (mask, grain) = crate::gpu::grade_textures(&mut objects, s.meta.post.vignette);
        let stream_indices = core::array::from_fn(|_| core::array::from_fn(|_| objects.buffer()));
        let tri = objects.buffer();
        glBindBuffer(GL_ARRAY_BUFFER, tri);
        let vertices = [-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0];
        glBufferData(GL_ARRAY_BUFFER, 24, vertices.as_ptr() as _, GL_STATIC_DRAW);
        Ok(Self {
            _objects: objects,
            mask,
            display_fog: v4(
                pc::color::tone(s.meta.atmosphere.fog_color, &s.meta.post),
                0.0,
            ),
            display_black: crate::gpu::tone_black(&s.meta.post),
            shadow,
            timings: [0.0; 5],
            submit_ms: 0.0,
            gl_error: 0,
            profile: false,
            profile_class: 0,
            sky_ms: 0.0,
            mesh_ms: 0.0,
            wet_response_ms: 0.0,
            water_response_ms: 0.0,
            mesh_steps_ms: [[0.0; 5]; MESH_PASSES],
            post_steps_ms: [0.0; 3],
            effects: Effects::new(root, s, width, height)?,
            vista: VistaUniforms::new(s),
            haze_eye: [None; MESH_PASSES],
            haze_values: core::array::from_fn(|_| alloc::vec![None; s.meta.draws.len()]),
            haze_keys: core::array::from_fn(|_| alloc::vec![None; s.meta.draws.len()]),
            programs,
            wet_response: if wet_programs.iter().any(Option::is_some) {
                Some(Target::new((width / 3).max(1), (height / 3).max(1), true)?)
            } else { None },
            wet_programs,
            water_response: if water_programs.iter().any(Option::is_some) {
                Some(Target::new((width / 2).max(1), (height / 2).max(1), true)?)
            } else { None },
            water_programs,
            draws,
            sky,
            post,
            main: Target::new(width, height, true)?,
            sky_low: Target::new(sky_width, sky_width * 2 / 3, false)?,
            blit,
            copy,
            mirror: Target::new(mirror_width, mirror_height, true)?,
            mirror_blur: Target::new(mirror_width / 2, mirror_height / 2, false)?,
            mirror_region_cache: None,
            white,
            white_cube,
            black,
            lut,
            grain,
            tri,
            stream_indices,
            stream_slot: [0; MESH_PASSES],
            stream_valid: [false; MESH_PASSES],
            selection_keys: core::array::from_fn(|_| Vec::new()),
            selection_scratch: Vec::new(),
            stream_ranges: core::array::from_fn(
                |_| alloc::vec![StreamRange::default(); s.meta.draws.len()],
            ),
            cluster_scratch: Vec::new(),
            query_cache: core::array::from_fn(|_| Default::default()),
            index_scratch: Vec::new(),
            count: 0,
            triangles: 0,
            light_points: 0,
            width,
            height,
        })
    }
    pub fn hdr_target(&self) -> (u32, i32, i32) {
        (self.main.fbo, self.main.w, self.main.h)
    }
    pub unsafe fn resize(&mut self, w: i32, h: i32) -> Result<(), String> {
        let main = Target::new(w, h, true)?;
        let wet_response = if self.wet_response.is_some() {
            Some(Target::new((w / 3).max(1), (h / 3).max(1), true)?)
        } else { None };
        let water_response = if self.water_response.is_some() {
            Some(Target::new((w / 2).max(1), (h / 2).max(1), true)?)
        } else { None };
        let divisor = 3;
        let min_width = 64;
        let mirror = Target::new(
            (w / divisor).max(min_width),
            (h / divisor).max(min_width * 2 / 3),
            true,
        )?;
        let sky_low = Target::new(
            (w / 4).clamp(64, 128),
            (w / 4).clamp(64, 128) * 2 / 3,
            false,
        )?;
        let mirror_blur = Target::new(mirror.w / 2, mirror.h / 2, false)?;
        // Stage all fallible allocations before replacing any live target.
        // Effects::resize is itself transactional and runs last.
        self.effects.resize(w, h)?;
        self.mirror = mirror;
        self.sky_low = sky_low;
        self.mirror_blur = mirror_blur;
        self.mirror_region_cache = None;
        self.main = main;
        self.wet_response = wet_response;
        self.water_response = water_response;
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
        p.v("uDisplayFog", &self.display_fog);
        p.v("uAtlasBlack", &self.display_black);
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
        glColorMask(1, 1, 1, 1);
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
        p.tex("uAtlasLut", self.lut, 1);
        self.fullscreen(p);
        glEnable(GL_DEPTH_TEST);
        glDepthMask(1);
    }
    fn mesh_program(&self, draw: usize, pass: MeshPass) -> usize {
        if pass == MeshPass::WetResponse {
            self.wet_programs[draw].expect("wet pass selected only validated response draws")
        } else if pass == MeshPass::WaterResponse {
            self.water_programs[draw].expect("water pass selected only validated response draws")
        } else { self.draws[draw][usize::from(pass == MeshPass::Mirror)] }
    }
    unsafe fn meshes(
        &mut self,
        s: &Scene,
        vp: Mat4,
        eye: Vec3,
        time: f32,
        mode: MeshPass,
        reflection: bool,
    ) {
        let mirror = mode == MeshPass::Mirror;
        let cpu_start = crate::atlas_seconds();
        let reflection_matrix = Mat4::from_scale(Vec3::new(1.0, -1.0, 1.0));
        let clip = planes(if mirror { vp * reflection_matrix } else { vp });
        let pass = mode as usize;
        let haze_eye = eye.to_array().map(f32::to_bits);
        if self.haze_eye[pass] != Some(haze_eye) {
            self.haze_eye[pass] = Some(haze_eye);
            self.haze_values[pass].fill(None);
            self.haze_keys[pass].fill(None);
        }
        let mut order = Vec::new();
        for (i, d) in s.meta.draws.iter().enumerate() {
            let m = &s.meta.materials[d.material as usize];
            if mode == MeshPass::WetResponse && self.wet_programs[i].is_none() { continue; }
            if mode == MeshPass::WaterResponse && self.water_programs[i].is_none() { continue; }
            if d.layout == pc::VertexLayout::Lights {
                continue;
            }
            if match self.profile_class {
                    1 => d.layout != pc::VertexLayout::Baked || m.kind == pc::Kind::Glass,
                    2 => (d.node.is_none() && d.skin.is_none()) || m.kind == pc::Kind::Glass,
                    3 => m.kind != pc::Kind::Water,
                    4 => m.kind != pc::Kind::Glass,
                    5 => d.layout != pc::VertexLayout::Baked || m.alpha_test <= 0.0,
                    6 => {
                        d.layout != pc::VertexLayout::Baked
                            || m.alpha_test > 0.0
                            || m.blend != pc::Blend::Opaque
                            || m.kind == pc::Kind::Glass
                    }
                    7 => true,
                    8 => m.kind != pc::Kind::Products,
                    9 => m.kind != pc::Kind::InteriorWindow,
                    10 => m.wet.is_none(),
                    11 => m.wet.is_some() || m.kind == pc::Kind::Glass || d.node.is_some() || d.skin.is_some(),
                    12 => m.kind == pc::Kind::InteriorWindow,
                    13 => m.kind == pc::Kind::Products,
                    _ => false,
                }
            {
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
            let alpha = material_blend(m) != pc::Blend::Opaque;
            let lod = s.effective_lods(i).iter().rev().find(|l| {
                l.error
                    < distance.max(1.0)
                        * if mirror {
                            1.6 / self.mirror.h as f32
                        } else {
                            0.8 / self.height as f32
                        }
            });
            let (count, offset) = lod
                .map(|l| (l.index_count, l.indices.offset))
                .unwrap_or((d.index_count, d.indices.offset));
            if count == 0
                && !s.mesh_clusters.as_ref().is_some_and(|c| c.groups(i).is_some())
            {
                continue;
            }
            let source_range = pc::Range { offset, size: count * 2 };
            let index_override = s.index_override(i, &source_range);
            let program = self.mesh_program(i, mode);
            let display_haze = if self.programs[program].has("uDisplayHaze") {
                self.vista.as_ref().map(|vista| {
                    let static_center = d.node.is_none() && d.skin.is_none();
                    if static_center {
                        if let Some(value) = self.haze_values[pass][i] {
                            return value;
                        }
                    }
                    let center = (lo + hi) * 0.5;
                    let center = if mirror {
                        reflection_matrix.transform_point3(center)
                    } else {
                        center
                    };
                    let value = vista.display_at(eye, center, &s.meta.post);
                    if static_center {
                        self.haze_values[pass][i] = Some(value);
                    }
                    value
                })
            } else {
                None
            };
            // Only bounded display inputs may share a quantized haze uniform.
            // Emission and reflection additions retain the exact source value.
            let haze = if !alpha {
                s.ldr_colors[i]
                    .and_then(|c| c.state)
                    .and_then(|state| s.display_states.get(state as usize))
                    .filter(|state| state.emission.is_none() && state.wet.is_none())
                    .and_then(|_| display_haze)
                    .and_then(|value| {
                        if let Some(key) = self.haze_keys[pass][i] {
                            return Some(key);
                        }
                        let key = crate::mesh_batch::quantize_haze(value);
                        // A validated display state only belongs to a static
                        // draw. Its centre shares the eye-keyed value cache.
                        self.haze_keys[pass][i] = key;
                        key
                    })
            } else {
                None
            };
            let mergeable = !alpha
                && m.depth_write
                && d.node.is_none()
                && d.skin.is_none()
                && (d.layout == pc::VertexLayout::Baked
                    || s.ldr_colors[i].is_some_and(|c| c.page.is_some()))
                && !self.programs[program].has("uLightPos")
                && (!self.programs[program].has("uDisplayHaze") || haze.is_some());
            order.push(DrawRun {
                index: i,
                transparent: alpha,
                sort_key: if alpha {
                    -eye.distance_squared((lo + hi) * 0.5)
                } else {
                    if m.alpha_test > 0.0 {
                        1.0
                    } else {
                        0.0
                    }
                },
                material_key: {
                    index_override.map(|r| r.state).or_else(|| s.ldr_colors[i].and_then(|c| c.state))
                        .map_or((false, d.material), |state| (true, state))
                },
                haze,
                display_haze,
                cluster_span: None,
                index_override: index_override.map(|_| source_range),
                center: (lo + hi) * 0.5,
                count,
                offset,
                streaming: mergeable
                    || s.ldr_colors[i].is_some_and(|c| c.page.is_some()),
                mergeable,
                page_key: {
                    s.ldr_colors[i]
                        .and_then(|c| c.page)
                        .map_or((false, d.vertices.offset), |page| (true, page))
                },
            });
        }
        let cull_done = crate::atlas_seconds();
        order.sort_unstable_by(|a, b| {
            a.transparent
                .cmp(&b.transparent)
                .then(a.sort_key.total_cmp(&b.sort_key))
                .then_with(|| {
                    if a.transparent {
                        a.index.cmp(&b.index)
                    } else {
                        a.material_key
                            .cmp(&b.material_key)
                            .then(a.page_key.cmp(&b.page_key))
                            .then(a.haze.cmp(&b.haze))
                            .then(a.offset.cmp(&b.offset))
                    }
                })
        });
        let sort_done = crate::atlas_seconds();
        // Resolve a compact, exact visibility/LOD selection before touching
        // index data. The same selection means the same immutable source
        // indices, even when a camera moves inside one visibility region.
        // Dynamic bounds/centers and per-draw haze still come from this frame.
        self.selection_scratch.clear();
        self.cluster_scratch.clear();
        let cluster_view = crate::mesh_clusters::Query::new(
            clip.map(|plane| plane.to_array()),
            eye.to_array(),
            if mirror {
                1.6 / self.mirror.h as f32
            } else {
                0.8 / self.height as f32
            },
        )
        // Mirror winding is reversed by glFrontFace below. Evaluate source
        // triangle orientation from the reflected eye, while retaining the
        // original eye above for the existing LOD distance contract.
        .with_cull_eye(if mirror {
            [eye.x, -eye.y, eye.z]
        } else {
            eye.to_array()
        });
        for run in &mut order {
            let groups = if !run.transparent {
                s.mesh_clusters
                    .as_ref()
                    .and_then(|c| c.groups(run.index).map(|g| (c, g)))
            } else {
                None
            };
            if groups.is_some() {
                run.streaming = true;
            }
            // Only streamed draws own bytes in this IBO. A moving raw draw's
            // visibility, LOD or transparent order cannot invalidate them.
            run.stream_key(&mut self.selection_scratch, groups.is_some());
            if let Some((clusters, _)) = groups {
                let size_at = self.selection_scratch.len();
                self.selection_scratch.push(0);
                let start = self.cluster_scratch.len();
                self.query_cache[pass].query(
                    clusters,
                    run.index,
                    &cluster_view,
                    |group, level, cluster, bounds| {
                        self.selection_scratch
                            .extend_from_slice(&[group, level, cluster]);
                        self.cluster_scratch.push(bounds);
                    },
                );
                let count = self.cluster_scratch.len() - start;
                self.selection_scratch[size_at] = count as u32;
                run.cluster_span = Some((start, count));
            }
        }
        let reuse_stream =
            self.stream_valid[pass] && self.selection_keys[pass] == self.selection_scratch;
        if !reuse_stream {
            self.index_scratch.clear();
        }
        let mut combined: Vec<DrawRun> = Vec::new();
        for mut run in order {
            if reuse_stream {
                self.stream_ranges[pass][run.index].restore(&mut run);
            } else if run.streaming {
                if let Some((start, count)) = run.cluster_span {
                    run.streaming = true;
                    let first = self.index_scratch.len();
                    let base = s.ldr_colors[run.index]
                        .filter(|c| c.page.is_some())
                        .map_or(0, |c| c.base_vertex);
                    let clusters = s.mesh_clusters.as_ref().unwrap();
                    for cluster in &self.cluster_scratch[start..start + count] {
                        self.index_scratch.extend(
                            clusters
                                .indices(cluster)
                                .iter()
                                .map(|&i| (i as u32 + base) as u16),
                        );
                    }
                    run.offset = (first * 2) as u32;
                    run.count = (self.index_scratch.len() - first) as u32;
                } else {
                    let indices = if let Some(source) = &run.index_override {
                        s.index_override(run.index, source).map(|r| r.indices)
                    } else {
                        s.indices(run.offset, run.count)
                    };
                    run.streaming = indices.is_some();
                    if let Some(indices) = indices {
                        run.count = indices.len() as u32;
                        run.offset = (self.index_scratch.len() * 2) as u32;
                        let base = {
                            s.ldr_colors[run.index]
                                .filter(|c| c.page.is_some())
                                .map_or(0, |c| c.base_vertex)
                        };
                        self.index_scratch
                            .extend(indices.iter().map(|&i| (i as u32 + base) as u16));
                    }
                }
                self.stream_ranges[pass][run.index] = StreamRange {
                    offset: run.offset,
                    count: run.count,
                    streaming: run.streaming,
                };
            }
            if run.count == 0 {
                continue;
            }
            if let Some(last) = combined.last_mut() {
                let a = &s.meta.draws[last.index];
                let b = &s.meta.draws[run.index];
                let same_color_page = match (s.ldr_colors[last.index], s.ldr_colors[run.index]) {
                        (Some(a), Some(b)) => {
                            a.offset == b.offset
                                && a.page == b.page
                                && a.texture == b.texture
                                && a.state == b.state
                                && (a.page.is_some() || a.flags == b.flags)
                        }
                        (None, None) => true,
                        _ => false,
                    };
                if last.streaming
                    && run.streaming
                    && last.mergeable
                    && run.mergeable
                    && self.mesh_program(last.index, mode) == self.mesh_program(run.index, mode)
                    && same_color_page
                    && last.haze == run.haze
                    && if s.ldr_colors[last.index].is_some_and(|c| c.page.is_some())
                    {
                        last.material_key == run.material_key
                            && last
                                .count
                                .checked_add(run.count)
                                .is_some_and(|count| count <= i32::MAX as u32)
                    } else {
                        crate::mesh_batch::compatible(
                            a,
                            b,
                            last.offset,
                            last.count,
                            run.offset,
                            run.count,
                        )
                    }
                {
                    last.count += run.count;
                    continue;
                }
            }
            combined.push(run);
        }
        let indices_done = crate::atlas_seconds();
        glBindVertexArrayOES(0);
        let mut stream_ready = true;
        if !reuse_stream {
            let next_slot = (self.stream_slot[pass] + 1) % 3;
            if !self.index_scratch.is_empty() {
                let stream = self.stream_indices[pass][next_slot];
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, stream);
                glBufferData(
                    GL_ELEMENT_ARRAY_BUFFER,
                    (self.index_scratch.len() * 2) as isize,
                    self.index_scratch.as_ptr() as _,
                    0x88e0, /* STREAM_DRAW */
                );
                let error = glGetError();
                if error != 0 {
                    // Ranges describe the attempted upload, not the old IBO.
                    // Never cache or draw them after a failed allocation.
                    stream_ready = false;
                    self.gl_error = error;
                }
            }
            self.stream_valid[pass] = stream_ready;
            if stream_ready {
                self.stream_slot[pass] = next_slot;
                core::mem::swap(&mut self.selection_keys[pass], &mut self.selection_scratch);
            }
        }
        let stream = self.stream_indices[pass][self.stream_slot[pass]];
        let upload_done = crate::atlas_seconds();
        glBindBuffer(GL_ARRAY_BUFFER, s.geometry);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, s.geometry);
        glDepthFunc(GL_LEQUAL);
        glFrontFace(if mirror { 0x0900 } else { 0x0901 });
        let mut current_program = usize::MAX;
        let mut current_material = (usize::MAX, (false, u32::MAX));
        let mut globals_set = alloc::vec![false; self.programs.len()];
        // globals()/shadow.bind() only set uniforms here. Any future direct
        // texture binding inside this pass must invalidate this local cache.
        let mut texture_bindings = crate::gpu::TextureBindings::default();
        for DrawRun {
            index: i,
            center,
            count,
            offset,
            streaming,
            material_key,
            haze,
            display_haze,
            ..
        } in combined
        {
            if streaming && !stream_ready {
                continue;
            }
            let d = &s.meta.draws[i];
            let m = &s.meta.materials[d.material as usize];
            let program = self.mesh_program(i, mode);
            let p = &self.programs[program];
            let display_color = s.ldr_colors[i];
            let blend = material_blend(m);
            if current_program != program {
                p.bind();
                current_program = program;
            }
            if !globals_set[program] {
                self.globals(p, s, eye, time);
                p.mat("uViewProj", vp);
                p.v(
                    "uWorldScale",
                    &[1.0, if mirror { -1.0 } else { 1.0 }, 1.0, 0.0],
                );
                globals_set[program] = true;
            }
            let material_changed = current_material != (program, material_key);
            current_material = (program, material_key);
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
            let uv = if display_color.is_some_and(|c| c.page.is_some()) {
                [1.0, 1.0, 0.0, 0.0]
            } else {
                [d.uv_scale[0], d.uv_scale[1], d.uv_offset[0], d.uv_offset[1]]
            };
            p.v("uUv", &m.uv_anim.map(|a| a.apply(uv, time)).unwrap_or(uv));
            if let Some(haze) = haze {
                p.v("uDisplayHaze", &haze.map(|v| v as f32 / 255.0));
            } else if let Some(value) = display_haze {
                p.v("uDisplayHaze", &value);
            }
            if material_changed {
                let gain = s.emissive[d.material as usize];
                if display_color.is_some_and(|c| c.flags & 8 != 0) {
                    let emission = pc::color::tone(m.emissive.map(|v| v * gain), &s.meta.post);
                    p.v(
                        "uDisplayEmission",
                        &v4(
                            core::array::from_fn(|k| {
                                (emission[k] - self.display_black[k]).max(0.0)
                            }),
                            0.0,
                        ),
                    );
                }
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
                if display_color.is_none() {
                    if let Some(shade) = m.emission_shade {
                        let mut values = [0.0; 8];
                        values[..4].copy_from_slice(&shade.normal);
                        values[4..].copy_from_slice(&shade.height);
                        p.v("uEmissionShade", &values);
                    }
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
                if display_color.is_some_and(|c| c.flags & (16 | 32) != 0) {
                    let roughness = m.roughness
                        * m.orm
                            .map(|i| s.meta.textures[i as usize].mean[1])
                            .unwrap_or(1.0);
                    p.v("uPbr", &[roughness, 0.0, m.normal_scale, 1.0]);
                    p.v(
                        "uEnvK",
                        &[
                            0.0,
                            m.clearcoat.max(m.drops),
                            0.0,
                            if s.meta.rain.active { 1.0 } else { 0.0 },
                        ],
                    );
                    if let Some(wet) = &m.wet {
                        p.v(
                            "uWet",
                            &[
                                wet.puddles,
                                libm::sqrtf(wet.darken.max(0.0)),
                                wet.roughness,
                                wet.ripple,
                            ],
                        );
                        p.v("uWet2", &[1.0 / wet.puddle_scale.max(0.01), 0.0, 0.0, 0.0]);
                        p.v(
                            "uReflOn",
                            &[if reflection && !mirror { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0],
                        );
                        let rain = if s.meta.rain.active { 1.0 } else { 0.0 };
                        p.v("uWetCurve", &[
                            roughness * (1.0 + (wet.roughness - 1.0) * rain),
                            1.0 + (libm::sqrtf(wet.darken.max(0.0)) - 1.0) * rain,
                            0.71 - wet.puddles * 0.25,
                            if wet.puddles >= 0.001 { rain } else { 0.0 },
                        ]);
                        let frame = (time * 1.15 - libm::floorf(time * 1.15)) * 16.0;
                        let cell = libm::floorf(frame);
                        p.v("uRippleCell", &[cell % 4.0, libm::floorf(cell * 0.25), 0.0, 0.0]);
                        p.v(
                            "uRipple",
                            &[
                                cell,
                                0.0,
                                0.0,
                                1.0 / s.meta.effects.ripple_tile.max(0.1),
                            ],
                        );
                    }
                }
                if display_color.is_none() {
                    let orm = m.orm.map(|t| s.meta.textures[t as usize].mean).unwrap_or([1.0; 4]);
                    p.v(
                        "uPbr",
                        &[
                            m.roughness * orm[1],
                            m.water.map(|w| w.mask).unwrap_or(m.metalness * orm[2]),
                            m.normal_scale,
                            (orm[0] - 1.0) * m.ao_strength + 1.0,
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
                        {
                            let display = |body: [f32; 3]| {
                                pc::color::tone(
                                    core::array::from_fn(|k| {
                                        body[k] * s.meta.atmosphere.hemisphere_sky[k]
                                    }),
                                    &s.meta.post,
                                )
                            };
                            p.v("uDisplayBody", &v4(display(w.body), 0.0));
                            p.v(
                                "uDisplayShallow",
                                &v4(display(w.shallow.unwrap_or(w.body)), 0.0),
                            );
                            if let Some(sun) = &s.meta.sun {
                                p.v(
                                    "uDisplaySun",
                                    &v4(pc::color::tone(sun.radiance, &s.meta.post), 0.0),
                                );
                            }
                        }
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
                }
            }
            // Only the nearest two lights are used. Do not allocate and
            // sort the whole scene light list for every submitted draw.
            if p.has("uLightPos") || p.has("uObjectLightDir") {
                let mut lights: [Option<&crate::scene::Light>; 2] = [None, None];
                let mut nearest = [f32::INFINITY; 2];
                for light in &s.lights {
                    if d.layout == pc::VertexLayout::Baked && !light.dynamic {
                        continue;
                    }
                    let distance = light.pos.distance_squared(center);
                    if distance < nearest[0] {
                        nearest[1] = nearest[0];
                        lights[1] = lights[0];
                        nearest[0] = distance;
                        lights[0] = Some(light);
                    } else if distance < nearest[1] {
                        nearest[1] = distance;
                        lights[1] = Some(light);
                    }
                }
                let (mut positions, mut colors, mut dirs, mut rights, mut ups) =
                    ([0.0; 8], [0.0; 8], [0.0; 8], [0.0; 8], [0.0; 8]);
                for (k, l) in lights.iter().flatten().enumerate() {
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
                let (mut object_dirs, mut object_colors) = ([0.0; 8], [0.0; 8]);
                for (k, l) in lights.iter().flatten().enumerate() {
                    let delta = center - l.pos;
                    let closest = l.pos
                        + l.right * delta.dot(l.right).clamp(-l.size[0], l.size[0])
                        + l.up * delta.dot(l.up).clamp(-l.size[1], l.size[1]);
                    let to_light = closest - center;
                    let direction = to_light.normalize_or_zero();
                    let range2 = to_light.length_squared() + l.size[0] * l.size[1];
                    let cone = ((-direction).dot(l.dir) * l.spot[1] + l.spot[0]).clamp(0.0, 1.0);
                    let range = range2
                        * if l.reach > 0.0 {
                            1.0 / (l.reach * l.reach)
                        } else {
                            0.0
                        };
                    let attenuation = (1.0 - range * range).clamp(0.0, 1.0);
                    let color = l.color
                        * (attenuation * attenuation * cone * cone * (3.0 - 2.0 * cone)
                            / range2.max(0.01)
                            / core::f32::consts::PI);
                    object_dirs[k * 4..k * 4 + 4].copy_from_slice(&v4(direction.to_array(), 0.0));
                    object_colors[k * 4..k * 4 + 4].copy_from_slice(&v4(color.to_array(), 0.0));
                }
                p.v("uObjectLightDir", &object_dirs);
                p.v("uObjectLightCol", &object_colors);
            }
            if material_changed {
                let tex = |i: Option<u32>| i.map(|i| s.textures[i as usize]).unwrap_or(self.white);
                let mut unit = 0;
                for (name, id) in [
                    (
                        "uAlbedo",
                        tex(display_color.map_or(m.albedo, |c| c.texture)),
                    ),
                    ("uNormalMap", tex(m.normal)),
                    ("uOrm", tex(m.orm)),
                    ("uEmission", tex(m.emission)),
                    ("uEnv", tex(s.meta.atmosphere.environment)),
                    (
                        "uDisplayEnv",
                        match s.display_environments[d.material as usize] {
                            0 => self.white_cube,
                            id => id,
                        },
                    ),
                    ("uPuddles", tex(s.meta.effects.puddles)),
                    ("uRipples", tex(s.meta.effects.ripples)),
                    ("uBeads", tex(s.meta.effects.beads)),
                    ("uWetResponse", self.wet_response.as_ref().map_or(self.white, |t| t.texture)),
                    ("uWaterResponse", self.water_response.as_ref().map_or(self.white, |t| t.texture)),
                    ("uDisplayReflSharp", self.mirror.texture),
                    ("uDisplayReflBlur", self.mirror_blur.texture),
                    ("uReflSharp", self.mirror.texture),
                    ("uReflBlur", self.mirror_blur.texture),
                    ("uAtlasLut", self.lut),
                    (
                        "uShadow",
                        self.shadow
                            .as_ref()
                            .map(|s| s.texture())
                            .unwrap_or(self.white),
                    ),
                ] {
                    unit = p.tex_cached(name, id, unit, &mut texture_bindings);
                }
                let cull = if material_key.0 {
                    s.display_states[material_key.1 as usize].cull
                } else { !m.double_sided };
                if cull { glEnable(GL_CULL_FACE); } else { glDisable(GL_CULL_FACE); }
                if blend != pc::Blend::Opaque {
                    glEnable(GL_BLEND);
                    glBlendFuncSeparate(
                        if blend == pc::Blend::Alpha {
                            GL_SRC_ALPHA
                        } else {
                            GL_ONE
                        },
                        if blend == pc::Blend::Additive {
                            GL_ONE
                        } else {
                            0x0303
                        },
                        0,
                        GL_ONE,
                    );
                } else {
                    glDisable(GL_BLEND);
                    glColorMask(1, 1, 1, 1);
                }
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
                glDepthMask((m.depth_write && blend == pc::Blend::Opaque) as u8);
                if let Some(b) = m.polygon_offset {
                    glEnable(0x8037);
                    glPolygonOffset(b[0], b[1]);
                } else {
                    glDisable(0x8037);
                }
            }
            glBindVertexArrayOES(display_color.map_or(s.vaos[i], |c| c.vao));
            glBindBuffer(
                GL_ELEMENT_ARRAY_BUFFER,
                if streaming { stream } else { s.geometry },
            );
            let gpu_offset = if streaming {
                offset
            } else if let Some(offset) = s.gpu_index_offset(offset, count) {
                offset
            } else {
                self.gl_error = 0x0502; // Missing validated GPU range, not texture zero.
                break;
            };
            glDrawElements(
                GL_TRIANGLES,
                count as _,
                GL_UNSIGNED_SHORT,
                gpu_offset as usize as _,
            );
            self.count += 1;
            self.triangles += count / 3;
        }
        glBindVertexArrayOES(0);
        glDisable(0x8037);
        glDisable(GL_BLEND);
        glColorMask(1, 1, 1, 1);
        glFrontFace(0x0901);
        let submit_done = crate::atlas_seconds();
        let stamps = [
            cpu_start,
            cull_done,
            sort_done,
            indices_done,
            upload_done,
            submit_done,
        ];
        self.mesh_steps_ms[pass] =
            core::array::from_fn(|i| ((stamps[i + 1] - stamps[i]) * 1000.0) as f32);
    }
    // Display blending is submitted asynchronously and EAGL
    // presentation provides backpressure. Normal timing has no explicit
    // glFinish, but includes any implicit driver waits in submitted calls.
    // Diagnostic profiling adds explicit completion to each measured pass.
    unsafe fn end_pass(&mut self, stage: usize, started: f64) -> f64 {
        let submitted = crate::atlas_seconds();
        if self.profile {
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
    ) -> Result<(), String> {
        self.count = 0;
        self.triangles = 0;
        self.gl_error = 0;
        self.mesh_steps_ms = [[0.0; 5]; MESH_PASSES];
        let mut stamp = crate::atlas_seconds();
        if let Some(shadow) = &mut self.shadow {
            let stats = shadow.render(s, time);
            self.count += stats.draws;
            self.triangles += stats.triangles;
        }
        stamp = self.end_pass(0, stamp);
        let projection = glam::camera::rh::proj::opengl::perspective(
            fov * core::f32::consts::PI / 180.0,
            1.5,
            0.25,
            100000.0,
        );
        let vp = projection * glam::camera::rh::view::look_at_mat4(eye, target, Vec3::Y);
        let mirror_needed = reflection
            && s.meta
                .materials
                .iter()
                .any(|m| m.wet.as_ref().is_some_and(|w| w.planar));
        // The read footprint is specific to the compiled display wet recipe.
        // Any raw material consumer retains the complete reflection target.
        let mirror_region = if !mirror_needed {
            ReflectionRegion::Empty
        } else if self.wet_response.is_some()
            && s.meta.draws.iter().enumerate().all(|(i, d)| {
                s.meta.materials[d.material as usize].wet.is_none()
                    || self.wet_programs[i].is_some()
            })
        {
            let key = vp.to_cols_array().map(f32::to_bits);
            if let Some((_, region)) = self.mirror_region_cache.filter(|(view, _)| *view == key) {
                region
            } else {
                let response = self.wet_response.as_ref().unwrap();
                let region = ReflectionRegion::calculate(vp, [response.w, response.h],
                    [self.mirror.w, self.mirror.h], [self.mirror_blur.w, self.mirror_blur.h],
                    s.meta.draws.iter().filter_map(|d| {
                        let wet = s.meta.materials[d.material as usize].wet.as_ref()?;
                        let (min, max) = s.bounds(d);
                        Some(WetBounds { min, max, ripple: wet.ripple,
                            puddle_gain: if wet.puddles >= 0.001 && s.meta.rain.active { 1.0 } else { 0.0 } })
                    }));
                self.mirror_region_cache = Some((key, region));
                region
            }
        } else {
            ReflectionRegion::Full
        };
        glDisable(GL_SCISSOR_TEST);
        if mirror_region != ReflectionRegion::Empty {
            self.mirror.bind();
            glDepthMask(1);
            glClearColor(0.0, 0.0, 0.0, 1.0);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            if let ReflectionRegion::Scissor { mirror, .. } = mirror_region {
                glEnable(GL_SCISSOR_TEST);
                glScissor(mirror.x, mirror.y, mirror.width, mirror.height);
            }
            self.sky(s, eye, target, fov, time, true);
            self.meshes(s, vp, eye, time, MeshPass::Mirror, false);
            {
                glDiscardFramebufferEXT(0x8d40, 1, &0x8d00);
            }
            glBindVertexArrayOES(0);
            glDisable(GL_DEPTH_TEST);
            glDepthMask(0);
            glDisable(GL_CULL_FACE);
            glDisable(GL_BLEND);
            self.mirror_blur.bind();
            glDisable(GL_SCISSOR_TEST);
            // Clear before scissoring so a partial draw need not restore the
            // previous frame's unused tiles on a tile-based GPU.
            glClear(GL_COLOR_BUFFER_BIT);
            if let ReflectionRegion::Scissor { down, .. } = mirror_region {
                glEnable(GL_SCISSOR_TEST);
                glScissor(down.x, down.y, down.width, down.height);
            }
            let p = &self.programs[self.blit];
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
            glDisable(GL_SCISSOR_TEST);
        }
        stamp = self.end_pass(1, stamp);
        self.wet_response_ms = 0.0;
        if let Some(response) = &self.wet_response {
            response.bind();
            glEnable(GL_DEPTH_TEST);
            glDepthMask(1);
            glColorMask(1, 1, 1, 1);
            glClearColor(0.0, 0.0, 0.0, 1.0);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            self.meshes(s, vp, eye, time, MeshPass::WetResponse, reflection);
            glDiscardFramebufferEXT(0x8d40, 1, &0x8d00);
            if self.profile { glFinish(); }
            let done = crate::atlas_seconds();
            self.wet_response_ms = ((done - stamp) * 1000.0) as f32;
            stamp = done;
        }
        self.water_response_ms = 0.0;
        if let Some(response) = &self.water_response {
            response.bind();
            glEnable(GL_DEPTH_TEST);
            glDepthMask(1);
            glColorMask(1, 1, 1, 1);
            glClearColor(0.0, 0.0, 0.0, 0.0);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            self.meshes(s, vp, eye, time, MeshPass::WaterResponse, reflection);
            glDiscardFramebufferEXT(0x8d40, 1, &0x8d00);
            if self.profile { glFinish(); }
            let done = crate::atlas_seconds();
            self.water_response_ms = ((done - stamp) * 1000.0) as f32;
            stamp = done;
        }
        {
            self.sky_low.bind();
            self.sky(s, eye, target, fov, time, false);
        }
        self.main.bind();
        glDepthMask(1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        {
            glDisable(GL_DEPTH_TEST);
            glDepthMask(0);
            glDisable(GL_CULL_FACE);
            let p = &self.programs[self.copy];
            p.bind();
            p.tex("uSource", self.sky_low.texture, 0);
            self.fullscreen(p);
            glEnable(GL_DEPTH_TEST);
            glDepthMask(1);
        }
        if self.profile {
            glFinish();
        }
        let sky_finished = crate::atlas_seconds();
        self.sky_ms = ((sky_finished - stamp) * 1000.0) as f32;
        self.meshes(s, vp, eye, time, MeshPass::Main, reflection);
        self.submit_ms = ((crate::atlas_seconds() - stamp) * 1000.0) as f32;
        stamp = self.end_pass(2, stamp);
        self.mesh_ms = ((stamp - sky_finished) * 1000.0) as f32;
        let stats = self
            .effects
            .draw_geometry(s, vp, eye, target, fov, time, rain, self.lut)?;
        self.light_points = stats.light_points;
        self.count += stats.draws;
        self.triangles += stats.particle_quads * 2;
        {
            // Post effects reconstruct distance from color alpha. Hardware
            // depth is dead once all opaque and particle geometry is drawn.
            glDiscardFramebufferEXT(0x8d40, 1, &0x8d00);
        }
        stamp = self.end_pass(3, stamp);
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
            self.lut,
        );
        if self.profile {
            glFinish();
        }
        let post_fx_done = crate::atlas_seconds();
        self.post_steps_ms[0] = ((post_fx_done - stamp) * 1000.0) as f32;
        glDisable(GL_DEPTH_TEST);
        glDepthMask(0);
        glDisable(GL_CULL_FACE);
        glDisable(GL_BLEND);
        // Display colors composite directly into EAGL, avoiding an extra
        // target, tile store and fullscreen texture read.
        glBindFramebuffer(0x8d40, fbo);
        glViewport(0, 0, w, h);
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
        if self.profile {
            glFinish();
        }
        let grade_done = crate::atlas_seconds();
        self.post_steps_ms[1] = ((grade_done - post_fx_done) * 1000.0) as f32;
        glDepthMask(1);
        // The drawable only receives a fullscreen color composite. Its depth
        // attachment is never used, so a discard here is redundant. Let EAGL
        // presentation provide backpressure for the submitted frame.
        let finish = self.end_pass(4, stamp);
        self.post_steps_ms[2] = ((finish - grade_done) * 1000.0) as f32;
        Ok(())
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    fn run(index: usize, streaming: bool, offset: u32, count: u32) -> DrawRun {
        DrawRun {
            index,
            streaming,
            offset,
            count,
            transparent: false,
            sort_key: 0.0,
            center: Vec3::ZERO,
            mergeable: streaming,
            page_key: (false, 0),
            material_key: (false, 0),
            haze: None,
            display_haze: None,
            cluster_span: None,
            index_override: None,
        }
    }
    fn key(runs: &[DrawRun]) -> Vec<u32> {
        let mut key = Vec::new();
        for run in runs {
            run.stream_key(&mut key, false);
        }
        key
    }
    #[test]
    fn animated_raw_ranges_do_not_invalidate_or_reuse_static_index_ranges() {
        let before = [
            run(0, true, 18, 6),
            run(1, false, 60, 12),
            run(2, true, 42, 9),
        ];
        // Raw moving geometry may change LOD, disappear, or sort elsewhere.
        let mut after = [
            run(1, false, 96, 3),
            run(0, true, 18, 6),
            run(2, true, 42, 9),
        ];
        assert_eq!(key(&before), key(&after));
        assert_eq!(key(&before), key(&after[1..]));
        let cached = [
            StreamRange {
                offset: 0,
                count: 6,
                streaming: true,
            },
            StreamRange::default(),
            StreamRange {
                offset: 12,
                count: 9,
                streaming: true,
            },
        ];
        for run in &mut after {
            cached[run.index].restore(run);
        }
        assert_eq!(
            (after[0].offset, after[0].count, after[0].streaming),
            (96, 3, false)
        );
        assert_eq!(
            (after[1].offset, after[1].count, after[1].streaming),
            (0, 6, true)
        );
        assert_eq!(
            (after[2].offset, after[2].count, after[2].streaming),
            (12, 9, true)
        );
        assert_ne!(
            key(&before),
            key(&[run(0, true, 18, 3), run(2, true, 42, 9)])
        );
        assert_ne!(
            key(&before),
            key(&[run(2, true, 42, 9), run(0, true, 18, 6)])
        );
    }
    #[test]
    fn display_index_recipe_has_a_distinct_stream_key_and_restores_its_smaller_count() {
        let original = run(0, true, 18, 12);
        let mut display = run(0, true, 18, 12);
        display.index_override = Some(pc::Range { offset: 18, size: 24 });
        assert_ne!(key(&[original]), key(core::slice::from_ref(&display)));
        let cached = StreamRange { offset: 64, count: 6, streaming: true };
        cached.restore(&mut display);
        assert_eq!((display.offset, display.count), (64, 6));
        assert_eq!(display.index_override.unwrap().offset, 18);
    }

    #[test]
    fn clustered_ranges_key_selected_parts_instead_of_unused_whole_draw_lod() {
        let mut a = Vec::new();
        let mut b = Vec::new();
        run(4, true, 18, 6).stream_key(&mut a, true);
        run(4, true, 72, 3).stream_key(&mut b, true);
        // One selected cluster, from group 2, LOD 1, cluster ordinal 3.
        a.extend_from_slice(&[1, 2, 1, 3]);
        b.extend_from_slice(&[1, 2, 1, 3]);
        assert_eq!(a, b);
        *b.last_mut().unwrap() = 4;
        assert_ne!(a, b);
        let mut empty = Vec::new();
        run(4, true, 18, 6).stream_key(&mut empty, true);
        empty.push(0);
        assert_ne!(a, empty);
        assert!(
            !empty.is_empty(),
            "empty selection still identifies its source draw"
        );
    }
}
