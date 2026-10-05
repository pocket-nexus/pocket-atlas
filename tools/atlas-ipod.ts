/** Pocket Atlas on the iPod touch 4: cook, build, install and measure. PocketJS
 * supplies the pinned iOS 6 sysroot, the startup objects, the
 * MobileInstallation transaction, and the interface's runtime: its UI core
 * (with the OpenGL ES 2 backend), QuickJS and the guest driver. The app is
 * the C in ipod/src and the interface in ui/. */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { IPODTOUCH4_TOOLCHAIN, ipodtouch4CacheRoot, ipodtouch4CsuPath, ipodtouch4QuickJsPath, ipodtouch4SysrootPath, inspectIPodTouch4Toolchain } from "../vendor/pocketjs/tools/ipodtouch4-toolchain";
import { IPOD_INSTALLER, parseInstalledIPodApp, shellQuote, userDeploymentScript } from "../vendor/pocketjs/tools/ipodtouch4-installation";
import { PLACES } from "../web/src/places/registry";
import { globeSurface } from "./atlas-globe";
import { compileInterface } from "./atlas-ui";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const command = args[0] ?? "build";
const option = (key: string, fallback = "") => (args.includes(key) ? (args[args.indexOf(key) + 1] ?? fallback) : fallback);
const out = join(root, ".pocket-build/ipod");
const assets = join(out, "assets");
const bundle = join(out, "Payload/PocketAtlas.app");
// Another identity installs beside a build that is being compared against.
const bundleId = process.env.ATLAS_IPOD_BUNDLE_ID ?? "dev.pocket-nexus.atlas";
const bundleName = "PocketAtlas.app";
const places = PLACES.filter((p) => p.status === "live" && p.targets?.includes("ipod") && (!option("--place") || p.id === option("--place")));
if (!places.length) throw new Error("no iPod place matches");

