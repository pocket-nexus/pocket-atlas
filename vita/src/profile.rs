//! Render profiles: a GPU frame budget and the image quality spent to meet
//! it on the Vita (SGX543MP4+ at 222 MHz, CPU at 444 MHz).
//!
//! Costs measured on the device that set the numbers below (Konbini view):
//! geometry runs at about 25 M triangles/s; material shading at about 1.3
//! shader instructions per core cycle; a full-screen 960×544 blit takes
//! 1.4 ms; the tone-mapping composite 5.2 ms at 640×362; one haze light
//! 1.3 ms per 32 k pixels; the planar reflection 4–10 ms with its own
//! geometry pass.
//!
//! A profile fixes what needs render targets or program variants of its
//! own (reflection and haze sizes, bloom chain, material tiers, particle
//! counts). Its quality steps are what the governor trades at run time:
//! scene resolution first, then LOD and detail distances.

use pocket3d_gxm::target::Msaa;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    /// Scene resolution level (index into `frame::SCALES`).
    pub level: usize,
    /// A draw switches to its LOD1 once that LOD's error projects under
    /// this many scene pixels.
    pub lod_pixels: f32,
    /// Lit draws beyond this distance (m) use the FAR material variant.
    pub detail_m: f32,
    /// Main-pass draws whose bounding radius is under this fraction of their
    /// distance are skipped (a few pixels on screen).
    pub cull_size: f32,
    /// Lit haze and bloom, the first effects a 60 fps step gives up.
    pub haze: bool,
    pub bloom: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Profile {
    pub name: &'static str,
    /// Frame period the governor holds (ms): a multiple of the 16.7 ms
    /// display refresh.
    pub budget_ms: f32,
    /// Quality steps, best first.
    pub steps: &'static [Step],
    pub msaa: Msaa,
    /// Reflection target: 0 = 480×272, 1 = 240×136 (blurred copy at half
    /// that). The mirror pass skips draws whose radius is below
    /// `reflection_min_size` × their distance.
    pub reflection_size: usize,
    pub reflection_min_size: f32,
    /// Haze buffer: 0 = 160×90, 1 = 120×68; lights integrated per pixel.
    pub haze_size: usize,
    pub haze_lights: usize,
    /// Bloom chain from quarter resolution (two levels) or from an eighth
    /// (one level).
    pub bloom_full: bool,
    /// Rain streak quads, and whether the steam vents draw.
    pub streaks: u32,
    pub steam: bool,
    /// Per-pixel lights per draw for moving sources (static light is baked).
    pub dynamic_lights: usize,
    /// Near materials keep normal, ORM and rain-streak maps; without them
    /// every draw inside the detail distance uses the LITE variant.
    pub detail_maps: bool,
    /// Redraw reflection and haze on alternate frames while the camera is
    /// slow.
    pub alternate: bool,
}

/// The full effect set, around 20 fps.
pub const CINEMATIC: Profile = Profile {
    name: "cinematic",
    budget_ms: 50.0,
    steps: &[
        Step { level: 0, lod_pixels: 0.75, detail_m: 18.0, cull_size: 0.0, haze: true, bloom: true },
        Step { level: 1, lod_pixels: 1.0, detail_m: 12.0, cull_size: 0.0, haze: true, bloom: true },
        Step { level: 2, lod_pixels: 1.5, detail_m: 12.0, cull_size: 0.0, haze: true, bloom: true },
    ],
    msaa: Msaa::X4,
    reflection_size: 0,
    reflection_min_size: 0.06,
    haze_size: 0,
    haze_lights: 6,
    bloom_full: true,
    streaks: 7000,
    steam: true,
    dynamic_lights: 4,
    detail_maps: true,
    alternate: true,
};

/// 60 fps. Measured on the device (Konbini view, 544×308): haze costs
/// 1.2 ms per frame, bloom 2.2 ms, and the lowest step reaches the budget
/// with neither at 480×272. Lighter views keep more.
pub const VITA60: Profile = Profile {
    name: "vita60",
    budget_ms: 16.7,
    steps: &[
        Step { level: 1, lod_pixels: 1.0, detail_m: 10.0, cull_size: 0.004, haze: true, bloom: true },
        Step { level: 2, lod_pixels: 1.5, detail_m: 8.0, cull_size: 0.006, haze: true, bloom: true },
        Step { level: 3, lod_pixels: 2.0, detail_m: 6.0, cull_size: 0.008, haze: true, bloom: true },
        Step { level: 3, lod_pixels: 2.5, detail_m: 5.0, cull_size: 0.01, haze: false, bloom: true },
        Step { level: 3, lod_pixels: 3.0, detail_m: 4.0, cull_size: 0.012, haze: false, bloom: false },
        Step { level: 4, lod_pixels: 3.0, detail_m: 4.0, cull_size: 0.015, haze: false, bloom: false },
    ],
    msaa: Msaa::X4,
    reflection_size: 1,
    reflection_min_size: 0.1,
    haze_size: 1,
    haze_lights: 2,
    bloom_full: false,
    streaks: 1500,
    steam: false,
    dynamic_lights: 2,
    detail_maps: false,
    alternate: true,
};

pub const ALL: [&Profile; 2] = [&VITA60, &CINEMATIC];

pub fn by_name(name: &str) -> Option<&'static Profile> {
    ALL.into_iter().find(|p| p.name == name)
}

/// Walks a profile's quality steps to hold its frame period. Frames are
/// paced by the display refresh, so a frame that fits shows as exactly the
/// period and headroom is invisible: the governor steps down after sustained
/// misses and probes one step up after holding the period, backing off
/// (doubling the wait) each time a probe misses.
pub struct Governor {
    pub step: usize,
    /// Measurements pin the step.
    pub hold: bool,
    held: u32,
    probing: bool,
    /// Frames to hold before probing the step above each step.
    wait: [u32; 8],
}

impl Governor {
    pub fn new() -> Self {
        Self { step: 0, hold: false, held: 0, probing: false, wait: [90; 8] }
    }

    /// `frame_ms`: smoothed frame time.
    pub fn feedback(&mut self, profile: &Profile, frame_ms: f32) {
        if self.hold {
            return;
        }
        self.held += 1;
        let over = frame_ms > profile.budget_ms * 1.06;
        if over && self.held >= 10 && self.step + 1 < profile.steps.len() {
            if self.probing {
                self.wait[self.step] = (self.wait[self.step] * 2).min(3600);
            }
            self.step += 1;
            self.held = 0;
            self.probing = false;
        } else if !over && self.step > 0 && self.held >= self.wait[self.step - 1] {
            self.step -= 1;
            self.held = 0;
            self.probing = true;
        } else if self.probing && self.held > 45 {
            self.probing = false;
        }
    }
}
