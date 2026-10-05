// PSP uses PocketJS's pinned SDK resolver, Atlas owns the place renderer.
// bun tools/atlas-psp.ts cook|build|serve|run|status|ctl|capture|package
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { guardDeviceCommand } from "../vendor/pocketjs/tools/device-lease.ts";
import { DeviceEvidence, fileSha256 } from "../vendor/pocketjs/tools/device-evidence.ts";
import { assertFrameSample, compileIdentity } from "./device-validation";
import {
  readStatus,
  shotCount,
  writeControl,
  type Status,
} from "./psp-session.ts";
import { resolvePspBuildToolchain } from "../vendor/pocketjs/tools/psp-toolchain.ts";
import { POCKET3D_ICON } from "../vendor/pocketjs/tools/pocket3d-icon.ts";
import { hostBuildEnvironment } from "../vendor/pocketjs/framework/src/manifest/index.ts";
import { PLACES } from "../web/src/places/registry";
import { globeSurfacePsp } from "./atlas-globe";
import { compileInterface } from "./atlas-ui";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const command = args[0] ?? "build";
const lease = command === "cook" ? undefined : await guardDeviceCommand(command === "serve" ? "psp:usb:transport" : "psp:usb");
const opt = (key: string, fallback: string) => {
  const at = args.indexOf(key);
  return at < 0 ? fallback : (args[at + 1] ?? fallback);
};
const place = opt("--place", "tokyo-konbini");
if (!/^[a-z0-9-]+$/.test(place)) throw new Error("invalid place id");
// An existing usbhostfs_pc may already own the cable in another worktree.
// Reuse its exact root with --share; never start a second owner.
const share = resolve(opt("--share", `${root}/.pocket-build/psp/host0`));
const pack = resolve(root, `.pocket-build/places/${place}/${place}.psp.place`);
const port = opt("--port", "10000");
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65533)
  throw new Error("Invalid PSPLINK port");
mkdirSync(share, { recursive: true });
const statusPath = `${share}/status.json`;
const controlPath = `${share}/control.txt`;
async function waitStatus(
  predicate: (s: Status) => boolean,
  timeoutMs = 30000,
): Promise<Status> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    lease?.assertHeld();
    // The device truncates and writes status in one operation; retry partial reads.
    try {
      const s = readStatus(statusPath);
      if (predicate(s)) return s;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(
    "PSP did not acknowledge a fresh rendered frame; check PSPLINK",
  );
}

/** A PARAM.SFO: keys in order, 32-bit integers and NUL-terminated strings padded to four bytes. */
function paramSfo(values: Record<string, number | string>): Buffer {
  const keys = Object.keys(values).sort();
  const data = keys.map((key) => {
    const value = values[key];
    if (typeof value === "number") {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(value);
      return { format: 0x0404, used: 4, bytes };
    }
    const text = Buffer.from(value + "\0");
    return { format: 0x0204, used: text.length, bytes: Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4)]) };
  });
  const names = Buffer.from(keys.map((key) => key + "\0").join(""));
  const keyTable = 20 + keys.length * 16, dataTable = keyTable + Math.ceil(names.length / 4) * 4;
  const out = Buffer.alloc(dataTable + data.reduce((sum, d) => sum + d.bytes.length, 0));
  out.write("\0PSF");
  out.writeUInt32LE(0x101, 4);
  out.writeUInt32LE(keyTable, 8);
  out.writeUInt32LE(dataTable, 12);
  out.writeUInt32LE(keys.length, 16);
  let nameAt = 0, dataAt = 0;
  keys.forEach((key, i) => {
    const at = 20 + i * 16, d = data[i];
    out.writeUInt16LE(nameAt, at);
    out.writeUInt16LE(d.format, at + 2);
    out.writeUInt32LE(d.used, at + 4);
    out.writeUInt32LE(d.bytes.length, at + 8);
    out.writeUInt32LE(dataAt, at + 12);
    d.bytes.copy(out, dataTable + dataAt);
    nameAt += key.length + 1;
    dataAt += d.bytes.length;
  });
  names.copy(out, keyTable);
  return out;
}

/** Every PSP place that has been cooked: its id and pack. */
const cooked = () => PLACES.filter((p) => p.targets?.includes("psp")).map((p) => [p.id, resolve(root, `.pocket-build/places/${p.id}/${p.id}.psp.place`)] as const).filter(([, path]) => existsSync(path));

