import { AdditiveBlending, Color, CustomBlending, Material, OneFactor, Vector3, type Mesh, type Object3D, type WebGLProgramParametersWithUniforms } from "three";
import type { SkySpec } from "./sky";

/**
 * Vista haze (`dusk-vista` places): height-dependent extinction under a
 * temperature inversion, replacing three.js fog on every material, with the
 * same formula the handheld evaluates per vertex (`extras.pocketAtlas.haze`).
 *
 *   ρ(y)  = ρ0                          y ≤ H
 *         = ρ0 · exp(−(y − H) / s)      y > H
 *   G(y)  = ρ0 · y                      y ≤ H        (antiderivative of ρ)
 *         = ρ0 · (H + s · (1 − exp(−(y − H) / s)))   y > H
 *   τ     = d · (G(y_p) − G(y_e)) / (y_p − y_e)     (d · ρ(y_e) when |y_p − y_e| < 0.01)
 *   T     = exp(−τ)
 *   out   = c · T + inscatter · (1 − T)
 *   inscatter = gain · hsky(p − eye) + glow · ρ(y_p) / ρ0
 *
 * `d` is the eye-to-point distance in place metres (geometry beyond a few
 * kilometres already carries the curvature drop) and `glow` is the warm-grey
 * light the city scatters into the haze layer, full below the inversion and
 * fading with the density above it. `hsky` is `shared/sky.ts`'s dome on the
 * horizon (h = 0) toward the point, with the sun-side terms weighted by
 * `band`: the afterglow is a high-atmosphere, long-path light, so a few
 * kilometres of low haze toward the sunset take only that share of it, and
 * near hills there stay dark silhouettes. With a = cos of the azimuth from
 * the point's horizontal direction to the sun's, mu = max(a · |sun.xz|, 0),
 * toward = (a + 1) / 2, away = max((1 − a) / 2, 0):
 *
 *   w    = band + (1 − band) · (1 − T)
 *   hsky = ( mix(horizon, zenith, (1e-5)^gradientPower)
 *          + w · sunColor · glow.intensity · (wide.w · mu^wide.e + tight.w · mu^tight.e)
 *          + w · twilight.band.color · mix(1, toward^band.sunPower, band.sunBias)
 *          + twilight.belt.color · exp(−(belt.elevation / belt.width)²) · away^belt.power )
 *        · (1 − shadow.strength · away^shadow.power)
 *
 * The afterglow's share grows with the haze's optical depth: near hills toward
 * the sunset (T ≈ 0.94) take about `band` of it and stay dark, a point
 * infinitely far (T → 0) takes the dome's own horizon (w = 1). With gain 1 and
 * no glow the far terrain then meets the sky at h = 0 without a step in every
 * azimuth; a place that wants a brighter horizon puts it in the sky's terms. Additive materials (and the light field)
 * take `T` only; premultiplied ones scale the inscatter by their alpha.
 */
export interface HazeSpec {
  /** ρ0, extinction under the inversion (1/m). */
  density: number;
  /** H, the inversion top (place y, m). */
  inversion: number;
  /** s, the e-fold height of the density above H (m). */
  scale: number;
  /** Inscatter gain on the horizon sky colour. */
  gain: number;
  /** Weight of the sky's sun-side terms (sun glow lobes, twilight band) in the inscatter, 0–1. */
  band: number;
  /** City glow in the haze layer (linear RGB, added to the inscatter). */
  glow: Color;
  /** The sky whose horizon colours the inscatter. */
  sky: SkySpec;
}

/** Uniforms of the haze GLSL (one shared set; materials reference the same objects). */
export interface HazeUniforms {
  [name: string]: { value: unknown };
  uHaze: { value: [number, number, number, number] };
  uHazeGlow: { value: Color };
  uHazeHorizon: { value: Color };
  uHazeSun: { value: [number, number, number, number] };
  uHazeLobes: { value: [number, number, number, number] };
  uHazeSunGlow: { value: Color };
  uHazeBand: { value: Color };
  uHazeBandShape: { value: [number, number] };
  uHazeBelt: { value: Color };
  uHazeTwilight: { value: [number, number, number] };
  uHazeBandW: { value: number };
}

