import { BackSide, ClampToEdgeWrapping, Color, LinearFilter, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Texture } from "three";
import type { Baker } from "../bake";
import type { DayWorld } from "./context";

/**
 * Daytime sky for residential streets: a clear blue gradient, the sun, and a
 * field of fair-weather cumulus baked once into a 1024² panorama.
 *
 * Cloud panorama layout (the handheld samples it the same way):
 *   azimuth a = atan2(d.x, −d.z) ∈ [0, 2π) (0 = looking down the stairs, π/2 = +X)
 *   elevation e = asin(d.y) ∈ [0, π/2]
 *   the image holds two halves: v ∈ [0, 0.5) covers a ∈ [0, π), v ∈ [0.5, 1) covers [π, 2π)
 *   u = fract(a / π), v = (half + sqrt(e / (π/2))) / 2, rows bottom-up (v = 0 is the last PNG row)
 * Channels: R = opacity, G = sunlit radiance / SUN_SCALE, B = sky-lit radiance
 * (both already multiplied by the transmittance in front). Clouds composite
 * as  sky · (1 − R·f) + (sunColor · SUN_SCALE · G + ambient · B) · f  with
 * f = smoothstep(0, fadeElevation, d.y) fading them into the horizon haze.
 */
export const SKY = {
  zenith: new Color(0.075, 0.25, 0.78),
  horizon: new Color(0.62, 0.76, 0.92),
  ground: new Color(0.42, 0.44, 0.45),
  sun: new Color(1.0, 0.93, 0.8),
  /** Radiance multipliers for the sky gradient and the sun glow. */
  skyIntensity: 1.0,
  glow: 0.22,
  disc: 40,
  cloudSun: new Color(1.0, 0.95, 0.86).multiplyScalar(1.35),
  cloudAmbient: new Color(0.46, 0.56, 0.72),
  sunScale: 2.5,
  fadeElevation: 0.04,
};

const CLOUD_SIZE = 1024;

const CLOUD_BAKE = /* glsl */ `
uniform vec3 uSun;
#define PI 3.14159265
const float RE = 6371000.0;
const float CB = 1400.0;
const float CT = 4600.0;
const float CELL = 3300.0;
const float SIGMA = 0.02;

float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s / 0.9375;
}
// Fair-weather cumulus: most Worley sites carry a cloud built from three
// flat-based domes spread over the cell and two or three rounded turrets
// rising out of them, with the outline billowed by two octaves of 3D noise.
// Returns density; hL = height within the cloud (0 at the base, 1 at the top).
float cloudShape(vec3 p, float alt, out float hL) {
  hL = 0.0;
  float h = alt - CB;
  if (h < 0.0 || h > CT - CB) return -1.0;
  vec2 q = p.xz / CELL;
  q += 0.2 * vec2(gnoise(q * 0.6, vec2(0.0)), gnoise(q * 0.6 + 7.3, vec2(0.0)));
  vec2 i = floor(q), f = fract(q);
  float edge = -1.0;
  float top = 0.0;
  // Union over the neighbouring sites, so no cloud is cut at a cell border.
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 bc = i + o;
    vec2 site = o + hash22(bc) - f;
    if (dot(site, site) > 0.85) continue;
    vec3 hc = hash32(bc + 11.0);
    if (hc.x > 0.6) continue;
    vec2 rel = -site * CELL;
    float rb = CELL * (0.12 + 0.2 * hc.y);
    float tall = 0.45 + 0.75 * hc.z;
    for (int k = 0; k < 6; k++) {
      vec3 hk = hash32(bc * 3.1 + float(k) * 17.7);
      vec3 hk2 = hash32(bc * 5.7 + float(k) * 31.3);
      if (k >= 3 && hk2.z > 0.7) continue;
      float spread = k < 3 ? 0.75 : 0.5;
      vec2 off = (hk.xy - 0.5) * 2.0 * rb * spread * (k == 0 ? 0.3 : 1.0);
      float r = rb * (k < 3 ? 0.55 + 0.35 * hk.z : 0.32 + 0.22 * hk.z);
      float e;
      float tk;
      if (k < 3) {
        // Flat-based dome.
        float ht = r * tall * (0.8 + 0.4 * hk2.x);
        tk = h / ht;
        float rr = r * sqrt(max(1.0 - tk * tk, 0.0)) * (1.0 + 0.25 * (1.0 - tk));
        // Above the dome top the edge keeps falling, so no noise column rises from it.
        e = (rr - length(rel - off)) / rb - max(tk - 1.0, 0.0) * (r / rb) * 2.0;
      } else {
        // Turret: a sphere standing on the domes.
        float cy = r * tall * (1.0 + 0.9 * hk2.x);
        vec2 dxz = rel - off;
        e = (r - length(vec3(dxz.x, (h - cy) * 1.15, dxz.y))) / rb;
        tk = h / (cy + r);
      }
      if (e > edge) { edge = e; top = tk; }
    }
  }
  hL = clamp(top, 0.0, 1.0);
  float ramp = smoothstep(0.0, 70.0, h);
  return edge * ramp - (1.0 - ramp);
}
// Density from the shape: billows grow with height; the base stays crisp and flat.
float cloudDensity(vec3 p, float edge, float hL) {
  if (edge < -0.4) return 0.0;
  float n = fbm3(p / 300.0);
  float det = fbm3(p / 100.0 + 3.1);
  float billow = (n - 0.5) * (0.6 + 1.1 * hL) + (det - 0.5) * (0.25 + 0.3 * hL);
  return clamp(edge * 2.3 + billow - 0.03, 0.0, 1.0);
}
float cumulus(vec3 p, float alt, out float hL) {
  float e = cloudShape(p, alt, hL);
  return cloudDensity(p, e, hL);
}
float altitude(vec3 p) { return length(p + vec3(0.0, RE, 0.0)) - RE; }
float shell(vec3 o, vec3 d, float r) {
  vec3 oc = o + vec3(0.0, RE, 0.0);
  float b = dot(oc, d);
  float c = dot(oc, oc) - r * r;
  return -b + sqrt(max(b * b - c, 0.0));
}
float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5); }
`;

