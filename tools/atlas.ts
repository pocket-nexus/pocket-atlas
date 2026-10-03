// Pocket Atlas on PS Vita: build the native runtime, replace it on a device
// over PocketJS's wired debug transport (vendor/pocketjs), sync shader
// sources, fetch captures, and package the standalone VPK.
//
//   bun tools/atlas.ts cook [--place ID]            # scene.glb → <place>.place
//   bun tools/atlas.ts cook-atlas                   # web export-atlas → atlas.pack (globe + places)
//   bun tools/atlas.ts serve                         # USB host (keep running)
//   bun tools/atlas.ts build  [--title P3B1D7273] [--debug]
//   bun tools/atlas.ts vpk                          # standalone PKAT00001 VPK
//   bun tools/atlas.ts push-vpk [file.vpk]          # → ux0:data/pocket-atlas/ via the dev build
//   bun tools/atlas.ts native [--title P3B1D7273]   # build + USB SELF replacement
//   bun tools/atlas.ts status|capture [--title ...]
//   bun tools/atlas.ts sync                         # packs + shader sources → host0:atlas/
//   bun tools/atlas.ts ctl '{"settings":{"haze":false}}' # host0:atlas/control.json
//   bun tools/atlas.ts lint                          # parse/type-check Cg on the host
//   bun tools/atlas.ts bench                         # frame cost per renderer feature
//   bun tools/atlas.ts profile ['{"msaa":false}']    # GPU time per scene
//   bun tools/atlas.ts sweep [--shots a,b] [--time 100] # frame time per shot × quality step
//   bun tools/atlas.ts shots [--seconds 90]          # frame time per cinematic shot
//   (bench, profile, sweep, shots: --render vita30|vita60|cinematic, default vita30;
//    bench and profile: --shot NAME --time T, else the device's current view;
//    --place ID picks the place, default tokyo-konbini)
//
// The default title is Pocket Devkit (P3B1D7273, PocketJS apps/devkit), the
// development container installed on the console: its native slots accept
// replacement SELFs and reopening its LiveArea bubble returns to it. `vpk`
// builds the standalone Pocket Atlas package (PKAT00001).

import { $ } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageVitaVpk } from "../vendor/pocketjs/tools/vita-package.ts";
import { prepareVitaUsb } from "../vendor/pocketjs/tools/vita-usb.ts";

const ROOT = resolve(import.meta.dir, "..");
const POCKETJS = resolve(ROOT, "vendor/pocketjs");
const APP_DIR = resolve(ROOT, "vita");
const OUT_DIR = resolve(ROOT, "dist/vita");
const home = process.env.HOME ?? "";
const vitasdk = process.env.VITASDK || `${home}/vitasdk`;
const rustup = Bun.which("rustup") ?? `${home}/.cargo/bin/rustup`;
const argv = Bun.argv.slice(2);
const command = argv[0] ?? "build";

function value(flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}

/** Pocket Devkit's title: vitaTitleId("dev.pocket-stack.devkit"). */
const DEVKIT = "P3B1D7273";
const title = value("--title", command === "vpk" ? "PKAT00001" : DEVKIT);
const release = !argv.includes("--debug");
const output = `pocket-atlas-${title}`;
/** The place a command cooks, syncs or measures. */
const PLACE = value("--place", "tokyo-konbini");

interface BuildOptions {
  /** Packaged build: no USB debug driver, pack and GXPs inside the VPK. */
  readonly standalone?: boolean;
  /** VPK-relative files overlaid on the framework's LiveArea defaults. */
  readonly assets?: string;
}

