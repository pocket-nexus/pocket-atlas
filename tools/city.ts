// Pocket City on PS Vita: build the native runtime, replace it on a device
// over PocketJS's wired debug transport (vendor/pocketjs), sync shader
// sources, fetch captures, and package the standalone VPK.
//
//   bun tools/city.ts cook                          # scene.glb → tokyo.pcity
//   bun tools/city.ts serve                         # USB host (keep running)
//   bun tools/city.ts build  [--title P6424D941] [--debug]
//   bun tools/city.ts vpk                           # standalone PKCT00001 VPK
//   bun tools/city.ts push-vpk                      # → ux0:data/pocket-city/ via the dev build
//   bun tools/city.ts native [--title P6424D941]   # build + USB SELF replacement
//   bun tools/city.ts status|capture [--title ...]
//   bun tools/city.ts sync                          # pack + shader sources → host0:city/
//   bun tools/city.ts ctl '{"settings":{"haze":false}}' # host0:city/control.json
//   bun tools/city.ts lint                          # parse/type-check Cg on the host
//   bun tools/city.ts bench                         # frame cost per renderer feature
//   bun tools/city.ts profile ['{"msaa":false}']    # GPU time per scene
//
// The default title is the installed Pocket Hero development runtime, whose
// native slot accepts replacement SELFs; reopening its LiveArea bubble
// restores Hero. `--title PKCT00001` builds the standalone Pocket City VPK.

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

const title = value("--title", command === "vpk" ? "PKCT00001" : "P6424D941");
const release = !argv.includes("--debug");
const output = `pocket-city-${title}`;

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
  console.log(`city: cargo vita build vpk (title ${title}, ${release ? "release" : "debug"})`);
  await $`${rustup} run nightly-2026-05-28 cargo vita build vpk ${cargoArgs}`.cwd(APP_DIR).env(env);

  const target = `${APP_DIR}/target/armv7-sony-vita-newlibeabihf/${release ? "release" : "debug"}`;
  const eboot = `${target}/pocket-city-vita.self`;
  const sfo = `${target}/pocket-city-vita.sfo`;
  const vpk = `${target}/pocket-city-vita.vpk`;
  // Unsafe-homebrew SELF: loading the USB driver and writing the inactive
  // native slot need the standard homebrew permissions.
  await $`${vitasdk}/bin/vita-make-fself ${target}/pocket-city-vita.velf ${eboot}`;
  await $`${vitasdk}/bin/vita-mksfoex -d ATTRIBUTE2=12 -s TITLE_ID=${title} ${"Pocket City"} ${sfo}`;
  await packageVitaVpk({ tool: `${vitasdk}/bin/vita-pack-vpk`, sfo, eboot, output: vpk, usbDriver: usb?.driver, applicationAssets: options.assets });

  mkdirSync(OUT_DIR, { recursive: true });
  cpSync(vpk, `${OUT_DIR}/${output}.vpk`);
  cpSync(eboot, `${OUT_DIR}/${output}.self`);
  const selfSha256 = createHash("sha256").update(readFileSync(eboot)).digest("hex");
  const runtime = `${OUT_DIR}/${output}.runtime.json`;
  await Bun.write(runtime, JSON.stringify({
    version: 1, titleId: title, applicationId: "nexus.pocket.city", output, nativeBuild, plan: null,
    self: `${output}.self`, usbDebug: !options.standalone, usbDriver: usb?.fingerprint ?? null, selfSha256,
  }, null, 2) + "\n");
  console.log(`city: ${OUT_DIR}/${output}.vpk (native build ${nativeBuild})`);
  return runtime;
}

// PocketJS's wired debug tool, pointed at this repository's USB share.
async function dev(...args: string[]): Promise<void> {
  const runtime = `${OUT_DIR}/${output}.runtime.json`;
  const share = resolve(ROOT, ".pocket-build/vita-usb/share");
  mkdirSync(share, { recursive: true });
  await $`bun ${POCKETJS}/tools/vita-dev.ts ${args} --runtime ${runtime} --title ${title} --dir ${share}`.cwd(POCKETJS);
}

