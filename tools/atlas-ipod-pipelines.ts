import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeShadowPipelines } from "./atlas-ipod-shadow";
import { writeEffects } from "./atlas-ipod-effects";
import { ldrPostShader } from "./atlas-ipod-post";
import { globeGradeShader } from "./atlas-ipod-globe";
import { waterPrograms } from "./atlas-ipod-water";
import { textureUsage } from "./atlas-ipod-textures";
import { shader } from "./atlas-ipod-shaders";
import { readIPodMetadata } from "./atlas-ipod-pack";
import { PLACES } from "../web/src/places/registry";
import { selectIPodPlaces } from "./atlas-ipod-catalog";
const root = resolve(import.meta.dir, "..");
function meta(place: string) {
  return readIPodMetadata(join(root, `.pocket-build/ipod/assets/${place}.place`));
}
const fragments: Record<string, string> = {
  standard: "standard_f",
  unlit: "unlit_f",
  glass: "glass_f",
  interior_window: "window_f",
  products: "products_f",
  tower: "tower_f",
  skyline: "skyline_f",
  water: "water_f",
  lights: "lights_f",
};
function pair(scene: any, d: any, mirror: boolean, output: "scene" | "coverage" = "scene", windowVertexParams = false, windowRayParams = false) {
  const m = scene.materials[d.material];
  const f: Record<string, number> = {
    LIGHTS: ["standard", "glass"].includes(m.kind) ? 2 : 0,
  };
  const v: Record<string, number> = {};
  if (windowVertexParams) {
    if (m.kind !== "interior_window" || mirror || output !== "scene")
      throw new Error("Window vertex parameters require the display main window pair");
    v.SGX_WINDOW_PARAMS = f.SGX_WINDOW_PARAMS = 1;
  }
  if (windowRayParams) {
    if (!windowVertexParams || d.node != null || d.skin != null || d.layout === "skinned")
      throw new Error("Window rays require the static window parameter recipe");
    v.SGX_WINDOW_RAY_PARAMS = f.SGX_WINDOW_RAY_PARAMS = 1;
  }
  if (output === "coverage") {
    if (m.kind !== "water" || mirror || m.blend !== "opaque" || !m.depth_write)
      throw new Error("Coverage response requires opaque display water");
    f.ATLAS_COVERAGE_TARGET = 1;
  }
  f.ATLAS_BLEND =
    m.kind === "glass"
      ? 3
      : ["tower", "lights"].includes(m.kind)
        ? 2
        : (
            { opaque: 0, alpha: 1, additive: 2, premultiplied: 3 } as Record<
              string,
              number
            >
          )[m.blend];
  if (["standard", "glass"].includes(m.kind)) {
    f.FAR = 1;
    if (d.layout === "baked" && !m.wet) f.LIGHTS = 0;
  }
  if (d.layout === "baked" && f.LIGHTS > 0) f.LIGHTS = 1;
  for (const [on, name] of [
    [d.layout === "baked", "BAKED"],
    [m.albedo != null, "ALBEDO_MAP"],
    [m.vertex_color, "VERTEX_COLOR"],
    [m.alpha_test > 0, "ALPHA_TEST"],
    [m.blend === "alpha", "BLEND"],
    [mirror, "REFLECTION"],
    [m.interior, "INTERIOR"],
  ] as const)
    if (on) f[name] = 1;
  if (m.kind === "products") {
    v.PRODUCTS = 1;
    f.PRODUCTS = 1;
  }
  if (d.layout === "baked") v.BAKED = 1;
  if (m.kind === "standard" && !m.interior && d.layout !== "baked" && d.layout !== "lights") {
    v.VERTEX_LIGHTS = 2;
    f.VERTEX_LIGHTS = 1;
    f.LIGHTS = 0;
  }
  if (m.interior) f.LIGHTS = 0;
  if (d.layout === "skinned") {
    v.SKINNED = 1;
    v.MAX_BONES = Math.max(scene.skins[d.skin].joints.length, 1);
  }
  if (m.fog && !m.interior) {
    if (scene.vista_haze) {
      v.VISTA = 1;
      f.VISTA = 1;
    } else f.FOG = 1;
  }
  if (m.kind === "standard") {
    for (const [on, name] of [
      [m.normal != null, "NORMAL_MAP"],
      [m.orm != null, "ORM_MAP"],
      [m.emission != null, "EMISSION_MAP"],
      [m.emission_shade != null, "EMISSION_SHADE"],
      [!!m.wet, "WET"],
      [m.wet?.planar, "PLANAR"],
      [!!m.damp, "DAMP"],
      [m.clearcoat > 0, "CLEARCOAT"],
      [!!scene.sun && !m.interior, "SUN"],
      [
        !!scene.sun && !m.interior && (m.roughness < 0.6 || m.metalness > 0.3),
        "SUN_SPEC",
      ],
    ] as const)
      if (on) f[name] = 1;
    if (m.wet?.planar && !mirror) v.SCREEN = 1;
  }
  if (
    m.vertex_color ||
    ["unlit", "products", "interior_window", "skyline"].includes(m.kind)
  )
    v.COLOR = 1;
  if (["interior_window", "skyline"].includes(m.kind)) v.TANGENT = 1;
  if (m.kind === "water") {
    v.WAVES = 1;
    if (scene.sun) f.SUN = 1;
    if (m.water?.shallow && m.vertex_color) f.SHALLOW = 1;
  }
  if (m.kind === "products" && d.layout === "static") v.PRODUCTS_CACHED = 1;
  if (d.layout === "skinned") v.SKIP_ZERO_WEIGHTS = 1;
  f.ATLAS_LDR = 1;
  if (d.node == null && d.skin == null) v.STATIC_WORLD = 1;
  if (m.kind === "glass") {
    f.LIGHTS = 0;
    f.LITE = 1;
  }
  if (m.kind === "water") {
    f.LITE = 1;
    f.DISPLAY_COLOR = 1;
    f.ATLAS_OUTPUT_LDR = 1;
    delete v.VISTA;
  }
  if (v.VERTEX_LIGHTS) {
    v.OBJECT_LIGHTS = v.VERTEX_LIGHTS;
    delete v.VERTEX_LIGHTS;
  }
  // Keep baked diffuse, material color, emission and wet reflections. The
  // throughput profile uses the shared far/lite equations at all distances.
  if (m.kind === "standard") {
    f[m.wet ? "LITE" : "FAR"] = 1;
    if (d.layout === "baked") f.LIGHTS = 0;
    if (m.fog && !m.interior && !scene.vista_haze) {
      v.VERTEX_FOG = 1;
      f.VERTEX_FOG = 1;
    }
    if (!scene.rain.active && !scene.fog_lights?.length && !scene.atmosphere.haze_ambient?.some((x: number) => x > 0))
      f.DEPTH_UNUSED = 1;
  }
  return [
    shader(m.kind === "lights" ? "lights_v" : "surface_v", v),
    shader(fragments[m.kind], f),
  ];
}
type DisplayColor = { texture: number | null; flags: number; page?: number | null };
type ColorPass = "main" | "wet-response" | "reflection";

