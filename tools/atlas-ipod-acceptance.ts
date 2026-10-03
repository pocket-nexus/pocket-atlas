import { readIPodMetadata } from "./atlas-ipod-pack";
/** Physical-device camera sweep. Only render-worker presentation windows
 * establish cadence; UIKit callbacks and capture I/O are separate evidence. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLACES } from "../web/src/places/registry";
import { selectIPodPlaces } from "./atlas-ipod-catalog";

const root = resolve(import.meta.dir, "..");
const requiredSamples = 120;
const budgetMs = 1000 / 30;

type Summary = { samples: number; mean: number; p95: number; max: number; overBudget: number };
type Timing = {
  source: string;
  windowCapacity: number;
  presentedFrames: number;
  excludedFrames: number;
  renderMs: Summary;
  presentMs: Summary;
  workMs: Summary;
  intervalMs: Summary;
};
type Status = {
  buildId: string;
  place: string;
  shot: number;
  camera: number[];
  time: number;
  cinematic: boolean;
  paused: boolean;
  quality: number;
  profile: boolean;
  profileDrawClass: number;
  memoryWarningBatches: number;
  lastCommand: string;
  state: string;
  glError: number;
  fps: number;
  frameTiming: Timing;
  width: number;
  height: number;
  renderWidth: number;
  renderHeight: number;
};
type Expected = { renderWidth: number; buildId: string; place: string; shot: number; quality: number; profile: boolean; camera: number[]; nonce?: string; memoryWarningBatches: number };

export function parseOptions(args: string[]) {
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  const quality = Number(option("--quality", "0"));
  const width = Number(option("--width", "0"));
  const seconds = Number(option("--seconds", "90"));
  const warmup = Number(option("--warmup", "2"));
  if (![0, 1, 2].includes(quality) || !Number.isInteger(width) ||
      (width !== 0 && (width < 160 || width > 960)) ||
      !Number.isFinite(seconds) || seconds < 4 || seconds > 600 ||
      !Number.isFinite(warmup) || warmup < 1 || warmup > 60)
    throw new Error("Use --quality 0|1|2, --width 0 or 160..960, --seconds 4..600 and --warmup 1..60");
  return {
    quality, width, seconds, warmup,
    selected: option("--place", ""),
    profile: args.includes("--profile"),
    directory: resolve(option("--out", join(root, `.pocket-build/validation/ipod/sweep-${Date.now()}`))),
  };
}

export function validateState(state: Status, expected: Expected) {
  if (state.buildId !== expected.buildId || state.place !== expected.place ||
      state.shot !== expected.shot || state.quality !== expected.quality ||
      state.profile !== expected.profile || state.state !== "running" || state.glError !== 0)
    throw new Error("Unexpected build, camera, quality, profile or GL state");
  if (!Number.isSafeInteger(state.memoryWarningBatches) || state.memoryWarningBatches < 0 ||
      state.memoryWarningBatches !== expected.memoryWarningBatches)
    throw new Error("Memory pressure changed during normal acceptance");
  if (state.profileDrawClass !== 0)
    throw new Error(`Diagnostic mesh filter remains active: profileDrawClass=${state.profileDrawClass}`);
  if (expected.nonce && state.lastCommand !== expected.nonce)
    throw new Error("Scene command changed during the measurement window");
  // Physical UI actions do not change the debug command nonce. A user may
  // leave the camera still while resuming animation or selecting walk mode.
  if (state.time !== 25 || state.cinematic !== true || state.paused !== false)
    throw new Error("Fixed scene time or cinematic playback changed during acceptance");
  if (!Array.isArray(state.camera) || state.camera.length !== 3 ||
      expected.camera.some((value, index) => !Number.isFinite(state.camera[index]) || Math.abs(value - state.camera[index]) > .002))
    throw new Error("Acknowledged camera does not match the authored shot midpoint");
  if (state.renderWidth !== expected.renderWidth || state.renderHeight !== Math.floor(expected.renderWidth * 2 / 3))
    throw new Error("Internal scene resolution changed during acceptance");
  const timing = state.frameTiming;
  if (!timing || timing.source !== "render-worker-present" || timing.windowCapacity < requiredSamples ||
      !Number.isInteger(timing.presentedFrames) || !Number.isInteger(timing.excludedFrames) ||
      timing.presentedFrames < timing.excludedFrames || timing.excludedFrames < 0)
    throw new Error("Missing or invalid render-worker presentation counters");
  for (const summary of [timing.renderMs, timing.presentMs, timing.workMs, timing.intervalMs]) {
    if (!summary || !Number.isInteger(summary.samples) || summary.samples < 0 || summary.samples > timing.windowCapacity ||
        ![summary.mean, summary.p95, summary.max].every((value) => Number.isFinite(value) && value >= 0) ||
        !Number.isInteger(summary.overBudget) || summary.overBudget < 0 || summary.overBudget > summary.samples)
      throw new Error("Invalid completed-frame timing window");
  }
  if (!Number.isFinite(state.fps) || state.fps < 0 ||
      (timing.intervalMs.mean > 0 && Math.abs(state.fps - 1000 / timing.intervalMs.mean) > .05))
    throw new Error("FPS is inconsistent with the presentation interval window");
}

export function assessWindow(before: Timing, after: Timing, fps: number) {
  const presented = after.presentedFrames - before.presentedFrames;
  const excluded = after.excludedFrames - before.excludedFrames;
  if (presented < 0 || excluded < 0 || excluded > presented)
    throw new Error("Render-worker counters restarted during measurement");
  const steadyFrames = presented - excluded;
  const complete = steadyFrames >= requiredSamples && after.workMs.samples >= requiredSamples && after.intervalMs.samples >= requiredSamples;
  return {
    complete,
    steadyFrames,
    presentedFrames: presented,
    excludedFrames: excluded,
    requiredSamples,
    fps,
    windowSeconds: after.intervalMs.samples * after.intervalMs.mean / 1000,
    renderMs: after.renderMs,
    presentMs: after.presentMs,
    workMs: after.workMs,
    intervalMs: after.intervalMs,
    budgetMs,
    // Strict budget evidence, not a rounded "30" label or an inferred UI rate.
    meets30FpsBudget: complete && fps >= 30 && after.intervalMs.p95 <= budgetMs && after.workMs.p95 <= budgetMs,
  };
}

/** Collection already happens on the device. SSH reads are deliberately sparse
 * so waiting for evidence does not repeatedly compete with the A4 renderer. */
