/**
 * Dry daylight surfaces (GLSL bodies for Baker.surface). Each tile covers the
 * physical size noted next to it; materials set texture.repeat to 1 / size
 * because the geometry carries UVs in metres. Albedo is linear.
 */

/** 2 m of flamed light-grey granite: biotite, feldspar, quartz; slab-scale mottling. */
export const GRANITE = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 220.0, vec2(220.0));
  vec3 w2 = worley(uv * 480.0 + 7.1, vec2(480.0));
  float big = fbm(uv * 3.0, vec2(3.0), 4);
  float mid = fbm(uv * 26.0, vec2(26.0), 4);
  float biot = step(0.8, w.z) * smoothstep(0.55, 0.18, w.x);
  float felds = step(w.z, 0.28) * smoothstep(0.62, 0.22, w.x);
  float quartz = step(0.5, w.z) * step(w.z, 0.62) * smoothstep(0.5, 0.2, w.x);
  float fine = step(0.88, w2.z) * smoothstep(0.5, 0.12, w2.x);
  vec3 base = mix(vec3(0.33, 0.325, 0.31), vec3(0.45, 0.445, 0.43), mid) * (0.9 + 0.2 * big);
  vec3 col = mix(base, vec3(0.035, 0.035, 0.04), biot * 0.92);
  col = mix(col, vec3(0.6, 0.585, 0.56), felds * 0.55);
  col = mix(col, vec3(0.24, 0.245, 0.25), quartz * 0.5);
  col = mix(col, vec3(0.05), fine * 0.6);
  // Foot traffic grime and rain-dried dust in patches.
  float grime = smoothstep(0.5, 0.82, fbm(uv * 5.0 + 3.3, vec2(5.0), 5));
  col *= 1.0 - grime * 0.2;
  float h = mid * 0.3 + felds * 0.18 - biot * 0.12 + w2.x * 0.25;
  float r = 0.74 + 0.1 * mid - quartz * 0.12 + grime * 0.06;
  return S(col, h, r, 1.0 - biot * 0.25, 0.0);
}`;

/** 1.84 × 1.8 m of fired brick: 8 × 24 staggered courses, neutral recessed lime mortar. */
export function brickWallSurface(color: [number, number, number]): string {
  return /* glsl */ `
