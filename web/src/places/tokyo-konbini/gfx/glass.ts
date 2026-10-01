import { CustomBlending, OneFactor, OneMinusSrcAlphaFactor, type MeshPhysicalMaterial, type MeshStandardMaterial } from "three";
import { GLSL_NOISE } from "../../shared/glsl";
import type { WetShared } from "./wet";

const VERT_PARS = /* glsl */ `
varying vec3 vGlassWorld;
`;
const VERT_MAIN = /* glsl */ `
{
  vec4 gw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    gw = instanceMatrix * gw;
  #endif
  vGlassWorld = (modelMatrix * gw).xyz;
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uRain;
uniform float uDrops;
varying vec3 vGlassWorld;
${GLSL_NOISE}

// Static beads: Worley cells, each holding a drop of random size.
vec3 beads(vec2 uv, float scale, float seed) {
  vec2 p = uv * scale;
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec3 acc = vec3(0.0);
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec3 h = hash32(i + o + seed);
    if (h.z < 0.35) continue;
    vec2 c = o + 0.15 + h.xy * 0.7;
    vec2 d = f - c;
    d.y *= 1.0 + h.z * 0.4;
    float r = 0.12 + 0.2 * h.z * h.x;
    float l = length(d);
    if (l < r) {
      float k = l / r;
      acc.xy += d / r * sqrt(1.0 - k * k) * 1.4;
      acc.z = max(acc.z, smoothstep(1.0, 0.7, k));
    }
  }
  return acc;
}

// Running drops with a bead trail, one lane per column.
vec3 runners(vec2 uv, float t) {
  float lanes = 9.0;
  vec2 p = vec2(uv.x * lanes, uv.y);
  float lane = floor(p.x);
  float h = hash12(vec2(lane, 3.7));
  float h2 = hash12(vec2(lane, 9.1));
  float speed = 0.18 + h * 0.4;
  float period = 2.2 + h2 * 2.5;
  float y = fract(uv.y / period + t * speed / period + h * 5.0);
  float wob = sin(uv.y * 22.0 + h * 40.0) * 0.06 + sin(uv.y * 7.0 + h2 * 9.0) * 0.08;
  float fx = fract(p.x) - 0.5 - wob;
  vec3 acc = vec3(0.0);
  // head
  float head = 0.9;
  vec2 d = vec2(fx * 1.0, (y - head) * period * lanes * 0.55);
  float r = 0.22;
  float l = length(d);
  if (l < r) {
    float k = l / r;
    acc.xy += d / r * sqrt(1.0 - k * k) * 1.6;
    acc.z = smoothstep(1.0, 0.6, k);
  }
  // trail: thin wet streak above the head plus tiny beads
  float trail = smoothstep(head, head - 0.35, y) * step(y, head);
  float tw = smoothstep(0.08, 0.0, abs(fx));
  acc.z = max(acc.z, trail * tw * 0.5);
  acc.x += -sign(fx) * trail * tw * 0.3;
  return acc;
}
`;

const FRAG_NORMAL = /* glsl */ `
float glassDrop = 0.0;
{
  // Glass UV in meters along its plane (axis picked from the geometry normal).
  vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec2 guv = abs(wn.x) > abs(wn.z) ? vec2(vGlassWorld.z, vGlassWorld.y) : vec2(vGlassWorld.x, vGlassWorld.y);
  vec3 b = beads(guv, 38.0, 0.0) + beads(guv, 71.0, 13.0) * 0.6;
  vec3 run = runners(guv * vec2(1.3, 1.0), uTime);
  vec3 all = (b + run) * uRain * uDrops;
  glassDrop = clamp(all.z, 0.0, 1.0);
  vec3 tU = normalize((viewMatrix * vec4(abs(wn.x) > abs(wn.z) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0), 0.0)).xyz);
  vec3 tV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  normal = normalize(normal + (tU * all.x + tV * all.y) * 0.9);
}
`;

const FRAG_OUT = /* glsl */ `
{
  // Premultiplied: reflections are added at full strength while the tint
  // (diffuse) scales with coverage, like real glass over a bright interior.
  float cover = clamp(diffuseColor.a + glassDrop * 0.12, 0.0, 1.0);
  gl_FragColor = vec4(totalDiffuse * cover + totalSpecular * (1.0 + glassDrop * 0.6) + totalEmissiveRadiance, cover);
}
`;

/**
 * Storefront glass: premultiplied blend (specular is not faded by opacity),
 * plus procedural rain beads and running drops on the outer face.
 */
export function makeRainGlass<T extends MeshStandardMaterial | MeshPhysicalMaterial>(material: T, shared: WetShared, drops = 1): T {
  material.userData.pocketAtlas = { ...(material.userData.pocketAtlas ?? {}), kind: "glass", glass: { drops } };
  material.transparent = true;
  material.depthWrite = false;
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  const local = { uDrops: { value: drops } };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uRain = shared.uRain;
    Object.assign(shader.uniforms, local);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace("#include <opaque_fragment>", FRAG_OUT);
  };
  material.customProgramCacheKey = () => "rain-glass";
  return material;
}
