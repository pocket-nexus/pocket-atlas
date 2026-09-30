import { ATMOSPHERE_RADIUS, PLANET_RADIUS } from "../geo";

export const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const COMMON = /* glsl */ `
#define PI 3.141592653589793
#define TAU 6.283185307179586
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float sq(float x) { return x * x; }

vec3 latLonToVec(float lat, float lon) {
  float c = cos(lat);
  return vec3(c * sin(lon), sin(lat), c * cos(lon));
}

// Equirectangular lookup; v = 0 is the north pole (see geo.ts).
vec2 sphereUv(vec3 p) {
  return vec2(atan(p.x, p.z) / TAU + 0.5, 0.5 - asin(clamp(p.y, -1.0, 1.0)) / PI);
}

// Same, but picks whichever longitude parametrisation is continuous across the
// pixel quad so mip selection does not spike along the antimeridian seam.
vec2 sphereUvSeamless(vec3 p) {
  vec2 uv = sphereUv(p);
  float u2 = fract(uv.x + 0.5) - 0.5;
  if (fwidth(uv.x) > fwidth(u2) + 1e-5) uv.x = u2;
  return uv;
}

float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}
`;

/** Simplex noise (Ashima Arts / Stefan Gustavson, MIT), fbm, ridged and Worley. */
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// fbm in roughly [-1, 1]; the per-octave offset breaks lattice alignment.
float fbm(vec3 p, int octaves) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    s += a * snoise(p);
    n += a;
    p = p * 2.03 + vec3(1.7, -9.2, 3.1);
    a *= 0.5;
  }
  return s / n;
}

float ridged(vec3 p, int octaves) {
  float s = 0.0, a = 0.5, n = 0.0, prev = 1.0;
  for (int i = 0; i < 10; i++) {
    if (i >= octaves) break;
    float r = 1.0 - abs(snoise(p));
    r *= r;
    s += a * r * prev;
    n += a;
    prev = r;
    p = p * 2.07 + vec3(4.1, 2.3, -7.7);
    a *= 0.5;
  }
  return s / n;
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Nearest and second-nearest feature distances; F2 - F1 is small along cell edges.
vec2 worley2(vec3 p) {
  vec3 i = floor(p);
  vec3 fr = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + hash33(i + o) - fr;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return sqrt(vec2(d1, d2));
}

// Distance to the nearest feature point (F1).
float worley(vec3 p) {
  vec3 i = floor(p);
  vec3 fr = fract(p);
  float d = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + hash33(i + o) - fr;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
`;

/**
 * Single-scattering atmosphere in planet-radius units. The shell is ~3× the
 * real thickness so the limb reads at globe scale; scale heights and
 * coefficients are scaled to keep the real optical depths.
 */
export const ATMOSPHERE = /* glsl */ `
#define PLANET_R ${f(PLANET_RADIUS)}
#define ATMOS_R ${f(ATMOSPHERE_RADIUS)}
#define ATMOS_H (ATMOS_R - PLANET_R)
#define HR 0.0055
#define HM 0.0013
#ifndef ATMOS_STEPS
#define ATMOS_STEPS 12
#endif
const vec3 BETA_R = vec3(8.4, 19.5, 47.9);
const float BETA_M = 7.0;
const float MIE_G = 0.78;

uniform sampler2D tTransmittance;
uniform float uSunI;

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

// Transmittance from a point at altitude h towards a sun at cos-zenith mu,
// including the planet's (softened) shadow.
vec3 sunTransmittance(float h, float mu) {
  return texture(tTransmittance, vec2(mu * 0.5 + 0.5, sqrt(saturate(h / ATMOS_H)))).rgb;
}

float phaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float phaseM(float c) {
  float g2 = MIE_G * MIE_G;
  return 0.1193662 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * MIE_G * c, 1e-4), 1.5));
}

void scatter(vec3 ro, vec3 rd, float tMax, vec3 L, float jitter, out vec3 inscatter, out vec3 transmittance) {
  inscatter = vec3(0.0);
  transmittance = vec3(1.0);
  vec2 ta = raySphere(ro, rd, ATMOS_R);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tMax);
  if (t1 <= t0) return;
  float dt = (t1 - t0) / float(ATMOS_STEPS);
  vec2 od = vec2(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < ATMOS_STEPS; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
    float r = length(p);
    float h = max(r - PLANET_R, 0.0);
    vec2 dens = exp(-h / vec2(HR, HM)) * dt;
    vec3 tv = exp(-(BETA_R * (od.x + 0.5 * dens.x) + BETA_M * 1.1 * (od.y + 0.5 * dens.y)));
    vec3 att = tv * sunTransmittance(h, dot(p, L) / r);
    sumR += att * dens.x;
    sumM += att * dens.y;
    od += dens;
  }
  float c = dot(rd, L);
  inscatter = uSunI * (sumR * BETA_R * phaseR(c) + sumM * BETA_M * phaseM(c));
  transmittance = exp(-(BETA_R * od.x + BETA_M * 1.1 * od.y));
}
`;