Surface surface(vec2 uv) {
  vec2 grid = uv * vec2(8.0, 24.0);
  grid.x += mod(floor(grid.y), 2.0) * 0.5;
  vec2 cell = floor(grid), f = fract(grid);
  vec2 edge = min(f, 1.0 - f) * vec2(0.23, 0.075);
  float grit = fbm(uv * 160.0, vec2(160.0), 4);
  float chip = smoothstep(0.58, 0.78, fbm(uv * 72.0, vec2(72.0), 3));
  float distanceToJoint = min(edge.x, edge.y) - chip * 0.002;
  float face = smoothstep(0.0035, 0.0065, distanceToJoint);
  float fired = hash12(mod(cell, vec2(8.0, 24.0)) + 19.0);
  float stain = smoothstep(0.48, 0.82, fbm(uv * vec2(16.0, 2.0), vec2(16.0, 2.0), 4));
  vec3 brick = vec3(${color.map(v => v.toFixed(6)).join(", ")}) * (0.72 + 0.43 * fired) * (0.84 + 0.22 * grit);
  brick *= 1.0 - 0.18 * stain;
  vec3 mortar = vec3(0.23, 0.225, 0.205) * (0.85 + 0.18 * grit);
  float height = face * 0.72 + grit * 0.075 - chip * face * 0.08;
  return S(mix(mortar, brick, face), height, mix(0.96, 0.84 + 0.1 * grit, face), mix(0.58, 1.0, face), 0.0);
}`;
}

/**
 * 2.4 m of rubble retaining wall (練積み): rounded field stones of mixed tone
 * bedded in grey mortar, lichen on the faces, moss low in the joints, water
 * streaks from the coping.
 */
export const RUBBLE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 q = uv + 0.05 * vec2(gnoise(uv * 6.0, vec2(6.0)), gnoise(uv * 6.0 + 4.1, vec2(6.0)));
  vec3 w = worley(q * vec2(7.0, 8.0), vec2(7.0, 8.0));
  float edge = w.y - w.x;
  float joint = 1.0 - smoothstep(0.02, 0.07, edge);
  float dome = sqrt(smoothstep(0.0, 0.5, edge));
  float surf = fbm(uv * 36.0, vec2(36.0), 5);
  float pits = fbm(uv * 120.0, vec2(120.0), 3);
  float tone = w.z;
  vec3 stone = mix(vec3(0.25, 0.235, 0.21), vec3(0.4, 0.39, 0.36), smoothstep(0.1, 0.9, tone));
  stone = mix(stone, vec3(0.33, 0.29, 0.23), step(0.82, tone) * 0.7);
  stone = mix(stone, vec3(0.2, 0.21, 0.2), step(tone, 0.12) * 0.6);
  stone *= 0.8 + 0.32 * surf + 0.1 * pits;
  float lichen = smoothstep(0.6, 0.78, fbm(uv * 10.0 + 1.7, vec2(10.0), 5)) * dome;
  stone = mix(stone, vec3(0.5, 0.52, 0.45), lichen * 0.35);
  float moss = smoothstep(0.45, 0.75, fbm(uv * 4.0 + 9.0, vec2(4.0), 5));
  vec3 mortar = mix(vec3(0.3, 0.295, 0.28), vec3(0.12, 0.16, 0.07), moss * 0.8);
  vec3 col = mix(stone, mortar, joint);
  float streak = smoothstep(0.5, 0.9, fbm(vec2(uv.x * 22.0, uv.y * 1.0), vec2(22.0, 1.0), 4));
  col *= 1.0 - streak * 0.22;
  float h = dome * 0.9 + surf * 0.14 + pits * 0.05 - joint * 0.25;
  return S(col, h, mix(0.8, 0.95, joint), 1.0 - joint * 0.45 - (1.0 - dome) * 0.15, 0.0);
}`;

/** 1.8 m of large cut granite blocks (0.9 × 0.45 m) in running bond, tooled faces. */
export const CUTSTONE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 2.0, uv.y * 4.0);
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f) * vec2(0.9, 0.45);
  float d = min(e.x, e.y);
  float joint = 1.0 - smoothstep(0.004, 0.012, d);
  float chamfer = smoothstep(0.0, 0.03, d);
  float id = hash12(mod(cell, vec2(2.0, 4.0)) + 5.0);
  float tool = vnoise(vec2(uv.x * 900.0, uv.y * 30.0), vec2(900.0, 30.0));
  float n = fbm(uv * 20.0, vec2(20.0), 5);
  vec3 w = worley(uv * 160.0, vec2(160.0));
  float speck = step(0.78, w.z) * smoothstep(0.5, 0.15, w.x);
  vec3 col = mix(vec3(0.27, 0.265, 0.25), vec3(0.37, 0.36, 0.34), id) * (0.84 + 0.3 * n);
  col = mix(col, vec3(0.05), speck * 0.7);
  float stain = smoothstep(0.55, 0.85, fbm(vec2(uv.x * 10.0, uv.y * 2.0) + 2.0, vec2(10.0, 2.0), 4));
  col *= 1.0 - stain * 0.3;
  col = mix(col, vec3(0.12, 0.12, 0.11), joint);
  float h = chamfer * 0.7 + tool * 0.08 + n * 0.1 - joint * 0.3;
  return S(col, h, 0.8 + 0.1 * n, 1.0 - joint * 0.55, 0.0);
}`;

/**
 * 3.6 m of fair-faced concrete (打ち放し): 1.8 × 0.9 m form panels with fine
 * seams, form-tie cones in a 0.6 × 0.45 m grid, lift marks and rain streaks.
 */
export const FORM_CONCRETE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 p = uv * 3.6;
  vec2 panel = vec2(p.x / 1.8, p.y / 0.9);
  vec2 pf = fract(panel);
  vec2 pe = min(pf, 1.0 - pf) * vec2(1.8, 0.9);
  float seam = 1.0 - smoothstep(0.0015, 0.005, min(pe.x, pe.y));
  float pid = hash12(mod(floor(panel), vec2(2.0, 4.0)) + 2.0);
  vec2 tp = fract(vec2((p.x + 0.3) / 0.6, (p.y + 0.225) / 0.45)) - 0.5;
  float tl = length(tp * vec2(0.6, 0.45));
  float tie = 1.0 - smoothstep(0.012, 0.016, tl);
  float ring = smoothstep(0.012, 0.016, tl) * (1.0 - smoothstep(0.016, 0.02, tl));
  float n = fbm(uv * 14.0, vec2(14.0), 6);
  float m = fbm(uv * 2.0 + 3.0, vec2(2.0), 4);
  vec3 w = worley(uv * 260.0, vec2(260.0));
  float pore = smoothstep(0.16, 0.03, w.x) * step(0.72, w.z);
  vec3 col = vec3(0.4, 0.4, 0.385) * (0.85 + 0.22 * n) * (0.92 + 0.14 * pid) * (0.9 + 0.2 * m);
  float streak = smoothstep(0.5, 0.88, fbm(vec2(uv.x * 30.0, uv.y * 2.0) + 7.0, vec2(30.0, 2.0), 4));
  float topDirt = smoothstep(0.6, 1.0, fract(panel.y)) * 0.1;
  col *= 1.0 - streak * 0.3 - topDirt;
  col *= 1.0 - pore * 0.5;
  col = mix(col, vec3(0.2, 0.2, 0.2), tie * 0.85);
  col *= 1.0 - seam * 0.35 - ring * 0.2;
  float h = n * 0.25 - pore * 0.5 - tie * 0.8 + ring * 0.2 - seam * 0.3;
  return S(col, h, 0.8 + 0.1 * n - tie * 0.2, 1.0 - tie * 0.6 - pore * 0.3, 0.0);
}`;

