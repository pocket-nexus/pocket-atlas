import { describe, expect, test } from "bun:test";
import { observationScript, parseObservationOptions, summarizeObservation, type Observation } from "./atlas-ipod-observe";

function row(seconds: number, frames: number, fps = 30): Observation {
  return {
    hostMs: seconds * 1000,
    scene: {
      buildId: "accepted-build", place: "scene", state: "running", glError: 0,
      quality: 0, profile: false, profileDrawClass: 0,
      width: 480, height: 320, renderWidth: 480, renderHeight: 320,
      rain: true, reflection: true, bloom: true, sound: false,
      memoryWarningBatches: 0, paused: false, cinematic: true, time: seconds, shot: 0, fps,
      frameTiming: { source: "render-worker-present", presentedFrames: frames, excludedFrames: 0,
        windowCapacity: 120, intervalMs: { samples: 120, mean: 1000 / fps, p95: 100, max: 120 } },
    },
    ui: { uiFrame: seconds * 60, renderRequestHz: 60 },
  };
}

describe("iPod live observation", () => {
  test("independent count/wall rate does not average recent FPS or UI callbacks", () => {
    const result = summarizeObservation([row(10, 100, 10), row(20, 300, 60), row(30, 600, 20)]);
    expect(result.hostCounterFps).toBe(25);
    expect(result.uiCallbackHz).toBe(60);
    expect(result.sampledRollingWindows).toMatchObject({ minFps: 10, maxFps: 60,
      maxWindowSeconds: 12, maxP95IntervalMs: 100 });
    expect(result.sampledRollingWindows.minWindowSeconds).toBeCloseTo(2);
    expect(result.normalPlaybackEvidence).toBe(true);
  });

  test("sparse windows report cadence without inventing a performance gate or global p95", () => {
    const result = summarizeObservation([row(10, 100), row(20, 400)]);
    expect(result).not.toHaveProperty("meets30FpsBudget");
    expect(result).not.toHaveProperty("accepted");
    expect(result).not.toHaveProperty("sessionP95Ms");
  });

  test("camera motion and shot changes are observed without freezing playback", () => {
    const a = row(10, 100), b = row(20, 400);
    b.scene.shot = 2; b.scene.cinematic = false;
    expect(summarizeObservation([a, b])).toMatchObject({ normalPlaybackEvidence: true,
      shotsObserved: [0, 2], modesObserved: ["cinematic", "manual"] });
    const options = parseObservationOptions(["--seconds", "90", "--interval", "5"]);
    const script = observationScript("/app's tmp", options);
    expect(script).toContain("sleep 12");
    expect(script).toContain("-le 18");
    expect(script).toContain("'/app'\\''s tmp/status.json'");
    expect(script).not.toMatch(/control|capture|kill|uiopen/);
  });

  test("clock, counter and FPS corruption are errors", () => {
    for (const corrupt of [
      (s: Observation) => { s.hostMs = 9000; },
      (s: Observation) => { s.scene.frameTiming.presentedFrames = 99; },
      (s: Observation) => { s.scene.fps = 60; },
      (s: Observation) => { s.scene.frameTiming.intervalMs.mean = NaN; },
      (s: Observation) => { s.ui.uiFrame = 1; },
    ]) {
      const a = row(10, 100), b = row(20, 400); corrupt(b);
      expect(() => summarizeObservation([a, b])).toThrow();
    }
  });

  test("stalls, freezes, readback, pressure and setting changes invalidate normal evidence", () => {
    for (const change of [
      (s: Observation) => { s.scene.frameTiming.presentedFrames = 100; },
      (s: Observation) => { s.scene.time = 10; },
      (s: Observation) => { s.scene.frameTiming.excludedFrames = 1; },
      (s: Observation) => { s.scene.frameTiming.intervalMs.samples = 1; },
      (s: Observation) => { s.scene.place = "other"; },
      (s: Observation) => { s.scene.memoryWarningBatches = 1; },
      (s: Observation) => { s.scene.paused = true; },
      (s: Observation) => { s.scene.profile = true; },
      (s: Observation) => { s.scene.profileDrawClass = 2; },
      (s: Observation) => { s.scene.renderWidth = 160; },
    ]) {
      const a = row(10, 100), b = row(20, 400); change(b);
      expect(summarizeObservation([a, b])).toMatchObject({ normalPlaybackEvidence: false });
    }
  });

  test("bounded numeric options cannot inject remote shell syntax", () => {
    expect(parseObservationOptions([])).toMatchObject({ seconds: 120, interval: 2, warmup: 12 });
    expect(parseObservationOptions(["--seconds", "60", "--interval", "60"]).interval).toBe(60);
    for (const args of [["--seconds", "1"], ["--seconds", "601"], ["--seconds", "10; reboot"],
      ["--interval", "0"], ["--interval", "7"], ["--warmup", "NaN"], ["--warmup"]])
      expect(() => parseObservationOptions(args)).toThrow();
  });
});
