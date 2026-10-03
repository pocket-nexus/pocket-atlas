/** Cook the shared globe export, canonical atlas previews/font and live registry
 * into the small native 3DS browser pack. No browser or device is needed here.
 * bun tools/atlas-3ds-assets.ts [--out .pocket-build/3ds/romfs/atlas.3ds]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PLACES } from "../web/src/places/registry";

const root = resolve(import.meta.dir, "..");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1]!;
};
const source = resolve(arg("atlas", `${root}/.pocket-build/atlas/atlas.pack`));
const globeDir = resolve(arg("globe", `${root}/.pocket-build/atlas/globe`));
const out = resolve(arg("out", `${root}/.pocket-build/3ds/romfs/atlas.3ds`));
const pack = readFileSync(source);
if (pack.toString("ascii", 0, 4) !== "ATLS")
  throw new Error("Expected canonical ATLS pack");
function section(tag: string): Buffer {
  for (let i = 0; i < pack.readUInt32LE(8); i++) {
    const at = 16 + i * 16;
    if (pack.toString("ascii", at, at + 4) === tag) {
      const offset = pack.readUInt32LE(at + 4),
        size = pack.readUInt32LE(at + 8);
      if (offset + size > pack.length) throw new Error(`Truncated ${tag}`);
      return pack.subarray(offset, offset + size);
    }
  }
  throw new Error(`Missing ${tag}`);
}
const meta = JSON.parse(section("META").toString());
const coverage = section("FONT"),
  texdata = section("TEXD");
const globe = JSON.parse(readFileSync(`${globeDir}/globe.json`, "utf8"));
const HEADER = 96,
  PLACE = 68,
  GLYPH = 20,
  TEX = 32;
const chunks: Buffer[] = [];
let cursor = 0;
function push(b: Buffer, alignment = 4): number {
  const pad = (alignment - (cursor % alignment)) % alignment;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    cursor += pad;
  }
  const at = cursor;
  chunks.push(b);
  cursor += b.length;
  return at;
}
const header = Buffer.alloc(HEADER);
push(header);
const places = Buffer.alloc(PLACES.length * PLACE);
const placesAt = push(places);
// A single 13 px face, sampled from the shared 15 px caption glyphs. Keep the
// same registered charset, including Japanese/Korean/Chinese and Latin names.
const fontScale = 13 / 15;
const glyphs = meta.font.glyphs
  .filter((g: any) => g.style === 0)
  .sort((a: any, b: any) => a.cp - b.cp);
const glyphBytes = Buffer.alloc(glyphs.length * GLYPH),
  glyphAt = push(glyphBytes);
const fw = 512;
let fx = 1,
  fy = 1,
  rowH = 0;
const cells: { g: any; x: number; y: number; w: number; h: number }[] = [];
for (const g of glyphs) {
  const w = Math.max(1, Math.ceil(g.w * fontScale)),
    h = Math.max(1, Math.ceil(g.h * fontScale));
  if (fx + w + 1 > fw) {
    fx = 1;
    fy += rowH + 1;
    rowH = 0;
  }
  cells.push({ g, x: fx, y: fy, w, h });
  fx += w + 1;
  rowH = Math.max(rowH, h);
}
const fh = 2 ** Math.ceil(Math.log2(fy + rowH + 1));
if (fh > 1024) throw new Error(`Font exceeds PICA texture limits: ${fw}x${fh}`);
const font = Buffer.alloc(fw * fh);
for (const [i, c] of cells.entries()) {
  const { g, x, y, w, h } = c,
    at = i * GLYPH;
  glyphBytes.writeUInt32LE(g.cp, at);
  for (const [j, n] of [x, y, w, h].entries())
    glyphBytes.writeUInt16LE(n, at + 4 + j * 2);
  glyphBytes.writeInt16LE(Math.round(g.left * fontScale), at + 12);
  glyphBytes.writeInt16LE(Math.round(g.top * fontScale), at + 14);
  glyphBytes.writeFloatLE(g.advance * fontScale, at + 16);
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++) {
      // Area sampling preserves tiny stems better than nearest-neighbour.
      let sum = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const ox = Math.min(
            g.w - 1,
            Math.floor((xx + (sx + 0.5) / 2) / fontScale),
          );
          const oy = Math.min(
            g.h - 1,
            Math.floor((yy + (sy + 0.5) / 2) / fontScale),
          );
          if (ox >= 0 && oy >= 0)
            sum += coverage[(g.y + oy) * meta.font.width + g.x + ox];
        }
      font[(y + yy) * fw + x + xx] = Math.round(sum / 4);
    }
}
const texCount = 3 + PLACES.filter((p) => !!p.load).length;
const texHeaders = Buffer.alloc(texCount * TEX),
  texAt = push(texHeaders);
const fields = [
  "id",
  "name",
  "native",
  "locality",
  "localityNative",
  "country",
  "weather",
  "author",
  "kind",
  "tags",
  "summary",
  "timeZone",
] as const;
for (const [i, p] of PLACES.entries()) {
  for (const [j, key] of fields.entries()) {
    const value = key === "tags" ? (p.tags ?? []).join(" · ") : (p[key] ?? "");
    places.writeUInt32LE(push(Buffer.from(`${value}\0`)), i * PLACE + j * 4);
  }
  places.writeFloatLE(p.lat, i * PLACE + 48);
  places.writeFloatLE(p.lon, i * PLACE + 52);
  places.writeUInt32LE((p.load && p.targets?.includes("3ds") ? 1 : 0) | (p.featured ? 2 : 0), i * PLACE + 56);
  places.writeUInt32LE(parseInt(p.accent.replace("#", ""), 16), i * PLACE + 60);
  places.writeInt32LE(-1, i * PLACE + 64);
}
const fontAt = push(font);
// Metadata/font stay resident on scene entry; GPU texture payloads are streamed.
const dataAt = (cursor + 127) & ~127;
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
let nextTex = 0;
function texture(
  w: number,
  h: number,
  alpha: boolean,
  sample: (x: number, y: number) => number[],
) {
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
  const id = nextTex++,
    at = id * TEX;
  [w, h, alpha ? 1 : 0, push(data, 128), data.length].forEach((n, i) =>
    texHeaders.writeUInt32LE(n, at + i * 4),
  );
  return id;
}
for (const name of ["albedo", "lights", "clouds"]) {
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
  texture(width, height, name === "clouds", (x, y) => {
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
}
function rgb565(n: number) {
  return [
    ((n >> 11) * 255) / 31,
    (((n >> 5) & 63) * 255) / 63,
    ((n & 31) * 255) / 31,
  ];
}
function bc1(tex: any, x: number, y: number): number[] {
  if (tex.format !== "bc1")
    throw new Error(`Preview should be BC1: ${tex.name}, ${tex.format}`);
  const at =
    tex.data.offset + ((y >> 2) * Math.ceil(tex.width / 4) + (x >> 2)) * 8;
  const a = texdata.readUInt16LE(at),
    b = texdata.readUInt16LE(at + 2),
    ca = rgb565(a),
    cb = rgb565(b);
  const colors = [
    ca,
    cb,
    ca.map((v, k) => (v * 2 + cb[k]) / 3),
    ca.map((v, k) => (v + cb[k] * 2) / 3),
  ];
  const index =
    (texdata.readUInt32LE(at + 4) >>> (((y & 3) * 4 + (x & 3)) * 2)) & 3;
  return colors[index];
}
for (const [i, p] of PLACES.entries())
  if (p.load) {
    const tex = meta.textures.find((t: any) => t.name === `preview:${p.id}`);
    if (!tex)
      throw new Error(
        `Missing shared preview for ${p.id}; run preview-place.ts and cook-atlas`,
      );
    const id = texture(256, 128, false, (x, y) => {
      const c = [0, 0, 0];
      for (let yy = 0; yy < 2; yy++)
        for (let xx = 0; xx < 2; xx++) {
          const s = bc1(
            tex,
            Math.min(
              tex.width - 1,
              Math.floor(((x + (xx + 0.5) / 2) * tex.width) / 256),
            ),
            Math.min(
              tex.height - 1,
              Math.floor(((y + (yy + 0.5) / 2) * tex.height) / 128),
            ),
          );
          for (let j = 0; j < 3; j++) c[j] += s[j] / 4;
        }
      return c;
    });
    places.writeInt32LE(id, i * PLACE + 64);
  }
header.write("AT3B");
[
  1,
  PLACES.length,
  placesAt,
  glyphs.length,
  glyphAt,
  fw,
  fh,
  fontAt,
  font.length,
  texCount,
  texAt,
  dataAt,
  cursor,
].forEach((n, i) => header.writeUInt32LE(n, 4 + i * 4));
[
  globe.startLat,
  globe.startLon,
  globe.idleDegPerS,
  globe.cloudDriftPerS,
  ...globe.sun,
].forEach((n, i) => header.writeFloatLE(n, 56 + i * 4));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat(chunks));
console.log(
  `${out}: ${PLACES.length} places, ${texCount} textures, ${glyphs.length} glyphs, ${fw}x${fh} font, ${(cursor / 1048576).toFixed(2)} MiB`,
);
