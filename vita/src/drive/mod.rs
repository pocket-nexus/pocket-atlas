//! Routes: a road driven end to end. The route's kit is loaded as a place
//! (materials, sky, light, the car) and the place renderer draws it; this
//! module streams the road's cells into that scene's draw list, runs the
//! car and the trip (`pocket3d-drive`, the port of the web reference) and
//! draws the driving display.
//!
//! The world is tens of kilometres across, more than single-precision
//! positions resolve at the scale of a car: everything handed to the
//! renderer is relative to a render origin near the camera, moved in whole
//! kilometres when the camera has gone far from it.

mod audio;
mod hud;
pub mod pack;
mod stream;

use glam::{EulerRot, Quat, Vec3};
use pocket3d_drive::{autopilot, drive_sound, next_stop, sound::QUIET, Car, Chase, Controls, DriveSound, DriveView, Spec, Stop, Traffic, Trip, TripEvent, TripPhase, TRAFFIC_CARS};
use pocketjs_vita::input::Pad;
use serde_json::{json, Value};
use vitasdk_sys as sdk;

use crate::camera::View;
use crate::frame::Renderer;
use crate::gpu::Gpu;
use crate::paths;
use crate::scene::Scene;
use crate::ui::Ui;
use pack::RoutePack;
use stream::Streamer;

/// Where the car keeps to: the left lane's middle, metres right of the centre line.
const LANE: f64 = -1.65;
/// The render origin moves when the camera is this far from it (m), to a multiple of its grid.
const REBASE: f64 = 2048.0;
const ORIGIN_GRID: f64 = 1024.0;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The car is driven and the driving camera follows it.
    Drive,
    /// The camera rig (named views, free flight) looks around; the car waits.
    Look,
}

pub enum Outcome {
    None,
    /// Back to the atlas.
    Leave,
}

struct Nodes {
    root: Option<usize>,
    wheels: [Option<usize>; 4],
    /// The other vehicles' nodes (`traffic-0` …).
    traffic: [Option<usize>; TRAFFIC_CARS],
}

pub struct Drive {
    pub pack: RoutePack,
    stream: Streamer,
    id: String,
    spec: Spec,
    stops: Vec<Stop>,
    car: Car,
    trip: Trip,
    chase: Chase,
    cam: DriveView,
    pub mode: Mode,
    /// Autopilot speed (m/s): measurements and captures.
    auto: Option<f64>,
    controls: Controls,
    origin: [f64; 3],
    nodes: Nodes,
    brake_material: Option<usize>,
    /// The kit's own draws at the head of the scene's list.
    kit_draws: usize,
    paused: bool,
    notice: Option<(String, String, f32)>,
    eye: [f64; 3],
    target: [f64; 3],
    fov: f32,
    prev_eye: Option<[f64; 3]>,
    /// Wanted cells not ready yet.
    missing: usize,
    events: Vec<TripEvent>,
    /// Seconds since the trip's phase last changed (cards fade in).
    phase_time: f32,
    saved: usize,
    audio: Option<audio::Audio>,
    sound: DriveSound,
    traffic: Traffic,
}

fn spec_of(c: &pocket3d_place::route::CarSpec) -> Spec {
    Spec {
        mass: c.mass as f64,
        inertia: c.inertia as f64,
        wheelbase: c.wheelbase as f64,
        front: c.front as f64,
        rear: c.rear as f64,
        half_width: c.half_width as f64,
        wheel_radius: c.wheel_radius as f64,
        power: c.power as f64,
        force: c.force as f64,
        brake: c.brake as f64,
        engine_brake: c.engine_brake as f64,
        rolling: c.rolling as f64,
        drag: c.drag as f64,
        stiffness_front: c.stiffness_front as f64,
        stiffness_rear: c.stiffness_rear as f64,
        lock: c.lock as f64,
        steer_rate: c.steer_rate as f64,
        steer_speed: c.steer_speed as f64,
        top: c.top as f64,
        reverse: c.reverse as f64,
    }
}

/// Loads a route: its pack's table and its kit as a scene.
///
/// # Safety
/// GXM initialised; render thread.
pub unsafe fn load(id: &str, mut progress: impl FnMut(&str)) -> Result<(Scene, Drive, String), String> {
    pack::sync(id, |done| progress(&format!("copying the route from the computer: {} MiB", done >> 20)))?;
    let mut error = format!("no route pack for {id}");
    for path in pack::paths(id) {
        let pack = match RoutePack::open(&path) {
            Ok(p) => p,
            Err(e) => {
                if !e.contains("No such file") {
                    error = e;
                }
                continue;
            }
        };
        let scene = Scene::load_at(&path, pack.kit_at, |done, total, what| progress(&format!("kit {done}/{total}  {what}")))?;
        let drive = Drive::new(id, pack, &scene)?;
        return Ok((scene, drive, path));
    }
    Err(error)
}

