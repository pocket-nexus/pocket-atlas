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
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Profile {
    pub name: &'static str,
    /// GPU time per frame the governor holds (ms).
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
    budget_ms: 55.0,
    steps: &[
        Step { level: 0, lod_pixels: 0.75, detail_m: 18.0 },
        Step { level: 1, lod_pixels: 1.0, detail_m: 12.0 },
        Step { level: 2, lod_pixels: 1.5, detail_m: 12.0 },
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

/// 60 fps: 15.5 ms of GPU work leaves room for the display flip.
pub const VITA60: Profile = Profile {
    name: "vita60",
    budget_ms: 15.5,
    steps: &[
        Step { level: 1, lod_pixels: 1.0, detail_m: 10.0 },
        Step { level: 2, lod_pixels: 1.5, detail_m: 8.0 },
        Step { level: 2, lod_pixels: 2.5, detail_m: 6.0 },
        Step { level: 3, lod_pixels: 3.0, detail_m: 5.0 },
    ],
    msaa: Msaa::X4,
    reflection_size: 1,
    reflection_min_size: 0.1,
    haze_size: 1,
    haze_lights: 4,
    bloom_full: false,
    streaks: 3000,
    steam: false,
    dynamic_lights: 2,
    detail_maps: false,
    alternate: true,
};

pub const ALL: [&Profile; 2] = [&VITA60, &CINEMATIC];

pub fn by_name(name: &str) -> Option<&'static Profile> {
    ALL.into_iter().find(|p| p.name == name)
}

/// Walks a profile's quality steps to hold its budget.
pub struct Governor {
    pub step: usize,
    held: u32,
}

impl Governor {
    pub fn new() -> Self {
        Self { step: 0, held: 0 }
    }

    /// `gpu_ms`: frame time without the display-flip wait. Steps down a
    /// quality step when over budget, back up when under 80 % of it, each
    /// step held at least 20 frames.
    pub fn feedback(&mut self, profile: &Profile, gpu_ms: f32) {
        self.held += 1;
        if self.held < 20 {
            return;
        }
        if gpu_ms > profile.budget_ms * 1.04 && self.step + 1 < profile.steps.len() {
            self.step += 1;
            self.held = 0;
        } else if gpu_ms < profile.budget_ms * 0.8 && self.step > 0 {
            self.step -= 1;
            self.held = 0;
        }
    }
}
