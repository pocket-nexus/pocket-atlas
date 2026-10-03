import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { colorPair, performanceMainPair, performanceReflectionPair, windowParameterDraws, windowRayDraws } from "./atlas-ipod-pipelines";
import { samplerDeclarations } from "./atlas-ipod-textures";

test("optimized interior-window mirrors select REFLECTION and the display tier by material kind", () => {
  const draw = { material: 0, layout: "static", node: null, skin: null };
  const calls: unknown[][] = [];
  const compile = (...args: any[]) => { calls.push(args); return ["vertex", "display-reflection"]; };
  for (const kind of ["standard", "glass", "water", "products", "interior_window", "lights"]) {
    const scene = { materials: [{ kind }] };
    const result = performanceReflectionPair(scene, draw, undefined, compile);
    if (kind === "interior_window") {
      expect(result).toEqual(["vertex", "display-reflection"]);
      expect(calls.at(-1)).toEqual([scene, draw, true, 3]);
    } else expect(result).toBeNull();
  }
  expect(calls).toHaveLength(1);
});

test("window parameter selection requires the versioned proof and affects only display main", () => {
  const draw = { material: 0, layout: "static", node: null, skin: null };
  const scene: any = { draws: [draw, draw], materials: [{ kind: "interior_window" }] };
  expect([...windowParameterDraws(scene)]).toEqual([]);
  scene.ipod_recipes = { window_vertex_params: { version: 1, draws: [0, 1] } };
  expect([...windowParameterDraws(scene)]).toEqual([0, 1]);
  const calls: unknown[][] = [];
  const compile = (...args: any[]) => { calls.push(args); return ["v", "f"]; };
  for (const enabled of [false, true]) {
    performanceMainPair(scene, draw, enabled, false, compile);
    expect(calls.at(-1)).toEqual([scene, draw, false, 3, "scene", enabled, false]);
  }
  performanceReflectionPair(scene, draw, undefined, compile);
  expect(calls.at(-1)).toEqual([scene, draw, true, 3]);
  for (const recipe of [{ version: 2, draws: [0] }, { version: 1, draws: [1, 0] },
    { version: 1, draws: [0, 0] }, { version: 1, draws: [2] }, { version: 1, draws: [-1] },
    { version: 1, draws: [0.5] }, { version: 1, draws: null }]) {
    scene.ipod_recipes.window_vertex_params = recipe;
    expect(() => windowParameterDraws(scene)).toThrow();
  }
  scene.ipod_recipes.window_vertex_params = { version: 1, draws: [0] };
  for (const material of [{ kind: "standard" }, { kind: "interior_window", uv_anim: {} },
    { kind: "interior_window", vertex_pbr: true }]) {
    scene.materials[0] = material;
    expect(() => windowParameterDraws(scene)).toThrow("Invalid window vertex parameter draw");
  }
});

test("window ray recipe is an independent static subset and never inferred from seed proof", () => {
  const draw = { material: 0, layout: "static", node: null, skin: null };
  const scene: any = { draws: [draw, draw], materials: [{ kind: "interior_window" }],
    ipod_recipes: { window_vertex_params: { version: 1, draws: [0, 1] } } };
  expect([...windowRayDraws(scene)]).toEqual([]);
  scene.ipod_recipes.window_ray_params = { version: 1, draws: [1] };
  expect([...windowRayDraws(scene)]).toEqual([1]);
  for (const recipe of [{version: 2, draws: [0]}, {version: 1, draws: []}, {version: 1, draws: [1,0]},
    {version: 1, draws: [0,0]}, {version: 1, draws: [2]}, {version: 1, draws: [0.5]}]) {
    scene.ipod_recipes.window_ray_params = recipe;
    expect(() => windowRayDraws(scene)).toThrow();
  }
  scene.ipod_recipes.window_ray_params = {version: 1, draws: [0]};
  for (const unsupported of [{...draw,node:0},{...draw,skin:0},{...draw,layout:"skinned"}]) {
    scene.draws[0]=unsupported;
    expect(() => windowRayDraws(scene)).toThrow("Invalid window ray");
  }
  scene.draws[0]=draw;
  scene.ipod_recipes.window_vertex_params = null;
  expect(() => windowRayDraws(scene)).toThrow("Invalid window ray");
});

