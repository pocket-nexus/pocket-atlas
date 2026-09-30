import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";
import { N8AOPostPass } from "n8ao";
import { Color, HalfFloatType, Matrix4, Uniform, Vector2, Vector3, Vector4, type PerspectiveCamera, type Scene, type WebGLRenderer } from "three";
import type { Quality } from "../../core/quality";

export const MAX_FOG_LIGHTS = 24;

/** A light that scatters in the rain haze (and lights rain streaks). */
export interface FogLight {
  position: Vector3;
  color: Color;
  /** Scattering strength (independent of the scene light's intensity). */
  intensity: number;
  /** Softening radius (m): larger = broader, dimmer core. */
  radius: number;
  /** Spot: direction and cone cosines; omit for omni. */
  direction?: Vector3;
  cosOuter?: number;
  cosInner?: number;
  /** Live multiplier (flicker, car headlights passing). */
  gain?: number;
}

const LIT_FOG = /* glsl */ `
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec3 uCamPos;
uniform int uCount;
uniform vec4 uLPos[${MAX_FOG_LIGHTS}];
uniform vec4 uLCol[${MAX_FOG_LIGHTS}];
uniform vec4 uLDir[${MAX_FOG_LIGHTS}];
uniform float uDensity;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uAmbient;
uniform float uAmbientDensity;
uniform float uFar;

float segment(vec3 ro, vec3 rd, float t0, float t1, int i) {
  vec3 L = uLPos[i].xyz - ro;
  float tca = dot(L, rd);
  float r = uLPos[i].w;
  float h = sqrt(max(dot(L, L) - tca * tca, 0.0) + r * r);
  float I = (atan((t1 - tca) / h) - atan((t0 - tca) / h)) / h;
  if (uLCol[i].w > -1.5) {
    float tc = clamp(tca, t0, t1);
    vec3 P = ro + rd * tc;
    vec3 dl = normalize(P - uLPos[i].xyz);
    float cs = dot(dl, uLDir[i].xyz);
    I *= smoothstep(uLCol[i].w, uLDir[i].w, cs);
  }
  return I;
}

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 a = (uBoxMin - ro) * inv;
  vec3 b = (uBoxMax - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 vp = uProjInv * ndc;
  vp /= vp.w;
  float dist = depth >= 0.9999 ? uFar : length(vp.xyz);
  vec3 rd = normalize((uViewInv * vec4(vp.xyz, 0.0)).xyz);
  vec3 ro = uCamPos;
  // Skip the part of the ray inside the shop: it is dry, bright and haze-free.
  vec2 bh = boxHit(ro, rd);
  float in0 = max(bh.x, 0.0);
  float in1 = min(bh.y, dist);
  bool cut = bh.y > bh.x && in1 > in0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_FOG_LIGHTS}; i++) {
    if (i >= uCount) break;
    float I = cut ? segment(ro, rd, 0.0, in0, i) + segment(ro, rd, in1, dist, i) : segment(ro, rd, 0.0, dist, i);
    acc += uLCol[i].rgb * I;
  }
  float outside = cut ? dist - (in1 - in0) : dist;
  float amb = 1.0 - exp(-outside * uAmbientDensity);
  outputColor = vec4(inputColor.rgb + acc * uDensity + uAmbient * amb, inputColor.a);
}
`;

/**
 * Single-scattering from point and spot lights in a homogeneous rain haze,
 * integrated analytically along each view ray up to the depth buffer
 * (closed-form ∫ 1/d² dt = atan terms). Gives every lamp and sign its halo and
 * the street lamps their cones without ray marching.
 */
export class LitFogEffect extends Effect {
  /** Most lights integrated per pixel (the rest are culled on the CPU). */
  budget = 16;

  constructor() {
    super("LitFogEffect", LIT_FOG, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["uProjInv", new Uniform(new Matrix4())],
        ["uViewInv", new Uniform(new Matrix4())],
        ["uCamPos", new Uniform(new Vector3())],
        ["uCount", new Uniform(0)],
        ["uLPos", new Uniform(Array.from({ length: MAX_FOG_LIGHTS }, () => new Vector4()))],
        ["uLCol", new Uniform(Array.from({ length: MAX_FOG_LIGHTS }, () => new Vector4()))],
        ["uLDir", new Uniform(Array.from({ length: MAX_FOG_LIGHTS }, () => new Vector4()))],
        ["uDensity", new Uniform(0.02)],
        ["uBoxMin", new Uniform(new Vector3())],
        ["uBoxMax", new Uniform(new Vector3())],
        ["uAmbient", new Uniform(new Color())],
        ["uAmbientDensity", new Uniform(0.0)],
        ["uFar", new Uniform(200)],
      ]),
    });
  }

  sync(camera: PerspectiveCamera, lights: FogLight[]): void {
    const u = this.uniforms;
    (u.get("uProjInv")!.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u.get("uViewInv")!.value as Matrix4).copy(camera.matrixWorld);
    (u.get("uCamPos")!.value as Vector3).setFromMatrixPosition(camera.matrixWorld);
    const pos = u.get("uLPos")!.value as Vector4[];
    const col = u.get("uLCol")!.value as Vector4[];
    const dir = u.get("uLDir")!.value as Vector4[];
    // Keep the lights that can matter from here: strength over distance.
    const cam = u.get("uCamPos")!.value as Vector3;
    const ranked = lights
      .map((l) => {
        const g = (l.gain ?? 1) * l.intensity;
        const d2 = l.position.distanceToSquared(cam);
        return { l, g, score: (g * (1 + l.radius * l.radius)) / (1 + d2 * 0.02) };
      })
      .filter((e) => e.g > 0.0001 && e.score > 0.0015)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.budget);
    let n = 0;
    for (const { l, g } of ranked) {
      pos[n].set(l.position.x, l.position.y, l.position.z, l.radius);
      col[n].set(l.color.r * g, l.color.g * g, l.color.b * g, l.direction ? (l.cosOuter ?? 0.5) : -2);
      if (l.direction) dir[n].set(l.direction.x, l.direction.y, l.direction.z, l.cosInner ?? 0.9);
      n++;
    }
    u.get("uCount")!.value = n;
  }

  setBox(min: Vector3, max: Vector3): void {
    (this.uniforms.get("uBoxMin")!.value as Vector3).copy(min);
    (this.uniforms.get("uBoxMax")!.value as Vector3).copy(max);
  }
}

