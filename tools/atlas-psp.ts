// PSP uses PocketJS's pinned SDK resolver, Atlas owns the place renderer.
// bun tools/atlas-psp.ts cook|build|serve|run|status|ctl|capture|package
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { guardDeviceCommand } from "../vendor/pocketjs/tools/device-lease.ts";
import { DeviceEvidence, fileSha256 } from "../vendor/pocketjs/tools/device-evidence.ts";
import { assertFrameSample, compileIdentity } from "./device-validation";
import {
  readStatus,
  shotCount,
  writeControl,
  packHash,
  PSP_PACK_VERSION,
  type Identity,
  type Status,
} from "./psp-session.ts";
import { resolvePspBuildToolchain } from "../vendor/pocketjs/tools/psp-toolchain.ts";

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
const receiptPath = `${share}/pocket-atlas.build.json`;
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function identity(): Identity & { place: string } {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (typeof receipt.place !== "string" || !/^[a-z0-9-]+$/.test(receipt.place))
    throw new Error("Invalid PSP build receipt place");
  if (sha(`${share}/scene.place`) !== receipt.packSha256 || sha(`${share}/pocket-atlas.prx`) !== receipt.prxSha256)
    throw new Error("PSP share differs from its build receipt; build the intended place again");
  return receipt;
}
async function waitStatus(
  predicate: (s: Status) => boolean,
  timeoutMs = 30000,
  expected: Identity = identity(),
): Promise<Status> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    lease?.assertHeld();
    // The device truncates and writes status in one operation; retry partial reads.
    try {
      const s = readStatus(statusPath, expected);
      if (predicate(s)) return s;
    } catch (error) { lastError = error; }
    await Bun.sleep(250);
  }
  throw new Error(
    `PSP did not acknowledge the intended build and place: ${lastError ?? "no advancing frame"}`,
  );
}