/**
 * Declarations and functions (fragment or vertex stage). A shader that is not
 * patched by `Haze.apply` (e.g. the light field) prepends this, merges
 * `haze.uniforms` and calls `hazeTransmittance(cameraPosition, worldPos)`.
 *
 *   uHaze      = (ρ0, H, s, gain)
 *   uHazeSun   = (sun.x, sun.y, sun.z, |sun.xz|)
 *   uHazeLobes = (wide.w, wide.e, tight.w, tight.e)
 *   uHazeBelt  = belt.color · exp(−(belt.elevation / belt.width)²)   (its value on the horizon)
 *   uHazeTwilight = (belt.power, shadow.strength, shadow.power)
 */
export const HAZE_GLSL = /* glsl */ `
uniform vec4 uHaze;
uniform vec3 uHazeGlow;
uniform vec3 uHazeHorizon;
uniform vec4 uHazeSun;
uniform vec4 uHazeLobes;
uniform vec3 uHazeSunGlow;
uniform vec3 uHazeBand;
uniform vec2 uHazeBandShape;
uniform vec3 uHazeBelt;
uniform vec3 uHazeTwilight;
uniform float uHazeBandW;
float hazeRho(float y) {
  return y <= uHaze.y ? uHaze.x : uHaze.x * exp(-(y - uHaze.y) / uHaze.z);
}
float hazeG(float y) {
  return y <= uHaze.y ? uHaze.x * y : uHaze.x * (uHaze.y + uHaze.z * (1.0 - exp(-(y - uHaze.y) / uHaze.z)));
}
float hazeTransmittance(vec3 eye, vec3 p) {
  float d = distance(eye, p);
  float dy = p.y - eye.y;
  float tau = abs(dy) < 0.01 ? d * hazeRho(eye.y) : d * (hazeG(p.y) - hazeG(eye.y)) / dy;
  return exp(-max(tau, 0.0));
}
// The sky dome (shared/sky.ts) on the horizon toward horizontal direction dxz,
// its sun-side terms (glow lobes, twilight band) weighted by w.
vec3 hazeSky(vec2 dxz, float w) {
  vec2 dh = normalize(dxz + vec2(1e-5));
  vec2 sh = normalize(uHazeSun.xz + vec2(1e-5));
  float a = clamp(dot(dh, sh), -1.0, 1.0);
  float mu = max(a * uHazeSun.w, 0.0);
  float toward = (a + 1.0) * 0.5;
  float away = max((1.0 - a) * 0.5, 0.0);
  vec3 sunSide = uHazeSunGlow * (uHazeLobes.x * pow(mu, uHazeLobes.y) + uHazeLobes.z * pow(mu, uHazeLobes.w))
               + uHazeBand * mix(1.0, pow(toward, uHazeBandShape.y), uHazeBandShape.x);
  vec3 col = uHazeHorizon + w * sunSide;
  col += uHazeBelt * pow(away, uHazeTwilight.x);
  col *= 1.0 - uHazeTwilight.y * pow(away, uHazeTwilight.z);
  return col;
}
// The afterglow's share grows with the optical depth: band near, the full
// horizon sky for a point infinitely far (T → 0), where it meets the dome.
vec3 hazeInscatter(vec3 eye, vec3 p, float T) {
  float w = uHazeBandW + (1.0 - uHazeBandW) * (1.0 - T);
  return uHaze.w * hazeSky(p.xz - eye.xz, w) + uHazeGlow * (hazeRho(p.y) / uHaze.x);
}
vec3 hazeApply(vec3 c, vec3 eye, vec3 p) {
  float T = hazeTransmittance(eye, p);
  return c * T + hazeInscatter(eye, p, T) * (1.0 - T);
}
`;

