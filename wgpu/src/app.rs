//! The shell: the atlas screen, the game's side of the interface channel, and
//! the flow around a place.
//!
//! The interface is the game's own PocketJS app (`ui/`), run as a guest by
//! whatever hosts this shell (a realm of a page; nothing, when a frame is
//! written to a file). The shell keeps the [`State`] the guest is shown and
//! does what its [`Command`]s ask (`ui/app/protocol.ts`): on the atlas screen
//! they place and turn the globe; `enter` opens a place through the renderer
//! of places, when the build has one (`place.rs`).
//!
//! A frame is [`App::step`], the guest's turn when [`App::guest_due`] says one
//! is due (`heard`, the turn, `say` for each line, `turned`), then
//! [`App::draw`]. The guest is turned thirty times a second, as on the
//! handhelds, and rests while nothing changes (`pocket_atlas_interface::Rest`).

use std::cell::RefCell;
use std::fmt::Write;
use std::rc::Rc;

use pocket_atlas_interface::{Command, Interface, Rest, Scene};
use pocket_web_wgpu::gpu::{Gpu, Screen};
use pocket_web_wgpu::overlay::Overlay;
use pocket_web_wgpu::source::Source;
use pocket_web_wgpu::task;

use crate::globe::{Globe, Turn};
use crate::place::{Opening, Place, Renderer};

/// Seconds between two turns of the guest: the handhelds' hosts turn it thirty times a second and tell it
/// so (`__simHz`).
pub const TURN: f32 = 1.0 / 30.0;
/// Turns a second, for the page that starts the guest.
pub const TURNS: u32 = 30;
/// The night behind the globe (`globe_render` in `ipod/src/globe.c`).
const NIGHT: [f32; 3] = [0.012, 0.018, 0.035];
/// A stick this far from its middle or nearer is at rest (`axis` in `psp/src/main.rs`).
const REST: f32 = 0.18;

/// What a page holds of a handheld's controls: its buttons as PocketJS's bits, and its sticks in -1…1,
/// right and up positive.
#[derive(Clone, Copy, Debug, Default)]
pub struct Held {
    pub buttons: u32,
    pub left: [f32; 2],
    pub right: [f32; 2],
}

/// A screen and the frames it asks for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    pub name: &'static str,
    /// Pixels of the scene.
    pub width: u32,
    pub height: u32,
    /// Samples a pixel of the scene is drawn with.
    pub samples: u32,
    /// Frames a second.
    pub hz: u32,
    /// The primary surface in the interface's logical pixels: what the `globe` command's numbers are in.
    pub logical: [u32; 2],
}

/// The screens of the handhelds the atlas runs on. The sizes are each device's presentation of the
/// interface (`ui/pocket.json`, resolved into `plan.json` by `tools/atlas-ui.ts`); a page reads them from
/// the plan and hands them to [`App::reshape`], so these are what a frame written to a file uses.
pub const SHAPES: [Shape; 4] = [
    Shape { name: "psp", width: 480, height: 272, samples: 4, hz: 30, logical: [480, 272] },
    Shape { name: "vita", width: 960, height: 544, samples: 4, hz: 30, logical: [480, 272] },
    Shape { name: "3ds", width: 400, height: 240, samples: 4, hz: 30, logical: [400, 240] },
    Shape { name: "ipod", width: 480, height: 320, samples: 4, hz: 60, logical: [480, 320] },
];

impl Shape {
    pub fn named(name: &str) -> Option<Shape> {
        SHAPES.iter().copied().find(|s| s.name == name)
    }
}

/// What is behind the interface.
enum Visiting {
    Atlas,
    /// A place is being opened: the renderer's answer lands here.
    Loading(Rc<RefCell<Option<Result<Box<dyn Place>, String>>>>),
    Place(Box<dyn Place>),
}

