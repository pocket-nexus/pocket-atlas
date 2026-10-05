// Pocket Atlas on PS Vita: build the native runtime, replace it on a device
// over PocketJS's wired debug transport (vendor/pocketjs), sync shader
// sources, fetch captures, and package the standalone VPK.
//
//   bun tools/atlas.ts cook [--place ID] [--tex 1024] # scene.glb → <place>.place
//   bun tools/atlas.ts cook-atlas                   # web export-atlas → atlas.pack (globe + places)
//   bun tools/atlas.ts serve                         # USB host (keep running)
//   bun tools/atlas.ts build  [--title P3B1D7273] [--debug]
//   bun tools/atlas.ts programs                     # every program a package needs → .pocket-build/vita-programs/
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
//   --share DIR reuses an already-running USB host's root directory.
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
import { POCKET3D_ICON } from "../vendor/pocketjs/tools/pocket3d-icon.ts";
import { prepareVitaUsb } from "../vendor/pocketjs/tools/vita-usb.ts";
import { VitaUsbClient } from "../vendor/pocketjs/tools/vita-dev-client.ts";
import { guardDeviceCommand } from "../vendor/pocketjs/tools/device-lease.ts";
import { DeviceEvidence, assertDeviceIdentity, fileSha256, type DeviceIdentity } from "../vendor/pocketjs/tools/device-evidence.ts";
import { compileInterface } from "./atlas-ui";
import { assertFrameSample, assertVitaMeasurement, compileIdentity } from "./device-validation";
import { readPack, VITA_PACK_VERSION } from "./place-container";
import { PROGRAMS_DIR, PROGRAM_SETTINGS, profileNames, shaderSources, vitaPlaces, type Coverage } from "./vita-programs";

const ROOT = resolve(import.meta.dir, "..");
const POCKETJS = resolve(ROOT, "vendor/pocketjs");
const APP_DIR = resolve(ROOT, "vita");
const OUT_DIR = resolve(ROOT, "dist/vita");
const home = process.env.HOME ?? "";
const vitasdk = process.env.VITASDK || `${home}/vitasdk`;
const rustup = Bun.which("rustup") ?? `${home}/.cargo/bin/rustup`;
const argv = Bun.argv.slice(2);
const command = argv[0] ?? "build";
const lease = ["build", "cook", "cook-atlas", "lint", "vpk"].includes(command) ? undefined : await guardDeviceCommand(command === "serve" ? "vita:usb:transport" : "vita:usb");

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
/** Explicitly reuse an existing host without restarting the device's link. */
const USB_SHARE = resolve(value("--share", resolve(ROOT, ".pocket-build/vita-usb/share")));

interface BuildOptions {
  /** Packaged build: no USB debug driver, pack and GXPs inside the VPK. */
  readonly standalone?: boolean;
  /** VPK-relative files overlaid on the framework's LiveArea defaults. */
  readonly assets?: string;
}

/**
 * The id a build carries. A development build takes a fresh one, which the dev host tells two builds apart by.
 * `tools/release.ts` names a release build's instead (POCKET_RELEASE_BUILD: 32 hex digits from the commit and
 * the hashes of what the package is built from), so two builds of one commit are the same bytes.
 */
function buildId(): string {
  const named = process.env.POCKET_RELEASE_BUILD;
  if (named === undefined) return randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(named)) throw new Error("POCKET_RELEASE_BUILD is not 32 hex digits");
  return named;
}

async function build(options: BuildOptions = {}): Promise<string> {
  if (!existsSync(`${vitasdk}/bin/vita-pack-vpk`)) throw new Error(`VitaSDK not found at ${vitasdk}`);
  const usb = options.standalone ? undefined : await prepareVitaUsb();
  const nativeBuild = buildId();
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
  // The bubble icon is the Pocket3D icon, from PocketJS, in the development
  // build and in the standalone package: `icon` replaces sce_sys/icon0.png.
  await packageVitaVpk({ tool: `${vitasdk}/bin/vita-pack-vpk`, sfo, eboot, output: vpk, usbDriver: usb?.driver, applicationAssets: options.assets, icon: POCKET3D_ICON.vita });

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
  const share = USB_SHARE;
  mkdirSync(share, { recursive: true });
  await $`bun ${POCKETJS}/tools/vita-dev.ts ${args} --runtime ${runtime} --title ${title} --dir ${share}`.cwd(POCKETJS);
}

