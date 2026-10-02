/** GLES2 globe assets from the shared web globe export.
 *
 * Surface maps keep all their channels: albedo alpha is a water mask and
 * normal alpha is elevation, not opacity. Screen-space radiance uses a
 * filterable RGBA8 encoding because SGX535 lacks half-float linear filtering.
 * No device connection or application build is performed here.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type SourceFile = {
  name: string;
  file: string;
  width: number;
  height: number;
  channels: number;
  format: "u8" | "f32";
  srgb: boolean;
};
type GlobeExport = Record<string, unknown> & { files: SourceFile[] };
type Encoding = "srgb" | "linear" | "sqrt-radiance";
type Filter = "color" | "normal" | "lights" | "data";
type Pixels = { width: number; height: number; data: Float32Array };
export type GlobeAsset = {
  name: string;
  file: string;
  width: number;
  height: number;
  channels: 4;
  format: "rgba8" | "f32";
  encoding: Encoding;
  mips: number;
  wrapS: "repeat" | "clamp";
  wrapT: "clamp";
  bytes: number;
  sha256: string;
};
const ROOT = resolve(import.meta.dir, "..");
const SURFACES: Record<string, Filter> = {
  albedo: "color",
  normals: "normal",
  lights: "lights",
  clouds: "data",
};
const ATMOSPHERE = new Set(["space", "inscatter", "transmittance"]);
const REQUIRED = [...Object.keys(SURFACES), ...ATMOSPHERE, "sun-transmittance"];
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const decodeSrgb = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const encodeSrgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

function readSource(
  dir: string,
  file: SourceFile,
): { bytes: Buffer; pixels: Pixels } {
  if (
    file.file !== basename(file.file) ||
    !file.file ||
    !["u8", "f32"].includes(file.format) ||
    !Number.isInteger(file.width) ||
    !Number.isInteger(file.height) ||
    file.width < 1 ||
    file.height < 1 ||
    ![1, 2, 3, 4].includes(file.channels)
  ) {
    throw new Error(`${file.name}: invalid source layout`);
  }
  const bytes = readFileSync(join(dir, file.file));
  const stride = file.format === "f32" ? 4 : 1;
  if (bytes.length !== file.width * file.height * file.channels * stride) {
    throw new Error(`${file.name}: source size mismatch`);
  }
  const data = new Float32Array(file.width * file.height * 4);
  const floats = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const filter = SURFACES[file.name];
  for (let i = 0; i < file.width * file.height; i++) {
    for (let c = 0; c < 4; c++) {
      let v =
        c < file.channels
          ? stride === 4
            ? floats.getFloat32((i * file.channels + c) * 4, true)
            : bytes[i * file.channels + c] / 255
          : c === 3
            ? 1
            : 0;
      if (!Number.isFinite(v))
        throw new Error(`${file.name}: non-finite source pixel ${i}`);
      if (c < 3 && file.srgb) v = decodeSrgb(v);
      // Lights store square-root intensity; average energy before re-encoding.
      if (c < 2 && filter === "lights") v *= v;
      if (c < 3 && filter === "normal") v = v * 2 - 1;
      data[i * 4 + c] = v;
    }
  }
  return { bytes, pixels: { width: file.width, height: file.height, data } };
}

/** Weighted box filter; exact area weights also support the 960×544 ray bakes.
 * All channels are independent. Masks / height / data are never opacity.
 */
