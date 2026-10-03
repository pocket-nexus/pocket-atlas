import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shader } from "./atlas-ipod-shaders";
import { windowParameterFragment, windowParameterVertex } from "./atlas-ipod-window";
import { samplerDeclarations } from "./atlas-ipod-textures";

const root = resolve(import.meta.dir, "..");
const shaders = join(root, ".pocket-build/ipod/assets/shaders");
const output = join(root, ".pocket-build/validation/ipod/window-parameters");
const read = (name: string) => readFileSync(join(root, `vita/shaders/${name}.cg`), "utf8");

test("window lowering moves seed/time constants while retaining spatial room, TV and curtain equations", () => {
  const original = read("window_f"), lowered = windowParameterFragment(original);
  expect(lowered).not.toMatch(/hash(?:12|32)\(seed|floor\(vUv\)|vColor/);
  for (const code of [
    "float2 local = frac(vUv);", "float3 d = normalize(float3(dot(V, t), dot(V, b), -dot(V, n)));",
    "float tt = min(min(tw.x, tw.y), tw.z);", "roomLight(h, room, vRoomC.rgb)",
    "float3 dd = h - float3(room.x * 0.5, 0.7, room.z - 0.2);",
    "float3(0.35, 0.55, 1.0) * f * 0.9 / (1.0 + dot(dd, dd) * 1.2)",
    "sin(local.x * 60.0)", "frac(local.y * H * 12.0)",
    "tex2D(uPuddles, local * float2(20.0, 10.0)).g", "octUv(reflect(V, N))", "fogFactor(dist, uFog.w)",
  ]) expect(lowered).toContain(code);
  const vertex = windowParameterVertex(read("surface_v"), readFileSync(join(root, "vita/shaders/common.cgh"), "utf8"));
  expect(vertex).toContain("float2 windowSeed = floor(oUv);");
  expect(vertex).toContain("float2 windowSize = aColor.rg;");
  expect(vertex.match(/hash12\(windowSeed/g)).toHaveLength(7);
  expect(vertex.match(/hash32\(windowSeed/g)).toHaveLength(1);
  expect(vertex).toContain("|| defined(SGX_WINDOW_PARAMS)\n    uniform float4 uEye,");
  expect(vertex).toContain("sin(uEye.w * 7.0 + windowHash.x * 40.0)");
  expect(vertex).toContain("sin(uEye.w * 3.1 + windowHash.z * 11.0)");
  expect(lowered).toContain("floor(vRoomA.w + 0.5)");
  expect(lowered).not.toMatch(/\bh3\b|\bh4\b|\bbright\b|uEye\.w|hash(?:12|32)\(/);
  expect(lowered.match(/\bsin\(/g)).toHaveLength(1);
  expect(() => windowParameterFragment(original.replace("half4 vColor", "float4 vColor"))).toThrow("Window parameter contract changed");
});

test("window parameter variants fit eight varying vectors and preserve samplers, TV and parallax", () => {
  mkdirSync(output, { recursive: true });
  const metrics: unknown[] = [];
  for (const fog of ["none", "FOG", "VISTA"]) for (const skin of [false, true]) {
    const v = { COLOR: 1, TANGENT: 1, ...(fog === "VISTA" ? { VISTA: 1 } : {}),
      ...(skin ? { SKINNED: 1, MAX_BONES: 4, SKIP_ZERO_WEIGHTS: 1 } : { STATIC_WORLD: 1 }) };
    const f = { ATLAS_LDR: 1, ATLAS_BLEND: 0, ...(fog === "none" ? {} : { [fog]: 1 }) };
    const original = readFileSync(join(shaders, `${shader("window_f", f)}.glsl`), "utf8");
    const pair = [shader("surface_v", { ...v, SGX_WINDOW_PARAMS: 1 }), shader("window_f", { ...f, SGX_WINDOW_PARAMS: 1 })];
    const sources = pair.map(name => readFileSync(join(shaders, `${name}.glsl`), "utf8"));
    const varyings = [...sources[1].matchAll(/^varying (?:highp |mediump |lowp )?vec([234]) (\w+);/gm)];
    expect(varyings.length).toBe(fog === "VISTA" ? 8 : 7);
    expect(varyings.reduce((sum, m) => sum + +m[1], 0)).toBeLessThanOrEqual(32);
    expect(samplerDeclarations(sources[1])).toEqual(samplerDeclarations(original));
    expect(sources[1].match(/\bsin\(/g)).toHaveLength(1);
    expect(sources[0].match(/\bsin\(/g)).toHaveLength(2);
    // Vertex-stage default float precision is highp in GLSL ES 1.00.
    expect(sources[0]).toMatch(/uniform (?:highp )?vec4 uEye;/);
    expect(sources[0]).not.toMatch(/mediump vec2 \w+ = aColor\.xy \*/);
    expect(sources[1]).not.toContain("uEye.w");
    expect(sources[1]).toContain("uEye");
    expect(sources[1]).toContain("atlasDisplay(atlasColor.rgb)");
    expect(sources[1]).not.toContain("33.33000"); // Shared hash polynomial is absent from FS.
    expect(sources[0]).toContain("33.33000");
    expect(sources[1]).not.toMatch(/varying\s+(?:highp\s+)?vec4 vColor;/);
    const paths = sources.map((source, stage) => {
      const path = join(output, `${fog}-${+skin}.${stage ? "frag" : "vert"}`);
      writeFileSync(path, source); return path;
    });
    const linked = Bun.spawnSync(["glslangValidator", "-l", ...paths], { stdout: "pipe", stderr: "pipe" });
    expect(linked.exitCode, linked.stdout.toString()+linked.stderr.toString()).toBe(0);
    metrics.push({ fog, skin, originalBytes: original.length, fragmentBytes: sources[1].length, varyings: varyings.length, pair });
  }
  expect(() => shader("window_f", { SGX_WINDOW_PARAMS: 1, REFLECTION: 1 })).toThrow("main interior-window pair");
  expect(() => shader("surface_v", { SGX_WINDOW_PARAMS: 1 })).toThrow("COLOR and TANGENT");
  writeFileSync(join(output, "shaders.json"), JSON.stringify(metrics, null, 2));
}, 30_000);

test("integer room flags retain threshold decisions under interpolation rounding", () => {
  const f32 = Math.fround;
  const flags = (x: number, y: number, z: number, lamp: number, style: number, cloth: number, furniture: number) =>
    (x < .62 ? 1 : y < .35 ? 2 : 0) + (lamp < .68 ? 4 : 0)
    + (z < .4 ? 0 : z < .7 ? 8 : 16) + (style < .35 ? 0 : style < .55 ? 32 : style < .75 ? 64 : 96)
    + (cloth >= .7 ? 128 : 0) + (furniture > .5 ? 256 : 0);
  // Test values immediately below/at/above every source decision boundary.
  for (const edge of [.35, .4, .5, .55, .62, .68, .7, .75]) for (const delta of [-1e-7, 0, 1e-7]) {
    for (const x of [0, edge+delta, 1]) for (const y of [0, edge+delta, 1]) {
      const z=edge+delta, lamp=z, style=z, cloth=z, furniture=z;
      const value=flags(x,y,z,lamp,style,cloth,furniture);
      for (const noise of [-.125, 0, .125]) {
        const decoded=Math.floor(f32(value+noise)+.5);
        expect(decoded%4).toBe(x < .62 ? 1 : y < .35 ? 2 : 0);
        expect(Math.floor(decoded/4)%2).toBe(+(lamp < .68));
        expect(Math.floor(decoded/8)%4).toBe(z < .4 ? 0 : z < .7 ? 1 : 2);
        expect(Math.floor(decoded/32)%4).toBe(style < .35 ? 0 : style < .55 ? 1 : style < .75 ? 2 : 3);
        expect(Math.floor(decoded/128)%2).toBe(+(cloth >= .7));
        expect(decoded >= 256).toBe(furniture > .5);
      }
    }
  }
});

test("constant pane parameters survive a float32 perspective interpolation model", () => {
  // All three vertices have the same proved seed and pane RG. This bounds
  // the extra interpolation in a float32 arithmetic model, not SGX driver
  // arithmetic or whole-image colour at curtain/furniture discontinuities.
  const f = Math.fround;
  let maxScalarError = 0, maxFlagError = 0;
  const interpolate = (value: number, weights: number[], inverseW: number[]) => {
    const q = weights.map((w, i) => f(f(w) * f(inverseW[i])));
    const numerator = f(f(f(value * q[0]) + f(value * q[1])) + f(value * q[2]));
    const denominator = f(f(q[0] + q[1]) + q[2]);
    return f(numerator / denominator);
  };
  for (const depths of [[1, 1, 1], [1e-4, 1, 1e4], [37, .013, 700]]) {
    for (let x = 0; x <= 16; x++) for (let y = 0; y <= 16-x; y++) {
      const weights = [x/16, y/16, (16-x-y)/16];
      for (let i = 0; i <= 255; i++) {
        const value = f(i/255);
        maxScalarError = Math.max(maxScalarError, Math.abs(interpolate(value, weights, depths) - value));
      }
      for (let flags = 0; flags < 512; flags++) {
        const value = interpolate(flags, weights, depths);
        maxFlagError = Math.max(maxFlagError, Math.abs(value-flags));
        expect(Math.floor(value+.5)).toBe(flags);
      }
    }
  }
  expect(maxScalarError).toBeLessThanOrEqual(2 ** -22);
  expect(maxFlagError).toBeLessThanOrEqual(2 ** -14);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "interpolation.json"), JSON.stringify({
    maxScalarError, maxFlagError,
    scope: "float32 constant-varying perspective interpolation; device capture comparison still required",
  }, null, 2));
});

test("room constants and animated TV retain the reference equations across seeds, time and perspective", () => {
  // An independent float32 model of the shared source equations. It measures
  // the added constant-varying interpolation, not vertex-vs-fragment driver
  // sin accuracy or image error at discontinuous ray/curtain boundaries.
  const f = Math.fround;
  const add = (a: number, b: number) => f(f(a) + f(b));
  const mul = (a: number, b: number) => f(f(a) * f(b));
  const frac = (a: number) => f(a - Math.floor(a));
  const dot = (a: number[], b: number[]) => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));
  function hash(seed: number[], vector: boolean): number[] {
    let p = [seed[0], seed[1], seed[0]].map((x, i) => frac(mul(x, vector ? [.1031, .1030, .0973][i] : .1031)));
    const q = (vector ? [p[1], p[0], p[2]] : [p[1], p[2], p[0]]).map(x => add(x, 33.33));
    const d = dot(p, q); p = p.map(x => add(x, d));
    return vector ? [frac(mul(add(p[0], p[1]), p[2])), frac(mul(add(p[0], p[2]), p[1])), frac(mul(add(p[1], p[2]), p[0]))]
      : [frac(mul(add(p[0], p[1]), p[2]))];
  }
  const interpolate = (value: number, weights: number[], inverseW: number[]) => {
    const q = weights.map((w, i) => mul(w, inverseW[i]));
    return f(dot([value, value, value], q) / add(add(q[0], q[1]), q[2]));
  };
  const times = [0, 1/60, 1, 12.345, 25, 60, 7200, 1e6, ...Array.from({ length: 31 }, (_, i) => 24.5+i/30)];
  const perspectives = [
    { bary: [1, 0, 0], w: [1, 1, 1] },
    { bary: [.125, .375, .5], w: [1, 1, 1] },
    { bary: [.03125, .3125, .65625], w: [1e-4, 1, 1e4] },
    { bary: [.5, .4375, .0625], w: [37, .013, 700] },
  ];
  let maxParameterError = 0, maxLightingError = 0, maxGlowError = 0, maxFlagError = 0, cases = 0, tvRooms = 0;
  let maxFlickerError = 0, minFlicker = Infinity, maxFlicker = -Infinity;
  for (let i = 0; i < 256; i++) {
    const seed = [i * 13 % 1000 - 80, i * 37 % 1000 - 32];
    const h3 = hash(seed.map(x => add(mul(x, 1.37), .5)), true);
    const h = (offset: number) => hash(seed.map(x => add(x, offset)), false)[0];
    const lit = h3[0] < f(.62), tv = !lit && h3[1] < f(.35);
    if (tv) tvRooms++;
    const lamp = h(17.1) < f(.68) ? [1, .72, .45] : [.82, .9, 1];
    const bright = add(.55, mul(h3[1], .9));
    const style = h(5.5), furniture = h(9), cloth = h(8);
    const flags = (lit ? 1 : tv ? 2 : 0) + (h(17.1) < f(.68) ? 4 : 0)
      + (h3[2] < f(.4) ? 0 : h3[2] < f(.7) ? 8 : 16)
      + (style < f(.35) ? 0 : style < f(.55) ? 32 : style < f(.75) ? 64 : 96)
      + (cloth >= f(.7) ? 128 : 0) + (furniture > .5 ? 256 : 0);
    const W = Math.max(mul(f(i / 255), 16), f(.3));
    const H = Math.max(mul(f((i * 37 % 256) / 255), 16), f(.3));
    const depth = add(3.2, mul(h3[2], 2.5));
    const originalRoom = [add(W, 1.4), f(2.6), depth];
    for (const time of times) {
      const flicker = add(.6, mul(mul(.4, f(Math.sin(add(mul(time, 7), mul(h3[0], 40))))),
        f(Math.sin(add(mul(time, 3.1), mul(h3[2], 11))))));
      minFlicker = Math.min(minFlicker, flicker); maxFlicker = Math.max(maxFlicker, flicker);
      const packed = [W, H, depth, flags, h(3), furniture, add(.25, mul(.35, h(2))),
        add(add(.4, mul(.6, h(4))), .001), ...lamp.map(c => mul(c, bright)), flicker];
      for (const { bary, w } of perspectives) {
        const v = packed.map(x => interpolate(x, bary, w));
        maxFlagError = Math.max(maxFlagError, Math.abs(v[3] - flags));
        expect(Math.floor(v[3] + .5)).toBe(flags);
        for (let k = 0; k < 12; k++) if (k !== 3) maxParameterError = Math.max(maxParameterError, Math.abs(v[k] - packed[k]));
        maxFlickerError = Math.max(maxFlickerError, Math.abs(v[11] - flicker));
        // Spatial attenuation is still evaluated per fragment. Include the
        // interpolated room dimensions in the moved-constant candidate.
        const room = [add(v[0], 1.4), f(2.6), v[2]];
        const hit = [mul(originalRoom[0], .23), f(.71), mul(originalRoom[2], .93)];
        const factor = (r: number[], television: boolean) => {
          const p = television ? [mul(r[0], .5), f(.7), add(r[2], -.2)] : [mul(r[0], .5), add(r[1], -.25), mul(r[2], .55)];
          const d = hit.map((x, k) => add(x, -p[k]));
          return television ? add(1, mul(dot(d, d), 1.2)) : add(.25, f(1.6 / add(1, mul(dot(d, d), .45))));
        };
        for (let c = 0; c < 3; c++) {
          let original = lit ? mul(mul(lamp[c], bright), factor(originalRoom, false)) : f([.015, .016, .02][c]);
          let lowered = lit ? mul(v[8+c], factor(room, false)) : f([.015, .016, .02][c]);
          if (tv) {
            original = add(original, f(mul(mul([.35, .55, 1][c], flicker), .9) / factor(originalRoom, true)));
            lowered = add(lowered, f(mul(mul([.35, .55, 1][c], v[11]), .9) / factor(room, true)));
          }
          maxLightingError = Math.max(maxLightingError, Math.abs(original-lowered));
          maxGlowError = Math.max(maxGlowError, Math.abs(mul(mul(lamp[c], bright), .9)-mul(v[8+c], .9)));
        }
        cases++;
      }
    }
  }
  expect(tvRooms).toBeGreaterThan(0);
  expect(minFlicker).toBeGreaterThanOrEqual(.19999);
  expect(maxFlicker).toBeLessThanOrEqual(1.00001);
  expect(maxParameterError).toBeLessThanOrEqual(2 ** -18);
  expect(maxFlickerError).toBeLessThanOrEqual(2 ** -22);
  expect(maxLightingError).toBeLessThanOrEqual(2 ** -18);
  expect(maxGlowError).toBeLessThanOrEqual(2 ** -21);
  expect(maxFlagError).toBeLessThanOrEqual(2 ** -14);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "time-constants.json"), JSON.stringify({
    cases, seeds: 256, times, tvRooms, maxParameterError, maxFlickerError, maxLightingError, maxGlowError, maxFlagError,
    scope: "shared-equation float32 model; not a device sin/whole-image error guarantee; ray and curtain threshold comparisons can differ near boundaries",
  }, null, 2));
});
