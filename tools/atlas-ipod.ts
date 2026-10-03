/** Native Atlas GLES2 application; PocketJS supplies the pinned sysroot and
 * MobileInstallation transaction, rather than duplicating either toolchain. */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ipodtouch4CacheRoot,
  ipodtouch4CsuPath,
  ipodtouch4SysrootPath,
  inspectIPodTouch4Toolchain,
  IPODTOUCH4_TOOLCHAIN,
} from "../vendor/pocketjs/tools/ipodtouch4-toolchain";
import {
  IPOD_INSTALLER,
  parseInstalledIPodApp,
  shellQuote,
  userDeploymentScript,
} from "../vendor/pocketjs/tools/ipodtouch4-installation";
import { PLACES } from "../web/src/places/registry";
import { isIPodAsset, selectIPodPlaces } from "./atlas-ipod-catalog";
import { validateDrawableCapture } from "./atlas-ipod-capture";
import { collectObservation, parseObservationOptions } from "./atlas-ipod-observe";
const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2),
  command = args[0] ?? "build";
const out = join(root, ".pocket-build/ipod"),
  bundle = join(out, "Payload/PocketAtlas.app"),
  native = join(out, "native");
const bundleId = "dev.pocket-nexus.atlas",
  bundleName = "PocketAtlas.app";
