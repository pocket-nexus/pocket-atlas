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
    background: [String; 2],
    marker: [String; 2],
}
pub struct Globe {
    _objects: Objects,
    marker: Program,
    quad: u32,
    hits: Vec<(usize, [f32; 2])>,
    meta: Meta,
    program: Program,
    post: Program,
    background: Program,
    textures: BTreeMap<String, u32>,
    target: Target,
    vb: u32,
    ib: u32,
    tri: u32,
    count: i32,
    lut: u32,
    white: u32,
    grain: u32,
}
impl Globe {
    pub unsafe fn new(root: &str) -> Result<Self, String> {
        let meta: Meta = serde_json::from_slice(&read(&format!("{root}/globe/globe.json"))?)
            .map_err(|e| format!("globe metadata {e}"))?;
        let pipelines: Pipelines =
            serde_json::from_slice(&read(&format!("{root}/globe.pipelines.json"))?)
                .map_err(|e| format!("globe pipelines {e}"))?;
        let mut objects = Objects::default();
        let mut textures = BTreeMap::new();
        for t in &meta.files {
            if t.file.ends_with(".f32") {
                continue;
            }
            let data = read(&format!("{root}/globe/{}", t.file))?;
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
        for y in 0..ny {
            for x in 0..nx {
                let a = (y * (nx + 1) + x) as u16;
                let b = a + (nx + 1) as u16;
                indices.extend([a, b, a + 1, a + 1, b, b + 1]);
            }
        }
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
        Ok(Self {
            _objects: objects,
            quad,
            hits: Vec::new(),
            marker: Program::new(root, &pipelines.marker)?,
            meta,
            program: Program::new(root, &pipelines.globe)?,
            post: Program::new(root, &pipelines.post)?,
            background: Program::new(root, &pipelines.background)?,
            textures,
            target: Target::new(480, 272, true)?,
            vb,
            ib,
            tri,
            count: indices.len() as _,
            lut,
            white,
            grain,
        })
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
        glBindBuffer(GL_ARRAY_BUFFER, self.vb);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self.ib);
        for i in 0..8 {
            glDisableVertexAttribArray(i);
        }
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, 0, 20, core::ptr::null());
        glEnableVertexAttribArray(3);
        glVertexAttribPointer(3, 2, GL_FLOAT, 0, 20, 12usize as _);
        glDrawElements(
            GL_TRIANGLES,
            self.count,
            GL_UNSIGNED_SHORT,
            core::ptr::null(),
        );
        self.hits.clear();
        glDisable(GL_DEPTH_TEST);
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
        }
        glBindFramebuffer(0x8d40, fbo);
        glViewport(0, 0, w, h);
        glClearColor(0.015, 0.025, 0.045, 1.0);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        glDisable(GL_DEPTH_TEST);
        glViewport(-58 * w / 960, 40 * h / 640, 936 * w / 960, 530 * h / 640);
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
        glViewport(0, 0, w, h);
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
