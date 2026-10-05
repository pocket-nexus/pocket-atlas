//! Pocket Atlas on the PSP: the globe and the places on the GE, and over
//! them the interface, a PocketJS guest (`ui/`) that draws every 2D pixel
//! and says what the buttons mean. One place is in memory at a time, in a
//! buffer that is reserved once and holds the globe's surface meanwhile.
#![no_std]
#![no_main]
extern crate alloc;

mod audio;
mod camera;
mod dev;
mod globe;
mod interface;
mod renderer;
mod scene;

use alloc::{format, string::String, vec::Vec};
use core::ffi::c_void;
use pocket3d_place_psp as pp;
use pocket_atlas_interface::{Command, Scene as Showing, Setting};
use pocketjs_psp::{arena, host};
use psp::sys::*;

psp::module!("PocketAtlas", 1, 0);

/// What the arena keeps beside the pack buffer: the interface (its pak, the
/// UI core, the guest's heap: about 4.7 MiB once booted) and a place's
/// working memory (skinned vertices, the merged index stream).
const RESERVE: usize = 8 * 1024 * 1024;

fn psp_main() {
    psp::enable_home_button();
    // The guest's parser recurses past the main thread's stack.
    unsafe { host::run_on_worker(worker, || run()) }
}
unsafe extern "C" fn worker(_: usize, _: *mut c_void) -> i32 {
    run();
    0
}

/// Beside the executable, or on the PSPLINK share.
unsafe fn open(name: &str, writing: bool) -> SceUid {
    let flags = || if writing { IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC } else { IoOpenFlags::RD_ONLY };
    let local = format!("{name}\0");
    let fd = sceIoOpen(local.as_ptr(), flags(), 0o666);
    if fd.0 >= 0 {
        return fd;
    }
    let host = format!("host0:/{name}\0");
    sceIoOpen(host.as_ptr(), flags(), 0o666)
}
/// Reads `name` into `dest`, whole: its length, or why not.
unsafe fn read_into(name: &str, dest: &mut [u8]) -> Result<usize, &'static str> {
    let fd = open(name, false);
    if fd.0 < 0 {
        return Err("the file is missing");
    }
    let size = sceIoLseek32(fd, 0, IoWhence::End);
    sceIoLseek32(fd, 0, IoWhence::Set);
    if size <= 0 || size as usize > dest.len() {
        sceIoClose(fd);
        return Err("it does not fit in memory here");
    }
    let mut at = 0;
    while at < size as usize {
        let n = sceIoRead(fd, dest[at..].as_mut_ptr() as _, (size as usize - at).min(64 * 1024) as u32);
        if n <= 0 {
            sceIoClose(fd);
            return Err("it could not be read");
        }
        at += n as usize;
    }
    sceIoClose(fd);
    Ok(at)
}
unsafe fn size(name: &str) -> usize {
    let fd = open(name, false);
    if fd.0 < 0 {
        return 0;
    }
    let size = sceIoLseek32(fd, 0, IoWhence::End).max(0) as usize;
    sceIoClose(fd);
    size
}
unsafe fn read(name: &str) -> Option<Vec<u8>> {
    let mut bytes = alloc::vec![0u8; size(name)];
    read_into(name, &mut bytes).ok().map(|_| bytes)
}
unsafe fn write(name: &str, bytes: &[u8]) {
    let fd = open(name, true);
    if fd.0 >= 0 {
        sceIoWrite(fd, bytes.as_ptr() as _, bytes.len());
        sceIoClose(fd);
    }
}
/// The places here whose pack fits the buffer: `<id>.place` beside the
/// executable or on the PSPLINK share.
unsafe fn installed(capacity: usize) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for directory in [".\0", "host0:/\0"] {
        let fd = sceIoDopen(directory.as_ptr());
        if fd.0 < 0 {
            continue;
        }
        let mut entry: SceIoDirent = core::mem::zeroed();
        while sceIoDread(fd, &mut entry) > 0 {
            let length = entry.d_name.iter().position(|&c| c == 0).unwrap_or(0);
            let name = core::str::from_utf8(&entry.d_name[..length]).unwrap_or("");
            if let Some(id) = name.strip_suffix(".place") {
                if entry.d_stat.st_size as usize <= capacity && !ids.iter().any(|i| i == id) {
                    ids.push(id.into());
                }
            }
            entry = core::mem::zeroed();
        }
        sceIoDclose(fd);
    }
    ids
}

