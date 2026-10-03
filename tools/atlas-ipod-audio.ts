/** Bake the existing Web Audio soundscapes for the native iPod player.
 * No replacement synthesis: each original audio class builds and schedules its
 * own graph in OfflineAudioContext. Outputs are consumed from assets/*.audio.caf.
 *
 * bun tools/atlas-ipod-audio.ts [--place <id>]
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readIPodMetadata } from "./atlas-ipod-pack";
import { PLACES } from "../web/src/places/registry";
import { selectIPodPlaces } from "./atlas-ipod-catalog";

const root = resolve(import.meta.dir, "..");
const work = join(root, ".pocket-build/validation/ipod/audio");
const assets = join(root, ".pocket-build/ipod/assets");
const args = Bun.argv.slice(2);
const selected = args.includes("--place")
  ? args[args.indexOf("--place") + 1]
  : undefined;
const places = selectIPodPlaces(PLACES, selected);
if (!places.length)
  throw new Error(`No iPod release place matched ${selected ?? "the catalog"}`);
mkdirSync(work, { recursive: true });
mkdirSync(assets, { recursive: true });

function metadata(id: string) {
  return readIPodMetadata(join(assets, `${id}.place`));
}

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode)
    throw new Error(`${command[0]}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function decodedLevels(path: string, expectedFrames: number) {
  const bytes = readFileSync(path);
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("CAF decoder did not produce a WAVE file");
  let samples: Buffer | undefined;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32LE(at + 4);
    if (bytes.toString("ascii", at, at + 4) === "data")
      samples = bytes.subarray(at + 8, at + 8 + length);
    at += 8 + length + (length & 1);
  }
  if (!samples || samples.length !== expectedFrames * 4)
    throw new Error("CAF decode changed the loop duration");
  let peak = 0,
    squared = 0,
    clipped = 0;
  for (let at = 0; at < samples.length; at += 2) {
    const sample = samples.readInt16LE(at);
    peak = Math.max(peak, Math.abs(sample) / 32768);
    squared += (sample / 32768) ** 2;
    if (sample === 32767 || sample === -32768) ++clipped;
  }
  const rms = Math.sqrt(squared / (samples.length / 2));
  if (clipped || rms < 0.00001)
    throw new Error("Invalid levels in the independently decoded CAF");
  return { frames: expectedFrames, peak, rms, clipped };
}

const source = (file: string) => JSON.stringify(join(root, "web/src", file));
const entry = join(work, "render.ts");
writeFileSync(
  entry,
  `
import { PerspectiveCamera, Vector3 } from ${JSON.stringify(join(root, "web/node_modules/three/build/three.module.js"))};
import { AudioEngine } from ${source("core/audio.ts")};
import { TokyoAudio } from ${source("places/tokyo-konbini/audio.ts")};
import { SugaAudio } from ${source("places/suga-shrine-stairs/audio.ts")};
import { AkibaAudio } from ${source("places/akihabara-radio-kaikan/audio.ts")};
import { KamakuraAudio } from ${source("places/kamakura-koko-mae-crossing/audio.ts")};
import { GriffithAudio } from ${source("places/griffith-observatory/audio.ts")};
import { crossingAt } from ${source("places/kamakura-koko-mae-crossing/world/timeline.ts")};
import { L } from ${source("places/tokyo-konbini/world/layout.ts")};

const constructors = {
  "tokyo-konbini": TokyoAudio,
  "suga-shrine-stairs": SugaAudio,
  "akihabara-radio-kaikan": AkibaAudio,
  "kamakura-koko-mae-crossing": KamakuraAudio,
  "griffith-observatory": GriffithAudio,
};

window.renderAudio = async function ({id, seconds, shot}) {
  let seed = 0x51ab47;
  for (const ch of id) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  const originalRandom = Math.random;
  Math.random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
  try {
    const sampleRate = 44100, warmup = 8, blendSeconds = 0.04;
    const samples = Math.round(seconds * sampleRate);
    const blend = Math.round(blendSeconds * sampleRate);
    const start = warmup * sampleRate;
    const context = new OfflineAudioContext(2, start + samples + blend + 256, sampleRate);
    const engine = new AudioEngine(false);
    // Provide the same master/compressor bus as AudioEngine.create(), while
    // retaining the engine's own noise generator, ramp and whenReady methods.
    const master = context.createGain();
    master.gain.value = 0.9;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 3;
    master.connect(compressor).connect(context.destination);
    Object.assign(engine, {ctx: context, master});
    const sound = new constructors[id](engine);
    const camera = new PerspectiveCamera(shot.from.fov, 1.5, 0.1, 120000);
    camera.position.fromArray(shot.from.pos).lerp(new Vector3().fromArray(shot.to.pos), 0.5);
    camera.lookAt(new Vector3().fromArray(shot.from.target).lerp(new Vector3().fromArray(shot.to.target), 0.5));
    camera.updateMatrixWorld(true);
    const shop = new Vector3(2.1, 1.4, L.konbini.front);
    sound.start();
    const update = (dt) => {
      const time = context.currentTime - warmup;
      switch (id) {
        case "tokyo-konbini": {
          const swell = 0.5 + 0.5 * Math.sin(time * 0.09) * Math.sin(time * 0.037 + 1.3);
          const gust = Math.max(0, Math.sin(time * 0.21) * Math.sin(time * 0.083 + 0.7));
          sound.setIntensity(0.85 + 0.35 * swell, gust);
          sound.update(dt, camera, shop);
          break;
        }
        case "suga-shrine-stairs": sound.update(dt, camera); break;
        case "kamakura-koko-mae-crossing": sound.update(dt, time, camera, crossingAt(time)); break;
        default: sound.update(dt, time, camera); break;
      }
    };
    update(0);
    const step = 1 / 30;
    let suspend = context.suspend(step);
    const rendering = context.startRendering();
    let previous = 0;
    for (let at = step; at < context.length / sampleRate; at += step) {
      await suspend;
      update(context.currentTime - previous);
      previous = context.currentTime;
      const next = at + step;
      const hasNext = next < context.length / sampleRate - 128 / sampleRate;
      if (hasNext) suspend = context.suspend(next);
      await context.resume();
      if (!hasNext) break;
    }
    const rendered = await rendering;
    const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
    const pcm = new Int16Array(samples * 2);
    let peak = 0, squared = 0, clipped = 0;
    const seam = [0, 0];
    for (let i = 0; i < samples; ++i) {
      for (let channel = 0; channel < 2; ++channel) {
        const data = channel ? right : left;
        // Blend the overrun into the first 40ms, retaining the exact loop length
        // and event clock. This removes a discontinuity without a silent gap.
        const f = i < blend ? i / blend : 1;
        const value = i < blend ? data[start + i] * f + data[start + samples + i] * (1 - f) : data[start + i];
        if (!Number.isFinite(value)) throw new Error("Non-finite audio sample");
        peak = Math.max(peak, Math.abs(value));
        squared += value * value;
        if (Math.abs(value) >= 1) ++clipped;
        pcm[i * 2 + channel] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
      }
    }
    for (let channel = 0; channel < 2; ++channel) seam[channel] = Math.abs(pcm[channel] - pcm[(samples - 1) * 2 + channel]) / 32767;
    const bytes = new Uint8Array(pcm.buffer);
    for (let i = 0; i < bytes.length; i += 1024 * 1024) {
      const chunk = bytes.subarray(i, i + 1024 * 1024);
      let text = "";
      for (let j = 0; j < chunk.length; j += 0x8000) text += String.fromCharCode(...chunk.subarray(j, j + 0x8000));
      await window.writeAudio(btoa(text));
    }
    return {seconds, sampleRate, channels:2, samples, peak, rms:Math.sqrt(squared / (samples * 2)), clipped, seam, camera:camera.position.toArray()};
  } finally { Math.random = originalRandom; }
};
`,
);

const built = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!built.success) throw new Error(built.logs.join("\n"));
const javascript = await built.outputs[0].text();
const { chromium } = createRequire(join(root, "web/package.json"))(
  "playwright-core",
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const receipts = [];
try {
  for (const place of places) {
    const meta = metadata(place.id);
    // A static geometry pack can have a one-second animation track. Ambient
    // cicada bouts still need their original long, varied soundscape.
    const seconds = meta.frames / meta.fps >= 20 ? meta.frames / meta.fps : 120;
    const wav = join(work, `${place.id}.wav`);
    const file = openSync(wav, "w");
    const length = Math.round(seconds * 44100) * 4;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(length + 36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(44100, 24);
    header.writeUInt32LE(44100 * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(length, 40);
    writeSync(file, header);
    const page = await browser.newPage();
    page.on("pageerror", (error: Error) => console.error(error.message));
    await page.route("http://atlas-audio.local/**", (route: any) =>
      route.fulfill({
        contentType: route.request().url().endsWith("render.js")
          ? "text/javascript"
          : "text/html",
        body: route.request().url().endsWith("render.js")
          ? javascript
          : '<!doctype html><script type="module" src="/render.js"></script>',
      }),
    );
    await page.exposeFunction("writeAudio", (chunk: string) =>
      writeSync(file, Buffer.from(chunk, "base64")),
    );
    let report;
    try {
      await page.goto("http://atlas-audio.local/");
      await page.waitForFunction(
        () => typeof (window as any).renderAudio === "function",
      );
      report = await page.evaluate(
        (input: any) => (window as any).renderAudio(input),
        {
          id: place.id,
          seconds,
          shot: meta.camera.shots[0],
        },
      );
    } finally {
      closeSync(file);
      await page.close();
    }
    if (report.clipped || report.rms < 0.00001)
      throw new Error(
        `${place.id}: invalid rendered levels ${JSON.stringify(report)}`,
      );
    const output = join(assets, `${place.id}.audio.caf`);
    run(["afconvert", "-f", "caff", "-d", "ima4", wav, output]);
    const info = run(["afinfo", output]);
    writeFileSync(join(work, `${place.id}.afinfo.txt`), info);
    // Decode the shipped CAF independently, not just the source PCM.
    const decoded = join(work, `${place.id}.decoded.wav`);
    run(["afconvert", "-f", "WAVE", "-d", "LEI16", output, decoded]);
    const receipt = {
      place: place.id,
      ...report,
      format: "CAF Apple IMA4 stereo",
      sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
      decoded: decodedLevels(decoded, report.samples),
      source: `web/src/places/${place.id}/audio.ts`,
      sourceSha256: createHash("sha256")
        .update(readFileSync(join(root, `web/src/places/${place.id}/audio.ts`)))
        .digest("hex"),
      listener: "first authored shot midpoint; fixed stereo perspective",
      limits:
        "Baked sound follows the scene clock. Walking does not re-spatialize the audio or trigger the proximity door chime.",
    };
    receipts.push(receipt);
    writeFileSync(
      join(work, `${place.id}.json`),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      `${place.id}: ${seconds}s, peak ${report.peak.toFixed(4)}, RMS ${report.rms.toFixed(4)}, ${output}`,
    );
  }
} finally {
  await browser.close();
}
writeFileSync(join(work, "receipt.json"), JSON.stringify(receipts, null, 2));
