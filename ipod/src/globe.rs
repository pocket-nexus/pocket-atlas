//! The atlas is a live, rotatable globe, using the shared Earth material and
//! the exported atmosphere tables. UIKit supplies the accessible place list.
use crate::{
    gl::*,
    gpu::{Objects, Program, Target},
    read,
    scene::rows,
};
use alloc::{collections::BTreeMap, format, string::String, vec::Vec};
use glam::{EulerRot, Mat4, Quat, Vec3, Vec4};
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    framing: Framing,
    camera: Camera,
    sun: [f32; 3],
    sun_i: f32,
    surface: f32,
    lights_max: f32,
    lights_gain: f32,
    night: f32,
    cloud_shadow: f32,
    specular: f32,
    cloud_opacity: f32,
    cloud_glow: f32,
    cloud_drift_per_s: f32,
    sun_curve: Vec<[f32; 4]>,
    files: Vec<Texture>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Framing {
    width: f32,
    height: f32,
    radius_px: f32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Camera {
    distance: f32,
    fov: f32,
    shift_ndc: f32,
}
#[derive(Deserialize)]
struct Texture {
    name: String,
    file: String,
    width: i32,
    height: i32,
    mips: u32,
    #[serde(rename = "wrapS")]
    wrap_s: String,
}
#[derive(Deserialize)]
struct Pipelines {
    globe: [String; 2],
    post: [String; 2],
    post_bounded: [String; 2],
    background: [String; 2],
    marker: [String; 2],
    blit: [String; 2],
}
pub struct Globe {
    pub profile: bool,
    /// Background, Earth surface, place markers, and final grade/composite.
    pub timings: [f32; 4],
    pub draws: u32,
    pub triangles: u32,
    pub sphere_step: u32,
    /// Grade, then display blit.
    pub post_steps_ms: [f32; 2],
    _objects: Objects,
    marker: Program,
    quad: u32,
    hits: Vec<(usize, [f32; 2])>,
    meta: Meta,
    program: Program,
    post: Program,
    blit: Program,
    background: Program,
    textures: BTreeMap<String, u32>,
    target: Target,
    grade_target: Target,
    vb: u32,
    ib: u32,
    tri: u32,
    sphere_levels: [SphereLevel; 3],
    lut: u32,
    white: u32,
    grain: u32,
}
struct SphereLevel {
    step: u32,
    count: i32,
    offset: usize,
}
impl Globe {
    pub unsafe fn new(root: &str, width: i32) -> Result<Self, String> {
        let (width, height) = target_size(width)?;
        let meta: Meta = serde_json::from_slice(&read(&format!("{root}/globe/globe.json"))?)
            .map_err(|e| format!("globe metadata {e}"))?;
        if ![
            meta.framing.width,
            meta.framing.height,
            meta.framing.radius_px,
        ]
        .iter()
        .all(|v| v.is_finite() && *v > 0.0)
            || !meta.camera.distance.is_finite()
            || meta.camera.distance <= 1.0
        {
            return Err("globe framing".into());
        }
        let pipelines: Pipelines =
            serde_json::from_slice(&read(&format!("{root}/globe.pipelines.json"))?)
                .map_err(|e| format!("globe pipelines {e}"))?;
        let mut objects = Objects::default();
        let mut textures = BTreeMap::new();
        let mut bounded_background = false;
        for t in &meta.files {
            if t.file.ends_with(".f32") {
                continue;
            }
            let data = read(&format!("{root}/globe/{}", t.file))?;
            if t.name == "space" {
                bounded_background = fast_grade_background(&data);
            }
            let mut texture = 0;
            glGenTextures(1, &mut texture);
            objects.textures.push(texture);
            glBindTexture(GL_TEXTURE_2D, texture);
            let (mut w, mut h, mut at) = (t.width, t.height, 0usize);
            for level in 0..t.mips {
                let size = w as usize * h as usize * 4;
                if at + size > data.len() {
                    return Err("globe texture range".into());
                }
                glTexImage2D(
                    GL_TEXTURE_2D,
                    level as _,
                    GL_RGBA as _,
                    w,
                    h,
                    0,
                    GL_RGBA,
                    GL_UNSIGNED_BYTE,
                    data[at..].as_ptr() as _,
                );
                at += size;
                w = (w / 2).max(1);
                h = (h / 2).max(1);
            }
            glTexParameteri(
                GL_TEXTURE_2D,
                GL_TEXTURE_MIN_FILTER,
                if t.mips > 1 { 0x2703 } else { GL_LINEAR },
            );
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(
                GL_TEXTURE_2D,
                GL_TEXTURE_WRAP_S,
                if t.wrap_s == "repeat" {
                    GL_REPEAT
                } else {
                    GL_CLAMP_TO_EDGE
                },
            );
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            textures.insert(t.name.clone(), texture);
        }
        let (mut vertices, mut indices) = (Vec::<f32>::new(), Vec::<u16>::new());
        let (nx, ny) = (128, 64);
        for y in 0..=ny {
            let v = y as f32 / ny as f32;
            let lat = core::f32::consts::PI * (0.5 - v);
            for x in 0..=nx {
                let u = x as f32 / nx as f32;
                let lon = (u - 0.5) * core::f32::consts::TAU;
                vertices.extend([
                    libm::cosf(lat) * libm::sinf(lon),
                    libm::sinf(lat),
                    libm::cosf(lat) * libm::cosf(lon),
                    u,
                    v,
                ]);
            }
        }
        let sphere_levels = [1, 2, 4].map(|step| append_sphere_level(&mut indices, step));
        let vb = objects.buffer();
        let ib = objects.buffer();
        let tri = objects.buffer();
        let quad = objects.buffer();
        glBindBuffer(GL_ARRAY_BUFFER, quad);
        let corners = [
            -1.0f32, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
        ];
        glBufferData(GL_ARRAY_BUFFER, 48, corners.as_ptr() as _, GL_STATIC_DRAW);
        glBindBuffer(GL_ARRAY_BUFFER, vb);
        glBufferData(
            GL_ARRAY_BUFFER,
            (vertices.len() * 4) as _,
            vertices.as_ptr() as _,
            GL_STATIC_DRAW,
        );

        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ib);
        glBufferData(
            GL_ELEMENT_ARRAY_BUFFER,
            (indices.len() * 2) as _,
            indices.as_ptr() as _,
            GL_STATIC_DRAW,
        );

        glBindBuffer(GL_ARRAY_BUFFER, tri);
        let triangle = [-1.0f32, -1.0, 3.0, -1.0, -1.0, 3.0];
        glBufferData(GL_ARRAY_BUFFER, 24, triangle.as_ptr() as _, GL_STATIC_DRAW);
        let mut grade = pocket3d_place::Post::default();
        grade.contrast = 1.0;
        grade.saturation = 1.0;
        grade.lift = [0.0; 3];
        grade.gain = [1.0; 3];
        let lut = crate::gpu::tone_lut(&grade);
        objects.textures.push(lut);
        let (white, grain) = crate::gpu::grade_textures(&mut objects, 0.3);
        let post_names = [pipelines.post, pipelines.post_bounded];
        let post = Program::new(
            root,
            &post_names[usize::from(bounded_background)],
        )?;
        Ok(Self {
            profile: false,
            timings: [0.0; 4],
            draws: 0,
            triangles: 0,
            sphere_step: 1,
            post_steps_ms: [0.0; 2],
            _objects: objects,
            quad,
            hits: Vec::new(),
            marker: Program::new(root, &pipelines.marker)?,
            meta,
            program: Program::new(root, &pipelines.globe)?,
            post,
            blit: Program::new(root, &pipelines.blit)?,
            background: Program::new(root, &pipelines.background)?,
            textures,
            target: Target::new(width, height, true)?,
            grade_target: Target::new(width, height, false)?,
            vb,
            ib,
            tri,
            sphere_levels,
            lut,
            white,
            grain,
        })
    }
    pub fn dimensions(&self) -> (i32, i32) {
        (self.target.w, self.target.h)
    }
    pub unsafe fn resize(&mut self, width: i32) -> Result<(), String> {
        let (width, height) = target_size(width)?;
        // Keep the usable target if allocation fails. The App latches failures
        // until an explicit retry, just as it does for a place renderer.
        let target = Target::new(width, height, true)?;
        let grade_target = Target::new(width, height, false)?;
        self.target = target;
        self.grade_target = grade_target;
        Ok(())
    }
    unsafe fn triangle(&self) {
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        glBindBuffer(GL_ARRAY_BUFFER, self.tri);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, 0, 8, core::ptr::null());
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
    pub unsafe fn frame(
        &mut self,
        markers: &[Marker],
        rotation: [f32; 2],
        time: f32,
        fbo: u32,
        w: i32,
        h: i32,
    ) {
        let mut timings = [0.0; 4];
        let mut stamp = crate::atlas_seconds();
        self.draws = 0;
        self.triangles = 0;
        self.post_steps_ms = [0.0; 2];
        let m = &self.meta;
        self.target.bind();
        glDepthMask(1);
        glClearColor(0.0, 0.0, 0.0, 1.0);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        glDisable(GL_BLEND);
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        self.background.bind();
        self.background.tex("uSource", self.textures["space"], 0);
        self.triangle();
        self.draws += 1;
        self.triangles += 1;
        stamp = finish_pass(self.profile, &mut timings, 0, stamp);
        let p = &self.program;
        p.bind();
        let eye = Vec3::new(0.0, 0.0, m.camera.distance);
        let projection = glam::camera::rh::proj::opengl::perspective(
            m.camera.fov.to_radians(),
            960.0 / 544.0,
            m.camera.distance - 1.2,
            m.camera.distance + 2.0,
        );
        let shift = Mat4::from_cols(
            Vec4::X,
            Vec4::Y,
            Vec4::Z,
            Vec4::new(m.camera.shift_ndc, 0.0, 0.0, 1.0),
        );
        let vp =
            shift * projection * glam::camera::rh::view::look_at_mat4(eye, Vec3::ZERO, Vec3::Y);
        let rot = Mat4::from_quat(Quat::from_euler(
            EulerRot::XYZ,
            rotation[0].to_radians(),
            -rotation[1].to_radians(),
            0.0,
        ));
        p.mat("uViewProj", vp);
        p.v("uEarthRot", &rows(rot));
        p.v("uSun", &[m.sun[0], m.sun[1], m.sun[2], 0.0]);
        p.v("uEye", &[eye.x, eye.y, eye.z, 0.0]);
        p.v(
            "uGlobeK",
            &[m.sun_i * m.surface, m.lights_max, m.lights_gain, m.night],
        );
        p.v(
            "uGlobeK2",
            &[m.cloud_shadow, m.specular, m.cloud_opacity, m.cloud_glow],
        );
        p.v(
            "uCloudOff",
            &[time * m.cloud_drift_per_s, m.sun_i, 0.0, 0.0],
        );
        let curve: Vec<f32> = m.sun_curve.iter().flatten().copied().collect();
        p.v("uSunCurve", &curve);
        for (i, (uniform, name)) in [
            ("uAlbedo", "albedo"),
            ("uNormalMap", "normals"),
            ("uLights", "lights"),
            ("uClouds", "clouds"),
            ("uInscatter", "inscatter"),
            ("uTransmit", "transmittance"),
        ]
        .iter()
        .enumerate()
        {
            p.tex(uniform, self.textures[*name], i as _);
        }
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        {
            // The indexed sphere is counter-clockwise from outside. GL_BACK
            // is the context's default cull mode and is never changed here.
            glFrontFace(0x0901);
            glEnable(GL_CULL_FACE);
        }
        glBindBuffer(GL_ARRAY_BUFFER, self.vb);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self.ib);
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, 0, 20, core::ptr::null());
        glEnableVertexAttribArray(3);
        glVertexAttribPointer(3, 2, GL_FLOAT, 0, 20, 12usize as _);
        let radius = m.framing.radius_px
            * (self.target.w as f32 / m.framing.width).max(self.target.h as f32 / m.framing.height);
        let level = &self.sphere_levels[sphere_level(radius, m.camera.distance)];
        self.sphere_step = level.step;
        glDrawElements(
            GL_TRIANGLES,
            level.count,
            GL_UNSIGNED_SHORT,
            level.offset as _,
        );
        self.draws += 1;
        self.triangles += level.count as u32 / 3;
        stamp = finish_pass(self.profile, &mut timings, 1, stamp);
        self.hits.clear();
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        let p = &self.marker;
        p.bind();
        glBindBuffer(GL_ARRAY_BUFFER, self.quad);
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, 0, 8, core::ptr::null());
        for (i, marker) in markers.iter().enumerate() {
            let lat = marker.lat.to_radians();
            let lon = marker.lon.to_radians();
            let point = Vec3::new(
                libm::cosf(lat) * libm::sinf(lon),
                libm::sinf(lat),
                libm::cosf(lat) * libm::cosf(lon),
            );
            let world = rot.transform_point3(point * 1.004);
            let visibility =
                ((world.normalize().dot((eye - world).normalize()) - 0.05) / 0.2).clamp(0.0, 1.0);
            if visibility <= 0.0 {
                continue;
            }
            let clip = vp * world.extend(1.0);
            let x = clip.x / clip.w;
            let y = clip.y / clip.w;
            // Composite viewport converted to UIKit landscape points.
            self.hits.push((
                i,
                [
                    (-58.0 + (x + 1.0) * 468.0) / 2.0,
                    (640.0 - 40.0 - (y + 1.0) * 265.0) / 2.0,
                ],
            ));
            let pulse = (time * 1.4) % 1.0;
            p.v("uMarker", &[x, y, 18.0 * 2.0 / 960.0, 18.0 * 2.0 / 544.0]);
            p.v(
                "uMarkerCol",
                &[
                    marker.color[0] * 5.0 * visibility,
                    marker.color[1] * 5.0 * visibility,
                    marker.color[2] * 5.0 * visibility,
                    0.0,
                ],
            );
            p.v(
                "uMarkerK",
                &[0.16, 0.2 + 0.7 * pulse, 0.07, 0.9 * (1.0 - pulse)],
            );
            glDrawArrays(GL_TRIANGLES, 0, 6);
            self.draws += 1;
            self.triangles += 2;
        }
        stamp = finish_pass(self.profile, &mut timings, 2, stamp);
        glDisable(GL_DEPTH_TEST);
        self.grade_target.bind();
        let p = &self.post;
        p.bind();
        p.tex("uScene", self.target.texture, 0);
        p.tex("uLut", self.lut, 1);
        p.tex("uMask", self.white, 2);
        p.tex("uGrain", self.grain, 3);
        p.v("uBloomK", &[0.0, 1.0, 0.0, 0.0]);
        p.v("uGrade", &[0.0, 0.0, 0.022, 0.0]);
        p.v(
            "uGrainK",
            &[7.5, 4.25, time * 0.618034 % 1.0, time * 0.414214 % 1.0],
        );
        self.triangle();
        self.draws += 1;
        self.triangles += 1;
        if self.profile {
            glFinish();
        }
        let grade_done = crate::atlas_seconds();
        self.post_steps_ms[0] = ((grade_done - stamp) * 1000.0) as f32;
        composite_target(fbo, w, h);
        self.blit.bind();
        self.blit.tex("uSource", self.grade_target.texture, 0);
        self.triangle();
        self.draws += 1;
        self.triangles += 1;
        glViewport(0, 0, w, h);
        let post_done = finish_pass(self.profile, &mut timings, 3, stamp);
        self.post_steps_ms[1] = ((post_done - grade_done) * 1000.0) as f32;
        self.timings = timings;
    }
}

