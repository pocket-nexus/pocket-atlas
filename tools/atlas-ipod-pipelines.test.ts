import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performanceReflectionPair } from "./atlas-ipod-pipelines";
import { samplerDeclarations } from "./atlas-ipod-textures";

test("optimized interior-window mirrors select REFLECTION and the display tier by material kind", () => {
  const draw = { material: 0, layout: "static", node: null, skin: null };
  const calls: unknown[][] = [];
  const compile = (...args: any[]) => { calls.push(args); return ["vertex", "display-reflection"]; };
  for (const kind of ["standard", "glass", "water", "products", "interior_window", "lights"]) {
    const scene = { materials: [{ kind }] };
    const result = performanceReflectionPair(scene, draw, compile);
    if (kind === "interior_window") {
      expect(result).toEqual(["vertex", "display-reflection"]);
      expect(calls.at(-1)).toEqual([scene, draw, true, 3]);
    } else expect(result).toBeNull();
  }
  expect(calls).toHaveLength(1);
});

test("display window reflection links both fog modes and excludes the full room tracer", () => {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-window-reflection-tests");
  mkdirSync(directory, { recursive: true });
  for (const vista of [false, true]) {
    const scene = {
      materials: [{ kind: "interior_window", blend: "opaque", vertex_color: false, alpha_test: 0,
        interior: false, fog: true, clearcoat: 0, drops: 0 }],
      skins: [], rain: { active: true }, vista_haze: vista ? {} : null,
    };
    const draw = { material: 0, layout: "static", node: null, skin: null };
    const pair = performanceReflectionPair(scene, draw)!;
    const source = pair.map(key => readFileSync(resolve(import.meta.dir, `../.pocket-build/ipod/assets/shaders/${key}.glsl`), "utf8"));
    expect(samplerDeclarations(source[1])).toEqual(["uAtlasLut", "uEnv"]);
    expect(source[1]).not.toMatch(/\bsin\s*\(|\bfract\s*\(|uPuddles|gl_LastFragData/);
    expect(source[1]).toContain("atlasDisplay(atlasColor.rgb)");
    expect(source[1]).toContain("uEmissive");
    expect(source[1]).toContain("uEnvK");
    expect(source[1].includes("vHaze")).toBe(vista);
    expect(/\buFog\./.test(source[1])).toBe(!vista);
    const files = source.map((text, stage) => {
      const path = join(directory, `${+vista}.${stage ? "frag" : "vert"}`);
      writeFileSync(path, text); return path;
    });
    const linked = Bun.spawnSync(["glslangValidator", "-l", ...files], { stdout: "pipe", stderr: "pipe" });
    expect(linked.exitCode, linked.stdout.toString() + linked.stderr.toString()).toBe(0);
  }
});