struct App {
    ui: interface::Ui,
    dev: dev::Session,
    /// The one pack buffer, for the process's life.
    buffer: &'static mut [u8],
    frame: u32,
    now: u32,
    /// The interface's turns since the last report, in microseconds: all of
    /// them, and the longest.
    turns: (u64, u32),
}
impl App {
    /// The seconds since the last call, bounded.
    unsafe fn tick(&mut self) -> f32 {
        let start = sceKernelGetSystemTimeLow();
        let dt = (start.wrapping_sub(self.now) as f32 / 1e6).min(0.1);
        self.now = start;
        dt
    }
    /// The pad, the interface's turn, and what a control message asks of it.
    unsafe fn turn(&mut self, dt: f32, pad: &SceCtrlData, command: &Option<dev::Command>) -> Vec<Command> {
        for &buttons in command.iter().flat_map(|c| &c.press) {
            self.ui.press(buttons);
        }
        let before = sceKernelGetSystemTimeLow();
        let asked = self.ui.turn(dt, pad.buttons.bits(), (pad.lx as u32) << 8 | pad.ly as u32);
        let spent = sceKernelGetSystemTimeLow().wrapping_sub(before);
        self.turns = (self.turns.0 + spent as u64, self.turns.1.max(spent));
        asked
    }
    /// One vblank wait if work already consumed a refresh, two otherwise.
    /// A control message can have the frame written to the share as it is shown.
    unsafe fn present(&mut self, start: u32, command: &Option<dev::Command>) {
        sceDisplayWaitVblankStart();
        if sceKernelGetSystemTimeLow().wrapping_sub(start) < 25_000 {
            sceDisplayWaitVblankStart();
        }
        // The buffer that becomes the next frame's is the one shown until now.
        let hidden = sceGuSwapBuffers() as usize;
        if command.as_ref().is_some_and(|c| c.capture) {
            self.dev.capture((0x4400_0000 + (hidden ^ renderer::FB)) as *const u8);
        }
        self.frame += 1;
    }
    unsafe fn report(&mut self, status: dev::Status) {
        let stats = arena::stats();
        let (scene, place) = {
            let state = self.ui.state();
            (state.scene, state.place.clone())
        };
        // A report every thirty frames.
        let turns = core::mem::take(&mut self.turns);
        self.dev.report(dev::Status {
            scene: ["atlas", "loading", "place", "error"][scene as usize],
            place: &place,
            interface: self.ui.error,
            memory: [stats.bump_bytes, stats.tail_free_bytes, self.buffer.len()],
            frame: self.frame,
            interface_ms: turns.0 as f32 / 30000.0,
            max_interface_ms: turns.1 as f32 / 1000.0,
            ..status
        });
    }
}
const IDLE: dev::Status = dev::Status {
    scene: "", place: "", interface: "", memory: [0; 3], frame: 0, shot: "", shot_index: 0, time: 0.0, frame_ms: 33.3, work_ms: 0.0,
    gpu_wait_ms: 0.0, max_work_ms: 0.0, interface_ms: 0.0, max_interface_ms: 0.0, draws: 0, triangles: 0, pack_bytes: 0, rain: false, reflection: false, paused: false, free_camera: false,
};
fn axis(v: u8) -> f32 {
    let x = (v as f32 - 128.0) / 127.0;
    if x.abs() < 0.18 {
        0.0
    } else {
        x
    }
}

/// The Pocket3D title card, drawn into video memory before the GE is set up.
/// It leaves the frame buffer as zero bytes.
unsafe fn title() {
    // the uncached mirror of video memory: what is written is what the display reads
    let vram = (sceGeEdramGetAddr() as usize | 0x4000_0000) as *mut u8;
    sceDisplaySetMode(DisplayMode::Lcd, 480, 272);
    let mut surface = pocket3d_title::Surface {
        pixels: core::slice::from_raw_parts_mut(vram, 512 * 272 * 4),
        width: 480,
        height: 272,
        stride: 512,
        layout: pocket3d_title::Layout::Rgba8,
    };
    pocket3d_title::play(&mut surface, |_| {
        sceDisplaySetFrameBuf(vram, 512, DisplayPixelFormat::Psm8888, DisplaySetBufSync::NextFrame);
        sceDisplayWaitVblankStart();
    });
}

