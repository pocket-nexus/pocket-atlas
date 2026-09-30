/**
 * Procedural PBR surfaces (GLSL bodies for Baker.surface). Each tile covers
 * the physical size noted next to it; materials set texture.repeat to
 * 1 / size because all scene geometry carries UVs in meters.
 */

/** 4 m asphalt: exposed aggregate, binder, patch seams and hairline cracks. */
export const ASPHALT = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 per = vec2(64.0);
  vec2 p = uv * per;
  vec3 w = worley(p * 1.0, per);
  vec3 w2 = worley(p * 2.3 + 3.1, per * 2.3);
  float stone = smoothstep(0.62, 0.18, w.x) * step(0.35, w.z);
  float fine = smoothstep(0.55, 0.1, w2.x) * step(0.5, w2.z);
  float grime = fbm(uv * 6.0, vec2(6.0), 5);
  float patchN = fbm(uv * 2.0 + 0.3, vec2(2.0), 4);
  float patchA = smoothstep(0.54, 0.56, patchN);
  float cracksN = ridged(uv * 5.0, vec2(5.0), 4);
  float crack = smoothstep(0.93, 0.985, cracksN) * (0.4 + 0.6 * smoothstep(0.4, 0.7, grime));
  vec3 binder = mix(vec3(0.034, 0.035, 0.038), vec3(0.058, 0.057, 0.06), grime);
  binder = mix(binder, vec3(0.024, 0.024, 0.026), patchA * 0.85);
  vec3 stoneCol = mix(vec3(0.075, 0.073, 0.07), vec3(0.11, 0.105, 0.1), w.z);
  vec3 col = mix(binder, stoneCol, stone * (1.0 - patchA * 0.7) * 0.6);
  col = mix(col, vec3(0.07), fine * 0.3);
  col *= 1.0 - crack * 0.6;
  float h = stone * 0.35 + fine * 0.12 + grime * 0.25 - crack * 0.6 - patchA * 0.05;
  float r = mix(0.82, 0.7, stone) - patchA * 0.1;
  return S(col, h, r, 1.0 - crack * 0.6 - (1.0 - stone) * 0.12, 0.0);
}`;

/** 1.2 m square of 30 cm granite-look pavers with grout (konbini forecourt). */
export const PAVERS = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = uv * 4.0;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 edge = min(f, 1.0 - f);
  float grout = 1.0 - smoothstep(0.012, 0.03, min(edge.x, edge.y));
  float id = hash12(mod(cell, 4.0) + 3.0);
  vec3 w = worley(uv * 96.0, vec2(96.0));
  float speck = smoothstep(0.25, 0.05, w.x);
  float mottle = fbm(uv * 8.0, vec2(8.0), 4);
  vec3 base = mix(vec3(0.28, 0.28, 0.29), vec3(0.36, 0.355, 0.35), id) * (0.85 + 0.3 * mottle);
  base = mix(base, vec3(0.08), speck * 0.5 * step(0.5, w.z));
  base = mix(base, vec3(0.5), speck * 0.3 * step(w.z, 0.2));
  vec3 col = mix(base, vec3(0.08, 0.08, 0.085), grout);
  float bevel = smoothstep(0.0, 0.05, min(edge.x, edge.y));
  float h = bevel * 0.6 + mottle * 0.05 - grout * 0.3;
  return S(col, h, mix(0.55, 0.8, grout) - mottle * 0.1, 1.0 - grout * 0.5, 0.0);
}`;

