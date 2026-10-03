import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { wetVertex, wetFragment, wetResponseFragment, wetResolveFragment } from "./atlas-ipod-wet";
import { shader } from "./atlas-ipod-shaders";
import { samplerDeclarations } from "./atlas-ipod-textures";

test("wet response splits the authoritative kernel and resolve keeps native coverage, fog and depth", () => {
  const shared = readFileSync(resolve(import.meta.dir, "../vita/shaders/color_f.cg"), "utf8");
  const response = wetResponseFragment(shared), resolveSource = wetResolveFragment(shared);
  for (const sample of ["uPuddles", "uRipples", "uDisplayReflSharp", "uDisplayReflBlur"])
    expect(response).toContain(`tex2D(${sample}`);
  expect(response).toContain("return half4(reflected * (fresnel * weight), darkening)");
  expect(response).toContain("if (c.a < uEmissive.w) discard");
  expect(response).not.toContain("c.rgb = lerp(uDisplayHaze");
  expect(resolveSource).not.toMatch(/uPuddles|uRipples|uWetCurve|uDisplayRefl|normalize\(/);
  expect(resolveSource).toContain("c.rgb = c.rgb * response.a + response.rgb;");
  for (const preserved of ["c *= tex2D(uAlbedo, vUv)", "tex2D(uEmission, vUv)",
    "if (c.a < uEmissive.w) discard", "lerp(uDisplayHaze.rgb, c.rgb, uDisplayHaze.a)",
    "lerp(c.rgb, uDisplayFog.rgb, vFog)", "return half4(c.rgb, vDepth)"])
    expect(resolveSource).toContain(preserved);
  expect(() => wetResponseFragment(shared.replace("reflected * (fresnel * weight)", "reflected"))).toThrow("decomposition contract");
  expect(() => wetResolveFragment("void main(){} ")).toThrow("contract changed");
});

test("wet response and native resolve link with minimal samplers for every coverage and fog mode", () => {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-wet-tests/separated");
  mkdirSync(directory, { recursive: true });
  for (const alpha of [false, true]) for (const albedo of [false, true]) {
    for (const fog of ["none", "fog", "vista"]) for (const response of [false, true]) {
      const v: Record<string, number> = { COLOR: 1, DISPLAY_COLOR: 1, FLOAT_VERTEX: 1, STATIC_WORLD: 1, SCREEN: 1 };
      const f: Record<string, number> = { WET: 1, [response ? "SGX_WET_RESPONSE" : "SGX_WET_RESOLVE"]: 1 };
      if (albedo) f.ALBEDO_MAP = 1;
      if (alpha) f.ALPHA_TEST = 1;
      if (response) v.SGX_WET = 1;
      else {
        v.LDR_COLOR = 1;
        f.EMISSION_MAP = 1;
        if (fog === "fog") { v.VERTEX_FOG = 1; f.FOG = 1; }
        if (fog === "vista") f.VISTA = 1;
      }
      const keys = [shader("surface_v", v), shader("color_f", f)];
      const sources = keys.map(k => readFileSync(resolve(import.meta.dir, `../.pocket-build/ipod/assets/shaders/${k}.glsl`), "utf8"));
      const names = sources.flatMap(samplerDeclarations).sort();
      expect(names).toEqual(response
        ? [...(alpha && albedo ? ["uAlbedo"] : []), "uDisplayReflBlur", "uDisplayReflSharp", "uPuddles", "uRipples"].sort()
        : [...(albedo ? ["uAlbedo"] : []), "uEmission", "uWetResponse"].sort());
      expect(sources[1]).not.toContain("atlasDisplay(");
      expect(sources[1]).not.toContain("gl_LastFragData");
      expect(sources[0].includes("vWetFresnel")).toBe(response);
      const files = sources.map((source, stage) => {
        const path = join(directory, `${+response}-${+alpha}-${+albedo}-${fog}.${stage ? "frag" : "vert"}`);
        writeFileSync(path, source); return path;
      });
      const linked = Bun.spawnSync(["glslangValidator", "-l", ...files], { stdout: "pipe", stderr: "pipe" });
      expect(linked.exitCode, linked.stdout.toString() + linked.stderr.toString()).toBe(0);
    }
  }
});

test("response quantization bounds color error independently of material fog and native albedo", () => {
  const byte = (x: number) => Math.round(x * 255) / 255;
  let seed = 1;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  // At a common sample position, decomposition is exact before storage.
  // Linear reconstruction is an additional spatial approximation, separate
  // from this coefficient-quantization bound; no pixel-equivalence claim.
  for (let i = 0; i < 16384; i++) {
    const base = random() * 2, darken = random(), puddle = random();
    const fresnel = 0.04 + 0.96 * random() ** 4;
    const weight = random(), reflection = random(), fog = random(), fogColor = random();
    const d = darken * (1 - 0.33 * puddle), r = reflection * fresnel * weight;
    const original = (base * d + r) * (1 - fog) + fogColor * fog;
    const resolved = (base * byte(d) + byte(r)) * (1 - fog) + fogColor * fog;
    expect(Math.abs(original - resolved)).toBeLessThanOrEqual((base + 1) * (1 - fog) / 510 + 1e-12);
  }
  // Untouched response pixels preserve the material exactly.
  for (const base of [0, 0.01, 0.5, 1, 2]) expect(base * byte(1) + byte(0)).toBe(base);
});

test("wet lowering retains ripple and reflection sampling with matched view interpolators", () => {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-wet-tests");
  mkdirSync(directory, { recursive: true });
  const expand = (name: string): string => readFileSync(resolve(import.meta.dir, "../vita/shaders", name), "utf8")
    .replace(/#include "([^"\n]+)"/g, (_, n) => expand(n));
  const vertex = wetVertex(expand("surface_v.cg"));
  const fragment = wetFragment(expand("color_f.cg"));
  expect(fragment).toContain("tex2D(uPuddles, vWetUv.xy)");
  expect(fragment).toContain("tex2D(uRipples");
  expect(fragment).toContain("tex2D(uDisplayReflSharp");
  expect(fragment).toContain("tex2D(uDisplayReflBlur");
  expect(fragment).not.toContain("normalize(");
  expect(() => wetFragment("void main(){}")).toThrow("contract changed");
  for (const fog of [false, true]) {
    const files = [vertex, fragment].map((source, stage) => {
      const path = join(directory, `wet-${Number(fog)}.${stage ? "frag" : "vert"}`);
      const hlsl = path + ".hlsl", spv = path + ".spv";
      writeFileSync(hlsl, source.replace(/: POSITION\b/g, ": SV_Position").replace(/: COLOR\b/g, ": SV_Target"));
      const flags = stage ? ["WET", "ALBEDO_MAP", ...(fog ? ["FOG"] : [])]
        : ["COLOR", "DISPLAY_COLOR", "FLOAT_VERTEX", "STATIC_WORLD", "SCREEN", "LDR_COLOR", ...(fog ? ["VERTEX_FOG"] : [])];
      const compiled = Bun.spawnSync(["glslangValidator", "-D", "--hlsl-dx9-compatible", "--auto-map-bindings", "--auto-map-locations", "-V", "-S", stage ? "frag" : "vert", "-e", "main", ...flags.map(f => `-D${f}=1`), hlsl, "-o", spv], { stdout: "pipe", stderr: "pipe" });
      expect(compiled.exitCode, compiled.stdout.toString() + compiled.stderr.toString()).toBe(0);
      const translated = Bun.spawnSync(["spirv-cross", spv, "--es", "--version", "100"], { stdout: "pipe", stderr: "pipe" });
      expect(translated.exitCode, translated.stderr.toString()).toBe(0);
      writeFileSync(path, translated.stdout.toString().replace(/\bo(WetUv|WetFresnel|Screen|Color|Uv|Fog|Depth)\b/g, "v$1"));
      return path;
    });
    const linked = Bun.spawnSync(["glslangValidator", "-l", ...files], { stdout: "pipe", stderr: "pipe" });
    expect(linked.exitCode, linked.stdout.toString() + linked.stderr.toString()).toBe(0);
  }
});