const CLOUD_BODY = /* glsl */ `
  float halfIdx = vUv.y < 0.5 ? 0.0 : 1.0;
  float lv = fract(vUv.y * 2.0);
  float el = lv * lv * PI * 0.5;
  float az = (vUv.x + halfIdx) * PI;
  vec3 dir = vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
  vec3 o = vec3(0.0, 30.0, 0.0);
  float t0 = shell(o, dir, RE + CB);
  float t1 = min(shell(o, dir, RE + CT), t0 + 30000.0);
  float mu = dot(dir, uSun);
  float phase = 0.55 * hg(mu, 0.55) + 0.45 * hg(mu, -0.2);
  float T = 1.0, sunAcc = 0.0, ambAcc = 0.0;
  // Coarse steps find a cloud; fine steps integrate it.
  // Coarse steps test the noise-free shape (grown by the noise's reach), so
  // thin wisps are never stepped over; fine steps integrate the density.
  const float DC = 150.0;
  const float DF = 35.0;
  float t = t0 + 0.5 * DC;
  int fine = 0;
  for (int i = 0; i < 900; i++) {
    if (t > t1 || T < 0.01) break;
    vec3 p = o + dir * t;
    float hL;
    float edge = cloudShape(p, altitude(p), hL);
    if (fine == 0) {
      if (edge > -0.45) { t = max(t0, t - DC); fine = 12; continue; }
      t += DC;
      continue;
    }
    t += DF;
    if (edge <= -0.45) { fine--; continue; }
    fine = 12;
    float dens = cloudDensity(p, edge, hL);
    if (dens <= 0.0) continue;
    float a = 1.0 - exp(-dens * SIGMA * DF);
    float od = 0.0, ls = 50.0;
    vec3 q = p;
    for (int j = 0; j < 6; j++) {
      q += uSun * ls;
      float hq;
      od += cumulus(q, altitude(q), hq) * ls;
      ls *= 1.85;
    }
    float Tl = exp(-od * SIGMA);
    // Single scattering plus a soft multiple-scattering lobe.
    float sunL = Tl * phase + 0.3 * exp(-od * SIGMA * 0.25);
    float ambL = 0.28 + 0.72 * pow(hL, 0.7);
    sunAcc += T * a * sunL;
    ambAcc += T * a * ambL;
    T *= 1.0 - a;
  }
  float haze = exp(-t0 / 42000.0);
  outColor = vec4((1.0 - T) * haze, clamp(sunAcc * haze / ${SKY.sunScale.toFixed(1)}, 0.0, 1.0), clamp(ambAcc * haze, 0.0, 1.0), 1.0);
`;

