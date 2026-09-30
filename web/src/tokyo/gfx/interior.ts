import { MeshStandardMaterial, type PlaneGeometry, type BufferAttribute } from "three";
import { GLSL_NOISE } from "./glsl";
import type { WetShared } from "./wet";

/**
 * Window UVs carry two things: fract(uv) is the position across the pane,
 * floor(uv) is a per-window seed. Call this on a PlaneGeometry after placing.
 */
export function seedWindowUV(g: PlaneGeometry, seedX: number, seedY: number): PlaneGeometry {
  const uv = g.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, seedX + 0.002 + uv.getX(i) * 0.996, seedY + 0.002 + uv.getY(i) * 0.996);
  }
  return g;
}

const VERT_PARS = /* glsl */ `
varying vec3 vIWorld;
`;
const VERT_MAIN = /* glsl */ `
{
  vec4 iw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    iw = instanceMatrix * iw;
  #endif
  vIWorld = (modelMatrix * iw).xyz;
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
varying vec3 vIWorld;
${GLSL_NOISE}

vec3 roomLight(vec3 h, vec3 room, vec3 lampCol, float lit) {
  // Ceiling lamp near the middle of the room.
  vec3 lamp = vec3(room.x * 0.5, room.y - 0.25, room.z * 0.55);
  vec3 d = h - lamp;
  float fall = 1.0 / (1.0 + dot(d, d) * 0.45);
  return lampCol * lit * (0.25 + 1.6 * fall);
}

// Interior mapping (van Dongen): trace the view ray through a box room behind the glass.
vec3 interior(vec2 local, vec2 seed, vec3 P, vec3 V, out float curtainA, out vec3 curtainCol) {
  vec3 dp1 = dFdx(P);
  vec3 dp2 = dFdy(P);
  vec2 du1 = dFdx(local);
  vec2 du2 = dFdy(local);
  float det = du1.x * du2.y - du1.y * du2.x;
  vec3 T = (dp1 * du2.y - dp2 * du1.y) / det;
  vec3 B = (dp2 * du1.x - dp1 * du2.x) / det;
  float W = max(length(T), 0.3);
  float H = max(length(B), 0.3);
  vec3 t = T / W;
  vec3 b = B / H;
  vec3 n = normalize(cross(t, b));

  vec3 h3 = hash32(seed * 1.37 + 0.5);
  float h4 = hash12(seed + 17.1);
  vec3 room = vec3(W + 1.4, 2.6, 3.2 + h3.z * 2.5);
  float sill = H < 1.7 ? 0.85 : 0.18;
  vec3 p = vec3(0.7 + local.x * W, sill + local.y * H, 0.0);
  vec3 d = normalize(vec3(dot(V, t), dot(V, b), -dot(V, n)));
  d.z = max(d.z, 0.05);

  vec3 tw = vec3((d.x > 0.0 ? room.x - p.x : -p.x) / d.x, (d.y > 0.0 ? room.y - p.y : -p.y) / d.y, (room.z - p.z) / d.z);
  float tt = min(min(tw.x, tw.y), tw.z);
  vec3 h = p + d * tt;

  // Per-room character.
  bool lit = h3.x < 0.62;
  bool tv = !lit && h3.y < 0.35;
  vec3 lampCol = h4 < 0.68 ? vec3(1.0, 0.72, 0.45) : vec3(0.82, 0.9, 1.0);
  float bright = 0.55 + h3.y * 0.9;
  vec3 wallCol = mix(vec3(0.78, 0.74, 0.66), vec3(0.62, 0.66, 0.68), hash12(seed + 3.0));
  vec3 floorCol = h3.z < 0.4 ? vec3(0.55, 0.36, 0.2) : h3.z < 0.7 ? vec3(0.6, 0.56, 0.36) : vec3(0.4, 0.4, 0.42);
  vec3 ceilCol = vec3(0.5);
  vec3 albedo;
  if (tt == tw.z) {
    albedo = wallCol;
    // Furniture silhouettes against the back wall: a shelf or a sofa.
    float k = hash12(seed + 9.0);
    if (h.y < 0.75 && abs(h.x - room.x * (0.3 + k * 0.4)) < 0.9) albedo *= 0.35;
    if (k > 0.5 && h.y > 0.9 && h.y < 2.0 && abs(h.x - room.x * 0.2) < 0.35) albedo = vec3(0.15, 0.12, 0.1);
    // Poster / picture.
    if (abs(h.x - room.x * 0.65) < 0.35 && abs(h.y - 1.5) < 0.25) albedo = mix(albedo, vec3(0.3, 0.4, 0.6), 0.7);
  } else if (tt == tw.x) {
    albedo = wallCol * 0.92;
    if (h.y < 2.05 && h.y > 0.0 && abs(h.z - room.z * 0.6) < 0.4) albedo *= 0.55; // a door
  } else {
    albedo = d.y < 0.0 ? floorCol : ceilCol;
  }
  vec3 light = lit ? roomLight(h, room, lampCol, bright) : vec3(0.015, 0.016, 0.02);
  if (tv) {
    float f = 0.6 + 0.4 * sin(uTime * 7.0 + h3.x * 40.0) * sin(uTime * 3.1 + h3.z * 11.0);
    vec3 tvPos = vec3(room.x * 0.5, 0.7, room.z - 0.2);
    vec3 dd = h - tvPos;
    light += vec3(0.35, 0.55, 1.0) * f * 0.9 / (1.0 + dot(dd, dd) * 1.2);
  }
  vec3 col = albedo * light;

  // Curtains / blinds just behind the glass (lit from inside).
  float style = hash12(seed + 5.5);
  curtainA = 0.0;
  curtainCol = vec3(0.0);
  vec3 cloth = mix(vec3(0.85, 0.8, 0.7), vec3(0.6, 0.3, 0.25), step(0.7, hash12(seed + 8.0)));
  if (style < 0.35) {
    float open = 0.25 + 0.35 * hash12(seed + 2.0);
    float leftEdge = open;
    float rightEdge = 1.0 - open * 0.7;
    float fold = 0.85 + 0.15 * sin(local.x * 60.0);
    curtainA = (local.x < leftEdge || local.x > rightEdge) ? 0.92 : 0.0;
    curtainCol = cloth * fold;
  } else if (style < 0.55) {
    float slat = step(0.35, fract(local.y * H * 12.0));
    curtainA = slat * 0.85 * step(local.y, 0.4 + 0.6 * hash12(seed + 4.0) + 0.001);
    curtainCol = vec3(0.8, 0.8, 0.78);
  } else if (style < 0.75) {
    curtainA = 0.55;
    curtainCol = vec3(0.92, 0.9, 0.86) * (0.9 + 0.1 * vnoise(local * vec2(80.0, 40.0), vec2(0.0)));
  }
  vec3 glow = lit ? lampCol * bright * 0.9 : vec3(0.01);
  if (tv) glow += vec3(0.1, 0.18, 0.35);
  curtainCol *= glow;
  return col;
}
`;