/** 1 m of 250 × 62.5 mm facade tiles in running bond (a Tokyo mid-rise staple). */
export const WALL_TILE = /* glsl */ `
uniform vec3 uTileA;
uniform vec3 uTileB;
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 4.0, uv.y * 16.0);
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 edge = min(f, 1.0 - f) * vec2(0.25, 0.0625) * 16.0;
  float grout = 1.0 - smoothstep(0.04, 0.09, min(edge.x, edge.y));
  float id = hash12(mod(cell, vec2(4.0, 16.0)) + 1.3);
  float glaze = fbm(uv * vec2(24.0, 24.0), vec2(24.0), 3);
  vec3 tile = mix(uTileA, uTileB, id) * (0.9 + 0.2 * glaze);
  vec3 col = mix(tile, vec3(0.22, 0.21, 0.2), grout);
  float bevel = smoothstep(0.0, 0.2, min(edge.x, edge.y));
  return S(col, bevel * 0.8 - grout * 0.2, mix(0.32 + 0.2 * id, 0.9, grout), 1.0 - grout * 0.45, 0.0);
}`;

/** 3 m cast concrete with pores and water staining. */
export const CONCRETE = /* glsl */ `
uniform vec3 uTint;
Surface surface(vec2 uv) {
  float n = fbm(uv * 4.0, vec2(4.0), 6);
  float m = fbm(uv * 1.0 + 7.0, vec2(1.0), 3);
  vec3 w = worley(uv * 180.0, vec2(180.0));
  float pore = smoothstep(0.18, 0.02, w.x) * step(0.7, w.z);
  vec3 col = uTint * (0.75 + 0.45 * n) * (0.8 + 0.3 * m);
  col *= 1.0 - pore * 0.5;
  return S(col, n * 0.5 - pore * 0.6, 0.78 + 0.15 * n, 1.0 - pore * 0.4, 0.0);
}`;

/** 1.2 m of 60 cm glossy porcelain floor tiles (konbini interior). */
export const FLOOR_TILE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = uv * 2.0;
  vec2 f = fract(g);
  vec2 edge = min(f, 1.0 - f);
  float grout = 1.0 - smoothstep(0.004, 0.012, min(edge.x, edge.y));
  float id = hash12(mod(floor(g), 2.0) + 11.0);
  float cloud = fbm(uv * 6.0, vec2(6.0), 5);
  vec3 w = worley(uv * 70.0, vec2(70.0));
  float fleck = smoothstep(0.2, 0.05, w.x) * step(0.6, w.z);
  vec3 col = mix(vec3(0.66, 0.66, 0.64), vec3(0.74, 0.735, 0.72), id) * (0.94 + 0.1 * cloud);
  col = mix(col, vec3(0.42, 0.42, 0.44), fleck * 0.4);
  col = mix(col, vec3(0.35, 0.35, 0.36), grout);
  return S(col, -grout * 0.4, mix(0.08 + cloud * 0.08, 0.6, grout), 1.0 - grout * 0.3, 0.0);
}`;

/** 1 m brushed aluminium (horizontal grain). */
export const BRUSHED = /* glsl */ `
uniform vec3 uTint;
Surface surface(vec2 uv) {
  float streak = vnoise(vec2(uv.x * 4.0, uv.y * 900.0), vec2(4.0, 900.0));
  float streak2 = vnoise(vec2(uv.x * 24.0, uv.y * 2400.0), vec2(24.0, 2400.0));
  float smudge = fbm(uv * 3.0, vec2(3.0), 4);
  vec3 col = uTint * (0.9 + 0.12 * streak + 0.05 * streak2);
  return S(col, streak * 0.2, 0.28 + 0.12 * streak2 + 0.15 * smudge, 1.0, 1.0);
}`;

/** 1 m rolling steel shutter: 80 mm slats, dust in the grooves, some rust. */
export const SHUTTER = /* glsl */ `
uniform vec3 uTint;
Surface surface(vec2 uv) {
  float slat = fract(uv.y * 12.5);
  float profile = sin(slat * 3.14159);
  float groove = 1.0 - smoothstep(0.0, 0.12, min(slat, 1.0 - slat));
  float grime = fbm(uv * vec2(3.0, 8.0), vec2(3.0, 8.0), 5);
  float rust = smoothstep(0.66, 0.8, fbm(uv * 5.0 + 3.0, vec2(5.0), 5)) * (0.4 + groove);
  vec3 col = uTint * (0.75 + 0.3 * grime);
  col = mix(col, vec3(0.18, 0.08, 0.04), clamp(rust, 0.0, 1.0));
  col *= 1.0 - groove * 0.45;
  return S(col, profile * 0.7, 0.45 + 0.35 * grime + rust * 0.3, 1.0 - groove * 0.5, 0.35 * (1.0 - rust));
}`;

/** 0.6 m mineral-fibre ceiling panel with a T-bar grid. */
export const CEILING = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 f = fract(uv);
  vec2 edge = min(f, 1.0 - f);
  float bar = 1.0 - smoothstep(0.008, 0.016, min(edge.x, edge.y));
  vec3 w = worley(uv * 60.0, vec2(60.0));
  float pit = smoothstep(0.16, 0.05, w.x) * step(0.45, w.z);
  vec3 col = mix(vec3(0.8, 0.8, 0.78) * (1.0 - pit * 0.35), vec3(0.86), bar);
  return S(col, -pit * 0.5 + bar * 0.3, mix(0.95, 0.4, bar), 1.0 - pit * 0.3, bar * 0.5);
}`;

