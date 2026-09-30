//! Pocket City on PS Vita: the Tokyo rain scene on the programmable GXM
//! renderer (pocket3d-gxm).
//!
//! Development loop over the wired debug transport: the pack and shader
//! sources are read from the USB share (`host0:city/`), shaders compile on
//! the device and hot-reload when their source changes, `host0:city/control.json`
//! steers camera and renderer settings, and status receipts report timings
//! and draw statistics under `engine`.

mod camera;
mod frame;
mod gpu;
mod hostfs;
mod provision;
mod scene;
mod shaders;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use camera::{Mode, Rig, View};
use frame::{Renderer, Settings, Weather};
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

/// Development builds read the pack from the USB share first; packaged
/// builds carry it in the VPK.
const PACKS: &[&str] = if cfg!(feature = "usb-debug") {
    &["host0:city/tokyo.pcity", "ux0:data/pocket-city/tokyo.pcity", "app0:tokyo.pcity"]
} else {
    &["app0:tokyo.pcity", "ux0:data/pocket-city/tokyo.pcity"]
};

extern "C" {
    fn scePowerSetArmClockFrequency(freq: i32) -> i32;
    fn scePowerSetBusClockFrequency(freq: i32) -> i32;
    fn scePowerSetGpuClockFrequency(freq: i32) -> i32;
    fn scePowerSetGpuXbarClockFrequency(freq: i32) -> i32;
}

unsafe fn text(font: *mut g::vita2d_pgf, x: i32, y: i32, color: u32, scale: f32, s: &str) {
    let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap();
    g::vita2d_pgf_draw_text(font, x, y, color, scale, c.as_ptr());
}

unsafe fn loading_frame(font: *mut g::vita2d_pgf, lines: &[String], dev: &dev::Host) {
    graphics::begin_frame(0xff0a_0806);
    text(font, 40, 60, 0xffff_ffff, 1.2, "POCKET CITY  /  TOKYO");
    for (i, l) in lines.iter().enumerate() {
        text(font, 40, 110 + i as i32 * 26, 0xffc8_c8c8, 0.9, l);
    }
    dev.overlay();
    graphics::present();
}