impl Drive {
    fn new(id: &str, pack: RoutePack, scene: &Scene) -> Result<Self, String> {
        let stops: Vec<Stop> = pack.meta.stops.iter().map(|s| Stop { name: s.name.clone(), native: s.native.clone(), s: s.s as f64 }).collect();
        if stops.len() < 2 {
            return Err("route: fewer than two stops".into());
        }
        let node = |name: &str| scene.meta.nodes.iter().position(|n| n.name == name || n.name.rsplit_once('_').is_some_and(|(b, _)| b == name));
        let nodes = Nodes { root: node("car"), wheels: [node("wheel-fl"), node("wheel-fr"), node("wheel-rl"), node("wheel-rr")], traffic: core::array::from_fn(|i| node(&format!("traffic-{i}"))) };
        let brake_material = scene.meta.materials.iter().position(|m| m.name == "car-brake");
        // A trip in progress resumes from the last stop reached.
        let saved = paths::read_json(&format!("route-{id}.json")).and_then(|v| v["reached"].as_u64()).map_or(0, |n| n as usize);
        let reached = if saved + 1 < stops.len() { saved } else { 0 };
        let spec = spec_of(&pack.meta.car);
        let car = Car::start(&pack.line, stops[reached].s.max(12.0), LANE);
        let stream = Streamer::new(&pack)?;
        Ok(Self {
            stream,
            id: id.into(),
            spec,
            car,
            trip: Trip::new(reached),
            chase: Chase::default(),
            cam: DriveView::Chase,
            mode: Mode::Drive,
            auto: None,
            controls: Controls::default(),
            origin: [0.0; 3],
            nodes,
            brake_material,
            kit_draws: 0,
            paused: false,
            notice: None,
            eye: [0.0; 3],
            target: [0.0, 0.0, -1.0],
            fov: 50.0,
            prev_eye: None,
            missing: 0,
            events: Vec::new(),
            phase_time: 0.0,
            saved: reached,
            audio: unsafe { audio::Audio::start() },
            sound: QUIET,
            traffic: Traffic::new(car.s, pack.line.length),
            stops,
            pack,
        })
    }

    /// After the renderer has seen the kit (its swatches name every program the
    /// cells need): the swatches go, the car's draws stay at the head of the list.
    pub fn adopt(&mut self, scene: &mut Scene) {
        scene.draws.retain(|d| d.node.is_some() || d.skin.is_some());
        self.kit_draws = scene.draws.len();
        self.stream.dirty = true;
    }

    /// A control message's `drive` object: `km` places the car, `auto` (km/h, 0 off)
    /// engages the autopilot, `view` picks the camera, `look` hands the camera to the rig.
    pub fn control(&mut self, v: &Value) {
        if let Some(km) = v["km"].as_f64() {
            let s = (km * 1000.0).clamp(12.0, self.pack.line.length - 20.0);
            self.car = Car::start(&self.pack.line, s, LANE);
            self.traffic = Traffic::new(s, self.pack.line.length);
            self.chase.ready = false;
            self.prev_eye = None;
            self.trip.reached = self.stops.iter().rposition(|st| st.s <= s).unwrap_or(0).min(self.stops.len() - 2);
            if self.trip.phase == TripPhase::Arrived {
                self.trip = Trip::new(self.trip.reached);
            }
            self.mode = Mode::Drive;
        }
        if let Some(kmh) = v["auto"].as_f64() {
            self.auto = (kmh > 0.0).then_some(kmh / 3.6);
            self.mode = Mode::Drive;
        }
        match v["view"].as_str() {
            Some("hood") => self.cam = DriveView::Hood,
            Some("chase") => self.cam = DriveView::Chase,
            _ => {}
        }
        if let Some(look) = v["look"].as_bool() {
            self.mode = if look { Mode::Look } else { Mode::Drive };
        }
    }

    fn save(&mut self) {
        if self.saved != self.trip.reached {
            self.saved = self.trip.reached;
            paths::write_json(&format!("route-{}.json", self.id), &json!({"reached": self.trip.reached, "seconds": self.trip.seconds, "metres": self.trip.metres}));
        }
    }