/** 2 m vertical cedar boards, dark stained (izakaya frontage). */
export const WOOD = /* glsl */ `
uniform vec3 uTint;
Surface surface(vec2 uv) {
  float board = floor(uv.x * 14.0);
  float bf = fract(uv.x * 14.0);
  float gap = 1.0 - smoothstep(0.0, 0.06, min(bf, 1.0 - bf));
  float id = hash12(vec2(mod(board, 14.0), 3.0));
  float grain = fbm(vec2(uv.x * 140.0 + id * 9.0, uv.y * 6.0), vec2(140.0, 6.0), 4);
  float rings = sin((uv.x * 140.0 + grain * 6.0 + id * 20.0) * 3.0) * 0.5 + 0.5;
  vec3 col = uTint * (0.7 + 0.35 * id) * (0.8 + 0.3 * rings * grain);
  col *= 1.0 - gap * 0.7;
  return S(col, rings * 0.3 - gap, 0.62 + 0.2 * grain, 1.0 - gap * 0.6, 0.0);
}`;

/** 1 m painted steel with chips (poles, vending machine bodies, AC units). */
export const PAINTED = /* glsl */ `
uniform vec3 uTint;
Surface surface(vec2 uv) {
  float n = fbm(uv * 6.0, vec2(6.0), 5);
  float chip = smoothstep(0.72, 0.76, fbm(uv * 12.0 + 5.0, vec2(12.0), 5));
  float dirt = fbm(uv * vec2(2.0, 10.0) + 1.0, vec2(2.0, 10.0), 4);
  vec3 col = uTint * (0.92 + 0.12 * n) * (1.0 - 0.25 * smoothstep(0.55, 0.8, dirt));
  col = mix(col, vec3(0.12, 0.11, 0.1), chip);
  return S(col, -chip * 0.4 + n * 0.1, mix(0.38 + 0.2 * n, 0.8, chip), 1.0, chip * 0.6);
}`;

/** 0.4 m yellow tactile paving (dots and bars) for the crossing approach. */
export const TACTILE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = fract(uv * 5.0) - 0.5;
  float dot1 = 1.0 - smoothstep(0.17, 0.21, length(g));
  vec2 edge = min(fract(uv), 1.0 - fract(uv));
  float grout = 1.0 - smoothstep(0.005, 0.015, min(edge.x, edge.y));
  float n = fbm(uv * 8.0, vec2(8.0), 4);
  vec3 col = vec3(0.62, 0.46, 0.04) * (0.75 + 0.3 * n);
  col = mix(col, vec3(0.1), grout);
  return S(col, dot1 * 0.8, 0.55 + 0.2 * n, 1.0 - grout * 0.4, 0.0);
}`;