/** 2 m plain cast concrete (poles, foundations, gutters, curbs). */
export const CONCRETE = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 6.0, vec2(6.0), 6);
  float m = fbm(uv * 1.5 + 7.0, vec2(1.5), 3);
  vec3 w = worley(uv * 150.0, vec2(150.0));
  float pore = smoothstep(0.18, 0.02, w.x) * step(0.7, w.z);
  vec3 col = vec3(0.42, 0.415, 0.4) * (0.78 + 0.4 * n) * (0.85 + 0.25 * m);
  float streak = smoothstep(0.55, 0.9, fbm(vec2(uv.x * 16.0, uv.y * 1.0), vec2(16.0, 1.0), 4));
  col *= 1.0 - streak * 0.22;
  col *= 1.0 - pore * 0.5;
  return S(col, n * 0.5 - pore * 0.6, 0.82 + 0.12 * n, 1.0 - pore * 0.4, 0.0);
}`;

/**
 * 1 m of fibre-cement lap siding (窯業系サイディング): 0.2 m courses with a
 * shadow groove and a faint embossed wood grain. White; materials tint it.
 */
export const SIDING = /* glsl */ `
Surface surface(vec2 uv) {
  float c = fract(uv.y * 5.0);
  float groove = 1.0 - smoothstep(0.0, 0.05, c);
  float lip = smoothstep(0.93, 1.0, c);
  float profile = c * 0.6 - groove * 0.9 + lip * 0.3;
  float grain = vnoise(vec2(uv.x * 30.0, uv.y * 400.0), vec2(30.0, 400.0));
  float dirt = fbm(uv * vec2(3.0, 6.0), vec2(3.0, 6.0), 4);
  vec3 col = vec3(0.78, 0.775, 0.76) * (0.95 + 0.06 * grain) * (1.0 - 0.1 * smoothstep(0.55, 0.85, dirt));
  col *= 1.0 - groove * 0.45;
  return S(col, profile + grain * 0.04, 0.72 + 0.1 * grain, 1.0 - groove * 0.5, 0.0);
}`;

/** 4 m of dry, sun-bleached asphalt: aggregate, patches, sealed cracks, oil spots. */
export const ASPHALT = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 per = vec2(72.0);
  vec3 w = worley(uv * 72.0, per);
  vec3 w2 = worley(uv * 170.0 + 3.1, vec2(170.0));
  float stone = smoothstep(0.62, 0.2, w.x) * step(0.3, w.z);
  float fine = smoothstep(0.55, 0.1, w2.x) * step(0.45, w2.z);
  float grime = fbm(uv * 6.0, vec2(6.0), 5);
  float patchA = smoothstep(0.56, 0.58, fbm(uv * 2.0 + 0.3, vec2(2.0), 4));
  float crack = smoothstep(0.935, 0.985, ridged(uv * 5.0, vec2(5.0), 4)) * (0.4 + 0.6 * smoothstep(0.4, 0.7, grime));
  float oil = smoothstep(0.7, 0.85, fbm(uv * 3.0 + 5.5, vec2(3.0), 4));
  vec3 binder = mix(vec3(0.085, 0.085, 0.088), vec3(0.13, 0.128, 0.126), grime);
  binder = mix(binder, vec3(0.07, 0.07, 0.072), patchA * 0.6);
  vec3 stoneCol = mix(vec3(0.17, 0.165, 0.16), vec3(0.3, 0.29, 0.28), w.z);
  vec3 col = mix(binder, stoneCol, stone * (1.0 - patchA * 0.6) * 0.7);
  col = mix(col, vec3(0.2, 0.2, 0.19), fine * 0.35);
  col = mix(col, vec3(0.03, 0.03, 0.03), crack * 0.8);
  col *= 1.0 - oil * 0.25;
  float h = stone * 0.4 + fine * 0.14 + grime * 0.2 - crack * 0.6 - patchA * 0.05;
  float r = mix(0.9, 0.78, stone) - patchA * 0.06 - oil * 0.2;
  return S(col, h, r, 1.0 - crack * 0.6 - (1.0 - stone) * 0.12, 0.0);
}`;

