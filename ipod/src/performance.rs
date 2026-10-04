//! Completed-frame wall times, independent of UIKit callbacks and GPU pass
//! profiling. Recording only appends to fixed windows; distributions are sorted
//! when status is requested. Frame/present time never changes render resolution:
//! the device profile has a fixed 480x320 floor, including low-memory fallback.
use alloc::collections::BTreeMap;
use serde::Serialize;

pub const WINDOW: usize = 120;
pub const FRAME_BUDGET_MS: f32 = 1000.0 / 30.0;
pub const WORK_TARGET_MS: f32 = 27.0;

#[derive(Clone)]
struct Samples {
    values: [f32; WINDOW],
    count: usize,
    next: usize,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub samples: usize,
    pub mean: f32,
    pub p95: f32,
    pub max: f32,
    pub over_budget: usize,
}

impl Samples {
    fn new() -> Self {
        Self {
            values: [0.0; WINDOW],
            count: 0,
            next: 0,
        }
    }

    fn push(&mut self, ms: f32) {
        self.values[self.next] = ms;
        self.next = (self.next + 1) % WINDOW;
        self.count = (self.count + 1).min(WINDOW);
    }

    fn summary(&self) -> Summary {
        if self.count == 0 {
            return Summary {
                samples: 0,
                mean: 0.0,
                p95: 0.0,
                max: 0.0,
                over_budget: 0,
            };
        }
        let mut sorted = self.values;
        let values = &mut sorted[..self.count];
        values.sort_unstable_by(f32::total_cmp);
        Summary {
            samples: self.count,
            mean: (values.iter().map(|&value| value as f64).sum::<f64>() / self.count as f64)
                as f32,
            p95: values[(self.count * 95).div_ceil(100) - 1],
            max: values[self.count - 1],
            over_budget: values.iter().filter(|&&ms| ms > FRAME_BUDGET_MS).count(),
        }
    }
}

pub struct FrameTimings {
    render: Samples,
    present: Samples,
    work: Samples,
    interval: Samples,
    presented: u64,
    excluded: u64,
    first_interval: bool,
    passes: PassTimings,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PassKind {
    Scene,
    Globe,
}

impl PassKind {
    fn names(self) -> &'static [&'static str] {
        match self {
            Self::Scene => &[
                "shadow",
                "mirror",
                "main",
                "geometryEffects",
                "post",
                "mesh",
                "postEffects",
                "grade",
                "blit",
                "wetResponse",
                "waterResponse",
            ],
            Self::Globe => &["background", "surface", "markers", "post", "grade", "blit"],
        }
    }
}

