//! Exercise the production App state machine with explicit Scene/Renderer
//! doubles. This proves retry and ownership policy, not GPU allocation.
#![allow(dead_code)]
extern crate alloc;

#[path = "../src/app.rs"]
mod app;
#[path = "../src/gl.rs"]
mod gl;
#[path = "../src/performance.rs"]
mod performance;
#[path = "../src/pipelines.rs"]
mod pipelines;
#[path = "../src/state.rs"]
mod state;

use core::ffi::c_char;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering::SeqCst};
static GLOBE_BUILDS: AtomicUsize = AtomicUsize::new(0);
static LOADS: AtomicUsize = AtomicUsize::new(0);
static BUILDS: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static RESIZES: AtomicUsize = AtomicUsize::new(0);
static FAIL_RESIZE: AtomicBool = AtomicBool::new(false);
static FAIL_SCENE: AtomicBool = AtomicBool::new(false);
static FAIL_RENDERER: AtomicBool = AtomicBool::new(false);
static CONSTRUCTED_DOOR: AtomicU32 = AtomicU32::new(0);
static FAIL_FRAME: AtomicBool = AtomicBool::new(false);
static BOUND_PROGRAM: AtomicU32 = AtomicU32::new(0);
static RAW_GL_ERROR: AtomicU32 = AtomicU32::new(0);
static RENDERER_GL_ERROR: AtomicU32 = AtomicU32::new(0);
static SUBMITTED_CLASS: AtomicU32 = AtomicU32::new(0);

fn read(path: &str) -> Result<Vec<u8>, String> {
    Ok(if path.ends_with("catalog.json") {
        br##"[{"id":"test-place","name":"Test","summary":"Test place","native":"Test",
             "locality":"Test","weather":"Clear","author":"Test","lat":0,"lon":0,"accent":"#123456"}]"##.to_vec()
    } else if path.ends_with("build-receipt.json") {
        br#"{"buildId":"test"}"#.to_vec()
    } else {
        return Err("unexpected host-test read".into());
    })
}

mod scene {
    use super::*;
    pub struct Meta {
        pub camera: pocket3d_place::CameraSet,
    }
    pub struct LightSource;
    impl LightSource {
        pub fn bytes(&self) -> usize {
            0
        }
    }
    pub struct Scene {
        pub light_lod_source: LightSource,
        pub meta: Meta,
        pub door: f32,
        pub gpu_bytes: usize,
        pub cpu_index_bytes: usize,
        pub ldr_color_bytes: usize,
    }
    impl Scene {
        pub unsafe fn load(_: &str) -> Result<Self, String> {
            assert_eq!(
                LIVE.load(SeqCst),
                0,
                "release renderer before loading a scene profile"
            );
            LOADS.fetch_add(1, SeqCst);
            if FAIL_SCENE.load(SeqCst) {
                return Err("injected scene profile upload failure".into());
            }
            let key = pocket3d_place::ShotKey {
                pos: [0.0, 2.0, 8.0],
                target: [0.0, 0.0, 0.0],
                fov: 45.0,
            };
            Ok(Self {
                light_lod_source: LightSource,
                meta: Meta {
                    camera: pocket3d_place::CameraSet {
                        shots: vec![pocket3d_place::Shot {
                            name: "Test shot".into(),
                            from: key.clone(),
                            to: key.clone(),
                            duration: 30.0,
                        }],
                        walkable: vec![],
                        intro: key,
                    },
                },
                door: 0.4,
                gpu_bytes: 1,
                cpu_index_bytes: 0,
                ldr_color_bytes: 0,
            })
        }
        pub fn update(&mut self, _: f32, _: glam::Vec3, _: f32) {
            self.door = 0.73;
        }

    }
}