const SHARE = resolve(ROOT, ".pocket-build/vita-usb/share/city");
const PACK = resolve(ROOT, ".pocket-build/city/tokyo/tokyo.pcity");

// The device reads the pack and shader sources from the USB share; shaders
// recompile on the device when their source changes.
function sync(): void {
  // The device never creates directories on host0: (stat-style requests stall
  // the USB channel); every directory it writes into exists up front.
  for (const dir of ["shaders", "gxp", "errors"]) mkdirSync(`${SHARE}/${dir}`, { recursive: true });
  cpSync(`${APP_DIR}/shaders`, `${SHARE}/shaders`, { recursive: true });
  // The device polls this one file and reloads the sources when it changes.
  const stamp = createHash("sha256");
  for (const f of readdirSync(`${APP_DIR}/shaders`).sort()) stamp.update(f).update(readFileSync(`${APP_DIR}/shaders/${f}`));
  writeFileSync(`${SHARE}/shaders/stamp`, stamp.digest("hex"));
  if (!existsSync(PACK)) throw new Error(`${PACK} missing: run the cooker first`);
  const dst = `${SHARE}/tokyo.pcity`;
  const same = existsSync(dst) && Bun.file(dst).size === Bun.file(PACK).size &&
    createHash("sha256").update(readFileSync(dst)).digest("hex") === createHash("sha256").update(readFileSync(PACK)).digest("hex");
  if (!same) cpSync(PACK, dst);
  console.log(`city: synced shaders${same ? "" : " and pack"} to ${SHARE}`);
}