export function colorPair(scene: any, d: any, color: DisplayColor, pass: ColorPass = "main") {
  const m = scene.materials[d.material];
  const wetResponse = pass === "wet-response";
  const v: Record<string, number> = { COLOR: 1, DISPLAY_COLOR: 1 };
  const f: Record<string, number> = {};
  // Mirror/downsample/wet consumers read RGB only. Keep the main target's
  // haze/rain depth, but do not calculate or interpolate it for mirror colour.
  const depth = pass !== "reflection" && (scene.rain.active || scene.fog_lights?.length || scene.atmosphere.haze_ambient?.some((x: number) => x > 0));
  if (color.page != null) v.FLOAT_VERTEX = 1;
  if (depth) v.LDR_COLOR = 1;
  else f.DEPTH_UNUSED = 1;
  if (d.node == null && d.skin == null) v.STATIC_WORLD = 1;
  if (d.layout === "skinned") {
    v.SKINNED = 1;
    v.SKIP_ZERO_WEIGHTS = 1;
    v.MAX_BONES = Math.max(scene.skins[d.skin].joints.length, 1);
  }
  if (color.texture != null) f.ALBEDO_MAP = 1;
  if (color.flags & 8) f.EMISSION_MAP = 1;
  if (color.flags & 16) {
    f.WET = 1; v.SCREEN = 1;
    if (wetResponse) { v.SGX_WET = 1; f.SGX_WET_RESPONSE = 1; }
    else f.SGX_WET_RESOLVE = 1;
  }
  if (color.flags & 32) {
    v.DISPLAY_NORMAL = 1;
    if (!scene.rain.active || Math.max(m.clearcoat, m.drops) <= 0) f.NO_DROPS = 1;
    f.DISPLAY_COLOR = 1; f.LITE = 1; f.LIGHTS = 0;
    f.ATLAS_LDR = 1; f.ATLAS_OUTPUT_LDR = 1; f.ATLAS_BLEND = 3;
  }
  if (m.alpha_test > 0) f.ALPHA_TEST = 1;
  if (m.blend !== "opaque") f.BLEND = 1;
  if (m.blend === "additive") f.ADDITIVE = 1;
  if (m.blend === "premultiplied") f.PREMULTIPLIED = 1;
  if (m.fog && !m.interior) {
    if (scene.vista_haze) f.VISTA = 1;
    else { if (!(color.flags & 32)) v.VERTEX_FOG = 1; f.FOG = 1; }
  }
  if (wetResponse) {
    // The response is display RGB plus a diffuse multiplier, not eye depth.
    // Fog and native texture detail are applied once, by the main resolve.
    delete v.LDR_COLOR; delete v.VERTEX_FOG;
    delete f.FOG; delete f.VISTA; delete f.EMISSION_MAP;
    delete f.DEPTH_UNUSED;
  }
  return [shader("surface_v", v), shader(color.flags & 32 ? "glass_f" : "color_f", f)];
}