unsafe fn run() {
    scePowerSetClockFrequency(333, 333, 166);
    title();
    host::reset_fpu_status();
    renderer::init();
    sceCtrlSetSamplingCycle(0);
    sceCtrlSetSamplingMode(CtrlMode::Analog);
    // The pack buffer first: what the arena has, less what the interface and
    // a place's working memory take. The interface's script is read into it
    // (it is free until a place loads) and its pak into storage of its own
    // size, neither through the allocator's power-of-two classes.
    let capacity = pp::MAX_BYTES.min(arena::stats().tail_free_bytes.saturating_sub(RESERVE)) & !63;
    let storage = arena::alloc_permanent(capacity.max(64), 64);
    if storage.is_null() {
        host::halt("no memory for a place");
    }
    let buffer = core::slice::from_raw_parts_mut(storage, capacity);
    let pak = {
        let length = size("atlas.pak");
        let pak = arena::alloc_permanent(length.max(16), 16);
        (!pak.is_null() && read_into("atlas.pak", core::slice::from_raw_parts_mut(pak, length)).is_ok()).then(|| core::slice::from_raw_parts(pak as *const u8, length))
    };
    let script = read_into("atlas.js", &mut buffer[..capacity - 1]).ok().map(|length| {
        buffer[length] = 0;
        &buffer[..length + 1]
    });
    let ui = interface::Ui::boot(script, pak);
    let mut app = App { ui, dev: dev::Session::connect(), buffer, frame: 0, now: sceKernelGetSystemTimeLow(), turns: (0, 0) };
    {
        let places = installed(capacity);
        let prefs = read("interface.json").and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_default();
        let state = app.ui.state();
        state.installed = places;
        state.prefs = prefs;
    }
    let mut next: Option<String> = None;
    loop {
        let place = match next.take() {
            Some(place) => place,
            None => atlas(&mut app),
        };
        next = visit(&mut app, &place);
    }
}

/// The globe, with the interface's lists over it, until a place is picked.
unsafe fn atlas(app: &mut App) -> String {
    app.ui.collect();
    let room = globe::BYTES.min(app.buffer.len());
    let surface = read_into("globe.psp", &mut app.buffer[..room]).ok().filter(|&n| n == globe::BYTES);
    let mut globe = globe::Globe::new(if surface.is_some() { app.buffer.as_ptr() } else { core::ptr::null() });
    {
        let state = app.ui.state();
        state.scene = Showing::Atlas;
        state.place.clear();
        state.shots.clear();
        state.options.clear();
        state.stats.clear();
    }
    let mut pad: SceCtrlData = core::mem::zeroed();
    let mut held = false;
    loop {
        let dt = app.tick();
        let start = app.now;
        sceCtrlPeekBufferPositive(&mut pad, 1);
        let command = if app.frame % 15 == 0 { app.dev.poll() } else { None };
        let mut go = command.as_ref().filter(|c| !c.place.is_empty()).map(|c| c.place.clone());
        for asked in app.turn(dt, &pad, &command) {
            match asked {
                Command::Globe { x, y, r, lat, lon, pin } => {
                    globe.place(x, y, r);
                    globe.turn(lat, lon, pin);
                }
                Command::Pins(list) => globe.pins(&list),
                Command::Spin { dx, dy } => globe.spin(-dx * 0.5, dy * 0.5),
                Command::Enter(place) => go = Some(place),
                Command::Hold(on) => held = on,
                Command::Prefs(text) => {
                    write("interface.json", text.as_bytes());
                    app.ui.state().prefs = text;
                }
                _ => {}
            }
        }
        // The stick spins the globe; where it comes to rest is what the
        // interface's Explore list sorts from.
        let (x, y) = (axis(pad.lx), axis(pad.ly));
        if !held && (x != 0.0 || y != 0.0) {
            globe.spin(x * 60.0 * dt, -y * 60.0 * dt);
        }
        if globe.update(dt) {
            let state = app.ui.state();
            (state.lat, state.lon) = (globe.facing[0], globe.facing[1]);
        }
        renderer::begin(0xff09_0503);
        globe.draw();
        let gpu = renderer::end(&app.ui);
        let work = sceKernelGetSystemTimeLow().wrapping_sub(start);
        app.present(start, &command);
        if app.frame % 30 == 0 {
            app.report(dev::Status { work_ms: work as f32 / 1000.0, gpu_wait_ms: gpu as f32 / 1000.0, ..IDLE });
        }
        if let Some(place) = go {
            return place;
        }
    }
}