const GRADE = /* glsl */ `
uniform float uGrain;
uniform float uVignette;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uSaturation;
uniform float uContrast;
uniform float uFade;
uniform float uBars;
float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  // Contrast pivoting on middle grey.
  c = 0.18 * pow(c / 0.18, vec3(uContrast));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  // Lift shadows toward teal, push highlights warm (applied on a soft curve).
  float sh = 1.0 - smoothstep(0.0, 0.35, l);
  float hi = smoothstep(0.35, 1.0, l);
  c += uLift * sh * 0.04;
  c *= mix(vec3(1.0), uGain, hi);
  vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
  float v = smoothstep(1.05, 0.25, length(d));
  c *= mix(1.0 - uVignette, 1.0, v);
  float n = gHash(uv * resolution + fract(time * 7.13) * 911.0) + gHash(uv * resolution * 1.37 - fract(time * 3.1) * 517.0) - 1.0;
  c += n * uGrain * (0.35 + 0.65 * (1.0 - smoothstep(0.0, 0.5, l)));
  c = mix(c, vec3(0.0), uFade);
  // Letterbox toward 2.39:1 while the cinematic camera runs.
  float bar = uBars * max(0.0, 0.5 - (aspect / 2.39) * 0.5);
  c *= smoothstep(bar - 0.001, bar + 0.001, min(uv.y, 1.0 - uv.y));
  outputColor = vec4(c, inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", GRADE, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["uGrain", new Uniform(0.03)],
        ["uVignette", new Uniform(0.45)],
        ["uLift", new Uniform(new Vector3(0.1, 0.35, 0.45))],
        ["uGain", new Uniform(new Vector3(1.04, 0.99, 0.94))],
        ["uSaturation", new Uniform(1.18)],
        ["uContrast", new Uniform(1.16)],
        ["uFade", new Uniform(0)],
        ["uBars", new Uniform(0)],
      ]),
    });
  }
}

export interface PostChain {
  composer: EffectComposer;
  fog: LitFogEffect;
  grade: GradeEffect;
  bloom: BloomEffect;
  dof: DepthOfFieldEffect | null;
  setSize(w: number, h: number): void;
  render(dt: number): void;
  dispose(): void;
}

export function createPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, quality: Quality): PostChain {
  const composer = new EffectComposer(renderer, {
    frameBufferType: HalfFloatType,
    multisampling: quality.msaa,
    stencilBuffer: false,
  });
  composer.addPass(new RenderPass(scene, camera));

  if (quality.ao) {
    const ao = new N8AOPostPass(scene, camera, 16, 16);
    ao.configuration.aoRadius = 1.2;
    ao.configuration.distanceFalloff = 0.6;
    ao.configuration.intensity = 2.2;
    ao.configuration.gammaCorrection = false;
    ao.configuration.halfRes = quality.level !== "ultra";
    ao.configuration.color = new Color(0, 0, 0);
    composer.addPass(ao);
  }

  const fog = new LitFogEffect();
  fog.budget = quality.level === "low" ? 6 : quality.level === "medium" ? 10 : 16;
  composer.addPass(new EffectPass(camera, fog));

  let dof: DepthOfFieldEffect | null = null;
  if (quality.level === "high" || quality.level === "ultra") {
    dof = new DepthOfFieldEffect(camera, { focusDistance: 12, focusRange: 10, bokehScale: 1.5, resolutionScale: 0.5 });
    const dofPass = new EffectPass(camera, dof);
    composer.addPass(dofPass);
  }

  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 1.1,
    luminanceSmoothing: 0.4,
    intensity: 0.85,
    radius: 0.7,
    levels: quality.level === "low" ? 5 : 8,
  });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const grade = new GradeEffect();
  const finals: Effect[] = [];
  if (quality.msaa === 0) finals.push(new SMAAEffect());
  else finals.push(new ChromaticAberrationEffect({ offset: new Vector2(0.0006, 0.0004), radialModulation: true, modulationOffset: 0.25 }));
  finals.push(bloom, tone, grade);
  composer.addPass(new EffectPass(camera, ...finals));

  return {
    composer,
    fog,
    grade,
    bloom,
    dof,
    setSize: (w, h) => composer.setSize(w, h, false),
    render: (dt) => composer.render(dt),
    dispose: () => composer.dispose(),
  };
}