async function build(options: BuildOptions = {}): Promise<string> {
  if (!existsSync(`${vitasdk}/bin/vita-pack-vpk`)) throw new Error(`VitaSDK not found at ${vitasdk}`);
  const usb = options.standalone ? undefined : await prepareVitaUsb();
  const nativeBuild = randomBytes(16).toString("hex");
  const env = {
    ...process.env,
    PATH: `${vitasdk}/bin:${home}/.cargo/bin:${process.env.PATH ?? ""}`,
    VITASDK: vitasdk,
    VITA_DEFAULT_TITLE_ID: title,
    POCKETJS_VITA_TITLE_ID: title,
    POCKETJS_NATIVE_BUILD: nativeBuild,
    POCKETJS_EMBED_APP: "0",
    TARGET_AR: "arm-vita-eabi-ar",
    AR_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-ar",
    TARGET_CC: "arm-vita-eabi-gcc",
    CC_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-gcc",
    TARGET_CXX: "arm-vita-eabi-g++",
    CXX_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-g++",
  };
  const cargoArgs = [...(release ? ["--release"] : []), ...(options.standalone ? ["--no-default-features"] : [])];
  console.log(`atlas: cargo vita build vpk (title ${title}, ${release ? "release" : "debug"})`);
  await $`${rustup} run nightly-2026-05-28 cargo vita build vpk ${cargoArgs}`.cwd(APP_DIR).env(env);

  const target = `${APP_DIR}/target/armv7-sony-vita-newlibeabihf/${release ? "release" : "debug"}`;
  const eboot = `${target}/pocket-atlas-vita.self`;
  const sfo = `${target}/pocket-atlas-vita.sfo`;
  const vpk = `${target}/pocket-atlas-vita.vpk`;
  // Unsafe-homebrew SELF: loading the USB driver and writing the inactive
  // native slot need the standard homebrew permissions.
  await $`${vitasdk}/bin/vita-make-fself ${target}/pocket-atlas-vita.velf ${eboot}`;
  await $`${vitasdk}/bin/vita-mksfoex -d ATTRIBUTE2=12 -s TITLE_ID=${title} ${"Pocket Atlas"} ${sfo}`;
  await packageVitaVpk({ tool: `${vitasdk}/bin/vita-pack-vpk`, sfo, eboot, output: vpk, usbDriver: usb?.driver, applicationAssets: options.assets });

  mkdirSync(OUT_DIR, { recursive: true });
  cpSync(vpk, `${OUT_DIR}/${output}.vpk`);
  cpSync(eboot, `${OUT_DIR}/${output}.self`);
  const selfSha256 = createHash("sha256").update(readFileSync(eboot)).digest("hex");
  const runtime = `${OUT_DIR}/${output}.runtime.json`;
  await Bun.write(runtime, JSON.stringify({
    version: 1, titleId: title, applicationId: "nexus.pocket.atlas", output, nativeBuild, plan: null,
    self: `${output}.self`, usbDebug: !options.standalone, usbDriver: usb?.fingerprint ?? null, selfSha256,
  }, null, 2) + "\n");
  console.log(`atlas: ${OUT_DIR}/${output}.vpk (native build ${nativeBuild})`);
  return runtime;
}

// PocketJS's wired debug tool, pointed at this repository's USB share.
async function dev(...args: string[]): Promise<void> {
  const runtime = `${OUT_DIR}/${output}.runtime.json`;
  const share = resolve(ROOT, ".pocket-build/vita-usb/share");
  mkdirSync(share, { recursive: true });
  await $`bun ${POCKETJS}/tools/vita-dev.ts ${args} --runtime ${runtime} --title ${title} --dir ${share}`.cwd(POCKETJS);
}

const SHARE = resolve(ROOT, ".pocket-build/vita-usb/share/atlas");
const PLACES_DIR = resolve(ROOT, ".pocket-build/places");
const PLACE_DIR = `${PLACES_DIR}/${PLACE}`;
const PACK = `${PLACE_DIR}/${PLACE}.place`;
/** The globe and place list (`cook-atlas`, from web/scripts/export-atlas.ts). */
const ATLAS_PACK = resolve(ROOT, ".pocket-build/atlas/atlas.pack");
const FONTS = resolve(ROOT, ".pocket-build/fonts");
const NOTO_REVISION = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
/** SHA-256 of the Noto Sans CJK JP faces at NOTO_REVISION. */
const NOTO_SHA256: Record<string, string> = {
  "NotoSansCJKjp-Medium.otf": "dd523e580e3413c480b2d701bf64e534c20f8419e3cfb6a44c2bdcd8d2a6c052",
  "NotoSansCJKjp-Bold.otf": "e53dcb0dcb2922e45d01aae1ebd2f382bb81d4229b18b6b883bd170678af1f76",
};

