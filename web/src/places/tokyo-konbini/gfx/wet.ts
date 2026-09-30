import { Matrix4, type IUniform, type MeshStandardMaterial, type Texture } from "three";
import { GLSL_NOISE, GLSL_RIPPLES } from "../../shared/glsl";

/**
 * Scene-wide uniforms shared by every wet material. The stage updates the
 * values once per frame; materials hold references to these objects.
 */
export interface WetShared {
  uTime: IUniform<number>;
  uRain: IUniform<number>;
  uReflOn: IUniform<number>;
  uReflMatrix: IUniform<Matrix4>;
  uReflSharp: IUniform<Texture | null>;
  uReflBlur: IUniform<Texture | null>;
  uReflSoft: IUniform<Texture | null>;
  uPuddleTex: IUniform<Texture | null>;
}

export function createWetShared(): WetShared {
  return {
    uTime: { value: 0 },
    uRain: { value: 1 },
    uReflOn: { value: 1 },
    uReflMatrix: { value: new Matrix4() },
    uReflSharp: { value: null },
    uReflBlur: { value: null },
    uReflSoft: { value: null },
    uPuddleTex: { value: null },
  };
}

export interface WetOptions {
  /** 0 = no standing water, 1 = lots. */
  puddles: number;
  /** Albedo multiplier when soaked (porous surfaces darken more). */
  darken: number;
  /** Roughness multiplier on the wet film outside puddles. */
  roughness: number;
  /** Receives the planar reflection (only for surfaces on the mirror plane). */
  planar: boolean;
  /** Ripple normal strength inside puddles. */
  ripple?: number;
  /** World-space size of the puddle pattern (m). */
  puddleScale?: number;
}

const VERT_PARS = /* glsl */ `
uniform mat4 uReflMatrix;
varying vec4 vWetRefl;
varying vec3 vWetWorld;
`;

const VERT_MAIN = /* glsl */ `
{
  vec4 wetWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wetWorld = instanceMatrix * wetWorld;
  #endif
  wetWorld = modelMatrix * wetWorld;
  vWetWorld = wetWorld.xyz;
  vWetRefl = uReflMatrix * wetWorld;
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uRain;
uniform float uReflOn;
uniform sampler2D uReflSharp;
uniform sampler2D uReflBlur;
uniform sampler2D uReflSoft;
uniform sampler2D uPuddleTex;
uniform float uPuddles;
uniform float uPuddleScale;
uniform float uWetDarken;
uniform float uWetRough;
uniform float uRipple;
varying vec4 vWetRefl;
varying vec3 vWetWorld;
${GLSL_NOISE}
${GLSL_RIPPLES}
`;

const FRAG_ALBEDO = /* glsl */ `
float wetPuddle = 0.0;
vec3 wetNW = vec3(0.0, 1.0, 0.0);
{
  vec2 pw = vWetWorld.xz / uPuddleScale;
  vec4 pn = texture2D(uPuddleTex, pw);
  vec4 pn2 = texture2D(uPuddleTex, pw * 3.7 + 0.37);
  float field = pn.r * 0.75 + pn2.g * 0.25;
  float thr = 0.71 - uPuddles * 0.25;
  wetPuddle = smoothstep(thr - 0.012, thr + 0.03, field) * uRain * step(0.001, uPuddles);
  float damp = smoothstep(thr - 0.09, thr, field);
  diffuseColor.rgb *= mix(1.0, uWetDarken, uRain);
  diffuseColor.rgb *= mix(1.0, 0.82, damp * uRain);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45 + vec3(0.002, 0.0025, 0.003), wetPuddle);
  // Drop ripples only matter on standing water; skip the 18-cell loop elsewhere.
  vec2 rip = vec2(0.0);
  if (wetPuddle > 0.01 && uRipple > 0.0) rip = rainRipples(vWetWorld.xz, uTime) * uRain;
  vec2 micro = vec2(gnoise(vWetWorld.xz * 9.0 + uTime * 0.4, vec2(0.0)), gnoise(vWetWorld.zx * 9.0 - uTime * 0.37, vec2(0.0)));
  wetNW = normalize(vec3(-(rip.x * uRipple + micro.x * 0.015), 1.0, -(rip.y * uRipple + micro.y * 0.015)));
}
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, roughnessFactor * uWetRough, uRain);
roughnessFactor = mix(roughnessFactor, 0.02, wetPuddle);
`;

const FRAG_NORMAL = /* glsl */ `
{
  vec3 wetNV = normalize((viewMatrix * vec4(wetNW, 0.0)).xyz);
  normal = normalize(mix(normal, wetNV, wetPuddle * 0.96));
}
`;

