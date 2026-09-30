/**
 * Shared GLSL: hashing, tileable gradient noise, fbm and Worley cells. Every
 * periodic function takes a `per` (period in lattice cells) so baked textures
 * wrap seamlessly.
 */
export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
vec2 wrapCell(vec2 c, vec2 per) {
  return per.x > 0.0 ? mod(c, per) : c;
}
float gnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = hash22(wrapCell(i, per)) * 2.0 - 1.0;
  vec2 g10 = hash22(wrapCell(i + vec2(1.0, 0.0), per)) * 2.0 - 1.0;
  vec2 g01 = hash22(wrapCell(i + vec2(0.0, 1.0), per)) * 2.0 - 1.0;
  vec2 g11 = hash22(wrapCell(i + vec2(1.0, 1.0), per)) * 2.0 - 1.0;
  float a = dot(g00, f);
  float b = dot(g10, f - vec2(1.0, 0.0));
  float c = dot(g01, f - vec2(0.0, 1.0));
  float d = dot(g11, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4142;
}
float vnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(wrapCell(i, per));
  float b = hash12(wrapCell(i + vec2(1.0, 0.0), per));
  float c = hash12(wrapCell(i + vec2(0.0, 1.0), per));
  float d = hash12(wrapCell(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// fbm in [0,1]
float fbm(vec2 p, vec2 per, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p, per);
    n += a;
    p = p * 2.0 + vec2(17.3, 9.1) * float(per.x <= 0.0);
    per *= 2.0;
    a *= 0.5;
  }
  return s / n * 0.5 + 0.5;
}
float ridged(vec2 p, vec2 per, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * (1.0 - abs(gnoise(p, per)));
    n += a;
    p *= 2.0;
    per *= 2.0;
    a *= 0.5;
  }
  return s / n;
}
// Worley: x = F1, y = F2, z = cell hash
vec3 worley(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 c = wrapCell(i + o, per);
    vec2 r = o + hash22(c) - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; id = hash12(c + 7.7); }
    else if (d < f2) { f2 = d; }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
`;

/** Rain ripple normal perturbation for a horizontal water film (world xz in meters). */
export const GLSL_RIPPLES = /* glsl */ `
vec2 rippleLayer(vec2 p, float t, float seed) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 acc = vec2(0.0);
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 c = cell + o;
    vec3 h = hash32(c + seed);
    vec2 center = o + h.xy;
    float phase = fract(t * (0.9 + 0.5 * h.z) + h.x * 7.0);
    vec2 d = f - center;
    float dist = length(d);
    float radius = phase * 0.55;
    float ring = dist - radius;
    float env = (1.0 - phase) * (1.0 - phase);
    float wave = sin(ring * 42.0) * exp(-ring * ring * 520.0) * env;
    acc += (d / max(dist, 1e-3)) * wave;
  }
  return acc;
}
vec2 rainRipples(vec2 xz, float t) {
  vec2 a = rippleLayer(xz * 2.3, t * 1.15, 0.0);
  vec2 b = rippleLayer(xz * 3.1 + 11.7, t * 1.35, 41.0);
  return a + b * 0.8;
}
`;