/** 1 m of painted standing-seam sheet metal (seams every 0.4 m along v). */
export const SHEET_ROOF = /* glsl */ `
Surface surface(vec2 uv) {
  float s = fract(uv.x * 2.5);
  float seam = smoothstep(0.03, 0.0, min(s, 1.0 - s));
  float pan = fbm(uv * vec2(10.0, 2.0), vec2(10.0, 2.0), 4);
  float rust = smoothstep(0.7, 0.85, fbm(uv * 6.0 + 2.0, vec2(6.0), 5));
  float dust = fbm(uv * 3.0 + 1.0, vec2(3.0), 4);
  vec3 col = vec3(0.7) * (0.9 + 0.15 * pan) * (1.0 - 0.15 * dust);
  col = mix(col, vec3(0.3, 0.14, 0.06), rust * 0.6);
  return S(col, seam * 1.2 + pan * 0.05, 0.42 + 0.2 * dust + rust * 0.3, 1.0 - 0.2 * smoothstep(0.5, 1.0, s), 0.35 * (1.0 - rust));
}`;

/**
 * 1.2 m of glazed J-shaped clay roof tiles (釉薬瓦): 0.3 m wide rolls, 0.24 m
 * exposed courses. White; materials tint it (blue, silver-grey).
 */
export const TILE_ROOF = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 4.0, uv.y * 5.0);
  float row = floor(g.y);
  float fx = fract(g.x);
  float fy = fract(g.y);
  float roll = sin(fx * 3.14159);
  float lap = smoothstep(0.0, 0.08, fy) * (1.0 - smoothstep(0.9, 1.0, fy) * 0.6);
  float id = hash12(vec2(mod(floor(g.x), 4.0), mod(row, 5.0)) + 9.0);
  float glaze = fbm(uv * 30.0, vec2(30.0), 3);
  vec3 col = vec3(0.8) * (0.86 + 0.18 * id) * (0.92 + 0.12 * glaze);
  float shade = 1.0 - (1.0 - lap) * 0.55;
  col *= shade * (0.8 + 0.2 * roll);
  float h = roll * 0.7 + fy * 0.25 - (1.0 - lap) * 0.4;
  return S(col, h, 0.22 + 0.15 * glaze + (1.0 - lap) * 0.4, 0.55 + 0.45 * lap, 0.0);
}`;

/** 1 m of cherry bark: grey-brown, horizontal lenticel bands, rough plates. */
export const BARK = /* glsl */ `
Surface surface(vec2 uv) {
  float bands = vnoise(vec2(uv.x * 4.0, uv.y * 60.0), vec2(4.0, 60.0));
  float lent = smoothstep(0.72, 0.9, vnoise(vec2(uv.x * 18.0, uv.y * 140.0), vec2(18.0, 140.0))) * smoothstep(0.4, 0.8, bands);
  float plates = fbm(uv * vec2(6.0, 14.0), vec2(6.0, 14.0), 5);
  float moss = smoothstep(0.62, 0.8, fbm(uv * 3.0 + 4.0, vec2(3.0), 4));
  vec3 col = mix(vec3(0.07, 0.055, 0.05), vec3(0.16, 0.13, 0.115), plates);
  col = mix(col, vec3(0.28, 0.24, 0.2), lent * 0.6);
  col = mix(col, vec3(0.12, 0.16, 0.06), moss * 0.5);
  return S(col, plates * 0.8 - lent * 0.3, 0.88, 0.85 + 0.15 * plates, 0.0);
}`;

/** Fine horizontal brushing, subtle sheet variation and accumulated surface dirt. */
export const STAINLESS = /* glsl */ `
Surface surface(vec2 uv) {
  float brush = vnoise(uv * vec2(3.0, 480.0), vec2(3.0, 480.0));
  float broad = fbm(uv * vec2(2.0, 18.0), vec2(2.0, 18.0), 3);
  float dirt = smoothstep(0.58, 0.85, fbm(uv * vec2(12.0, 2.0), vec2(12.0, 2.0), 3));
  vec3 col = vec3(0.64, 0.67, 0.68) * (0.94 + brush * 0.08 + broad * 0.04 - dirt * 0.1);
  return S(col, brush * 0.12, 0.31 + brush * 0.13 + dirt * 0.16, 1.0, 0.84 - dirt * 0.15);
}`;

/** 1 m of painted steel with chalking, chips and a little rust (tinted per use). */
export const PAINT = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 8.0, vec2(8.0), 5);
  float chip = smoothstep(0.74, 0.78, fbm(uv * 14.0 + 5.0, vec2(14.0), 5));
  float rust = smoothstep(0.78, 0.9, fbm(uv * 9.0 + 2.0, vec2(9.0), 5)) * (0.3 + chip);
  float chalk = fbm(uv * vec2(2.0, 12.0) + 1.0, vec2(2.0, 12.0), 4);
  vec3 col = vec3(1.0) * (0.92 + 0.1 * n) * (1.0 + 0.08 * smoothstep(0.5, 0.85, chalk));
  col = mix(col, vec3(0.2, 0.19, 0.18), chip * 0.7);
  col = mix(col, vec3(0.24, 0.1, 0.04), clamp(rust, 0.0, 1.0) * 0.8);
  return S(col, -chip * 0.4 + n * 0.08, mix(0.42 + 0.18 * n + 0.1 * chalk, 0.8, max(chip, rust)), 1.0, chip * 0.35);
}`;

