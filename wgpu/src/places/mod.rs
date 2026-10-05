//! The renderer of places: the PS Vita's (`vita/src/frame.rs`, `scene.rs`,
//! `camera.rs` and `vita/shaders`) on wgpu, from the PS Vita's packs.
//!
//! [`RENDERER`] is the value the shell names (`place::RENDERER`). A place is
//! opened in two parts: its table, `META`, geometry and animation are read
//! before the shell is handed the place, and its textures arrive after, a few
//! at a time, each a stand-in of its mean colour until its texels are on the
//! GPU. So the first frame of a place needs about a third of its pack.

pub mod camera;
pub mod frame;
pub mod programs;
pub mod scene;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt::Write;
use std::rc::Rc;

use glam::Vec3;
use pocket3d_place as pc;
use pocket_atlas_interface::{Command, Setting};
use pocket_web_wgpu::gpu::{Frame, Gpu};
use pocket_web_wgpu::source::Source;
use pocket_web_wgpu::{task, wgpu};

use crate::app::{Held, Shape};
use crate::place::{Opened, Opening, Place, Renderer, Shown};
use camera::{Mode, Rig, View};
use frame::Weather;
use scene::{Head, Scene};

/// The renderer of places: BC blocks where the adapter reads them.
pub const RENDERER: Renderer = Renderer { wants: wgpu::Features::TEXTURE_COMPRESSION_BC, open };

/// Textures read at once.
const READERS: usize = 4;
/// PocketJS's button bits (`contracts/spec/spec.ts`, `BTN`).
mod button {
    pub const UP: u32 = 0x0010;
    pub const RIGHT: u32 = 0x0020;
    pub const DOWN: u32 = 0x0040;
    pub const LEFT: u32 = 0x0080;
}
/// Exposure steps, in stops.
const EXPOSURE: [f32; 5] = [-1.0, -0.5, 0.0, 0.5, 1.0];

/// A texture's texels as they arrive: its index, and its bytes or why they did not come.
type Arrivals = Rc<RefCell<VecDeque<(usize, Result<Vec<u8>, String>)>>>;

pub struct Visit {
    gpu: Gpu,
    pub scene: Scene,
    pub renderer: frame::Renderer,
    rig: Rig,
    pub view: View,
    /// Seconds of the place's loop.
    pub clock: f32,
    paused: bool,
    statistics: bool,
    exposure: usize,
    /// The interface's sticks on a touch panel: move across and forward, look across and up.
    drive: [f32; 4],
    /// A view held for a picture: the rig does not move it.
    held: Option<View>,
    two_sticks: bool,
    arrivals: Arrivals,
    /// Textures whose texels have not arrived.
    pub waiting: usize,
    /// Milliseconds between frames, smoothed, for the statistics.
    interval: f32,
    last: f64,
    /// The pack, for what has been read of it; milliseconds from the start of the opening to the place
    /// being handed over, and to its last texture being on the GPU.
    pack: Source,
    born: f64,
    opened: f32,
    completed: Option<f32>,
    pub trouble: String,
}