    /// One frame of the drive. `look`: the camera the rig or a control message
    /// holds (absolute), when the car is not what the camera follows. Returns
    /// the view relative to the render origin.
    ///
    /// # Safety
    /// Render thread, outside any scene.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn update(&mut self, dt: f32, pad: &Pad, buttons: u32, pressed: u32, menu_open: bool, scene: &mut Scene, renderer: &mut Renderer, look: Option<&View>) -> (View, Outcome) {
        let mut outcome = Outcome::None;
        let dtf = dt as f64;
        self.phase_time += dt;
        if let Some(n) = &mut self.notice {
            n.2 -= dt;
            if n.2 <= 0.0 {
                self.notice = None;
            }
        }
        let driving = self.mode == Mode::Drive && look.is_none();
        if driving && !menu_open {
            if pressed & sdk::SCE_CTRL_START != 0 {
                self.paused = !self.paused;
            }
            if self.paused {
                if pressed & sdk::SCE_CTRL_CROSS != 0 {
                    self.paused = false;
                } else if pressed & sdk::SCE_CTRL_CIRCLE != 0 {
                    outcome = Outcome::Leave;
                } else if pressed & sdk::SCE_CTRL_SQUARE != 0 {
                    self.car = Car::start(&self.pack.line, self.stops[self.trip.reached].s.max(12.0), LANE);
                    self.traffic = Traffic::new(self.car.s, self.pack.line.length);
                    self.chase.ready = false;
                    self.paused = false;
                }
            } else if pressed & sdk::SCE_CTRL_TRIANGLE != 0 {
                self.cam = if self.cam == DriveView::Chase { DriveView::Hood } else { DriveView::Chase };
            } else if self.trip.phase == TripPhase::Arrived && pressed & sdk::SCE_CTRL_CIRCLE != 0 {
                outcome = Outcome::Leave;
            }
        }
        if driving && !self.paused {
            let input = if let Some(speed) = self.auto {
                autopilot(&self.car, &self.pack.line, &self.spec, speed, LANE)
            } else if menu_open {
                Controls { steer: 0.0, throttle: 0.0, brake: 0.0 }
            } else {
                self.read_pad(dt, pad, buttons)
            };
            let input = if self.trip.phase == TripPhase::Arrived { Controls { steer: input.steer, throttle: 0.0, brake: 1.0 } } else { input };
            let before = self.car.odometer;
            self.car.step(&input, &self.pack.line, dtf, &self.spec);
            if self.traffic.step(&self.car, self.pack.line.length, dtf) {
                // Both stop where they met.
                self.car.vx = 0.0;
                self.car.vy = 0.0;
                self.car.yaw_rate = 0.0;
                self.trip.scrapes += 1;
                self.notice = Some(("Easy: keep to the left lane".into(), String::new(), 4.0));
            }
            self.events.clear();
            let phase = self.trip.phase;
            let mut events = core::mem::take(&mut self.events);
            self.trip.step(&self.car, &self.stops, dtf, self.car.odometer - before, self.car.scrape == 0.0 && self.car.impact > 1.5, &mut events);
            for e in &events {
                if let TripEvent::Stop(i) = e {
                    self.notice = Some((self.stops[*i].name.clone(), self.stops[*i].native.clone(), 6.0));
                }
            }
            if !events.is_empty() {
                self.save();
            }
            if matches!(events.last(), Some(TripEvent::Arrived)) {
                // The next trip starts from the beginning.
                paths::write_json(&format!("route-{}.json", self.id), &json!({"reached": 0, "completed": true, "seconds": self.trip.seconds, "metres": self.trip.metres}));
            }
            self.events = events;
            if phase != self.trip.phase {
                self.phase_time = 0.0;
            }
            if let Some(mi) = self.brake_material {
                scene.emissive_gain[mi] = if input.brake > 0.1 && !self.car.reverse { 4.2 } else { 1.0 };
            }
            self.sound = drive_sound(&self.car, if self.car.reverse { input.brake } else { input.throttle }, &self.sound, dtf);
        }
        if let Some(a) = &self.audio {
            a.update(&self.sound, if driving && !self.paused { 1.0 } else { 0.0 });
        }