/** Opaque prelit mirrors need colour and coverage, not encoded eye depth.
 * Alpha-tested coverage still runs. Wet/glass have separate response/blend
 * contracts, and transparent RGB blending needs its original source alpha.
 * Raw interior windows retain their authored cheap display-domain mirror. */
export function reflectionPair(scene: any, draw: any, color?: DisplayColor, compile = pair): string[] | null {
  const material = scene.materials[draw.material];
  if (color && material.blend === "opaque" && !(color.flags & (16 | 32)) &&
      ["standard", "unlit", "products"].includes(material.kind))
    return colorPair(scene, draw, color, "reflection");
  return material.kind === "interior_window" ? compile(scene, draw, true) : null;
}

/** The compiler and runtime both prove all full/LOD triangles. This reader
 * only enforces the versioned recipe's table shape; it never infers eligibility
 * from a material name or substitutes a missing proof. */
export function windowParameterDraws(scene: any): Set<number> {
  const recipe = scene.ipod_recipes?.window_vertex_params;
  if (recipe == null) return new Set();
  if (recipe.version !== 1 || !Array.isArray(recipe.draws))
    throw new Error("Unsupported window vertex parameter recipe");
  let previous = -1;
  for (const index of recipe.draws) {
    const draw = scene.draws[index], material = draw && scene.materials[draw.material];
    if (!Number.isInteger(index) || index <= previous || !material ||
        material.kind !== "interior_window" || material.uv_anim != null || material.vertex_pbr || draw.layout === "lights")
      throw new Error("Invalid window vertex parameter draw");
    previous = index;
  }
  return new Set(recipe.draws);
}

/** Shape/identity validation only: shared Rust proves the source frames. */
export function windowRayDraws(scene: any): Set<number> {
  const recipe = scene.ipod_recipes?.window_ray_params;
  if (recipe == null) return new Set();
  if (recipe.version !== 1 || !Array.isArray(recipe.draws) || !recipe.draws.length)
    throw new Error("Unsupported window ray parameter recipe");
  const parameters = windowParameterDraws(scene);
  let previous = -1;
  for (const index of recipe.draws) {
    const draw = scene.draws[index];
    if (!Number.isInteger(index) || index <= previous || !parameters.has(index) ||
        draw.node != null || draw.skin != null || draw.layout === "skinned" || draw.layout === "lights")
      throw new Error("Invalid window ray parameter draw");
    previous = index;
  }
  return new Set(recipe.draws);
}

export function mainPair(scene: any, draw: any, enabled: boolean, rays = false, compile = pair): string[] {
  return compile(scene, draw, false, "scene", enabled, rays);
}