async function build() {
  if (!existsSync(pack)) throw new Error("cook the PSP place first");
  const ui = await compileInterface("psp");
  const tc = resolvePspBuildToolchain();
  const runtimeBuild = randomUUID().replaceAll("-", "");
  // The interface's runtime (PocketJS's PSP host library) builds QuickJS
  // from C for the same target: PocketJS's own flags for it.
  await $`${tc.rustup} run ${tc.manifest.rust.toolchain} cargo psp --release --locked`
    .cwd(`${root}/psp`)
    .env({
      ...tc.environment,
      RUSTFLAGS: "-A linker-messages -A unexpected-cfgs -A unstable-name-collisions",
      CRATE_CC_NO_DEFAULTS: "1",
      TARGET_CC: "clang",
      TARGET_AR: `${tc.llvmBin}/llvm-ar`,
      TARGET_CFLAGS:
        `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
        `-fno-stack-protector -O2 -I${tc.sdk.path}/psp/include -I${tc.sdk.path}/psp/sdk/include`,
      AR_mipsel_sony_psp: `${tc.llvmBin}/llvm-ar`,
      RANLIB_mipsel_sony_psp: `${tc.llvmBin}/llvm-ranlib`,
      ...hostBuildEnvironment(ui.inputs, { outputDirectory: ui.directory, embedApp: false }),
      POCKETJS_OFFLOAD_SLOT: "",
      RUST_PSP_ABORT_ONLY: "1",
      ATLAS_BUILD_ID: runtimeBuild,
      RUST_PSP_TARGET: `${root}/vendor/pocketjs/hosts/psp/targets/mipsel-sony-psp.json`,
    });
  const out = `${root}/psp/target/mipsel-sony-psp/release`;
  // The package asks for the large memory of a PSP-2000 or later (cargo-psp
  // has no setting for it): there every place fits beside the interface. A
  // PSP-1000 lists the places whose pack does not fit as not on the device.
  await Bun.write(`${out}/PARAM.SFO`, paramSfo({ BOOTABLE: 1, CATEGORY: "MG", DISC_VERSION: "1.00", MEMSIZE: 1, PARENTAL_LEVEL: 1, PSP_SYSTEM_VER: "1.00", REGION: 0x8000, TITLE: "Pocket Atlas" }));
  // ICON0.PNG is the Pocket3D icon, from PocketJS; PIC1.PNG is a capture of the game.
  await $`pack-pbp ${out}/EBOOT.PBP ${out}/PARAM.SFO ${POCKET3D_ICON.psp} NULL NULL ${root}/psp/assets/pic1.png NULL ${out}/pocket-atlas-psp.prx NULL`.quiet();
  lease?.assertHeld();
  cpSync(`${out}/pocket-atlas-psp.prx`, `${share}/pocket-atlas.prx`);
  cpSync(`${out}/EBOOT.PBP`, `${share}/EBOOT.PBP`);
  // Beside the executable: the interface, the globe's surface, the places.
  for (const file of ["atlas.js", "atlas.pak"]) cpSync(`${ui.directory}/${file}`, `${share}/${file}`);
  await Bun.write(`${share}/globe.psp`, globeSurfacePsp(512));
  for (const [id, path] of cooked()) cpSync(path, `${share}/${id}.place`);
  // Every staged place and its pack: one build is measured in each of them.
  const packs = Object.fromEntries(cooked().map(([id, path]) => [id, fileSha256(path)]));
  await Bun.write(`${share}/build.json`, JSON.stringify({ runtimeBuild, packSha256: fileSha256(pack), prxSha256: fileSha256(`${share}/pocket-atlas.prx`), places: Object.keys(packs), packs }, null, 2));
  console.log(`PSP release: ${share}`);
}
async function shell(text: string) {
  lease?.assertHeld();
  const p = Bun.spawn(["pspsh", "-p", port, "-e", text], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => p.kill(), 15000);
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timeout);
  console.log(out + err);
  if (code !== 0 || /Error:|Error loading|Could not|failed/i.test(out + err))
    throw new Error(`pspsh failed: ${text}`);
}
if (command === "cook") {
  await $`cargo run --release --locked -p pocket3d-place-cook -- --target psp --in ${root}/.pocket-build/places/${place} --out ${pack}`.cwd(
    root,
  );
} else if (command === "build") await build();
else if (command === "serve") {
  const running = await $`pgrep -x usbhostfs_pc`.nothrow().quiet();
  if (running.exitCode === 0)
    throw new Error(
      "usbhostfs_pc already owns a PSP session; reuse it or stop it explicitly first",
    );
  await $`usbhostfs_pc -b ${port} ${share}`;
} else if (command === "run") {
  if (!args.includes("--no-build")) await build();
  await shell("reset");
  await Bun.sleep(1500);
  rmSync(`${share}/status.json`, { force: true });
  writeControl(controlPath, { shot: 0, place });
  await shell("ldstart host0:/pocket-atlas.prx");
  console.log(JSON.stringify(await waitStatus(() => true), null, 2));
} else if (command === "status") {
  console.log(JSON.stringify(await waitStatus(() => true, 2000), null, 2));
} else if (command === "shots") {
  const directory = resolve(
    opt("--out", `${root}/.pocket-build/validation/psp/shots-${Date.now()}`),
  );
  mkdirSync(directory, { recursive: true });
  const rows: object[] = [];
  const expected = JSON.parse(readFileSync(`${share}/build.json`, "utf8"));
  expected.packSha256 = expected.packs?.[place] ?? expected.packSha256;
  if (fileSha256(`${share}/${place}.place`) !== expected.packSha256 || fileSha256(`${share}/pocket-atlas.prx`) !== expected.prxSha256)
    throw new Error("PSP staged files changed since build");
  const identity = (s: Status) => ({ device: "psp:usb", runtimeBuild: s.runtimeBuild, assets: { pack: s.packSha256 } });
  const evidence = new DeviceEvidence<object>({ device: "psp:usb", runtimeBuild: expected.runtimeBuild, assets: { pack: expected.packSha256 } });
  const compilation = compileIdentity(pack, "psp", opt("--compile", pack.replace(/\.place$/, ".compile.json")));
  if (compilation.packSha256 !== expected.packSha256) throw new Error("PSP build uses a different pack from this compilation");
  const budgetMs = compilation.budgetMs;
  let completed = false;
  try {
    const count = shotCount(readFileSync(`${share}/${place}.place`));
    for (let shot = 0; shot < count; shot++) {
      const nonce = writeControl(controlPath, { shot, time: 10, place });
      const acknowledged = await waitStatus(
        (s) => s.controlNonce === nonce && s.shotIndex === shot,
      );
      const samples: Status[] = [];
      let last = acknowledged.frame;
      while (samples.length < 5) {
        const sample = await waitStatus(
          (s) =>
            s.controlNonce === nonce &&
            s.frame > last &&
            s.shotIndex === shot &&
            s.time === 10,
        );
        assertFrameSample(sample, last, ["workMs", "maxWorkMs", "fps", "draws", "triangles"]);
        samples.push(sample);
        evidence.observe(identity(sample), { kind: "timing", shot, quality: "psp30", time: 10, sample, missedBudget: sample.maxWorkMs > budgetMs });
        last = sample.frame;
      }
      const row = {
        shot: samples[0].shot,
        fps: samples.reduce((n, s) => n + s.fps, 0) / samples.length,
        workMs: samples.reduce((n, s) => n + s.workMs, 0) / samples.length,
        maxWorkMs: Math.max(...samples.map((s) => s.maxWorkMs)),
        draws: samples[0].draws,
        triangles: samples[0].triangles,
        samples,
      };
      rows.push(row);
      console.log(JSON.stringify({ ...row, samples: undefined }));
      const file = `shot-${shot}.bmp`;
      await shell(`scrshot host0:/${file}`);
      cpSync(`${share}/${file}`, `${directory}/shot-${shot}.bmp`);
      evidence.observe(identity(await waitStatus(s => s.controlNonce === nonce && s.shotIndex === shot)),
        { kind: "capture", shot, file: `shot-${shot}.bmp`, sha256: fileSha256(`${directory}/shot-${shot}.bmp`), visualReview: "not-recorded" });
    }
    completed = true;
  } finally {
    await Bun.write(`${directory}/shots.json`, JSON.stringify(rows, null, 2));
    await Bun.write(`${directory}/device.json`, JSON.stringify({ ...evidence.receipt(), compilation, complete: completed, cameraCoverage: rows.length, budgetMs, timing: "CPU submission plus remaining GE wait; gpuWaitMs is not serialized GPU time" }, null, 2));
    lease?.assertHeld();
    const ending = readStatus(statusPath);
    if (ending.runtimeBuild === expected.runtimeBuild && ending.packSha256 === expected.packSha256) writeControl(controlPath, { shot: 0, place });
  }
} else if (command === "ctl") {
  const c = JSON.parse(args[1] ?? "{}");
  const nonce = writeControl(controlPath, c);
  console.log(
    JSON.stringify(await waitStatus((s) => s.controlNonce === nonce), null, 2),
  );
} else if (command === "capture") {
  const out = resolve(
    opt("--out", `${root}/.pocket-build/validation/psp/${Date.now()}.bmp`),
  );
  mkdirSync(resolve(out, ".."), { recursive: true });
  const file = `capture-${Date.now()}.bmp`;
  await shell(`scrshot host0:/${file}`);
  if (!existsSync(`${share}/${file}`))
    throw new Error("PSPLINK did not write the screenshot");
  cpSync(`${share}/${file}`, out);
} else if (command === "package") {
  await build();
  const out = `${root}/dist/PSP/GAME/PocketAtlas`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The executable, the interface, the globe and every cooked place.
  for (const file of ["EBOOT.PBP", "atlas.js", "atlas.pak", "globe.psp", ...cooked().map(([id]) => `${id}.place`)]) cpSync(`${share}/${file}`, `${out}/${file}`);
  console.log(`Copy dist/PSP to the Memory Stick: ${out}`);
} else throw new Error(`unknown PSP command ${command}`);