/** 1 m of sprayed stucco (吹付け): fine bumps, faint trowel lines. White; tinted per use. */
export const STUCCO = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 90.0, vec2(90.0));
  float bump = smoothstep(0.55, 0.0, w.x);
  float n = fbm(uv * 12.0, vec2(12.0), 5);
  float dirt = smoothstep(0.55, 0.85, fbm(vec2(uv.x * 8.0, uv.y * 1.0) + 3.0, vec2(8.0, 1.0), 4));
  vec3 col = vec3(0.76, 0.75, 0.72) * (0.94 + 0.08 * n) * (1.0 - 0.18 * dirt);
  return S(col, bump * 0.6 + n * 0.2, 0.88, 0.85 + 0.15 * bump, 0.0);
}`;

/** 1.6 m of 390 × 190 mm concrete block wall (ブロック塀) with capping course. */
export const BLOCK = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 1.6 / 0.4, uv.y * 1.6 / 0.2);
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f) * vec2(0.4, 0.2);
  float joint = 1.0 - smoothstep(0.004, 0.008, min(e.x, e.y));
  float id = hash12(mod(floor(g), vec2(4.0, 8.0)) + 1.0);
  float n = fbm(uv * 20.0, vec2(20.0), 5);
  vec3 w = worley(uv * 200.0, vec2(200.0));
  float pore = smoothstep(0.2, 0.05, w.x) * step(0.6, w.z);
  float streak = smoothstep(0.5, 0.9, fbm(vec2(uv.x * 12.0, uv.y * 1.0), vec2(12.0, 1.0), 4));
  vec3 col = vec3(0.4, 0.395, 0.38) * (0.88 + 0.16 * id) * (0.85 + 0.25 * n);
  col *= 1.0 - pore * 0.4 - streak * 0.25;
  col = mix(col, vec3(0.3, 0.3, 0.29), joint);
  return S(col, n * 0.3 - joint * 0.5 - pore * 0.4, 0.9, 1.0 - joint * 0.5, 0.0);
}`;

