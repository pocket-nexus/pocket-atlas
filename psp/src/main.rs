#![no_std]
#![no_main]
extern crate alloc;

mod audio;
mod camera;
mod renderer;
mod scene;

use alloc::{format, vec, vec::Vec};
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
unsafe fn write(path: &[u8], text: &str) {
    let fd = sceIoOpen(
        path.as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
        0o666,
    );
    if fd.0 >= 0 {
        sceIoWrite(fd, text.as_ptr() as _, text.len());
        sceIoClose(fd);
    }
}
unsafe fn run() {
    scePowerSetClockFrequency(333, 333, 166);
    psp::dprintln!("Pocket Atlas / PSP\nLoading Rainy Night Konbini...");
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
    audio::start();
    sceCtrlSetSamplingCycle(0);
    sceCtrlSetSamplingMode(CtrlMode::Analog);
    let mut previous = CtrlButtons::empty();
    let mut pad: SceCtrlData = core::mem::zeroed();
    let mut now = sceKernelGetSystemTimeLow();
    let mut clock = 0.0f32;
    let mut frozen = -1.0f32;
    let mut paused = false;
    let mut rain = true;
    let mut reflection = true;
    let mut hud = false;
    let mut muted = false;
    let mut was_open = false;
    let mut nonce = 0u32;
    let mut frame = 0u32;
    let mut work_sum = 0u64;
    let mut gpu_sum = 0u64;
    let mut max_work = 0u32;
    let mut sample_start = now;
    let mut control = [0u8; 128];
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
        if pressed.contains(CtrlButtons::SQUARE) {
            rain = !rain;
        }
        if pressed.contains(CtrlButtons::TRIANGLE) {
            reflection = !reflection;
        }
        if frame % 30 == 0 {
            let fd = sceIoOpen(b"host0:/control.txt\0".as_ptr(), IoOpenFlags::RD_ONLY, 0);
            if fd.0 >= 0 {
                let n = sceIoRead(fd, control.as_mut_ptr() as _, 127);
                sceIoClose(fd);
                if n > 0 {
                    if let Ok(s) = core::str::from_utf8(&control[..n as usize]) {
                        let mut parts = s.split_whitespace();
                        let shot = parts.next().and_then(|v| v.parse::<i32>().ok());
                        let time = parts.next().and_then(|v| v.parse::<f32>().ok());
                        let pause = parts.next().and_then(|v| v.parse::<u32>().ok());
                        let r = parts.next().and_then(|v| v.parse::<u32>().ok());
                        let refl = parts.next().and_then(|v| v.parse::<u32>().ok());
                        let id = parts.next().and_then(|v| v.parse::<u32>().ok());
                        if let (Some(s), Some(t), Some(p), Some(r), Some(rf), Some(id)) =
                            (shot, time, pause, r, refl, id)
                        {
                            if id != nonce && t.is_finite() {
                                nonce = id;
                                frozen = t;
                                paused = p != 0;
                                rain = r != 0;
                                reflection = rf != 0;
                                if s >= 0 {
                                    rig.cut(s as usize % scene.shots.len(), scene.shots);
                                    rig.shot_time = scene.shots[rig.shot].duration * 0.5;
                                }
                            }
                        }
                    }
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
            write(b"host0:/status.json\0",&format!("{{\"target\":\"psp\",\"frame\":{},\"shot\":\"{}\",\"shotIndex\":{},\"time\":{:.2},\"fps\":{:.2},\"frameMs\":{:.2},\"workMs\":{:.2},\"gpuWaitMs\":{:.2},\"maxWorkMs\":{:.2},\"draws\":{},\"triangles\":{},\"packBytes\":{},\"rain\":{},\"reflection\":{},\"paused\":{},\"freeCamera\":{}}}\n",frame,shot,rig.shot,time,1000.0/ms,ms,work_sum as f32/30000.0,gpu_sum as f32/30000.0,max_work as f32/1000.0,stats.draws,stats.triangles,len,rain,reflection,paused,!rig.cinematic));
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
