/** Read-only observation of a running scene. Never freezes its clock/camera,
 * profiles GPU passes, captures pixels, or changes the accepted renderer. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shellQuote } from "../vendor/pocketjs/tools/ipodtouch4-installation";

type Distribution = { samples: number; mean: number; p95: number; max: number };
export type Observation = {
  hostMs: number;
  scene: {
    buildId: string; place: string; state: string; glError: number;
    quality: number; profile: boolean; profileDrawClass: number;
    width: number; height: number; renderWidth: number; renderHeight: number;
    rain: boolean; reflection: boolean; bloom: boolean; sound: boolean;
    memoryWarningBatches: number; paused: boolean; cinematic: boolean;
    time: number; shot: number; fps: number;
    frameTiming: {
      source: string; presentedFrames: number; excludedFrames: number;
      windowCapacity: number; intervalMs: Distribution;
    };
  };
  ui: { uiFrame: number; renderRequestHz: number };
};

export function parseObservationOptions(args: string[]) {
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1] ?? "";
  };
  const seconds = Number(option("--seconds", "120"));
  const interval = Number(option("--interval", "2"));
  const warmup = Number(option("--warmup", "12"));
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600 ||
      !Number.isInteger(interval) || interval < 1 || interval > seconds ||
      seconds % interval !== 0 || !Number.isInteger(warmup) || warmup < 2 || warmup > 30)
    throw new Error("Use --seconds 10..600, --interval 1..seconds (integer divisor of seconds), --warmup 2..30");
  return { seconds, interval, warmup,
    directory: resolve(option("--out", `.pocket-build/validation/ipod/observe-${Date.now()}`)) };
}

export function observationScript(directory: string, options: ReturnType<typeof parseObservationOptions>) {
  // One SSH connection; device discovery, authentication and installer lookup
  // finish before warmup. Only two existing status files are read per sample.
  const scene = shellQuote(join(directory, "status.json"));
  const ui = shellQuote(join(directory, "ui-status.json"));
  return `set -e; sleep ${options.warmup}; n=0; while [ "$n" -le ${options.seconds / options.interval} ]; do ` +
    `printf '{"scene":'; cat ${scene}; printf ',"ui":'; cat ${ui}; printf '}\\n'; ` +
    `n=$((n+1)); if [ "$n" -le ${options.seconds / options.interval} ]; then sleep ${options.interval}; fi; done`;
}

export function summarizeObservation(rows: Observation[]) {
  if (rows.length < 2) throw new Error("At least two status observations required");
  const first = rows[0], last = rows.at(-1)!;
  const problems = new Set<string>();
  const invariant = ["buildId", "place", "quality", "width", "height", "renderWidth", "renderHeight",
    "rain", "reflection", "bloom", "sound", "memoryWarningBatches"] as const;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], s = row.scene, t = s.frameTiming, d = t?.intervalMs;
    if (!Number.isFinite(row.hostMs) || row.hostMs < 0 || !t || t.source !== "render-worker-present" ||
        ![t.presentedFrames, t.excludedFrames, t.windowCapacity, d?.samples, row.ui?.uiFrame].every(
          n => Number.isSafeInteger(n) && n >= 0) || t.excludedFrames > t.presentedFrames ||
        ![s.fps, s.time, d?.mean, d?.p95, d?.max].every(n => Number.isFinite(n) && n >= 0) ||
        t.windowCapacity !== 120 || d.samples > t.windowCapacity || d.mean <= 0 ||
        ![s.profile, s.paused, s.cinematic, s.rain, s.reflection, s.bloom, s.sound].every(v => typeof v === "boolean") ||
        ![s.width, s.height, s.renderWidth, s.renderHeight, row.ui.renderRequestHz].every(n => Number.isInteger(n) && n > 0) ||
        !Number.isSafeInteger(s.memoryWarningBatches) || s.memoryWarningBatches < 0 ||
        Math.abs(s.fps - 1000 / d.mean) > .05)
      throw new Error("Invalid render-worker timing or host clock");
    if (invariant.some(key => s[key] !== first.scene[key])) problems.add("Build, scene, quality, effects or memory-pressure state changed");
    if (row.ui.renderRequestHz !== first.ui.renderRequestHz) problems.add("Render request rate changed");
    if (s.state !== "running" || s.glError !== 0 || s.profile || s.profileDrawClass !== 0)
      problems.add("Error or diagnostic rendering observed");
    if (s.paused) problems.add("Playback paused");
    if (d.samples !== t.windowCapacity) problems.add("Incomplete rolling timing window");
    if (index) {
      const previous = rows[index - 1];
      if (row.hostMs <= previous.hostMs || t.presentedFrames < previous.scene.frameTiming.presentedFrames ||
          t.excludedFrames < previous.scene.frameTiming.excludedFrames || row.ui.uiFrame < previous.ui.uiFrame)
        throw new Error("Clock or presentation counters restarted");
      if (t.presentedFrames === previous.scene.frameTiming.presentedFrames) problems.add("Stale status or presentation stall");
      if (s.time <= previous.scene.time) problems.add("Scene clock frozen or restarted");
    }
  }
  const elapsedSeconds = (last.hostMs - first.hostMs) / 1000;
  const presentedFrames = last.scene.frameTiming.presentedFrames - first.scene.frameTiming.presentedFrames;
  const excludedFrames = last.scene.frameTiming.excludedFrames - first.scene.frameTiming.excludedFrames;
  if (excludedFrames) problems.add("Loading, readback or other excluded frames occurred");
  return {
    schemaVersion: 1,
    scenario: "live-observation",
    buildId: first.scene.buildId, place: first.scene.place,
    configuration: {
      quality: first.scene.quality,
      sceneSize: [first.scene.renderWidth, first.scene.renderHeight],
      drawableSize: [first.scene.width, first.scene.height],
      rain: first.scene.rain, reflection: first.scene.reflection, bloom: first.scene.bloom,
      sound: first.scene.sound, renderRequestHz: first.ui.renderRequestHz,
    },
    normalPlaybackEvidence: problems.size === 0, problems: [...problems],
    hostElapsedSeconds: elapsedSeconds, presentedFrames, excludedFrames,
    // Counts / wall time, never an arithmetic average of changing FPS values.
    hostCounterFps: presentedFrames / elapsedSeconds,
    hostCounterLimit: "Approximate endpoints: existing status files publish about twice per second; host times are receipt times. Includes all presentations, including exclusions.",
    uiCallbackHz: (last.ui.uiFrame - first.ui.uiFrame) / elapsedSeconds,
    uiLimit: "Main-thread callback cadence, not scene FPS or measured display scanout.",
    sampledRollingWindows: {
      count: rows.length,
      capacityFrames: first.scene.frameTiming.windowCapacity,
      minFps: Math.min(...rows.map(r => r.scene.fps)),
      maxFps: Math.max(...rows.map(r => r.scene.fps)),
      maxP95IntervalMs: Math.max(...rows.map(r => r.scene.frameTiming.intervalMs.p95)),
      minWindowSeconds: Math.min(...rows.map(r => r.scene.frameTiming.intervalMs.mean * r.scene.frameTiming.intervalMs.samples / 1000)),
      maxWindowSeconds: Math.max(...rows.map(r => r.scene.frameTiming.intervalMs.mean * r.scene.frameTiming.intervalMs.samples / 1000)),
      limit: "Overlapping recent-frame windows; neither whole-session extrema/p95 nor a distribution of session time. No interpolation across samples.",
    },
    shotsObserved: [...new Set(rows.map(r => r.scene.shot))].sort((a, b) => a - b),
    modesObserved: [...new Set(rows.map(r => r.scene.cinematic ? "cinematic" : "manual"))],
    timingBoundary: "Successful EAGL presentRenderbuffer returns; not optical/display-scanout timing. No comfort score is inferred.",
  };
}

export async function collectObservation(
  start: (script: string) => Bun.Subprocess<"ignore", "pipe", "pipe">,
  remoteDirectory: string,
  options: ReturnType<typeof parseObservationOptions>,
) {
  mkdirSync(options.directory, { recursive: true });
  const rows: Observation[] = [];
  const process = start(observationScript(remoteDirectory, options));
  const stderr = new Response(process.stderr).text();
  const deadline = setTimeout(() => process.kill(), (options.warmup + options.seconds * 2 + 60) * 1000);
  let pending = "";
  const decoder = new TextDecoder();
  try {
    for await (const bytes of process.stdout) {
      pending += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        rows.push({ ...JSON.parse(line), hostMs: performance.now() });
      }
    }
    if (await process.exited) throw new Error(await stderr);
    if (pending.trim() || rows.length !== options.seconds / options.interval + 1)
      throw new Error("Incomplete observation stream");
    const summary = { ...summarizeObservation(rows), sampling: {
      intervalSeconds: options.interval, warmupSeconds: options.warmup,
      requestedSeconds: options.seconds,
      transport: "one SSH connection; sleep between reads; no discovery or authentication during sampling",
    } };
    writeFileSync(join(options.directory, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ...summary, directory: options.directory }, null, 2));
    return summary;
  } finally {
    clearTimeout(deadline);
    if (process.exitCode === null) process.kill();
    await process.exited;
    await stderr;
    writeFileSync(join(options.directory, "samples.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  }
}
