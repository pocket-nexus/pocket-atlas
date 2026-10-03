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
  cpSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { crc32 } from "node:zlib";
import { PLACES } from "../web/src/places/registry";
import { syncAssets } from "./atlas-3ds-delivery";
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
  romfs = join(dir, "atlas-romfs");
const nativePlaces = join(dir, "places");
const livePlaces = PLACES.filter((p) => p.status === "live" && p.load && p.targets?.includes("3ds"));
const receipts = join(root, ".pocket-build/validation/3ds");
mkdirSync(receipts, { recursive: true });
const thin = args.includes("--thin");
const artifact = join(
  root,
  thin ? "dist/3ds/pocket-atlas-dev.3dsx" : "dist/3ds/pocket-atlas.3dsx",
);
const sha = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
function assets() {
  return livePlaces.map((p) => {
    const path = join(nativePlaces, `${p.id}.place`);
    const data = readFileSync(path);
    return {
      id: p.id,
      path,
      sha256: sha(path),
      bytes: data.length,
      crc32: crc32(data),
    };
  });
}
async function build() {
  const entries = assets();
  mkdirSync(romfs, { recursive: true });
  const atlasPath = join(dir, "romfs/atlas.3ds");
  if (!existsSync(atlasPath))
    throw new Error("cook the atlas: bun tools/atlas-3ds-assets.ts");
  cpSync(atlasPath, join(romfs, "atlas.3ds"));
  const atlasHash = sha(atlasPath);
  const pocketjsRevision = (
    await $`git -C ${join(root, "vendor/pocketjs")} rev-parse HEAD`.text()
  ).trim();
  const sourceHash = createHash("sha256")
    .update(atlasHash)
    .update(JSON.stringify(entries.map(({ path, ...entry }) => entry)))
    .update(pocketjsRevision)
    .update(THREE_DS_CONTAINER_IMAGE);
  sourceHash.update(readFileSync(join(root, "n3ds/Makefile")));
  for (const name of readdirSync(join(root, "n3ds/src")).sort())
    sourceHash.update(readFileSync(join(root, "n3ds/src", name)));
  const buildId = sourceHash.digest("hex").slice(0, 12);
  const config = join(dir, "build/config.h");
  mkdirSync(join(dir, "build"), { recursive: true });
  const catalog = entries
    .map(
      (e) =>
        `X(${JSON.stringify(e.id)}, "${e.sha256}", ${e.bytes}u, ${e.crc32}u)`,
    )
    .join(" ");
  const header = `#define POCKETJS_HOST_ABI ${THREE_DS_DEV_HOST_ABI}\n#define POCKETJS_TARGET_ID "${THREE_DS_DEV_TARGET_ID}"\n#define ATLAS_BUILD_ID "${buildId}"\n#define ATLAS_CATALOG(X) ${catalog}\n`;
  if (!existsSync(config) || readFileSync(config, "utf8") !== header)
    writeFileSync(config, header);
  // Assemble and compile on the container's own filesystem. Docker Desktop's
  // shared mount can expose stale sizes for files just rewritten by bin2s.
  writeFileSync(
    join(romfs, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        atlasSha256: atlasHash,
        places: entries.map(({ path, ...e }) => e),
      },
      null,
      2,
    ) + "\n",
  );
  const snapshot = join(dir, `source-${buildId}.tar`);
  await $`tar --no-xattrs -cf ${snapshot} n3ds .pocket-build/3ds/build/config.h`.cwd(
    root,
  );
  await runContainer(
    `mkdir -p /tmp/atlas-source /tmp/atlas-build
tar -xf /atlas/.pocket-build/3ds/source-${buildId}.tar -C /tmp/atlas-source
cp /tmp/atlas-source/.pocket-build/3ds/build/config.h /tmp/atlas-build/config.h
make -f /tmp/atlas-source/n3ds/Makefile -j8 BUILD=/tmp/atlas-build SOURCE=/tmp/atlas-source/n3ds/src ROMFS=/atlas/.pocket-build/3ds/atlas-romfs OUT=/atlas/dist/3ds/${thin ? "pocket-atlas-dev.3dsx" : "pocket-atlas.3dsx"}
cp /tmp/atlas-build/*.shbin /tmp/atlas-build/atlas.elf /tmp/atlas-build/atlas.map /atlas/.pocket-build/3ds/build/`,
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
    atlasSha256: atlasHash,
    places: entries.map(({ path, ...e }) => e),
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
  let devices = await discoverPocketRuntimes({ addresses: [host] });
  for (
    let attempt = 0;
    attempt < 2 && !devices.some((d) => d.address === host);
    attempt++
  ) {
    await Bun.sleep(250);
    devices = await discoverPocketRuntimes({ addresses: [host] });
  }
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
    heartbeatTimeoutMs: 30000,
  });
  client.on("ctrl", (m) => {
    if (m.t === "log" || m.t === "runtime.native") console.log(m);
  });
  for (const event of ["heartbeatTimeout", "protocolError", "socketError"])
    client.on(event, (error) => console.error(`${event}: ${String(error)}`));
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
async function enterPlace(c: PocketRuntimeClient, id: string) {
  await status(c, { place: id });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await Bun.sleep(400);
    const state = await status(c);
    if (state.place === id && state.phase === "running") return state;
    if (state.error) throw new Error(String(state.error));
  }
  throw new Error(`Place did not start: ${id}`);
}
function shotNames(id: string): string[] {
  const data = readFileSync(join(nativePlaces, `${id}.place`));
  for (let i = 0; i < data.readUInt32LE(8); i++) {
    const at = 16 + i * 16;
    if (data.toString("ascii", at, at + 4) === "META") {
      const offset = data.readUInt32LE(at + 4),
        bytes = data.readUInt32LE(at + 8);
      return JSON.parse(
        data.toString("utf8", offset, offset + bytes),
      ).camera.shots.map((shot: { name: string }) => shot.name);
    }
  }
  throw new Error(`Missing camera metadata: ${id}`);
}
if (command === "cook") {
  mkdirSync(nativePlaces, { recursive: true });
  if (args.includes("--place") && !livePlaces.some((p) => p.id === place))
    throw new Error(`${place} is not in the 3DS release catalog; compile its PlaceIR explicitly to check capabilities`);
  for (const p of livePlaces.filter(
    (p) => !args.includes("--place") || p.id === place,
  )) {
    await $`cargo run --release --locked -p pocket3d-place-cook -- --target 3ds --in ${join(root, `.pocket-build/places/${p.id}`)} --out ${join(nativePlaces, `${p.id}.place`)} --tex ${option("--tex", "256")}`.cwd(
      root,
    );
  }
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
        let running = await status(c);
        if (
          running.build === receipt.buildId &&
          ["running", "browser"].includes(String(running.phase))
        ) {
          const assetReceipts = thin
            ? []
            : await syncAssets(c, assets(), {
                host: option("--asset-host", "") || undefined,
                onProgress: (r, i, count) =>
                  console.log(
                    `Assets ${i}/${count}: ${r.sha256.slice(0, 12)} ${r.cached ? "cache verified" : "transferred and verified"}`,
                  ),
              });
          const before = await status(c);
          await Bun.sleep(600);
          running = await status(c);
          if (
            running.build !== receipt.buildId ||
            !["running", "browser"].includes(String(running.phase)) ||
            running.error ||
            Number(running.frame) <= Number(before.frame)
          )
            throw new Error(
              `Installed runtime did not advance after asset sync: ${JSON.stringify(running)}`,
            );
          writeFileSync(
            join(receipts, "installed.json"),
            JSON.stringify(
              {
                ...receipt,
                running,
                assetReceipts,
                transferExitCode: transfer.exitCode,
              },
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
} else if (command === "package") {
  await build();
  const stage = join(dir, "release");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "3ds"), { recursive: true });
  mkdirSync(join(stage, "pocket-atlas"));
  cpSync(artifact, join(stage, "3ds/pocket-atlas.3dsx"));
  for (const e of assets())
    cpSync(e.path, join(stage, `pocket-atlas/${e.sha256}.place`));
  cpSync(
    join(romfs, "manifest.json"),
    join(stage, "pocket-atlas/manifest.json"),
  );
  const archive = join(root, "dist/3ds/pocket-atlas-sd.zip");
  rmSync(archive, { force: true });
  await $`zip -q -r ${archive} 3ds pocket-atlas`.cwd(stage);
  console.log(archive);
} else {
  let c = await connect();
  try {
    if (
      ["profile", "sweep", "tour"].includes(command) &&
      args.includes("--place")
    )
      await enterPlace(c, place);
    if (command === "sync") {
      const assetReceipts = await syncAssets(c, assets(), {
        host: option("--asset-host", "") || undefined,
        onProgress: (r, i, count) =>
          console.log(
            `Assets ${i}/${count}: ${r.sha256.slice(0, 12)} ${r.cached ? "cache verified" : "transferred and verified"}`,
          ),
      });
      const running = await status(c);
      if (
        !["browser", "running"].includes(String(running.phase)) ||
        running.error
      )
        throw new Error(
          `Asset sync completed but the view failed: ${JSON.stringify(running)}`,
        );
      writeFileSync(
        join(receipts, "sync.json"),
        JSON.stringify({ assetReceipts, running }, null, 2) + "\n",
      );
    } else if (command === "status" || command === "ctl") {
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
      const current = await status(c);
      if (!current.place)
        throw new Error("Enter a place first, or pass --place ID");
      const names = option(
        "--shots",
        shotNames(String(current.place)).join(","),
      ).split(",");
      const available = shotNames(String(current.place));
      for (const name of names)
        if (!available.includes(name)) throw new Error(`Unknown shot: ${name}`);
      const sampleCount = Number(option("--samples", "20"));
      if (!Number.isInteger(sampleCount) || sampleCount < 2)
        throw new Error("--samples must be an integer of at least 2");
      const rows = [];
      for (const shot of names)
        for (const step of command === "sweep"
          ? [0, 1, 2, 3, 4]
          : [Number(option("--step", "0"))]) {
          await status(c, {
            shot,
            step,
            lodFloor: Number(option("--lod", "3")),
            hold: true,
            inputLock: true,
            ...(args.includes("--live")
              ? { play: true, cameraHold: true }
              : { time: Number(option("--time", "10")) }),
          });
          await Bun.sleep(1200);
          let previous = await status(c, { measure: true });
          const samples = [];
          for (let i = 0; i < sampleCount; i++) {
            await Bun.sleep(120);
            const sample = await status(c);
            if (
              sample.phase !== "running" ||
              sample.place !== current.place ||
              sample.build !== current.build ||
              sample.shot !== shot ||
              sample.error ||
              Number(sample.frame) <= Number(previous.frame) ||
              Number(sample.measuredFrames) <= 0
            )
              throw new Error(
                `Profile runtime stopped or changed: ${JSON.stringify(sample)}`,
              );
            samples.push(sample);
            previous = sample;
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
      let previous = await status(c, {
        shot: 0,
        hold: false,
        play: true,
        cameraHold: false,
        inputLock: true,
        measure: true,
      });
      const samples = [];
      const reconnects = [];
      const out = option("--out", join(receipts, "tour.json"));
      const saveTour = (complete: boolean) =>
        writeFileSync(
          out,
          JSON.stringify(
            { complete, reconnects, samples, measured: samples.at(-1) },
            null,
            2,
          ) + "\n",
        );
      const end = Date.now() + Number(option("--seconds", "60")) * 1000;
      while (Date.now() < end) {
        await Bun.sleep(500);
        let sample;
        try {
          sample = await status(c);
        } catch (error) {
          // The device counts every frame even if Wi-Fi drops. Reconnect only
          // to the same uninterrupted run; never restart its measurement.
          c.close();
          if (reconnects.length >= 3) throw error;
          c = await connect();
          sample = await status(c, { inputLock: true });
          reconnects.push({
            afterFrame: previous.frame,
            resumedFrame: sample.frame,
            error: String(error),
          });
        }
        if (
          sample.phase !== "running" ||
          sample.place !== previous.place ||
          sample.build !== previous.build ||
          sample.error ||
          Number(sample.frame) <= Number(previous.frame) ||
          Number(sample.measuredFrames) <= Number(previous.measuredFrames)
        )
          throw new Error(
            `Tour runtime stopped or changed: ${JSON.stringify(sample)}`,
          );
        samples.push(sample);
        previous = sample;
        if (samples.length % 20 === 0) saveTour(false);
      }
      saveTour(true);
      console.log(samples.at(-1));
    } else
      throw new Error(
        "usage: cook [--place ID] | build | install [--thin] | sync | package | status | ctl JSON | capture | profile | sweep | tour",
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
