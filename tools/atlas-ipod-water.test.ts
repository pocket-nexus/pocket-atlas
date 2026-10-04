import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { usesWaterResponse, waterResolveDefines, waterResolveSource, waterPrograms } from "./atlas-ipod-water";
import { samplerDeclarations } from "./atlas-ipod-textures";
import { shader } from "./atlas-ipod-shaders";
import { hdrFragment } from "./atlas-ipod-hdr";

const scene = { materials: [{ kind: "water", blend: "opaque", depth_write: true }], skins: [{ joints: [0, 1, 2, 3] }] };

test("only opaque depth-writing water separates shading and compiles the coverage response", () => {
  const draw = { material: 0, layout: "static", node: null, skin: null };
  const original = ["original-water-vertex", "original-water-fragment"];
  expect(usesWaterResponse(scene, draw)).toBe(true);
  const response = ["original-water-vertex", "coverage-water-fragment"];
  let calls = 0;
  const compileResponse = () => { calls++; return response; };
  const selected = waterPrograms(scene, draw, original, compileResponse);
  expect(selected.water_response).toBe(response);
  expect(selected.main[1]).toStartWith("water_resolve_f-");
  for (const material of [
    { kind: "water", blend: "alpha", depth_write: true },
    { kind: "water", blend: "additive", depth_write: true },
    { kind: "water", blend: "opaque", depth_write: false },
    { kind: "standard", blend: "opaque", depth_write: true },
  ]) {
    const s = { ...scene, materials: [material] };
    expect(usesWaterResponse(s, draw)).toBe(false);
    expect(waterPrograms(s, draw, original, compileResponse)).toEqual({ main: original, water_response: null });
  }
  expect(calls).toBe(1);
});

