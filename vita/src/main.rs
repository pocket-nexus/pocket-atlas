//! Pocket Atlas on PS Vita: places rendered on the programmable GXM renderer
//! (pocket-vita-gxm).
//!
//! Development loop over the wired debug transport: the pack and shader
//! sources are read from the USB share (`host0:atlas/`), shaders compile on
//! the device and hot-reload when their source changes, `host0:atlas/control.json`
//! steers camera and renderer settings, and status receipts report timings
//! and draw statistics under `engine`.
#![recursion_limit = "256"]

mod atlas;
mod camera;
mod frame;
mod gpu;
mod hostfs;
mod interface;
mod paths;
mod profile;
mod provision;
mod scene;
mod pack_io;
mod settings;
mod shaders;
mod sun_bounds;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use camera::{Mode, Rig, View};
use frame::{Renderer, Weather};
use glam::Vec3;
use gpu::Gpu;
use pocket_atlas_interface::{Command, Scene as Showing};
use pocket_vita_gxm::target::{Fence, Msaa};
use pocketjs_vita::{dev, dev_protocol::Op, devmenu::Action, graphics, input};
use scene::Scene;
use serde_json::{json, Value};
use vita2d_sys as g;

#[no_mangle]
#[used]
pub static sceUserMainThreadStackSize: u32 = 1024 * 1024;

#[no_mangle]
#[used]
pub static _newlib_heap_size_user: u32 = 96 * 1024 * 1024;

/// The first place of a development build without an atlas pack.
const DEFAULT_PLACE: &str = "tokyo-konbini";
/// What the interface asked to have kept (the saved places), in the data folder.
const INTERFACE_FILE: &str = "interface.json";

extern "C" {
    fn scePowerSetArmClockFrequency(freq: i32) -> i32;
    fn scePowerSetBusClockFrequency(freq: i32) -> i32;
    fn scePowerSetGpuClockFrequency(freq: i32) -> i32;
    fn scePowerSetGpuXbarClockFrequency(freq: i32) -> i32;
    fn scePowerGetArmClockFrequency() -> i32;
    fn scePowerGetBusClockFrequency() -> i32;
    fn scePowerGetGpuClockFrequency() -> i32;
    fn scePowerGetGpuXbarClockFrequency() -> i32;
    fn sceDisplayGetVcount() -> i32;
    fn sceDisplayWaitVblankStartMulti(vcount: u32) -> i32;
}

/// ARM, bus, GPU and GPU crossbar clocks (MHz) the frame budgets assume.
const CLOCKS: [i32; 4] = [444, 222, 222, 166];

/// Sets the clocks; returns the four results.
unsafe fn set_clocks() -> [i32; 4] {
    [
        scePowerSetArmClockFrequency(CLOCKS[0]),
        scePowerSetBusClockFrequency(CLOCKS[1]),
        scePowerSetGpuClockFrequency(CLOCKS[2]),
        scePowerSetGpuXbarClockFrequency(CLOCKS[3]),
    ]
}

unsafe fn clocks_now() -> [i32; 4] {
    [scePowerGetArmClockFrequency(), scePowerGetBusClockFrequency(), scePowerGetGpuClockFrequency(), scePowerGetGpuXbarClockFrequency()]
}

/// A frame of the interface alone, while there is no scene to draw (a place
/// loading, programs compiling, an error): the guest turns, then draws.
unsafe fn interface_frame(ui: &mut interface::Ui, dev: &dev::Host, dt: f32) -> Vec<Command> {
    let pad = input::read();
    let asked = ui.turn(dt, pad.buttons, &pad);
    graphics::begin_frame(0xff0a_0806);
    ui.draw();
    dev.overlay();
    graphics::present();
    asked
}

/// Copies `host0:atlas/outbox/<name>` to the data folder (a
/// packaged build to install from VitaShell) and records the result next to
/// the source as `<name>.done`.
fn fetch(name: &str) {
    let result = (|| -> Result<u64, String> {
        if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
            return Err(format!("refusing file name {name:?}"));
        }
        let _ = std::fs::create_dir_all(paths::DATA);
        let mut src = std::fs::File::open(format!("host0:atlas/outbox/{name}")).map_err(|e| e.to_string())?;
        let to = format!("{}/{name}", paths::DATA);
        let mut dst = std::fs::File::create(&to).map_err(|e| format!("{to}: {e}"))?;
        std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())
    })();
    let text = match result {
        Ok(n) => format!("ok {n} {}/{name}", paths::DATA),
        Err(e) => format!("error {e}"),
    };
    let _ = hostfs::write(&format!("host0:atlas/outbox/{name}.done"), text.as_bytes());
}