unsafe fn composite_target(fbo: u32, width: i32, height: i32) {
    glBindFramebuffer(0x8d40, fbo);
    glViewport(0, 0, width, height);
    glClearColor(0.015, 0.025, 0.045, 1.0);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glViewport(
        -58 * width / 960,
        40 * height / 640,
        936 * width / 960,
        530 * height / 640,
    );
}

fn fast_grade_background(rgba: &[u8]) -> bool {
    !rgba.is_empty()
        && rgba.len() % 4 == 0
        && rgba
            .chunks_exact(4)
            .all(|pixel| pixel[..3].iter().all(|&c| c <= 254))
}

fn append_sphere_level(indices: &mut Vec<u16>, step: u32) -> SphereLevel {
    let start = indices.len();
    for y in (0..64).step_by(step as usize) {
        for x in (0..128).step_by(step as usize) {
            let a = (y * 129 + x) as u16;
            let b = ((y + step) * 129 + x) as u16;
            let across = step as u16;
            indices.extend([a, b, a + across, a + across, b, b + across]);
        }
    }
    SphereLevel {
        step,
        count: (indices.len() - start) as i32,
        offset: start * 2,
    }
}

fn silhouette_error(radius_px: f32, distance: f32, step: u32) -> f32 {
    // Latitude and longitude each span 2*pi*step/128. The mesh contains
    // a concentric sphere of radius cos(half-step)^2; using both axes also
    // bounds a diagonal facet at arbitrary globe rotation. Project that
    // inner sphere with the same perspective camera, rather than assuming
    // orthographic chords. This bounds the silhouette in target pixels.
    let half = core::f64::consts::PI * step as f64 / 128.0;
    let cosine = libm::cos(half);
    let inner = cosine * cosine;
    let distance2 = (distance as f64) * (distance as f64);
    let ratio = inner * libm::sqrt((distance2 - 1.0) / (distance2 - inner * inner));
    (radius_px as f64 * (1.0 - ratio)) as f32
}