const SHARE = resolve(USB_SHARE, "atlas");
const PLACES_DIR = resolve(ROOT, ".pocket-build/places");
const PLACE_DIR = `${PLACES_DIR}/${PLACE}`;
const PACK = `${PLACE_DIR}/${PLACE}.place`;
/** The globe (`cook-atlas`, from web/scripts/export-atlas.ts). */
const ATLAS_PACK = resolve(ROOT, ".pocket-build/atlas/atlas.pack");
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

// The interface (ui/), compiled for the Vita: the device reads it beside the packs.
async function syncInterface(directory: string): Promise<void> {
  const ui = await compileInterface("vita");
  for (const file of ["atlas.js", "atlas.pak"]) copyIfChanged(`${ui.directory}/${file}`, `${directory}/${file}`);
}

// The device reads the pack and shader sources from the USB share; shaders
// recompile on the device when their source changes.
async function sync(): Promise<void> {
  lease?.assertHeld();
  await syncInterface(SHARE);
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
    ...[[], ["BAKED", "TANGENT", "COLOR"], ["SKINNED", "MAX_BONES=24"], ["VISTA"]].map((v): [string, string[]] => ["surface_v.cg", ["SUN", ...v]]),
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "SUN_SPEC", "ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "FOG"]], ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "ALPHA_TEST", "ALBEDO_MAP", "EMISSION_MAP", "FOG"]],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "FAR", "ALBEDO_MAP", "FOG"]], ["shadow_f.cg", []], ["shadow_f.cg", ["ALPHA_TEST"]], ["shadow_pair_f.cg", []], ["fill_f.cg", []], ["sky_day_f.cg", []], ["sky_day_f.cg", ["TWILIGHT"]],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "MOVING_SHADOW", "SUN_SPEC", "ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "FOG"]],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "MOVING_SHADOW", "FAR", "ALBEDO_MAP", "FOG"]],
    ["standard_f.cg", ["LIGHTS=0", "SUN", "MOVING_SHADOW", "SUN_SPEC", "FOG"]],
    ...[[], ["FAR"], ["LITE"], ["REFLECTION"]].map((tier): [string, string[]] => ["standard_f.cg", ["LIGHTS=0", "BAKED", "SUN", "MOVING_SHADOW", "SUN_SPEC", "VERTEX_COLOR", "VERTEX_PBR", "FOG", ...tier]]),
    ["globe_v.cg", []], ["globe_f.cg", []], ["marker_v.cg", []], ["marker_f.cg", []], ["surface_v.cg", ["WAVES"]], ["water_f.cg", ["SUN", "FOG"]], ["water_f.cg", []], ["water_f.cg", ["SUN", "FOG", "SHALLOW"]], ["surface_v.cg", ["WAVES", "COLOR"]], ["surface_v.cg", ["FLAT"]], ["surface_v.cg", ["BAKED", "FLAT"]],
    // Light fields and the vista haze (dusk-vista places).
    ["lights_v.cg", []], ["lights_v.cg", ["VISTA"]], ["lights_f.cg", []],
    ["surface_v.cg", ["BAKED", "VISTA"]], ["surface_v.cg", ["VISTA", "COLOR", "TANGENT"]], ["surface_v.cg", ["SKINNED", "MAX_BONES=24", "VISTA", "VERTEX_LIGHTS=2"]], ["surface_v.cg", ["WAVES", "VISTA"]], ["surface_v.cg", ["VISTA", "FLAT"]],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "FAR", "ALBEDO_MAP", "VISTA"]], ["standard_f.cg", ["LIGHTS=1", "BAKED", "ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "EMISSION_MAP", "VISTA"]],
    ["standard_f.cg", ["LIGHTS=2", "BAKED", "LITE", "WET", "PLANAR", "ALBEDO_MAP", "VISTA"]], ["standard_f.cg", ["LIGHTS=0", "VERTEX_LIGHTS", "ALBEDO_MAP", "VISTA", "BLEND"]],
    ["unlit_f.cg", ["ALBEDO_MAP", "VERTEX_COLOR", "VISTA"]], ["glass_f.cg", ["LIGHTS=0", "BAKED", "VISTA"]], ["window_f.cg", ["VISTA"]], ["water_f.cg", ["VISTA"]],
    ["post_v.cg", []], ["post_v.cg", ["GRAIN"]], ["haze_f.cg", ["HAZE_LIGHTS=2"]], ["haze_f.cg", ["HAZE_LIGHTS=6"]], ["prefilter_f.cg", []], ["prefilter_f.cg", ["PER_PIXEL"]], ["prefilter_f.cg", ["HAZE"]], ["prefilter_f.cg", ["HAZE", "PER_PIXEL"]], ["down_f.cg", []], ["up_f.cg", []], ["composite_f.cg", []], ["composite_f.cg", ["HAZE", "BLOOM"]], ["blit_f.cg", []],
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
let evidence: DeviceEvidence<object> | undefined;
let expectedIdentity: DeviceIdentity | undefined;
let compilation: ReturnType<typeof compileIdentity> | undefined;
const sampledCameras = new Set<string>();
const timingWindows = new Map<string, { frame: number; shaderGeneration: number }>();
const evidenceDirectory = resolve(ROOT, `.pocket-build/validation/vita/${command}-${Date.now()}`);
function shaderIdentity(): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(`${APP_DIR}/shaders`).sort()) hash.update(name).update(readFileSync(`${APP_DIR}/shaders/${name}`));
  return hash.digest("hex");
}
function observe(e: any, detail: object) {
  if (!expectedIdentity) throw new Error("Missing Vita runtime identity");
  evidence ??= new DeviceEvidence<object>(expectedIdentity);
  compilation ??= compileIdentity(PACK, "vita", value("--compile", PACK.replace(/\.place$/, ".compile.json")));
  if (compilation.packSha256 !== expectedIdentity.assets.pack) throw new Error("Vita pack changed before its measurement");
  if (!["capture", "begin"].includes((detail as any).kind)) {
    const key = JSON.stringify(detail), previous = timingWindows.get(key);
    assertFrameSample(e, previous?.frame ?? -1, ["frameMs", "cpuSubmitMs", "waitMs", "swapMs", "shaderGeneration"]);
    if (e.settings?.profile !== RENDER || e.pending || e.main?.missing || e.reflection?.missing ||
        (previous && previous.shaderGeneration !== e.shaderGeneration)) throw new Error("Vita render settings/programs changed during timing");
    timingWindows.set(key, { frame: e.frame, shaderGeneration: e.shaderGeneration });
  }
  evidence.observe({ device: expectedIdentity.device, runtimeBuild: e.runtimeBuild, assets: { pack: e.packSha256, shaders: e.shaderSourceSha256 } },
    { ...detail, sample: e, missedBudget: Number(e.frameMs) > compilation.budgetMs });
}

