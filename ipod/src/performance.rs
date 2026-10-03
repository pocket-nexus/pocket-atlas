//! Completed-frame wall times, independent of UIKit callbacks and GPU pass
//! profiling. A bounded window reports actual presentation cadence separately
//! from work time. Resolution increases are single-step trials, judged by a
//! fresh completed-frame window rather than scaling present/vsync waits by
//! pixel count. A failed trial rolls back and cools down before trying again.
use alloc::collections::BTreeMap;
use serde::Serialize;

pub const WINDOW: usize = 120;
pub const FRAME_BUDGET_MS: f32 = 1000.0 / 30.0;
pub const WORK_TARGET_MS: f32 = 27.0;
const WIDTHS: [i32; 7] = [160, 192, 256, 320, 400, 480, 640];
const PROBE_COOLDOWN: usize = WINDOW * 2;

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
            ],
            Self::Globe => &["background", "surface", "markers", "post", "grade", "blit"],
        }
    }
}

struct PassTimings {
    identity: Option<(PassKind, bool)>,
    stages: [Samples; 9],
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

    pub fn cadence(&self) -> Summary {
        self.interval.summary()
    }

    pub fn record_passes(&mut self, kind: PassKind, profile: bool, values: &[f32]) {
        self.passes.record(kind, profile, values);
    }

    pub fn pass_report(&self) -> Option<PassTimingReport> {
        self.passes.report()
    }
}

pub struct ResolutionController {
    step: usize,
    samples: Samples,
    over_budget_streak: usize,
    probe_from: Option<usize>,
    cooldown: usize,
}

impl ResolutionController {
    pub fn new() -> Self {
        Self {
            step: 3,
            samples: Samples::new(),
            over_budget_streak: 0,
            probe_from: None,
            cooldown: 0,
        }
    }

    pub fn memory_pressure(&mut self) {
        self.step = 0;
        self.probe_from = None;
        self.cooldown = PROBE_COOLDOWN;
        self.reset_samples();
    }

    pub fn width(&self) -> i32 {
        WIDTHS[self.step]
    }

    pub fn reset_samples(&mut self) {
        // App calls this when it resizes the actual target. Keep the pending
        // trial and cooldown; the new target still needs its own full window.
        // A place/quality change constructs a new controller instead.
        self.samples = Samples::new();
        self.over_budget_streak = 0;
    }

    fn back_off(&mut self) {
        self.step = self
            .probe_from
            .take()
            .unwrap_or(self.step.saturating_sub(1));
        self.cooldown = PROBE_COOLDOWN;
        self.reset_samples();
    }