mod renderer {
    use super::*;
    pub struct Renderer {
        pub width: i32,
        pub height: i32,
        pub profile: bool,
        pub profile_class: u8,
        pub gl_error: u32,
        pub sky_ms: f32,
        pub mesh_ms: f32,
        pub wet_response_ms: f32,
        pub water_response_ms: f32,
        pub mesh_steps_ms: [[f32; 5]; 4],
        pub submit_ms: f32,
        pub timings: [f32; 5],
        pub post_steps_ms: [f32; 3],
        pub count: u32,
        pub triangles: u32,
        pub light_points: u32,
    }
    impl Renderer {
        pub unsafe fn new(
            _: &str,
            _: &str,
            scene: &scene::Scene,
        ) -> Result<Self, String> {
            if FAIL_RENDERER.load(SeqCst) { return Err("injected shader failure".into()); }
            assert_eq!(
                LIVE.fetch_add(1, SeqCst),
                0,
                "old renderer must be released first"
            );
            BUILDS.fetch_add(1, SeqCst);
            CONSTRUCTED_DOOR.store(scene.door.to_bits(), SeqCst);
            let width = 480;
            Ok(Self {
                width,
                height: width * 2 / 3,
                profile: false,
                profile_class: 0,
                gl_error: 0,
                sky_ms: 0.0,
                mesh_ms: 0.0,
                wet_response_ms: 0.0,
                water_response_ms: 0.0,
                mesh_steps_ms: [[0.0; 5]; 4],
                submit_ms: 0.0,
                timings: [0.0; 5],
                post_steps_ms: [0.0; 3],
                count: 1,
                triangles: 1,
                light_points: 0,
            })
        }
        pub unsafe fn resize(&mut self, width: i32, height: i32) -> Result<(), String> {
            RESIZES.fetch_add(1, SeqCst);
            if FAIL_RESIZE.load(SeqCst) {
                return Err("injected allocation failure".into());
            }
            self.width = width;
            self.height = height;
            Ok(())
        }
        #[allow(clippy::too_many_arguments)]
        pub unsafe fn frame(
            &mut self,
            _: &mut scene::Scene,
            _: glam::Vec3,
            _: glam::Vec3,
            _: f32,
            _: f32,
            _: u32,
            _: i32,
            _: i32,
            _: bool,
            _: bool,
            _: bool,
        ) -> Result<(), String> {
            SUBMITTED_CLASS.store(self.profile_class as u32, SeqCst);
            if FAIL_FRAME.load(SeqCst) {
                return Err("injected particle upload failure".into());
            }
            self.gl_error = RENDERER_GL_ERROR.load(SeqCst);
            glUseProgram(7);
            Ok(())
        }
        pub fn field_appearance_bytes(&self) -> usize { 0 }
        pub fn light_lod_bytes(&self) -> (usize, usize) {
            (0, 0)
        }
        pub fn cpu_index_bytes(&self) -> usize {
            0
        }
        pub fn hdr_target(&self) -> (u32, i32, i32) {
            (1, self.width, self.height)
        }
    }
    impl Drop for Renderer {
        fn drop(&mut self) {
            assert_eq!(
                BOUND_PROGRAM.load(SeqCst),
                0,
                "current program must be unbound before drop"
            );
            assert_eq!(LIVE.fetch_sub(1, SeqCst), 1);
        }
    }
}

mod globe {
    use super::*;
    pub struct Marker {
        pub lat: f32,
        pub lon: f32,
        pub color: [f32; 3],
    }
    pub struct Globe {
        dimensions: (i32, i32),
        pub profile: bool,
        pub timings: [f32; 4],
        pub post_steps_ms: [f32; 2],
        pub sphere_step: u32,
        pub draws: u32,
        pub triangles: u32,
    }
    impl Globe {
        pub unsafe fn new(_: &str, width: i32) -> Result<Self, String> {
            GLOBE_BUILDS.fetch_add(1, SeqCst);
            Ok(Self {
                dimensions: (width, (width * 272 + 240) / 480),
                profile: false,
                timings: [0.0; 4],
                post_steps_ms: [0.0; 2],
                sphere_step: 1,
                draws: 5,
                triangles: 16390,
            })
        }
        pub fn dimensions(&self) -> (i32, i32) {
            self.dimensions
        }
        pub unsafe fn resize(&mut self, width: i32) -> Result<(), String> {
            RESIZES.fetch_add(1, SeqCst);
            if FAIL_RESIZE.load(SeqCst) {
                return Err("injected globe target failure".into());
            }
            self.dimensions = (width, (width * 272 + 240) / 480);
            Ok(())
        }
        pub fn pick(&self, _: f32, _: f32) -> Option<usize> {
            None
        }
        pub unsafe fn frame(&mut self, _: &[Marker], _: [f32; 2], _: f32, _: u32, _: i32, _: i32) {
            self.timings = if self.profile {
                [1.0, 2.0, 3.0, 4.0]
            } else {
                [0.0; 4]
            };
            self.sphere_step = 2;
            self.post_steps_ms = [3.0, 1.0];
        }
    }
}

