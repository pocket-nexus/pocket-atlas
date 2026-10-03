import { describe, expect, test } from "bun:test";
import { assessUiCapture, assessWindow, nextSampleDelayMs, nextQuietSampleDelayMs, parseOptions, pngDimensions, validateState } from "./atlas-ipod-acceptance";

function timing(presentedFrames = 240, samples = 120, ms = 1000 / 30) {
  const summary = (value: number) => ({ samples, mean: value, p95: value, max: value, overBudget: value > 1000 / 30 ? samples : 0 });
  return {
    source: "render-worker-present", windowCapacity: 120, presentedFrames, excludedFrames: 0,
    renderMs: summary(ms - 1), presentMs: summary(1), workMs: summary(ms), intervalMs: summary(ms),
  };
}

describe("iPod physical acceptance evidence", () => {
  test("default acceptance uses the fixed profile without a diagnostic override", () => {
    expect(parseOptions([])).toMatchObject({ quality: 0, width: 0, warmup: 2, seconds: 90 });
    expect(parseOptions(["--quality", "2", "--width", "160"])).toMatchObject({ quality: 2, width: 160 });
    expect(() => parseOptions(["--width", "80"])).toThrow();
    expect(() => parseOptions(["--seconds", "NaN"])).toThrow();
    expect(() => parseOptions(["--quality", "3"])).toThrow();
  });

  test("full old windows cannot masquerade as 120 fresh presentations", () => {
    const before = timing(120);
    expect(assessWindow(before, timing(122), 30).complete).toBe(false);
    const withReadback = timing(240);
    withReadback.excludedFrames = 20;
    expect(assessWindow(before, withReadback, 30)).toMatchObject({ complete: false, steadyFrames: 100 });
    expect(assessWindow(before, timing(300, 60), 30).complete).toBe(false);
    expect(assessWindow(before, timing(240), 30).complete).toBe(true);
  });

  test("poll waits follow missing real samples without changing the evidence gate", () => {
    const before = timing(120);
    expect(nextSampleDelayMs(before, before, 90_000)).toBeCloseTo(4250);
    expect(nextSampleDelayMs(before, timing(120, 120, 100), 90_000)).toBe(12_250);
    expect(nextSampleDelayMs(before, timing(120, 120, 1000), 90_000)).toBe(20_000);
    expect(nextSampleDelayMs(before, timing(239), 90_000)).toBe(2000);
    expect(nextSampleDelayMs(before, timing(239), 300)).toBe(300);
    expect(nextSampleDelayMs(before, timing(240), 90_000)).toBe(0);
    // A reset current window still needs new samples despite enough lifetime frames.
    expect(nextSampleDelayMs(before, timing(300, 30, 100), 90_000)).toBe(9250);
    expect(assessWindow(before, timing(300, 30, 100), 10).complete).toBe(false);
  });

  test("quiet sampling covers a rolling window without weakening freshness or deadline", () => {
    const before = timing(120);
    expect(nextQuietSampleDelayMs(before, before, 90_000)).toBeCloseTo(6000);
    expect(nextQuietSampleDelayMs(before, timing(239), 90_000)).toBeCloseTo(6000);
    expect(nextQuietSampleDelayMs(before, timing(239), 300)).toBe(300);
    expect(nextQuietSampleDelayMs(before, timing(120, 120, 1000), 90_000)).toBe(20_000);
    expect(nextQuietSampleDelayMs(before, timing(240), 90_000)).toBe(0);
  });

  test("slow rendering is complete evidence but fails the actual 30fps budget", () => {
    const result = assessWindow(timing(120), timing(240, 120, 100), 10);
    expect(result).toMatchObject({ complete: true, fps: 10, meets30FpsBudget: false });
    expect(result.intervalMs.p95).toBe(100);
    expect(result.workMs.overBudget).toBe(120);
    expect(assessWindow(timing(120), timing(240), 30).meets30FpsBudget).toBe(true);
    expect(() => assessWindow(timing(240), timing(1), 30)).toThrow("restarted");
  });

  test("diagnostic filters and source or nonce changes fail validation", () => {
    const expected = { renderWidth: 480, buildId: "build", place: "test-place", shot: 0, camera: [1, 2, 3], quality: 0, profile: false, nonce: "command", memoryWarningBatches: 0 };
    const state = {
      ...expected, lastCommand: "command", state: "running", glError: 0, fps: 30,
      time: 25, cinematic: true, paused: false,
      profileDrawClass: 0, frameTiming: timing(), width: 480, height: 320, renderWidth: 480, renderHeight: 320,
    };
    expect(() => validateState(state, expected)).not.toThrow();
    expect(() => validateState({ ...state, renderWidth: 160, renderHeight: 106 }, expected)).toThrow("resolution");
    expect(() => validateState({ ...state, memoryWarningBatches: 1 }, expected)).toThrow("Memory pressure");
    expect(() => validateState({ ...state, memoryWarningBatches: NaN }, expected)).toThrow("Memory pressure");
    expect(() => validateState({ ...state, profileDrawClass: 7 }, expected)).toThrow("filter");
    expect(() => validateState({ ...state, lastCommand: "another" }, expected)).toThrow("changed");
    expect(() => validateState({ ...state, time: 26 }, expected)).toThrow("playback changed");
    expect(() => validateState({ ...state, cinematic: false }, expected)).toThrow("playback changed");
    expect(() => validateState({ ...state, paused: true }, expected)).toThrow("playback changed");
    expect(() => validateState({ ...state, frameTiming: { ...timing(), source: "ui" } }, expected)).toThrow("render-worker");
    expect(() => validateState({ ...state, fps: 60 }, expected)).toThrow("inconsistent");
  });

  test("capture dimensions are read from each PNG independently", () => {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(960, 20);
    expect(pngDimensions(png)).toEqual({ width: 640, height: 960 });
    expect(() => pngDimensions(Buffer.from("not png"))).toThrow();
  });

  test("native layer scale never promotes a low resolution screenshot", () => {
    const metadata = {
      source: "UIGetScreenImage", resampled: false, width: 320, height: 480,
      display: { screenScale: 2, screenWidth: 320, screenHeight: 480,
        windowScale: 2, rootScale: 2, rootLayerScale: 2, overlayScale: 2,
        overlayLayerScale: 2, labelScale: 2, labelLayerScale: 2, glScale: 1 },
    };
    expect(assessUiCapture({ width: 320, height: 480 }, metadata)).toMatchObject({
      width: 320, height: 480, matchesScreenPixels: false, layersMatchScreenScale: true,
    });
    expect(assessUiCapture({ width: 640, height: 960 }, { ...metadata, width: 640, height: 960 }))
      .toMatchObject({ matchesScreenPixels: true, layersMatchScreenScale: true });
    expect(assessUiCapture({ width: 320, height: 480 }, {
      ...metadata, display: { ...metadata.display, rootScale: 1 },
    }).layersMatchScreenScale).toBe(false);
    expect(() => assessUiCapture({ width: 640, height: 960 }, metadata)).toThrow("metadata");
    expect(() => assessUiCapture({ width: 320, height: 480 }, { ...metadata, resampled: true })).toThrow("original");
  });
});