/** The device's engine status (the USB host replaces the file while it is read). */
function engine(): any {
  lease?.assertHeld();
  for (let i = 0; ; i++) {
    try {
      const status = new VitaUsbClient(USB_SHARE, title).status();
      const runtime = JSON.parse(readFileSync(`${OUT_DIR}/${output}.runtime.json`, "utf8"));
      if (status.nativeBuild !== runtime.nativeBuild) throw new Error("another native build owns the Vita; refusing to measure it");
      if (status.error || status.engine?.renderError || status.engine?.errors?.length) throw new Error(`Vita renderer error: ${JSON.stringify(status.error || status.engine.renderError || status.engine.errors)}`);
      const e = status.engine ?? {};
      if (e.stage === "running") {
        if (e.place !== PLACE) throw new Error(`Expected ${PLACE}, found ${e.place}`);
        expectedIdentity ??= { device: "vita:usb", runtimeBuild: runtime.nativeBuild, assets: { pack: fileSha256(PACK), shaders: shaderIdentity() } };
        assertDeviceIdentity(expectedIdentity, { device: "vita:usb", runtimeBuild: String(status.nativeBuild), assets: { pack: e.packSha256, shaders: e.shaderSourceSha256 } });
        e.runtimeBuild = status.nativeBuild;
        e.frame = status.frame;
      }
      return e;
    } catch (e) { if (i > 20) throw e; }
    Bun.sleepSync(50);
  }
}

interface Shot { name: string; from: { pos: number[]; target: number[]; fov: number }; to: { pos: number[]; target: number[]; fov: number } }