/** Bakes the cumulus panorama for a sun direction (unit vector toward the sun). */
export function bakeClouds(baker: Baker, sun: Vector3): Texture {
  const tex = baker.bake(CLOUD_SIZE, CLOUD_SIZE, CLOUD_BODY, {
    header: CLOUD_BAKE,
    uniforms: { uSun: { value: sun.clone() } },
    mipmaps: false,
    repeat: false,
    tiles: 16,
  });
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.name = "sky-clouds";
  return tex;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform float uGlow;
uniform float uDisc;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmbient;
uniform float uFade;
uniform float uDrift;
uniform float uTime;
uniform sampler2D uClouds;
varying vec3 vDir;
#define PI 3.14159265
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
  col = h < 0.0 ? mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0)) : col;
  float mu = dot(d, uSunDir);
  col += uSun * uGlow * (0.35 * pow(max(mu, 0.0), 6.0) + pow(max(mu, 0.0), 48.0));
  col += uSun * uDisc * smoothstep(0.99995, 0.99999, mu);
  if (h > 0.0) {
    float az = atan(d.x, -d.z) / (2.0 * PI);
    float a01 = fract(az + uDrift * uTime);
    float halfIdx = floor(a01 * 2.0);
    float u = fract(a01 * 2.0);
    float lv = sqrt(asin(clamp(h, 0.0, 1.0)) / (PI * 0.5));
    float v = (halfIdx + clamp(lv, 0.5 / 512.0, 1.0 - 0.5 / 512.0)) * 0.5;
    vec3 c = texture2D(uClouds, vec2(u, v)).rgb;
    float f = smoothstep(0.0, uFade, h);
    col = col * (1.0 - c.r * f) + (uCloudSun * ${SKY.sunScale.toFixed(1)} * c.g + uCloudAmbient * c.b) * f;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * Sky dome. It is the only custom shader on scene surfaces; its annotation
 * carries every parameter a handheld needs to redraw it.
 */
export function buildSky(w: DayWorld, sunDir: Vector3, clouds: Texture): { sky: Mesh; update: (t: number, cam: Vector3) => void } {
  const drift = 0.00004;
  const mat = new ShaderMaterial({
    uniforms: {
      uZenith: { value: SKY.zenith.clone().multiplyScalar(SKY.skyIntensity) },
      uHorizon: { value: SKY.horizon.clone().multiplyScalar(SKY.skyIntensity) },
      uGround: { value: SKY.ground },
      uSunDir: { value: sunDir.clone() },
      uSun: { value: SKY.sun },
      uGlow: { value: SKY.glow },
      uDisc: { value: SKY.disc },
      uCloudSun: { value: SKY.cloudSun },
      uCloudAmbient: { value: SKY.cloudAmbient },
      uFade: { value: SKY.fadeElevation },
      uDrift: { value: drift },
      uTime: { value: 0 },
      uClouds: { value: clouds },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(1800, 64, 32), mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.dynamic = true;
  const arr = (c: Color) => [c.r, c.g, c.b];
  sky.userData.pocketAtlas = {
    kind: "sky",
    model: "gradient-sun-cloudpanorama",
    zenith: arr(SKY.zenith),
    horizon: arr(SKY.horizon),
    ground: arr(SKY.ground),
    gradientPower: 0.42,
    groundBlend: 6,
    sunDirection: [sunDir.x, sunDir.y, sunDir.z],
    sunColor: arr(SKY.sun),
    glow: { intensity: SKY.glow, wide: [0.35, 6], tight: [1, 48] },
    disc: { intensity: SKY.disc, cosInner: 0.99999, cosOuter: 0.99995 },
    clouds: {
      file: "sky-clouds.png",
      size: [CLOUD_SIZE, CLOUD_SIZE],
      mapping: "two-half azimuth × sqrt(elevation); u = fract(a/π), v = (half + sqrt(e/(π/2)))/2; rows bottom-up",
      azimuthZero: [0, 0, -1],
      channels: { r: "opacity", g: "sunlit / sunScale", b: "skylit" },
      sunScale: SKY.sunScale,
      sunColor: arr(SKY.cloudSun),
      ambientColor: arr(SKY.cloudAmbient),
      fadeElevation: SKY.fadeElevation,
      driftTurnsPerSecond: drift,
      layer: { base: 1400, top: 4600, cell: 3300, note: "baked offline; the handheld only samples the panorama" },
    },
  };
  w.root.add(sky);
  return {
    sky,
    update: (t, cam) => {
      mat.uniforms.uTime.value = t;
      sky.position.copy(cam);
    },
  };
}