pub struct App {
    pub gpu: Gpu,
    pub screen: Screen,
    pub shape: Shape,
    pub overlay: Overlay,
    globe: Globe,
    /// Where the globe sits and what it faces.
    pub turn: Turn,
    interface: Interface,
    rest: Rest,
    renderer: Option<Renderer>,
    /// The packs a page says it has: a place's id and where its pack is.
    packs: Vec<(String, String)>,
    visiting: Visiting,
    /// The interface holds the pad: the stick is not the globe's.
    held: bool,
    /// The interface shows nothing just now.
    quiet: bool,
    /// What the interface asked to have kept, until the host takes it.
    prefs: Option<String>,
    /// Seconds the guest is owed, and sixtieths of a second since its last turn.
    owed: f32,
    since: f32,
    /// A count of the guest's pictures, for `Rest`.
    pictures: u32,
    last: Option<f64>,
    interval: f32,
    frames: u32,
    turns: u32,
    triangles: u32,
    /// When the visitor entered the place (the kernel's clock, ms), and how long after it the place's
    /// first frame was drawn.
    entered: f64,
    arrival: Option<f32>,
    /// The last thing that went wrong, for the status.
    pub trouble: String,
}

/// The packs a page names, as pairs of a place's id and where its pack is: a flat JSON object of strings, `{"tokyo-konbini":"places/….json"}`.
pub fn packs_of(json: &str) -> Option<Vec<(String, String)>> {
    let mut strings = Vec::new();
    let mut chars = json.trim().strip_prefix('{')?.strip_suffix('}')?.chars();
    // (what stands between two strings: a colon after a key, a comma after a value)
    let mut between = String::new();
    while let Some(c) = chars.next() {
        if c != '"' {
            between.push(c);
            continue;
        }
        let expected = if strings.is_empty() { "" } else if strings.len() % 2 == 1 { ":" } else { "," };
        if between.trim() != expected {
            return None;
        }
        between.clear();
        let mut text = String::new();
        loop {
            match chars.next()? {
                '"' => break,
                '\\' => text.push(chars.next()?),
                c => text.push(c),
            }
        }
        strings.push(text);
    }
    if !between.trim().is_empty() || strings.len() % 2 != 0 {
        return None;
    }
    let mut pairs = Vec::new();
    let mut strings = strings.into_iter();
    while let (Some(id), Some(at)) = (strings.next(), strings.next()) {
        pairs.push((id, at));
    }
    Some(pairs)
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' | '\\' => out.extend(['\\', c]),
            c if c < ' ' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

impl App {
    /// The shell on a screen, with the atlas behind the interface. `renderer`: the build's renderer of
    /// places (`place::RENDERER`), or none.
    pub fn open(gpu: Gpu, screen: Screen, shape: Shape, renderer: Option<Renderer>) -> App {
        let overlay = Overlay::new(&gpu, screen.format);
        let globe = Globe::new(&gpu);
        App {
            gpu,
            screen,
            shape,
            overlay,
            globe,
            turn: Turn::default(),
            interface: Interface::default(),
            rest: Rest::default(),
            renderer,
            packs: Vec::new(),
            visiting: Visiting::Atlas,
            held: false,
            quiet: false,
            prefs: None,
            owed: 0.0,
            since: 0.0,
            pictures: 0,
            last: None,
            interval: 1000.0 / shape.hz as f32,
            frames: 0,
            turns: 0,
            triangles: 0,
            entered: 0.0,
            arrival: None,
            trouble: String::new(),
        }
    }

    /// The globe's surface has been read (`tools/atlas-globe.ts`): rows of RGBA.
    pub fn globe_surface(&mut self, texels: &[u8]) -> Result<(), String> {
        self.globe.surface(&self.gpu, texels)
    }

    /// The packs that are here: a place's id and where its pack is (a file on a server that answers byte
    /// ranges, or the manifest of one cut into pieces). The interface is told of them only when the build
    /// has a renderer of places: without one no place can be opened, whatever packs there are.
    pub fn packs(&mut self, list: Vec<(String, String)>) {
        self.packs = list;
        self.interface.state.installed = if self.renderer.is_some() { self.packs.iter().map(|(place, _)| place.clone()).collect() } else { Vec::new() };
    }

    /// What the interface stored on an earlier visit, handed back to it.
    pub fn prefs_stored(&mut self, text: &str) {
        self.interface.state.prefs = text.into();
    }

    /// What the interface asked to have kept since the last call.
    pub fn prefs_take(&mut self) -> Option<String> {
        self.prefs.take()
    }

    /// Something of the start failed (the globe's surface): the status says what.
    pub fn fail(&mut self, why: &str) {
        self.trouble = why.into();
    }

    // ---- the interface's channel

    /// A guest has opened the channel: it is told the whole state on its next turn. A guest that replaces
    /// another (another device's presentation) opens it again.
    pub fn interface_opened(&mut self) {
        self.interface.open("pocket.overlay");
        self.rest = Rest::default();
        // (the presentation that left may have held the pad or said it shows nothing)
        self.held = false;
        self.quiet = false;
    }

    /// Sixtieths of a second the guest's turn advances its clock by, when a turn is due now; 0 when it is
    /// not: less than a thirtieth of a second has passed since the last, or the guest rests. `buttons`:
    /// PocketJS's bits, as the guest would be handed them; `touching`: a contact is on a surface it draws,
    /// or has just left one.
    pub fn guest_due(&mut self, buttons: u32, touching: bool) -> u32 {
        // (a frame that came a moment early still has its turn: frames and turns keep step at 30 a second)
        if self.owed + 0.004 < TURN {
            return 0;
        }
        self.owed = (self.owed - TURN).max(0.0);
        if !self.rest.due(buttons != 0 || touching, self.interface.pending()) {
            return 0;
        }
        let ticks = (self.since.round() as u32).clamp(2, 60);
        self.since = 0.0;
        self.turns += 1;
        ticks
    }

    /// The line of state the guest has not seen, for its turn.
    pub fn heard(&mut self) -> Option<String> {
        self.interface.poll()
    }

    /// A line the guest sent in its turn.
    pub fn say(&mut self, line: &str) {
        self.interface.receive(line);
    }

    /// The guest's turn has ended: what it asked for is done. `moved`: what it draws on any of its surfaces
    /// differs from the turn before.
    pub fn turned(&mut self, moved: bool) {
        self.pictures = self.pictures.wrapping_add(moved as u32);
        self.rest.drew(&[self.pictures]);
        while let Some(command) = self.interface.next() {
            self.obey(command);
        }
    }

    fn obey(&mut self, command: Command) {
        match command {
            Command::Globe { x, y, r, lat, lon, pin } => self.turn.face(x, y, r, lat, lon, pin),
            Command::Pins(list) => self.turn.pins(&list),
            // (a finger on the globe: only the presentation for a touch panel sends it)
            Command::Spin { dx, dy } => self.turn.drag(dx, dy),
            Command::Enter(place) => self.enter(place),
            Command::Leave => self.leave(),
            Command::Hold(on) => self.held = on,
            Command::Quiet(on) => self.quiet = on,
            Command::Prefs(text) => {
                self.interface.state.prefs = text.clone();
                self.prefs = Some(text);
            }
            // The rest are a place's.
            command => {
                if let Visiting::Place(place) = &mut self.visiting {
                    place.obey(&command);
                }
            }
        }
    }

    // ---- the flow around a place

    fn refuse(&mut self, why: &str) {
        self.visiting = Visiting::Atlas;
        self.interface.state.scene = Scene::Error;
        self.interface.state.message = why.into();
    }

    /// The interface's `enter`: the place is opened beside the frames, and `scene` is `Loading` until the
    /// renderer has answered.
    fn enter(&mut self, place: String) {
        self.leave();
        self.interface.state.place = place.clone();
        let Some(renderer) = self.renderer else { return self.refuse("Places cannot be opened in the browser yet.") };
        let Some((_, at)) = self.packs.iter().find(|(id, _)| *id == place) else { return self.refuse("This place's pack is not here.") };
        self.interface.state.scene = Scene::Loading;
        (self.entered, self.arrival) = (task::now(), None);
        let answer = Rc::new(RefCell::new(None));
        self.visiting = Visiting::Loading(answer.clone());
        let (at, gpu, format, shape) = (at.clone(), self.gpu.clone(), self.screen.format, self.shape);
        task::spawn(async move {
            let opened = match Source::open(&at).await {
                Ok(pack) => (renderer.open)(Opening { place, pack, gpu, format, shape }).await,
                Err(why) => Err(why),
            };
            *answer.borrow_mut() = Some(opened);
        });
    }

    /// Back to the atlas: a place that was open is dropped, and what it held on the GPU with it.
    fn leave(&mut self) {
        self.visiting = Visiting::Atlas;
        let state = &mut self.interface.state;
        state.scene = Scene::Atlas;
        state.place.clear();
        state.message.clear();
        state.shots.clear();
        state.options.clear();
        state.stats.clear();
        (state.shot, state.tour, state.paused) = (0, false, false);
    }

    /// The renderer's answer, when it has come.
    fn arrive(&mut self) {
        let Visiting::Loading(answer) = &self.visiting else { return };
        let Some(opened) = answer.borrow_mut().take() else { return };
        match opened {
            Ok(place) => {
                self.interface.state.shots = place.shots();
                self.interface.state.scene = Scene::Place;
                self.visiting = Visiting::Place(place);
            }
            Err(why) => self.refuse(&why),
        }
    }

    // ---- a frame

    /// The first half of a frame at `now` (milliseconds on a clock that goes forward): the place or the
    /// globe advances by the time since the last frame.
    pub fn step(&mut self, now: f64, held: &Held) {
        let passed = self.last.map(|last| (now - last) as f32);
        self.last = Some(now);
        if let Some(passed) = passed.filter(|p| *p > 0.0) {
            self.interval += (passed - self.interval) * 0.05;
        }
        // (a clock that went back, or a tab that was hidden, is one frame's time)
        let dt = passed.filter(|p| *p > 0.0).map_or(1.0 / self.shape.hz as f32, |p| (p / 1000.0).min(0.1));
        self.owed = (self.owed + dt).min(2.0 * TURN);
        self.since += dt * 60.0;
        self.arrive();
        if let Visiting::Place(place) = &mut self.visiting {
            place.step(dt, held, !self.held);
            let shown = place.shown();
            let state = &mut self.interface.state;
            (state.shot, state.tour, state.paused, state.options, state.stats) = (shown.shot, shown.tour, shown.paused, shown.options, shown.stats);
            return;
        }
        // The stick spins the globe unless a sheet of the interface has the pad; where a spin comes to rest
        // is what the interface's Explore list sorts from.
        let axis = |v: f32| if v.abs() < REST { 0.0 } else { v };
        let (east, north) = (axis(held.left[0]), axis(held.left[1]));
        if !self.held && self.interface.state.scene == Scene::Atlas && (east != 0.0 || north != 0.0) {
            self.turn.spin(east * 60.0 * dt, north * 60.0 * dt);
        }
        if let Some([lat, lon]) = self.turn.update(dt) {
            (self.interface.state.lat, self.interface.state.lon) = (lat, lon);
        }
    }

    /// The second half: the place's passes, or the globe, with the interface's picture over it.
    pub fn draw(&mut self) -> Result<(), String> {
        let frame = self.screen.frame(&self.gpu)?;
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        if let Visiting::Place(place) = &mut self.visiting {
            self.triangles = place.draw(&self.gpu, &mut encoder, &frame)?;
            self.arrival.get_or_insert((task::now() - self.entered) as f32);
        } else {
            let mut pass = frame.pass(&mut encoder, NIGHT);
            let logical = [self.shape.logical[0] as f32, self.shape.logical[1] as f32];
            self.triangles = self.globe.draw(&self.gpu, &mut pass, &self.turn, self.screen.format, self.screen.samples, logical);
        }
        if !self.quiet {
            self.overlay.draw(&mut encoder, &frame);
        }
        self.gpu.queue.submit([encoder.finish()]);
        frame.present();
        self.frames += 1;
        Ok(())
    }

    /// Another screen from the next frame on (another device's). A canvas has the new size already.
    pub fn reshape(&mut self, shape: Shape) {
        if (shape.width, shape.height, shape.samples) != (self.screen.width, self.screen.height, self.screen.samples) {
            self.screen.resize(&self.gpu, shape.width, shape.height, shape.samples);
        }
        self.shape = shape;
        self.interval = 1000.0 / shape.hz as f32;
        if let Visiting::Place(place) = &mut self.visiting {
            place.reshape(&self.gpu, self.screen.format, &shape);
        }
    }

    /// Words a development host sends: `enter=<place>` and `leave`, as the interface would ask. The rest
    /// are the open place's (`Place::control`).
    pub fn control(&mut self, words: &str) {
        let mut rest = Vec::new();
        for word in words.split_whitespace() {
            match word.split_once('=') {
                Some(("enter", place)) => self.enter(place.into()),
                None if word == "leave" => self.leave(),
                _ => rest.push(word),
            }
        }
        if let (Visiting::Place(place), false) = (&mut self.visiting, rest.is_empty()) {
            place.control(&rest.join(" "));
        }
    }

    pub fn scene(&self) -> Scene {
        self.interface.state.scene
    }

    /// The run as a JSON object.
    pub fn status(&self) -> String {
        let state = &self.interface.state;
        let scene = match state.scene {
            Scene::Atlas => "atlas",
            Scene::Loading => "loading",
            Scene::Place => "place",
            Scene::Error => "error",
        };
        let s = &self.shape;
        let mut out = String::with_capacity(768);
        let _ = write!(
            out,
            "{{\"target\":\"wgpu\",\"scene\":\"{scene}\",\"place\":\"{}\",\"message\":\"{}\",\"installed\":{},\"places\":{},\"packs\":{},\"frames\":{},\"fps\":{:.3},\"turns\":{},\"triangles\":{},",
            escaped(&state.place),
            escaped(&state.message),
            state.installed.len(),
            self.renderer.is_some(),
            self.packs.len(),
            self.frames,
            if self.interval > 0.0 { 1000.0 / self.interval } else { 0.0 },
            self.turns,
            self.triangles
        );
        let _ = write!(
            out,
            "\"globe\":{{\"surface\":{},\"at\":[{:.2},{:.2},{:.2}],\"facing\":[{:.3},{:.3}],\"pins\":{},\"lit\":{}}},\"held\":{},\"quiet\":{},",
            self.globe.surface_width().unwrap_or(0),
            self.turn.place[0],
            self.turn.place[1],
            self.turn.place[2],
            self.turn.facing[0],
            self.turn.facing[1],
            self.turn.pin_count(),
            self.turn.lit().map_or(-1, |pin| pin as i32),
            self.held,
            self.quiet
        );
        let _ = write!(
            out,
            "\"shape\":{{\"name\":\"{}\",\"width\":{},\"height\":{},\"samples\":{},\"hz\":{},\"logical\":[{},{}]}},\"adapter\":\"{}\",\"trouble\":\"{}\",",
            s.name,
            s.width,
            s.height,
            s.samples,
            s.hz,
            s.logical[0],
            s.logical[1],
            escaped(&self.gpu.adapter),
            escaped(&self.trouble)
        );
        // The open place: milliseconds from `enter` to its first frame, then what its renderer says of it.
        match &self.visiting {
            Visiting::Place(place) => {
                let _ = write!(out, "\"visit\":{{\"arrival\":{:.1},{}}}}}", self.arrival.unwrap_or(-1.0), place.status());
            }
            _ => out.push_str("\"visit\":null}"),
        }
        out
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::place::{Opened, Shown};
    use pocket_atlas_interface::Setting;
    use pocket_web_wgpu::gpu::Frame;
    use pocket_web_wgpu::wgpu;

    /// A place that draws the night and counts what it is asked: the seam's other side, for the flow.
    struct Stub {
        bytes: u64,
        shot: u32,
        rain: bool,
        drew: Rc<RefCell<u32>>,
    }

    thread_local! {
        static DREW: Rc<RefCell<u32>> = Rc::new(RefCell::new(0));
    }

    impl Place for Stub {
        fn shots(&self) -> Vec<String> {
            vec!["Arrival".into(), "Counter".into()]
        }
        fn obey(&mut self, command: &Command) {
            match command {
                Command::Shot(index) => self.shot = *index as u32,
                Command::Option { key, value } if key == "rain" => self.rain = *value != 0,
                _ => {}
            }
        }
        fn step(&mut self, _dt: f32, _held: &Held, _free: bool) {}
        fn shown(&self) -> Shown {
            Shown { shot: self.shot, tour: true, paused: false, options: vec![Setting::switch("rain", self.rain)], stats: format!("{} bytes", self.bytes) }
        }
        fn reshape(&mut self, _gpu: &Gpu, _format: wgpu::TextureFormat, _shape: &Shape) {}
        fn draw(&mut self, _gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, frame: &Frame) -> Result<u32, String> {
            drop(frame.pass(encoder, [0.0, 0.0, 0.0]));
            *self.drew.borrow_mut() += 1;
            Ok(12)
        }
    }

    fn open(opening: Opening) -> Opened {
        Box::pin(async move {
            if opening.place == "broken" {
                return Err("its pack is cut short".to_string());
            }
            // (the pack is read through the kernel's source: here, all of a small file)
            let bytes = opening.pack.all().await?.len() as u64;
            Ok(Box::new(Stub { bytes, shot: 0, rain: true, drew: DREW.with(|d| d.clone()) }) as Box<dyn Place>)
        })
    }

    fn app(renderer: Option<Renderer>) -> Option<App> {
        let gpu = match task::wait(Gpu::headless()) {
            Ok(gpu) => gpu,
            Err(why) => {
                eprintln!("skipped: {why}");
                return None;
            }
        };
        let shape = Shape::named("psp").unwrap();
        let screen = Screen::texture(&gpu, shape.width, shape.height, shape.samples);
        let mut app = App::open(gpu, screen, shape, renderer);
        app.interface_opened();
        Some(app)
    }

    /// One turn of a guest that says `lines`.
    fn turn(app: &mut App, lines: &[&str]) -> Option<String> {
        app.step(app.last.unwrap_or(0.0) + 1000.0 / 30.0, &Held::default());
        assert!(app.guest_due(1, false) > 0);
        let heard = app.heard();
        for line in lines {
            app.say(line);
        }
        app.turned(true);
        heard
    }

    #[test]
    fn a_page_names_its_packs_as_a_json_object() {
        assert_eq!(packs_of("{}"), Some(vec![]));
        assert_eq!(packs_of(r#" { "tokyo-konbini" : "places/a,b.json", "sf-lombard-street":"https://example.test/p.place" } "#), Some(vec![("tokyo-konbini".into(), "places/a,b.json".into()), ("sf-lombard-street".into(), "https://example.test/p.place".into())]));
        assert_eq!(packs_of(r#"{"a":"say \"here\""}"#), Some(vec![("a".into(), r#"say "here""#.into())]));
        for not in ["", "[]", r#"{"a"}"#, r#"{"a":1}"#, r#"{"a":"b" "c":"d"}"#, r#"{"a":"b",}"#, r#"{"a":"b"#] {
            assert_eq!(packs_of(not), None, "{not}");
        }
    }

    #[test]
    fn without_a_renderer_no_place_is_here_and_none_opens() {
        let Some(mut app) = app(None) else { return };
        app.packs(vec![("tokyo-konbini".into(), "konbini.place".into())]);
        // The interface is told no pack is on this device: it lists every place as closed.
        let first = turn(&mut app, &[r#"{"type":"globe","x":129,"y":128,"r":100,"lat":35.7,"lon":139.7,"pin":2}"#, r#"{"type":"pins","list":"35.710,139.811,4fe3c1;34.118,-118.300,7f8cff;35.700,139.700,ff8040"}"#]).unwrap();
        assert!(first.contains(r#""scene":"atlas""#) && first.contains(r#""installed":[]"#), "{first}");
        assert_eq!((app.turn.place, app.turn.pin_count(), app.turn.lit()), ([129.0, 128.0, 100.0], 3, Some(2)));
        app.draw().unwrap();
        // An `enter` that comes all the same is answered at once, with why, and the way back is `leave`.
        turn(&mut app, &[r#"{"type":"enter","place":"tokyo-konbini"}"#]);
        assert_eq!(app.scene(), Scene::Error);
        let said = turn(&mut app, &[]).unwrap();
        assert!(said.contains(r#""scene":"error""#) && said.contains("Places cannot be opened in the browser yet."), "{said}");
        app.draw().unwrap();
        turn(&mut app, &[r#"{"type":"leave"}"#]);
        assert_eq!(app.scene(), Scene::Atlas);
        assert!(app.status().contains(r#""scene":"atlas""#));
    }

    #[test]
    fn a_renderer_of_places_plugs_into_the_flow() {
        let Some(mut app) = app(Some(Renderer { wants: wgpu::Features::empty(), open })) else { return };
        let pack = std::env::temp_dir().join(format!("atlas-wgpu-{}.place", std::process::id()));
        std::fs::write(&pack, vec![7u8; 4321]).unwrap();
        let at = pack.to_string_lossy().into_owned();
        app.packs(vec![("tokyo-konbini".into(), at.clone()), ("broken".into(), at)]);
        let first = turn(&mut app, &[]).unwrap();
        assert!(first.contains(r#""installed":["tokyo-konbini","broken"]"#), "{first}");

        // enter: loading, then the place with its shots and what it lets the visitor set.
        turn(&mut app, &[r#"{"type":"enter","place":"tokyo-konbini"}"#]);
        let said = turn(&mut app, &[]).unwrap();
        assert!(said.contains(r#""scene":"place""#) && said.contains(r#""shots":["Arrival","Counter"]"#) && said.contains(r#""options":[{"key":"rain","value":1}]"#) && said.contains("4321 bytes"), "{said}");
        // The place draws the frame, and the commands that are a place's reach it.
        let before = DREW.with(|d| *d.borrow());
        app.draw().unwrap();
        assert_eq!(DREW.with(|d| *d.borrow()), before + 1);
        turn(&mut app, &[r#"{"type":"shot","index":1}"#, r#"{"type":"option","key":"rain","value":0}"#, r#"{"type":"hold","on":true}"#]);
        let said = turn(&mut app, &[]).unwrap();
        assert!(said.contains(r#""shot":1"#) && said.contains(r#""options":[{"key":"rain","value":0}]"#), "{said}");
        // Another device's screen while the place is open.
        app.reshape(Shape::named("vita").unwrap());
        app.draw().unwrap();
        // leave: the atlas again, the globe drawn, the place's state gone.
        turn(&mut app, &[r#"{"type":"leave"}"#]);
        let said = turn(&mut app, &[]).unwrap();
        assert!(said.contains(r#""scene":"atlas""#) && said.contains(r#""shots":[]"#) && said.contains(r#""options":[]"#), "{said}");
        app.draw().unwrap();
        assert_eq!(DREW.with(|d| *d.borrow()), before + 2);

        // A place that does not open says why, and one with no pack here is refused.
        turn(&mut app, &[r#"{"type":"enter","place":"broken"}"#]);
        let said = turn(&mut app, &[]).unwrap();
        assert!(said.contains(r#""scene":"error""#) && said.contains("its pack is cut short"), "{said}");
        turn(&mut app, &[r#"{"type":"leave"}"#, r#"{"type":"enter","place":"elsewhere"}"#]);
        assert!(turn(&mut app, &[]).unwrap().contains("This place's pack is not here."));
        std::fs::remove_file(&pack).unwrap();
    }

    #[test]
    fn the_guest_is_turned_thirty_times_a_second_and_rests() {
        let Some(mut app) = app(None) else { return };
        // Frames at sixty a second: a turn every other one, two sixtieths each.
        let mut ticks = Vec::new();
        for frame in 0..8 {
            app.step(frame as f64 * 1000.0 / 60.0, &Held::default());
            let due = app.guest_due(1, false);
            if due > 0 {
                app.turned(false);
            }
            ticks.push(due);
        }
        assert_eq!(ticks, [2, 0, 2, 0, 2, 0, 2, 0]);
        // With nothing held and nothing changing it rests, and is looked in on about once a second with the
        // time that passed.
        let mut turns = Vec::new();
        for frame in 8..8 + 240 {
            app.step(frame as f64 * 1000.0 / 60.0, &Held::default());
            let due = app.guest_due(0, false);
            if due > 0 {
                app.heard();
                app.turned(false);
                turns.push(due);
            }
        }
        // (one still turn was the last of the held button's; then three looks in the 101 turns left of four seconds)
        assert_eq!(turns.len(), pocket_atlas_interface::Rest::STILL as usize - 1 + 3, "{turns:?}");
        assert_eq!(turns.last(), Some(&60));
        // The stick spins the globe, and where it settles reaches the interface.
        let facing = app.turn.facing;
        for frame in 0..30 {
            app.step(5000.0 + frame as f64 * 1000.0 / 60.0, &Held { buttons: 0, left: [1.0, 0.1], right: [0.0, 0.0] });
        }
        assert!(app.turn.facing[1] > facing[1] + 20.0 && app.turn.facing[0] == facing[0]);
        for frame in 30..90 {
            app.step(5000.0 + frame as f64 * 1000.0 / 60.0, &Held::default());
        }
        assert_eq!(app.interface.state.lon, app.turn.facing[1]);
    }
}