/** Camera coverage comes from the measured pack, not a potentially newer browser export. */
function shotList(): Shot[] {
  return JSON.parse(readPack(readFileSync(PACK), "PLCE", VITA_PACK_VERSION).section("META").toString("utf8")).camera.shots;
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
      assertVitaMeasurement(e, { ...shot, settings: { ...base, ...off } });
      observe(e, { kind: "timing", mode: "bench", variant: name, view: shot.view, time: shot.time });
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
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ ...shot, settings: { ...extra, profile: true } }) + "\n");
  await settle();
  // Reflection and haze redraw on alternate frames: each scene averages
  // over the sampled frames that drew it, with the share of frames it ran in.
  const sum = new Map<string, { ms: number; frames: number }>();
  const n = 12;
  for (let i = 0; i < n; i++) {
    // Jittered, so samples do not lock onto one parity of alternating frames.
    await Bun.sleep(280 + Math.random() * 90);
    const seen = new Map<string, number>();
    const e = engine();
    if (e.stage !== "running" || e.place !== PLACE) throw new Error("requested place changed during GPU profiling");
    assertVitaMeasurement(e, { ...shot, settings: { ...extra, profile: true } });
    observe(e, { kind: "serialized-gpu-timing", view: shot.view, time: shot.time });
    for (const [name, ms] of e.passes ?? []) seen.set(name, (seen.get(name) ?? 0) + ms);
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
  for (let i = 0; i < 1200; i++) {
    const e = engine();
    if (e.stage === "running" && e.place === PLACE && !(e.main?.missing || e.reflection?.missing || e.pending)) return;
    if (i % 10 === 0) console.log(`waiting for programs: ${e.pending ?? 0} compiling, ${e.main?.missing ?? 0} + ${e.reflection?.missing ?? 0} draws missing`);
    await Bun.sleep(500);
  }
  throw new Error("programs still compiling after 10 minutes");
}

// Frame time per shot (halfway view, fixed time) at every quality step of
// the profile, the governor held: which step each view sustains.
async function sweep(): Promise<void> {
  const extra = argv[1] && !argv[1].startsWith("--") ? JSON.parse(argv[1]) : {};
  const names = value("--shots", "").split(",").filter(Boolean).map((n) => n.toLowerCase());
  const shots = shotList().filter((s) => !names.length || names.includes(s.name.toLowerCase()));
  if (!shots.length || names.some(n => !shots.some(s => s.name.toLowerCase() === n))) throw new Error("Unknown or empty Vita camera selection");
  const time = Number(value("--time", "100"));
  mkdirSync(SHARE, { recursive: true });
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
  await Bun.sleep(1500);
  const steps = Number(value("--steps", String(engine().settings?.steps ?? 1)));
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > engine().settings.steps) throw new Error("Invalid Vita quality-step count");
  console.log(`render profile ${RENDER}, time ${time} s, frame ms per step (cpu submit ms)`);
  console.log(`${"".padEnd(10)} ${[...Array(steps).keys()].map((k) => `step ${k}`.padStart(13)).join("")}`);
  for (const s of shots) {
    const row: string[] = [];
    for (let k = 0; k < steps; k++) {
      await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER, view: shotView(s), time, settings: { ...extra, step: k, hold: true } }) + "\n");
      await settle();
      let ms = 0;
      let cpu = 0;
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(400);
        const e = engine();
        assertVitaMeasurement(e, { view: shotView(s), time, settings: { ...extra, step: k, hold: true } });
        observe(e, { kind: "timing", shot: s.name, step: k, view: shotView(s), time });
        sampledCameras.add(s.name);
        ms += e.frameMs / 6;
        cpu += e.cpuSubmitMs / 6;
      }
      row.push(`${ms.toFixed(1)} (${cpu.toFixed(1)})`.padStart(13));
      mkdirSync(evidenceDirectory, { recursive: true });
      const capture = `${evidenceDirectory}/camera-${shots.indexOf(s)}-step-${k}.png`;
      await dev("capture", "--out", capture);
      observe(engine(), { kind: "capture", shot: s.name, step: k, path: capture, sha256: fileSha256(capture), visualReview: "not-recorded" });
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
  await syncInterface(stage);
  console.log(`atlas: staged ${hashes.length} programs, the atlas and ${places.map(([id]) => id).join(", ")} in ${stage}`);
  await build({ standalone: true, assets: stage });
}

