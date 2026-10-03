import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ldrPostSource } from "./atlas-ipod-post";

const output = resolve(import.meta.dir, "../.pocket-build/validation/ipod-post-tests");

test("display post retains grain/mask and enabled effects without a tone lookup or HDR math", () => {
  mkdirSync(output, { recursive: true });
  for (const bloom of [false, true]) for (const haze of [false, true]) {
    const source = ldrPostSource({ bloom, haze });
    expect(source).not.toMatch(/uLut|radiance|sqrt\(|pow\(|\bif\s*\(/);
    expect(source.includes("uBloom")).toBe(bloom || haze);
    expect(source).not.toContain("uHazeTex");
    expect((source.match(/texture2D\(uBloom,/g) ?? []).length).toBe(bloom || haze ? 1 : 0);
    expect(source).toContain("texture2D(uGrain,vGrain)");
    expect(source).toContain("texture2D(uMask,vUv)");
    const path = join(output, `display-${+bloom}-${+haze}.frag`);
    writeFileSync(path, source);
    const result = Bun.spawnSync(["glslangValidator", "-S", "frag", path], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  }
});
