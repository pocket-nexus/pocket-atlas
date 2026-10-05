/** Pocket Atlas on Android, built for the Redmi 1S (HM 1S: Android 4.3,
 * Adreno 305, OpenGL ES 3.0): cook, build, package, install and measure.
 * The app is a NativeActivity with no Java: the C in android/src, PocketJS's
 * runtime for the interface (its UI core with the OpenGL ES 2 backend,
 * QuickJS and the guest driver), the Pocket3D title card (android/title) and
 * the packs. The NDK compiles it, `aapt`, `zipalign` and `apksigner` package
 * it; there is no Gradle project. */
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureQuickJsCheckout, quickJsCheckout } from "../vendor/pocketjs/tools/native-host-build.ts";
import { POCKET3D_ICON_ANDROID } from "../vendor/pocketjs/tools/pocket3d-icon.ts";
import { PLACES } from "../web/src/places/registry";
import { globeSurface } from "./atlas-globe";
import { compileInterface } from "./atlas-ui";

const root = resolve(import.meta.dir, "..");
const pocket = join(root, "vendor/pocketjs");
const args = Bun.argv.slice(2);
const command = args[0] ?? "build";
const option = (key: string, fallback = "") => (args.includes(key) ? (args[args.indexOf(key) + 1] ?? fallback) : fallback);
const out = join(root, ".pocket-build/android");
const assets = join(out, "assets");
const validation = join(root, ".pocket-build/validation/android");
// Another identity installs beside a build that is being compared against.
export const PACKAGE = process.env.ATLAS_ANDROID_PACKAGE ?? "dev.pocketnexus.atlas";
const ACTIVITY = `${PACKAGE}/android.app.NativeActivity`;
/** Where the tool pushes what the app reads from outside its APK. */
const PUSHED = `/data/local/tmp/${PACKAGE}`;
const FILES = `/data/data/${PACKAGE}/files`;
export const PROFILE = "redmi1s60";
const profile = JSON.parse(readFileSync(join(root, `profiles/${PROFILE}.json`), "utf8"));
/** A release build has no door for pushed code or packs and always plays the title card. */
const release = args.includes("--release");