// Frame time per cinematic shot while the camera rig plays (render profile
// and governor as they run for a viewer).
async function shots(): Promise<void> {
  const seconds = Number(value("--seconds", "90"));
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
  await settle();
  const acc = new Map<string, { ms: number[]; steps: Set<number>; levels: Set<number> }>();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const e = engine();
      if (e.stage !== "running" || e.place !== PLACE) throw new Error("requested place is not running");
      observe(e, { kind: "timing", shot: e.view.shot });
      sampledCameras.add(e.view.shot);
      const a = acc.get(e.view.shot) ?? { ms: [], steps: new Set(), levels: new Set() };
      a.ms.push(e.frameMs);
      a.steps.add(e.settings.step);
      a.levels.add(e.settings.level);
      acc.set(e.view.shot, a);
    } catch (e) { throw new Error(`shot measurement interrupted: ${e}`); }
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
// Every program a package needs (tools/vita-programs.ts): each Vita place under each frame rate, each switch a
// member has thrown both ways, in a process started for the pass, so the console's list is what those settings
// ask for and nothing an earlier run left. The list, its programs and the record of the pass go to
// .pocket-build/vita-programs/, which `tools/release.ts` packs.
async function programs(): Promise<void> {
  const places = vitaPlaces(), profiles = profileNames();
  const uncooked = places.filter((id) => !existsSync(`${PLACES_DIR}/${id}/${id}.place`));
  if (uncooked.length) throw new Error(`${uncooked.join(", ")} not cooked: run \`bun tools/atlas.ts cook --place ID\` first`);
  await sync();
  await build();
  await dev("native");
  const runtime = JSON.parse(readFileSync(`${OUT_DIR}/${output}.runtime.json`, "utf8"));
  const client = new VitaUsbClient(USB_SHARE, title);
  /** This build's engine status, or null while it is not up (the USB host replaces the file while it is read). */
  const read = (): any => {
    lease?.assertHeld();
    try {
      const status = client.status();
      return status.nativeBuild === runtime.nativeBuild ? (status.engine ?? null) : null;
    } catch {
      return null;
    }
  };
  const send = (message: object) => writeFileSync(`${SHARE}/control.json`, JSON.stringify({ ...message, nonce: Date.now() }) + "\n");
  /** Waits until `ready` has held for a second. A program that failed stops the pass. */
  const wait = async (what: string, ready: (e: any) => boolean, seconds = 240): Promise<any> => {
    for (let held = 0, i = 0; i < seconds * 4; i++) {
      await Bun.sleep(250);
      const e = read();
      if (e?.errors?.length) throw new Error(`a program failed in ${what}: ${JSON.stringify(e.errors)}`);
      held = e && ready(e) ? held + 1 : 0;
      if (held >= 4) return e;
    }
    throw new Error(`the console did not settle in ${what}: is Pocket Devkit on screen and the cable in?`);
  };
  /** Nothing compiling and no draw waiting for its program. */
  const drawn = (e: any) => !e.pending && !e.main?.missing && !e.reflection?.missing;
  await wait("the atlas", (e) => e.stage === "atlas", 120);
  const renderErrors: Coverage["renderErrors"] = [];
  let last: any;
  for (const profile of profiles)
    for (const place of places) {
      const here = `${place} at ${profile}`;
      const loaded = (e: any) => e.stage === "running" && e.place === place && e.settings?.profile === profile && drawn(e);
      send({ renderProfile: profile, place });
      await wait(here, loaded);
      for (const settings of PROGRAM_SETTINGS) {
        send({ settings });
        await Bun.sleep(500);
        await wait(`${here} with ${JSON.stringify(settings)}`, (e) => e.stage === "running" && e.place === place && drawn(e));
      }
      // The profile's own switches and its governor again.
      send({ renderProfile: profile, settings: { hold: false } });
      await Bun.sleep(500);
      last = await wait(here, loaded);
      if (last.renderError) renderErrors.push({ profile, place, error: String(last.renderError) });
      console.log(`atlas: ${here}: ${last.compiled} compiled so far${last.renderError ? `, ${last.renderError}` : ""}`);
    }
  if (last.shaderSourceSha256 !== shaderSources()) throw new Error("the console compiled other shader sources than vita/shaders holds");
  // The list is rewritten when a program is first needed: the last one is in it once nothing is pending.
  await Bun.sleep(2000);
  const manifest = readFileSync(`${SHARE}/gxp/manifest.txt`, "utf8");
  const rows = manifest.split("\n").filter(Boolean);
  rmSync(PROGRAMS_DIR, { recursive: true, force: true });
  mkdirSync(PROGRAMS_DIR, { recursive: true });
  for (const row of rows) cpSync(`${SHARE}/gxp/${row.slice(0, 16)}.gxp`, `${PROGRAMS_DIR}/${row.slice(0, 16)}.gxp`);
  writeFileSync(`${PROGRAMS_DIR}/manifest.txt`, manifest);
  const coverage: Coverage = {
    schema: 1, at: new Date().toISOString(), nativeBuild: runtime.nativeBuild, shaderSourcesSha256: shaderSources(), places, profiles, settings: PROGRAM_SETTINGS,
    programs: rows.length, manifestSha256: createHash("sha256").update(manifest).digest("hex"), compiled: last.compiled, renderErrors,
  };
  writeFileSync(`${PROGRAMS_DIR}/coverage.json`, JSON.stringify(coverage, null, 2) + "\n");
  send({ renderProfile: "vita30", atlas: true });
  console.log(`atlas: ${rows.length} programs over ${places.length} places × ${profiles.length} frame rates × ${PROGRAM_SETTINGS.length} settings (${last.compiled} compiled in this pass) → ${PROGRAMS_DIR}`);
}

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

