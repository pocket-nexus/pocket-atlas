/** Atlas' native PICA200 pipeline. PocketJS owns the authenticated wire and
 * .3dsx install/launch; this tool adds renderer controls and measurements. */
import { $ } from "bun";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import {
  runContainer,
  THREE_DS_CONTAINER_IMAGE,
} from "../vendor/pocketjs/tools/3ds-toolchain.ts";
import {
  PocketRuntimeClient,
  parsePocketRuntimeToken,
  discoverPocketRuntimes,
} from "../vendor/pocketjs/tools/3ds-runtime-client.ts";
import {
  THREE_DS_DEV_HOST_ABI,
  THREE_DS_DEV_TARGET_ID,
} from "../vendor/pocketjs/tools/3ds-profile.ts";
import { pocketRuntimeDeviceId } from "../vendor/pocketjs/contracts/spec/pocket-runtime-wire.ts";
const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2),
  command = args[0] ?? "build";
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1]! : fallback;
};
const place = option("--place", "tokyo-konbini"),
  dir = join(root, ".pocket-build/3ds"),
  romfs = join(dir, "romfs");
const receipts = join(root, ".pocket-build/validation/3ds");
mkdirSync(receipts, { recursive: true });
const thin = args.includes("--thin");
const artifact = join(
  root,
  thin ? "dist/3ds/pocket-atlas-dev.3dsx" : "dist/3ds/pocket-atlas.3dsx",
);
const sha = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
async function build() {
  if (!existsSync(join(romfs, "scene.place")))
    throw new Error("cook first: bun tools/atlas-3ds.ts cook");
  const placeHash = sha(join(romfs, "scene.place")),
    placeBytes = readFileSync(join(romfs, "scene.place")).length;
  const pocketjsRevision = (
    await $`git -C ${join(root, "vendor/pocketjs")} rev-parse HEAD`.text()
  ).trim();
  const sourceHash = createHash("sha256")
    .update(placeHash)
    .update(pocketjsRevision)
    .update(THREE_DS_CONTAINER_IMAGE);
  sourceHash.update(readFileSync(join(root, "n3ds/Makefile")));
  for (const name of readdirSync(join(root, "n3ds/src")).sort())
    sourceHash.update(readFileSync(join(root, "n3ds/src", name)));
  const buildId = sourceHash.digest("hex").slice(0, 12);
  const config = join(dir, "build/config.h");
  mkdirSync(join(dir, "build"), { recursive: true });
  const header = `#define POCKETJS_HOST_ABI ${THREE_DS_DEV_HOST_ABI}\n#define POCKETJS_TARGET_ID "${THREE_DS_DEV_TARGET_ID}"\n#define ATLAS_BUILD_ID "${buildId}"\n#define ATLAS_PLACE_SHA "${placeHash}"\n#define ATLAS_PLACE_BYTES ${placeBytes}\n`;
  if (!existsSync(config) || readFileSync(config, "utf8") !== header)
    writeFileSync(config, header);
  // Assemble and compile on the container's own filesystem. Docker Desktop's
  // shared mount can expose stale sizes for files just rewritten by bin2s.
  const packedRomfs = thin ? join(dir, "thin-romfs") : romfs;
  mkdirSync(packedRomfs, { recursive: true });
  writeFileSync(
    join(packedRomfs, "manifest.json"),
    JSON.stringify({
      place,
      sha256: placeHash,
      bytes: placeBytes,
      embedded: !thin,
    }),
  );
  const snapshot = join(dir, `source-${buildId}.tar`);
  await $`tar --no-xattrs -cf ${snapshot} n3ds .pocket-build/3ds/build/config.h`.cwd(
    root,
  );
  await runContainer(
    `mkdir -p /tmp/atlas-source /tmp/atlas-build
tar -xf /atlas/.pocket-build/3ds/source-${buildId}.tar -C /tmp/atlas-source
cp /tmp/atlas-source/.pocket-build/3ds/build/config.h /tmp/atlas-build/config.h
make -f /tmp/atlas-source/n3ds/Makefile -j8 BUILD=/tmp/atlas-build SOURCE=/tmp/atlas-source/n3ds/src ROMFS=/atlas/.pocket-build/3ds/${thin ? "thin-romfs" : "romfs"} OUT=/atlas/dist/3ds/${thin ? "pocket-atlas-dev.3dsx" : "pocket-atlas.3dsx"}
cp /tmp/atlas-build/scene.shbin /tmp/atlas-build/wet.shbin /tmp/atlas-build/atlas.elf /tmp/atlas-build/atlas.map /atlas/.pocket-build/3ds/build/`,
    [{ hostPath: root, containerPath: "/atlas" }],
    "/atlas",
    {},
    "Atlas native build",
  );
  const receipt = {
    target: "3ds",
    pocketjsRevision,
    buildId,
    thin,
    container: THREE_DS_CONTAINER_IMAGE,
    bytes: readFileSync(artifact).length,
    sha256: sha(artifact),
    placeSha256: sha(join(romfs, "scene.place")),
  };
  if (receipt.bytes > 32 * 1024 * 1024)
    throw new Error("native install limit: artifact exceeds 32 MiB");
  writeFileSync(
    join(receipts, thin ? "build-thin.json" : "build.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(receipt);
  return receipt;
}
async function connect() {
  const host = option("--host", process.env.POCKET_3DS_HOST ?? "192.168.8.159");
  const keys = option(
    "--keys",
    join(root, "vendor/pocketjs/.pocket/3ds/devices"),
  );
  const devices = await discoverPocketRuntimes({ addresses: [host] });
  const device = devices.find((d) => d.address === host);
  if (!device) throw new Error(`no Pocket Runtime at ${host}:8131`);
  let token: Uint8Array | undefined;
  for (const name of readdirSync(keys).filter((n) => n.endsWith(".key"))) {
    const t = parsePocketRuntimeToken(readFileSync(join(keys, name), "utf8"));
    if (pocketRuntimeDeviceId(t) === device.deviceId) {
      token = t;
      break;
    }
  }
  if (!token)
    throw new Error(
      `no pairing key matches ${device.deviceId.toString(16)}; use --keys PATH to existing PocketJS pairing directory`,
    );
  const client = new PocketRuntimeClient({
    host,
    port: device.port,
    token,
    timeoutMs: 20000,
  });
  client.on("ctrl", (m) => {
    if (m.t === "log" || m.t === "runtime.native") console.log(m);
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
async function status(
  c: PocketRuntimeClient,
  ctl: Record<string, unknown> = {},
) {
  const p = c.waitForCtrl((m) => m.t === "atlas.status");
  await c.sendCtrl({ t: "atlas.control", ...ctl });
  return await p;
}
if (command === "cook") {
  mkdirSync(romfs, { recursive: true });
  await $`cargo run --release --locked -p pocket3d-place-cook -- --pica-from ${join(root, `.pocket-build/places/${place}/${place}.place`)} --out ${join(romfs, "scene.place")} --tex ${option("--tex", "256")}`.cwd(
    root,
  );
} else if (command === "build") await build();
else if (command === "install") {
  const receipt = await build();
  const transfer =
    await $`bun ${join(root, "vendor/pocketjs/tools/3ds-dev.ts")} install --host ${option("--host", process.env.POCKET_3DS_HOST ?? "192.168.8.159")} --file ${artifact} --name pocket-atlas.3dsx`.nothrow();
  let verified = false,
    lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const c = await connect();
      try {
        const running = await status(c);
        if (running.build === receipt.buildId && running.phase === "running") {
          writeFileSync(
            join(receipts, "installed.json"),
            JSON.stringify(
              { ...receipt, running, transferExitCode: transfer.exitCode },
              null,
              2,
            ) + "\n",
          );
          console.log(`Verified ${receipt.buildId} running on the 3DS`);
          verified = true;
          break;
        }
        lastError = new Error(`device is ${running.build}: ${running.phase}`);
      } finally {
        c.close();
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(1000);
  }
  if (!verified)
    throw new Error(
      `Native install did not reach the expected running build: ${lastError}`,
    );
} else {
  const c = await connect();
  try {
    if (command === "status" || command === "ctl") {
      const ctl = command === "ctl" ? JSON.parse(args[1] ?? "{}") : {};
      const s = await status(c, ctl);
      console.log(JSON.stringify(s, null, 2));
      writeFileSync(
        join(receipts, "last-status.json"),
        JSON.stringify(s, null, 2) + "\n",
      );
    } else if (command === "capture") {
      const pending = c.waitForScreenshot();
      await c.sendCtrl({
        t: "screenshot",
        surface: option("--surface", "top"),
      });
      const shot = await pending;
      const path = option("--out", join(receipts, `capture-${Date.now()}.png`));
      await Bun.write(path, shot.png);
      console.log(path);
    } else if (command === "profile" || command === "sweep") {
      const names = option(
        "--shots",
        "Konbini,Puddles,Vending,Crossing,Inside,Wires",
      ).split(",");
      const rows = [];
      for (const shot of names)
        for (const step of command === "sweep"
          ? [0, 1, 2, 3, 4]
          : [Number(option("--step", "0"))]) {
          await status(c, {
            shot,
            step,
            hold: true,
            inputLock: true,
            ...(args.includes("--live")
              ? { play: true, cameraHold: true }
              : { time: Number(option("--time", "10")) }),
          });
          await Bun.sleep(1200);
          await status(c, { measure: true });
          const samples = [];
          for (let i = 0; i < Number(option("--samples", "20")); i++) {
            await Bun.sleep(120);
            samples.push(await status(c));
          }
          const mean = (key: string) =>
            samples.reduce((n, s) => n + Number(s[key]), 0) / samples.length;
          const max = (key: string) =>
            Math.max(...samples.map((s) => Number(s[key])));
          const row = {
            shot,
            step,
            build: samples[0]?.build,
            live: args.includes("--live"),
            measured: {
              frames: samples.at(-1)?.measuredFrames,
              mean: samples.at(-1)?.frameMean,
              p95: samples.at(-1)?.frameP95,
              max: samples.at(-1)?.frameMax,
              workMax: samples.at(-1)?.workMax,
            },
            frameMean: mean("frameMs"),
            frameMax: max("frameMs"),
            gpuMean: mean("gpuMs"),
            gpuMax: max("gpuMs"),
            cpuMean: mean("cpuMs"),
            cpuMax: max("cpuMs"),
            draws: mean("draws"),
            triangles: mean("triangles"),
            samples,
          };
          rows.push(row);
          console.log({ ...row, samples: undefined });
          writeFileSync(
            option("--out", join(receipts, `${command}.json`)),
            JSON.stringify(rows, null, 2) + "\n",
          );
        }
    } else if (command === "tour") {
      await status(c, {
        shot: 0,
        hold: false,
        play: true,
        cameraHold: false,
        inputLock: true,
        measure: true,
      });
      const samples = [];
      const end = Date.now() + Number(option("--seconds", "60")) * 1000;
      while (Date.now() < end) {
        await Bun.sleep(500);
        samples.push(await status(c));
      }
      const result = { samples, measured: samples.at(-1) };
      writeFileSync(
        option("--out", join(receipts, "tour.json")),
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(result.measured);
    } else
      throw new Error(
        "usage: cook | build | install | status | ctl JSON | capture | profile | sweep",
      );
  } finally {
    if (["profile", "sweep", "tour"].includes(command)) {
      try {
        await status(c, {
          inputLock: false,
          hold: false,
          play: true,
          cameraHold: false,
        });
      } catch {}
    }
    c.close();
  }
}