// The toolchain: the last NDK that builds for API 18, and PocketJS's pins for
// the guest's runtime (the QuickJS revision and the Rust toolchain its UI
// core builds with).
const pins = JSON.parse(readFileSync(join(pocket, "tools/cli/moto-g-play-toolchain.json"), "utf8"));
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "/opt/homebrew/share/android-commandlinetools";
const ndk = process.env.ANDROID_NDK_HOME ?? join(sdk, "ndk/21.4.7075529");
const llvm = join(ndk, "toolchains/llvm/prebuilt", process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64", "bin");
const clang = join(llvm, "armv7a-linux-androideabi18-clang");
const glue = join(ndk, "sources/android/native_app_glue");
const buildTools = join(sdk, "build-tools/34.0.0");
const platform = join(sdk, "platforms/android-34/android.jar");
const javaHome = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17";
const RUST = pins.rust.toolchain as string, RUST_TARGET = "armv7-linux-androideabi";
const cache = join(homedir(), ".cache/pocket-nexus/android");
const quickJs = quickJsCheckout(join(cache, "sources/quickjs-rs"));
// PocketJS's Android tools keep one debug key; an installed app upgrades only under the key it was signed with.
const signing = join(cache, "signing");
const keystore = join(signing, ["blackberry-android-probe.jks", "blackberry-classic.jks", "android-debug.jks"].find((name) => existsSync(join(signing, name))) ?? "android-debug.jks");

const places = PLACES.filter((p) => p.status === "live" && p.targets?.includes("android") && (!option("--place") || p.id === option("--place")));

function run(cmd: string[], cwd = root, env: Record<string, string | undefined> = process.env): string {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${p.stdout.toString()}${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const newer = (output: string, inputs: string[]) => !existsSync(output) || inputs.some((file) => statSync(file).mtimeMs > statSync(output).mtimeMs);

// ---- the phone

/** The one phone this build is for, or the one ANDROID_SERIAL names. */
function serial(): string {
  const listed = run(["adb", "devices"]).split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((part) => part[1] === "device").map((part) => part[0]);
  const wanted = process.env.ANDROID_SERIAL;
  if (wanted) {
    if (!listed.includes(wanted)) throw new Error(`${wanted} is not connected and authorized`);
    return wanted;
  }
  if (listed.length !== 1) throw new Error(`expected one authorized Android device, found ${listed.length}: set ANDROID_SERIAL`);
  return listed[0];
}
let phone = "";
const adb = (...cmd: string[]) => run(["adb", "-s", (phone ||= serial()), ...cmd]);
/** A shell command's output without the ROM's "open: Permission denied" noise and carriage returns. */
const shell = (script: string) => adb("shell", script).replace(/\r/g, "").split("\n").filter((line) => line !== "open: Permission denied").join("\n").trim();
function push(from: string, name: string) {
  shell(`mkdir -p ${PUSHED}; chmod 755 ${PUSHED}`);
  adb("push", from, `${PUSHED}/${name}`);
  shell(`chmod 644 ${PUSHED}/${name}`);
}
function pull(name: string, to: string): Buffer {
  mkdirSync(dirname(to), { recursive: true });
  adb("pull", `${FILES}/${name}`, to);
  return readFileSync(to);
}
const status = (): Record<string, any> => JSON.parse(pull("status.json", join(out, "status.json")).toString());
/** Sends a command and waits until a shown frame acknowledges it. */
async function control(message: Record<string, unknown>) {
  const nonce = randomBytes(8).toString("hex"), file = join(out, "control.json");
  mkdirSync(out, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...message, nonce }));
  push(file, "control.json");
  for (let attempt = 0; attempt < 120; attempt++) {
    await Bun.sleep(400);
    let s: Record<string, any>;
    try { s = status(); } catch { continue; }
    if (s.lastCommand === nonce && (!(message.capture || message.screen) || s.capture === nonce)) return s;
  }
  throw new Error("the phone did not acknowledge the command");
}
/** The frame before the interface, or with `screen` as shown, interface and all. */
async function capture(output: string, screen = false) {
  const s = await control(screen ? { screen: true } : { capture: true });
  const name = screen ? "screen.rgba" : "frame.rgba", raw = join(out, name);
  pull(name, raw);
  mkdirSync(dirname(output), { recursive: true });
  // Rows from the bottom of the window.
  run(["magick", "-size", `${s.window[0]}x${s.window[1]}`, "-depth", "8", `rgba:${raw}`, "-alpha", "off", "-flip", output]);
}
/**
 * MIUI asks on the phone before every install over USB, on two screens
 * ("Replace app", then "Install"). Nobody is at the phone: the tool finds the
 * button in the window's hierarchy and taps it.
 */
async function install(apk: string) {
  const installing = Bun.spawn(["adb", "-s", (phone ||= serial()), "install", "-r", apk], { stdout: "pipe", stderr: "pipe" });
  let done = false;
  installing.exited.then(() => (done = true));
  for (let waited = 0; !done && waited < 240; waited++) {
    await Bun.sleep(1200);
    if (done || !/mCurrentFocus=.*PackageInstallerActivity/.test(shell("dumpsys window windows | grep mCurrentFocus"))) continue;
    shell("uiautomator dump /sdcard/atlas-ui.xml");
    const button = shell("cat /sdcard/atlas-ui.xml").match(/text="(?:OK|Install|确定|安装)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (button) shell(`input tap ${(+button[1] + +button[3]) >> 1} ${(+button[2] + +button[4]) >> 1}`);
  }
  const output = (await new Response(installing.stdout).text()) + (await new Response(installing.stderr).text());
  if (!/Success/.test(output)) throw new Error(`install: ${output.trim()}`);
}
async function launch() {
  shell(`am force-stop ${PACKAGE}`);
  shell(`mkdir -p ${PUSHED}; chmod 755 ${PUSHED}; rm -f ${PUSHED}/control.json`);
  shell(`run-as ${PACKAGE} rm -f files/status.json`);
  shell(`am start -n ${ACTIVITY}`);
  for (let attempt = 0; ; attempt++) {
    await Bun.sleep(500);
    try { return status(); } catch (error) { if (attempt === 60) throw error; }
  }
}

// ---- cook, build, package

function cook() {
  if (!places.length) throw new Error("no Android place matches");
  mkdirSync(assets, { recursive: true });
  for (const p of places) {
    run(["cargo", "run", "--release", "--locked", "-p", "pocket3d-place-cook", "--", "--profile", PROFILE, "--cell", "16", "--in", join(root, ".pocket-build/places", p.id), "--out", join(assets, `${p.id}.place`)]);
    console.log(`${p.id}: ${(statSync(join(assets, `${p.id}.place`)).size / 1048576).toFixed(1)} MiB`);
  }
}

function doctor() {
  const checks: [string, boolean, string][] = [
    ["NDK clang for API 18", existsSync(clang), clang],
    ["native_app_glue", existsSync(join(glue, "android_native_app_glue.c")), glue],
    ["aapt, zipalign, apksigner", ["aapt", "zipalign", "apksigner"].every((tool) => existsSync(join(buildTools, tool))), buildTools],
    ["android.jar", existsSync(platform), platform],
    ["Java", existsSync(join(javaHome, "bin/java")), javaHome],
    ["Rust target", existsSync(join(run(["rustup", "run", RUST, "rustc", "--print", "sysroot"]), "lib/rustlib", RUST_TARGET, "lib")), `${RUST_TARGET} on ${RUST}`],
    ["ImageMagick", !!Bun.which("magick"), "magick"],
  ];
  for (const [label, ok, detail] of checks) console.log(`[${ok ? "ok" : "missing"}] ${label}: ${detail}`);
  try {
    const model = shell("getprop ro.product.model"), release = shell("getprop ro.build.version.release"), board = shell("getprop ro.board.platform");
    console.log(`[${model === "HM 1S" ? "ok" : "other"}] phone: ${model}, Android ${release}, ${board} (the profile is measured on an HM 1S, Android 4.3, msm8226)`);
  } catch (error) {
    console.log(`[missing] phone: ${(error as Error).message}`);
  }
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function build(): Promise<{ libraries: string; ui: string; build: string }> {
  if (!existsSync(clang)) throw new Error(`no NDK at ${ndk}: install ndk;21.4.7075529 with sdkmanager`);
  const ui = await compileInterface("android");
  const objects = join(out, "native"), libraries = join(out, "apk/lib/armeabi-v7a");
  mkdirSync(objects, { recursive: true });
  mkdirSync(libraries, { recursive: true });
  ensureQuickJsCheckout("atlas-android", quickJs.root, pins.quickjs);

  // The interface's runtime, from PocketJS: the UI core as a static library
  // (its OpenGL ES 2 backend, which an ES 3 context runs unchanged), QuickJS,
  // and the driver that runs the guest. Its service wire is answered in the
  // process by n3ds/src/interface.c.
  const cargo = (directory: string, target: string, extra: string[] = []) =>
    run(["rustup", "run", RUST, "cargo", "build", "--release", "--locked", "--target", RUST_TARGET, ...extra], directory, { ...process.env, CARGO_TARGET_DIR: target, RUSTUP_TOOLCHAIN: undefined });
  cargo(join(pocket, "engine/ui-cabi"), join(out, "ui-core"), ["--no-default-features", "--features", "bare-platform"]);
  cargo(join(root, "android/title"), join(out, "title"));
  const core = join(out, "ui-core", RUST_TARGET, "release/libpocketjs_symbian_core.a");
  const title = join(out, "title", RUST_TARGET, "release/libatlas_title.a");

  const flags = ["-O3", "-fPIC", "-mcpu=cortex-a7", "-mfpu=neon-vfpv4", "-mfloat-abi=softfp", "-mthumb", "-ffunction-sections", "-fdata-sections", "-fvisibility=hidden", "-DANDROID", "-D_GNU_SOURCE"];
  const compile = (source: string, extra: string[] = [], inputs: string[] = []) => {
    const object = join(objects, source.replace(/[^A-Za-z0-9]/g, "_") + ".o");
    if (newer(object, [source, ...inputs])) run([clang, ...flags, ...extra, "-c", source, "-o", object]);
    return object;
  };
  const includes = ["-I", join(pocket, "engine/quickjs-c"), "-I", join(pocket, "engine/ui-cabi/include"), "-I", join(pocket, "contracts/generated"),
    "-I", join(pocket, "hosts/ios-legacy"), "-I", join(pocket, "hosts/shared"), "-I", glue, "-isystem", quickJs.source];
  const guest = [
    ...["quickjs.c", "cutils.c", "dtoa.c", "libregexp.c", "libunicode.c"].map((f) => compile(join(quickJs.source, f), ["-std=gnu11", "-I", quickJs.source, "-funsigned-char", "-fwrapv", "-fno-strict-aliasing", `-DCONFIG_VERSION="${pins.quickjs.version}"`, "-w"])),
    compile(quickJs.staticFunctions, ["-std=gnu11", "-I", quickJs.source, "-funsigned-char", "-w"]),
    compile(join(pocket, "engine/quickjs-c/rust_eh_personality.c")),
  ];
  const sources = ["android/src/main.c", "android/src/scene.c", "android/src/globe.c", "n3ds/src/interface.c"].map((f) => join(root, f));
  const headers = ["android/src/scene.h", "android/src/shaders.h", "android/src/globe.h", "n3ds/src/format.h", "n3ds/src/control.h", "n3ds/src/interface.h"].map((f) => join(root, f));
  const id = createHash("sha256").update([...sources, ...headers, join(ui.directory, "atlas.js"), join(ui.directory, "atlas.pak"), core, title].map(sha).join()).digest("hex").slice(0, 12);
  const settings = [`-DATLAS_PACKAGE="${PACKAGE}"`, `-DATLAS_SAMPLES=${profile.presentation.samples ?? 0}`, `-DATLAS_RATE=${profile.presentation.targetFps}`, ...(release ? [] : ["-DATLAS_DEV"])];
  const strict = ["-std=gnu11", "-Wall", "-Wextra", "-Werror", `-DATLAS_BUILD="${id}"`, ...settings, ...includes];
  // The runtime is rebuilt with the interface: the plan's target, host ABI and density are compiled in.
  rmSync(join(objects, join(pocket, "engine/quickjs-c/pocket_runtime.c").replace(/[^A-Za-z0-9]/g, "_") + ".o"), { force: true });
  for (const source of sources) rmSync(join(objects, source.replace(/[^A-Za-z0-9]/g, "_") + ".o"), { force: true });
  const mine = [
    ...sources.map((f) => compile(f, strict)),
    compile(join(pocket, "engine/quickjs-c/pocket_runtime.c"), ["-std=gnu11", ...includes, "-DPOCKET_SVC_WIRE", `-DPOCKETJS_TARGET_ID="${ui.inputs.target}"`,
      `-DPOCKETJS_HOST_ABI=${ui.inputs.hostAbi}`, `-DPOCKET_RASTER_DENSITY=${ui.inputs.viewport.rasterDensity}`]),
    // The glue's entry becomes this library's: android/src/loader.c is what NativeActivity loads.
    compile(join(glue, "android_native_app_glue.c"), ["-DANativeActivity_onCreate=atlas_activity", "-fvisibility=default", "-w"]),
  ];
  // Two Rust static libraries each bring their own copy of the language's
  // runtime symbols; the title card's is the smaller, so its duplicates give way.
  const link = (output: string, inputs: string[], libs: string[]) =>
    run([clang, "-shared", "-Wl,--no-undefined", "-Wl,--gc-sections", "-Wl,--build-id=none", `-Wl,-soname,${output.split("/").pop()}`, "-Wl,-z,max-page-size=4096", "-o", output, ...inputs, ...libs]);
  link(join(libraries, "libatlas.so"), [...mine, ...guest, "-Wl,--whole-archive", core, "-Wl,--no-whole-archive", "-Wl,--allow-multiple-definition", title],
    ["-landroid", "-llog", "-lEGL", "-lGLESv3", "-ldl", "-lm"]);
  rmSync(join(objects, join(root, "android/src/loader.c").replace(/[^A-Za-z0-9]/g, "_") + ".o"), { force: true });
  link(join(libraries, "libmain.so"), [compile(join(root, "android/src/loader.c"), ["-std=gnu11", "-Wall", "-Wextra", "-Werror", ...settings])], ["-landroid", "-llog", "-ldl"]);
  run([join(llvm, "llvm-strip"), "--strip-unneeded", join(libraries, "libatlas.so"), join(libraries, "libmain.so")]);

  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "globe.rgba"), globeSurface(1024));
  for (const file of ["atlas.js", "atlas.pak"]) cpSync(join(ui.directory, file), join(assets, file));
  console.log(JSON.stringify({ build: id, package: PACKAGE, release, libatlas: statSync(join(libraries, "libatlas.so")).size }));
  return { libraries, ui: ui.directory, build: id };
}

async function apk(): Promise<string> {
  await build();
  const staging = join(out, "apk"), packed = join(staging, "assets"), resources = join(staging, "res");
  rmSync(packed, { recursive: true, force: true });
  rmSync(resources, { recursive: true, force: true });
  mkdirSync(packed, { recursive: true });
  for (const file of ["atlas.js", "atlas.pak", "globe.rgba"]) cpSync(join(assets, file), join(packed, file));
  // --lean leaves the packs out: a development phone gets them pushed.
  if (!args.includes("--lean"))
    for (const p of places) {
      if (!existsSync(join(assets, `${p.id}.place`))) throw new Error(`${p.id}.place is not cooked: bun tools/atlas-android.ts cook`);
      cpSync(join(assets, `${p.id}.place`), join(packed, `${p.id}.place`));
    }
  // The launcher icon is the Pocket3D icon, from PocketJS: one file per density, unchanged.
  for (const [density, file] of Object.entries(POCKET3D_ICON_ANDROID)) {
    mkdirSync(join(resources, `drawable-${density}`), { recursive: true });
    cpSync(file, join(resources, `drawable-${density}/icon.png`));
  }
  const version = JSON.parse(readFileSync(join(root, "ui/pocket.json"), "utf8")).version as string;
  const [major, minor, patch] = version.split(".").map(Number);
  const manifest = join(staging, "AndroidManifest.xml");
  writeFileSync(manifest, readFileSync(join(root, "android/AndroidManifest.xml"), "utf8").replaceAll("@PACKAGE@", PACKAGE).replaceAll("@VERSION_CODE@", String(major * 10000 + minor * 100 + patch))
    .replaceAll("@VERSION_NAME@", version).replaceAll("@DEBUGGABLE@", String(!release)).replaceAll("@LABEL@", PACKAGE.endsWith(".atlas") ? "Pocket Atlas" : `Atlas ${PACKAGE.split(".").pop()}`));
  const unsigned = join(out, "unsigned.apk"), output = join(out, release ? "PocketAtlas.apk" : "PocketAtlas-dev.apk");
  // Packs are stored, not deflated: the app maps them from the APK. PNGs go in as they are.
  run([join(buildTools, "aapt"), "package", "-f", "--no-crunch", "-0", "place", "-0", "pak", "-0", "rgba", "-M", manifest, "-S", resources, "-A", packed, "-I", platform, "-F", unsigned]);
  run(["zip", "-q", "-r", unsigned, "lib"], staging);
  run([join(buildTools, "zipalign"), "-f", "4", unsigned, output]);
  const java = { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, "bin")}:${process.env.PATH}` };
  if (!existsSync(keystore)) {
    mkdirSync(signing, { recursive: true });
    run([join(javaHome, "bin/keytool"), "-genkeypair", "-noprompt", "-keystore", keystore, "-storepass", "android", "-alias", "androiddebugkey", "-keypass", "android",
      "-dname", "CN=PocketJS Android,O=PocketJS,C=HK", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000"], root, java);
  }
  run([join(buildTools, "apksigner"), "sign", "--ks", keystore, "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--min-sdk-version", "18", output], root, java);
  const badging = run([join(buildTools, "aapt"), "dump", "badging", output]);
  for (const marker of [`package: name='${PACKAGE}'`, "sdkVersion:'18'", "native-code: 'armeabi-v7a'", "uses-gl-es: '0x30000'"])
    if (!badging.includes(marker)) throw new Error(`the APK lacks ${marker}`);
  console.log(JSON.stringify({ apk: output, bytes: statSync(output).size, sha256: sha(output), places: args.includes("--lean") ? [] : places.map((p) => p.id) }));
  return output;
}

if (command === "doctor") doctor();
else if (command === "cook") cook();
else if (command === "build") await build();
else if (command === "apk") await apk();
else if (command === "install") {
  await install(await apk());
  console.log(JSON.stringify(await launch()));
} else if (command === "native") {
  // Replaces the library and the interface a development build runs, and
  // with --place that place's pack, without an install.
  if (release) throw new Error("a release build takes nothing pushed");
  const built = await build();
  shell(`am force-stop ${PACKAGE}`);
  push(join(built.libraries, "libatlas.so"), "libatlas.so");
  for (const file of ["atlas.js", "atlas.pak", "globe.rgba"]) push(join(assets, file), file);
  if (option("--place")) push(join(assets, `${option("--place")}.place`), `${option("--place")}.place`);
  if (args.includes("--packs")) for (const p of places) push(join(assets, `${p.id}.place`), `${p.id}.place`);
  shell(args.includes("--no-title") ? `touch ${PUSHED}/no-title` : `rm -f ${PUSHED}/no-title`);
  const s = await launch();
  if (s.build !== built.build) throw new Error(`the phone runs build ${s.build}, not ${built.build}`);
  console.log(JSON.stringify(s));
} else if (command === "unpush") shell(`rm -rf ${PUSHED}`);
else if (command === "launch") console.log(JSON.stringify(await launch()));
else if (command === "stop") shell(`am force-stop ${PACKAGE}`);
else if (command === "status") console.log(JSON.stringify(status()));
else if (command === "ctl") console.log(JSON.stringify(await control(JSON.parse(args[1] ?? "{}"))));
else if (command === "capture") await capture(resolve(option("--out", join(validation, "capture.png"))), args.includes("--screen"));
else if (command === "shots") {
  // Every authored shot at its midpoint with the loop frozen at 25 s: frame
  // intervals as shown over 240 frames with no traffic to the phone, then a
  // capture (outside the window).
  const directory = resolve(option("--out", join(validation, `shots-${Date.now()}`)));
  // --gpu also times the GPU with a timer query: a time below the refresh, at the cost of the frames' own pacing.
  const settings = { ...(option("--samples") ? { samples: Number(option("--samples")) } : {}), ...(option("--rate") ? { rate: Number(option("--rate")) } : {}), ...(option("--lines") ? { lines: Number(option("--lines")) } : {}), profile: args.includes("--gpu") };
  const frames = Number(option("--frames", "240"));
  const results: Record<string, unknown>[] = [];
  for (const p of places)
    for (let shot = 0, count = 1; shot < count; shot++) {
      let s = await control({ place: p.id, shot, time: Number(option("--time", "25")), cinematic: true, pause: false, reflection: true, rain: true, glow: true, ...settings });
      count = s.shots;
      await Bun.sleep(1500);
      s = await control({ mark: true });
      do {
        await Bun.sleep(Math.max(800, (frames + 5 - s.marked) * 1000 / Math.max(s.fps, 5)));
        s = status();
      } while (s.marked < frames);
      await capture(join(directory, `${p.id}-${shot}.png`));
      results.push({ place: p.id, shot, name: s.shotName, window: s.window, samples: s.samples, rate: s.rate, fps: s.fps, frames: s.marked, late: s.markedLate, worstMs: s.worstMs,
        workMs: s.workMs, swapMs: s.swapMs, intervalMs: s.intervalMs, prepareMs: s.prepareMs, ...(args.includes("--gpu") ? { gpuMs: s.gpuMs } : {}), draws: s.draws, triangles: s.triangles, mirrorTriangles: s.mirrorTriangles, sprites: s.sprites, build: s.build, glError: s.glError });
      console.log(`${p.id}/${shot} ${s.shotName}: ${s.fps.toFixed(1)} fps, ${s.markedLate} late in ${s.marked}, worst ${s.worstMs.toFixed(1)} ms, work ${s.workMs.mean.toFixed(1)} ms${args.includes("--gpu") ? `, GPU ${s.gpuMs.mean.toFixed(1)} ms` : ""}, ${s.triangles + s.mirrorTriangles} triangles in ${s.draws} draws`);
      writeFileSync(join(directory, "receipt.json"), JSON.stringify({ scenario: "authored shot midpoints, loop frozen", frames, settings, results }, null, 2));
    }
  await control({ time: -1, shot: 0, profile: false });
  console.log(directory);
} else throw new Error("usage: doctor | cook [--place ID] | build | apk [--release] [--lean] | install [--release] [--lean] | native [--place ID] [--packs] [--no-title] | unpush | launch | stop | status | ctl JSON | capture [--screen] [--out PNG] | shots [--place ID] [--samples N] [--rate N] [--lines N] [--gpu] [--frames N] [--out DIR]");