        // The camera, absolute.
        let (eye, target, fov) = match look {
            Some(v) => ([v.pos.x as f64, v.pos.y as f64, v.pos.z as f64], [v.target.x as f64, v.target.y as f64, v.target.z as f64], v.fov_y),
            None => {
                let e = self.chase.step(&self.car, self.cam, if self.paused { 0.0 } else { dtf });
                (e.pos, e.target, e.fov as f32)
            }
        };
        self.eye = eye;
        self.target = target;
        self.fov = fov;
        if (eye[0] - self.origin[0]).abs() > REBASE || (eye[2] - self.origin[2]).abs() > REBASE {
            self.origin = [(eye[0] / ORIGIN_GRID).round() * ORIGIN_GRID, 0.0, (eye[2] / ORIGIN_GRID).round() * ORIGIN_GRID];
            self.stream.dirty = true;
            self.prev_eye = None;
        }
        self.missing = self.stream.update(&self.pack, eye[0], eye[2]);
        if self.stream.dirty {
            self.stream.dirty = false;
            scene.draws.truncate(self.kit_draws);
            self.stream.draws(&self.pack, &scene.meta.materials, self.origin, &mut scene.draws);
        }
        // The flakes streak by the camera's own motion.
        renderer.cam_velocity = match self.prev_eye {
            Some(p) if dt > 1e-4 => {
                let v = Vec3::new((eye[0] - p[0]) as f32, (eye[1] - p[1]) as f32, (eye[2] - p[2]) as f32) / dt;
                // A cut is not motion.
                if v.length() > 80.0 { Vec3::ZERO } else { renderer.cam_velocity.lerp(v, 0.25) }
            }
            _ => Vec3::ZERO,
        };
        self.prev_eye = Some(eye);