export function nextSampleDelayMs(before: Timing, after: Timing, remainingMs: number) {
  if (remainingMs <= 0) return 0;
  const fps = after.intervalMs.mean > 0 ? 1000 / after.intervalMs.mean : 30;
  const window = assessWindow(before, after, fps);
  if (window.complete) return 0;
  const missing = Math.max(
    requiredSamples - window.steadyFrames,
    requiredSamples - after.workMs.samples,
    requiredSamples - after.intervalMs.samples,
  );
  const estimatedMs = missing * 1000 / Math.max(1, Math.min(30, fps)) + 250;
  return Math.min(remainingMs, Math.max(2000, Math.min(20_000, estimatedMs)));
}

export function pngDimensions(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      data.toString("ascii", 12, 16) !== "IHDR") throw new Error("Capture is not a PNG");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function assessUiCapture(pixels: { width: number; height: number }, metadata: any) {
  if (metadata?.source !== "UIGetScreenImage" || metadata.resampled !== false ||
      metadata.width !== pixels.width || metadata.height !== pixels.height)
    throw new Error("UI capture metadata does not match the original screen image");
  const display = metadata.display;
  const fields = ["screenScale", "screenWidth", "screenHeight", "windowScale", "rootScale",
    "rootLayerScale", "overlayScale", "overlayLayerScale", "labelScale", "labelLayerScale"];
  if (!display || fields.some((field) => !Number.isFinite(display[field]) || display[field] <= 0))
    throw new Error("UI capture lacks measured screen and layer scales");
  const screenPixels = {
    width: Math.round(display.screenWidth * display.screenScale),
    height: Math.round(display.screenHeight * display.screenScale),
  };
  return {
    ...pixels, source: metadata.source, resampled: false,
    screenPixels,
    matchesScreenPixels: pixels.width === screenPixels.width && pixels.height === screenPixels.height,
    layersMatchScreenScale: fields.filter((field) => field.endsWith("Scale"))
      .every((field) => Math.abs(display[field] - display.screenScale) < .001),
    // Configured backing scales and output dimensions do not prove text fidelity.
    display,
  };
}