/// Remote control: `host0:atlas/control.json`, polled off the render thread.
fn control_watcher() -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    let _ = std::thread::Builder::new().name("atlas-control".into()).stack_size(256 * 1024).spawn(move || {
        // What is there at launch is left over from an earlier run: only
        // changes after it count.
        let mut last = hostfs::read("host0:atlas/control.json", 64 * 1024).unwrap_or_default();
        loop {
            std::thread::sleep(Duration::from_millis(400));
            if let Some(bytes) = hostfs::read("host0:atlas/control.json", 64 * 1024) {
                if bytes != last {
                    last = bytes.clone();
                    if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(name) = v["fetch"].as_str() {
                            fetch(name);
                        }
                        if tx.send(v).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
    rx
}

struct Control {
    frozen: Option<f32>,
    view: Option<View>,
}

fn apply_control(v: &Value, rig: &mut Rig, r: &mut Renderer, ctl: &mut Control, hud: &mut bool) {
    *hud = v["settings"]["hud"].as_bool().unwrap_or(*hud);
    // Naming a profile resets the switches and the governor to the
    // profile's, then the settings below override them.
    if let Some(p) = v["renderProfile"].as_str().and_then(profile::by_name) {
        r.set_profile(p);
        r.timeline.on = false;
    }
    let s = &mut r.settings;
    let flag = |k: &str, cur: bool| v["settings"][k].as_bool().unwrap_or(cur);
    s.reflection = flag("reflection", s.reflection);
    s.haze = flag("haze", s.haze);
    s.bloom = flag("bloom", s.bloom);
    s.rain = flag("rain", s.rain);
    s.cull_cw = flag("cullCw", s.cull_cw);
    if let Some(e) = v["settings"]["exposure"].as_f64() {
        s.exposure = e as f32;
    }
    s.msaa = if flag("msaa", s.msaa == Msaa::X4) { Msaa::X4 } else { Msaa::None };
    s.flat = flag("flat", s.flat);
    if let Some(n) = v["settings"]["scale"].as_u64() {
        s.scale = n.min(frame::SCALES.len() as u64) as u32;
    }
    s.amortize = flag("amortize", s.amortize);
    if let Some(n) = v["settings"]["skip"].as_u64() {
        s.skip = n as u32;
    }
    if let Some(n) = v["settings"]["fx"].as_u64() {
        s.fx = n as u32;
    }
    if let Some(n) = v["settings"]["maxLights"].as_u64() {
        s.max_lights = n.min(4) as usize;
    }
    let int = |k: &str| v["settings"][k].as_u64();
    let num = |k: &str| v["settings"][k].as_f64().map(|x| x as f32);
    if let Some(n) = int("reflSize") {
        s.reflection_size = (n as usize).min(1);
    }
    if let Some(n) = int("hazeSize") {
        s.haze_size = Some((n as usize).min(1));
    }
    if let Some(n) = int("hazeLights") {
        s.haze_lights = Some(n as usize);
    }
    if let Some(n) = int("streaks") {
        s.streaks = n as u32;
    }
    s.bloom_full = v["settings"]["bloomFull"].as_bool().or(s.bloom_full);
    s.steam = flag("steam", s.steam);
    s.detail_maps = flag("detailMaps", s.detail_maps);
    s.vertex_lights = flag("vertexLights", s.vertex_lights);
    s.detail_m = num("detailM").or(s.detail_m);
    s.lod_pixels = num("lodPixels").or(s.lod_pixels);
    s.cull_size = num("cullSize").or(s.cull_size);
    s.field_min = num("fieldMin").or(s.field_min);
    s.field_max = num("fieldMax").or(s.field_max);
    // Pins the governor's quality step; `hold` keeps it there.
    if let Some(n) = v["settings"]["step"].as_u64() {
        r.governor.step = (n as usize).min(r.profile.steps.len() - 1);
        r.governor.boost = 0;
    }
    r.governor.hold = v["settings"]["hold"].as_bool().unwrap_or(r.governor.hold);
    r.timeline.on = v["settings"]["profile"].as_bool().unwrap_or(r.timeline.on);
    ctl.frozen = v["time"].as_f64().map(|t| t as f32);
    ctl.view = v["view"]["pos"].as_array().zip(v["view"]["target"].as_array()).map(|(p, t)| {
        let f = |a: &Vec<Value>, i: usize| a.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
        View { pos: Vec3::new(f(p, 0), f(p, 1), f(p, 2)), target: Vec3::new(f(t, 0), f(t, 1), f(t, 2)), fov_y: v["view"]["fov"].as_f64().unwrap_or(45.0) as f32 }
    });
    if let Some(n) = v["shot"].as_u64() {
        rig.set_shot(n as usize);
    }
}

/// State that lives across the atlas and the places.
struct App {
    gpu: Gpu,
    dev: dev::Host,
    live: bool,
    control: mpsc::Receiver<Value>,
    clocks: [i32; 4],
    clock_resets: u32,
    started: Instant,
    fence: Fence,
    frame_no: u32,
    manifest_state: (u32, usize),
    interface: interface::Ui,
    /// Where the interface last had the globe face (latitude, longitude,
    /// pin lit): a visit frees the globe, and it faces there again after.
    faced: Option<(f32, f32, bool)>,
    /// The player's render settings, kept across places.
    prefs: settings::Prefs,
}

/// Which screen runs next: the atlas, or a place (its id and a control
/// message to apply once it runs).
enum Next {
    Atlas,
    Place(String, Option<Value>),
}

/// What a control message does to the interface: `{"press": ["down",
/// "circle"]}` presses its buttons, `{"interface": false}` leaves it out of
/// the frame (to measure a place without it).
fn press(ui: &mut interface::Ui, v: &Value) {
    use vitasdk_sys::*;
    if let Some(shown) = v["interface"].as_bool() {
        ui.show(shown);
    }
    for name in v["press"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        ui.press(match name {
            "up" => SCE_CTRL_UP,
            "down" => SCE_CTRL_DOWN,
            "left" => SCE_CTRL_LEFT,
            "right" => SCE_CTRL_RIGHT,
            "circle" => SCE_CTRL_CIRCLE,
            "cross" => SCE_CTRL_CROSS,
            "triangle" => SCE_CTRL_TRIANGLE,
            "square" => SCE_CTRL_SQUARE,
            "l" => SCE_CTRL_LTRIGGER,
            "r" => SCE_CTRL_RTRIGGER,
            "start" => SCE_CTRL_START,
            _ => continue,
        });
    }
}

/// The programs this build uses, for packaging (`atlas.ts vpk`): rewritten
/// after a hot reload or when a program is first needed.
fn write_manifest(gpu: &Gpu, live: bool, state: &mut (u32, usize)) {
    let now = (gpu.generation, gpu.programs.len());
    if live && *state != now && gpu.pending() == 0 {
        *state = now;
        let _ = hostfs::write("host0:atlas/gxp/manifest.txt", gpu.manifest().as_bytes());
    }
}

/// The atlas: the globe, with the interface's lists over it, until a place
/// is picked (or a control message names one); then its memory is freed.
unsafe fn run_atlas(app: &mut App) -> Next {
    let ctx = g::vita2d_get_context();
    atlas::Atlas::warm(&mut app.gpu);
    let mut error = String::new();
    let mut loaded = None;
    // Right after a native replacement the previous process's video memory
    // can still be on its way back: an allocation failure is retried.
    for attempt in 0..6 {
        error.clear();
        for path in atlas::pack_paths().iter().map(String::as_str) {
            match atlas::Atlas::load(path) {
                Ok(a) => {
                    loaded = Some(a);
                    break;
                }
                Err(e) if error.is_empty() || !e.contains("No such file") => error = e,
                Err(_) => {}
            }
        }
        if loaded.is_some() || !error.contains("AllocMemBlock") {
            break;
        }
        pocketjs_vita::vita_log(format_args!("atlas: {error} (attempt {attempt})"));
        std::thread::sleep(Duration::from_millis(500));
    }
    let Some(mut atlas) = loaded else {
        // Development builds without an atlas pack go straight to a place.
        pocketjs_vita::vita_log(format_args!("atlas: {error}"));
        return Next::Place(DEFAULT_PLACE.into(), None);
    };
    {
        let state = app.interface.state();
        // The places whose pack is here; looked for once (a miss on the USB
        // share costs a round trip).
        if state.installed.is_empty() {
            state.installed = atlas.meta.places.iter().filter(|p| p.enterable && atlas::place_paths(&p.id).iter().any(|path| std::fs::File::open(path).is_ok())).map(|p| p.id.clone()).collect();
        }
        state.scene = Showing::Atlas;
        state.place.clear();
        state.shots.clear();
        state.options.clear();
        state.stats.clear();
    }
    if let Some((lat, lon, lit)) = app.faced {
        atlas.face(lat, lon, lit);
    }
    let mut last = Instant::now();
    let mut frame_ms = 33.3f32;
    let mut last_vcount = sceDisplayGetVcount();
    let mut was_spun = false;
    let exit = loop {
        let pad = input::read();
        let (buttons, action) = app.dev.menu.input(pad.buttons);
        app.gpu.poll();
        let now = Instant::now();
        let raw = (now - last).as_secs_f32();
        last = now;
        frame_ms = frame_ms * 0.9 + raw * 1000.0 * 0.1;

        // A control message for a place enters it and applies there;
        // `{"atlas": true}` messages stay (probes, and buttons to press).
        let mut go = None;
        while let Ok(v) = app.control.try_recv() {
            press(&mut app.interface, &v);
            if v["atlas"].as_bool() == Some(true) || v["place"].is_null() {
                let pr = &v["probe"];
                let flag = |k: &str| pr[k].as_bool().unwrap_or(false);
                atlas.probe = atlas::Probe { no_ui: flag("ui"), no_globe: flag("globe"), no_bloom: flag("bloom"), no_markers: flag("markers"), no_space: flag("space") };
                if let Some(sz) = pr["scale"].as_array() {
                    let (w, h) = (sz[0].as_u64().unwrap_or(960) as u32, sz[1].as_u64().unwrap_or(544) as u32);
                    let msaa = match pr["msaa"].as_u64() {
                        Some(4) => Msaa::X4,
                        Some(2) => Msaa::X2,
                        _ => Msaa::None,
                    };
                    if let Err(e) = atlas.resize(w, h, msaa) {
                        pocketjs_vita::vita_log(format_args!("atlas: resize {e}"));
                    }
                }
                continue;
            }
            go = Some(Next::Place(v["place"].as_str().unwrap_or(DEFAULT_PLACE).into(), Some(v)));
        }
        // The interface's turn: the globe faces what it has in focus.
        for command in app.interface.turn(raw.min(0.1), buttons, &pad) {
            match command {
                Command::Globe { lat, lon, pin, .. } => {
                    app.faced = Some((lat, lon, pin.is_some()));
                    atlas.face(lat, lon, pin.is_some());
                }
                Command::Enter(id) => go = Some(Next::Place(id, None)),
                Command::Prefs(text) => {
                    crate::paths::write_text(INTERFACE_FILE, &text);
                    app.interface.state().prefs = text;
                }
                _ => {}
            }
        }
        // The stick spins the globe unless a menu has the pad; where a spin
        // comes to rest is what the interface's Explore list sorts from.
        let still = input::Pad { buttons: 0, lx: 128, ly: 128, rx: 128, ry: 128 };
        let spun = atlas.update(raw.min(0.1), if go.is_none() && !app.dev.menu.visible { &pad } else { &still });
        if was_spun && !spun {
            let state = app.interface.state();
            (state.lat, state.lon) = (atlas.lat, atlas.lon);
        }
        was_spun = spun;

        let pending = app.gpu.pending();
        if pending > 0 {
            app.dev.engine = json!({"stage": "compiling", "pending": pending, "errors": app.gpu.errors});
            app.dev.publish(app.frame_no, "atlas");
            graphics::begin_frame(0xff0a_0806);
            app.dev.overlay();
            graphics::present();
            serve(&mut app.dev, app.frame_no, action);
            app.frame_no = app.frame_no.wrapping_add(1);
            if let Some(n) = go {
                break n;
            }
            continue;
        }
        write_manifest(&app.gpu, app.live, &mut app.manifest_state);
        if app.frame_no % 60 == 0 && clocks_now().iter().zip(CLOCKS).any(|(&now, want)| now < want) {
            set_clocks();
            app.clock_resets += 1;
        }

        let t_cpu = Instant::now();
        let render_error = atlas.render(&mut app.gpu).err();
        let cpu_ms = t_cpu.elapsed().as_secs_f32() * 1000.0;
        let t_wait = Instant::now();
        app.fence.wait((app.frame_no.wrapping_sub(1) % 2) as usize);
        let wait_ms = t_wait.elapsed().as_secs_f32() * 1000.0;
        g::vita2d_pool_reset();
        g::vita2d_start_drawing_advanced(core::ptr::null_mut(), 0);
        atlas.present(&mut app.gpu);
        g::sceGxmSetViewport(ctx, 480.0, 480.0, 272.0, -272.0, 0.5, 0.5);
        let t_ui = Instant::now();
        if !atlas.probe.no_ui {
            app.interface.draw();
        }
        let ui_ms = t_ui.elapsed().as_secs_f32() * 1000.0;
        app.dev.overlay();
        g::sceGxmEndScene(ctx, core::ptr::null(), app.fence.signal((app.frame_no % 2) as usize));
        // Paced like the places: every second refresh.
        let since = sceDisplayGetVcount().wrapping_sub(last_vcount);
        if (0..2).contains(&since) {
            sceDisplayWaitVblankStartMulti((2 - since) as u32);
        }
        last_vcount = sceDisplayGetVcount();
        g::vita2d_swap_buffers();

        app.dev.engine = json!({
            "stage": "atlas",
            "installed": app.interface.state().installed,
            "interfaceError": app.interface.error,
            "globe": {"lat": atlas.lat, "lon": atlas.lon},
            "fps": 1000.0 / frame_ms.max(0.1), "frameMs": frame_ms,
            "cpuMs": cpu_ms, "waitMs": wait_ms, "uiMs": ui_ms,
            "size": [atlas.size.0, atlas.size.1], "msaa": format!("{:?}", atlas.msaa),
            "loadMs": atlas.load_ms,
            "errors": app.gpu.errors, "renderError": render_error,
            "clockMhz": clocks_now(), "clockResets": app.clock_resets,
            "uptime": app.started.elapsed().as_secs(),
        });
        app.dev.publish(app.frame_no, "atlas");
        serve(&mut app.dev, app.frame_no, action);
        app.frame_no = app.frame_no.wrapping_add(1);
        if let Some(n) = go {
            break n;
        }
    };
    g::sceGxmFinish(ctx);
    atlas.release();
    exit
}

fn main() {
    unsafe {
        if let Err(error) = graphics::init_with_pool(2 * 1024 * 1024) {
            pocketjs_vita::vita_log(format_args!("atlas: graphics {error}"));
            return;
        }
        let clocks = set_clocks();
        // The system lowers the clocks again after a suspend or a power-mode
        // change; they are checked once a second and set again.
        let dev = dev::Host::new();
        let live = cfg!(feature = "usb-debug");
        let gpu = match Gpu::new(live) {
            Ok(g) => g,
            Err(e) => {
                pocketjs_vita::vita_log(format_args!("atlas: shader patcher {e}"));
                return;
            }
        };
        let mut interface = interface::Ui::boot();
        interface.state().prefs = std::fs::read_to_string(format!("{}/{INTERFACE_FILE}", paths::DATA)).unwrap_or_default();

        // Packaged builds have no USB share to be steered from.
        let control = if live { control_watcher() } else { mpsc::channel().1 };
        let mut app = App {
            gpu,
            dev,
            live,
            control,
            clocks,
            clock_resets: 0,
            started: Instant::now(),
            fence: Fence::new(0, 2),
            frame_no: 0,
            manifest_state: (u32::MAX, 0),
            interface,
            faced: None,
            prefs: settings::Prefs::load(live),
        };
        let mut next = Next::Atlas;
        loop {
            next = match next {
                Next::Atlas => run_atlas(&mut app),
                Next::Place(place, first) => run_place(&mut app, place, first),
            };
        }
    }
}

/// One place: load its pack, render it until the interface or a control
/// message leaves it, then free its memory.
unsafe fn run_place(app: &mut App, id: String, first: Option<Value>) -> Next {
    let id = id.as_str();
    let (live, clocks) = (app.live, app.clocks);
    let mut clock_resets = app.clock_resets;
    let mut gpu = &mut app.gpu;
    let mut dev = &mut app.dev;
    let control = &app.control;
    let fence = &mut app.fence;
    let prefs = &mut app.prefs;
    let ui = &mut app.interface;
    {
        let state = ui.state();
        state.scene = Showing::Loading;
        state.place = id.into();
        state.message.clear();
    }
    // A place that cannot be shown: the interface says why until it is left.
    let failed = |ui: &mut interface::Ui, dev: &mut dev::Host, message: String| -> Next {
        {
            let state = ui.state();
            state.scene = Showing::Error;
            state.message = message.clone();
        }
        // Keep counting frames: the host accepts a native replacement once
        // the new build reports frame > 1, error screen or not.
        let mut frame = 0u32;
        loop {
            dev.engine = json!({"stage": "error", "place": id, "error": message});
            dev.publish(frame, "atlas");
            if interface_frame(ui, dev, 1.0 / 30.0).contains(&Command::Leave) {
                return Next::Atlas;
            }
            let (_, action) = dev.menu.input(input::read().buttons);
            serve(dev, frame, action);
            frame = frame.wrapping_add(1);
        }
    };
    {
            // ---------------------------------------------------------- load
            let mut scene = None;
            let mut load_error = String::new();
            let paths = atlas::place_paths(id);
            for path in paths.iter().map(String::as_str) {
                let mut last = Instant::now();
                let r = Scene::load(path, |_, _, _| {
                    if last.elapsed() > Duration::from_millis(100) {
                        last = Instant::now();
                        interface_frame(ui, dev, 0.1);
                    }
                });
                match r {
                    Ok(s) => {
                        scene = Some((s, path));
                        break;
                    }
                    // A missing pack fails at open; keep the first real error.
                    Err(e) if load_error.is_empty() || !e.contains("No such file") => load_error = e,
                    Err(_) => {}
                }
            }
            let Some((mut scene, pack_path)) = scene else {
                return failed(ui, dev, if load_error.is_empty() { format!("no place pack found ({})", paths[0]) } else { load_error });
            };
            let mut renderer = match Renderer::new(&profile::VITA30, &scene) {
                Ok(r) => r,
                Err(e) => {
                    g::sceGxmFinish(g::vita2d_get_context());
                    core::ptr::read(&scene).release();
                    return failed(ui, dev, format!("renderer: {e}"));
                }
            };
            // The player's settings, then anything a control message names.
            prefs.apply(&mut renderer);
            renderer.warm(&mut gpu, &scene);
            let mut rig = Rig::new(&scene.meta.camera);
            let mut ctl = Control { frozen: None, view: None };
            ui.state().shots = rig.shot_names();

            // ---------------------------------------------------------- run
            let ctx = g::vita2d_get_context();
            let started = app.started;
            let mut last = Instant::now();
            let mut frame_no = app.frame_no;
            let mut clock = 0.0f32;
            let mut frame_ms = 0.0f32;
            let mut last_vcount = sceDisplayGetVcount();
            let mut t_vblank = Instant::now();
            let mut last_gpu: Option<f32> = None;
            let mut gpu_done: Option<Instant> = None;
            let mut wait_ms = 0.0f32;
            let mut swap_ms = 0.0f32;
            let mut manifest_state = app.manifest_state;
            // The interface has the pad (its menu is open); the tour's clock stands still.
            let (mut held, mut paused) = (false, false);
            let mut view = View { pos: Vec3::new(10.0, 3.0, 12.0), target: Vec3::new(2.0, 1.5, -3.0), fov_y: 45.0 };
            let mut compiling_since = Some(Instant::now());
            if let Some(v) = &first {
                apply_control(v, &mut rig, &mut renderer, &mut ctl, &mut prefs.hud);
            }
            let exit = loop {
                let pad = input::read();
                let (buttons, action) = dev.menu.input(pad.buttons);
                gpu.poll();
                let mut switch = None;
                while let Ok(v) = control.try_recv() {
                    press(ui, &v);
                    if v["atlas"].as_bool() == Some(true) {
                        switch = Some(Next::Atlas);
                        continue;
                    }
                    if let Some(p) = v["place"].as_str().filter(|p| *p != id) {
                        switch = Some(Next::Place(p.into(), Some(v.clone())));
                        continue;
                    }
                    apply_control(&v, &mut rig, &mut renderer, &mut ctl, &mut prefs.hud);
                }
                if let Some(n) = switch {
                    break n;
                }

                let now = Instant::now();
                let raw = (now - last).as_secs_f32();
                // Simulation steps stay bounded; the reported frame time does not.
                let dt = raw.min(0.1);
                last = now;
                frame_ms = frame_ms * 0.9 + raw * 1000.0 * 0.1;
                let fps = 1000.0 / frame_ms.max(0.1);

                let pending = gpu.pending();
                if pending > 0 && compiling_since.is_some() {
                    ui.state().message = match &gpu.compiler {
                        None => "Loading the shader compiler".into(),
                        Some(Ok(_)) => format!("Compiling {pending} programs"),
                        Some(Err(e)) => format!("No runtime compiler ({e})"),
                    };
                    dev.engine = json!({"stage": "compiling", "pending": pending, "compiled": gpu.compiled, "compileMs": gpu.compile_ms,
                        "compiler": format!("{:?}", gpu.compiler), "errors": gpu.errors});
                    dev.publish(frame_no, "atlas");
                    interface_frame(ui, dev, dt);
                    serve(&mut dev, frame_no, action);
                    frame_no = frame_no.wrapping_add(1);
                    continue;
                }
                if compiling_since.take().is_some() {
                    let state = ui.state();
                    state.scene = Showing::Place;
                    state.message.clear();
                }
                // The programs this build uses, for packaging (`atlas.ts vpk`):
                // rewritten after a hot reload or when a program is first needed.
                let state = (gpu.generation, gpu.programs.len());
                if live && manifest_state != state && gpu.pending() == 0 {
                    manifest_state = state;
                    let _ = hostfs::write("host0:atlas/gxp/manifest.txt", gpu.manifest().as_bytes());
                }

                // ------------------------------------------------------ update
                // The interface's turn: it is shown where the tour is and what
                // can be set here, and says what the visitor asked for.
                if frame_no % 15 == 0 || ui.state().options.is_empty() {
                    let (w, h) = frame::SCALES[renderer.level()];
                    let state = ui.state();
                    // The renderer gave up a resolution that does not fit.
                    if renderer.settings.scale as usize >= frame::SCALES.len() {
                        prefs.scale = None;
                    }
                    state.options = settings::list(prefs, &renderer);
                    state.stats = if prefs.hud { format!("{fps:.0} fps · {w}×{h} · {}k triangles", renderer.stats.main.tris / 1000) } else { String::new() };
                }
                {
                    let state = ui.state();
                    state.shot = rig.shot_index() as u32;
                    state.tour = rig.mode == Mode::Cinematic;
                    state.paused = paused;
                }
                let mut leave = false;
                for command in ui.turn(dt, buttons, &pad) {
                    match command {
                        Command::Leave => leave = true,
                        Command::Shot(k) => rig.set_shot(k),
                        Command::Tour(true) => rig.set_shot(rig.shot_index()),
                        Command::Tour(false) => rig.release(&view),
                        Command::Pause(on) => paused = on,
                        Command::Hold(on) => held = on,
                        Command::Option { key, value } => {
                            settings::set(prefs, &mut renderer, &key, value as usize);
                            ui.state().options.clear();
                        }
                        _ => {}
                    }
                }
                if leave {
                    break Next::Atlas;
                }
                if !paused {
                    clock += dt;
                }
                let time = ctl.frozen.unwrap_or(clock);
                // Dead zone, then 0..1 over the remaining travel (no step at its edge).
                let axis = |v: u8| {
                    let f = ((v as f32 - 128.0) / 127.0).clamp(-1.0, 1.0);
                    ((f.abs() - 0.18) / 0.82).max(0.0).copysign(f)
                };
                // The left stick walks, the right one looks, and the d-pad
                // rises and sinks, unless a menu has the pad.
                let lift = if buttons & vitasdk_sys::SCE_CTRL_UP != 0 { 1.0 } else if buttons & vitasdk_sys::SCE_CTRL_DOWN != 0 { -1.0 } else { 0.0 };
                let menu_open = dev.menu.visible || held;
                let (l, r) = if menu_open { ((0.0, 0.0), (0.0, 0.0)) } else { ((axis(pad.lx), axis(pad.ly)), (axis(pad.rx), axis(pad.ry))) };
                view = match &ctl.view {
                    Some(v) => View { pos: v.pos, target: v.target, fov_y: v.fov_y },
                    None => rig.update(if paused { 0.0 } else { dt }, time, l, r, if menu_open { 0.0 } else { lift }, &view),
                };
                let weather = Weather::at(time);
                if let Some(d) = &scene.meta.doors {
                    let near = (view.pos - Vec3::from(d.trigger)).length() < d.radius;
                    let goal = if near { 1.0 } else { 0.0 };
                    scene.door_open += (goal - scene.door_open) * (1.0 - (-dt * if near { 3.5 } else { 2.2 }).exp());
                }
                scene.update(time);
                if frame_no % 60 == 0 && clocks_now().iter().zip(CLOCKS).any(|(&now, want)| now < want) {
                    set_clocks();
                    clock_resets += 1;
                }

                // ------------------------------------------------------ render
                // Profiling serializes the GPU, and the settings sheet adds its
                // own cost: neither frame time steers the governor.
                if !renderer.timeline.on && !held {
                    renderer.feedback(frame_ms, last_gpu, raw * 1000.0);
                }
                let fade = if ctl.view.is_some() { 0.0 } else { rig.fade };
                let bars = if ctl.view.is_some() { 0.0 } else { rig.bars };
                let render_error = renderer.render(&mut gpu, &scene, &view, time, &weather, fade, bars).err();
                let t_wait = Instant::now();
                fence.wait((frame_no.wrapping_sub(1) % 2) as usize);
                wait_ms = wait_ms * 0.9 + t_wait.elapsed().as_secs_f32() * 1000.0 * 0.1;
                g::vita2d_pool_reset();
                g::vita2d_start_drawing_advanced(core::ptr::null_mut(), 0);
                renderer.present(&mut gpu);
                g::sceGxmSetViewport(ctx, 480.0, 480.0, 272.0, -272.0, 0.5, 0.5);
                ui.draw();
                dev.overlay();
                let t_display = Instant::now();
                g::sceGxmEndScene(ctx, core::ptr::null(), fence.signal((frame_no % 2) as usize));
                if renderer.timeline.on {
                    fence.wait((frame_no % 2) as usize);
                    renderer.timeline.passes.push(("display", t_display.elapsed().as_secs_f32() * 1000.0));
                }
                // Frames are shown every `interval` refreshes (two for a 30 fps
                // profile): a frame that finishes early waits, so frame times stay
                // even instead of alternating between one and two refreshes.
                let interval = (renderer.profile.budget_ms / 16.68).round().max(1.0) as i32;
                let since = sceDisplayGetVcount().wrapping_sub(last_vcount);
                // The frame's GPU time for the governor: its display scene's
                // completion, polled in 0.5 ms steps while the CPU waits for
                // the refresh (stopping 2 ms short of it), from the later of
                // its first scene's kick and the previous frame's completion.
                let slot = (frame_no % 2) as usize;
                let mut done_at = None;
                if interval > 1 && (0..interval).contains(&since) {
                    let deadline = t_vblank + Duration::from_micros((interval as u64) * 16_683 - 2_000);
                    while Instant::now() < deadline {
                        if fence.done(slot) {
                            done_at = Some(Instant::now());
                            break;
                        }
                        vitasdk_sys::sceKernelDelayThread(500);
                    }
                    let since = sceDisplayGetVcount().wrapping_sub(last_vcount);
                    if (0..interval).contains(&since) {
                        sceDisplayWaitVblankStartMulti((interval - since) as u32);
                    }
                }
                let start = match (renderer.timeline.first_kick, gpu_done) {
                    (Some(k), Some(c)) => Some(k.max(c)),
                    (k, _) => k,
                };
                last_gpu = done_at.zip(start).map(|(d, s)| d.saturating_duration_since(s).as_secs_f32() * 1000.0);
                gpu_done = done_at;
                t_vblank = Instant::now();
                last_vcount = sceDisplayGetVcount();
                let t_swap = Instant::now();
                g::vita2d_swap_buffers();
                swap_ms = swap_ms * 0.9 + t_swap.elapsed().as_secs_f32() * 1000.0 * 0.1;

                let st = &renderer.stats;
                let pass = |p: &frame::PassStats| json!({"draws": p.draws, "tris": p.tris, "lod": p.lod, "culled": p.culled, "missing": p.missing, "lights": p.lights, "unbaked": p.unbaked, "movingReceivers": p.moving_receivers, "fields": p.fields, "points": p.points});
                let s = &renderer.settings;
                // Main-pass triangles by material, heaviest first (profiling).
                let mut by: Vec<(usize, u32)> = renderer.stats.by_material.iter().copied().enumerate().filter(|x| x.1 > 0).collect();
                by.sort_by(|a, b| b.1.cmp(&a.1));
                // [material, triangles, draws] of the main pass, heaviest 64.
                let heavy: Vec<Value> = by.iter().take(64).map(|(i, t)| json!([scene.meta.materials[*i].name, t, renderer.stats.draws_by_material.get(*i).copied().unwrap_or(0)])).collect();
                dev.engine = json!({
                    "stage": "running",
                    "place": id,
                    "pack": pack_path,
                    "packSha256": scene.pack_sha256,
                    "shaderSourceSha256": gpu.service.source_sha256.lock().ok().map(|s| s.clone()),
                    "fps": fps, "frameMs": frame_ms, "cpuSubmitMs": st.cpu_submit_us as f32 / 1000.0, "waitMs": wait_ms, "swapMs": swap_ms,
                    "time": time,
                    "reflection": pass(&st.reflection), "main": pass(&st.main), "fxQuads": st.fx_quads,
                    "programs": gpu.programs.len(), "pending": gpu.pending(), "compiled": gpu.compiled, "compileMs": gpu.compile_ms, "shaderGeneration": gpu.generation,
                    "errors": gpu.errors, "renderError": render_error,
                    "compiler": format!("{:?}", gpu.compiler),
                    "patcher": gpu.own.usage(),
                    "memory": {"textures": scene.bytes_tex, "geometry": scene.bytes_geom, "vram": scene.vram.reserved(), "main": scene.main.reserved()},
                    "loadMs": scene.load_ms,
                    "clocks": clocks,
                    "clockMhz": clocks_now(),
                    "clockResets": clock_resets,
                    "interfaceError": ui.error, "interface": ui.shown(), "held": held, "paused": paused,
                    "view": {"pos": view.pos.to_array(), "target": view.target.to_array(), "fov": view.fov_y, "mode": if rig.mode == Mode::Cinematic { "cinematic" } else { "free" }, "shot": rig.shot_name()},
                    "settings": {"msaa": s.msaa == Msaa::X4, "reflection": s.reflection, "haze": s.haze, "bloom": s.bloom, "rain": s.rain, "cullCw": s.cull_cw, "exposure": s.exposure, "maxLights": s.max_lights, "flat": s.flat, "scale": s.scale, "level": renderer.level(), "profile": renderer.profile.name, "step": renderer.governor.step, "boost": renderer.governor.boost, "gpuMs": renderer.governor.gpu_ms, "steps": renderer.profile.steps.len(), "hold": renderer.governor.hold, "budgetMs": renderer.profile.budget_ms, "fx": s.fx, "amortize": s.amortize, "reflSize": s.reflection_size, "hazeSize": renderer.step().haze_size, "hazeLights": renderer.step().haze_lights, "bloomFull": renderer.step().bloom_full, "streaks": s.streaks, "steam": s.steam, "detailMaps": s.detail_maps, "vertexLights": s.vertex_lights, "detailM": renderer.step().detail_m, "lodPixels": renderer.step().lod_pixels},
                    "uptime": started.elapsed().as_secs(),
                    "profiling": renderer.timeline.on,
                    "passes": renderer.timeline.passes.iter().map(|(n, ms)| json!([n, ms])).collect::<Vec<_>>(),
                    "cpuPasses": renderer.timeline.cpu.iter().map(|(n, rec, end)| json!([n, rec, end])).collect::<Vec<_>>(),
                    "heavy": heavy,
                });
                dev.publish(frame_no, "atlas");
                serve(&mut dev, frame_no, action);
                frame_no = frame_no.wrapping_add(1);
            };
            // Leave: the GPU finishes this place's frames before its memory goes.
            g::sceGxmFinish(ctx);
            renderer.release();
            scene.release();
            prefs.save();
            app.frame_no = frame_no;
            app.manifest_state = manifest_state;
            app.clock_resets = clock_resets;
            exit
    }
}

/// Answers wired-debug requests at a frame boundary.
unsafe fn serve(dev: &mut dev::Host, frame: u32, action: Action) {
    let mut request = dev.poll();
    let op = request.as_ref().map(|r| r.command.op).or(match action {
        Action::Capture => Some(Op::Capture),
        _ => None,
    });
    match op {
        Some(Op::Status) => request.take().unwrap().finish(Ok(dev.status(frame, "atlas"))),
        Some(Op::Menu) => {
            dev.menu.visible = !dev.menu.visible;
            request.take().unwrap().finish(Ok(json!({"menu": dev.menu.visible})));
        }
        Some(Op::Capture) => {
            if let Some(request) = request.take() {
                let _ = request.reply.try_send(dev.capture(frame));
            } else {
                dev.capture_from_menu(frame);
            }
        }
        Some(Op::Native) => {
            let request = request.take().unwrap();
            g::vita2d_wait_rendering_done();
            let result = dev::exec_native(request.native_path.as_ref().unwrap());
            request.finish(result.map(|_| json!({})));
        }
        Some(Op::Push | Op::Reload | Op::Reset) => {
            if let Some(request) = request.take() {
                request.finish(Err("Pocket Atlas has no JS guest; use native".into()));
            }
        }
        None => {}
    }
}