const opt = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
function run(cmd: string[], cwd = root, input?: Uint8Array): string {
  const p = Bun.spawnSync(cmd, {
    cwd,
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode)
    throw new Error(`${cmd[0]}: ${p.stdout.toString()}${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const sha = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : join(dir, e.name),
  );
}
async function build() {
  const tc = inspectIPodTouch4Toolchain();
  if (!tc.sysroot || !tc.csu)
    throw new Error("Run PocketJS ipodtouch4 doctor/setup first");
  mkdirSync(native, { recursive: true });
  if (command === "package" || command === "deploy")
    rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  const clang = run(["xcrun", "--find", "clang"]),
    ld = run(["xcrun", "--find", "ld-classic"]),
    sdk = run(["xcrun", "--sdk", "macosx", "--show-sdk-path"]);
  const csu = ipodtouch4CsuPath(),
    sysroot = ipodtouch4SysrootPath();
  const compile = (source: string, name: string, extra: string[] = []) => {
    const object = join(native, name + ".o");
    run([
      clang,
      "-target",
      "armv7-apple-ios6.0",
      "-miphoneos-version-min=6.0",
      "-march=armv7",
      "-O3",
      "-fno-stack-protector",
      "-fno-builtin",
      "-fno-common",
      "-fwrapv",
      "-funsigned-char",
      "-U_FORTIFY_SOURCE",
      "-D_FORTIFY_SOURCE=0",
      "-isysroot",
      sdk,
      "-Wno-incompatible-sysroot",
      ...extra,
      "-c",
      source,
      "-o",
      object,
    ]);
    return object;
  };
  const boot = [
    compile(join(csu, "start.s"), "start", ["-x", "assembler-with-cpp"]),
    compile(join(csu, "dyld_glue.s"), "dyld", [
      "-x",
      "assembler-with-cpp",
      "-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header",
      "-DCRT",
    ]),
    compile(
      join(root, "vendor/pocketjs/hosts/ios-legacy/crt_globals.c"),
      "globals",
    ),
  ];
  const rt = IPODTOUCH4_TOOLCHAIN.compiler.rustToolchain;
  const cargo = run(["rustup", "which", "--toolchain", rt, "cargo"]),
    rustc = run(["rustup", "which", "--toolchain", rt, "rustc"]);
  const p = Bun.spawn(
    [
      cargo,
      "build",
      "--release",
      "--manifest-path",
      join(root, "ipod/Cargo.toml"),
      "--target",
      join(root, "vendor/pocketjs/hosts/ipodtouch4/armv7-apple-ios.json"),
      "-Z",
      "json-target-spec",
      "-Z",
      "build-std=core,alloc,compiler_builtins",
      "-Z",
      "build-std-features=compiler-builtins-mem",
    ],
    {
      cwd: root,
      env: { ...process.env, RUSTC: rustc },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (await p.exited) throw new Error("Rust build failed");
  const common = [
    "-arch",
    "armv7",
    "-syslibroot",
    sysroot,
    "-L/usr/lib",
    "-F/System/Library/Frameworks",
    "-iphoneos_version_min",
    "6.0",
    "-no_pie",
    "-no_uuid",
    "-no_function_starts",
    "-no_data_in_code_info",
    "-no_source_version",
    "-no_compact_unwind",
    "-no_adhoc_codesign",
    "-no_encryption",
    "-e",
    "start",
  ];
  const executable = join(bundle, "PocketAtlas");
  run([
    ld,
    ...common,
    "-o",
    executable,
    ...boot,
    compile(join(root, "ipod/src/platform.c"), "platform"),
    compile(join(root, "ipod/src/audio.c"), "audio"),
    compile(join(root, "ipod/src/render_worker.c"), "render-worker"),
    "-force_load",
    join(root, "ipod/target/armv7-apple-ios/release/libpocket_atlas_ipod.a"),
    "-framework",
    "UIKit",
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "QuartzCore",
    "-framework",
    "OpenGLES",
    "-framework",
    "AVFoundation",
    "-lobjc",
    "-lSystem",
    "-lgcc_s.1",
  ]);
  run(["chmod", "755", executable]);
  run(["ldid", "-S", executable]);
  const installer = join(out, "installer");
  run([
    ld,
    ...common,
    "-o",
    installer,
    ...boot,
    compile(
      join(root, "vendor/pocketjs/hosts/ipodtouch4/installer.c"),
      "installer",
    ),
    "-framework",
    "Foundation",
    "-lobjc",
    "-lSystem",
    "-lgcc_s.1",
  ]);
  run(["chmod", "755", installer]);
  run([
    "ldid",
    `-S${root}/vendor/pocketjs/hosts/ipodtouch4/installer-entitlements.plist`,
    installer,
  ]);
  cpSync(join(root, "ipod/Info.plist"), join(bundle, "Info.plist"));
  for (const [name, size] of [
    ["Icon.png", "57x57"],
    ["Icon@2x.png", "114x114"],
  ]) {
    run([
      "magick",
      join(root, "vita/assets/sce_sys/icon0.png"),
      "-resize",
      size,
      join(bundle, name),
    ]);
  }
  const places = selectIPodPlaces(PLACES);
  writeFileSync(
    join(bundle, "catalog.json"),
    JSON.stringify(
      places.map(
        ({ load, ...p }) => p,
      ),
    ),
  );
  for (const place of places) {
    for (const suffix of [
      "place",
      "pipelines.json",
      "shadow.json",
      "audio.caf",
      "preview.png",
    ]) {
      if (!existsSync(join(out, "assets", `${place.id}.${suffix}`)))
        throw new Error(
          `Missing asset: ${place.id}.${suffix}; see ipod/README.md`,
        );
    }
  }
  const sourceAssets = join(out, "assets"), bundledAssets = join(bundle, "assets");
  // Rebuild the asset tree even for an incremental native build: an old
  // catalog entry must not survive in the next package after losing opt-in.
  rmSync(bundledAssets, { recursive: true, force: true });
  if (existsSync(sourceAssets)) {
    for (const source of files(sourceAssets)) {
      const name = source.slice(sourceAssets.length + 1);
      if (!isIPodAsset(name, places)) continue;
      const destination = join(bundledAssets, name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
    }
  }
  const hashes = Object.fromEntries(
    files(bundle)
      .filter((p) => !p.endsWith("build-receipt.json"))
      .map((p) => [p.slice(bundle.length + 1), sha(p)]),
  );
  const buildId = createHash("sha256")
    .update(JSON.stringify(hashes))
    .digest("hex")
    .slice(0, 24);
  writeFileSync(
    join(bundle, "build-receipt.json"),
    JSON.stringify({ buildId, bundleId, files: hashes }, null, 2),
  );
  if (command === "deploy" || command === "package") {
    rmSync(join(out, "PocketAtlas.ipa"), { force: true });
    run(["zip", "-q", "-r", join(out, "PocketAtlas.ipa"), "Payload"], out);
  }
  console.log(JSON.stringify({ bundle, buildId, executable: sha(executable) }));
}
async function device<T>(
  operation: (
    ssh: (s: string) => string,
    scp: (from: string, to: string, download?: boolean) => void,
    stream: (script: string) => Bun.Subprocess<"ignore", "pipe", "pipe">,
  ) => Promise<T> | T,
) {
  const ids = run(["idevice_id", "-l"]).split("\n");
  const udid =
    process.env.POCKETJS_IPODTOUCH4_UDID ?? (ids.length === 1 ? ids[0] : "");
  if (!/^[0-9a-f]{40}$/.test(udid))
    throw new Error("Set POCKETJS_IPODTOUCH4_UDID");
  for (const [key, value] of [
    ["ProductType", "iPod4,1"],
    ["ProductVersion", "6.1.6"],
    ["BuildVersion", "10B500"],
  ])
    if (run(["ideviceinfo", "-u", udid, "-k", key]) !== value)
      throw new Error(`Unexpected ${key}`);
  const keys = join(ipodtouch4CacheRoot(), "ssh", udid);
  const key =
    process.env.POCKETJS_IPODTOUCH4_KEY ??
    join(
      existsSync(keys) ? keys : join(ipodtouch4CacheRoot(), "ssh"),
      "id_rsa",
    );
  const hosts =
    process.env.POCKETJS_IPODTOUCH4_KNOWN_HOSTS ??
    join(
      existsSync(keys) ? keys : join(ipodtouch4CacheRoot(), "ssh"),
      "known_hosts",
    );
  const port = await new Promise<number>((yes, no) => {
    const server = createServer();
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as { port: number }).port;
      server.close(() => yes(p));
    });
  });
  const tunnel = Bun.spawn(["iproxy", "-u", udid, `${port}:22`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const auth = [
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "HostKeyAlias=[127.0.0.1]:2224",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${hosts}`,
    "-o",
    "HostKeyAlgorithms=+ssh-rsa",
    "-o",
    "PubkeyAcceptedAlgorithms=+ssh-rsa",
  ];
  const ssh = (s: string) =>
    run(["ssh", "-p", String(port), ...auth, "root@127.0.0.1", s]);
  const scp = (from: string, to: string, download = false) =>
    run([
      "scp",
      "-O",
      "-P",
      String(port),
      ...auth,
      download ? `root@127.0.0.1:${from}` : from,
      download ? to : `root@127.0.0.1:${to}`,
    ]);
  try {
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(200);
      try {
        ssh("true");
        ready = true;
        break;
      } catch (e) {
        if (i === 19) throw e;
      }
    }
    if (!ready) throw new Error("USB SSH unavailable");
    return await operation(ssh, scp, (script) => Bun.spawn(
      ["ssh", "-p", String(port), ...auth, "root@127.0.0.1", script],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ));
  } finally {
    tunnel.kill();
    await tunnel.exited;
  }
}
const installed = (ssh: (s: string) => string) =>
  parseInstalledIPodApp(
    ssh(`${IPOD_INSTALLER} lookup ${shellQuote(bundleId)}`),
    bundleId,
    bundleName,
  );