let completed = false;
try {
if (["bench", "profile", "shots", "sweep"].includes(command)) observe(engine(), { kind: "begin" });
if (command === "build") await build();
else if (command === "push-vpk") await pushVpk();
else if (command === "vpk") await vpk();
else if (command === "programs") await programs();
else if (command === "lint") await lint();
else if (command === "bench") await bench();
else if (command === "profile") await profile();
else if (command === "shots") await shots();
else if (command === "sweep") await sweep();
else if (command === "sync") await sync();
else if (command === "ctl") {
  mkdirSync(SHARE, { recursive: true });
  const body = argv[1] ?? "{}";
  JSON.parse(body);
  await Bun.write(`${SHARE}/control.json`, body + "\n");
  console.log(`atlas: ${SHARE}/control.json = ${body}`);
} else if (command === "native") {
  await sync();
  await build();
  await dev("native");
} else if (command === "serve") {
  await dev("serve");
} else if (command === "cook") {
  const tex = Number(value("--tex", "1024"));
  if (![128, 256, 512, 1024, 2048].includes(tex)) throw new Error("--tex must be 128, 256, 512, 1024 or 2048");
  await $`cargo run --release --locked -p pocket3d-place-cook -- --target vita --in ${PLACE_DIR} --tex ${tex}`.cwd(ROOT);
} else if (command === "cook-atlas") {
  await $`cargo run --release --locked -p pocket3d-place-cook -- atlas --in ${resolve(ROOT, ".pocket-build/atlas/globe")} --out ${ATLAS_PACK}`.cwd(ROOT);
} else if (command === "capture") {
  const out = value("--out", resolve(ROOT, `.pocket-build/validation/captures/${new Date().toISOString().replace(/[:.]/g, "-")}.png`));
  await dev("capture", "--out", out);
} else if (command === "status" || command === "menu") {
  const rest = argv.slice(1).filter((a, i, all) => a !== "--title" && all[i - 1] !== "--title");
  await dev(command, ...rest);
} else throw new Error(`unknown atlas command: ${command}`);
completed = true;
} finally {
  if (evidence) {
    mkdirSync(evidenceDirectory, { recursive: true });
    const cameras = shotList().map(s => s.name);
    writeFileSync(`${evidenceDirectory}/device.json`, JSON.stringify({ ...evidence.receipt(), compilation, complete: completed, renderProfile: RENDER,
      cameras: [...sampledCameras], allCameras: cameras.every(n => sampledCameras.has(n)) }, null, 2));
    // Release fixed-time/profile controls even after an interrupted measurement.
    lease?.assertHeld();
    const status = new VitaUsbClient(USB_SHARE, title).status();
    if (expectedIdentity && status.nativeBuild === expectedIdentity.runtimeBuild && status.engine?.packSha256 === expectedIdentity.assets.pack)
      writeFileSync(`${SHARE}/control.json`, JSON.stringify({ place: PLACE, renderProfile: RENDER }) + "\n");
    console.log(`Device evidence: ${evidenceDirectory}/device.json`);
  }
}