if (import.meta.main) {
for (const place of selectIPodPlaces(PLACES)) {
  const m = meta(place.id);
  const windowParameters = windowParameterDraws(m);
  const windowRays = windowRayDraws(m);
  const colorPath = join(root, `.pocket-build/ipod/assets/${place.id}.ipod-color.json`);
  const colors = new Map<number, DisplayColor>();
  if (existsSync(colorPath)) {
    const color = JSON.parse(readFileSync(colorPath, "utf8"));
    if (color.version !== 2 && color.version !== 3) throw new Error(`Unsupported display color version: ${place.id}`);
    for (const draw of color.draws) colors.set(draw.draw, draw);
  }
  for (const index of windowParameters)
    if (colors.has(index)) throw new Error("Window vertex parameters cannot replace display-color vertices");
  writeShadowPipelines(place.id, m);
  const pairs = m.draws.map((d: any, i: number) =>
    d.layout === "lights"
      ? null
      : {
          display_color: colors.has(i),
          display_float: colors.get(i)?.page != null,
          display_texture: colors.get(i)?.texture ?? null,
          display_flags: colors.get(i)?.flags ?? 0,
          window_vertex_params: windowParameters.has(i),
          window_ray_params: windowRays.has(i),
          ...waterPrograms(m, d, colors.has(i) ? colorPair(m, d, colors.get(i)!) : mainPair(m, d, windowParameters.has(i), windowRays.has(i)),
            () => pair(m, d, false, "coverage")),
          reflection: reflectionPair(m, d, colors.get(i)),
          wet_response: (colors.get(i)?.flags ?? 0) & 16 ? colorPair(m, d, colors.get(i)!, "wet-response") : null,
        },
  );
  const fixed = {
    sky: [
      shader("sky_v"),
      shader(m.day_sky ? "sky_day_f" : "sky_f",
        { ATLAS_LDR: 1, ...(m.day_sky?.twilight ? { TWILIGHT: 1 } : {}) }),
    ],
    post: [shader("post_v", { GRAIN: 1 }), ldrPostShader({ bloom: true, haze: !!m.rain.active || !!m.fog_lights?.length || !!m.atmosphere.haze_ambient?.some((x: number) => x > 0) })],
    blit: [shader("post_v"), shader("blit_f")],
    copy: [shader("post_v"), shader("blit_f", { PRESERVE_ALPHA: 1 })],
  };
  writeFileSync(
    join(root, `.pocket-build/ipod/assets/${place.id}.pipelines.json`),
    JSON.stringify({ draws: pairs, ...fixed, texture_usage: textureUsage(
      pairs, fixed.sky,
      name => readFileSync(join(root, `.pocket-build/ipod/assets/shaders/${name}.glsl`), "utf8"),
    ) }),
  );
  console.log(place.id, pairs.length);
}

writeEffects();
const background = shader("blit_f");
const bgPath = join(
  root,
  `.pocket-build/ipod/assets/shaders/${background}.glsl`,
);
const bgSource = readFileSync(bgPath, "utf8").replace(
  "texture2D(uSource, vUv)",
  "texture2D(uSource, vec2(vUv.x, 1.0-vUv.y))",
);
writeFileSync(bgPath.replace(".glsl", "-globe.glsl"), bgSource);
writeFileSync(
  join(root, ".pocket-build/ipod/assets/globe.pipelines.json"),
  JSON.stringify({
    marker: [shader("marker_v"), shader("marker_f", { ATLAS_BLEND: 2 })],
    globe: [shader("globe_v"), shader("globe_f")],
    post: [shader("post_v", { GRAIN: 1 }), shader("composite_f")],
    post_bounded: [shader("post_v", { GRAIN: 1 }), globeGradeShader()],
    background: [shader("post_v"), background + "-globe"],
    blit: [shader("post_v"), shader("blit_f")],
  }),
);

// Retain only shader variants referenced by the current pipeline tables.
const assetRoot = join(root, ".pocket-build/ipod/assets"),
  live = new Set<string>();
function visit(value: unknown) {
  if (typeof value === "string") live.add(value + ".glsl");
  else if (Array.isArray(value)) value.forEach(visit);
  else if (value && typeof value === "object")
    Object.entries(value).forEach(([key, child]) => {
      if (key !== "texture_usage") visit(child); // Metadata repeats program names and adds sampler lists.
    });
}
for (const entry of readdirSync(assetRoot))
  if (
    entry.endsWith(".pipelines.json") ||
    entry.endsWith(".shadow.json") ||
    entry === "effects.json"
  )
    visit(JSON.parse(readFileSync(join(assetRoot, entry), "utf8")));
for (const entry of readdirSync(join(assetRoot, "shaders")))
  if (entry.endsWith(".glsl") && !live.has(entry))
    unlinkSync(join(assetRoot, "shaders", entry));
}
