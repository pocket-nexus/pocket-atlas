/**
 * The globe's surface for the renderers that draw it as one lit, textured
 * sphere (the iPod touch and the PSP): the web export's daylight albedo with
 * its city lights in the alpha channel, equirectangular, north at row 0.
 * Needs `web/scripts/export-atlas.ts` to have written `.pocket-build/atlas/globe`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "../.pocket-build/atlas/globe");

/** RGBA8 rows, `width` by `width / 2`: albedo, and the lights' luminance in alpha. */
export function globeSurface(width: number): Uint8Array {
  if (!existsSync(join(source, "globe.json"))) throw new Error("no globe export: run web/scripts/export-atlas.ts (see README, PS Vita)");
  const globe = JSON.parse(readFileSync(join(source, "globe.json"), "utf8"));
  const file = (name: string) => globe.files.find((f: { name: string }) => f.name === name) as { file: string; width: number; height: number; channels: number };
  const albedo = file("albedo"), lights = file("lights");
  const texels = readFileSync(join(source, albedo.file)), lumens = readFileSync(join(source, lights.file));
  const height = width / 2, step = albedo.width / width, out = new Uint8Array(width * height * 4);
  if (!Number.isInteger(step) || albedo.width !== lights.width || albedo.height !== albedo.width / 2) throw new Error("unexpected globe export size");
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      for (let j = 0; j < step; j++)
        for (let i = 0; i < step; i++) {
          const at = (y * step + j) * albedo.width + x * step + i;
          for (let c = 0; c < 3; c++) sum[c] += texels[at * 4 + c];
          // The web shader's luminance: both channels squared, times its gain.
          const r = lumens[at * 2] / 255, g = lumens[at * 2 + 1] / 255;
          sum[3] += Math.min(1, (r * r + g * g) * globe.lightsMax * globe.lightsGain);
        }
      const n = step * step, at = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) out[at + c] = Math.round(sum[c] / n);
      // A city is a few source texels: keep its peak from averaging away.
      out[at + 3] = Math.round(255 * Math.min(1, Math.sqrt(sum[3] / n) * 1.6));
    }
  return out;
}

/** GE texels are stored in blocks sixteen bytes wide and eight rows tall. */
function swizzle(rows: Uint8Array, rowBytes: number): Uint8Array {
  const out = new Uint8Array(rows.length), across = rowBytes / 16;
  for (let at = 0; at < rows.length; at++) {
    const x = at % rowBytes, y = (at - x) / rowBytes;
    out[((y >> 3) * across + (x >> 4)) * 128 + (y & 7) * 16 + (x & 15)] = rows[at];
  }
  return out;
}

/**
 * The surface as the PSP's globe reads it (psp/src/globe.rs): the daylight
 * side as swizzled RGBA8888, then the lights as swizzled RGBA4444, a warm
 * white whose alpha is their luminance.
 */
export function globeSurfacePsp(width: number): Uint8Array {
  const surface = globeSurface(width), texels = surface.length / 4;
  const day = new Uint8Array(surface), lights = new Uint8Array(texels * 2);
  for (let i = 0; i < texels; i++) {
    const value = 0x07bf | (surface[i * 4 + 3] >> 4) << 12; // A, B, G, R nibbles
    lights[i * 2] = value & 255;
    lights[i * 2 + 1] = value >> 8;
    day[i * 4 + 3] = 255;
  }
  return Buffer.concat([swizzle(day, width * 4), swizzle(lights, width * 2)]);
}

if (import.meta.main) {
  const width = Number(process.argv[2] ?? 512), out = process.argv[3] ?? "globe.rgba";
  await Bun.write(out, globeSurface(width));
  console.log(`${out}: ${width}x${width / 2} RGBA`);
}