async function command(...args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "tools/atlas-ipod.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(stderr + stdout);
  return stdout.trim();
}

function meta(id: string) {
  return readIPodMetadata(join(root, ".pocket-build/ipod/assets", id + ".place"));
}

/** Place the quiet interval after USB identity/installer queries. A complete
 * rolling window plus publication margin avoids benchmarking our own setup. */
export function nextQuietSampleDelayMs(before: Timing, after: Timing, remainingMs: number) {
  const fresh = nextSampleDelayMs(before, after, remainingMs);
  if (!fresh) return 0;
  return Math.max(0, Math.min(remainingMs, 20_000,
    Math.max(fresh, requiredSamples * after.intervalMs.mean + 2000)));
}

async function main() {
  const options = parseOptions(Bun.argv.slice(2));
  const places = selectIPodPlaces(PLACES, options.selected);
  if (!places.length) throw new Error("No matching iPod release places");
  const scenes = places.map((place) => ({ place, shots: meta(place.id).camera.shots }));
  const expectedShots = scenes.reduce((count, scene) => count + scene.shots.length, 0);
  const receipt = JSON.parse(readFileSync(join(root, ".pocket-build/ipod/Payload/PocketAtlas.app/build-receipt.json"), "utf8"));
  mkdirSync(options.directory, { recursive: true });
  const results: Record<string, any>[] = [];
  const baseline: Status = JSON.parse(await command("status"));
  if (baseline.buildId !== receipt.buildId) throw new Error("Installed build differs from local receipt");
  if (baseline.memoryWarningBatches !== 0)
    throw new Error("Normal acceptance requires a process with no memory pressure fallback");
  const save = () => writeFileSync(join(options.directory, "receipt.json"), JSON.stringify({
    schemaVersion: 3,
    scenario: "fixed-shot-midpoint-frozen-time",
    scope: "Per-shot recent-frame stress samples at time 25; not a live-tour FPS range or a comfort verdict",
    buildId: receipt.buildId,
    timing: "render-worker-present; rolling steady windows; capture excluded; UI reported separately",
    polling: "USB identity/lookup before a 2–20s quiet interval; a rolling window plus 2s publication margin when within the bound",
    quality: options.quality,
    widthOverride: options.width,
    diagnosticProfile: options.profile,
    suitableForNormalPerformanceGate: !options.profile,
    warmupSeconds: options.warmup,
    perShotDeadlineSeconds: options.seconds,
    requiredSamples,
    expectedShots,
    completedShots: results.filter((row) => row.result === "complete").length,
    complete: results.length === expectedShots && results.every((row) => row.result === "complete"),
    results,
  }, null, 2));

  for (const { place, shots } of scenes) {
    for (let shot = 0; shot < shots.length; shot++) {
      const row: Record<string, any> = {
        place: place.id, shot, name: shots[shot].name, time: 25,
        quality: options.quality, widthOverride: options.width,
        diagnosticProfile: options.profile, result: "incomplete",
      };
      try {
        const expected: Expected = {
          buildId: receipt.buildId, place: place.id, shot, quality: options.quality, profile: options.profile,
          renderWidth: options.width || (options.quality === 1 ? 960 : 480),
          memoryWarningBatches: baseline.memoryWarningBatches,
          camera: shots[shot].from.pos.map((value: number, index: number) => (value + shots[shot].to.pos[index]) / 2),
        };
        const initial: Status = JSON.parse(await command("ctl", JSON.stringify({
          ...(shot === 0 ? { place: place.id } : {}), shot, time: 25,
          quality: options.quality, renderWidth: options.width,
          profile: options.profile, profileDrawClass: 0,
          rain: true, bloom: true, reflection: true, sound: false, pause: false,
          renderRequestHz: 60, touches: [{ phase: -1 }],
        })));
        validateState(initial, expected);
        expected.nonce = initial.lastCommand;
        const before: Status = JSON.parse(await command("status", "--quiet", String(options.warmup)));
        validateState(before, expected);
        const started = performance.now();
        const deadline = started + options.seconds * 1000;
        let after = before;
        let measurement = assessWindow(before.frameTiming, after.frameTiming, after.fps);
        while (!measurement.complete && performance.now() < deadline) {
          const quietMs = nextQuietSampleDelayMs(before.frameTiming, after.frameTiming,
            Math.max(0, deadline - performance.now()));
          after = JSON.parse(await command("status", "--quiet", String(quietMs / 1000)));
          validateState(after, expected);
          measurement = assessWindow(before.frameTiming, after.frameTiming, after.fps);
        }
        row.measurement = { ...measurement, elapsedSeconds: (performance.now() - started) / 1000 };
        row.status = after;
        row.profileDrawClass = after.profileDrawClass;
        row.result = measurement.complete ? "complete" : "incomplete";
        if (!measurement.complete) row.reason = "Deadline reached before 120 post-warmup steady presentations and a full current timing window";

        // Readback begins only after the timing window. Record the real drawable
        // and native UI PNG dimensions, never infer one from the other's scale.
        const capture = join(options.directory, `${place.id}-${shot}.png`);
        const uiCapture = join(options.directory, `${place.id}-${shot}-ui.png`);
        row.capture = capture;
        row.uiCapture = uiCapture;
        await command("capture", "--out", capture);
        await command("capture-ui", "--out", uiCapture);
        const ui = JSON.parse(await command("status", "--ui"));
        const captured: Status = JSON.parse(await command("status"));
        validateState(captured, expected);
        const drawable = pngDimensions(readFileSync(capture));
        const nativeUI = assessUiCapture(pngDimensions(readFileSync(uiCapture)),
          JSON.parse(readFileSync(uiCapture + ".json", "utf8")));
        if (drawable.width !== captured.width || drawable.height !== captured.height)
          throw new Error("Captured drawable dimensions do not match the current presented surface");
        if (captured.width !== (options.quality === 1 ? 960 : 480) || captured.height !== (options.quality === 1 ? 640 : 320))
          throw new Error("Quality selection has not reached its expected drawable size");
        row.drawable = { ...drawable, internalWidth: captured.renderWidth, internalHeight: captured.renderHeight };
        row.nativeUI = nativeUI;
        row.ui = ui;
        console.log(`${place.id}/${shot} fixed midpoint / frozen t=25 ${row.result}: ${measurement.fps.toFixed(2)} fps over last ${measurement.windowSeconds.toFixed(2)} s; interval p95 ${measurement.intervalMs.p95.toFixed(2)} ms; work p95 ${measurement.workMs.p95.toFixed(2)} ms; ${measurement.steadyFrames} steady frames; strict 30fps budget ${measurement.meets30FpsBudget ? "met" : "not met"}`);
      } catch (error) {
        row.result = "failed";
        row.reason = String(error);
        console.error(`${place.id}/${shot}: ${row.reason}`);
      }
      results.push(row);
      save();
    }
  }
  console.log(options.directory);
  if (results.some((row) => row.result !== "complete")) process.exitCode = 1;
}

if (import.meta.main) await main();