/// A frame of the interface alone: a place loading, or one that cannot be shown.
unsafe fn interlude(app: &mut App) -> Vec<Command> {
    let dt = app.tick();
    let start = app.now;
    let mut pad: SceCtrlData = core::mem::zeroed();
    sceCtrlPeekBufferPositive(&mut pad, 1);
    let command = if app.frame % 15 == 0 { app.dev.poll() } else { None };
    let mut asked = app.turn(dt, &pad, &command);
    if command.is_some_and(|c| !c.place.is_empty()) {
        asked.push(Command::Leave);
    }
    renderer::begin(0xff0b_0705);
    renderer::end(&app.ui);
    app.present(start, &None);
    if app.frame % 30 == 0 {
        app.report(IDLE);
    }
    asked
}

/// One place: read its pack, draw it until the interface or a control
/// message leaves it. Returns the place a control message asked for instead.
unsafe fn visit(app: &mut App, place: &str) -> Option<String> {
    app.ui.collect();
    {
        let state = app.ui.state();
        state.scene = Showing::Loading;
        state.place = place.into();
        state.message.clear();
        // Another place's, when a control message came straight from it.
        state.shots.clear();
        state.options.clear();
        state.stats.clear();
    }
    // The interface has its say before the memory stick takes the thread.
    for _ in 0..4 {
        interlude(app);
    }
    let name = format!("{place}.place");
    // The pack is borrowed from the buffer for as long as the place is up.
    let storage = core::slice::from_raw_parts_mut(app.buffer.as_mut_ptr(), app.buffer.len());
    let loaded = read_into(&name, storage).and_then(|length| pp::validate(&storage[..length]).map(|header| (&storage[..length], header)));
    let (bytes, h) = match loaded {
        Ok(pack) => pack,
        Err(why) => {
            {
                let state = app.ui.state();
                state.scene = Showing::Error;
                state.message = format!("{name}: {why}");
            }
            while !interlude(app).contains(&Command::Leave) {}
            return None;
        }
    };
    app.dev.loaded(bytes);
    let mut scene = scene::Scene::new(bytes, h);
    let mut rig = camera::Rig::new(scene.shots[0]);
    let mut gpu = renderer::Renderer::new(&scene);
    // The rain's mixer lives for the process; it is silent outside a place.
    static mut MIXING: bool = false;
    if (h.rain != 0 || h.doors.iter().any(|&node| node != pp::NONE)) && !MIXING {
        MIXING = true;
        audio::start();
    }
    let has_rain = h.rain != 0;
    let has_reflection = scene.materials.iter().any(|m| m.flags & pp::WET != 0);
    let (mut rain, mut reflection, mut sound, mut statistics) = (has_rain, has_reflection, true, false);
    let (mut paused, mut held, mut was_open) = (false, false, false);
    let (mut clock, mut frozen) = (0.0f32, -1.0f32);
    let mut pad: SceCtrlData = core::mem::zeroed();
    let (mut work_sum, mut gpu_sum, mut max_work, mut sample_start) = (0u64, 0u64, 0u32, app.now);
    {
        let state = app.ui.state();
        state.scene = Showing::Place;
        state.shots = scene.shots.iter().map(|s| core::str::from_utf8(&s.name).unwrap_or("").trim_end_matches('\0').into()).collect();
    }
    let next = loop {
        let dt = app.tick();
        let start = app.now;
        sceCtrlPeekBufferPositive(&mut pad, 1);
        let command = if app.frame % 15 == 0 { app.dev.poll() } else { None };
        if let Some(c) = &command {
            if !c.place.is_empty() && c.place != place {
                break Some(c.place.clone());
            }
            frozen = c.time;
            paused = c.pause;
            rain = has_rain && c.rain;
            reflection = has_reflection && c.reflection;
            if c.shot >= 0 && (c.shot as usize) < scene.shots.len() {
                rig.cut(c.shot as usize, scene.shots);
                rig.shot_time = scene.shots[rig.shot].duration * 0.5;
            }
        }
        {
            let state = app.ui.state();
            state.shot = rig.shot as u32;
            state.tour = rig.cinematic;
            state.paused = paused;
            if state.options.is_empty() {
                if has_rain {
                    state.options.push(Setting::switch("rain", rain));
                    state.options.push(Setting::switch("sound", sound));
                }
                if has_reflection {
                    state.options.push(Setting::switch("reflection", reflection));
                }
                state.options.push(Setting::switch("stats", statistics));
            }
        }
        let mut leave = false;
        for asked in app.turn(dt, &pad, &command) {
            match asked {
                Command::Leave => leave = true,
                Command::Shot(k) => {
                    rig.cut(k % scene.shots.len(), scene.shots);
                    frozen = -1.0;
                }
                Command::Tour(true) => {
                    rig.cut(rig.shot, scene.shots);
                    (frozen, paused) = (-1.0, false);
                }
                Command::Tour(false) => rig.release(),
                Command::Pause(on) => paused = on,
                Command::Hold(on) => held = on,
                Command::Option { key, value } => {
                    match key.as_str() {
                        "rain" => rain = value != 0,
                        "reflection" => reflection = value != 0,
                        "sound" => sound = value != 0,
                        "stats" => statistics = value != 0,
                        _ => {}
                    }
                    app.ui.state().options.clear();
                }
                _ => {}
            }
        }
        if leave {
            break None;
        }
        if !paused {
            clock += dt;
        }
        let time = if frozen >= 0.0 { frozen } else { clock };
        // The stick walks and the d-pad looks, unless a menu has the pad.
        let b = |flag| if !held && pad.buttons.contains(flag) { 1.0 } else { 0.0 };
        rig.update(
            if frozen >= 0.0 || paused { 0.0 } else { dt },
            if held { (0.0, 0.0) } else { (axis(pad.lx), axis(pad.ly)) },
            (b(CtrlButtons::RIGHT) - b(CtrlButtons::LEFT), b(CtrlButtons::DOWN) - b(CtrlButtons::UP)),
            scene.shots,
            scene.walkable,
        );
        scene.update(time, rig.pos);
        let indoors = scene.dry.iter().any(|b| (0..3).all(|k| rig.pos[k] >= b[k] && rig.pos[k] <= b[k + 3]));
        audio::LEVEL.store(if !sound || !rain || h.rain == 0 { 0 } else if indoors { 45 } else { 130 }, core::sync::atomic::Ordering::Relaxed);
        let open = scene.door > 0.5;
        if open && !was_open && sound {
            audio::CHIME.fetch_add(1, core::sync::atomic::Ordering::Relaxed);
        }
        was_open = open;
        let stats = gpu.frame(&scene, &rig, time, rain && h.rain != 0, reflection, &app.ui);
        let work = sceKernelGetSystemTimeLow().wrapping_sub(start);
        work_sum += work as u64;
        gpu_sum += stats.gpu_us as u64;
        max_work = max_work.max(work);
        app.present(start, &command);
        if app.frame % 30 == 0 {
            let end = sceKernelGetSystemTimeLow();
            let ms = end.wrapping_sub(sample_start) as f32 / 30000.0;
            let fps = 1000.0 / ms;
            let shot = core::str::from_utf8(&scene.shots[rig.shot].name).unwrap_or("").trim_end_matches('\0');
            app.report(dev::Status {
                shot,
                shot_index: rig.shot,
                time,
                frame_ms: ms,
                work_ms: work_sum as f32 / 30000.0,
                gpu_wait_ms: gpu_sum as f32 / 30000.0,
                max_work_ms: max_work as f32 / 1000.0,
                draws: stats.draws,
                triangles: stats.triangles,
                pack_bytes: bytes.len(),
                rain,
                reflection,
                paused,
                free_camera: !rig.cinematic,
                ..IDLE
            });
            (work_sum, gpu_sum, max_work) = (0, 0, 0);
            sample_start = sceKernelGetSystemTimeLow();
            app.ui.state().stats = if statistics { format!("{fps:.0} fps · {}k triangles", stats.triangles / 1000) } else { String::new() };
        }
    };
    audio::LEVEL.store(0, core::sync::atomic::Ordering::Relaxed);
    next
}