        // The car's nodes, relative to the origin.
        let c = &self.car;
        if let Some(root) = self.nodes.root {
            let n = &mut scene.meta.nodes[root];
            n.translation = [(c.x - self.origin[0]) as f32, (c.y - self.origin[1]) as f32, (c.z - self.origin[2]) as f32];
            let roll = (c.ay * 0.012).clamp(-0.06, 0.06);
            let dive = (c.ax * 0.008).clamp(-0.04, 0.04);
            n.rotation = Quat::from_euler(EulerRot::YXZ, -c.heading as f32, (c.pitch + dive) as f32, roll as f32).to_array();
        }
        let spin = (c.wheel % core::f64::consts::TAU) as f32;
        for (i, w) in self.nodes.wheels.iter().enumerate() {
            if let Some(w) = *w {
                scene.meta.nodes[w].rotation = Quat::from_euler(EulerRot::YXZ, if i < 2 { -c.steer as f32 } else { 0.0 }, -spin, 0.0).to_array();
            }
        }
        for (i, n) in self.nodes.traffic.iter().enumerate() {
            let Some(n) = *n else { continue };
            let t = &self.traffic.cars[i];
            let node = &mut scene.meta.nodes[n];
            if t.s < 0.0 {
                node.scale = [0.0; 3];
                continue;
            }
            let p = self.pack.line.at(t.s);
            let dir = if t.v < 0.0 { -1.0 } else { 1.0 };
            node.scale = [1.0; 3];
            node.translation = [(p.x - p.tz * t.d - self.origin[0]) as f32, (p.y - 0.02 * t.d.abs() - self.origin[1]) as f32, (p.z + p.tx * t.d - self.origin[2]) as f32];
            node.rotation = Quat::from_euler(EulerRot::YXZ, -((p.tx * dir).atan2(-p.tz * dir)) as f32, (p.grade.atan() * dir) as f32, 0.0).to_array();
        }
        // The bonnet camera sits inside the body.
        let hide = look.is_none() && self.mode == Mode::Drive && self.cam == DriveView::Hood;
        if let Some(root) = self.nodes.root {
            scene.meta.nodes[root].scale = if hide { [0.0; 3] } else { [1.0; 3] };
        }
        let rel = |p: [f64; 3]| Vec3::new((p[0] - self.origin[0]) as f32, (p[1] - self.origin[1]) as f32, (p[2] - self.origin[2]) as f32);
        (View { pos: rel(eye), target: rel(target), fov_y: fov }, outcome)
    }

    /// Pad into controls: the left stick or the D-pad steers, R or × drives,
    /// L or □ brakes (and reverses from rest).
    fn read_pad(&mut self, dt: f32, pad: &Pad, buttons: u32) -> Controls {
        let dt = dt as f64;
        let f = ((pad.lx as f64 - 128.0) / 127.0).clamp(-1.0, 1.0);
        let stick = ((f.abs() - 0.14) / 0.86).max(0.0).powf(1.5).copysign(f);
        let keys: f64 = (if buttons & sdk::SCE_CTRL_RIGHT != 0 { 1.0 } else { 0.0 }) - (if buttons & sdk::SCE_CTRL_LEFT != 0 { 1.0 } else { 0.0 });
        let sign = |v: f64| if v > 0.0 { 1.0 } else if v < 0.0 { -1.0 } else { 0.0 };
        let c = &mut self.controls;
        if stick != 0.0 {
            c.steer = stick;
        } else {
            // The D-pad turns the wheel at a rate that slows with speed and centres faster than it turns.
            let speed = self.car.vx.abs();
            let rate = (if keys == 0.0 || sign(keys) != sign(c.steer) { 3.6 } else { 2.2 }) / (1.0 + speed / 22.0);
            c.steer += (keys - c.steer).clamp(-rate * dt, rate * dt);
        }
        let throttle = if buttons & (sdk::SCE_CTRL_RTRIGGER | sdk::SCE_CTRL_CROSS) != 0 { 1.0 } else { 0.0 };
        let brake = if buttons & (sdk::SCE_CTRL_LTRIGGER | sdk::SCE_CTRL_SQUARE) != 0 { 1.0 } else { 0.0 };
        c.throttle += (throttle - c.throttle).clamp(-6.0 * dt, 3.2 * dt);
        c.brake += (brake - c.brake).clamp(-8.0 * dt, 5.0 * dt);
        *c
    }

    /// Whether the cells around the camera are all in (the first frames wait for them).
    pub fn settled(&self) -> bool {
        self.missing == 0
    }

    /// The camera in the world (the rig takes over from here; status reports it).
    pub fn look(&self) -> View {
        let v = |p: [f64; 3]| Vec3::new(p[0] as f32, p[1] as f32, p[2] as f32);
        View { pos: v(self.eye), target: v(self.target), fov_y: self.fov }
    }

    /// Whether ○ may hand the camera to the rig: not on a card that uses it.
    pub fn can_look(&self) -> bool {
        !self.paused && self.trip.phase != TripPhase::Arrived
    }

    /// The driving display.
    ///
    /// # Safety
    /// Inside the display scene.
    pub unsafe fn draw(&self, ui: &Ui, gpu: &mut Gpu, accent: [f32; 3], look: bool) {
        if self.mode == Mode::Look || look {
            return;
        }
        let (stop, metres) = next_stop(&self.stops, self.car.s);
        let limit = self.pack.meta.limits.iter().rev().find(|l| l.0 as f64 <= self.car.s).map_or(0.0, |l| l.1);
        let minutes = self.pack.meta.departure as f64 + self.trip.seconds / 60.0;
        hud::draw(
            ui,
            gpu,
            &hud::State {
                kmh: (self.car.vx.abs() * 3.6) as f32,
                limit,
                s: self.car.s as f32,
                length: self.pack.line.length as f32,
                stops: &self.stops,
                next: stop,
                metres: metres as f32,
                clock: ((minutes / 60.0) as u32 % 24, minutes as u32 % 60),
                notice: self.notice.as_ref().map(|n| (n.0.as_str(), n.1.as_str(), n.2)),
                trip: &self.trip,
                paused: self.paused,
                phase_time: self.phase_time,
                reverse: self.car.reverse,
                accent,
                loading: self.missing,
            },
        );
    }

    pub fn status(&self) -> Value {
        let st = self.stream.stats();
        json!({
            "km": self.car.s / 1000.0, "offset": self.car.d, "kmh": self.car.vx * 3.6, "slip": self.car.slip,
            "mode": if self.mode == Mode::Drive { "drive" } else { "look" }, "auto": self.auto.map(|v| v * 3.6), "paused": self.paused,
            "trip": {"phase": match self.trip.phase { TripPhase::Ready => "ready", TripPhase::Driving => "driving", TripPhase::Arrived => "arrived" }, "reached": self.trip.reached, "seconds": self.trip.seconds, "metres": self.trip.metres, "scrapes": self.trip.scrapes},
            "cells": {"ready": st.ready, "loading": st.loading, "queued": st.queued, "missing": self.missing, "read": self.stream.loaded, "readBytes": self.stream.bytes, "pool": st.pool_used, "poolReserved": st.pool_reserved},
            "origin": [self.origin[0], self.origin[2]],
            "errors": self.stream.errors,
        })
    }

    /// Frees the cells.
    ///
    /// # Safety
    /// GPU idle with respect to every cell.
    pub unsafe fn release(self) {
        if let Some(a) = self.audio {
            a.stop();
        }
        self.stream.release();
    }
}