function run(cmd: string[], cwd = root, stdin?: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdin: stdin === undefined ? undefined : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(`${cmd.slice(0, 2).join(" ")}: ${p.stdout.toString()}${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : join(dir, e.name)));

function cook() {
  mkdirSync(assets, { recursive: true });
  for (const p of places) {
    const source = join(root, ".pocket-build/places", p.id);
    run(["cargo", "run", "--release", "--locked", "-p", "pocket3d-place-cook", "--", "--profile", "ipod30", "--cell", "16", "--in", source, "--out", join(assets, `${p.id}.place`)]);
    console.log(`${p.id}: ${(readFileSync(join(assets, `${p.id}.place`)).byteLength / 1048576).toFixed(1)} MiB`);
  }
}

async function build() {
  const toolchain = inspectIPodTouch4Toolchain();
  if (!toolchain.sysroot || !toolchain.csu || !toolchain.quickjs) throw new Error("no iPod touch 4 toolchain: run `bun ipodtouch4 doctor` in vendor/pocketjs");
  const ui = await compileInterface("ipod");
  const objects = join(out, "native");
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(objects, { recursive: true });
  mkdirSync(bundle, { recursive: true });
  const clang = run(["xcrun", "--find", "clang"]), ld = run(["xcrun", "--find", "ld-classic"]), sdk = run(["xcrun", "--sdk", "macosx", "--show-sdk-path"]);
  const sources = ["ipod/src/main.c", "ipod/src/scene.c", "ipod/src/scene.h", "ipod/src/shaders.h", "ipod/src/globe.c", "ipod/src/globe.h",
    "n3ds/src/format.h", "n3ds/src/control.h", "n3ds/src/interface.c", "n3ds/src/interface.h"];
  const build = createHash("sha256").update([...sources.map((f) => join(root, f)), join(ui.directory, "atlas.js"), join(ui.directory, "atlas.pak")].map(sha).join()).digest("hex").slice(0, 12);
  const compile = (source: string, extra: string[] = []) => {
    const object = join(objects, source.replace(/[^A-Za-z0-9]/g, "_") + ".o");
    // cortex-a8: scalar float goes through NEON (its VFP unit is not pipelined).
    run([clang, "-target", "armv7-apple-ios6.0", "-miphoneos-version-min=6.0", "-mcpu=cortex-a8", "-O3", "-fno-stack-protector", "-fno-common",
      "-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=0", "-isysroot", sdk, "-Wno-incompatible-sysroot", ...extra, "-c", source, "-o", object]);
    return object;
  };
  const csu = ipodtouch4CsuPath();
  const boot = [
    compile(join(csu, "start.s"), ["-x", "assembler-with-cpp"]),
    compile(join(csu, "dyld_glue.s"), ["-x", "assembler-with-cpp", "-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header", "-DCRT"]),
    compile(join(root, "vendor/pocketjs/hosts/ios-legacy/crt_globals.c")),
  ];
  const link = (output: string, inputs: string[], frameworks: string[]) => {
    run([ld, "-arch", "armv7", "-syslibroot", ipodtouch4SysrootPath(), "-L/usr/lib", "-F/System/Library/Frameworks", "-iphoneos_version_min", "6.0",
      "-no_pie", "-no_uuid", "-no_function_starts", "-no_data_in_code_info", "-no_source_version", "-no_compact_unwind", "-no_adhoc_codesign", "-no_encryption",
      "-e", "start", "-o", output, ...boot, ...inputs, ...frameworks.flatMap((f) => ["-framework", f]), "-lobjc", "-lSystem", "-lgcc_s.1"]);
    run(["chmod", "755", output]);
  };
  // The interface's runtime, from PocketJS: the UI core as a static library
  // (ES 2 backend; PocketJS's own iPod host builds the ES 1.1 one), QuickJS,
  // and the driver that runs the guest. Its service wire is answered in the
  // process by n3ds/src/interface.c.
  const pocket = join(root, "vendor/pocketjs"), rust = IPODTOUCH4_TOOLCHAIN.compiler.rustToolchain, core = join(out, "ui-core");
  const rustup = (tool: string) => run(["rustup", "which", "--toolchain", rust, tool]);
  const built = Bun.spawnSync([rustup("cargo"), "build", "--release", "--locked", "--no-default-features", "--features", "bare-platform",
    "--target", join(pocket, "hosts/ipodtouch4/armv7-apple-ios.json"), "-Z", "json-target-spec", "-Z", "build-std=core,alloc,compiler_builtins",
    "-Z", "build-std-features=compiler-builtins-mem"], { cwd: join(pocket, "engine/ui-cabi"), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, RUSTC: rustup("rustc"), CARGO_TARGET_DIR: core, IPHONEOS_DEPLOYMENT_TARGET: "6.0" } });
  if (built.exitCode) throw new Error(`ui core: ${built.stderr}`);
  const quickjs = join(ipodtouch4QuickJsPath(), "libquickjs-sys/embed/quickjs");
  const includes = ["-I", join(pocket, "engine/quickjs-c"), "-I", join(pocket, "engine/ui-cabi/include"), "-I", join(pocket, "contracts/generated"),
    "-I", join(pocket, "hosts/ios-legacy"), "-I", join(pocket, "hosts/shared"), "-isystem", quickjs];
  const guest = [
    ...["quickjs.c", "cutils.c", "dtoa.c", "libregexp.c", "libunicode.c"].map((f) => compile(join(quickjs, f), ["-I", quickjs, "-funsigned-char", "-fwrapv", `-DCONFIG_VERSION="${IPODTOUCH4_TOOLCHAIN.compiler.quickJsVersion}"`])),
    compile(join(pocket, "engine/quickjs-c/pocket_runtime.c"), [...includes, "-DPOCKET_SVC_WIRE", `-DPOCKETJS_TARGET_ID="${ui.inputs.target}"`,
      `-DPOCKETJS_HOST_ABI=${ui.inputs.hostAbi}`, `-DPOCKET_RASTER_DENSITY=${ui.inputs.viewport.rasterDensity}`]),
    compile(join(pocket, "hosts/ios-legacy/compat.c")),
  ];
  const strict = ["-Wall", "-Wextra", "-Werror", `-DATLAS_BUILD="${build}"`, ...includes];
  const executable = join(bundle, "PocketAtlas");
  link(executable, [...["ipod/src/main.c", "ipod/src/scene.c", "ipod/src/globe.c", "n3ds/src/interface.c"].map((f) => compile(join(root, f), strict)), ...guest,
    "-force_load", join(core, "armv7-apple-ios/release/libpocketjs_symbian_core.a")], ["UIKit", "Foundation", "QuartzCore", "OpenGLES"]);
  run(["ldid", "-S", executable]);
  link(join(out, "installer"), [compile(join(root, "vendor/pocketjs/hosts/ipodtouch4/installer.c"))], ["Foundation"]);
  run(["ldid", `-S${root}/vendor/pocketjs/hosts/ipodtouch4/installer-entitlements.plist`, join(out, "installer")]);

  const plist = (entries: Record<string, string>) => Object.entries(entries).map(([k, v]) => `<key>${k}</key>${v}`).join("");
  const text = (v: string) => `<string>${v}</string>`;
  writeFileSync(join(bundle, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${plist({
    CFBundleIdentifier: text(bundleId), CFBundleExecutable: text("PocketAtlas"), CFBundleName: text("Pocket Atlas"),
    CFBundleDisplayName: text(bundleId.endsWith(".atlas") ? "Pocket Atlas" : "Atlas " + bundleId.split(".").pop()),
    CFBundleIconFiles: `<array>${text("Icon.png")}${text("Icon@2x.png")}</array>`, UIPrerenderedIcon: "<true/>", CFBundlePackageType: text("APPL"),
    CFBundleVersion: text("1"), CFBundleShortVersionString: text("0.1.0"), MinimumOSVersion: text("6.0"), UIDeviceFamily: "<array><integer>1</integer></array>",
    // Leaving the app ends it: UIKit would do so anyway (the link stubs carry no UIKit version).
    UIStatusBarHidden: "<true/>", UIApplicationExitsOnSuspend: "<true/>", UIRequiredDeviceCapabilities: `<array>${text("armv7")}${text("opengles-2")}</array>`,
    // `launch` opens the app through its own URL scheme.
    CFBundleURLTypes: `<array><dict><key>CFBundleURLSchemes</key><array>${text(bundleId)}</array></dict></array>`,
  })}</dict></plist>\n`);
  for (const [name, size] of [["Icon.png", "57x57"], ["Icon@2x.png", "114x114"]])
    run(["magick", join(root, "vita/assets/sce_sys/icon0.png"), "-resize", size, "-define", "png:exclude-chunk=date,time", join(bundle, name)]);
  for (const file of ["atlas.js", "atlas.pak"]) cpSync(join(ui.directory, file), join(bundle, file));
  writeFileSync(join(bundle, "globe.rgba"), globeSurface(512));
  for (const p of places) {
    if (!existsSync(join(assets, `${p.id}.place`))) throw new Error(`${p.id}.place is not cooked: bun tools/atlas-ipod.ts cook`);
    cpSync(join(assets, `${p.id}.place`), join(bundle, `${p.id}.place`));
  }
  rmSync(join(out, "PocketAtlas.ipa"), { force: true });
  if (command !== "build") run(["zip", "-q", "-r", join(out, "PocketAtlas.ipa"), "Payload"], out);
  console.log(JSON.stringify({ bundle, build, bundleId, executable: sha(executable) }));
}