fn sphere_level(radius_px: f32, distance: f32) -> usize {
    {
        for (index, step) in [(2, 4), (1, 2)] {
            if silhouette_error(radius_px, distance, step) <= 0.25 {
                return index;
            }
        }
    }
    0
}

fn target_size(width: i32) -> Result<(i32, i32), String> {
    if !(1..=4096).contains(&width) {
        return Err("globe target width".into());
    }
    // Preserve the authored globe projection and composite viewport at every
    // quality level. Resize resolution, never UIKit coordinates or markers.
    Ok((width, ((width * 272 + 240) / 480).max(1)))
}

unsafe fn finish_pass(profile: bool, timings: &mut [f32; 4], pass: usize, start: f64) -> f64 {
    if profile {
        glFinish();
    }
    let now = crate::atlas_seconds();
    timings[pass] = ((now - start) * 1000.0) as f32;
    now
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sphere_lods_reuse_full_vertices_with_same_winding_and_bounded_indices() {
        let mut indices = Vec::new();
        let levels = [1, 2, 4].map(|step| append_sphere_level(&mut indices, step));
        for (level, triangles) in levels.iter().zip([16384, 4096, 1024]) {
            assert_eq!(level.count / 3, triangles);
            let first = level.offset / 2;
            let slice = &indices[first..first + level.count as usize];
            assert!(slice.iter().all(|&i| i < 129 * 65));
            for quad in slice.chunks_exact(6) {
                assert_eq!(quad[2] - quad[0], level.step as u16);
                assert_eq!(quad[1] - quad[0], 129 * level.step as u16);
                assert_eq!(quad[3], quad[2]);
                assert_eq!(quad[4], quad[1]);
                assert_eq!(quad[5] - quad[1], level.step as u16);
            }
        }
        assert_eq!(levels[0].offset, 0);
        assert_eq!(levels[1].offset, levels[0].count as usize * 2);
        assert_eq!(
            levels[2].offset,
            (levels[0].count + levels[1].count) as usize * 2
        );
    }

    #[test]
    fn sphere_lod_respects_quarter_pixel_bound_and_full_quality() {
        let distance = 5.141497;
        for width in [160, 192, 256, 320, 400, 480, 640, 960] {
            let (_, height) = target_size(width).unwrap();
            let radius = 201.28 * (width as f32 / 960.0).max(height as f32 / 544.0);
            let level = sphere_level(radius, distance);
            let step = [1, 2, 4][level];
            assert!(silhouette_error(radius, distance, step) <= 0.25);

            if level < 2 {
                assert!(silhouette_error(radius, distance, step * 2) > 0.25);
            }
        }
        assert_eq!(sphere_level(201.28 / 3.0, distance), 1);
        assert_eq!(sphere_level(201.28 / 6.0, distance), 1);
        assert_eq!(sphere_level(20.0, distance), 2);
    }

    #[test]
    fn silhouette_bound_contains_the_actual_mesh_facets() {
        let point = |index: u16| {
            let lat = core::f64::consts::PI * (0.5 - (index as usize / 129) as f64 / 64.0);
            let lon = ((index as usize % 129) as f64 / 128.0 - 0.5) * core::f64::consts::TAU;
            [
                libm::cos(lat) * libm::sin(lon),
                libm::sin(lat),
                libm::cos(lat) * libm::cos(lon),
            ]
        };
        for step in [1, 2, 4] {
            let mut indices = Vec::new();
            append_sphere_level(&mut indices, step);
            let cosine = libm::cos(core::f64::consts::PI * step as f64 / 128.0);
            let inner_radius = cosine * cosine;
            for triangle in indices.chunks_exact(3) {
                let a = point(triangle[0]);
                let b = point(triangle[1]);
                let c = point(triangle[2]);
                let ab: [f64; 3] = core::array::from_fn(|k| b[k] - a[k]);
                let ac: [f64; 3] = core::array::from_fn(|k| c[k] - a[k]);
                let normal = [
                    ab[1] * ac[2] - ab[2] * ac[1],
                    ab[2] * ac[0] - ab[0] * ac[2],
                    ab[0] * ac[1] - ab[1] * ac[0],
                ];
                let norm2 = normal.iter().map(|n| n * n).sum::<f64>();
                // One triangle per polar quad collapses at the common pole.
                if norm2 < 1e-20 {
                    continue;
                }
                let plane_distance =
                    normal.iter().zip(a).map(|(n, p)| n * p).sum::<f64>() / libm::sqrt(norm2);
                assert!(
                    plane_distance > 0.0,
                    "all nondegenerate triangles must face outwards (CCW)"
                );
                assert!(
                    plane_distance + 1e-12 >= inner_radius,
                    "facet at step {step} violates the claimed inner sphere"
                );
            }
        }
    }

    #[test]
    fn fast_grade_requires_bounded_rgb_but_not_bounded_alpha() {
        for byte in 0..=254 {
            assert!(fast_grade_background(&[byte, byte, byte, 255]));
        }
        for channel in 0..3 {
            let mut pixel = [254, 254, 254, 255];
            pixel[channel] = 255;
            assert!(!fast_grade_background(&pixel));
        }
        assert!(!fast_grade_background(&[]));
        assert!(!fast_grade_background(&[0; 3]));
    }

    #[test]
    fn resolution_preserves_authored_aspect_and_full_quality_target() {
        assert_eq!(super::target_size(480).unwrap(), (480, 272));
        assert_eq!(super::target_size(320).unwrap(), (320, 181));
        assert_eq!(super::target_size(160).unwrap(), (160, 91));
        assert_eq!(super::target_size(640).unwrap(), (640, 363));
        assert!(super::target_size(0).is_err());
        assert!(super::target_size(4097).is_err());
    }
}
pub struct Marker {
    pub lat: f32,
    pub lon: f32,
    pub color: [f32; 3],
}
impl Globe {
    pub fn pick(&self, x: f32, y: f32) -> Option<usize> {
        self.hits
            .iter()
            .map(|(i, p)| (*i, (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y)))
            .filter(|(_, d)| *d < 18.0 * 18.0)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i)
    }
}