/**
 * The interface font's faces: Inter Regular/Bold from PocketJS, Noto Sans CJK
 * JP Medium/Bold (OFL) fetched once into `.pocket-build/fonts` and checked.
 */
async function fontFaces(): Promise<string[]> {
  mkdirSync(FONTS, { recursive: true });
  const cjk: string[] = [];
  for (const [name, sha] of Object.entries(NOTO_SHA256)) {
    const path = `${FONTS}/${name}`;
    if (!existsSync(path)) {
      const r = await fetch(`https://raw.githubusercontent.com/notofonts/noto-cjk/${NOTO_REVISION}/Sans/OTF/Japanese/${name}`);
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      writeFileSync(path, new Uint8Array(await r.arrayBuffer()));
    }
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== sha) throw new Error(`${path}: checksum mismatch`);
    cjk.push(path);
  }
  const inter = `${POCKETJS}/assets/fonts`;
  return ["--latin", `${inter}/Inter-Regular.ttf`, "--latin-bold", `${inter}/Inter-Bold.ttf`, "--cjk", cjk[0]!, "--cjk-bold", cjk[1]!];
}

/** Every cooked place pack: [id, path]. */
function cookedPlaces(): [string, string][] {
  if (!existsSync(PLACES_DIR)) return [];
  return readdirSync(PLACES_DIR)
    .map((id): [string, string] => [id, `${PLACES_DIR}/${id}/${id}.place`])
    .filter(([, path]) => existsSync(path));
}

/** Copies `src` to `dst` unless the bytes are already there; true when copied. */
function copyIfChanged(src: string, dst: string): boolean {
  const same = existsSync(dst) && Bun.file(dst).size === Bun.file(src).size &&
    createHash("sha256").update(readFileSync(dst)).digest("hex") === createHash("sha256").update(readFileSync(src)).digest("hex");
  if (!same) cpSync(src, dst);
  return !same;
}

// The device reads the pack and shader sources from the USB share; shaders
// recompile on the device when their source changes.
function sync(): void {
  // The device never creates directories on host0: (stat-style requests stall
  // the USB channel); every directory it writes into exists up front.
  for (const dir of ["shaders", "gxp", "errors", "places"]) mkdirSync(`${SHARE}/${dir}`, { recursive: true });
  cpSync(`${APP_DIR}/shaders`, `${SHARE}/shaders`, { recursive: true });
  // The device polls this one file and reloads the sources when it changes.
  const stamp = createHash("sha256");
  for (const f of readdirSync(`${APP_DIR}/shaders`).sort()) stamp.update(f).update(readFileSync(`${APP_DIR}/shaders/${f}`));
  writeFileSync(`${SHARE}/shaders/stamp`, stamp.digest("hex"));
  const places = cookedPlaces();
  if (!places.length) throw new Error(`no cooked place under ${PLACES_DIR}: run \`bun tools/atlas.ts cook\` first`);
  const copied = places.filter(([id, path]) => copyIfChanged(path, `${SHARE}/places/${id}.place`)).map(([id]) => id);
  if (existsSync(ATLAS_PACK) && copyIfChanged(ATLAS_PACK, `${SHARE}/atlas.pack`)) copied.push("atlas");
  console.log(`atlas: synced shaders${copied.length ? ` and ${copied.join(", ")}` : ""} to ${SHARE}`);
}

