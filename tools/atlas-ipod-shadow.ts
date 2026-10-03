/** Sun-shadow variants of the shared surface and packed-depth programs. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shader } from "./atlas-ipod-shaders";
import { PLACES } from "../web/src/places/registry";
import { selectIPodPlaces } from "./atlas-ipod-catalog";
import { createHash } from "node:crypto";
import { readIPodMetadata } from "./atlas-ipod-pack";

interface ShadowMeta {
  materials: {
    kind: string;
    blend: string;
    alpha_test: number;
    uv_anim?: unknown;
  }[];
  draws: {
    material: number;
    cast_shadow: boolean;
    layout: string;
    skin?: number;
    node?: number;
  }[];
  skins: { joints: number[] }[];
}

const root = resolve(import.meta.dir, "..");
const assets = join(root, ".pocket-build/ipod/assets");

function dynamicFragment(alpha: boolean): string {
  const key = shader("shadow_f", alpha ? { ALPHA_TEST: 1 } : {});
  let source = readFileSync(join(assets, `shaders/${key}.glsl`), "utf8");
  // Restore the cached static map each frame, then take the nearest of its
  // packed depth and each moving caster. This replaces rerendering thousands
  // of static meshes; the shared fragment still performs the actual encode.
  source = source
    .replace(
      "#version 100",
      "#version 100\n#extension GL_EXT_shader_framebuffer_fetch : require",
    )
    .replace("void main(", "highp vec4 atlasPackedDepth;\nvoid atlasShadow(")
    .replace(/gl_FragData\[0\]/g, "atlasPackedDepth");
  source += `
void main() {
    atlasShadow();
    highp vec4 previous = gl_LastFragData[0];
    highp vec3 decode = vec3(1.0, 1.0 / 255.0, 1.0 / 65025.0);
    gl_FragColor = dot(atlasPackedDepth.rgb, decode) < dot(previous.rgb, decode) ? atlasPackedDepth : previous;
}
`;
  const result = `shadow_dynamic_f-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
  writeFileSync(join(assets, `shaders/${result}.glsl`), source);
  return result;
}

export function writeShadowPipelines(id: string, meta: ShadowMeta): void {
  const draws = meta.draws.map((draw) => {
    const material = meta.materials[draw.material];
    if (
      !draw.cast_shadow ||
      draw.layout === "lights" ||
      material.blend !== "opaque" ||
      ["glass", "water", "interior_window"].includes(material.kind)
    )
      return null;
    const alpha = material.alpha_test > 0;
    const vertex: Record<string, number> = alpha ? {} : { FLAT: 1 };
    if (draw.layout === "skinned") {
      if (draw.skin == null) throw new Error(`${id}: shadow skin missing`);
      vertex.SKINNED = 1;
      vertex.MAX_BONES = Math.max(meta.skins[draw.skin].joints.length, 1);
    }
    // Baked lighting is irrelevant to the depth pass: it shares the static
    // position/UV prefix without carrying the irradiance varying.
    const dynamic =
      draw.node != null || draw.skin != null || material.uv_anim != null;
    return [
      shader("surface_v", vertex),
      dynamic
        ? dynamicFragment(alpha)
        : shader("shadow_f", alpha ? { ALPHA_TEST: 1 } : {}),
    ];
  });
  mkdirSync(assets, { recursive: true });
  const copy = [shader("post_v"), shader("blit_f")];
  writeFileSync(
    join(assets, `${id}.shadow.json`),
    JSON.stringify({ draws, copy }),
  );
}

function packMeta(id: string): ShadowMeta {
  return readIPodMetadata(join(assets, `${id}.place`));
}

export function checkShadowPipelines(id: string): void {
  const config = JSON.parse(
    readFileSync(join(assets, `${id}.shadow.json`), "utf8"),
  ) as { draws: ([string, string] | null)[]; copy: [string, string] };
  const unique = new Map(
    [
      ...config.draws.filter((p): p is [string, string] => p != null),
      config.copy,
    ].map((p) => [p.join(":"), p]),
  );
  const directory = join(root, ".pocket-build/ipod/shadow-validation");
  mkdirSync(directory, { recursive: true });
  for (const pair of unique.values()) {
    const files = pair.map((name, stage) => {
      let source = readFileSync(join(assets, `shaders/${name}.glsl`), "utf8");
      if (
        stage === 1 &&
        /gl_FragColor\s*=\s*atlasEncode|atlasDecode\(texture2D\(u(?:Albedo|Source)/.test(
          source,
        )
      )
        throw new Error(
          `${id}: packed shadow depth must bypass HDR conversion`,
        );
      source = source
        .replace(
          "#extension GL_EXT_shader_framebuffer_fetch : require",
          "uniform highp vec4 atlasPriorFragment[1];",
        )
        .replace(/\bgl_LastFragData\b/g, "atlasPriorFragment");
      const file = join(directory, `${name}.${stage === 0 ? "vert" : "frag"}`);
      writeFileSync(file, source);
      return file;
    });
    const result = Bun.spawnSync(["glslangValidator", "-l", ...files], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode)
      throw new Error(
        `${id}: ${result.stdout.toString()}${result.stderr.toString()}`,
      );
  }
  console.log(
    `${id}: ${unique.size} shadow shader pairs linked; ${config.draws.filter(Boolean).length} casters`,
  );
}

if (import.meta.main) {
  for (const place of selectIPodPlaces(PLACES)) {
    writeShadowPipelines(place.id, packMeta(place.id));
    if (Bun.argv.includes("--check")) checkShadowPipelines(place.id);
  }
}