// Host-side Cg check through open-shacccg's glslang front end (set
// OPENSHACCG to its openshacccg_compile). Its backend rejects most real
// shaders ("unsupported … subset"); reaching the backend means the source
// parsed and type-checked, which is what this catches before a device run.
async function lint(): Promise<void> {
  const tool = process.env.OPENSHACCG ?? `${home}/.cache/pocket-city/open-shacccg/build-gl/openshacccg_compile`;
  if (!existsSync(tool)) throw new Error(`openshacccg_compile not found (OPENSHACCG=${tool})`);
  const dir = `${APP_DIR}/shaders`;
  const expand = (name: string): string =>
    readFileSync(`${dir}/${name}`, "utf8").split("\n").map((line, i) => {
      const m = line.trim().match(/^#include\s+"(.+)"/);
      return m ? `${expand(m[1]!)}\n#line ${i + 2} "${name}"` : line;
    }).join("\n");
  const lit = ["ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "EMISSION_MAP", "VERTEX_COLOR", "WET", "PLANAR", "FOG"];
  const cases: [string, string[]][] = [
    ["surface_v.cg", []], ["surface_v.cg", ["SKINNED", "MAX_BONES=24"]], ["surface_v.cg", ["BAKED"]],
    ["standard_f.cg", ["LIGHTS=2", "BAKED", "WET", "PLANAR", "ALBEDO_MAP", "NORMAL_MAP", "ORM_MAP", "FOG"]], ["debug_f.cg", []],
    ["standard_f.cg", ["LIGHTS=0", "BAKED", "FAR", "DAMP", "ALBEDO_MAP", "NORMAL_MAP", "FOG"]], ["glass_f.cg", ["LIGHTS=0", "BAKED", "FOG"]],
    ["standard_f.cg", ["LIGHTS=4", ...lit]], ["standard_f.cg", ["LIGHTS=2", "DAMP", "CLEARCOAT", "ALPHA_TEST", "REFLECTION"]],
    ["standard_f.cg", ["LIGHTS=0", "INTERIOR", "ALBEDO_MAP"]], ["unlit_f.cg", ["ALBEDO_MAP", "VERTEX_COLOR", "FOG", "ALPHA_TEST"]],
    ["glass_f.cg", ["LIGHTS=4", "FOG"]], ["glass_f.cg", ["LIGHTS=0", "REFLECTION"]], ["window_f.cg", ["FOG"]], ["window_f.cg", ["REFLECTION"]],
    ["products_f.cg", []], ["skyline_f.cg", []], ["tower_f.cg", []], ["sky_v.cg", []], ["sky_f.cg", []],
    ...["STREAK", "SPLASH", "DRIP", "STEAM", "BEACON"].map((d): [string, string[]] => ["fx_v.cg", [d]]),
    ...["STREAK", "SPLASH", "STEAM", "BEACON"].map((d): [string, string[]] => ["fx_f.cg", [d]]),
    ["post_v.cg", []], ["haze_f.cg", []], ["prefilter_f.cg", []], ["down_f.cg", []], ["up_f.cg", []], ["composite_f.cg", []], ["blit_f.cg", []],
  ];
  const tmp = resolve(ROOT, ".pocket-build/city/lint");
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

// Renderer switches as the device starts; every measurement sends the full
// set so no switch carries over from an earlier run.
const DEFAULTS = { reflection: true, haze: true, bloom: true, rain: true, msaa: true, flat: false, maxLights: 4, fx: 63, skip: 0, hud: true, amortize: true, scale: 1 };

// Frame cost per renderer feature at a fixed view and time: each row turns
// one feature off (or all of them) through control.json and averages the
// frame times the device reports once the change has settled.
async function bench(): Promise<void> {
  const status = resolve(ROOT, `.pocket-build/vita-usb/share/pocket-vita/${title}/status.json`);
  // The USB host replaces status.json while it is read; retry the read.
  const engine = (): any => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(readFileSync(status, "utf8")).engine ?? {}; } catch (e) { if (i > 20) throw e; }
      Bun.sleepSync(50);
    }
  };
  const view = engine().view;
  if (engine().stage !== "running" || !view) throw new Error("the device is not running Pocket City");
  const shot = { view: { pos: view.pos, target: view.target, fov: view.fov }, time: engine().time };
  const all = DEFAULTS;
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
    await Bun.write(`${SHARE}/control.json`, JSON.stringify({ ...shot, settings: { ...all, ...off } }) + "\n");
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
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ settings: all }) + "\n");
}

// GPU time per scene at the current view: the device serializes the frame
// while `profile` is on and reports each scene's duration.
async function profile(): Promise<void> {
  const status = resolve(ROOT, `.pocket-build/vita-usb/share/pocket-vita/${title}/status.json`);
  const engine = (): any => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(readFileSync(status, "utf8")).engine ?? {}; } catch (e) { if (i > 20) throw e; }
      Bun.sleepSync(50);
    }
  };
  const view = engine().view;
  if (engine().stage !== "running" || !view) throw new Error("the device is not running Pocket City");
  const extra = argv[1] ? JSON.parse(argv[1]) : {};
  const shot = { view: { pos: view.pos, target: view.target, fov: view.fov }, time: engine().time };
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ ...shot, settings: { ...DEFAULTS, profile: true, ...extra } }) + "\n");
  await Bun.sleep(3000);
  const sum = new Map<string, number>();
  const n = 8;
  for (let i = 0; i < n; i++) {
    await Bun.sleep(400);
    const seen = new Map<string, number>();
    for (const [name, ms] of engine().passes ?? []) seen.set(name, (seen.get(name) ?? 0) + ms);
    for (const [name, ms] of seen) sum.set(name, (sum.get(name) ?? 0) + ms / n);
  }
  let total = 0;
  for (const [name, ms] of sum) {
    total += ms;
    console.log(`${name.padEnd(16)} ${ms.toFixed(2).padStart(7)} ms`);
  }
  console.log(`${"total".padEnd(16)} ${total.toFixed(2).padStart(7)} ms`);
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ ...shot, settings: { ...DEFAULTS, profile: false } }) + "\n");
}