// Host-side Cg check through open-shacccg's glslang front end (set
// OPENSHACCG to its openshacccg_compile). Its backend rejects most real
// shaders ("unsupported … subset"); reaching the backend means the source
// parsed and type-checked, which is what this catches before a device run.
async function lint(): Promise<void> {
  const tool = process.env.OPENSHACCG ?? `${home}/.cache/pocket-atlas/open-shacccg/build-gl/openshacccg_compile`;
  if (!existsSync(tool)) throw new Error(`openshacccg_compile not found (OPENSHACCG=${tool})`);
  const dir = `${APP_DIR}/shaders`;
  const expand = (name: string): string =>
    readFileSync(`${dir}/${name}`, "utf8").split("\n").map((line, i) => {
      const m = line.trim().match(/^#include\s+"(.+)"/);
      return m ? `${expand(m[1]!)}\n#line ${i + 2} "${name}"` : line;
    }).join("\n");
  const lit = ["ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "EMISSION_MAP", "VERTEX_COLOR", "WET", "PLANAR", "FOG"];
  const cases: [string, string[]][] = [
    ["surface_v.cg", []], ["surface_v.cg", ["SKINNED", "MAX_BONES=24"]], ["surface_v.cg", ["BAKED"]], ["surface_v.cg", ["SKINNED", "MAX_BONES=24", "VERTEX_LIGHTS=4"]],
    ["standard_f.cg", ["LIGHTS=0", "VERTEX_LIGHTS", "ALBEDO_MAP", "NORMAL_MAP", "FOG"]],
    ["standard_f.cg", ["LIGHTS=2", "BAKED", "WET", "PLANAR", "ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "FOG"]], ["debug_f.cg", []],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "FAR", "DAMP", "ALBEDO_MAP", "NORMAL_MAP", "FOG"]], ["standard_f.cg", ["LIGHTS=2", "BAKED", "LITE", "WET", "PLANAR", "ALBEDO_MAP", "NORMAL_MAP", "FOG"]], ["glass_f.cg", ["LIGHTS=0", "BAKED", "FOG"]], ["glass_f.cg", ["LIGHTS=0", "BAKED", "LITE", "FOG"]],
    ["standard_f.cg", ["LIGHTS=4", ...lit]], ["standard_f.cg", ["LIGHTS=2", "DAMP", "CLEARCOAT", "ALPHA_TEST", "REFLECTION"]],
    ["standard_f.cg", ["LIGHTS=0", "INTERIOR", "ALBEDO_MAP"]], ["unlit_f.cg", ["ALBEDO_MAP", "VERTEX_COLOR", "FOG", "ALPHA_TEST"]],
    ["glass_f.cg", ["LIGHTS=4", "FOG"]], ["glass_f.cg", ["LIGHTS=0", "REFLECTION"]], ["window_f.cg", ["FOG"]], ["window_f.cg", ["REFLECTION"]],
    ["products_f.cg", []], ["skyline_f.cg", []], ["tower_f.cg", []], ["sky_v.cg", []], ["sky_f.cg", []],
    ...["STREAK", "SPLASH", "DRIP", "STEAM", "BEACON"].map((d): [string, string[]] => ["fx_v.cg", [d]]),
    ...["STREAK", "SPLASH", "STEAM", "BEACON"].map((d): [string, string[]] => ["fx_f.cg", [d]]),
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "SUN_SPEC", "ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "FOG"]], ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "ALPHA_TEST", "ALBEDO_MAP", "EMISSION_MAP", "FOG"]],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "FAR", "ALBEDO_MAP", "FOG"]], ["shadow_f.cg", []], ["shadow_f.cg", ["ALPHA_TEST"]], ["fill_f.cg", []], ["sky_day_f.cg", []], ["sky_day_f.cg", ["TWILIGHT"]],
    ["globe_v.cg", []], ["globe_f.cg", []], ["marker_v.cg", []], ["marker_f.cg", []], ["ui_v.cg", []], ["ui_f.cg", []], ["ui_f.cg", ["TEX"]], ["text_v.cg", []], ["text_f.cg", []], ["surface_v.cg", ["WAVES"]], ["water_f.cg", ["SUN", "FOG"]], ["water_f.cg", []], ["water_f.cg", ["SUN", "FOG", "SHALLOW"]], ["surface_v.cg", ["WAVES", "COLOR"]], ["surface_v.cg", ["FLAT"]], ["surface_v.cg", ["BAKED", "FLAT"]],
    // Light fields and the vista haze (dusk-vista places).
    ["lights_v.cg", []], ["lights_v.cg", ["VISTA"]], ["lights_f.cg", []],
    ["surface_v.cg", ["BAKED", "VISTA"]], ["surface_v.cg", ["VISTA", "COLOR", "TANGENT"]], ["surface_v.cg", ["SKINNED", "MAX_BONES=24", "VISTA", "VERTEX_LIGHTS=2"]], ["surface_v.cg", ["WAVES", "VISTA"]], ["surface_v.cg", ["VISTA", "FLAT"]],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "FAR", "ALBEDO_MAP", "VISTA"]], ["standard_f.cg", ["LIGHTS=1", "BAKED", "ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "EMISSION_MAP", "VISTA"]],
    ["standard_f.cg", ["LIGHTS=2", "BAKED", "LITE", "WET", "PLANAR", "ALBEDO_MAP", "VISTA"]], ["standard_f.cg", ["LIGHTS=0", "VERTEX_LIGHTS", "ALBEDO_MAP", "VISTA", "BLEND"]],
    ["unlit_f.cg", ["ALBEDO_MAP", "VERTEX_COLOR", "VISTA"]], ["glass_f.cg", ["LIGHTS=0", "BAKED", "VISTA"]], ["window_f.cg", ["VISTA"]], ["water_f.cg", ["VISTA"]],
    ["post_v.cg", []], ["post_v.cg", ["GRAIN"]], ["haze_f.cg", ["HAZE_LIGHTS=2"]], ["haze_f.cg", ["HAZE_LIGHTS=6"]], ["prefilter_f.cg", []], ["prefilter_f.cg", ["PER_PIXEL"]], ["down_f.cg", []], ["up_f.cg", []], ["composite_f.cg", []], ["composite_f.cg", ["HAZE", "BLOOM"]], ["blit_f.cg", []],
  ];
  const tmp = resolve(ROOT, ".pocket-build/atlas/lint");
  mkdirSync(tmp, { recursive: true });
  let failed = 0;
  for (const [file, defines] of cases) {
    const src = defines.map((d) => `#define ${d.replace("=", " ")}\n`).join("") + expand(file);
    const path = `${tmp}/${file}.${defines.join("_").replace(/=/g, "")}.cg`;
    await Bun.write(path, src);
    const stage = file.endsWith("_v.cg") ? "vertex" : "fragment";
    const r = Bun.spawnSync([tool, "--stage", stage, path, `${tmp}/out.gxp`]);
    const out = `${r.stdout}${r.stderr}`.trim();
    const ok = r.exitCode === 0 || out.includes("unsupported");
    if (!ok) failed++;
    console.log(`${ok ? "ok   " : "FAIL "} ${file} ${defines.join(",")}${ok ? "" : `\n${out}`}`);
  }
  if (failed) throw new Error(`${failed} shader variants failed`);
}

// Every measurement names the render profile, which resets the device's
// switches and governor to the profile's; `settings` then overrides them.
const RENDER = value("--render", "vita30");
const STATUS = resolve(ROOT, `.pocket-build/vita-usb/share/pocket-vita/${title}/status.json`);

/** The device's engine status (the USB host replaces the file while it is read). */
function engine(): any {
  for (let i = 0; ; i++) {
    try { return JSON.parse(readFileSync(STATUS, "utf8")).engine ?? {}; } catch (e) { if (i > 20) throw e; }
    Bun.sleepSync(50);
  }
}

interface Shot { name: string; from: { pos: number[]; target: number[]; fov: number }; to: { pos: number[]; target: number[]; fov: number } }

/** The cinematic shots authored in the cooked scene (scene.glb extras). */
function shotList(): Shot[] {
  const b = readFileSync(`${PLACE_DIR}/scene.glb`);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
  return json.scenes[0].extras.pocketAtlas.camera.shots;
}

/** A shot's view halfway through its move, as the rig eases it. */
function shotView(s: Shot): { pos: number[]; target: number[]; fov: number } {
  const t = 0.5;
  const mix = (a: number[], b: number[]) => a.map((x, i) => x + (b[i]! - x) * t);
  return { pos: mix(s.from.pos, s.to.pos), target: mix(s.from.target, s.to.target), fov: s.from.fov + (s.to.fov - s.from.fov) * t };
}

/** `--shot NAME` (halfway view), else the device's current view; `--time` or the device's time. */
function measuredView(): { view: { pos: number[]; target: number[]; fov: number }; time: number } {
  const e = engine();
  if (e.stage !== "running" || !e.view) throw new Error("the device is not running Pocket Atlas");
  const name = value("--shot", "");
  const shot = name ? shotList().find((s) => s.name.toLowerCase() === name.toLowerCase()) : undefined;
  if (name && !shot) throw new Error(`no shot ${name}: ${shotList().map((s) => s.name).join(", ")}`);
  const view = shot ? shotView(shot) : { pos: e.view.pos, target: e.view.target, fov: e.view.fov };
  return { view, time: Number(value("--time", String(e.time))) };
}

// Frame cost per renderer feature at a fixed view and time: each row turns
// one feature off (or all of them) through control.json and averages the
// frame times the device reports once the change has settled.
async function bench(): Promise<void> {
  const shot = { place: PLACE, renderProfile: RENDER, ...measuredView() };
  const base = argv[1] && !argv[1].startsWith("--") ? JSON.parse(argv[1]) : {};
  const bare = { reflection: false, haze: false, bloom: false, rain: false };
  const rows: [string, Record<string, boolean | number>][] = [
    ["full", {}], ["no reflection", { reflection: false }], ["no haze", { haze: false }],
    ["no bloom", { bloom: false }], ["no rain", { rain: false }], ["no msaa", { msaa: false }], ["960x544", { scale: 0 }], ["640x362", { scale: 2 }],
    ["lights 2", { maxLights: 2 }], ["lights 0", { maxLights: 0 }],
    ["meshes only", bare], ["meshes flat", { ...bare, flat: true }],
    ["flat no msaa", { ...bare, flat: true, msaa: false }], ["full (again)", {}],
  ];
  mkdirSync(SHARE, { recursive: true });
  console.log(`view ${JSON.stringify(shot)}`);
  for (const [name, off] of rows) {
    await Bun.write(`${SHARE}/control.json`, JSON.stringify({ ...shot, settings: { ...base, ...off } }) + "\n");
    await Bun.sleep(3000);
    const sum = { frameMs: 0, cpuSubmitMs: 0, waitMs: 0, swapMs: 0 };
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(500);
      const e = engine();
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += (e[k] ?? 0) / 8;
    }
    const f = (v: number) => v.toFixed(1).padStart(6);
    console.log(`${name.padEnd(14)} ${f(sum.frameMs)} ms ${(1000 / sum.frameMs).toFixed(1).padStart(5)} fps  cpu ${f(sum.cpuSubmitMs)}  gpu wait ${f(sum.waitMs)}  swap ${f(sum.swapMs)}`);
  }
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
}

// GPU time per scene at the current view: the device serializes the frame
// while `profile` is on and reports each scene's duration.
async function profile(): Promise<void> {
  const extra = argv[1] && !argv[1].startsWith("--") ? JSON.parse(argv[1]) : {};
  const shot = { place: PLACE, renderProfile: RENDER, ...measuredView() };
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ ...shot, settings: { profile: true, ...extra } }) + "\n");
  await settle();
  // Reflection and haze redraw on alternate frames: each scene averages
  // over the sampled frames that drew it, with the share of frames it ran in.
  const sum = new Map<string, { ms: number; frames: number }>();
  const n = 12;
  for (let i = 0; i < n; i++) {
    // Jittered, so samples do not lock onto one parity of alternating frames.
    await Bun.sleep(280 + Math.random() * 90);
    const seen = new Map<string, number>();
    for (const [name, ms] of engine().passes ?? []) seen.set(name, (seen.get(name) ?? 0) + ms);
    for (const [name, ms] of seen) {
      const a = sum.get(name) ?? { ms: 0, frames: 0 };
      sum.set(name, { ms: a.ms + ms, frames: a.frames + 1 });
    }
  }
  let total = 0;
  let mean = 0;
  for (const [name, a] of sum) {
    total += a.ms / a.frames;
    mean += a.ms / n;
    const share = a.frames < n ? `  (${a.frames}/${n} frames)` : "";
    console.log(`${name.padEnd(16)} ${(a.ms / a.frames).toFixed(2).padStart(7)} ms${share}`);
  }
  console.log(`${"worst frame".padEnd(16)} ${total.toFixed(2).padStart(7)} ms`);
  console.log(`${"mean frame".padEnd(16)} ${mean.toFixed(2).padStart(7)} ms`);
  // Back to the camera rig with the profile's switches.
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
}