/// Opens the place of `opening.pack`: everything but its textures' texels, which arrive beside the frames.
pub async fn visit(opening: Opening) -> Result<Visit, String> {
    let Opening { pack, gpu, format, shape, .. } = opening;
    let born = task::now();
    // (a pack of BC blocks is not read at all where the GPU cannot sample them)
    let head = Head::read(&pack).await?;
    let scene = Scene::open(&gpu, &pack, &head).await?;
    let renderer = frame::Renderer::new(&gpu, &scene, format, shape.width, shape.height, shape.samples);
    let rig = Rig::new(&scene.meta.camera);
    let intro = &scene.meta.camera.intro;
    let view = View { pos: Vec3::from(intro.pos), target: Vec3::from(intro.target), fov_y: intro.fov };

    // The textures: what every surface reads first (the environment, the puddle and ripple fields, the
    // beads, the clouds), then the smallest first, so most materials have theirs early.
    let meta = &scene.meta;
    let fx = &meta.effects;
    let first: Vec<usize> = [meta.atmosphere.environment, fx.puddles, fx.ripples, fx.beads, fx.clouds, meta.day_sky.as_ref().and_then(|d| d.clouds)].into_iter().flatten().map(|t| t as usize).collect();
    let mut order: Vec<usize> = (0..meta.textures.len()).filter(|t| !first.contains(t)).collect();
    order.sort_by_key(|&t| meta.textures[t].data.size);
    let mut wanted: VecDeque<(usize, u64, u64)> = VecDeque::new();
    for index in first.into_iter().chain(order) {
        if !wanted.iter().any(|w| w.0 == index) {
            let (offset, size) = head.texels(index)?;
            wanted.push_back((index, offset, size));
        }
    }
    let waiting = wanted.len();
    let arrivals: Arrivals = Default::default();
    let wanted = Rc::new(RefCell::new(wanted));
    for _ in 0..READERS {
        let (wanted, arrivals, pack) = (wanted.clone(), arrivals.clone(), pack.clone());
        task::spawn(async move {
            loop {
                let Some((index, offset, size)) = wanted.borrow_mut().pop_front() else { break };
                let texels = pack.range(offset, size).await;
                arrivals.borrow_mut().push_back((index, texels));
            }
        });
    }
    Ok(Visit { gpu, scene, renderer, rig, view, clock: 0.0, paused: false, statistics: false, exposure: 2, drive: [0.0; 4], held: None, two_sticks: shape.name == "vita", arrivals, waiting, interval: 1000.0 / shape.hz as f32, last: task::now(), pack, born, opened: (task::now() - born) as f32, completed: None, trouble: String::new() })
}

fn open(opening: Opening) -> Opened {
    Box::pin(async move { visit(opening).await.map(|v| Box::new(v) as Box<dyn Place>) })
}

impl Visit {
    /// Texels that have arrived go to the GPU: a few a frame, so a frame stays short.
    fn arrive(&mut self) {
        for _ in 0..2 {
            let Some((index, texels)) = self.arrivals.borrow_mut().pop_front() else { break };
            self.waiting -= 1;
            if self.waiting == 0 {
                self.completed = Some((task::now() - self.born) as f32);
            }
            match texels.and_then(|t| self.scene.arrive(&self.gpu, index, &t)) {
                Ok(()) => self.renderer.arrived(&self.gpu, &self.scene, index),
                Err(why) => {
                    if self.trouble.is_empty() {
                        self.trouble = why;
                    }
                }
            }
        }
    }

    /// Every texture's texels are on the GPU.
    pub fn complete(&self) -> bool {
        self.waiting == 0
    }

    /// Holds the camera on shot `k` at `part` of its length, with the loop at `time` seconds: a picture of
    /// the place that does not depend on when it is taken.
    pub fn hold(&mut self, k: usize, part: f32, time: f32) -> bool {
        self.clock = time;
        self.held = self.rig.hold_shot(k, part);
        self.scene.update(time);
        self.held.is_some()
    }

    fn options(&self) -> Vec<Setting> {
        let s = &self.renderer.settings;
        let mut v = vec![Setting::switch("bloom", s.bloom)];
        if self.renderer.has_haze() {
            v.push(Setting::switch("haze", s.haze));
        }
        if self.renderer.has_reflection() {
            v.push(Setting::switch("reflection", s.reflection));
        }
        if self.renderer.has_rain() {
            v.push(Setting::switch("rain", s.rain));
        }
        v.push(Setting::choice("exposure", self.exposure, &["\u{2212}1 EV", "\u{2212}\u{bd} EV", "0 EV", "+\u{bd} EV", "+1 EV"]));
        v.push(Setting::switch("stats", self.statistics));
        v
    }

