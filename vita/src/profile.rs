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
    /// A draw switches to a coarser LOD once that LOD's error projects
    /// under this many scene pixels.
    pub lod_pixels: f32,
    /// Lit draws beyond this distance (m) use the FAR material variant.
    pub detail_m: f32,
    /// Main-pass draws whose bounding radius is under this fraction of their
    /// distance are skipped (a few pixels on screen).
    pub cull_size: f32,
    /// Lit haze: off, or its buffer (0 = 160×90, 1 = 120×68) and the lights
    /// integrated per pixel (2, 4 or 6).
    pub haze: bool,
    pub haze_size: usize,
    pub haze_lights: usize,
    /// Bloom, from a quarter of 960×544 (two levels) or an eighth (one).
    pub bloom: bool,
    pub bloom_full: bool,
}

impl Step {
    const fn new(level: usize, lod_pixels: f32, detail_m: f32, cull_size: f32) -> Self {
        Self { level, lod_pixels, detail_m, cull_size, haze: true, haze_size: 0, haze_lights: 6, bloom: true, bloom_full: true }
    }

    const fn haze(self, size: usize, lights: usize) -> Self {
        Self { haze_size: size, haze_lights: lights, ..self }
    }

    const fn no_haze(self) -> Self {
        Self { haze: false, ..self }
    }

    const fn bloom(self, full: bool) -> Self {
        Self { bloom_full: full, ..self }
    }

    const fn no_bloom(self) -> Self {
        Self { bloom: false, ..self }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Profile {
    pub name: &'static str,
    /// Frame period the governor holds (ms): a multiple of the 16.7 ms
    /// display refresh; frames are shown at that period.
    pub budget_ms: f32,
    /// Quality steps, best first.
    pub steps: &'static [Step],
    pub msaa: Msaa,
    /// Reflection target: 0 = 480×272, 1 = 240×136 (blurred copy at half
    /// that). The mirror pass skips draws whose radius is below
    /// `reflection_min_size` × their distance.
    pub reflection_size: usize,
    pub reflection_min_size: f32,
    /// Rain streak quads, and whether the steam vents draw.
    pub streaks: u32,
    pub steam: bool,
    /// Per-pixel lights per draw (baked draws light only moving sources,
    /// at most one).
    pub dynamic_lights: usize,
    /// Near materials keep normal, ORM and rain-streak maps; without them
    /// every draw inside the detail distance uses the LITE variant.
    pub detail_maps: bool,
    /// Redraw reflection and haze on alternate frames while the camera is
    /// slow.
    pub alternate: bool,
    /// Moving and skinned meshes (people, the taxi) take their lights per
    /// vertex, diffuse only: they are dense, and 4 per-pixel lights on a
    /// pedestrian near the camera cost ~15 ms at 480×272.
    pub vertex_lights: bool,
}

/// The full effect set, around 20 fps.
pub const CINEMATIC: Profile = Profile {
    name: "cinematic",
    budget_ms: 50.0,
    steps: &[Step::new(0, 0.75, 18.0, 0.0), Step::new(1, 1.0, 12.0, 0.0), Step::new(2, 1.5, 12.0, 0.0)],
    msaa: Msaa::X4,
    reflection_size: 0,
    reflection_min_size: 0.06,
    streaks: 7000,
    steam: true,
    dynamic_lights: 4,
    detail_maps: true,
    alternate: true,
    vertex_lights: false,
};

/// 60 fps. Measured on the device (Konbini view, 544×308): haze costs
/// 1.2 ms per frame, bloom 2.2 ms, and the lowest step reaches the budget
/// with neither at 480×272. Lighter views keep more.
pub const VITA60: Profile = Profile {
    name: "vita60",
    budget_ms: 16.7,
    steps: &[
        Step::new(1, 1.0, 10.0, 0.004).haze(1, 2).bloom(false),
        Step::new(2, 1.5, 8.0, 0.006).haze(1, 2).bloom(false),
        Step::new(3, 2.0, 6.0, 0.008).haze(1, 2).bloom(false),
        Step::new(3, 2.5, 5.0, 0.01).no_haze().bloom(false),
        Step::new(3, 3.0, 4.0, 0.012).no_haze().no_bloom(),
        Step::new(4, 3.0, 4.0, 0.015).no_haze().no_bloom(),
    ],
    msaa: Msaa::X4,
    reflection_size: 1,
    reflection_min_size: 0.1,
    streaks: 1500,
    steam: false,
    dynamic_lights: 2,
    detail_maps: false,
    alternate: true,
    vertex_lights: true,
};

/// 30 fps at 480×272 (the display doubles it to 960×544): the full effect
/// set, with rain on the street, haze and bloom. Measured on the device at
/// step 0 (serialized GPU time): 31–41 ms across the shots, with a passing
/// car's headlights adding ~8 ms. The governor gives up LOD and detail
/// distance, then haze lights and resolution, then the bloom chain, and
/// haze last. Reflection and haze redraw every frame, so a moving camera
/// costs what a still one does.
pub const VITA30: Profile = Profile {
    name: "vita30",
    budget_ms: 33.3,
    steps: &[
        Step::new(4, 1.0, 8.0, 0.0),
        Step::new(4, 1.5, 6.0, 0.002).haze(0, 4),
        Step::new(4, 2.0, 5.0, 0.004).haze(1, 4),
        Step::new(4, 2.5, 4.0, 0.006).haze(1, 4).bloom(false),
        Step::new(4, 3.0, 4.0, 0.008).no_haze().bloom(false),
    ],
    msaa: Msaa::X4,
    reflection_size: 1,
    reflection_min_size: 0.06,
    streaks: 7000,
    steam: true,
    dynamic_lights: 4,
    detail_maps: true,
    alternate: false,
    vertex_lights: true,
};

pub const ALL: [&Profile; 3] = [&VITA30, &VITA60, &CINEMATIC];

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
