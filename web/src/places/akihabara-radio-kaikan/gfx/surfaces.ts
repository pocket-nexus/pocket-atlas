/**
 * Dry street surfaces for Akihabara (GLSL bodies for Baker.surface). Each tile
 * covers the physical size noted next to it; materials set texture.repeat to
 * 1 / size because the geometry carries UVs in metres. Albedo is linear.
 */

/** 4 m of worn grey asphalt (no lane markings on this street): aggregate, binder, patched trenches, tyre polish. */
export const ASPHALT = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 per = vec2(64.0);
  vec2 p = uv * per;
  vec3 w = worley(p, per);
  vec3 w2 = worley(p * 2.3 + 3.1, per * 2.3);
  float stone = smoothstep(0.62, 0.18, w.x) * step(0.35, w.z);
  float fine = smoothstep(0.55, 0.1, w2.x) * step(0.5, w2.z);
  float grime = fbm(uv * 6.0, vec2(6.0), 5);
  float patchN = fbm(uv * 1.5 + 0.3, vec2(1.5), 4);
  float patchA = smoothstep(0.56, 0.58, patchN);
  float crack = smoothstep(0.94, 0.985, ridged(uv * 4.0, vec2(4.0), 4)) * (0.4 + 0.6 * smoothstep(0.4, 0.7, grime));
  vec3 binder = mix(vec3(0.06, 0.06, 0.062), vec3(0.09, 0.088, 0.088), grime);
  binder = mix(binder, vec3(0.045, 0.045, 0.048), patchA * 0.8);
  vec3 stoneCol = mix(vec3(0.11, 0.107, 0.1), vec3(0.17, 0.165, 0.155), w.z);
  vec3 col = mix(binder, stoneCol, stone * (1.0 - patchA * 0.6) * 0.65);
  col = mix(col, vec3(0.12), fine * 0.3);
  col *= 1.0 - crack * 0.5;
  float h = stone * 0.35 + fine * 0.12 + grime * 0.25 - crack * 0.6 - patchA * 0.05;
  float r = mix(0.86, 0.72, stone) - patchA * 0.06;
  return S(col, h, r, 1.0 - crack * 0.5 - (1.0 - stone) * 0.1, 0.0);
}`;

/**
 * 2.4 m of interlocking concrete pavers (200 × 100 mm) in stretcher bond,
 * laid along the street: mixed warm and cool greys with a few dark brown
 * blocks, sanded joints, chewing-gum spots and foot polish.
 */
export const PAVERS = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 12.0, uv.y * 24.0);
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f) * vec2(0.2, 0.1);
  float d = min(e.x, e.y);
  float joint = 1.0 - smoothstep(0.002, 0.006, d);
  float bevel = smoothstep(0.0, 0.012, d);
  vec2 id2 = mod(cell, vec2(12.0, 24.0));
  float id = hash12(id2 + 3.7);
  float id2b = hash12(id2 + 11.1);
  vec3 cool = vec3(0.25, 0.255, 0.26);
  vec3 warm = vec3(0.33, 0.31, 0.28);
  vec3 dark = vec3(0.17, 0.15, 0.135);
  vec3 base = mix(cool, warm, step(0.55, id));
  base = mix(base, dark, step(0.86, id2b));
  base *= 0.88 + 0.24 * hash12(id2 + 5.3);
  vec3 w = worley(uv * 140.0, vec2(140.0));
  float speck = smoothstep(0.3, 0.06, w.x);
  float mottle = fbm(uv * 9.0, vec2(9.0), 4);
  base = mix(base, vec3(0.1), speck * 0.4 * step(0.6, w.z));
  base = mix(base, vec3(0.45), speck * 0.25 * step(w.z, 0.15));
  base *= 0.9 + 0.2 * mottle;
  float gum = smoothstep(0.08, 0.0, worley(uv * 9.0 + 2.0, vec2(9.0)).x) * step(0.8, worley(uv * 9.0 + 2.0, vec2(9.0)).z);
  base = mix(base, vec3(0.12, 0.12, 0.12), gum * 0.6);
  float traffic = fbm(uv * 2.0 + 5.0, vec2(2.0), 3);
  vec3 col = mix(base, vec3(0.09, 0.085, 0.08), joint);
  float h = bevel * 0.7 + mottle * 0.06 - joint * 0.3;
  float r = mix(0.72 - traffic * 0.14, 0.92, joint);
  return S(col, h, r, 1.0 - joint * 0.5, 0.0);
}`;

/**
 * 2.4 m of aluminium composite cladding: 1.2 m × 0.6 m white panels with
 * 15 mm recessed joints, faint streaks under the joints, a satin finish.
 */