/**
 * Waits for a control change to apply and for every program the frame uses
 * to be compiled (after a shader sync the device recompiles each changed
 * variant, and draws without a program are skipped meanwhile).
 */
async function settle(): Promise<void> {
  await Bun.sleep(2000);
  for (let i = 0; i < 600; i++) {
    const e = engine();
    if (!(e.main?.missing || e.reflection?.missing || e.pending)) return;
    if (i % 10 === 0) console.log(`waiting for programs: ${e.pending ?? 0} compiling, ${e.main?.missing ?? 0} + ${e.reflection?.missing ?? 0} draws missing`);
    await Bun.sleep(500);
  }
  throw new Error("programs still compiling after 5 minutes");
}

// Frame time per shot (halfway view, fixed time) at every quality step of
// the profile, the governor held: which step each view sustains.
async function sweep(): Promise<void> {
  const extra = argv[1] && !argv[1].startsWith("--") ? JSON.parse(argv[1]) : {};
  const names = value("--shots", "").split(",").filter(Boolean).map((n) => n.toLowerCase());
  const shots = shotList().filter((s) => !names.length || names.includes(s.name.toLowerCase()));
  const time = Number(value("--time", "100"));
  mkdirSync(SHARE, { recursive: true });
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
  await Bun.sleep(1500);
  const steps = Number(value("--steps", String(engine().settings?.steps ?? 1)));
  console.log(`render profile ${RENDER}, time ${time} s, frame ms per step (cpu submit ms)`);
  console.log(`${"".padEnd(10)} ${[...Array(steps).keys()].map((k) => `step ${k}`.padStart(13)).join("")}`);
  for (const s of shots) {
    const row: string[] = [];
    for (let k = 0; k < steps; k++) {
      await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER, view: shotView(s), time, settings: { step: k, hold: true, ...extra } }) + "\n");
      await settle();
      let ms = 0;
      let cpu = 0;
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(400);
        const e = engine();
        ms += e.frameMs / 6;
        cpu += e.cpuSubmitMs / 6;
      }
      row.push(`${ms.toFixed(1)} (${cpu.toFixed(1)})`.padStart(13));
    }
    console.log(`${s.name.padEnd(10)} ${row.join("")}`);
  }
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
}

