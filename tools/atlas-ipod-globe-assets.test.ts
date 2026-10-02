import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  cookGlobeAssets,
  resizePixels,
  sunCurve,
  type GlobeAsset,
} from "./atlas-ipod-globe-assets";

const validation = resolve(
  import.meta.dir,
  "../.pocket-build/validation/ipod-globe-tests",
);
function fixture(run: (input: string, output: string) => void) {
  mkdirSync(validation, { recursive: true });
  const dir = mkdtempSync(join(validation, "case-"));
  const input = join(dir, "source"),
    output = join(dir, "result");
  mkdirSync(input);
  const files: Record<string, unknown>[] = [];
  const raw = (
    name: string,
    width: number,
    height: number,
    channels: number,
    format: "u8" | "f32",
    values: number[],
    srgb = false,
  ) => {
    const file = `${name}.${format}`;
    const data = Buffer.alloc(
      width * height * channels * (format === "f32" ? 4 : 1),
    );
    for (let i = 0; i < width * height * channels; i++) {
      const v = values[i % values.length];
      if (format === "f32") data.writeFloatLE(v, i * 4);
      else data[i] = v;
    }
    writeFileSync(join(input, file), data);
    files.push({ name, file, width, height, channels, format, srgb });
  };
  raw("albedo", 8, 4, 4, "u8", [0, 0, 0, 0, 255, 255, 255, 255], true);
  raw("normals", 8, 4, 4, "u8", [204, 128, 230, 0, 51, 128, 230, 255]);
  raw("clouds", 8, 4, 4, "u8", [64, 128, 192, 255]);
  raw("lights", 8, 4, 2, "u8", [0, 255, 255, 0]);
  raw("space", 4, 2, 4, "f32", [4, 1, 0.25, 1]);
  raw("inscatter", 4, 2, 4, "f32", [4, 1, 0.25, 1]);
  raw("transmittance", 4, 2, 4, "f32", [0.25, 0.5, 0.75, 1]);
  raw("sun-transmittance", 4, 4, 4, "f32", [0.125, 0.25, 0.5, 1]);
  writeFileSync(
    join(input, "globe.json"),
    JSON.stringify({ files, sun: [0, 1, 0], framing: { width: 4, height: 2 } }),
  );
  try {
    run(input, output);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe("iPod globe assets", () => {
  test("surface channels, HDR encoding and f32 sunlight retain their meaning", () =>
    fixture((input, output) => {
      cookGlobeAssets(input, output, 4, 2);
      const meta = JSON.parse(readFileSync(join(output, "globe.json"), "utf8"));
      expect(meta.sun).toEqual([0, 1, 0]);
      expect(meta.files).toHaveLength(8);
      const file = (name: string): GlobeAsset =>
        meta.files.find((f: GlobeAsset) => f.name === name);
      const pixels = (name: string) =>
        readFileSync(join(output, file(name).file));
      expect(file("albedo").width).toBe(4);
      expect(file("albedo").height).toBe(2);
      expect(file("albedo").mips).toBe(3);
      expect(pixels("albedo").length).toBe((4 * 2 + 2 * 1 + 1) * 4);
      // RGB is gamma-correct, while alpha remains the independent water mask.
      expect([...pixels("albedo").subarray(0, 4)]).toEqual([
        188, 188, 188, 128,
      ]);
      expect([...pixels("normals").subarray(0, 4)]).toEqual([
        128, 128, 255, 128,
      ]);
      // Stored lights are sqrt intensity: this preserves mean emitted energy.
      expect([...pixels("lights").subarray(0, 4)]).toEqual([180, 180, 0, 255]);
      expect([...pixels("clouds").subarray(0, 4)]).toEqual([64, 128, 192, 255]);
      expect([...pixels("space").subarray(0, 4)]).toEqual([228, 180, 114, 255]);
      expect(file("space").encoding).toBe("sqrt-radiance");
      expect(file("space").mips).toBe(1);
      expect([...pixels("transmittance").subarray(0, 4)]).toEqual([
        64, 128, 191, 255,
      ]);
      expect(pixels("sun-transmittance")).toEqual(
        readFileSync(join(input, "sun-transmittance.f32")),
      );
      expect(meta.sunCurve).toHaveLength(32);
      for (const row of meta.sunCurve)
        expect(row).toEqual([0.125, 0.25, 0.5, 0]);
      for (const f of meta.files)
        expect(createHash("sha256").update(pixels(f.name)).digest("hex")).toBe(
          f.sha256,
        );
    }));

  test("sun curve samples both authored height rows and zenith domain", () => {
    const data = new Float32Array(256 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 256; x++) {
        const at = (y * 256 + x) * 4;
        data[at] = x;
        data[at + 1] = y;
        data[at + 2] = 0.25;
        data[at + 3] = 1;
      }
    const curve = sunCurve({ width: 256, height: 64, data });
    expect(curve[0]).toEqual([89, 0, 0.25, 0]);
    expect(curve[15]).toEqual([191, 0, 0.25, 0]);
    expect(curve[16]).toEqual([89, 24, 0.25, 0]);
    expect(curve[31]).toEqual([191, 24, 0.25, 0]);
  });

  test("fractional resampling uses area weights", () => {
    const data = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    const out = resizePixels({ width: 3, height: 1, data }, 2, 1);
    expect(out.data[0]).toBe(0);
    expect(out.data[4]).toBeCloseTo(2 / 3, 6);
  });

  test("malformed or missing maps fail before a completed manifest is written", () =>
    fixture((input, output) => {
      writeFileSync(join(input, "space.f32"), Buffer.alloc(4));
      expect(() => cookGlobeAssets(input, output, 4, 2)).toThrow(
        "size mismatch",
      );
    }));
});
