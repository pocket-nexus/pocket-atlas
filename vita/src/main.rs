//! Pocket Atlas on PS Vita: places rendered on the programmable GXM renderer
//! (pocket3d-gxm).
//!
//! Development loop over the wired debug transport: the pack and shader
//! sources are read from the USB share (`host0:atlas/`), shaders compile on
//! the device and hot-reload when their source changes, `host0:atlas/control.json`
//! steers camera and renderer settings, and status receipts report timings
//! and draw statistics under `engine`.
#![recursion_limit = "256"]

mod atlas;
mod browser;
mod camera;
mod frame;
mod gpu;
mod hostfs;
mod profile;
mod provision;
mod scene;
mod settings;
mod shaders;
mod ui;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use camera::{Mode, Rig, View};
use frame::{Renderer, Weather};
use glam::Vec3;
use gpu::Gpu;
use pocket3d_gxm::target::{Fence, Msaa};
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

unsafe fn text(font: *mut g::vita2d_pgf, x: i32, y: i32, color: u32, scale: f32, s: &str) {
    let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
    g::vita2d_pgf_draw_text(font, x, y, color, scale, c.as_ptr());
}

unsafe fn loading_frame(font: *mut g::vita2d_pgf, title: &str, lines: &[String], dev: &dev::Host) {
    graphics::begin_frame(0xff0a_0806);
    text(font, 40, 60, 0xffff_ffff, 1.2, title);
    for (i, l) in lines.iter().enumerate() {
        text(font, 40, 110 + i as i32 * 26, 0xffc8_c8c8, 0.9, l);
    }
    dev.overlay();
    graphics::present();
}

/// Copies `host0:atlas/outbox/<name>` to `ux0:data/pocket-atlas/<name>` (a
/// packaged build to install from VitaShell) and records the result next to
/// the source as `<name>.done`.
fn fetch(name: &str) {
    let result = (|| -> Result<u64, String> {
        if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
            return Err(format!("refusing file name {name:?}"));
        }
        let _ = std::fs::create_dir_all("ux0:data/pocket-atlas");
        let mut src = std::fs::File::open(format!("host0:atlas/outbox/{name}")).map_err(|e| e.to_string())?;
        let to = format!("ux0:data/pocket-atlas/{name}");
        let mut dst = std::fs::File::create(&to).map_err(|e| format!("{to}: {e}"))?;
        std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())
    })();
    let text = match result {
        Ok(n) => format!("ok {n} ux0:data/pocket-atlas/{name}"),
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
    // Pins the governor's quality step; `hold` keeps it there.
    if let Some(n) = v["settings"]["step"].as_u64() {
        r.governor.step = (n as usize).min(r.profile.steps.len() - 1);
    }
    r.governor.hold = v["settings"]["hold"].as_bool().unwrap_or(r.governor.hold);
    r.timeline.on = v["settings"]["profile"].as_bool().unwrap_or(r.timeline.on);
    ctl.frozen = v["time"].as_f64().map(|t| t as f32);
    ctl.view = v["view"]["pos"].as_array().zip(v["view"]["target"].as_array()).map(|(p, t)| {
        let f = |a: &Vec<Value>, i: usize| a.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
        View { pos: Vec3::new(f(p, 0), f(p, 1), f(p, 2)), target: Vec3::new(f(t, 0), f(t, 1), f(t, 2)), fov_y: v["view"]["fov"].as_f64().unwrap_or(45.0) as f32 }
    });
    if let Some(n) = v["shot"].as_u64() {
        for _ in 0..n {
            rig.next_shot();
        }
    }
}

/// State that lives across the atlas and the places.
struct App {
    gpu: Gpu,
    dev: dev::Host,
    font: *mut g::vita2d_pgf,
    live: bool,
    control: mpsc::Receiver<Value>,
    clocks: [i32; 4],
    clock_resets: u32,
    started: Instant,
    fence: Fence,
    frame_no: u32,
    prev_buttons: u32,
    manifest_state: (u32, usize),
    ui: ui::Ui,
    /// The atlas browser (lists, saved places, query) and the player's
    /// render settings, kept across screens.
    browser: browser::Browser,
    prefs: settings::Prefs,
    /// Accent of the place being entered (its settings sheet).
    accent: [f32; 3],
}