    pub fn observe(&mut self, work_ms: f32, cadence: &Summary) {
        if !work_ms.is_finite() || work_ms < 0.0 {
            return;
        }
        self.cooldown = self.cooldown.saturating_sub(1);
        self.samples.push(work_ms);
        self.over_budget_streak = if work_ms > FRAME_BUDGET_MS {
            self.over_budget_streak + 1
        } else {
            0
        };
        let stats = self.samples.summary();
        let full_window = stats.samples == WINDOW && cadence.samples == WINDOW;
        let cadence_on_budget = cadence.mean <= FRAME_BUDGET_MS && cadence.p95 <= FRAME_BUDGET_MS;
        let work_on_budget = stats.mean <= FRAME_BUDGET_MS && stats.p95 <= FRAME_BUDGET_MS;
        let overloaded =
            self.over_budget_streak >= 3 || (stats.samples >= 12 && stats.mean > FRAME_BUDGET_MS);

        if self.probe_from.is_some() {
            if overloaded {
                self.back_off();
            } else if full_window {
                if cadence_on_budget && work_on_budget {
                    self.probe_from = None;
                    // No immediate second promotion using this same window.
                    self.reset_samples();
                } else {
                    self.back_off();
                }
            }
            return;
        }

        if self.step > 0
            && (overloaded || (full_window && !cadence_on_budget && stats.mean > WORK_TARGET_MS))
        {
            // 27 ms is a headroom target, not a hard work-time limit:
            // present can wait until vsync even when rendering finishes early.
            // Stable 30 Hz completion must not trigger endless downshifts.
            self.back_off();
        } else if self.step + 1 < WIDTHS.len()
            && self.cooldown == 0
            && full_window
            && cadence_on_budget
            && work_on_budget
        {
            // Work includes fixed driver/vsync waits; multiplying it by the
            // pixel-area ratio can prevent even perfect 60 Hz from upgrading.
            // Probe one step instead, then accept only measured 30 FPS evidence.
            self.probe_from = Some(self.step);
            self.step += 1;
            self.reset_samples();
        }
    }
}

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
                    &[0.0, 2.0, slow, 4.0, 6.0, slow, 1.0, 2.0, 3.0],
                );
            }
        }
        let report = timings.pass_report().unwrap();
        assert!(report.profile);
        assert_eq!(report.timing_kind, "synchronized-gpu-and-cpu");
        assert_eq!(report.stages_ms.len(), 9);
        assert_eq!(report.stages_ms["mesh"].samples, WINDOW);
        assert_eq!(report.stages_ms["mesh"].mean, 14.0);
        assert_eq!(report.stages_ms["mesh"].p95, 50.0);
        assert_eq!(report.stages_ms["grade"].mean, 2.0);
        assert_eq!(timings.report().excluded_frames, 1);
        timings.reset_window();
        assert!(timings.pass_report().is_none());
        timings.record_passes(PassKind::Scene, false, &[1.0; 9]);
        assert_eq!(timings.pass_report().unwrap().stages_ms["mesh"].samples, 1);
        timings.record_passes(PassKind::Scene, true, &[2.0; 9]);
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

    fn steady_cadence() -> Summary {
        Summary {
            samples: WINDOW,
            mean: FRAME_BUDGET_MS,
            p95: FRAME_BUDGET_MS,
            max: FRAME_BUDGET_MS,
            over_budget: 0,
        }
    }

    #[test]
    fn promotion_requires_a_fresh_full_window_with_on_budget_mean_and_tail() {
        let mut controller = ResolutionController::new();
        for cadence in [
            Summary {
                samples: WINDOW - 1,
                ..steady_cadence()
            },
            Summary {
                mean: FRAME_BUDGET_MS + 1.0,
                ..steady_cadence()
            },
            Summary {
                p95: FRAME_BUDGET_MS + 1.0,
                ..steady_cadence()
            },
        ] {
            for _ in 0..121 {
                controller.observe(1.0, &cadence);
            }
            assert_eq!(controller.width(), 320);
        }
        controller.observe(1.0, &steady_cadence());
        assert_eq!(controller.width(), 400);
        let mut timings = FrameTimings::new();
        for _ in 0..121 {
            timings.record(1.0, 0.0, FRAME_BUDGET_MS, false);
        }
        timings.reset_window();
        controller.reset_samples();
        for _ in 0..120 {
            timings.record(1.0, 0.0, FRAME_BUDGET_MS, false);
            controller.observe(1.0, &timings.report().interval_ms);
        }
        assert_eq!(
            controller.width(),
            400,
            "pre-resize samples cannot permit promotion"
        );
        timings.record(1.0, 0.0, FRAME_BUDGET_MS, false);
        controller.observe(1.0, &timings.report().interval_ms);
        assert_eq!(controller.width(), 400);
        assert_eq!(
            controller.probe_from, None,
            "the new window accepts only this trial"
        );
        for _ in 0..WINDOW {
            controller.observe(1.0, &steady_cadence());
        }
        assert_eq!(controller.width(), 480);
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

    #[test]
    fn controller_drops_promptly_but_never_below_floor() {
        let mut controller = ResolutionController::new();
        for _ in 0..2 {
            controller.observe(70.0, &steady_cadence());
        }
        assert_eq!(controller.width(), 320);
        controller.observe(70.0, &steady_cadence());
        assert_eq!(controller.width(), 256);
        for _ in 0..200 {
            controller.observe(70.0, &steady_cadence());
        }
        assert_eq!(controller.width(), 160);
        controller.reset_samples();
        for _ in 0..WINDOW {
            controller.observe(14.0, &steady_cadence());
        }
        assert_eq!(controller.width(), 192);
    }

    // Reproduce App's target-change boundary: width changes clear timing
    // windows and work samples, while retaining the controller's trial state.
    fn observed_frame(
        controller: &mut ResolutionController,
        timings: &mut FrameTimings,
        work: f32,
        interval: f32,
    ) {
        let width = controller.width();
        if timings.record(work, 0.0, interval, false) {
            controller.observe(work, &timings.cadence());
        }
        if controller.width() != width {
            timings.reset_window();
            controller.reset_samples();
        }
    }

    #[test]
    fn fixed_vsync_waits_at_60_or_30_hz_do_not_lock_resolution_at_the_floor() {
        for interval in [1000.0 / 60.0, FRAME_BUDGET_MS] {
            let mut controller = ResolutionController::new();
            controller.step = 0;
            let mut timings = FrameTimings::new();
            let mut upgrades = 0;
            for _ in 0..2000 {
                let width = controller.width();
                observed_frame(&mut controller, &mut timings, interval, interval);
                assert!(controller.width() >= width, "vsync wait is not an overload");
                upgrades += usize::from(controller.width() > width);
            }
            assert_eq!(upgrades, WIDTHS.len() - 1);
            assert_eq!(controller.width(), 640);
            assert_eq!(controller.probe_from, None);
        }
    }

    #[test]
    fn failed_probe_rolls_back_for_bad_tail_and_cools_down_before_retry() {
        let mut controller = ResolutionController::new();
        let mut timings = FrameTimings::new();
        for _ in 0..=WINDOW {
            observed_frame(&mut controller, &mut timings, 10.0, 16.667);
        }
        assert_eq!(controller.width(), 400);
        assert_eq!(controller.probe_from, Some(3));
        for i in 0..WINDOW {
            let interval = if i % 10 == 0 { 40.0 } else { 16.667 };
            observed_frame(&mut controller, &mut timings, 10.0, interval);
        }
        assert_eq!(controller.width(), 400);
        observed_frame(&mut controller, &mut timings, 10.0, 40.0);
        assert_eq!(
            controller.width(),
            320,
            "mean FPS alone cannot accept a trial"
        );
        assert_eq!(controller.probe_from, None);
        assert_eq!(controller.cooldown, PROBE_COOLDOWN);
        for _ in 0..PROBE_COOLDOWN - 1 {
            observed_frame(&mut controller, &mut timings, 10.0, 16.667);
            assert_eq!(controller.width(), 320);
        }
        controller.observe(f32::NAN, &steady_cadence());
        assert_eq!(
            controller.cooldown, 1,
            "invalid samples do not consume cooldown"
        );
        observed_frame(&mut controller, &mut timings, 10.0, 16.667);
        assert_eq!(controller.width(), 400);
        for _ in 0..2 {
            observed_frame(&mut controller, &mut timings, 50.0, 50.0);
            assert_eq!(controller.width(), 400);
        }
        observed_frame(&mut controller, &mut timings, 50.0, 50.0);
        assert_eq!(
            controller.width(),
            320,
            "a real overload ends a trial promptly"
        );
        assert_eq!(controller.cooldown, PROBE_COOLDOWN);
    }

    #[test]
    fn hard_overload_and_soft_headroom_have_distinct_downshift_rules() {
        let mut controller = ResolutionController::new();
        for i in 0..11 {
            controller.observe(if i % 2 == 0 { 20.0 } else { 50.0 }, &steady_cadence());
            assert_eq!(controller.width(), 320);
        }
        controller.observe(50.0, &steady_cadence());
        assert_eq!(
            controller.width(),
            256,
            "sustained mean overload cannot hide between fast frames"
        );

        let mut controller = ResolutionController::new();
        for _ in 0..WINDOW {
            controller.observe(30.0, &steady_cadence());
        }
        assert_eq!(
            controller.width(),
            400,
            "30 ms of work with on-budget cadence may probe"
        );
        let mut controller = ResolutionController::new();
        let late_cadence = Summary {
            mean: 36.0,
            p95: 36.0,
            ..steady_cadence()
        };
        for _ in 0..WINDOW - 1 {
            controller.observe(30.0, &late_cadence);
            assert_eq!(controller.width(), 320);
        }
        controller.observe(30.0, &late_cadence);
        assert_eq!(
            controller.width(),
            256,
            "the soft target applies once cadence really misses budget"
        );
    }

    #[test]
    fn resize_preserves_trial_but_new_place_discards_trial_and_cooldown() {
        for reject_first in [false, true] {
            let mut controller = ResolutionController::new();
            for _ in 0..WINDOW {
                controller.observe(16.667, &steady_cadence());
            }
            assert_eq!(controller.probe_from, Some(3));
            controller.reset_samples();
            assert_eq!(controller.probe_from, Some(3));
            assert_eq!(controller.samples.count, 0);
            if reject_first {
                for _ in 0..3 {
                    controller.observe(50.0, &steady_cadence());
                }
                assert_eq!(controller.cooldown, PROBE_COOLDOWN);
            }
            controller = ResolutionController::new();
            assert_eq!(controller.width(), 320);
            assert_eq!(controller.probe_from, None);
            assert_eq!(controller.cooldown, 0);
            for _ in 0..WINDOW - 1 {
                controller.observe(16.667, &steady_cadence());
                assert_eq!(controller.width(), 320);
            }
            controller.observe(16.667, &steady_cadence());
            assert_eq!(controller.width(), 400);
        }
    }
}