test("independent ray flag changes only optimized main and requires both proofs", () => {
  const scene = { materials: [{ kind: "interior_window", blend: "opaque", fog: true }], rain: {active:true}, skins: [] };
  const draw = {material:0,layout:"static",node:null,skin:null};
  const previous = performanceMainPair(scene,draw,true);
  const ray = performanceMainPair(scene,draw,true,true);
  expect(ray[0]).not.toBe(previous[0]); expect(ray[1]).not.toBe(previous[1]);
  const read = (key:string) => readFileSync(resolve(import.meta.dir, `../.pocket-build/ipod/assets/shaders/${key}.glsl`),"utf8");
  expect(read(ray[0])).toContain("vWindowReflect"); expect(read(ray[1])).toContain("vWindowRay");
  expect(read(ray[1])).not.toContain("vNormal");
  expect(samplerDeclarations(read(ray[1]))).toEqual(samplerDeclarations(read(previous[1])));
  expect(read(performanceReflectionPair(scene,draw)![1])).not.toContain("vWindowRay");
  expect(() => performanceMainPair(scene,draw,false,true)).toThrow("static window parameter recipe");
},30_000);

test("proved display main selects the lowered program while absent proof keeps the original", () => {
  const scene = { materials: [{ kind: "interior_window", blend: "opaque", fog: true }],
    rain: { active: true }, skins: [] };
  const draw = { material: 0, layout: "static", node: null, skin: null };
  const original = performanceMainPair(scene, draw, false);
  const lowered = performanceMainPair(scene, draw, true);
  expect(lowered[0]).not.toBe(original[0]);
  expect(lowered[1]).not.toBe(original[1]);
  const read = (key: string) => readFileSync(resolve(import.meta.dir, `../.pocket-build/ipod/assets/shaders/${key}.glsl`), "utf8");
  expect(read(lowered[0])).toContain("vRoomA");
  expect(read(lowered[1])).toContain("vRoomA");
  expect(read(lowered[1])).not.toContain("vColor");
  expect(read(original[1])).toContain("vColor");
  expect(samplerDeclarations(read(lowered[1]))).toEqual(samplerDeclarations(read(original[1])));
}, 30_000);

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

function colorFixture(fog = "none", geometry = "float", alpha = false) {
  return {
    scene: {
      materials: [{ kind: "standard", blend: "opaque", fog: fog !== "none",
        interior: false, alpha_test: alpha ? 0.5 : 0, depth_write: true, albedo: 0, emission: 1 }],
      rain: { active: true }, atmosphere: { haze_ambient: [0, 0, 0] }, skins: [{ joints: [0, 1] }],
      vista_haze: fog === "vista" ? {} : null,
    },
    draw: { material: 0, layout: geometry === "skin" ? "skinned" : "baked",
      node: geometry === "float" ? null : 0, skin: geometry === "skin" ? 0 : null },
    color: { texture: 0, flags: 8, page: geometry === "float" ? 0 : null },
  };
}

const readColorShader = (key: string) => readFileSync(resolve(import.meta.dir,
  `../.pocket-build/ipod/assets/shaders/${key}.glsl`), "utf8");

test("mirror depth omission is restricted to opaque display colours, preserving raw and blend paths", () => {
  const { scene, draw, color } = colorFixture();
  for (const kind of ["standard", "unlit", "products"]) {
    scene.materials[0].kind = kind;
    expect(performanceReflectionPair(scene, draw,
      { ...color, flags: kind === "products" ? 64 : kind === "unlit" ? 0 : 8 })).not.toBeNull();
  }
  for (const kind of ["glass", "water", "tower", "lights"]) {
    scene.materials[0].kind = kind;
    expect(performanceReflectionPair(scene, draw, color)).toBeNull();
  }
  scene.materials[0].kind = "standard";
  expect(performanceReflectionPair(scene, draw)).toBeNull();
  for (const blend of ["alpha", "premultiplied", "additive"]) {
    scene.materials[0].blend = blend;
    expect(performanceReflectionPair(scene, draw, color)).toBeNull();
  }
  scene.materials[0].blend = "opaque";
  for (const flags of [16, 32, 16 | 32])
    expect(performanceReflectionPair(scene, draw, { ...color, flags })).toBeNull();
  scene.rain.active = false;
  expect(performanceReflectionPair(scene, draw, color)).toEqual(colorPair(scene, draw, color));
});