/// Remote control: `host0:city/control.json`, polled off the render thread.
fn control_watcher() -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    let _ = std::thread::Builder::new().name("city-control".into()).stack_size(256 * 1024).spawn(move || {
        let mut last = Vec::new();
        loop {
            std::thread::sleep(Duration::from_millis(400));
            if let Some(bytes) = hostfs::read("host0:city/control.json", 64 * 1024) {
                if bytes != last {
                    last = bytes.clone();
                    if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
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

fn apply_control(v: &Value, rig: &mut Rig, r: &mut Renderer, ctl: &mut Control) {
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
    s.reduced = flag("reduced", s.reduced);
    if let Some(n) = v["settings"]["fx"].as_u64() {
        s.fx = n as u32;
    }
    if let Some(n) = v["settings"]["maxLights"].as_u64() {
        s.max_lights = n.min(4) as usize;
    }
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

fn main() {
    unsafe {
        if let Err(error) = graphics::init_with_pool(2 * 1024 * 1024) {
            pocketjs_vita::vita_log(format_args!("city: graphics {error}"));
            return;
        }
        let clocks = [scePowerSetArmClockFrequency(444), scePowerSetBusClockFrequency(222), scePowerSetGpuClockFrequency(222), scePowerSetGpuXbarClockFrequency(166)];
        input::init();
        let mut dev = dev::Host::new();
        let font = g::vita2d_load_default_pgf();
        let live = cfg!(feature = "usb-debug");
        let mut gpu = match Gpu::new(live) {
            Ok(g) => g,
            Err(e) => {
                pocketjs_vita::vita_log(format_args!("city: shader patcher {e}"));
                return;
            }
        };

        // ---------------------------------------------------------- load
        let mut scene = None;
        let mut load_error = String::new();
        for &path in PACKS {
            let mut last = Instant::now();
            let r = Scene::load(path, |done, total, what| {
                if last.elapsed() > Duration::from_millis(100) {
                    last = Instant::now();
                    loading_frame(font, &[format!("{path}"), format!("loading {done}/{total}  {what}")], &dev);
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
            let msg = if load_error.is_empty() { "no city pack found (host0:city/tokyo.pcity)".to_string() } else { load_error };
            // Keep counting frames: the host accepts a native replacement once
            // the new build reports frame > 1, error screen or not.
            let mut frame = 0u32;
            loop {
                dev.engine = json!({"stage": "error", "error": msg});
                dev.publish(frame, "city");
                loading_frame(font, &[msg.clone(), "Sync the pack with: bun tools/city.ts sync".into()], &dev);
                let (_, action) = dev.menu.input(input::read().buttons);
                serve(&mut dev, frame, action);
                frame = frame.wrapping_add(1);
            }
        };
        let mut renderer = match Renderer::new(Settings::default(), &scene) {
            Ok(r) => r,
            Err(e) => {
                let mut frame = 0u32;
                loop {
                    dev.engine = json!({"stage": "error", "error": e});
                    dev.publish(frame, "city");
                    loading_frame(font, &[format!("renderer: {e}")], &dev);
                    let (_, action) = dev.menu.input(input::read().buttons);
                    serve(&mut dev, frame, action);
                    frame = frame.wrapping_add(1);
                }
            }
        };
        renderer.warm(&mut gpu, &scene);
        let mut rig = Rig::new(&scene.meta.camera);
        let control = control_watcher();
        let mut ctl = Control { frozen: None, view: None };

        // ---------------------------------------------------------- run
        let ctx = g::vita2d_get_context();
        let mut fence = Fence::new(0, 2);
        let started = Instant::now();
        let mut last = Instant::now();
        let mut frame_no = 0u32;
        let mut clock = 0.0f32;
        let mut frame_ms = 0.0f32;
        let mut wait_ms = 0.0f32;
        let mut swap_ms = 0.0f32;
        let mut hud = live;
        let mut manifest_generation = u32::MAX;
        let mut prev_buttons = 0u32;
        let mut view = View { pos: Vec3::new(10.0, 3.0, 12.0), target: Vec3::new(2.0, 1.5, -3.0), fov_y: 45.0 };
        let mut compiling_since = Some(Instant::now());
        loop {
            let pad = input::read();
            let (buttons, action) = dev.menu.input(pad.buttons);
            let pressed = buttons & !prev_buttons;
            prev_buttons = buttons;
            gpu.poll();
            while let Ok(v) = control.try_recv() {
                apply_control(&v, &mut rig, &mut renderer, &mut ctl);
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
                dev.publish(frame_no, "city");
                loading_frame(font, &lines, &dev);
                serve(&mut dev, frame_no, action);
                frame_no = frame_no.wrapping_add(1);
                continue;
            }
            compiling_since = None;
            // The programs this build uses, for packaging (`city.ts vpk`).
            if live && manifest_generation != gpu.generation && gpu.pending() == 0 {
                manifest_generation = gpu.generation;
                let _ = hostfs::write("host0:city/gxp/manifest.txt", gpu.manifest().as_bytes());
            }

            // ------------------------------------------------------ update
            clock += dt;
            let time = ctl.frozen.unwrap_or(clock);
            if pressed & vitasdk_sys::SCE_CTRL_SELECT != 0 {
                hud = !hud;
            }
            if pressed & vitasdk_sys::SCE_CTRL_TRIANGLE != 0 {
                rig.next_shot();
            }
            let axis = |v: u8| {
                let f = (v as f32 - 128.0) / 127.0;
                if f.abs() < 0.18 { 0.0 } else { f }
            };
            let lift = if buttons & vitasdk_sys::SCE_CTRL_RTRIGGER != 0 { 1.0 } else if buttons & vitasdk_sys::SCE_CTRL_LTRIGGER != 0 { -1.0 } else { 0.0 };
            let menu_open = dev.menu.visible;
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

            // ------------------------------------------------------ render
            let render_error = renderer.render(&mut gpu, &scene, &view, time, &weather).err();
            let t_wait = Instant::now();
            fence.wait((frame_no.wrapping_sub(1) % 2) as usize);
            wait_ms = wait_ms * 0.9 + t_wait.elapsed().as_secs_f32() * 1000.0 * 0.1;
            g::vita2d_pool_reset();
            g::vita2d_start_drawing_advanced(core::ptr::null_mut(), 0);
            let fade = if ctl.view.is_some() { 0.0 } else { rig.fade };
            let bars = if ctl.view.is_some() { 0.0 } else { rig.bars };
            renderer.composite(&mut gpu, time, fade, bars);
            g::sceGxmSetViewport(ctx, 480.0, 480.0, 272.0, -272.0, 0.5, 0.5);
            if hud {
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
            dev.overlay();
            let t_display = Instant::now();
            g::sceGxmEndScene(ctx, core::ptr::null(), fence.signal((frame_no % 2) as usize));
            if renderer.timeline.on {
                fence.wait((frame_no % 2) as usize);
                renderer.timeline.passes.push(("display", t_display.elapsed().as_secs_f32() * 1000.0));
            }
            let t_swap = Instant::now();
            g::vita2d_swap_buffers();
            swap_ms = swap_ms * 0.9 + t_swap.elapsed().as_secs_f32() * 1000.0 * 0.1;

            let st = &renderer.stats;
            let pass = |p: &frame::PassStats| json!({"draws": p.draws, "tris": p.tris, "culled": p.culled, "missing": p.missing});
            let s = &renderer.settings;
            dev.engine = json!({
                "stage": "running",
                "pack": pack_path,
                "fps": fps, "frameMs": frame_ms, "cpuSubmitMs": st.cpu_submit_us as f32 / 1000.0, "waitMs": wait_ms, "swapMs": swap_ms,
                "time": time,
                "reflection": pass(&st.reflection), "main": pass(&st.main), "fxQuads": st.fx_quads,
                "programs": gpu.programs.len(), "compiled": gpu.compiled, "compileMs": gpu.compile_ms, "shaderGeneration": gpu.generation,
                "errors": gpu.errors, "renderError": render_error,
                "compiler": format!("{:?}", gpu.compiler),
                "patcher": gpu.own.usage(),
                "memory": {"textures": scene.bytes_tex, "geometry": scene.bytes_geom, "vram": scene.vram.reserved(), "main": scene.main.reserved()},
                "loadMs": scene.load_ms,
                "clocks": clocks,
                "view": {"pos": view.pos.to_array(), "target": view.target.to_array(), "fov": view.fov_y, "mode": if rig.mode == Mode::Cinematic { "cinematic" } else { "free" }, "shot": rig.shot_name()},
                "settings": {"msaa": s.msaa == Msaa::X4, "reflection": s.reflection, "haze": s.haze, "bloom": s.bloom, "rain": s.rain, "cullCw": s.cull_cw, "exposure": s.exposure, "maxLights": s.max_lights, "flat": s.flat, "reduced": s.reduced, "fx": s.fx},
                "uptime": started.elapsed().as_secs(),
                "passes": renderer.timeline.passes.iter().map(|(n, ms)| json!([n, ms])).collect::<Vec<_>>(),
            });
            dev.publish(frame_no, "city");
            serve(&mut dev, frame_no, action);
            frame_no = frame_no.wrapping_add(1);
        }
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
        Some(Op::Status) => request.take().unwrap().finish(Ok(dev.status(frame, "city"))),
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
                request.finish(Err("Pocket City has no JS guest; use native".into()));
            }
        }
        None => {}
    }
}
