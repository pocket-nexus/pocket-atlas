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

use pocket_vita_gxm::target::Msaa;

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
    /// Resolution levels above step 0's, nearest first, that the governor
    /// climbs to while the measured GPU time leaves room (see `Governor`).
    pub boost: &'static [usize],
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
    boost: &[],
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
    boost: &[],
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
    // 544×308 and 640×362. Measured at Griffith Observatory (serialized GPU
    // at step 0): the Lawn takes 20.8, 22.7, 25.0 and 27.8 ms from 480×272
    // to 720×408; the main pass grows ~2.2 ms per 480×272 of pixels and the
    // composite with it, the bloom chain not at all. 720×408 rendered for
    // minutes without a fault but leaves the Lawn no headroom while running
    // (its frames finish at the refresh), and both device hangs of its
    // first tests came in sessions that had made its targets: left out
    // until a hang-free run proves it.
    boost: &[3, 2],
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
///
/// Above step 0 it climbs the profile's `boost` resolutions on the GPU time
/// it measures (each frame's completion, polled while the CPU waits for the
/// refresh): one level once the time predicted there — the measured time ×
/// (1 + 0.35 × (pixel ratio − 1)), the share that grows with pixels at
/// Griffith Observatory being 0.26 — stays under 80 % of the period for two
/// seconds; one level down after 3 slipped frames or a smoothed GPU time
/// over 92 % of the period, and the wait before the next climb doubles.
/// A place that never predicts under 80 % (the konbini) never climbs.
pub struct Governor {
    pub step: usize,
    /// Measurements pin the step.
    pub hold: bool,
    held: u32,
    probing: bool,
    /// Frames to hold before probing the step above each step.
    wait: [u32; 8],
    /// Boost resolutions climbed (0: step 0's own), the most allowed (video
    /// memory), frames held at the current one, frames to hold before the
    /// next climb, consecutive slipped frames.
    pub boost: usize,
    pub boost_cap: usize,
    boost_held: u32,
    boost_wait: u32,
    slips: u32,
    /// Smoothed GPU frame time (ms), 0 before the first measurement.
    pub gpu_ms: f32,
}

/// Pixels of a resolution level (`frame::SCALES`).
fn pixels(level: usize) -> f32 {
    let (w, h) = crate::frame::SCALES[level.min(crate::frame::SCALES.len() - 1)];
    (w * h) as f32
}

impl Governor {
    pub fn new() -> Self {
        Self { step: 0, hold: false, held: 0, probing: false, wait: [90; 8], boost: 0, boost_cap: usize::MAX, boost_held: 0, boost_wait: 60, slips: 0, gpu_ms: 0.0 }
    }

    /// The resolution level the governor holds: a boost level, or the step's.
    pub fn level(&self, profile: &Profile) -> usize {
        if self.step == 0 && self.boost > 0 { profile.boost[self.boost - 1] } else { profile.steps[self.step.min(profile.steps.len() - 1)].level }
    }

    /// `frame_ms`: smoothed frame time; `gpu_ms`: this frame's GPU time, or
    /// None when it did not finish before the refresh it was due at.
    /// `boost`: whether resolution boosts are allowed (not with a fixed
    /// resolution). Returns true when it climbed to a new boost level (its
    /// targets must be made).
    pub fn feedback(&mut self, profile: &Profile, frame_ms: f32, gpu_ms: Option<f32>, raw_ms: f32, boost: bool) -> bool {
        if self.hold {
            return false;
        }
        if !boost {
            self.boost = 0;
        }
        let g = gpu_ms.unwrap_or(profile.budget_ms);
        self.gpu_ms = if self.gpu_ms == 0.0 { g } else { self.gpu_ms * 0.9 + g * 0.1 };
        if self.boost > 0 {
            self.slips = if raw_ms > profile.budget_ms * 1.06 { self.slips + 1 } else { 0 };
            if self.slips >= 3 || self.gpu_ms > profile.budget_ms * 0.92 {
                let from = self.level(profile);
                self.boost -= 1;
                self.gpu_ms *= pixels(self.level(profile)) / pixels(from);
                self.boost_held = 0;
                self.boost_wait = (self.boost_wait * 2).min(3600);
                self.slips = 0;
                return false;
            }
            self.boost_held += 1;
        } else if self.step == 0 && !self.probing {
            self.boost_held += 1;
        } else {
            self.boost_held = 0;
        }
        if boost && self.step == 0 && self.boost < profile.boost.len().min(self.boost_cap) && self.boost_held >= self.boost_wait && gpu_ms.is_some() {
            let (from, to) = (self.level(profile), profile.boost[self.boost]);
            let predicted = self.gpu_ms * (1.0 + 0.35 * (pixels(to) / pixels(from) - 1.0));
            if predicted <= profile.budget_ms * 0.8 {
                self.boost += 1;
                self.gpu_ms = predicted;
                self.boost_held = 0;
                return true;
            }
        }
        if self.boost > 0 {
            return false;
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
        false
    }
}