// Standalone VPK (title PKAT00001 unless --title is given): the cooked pack
// and the GXP programs the device compiled for this source revision (listed
// in host0:atlas/gxp/manifest.txt) go into app0:, so the package runs
// without the runtime compiler or a computer.
async function vpk(): Promise<void> {
  const manifest = `${SHARE}/gxp/manifest.txt`;
  if (!existsSync(manifest)) throw new Error(`${manifest} missing: run the development build on the device first`);
  const stage = resolve(ROOT, ".pocket-build/atlas/vpk");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(`${stage}/gxp`, { recursive: true });
  cpSync(`${APP_DIR}/assets`, stage, { recursive: true });
  const hashes = readFileSync(manifest, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]!);
  for (const h of hashes) {
    const gxp = `${SHARE}/gxp/${h}.gxp`;
    if (!existsSync(gxp)) throw new Error(`${gxp} missing`);
    cpSync(gxp, `${stage}/gxp/${h}.gxp`);
  }
  mkdirSync(`${stage}/places`, { recursive: true });
  const places = cookedPlaces();
  for (const [id, path] of places) cpSync(path, `${stage}/places/${id}.place`);
  if (!existsSync(ATLAS_PACK)) throw new Error(`${ATLAS_PACK} missing: run \`bun tools/atlas.ts cook-atlas\` first`);
  cpSync(ATLAS_PACK, `${stage}/atlas.pack`);
  console.log(`atlas: staged ${hashes.length} programs, the atlas and ${places.map(([id]) => id).join(", ")} in ${stage}`);
  await build({ standalone: true, assets: stage });
}

