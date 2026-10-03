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
static CONSTRUCTED_DOOR: AtomicU32 = AtomicU32::new(0);
static FAIL_FRAME: AtomicBool = AtomicBool::new(false);
static BOUND_PROGRAM: AtomicU32 = AtomicU32::new(0);
static RAW_GL_ERROR: AtomicU32 = AtomicU32::new(0);
static RENDERER_GL_ERROR: AtomicU32 = AtomicU32::new(0);
static INDEX_DETACHES: AtomicUsize = AtomicUsize::new(0);
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
        pub performance: bool,
        pub meta: Meta,
        pub door: f32,
        pub gpu_bytes: usize,
        pub cpu_index_bytes: usize,
        pub ldr_color_bytes: usize,
    }
    impl Scene {
        pub unsafe fn load_for_profile(_: &str, performance: bool) -> Result<Self, String> {
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
                performance,
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
        pub unsafe fn reset_index_bindings(&self) {
            assert_eq!(
                LIVE.load(SeqCst),
                1,
                "detach references before deleting renderer buffers"
            );
            INDEX_DETACHES.fetch_add(1, SeqCst);
        }
    }
}

mod renderer {
    use super::*;
    pub struct Renderer {
        pub width: i32,
        pub height: i32,
        pub performance: bool,
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
            performance: bool,
        ) -> Result<Self, String> {
            assert_eq!(
                LIVE.fetch_add(1, SeqCst),
                0,
                "old renderer must be released first"
            );
            BUILDS.fetch_add(1, SeqCst);
            assert_eq!(scene.performance, performance);
            CONSTRUCTED_DOOR.store(scene.door.to_bits(), SeqCst);
            let width = if performance { 480 } else { 960 };
            Ok(Self {
                width,
                height: width * 2 / 3,
                performance,
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
        pub performance: bool,
        pub timings: [f32; 4],
        pub post_steps_ms: [f32; 2],
        pub sphere_step: u32,
        pub draws: u32,
        pub triangles: u32,
    }
    impl Globe {
        pub unsafe fn new(_: &str, width: i32, performance: bool) -> Result<Self, String> {
            GLOBE_BUILDS.fetch_add(1, SeqCst);
            Ok(Self {
                dimensions: (width, (width * 272 + 240) / 480),
                profile: false,
                performance,
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
        pub unsafe fn resize(&mut self, width: i32, performance: bool) -> Result<(), String> {
            RESIZES.fetch_add(1, SeqCst);
            if FAIL_RESIZE.load(SeqCst) {
                return Err("injected globe target failure".into());
            }
            self.dimensions = (width, (width * 272 + 240) / 480);
            self.performance = performance;
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
            self.sphere_step = if self.performance { 2 } else { 1 };
            self.post_steps_ms = if self.performance {
                [3.0, 1.0]
            } else {
                [4.0, 0.0]
            };
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
fn failed_resize_waits_for_retry_and_profile_reloads_preserve_camera_clock_and_door() {
    let mut app = app::App::new("/host-test".into());
    FAIL_RESIZE.store(true, SeqCst);
    app.command(br#"{"place":"test-place","quality":2,"renderWidth":640,"pause":true}"#);
    let initial = unsafe { presented(&mut app) };
    assert_eq!(initial["state"], "error");
    assert_eq!(initial["renderWidth"], 480);
    assert_eq!(RESIZES.load(SeqCst), 1);
    for _ in 0..100 {
        unsafe {
            presented(&mut app);
        }
    }
    assert_eq!(
        RESIZES.load(SeqCst),
        1,
        "failed target must not be retried each frame"
    );

    app.command(br#"{"quality":2}"#); // Explicitly reselecting the same quality retries once.
    unsafe {
        presented(&mut app);
    }
    assert_eq!(RESIZES.load(SeqCst), 2);
    FAIL_RESIZE.store(false, SeqCst);
    app.command(br#"{"renderWidth":640}"#);
    let recovered = unsafe { presented(&mut app) };
    assert_eq!(recovered["state"], "running");
    assert_eq!(recovered["renderWidth"], 640);
    assert_eq!(RESIZES.load(SeqCst), 3);
    assert_eq!(BUILDS.load(SeqCst), 1);
    assert_eq!(INDEX_DETACHES.load(SeqCst), 0);

    app.command(br#"{"quality":1,"renderWidth":0}"#);
    let full = unsafe { presented(&mut app) };
    assert_eq!(full["renderingProfile"], "full-hdr");
    assert_eq!(full["renderWidth"], 960);
    assert_eq!(full["qualityProfile"], "reference");
    assert_eq!(full["defaultRenderWidth"], 960);
    assert_eq!(full["camera"], initial["camera"]);
    assert_eq!(full["time"], initial["time"]);
    assert_eq!(LOADS.load(SeqCst), 2);
    assert_eq!(CONSTRUCTED_DOOR.load(SeqCst), 0.73f32.to_bits());
    app.command(br#"{"profile":false,"profileDrawClass":7}"#);
    let filtered = unsafe { presented(&mut app) };
    assert_eq!(filtered["profile"], false);
    assert_eq!(filtered["profileDrawClass"], 7);
    assert_eq!(SUBMITTED_CLASS.load(SeqCst), 7, "asynchronous diagnostics reach the renderer");
    assert_eq!(filtered["frameTiming"]["workMs"]["samples"], 1);
    app.command(br#"{"profileDrawClass":0}"#);
    let normal = unsafe { presented(&mut app) };
    assert_eq!(SUBMITTED_CLASS.load(SeqCst), 0);
    assert_eq!(normal["profileDrawClass"], 0);
    assert_eq!(normal["frameTiming"]["workMs"]["samples"], 1);
    assert_eq!(BUILDS.load(SeqCst), 2);
    assert_eq!(INDEX_DETACHES.load(SeqCst), 1);
    assert_eq!(
        RESIZES.load(SeqCst),
        3,
        "matching profile constructor needs no resize"
    );

    app.command(br#"{"quality":0}"#);
    unsafe {
        presented(&mut app);
    }
    assert_eq!(BUILDS.load(SeqCst), 3);
    assert_eq!(INDEX_DETACHES.load(SeqCst), 2);
    FAIL_RESIZE.store(true, SeqCst);
    // A diagnostic target change still fails transactionally and requires an
    // explicit retry; normal frame timing can no longer change the target.
    app.command(br#"{"renderWidth":640}"#);
    let failure = unsafe { presented(&mut app) };
    let attempts = RESIZES.load(SeqCst);
    assert_eq!(failure["state"], "error");
    for _ in 0..200 {
        unsafe {
            presented(&mut app);
        }
    }
    let still_failed = unsafe { presented(&mut app) };
    assert_eq!(RESIZES.load(SeqCst), attempts);
    assert_eq!(
        still_failed["renderWidth"], failure["renderWidth"],
        "the previous target must remain stable after failure"
    );
    assert_eq!(
        LOADS.load(SeqCst),
        3,
        "profile switches release incompatible assets before reloading"
    );
    RENDERER_GL_ERROR.store(0x0505, SeqCst);
    RAW_GL_ERROR.store(0x0502, SeqCst);
    assert_eq!(
        unsafe { presented(&mut app) }["glError"],
        0x0502,
        "a checked upload error must not overwrite another GL error"
    );
    assert_eq!(
        unsafe { presented(&mut app) }["glError"],
        0x0505,
        "a consumed upload error must remain visible in status"
    );
    RENDERER_GL_ERROR.store(0, SeqCst);
    assert_eq!(unsafe { presented(&mut app) }["glError"], 0);
    FAIL_FRAME.store(true, SeqCst);
    let frame_failure = unsafe { presented(&mut app) };
    assert_eq!(frame_failure["state"], "error");
    assert_eq!(frame_failure["error"], "injected particle upload failure");
    FAIL_FRAME.store(false, SeqCst);
    // A real profile reload must preserve an advancing nonzero clock, and
    // failure must release the old GPU owner without retrying every frame.
    FAIL_RESIZE.store(false, SeqCst);
    app.command(br#"{"pause":false,"renderWidth":480}"#);
    for _ in 0..60 {
        unsafe {
            presented(&mut app);
        }
    }
    let before = unsafe { presented(&mut app) };
    assert!(before["time"].as_f64().unwrap() > 1.0);
    app.command(br#"{"quality":1,"renderWidth":0}"#);
    let switched = unsafe { presented(&mut app) };
    assert_eq!(switched["state"], "running");
    let elapsed = switched["time"].as_f64().unwrap() - before["time"].as_f64().unwrap();
    assert!(elapsed >= 0.0 && elapsed < 0.04);
    assert_eq!(switched["camera"], before["camera"]);
    assert_eq!(CONSTRUCTED_DOOR.load(SeqCst), 0.73f32.to_bits());
    let globe_builds = GLOBE_BUILDS.load(SeqCst);
    FAIL_SCENE.store(true, SeqCst);
    app.command(br#"{"quality":0}"#);
    let failed_profile = unsafe { presented(&mut app) };
    assert_eq!(failed_profile["state"], "error");
    assert_eq!(
        failed_profile["error"],
        "injected scene profile upload failure"
    );
    assert_eq!(LIVE.load(SeqCst), 0);
    let attempts = LOADS.load(SeqCst);
    for _ in 0..10 {
        unsafe {
            presented(&mut app);
        }
    }
    assert_eq!(LOADS.load(SeqCst), attempts);
    assert_eq!(
        GLOBE_BUILDS.load(SeqCst),
        globe_builds,
        "failed scene must not allocate a globe"
    );
    FAIL_SCENE.store(false, SeqCst);
    app.command(br#"{"quality":0}"#); // Explicit same-quality retry.
    let restored = unsafe { presented(&mut app) };
    assert_eq!(restored["state"], "running");
    assert_eq!(LOADS.load(SeqCst), attempts + 1);
    assert!(restored["time"].as_f64().unwrap() >= switched["time"].as_f64().unwrap());
    assert_eq!(CONSTRUCTED_DOOR.load(SeqCst), 0.73f32.to_bits());
    unsafe {
        app.suspend();
    }
    assert_eq!(BOUND_PROGRAM.load(SeqCst), 0);
    assert_eq!(LIVE.load(SeqCst), 0);

    // The atlas has fixed authored dimensions and reports its real target.
    FAIL_RESIZE.store(false, SeqCst);
    app.command(br#"{"place":"atlas","quality":0,"renderWidth":0}"#);
    let globe = unsafe { presented(&mut app) };
    assert_eq!(globe["renderWidth"], 480);
    assert_eq!(globe["renderHeight"], 272);
    assert_eq!(globe["renderingProfile"], "globe-hdr");
    assert_eq!(globe["draws"], 5);
    assert_eq!(globe["triangles"], 16390);
    assert_eq!(globe["globeSphereStep"], 2);
    assert!(globe["passesMs"].is_null());
    for _ in 0..125 {
        unsafe {
            presented(&mut app);
        }
    }
    assert_eq!(unsafe { presented(&mut app) }["renderWidth"], 480);
    app.command(br#"{"quality":1,"profile":true}"#);
    let full_globe = unsafe { presented(&mut app) };
    assert_eq!(full_globe["renderWidth"], 480);
    assert_eq!(full_globe["renderHeight"], 272);
    assert_eq!(
        full_globe["globePassesMs"],
        serde_json::json!([1.0, 2.0, 3.0, 4.0])
    );
    assert_eq!(full_globe["globeSphereStep"], 1);
    assert_eq!(
        full_globe["globePostStepsMs"],
        serde_json::json!([4.0, 0.0])
    );
    assert!(
        full_globe["passTiming"].is_null(),
        "the resize frame is excluded"
    );
    let profiled = unsafe { presented(&mut app) };
    assert_eq!(profiled["passTiming"]["kind"], "globe");
    assert_eq!(profiled["passTiming"]["profile"], true);
    assert_eq!(profiled["passTiming"]["stagesMs"]["surface"]["mean"], 2.0);
    assert_eq!(profiled["passTiming"]["stagesMs"]["grade"]["mean"], 4.0);
    unsafe {
        app.frame(1.0 / 30.0, 480, 320, 1);
        app.frame_completed(999.0, 999.0, -1.0);
        app.refresh_status();
    }
    let captured: serde_json::Value = serde_json::from_slice(app.status.as_bytes()).unwrap();
    assert_eq!(
        captured["passTiming"], profiled["passTiming"],
        "readback cannot enter pass timing samples"
    );
    let attempts = RESIZES.load(SeqCst);
    app.command(br#"{"quality":2}"#);
    let fixed = unsafe { presented(&mut app) };
    assert_eq!(fixed["renderWidth"], 480);
    assert_eq!(fixed["globePostStepsMs"], serde_json::json!([3.0, 1.0]));
    assert_eq!(
        RESIZES.load(SeqCst),
        attempts + 1,
        "same-width profile switch must change the grade target"
    );
    app.command(br#"{"quality":0}"#);
    for _ in 0..125 {
        unsafe {
            presented(&mut app);
        }
    }
    assert_eq!(
        unsafe { presented(&mut app) }["renderWidth"],
        480,
        "profiling does not change the fixed device profile"
    );
    FAIL_RESIZE.store(true, SeqCst);
    app.command(br#"{"quality":2,"profile":false,"renderWidth":640}"#);
    let failure = unsafe { presented(&mut app) };
    let attempts = RESIZES.load(SeqCst);
    assert_eq!(failure["state"], "error");
    assert_eq!(failure["renderWidth"], 480);
    for _ in 0..150 {
        unsafe {
            presented(&mut app);
        }
    }
    assert_eq!(RESIZES.load(SeqCst), attempts);
    FAIL_RESIZE.store(false, SeqCst);
    app.command(br#"{"quality":2,"renderWidth":0}"#);
    assert_eq!(unsafe { presented(&mut app) }["renderWidth"], 480);

    // A real OS warning overrides even a diagnostic width, without resetting
    // the view, timeline or authored effect toggles. Subsequent warnings remain
    // observable and do not reload a compatible Scene.
    app.command(br#"{"place":"test-place","quality":1,"renderWidth":960,"pause":false,"time":-1}"#);
    for _ in 0..60 {
        unsafe {
            presented(&mut app);
        }
    }
    app.command(br#"{"pause":true}"#);
    let before_warning = unsafe { presented(&mut app) };
    assert!(before_warning["time"].as_f64().unwrap() > 1.0);
    app.memory_warning();
    let after_warning = unsafe { presented(&mut app) };
    assert_eq!(after_warning["quality"], 0);
    assert_eq!(after_warning["renderWidth"], 480);
    assert_eq!(after_warning["renderHeight"], 320);
    assert_eq!(after_warning["defaultRenderWidth"], 480);
    assert_eq!(after_warning["qualityProfile"], "optimized");
    assert_eq!(after_warning["memoryWarningBatches"], 1);
    assert_eq!(after_warning["camera"], before_warning["camera"]);
    assert_eq!(after_warning["target"], before_warning["target"]);
    assert_eq!(after_warning["time"], before_warning["time"]);
    assert_eq!(after_warning["rain"], before_warning["rain"]);
    assert_eq!(CONSTRUCTED_DOOR.load(SeqCst), 0.73f32.to_bits());
    let loads = LOADS.load(SeqCst);
    // Small targets are diagnostic only; a warning clears even that override
    // and restores the full fixed device dimensions, never a hidden low tier.
    app.command(br#"{"renderWidth":160}"#);
    let diagnostic = unsafe { presented(&mut app) };
    assert_eq!(diagnostic["renderWidth"], 160);
    assert_eq!(diagnostic["defaultRenderWidth"], 480);
    app.memory_warning();
    let warned_again = unsafe { presented(&mut app) };
    assert_eq!(warned_again["memoryWarningBatches"], 2);
    assert_eq!(warned_again["renderWidth"], 480);
    assert_eq!(LOADS.load(SeqCst), loads);

    // A warning after a same-batch navigation still forces the floor, and a
    // failed load neither retries the old selection nor hides the failure.
    app.command(br#"{"place":"test-place","quality":1}"#);
    app.memory_warning();
    assert_eq!(unsafe { presented(&mut app) }["renderWidth"], 480);
    FAIL_SCENE.store(true, SeqCst);
    let loads = LOADS.load(SeqCst);
    let globes = GLOBE_BUILDS.load(SeqCst);
    app.command(br#"{"place":"test-place","quality":1}"#);
    let failed = unsafe { presented(&mut app) };
    assert_eq!(failed["state"], "error");
    assert_eq!(failed["place"], "test-place");
    assert_eq!(LOADS.load(SeqCst), loads + 1);
    assert_eq!(GLOBE_BUILDS.load(SeqCst), globes);
    FAIL_SCENE.store(false, SeqCst);
    app.command(br#"{"quality":0}"#);
    assert_eq!(unsafe { presented(&mut app) }["state"], "running");

    // Old quality 2 checkpoints map to the same working set and resolution as
    // quality 0. The button skips that duplicate and offers only real profiles.
    let loads = LOADS.load(SeqCst);
    let builds = BUILDS.load(SeqCst);
    app.command(br#"{"quality":2,"renderWidth":0}"#);
    let legacy = unsafe { presented(&mut app) };
    assert_eq!(legacy["renderWidth"], 480);
    assert_eq!(legacy["qualityProfile"], "optimized");
    assert_eq!(LOADS.load(SeqCst), loads);
    assert_eq!(BUILDS.load(SeqCst), builds);
    for (quality, width) in [(1, 960), (0, 480)] {
        app.action(8);
        let selected = unsafe { presented(&mut app) };
        assert_eq!(selected["quality"], quality);
        assert_eq!(selected["renderWidth"], width);
    }

    // Present/backpressure and CPU cost are not permission to shrink quality.
    // Preserve the bad cadence in the report instead of hiding it at 160 px.
    for _ in 0..140 {
        unsafe {
            app.frame(1.0 / 30.0, 480, 320, 1);
            app.frame_completed(22.0, 90.0, 112.0);
        }
    }
    unsafe {
        app.refresh_status();
    }
    let overloaded: serde_json::Value = serde_json::from_slice(app.status.as_bytes()).unwrap();
    assert_eq!(overloaded["renderWidth"], 480);
    assert_eq!(overloaded["renderHeight"], 320);
    assert_eq!(overloaded["frameTiming"]["workMs"]["overBudget"], 120);
    assert_eq!(overloaded["frameTiming"]["intervalMs"]["p95"], 112.0);
    assert!(overloaded["fps"].as_f64().unwrap() < 9.0);

    // JSON construction is deferred until publication; timings and UI values
    // still advance, and a command is acknowledged only after presentation.
    let old_status = app.status.clone();
    app.command(br#"{"nonce":"presented"}"#);
    unsafe {
        app.frame(1.0 / 30.0, 480, 320, 1);
        app.frame_completed(5.0, 1.0, 1000.0 / 30.0);
    }
    assert_eq!(
        app.status, old_status,
        "a completed frame must not serialize JSON"
    );
    unsafe {
        app.refresh_status();
    }
    let published: serde_json::Value = serde_json::from_slice(app.status.as_bytes()).unwrap();
    assert_eq!(published["lastCommand"], "presented");
    assert!(
        published["frame"].as_u64().unwrap()
            > serde_json::from_slice::<serde_json::Value>(old_status.as_bytes()).unwrap()["frame"]
                .as_u64()
                .unwrap()
    );
    unsafe {
        app.frame(1.0 / 30.0, 480, 320, 1);
        app.frame_completed(5.0, 1.0, 1000.0 / 30.0);
    }
    app.command(br#"{"nonce":"preempted","place":"test-place"}"#);
    unsafe {
        app.suspend();
        app.refresh_status();
    }
    let suspended: serde_json::Value = serde_json::from_slice(app.status.as_bytes()).unwrap();
    assert_eq!(suspended["state"], "suspended");
    assert_eq!(
        suspended["lastCommand"], "presented",
        "backgrounding cannot acknowledge an unpresented command"
    );
    assert_eq!(suspended["gpuBytes"], 0);
    assert!(suspended["renderingProfile"].is_null());
    app.command(br#"{"place":"atlas"}"#);
    let resumed = unsafe { presented(&mut app) };
    assert_eq!(resumed["state"], "running");
    assert_eq!(resumed["lastCommand"], "preempted");
}
