// PSP uses PocketJS's pinned SDK resolver, Atlas owns the place renderer.
// bun tools/atlas-psp.ts cook|build|serve|run|status|ctl|capture|package
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  readStatus,
  shotCount,
  writeControl,
  type Status,
} from "./psp-session.ts";
import { resolvePspBuildToolchain } from "../vendor/pocketjs/tools/psp-toolchain.ts";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const command = args[0] ?? "build";
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

async function build() {
  if (!existsSync(pack)) throw new Error("cook the PSP place first");
  const tc = resolvePspBuildToolchain();
  await $`${tc.rustup} run ${tc.manifest.rust.toolchain} cargo psp --release --locked`
    .cwd(`${root}/psp`)
    .env({
      ...tc.environment,
      RUST_PSP_ABORT_ONLY: "1",
      RUST_PSP_TARGET: `${root}/vendor/pocketjs/hosts/psp/targets/mipsel-sony-psp.json`,
    });
  const out = `${root}/psp/target/mipsel-sony-psp/release`;
  cpSync(`${out}/pocket-atlas-psp.prx`, `${share}/pocket-atlas.prx`);
  cpSync(`${out}/EBOOT.PBP`, `${share}/EBOOT.PBP`);
  cpSync(pack, `${share}/scene.place`);
  console.log(`PSP release: ${share}`);
}
async function shell(text: string) {
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
  writeControl(controlPath, { shot: 0 });
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
  try {
    const count = shotCount(readFileSync(`${share}/scene.place`));
    for (let shot = 0; shot < count; shot++) {
      const nonce = writeControl(controlPath, { shot, time: 10 });
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
        samples.push(sample);
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
      await shell(`scrshot ${file}`);
      cpSync(`${share}/${file}`, `${directory}/shot-${shot}.bmp`);
    }
  } finally {
    await Bun.write(`${directory}/shots.json`, JSON.stringify(rows, null, 2));
    writeControl(controlPath, { shot: 0 });
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
  await shell(`scrshot ${file}`);
  if (!existsSync(`${share}/${file}`))
    throw new Error("PSPLINK did not write the screenshot");
  cpSync(`${share}/${file}`, out);
} else if (command === "package") {
  await build();
  const out = `${root}/dist/PSP/GAME/PocketAtlas`;
  mkdirSync(out, { recursive: true });
  cpSync(`${share}/EBOOT.PBP`, `${out}/EBOOT.PBP`);
  cpSync(`${share}/scene.place`, `${out}/scene.place`);
  console.log(`Copy dist/PSP to the Memory Stick: ${out}`);
} else throw new Error(`unknown PSP command ${command}`);