#[no_mangle]
extern "C" fn atlas_documents_path() -> *const c_char {
    core::ptr::null()
}
#[no_mangle]
extern "C" fn atlas_audio_available() -> i32 {
    0
}
#[no_mangle]
extern "C" fn atlas_audio_error() -> *const c_char {
    b"\0".as_ptr().cast()
}
#[no_mangle]
extern "C" fn atlas_audio_update(_: *const c_char, _: f64, _: i32, _: i32) -> i32 {
    0
}
#[no_mangle]
extern "C" fn atlas_resident_bytes() -> u32 {
    0
}
fn atlas_log(_: *const c_char) {}
#[no_mangle]
extern "C" fn glFinish() {}
#[no_mangle]
extern "C" fn glUseProgram(program: u32) {
    BOUND_PROGRAM.store(program, SeqCst);
}
#[no_mangle]
extern "C" fn glBindFramebuffer(_: u32, _: u32) {}
#[no_mangle]
extern "C" fn glViewport(_: i32, _: i32, _: i32, _: i32) {}
#[no_mangle]
extern "C" fn glClearColor(_: f32, _: f32, _: f32, _: f32) {}
#[no_mangle]
extern "C" fn glClear(_: u32) {}
#[no_mangle]
extern "C" fn glGetError() -> u32 {
    RAW_GL_ERROR.swap(0, SeqCst)
}

unsafe fn presented(app: &mut app::App) -> serde_json::Value {
    app.frame(1.0 / 30.0, 480, 320, 1);
    app.frame_completed(5.0, 1.0, 1000.0 / 30.0);
    app.refresh_status();
    serde_json::from_slice(app.status.as_bytes()).unwrap()
}