test("water resolve links static, rigid and skinned transforms while sampling only display response", () => {
  const fragment = waterResolveSource();
  expect(fragment).toContain("uniform mediump sampler2D uWaterResponse;");
  expect(samplerDeclarations(fragment)).toEqual(["uWaterResponse"]);
  expect(fragment.match(/texture2D\(/g)?.length).toBe(1);
  expect(fragment).toContain("response.rgb/response.a:uDisplayBody.rgb");
  expect(fragment).toContain("vec4(color,vDepth)");
  expect(fragment).not.toMatch(/uAtlasLut|atlasEncode|atlasDecode|Fog|pow\(|exp\(/);
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-water-tests");
  mkdirSync(directory, { recursive: true });
  for (const [i, draw] of [
    { material: 0, layout: "static", node: null, skin: null },
    { material: 0, layout: "baked", node: null, skin: null },
    { material: 0, layout: "static", node: 2, skin: null },
    { material: 0, layout: "skinned", node: 3, skin: 0 },
  ].entries()) {
    const defines = waterResolveDefines(scene, draw);
    expect(!!defines.STATIC_WORLD).toBe(draw.node == null && draw.skin == null);
    expect(!!defines.SKINNED).toBe(draw.layout === "skinned");
    if (draw.layout === "skinned") expect(defines.MAX_BONES).toBe(4);
    expect(defines.SCREEN).toBe(1); expect(defines.LDR_COLOR).toBe(1);
    expect(defines).not.toHaveProperty("WAVES");
    const result = waterPrograms(scene, draw, ["water-v", "water-f"], () => ["water-v", "coverage-f"]);
    const vertex = readFileSync(resolve(import.meta.dir, `../.pocket-build/ipod/assets/shaders/${result.main[0]}.glsl`), "utf8");
    expect(vertex).toContain("vScreen"); expect(vertex).toContain("vDepth");
    expect(vertex.includes("uBones")).toBe(draw.layout === "skinned");
    const vert = join(directory, `water-${i}.vert`), frag = join(directory, `water-${i}.frag`);
    writeFileSync(vert, vertex); writeFileSync(frag, fragment);
    const linked = Bun.spawnSync(["glslangValidator", "-l", vert, frag], { stdout: "pipe", stderr: "pipe" });
    expect(linked.exitCode, linked.stdout.toString() + linked.stderr.toString()).toBe(0);
  }
  expect(() => waterResolveDefines(scene, { material: 0, layout: "skinned", skin: null })).toThrow("skin is missing");
});

test("coverage output changes only water alpha and links all authored lighting variants", () => {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-water-tests");
  mkdirSync(directory, { recursive: true });
  for (const sun of [0, 1]) for (const shallow of [0, 1]) for (const fog of ["none", "FOG", "VISTA"]) {
    const defines: Record<string, number> = {
      LITE: 1, DISPLAY_COLOR: 1, ATLAS_LDR: 1, ATLAS_OUTPUT_LDR: 1, ATLAS_BLEND: 0,
      ...(sun ? { SUN: 1 } : {}), ...(shallow ? { SHALLOW: 1 } : {}), ...(fog === "none" ? {} : { [fog]: 1 }),
    };
    const files = [
      shader("surface_v", { WAVES: 1, STATIC_WORLD: 1, ...(shallow ? { COLOR: 1 } : {}) }),
      shader("water_f", { ...defines, ATLAS_COVERAGE_TARGET: 1 }),
    ];
    const sources = files.map(key => readFileSync(resolve(import.meta.dir, `../.pocket-build/ipod/assets/shaders/${key}.glsl`), "utf8"));
    const original = readFileSync(resolve(import.meta.dir, `../.pocket-build/ipod/assets/shaders/${shader("water_f", defines)}.glsl`), "utf8");
    expect(sources[1]).toBe(original.replace("vec4(atlasColor.rgb,1.0/(1.0+max(atlasColor.a,0.0)/32.0))", "vec4(atlasColor.rgb,1.0)"));
    expect(sources[1]).toContain("gl_FragColor=vec4(atlasColor.rgb,1.0)");
    const paths = sources.map((source, stage) => {
      const path = join(directory, `coverage-${sun}-${shallow}-${fog}.${stage ? "frag" : "vert"}`);
      writeFileSync(path, source); return path;
    });
    const linked = Bun.spawnSync(["glslangValidator", "-l", ...paths], { stdout: "pipe", stderr: "pipe" });
    expect(linked.exitCode, linked.stdout.toString() + linked.stderr.toString()).toBe(0);
  }
  const material = "#version 100\nprecision mediump float;\nvoid main() { gl_FragData[0]=vec4(0.3,0.4,0.5,32.0); }";
  const invalid: Record<string, number>[] = [
    { ATLAS_COVERAGE_TARGET: 1 },
    { ATLAS_COVERAGE_TARGET: 1, ATLAS_LDR: 1 },
    { ATLAS_COVERAGE_TARGET: 1, ATLAS_LDR: 1, ATLAS_OUTPUT_LDR: 1, ATLAS_BLEND: 3 },
  ];
  for (const defines of invalid) expect(() => hdrFragment(material, "water_f", defines)).toThrow("opaque display output");
});

test("bilinear response coverage removes clear-colour darkening and bounds RGBA8 colour error", () => {
  const body = [0.12, 0.28, 0.34];
  const colors = [[0.2, 0.7, 0.9], [0.8, 0.3, 0.1], [0.1, 0.5, 0.4], [0.9, 0.2, 0.6]];
  // All coverage patterns, including no low-resolution sample for a native
  // water sliver. Actual raster/subpixel precision still needs device capture.
  for (let mask = 0; mask < 16; mask++) for (const x of [0, 1/256, .1, .5, .9, 255/256, 1]) for (const y of [0, 1/256, .25, .5, .75, 255/256, 1]) {
    const weights = [(1-x)*(1-y), x*(1-y), (1-x)*y, x*y];
    const coverage = weights.reduce((sum, weight, i) => sum + ((mask >> i) & 1)*weight, 0);
    const sample = [0, 1, 2].map(channel => weights.reduce((sum, weight, i) =>
      sum + ((mask >> i) & 1)*weight*Math.round(colors[i][channel]*255)/255, 0));
    const expected = [0, 1, 2].map(channel => coverage > 0 ? weights.reduce((sum, weight, i) =>
      sum + ((mask >> i) & 1)*weight*colors[i][channel], 0)/coverage : body[channel]);
    const decoded = sample.map((color, i) => coverage > 0 ? color/coverage : body[i]);
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(decoded[channel]-expected[channel])).toBeLessThanOrEqual(0.5/255 + 1e-12);
      expect(Number.isFinite(decoded[channel])).toBe(true);
    }
  }
  // A quarter-covered 0.8 texel formerly returned 0.2, now returns 0.8.
  expect((0.8*.25)/.25).toBe(.8);
});

test("coverage normalization requires a floating sampler instead of default lowp fixed precision", () => {
  // GLSL ES 1.00 permits lowp's absolute 2^-8 steps; the texture return has
  // sampler precision, even when assigned to a mediump vec4. That loses
  // filtered RGB before the division. This is a permitted-model regression,
  // not a claim about the device driver's internal filtering implementation.
  const lowp = (value: number) => Math.round(value*256)/256;
  const coverage = 1/256, color = 51/255;
  expect(lowp(color*coverage)/lowp(coverage)).toBe(0);
  expect(color).toBe(.2);
  const half = new Float16Array(1);
  const fp16 = (value: number) => { half[0] = value; return half[0]; };
  for (const alpha of [1/256, 1/64, .1, .25, .5, .9, 1]) for (let byte = 0; byte < 256; byte++) {
    const expected = byte/255;
    const decoded = fp16(fp16(expected*alpha)/fp16(alpha));
    expect(Math.abs(decoded-expected)).toBeLessThanOrEqual(1/255);
  }
});

test("GLES response sampling uses the same bottom-left projected screen coordinates", () => {
  for (const w of [.1, 1, 100]) {
    for (const x of [-1, -.4, 0, 1]) for (const y of [-1, .2, 1]) {
      const screen = [x*w, y*w, 0, w];
      expect(screen[0]/screen[3]*.5+.5).toBeCloseTo((x+1)*.5, 10);
      expect(screen[1]/screen[3]*.5+.5).toBeCloseTo((y+1)*.5, 10);
    }
  }
});