const FRAG_EMISSIVE = /* glsl */ `
{
  vec2 seed = floor(vUv);
  vec2 local = fract(vUv);
  vec3 V = normalize(vIWorld - cameraPosition);
  float ca;
  vec3 cc;
  vec3 room = interior(local, seed, vIWorld, V, ca, cc);
  vec3 inside = mix(room, cc, ca);
  // Window frame shadowing at the edges.
  vec2 e = min(local, 1.0 - local);
  inside *= smoothstep(0.0, 0.04, min(e.x, e.y)) * 0.85 + 0.15;
  totalEmissiveRadiance = inside * uIntensity;
}
`;

/**
 * Apartment and office windows with parallax rooms. The material keeps its
 * glass specular (env + lights) and replaces emission with the traced room.
 */
export function makeInteriorWindows(shared: WetShared, intensity = 1.4): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0x06080a, roughness: 0.06, metalness: 0, envMapIntensity: 1.1 });
  const local = { uIntensity: { value: intensity } };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    Object.assign(shader.uniforms, local);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uIntensity;\n${FRAG_PARS}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
  };
  m.customProgramCacheKey = () => "interior-windows";
  // vUv is only declared when a map is present; force the UV varying.
  m.defines = { USE_UV: "" };
  m.name = "interior-windows";
  m.userData.pocketCity = { kind: "interiorWindow", intensity };
  return m;
}