/// Which screen runs next: the atlas (with a place to select), or a place
/// (id, display name, a control message to apply once it runs).
enum Next {
    Atlas(Option<String>),
    Place(String, String, Option<Value>),
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

/// The atlas: the globe and the place list until a place is picked (or a
/// control message names one), then its memory is freed.
unsafe fn run_atlas(app: &mut App, select: Option<String>) -> Next {
    let ctx = g::vita2d_get_context();
    atlas::Atlas::warm(&mut app.gpu);
    let mut error = String::new();
    let mut loaded = None;
    // Right after a native replacement the previous process's video memory
    // can still be on its way back: an allocation failure is retried.
    for attempt in 0..6 {
        error.clear();
        for &path in atlas::pack_paths() {
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
        return Next::Place(DEFAULT_PLACE.into(), DEFAULT_PLACE.into(), None);
    };
    app.browser.attach(&mut atlas);
    if let Some(id) = &select {
        app.browser.select(&mut atlas, id);
    }
    let mut last = Instant::now();
    let mut frame_ms = 33.3f32;
    let mut last_vcount = sceDisplayGetVcount();
    let mut prev_buttons = u32::MAX;
    let exit = loop {
        let pad = input::read();
        let (buttons, action) = app.dev.menu.input(pad.buttons);
        let pressed = buttons & !prev_buttons;
        prev_buttons = buttons;
        app.gpu.poll();
        let now = Instant::now();
        let raw = (now - last).as_secs_f32();
        last = now;
        frame_ms = frame_ms * 0.9 + raw * 1000.0 * 0.1;

        // A control message for a place enters it (the selected one when it
        // names none) and applies there; `{"atlas": true, "select": id}` stays.
        let mut go = None;
        while let Ok(v) = app.control.try_recv() {
            if v["atlas"].as_bool() == Some(true) {
                if let Some(t) = v["tab"].as_str().and_then(browser::Tab::by_name) {
                    app.browser.set_tab(&mut atlas, t);
                }
                if let Some(q) = v["search"].as_str() {
                    app.browser.search(&mut atlas, q);
                }
                if let Some(id) = v["select"].as_str() {
                    app.browser.select(&mut atlas, id);
                }
                if let Some(id) = v["save"].as_str() {
                    app.browser.toggle_saved(&mut atlas, id);
                }
                if v["keyboard"].as_bool() == Some(true) {
                    app.browser.open_search();
                }
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
            let id = v["place"].as_str().map(String::from).or_else(|| app.browser.focused(&atlas).map(|p| p.id.clone())).unwrap_or_else(|| DEFAULT_PLACE.into());
            go = Some(Next::Place(id, String::new(), Some(v)));
        }
        // The globe turns while a menu or the keyboard is up; the stick only
        // when neither is.
        let input_free = go.is_none() && !app.dev.menu.visible && !app.browser.dialog_running();
        let still = input::Pad { buttons: 0, lx: 128, ly: 128, rx: 128, ry: 128 };
        let spun = atlas.update(raw.min(0.1), if input_free { &pad } else { &still });
        if go.is_none() && !app.dev.menu.visible {
            if let Some(browser::Action::Enter(id)) = app.browser.update(&mut atlas, raw.min(0.1), &pad, pressed, spun) {
                go = Some(Next::Place(id, String::new(), None));
            }
        }
        if let Some(Next::Place(id, name, _)) = &mut go {
            if let Some(p) = atlas.meta.places.iter().find(|p| &p.id == id) {
                *name = format!("{}, {}", p.name, p.locality);
                app.accent = p.accent;
            }
            if name.is_empty() {
                *name = id.clone();
            }
        }

        let pending = app.gpu.pending();
        if pending > 0 {
            let lines = vec![format!("compiling {pending} programs ({} done, {} ms)", app.gpu.compiled, app.gpu.compile_ms)];
            app.dev.engine = json!({"stage": "compiling", "pending": pending, "errors": app.gpu.errors});
            app.dev.publish(app.frame_no, "atlas");
            loading_frame(app.font, "POCKET ATLAS", &lines, &app.dev);
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
        app.ui.begin_frame();
        atlas.present(&mut app.gpu);
        g::sceGxmSetViewport(ctx, 480.0, 480.0, 272.0, -272.0, 0.5, 0.5);
        let t_ui = Instant::now();
        if !atlas.probe.no_ui {
            app.browser.draw(&app.ui, &mut app.gpu, &atlas);
        }
        let ui_ms = t_ui.elapsed().as_secs_f32() * 1000.0;
        if app.prefs.hud {
            text(app.font, 12, 18, 0x90ff_ffff, 0.6, &format!("{:.1} fps  {:.1} ms", 1000.0 / frame_ms.max(0.1), frame_ms));
        }
        if let Some(e) = app.gpu.errors.first().or(render_error.as_ref()) {
            text(app.font, 12, 24, 0xff60_60ff, 0.75, &e.chars().take(110).collect::<String>());
        }
        app.dev.overlay();
        g::sceGxmEndScene(ctx, core::ptr::null(), app.fence.signal((app.frame_no % 2) as usize));
        // Paced like the places: every second refresh.
        let since = sceDisplayGetVcount().wrapping_sub(last_vcount);
        if (0..2).contains(&since) {
            sceDisplayWaitVblankStartMulti((2 - since) as u32);
        }
        last_vcount = sceDisplayGetVcount();
        // The system keyboard draws into the frame about to be shown.
        if app.browser.dialog_running() {
            g::vita2d_common_dialog_update();
        }
        g::vita2d_swap_buffers();

        app.dev.engine = json!({
            "stage": "atlas",
            "selected": app.browser.focused(&atlas).map(|p| p.id.clone()),
            "browser": app.browser.status(&atlas),
            "places": atlas.meta.places.iter().map(|p| json!({"id": p.id, "enterable": p.enterable})).collect::<Vec<_>>(),
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
    app.prev_buttons = prev_buttons;
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
        input::init();
        let dev = dev::Host::new();
        let font = g::vita2d_load_default_pgf();
        let live = cfg!(feature = "usb-debug");
        let mut gpu = match Gpu::new(live) {
            Ok(g) => g,
            Err(e) => {
                pocketjs_vita::vita_log(format_args!("atlas: shader patcher {e}"));
                return;
            }
        };
        let ui = match ui::Ui::new(font) {
            Ok(u) => u,
            Err(e) => {
                pocketjs_vita::vita_log(format_args!("atlas: ui {e}"));
                return;
            }
        };
        ui::Ui::warm(&mut gpu);

        // Packaged builds have no USB share to be steered from.
        let control = if live { control_watcher() } else { mpsc::channel().1 };
        let mut app = App {
            gpu,
            dev,
            font,
            live,
            control,
            clocks,
            clock_resets: 0,
            started: Instant::now(),
            fence: Fence::new(0, 2),
            frame_no: 0,
            prev_buttons: 0,
            manifest_state: (u32::MAX, 0),
            ui,
            browser: browser::Browser::new(),
            prefs: settings::Prefs::load(live),
            accent: [0.4, 0.6, 1.0],
        };
        let mut next = Next::Atlas(None);
        loop {
            next = match next {
                Next::Atlas(select) => run_atlas(&mut app, select),
                Next::Place(id, name, first) => run_place(&mut app, &id, &name, first),
            };
        }
    }
}

/// One place: load its pack, render it until START or a control message
/// leaves it, then free its memory.
unsafe fn run_place(app: &mut App, id: &str, name: &str, first: Option<Value>) -> Next {
    let title = format!("POCKET ATLAS  /  {}", name.to_uppercase());
    let (font, live, clocks) = (app.font, app.live, app.clocks);
    let mut clock_resets = app.clock_resets;
    let mut gpu = &mut app.gpu;
    let mut dev = &mut app.dev;
    let control = &app.control;
    let fence = &mut app.fence;
    let prefs = &mut app.prefs;
    let ui = &app.ui;
    let place_accent = app.accent;
    {
            // ---------------------------------------------------------- load
            let mut scene = None;
            let mut load_error = String::new();
            let paths = atlas::place_paths(id);
            for path in paths.iter().map(String::as_str) {
                let mut last = Instant::now();
                let r = Scene::load(path, |done, total, what| {
                    if last.elapsed() > Duration::from_millis(100) {
                        last = Instant::now();
                        loading_frame(font, &title, &[format!("{path}"), format!("loading {done}/{total}  {what}")], &dev);
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
                let msg = if load_error.is_empty() { format!("no place pack found ({})", paths[0]) } else { load_error };
                // Keep counting frames: the host accepts a native replacement once
                // the new build reports frame > 1, error screen or not.
                let mut frame = 0u32;
                loop {
                    dev.engine = json!({"stage": "error", "place": id, "error": msg});
                    dev.publish(frame, "atlas");
                    loading_frame(font, &title, &[msg.clone(), "Sync the pack with: bun tools/atlas.ts sync".into(), "START: back to the atlas".into()], &dev);
                    let buttons = input::read().buttons;
                    if buttons & vitasdk_sys::SCE_CTRL_START != 0 {
                        return Next::Atlas(Some(id.to_string()));
                    }
                    let (_, action) = dev.menu.input(buttons);
                    serve(&mut dev, frame, action);
                    frame = frame.wrapping_add(1);
                }
            };
            let mut renderer = match Renderer::new(&profile::VITA30, &scene) {
                Ok(r) => r,
                Err(e) => {
                    g::sceGxmFinish(g::vita2d_get_context());
                    core::ptr::read(&scene).release();
                    let mut frame = 0u32;
                    loop {
                        dev.engine = json!({"stage": "error", "place": id, "error": e});
                        dev.publish(frame, "atlas");
                        loading_frame(font, &title, &[format!("renderer: {e}"), "START: back to the atlas".into()], &dev);
                        let buttons = input::read().buttons;
                        if buttons & vitasdk_sys::SCE_CTRL_START != 0 {
                            return Next::Atlas(Some(id.to_string()));
                        }
                        let (_, action) = dev.menu.input(buttons);
                        serve(&mut dev, frame, action);
                        frame = frame.wrapping_add(1);
                    }
                }
            };
            // The player's settings, then anything a control message names.
            prefs.apply(&mut renderer);
            renderer.warm(&mut gpu, &scene);
            let mut sheet = settings::Sheet::new();
            let mut rig = Rig::new(&scene.meta.camera);
            let mut ctl = Control { frozen: None, view: None };

            // ---------------------------------------------------------- run
            let ctx = g::vita2d_get_context();
            let started = app.started;
            let mut last = Instant::now();
            let mut frame_no = app.frame_no;
            let mut clock = 0.0f32;
            let mut frame_ms = 0.0f32;
            let mut last_vcount = sceDisplayGetVcount();
            let mut wait_ms = 0.0f32;
            let mut swap_ms = 0.0f32;
            let mut manifest_state = app.manifest_state;
            // Buttons still held from the atlas (the confirm press) do not count.
            let mut prev_buttons = u32::MAX;
            let mut view = View { pos: Vec3::new(10.0, 3.0, 12.0), target: Vec3::new(2.0, 1.5, -3.0), fov_y: 45.0 };
            let mut compiling_since = Some(Instant::now());
            if let Some(v) = &first {
                apply_control(v, &mut rig, &mut renderer, &mut ctl, &mut prefs.hud);
            }
            let exit = loop {
                let pad = input::read();
                let (buttons, action) = dev.menu.input(pad.buttons);
                let pressed = buttons & !prev_buttons;
                prev_buttons = buttons;
                gpu.poll();
                // START (outside the menu) or a control message leaves the place.
                if pressed & vitasdk_sys::SCE_CTRL_START != 0 && !dev.menu.visible {
                    break Next::Atlas(Some(id.to_string()));
                }
                let mut switch = None;
                while let Ok(v) = control.try_recv() {
                    if v["atlas"].as_bool() == Some(true) {
                        switch = Some(Next::Atlas(Some(id.to_string())));
                        continue;
                    }
                    if let Some(p) = v["place"].as_str().filter(|p| *p != id) {
                        switch = Some(Next::Place(p.to_string(), p.to_string(), Some(v.clone())));
                        continue;
                    }
                    apply_control(&v, &mut rig, &mut renderer, &mut ctl, &mut prefs.hud);
                    if let Some(open) = v["sheet"].as_bool() {
                        sheet.open = open;
                    }
                    if let Some(row) = v["sheetRow"].as_u64() {
                        sheet.focus(row as usize);
                    }
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
                    let mut lines = vec![format!("{pack_path}: {} draws, {} textures in {} ms", scene.draws.len(), scene.textures.len(), scene.load_ms)];
                    lines.push(match &gpu.compiler {
                        None => "shader compiler: loading".into(),
                        Some(Ok(v)) => format!("SceShaccCg {v}: compiling {pending} programs ({} done, {} ms)", gpu.compiled, gpu.compile_ms),
                        Some(Err(e)) => format!("no runtime compiler ({e}); cached programs only"),
                    });
                    for e in gpu.errors.iter().take(8) {
                        lines.push(e.chars().take(90).collect());
                    }
                    dev.engine = json!({"stage": "compiling", "pending": pending, "compiled": gpu.compiled, "compileMs": gpu.compile_ms,
                        "compiler": format!("{:?}", gpu.compiler), "errors": gpu.errors});
                    dev.publish(frame_no, "atlas");
                    loading_frame(font, &title, &lines, &dev);
                    serve(&mut dev, frame_no, action);
                    frame_no = frame_no.wrapping_add(1);
                    continue;
                }
                compiling_since = None;
                // The programs this build uses, for packaging (`atlas.ts vpk`):
                // rewritten after a hot reload or when a program is first needed.
                let state = (gpu.generation, gpu.programs.len());
                if live && manifest_state != state && gpu.pending() == 0 {
                    manifest_state = state;
                    let _ = hostfs::write("host0:atlas/gxp/manifest.txt", gpu.manifest().as_bytes());
                }

                // ------------------------------------------------------ update
                clock += dt;
                let time = ctl.frozen.unwrap_or(clock);
                // SELECT opens the settings sheet; while it is up the pad
                // drives it, not the camera.
                if let settings::Outcome::Leave = sheet.update(dt, pressed, prefs, &mut renderer, &mut rig) {
                    break Next::Atlas(Some(id.to_string()));
                }
                let sheet_open = sheet.open;
                if pressed & vitasdk_sys::SCE_CTRL_TRIANGLE != 0 && !sheet_open {
                    rig.next_shot();
                }
                // Dead zone, then 0..1 over the remaining travel (no step at its edge).
                let axis = |v: u8| {
                    let f = ((v as f32 - 128.0) / 127.0).clamp(-1.0, 1.0);
                    ((f.abs() - 0.18) / 0.82).max(0.0).copysign(f)
                };
                let lift = if buttons & vitasdk_sys::SCE_CTRL_RTRIGGER != 0 { 1.0 } else if buttons & vitasdk_sys::SCE_CTRL_LTRIGGER != 0 { -1.0 } else { 0.0 };
                let menu_open = dev.menu.visible || sheet_open;
                let (l, r) = if menu_open { ((0.0, 0.0), (0.0, 0.0)) } else { ((axis(pad.lx), axis(pad.ly)), (axis(pad.rx), axis(pad.ry))) };
                view = match &ctl.view {
                    Some(v) => View { pos: v.pos, target: v.target, fov_y: v.fov_y },
                    None => rig.update(dt, time, l, r, if menu_open { 0.0 } else { lift }, &view),
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
                if !renderer.timeline.on && !sheet.visible() {
                    let p = renderer.profile;
                    renderer.governor.feedback(p, frame_ms);
                }
                let fade = if ctl.view.is_some() { 0.0 } else { rig.fade };
                let bars = if ctl.view.is_some() { 0.0 } else { rig.bars };
                let render_error = renderer.render(&mut gpu, &scene, &view, time, &weather, fade, bars).err();
                let t_wait = Instant::now();
                fence.wait((frame_no.wrapping_sub(1) % 2) as usize);
                wait_ms = wait_ms * 0.9 + t_wait.elapsed().as_secs_f32() * 1000.0 * 0.1;
                g::vita2d_pool_reset();
                g::vita2d_start_drawing_advanced(core::ptr::null_mut(), 0);
                ui.begin_frame();
                renderer.present(&mut gpu);
                g::sceGxmSetViewport(ctx, 480.0, 480.0, 272.0, -272.0, 0.5, 0.5);
                if prefs.hud {
                    let st = &renderer.stats;
                    let line = format!(
                        "{:.1} fps  {:.1} ms  cpu {:.1} ms  main {} draws {}k tris  refl {} draws  {}",
                        fps,
                        frame_ms,
                        st.cpu_submit_us as f32 / 1000.0,
                        st.main.draws,
                        st.main.tris / 1000,
                        st.reflection.draws,
                        if rig.mode == Mode::Cinematic { rig.shot_name().to_string() } else { "free".into() }
                    );
                    text(font, 12, 530, 0xc0ff_ffff, 0.75, &line);
                    if let Some(e) = gpu.errors.first().or(render_error.as_ref()) {
                        text(font, 12, 24, 0xff60_60ff, 0.75, &e.chars().take(110).collect::<String>());
                    }
                }
                let (w, h) = frame::SCALES[renderer.level()];
                let stats = format!("{fps:.1} fps  {frame_ms:.1} ms  ·  {w}×{h}  ·  step {} of {}", renderer.governor.step + 1, renderer.profile.steps.len());
                sheet.draw(ui, &mut gpu, prefs, &renderer, &rig, name, place_accent, &stats);
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
                if interval > 1 && (0..interval).contains(&since) {
                    sceDisplayWaitVblankStartMulti((interval - since) as u32);
                }
                last_vcount = sceDisplayGetVcount();
                let t_swap = Instant::now();
                g::vita2d_swap_buffers();
                swap_ms = swap_ms * 0.9 + t_swap.elapsed().as_secs_f32() * 1000.0 * 0.1;

                let st = &renderer.stats;
                let pass = |p: &frame::PassStats| json!({"draws": p.draws, "tris": p.tris, "lod": p.lod, "culled": p.culled, "missing": p.missing, "lights": p.lights, "unbaked": p.unbaked});
                let s = &renderer.settings;
                // Main-pass triangles by material, heaviest first (profiling).
                let mut by: Vec<(usize, u32)> = renderer.stats.by_material.iter().copied().enumerate().filter(|x| x.1 > 0).collect();
                by.sort_by(|a, b| b.1.cmp(&a.1));
                let heavy: Vec<Value> = by.iter().take(10).map(|(i, t)| json!([scene.meta.materials[*i].name, t])).collect();
                dev.engine = json!({
                    "stage": "running",
                    "place": id,
                    "pack": pack_path,
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
                    "sheet": sheet.open,
                    "view": {"pos": view.pos.to_array(), "target": view.target.to_array(), "fov": view.fov_y, "mode": if rig.mode == Mode::Cinematic { "cinematic" } else { "free" }, "shot": rig.shot_name()},
                    "settings": {"msaa": s.msaa == Msaa::X4, "reflection": s.reflection, "haze": s.haze, "bloom": s.bloom, "rain": s.rain, "cullCw": s.cull_cw, "exposure": s.exposure, "maxLights": s.max_lights, "flat": s.flat, "scale": s.scale, "level": renderer.level(), "profile": renderer.profile.name, "step": renderer.governor.step, "steps": renderer.profile.steps.len(), "hold": renderer.governor.hold, "budgetMs": renderer.profile.budget_ms, "fx": s.fx, "amortize": s.amortize, "reflSize": s.reflection_size, "hazeSize": renderer.step().haze_size, "hazeLights": renderer.step().haze_lights, "bloomFull": renderer.step().bloom_full, "streaks": s.streaks, "steam": s.steam, "detailMaps": s.detail_maps, "vertexLights": s.vertex_lights, "detailM": renderer.step().detail_m, "lodPixels": renderer.step().lod_pixels},
                    "uptime": started.elapsed().as_secs(),
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
            app.frame_no = frame_no;
            app.manifest_state = manifest_state;
            app.clock_resets = clock_resets;
            app.prev_buttons = prev_buttons;
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