const FRAG_REFL = /* glsl */ `
#ifdef WET_PLANAR
{
  vec2 ruv = vWetRefl.xy / vWetRefl.w;
  vec3 nW = normalize(mix(vec3(0.0, 1.0, 0.0), wetNW, max(wetPuddle, 0.35)));
  ruv += nW.xz * vec2(0.05, 0.09);
  float rr = material.roughness;
  vec3 rs = texture2D(uReflSharp, ruv).rgb;
  vec3 rb = texture2D(uReflBlur, ruv).rgb;
  vec3 rsoft = texture2D(uReflSoft, ruv).rgb;
  vec3 refl = mix(rs, rb, smoothstep(0.06, 0.2, rr));
  refl = mix(refl, rsoft, smoothstep(0.2, 0.42, rr));
  float edge = smoothstep(0.0, 0.03, ruv.x) * smoothstep(1.0, 0.97, ruv.x) * smoothstep(0.0, 0.03, ruv.y) * smoothstep(1.0, 0.97, ruv.y);
  float w = uReflOn * (1.0 - smoothstep(0.5, 0.8, rr)) * mix(0.35, 1.0, edge);
  radiance = mix(radiance, refl, w);
}
#endif
`;

/**
 * Turns a MeshStandardMaterial into a rain-soaked one: darker albedo, a
 * glossy water film, puddles with animated drop ripples and (optionally) the
 * planar street reflection fed through three's own IBL specular term, so the
 * Fresnel falloff comes from the standard BRDF.
 */
export function makeWet<T extends MeshStandardMaterial>(material: T, shared: WetShared, opts: WetOptions): T {
  const local = {
    uPuddles: { value: opts.puddles },
    uPuddleScale: { value: opts.puddleScale ?? 14 },
    uWetDarken: { value: opts.darken },
    uWetRough: { value: opts.roughness },
    uRipple: { value: opts.ripple ?? 0.55 },
  };
  material.userData.wet = local;
  material.userData.pocketAtlas = {
    ...(material.userData.pocketAtlas ?? {}),
    wet: { puddles: opts.puddles, darken: opts.darken, roughness: opts.roughness, planar: opts.planar, ripple: opts.ripple ?? 0.55, puddleScale: opts.puddleScale ?? 14 },
  };
  if (opts.planar) material.defines = { ...(material.defines ?? {}), WET_PLANAR: "" };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, local);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${FRAG_ALBEDO}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>\n${FRAG_REFL}`);
  };
  material.customProgramCacheKey = () => `wet-${opts.planar ? 1 : 0}`;
  return material;
}

const DAMP_FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uRain;
uniform float uDampDarken;
uniform float uDampRough;
uniform float uDampStreaks;
varying vec3 vWetWorld;
${GLSL_NOISE}
`;

const DAMP_ALBEDO = /* glsl */ `
float dampStreak = 0.0;
{
  vec3 p = vWetWorld;
  float u = p.x + p.z;
  float lane = vnoise(vec2(u * 7.0, p.y * 0.35), vec2(0.0));
  float lane2 = vnoise(vec2(u * 19.0 + 3.0, p.y * 0.8 - uTime * 0.05), vec2(0.0));
  dampStreak = smoothstep(0.55, 0.85, lane) * (0.6 + 0.4 * lane2) * uDampStreaks;
  diffuseColor.rgb *= mix(1.0, uDampDarken, uRain) * (1.0 - dampStreak * 0.35 * uRain);
}
`;

const DAMP_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, roughnessFactor * uDampRough, uRain);
roughnessFactor = mix(roughnessFactor, 0.12, dampStreak * uRain);
`;

/** Rain-soaked vertical surfaces: darker, glossier, with water running down in lanes. */
export function makeDamp<T extends MeshStandardMaterial>(material: T, shared: WetShared, opts: { darken: number; roughness: number; streaks?: number }): T {
  material.userData.pocketAtlas = { ...(material.userData.pocketAtlas ?? {}), damp: { darken: opts.darken, roughness: opts.roughness, streaks: opts.streaks ?? 1 } };
  const local = {
    uDampDarken: { value: opts.darken },
    uDampRough: { value: opts.roughness },
    uDampStreaks: { value: opts.streaks ?? 1 },
  };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uRain = shared.uRain;
    shader.uniforms.uReflMatrix = shared.uReflMatrix;
    Object.assign(shader.uniforms, local);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${DAMP_FRAG_PARS}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${DAMP_ALBEDO}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${DAMP_ROUGH}`);
  };
  material.customProgramCacheKey = () => "damp";
  return material;
}