type Device = { ssh: (script: string, stdin?: string) => string; pull: (from: string, to: string) => void; push: (from: string, to: string) => void; tmp: () => string; path: () => string };
/** The one connected, provisioned iPod4,1 (iOS 6.1.6) over a USB tunnel to its SSH server. */
async function device<T>(operation: (d: Device) => Promise<T> | T): Promise<T> {
  const ids = run(["idevice_id", "-l"]).split("\n").filter(Boolean);
  const udid = process.env.POCKETJS_IPODTOUCH4_UDID ?? (ids.length === 1 ? ids[0] : "");
  if (!/^[0-9a-f]{40}$/.test(udid)) throw new Error("connect one iPod touch 4 or set POCKETJS_IPODTOUCH4_UDID");
  for (const [key, value] of [["ProductType", "iPod4,1"], ["BuildVersion", "10B500"]])
    if (run(["ideviceinfo", "-u", udid, "-k", key]) !== value) throw new Error(`unexpected device ${key}`);
  const keys = [join(ipodtouch4CacheRoot(), "ssh", udid), join(ipodtouch4CacheRoot(), "ssh")].find((d) => existsSync(join(d, "id_rsa")))!;
  const port = await new Promise<number>((done, fail) => {
    const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const p = (server.address() as { port: number }).port;
      server.close(() => done(p));
    });
  });
  const tunnel = Bun.spawn(["iproxy", "-u", udid, `${port}:22`], { stdout: "ignore", stderr: "ignore" });
  const auth = ["-i", process.env.POCKETJS_IPODTOUCH4_KEY ?? join(keys, "id_rsa"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "HostKeyAlias=[127.0.0.1]:2224",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${process.env.POCKETJS_IPODTOUCH4_KNOWN_HOSTS ?? join(keys, "known_hosts")}`,
    "-o", "HostKeyAlgorithms=+ssh-rsa", "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa"];
  const ssh = (script: string, stdin?: string) => run(["ssh", "-p", String(port), ...auth, "root@127.0.0.1", script], root, stdin);
  const copy = (from: string, to: string) => void run(["scp", "-O", "-P", String(port), ...auth, from, to]);
  let app: ReturnType<typeof parseInstalledIPodApp> | undefined;
  const installed = () => (app ??= parseInstalledIPodApp(ssh(`${IPOD_INSTALLER} lookup ${shellQuote(bundleId)}`), bundleId, bundleName));
  try {
    for (let attempt = 0; ; attempt++) {
      await Bun.sleep(200);
      try { ssh("true"); break; } catch (error) { if (attempt === 20) throw error; }
    }
    return await operation({ ssh, pull: (from, to) => copy(`root@127.0.0.1:${from}`, to), push: (from, to) => copy(from, `root@127.0.0.1:${to}`),
      tmp: () => installed().Container + "/tmp", path: () => installed().Path });
  } finally {
    tunnel.kill();
    await tunnel.exited;
  }
}
const status = (d: Device) => JSON.parse(d.ssh(`cat ${shellQuote(d.tmp() + "/status.json")}`));
/** Sends a command and waits until a presented frame acknowledges it. */
async function control(d: Device, message: Record<string, unknown>) {
  const nonce = randomBytes(8).toString("hex"), file = shellQuote(d.tmp() + "/control.json");
  d.ssh(`cat > ${file}.new && mv ${file}.new ${file}`, JSON.stringify({ ...message, nonce }));
  for (let attempt = 0; attempt < 240; attempt++) {
    await Bun.sleep(500);
    const s = status(d);
    if (s.state === "error") throw new Error(s.error);
    if (s.lastCommand === nonce && (!(message.capture || message.screen) || s.capture === nonce)) return s;
  }
  throw new Error("the device did not acknowledge the command");
}
/** The frame before the interface (480x320), or with `screen` as presented, interface and all. */
async function capture(d: Device, output: string, screen = false) {
  await control(d, screen ? { screen: true } : { capture: true });
  const name = screen ? "screen.rgba" : "frame.rgba", raw = join(out, name);
  d.pull(`${d.tmp()}/${name}`, raw);
  mkdirSync(resolve(output, ".."), { recursive: true });
  // Both are the portrait drawable, bottom row first.
  run(["magick", "-size", "320x480", "-depth", "8", `rgba:${raw}`, "-alpha", "off", "-flip", "-rotate", "-90", output]);
}

if (command === "cook") cook();
else if (command === "build" || command === "package") await build();
else if (command === "deploy") {
  await build();
  await device((d) => {
    const remote = `/private/var/tmp/atlas-${randomBytes(8).toString("hex")}`, ipa = join(out, "PocketAtlas.ipa");
    d.ssh(`mkdir -p ${remote} /var/root/Library/PocketJS`);
    d.push(join(out, "installer"), `${remote}/installer`);
    d.push(ipa, `${remote}/app.ipa`);
    writeFileSync(join(out, "deploy.sh"), userDeploymentScript({ bundleId, bundleName, executable: "PocketAtlas", archive: `${remote}/app.ipa`, archiveHash: sha(ipa),
      files: Object.fromEntries(files(bundle).map((f) => [f.slice(bundle.length + 1), sha(f)])) }));
    d.push(join(out, "deploy.sh"), `${remote}/deploy.sh`);
    // Installs, then reads every installed file back against its hash.
    console.log(d.ssh(`chmod 700 ${remote}/installer; mv ${remote}/installer ${IPOD_INSTALLER}; ${IPOD_INSTALLER} lock ${shellQuote(bundleId)} ${remote}/deploy.sh; rm -rf ${remote}`));
  });
} else if (command === "native") {
  // Replaces the installed executable and interface, and with --place that place's pack.
  await build();
  await device((d) => {
    d.ssh("killall PocketAtlas 2>/dev/null; true");
    for (const file of ["atlas.js", "atlas.pak", ...(option("--place") ? [`${option("--place")}.place`] : [])]) d.push(join(bundle, file), `${d.path()}/${file}`);
    d.push(join(bundle, "PocketAtlas"), d.path() + "/PocketAtlas.new");
    const digest = d.ssh(`cd ${shellQuote(d.path())} && chmod 755 PocketAtlas.new && mv PocketAtlas.new PocketAtlas && openssl dgst -sha256 PocketAtlas`);
    if (!digest.endsWith(sha(join(bundle, "PocketAtlas")))) throw new Error("the installed executable differs");
  });
} else if (command === "launch")
  await device(async (d) => {
    d.ssh(`killall PocketAtlas 2>/dev/null; rm -f ${shellQuote(d.tmp() + "/status.json")}; su mobile -c ${shellQuote(`uiopen ${bundleId}://launch`)}`);
    for (let attempt = 0; ; attempt++) {
      await Bun.sleep(500);
      try { console.log(JSON.stringify(status(d))); break; } catch (error) { if (attempt === 40) throw error; }
    }
  });
else if (command === "status") await device((d) => console.log(JSON.stringify(status(d))));
else if (command === "ctl") await device(async (d) => console.log(JSON.stringify(await control(d, JSON.parse(args[1] ?? "{}")))));
else if (command === "capture") await device((d) => capture(d, resolve(option("--out", join(root, ".pocket-build/validation/ipod/capture.png"))), args.includes("--screen")));
else if (command === "shots") {
  // Every authored shot at its midpoint with the loop frozen at 25 s: frame
  // times over 120 presented frames, then a capture (outside the window).
  const directory = resolve(option("--out", join(root, `.pocket-build/validation/ipod/shots-${Date.now()}`)));
  const results: Record<string, unknown>[] = [];
  await device(async (d) => {
    for (const p of places)
      for (let shot = 0, count = 1; shot < count; shot++) {
        let s = await control(d, { place: p.id, shot, time: Number(option("--time", "25")), cinematic: true, pause: false, reflection: true, rain: true, glow: true });
        count = s.shots;
        await Bun.sleep(2000);
        const from = status(d).frame;
        do {
          // No traffic to the device while it fills the window.
          await Bun.sleep(Math.max(1000, (from + 125 - s.frame) * 1000 / Math.max(s.fps, 5)));
          s = status(d);
        } while (s.frame < from + 125);
        await capture(d, join(directory, `${p.id}-${shot}.png`));
        results.push({ place: p.id, shot, name: s.shotName, fps: s.fps, renderMs: s.renderMs, presentMs: s.presentMs, workMs: s.workMs, intervalMs: s.intervalMs,
          draws: s.draws, triangles: s.triangles, mirrorTriangles: s.mirrorTriangles, sprites: s.sprites, build: s.build, glError: s.glError });
        console.log(`${p.id}/${shot} ${s.shotName}: ${s.fps.toFixed(2)} fps, work ${s.workMs.mean.toFixed(1)} ms (p95 ${s.workMs.p95.toFixed(1)}), ${s.triangles + s.mirrorTriangles} triangles in ${s.draws} draws`);
        writeFileSync(join(directory, "receipt.json"), JSON.stringify({ scenario: "authored shot midpoints, loop frozen", frames: 120, results }, null, 2));
      }
    await control(d, { time: -1, shot: 0 });
  });
  console.log(directory);
} else throw new Error("usage: cook | build | package | deploy | native | launch | status | ctl JSON | capture [--screen] [--out PNG] | shots [--place ID] [--out DIR]");