#[test]
fn resize_failure_lifecycle_and_diagnostics_preserve_the_fixed_device_profile() {
    let mut app = app::App::new("/host-test".into());
    FAIL_RESIZE.store(true, SeqCst);
    app.command(br#"{"place":"test-place","renderWidth":640,"pause":true}"#);
    let initial = unsafe { presented(&mut app) };
    assert_eq!(initial["state"], "error");
    assert_eq!(initial["renderWidth"], 480);
    assert_eq!(RESIZES.load(SeqCst), 1);
    for _ in 0..100 { unsafe { presented(&mut app); } }
    assert_eq!(RESIZES.load(SeqCst), 1, "failed target must not retry every frame");
    app.command(br#"{"renderWidth":640}"#);
    unsafe { presented(&mut app); }
    assert_eq!(RESIZES.load(SeqCst), 2);
    FAIL_RESIZE.store(false, SeqCst);
    app.command(br#"{"renderWidth":640}"#);
    let recovered = unsafe { presented(&mut app) };
    assert_eq!(recovered["state"], "running");
    assert_eq!(recovered["renderWidth"], 640);
    assert_eq!(RESIZES.load(SeqCst), 3);
    assert_eq!(BUILDS.load(SeqCst), 1);
    assert_eq!(LOADS.load(SeqCst), 1);
    assert_eq!(recovered["camera"], initial["camera"]);
    assert_eq!(recovered["time"], initial["time"]);

    FAIL_RENDERER.store(true, SeqCst);
    app.command(br#"{"place":"test-place"}"#);
    let failed = unsafe { presented(&mut app) };
    assert_eq!(failed["error"], "injected shader failure");
    assert_eq!(failed["gpuBytes"], 0, "failed renderer releases the loaded scene");
    assert_eq!(LIVE.load(SeqCst), 0);
    FAIL_RENDERER.store(false, SeqCst);
    app.command(br#"{"place":"test-place"}"#);
    assert_eq!(unsafe { presented(&mut app) }["state"], "running");

    // Removed comparison commands cannot allocate another working set.
    for setting in [0, 1, 2] {
        app.command(format!(r#"{{"quality":{setting},"renderWidth":0}}"#).as_bytes());
        app.action(8); // obsolete native action stays unassigned
        let status = unsafe { presented(&mut app) };
        assert_eq!(status["quality"], 0);
        assert_eq!(status["qualityProfile"], "optimized");
        assert_eq!(status["renderingProfile"], "display-prelit");
        assert_eq!(status["defaultRenderWidth"], 480);
        assert_eq!(status["renderWidth"], 480);
    }
    assert_eq!(BUILDS.load(SeqCst), 2);
    assert_eq!(LOADS.load(SeqCst), 3);

    app.command(br#"{"profile":false,"profileDrawClass":7}"#);
    let filtered = unsafe { presented(&mut app) };
    assert_eq!(filtered["profile"], false);
    assert_eq!(SUBMITTED_CLASS.load(SeqCst), 7);
    assert_eq!(filtered["frameTiming"]["workMs"]["samples"], 1);
    app.command(br#"{"profileDrawClass":0}"#);
    unsafe { presented(&mut app); }
    assert_eq!(SUBMITTED_CLASS.load(SeqCst), 0);
    RENDERER_GL_ERROR.store(0x0505, SeqCst);
    RAW_GL_ERROR.store(0x0502, SeqCst);
    assert_eq!(unsafe { presented(&mut app) }["glError"], 0x0502);
    assert_eq!(unsafe { presented(&mut app) }["glError"], 0x0505);
    RENDERER_GL_ERROR.store(0, SeqCst);
    FAIL_FRAME.store(true, SeqCst);
    let failure = unsafe { presented(&mut app) };
    assert_eq!(failure["error"], "injected particle upload failure");
    FAIL_FRAME.store(false, SeqCst);

    // Suspension releases ownership; a failed cold reload stays visible and
    // waits for explicit navigation. It must never allocate the globe.
    app.command(br#"{"pause":false,"renderWidth":480}"#);
    for _ in 0..60 { unsafe { presented(&mut app); } }
    let before = unsafe { presented(&mut app) };
    assert!(before["time"].as_f64().unwrap() > 1.0);
    unsafe { app.suspend(); }
    assert_eq!(BOUND_PROGRAM.load(SeqCst), 0);
    assert_eq!(LIVE.load(SeqCst), 0);
    let restored = unsafe { presented(&mut app) };
    assert_eq!(restored["state"], "running");
    assert_eq!(restored["camera"], before["camera"]);
    assert!((restored["time"].as_f64().unwrap() - before["time"].as_f64().unwrap()).abs() < 0.04);
    assert_eq!(CONSTRUCTED_DOOR.load(SeqCst), 0.73f32.to_bits());
    unsafe { app.suspend(); }
    FAIL_SCENE.store(true, SeqCst);
    let globes = GLOBE_BUILDS.load(SeqCst);
    let failed = unsafe { presented(&mut app) };
    assert_eq!(failed["state"], "error");
    assert_eq!(LIVE.load(SeqCst), 0);
    let loads = LOADS.load(SeqCst);
    for _ in 0..10 { unsafe { presented(&mut app); } }
    assert_eq!(LOADS.load(SeqCst), loads);
    assert_eq!(GLOBE_BUILDS.load(SeqCst), globes);
    FAIL_SCENE.store(false, SeqCst);
    app.command(br#"{"place":"test-place"}"#);
    assert_eq!(unsafe { presented(&mut app) }["state"], "running");
    assert_eq!(LOADS.load(SeqCst), loads + 1);

    app.command(br#"{"place":"atlas","renderWidth":0,"profile":true}"#);
    let globe = unsafe { presented(&mut app) };
    assert_eq!(globe["renderWidth"], 480);
    assert_eq!(globe["renderHeight"], 272);
    assert_eq!(globe["renderingProfile"], "globe-hdr");
    assert_eq!(globe["globeSphereStep"], 2);
    assert!(globe["passTiming"].is_null(), "loading frame is excluded");
    let profiled = unsafe { presented(&mut app) };
    assert_eq!(profiled["passTiming"]["kind"], "globe");
    assert_eq!(profiled["passTiming"]["stagesMs"]["grade"]["mean"], 3.0);
    assert_eq!(profiled["passTiming"]["stagesMs"]["blit"]["mean"], 1.0);
    unsafe { app.frame_completed(999.0, 999.0, 999.0); app.refresh_status(); }
    // A captured/excluded presentation may not contaminate pass windows.
    app.command(br#"{"profile":false,"renderWidth":640}"#);
    FAIL_RESIZE.store(true, SeqCst);
    let failure = unsafe { presented(&mut app) };
    assert_eq!(failure["renderWidth"], 480);
    let attempts = RESIZES.load(SeqCst);
    for _ in 0..10 { unsafe { presented(&mut app); } }
    assert_eq!(RESIZES.load(SeqCst), attempts);
    FAIL_RESIZE.store(false, SeqCst);
    app.command(br#"{"renderWidth":640}"#);
    assert_eq!(unsafe { presented(&mut app) }["renderWidth"], 640);

    app.command(br#"{"place":"test-place","renderWidth":960,"pause":false,"time":-1}"#);
    for _ in 0..60 { unsafe { presented(&mut app); } }
    app.command(br#"{"pause":true}"#);
    let before = unsafe { presented(&mut app) };
    let loads = LOADS.load(SeqCst);
    app.memory_warning();
    let warned = unsafe { presented(&mut app) };
    assert_eq!(warned["renderWidth"], 480);
    assert_eq!(warned["memoryWarningBatches"], 1);
    assert_eq!(warned["camera"], before["camera"]);
    assert_eq!(warned["target"], before["target"]);
    assert_eq!(warned["time"], before["time"]);
    assert_eq!(LOADS.load(SeqCst), loads);
    app.command(br#"{"renderWidth":160}"#);
    assert_eq!(unsafe { presented(&mut app) }["renderWidth"], 160);
    app.memory_warning();
    assert_eq!(unsafe { presented(&mut app) }["renderWidth"], 480);

    // Bad cadence remains observable and cannot lower normal image quality.
    for _ in 0..140 { unsafe {
        app.frame(1.0 / 30.0, 480, 320, 1);
        app.frame_completed(22.0, 90.0, 112.0);
    } }
    unsafe { app.refresh_status(); }
    let overloaded: serde_json::Value = serde_json::from_slice(app.status.as_bytes()).unwrap();
    assert_eq!(overloaded["renderWidth"], 480);
    assert_eq!(overloaded["frameTiming"]["workMs"]["overBudget"], 120);
    assert_eq!(overloaded["frameTiming"]["intervalMs"]["p95"], 112.0);
    assert!(overloaded["fps"].as_f64().unwrap() < 9.0);

    let old_status = app.status.clone();
    app.command(br#"{"nonce":"presented"}"#);
    unsafe {
        app.frame(1.0 / 30.0, 480, 320, 1);
        app.frame_completed(5.0, 1.0, 1000.0 / 30.0);
    }
    assert_eq!(app.status, old_status, "JSON publication is deferred");
    unsafe { app.refresh_status(); }
    let published: serde_json::Value = serde_json::from_slice(app.status.as_bytes()).unwrap();
    assert_eq!(published["lastCommand"], "presented");
    app.command(br#"{"nonce":"preempted","place":"test-place"}"#);
    unsafe { app.suspend(); app.refresh_status(); }
    let suspended: serde_json::Value = serde_json::from_slice(app.status.as_bytes()).unwrap();
    assert_eq!(suspended["state"], "suspended");
    assert_eq!(suspended["lastCommand"], "presented", "unpresented command cannot be acknowledged");
    assert_eq!(suspended["gpuBytes"], 0);
    assert!(suspended["renderingProfile"].is_null());
    app.command(br#"{"place":"atlas"}"#);
    assert_eq!(unsafe { presented(&mut app) }["state"], "running");
}
