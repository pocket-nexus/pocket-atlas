/** Native-resolution water geometry resolves the display colour produced by
 * its complete shared water program in a smaller, independent depth target.
 * Waves, two normal layers, Fresnel, sunlight, shallow colour and fog remain
 * in that response program. Spatial filtering softens their fine detail. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shader } from "./atlas-ipod-shaders";

type WaterScene = {
  materials: { kind: string; blend: string; depth_write: boolean }[];
  skins: { joints: unknown[] }[];
};
type WaterDraw = { material: number; layout: string; node?: number | null; skin?: number | null };

export function usesWaterResponse(scene: WaterScene, draw: WaterDraw): boolean {
  const m = scene.materials[draw.material];
  return m?.kind === "water" && m.blend === "opaque" && m.depth_write;
}

export function waterResolveDefines(scene: WaterScene, draw: WaterDraw): Record<string, number> {
  const defines: Record<string, number> = { DISPLAY_COLOR: 1, SCREEN: 1, LDR_COLOR: 1 };
  if (draw.node == null && draw.skin == null) defines.STATIC_WORLD = 1;
  if (draw.layout === "skinned") {
    const skin = draw.skin == null ? undefined : scene.skins[draw.skin];
    if (!skin) throw new Error("Water resolve skin is missing");
    defines.SKINNED = 1;
    defines.SKIP_ZERO_WEIGHTS = 1;
    defines.MAX_BONES = Math.max(skin.joints.length, 1);
  }
  return defines;
}

export function waterResolveSource(): string {
  return `#version 100
precision mediump float;
// Coverage division needs filtered fractions below one display byte. A
// sampler defaults to lowp independently of the default float precision.
uniform mediump sampler2D uWaterResponse;
uniform vec4 uDisplayBody;
varying highp vec4 vScreen;
varying mediump float vDepth;
void main() {
 highp vec2 uv=vScreen.xy/vScreen.w*0.5+0.5;
 vec4 response=texture2D(uWaterResponse,uv);
 vec3 color=response.a>0.0?response.rgb/response.a:uDisplayBody.rgb;
 gl_FragColor=vec4(color,vDepth);
}
`;
}

function waterResolveShader(): string {
  const source = waterResolveSource();
  const key = "water_resolve_f-" + createHash("sha256").update(source).digest("hex").slice(0, 16);
  const output = resolve(import.meta.dir, "../.pocket-build/ipod/assets/shaders");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, key + ".glsl"), source);
  return key;
}

export function waterPrograms(scene: WaterScene, draw: WaterDraw, original: string[], compileResponse: () => string[]) {
  if (!usesWaterResponse(scene, draw)) return { main: original, water_response: null };
  return {
    main: [shader("surface_v", waterResolveDefines(scene, draw)), waterResolveShader()],
    // The original RGB equations write opaque coverage into an otherwise
    // transparent target. Normalizing the filtered coverage prevents dark
    // fringes against clear texels. A water sliver with no response sample
    // falls back to the material body colour; native geometry still clips it.
    water_response: compileResponse(),
  };
}