if (command === "build" || command === "package") await build();
else if (command === "native") {
  await build();
  await device((ssh, scp) => {
    const app = installed(ssh);
    ssh("/usr/bin/killall PocketAtlas 2>/dev/null || true");
    const path = app.Path + "/PocketAtlas";
    scp(join(bundle, "PocketAtlas"), path + ".new");
    const actual = ssh(
      `chmod 755 ${shellQuote(path + ".new")}; mv ${shellQuote(path + ".new")} ${shellQuote(path)}; /usr/bin/openssl dgst -sha256 ${shellQuote(path)}`,
    );
    const expected = sha(join(bundle, "PocketAtlas"));
    if (!actual.endsWith(expected)) throw new Error("Native readback mismatch");
    scp(join(bundle, "build-receipt.json"), app.Path + "/build-receipt.json");
    console.log("native executable readback", expected);
  });
} else if (command === "deploy") {
  await build();
  await device((ssh, scp) => {
    const remote = `/private/var/tmp/atlas-${randomBytes(8).toString("hex")}`;
    ssh(`mkdir -p ${remote} /var/root/Library/PocketJS`);
    scp(join(out, "installer"), `${remote}/installer`);
    scp(join(out, "PocketAtlas.ipa"), `${remote}/app.ipa`);
    const hashes = Object.fromEntries(
      files(bundle).map((p) => [p.slice(bundle.length + 1), sha(p)]),
    );
    const script = join(out, "deploy.sh");
    writeFileSync(
      script,
      userDeploymentScript({
        bundleId,
        bundleName,
        executable: "PocketAtlas",
        archive: `${remote}/app.ipa`,
        archiveHash: sha(join(out, "PocketAtlas.ipa")),
        files: hashes,
      }),
    );
    scp(script, `${remote}/deploy.sh`);
    ssh(
      `chmod 700 ${remote}/installer; mv ${remote}/installer ${IPOD_INSTALLER}; ${IPOD_INSTALLER} lock ${shellQuote(bundleId)} ${remote}/deploy.sh`,
    );
    console.log(installed(ssh));
    ssh(`rm -rf ${remote}`);
  });
} else if (command === "sync") {
  const places = selectIPodPlaces(PLACES, opt("--place", ""));
  if (!places.length) throw new Error("No matching iPod release places");
  await device((ssh, scp) => {
    const app = installed(ssh);
    ssh("/usr/bin/killall PocketAtlas 2>/dev/null || true");
    const folder = join(out, "assets");
    const inputs = files(folder).filter(
      (f) =>
        isIPodAsset(f.slice(folder.length + 1), places) &&
        (!args.includes("--packs") || f.endsWith(".place")) &&
        (!args.includes("--shaders") || !f.endsWith(".place")),
    );
    const names = inputs.map((f) => f.slice(folder.length + 1)),
      archive = join(out, "assets.tar.gz");
    run(["rm", "-f", archive]);
    run(["tar", "-czf", archive, "--no-xattrs", ...names], folder);
    const remote = app.Container + "/tmp/atlas-assets.tar.gz";
    scp(archive, remote);
    ssh(
      `mkdir -p ${shellQuote(app.Path + "/assets")}; /usr/bin/tar -xzf ${shellQuote(remote)} -C ${shellQuote(app.Path + "/assets")}`,
    );
    const hashes = Object.fromEntries(
      inputs.map((f) => [f.slice(folder.length + 1), sha(f)]),
    );
    const report = ssh(
      `/usr/bin/openssl dgst -sha256 ${Object.keys(hashes)
        .map((n) => shellQuote(app.Path + "/assets/" + n))
        .join(" ")}`,
    );
    for (const [n, hash] of Object.entries(hashes))
      if (!report.includes(`SHA256(${app.Path}/assets/${n})= ${hash}`))
        throw new Error(`Asset readback failed: ${n}`);
    writeFileSync(
      join(out, "sync-receipt.json"),
      JSON.stringify({ container: app.Container, files: hashes }, null, 2),
    );
    ssh(`rm -f ${shellQuote(remote)}`);
    console.log(`Synced and read back ${names.length} assets`);
  });
} else if (command === "launch")
  await device(async (ssh) => {
    const app = installed(ssh);
    ssh(
      `/usr/bin/killall PocketAtlas 2>/dev/null || true; rm -f ${shellQuote(app.Container + "/tmp/status.json")}; /bin/su mobile -c '/usr/bin/uiopen pocket-atlas://launch'`,
    );
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      if (
        ssh(
          `test -f ${shellQuote(app.Container + "/tmp/status.json")} && echo ready || true`,
        ) === "ready"
      )
        break;
      if (i === 59) throw new Error("No frame after launch within 30s");
    }
    console.log(ssh(`cat ${shellQuote(app.Container + "/tmp/gpu.json")}`));
    console.log(ssh(`cat ${shellQuote(app.Container + "/tmp/status.json")}`));
  });
