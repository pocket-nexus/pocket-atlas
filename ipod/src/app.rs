use crate::{
    gl::*,
    read,
    renderer::Renderer,
    scene::Scene,
    state::{Store, UserState},
};
use alloc::{
    ffi::CString,
    format,
    string::{String, ToString},
    vec::Vec,
};
use core::ffi::c_char;
use glam::Vec3;
use serde::Deserialize;
extern "C" {
    fn atlas_documents_path() -> *const c_char;
    fn atlas_audio_available() -> i32;
    fn atlas_audio_error() -> *const c_char;
    fn atlas_resident_bytes() -> u32;
    fn atlas_audio_update(place: *const c_char, time: f64, enabled: i32, paused: i32) -> i32;
}
#[derive(Deserialize)]
struct Place {
    id: String,
    name: String,
    summary: String,
    native: String,
    locality: String,
    weather: String,
    author: String,
    lat: f32,
    lon: f32,
    accent: String,
}
pub struct App {
    state_store: Option<Store>,
    state_restored: bool,
    state_saved: bool,
    state_error: String,
    details: Vec<CString>,
    authors: Vec<CString>,
    last_command: String,
    build_id: String,
    profile: bool,
    reset_dt: bool,
    reload: bool,
    saved_door: f32,
    sound: bool,
    ids: Vec<CString>,
    globe: Option<crate::globe::Globe>,
    globe_tried: bool,
    root: String,
    places: Vec<Place>,
    titles: Vec<CString>,
    summaries: Vec<CString>,
    selected: Option<usize>,
    pending: Option<usize>,
    scene: Option<Scene>,
    renderer: Option<Renderer>,
    pub status: CString,
    error: String,
    frame: u32,
    time: f32,
    shot: usize,
    shot_time: f32,
    freeze: Option<f32>,
    paused: bool,
    reflection: bool,
    bloom: bool,
    rain: bool,
    cinematic: bool,
    eye: Vec3,
    target: Vec3,
    fov: f32,
    fps_ms: f32,
    quality: i32,
    render_override: Option<i32>,
    adaptive_width: i32,
    quality_timer: f32,
    shot_name: CString,
    error_text: CString,
    touches: Vec<(i32, [f32; 2], [f32; 2])>,
    globe_rotation: [f32; 2],
    markers: Vec<crate::globe::Marker>,
}
impl App {
    pub fn new(root: String) -> Self {
        let build_id = read(&format!("{root}/build-receipt.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["buildId"].as_str().map(ToString::to_string))
            .unwrap_or_default();
        let places: Vec<Place> = read(&format!("{root}/catalog.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let titles = places
            .iter()
            .map(|p| CString::new(p.name.as_str()).unwrap())
            .collect();
        let summaries = places
            .iter()
            .map(|p| CString::new(p.summary.as_str()).unwrap())
            .collect();
        let ids = places
            .iter()
            .map(|p| CString::new(p.id.as_str()).unwrap())
            .collect();
        let details = places
            .iter()
            .map(|p| {
                CString::new(format!("{} · {} · {}", p.native, p.locality, p.weather)).unwrap()
            })
            .collect();
        let authors = places
            .iter()
            .map(|p| CString::new(p.author.as_str()).unwrap())
            .collect();
        let markers = places
            .iter()
            .map(|p| {
                let rgb =
                    u32::from_str_radix(p.accent.trim_start_matches('#'), 16).unwrap_or(0x88bbff);
                crate::globe::Marker {
                    lat: p.lat,
                    lon: p.lon,
                    color: core::array::from_fn(|i| {
                        libm::powf(((rgb >> (16 - i * 8)) & 255) as f32 / 255.0, 2.2)
                    }),
                }
            })
            .collect();
        let documents = unsafe { atlas_documents_path() };
        let state_store = if documents.is_null() {
            None
        } else {
            Store::new(&unsafe { core::ffi::CStr::from_ptr(documents) }.to_string_lossy()).ok()
        };
        let state_error = if state_store.is_none() {
            String::from("Documents directory is unavailable")
        } else {
            String::new()
        };
        let mut app = Self {
            state_store,
            state_restored: false,
            state_saved: false,
            state_error,
            markers,
            details,
            authors,
            last_command: String::new(),
            build_id,
            profile: false,
            reset_dt: false,
            reload: false,
            saved_door: 0.0,
            sound: false,
            ids,
            globe: None,
            globe_tried: false,
            root,
            places,
            titles,
            summaries,
            selected: None,
            pending: None,
            scene: None,
            renderer: None,
            status: CString::new("{}").unwrap(),
            error: String::new(),
            frame: 0,
            time: 0.0,
            shot: 0,
            shot_time: 0.0,
            freeze: None,
            paused: false,
            reflection: true,
            bloom: true,
            rain: true,
            cinematic: true,
            eye: Vec3::new(0.0, 2.0, 8.0),
            target: Vec3::ZERO,
            fov: 45.0,
            fps_ms: 33.3,
            quality: 1,
            render_override: None,
            adaptive_width: 480,
            quality_timer: 0.0,
            shot_name: CString::new("").unwrap(),
            error_text: CString::new("").unwrap(),
            touches: Vec::new(),
            globe_rotation: [31.0, 131.0],
        };
        app.restore_user_state();
        app
    }

    fn restore_user_state(&mut self) {
        let Some(store) = &self.state_store else {
            return;
        };
        let state = match store.load() {
            Ok(Some(state)) => state,
            Ok(None) => return,
            Err(error) => {
                self.state_error = error.into();
                return;
            }
        };
        let selected = match state.selected(self.places.iter().map(|p| p.id.as_str())) {
            Ok(selected) => selected,
            Err(error) => {
                self.state_error = error.into();
                return;
            }
        };
        self.selected = selected;
        self.reload = selected.is_some();
        self.reset_dt = true;
        self.time = state.time;
        self.shot = state.shot as usize;
        self.shot_time = state.shot_time;
        self.paused = state.paused;
        self.cinematic = state.cinematic;
        self.eye = Vec3::from(state.eye);
        self.target = Vec3::from(state.target);
        self.fov = state.fov;
        self.saved_door = state.door;
        self.globe_rotation = state.globe_rotation;
        self.sound = state.sound;
        self.rain = state.rain;
        self.reflection = state.reflection;
        self.bloom = state.bloom;
        self.quality = state.quality;
        self.state_restored = true;
    }

    pub fn save_user_state(&mut self) {
        // A queued scene change already resets its shot, but selected and its
        // camera still describe the displayed scene. Keep the last checkpoint.
        if self.pending.is_some() {
            return;
        }
        let Some(store) = &self.state_store else {
            return;
        };
        let state = UserState {
            version: UserState::VERSION,
            place: self.selected.map(|i| self.places[i].id.clone()),
            time: self.time,
            shot: self.shot as u32,
            shot_time: self.shot_time.max(0.0),
            paused: self.paused,
            cinematic: self.cinematic,
            eye: self.eye.to_array(),
            target: self.target.to_array(),
            fov: self.fov,
            door: self
                .scene
                .as_ref()
                .map(|s| s.door)
                .unwrap_or(self.saved_door),
            globe_rotation: [self.globe_rotation[0], self.globe_rotation[1] % 360.0],
            sound: self.sound,
            rain: self.rain,
            reflection: self.reflection,
            bloom: self.bloom,
            quality: self.quality,
        };
        match store.save(&state) {
            Ok(()) => {
                self.state_saved = true;
                self.state_error.clear();
            }
            Err(error) => {
                self.state_saved = false;
                self.state_error = error.into();
            }
        }
    }
    pub fn value(&self, field: i32) -> i32 {
        match field {
            0 => self.places.len() as i32,
            1 => {
                if self.pending.is_some() || self.reload {
                    2
                } else if !self.error.is_empty() {
                    3
                } else if self.scene.is_some() {
                    1
                } else {
                    0
                }
            }
            2 => self.selected.map(|i| i as i32).unwrap_or(-1),
            3 => self.paused as i32,
            4 => self.cinematic as i32,
            5 => self.rain as i32,
            6 => self.reflection as i32,
            7 => self.bloom as i32,
            8 => self.sound as i32,
            9 => self.quality,
            10 => self.shot as i32,
            11 => self
                .scene
                .as_ref()
                .map(|s| s.meta.camera.shots.len() as i32)
                .unwrap_or(0),
            12 => unsafe { atlas_audio_available() },
            _ => 0,
        }
    }
    pub fn text(&self, i: i32, field: i32) -> *const c_char {
        if i < 0 && field == 2 {
            return self.shot_name.as_ptr();
        }
        if i < 0 && field == 3 {
            return self.error_text.as_ptr();
        }
        let i = if i < 0 {
            self.selected.unwrap_or(0)
        } else {
            i as usize
        };
        if field == 4 {
            return self
                .ids
                .get(i)
                .map(|v| v.as_ptr())
                .unwrap_or(b"\0".as_ptr() as _);
        }
        if field == 5 {
            return self
                .details
                .get(i)
                .map(|v| v.as_ptr())
                .unwrap_or(b"\0".as_ptr() as _);
        }
        if field == 6 {
            return self
                .authors
                .get(i)
                .map(|v| v.as_ptr())
                .unwrap_or(b"\0".as_ptr() as _);
        }
        let values = if field == 0 {
            &self.titles
        } else {
            &self.summaries
        };
        values
            .get(i)
            .map(|v| v.as_ptr())
            .unwrap_or(b"\0".as_ptr() as _)
    }
    pub fn action(&mut self, action: i32) {
        match action {
            0 => {
                unsafe {
                    glFinish();
                }
                self.pending = None;
                self.reload = false;
                self.renderer = None;
                self.scene = None;
                self.selected = None;
                self.error.clear();
                self.touches.clear();
            }
            100..=199 => {
                let i = (action - 100) as usize;
                if i < self.places.len() {
                    self.pending = Some(i);
                    self.shot = 0;
                    self.shot_time = 0.0;
                    self.freeze = None;
                    self.paused = false;
                    self.cinematic = true;
                }
            }
            3 => {
                if let Some(s) = &self.scene {
                    self.shot =
                        (self.shot + s.meta.camera.shots.len() - 1) % s.meta.camera.shots.len();
                    self.shot_time = 0.0;
                    self.cinematic = true;
                }
            }
            6 => {
                if let Some(s) = &self.scene {
                    self.shot = (self.shot + 1) % s.meta.camera.shots.len();
                    self.shot_time = 0.0;
                    self.cinematic = true;
                }
            }
            4 => self.paused = !self.paused,
            5 => self.cinematic = !self.cinematic,
            8 => {
                self.quality = (self.quality + 1) % 3;
            }
            9 => self.rain = !self.rain,
            10 => self.reflection = !self.reflection,
            11 => self.bloom = !self.bloom,
            12 => self.sound = !self.sound,
            13 => {
                self.time = 0.0;
                self.shot = 0;
                self.shot_time = 0.0;
                self.cinematic = true;
                self.paused = false;
                self.freeze = None;
            }
            _ => {}
        }
    }
    pub fn command(&mut self, bytes: &[u8]) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) {
            if let Some(n) = v["nonce"].as_str() {
                self.last_command = n.to_string();
            }
            if let Some(touches) = v["touches"].as_array() {
                for t in touches {
                    self.touch(
                        t["phase"].as_i64().unwrap_or(-1) as i32,
                        t["x"].as_f64().unwrap_or(0.0) as f32,
                        t["y"].as_f64().unwrap_or(0.0) as f32,
                        t["id"].as_i64().unwrap_or(0) as i32,
                    );
                }
            }
            if let Some(id) = v["place"].as_str() {
                if id == "atlas" {
                    self.action(0);
                } else if let Some(i) = self.places.iter().position(|p| p.id == id) {
                    self.action(100 + i as i32);
                }
            }
            if let Some(shot) = v["shot"].as_u64() {
                self.shot = shot as usize;
                self.shot_time = -1.0;
                self.cinematic = true;
            }
            if let Some(t) = v["time"].as_f64() {
                self.freeze = if t >= 0.0 { Some(t as f32) } else { None };
            }
            if let Some(p) = v["pause"].as_bool() {
                self.paused = p;
            }
            if let Some(p) = v["sound"].as_bool() {
                self.sound = p;
            }
            if let Some(p) = v["profile"].as_bool() {
                self.profile = p;
            }
            if let Some(p) = v["reflection"].as_bool() {
                self.reflection = p;
            }
            if let Some(p) = v["bloom"].as_bool() {
                self.bloom = p;
            }
            if let Some(n) = v["renderWidth"].as_i64() {
                self.render_override = if n == 0 {
                    None
                } else {
                    Some((n as i32).clamp(256, 960))
                };
            }
            if let Some(n) = v["quality"].as_i64() {
                self.quality = (n as i32).clamp(0, 2);
            }
            if let Some(p) = v["rain"].as_bool() {
                self.rain = p;
            }
        }
    }
    pub fn touch(&mut self, phase: i32, x: f32, y: f32, id: i32) {
        if phase < 0 {
            self.touches.clear();
            return;
        }
        if phase == 0 {
            self.touches.retain(|t| t.0 != id);
            self.touches.push((id, [x, y], [x, y]));
            return;
        }
        if phase == 3 && self.scene.is_none() {
            let tapped = self
                .touches
                .iter()
                .find(|t| t.0 == id)
                .is_some_and(|t| (x - t.1[0]).abs() + (y - t.1[1]).abs() < 8.0);
            if tapped {
                if let Some(i) = self.globe.as_ref().and_then(|g| g.pick(x, y)) {
                    self.action(100 + i as i32);
                }
            }
        }
        if phase == 3 || phase == 4 {
            self.touches.retain(|t| t.0 != id);
            return;
        }
        if phase == 2 {
            return;
        }
        if let Some(t) = self.touches.iter_mut().find(|t| t.0 == id) {
            let dx = x - t.2[0];
            let dy = y - t.2[1];
            t.2 = [x, y];
            if self.scene.is_none() {
                self.globe_rotation[0] = (self.globe_rotation[0] + dy * 0.35).clamp(-80.0, 80.0);
                self.globe_rotation[1] += dx * 0.35;
            } else if !self.cinematic && t.1[0] > 240.0 {
                let direction = (self.target - self.eye).normalize();
                let yaw = libm::atan2f(direction.x, -direction.z) - dx * 0.005;
                let pitch = (libm::asinf(direction.y) - dy * 0.005).clamp(-1.3, 1.3);
                self.target = self.eye
                    + Vec3::new(
                        libm::sinf(yaw) * libm::cosf(pitch),
                        libm::sinf(pitch),
                        -libm::cosf(yaw) * libm::cosf(pitch),
                    );
            }
        }
    }
    /// The owner calls this with a current, drained GL context before iOS
    /// suspends the process. Preserve navigation but release the working set.
    pub unsafe fn suspend(&mut self) {
        // iOS may terminate a suspended process without a termination callback.
        // Commit the CPU state while the complete current view still exists.
        self.save_user_state();
        self.saved_door = self
            .scene
            .as_ref()
            .map(|s| s.door)
            .unwrap_or(self.saved_door);
        self.renderer = None;
        self.scene = None;
        self.globe = None;
        self.globe_tried = false;
        self.touches.clear();
        self.reload = self.selected.is_some();
        self.reset_dt = true;
        glFinish();
        let mut status: serde_json::Value =
            serde_json::from_slice(self.status.as_bytes()).unwrap_or_default();
        status["state"] = "suspended".into();
        status["gpuBytes"] = 0.into();
        status["residentBytes"] = atlas_resident_bytes().into();
        status["audioPlaying"] = false.into();
        status["userStateSaved"] = self.state_saved.into();
        status["userStateError"] = self.state_error.clone().into();
        self.status = CString::new(status.to_string()).unwrap();
    }
    pub unsafe fn frame(&mut self, dt: f32, w: i32, h: i32, fbo: u32) {
        let dt = if self.reset_dt {
            self.reset_dt = false;
            1.0 / 30.0
        } else {
            dt
        };
        let resuming = self.reload && self.pending.is_none();
        self.reload = false;
        if resuming {
            self.pending = self.selected;
        }
        if let Some(i) = self.pending.take() {
            glFinish();
            self.reset_dt = true;
            // A scene never displays the atlas: release its maps/targets before
            // uploading another full GPU working set on the 256 MB device.
            self.globe = None;
            self.globe_tried = false;
            self.renderer = None;
            self.scene = None;
            self.error.clear();
            let id = &self.places[i].id;
            let assets = format!("{}/assets", self.root);
            match Scene::load(&format!("{assets}/{id}.place")) {
                Ok(mut s) => match Renderer::new(&assets, id, &s) {
                    Ok(r) => {
                        if resuming {
                            s.door = self.saved_door;
                            // A bundle update may shorten or remove shots. The
                            // saved view remains valid without unbounded loops.
                            self.shot %= s.meta.camera.shots.len();
                            self.shot_time = self
                                .shot_time
                                .clamp(0.0, s.meta.camera.shots[self.shot].duration);
                        }
                        self.scene = Some(s);
                        self.renderer = Some(r);
                        self.selected = Some(i);
                        self.touches.clear();
                        if !resuming {
                            self.time = 0.0;
                        }
                    }
                    Err(e) => self.error = e,
                },
                Err(e) => self.error = e,
            }
            self.error_text = CString::new(self.error.as_str()).unwrap();
            if !self.error.is_empty() {
                crate::atlas_log(self.error_text.as_ptr());
            }
        }
        let measured_dt = dt;
        let dt = dt.clamp(0.0, 0.1);
        if !self.paused {
            self.time += measured_dt.max(0.0);
        }
        let time = self.freeze.unwrap_or(self.time);
        if let (Some(s), Some(r)) = (&mut self.scene, &mut self.renderer) {
            self.shot %= s.meta.camera.shots.len();
            if self.shot_time < 0.0 {
                self.shot_time = s.meta.camera.shots[self.shot].duration * 0.5;
            }
            if self.cinematic && !self.paused && self.freeze.is_none() {
                self.shot_time += measured_dt.max(0.0);
                while self.shot_time >= s.meta.camera.shots[self.shot].duration {
                    self.shot_time -= s.meta.camera.shots[self.shot].duration;
                    self.shot = (self.shot + 1) % s.meta.camera.shots.len();
                }
            }
            let shot = &s.meta.camera.shots[self.shot];
            if self.cinematic {
                let t = (self.shot_time / shot.duration).min(1.0);
                let t = t * t * (3.0 - 2.0 * t);
                self.eye = Vec3::from(shot.from.pos).lerp(Vec3::from(shot.to.pos), t);
                self.target = Vec3::from(shot.from.target).lerp(Vec3::from(shot.to.target), t);
                self.fov = shot.from.fov + (shot.to.fov - shot.from.fov) * t;
            }
            self.shot_name = CString::new(shot.name.as_str()).unwrap();
            if !self.cinematic {
                let direction = (self.target - self.eye).normalize();
                let forward = Vec3::new(direction.x, 0.0, direction.z).normalize();
                let right = forward.cross(Vec3::Y);
                let mut step = Vec3::ZERO;
                for t in &self.touches {
                    if t.1[0] < 240.0 {
                        step += (right * ((t.2[0] - t.1[0]) / 42.0).clamp(-1.0, 1.0)
                            - forward * ((t.2[1] - t.1[1]) / 42.0).clamp(-1.0, 1.0))
                            * dt
                            * 2.5;
                    }
                }
                let mut next = self.eye + step;
                if !s.meta.camera.walkable.is_empty() {
                    next = s
                        .meta
                        .camera
                        .walkable
                        .iter()
                        .map(|b| {
                            next.clamp(Vec3::new(b[0], b[1], b[2]), Vec3::new(b[3], b[4], b[5]))
                        })
                        .min_by(|a, b| {
                            a.distance_squared(next)
                                .total_cmp(&b.distance_squared(next))
                        })
                        .unwrap();
                }
                self.target += next - self.eye;
                self.eye = next;
            }
            self.quality_timer += measured_dt;
            if self.quality == 0 && self.quality_timer > 2.0 {
                let ms = measured_dt * 1000.0;
                if ms > 40.0 && self.adaptive_width > 320 {
                    self.adaptive_width = (self.adaptive_width - 80).max(320);
                } else if ms < 23.0 && self.adaptive_width < 960 {
                    self.adaptive_width += 80;
                }
                self.quality_timer = 0.0;
            }
            let width = self.render_override.unwrap_or(match self.quality {
                1 => 960,
                2 => 480,
                _ => self.adaptive_width,
            });
            if r.width != width {
                if let Err(e) = r.resize(width, width * 2 / 3) {
                    self.error = e;
                    self.error_text = CString::new(self.error.as_str()).unwrap();
                }
            }
            s.update(time, self.eye, dt);
            r.profile = self.profile;
            r.frame(
                s,
                self.eye,
                self.target,
                self.fov,
                time,
                fbo,
                w,
                h,
                self.reflection,
                self.bloom,
                self.rain,
            );
        } else {
            if !self.globe_tried {
                self.globe_tried = true;
                match crate::globe::Globe::new(&format!("{}/assets", self.root)) {
                    Ok(g) => self.globe = Some(g),
                    Err(e) => {
                        self.error = e;
                        self.error_text = CString::new(self.error.as_str()).unwrap();
                    }
                }
            }
            if let Some(g) = &mut self.globe {
                if self.touches.is_empty() {
                    self.globe_rotation[1] += dt * 1.6;
                }
                g.frame(&self.markers, self.globe_rotation, time, fbo, w, h);
            } else {
                glBindFramebuffer(0x8d40, fbo);
                glViewport(0, 0, w, h);
                glClearColor(0.015, 0.025, 0.045, 1.0);
                glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            }
        }
        let audio_id = self
            .selected
            .map(|i| self.ids[i].as_ptr())
            .unwrap_or(b"\0".as_ptr() as _);
        let audio_playing = atlas_audio_update(
            audio_id,
            time as f64,
            self.sound as i32,
            (self.paused || self.freeze.is_some()) as i32,
        );
        self.frame += 1;
        self.fps_ms = self.fps_ms * 0.95 + measured_dt * 1000.0 * 0.05;
        let status = serde_json::json!({"userStateRestored":self.state_restored,"userStateSaved":self.state_saved,"userStateError":self.state_error,"shotTime":self.shot_time,"residentBytes":atlas_resident_bytes(),"audioPlaying":audio_playing != 0,"audioError":core::ffi::CStr::from_ptr(atlas_audio_error()).to_string_lossy(),"buildId":self.build_id,"paused":self.paused,"cinematic":self.cinematic,"sound":self.sound,"rain":self.rain,"reflection":self.reflection,"bloom":self.bloom,"lastCommand":self.last_command,"state":if self.error.is_empty(){"running"}else{"error"},"error":self.error,"frame":self.frame,"place":self.selected.map(|i|self.places[i].id.as_str()).unwrap_or("atlas"),"width":w,"height":h,"renderWidth":self.renderer.as_ref().map(|r|r.width),"renderHeight":self.renderer.as_ref().map(|r|r.height),"frameMs":self.fps_ms,"fps":1000.0/self.fps_ms,"time":time,"shot":self.shot,"quality":self.quality,"timingKind":if self.profile {"synchronized-pass"}else{"cpu-submission"},"submitMs":self.renderer.as_ref().map(|r|r.submit_ms),"passesMs":self.renderer.as_ref().map(|r|r.timings),"camera":self.eye.to_array(),"target":self.target.to_array(),"fov":self.fov,"globeRotation":self.globe_rotation,"draws":self.renderer.as_ref().map(|r|r.count).unwrap_or(0),"triangles":self.renderer.as_ref().map(|r|r.triangles).unwrap_or(0),"gpuBytes":self.scene.as_ref().map(|s|s.gpu_bytes).unwrap_or(0),"glError":glGetError()});
        self.status = CString::new(status.to_string()).unwrap();
    }
}
