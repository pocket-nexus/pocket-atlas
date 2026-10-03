import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GLOBE_ENCODED_MAX, globeGradeSource } from "./atlas-ipod-globe";

const output = resolve(import.meta.dir, "../.pocket-build/validation/ipod-globe-tests");
const assets = resolve(import.meta.dir, "../.pocket-build/ipod/assets");

function half(value: number): number {
  if (!value || !Number.isFinite(value)) return value;
  const sign = Math.sign(value), magnitude = Math.abs(value);
  const step = 2 ** (Math.max(-14, Math.floor(Math.log2(magnitude))) - 10);
  const scaled = magnitude / step, lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = fraction > 0.5 || (fraction === 0.5 && lower % 2 !== 0) ? lower + 1 : lower;
  return sign * rounded * step;
}

function oldCoordinate(encoded: number, precision: (v: number) => number): number {
  const value = precision(encoded);
  const q = precision(value * value);
  const radiance = precision(q / Math.max(precision(1 - q), precision(1 / 255)));
  const normalized = Math.fround(radiance / Math.fround(1 + radiance));
  return Math.fround(Math.fround(Math.sqrt(normalized)) * 31);
}

test("bounded encoded grade cancels mathematically over the full input domain", () => {
  let maximum = 0;
  // A scalar transfer applies independently to all RGB combinations. Dense
  // probes include every source byte and the whole bilinear interpolation
  // domain; this is not a claim about the device's mediump implementation.
  for (let i = 0; i <= 65536; i++) {
    const encoded = i / 65536 * GLOBE_ENCODED_MAX;
    const q = encoded * encoded;
    expect(1 - q).toBeGreaterThan(1 / 255);
    const radiance = q / (1 - q);
    maximum = Math.max(maximum, Math.abs(Math.sqrt(radiance / (1 + radiance)) - encoded));
  }
  expect(maximum).toBeLessThan(1e-14);
});

test("all finite binary16 inputs and source bytes bound the host rounding difference", () => {
  let halfMaximum = 0, halfAt = 0, halfSamples = 0, floatMaximum = 0, byteMaximum = 0;
  for (let bits = 0; bits < 0x7c00; bits++) {
    const exponent = bits >>> 10, mantissa = bits & 1023;
    const value = exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
    if (value > GLOBE_ENCODED_MAX) break;
    expect(half(value)).toBe(value);
    halfSamples++;
    const difference = Math.abs(oldCoordinate(value, half) - Math.fround(value * 31));
    if (difference > halfMaximum) { halfMaximum = difference; halfAt = value; }
  }
  for (let i = 0; i <= 65536; i++) {
    const value = Math.fround(i / 65536 * GLOBE_ENCODED_MAX);
    floatMaximum = Math.max(floatMaximum,
      Math.abs(oldCoordinate(value, Math.fround) - Math.fround(value * 31)));
  }
  for (let byte = 0; byte <= 254; byte++) {
    const value = half(byte / 255);
    byteMaximum = Math.max(byteMaximum,
      Math.abs(oldCoordinate(value, half) - Math.fround(value * 31)));
  }
  expect(halfSamples).toBeGreaterThan(15000);
  expect(halfMaximum).toBeLessThan(0.007);
  expect(byteMaximum).toBeLessThan(0.007);
  expect(floatMaximum).toBeLessThan(0.00001);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "precision-model.json"), JSON.stringify({
    encodedRange: [0, GLOBE_ENCODED_MAX], halfSamples,
    binary16MaxLutCellDifference: halfMaximum, binary16WorstInput: halfAt,
    rgba8MaxLutCellDifference: byteMaximum, binary32DenseMaxLutCellDifference: floatMaximum,
    limit: "Host IEEE binary16/binary32 arithmetic model. Device mediump/filter precision is not measured here.",
  }, null, 2));
});

test("specialized fragment keeps tone/grain/mask and compiles as GLES 2", () => {
  const source = globeGradeSource();
  expect(source).not.toMatch(/atlasDecode|atlasEncode|sqrt\(|log2\(|exp2\(/);
  expect(source).toContain("texture2D(uGrain,vGrain)");
  expect(source).toContain("texture2D(uMask,vUv)");
  mkdirSync(output, { recursive: true });
  const path = join(output, "globe-grade.frag");
  writeFileSync(path, source);
  const result = Bun.spawnSync(["glslangValidator", "-S", "frag", path], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
});

test.skipIf(!existsSync(join(assets, "globe.pipelines.json")))("actual generated globe post vertex links both full and specialized fragments", () => {
  const pipelines = JSON.parse(readFileSync(join(assets, "globe.pipelines.json"), "utf8"));
  mkdirSync(output, { recursive: true });
  const vertex = join(output, "actual-post.vert");
  writeFileSync(vertex, readFileSync(join(assets, "shaders", pipelines.post[0] + ".glsl")));
  for (const [name, source] of [
    ["full", readFileSync(join(assets, "shaders", pipelines.post[1] + ".glsl"), "utf8")],
    ["performance", globeGradeSource()],
  ]) {
    const fragment = join(output, `linked-${name}.frag`);
    writeFileSync(fragment, source);
    const result = Bun.spawnSync(["glslangValidator", "-l", vertex, fragment], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  }
});