// Standalone VPK (title PKCT00001 unless --title is given): the cooked pack
// and the GXP programs the device compiled for this source revision (listed
// in host0:city/gxp/manifest.txt) go into app0:, so the package runs
// without the runtime compiler or a computer.
async function vpk(): Promise<void> {
  const manifest = `${SHARE}/gxp/manifest.txt`;
  if (!existsSync(manifest)) throw new Error(`${manifest} missing: run the development build on the device first`);
  const stage = resolve(ROOT, ".pocket-build/city/vpk");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(`${stage}/gxp`, { recursive: true });
  cpSync(`${APP_DIR}/assets`, stage, { recursive: true });
  const hashes = readFileSync(manifest, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]!);
  for (const h of hashes) {
    const gxp = `${SHARE}/gxp/${h}.gxp`;
    if (!existsSync(gxp)) throw new Error(`${gxp} missing`);
    cpSync(gxp, `${stage}/gxp/${h}.gxp`);
  }
  if (!existsSync(PACK)) throw new Error(`${PACK} missing: run the cooker first`);
  cpSync(PACK, `${stage}/tokyo.pcity`);
  console.log(`city: staged ${hashes.length} programs and the pack in ${stage}`);
  await build({ standalone: true, assets: stage });
}

// Copies the standalone VPK to ux0:data/pocket-city/ through the running
// development build, ready to install from VitaShell.
async function pushVpk(): Promise<void> {
  const name = "pocket-city-PKCT00001.vpk";
  const vpkPath = `${OUT_DIR}/${name}`;
  if (!existsSync(vpkPath)) throw new Error(`${vpkPath} missing: run \`bun tools/city.ts vpk\` first`);
  mkdirSync(`${SHARE}/outbox`, { recursive: true });
  rmSync(`${SHARE}/outbox/${name}.done`, { force: true });
  cpSync(vpkPath, `${SHARE}/outbox/${name}`);
  await Bun.write(`${SHARE}/control.json`, JSON.stringify({ fetch: name, nonce: Date.now() }) + "\n");
  const done = `${SHARE}/outbox/${name}.done`;
  for (let i = 0; i < 600 && !existsSync(done); i++) await Bun.sleep(500);
  if (!existsSync(done)) throw new Error("the device did not pick up the package (is the development build running?)");
  console.log(`city: ${readFileSync(done, "utf8").trim()}`);
}

if (command === "build") await build();
else if (command === "push-vpk") await pushVpk();
else if (command === "vpk") await vpk();
else if (command === "lint") await lint();
else if (command === "bench") await bench();
else if (command === "profile") await profile();
else if (command === "sync") sync();
else if (command === "ctl") {
  mkdirSync(SHARE, { recursive: true });
  const body = argv[1] ?? "{}";
  JSON.parse(body);
  await Bun.write(`${SHARE}/control.json`, body + "\n");
  console.log(`city: ${SHARE}/control.json = ${body}`);
} else if (command === "native") {
  sync();
  await build();
  await dev("native");
} else if (command === "serve") {
  await dev("serve");
} else if (command === "cook") {
  await $`cargo run --release -p pocket3d-city-cook -- --in ${resolve(ROOT, ".pocket-build/city/tokyo")}`.cwd(ROOT);
} else if (command === "capture") {
  const out = value("--out", resolve(ROOT, `.pocket-build/validation/captures/${new Date().toISOString().replace(/[:.]/g, "-")}.png`));
  await dev("capture", "--out", out);
} else if (command === "status" || command === "menu") {
  const rest = argv.slice(1).filter((a, i, all) => a !== "--title" && all[i - 1] !== "--title");
  await dev(command, ...rest);
} else throw new Error(`unknown city command: ${command}`);