const VERT_PARS = /* glsl */ `
varying vec3 vHazeWorld;
`;
// Place position from the view-space one: world = Rᵀ · (view − t) for view = R · world + t.
const VERT_MAIN = /* glsl */ `
vHazeWorld = (mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix);
`;
const FRAG_MAIN = /* glsl */ `
{
  float hazeT = hazeTransmittance(cameraPosition, vHazeWorld);
#if defined(HAZE_ADDITIVE)
  gl_FragColor.rgb *= hazeT;
#elif defined(HAZE_PREMULTIPLIED)
  gl_FragColor.rgb = gl_FragColor.rgb * hazeT + hazeInscatter(cameraPosition, vHazeWorld, hazeT) * (1.0 - hazeT) * gl_FragColor.a;
#else
  gl_FragColor.rgb = gl_FragColor.rgb * hazeT + hazeInscatter(cameraPosition, vHazeWorld, hazeT) * (1.0 - hazeT);
#endif
}
`;

type Patchable = Material & {
  isShaderMaterial?: boolean;
  premultipliedAlpha: boolean;
  fog?: boolean;
  userData: { haze?: boolean | "manual"; [k: string]: unknown };
};

/** The haze of one place: shared uniforms, the material patch, a CPU mirror and the export annotation. */
export class Haze {
  readonly spec: HazeSpec;
  readonly uniforms: HazeUniforms;
  private patched = new Map<Material, { before: Material["onBeforeCompile"]; key: Material["customProgramCacheKey"] }>();

  constructor(spec: HazeSpec) {
    this.spec = spec;
    const s = spec.sky;
    const tw = s.twilight;
    const sunXZ = Math.hypot(s.sun.x, s.sun.z);
    const beltZ = tw ? tw.belt.elevation / tw.belt.width : 0;
    this.uniforms = {
      uHaze: { value: [spec.density, spec.inversion, spec.scale, spec.gain] },
      uHazeGlow: { value: spec.glow.clone() },
      uHazeHorizon: { value: s.horizon.clone().lerp(s.zenith, Math.pow(1e-5, s.gradientPower)) },
      uHazeSun: { value: [s.sun.x, s.sun.y, s.sun.z, sunXZ] },
      uHazeLobes: { value: [s.glow.wide[0], s.glow.wide[1], s.glow.tight[0], s.glow.tight[1]] },
      uHazeSunGlow: { value: s.sunColor.clone().multiplyScalar(s.glow.intensity) },
      uHazeBand: { value: tw ? tw.band.color.clone() : new Color(0, 0, 0) },
      uHazeBandShape: { value: tw ? [tw.band.sunBias, tw.band.sunPower] : [0, 1] },
      uHazeBelt: { value: tw ? tw.belt.color.clone().multiplyScalar(Math.exp(-beltZ * beltZ)) : new Color(0, 0, 0) },
      uHazeTwilight: { value: tw ? [tw.belt.power, tw.shadow.strength, tw.shadow.power] : [1, 0, 1] },
      uHazeBandW: { value: spec.band },
    };
  }

