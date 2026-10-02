/** Physical-device camera sweep. Capture I/O happens outside measured windows.
 * Run after a complete `atlas-ipod.ts deploy`, with the application launched. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLACES } from "../web/src/places/registry";
const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
}
const selected = option("--place", "");
const width = Number(option("--width", "960"));
const seconds = Number(option("--seconds", "5"));
if (![320, 480, 640, 960].includes(width) || seconds < 2 || seconds > 60)
  throw new Error("Invalid width or measurement duration");
const directory = resolve(
  option(
    "--out",
    join(root, `.pocket-build/validation/ipod/sweep-${Date.now()}`),
  ),
);
mkdirSync(directory, { recursive: true });
async function command(...args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "tools/atlas-ipod.ts", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(stderr + stdout);
  return stdout.trim();
}
function meta(id: string) {
  const bytes = readFileSync(
    join(root, ".pocket-build/ipod/assets", id + ".place"),
  );
  for (let i = 0; i < bytes.readUInt32LE(8); i++) {
    const at = 16 + i * 16;
    if (bytes.toString("ascii", at, at + 4) === "META")
      return JSON.parse(
        bytes.toString(
          "utf8",
          bytes.readUInt32LE(at + 4),
          bytes.readUInt32LE(at + 4) + bytes.readUInt32LE(at + 8),
        ),
      );
  }
  throw new Error(`${id}: META missing`);
}
const receipt = JSON.parse(
  readFileSync(
    join(root, ".pocket-build/ipod/Payload/PocketAtlas.app/build-receipt.json"),
    "utf8",
  ),
);
const results: unknown[] = [];
for (const place of PLACES.filter(
  (p) => p.status === "live" && p.load && (!selected || p.id === selected),
)) {
  const shots = meta(place.id).camera.shots;
  for (let shot = 0; shot < shots.length; shot++) {
    const state = JSON.parse(
      await command(
        "ctl",
        JSON.stringify({
          ...(shot === 0 ? { place: place.id } : {}),
          shot,
          time: 25,
          quality: 1,
          renderWidth: width,
          profile: args.includes("--profile"),
          rain: true,
          bloom: true,
          reflection: true,
        }),
      ),
    );
    if (
      state.place !== place.id ||
      state.shot !== shot ||
      state.glError ||
      state.state !== "running"
    )
      throw new Error(`Unexpected render state: ${JSON.stringify(state)}`);
    if (state.buildId !== receipt.buildId)
      throw new Error("Running build does not match packaged receipt");
    const expected = shots[shot].from.pos.map(
      (v: number, i: number) => (v + shots[shot].to.pos[i]) / 2,
    );
    if (
      expected.some(
        (v: number, i: number) => Math.abs(v - state.camera[i]) > 0.002,
      )
    )
      throw new Error(`${place.id}/${shot}: camera mismatch`);
    // Warm the actual driver program and reset the timing window after load.
    await Bun.sleep(1000);
    const before = JSON.parse(await command("status"));
    const start = performance.now();
    await Bun.sleep(seconds * 1000);
    const after = JSON.parse(await command("status"));
    const elapsed = (performance.now() - start) / 1000;
    if (
      after.frame <= before.frame ||
      after.glError ||
      after.lastCommand !== state.lastCommand
    )
      throw new Error(`${place.id}/${shot}: stopped, changed or invalid frame`);
    const capture = join(directory, `${place.id}-${shot}.png`);
    await command("capture", "--out", capture);
    const ui = JSON.parse(await command("status", "--ui"));
    const row = {
      place: place.id,
      shot,
      name: shots[shot].name,
      width,
      time: 25,
      sampleSeconds: elapsed,
      frames: after.frame - before.frame,
      observedFps: (after.frame - before.frame) / elapsed,
      status: after,
      ui,
      capture,
    };
    results.push(row);
    writeFileSync(
      join(directory, "receipt.json"),
      JSON.stringify(
        {
          buildId: receipt.buildId,
          timing: "wall-clock frame-count window; excludes capture",
          results,
        },
        null,
        2,
      ),
    );
    console.log(
      `${place.id}/${shot} ${shots[shot].name}: ${row.observedFps.toFixed(2)} fps, UI ${ui.uiFrameMs.toFixed(1)} ms, GL ${after.glError}`,
    );
  }
}
console.log(directory);