/** 3 m of shaded terrace ground: packed soil, leaf litter, moss, a few weeds. */
export const GROUND = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 8.0, vec2(8.0), 6);
  float moss = smoothstep(0.5, 0.75, fbm(uv * 3.0 + 2.0, vec2(3.0), 5));
  vec3 w = worley(uv * 60.0, vec2(60.0));
  vec3 w2 = worley(uv * 140.0 + 3.0, vec2(140.0));
  float leaf = step(0.4, w.z) * smoothstep(0.38, 0.12, w.x);
  float leaf2 = step(0.5, w2.z) * smoothstep(0.4, 0.15, w2.x);
  float weed = smoothstep(0.7, 0.8, vnoise(uv * 300.0, vec2(300.0))) * moss;
  vec3 soil = mix(vec3(0.07, 0.055, 0.04), vec3(0.14, 0.11, 0.075), n);
  vec3 col = mix(soil, vec3(0.07, 0.1, 0.035), moss * 0.7);
  col = mix(col, mix(vec3(0.22, 0.15, 0.08), vec3(0.3, 0.24, 0.12), w.z), leaf * 0.75);
  col = mix(col, vec3(0.16, 0.12, 0.07), leaf2 * 0.5);
  col = mix(col, vec3(0.1, 0.17, 0.04), weed);
  return S(col, n * 0.6 + leaf * 0.25 + leaf2 * 0.15 + weed * 0.2, 0.9, 0.75 + 0.25 * n, 0.0);
}`;

/** 2.4 m of staggered fired-clay paving: 200 x 100 mm bricks with worn mortar. */
export const BRICK_PAVING = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 q=uv.yx*vec2(12.0,24.0);
  float row=floor(q.y); q.x+=mod(row,2.0)*0.5;
  vec2 id=floor(q),f=fract(q);
  float tone=hash12(id);
  vec2 edge=min(f,1.0-f)*vec2(0.2,0.1);
  float mortar=1.0-smoothstep(0.002,0.0045,min(edge.x,edge.y));
  float grain=fbm(uv*70.0,vec2(70.0),4);
  float stain=fbm(uv*4.0,vec2(4.0),4);
  vec3 clay=mix(vec3(0.095,0.029,0.021),vec3(0.205,0.070,0.047),tone);
  clay*=0.75+grain*0.32+stain*0.18;
  vec3 joint=vec3(0.23,0.22,0.19)*(0.86+0.16*grain);
  float worn=smoothstep(0.83,0.98,tone)*smoothstep(0.007,0.015,min(edge.x,edge.y));
  clay=mix(clay,clay*1.35,worn*0.25);
  return S(mix(clay,joint,mortar),grain*0.06-mortar*0.12,0.80+grain*0.12,1.0-mortar*0.20,0.0);
}`;