export const PANEL = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 2.0, uv.y * 4.0);
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f) * vec2(1.2, 0.6);
  float d = min(e.x, e.y);
  float joint = 1.0 - smoothstep(0.004, 0.009, d);
  float lip = smoothstep(0.009, 0.02, d);
  vec2 cell = mod(floor(g), vec2(2.0, 4.0));
  float id = hash12(cell + 1.9);
  float n = fbm(uv * 6.0, vec2(6.0), 4);
  float streak = smoothstep(0.55, 0.9, fbm(vec2(uv.x * 26.0, uv.y * 1.0), vec2(26.0, 1.0), 4)) * (1.0 - f.y) ;
  vec3 col = vec3(0.78, 0.78, 0.765) * (0.97 + 0.05 * id) * (0.97 + 0.05 * n);
  col *= 1.0 - streak * 0.12;
  col = mix(col, vec3(0.2, 0.2, 0.21), joint);
  float h = lip * 0.5 - joint * 0.4 + n * 0.02;
  return S(col, h, mix(0.36 + 0.06 * n, 0.8, joint), 1.0 - joint * 0.5, 0.0);
}`;

/** 1 m of 45 × 95 mm glazed facade tiles in stack bond (older mid-rises). */
export const TILE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 10.0, uv.y * 20.0);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f) * vec2(0.1, 0.05);
  float d = min(e.x, e.y);
  float grout = 1.0 - smoothstep(0.003, 0.006, d);
  float id = hash12(mod(cell, vec2(10.0, 20.0)) + 0.7);
  float glaze = fbm(uv * 30.0, vec2(30.0), 3);
  vec3 tile = vec3(0.82, 0.8, 0.76) * (0.88 + 0.16 * id) * (0.95 + 0.08 * glaze);
  vec3 col = mix(tile, vec3(0.42, 0.41, 0.39), grout);
  float bevel = smoothstep(0.0, 0.008, d);
  return S(col, bevel * 0.6 - grout * 0.2, mix(0.3 + 0.12 * id, 0.85, grout), 1.0 - grout * 0.4, 0.0);
}`;

/** 3 m of fair-faced concrete (viaduct piers, alleys, backs of buildings). */
export const CONCRETE = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 4.0, vec2(4.0), 6);
  float m = fbm(uv * 1.0 + 7.0, vec2(1.0), 3);
  vec3 w = worley(uv * 180.0, vec2(180.0));
  float pore = smoothstep(0.18, 0.02, w.x) * step(0.7, w.z);
  float streak = smoothstep(0.5, 0.9, fbm(vec2(uv.x * 14.0, uv.y * 1.5), vec2(14.0, 1.5), 4));
  vec3 col = vec3(0.42, 0.415, 0.4) * (0.78 + 0.4 * n) * (0.85 + 0.25 * m);
  col *= 1.0 - pore * 0.45 - streak * 0.18;
  return S(col, n * 0.5 - pore * 0.6, 0.82 + 0.12 * n, 1.0 - pore * 0.4, 0.0);
}`;

/** 1.2 m of flamed granite (kerbs, the building plinth, the plaza edge). */
export const GRANITE = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 160.0, vec2(160.0));
  vec3 w2 = worley(uv * 360.0 + 7.1, vec2(360.0));
  float mid = fbm(uv * 20.0, vec2(20.0), 4);
  float biot = step(0.8, w.z) * smoothstep(0.55, 0.18, w.x);
  float felds = step(w.z, 0.3) * smoothstep(0.6, 0.2, w.x);
  float fine = step(0.88, w2.z) * smoothstep(0.5, 0.12, w2.x);
  vec3 col = mix(vec3(0.34, 0.335, 0.32), vec3(0.46, 0.45, 0.44), mid);
  col = mix(col, vec3(0.05), biot * 0.85);
  col = mix(col, vec3(0.6, 0.58, 0.55), felds * 0.5);
  col = mix(col, vec3(0.08), fine * 0.5);
  float h = mid * 0.3 + felds * 0.15 - biot * 0.1 + w2.x * 0.2;
  return S(col, h, 0.72 + 0.1 * mid, 1.0 - biot * 0.2, 0.0);
}`;

/** 1 m of brushed / anodised aluminium (mullions, frames, louvres, canopy edges). */
export const ALUMINIUM = /* glsl */ `
Surface surface(vec2 uv) {
  float brush = vnoise(vec2(uv.x * 4.0, uv.y * 600.0), vec2(4.0, 600.0));
  float n = fbm(uv * 8.0, vec2(8.0), 3);
  vec3 col = vec3(0.72, 0.73, 0.74) * (0.92 + 0.08 * brush) * (0.96 + 0.06 * n);
  return S(col, brush * 0.08, 0.32 + 0.12 * brush + 0.06 * n, 1.0, 0.85);
}`;