else if (command === "status") {
  const quiet = Number(opt("--quiet", "0"));
  if (!Number.isFinite(quiet) || quiet < 0 || quiet > 30)
    throw new Error("Use status --quiet 0..30 seconds");
  await device(async (ssh) => {
    const app = installed(ssh);
    const file = args.includes("--ui") ? "ui-status.json" : "status.json";
    // Device identity queries and installer lookup can preempt the A4 render
    // worker. Settle after those operations, before reading its saved window.
    if (quiet) await Bun.sleep(quiet * 1000);
    console.log(ssh(`cat ${shellQuote(app.Container + "/tmp/" + file)}`));
  });
}
else if (command === "observe") {
  const options = parseObservationOptions(args);
  await device(async (ssh, _scp, stream) => {
    const app = installed(ssh);
    const summary = await collectObservation(stream, app.Container + "/tmp", options);
    if (!summary.normalPlaybackEvidence) process.exitCode = 1;
  });
}
else if (command === "ctl")
  await device(async (ssh, scp) => {
    const c = {
      ...JSON.parse(args[1] ?? "{}"),
      nonce: randomBytes(8).toString("hex"),
    };
    const file = join(out, "control.json");
    writeFileSync(file, JSON.stringify(c));
    const app = installed(ssh),
      dest = app.Container + "/tmp/control.json";
    scp(file, dest + ".new");
    ssh(`mv ${shellQuote(dest + ".new")} ${shellQuote(dest)}`);
    for (let attempt = 0; attempt < 120; attempt++) {
      await Bun.sleep(1000);
      const status = JSON.parse(
        ssh(`cat ${shellQuote(app.Container + "/tmp/status.json")}`),
      );
      if (status.lastCommand === c.nonce) {
        if (status.state === "error") throw new Error(status.error);
        if (status.glError) throw new Error(`GLES error: ${status.glError}`);
        console.log(JSON.stringify(status));
        return;
      }
    }
    throw new Error("Device command acknowledgement timed out");
  });