struct PassTimings {
    identity: Option<(PassKind, bool)>,
    stages: [Samples; 11],
}
impl PassTimings {
    fn new() -> Self {
        Self {
            identity: None,
            stages: core::array::from_fn(|_| Samples::new()),
        }
    }
    fn record(&mut self, kind: PassKind, profile: bool, values: &[f32]) {
        if values.len() != kind.names().len() || values.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return;
        }
        if self.identity != Some((kind, profile)) {
            *self = Self::new();
            self.identity = Some((kind, profile));
        }
        for (stage, &value) in self.stages.iter_mut().zip(values) {
            stage.push(value);
        }
    }
    fn report(&self) -> Option<PassTimingReport> {
        self.identity.map(|(kind, profile)| PassTimingReport {
            source: "render-worker-after-present",
            kind,
            profile,
            timing_kind: if profile {
                "synchronized-gpu-and-cpu"
            } else {
                "submission-and-blocking-waits"
            },
            window_capacity: WINDOW,
            stages_ms: kind
                .names()
                .iter()
                .zip(&self.stages)
                .map(|(&name, samples)| (name, samples.summary()))
                .collect(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassTimingReport {
    pub source: &'static str,
    pub kind: PassKind,
    pub profile: bool,
    pub timing_kind: &'static str,
    pub window_capacity: usize,
    pub stages_ms: BTreeMap<&'static str, Summary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingReport {
    pub source: &'static str,
    pub window_capacity: usize,
    pub presented_frames: u64,
    pub excluded_frames: u64,
    pub render_ms: Summary,
    pub present_ms: Summary,
    pub work_ms: Summary,
    pub interval_ms: Summary,
}

impl FrameTimings {
    pub fn new() -> Self {
        Self {
            render: Samples::new(),
            present: Samples::new(),
            work: Samples::new(),
            interval: Samples::new(),
            presented: 0,
            excluded: 0,
            first_interval: true,
            passes: PassTimings::new(),
        }
    }

    pub fn reset_window(&mut self) {
        self.render = Samples::new();
        self.present = Samples::new();
        self.work = Samples::new();
        self.interval = Samples::new();
        self.first_interval = true;
        self.passes = PassTimings::new();
    }

    pub fn record(&mut self, render: f32, present: f32, interval: f32, excluded: bool) -> bool {
        self.presented += 1;
        if excluded
            || !render.is_finite()
            || !present.is_finite()
            || !interval.is_finite()
            || render < 0.0
            || present < 0.0
            || interval < 0.0
        {
            self.excluded += 1;
            self.first_interval = true;
            return false;
        }
        self.render.push(render);
        self.present.push(present);
        self.work.push(render + present);
        if !self.first_interval && interval > 0.0 {
            self.interval.push(interval);
        }
        self.first_interval = false;
        true
    }

    pub fn report(&self) -> TimingReport {
        TimingReport {
            source: "render-worker-present",
            window_capacity: WINDOW,
            presented_frames: self.presented,
            excluded_frames: self.excluded,
            render_ms: self.render.summary(),
            present_ms: self.present.summary(),
            work_ms: self.work.summary(),
            interval_ms: self.interval.summary(),
        }
    }

    pub fn record_passes(&mut self, kind: PassKind, profile: bool, values: &[f32]) {
        self.passes.record(kind, profile, values);
    }

    pub fn pass_report(&self) -> Option<PassTimingReport> {
        self.passes.report()
    }
}

pub const SCENE_WIDTH: i32 = 480;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pass_windows_exclude_capture_and_reset_with_profile_kind_and_frame_window() {
        let mut timings = FrameTimings::new();
        for i in 0..125 {
            let valid = timings.record(12.0, 1.0, 33.0, i == 124);
            if valid {
                let slow = if i % 10 == 0 { 50.0 } else { 10.0 };
                timings.record_passes(
                    PassKind::Scene,
                    true,
                    &[0.0, 2.0, slow, 4.0, 6.0, slow, 1.0, 2.0, 3.0, 5.0, 7.0],
                );
            }
        }
        let report = timings.pass_report().unwrap();
        assert!(report.profile);
        assert_eq!(report.timing_kind, "synchronized-gpu-and-cpu");
        assert_eq!(report.stages_ms.len(), 11);
        assert_eq!(report.stages_ms["mesh"].samples, WINDOW);
        assert_eq!(report.stages_ms["mesh"].mean, 14.0);
        assert_eq!(report.stages_ms["mesh"].p95, 50.0);
        assert_eq!(report.stages_ms["grade"].mean, 2.0);
        assert_eq!(timings.report().excluded_frames, 1);
        timings.reset_window();
        assert!(timings.pass_report().is_none());
        timings.record_passes(PassKind::Scene, false, &[1.0; 11]);
        assert_eq!(timings.pass_report().unwrap().stages_ms["mesh"].samples, 1);
        timings.record_passes(PassKind::Scene, true, &[2.0; 11]);
        assert_eq!(timings.pass_report().unwrap().stages_ms["mesh"].samples, 1);
        timings.record_passes(PassKind::Globe, true, &[3.0; 6]);
        let report = timings.pass_report().unwrap();
        assert_eq!(report.stages_ms.len(), 6);
        assert_eq!(report.stages_ms["surface"].samples, 1);
        assert_eq!(report.stages_ms["surface"].mean, 3.0);
        timings.record_passes(PassKind::Globe, true, &[f32::NAN; 6]);
        assert_eq!(
            timings.pass_report().unwrap().stages_ms["surface"].samples,
            1
        );
    }

    #[test]
    fn completed_cadence_is_separate_from_work_and_reports_tail_misses() {
        let mut timings = FrameTimings::new();
        for i in 0..121 {
            timings.record(if i % 10 == 0 { 40.0 } else { 15.0 }, 2.0, 33.5, false);
        }
        let report = timings.report();
        assert_eq!(report.presented_frames, 121);
        assert_eq!(report.work_ms.samples, 120);
        assert_eq!(report.work_ms.p95, 42.0);
        assert_eq!(report.work_ms.max, 42.0);
        assert_eq!(report.work_ms.over_budget, 12);
        assert_eq!(report.interval_ms.mean, 33.5);
        assert_eq!(report.render_ms.max, 40.0);
        assert_eq!(report.present_ms.mean, 2.0);
    }

    #[test]
    fn loading_capture_and_resume_gaps_do_not_contaminate_windows() {
        let mut timings = FrameTimings::new();
        timings.record(5000.0, 20.0, 10000.0, true);
        timings.record(15.0, 1.0, 8000.0, false);
        timings.record(15.0, 1.0, 33.0, false);
        assert_eq!(timings.report().interval_ms.samples, 1);
        timings.reset_window();
        timings.record(20.0, 1.0, 90000.0, false);
        assert_eq!(timings.report().interval_ms.samples, 0);
        timings.record(20.0, 1.0, -1.0, false);
        assert_eq!(timings.report().excluded_frames, 2);
        assert_eq!(timings.report().presented_frames, 5);
        assert_eq!(timings.report().work_ms.max, 21.0);
    }

}