// This is a compiler-output comparison, not a rewritten RGB reference model:
// after deleting the unused depth input and setting only output alpha to zero,
// the fragment program must be identical (temporary IDs are compiler assigned).
function withoutDepth(source: string) {
  const names = new Map<string, string>();
  return source.replace(/^varying\s+(?:(?:lowp|mediump|highp)\s+)?float\s+vDepth;\n/gm, "")
    .replace(/\bvDepth\b/g, "0.0")
    .replace(/\b_\d+\b/g, name => {
      if (!names.has(name)) names.set(name, `_temp${names.size}`);
      return names.get(name)!;
    });
}

test("mirror colour pairs remove only depth while keeping fog, coverage, texture and all vertex transforms", () => {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-mirror-depth");
  mkdirSync(directory, { recursive: true });
  for (const fog of ["none", "fog", "vista"])
    for (const geometry of ["float", "model", "skin"])
      for (const alpha of [false, true]) {
        const { scene, draw, color } = colorFixture(fog, geometry, alpha);
        const main = colorPair(scene, draw, color).map(readColorShader);
        const mirror = performanceReflectionPair(scene, draw, color)!.map(readColorShader);
        expect(main[0]).toContain("vDepth"); expect(main[1]).toContain("vDepth");
        expect(mirror.join("\n")).not.toContain("vDepth");
        expect(mirror[0]).not.toMatch(/\blength\s*\(/);
        expect(withoutDepth(main[1])).toBe(withoutDepth(mirror[1]));
        expect(samplerDeclarations(mirror[1])).toEqual(["uAlbedo", "uEmission"]);
        expect(mirror[1].includes("discard")).toBe(alpha);
        expect(/\buDisplayFog\./.test(mirror[1])).toBe(fog === "fog");
        expect(/\buDisplayHaze\./.test(mirror[1])).toBe(fog === "vista");
        expect(mirror[0].includes("uEye")).toBe(fog === "fog");
        for (const uniform of ["uViewProj", geometry === "float" ? "uWorldScale" : "uModel"])
          expect(mirror[0]).toContain(uniform);
        if (geometry === "skin") {
          for (const attribute of ["aJoints", "aWeights", "uBones"])
            expect(mirror[0]).toContain(attribute);
        }
        const files = mirror.map((source, stage) => {
          const path = join(directory, `${fog}-${geometry}-${+alpha}.${stage ? "frag" : "vert"}`);
          writeFileSync(path, source); return path;
        });
        const linked = Bun.spawnSync(["glslangValidator", "-l", ...files], { stdout: "pipe", stderr: "pipe" });
        expect(linked.exitCode, linked.stdout.toString() + linked.stderr.toString()).toBe(0);
      }
}, 30_000);

test("untextured mirrors and scene-wide haze triggers keep the main depth contract", () => {
  const { scene, draw } = colorFixture();
  const color = { texture: null, flags: 0, page: 0 };
  for (const cause of ["rain", "lights", "ambient"]) {
    const input = { ...scene, rain: { active: cause === "rain" },
      fog_lights: cause === "lights" ? [{}] : [],
      atmosphere: { haze_ambient: cause === "ambient" ? [0.1, 0, 0] : [0, 0, 0] } };
    const main = colorPair(input, draw, color).map(readColorShader);
    const mirror = performanceReflectionPair(input, draw, color)!.map(readColorShader);
    expect(main[0]).toContain("vDepth");
    expect(mirror.join("\n")).not.toContain("vDepth");
    expect(samplerDeclarations(mirror[1])).toEqual([]);
    expect(withoutDepth(main[1])).toBe(withoutDepth(mirror[1]));
  }
});
