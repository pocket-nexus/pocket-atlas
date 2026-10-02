import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeShadowPipelines } from "./atlas-ipod-shadow";
import { writeEffects } from "./atlas-ipod-effects";
import { shader } from "./atlas-ipod-shaders";
import { PLACES } from "../web/src/places/registry";
const root = resolve(import.meta.dir, "..");
function meta(place: string) {
  const b = readFileSync(
    join(root, `.pocket-build/places/${place}/${place}.place`),
  );
  const n = b.readUInt32LE(8);
  for (let i = 0; i < n; i++) {
    const t = 16 + i * 16;
    if (b.toString("ascii", t, t + 4) === "META")
      return JSON.parse(
        b.toString(
          "utf8",
          b.readUInt32LE(t + 4),
          b.readUInt32LE(t + 4) + b.readUInt32LE(t + 8),
        ),
      );
  }
  throw new Error("META");
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
function pair(scene: any, d: any, mirror: boolean, tier: number) {
  const m = scene.materials[d.material];
  const f: Record<string, number> = {
    LIGHTS: ["standard", "glass"].includes(m.kind) ? 2 : 0,
  };
  const v: Record<string, number> = {};
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
  if (["standard", "glass"].includes(m.kind) && tier > 0) {
    f[tier === 1 ? "LITE" : "FAR"] = 1;
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
    if (tier === 1) f.LITE = 1;
    if (tier === 2) f.FAR = 1;
    if (m.normal != null && tier === 0 && !mirror) v.TANGENT = 1;
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
  return [
    shader(m.kind === "lights" ? "lights_v" : "surface_v", v),
    shader(fragments[m.kind], f),
  ];
}
for (const place of PLACES.filter((p) => p.status === "live" && p.load)) {
  const m = meta(place.id);
  writeShadowPipelines(place.id, m);
  const pairs = m.draws.map((d: any) =>
    d.layout === "lights"
      ? null
      : {
          detail: pair(m, d, false, 0),
          far: pair(m, d, false, m.materials[d.material].wet ? 1 : 2),
          reflection: pair(m, d, true, 2),
        },
  );
  const fixed = {
    sky: [
      shader("sky_v"),
      shader(
        m.day_sky ? "sky_day_f" : "sky_f",
        m.day_sky?.twilight ? { TWILIGHT: 1 } : {},
      ),
    ],
    post: [
      shader("post_v", { GRAIN: 1 }),
      shader("composite_f", { BLOOM: 1, HAZE: 1 }),
    ],
    blit: [shader("post_v"), shader("blit_f")],
    down: [shader("post_v"), shader("down_f")],
  };
  writeFileSync(
    join(root, `.pocket-build/ipod/assets/${place.id}.pipelines.json`),
    JSON.stringify({ draws: pairs, ...fixed }),
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
    background: [shader("post_v"), background + "-globe"],
  }),
);

// Retain only shader variants referenced by the current pipeline tables.
const assetRoot = join(root, ".pocket-build/ipod/assets"),
  live = new Set<string>();
function visit(value: unknown) {
  if (typeof value === "string") live.add(value + ".glsl");
  else if (Array.isArray(value)) value.forEach(visit);
  else if (value && typeof value === "object")
    Object.values(value).forEach(visit);
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