else if (command === "capture-ui")
  await device(async (ssh, scp) => {
    const app = installed(ssh);
    const remote = app.Container + "/tmp/";
    ssh(
      `rm -f ${["frame-ui.png", "frame-ui.json", "capture-ui-error.txt"].map((name) => shellQuote(remote + name)).join(" ")}; touch ${shellQuote(remote + "capture-ui")}`,
    );
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      const result = ssh(
        `if test -f ${shellQuote(remote + "capture-ui-error.txt")}; then cat ${shellQuote(remote + "capture-ui-error.txt")}; elif test -f ${shellQuote(remote + "frame-ui.json")}; then echo ready; fi`,
      );
      if (result === "ready") break;
      if (result) throw new Error(result);
      if (i === 59) throw new Error("No fresh UI capture within 30s");
    }
    const output = resolve(
      opt("--out", join(root, ".pocket-build/validation/ipod/interface.png")),
    );
    scp(remote + "frame-ui.png", output, true);
    scp(remote + "frame-ui.json", output + ".json", true);
    console.log(output);
  });
else if (command === "capture-hdr")
  await device(async (ssh, scp) => {
    const app = installed(ssh);
    const remote = app.Container + "/tmp/";
    ssh(
      `rm -f ${["frame-hdr.rgba", "frame-hdr.json", "capture-hdr-error.txt"].map((name) => shellQuote(remote + name)).join(" ")}; touch ${shellQuote(remote + "capture-hdr")}`,
    );
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      const result = ssh(
        `if test -f ${shellQuote(remote + "capture-hdr-error.txt")}; then cat ${shellQuote(remote + "capture-hdr-error.txt")}; elif test -f ${shellQuote(remote + "frame-hdr.json")}; then echo ready; fi`,
      );
      if (result === "ready") break;
      if (result) throw new Error(result);
      if (i === 59) throw new Error("No fresh HDR capture within 30s");
    }
    const prefix = resolve(
      opt("--out", join(root, ".pocket-build/validation/ipod/capture-hdr")),
    );
    mkdirSync(dirname(prefix), { recursive: true });
    scp(remote + "frame-hdr.rgba", prefix + ".rgba", true);
    scp(remote + "frame-hdr.json", prefix + ".json", true);
    const metadata = JSON.parse(readFileSync(prefix + ".json", "utf8"));
    const knownEncoding =
      (metadata.renderingProfile === "full-hdr" && metadata.encoding === "sqrt(c/(1+c))" && metadata.depth === "log") ||
      (metadata.renderingProfile === "display-prelit" && metadata.encoding === "display-srgb" && metadata.depth === "inverse-distance-when-used/zero-when-unused");
    if (!Number.isInteger(metadata.width) || metadata.width <= 0 || metadata.width > 4096 ||
        !Number.isInteger(metadata.height) || metadata.height <= 0 || metadata.height > 4096 ||
        metadata.format !== "rgba8" || !knownEncoding || metadata.origin !== "bottom-left" ||
        readFileSync(prefix + ".rgba").byteLength !== metadata.width * metadata.height * 4)
      throw new Error("Invalid HDR capture metadata or raw buffer length");
    console.log(JSON.stringify({ raw: prefix + ".rgba", metadata: prefix + ".json", ...metadata }));
  });
else if (command === "capture")
  await device(async (ssh, scp) => {
    const app = installed(ssh);
    const remote = app.Container + "/tmp/";
    ssh(
      `rm -f ${["frame.rgba", "frame.json", "capture-error.txt"].map((name) => shellQuote(remote + name)).join(" ")}; touch ${shellQuote(remote + "capture")}`,
    );
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      const result = ssh(
        `if test -f ${shellQuote(remote + "capture-error.txt")}; then cat ${shellQuote(remote + "capture-error.txt")}; elif test -f ${shellQuote(remote + "frame.json")}; then echo ready; fi`,
      );
      if (result === "ready") break;
      if (result) throw new Error(result);
      if (i === 59) throw new Error("No fresh frame within 30s");
    }
    const raw = join(out, "frame.rgba");
    scp(remote + "frame.rgba", raw, true);
    const output = resolve(
      opt("--out", join(root, ".pocket-build/validation/ipod/capture.png")),
    );
    mkdirSync(dirname(output), { recursive: true });
    scp(remote + "frame.json", output + ".json", true);
    const metadata = validateDrawableCapture(
      JSON.parse(readFileSync(output + ".json", "utf8")), readFileSync(raw).byteLength,
    );
    run([
      "magick",
      "-size",
      `${metadata.width}x${metadata.height}`,
      "-depth",
      "8",
      `rgba:${raw}`,
      "-flip",
      output,
    ]);
    console.log(output);
  });
else throw new Error(`Unknown iPod command ${command}`);
