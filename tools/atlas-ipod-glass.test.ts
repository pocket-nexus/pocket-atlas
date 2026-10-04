import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { displayGlassFragment, shader } from "./atlas-ipod-shaders";

const dot = (a: number[], b: number[]) => a.reduce((v, x, i) => v + x * b[i], 0);
const unit = (a: number[]) => a.map(x => x / Math.hypot(...a));
const oct = (a: number[]) => {
  const s = a.reduce((v, x) => v + Math.abs(x), 0), d = a.map(x => x / s);
  let p = [d[0], d[2]];
  if (d[1] < 0) p = [(1 - Math.abs(p[1])) * (p[0] >= 0 ? 1 : -1), (1 - Math.abs(p[0])) * (p[1] >= 0 ? 1 : -1)];
  return p.map(x => x * .5 + .5);
};

test("glass homogeneous reflection preserves both faces, Fresnel and fog for unnormalized view vectors", () => {
  for (let i = 0; i < 4096; i++) {
    const n = unit([Math.sin(i * .971 + .4), Math.cos(i * .17), Math.sin(i * 1.313)]);
    const eye = [Math.cos(i * .43), Math.sin(i * .31 + .2), Math.cos(i * 1.13)].map(x => x * (0.001 + i * .019));
    const v = unit(eye), nv = dot(n, v), facing = n.map(x => nv < 0 ? -x : x);
    const old = oct(facing.map((x, k) => 2 * x * dot(facing, v) - v[k]));
    const current = oct(n.map((x, k) => 2 * x * dot(n, eye) - eye[k]));
    expect(Math.max(...old.map((x, k) => Math.abs(x - current[k])))).toBeLessThan(1e-12);
    expect(Math.abs(dot(facing, v) - Math.abs(dot(n, eye)) / Math.sqrt(dot(eye, eye)))).toBeLessThan(1e-12);
    const dist = Math.hypot(...eye), density = .017;
    expect(Math.abs((1 - Math.exp(-density * density * dist * dist)) - (1 - Math.exp(-density * density * dot(eye, eye))))).toBeLessThan(1e-12);
  }
});

test("display glass links with drops, Vista and fog while retaining premultiplied coverage and full reference", () => {
  const shared = readFileSync(resolve(import.meta.dir, "../vita/shaders/glass_f.cg"), "utf8");
  const lowered = displayGlassFragment(shared);
  expect(lowered).toContain("tex2D(uBeads, guv)");
  expect(lowered).toContain("return half4(color, cover)");
  expect(lowered).not.toContain("if (dot(N, V) < 0.0)");
  expect(() => displayGlassFragment("void main() {}")).toThrow("contract changed");
  const out = resolve(import.meta.dir, "../.pocket-build/ipod/assets/shaders");
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-glass-tests");
  mkdirSync(directory, { recursive: true });
  const vertex = shader("surface_v", { COLOR: 1, DISPLAY_COLOR: 1, DISPLAY_NORMAL: 1, FLOAT_VERTEX: 1, STATIC_WORLD: 1, LDR_COLOR: 1 });
  const modes: Record<string, number>[] = [{}, { FOG: 1 }, { VISTA: 1 }, { NO_DROPS: 1 }];
  for (const mode of modes) {
    const key = shader("glass_f", { DISPLAY_COLOR: 1, LITE: 1, LIGHTS: 0, ATLAS_LDR: 1, ATLAS_OUTPUT_LDR: 1, ATLAS_BLEND: 3, ...mode });
    const fragment = readFileSync(join(out, key + ".glsl"), "utf8");
    expect(fragment).not.toMatch(/\blength\s*\(|\buAtlasLut\b/);
    expect(fragment).toContain("uDisplayEnv");
    const files = [vertex, key].map((name, i) => {
      const path = join(directory, `${key}.${i ? "frag" : "vert"}`);
      writeFileSync(path, readFileSync(join(out, name + ".glsl"), "utf8"));
      return path;
    });
    const p = Bun.spawnSync(["glslangValidator", "-l", ...files], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode, p.stdout.toString() + p.stderr.toString()).toBe(0);
  }
  const full = shader("glass_f", { LIGHTS: 1, ATLAS_BLEND: 3 });
  expect(readFileSync(join(out, full + ".glsl"), "utf8")).toMatch(/\blength\s*\(/);
});