  /**
   * Replaces the fog chunks of every lit or basic material under `root` (that
   * has not opted out with `fog: false` or `userData.haze = false`) with the
   * haze. Shader materials are left to call `HAZE_GLSL` themselves. Returns
   * the number of materials patched.
   */
  apply(root: Object3D): number {
    let n = 0;
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.material) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (this.patch(m as Patchable)) n++;
    });
    return n;
  }

  private patch(m: Patchable): boolean {
    if (this.patched.has(m) || m.isShaderMaterial || m.fog === false || m.userData.haze === false || m.userData.haze === "manual") return false;
    const before = m.onBeforeCompile;
    const key = m.customProgramCacheKey;
    this.patched.set(m, { before, key });
    m.userData.pocketAtlas = { ...m.userData.pocketAtlas, vistaHaze: true };
    const additive = m.blending === AdditiveBlending;
    const premultiplied = !additive && (m.premultipliedAlpha || (m.blending === CustomBlending && m.blendSrc === OneFactor));
    const uniforms = this.uniforms;
    m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
      before.call(m, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <fog_pars_vertex>", VERT_PARS).replace("#include <fog_vertex>", VERT_MAIN);
      const defs = additive ? "#define HAZE_ADDITIVE\n" : premultiplied ? "#define HAZE_PREMULTIPLIED\n" : "";
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <fog_pars_fragment>", `${defs}${VERT_PARS}${HAZE_GLSL}`)
        .replace("#include <fog_fragment>", FRAG_MAIN);
    };
    // The default key is the compile hook's source: keep the material's own hook's.
    const own = key === Material.prototype.customProgramCacheKey ? () => before.toString() : () => key.call(m);
    m.customProgramCacheKey = () => `${own()}|haze${additive ? "+" : premultiplied ? "p" : ""}`;
    m.needsUpdate = true;
    return true;
  }

  /** Restores the materials' own compile hooks (the stage calls it on dispose). */
  remove(): void {
    for (const [m, { before, key }] of this.patched) {
      m.onBeforeCompile = before;
      m.customProgramCacheKey = key;
      m.needsUpdate = true;
    }
    this.patched.clear();
  }

  /** ρ(y). */
  rho(y: number): number {
    const { density, inversion, scale } = this.spec;
    return y <= inversion ? density : density * Math.exp(-(y - inversion) / scale);
  }

  private g(y: number): number {
    const { density, inversion, scale } = this.spec;
    return y <= inversion ? density * y : density * (inversion + scale * (1 - Math.exp(-(y - inversion) / scale)));
  }

  /** T(eye, p), as the GLSL computes it. */
  transmittance(eye: Vector3, p: Vector3): number {
    const d = eye.distanceTo(p);
    const dy = p.y - eye.y;
    const tau = Math.abs(dy) < 0.01 ? d * this.rho(eye.y) : (d * (this.g(p.y) - this.g(eye.y))) / dy;
    return Math.exp(-Math.max(tau, 0));
  }

  /** The inscatter colour toward `p` from `eye` (with the afterglow weight at that point's transmittance). */
  inscatter(eye: Vector3, p: Vector3, out = new Color()): Color {
    const u = this.uniforms;
    let dx = p.x - eye.x;
    let dz = p.z - eye.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const [sx, , sz, sxz] = u.uHazeSun.value;
    const sl = Math.hypot(sx, sz) || 1;
    const a = Math.max(-1, Math.min(1, (dx * sx + dz * sz) / sl));
    const mu = Math.max(a * sxz, 0);
    const [ww, we, tw, te] = u.uHazeLobes.value;
    const toward = (a + 1) / 2;
    const away = Math.max((1 - a) / 2, 0);
    const [bias, power] = u.uHazeBandShape.value;
    const sunSide = u.uHazeSunGlow.value.clone().multiplyScalar(ww * Math.pow(mu, we) + tw * Math.pow(mu, te));
    sunSide.add(u.uHazeBand.value.clone().multiplyScalar(1 + (Math.pow(toward, power) - 1) * bias));
    const T = this.transmittance(eye, p);
    const w = this.spec.band + (1 - this.spec.band) * (1 - T);
    out.copy(u.uHazeHorizon.value).add(sunSide.multiplyScalar(w));
    const [beltPower, shadow, shadowPower] = u.uHazeTwilight.value;
    out.add(u.uHazeBelt.value.clone().multiplyScalar(Math.pow(away, beltPower)));
    out.multiplyScalar((1 - shadow * Math.pow(away, shadowPower)) * this.spec.gain);
    return out.add(this.spec.glow.clone().multiplyScalar(this.rho(p.y) / this.spec.density));
  }

  /** `extras.pocketAtlas.haze` on the scene (contract 2). */
  annotation(): Record<string, unknown> {
    const s = this.spec;
    return {
      density: s.density,
      inversion: s.inversion,
      scale: s.scale,
      gain: s.gain,
      band: s.band,
      glow: s.glow.toArray().map((v) => Math.round(v * 1e5) / 1e5),
      note: "T = exp(-d·(G(yp)−G(ye))/(yp−ye)), ρ(y) = density (y ≤ inversion) else density·exp(−(y−inversion)/scale); out = c·T + (gain·hsky + glow·ρ(yp)/density)·(1−T); hsky = the sky dome at h=0 toward p with its sun-glow lobes and twilight band × w, w = band + (1−band)·(1−T) (so T→0 gives the dome's horizon exactly); additive and lights: c·T. See places/shared/haze.ts",
    };
  }
}
