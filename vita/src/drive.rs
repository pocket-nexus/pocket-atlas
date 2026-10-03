//! Driving owns route state, controls and the in-game UI; GXM remains a device substrate.
use crate::{
    camera::View,
    gpu::Gpu,
    scene::Scene,
    ui::{rgb, Style, Ui, T},
};
use glam::{Mat4, Quat, Vec3};
use pocket3d_drive::{
    initial_state, restore_state, route_pitch, sample_route, step_drive, DriveInput, DriveState,
    Route,
};
use serde_json::{json, Value};
use vitasdk_sys::*;

#[derive(Clone, Copy)]
enum Articulation {
    Rigid,
    FrontWheel,
    WheelSpin,
    Steering,
}
struct VehicleNode {
    index: usize,
    parent: Option<u32>,
    translation: Vec3,
    rotation: Quat,
    scale: Vec3,
    motion: Articulation,
}

// The exporter appends an object ID to each name; keep the semantic name independent of it.
fn vehicle_name(name: &str, stem: &str) -> bool {
    name == stem
        || name
            .strip_prefix(stem)
            .and_then(|s| s.strip_prefix('_'))
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
}

pub struct Drive {
    route: Route,
    pub state: DriveState,
    pub paused: bool,
    cockpit: bool,
    reverse: bool,
    node: u32,
    vehicle: Vec<VehicleNode>,
    autosave: f32,
    input: Option<DriveInput>,
    pub error: Option<String>,
    audio: Option<crate::drive_audio::DriveAudio>,
    /// A USB profiling pose never enters the domain state or its save file.
    #[cfg(feature = "usb-debug")]
    inspection: Option<DriveState>,
}
impl Drive {
    pub fn from_scene(scene: &Scene) -> Result<Option<Self>, String> {
        let Some(meta) = &scene.meta.driving else {
            return Ok(None);
        };
        let route: Route = serde_json::from_value(meta.route.clone()).map_err(|e| e.to_string())?;
        route.validate()?;
        let file = format!("drive-{}.json", route.id);
        let state = crate::paths::read_json(&file)
            .and_then(|s| restore_state(&route, s))
            .or_else(|| {
                crate::paths::read_json(&format!("{file}.bak"))
                    .and_then(|s| restore_state(&route, s))
            })
            .unwrap_or_else(|| initial_state(&route));
        let audio = crate::drive_audio::DriveAudio::new().ok();
        let mut vehicle = Vec::new();
        for (index, n) in scene.meta.nodes.iter().enumerate() {
            let mut ancestor = Some(index as u32);
            let mut depth = 0;
            let mut under = false;
            while let Some(k) = ancestor {
                if k == meta.vehicle_node {
                    under = true;
                    break;
                }
                ancestor = scene.meta.nodes[k as usize].parent;
                depth += 1;
                if depth > scene.meta.nodes.len() {
                    break;
                }
            }
            if !under {
                continue;
            }
            let motion = if ["fl", "fr"]
                .iter()
                .any(|s| vehicle_name(&n.name, &format!("drive_wheel_{s}")))
            {
                Articulation::FrontWheel
            } else if ["fl", "fr", "rl", "rr"]
                .iter()
                .any(|s| vehicle_name(&n.name, &format!("drive_wheel_spin_{s}")))
            {
                Articulation::WheelSpin
            } else if vehicle_name(&n.name, "drive_steering_wheel") {
                Articulation::Steering
            } else {
                Articulation::Rigid
            };
            vehicle.push(VehicleNode {
                index,
                parent: n.parent,
                translation: Vec3::from(n.translation),
                rotation: Quat::from_array(n.rotation),
                scale: Vec3::from(n.scale),
                motion,
            });
        }
        Ok(Some(Self {
            route,
            state,
            paused: true,
            cockpit: false,
            reverse: false,
            node: meta.vehicle_node,
            vehicle,
            autosave: 0.,
            input: None,
            error: None,
            audio,
            #[cfg(feature = "usb-debug")]
            inspection: None,
        }))
    }
    pub fn save(&mut self) {
        let data = crate::paths::DATA;
        let path = format!("{data}/drive-{}.json", self.route.id);
        let tmp = format!("{path}.tmp");
        let backup = format!("{path}.bak");
        let result = (|| -> Result<(), String> {
            std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec(&self.state).map_err(|e| e.to_string())?;
            std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
            if let Ok(previous) = std::fs::read(&path) {
                if serde_json::from_slice::<Value>(&previous)
                    .ok()
                    .and_then(|v| restore_state(&self.route, v))
                    .is_some()
                {
                    std::fs::write(&backup, previous).map_err(|e| e.to_string())?;
                }
            }
            let _ = std::fs::remove_file(&path);
            std::fs::rename(tmp, path).map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            self.error = Some(format!("Save failed: {e}"));
        }
    }
    pub fn control(&mut self, v: &Value) {
        let d = &v["drive"];
        #[cfg(feature = "usb-debug")]
        {
            // Like the debug camera override, every control packet replaces this value.
            self.inspection = (|| {
                let station = d["inspect"]["s"].as_f64()?;
                let speed = d["inspect"]["speed"].as_f64()?;
                if !station.is_finite()
                    || !(0.0..=self.route.points.last()?.s).contains(&station)
                    || !speed.is_finite()
                    || !(-7.0..=27.0).contains(&speed)
                {
                    return None;
                }
                let p = sample_route(&self.route, station);
                let mut pose = self.state.clone();
                pose.s = station;
                pose.x = p.x + p.dz * 1.6;
                pose.y = p.y;
                pose.z = p.z - p.dx * 1.6;
                pose.yaw = p.yaw;
                pose.speed = speed;
                pose.vx = p.dx * speed;
                pose.vz = p.dz * speed;
                pose.steer = 0.0;
                Some(pose)
            })();
            if !d["inspect"].is_null() {
                return;
            }
        }
        if let Some(p) = d["paused"].as_bool() {
            self.paused = p;
        }
        if let Some(c) = d["cockpit"].as_bool() {
            self.cockpit = c;
        }
        if d["restart"].as_bool() == Some(true) {
            self.state = initial_state(&self.route);
            self.reverse = false;
            self.save();
        }
        self.input = serde_json::from_value(d["input"].clone()).ok();
    }
    pub fn update(&mut self, dt: f32, buttons: u32, pressed: u32, steer: f32, blocked: bool) {
        #[cfg(feature = "usb-debug")]
        if let Some(pose) = &mut self.inspection {
            if dt.is_finite() && dt > 0.0 {
                pose.odometer += pose.speed.abs() * dt.min(0.25) as f64;
            }
            if let Some(audio) = &self.audio {
                audio.update(0.0, 0.0, true);
            }
            return;
        }
        if pressed & SCE_CTRL_START != 0 {
            self.paused = !self.paused;
            self.save();
        }
        if !blocked {
            if pressed & SCE_CTRL_TRIANGLE != 0 {
                self.cockpit = !self.cockpit;
            }
            if pressed & SCE_CTRL_SQUARE != 0 && self.state.speed.abs() < 0.5 {
                self.reverse = !self.reverse;
            }
            if (self.paused || self.state.completed) && pressed & SCE_CTRL_CROSS != 0 {
                if self.state.completed {
                    self.state = initial_state(&self.route);
                    self.reverse = false;
                }
                self.paused = false;
            }
        }
        let input = self.input.unwrap_or(DriveInput {
            throttle: if buttons & SCE_CTRL_RTRIGGER != 0 {
                1.
            } else {
                0.
            },
            brake: if buttons & SCE_CTRL_LTRIGGER != 0 || buttons & SCE_CTRL_DOWN != 0 {
                1.
            } else {
                0.
            },
            steer: steer as f64,
            reverse: self.reverse,
            interact: buttons & SCE_CTRL_CROSS != 0,
            recover: buttons & SCE_CTRL_CIRCLE != 0,
        });
        let before = self.state.next_stop;
        if !self.paused && !blocked {
            step_drive(&self.route, &mut self.state, &input, dt as f64);
        }
        if let Some(audio) = &self.audio {
            audio.update(
                self.state.speed as f32,
                input.throttle as f32,
                self.paused || blocked,
            );
        }
        self.autosave += dt;
        if self.autosave >= 10. || self.state.next_stop != before {
            self.save();
            self.autosave = 0.;
        }
    }
    fn render_state(&self) -> &DriveState {
        #[cfg(feature = "usb-debug")]
        if let Some(pose) = &self.inspection {
            return pose;
        }
        &self.state
    }
    pub fn render_position(&self) -> [f32; 3] {
        let s = self.render_state();
        [s.x as f32, s.y as f32, s.z as f32]
    }
    pub fn render_speed(&self) -> f32 {
        self.render_state().speed as f32
    }
    pub fn view(&self) -> View {
        let s = self.render_state();
        let dir = Vec3::new(-(s.yaw.sin() as f32), 0., -(s.yaw.cos() as f32));
        let car = Vec3::new(s.x as f32, s.y as f32, s.z as f32);
        if self.cockpit {
            let orientation = Quat::from_rotation_y(s.yaw as f32)
                * Quat::from_rotation_x(route_pitch(&self.route, s.s) as f32);
            let pos = car + Vec3::Y * 0.05 + orientation * Vec3::new(0.32, 1.4, -0.25);
            View {
                pos,
                target: pos + orientation * Vec3::NEG_Z * 30.,
                fov_y: 56.,
            }
        } else {
            View {
                pos: car + Vec3::Y * 3. - dir * 6.6,
                target: car + Vec3::Y * 1.25 + dir * 9.,
                fov_y: 56.,
            }
        }
    }
    pub fn pose(&self, scene: &mut Scene) {
        let s = self.render_state();
        let orientation = Quat::from_rotation_y(s.yaw as f32)
            * Quat::from_rotation_x(route_pitch(&self.route, s.s) as f32);
        let target = Mat4::from_rotation_translation(
            orientation,
            Vec3::new(s.x as f32, s.y as f32 + 0.05, s.z as f32),
        );
        let steer = s.steer as f32;
        let angle = -steer * 0.48 / (1. + s.speed.abs() as f32 * 0.035);
        // Reduce in f64 before conversion: long journeys keep smooth tyre rotation on the Vita.
        let spin = (-s.odometer / 0.285).rem_euclid(std::f64::consts::TAU) as f32;
        for n in &self.vehicle {
            if n.index == self.node as usize {
                scene.node_world[n.index] = target;
                continue;
            }
            let rotation = match n.motion {
                Articulation::Rigid => n.rotation,
                Articulation::FrontWheel => Quat::from_rotation_y(angle),
                Articulation::WheelSpin => Quat::from_rotation_x(spin),
                Articulation::Steering => n.rotation * Quat::from_rotation_z(-steer * 2.4),
            };
            let local = Mat4::from_scale_rotation_translation(n.scale, rotation, n.translation);
            scene.node_world[n.index] = n
                .parent
                .map_or(local, |p| scene.node_world[p as usize] * local);
        }
    }
    pub fn status(&self) -> Value {
        let value = json!({"state":self.state,"paused":self.paused,"cockpit":self.cockpit,"saveError":self.error});
        #[cfg(feature = "usb-debug")]
        {
            let mut value = value;
            value["inspection"] = self
                .inspection
                .as_ref()
                .map_or(Value::Null, |p| json!({"s":p.s,"speed":p.speed}));
            value
        }
        #[cfg(not(feature = "usb-debug"))]
        value
    }
    pub unsafe fn draw(&self, ui: &Ui, gpu: &mut Gpu, ready: bool, stream_error: Option<&str>) {
        let panel = Style::fill(6., rgb(0x122833, 0.92));
        let cream = rgb(0xe9cb99, 1.);
        let white = rgb(0xeaf1f5, 1.);
        let muted = rgb(0xb5c7d2, 1.);
        ui.text_shadow(gpu, 28., 35., white, T::Strong, "NORTHBOUND / HOKKAIDO");
        let stop = self.route.stops.get(self.state.next_stop);
        if self.paused || self.state.completed {
            ui.rect(gpu, 58., 83., 420., 376., &panel);
            ui.text(
                gpu,
                86.,
                127.,
                cream,
                T::Label,
                "POCKET ATLAS / WINTER DELIVERY",
            );
            ui.text(
                gpu,
                86.,
                180.,
                white,
                T::Brand,
                if self.state.completed {
                    "JOURNEY COMPLETE"
                } else {
                    "NORTHBOUND"
                },
            );
            ui.text(
                gpu,
                86.,
                220.,
                muted,
                T::Body,
                "Furano - Nakafurano - Kamifurano - Biei",
            );
            ui.text(
                gpu,
                86.,
                257.,
                muted,
                T::Caption,
                "Keep left. Stop at each parcel marker.",
            );
            ui.text(
                gpu,
                86.,
                285.,
                muted,
                T::Caption,
                "Cross: deliver / refuel. Circle: recovery.",
            );
            ui.text(
                gpu,
                86.,
                313.,
                muted,
                T::Caption,
                "R: accelerate  L: brake  Square: reverse",
            );
            ui.text(
                gpu,
                86.,
                341.,
                muted,
                T::Caption,
                "Left stick: steer  Triangle: cabin / chase",
            );
            ui.text(
                gpu,
                86.,
                389.,
                cream,
                T::Strong,
                if self.state.completed {
                    "Cross: start a new journey"
                } else {
                    "Cross: continue journey"
                },
            );
            ui.text(
                gpu,
                86.,
                425.,
                muted,
                T::Caption,
                "SELECT: settings / return to atlas",
            );
        } else {
            ui.rect(gpu, 24., 64., 315., 100., &panel);
            ui.text(gpu, 42., 88., cream, T::Label, "NEXT DELIVERY / ROUTE 237");
            ui.text(
                gpu,
                42.,
                118.,
                white,
                T::Title,
                stop.map(|p| p.name.split('/').next().unwrap_or(&p.name).trim())
                    .unwrap_or("Biei"),
            );
            let remaining = stop.map_or(0., |p| {
                (p.s - self.state.s).max(0.) / self.route.distance_scale / 1000.
            });
            ui.text(
                gpu,
                42.,
                145.,
                muted,
                T::Caption,
                &format!(
                    "{remaining:.1} km   /   Stop {} of {}",
                    (self.state.next_stop + 1).min(self.route.stops.len()),
                    self.route.stops.len()
                ),
            );
            ui.rect(gpu, 24., 416., 335., 92., &panel);
            ui.text(
                gpu,
                42.,
                464.,
                white,
                T::Brand,
                &format!("{:03}", self.state.speed.abs() * 3.6),
            );
            ui.text(
                gpu,
                126.,
                466.,
                cream,
                T::Strong,
                if self.reverse { "km/h  R" } else { "km/h  D" },
            );
            ui.text(
                gpu,
                42.,
                493.,
                muted,
                T::Caption,
                &format!(
                    "Fuel {:.1} L   Condition {:.0}%",
                    self.state.fuel,
                    100. - self.state.damage
                ),
            );
            let near = stop.is_some_and(|p| (p.s - self.state.s).abs() < p.radius);
            let hint = if near && self.state.speed.abs() < 0.5 {
                "Cross: deliver / service"
            } else if near {
                "Slow down and park"
            } else {
                "START: pause    SELECT: settings"
            };
            ui.text_shadow(gpu, 405., 493., white, T::Caption, hint);
            // The route-ahead map shares the simulator's projection and turns with the car.
            ui.rect(gpu, 754., 331., 182., 144., &panel);
            let (sy, cy) = ((self.state.yaw as f32).sin(), (self.state.yaw as f32).cos());
            for offset in (-100..620).step_by(12) {
                let p = sample_route(&self.route, self.state.s + offset as f64);
                let (x, z) = ((p.x - self.state.x) as f32, (p.z - self.state.z) as f32);
                let (rx, rz) = ((cy * x - sy * z) * 0.18, (sy * x + cy * z) * 0.18);
                if rx.abs() < 80. && (-105.0..20.).contains(&rz) {
                    ui.rect(gpu, 843. + rx, 448. + rz, 3., 3., &Style::fill(1., cream));
                }
            }
            ui.rect(gpu, 841., 442., 7., 10., &Style::fill(2., white));
        }
        if !ready {
            ui.rect(gpu, 308., 238., 420., 55., &panel);
            ui.text(
                gpu,
                328.,
                272.,
                cream,
                T::Body,
                stream_error.unwrap_or("Preparing the road ahead..."),
            );
        }
        if let Some(e) = &self.error {
            ui.text(
                gpu,
                25.,
                535.,
                cream,
                T::Caption,
                &e.chars().take(90).collect::<String>(),
            );
        }
    }
}