async function build() {
  if (!existsSync(pack)) throw new Error("cook the PSP place first");
  const bytes = readFileSync(pack);
  shotCount(bytes);
  const tc = resolvePspBuildToolchain();
  const source = createHash("sha256");
  function hashTree(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) hashTree(file);
      else source.update(file.slice(root.length)).update(readFileSync(file));
    }
  }
  hashTree(`${root}/psp/src`);
  hashTree(`${root}/crates/pocket3d-place-psp/src`);
  for (const file of ["psp/Cargo.toml", "psp/Cargo.lock", "psp/Psp.toml", "crates/pocket3d-place-psp/Cargo.toml"])
    source.update(file).update(readFileSync(`${root}/${file}`));
  const pocketjsRevision = (await $`git -C ${root}/vendor/pocketjs rev-parse HEAD`.text()).trim();
  source.update(pocketjsRevision).update(JSON.stringify(tc.manifest));
  const build = source.digest("hex").slice(0, 16);
  const runtimeBuild = randomUUID().replaceAll("-", "");
  await $`${tc.rustup} run ${tc.manifest.rust.toolchain} cargo psp --release --locked`
    .cwd(`${root}/psp`)
    .env({
      ...tc.environment,
      RUST_PSP_ABORT_ONLY: "1",
      ATLAS_BUILD_ID: runtimeBuild,
      RUST_PSP_TARGET: `${root}/vendor/pocketjs/hosts/psp/targets/mipsel-sony-psp.json`,
      ATLAS_SOURCE_ID: build,
    });
  const out = `${root}/psp/target/mipsel-sony-psp/release`;
  lease?.assertHeld();
  cpSync(`${out}/pocket-atlas-psp.prx`, `${share}/pocket-atlas.prx`);
  cpSync(`${out}/EBOOT.PBP`, `${share}/EBOOT.PBP`);
  cpSync(pack, `${share}/scene.place`);
  const receipt = {
    build, runtimeBuild, place, pocketjsRevision, packVersion: PSP_PACK_VERSION, packHash: packHash(bytes),
    packBytes: bytes.length, packSha256: sha(pack), prxSha256: sha(`${share}/pocket-atlas.prx`),
    ebootSha256: sha(`${share}/EBOOT.PBP`),
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  mkdirSync(`${root}/.pocket-build/validation/psp`, { recursive: true });
  cpSync(receiptPath, `${root}/.pocket-build/validation/psp/build.json`);
  // Retain the standard evidence receipt path alongside the detailed package receipt.
  cpSync(receiptPath, `${share}/build.json`);
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
  const overrides = ["--tex", "--cell"].flatMap(flag => args.includes(flag) ? [flag, opt(flag, "")] : []);
  await $`cargo run --release --locked -p pocket3d-place-cook -- --target psp --in ${root}/.pocket-build/places/${place} --out ${pack} ${overrides}`.cwd(
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
  const expected = identity();
  await shell("reset");
  await Bun.sleep(1500);
  // PSPLINK can retain ms0 cwd from a standalone test. The relative pack
  // must be the staged one beside this PRX, not a previous Memory Stick scene.
  await shell("cd host0:/");
  rmSync(`${share}/status.json`, { force: true });
  writeControl(controlPath, { shot: 0 });
  await shell("ldstart host0:/pocket-atlas.prx");
  console.log(JSON.stringify(await waitStatus(() => true, 30000, expected), null, 2));
} else if (command === "status") {
  console.log(JSON.stringify(await waitStatus(() => true, 2000), null, 2));
} else if (command === "shots") {
  const directory = resolve(
    opt("--out", `${root}/.pocket-build/validation/psp/shots-${Date.now()}`),
  );
  mkdirSync(directory, { recursive: true });
  const rows: object[] = [];
  const time = Number(opt("--time", "10"));
  if (!Number.isFinite(time) || time < 0 || time > 86400) throw new Error("Invalid measurement time");
  const live = args.includes("--live");
  const expected = identity();
  await waitStatus(() => true, 2000, expected);
  const observedIdentity = (s: Status) => ({ device: "psp:usb", runtimeBuild: s.runtimeBuild, assets: { pack: s.packSha256 } });
  const evidence = new DeviceEvidence<object>({ device: "psp:usb", runtimeBuild: expected.runtimeBuild, assets: { pack: expected.packSha256 } });
  const measuredPack = resolve(root, `.pocket-build/places/${expected.place}/${expected.place}.psp.place`);
  if (args.includes("--place") && expected.place !== place) throw new Error("Another PSP place is running");
  const compilation = compileIdentity(measuredPack, "psp", opt("--compile", measuredPack.replace(/\.place$/, ".compile.json")));
  if (compilation.packSha256 !== expected.packSha256) throw new Error("PSP build uses a different pack from this compilation");
  const budgetMs = compilation.budgetMs;
  let completed = false;
  try {
    const count = shotCount(readFileSync(`${share}/scene.place`));
    for (let shot = 0; shot < count; shot++) {
      readStatus(statusPath, expected);
      const nonce = writeControl(controlPath, { shot, ...(live ? {} : { time }) });
      const acknowledged = await waitStatus(
        (s) => s.controlNonce === nonce && s.shotIndex === shot,
        30000, expected,
      );
      const samples: Status[] = [];
      let last = acknowledged.frame;
      while (samples.length < 5) {
        const sample = await waitStatus(
          (s) =>
            s.controlNonce === nonce &&
            s.frame > last &&
            s.shotIndex === shot &&
            (live || Math.abs(s.time - time) < 0.001),
          30000, expected,
        );
        assertFrameSample(sample, last, ["workMs", "maxWorkMs", "fps", "draws", "triangles"]);
        samples.push(sample);
        evidence.observe(observedIdentity(sample), { kind: "timing", shot, quality: "psp30", time: live ? null : time, sample, missedBudget: sample.maxWorkMs > budgetMs });
        last = sample.frame;
      }
      const row = {
        build: samples[0].build, packHash: samples[0].packHash, live, time: live ? null : time,
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
      evidence.observe(observedIdentity(await waitStatus(s => s.controlNonce === nonce && s.shotIndex === shot)),
        { kind: "capture", shot, file: `shot-${shot}.bmp`, sha256: fileSha256(`${directory}/shot-${shot}.bmp`), visualReview: "not-recorded" });
    }
    completed = true;
  } finally {
    await Bun.write(`${directory}/shots.json`, JSON.stringify(rows, null, 2));
    await Bun.write(`${directory}/device.json`, JSON.stringify({ ...evidence.receipt(), compilation, complete: completed, cameraCoverage: rows.length, budgetMs, timing: "CPU submission plus remaining GE wait; gpuWaitMs is not serialized GPU time" }, null, 2));
    // Never send a final command to a runtime that replaced this measurement.
    lease?.assertHeld();
    try {
      readStatus(statusPath, expected);
      writeControl(controlPath, { shot: 0 });
    } catch {}
  }
} else if (command === "ctl") {
  const c = JSON.parse(args[1] ?? "{}");
  const expected = identity();
  await waitStatus(() => true, 2000, expected);
  const nonce = writeControl(controlPath, c);
  console.log(
    JSON.stringify(await waitStatus((s) => s.controlNonce === nonce, 30000, expected), null, 2),
  );
} else if (command === "capture") {
  await waitStatus(() => true, 2000);
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
  if (!args.includes("--no-build")) await build();
  const expected = identity();
  if (expected.place !== place || sha(pack) !== expected.packSha256 || sha(`${share}/EBOOT.PBP`) !== JSON.parse(readFileSync(receiptPath, "utf8")).ebootSha256)
    throw new Error("PSP package files differ from the intended build");
  const out = `${root}/dist/PSP/GAME/PocketAtlas`;
  mkdirSync(out, { recursive: true });
  cpSync(`${share}/EBOOT.PBP`, `${out}/EBOOT.PBP`);
  cpSync(`${share}/scene.place`, `${out}/scene.place`);
  cpSync(receiptPath, `${out}/build.json`);
  console.log(`Copy dist/PSP to the Memory Stick: ${out}`);
} else throw new Error(`unknown PSP command ${command}`);