// Frame time per cinematic shot while the camera rig plays (render profile
// and governor as they run for a viewer).
async function shots(): Promise<void> {
  const seconds = Number(value("--seconds", "90"));
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
  await Bun.sleep(3000);
  const acc = new Map<string, { ms: number[]; steps: Set<number>; levels: Set<number> }>();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const e = JSON.parse(readFileSync(STATUS, "utf8")).engine;
      const a = acc.get(e.view.shot) ?? { ms: [], steps: new Set(), levels: new Set() };
      a.ms.push(e.frameMs);
      a.steps.add(e.settings.step);
      a.levels.add(e.settings.level);
      acc.set(e.view.shot, a);
    } catch { /* replaced while read */ }
    await Bun.sleep(500);
  }
  console.log(`render profile ${RENDER}`);
  for (const [shot, a] of acc) {
    const ms = a.ms.slice(2).length ? a.ms.slice(2) : a.ms;
    const mean = ms.reduce((x, y) => x + y, 0) / ms.length;
    console.log(`${shot.padEnd(10)} ${mean.toFixed(1).padStart(6)} ms ${(1000 / mean).toFixed(1).padStart(5)} fps  max ${Math.max(...ms).toFixed(1)} ms  steps ${[...a.steps].join(",")}  levels ${[...a.levels].join(",")}`);
  }
}

