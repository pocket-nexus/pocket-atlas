#![no_std]
#![no_main]
extern crate alloc;

mod audio;
mod camera;
mod dev;
mod renderer;
mod scene;

use alloc::{vec, vec::Vec};
use pocket3d_place_psp as pp;
use psp::{sys::*, Align16};

psp::module!("PocketAtlas", 1, 0);

fn psp_main() {
    psp::enable_home_button();
    unsafe {
        run();
    }
}

unsafe fn load(path: &[u8]) -> Result<(Vec<Align16<[u8; 16]>>, usize), &'static str> {
    let fd = sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0);
    if fd.0 < 0 {
        return Err("open scene.place");
    }
    let size = sceIoLseek32(fd, 0, IoWhence::End);
    sceIoLseek32(fd, 0, IoWhence::Set);
    if size <= 0 || size as usize > pp::MAX_BYTES {
        sceIoClose(fd);
        return Err("pack size");
    }
    let len = size as usize;
    let mut bytes = vec![Align16([0u8; 16]); len.div_ceil(16)];
    let dest = core::slice::from_raw_parts_mut(bytes.as_mut_ptr() as *mut u8, len);
    let mut at = 0;
    while at < len {
        let n = sceIoRead(
            fd,
            dest[at..].as_mut_ptr() as _,
            (len - at).min(64 * 1024) as u32,
        );
        if n <= 0 {
            sceIoClose(fd);
            return Err("pack read");
        }
        at += n as usize;
    }
    sceIoClose(fd);
    Ok((bytes, len))
}
unsafe fn run() {
    scePowerSetClockFrequency(333, 333, 166);
    psp::dprintln!("Pocket Atlas / PSP\nLoading scene.place...");
    let (storage, len) = match load(b"scene.place\0").or_else(|_| load(b"host0:/scene.place\0")) {
        Ok(v) => v,
        Err(e) => {
            psp::dprintln!("{}", e);
            loop {
                sceKernelDelayThread(1_000_000);
            }
        }
    };
    let bytes = core::slice::from_raw_parts(storage.as_ptr() as *const u8, len);
    let h = match pp::validate(bytes) {
        Ok(h) => h,
        Err(e) => {
            psp::dprintln!("Invalid PSP place: {}", e);
            loop {
                sceKernelDelayThread(1_000_000);
            }
        }
    };
    let mut scene = scene::Scene::new(bytes, h);
    let mut rig = camera::Rig::new(scene.shots[0]);
    let mut gpu = renderer::Renderer::new(&scene);
    if h.rain != 0 || h.doors.iter().any(|&node| node != pp::NONE) {
        audio::start();
    }
    sceCtrlSetSamplingCycle(0);
    sceCtrlSetSamplingMode(CtrlMode::Analog);
    let mut previous = CtrlButtons::empty();
    let mut pad: SceCtrlData = core::mem::zeroed();
    let mut now = sceKernelGetSystemTimeLow();
    let mut clock = 0.0f32;
    let mut frozen = -1.0f32;
    let mut paused = false;
    let has_rain = h.rain != 0;
    let has_reflection = scene.materials.iter().any(|m| m.flags & pp::WET != 0);
    let mut rain = has_rain;
    let mut reflection = has_reflection;
    let mut hud = false;
    let mut muted = false;
    let mut was_open = false;
    let mut dev = dev::Session::connect();
    let mut frame = 0u32;
    let mut work_sum = 0u64;
    let mut gpu_sum = 0u64;
    let mut max_work = 0u32;
    let mut sample_start = now;
    loop {
        let start = sceKernelGetSystemTimeLow();
        let dt = (start.wrapping_sub(now) as f32 / 1e6).min(0.1);
        now = start;
        sceCtrlPeekBufferPositive(&mut pad, 1);
        let pressed = pad.buttons & !previous;
        previous = pad.buttons;
        if pressed.contains(CtrlButtons::CIRCLE) {
            muted = !muted;
        }
        if pressed.contains(CtrlButtons::CROSS) {
            paused = !paused;
        }
        if pressed.contains(CtrlButtons::SELECT) {
            hud = !hud;
        }
        if pressed.contains(CtrlButtons::START) {
            rig.cinematic = true;
            frozen = -1.0;
            paused = false;
        }
        if pressed.contains(CtrlButtons::RTRIGGER) {
            rig.cut((rig.shot + 1) % scene.shots.len(), scene.shots);
            frozen = -1.0;
        }
        if pressed.contains(CtrlButtons::LTRIGGER) {
            rig.cut(
                (rig.shot + scene.shots.len() - 1) % scene.shots.len(),
                scene.shots,
            );
            frozen = -1.0;
        }
        if has_rain && pressed.contains(CtrlButtons::SQUARE) {
            rain = !rain;
        }
        if has_reflection && pressed.contains(CtrlButtons::TRIANGLE) {
            reflection = !reflection;
        }
        if frame % 30 == 0 {
            if let Some(command) = dev.poll() {
                frozen = command.time;
                paused = command.pause;
                rain = has_rain && command.rain;
                reflection = has_reflection && command.reflection;
                if command.shot >= 0 && (command.shot as usize) < scene.shots.len() {
                    rig.cut(command.shot as usize, scene.shots);
                    rig.shot_time = scene.shots[rig.shot].duration * 0.5;
                }
            }
        }
        if !paused {
            clock += dt;
        }
        let time = if frozen >= 0.0 { frozen } else { clock };
        let axis = |v: u8| {
            let x = (v as f32 - 128.0) / 127.0;
            if x.abs() < 0.18 {
                0.0
            } else {
                x
            }
        };
        let x = axis(pad.lx);
        let y = axis(pad.ly);
        let b = |flag| if pad.buttons.contains(flag) { 1.0 } else { 0.0 };
        rig.update(
            if frozen >= 0.0 || paused { 0.0 } else { dt },
            (x, y),
            (
                b(CtrlButtons::RIGHT) - b(CtrlButtons::LEFT),
                b(CtrlButtons::DOWN) - b(CtrlButtons::UP),
            ),
            scene.shots,
            scene.walkable,
        );
        scene.update(time, rig.pos);
        let indoors = scene
            .dry
            .iter()
            .any(|b| (0..3).all(|k| rig.pos[k] >= b[k] && rig.pos[k] <= b[k + 3]));
        audio::LEVEL.store(
            if muted || !rain || h.rain == 0 {
                0
            } else if indoors {
                45
            } else {
                130
            },
            core::sync::atomic::Ordering::Relaxed,
        );
        let open = scene.door > 0.5;
        if open && !was_open && !muted {
            audio::CHIME.fetch_add(1, core::sync::atomic::Ordering::Relaxed);
        }
        was_open = open;
        let stats = gpu.frame(&scene, &rig, time, rain && h.rain != 0, reflection);
        let work = sceKernelGetSystemTimeLow().wrapping_sub(start);
        work_sum += work as u64;
        gpu_sum += stats.gpu_us as u64;
        max_work = max_work.max(work);
        // One vblank wait if work already consumed a refresh, two otherwise.
        sceDisplayWaitVblankStart();
        if sceKernelGetSystemTimeLow().wrapping_sub(start) < 25_000 {
            sceDisplayWaitVblankStart();
        }
        sceGuSwapBuffers();
        frame += 1;
        if frame % 30 == 0 {
            let end = sceKernelGetSystemTimeLow();
            let ms = end.wrapping_sub(sample_start) as f32 / 30000.0;
            let shot = core::str::from_utf8(&scene.shots[rig.shot].name)
                .unwrap_or("")
                .trim_end_matches('\0');
            dev.report(dev::Status {
                frame,
                shot,
                shot_index: rig.shot,
                time,
                frame_ms: ms,
                work_ms: work_sum as f32 / 30000.0,
                gpu_wait_ms: gpu_sum as f32 / 30000.0,
                max_work_ms: max_work as f32 / 1000.0,
                draws: stats.draws,
                triangles: stats.triangles,
                pack_bytes: len,
                rain,
                reflection,
                paused,
                free_camera: !rig.cinematic,
            });
            if hud {
                psp::dprintln!("{} {:.1} fps / {} tris", shot, 1000.0 / ms, stats.triangles);
            }
            work_sum = 0;
            gpu_sum = 0;
            max_work = 0;
            sample_start = sceKernelGetSystemTimeLow();
        }
        core::hint::black_box(&storage);
    }
}
