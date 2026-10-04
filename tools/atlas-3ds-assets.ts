/** The 3DS globe (n3ds/src/globe.c): the web export's surface, city lights
 * and clouds as PICA tiles behind one small header. The place list, its
 * cards and all text are the interface's (ui/, tools/atlas-ui.ts).
 * bun tools/atlas-3ds-assets.ts [--out .pocket-build/3ds/romfs/globe.3ds]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const HEADER = 92;

/** A texel's place in PICA memory: 8×8 tiles, Morton order within a tile. */
function morton(x: number, y: number, width: number) {
  return (
    (((y >> 3) * (width >> 3) + (x >> 3)) * 64) |
    (x & 1) |
    ((y & 1) << 1) |
    ((x & 2) << 1) |
    ((y & 2) << 2) |
    ((x & 4) << 2) |
    ((y & 4) << 3)
  );
}
function texture(
  w: number,
  h: number,
  alpha: boolean,
  sample: (x: number, y: number) => number[],
): Buffer {
  const data = Buffer.alloc(w * h * 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = sample(x, y).map((v) =>
        Math.max(0, Math.min(255, Math.round(v))),
      );
      const v = alpha
        ? ((c[0] >> 4) << 12) |
          ((c[1] >> 4) << 8) |
          ((c[2] >> 4) << 4) |
          (c[3] >> 4)
        : ((c[0] >> 3) << 11) | ((c[1] >> 2) << 5) | (c[2] >> 3);
      // Convert top-first source rows to PICA memory order exactly once.
      // The runtime keeps the source UV coordinates (no second 1-v flip).
      data.writeUInt16LE(v, morton(x, h - 1 - y, w) * 2);
    }
  return data;
}

/** Writes `globe.3ds` from the globe `web/scripts/export-atlas.ts` exported. */
export function cookGlobe(
  out = `${root}/.pocket-build/3ds/romfs/globe.3ds`,
  globeDir = `${root}/.pocket-build/atlas/globe`,
): string {
  const globe = JSON.parse(readFileSync(`${globeDir}/globe.json`, "utf8"));
  const header = Buffer.alloc(HEADER);
  const chunks: Buffer[] = [header];
  let cursor = HEADER;
  header.write("AG3D");
  header.writeUInt32LE(1, 4);
  for (const [index, name] of ["albedo", "lights", "clouds"].entries()) {
    const desc = globe.files.find((f: any) => f.name === name);
    if (!desc || desc.format !== "u8") throw new Error(`Missing raw ${name}`);
    const raw = readFileSync(`${globeDir}/${desc.file}`);
    if (raw.length !== desc.width * desc.height * desc.channels)
      throw new Error(`Invalid ${name} length`);
    // The globe owns GPU memory only while the place renderer is unloaded.
    // Keep coastlines and city lights sharp at maximum zoom; cloud cover needs
    // less spatial detail and retains the smaller texture.
    const width = name === "clouds" ? 512 : 1024;
    const height = width / 2;
    const data = texture(width, height, name === "clouds", (x, y) => {
      const c = [0, 0, 0, 0],
        taps = 4;
      for (let yy = 0; yy < taps; yy++)
        for (let xx = 0; xx < taps; xx++) {
          const u = Math.floor(((x + (xx + 0.5) / taps) * desc.width) / width),
            v = Math.floor(((y + (yy + 0.5) / taps) * desc.height) / height);
          const k = (v * desc.width + u) * desc.channels;
          if (name === "lights") {
            const lum = Math.min(
              1,
              ((raw[k] / 255) ** 2 + (raw[k + 1] / 255) ** 2) *
                globe.lightsMax *
                globe.lightsGain,
            );
            c[0] += 255 * Math.sqrt(lum);
            c[1] += 183 * Math.sqrt(lum);
            c[2] += 100 * Math.sqrt(lum);
          } else for (let j = 0; j < desc.channels; j++) c[j] += raw[k + j];
        }
      const a = c.map((v) => v / (taps * taps));
      return name === "clouds"
        ? [232, 241, 255, Math.max(0, (a[0] - 55) * 1.5)]
        : a;
    });
    [width, height, name === "clouds" ? 1 : 0, cursor, data.length].forEach(
      (n, i) => header.writeUInt32LE(n, 8 + index * 20 + i * 4),
    );
    chunks.push(data);
    cursor += data.length;
  }
  [globe.startLat, globe.startLon, globe.cloudDriftPerS, ...globe.sun].forEach(
    (n, i) => header.writeFloatLE(n, 68 + i * 4),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat(chunks));
  return out;
}

if (import.meta.main) {
  const arg = (name: string, fallback?: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? fallback : process.argv[i + 1]!;
  };
  const out = cookGlobe(
    arg("out") && resolve(arg("out")!),
    arg("globe") && resolve(arg("globe")!),
  );
  console.log(`${out}: ${(readFileSync(out).length / 1048576).toFixed(2)} MiB`);
}