export function resizePixels(
  source: Pixels,
  width: number,
  height: number,
  normal = false,
): Pixels {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isInteger(source.width) ||
    !Number.isInteger(source.height) ||
    width > source.width ||
    height > source.height ||
    source.data.length !== source.width * source.height * 4
  ) {
    throw new Error("Invalid globe resample dimensions");
  }
  const data = new Float32Array(width * height * 4);
  const sx = source.width / width,
    sy = source.height / height;
  for (let y = 0; y < height; y++) {
    const ya = y * sy,
      yb = (y + 1) * sy;
    for (let x = 0; x < width; x++) {
      const xa = x * sx,
        xb = (x + 1) * sx,
        at = (y * width + x) * 4;
      const sums = [0, 0, 0, 0];
      for (
        let yy = Math.floor(ya);
        yy < Math.min(source.height, Math.ceil(yb));
        yy++
      ) {
        const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (
          let xx = Math.floor(xa);
          xx < Math.min(source.width, Math.ceil(xb));
          xx++
        ) {
          const weight = wy * (Math.min(xb, xx + 1) - Math.max(xa, xx));
          const from = (yy * source.width + xx) * 4;
          for (let c = 0; c < 4; c++) sums[c] += source.data[from + c] * weight;
        }
      }
      for (let c = 0; c < 4; c++) data[at + c] = sums[c] / (sx * sy);
      if (normal) {
        const length = Math.hypot(data[at], data[at + 1], data[at + 2]);
        if (length > 1e-8) for (let c = 0; c < 3; c++) data[at + c] /= length;
        else {
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 1;
        }
      }
    }
  }
  return { width, height, data };
}

function rgba8(pixels: Pixels, filter: Filter, encoding: Encoding): Uint8Array {
  const result = new Uint8Array(pixels.data.length);
  for (let i = 0; i < result.length; i++) {
    const channel = i % 4;
    let v = pixels.data[i];
    if (channel < 3 && filter === "normal") v = v * 0.5 + 0.5;
    if (channel < 2 && filter === "lights") v = Math.sqrt(Math.max(v, 0));
    if (channel < 3 && encoding === "srgb") v = encodeSrgb(Math.max(v, 0));
    if (channel < 3 && encoding === "sqrt-radiance") {
      // 254 is the last finite reconstruction code (about 126.75 linear).
      // Refuse an over-range bake rather than silently clipping its radiance.
      if (v > 126.75)
        throw new Error(`Globe radiance exceeds RGBA8 encoding range: ${v}`);
      v = Math.sqrt(Math.max(v, 0) / (1 + Math.max(v, 0)));
      result[i] = Math.min(254, byte(v));
    } else result[i] = byte(v);
  }
  return result;
}

/** Same two rows and zenith range as vita/src/atlas.rs::sun_curve, sampled
 * directly from f32 so no half-float rounding precedes the vertex uniforms.
 */
export function sunCurve(source: Pixels): number[][] {
  const out: number[][] = [];
  for (const row of [0, 0.3873]) {
    const y = Math.min(
      source.height - 1,
      Math.round(row * (source.height - 1)),
    );
    for (let i = 0; i < 16; i++) {
      const mu = -0.3 + (0.8 * i) / 15;
      const x = Math.min(
        source.width - 1,
        Math.round((mu * 0.5 + 0.5) * (source.width - 1)),
      );
      const at = (y * source.width + x) * 4;
      out.push([source.data[at], source.data[at + 1], source.data[at + 2], 0]);
    }
  }
  return out;
}