// Copies the standalone VPK to ux0:data/pocket-atlas/ through the running
// development build, ready to install from VitaShell.
async function pushVpk(): Promise<void> {
  const vpkPath = argv[1] && !argv[1].startsWith("--") ? resolve(argv[1]) : `${OUT_DIR}/pocket-atlas-PKAT00001.vpk`;
  const name = vpkPath.split("/").pop()!;
  if (!existsSync(vpkPath)) throw new Error(`${vpkPath} missing: run \`bun tools/atlas.ts vpk\` first`);
  mkdirSync(`${SHARE}/outbox`, { recursive: true });
  rmSync(`${SHARE}/outbox/${name}.done`, { force: true });
  cpSync(vpkPath, `${SHARE}/outbox/${name}`);
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ fetch: name, nonce: Date.now() }) + "\n");
  const done = `${SHARE}/outbox/${name}.done`;
  for (let i = 0; i < 600 && !existsSync(done); i++) await Bun.sleep(500);
  if (!existsSync(done)) throw new Error("the device did not pick up the package (is the development build running?)");
  console.log(`atlas: ${readFileSync(done, "utf8").trim()}`);
}

if (command === "build") await build();
else if (command === "push-vpk") await pushVpk();
else if (command === "vpk") await vpk();
else if (command === "lint") await lint();
else if (command === "bench") await bench();
else if (command === "profile") await profile();
else if (command === "shots") await shots();
else if (command === "sweep") await sweep();
else if (command === "sync") sync();
else if (command === "ctl") {
  mkdirSync(SHARE, { recursive: true });
  const body = argv[1] ?? "{}";
  JSON.parse(body);
  await Bun.write(`${SHARE}/control.json`, body + "\n");
  console.log(`atlas: ${SHARE}/control.json = ${body}`);
} else if (command === "native") {
  sync();
  await build();
  await dev("native");
} else if (command === "serve") {
  await dev("serve");
} else if (command === "cook") {
  await $`cargo run --release --locked -p pocket3d-place-cook -- --target vita --in ${PLACE_DIR}`.cwd(ROOT);
} else if (command === "cook-atlas") {
  const faces = await fontFaces();
  await $`cargo run --release -p pocket3d-place-cook -- atlas --in ${resolve(ROOT, ".pocket-build/atlas/globe")} --out ${ATLAS_PACK} ${faces}`.cwd(ROOT);
} else if (command === "capture") {
  const out = value("--out", resolve(ROOT, `.pocket-build/validation/captures/${new Date().toISOString().replace(/[:.]/g, "-")}.png`));
  await dev("capture", "--out", out);
} else if (command === "status" || command === "menu") {
  const rest = argv.slice(1).filter((a, i, all) => a !== "--title" && all[i - 1] !== "--title");
  await dev(command, ...rest);
} else throw new Error(`unknown atlas command: ${command}`);
