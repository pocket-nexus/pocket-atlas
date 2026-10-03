import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { shader } from "./atlas-ipod-shaders";

const assets = resolve(import.meta.dir, "../.pocket-build/ipod/assets/shaders");
const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod/merge-shaders");

test("iPod packed shadow writer and receiver retain their RGBA8 ABI after shared Vita shadow changes", () => {
  mkdirSync(directory, { recursive: true });
  const generated: string[] = [];
  const source = (name: string, defines: Record<string, number>) => {
    const key = shader(name, defines);
    generated.push(key);
    return readFileSync(join(assets, `${key}.glsl`), "utf8");
  };
  const link = (name: string, vertex: string, fragment: string) => {
    const vert = join(directory, `${name}.vert`), frag = join(directory, `${name}.frag`);
    writeFileSync(vert, vertex); writeFileSync(frag, fragment);
    const result = Bun.spawnSync(["glslangValidator", "-l", vert, frag], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stdout.toString()+result.stderr.toString()).toBe(0);
  };
  for (const alpha of [false, true]) for (const skin of [false, true]) {
    const v = source("surface_v", { ...(!alpha ? { FLAT: 1 } : {}), ...(skin ? { SKINNED: 1, MAX_BONES: 4, SKIP_ZERO_WEIGHTS: 1 } : {}) });
    const f = source("shadow_f", alpha ? { ALPHA_TEST: 1 } : {});
    expect(f).toMatch(/fract\([\s\S]*65025/);
    expect(f).not.toMatch(/atlasEncode\([^)]*(?:result|atlasColor)/);
    expect(f.includes("discard;")).toBe(alpha);
    link(`caster-${+alpha}-${+skin}`, v, f);
  }
  for (const fog of ["FOG", "VERTEX_FOG", "VISTA"]) for (const skin of [false, true]) {
    const v = source("surface_v", {
      ...(skin ? { SKINNED: 1, MAX_BONES: 4, SKIP_ZERO_WEIGHTS: 1 } : { BAKED: 1 }),
      ...(fog === "VERTEX_FOG" ? { VERTEX_FOG: 1 } : fog === "VISTA" ? { VISTA: 1 } : {}),
    });
    const f = source("standard_f", {
      LIGHTS: 0, SUN: 1, SUN_SPEC: 1, ...(skin ? {} : { BAKED: 1 }),
      ...(fog === "VERTEX_FOG" ? { FOG: 1, VERTEX_FOG: 1 } : { [fog]: 1 }),
    });
    expect(f).not.toMatch(/varying\s+(?:highp\s+)?vec3 vShadow|uMovingShadow/);
    expect(f).toContain("uSunMat");
    expect(f.match(/texture2D\(uShadow,/g)?.length).toBe(4);
    link(`receiver-${fog}-${+skin}`, v, f);
  }
  // The canonical writer's default stays float depth for Vita. Only iPod's
  // generator selects the packed branch; no global assets are regenerated.
  const shared = readFileSync(resolve(import.meta.dir, "../vita/shaders/shadow_f.cg"), "utf8");
  expect(shared).toContain("#ifdef PACKED_SHADOW");
  expect(shared).toContain("#else\n    return float4(d, d, d, 1.0);");
  writeFileSync(join(directory, "generated-shaders.json"), JSON.stringify([...new Set(generated)], null, 2));
}, 30_000);