    /// The run of the place as JSON members, for the shell's status.
    pub fn status(&self) -> String {
        let (variants, pipelines) = self.renderer.programs.counts();
        let (w, h, samples) = self.renderer.size();
        let st = &self.renderer.stats;
        let (head, read) = (self.scene.read, self.pack.read_so_far());
        let mut out = String::new();
        let _ = write!(
            out,
            "\"shot\":{},\"tour\":{},\"paused\":{},\"time\":{:.3},\"eye\":[{:.3},{:.3},{:.3}],\"size\":[{w},{h},{samples}],\"draws\":{},\"triangles\":{},\"culled\":{},\"mirrorDraws\":{},\"shadowDraws\":{},\"points\":{},\"particles\":{},\"variants\":{variants},\"pipelines\":{pipelines},\"textures\":{},\"waiting\":{},\"textureBytes\":{},\"geometryBytes\":{},\"targetBytes\":{},\"headRead\":[{},{}],\"read\":[{},{}],\"openMs\":{:.1},\"completeMs\":{:.1},\"fps\":{:.2},\"trouble\":\"{}\"",
            self.rig.shot_index(),
            self.rig.mode == Mode::Cinematic,
            self.paused,
            self.clock,
            self.view.pos.x,
            self.view.pos.y,
            self.view.pos.z,
            st.draws,
            st.tris,
            st.culled,
            st.mirror_draws,
            st.shadow_draws,
            st.points,
            st.fx_quads,
            self.scene.textures.len(),
            self.waiting,
            self.scene.bytes_tex,
            self.scene.bytes_geom,
            self.renderer.target_bytes(),
            head.0,
            head.1,
            read.requests,
            read.bytes,
            self.opened,
            self.completed.unwrap_or(-1.0),
            1000.0 / self.interval.max(0.001),
            self.trouble.replace(['"', '\\'], "'")
        );
        out
    }
}

impl Place for Visit {
    fn shots(&self) -> Vec<String> {
        self.rig.shot_names()
    }

    fn obey(&mut self, command: &Command) {
        match command {
            Command::Shot(k) => {
                self.held = None;
                self.rig.set_shot(*k);
            }
            Command::Tour(true) => {
                self.held = None;
                self.rig.set_shot(self.rig.shot_index());
            }
            Command::Tour(false) => self.rig.release(&self.view),
            Command::Pause(on) => self.paused = *on,
            Command::Option { key, value } => {
                let on = *value != 0;
                let s = &mut self.renderer.settings;
                match key.as_str() {
                    "bloom" => s.bloom = on,
                    "haze" => s.haze = on,
                    "reflection" => s.reflection = on,
                    "rain" => s.rain = on,
                    "exposure" => {
                        self.exposure = (*value as usize).min(EXPOSURE.len() - 1);
                        s.exposure = EXPOSURE[self.exposure].exp2();
                    }
                    "stats" => self.statistics = on,
                    _ => {}
                }
            }
            Command::Drive { mx, my, lx, ly } => self.drive = [*mx, *my, *lx, *ly],
            // A finger dragging the view: a quarter of a degree a logical pixel.
            Command::Look { dx, dy } => self.rig.turn(dx * 0.0045, -dy * 0.0045, &self.view),
            _ => {}
        }
    }

    fn step(&mut self, dt: f32, held: &Held, free: bool) {
        let now = task::now();
        let passed = (now - self.last) as f32;
        self.last = now;
        if passed > 0.0 && passed < 500.0 {
            self.interval += (passed - self.interval) * 0.05;
        }
        self.arrive();
        // (a view held for a picture holds the loop's moment too)
        if !self.paused && self.held.is_none() {
            self.clock += dt;
        }
        // Dead zone, then 0..1 over the remaining travel (no step at its edge).
        let axis = |v: f32| ((v.abs() - 0.18) / 0.82).max(0.0).copysign(v);
        let pressed = |bit: u32| if held.buttons & bit != 0 { 1.0 } else { 0.0 };
        let (mut left, mut right, mut lift) = ((0.0, 0.0), (0.0, 0.0), 0.0);
        if free {
            // The left stick walks and the right one looks. With two sticks the d-pad rises and sinks; with
            // one, it looks. (A pad's sticks read down as positive.)
            left = (axis(held.left[0]), -axis(held.left[1]));
            right = (axis(held.right[0]), -axis(held.right[1]));
            let (across, up) = (pressed(button::RIGHT) - pressed(button::LEFT), pressed(button::UP) - pressed(button::DOWN));
            if self.two_sticks {
                lift = up;
            } else {
                right = (right.0 + across, right.1 - up);
            }
            // The interface's sticks on a touch panel.
            let d = self.drive;
            left = (left.0 + d[0], left.1 - d[1]);
            right = ((right.0 + d[2]).clamp(-1.0, 1.0), (right.1 - d[3]).clamp(-1.0, 1.0));
        }
        self.view = match self.held {
            Some(view) => view,
            None => self.rig.update(if self.paused { 0.0 } else { dt }, self.clock, left, right, lift, &self.view),
        };
        if let Some(d) = &self.scene.meta.doors {
            let near = (self.view.pos - Vec3::from(d.trigger)).length() < d.radius;
            let goal = if near { 1.0 } else { 0.0 };
            self.scene.door_open += (goal - self.scene.door_open) * (1.0 - (-dt * if near { 3.5 } else { 2.2 }).exp());
        }
        self.scene.update(self.clock);
    }