export function cookGlobeAssets(
  input: string,
  output: string,
  surfaceWidth = 1024,
  atmosphereWidth = 512,
): void {
  if (
    surfaceWidth < 2 ||
    !Number.isInteger(surfaceWidth) ||
    (surfaceWidth & (surfaceWidth - 1)) !== 0 ||
    atmosphereWidth < 1 ||
    !Number.isInteger(atmosphereWidth)
  ) {
    throw new Error(
      "Surface width must be a power of two; atmosphere width must be a positive integer",
    );
  }
  const manifest = readFileSync(join(input, "globe.json"));
  const globe = JSON.parse(manifest.toString()) as GlobeExport;
  if (
    !Array.isArray(globe.files) ||
    globe.files.length !== REQUIRED.length ||
    new Set(globe.files.map((f) => f.name)).size !== REQUIRED.length ||
    REQUIRED.some((name) => !globe.files.some((f) => f.name === name))
  ) {
    throw new Error(
      "globe.json must contain each of the eight shared globe maps exactly once",
    );
  }
  mkdirSync(output, { recursive: true });
  const files: GlobeAsset[] = [];
  const sourceHashes: Record<string, string> = { "globe.json": sha(manifest) };
  let curve: number[][] = [];
  for (const file of globe.files) {
    const { bytes, pixels } = readSource(input, file);
    sourceHashes[file.file] = sha(bytes);
    if (file.name === "sun-transmittance") {
      if (file.format !== "f32" || file.channels !== 4 || file.srgb)
        throw new Error("Sunlight table must be linear f32 RGBA");
      curve = sunCurve(pixels);
      writeFileSync(join(output, file.file), bytes);
      files.push({
        name: file.name,
        file: file.file,
        width: file.width,
        height: file.height,
        channels: 4,
        format: "f32",
        encoding: "linear",
        mips: 1,
        wrapS: "clamp",
        wrapT: "clamp",
        bytes: bytes.length,
        sha256: sha(bytes),
      });
      continue;
    }
    const surface = Object.hasOwn(SURFACES, file.name);
    if (surface && (file.format !== "u8" || file.width !== file.height * 2))
      throw new Error(`${file.name}: expected equirectangular u8 map`);
    const minimumChannels =
      file.name === "lights" ? 2 : file.name === "clouds" ? 3 : 4;
    if (surface && file.channels < minimumChannels)
      throw new Error(`${file.name}: missing required surface channels`);
    if (!surface && (file.format !== "f32" || file.channels !== 4 || file.srgb))
      throw new Error(`${file.name}: expected linear f32 RGBA ray bake`);
    if (surface && file.srgb !== (file.name === "albedo"))
      throw new Error(`${file.name}: unexpected colour space`);
    const filter = surface ? SURFACES[file.name] : "data";
    const encoding: Encoding = surface
      ? file.srgb
        ? "srgb"
        : "linear"
      : file.name === "transmittance"
        ? "linear"
        : "sqrt-radiance";
    const width = Math.min(
      surface ? surfaceWidth : atmosphereWidth,
      file.width,
    );
    const height = surface
      ? width / 2
      : Math.max(1, Math.round((file.height * width) / file.width));
    let level = resizePixels(pixels, width, height, filter === "normal");
    const levels: Uint8Array[] = [];
    for (;;) {
      levels.push(rgba8(level, filter, encoding));
      if (!surface || (level.width === 1 && level.height === 1)) break;
      level = resizePixels(
        level,
        Math.max(1, level.width / 2),
        Math.max(1, level.height / 2),
        filter === "normal",
      );
    }
    const payload = Buffer.concat(levels);
    const name = `${file.name}.rgba8`;
    writeFileSync(join(output, name), payload);
    files.push({
      name: file.name,
      file: name,
      width,
      height,
      channels: 4,
      format: "rgba8",
      encoding,
      mips: levels.length,
      wrapS: surface ? "repeat" : "clamp",
      wrapT: "clamp",
      bytes: payload.length,
      sha256: sha(payload),
    });
    console.log(
      `${file.name}: ${width}×${height} ×${levels.length} ${encoding}, ${payload.length} bytes`,
    );
  }
  const metadata = {
    ...globe,
    files,
    sunCurve: curve,
    sunCurveDomain: { min: -0.3, max: 0.5, samples: 16, rows: [0, 0.3873] },
    radianceEncoding: {
      encode: "sqrt(c/(1+c))",
      decode: "e*e/(1-e*e)",
      alpha: "linear",
      maxCode: 254,
    },
    rows: "top-down",
    sourceHashes,
  };
  writeFileSync(
    join(output, "globe.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  console.log(
    `Globe assets: ${files.reduce((n, f) => n + f.bytes, 0)} bytes; 32 sunlight vec4s`,
  );
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`Missing value for ${name}`);
    return args[i + 1];
  };
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--in", "--out", "--surface-width", "--atmosphere-width"].includes(
        args[i],
      )
    )
      throw new Error(`Unknown option ${args[i]}`);
  }
  cookGlobeAssets(
    resolve(option("--in", join(ROOT, ".pocket-build/atlas/globe"))),
    resolve(option("--out", join(ROOT, ".pocket-build/ipod/assets/globe"))),
    Number(option("--surface-width", "1024")),
    Number(option("--atmosphere-width", "512")),
  );
}