    fn shown(&self) -> Shown {
        let st = &self.renderer.stats;
        let stats = if self.statistics { format!("{:.0} fps \u{b7} {} draws \u{b7} {}k triangles", 1000.0 / self.interval.max(0.001), st.draws + st.mirror_draws + st.shadow_draws, (st.tris + 500) / 1000) } else { String::new() };
        Shown { shot: self.rig.shot_index() as u32, tour: self.rig.mode == Mode::Cinematic, paused: self.paused, options: self.options(), stats }
    }

    fn reshape(&mut self, gpu: &Gpu, format: wgpu::TextureFormat, shape: &Shape) {
        self.two_sticks = shape.name == "vita";
        self.renderer.resize(gpu, format, shape.width, shape.height, shape.samples);
    }

    fn draw(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, frame: &Frame) -> Result<u32, String> {
        let weather = Weather::at(self.clock);
        // A held view is a picture: no dip to black, no bars.
        let (fade, bars) = if self.held.is_some() { (0.0, 0.0) } else { (self.rig.fade, self.rig.bars) };
        self.renderer.render(gpu, encoder, &self.scene, &self.view, self.clock, &weather, fade, bars, frame.shown());
        if self.trouble.is_empty() && !self.renderer.trouble.is_empty() {
            self.trouble = self.renderer.trouble.clone();
        }
        Ok(self.renderer.stats.tris)
    }

    fn control(&mut self, words: &str) {
        // `shot=K part=0.5 time=25` holds a view; `shot=off` hands the camera back to the tour.
        let (mut shot, mut part, mut time) = (None, 0.5, self.clock);
        for word in words.split_whitespace() {
            match word.split_once('=') {
                Some(("shot", "off")) => {
                    self.held = None;
                    self.rig.set_shot(self.rig.shot_index());
                }
                Some(("shot", k)) => shot = k.parse::<usize>().ok(),
                Some(("part", v)) => part = v.parse().unwrap_or(part),
                Some(("time", v)) => time = v.parse().unwrap_or(time),
                _ => {}
            }
        }
        if let Some(k) = shot {
            self.hold(k, part, time);
        }
    }

    fn status(&self) -> String {
        Visit::status(self)
    }
}

/// A pack's `META` names the textures' formats: whether this device can sample them is known before the
/// pack's larger sections are read.
pub fn readable(meta: &pc::Meta, gpu: &Gpu) -> bool {
    gpu.features.contains(wgpu::Features::TEXTURE_COMPRESSION_BC) || !meta.textures.iter().any(|t| matches!(t.format, pc::TexFormat::Bc1 | pc::TexFormat::Bc3 | pc::TexFormat::Bc5))
}

/// A place's pack read whole from a source, for a tool that draws one frame.
pub async fn settle(visit: &mut Visit, pack: &Source) -> Result<(), String> {
    let _ = pack;
    while !visit.complete() {
        visit.arrive();
        if !visit.trouble.is_empty() {
            return Err(visit.trouble.clone());
        }
        if visit.arrivals.borrow().is_empty() && !visit.complete() {
            return Err("a texture's texels did not arrive".into());
        }
    }
    Ok(())
}
