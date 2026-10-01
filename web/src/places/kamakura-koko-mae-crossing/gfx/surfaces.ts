/**
 * Seaside daylight surfaces (GLSL bodies for Baker.surface). Each tile covers
 * the physical size noted next to it; materials set texture.repeat to
 * 1 / size because the geometry carries UVs in metres. Albedo is linear.
 */

/** 4 m of sun-bleached, salt-dusted asphalt: light aggregate, sealed cracks, patches. */
export const ASPHALT = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 130.0, vec2(130.0));
  vec3 w2 = worley(uv * 260.0 + 3.1, vec2(260.0));
  float stone = smoothstep(0.62, 0.2, w.x) * step(0.25, w.z) * 0.7;
  float fine = smoothstep(0.55, 0.1, w2.x) * step(0.4, w2.z);
  float grime = fbm(uv * 6.0, vec2(6.0), 5);
  float wear = fbm(uv * 1.5 + 4.0, vec2(1.5), 4);
  float patchA = smoothstep(0.66, 0.68, fbm(uv * 2.0 + 0.3, vec2(2.0), 4)) * 0.6;
  // Sealed cracks: short and rare (long ridges read as lines converging down the road).
  float crack = smoothstep(0.985, 0.998, ridged(uv * 4.0, vec2(4.0), 4)) * smoothstep(0.6, 0.8, grime);
  vec3 binder = mix(vec3(0.088, 0.083, 0.073), vec3(0.112, 0.105, 0.092), grime) * (0.96 + 0.08 * wear);
  binder = mix(binder, vec3(0.075, 0.074, 0.072), patchA * 0.5);
  vec3 stoneCol = mix(vec3(0.14, 0.132, 0.118), vec3(0.22, 0.207, 0.185), w.z);
  vec3 col = mix(binder, stoneCol, stone * (1.0 - patchA * 0.7) * 0.75);
  col = mix(col, vec3(0.19, 0.18, 0.17), fine * 0.35);
  col = mix(col, vec3(0.05, 0.05, 0.05), crack * 0.35);
  float h = stone * 0.4 + fine * 0.14 + grime * 0.2 - crack * 0.6 - patchA * 0.05;
  float r = mix(0.9, 0.8, stone) - patchA * 0.05;
  return S(col, h, r, 1.0 - crack * 0.6 - (1.0 - stone) * 0.1, 0.0);
}`;

/** 2 m of plain cast concrete (kerbs, sea wall, walls, sleepers, poles). */
export const CONCRETE = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 6.0, vec2(6.0), 6);
  float m = fbm(uv * 1.5 + 7.0, vec2(1.5), 3);
  vec3 w = worley(uv * 150.0, vec2(150.0));
  float pore = smoothstep(0.18, 0.02, w.x) * step(0.7, w.z);
  vec3 col = vec3(0.46, 0.45, 0.43) * (0.82 + 0.32 * n) * (0.88 + 0.2 * m);
  float streak = smoothstep(0.55, 0.9, fbm(vec2(uv.x * 16.0, uv.y * 1.0), vec2(16.0, 1.0), 4));
  col *= 1.0 - streak * 0.18;
  col *= 1.0 - pore * 0.45;
  return S(col, n * 0.5 - pore * 0.6, 0.84 + 0.1 * n, 1.0 - pore * 0.4, 0.0);
}`;

/**
 * 2.4 m of rock-faced masonry retaining wall (間知石積み): split stones laid
 * in a diagonal pattern, dark grey-brown with salt bloom and plants low in
 * the joints.
 */
export const RUBBLE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 q = uv + 0.04 * vec2(gnoise(uv * 6.0, vec2(6.0)), gnoise(uv * 6.0 + 4.1, vec2(6.0)));
  vec3 w = worley(q * vec2(9.0, 10.0), vec2(9.0, 10.0));
  float edge = w.y - w.x;
  float joint = 1.0 - smoothstep(0.01, 0.045, edge);
  float face = sqrt(smoothstep(0.0, 0.45, edge));
  float split = fbm(uv * 30.0, vec2(30.0), 5);
  float pits = fbm(uv * 110.0, vec2(110.0), 3);
  float tone = w.z;
  vec3 stone = mix(vec3(0.11, 0.105, 0.1), vec3(0.21, 0.2, 0.185), smoothstep(0.1, 0.9, tone));
  stone = mix(stone, vec3(0.2, 0.17, 0.135), step(0.85, tone) * 0.6);
  stone *= 0.75 + 0.4 * split + 0.12 * pits;
  float salt = smoothstep(0.62, 0.8, fbm(uv * 8.0 + 1.7, vec2(8.0), 5)) * face;
  stone = mix(stone, vec3(0.42, 0.41, 0.38), salt * 0.3);
  float weeds = smoothstep(0.5, 0.75, fbm(uv * 4.0 + 9.0, vec2(4.0), 5));
  vec3 mortar = mix(vec3(0.09, 0.088, 0.083), vec3(0.06, 0.09, 0.035), weeds * 0.7);
  vec3 col = mix(stone, mortar, joint);
  float h = face * 0.9 + split * 0.25 + pits * 0.05 - joint * 0.3;
  return S(col, h, mix(0.82, 0.95, joint), 1.0 - joint * 0.5 - (1.0 - face) * 0.15, 0.0);
}`;

/**
 * 1.8 m of beige split-face stone cladding (石積み調): courses of 0.12–0.3 m
 * with random lengths, recessed dark joints, warm sandstone tones.
 */
export const STONE_CLAD = /* glsl */ `
Surface surface(vec2 uv) {
  float y = uv.y * 1.8;
  float row = floor(y / 0.2);
  float ry = fract(y / 0.2);
  float shift = hash12(vec2(mod(row, 9.0), 3.0));
  float x = uv.x * 1.8 / (0.35 + 0.3 * hash12(vec2(mod(row, 9.0), 7.0))) + shift * 4.0;
  float cx = floor(x);
  float rx = fract(x);
  float id = hash12(vec2(mod(cx, 16.0), mod(row, 9.0)));
  vec2 e = vec2(min(rx, 1.0 - rx) * 0.4, min(ry, 1.0 - ry) * 0.2);
  float d = min(e.x, e.y);
  float joint = 1.0 - smoothstep(0.004, 0.012, d);
  float bevel = smoothstep(0.0, 0.03, d);
  float split = fbm(uv * 40.0, vec2(40.0), 5);
  vec3 a = vec3(0.58, 0.5, 0.39);
  vec3 b = vec3(0.45, 0.38, 0.3);
  vec3 c = vec3(0.66, 0.6, 0.5);
  vec3 col = id < 0.4 ? mix(a, b, id / 0.4) : mix(a, c, (id - 0.4) / 0.6);
  col *= 0.82 + 0.3 * split;
  col = mix(col, vec3(0.13, 0.12, 0.1), joint);
  float h = bevel * 0.8 + split * 0.3 - joint * 0.3;
  return S(col, h, 0.85, 1.0 - joint * 0.5, 0.0);
}`;

/**
 * 1.13 m of decorative cast-block wall (化粧ブロック): 0.4 × 0.2 m blocks laid
 * on the diagonal, light grey with streaks (the walls on the park side). The
 * diagonal lattice repeats every 1.13 m (two blocks along, four courses up).
 */
export const BLOCK = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 r = vec2(uv.x + uv.y, uv.y - uv.x) * 0.8;
  vec2 g = vec2(r.x / 0.4, r.y / 0.2);
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f) * vec2(0.4, 0.2);
  float joint = 1.0 - smoothstep(0.004, 0.009, min(e.x, e.y));
  float id = hash12(floor(g) * 0.37);
  float n = fbm(uv * 20.0, vec2(20.0), 5);
  float streak = smoothstep(0.5, 0.9, fbm(vec2(uv.x * 12.0, uv.y * 1.0), vec2(12.0, 1.0), 4));
  vec3 col = vec3(0.36, 0.355, 0.34) * (0.86 + 0.14 * id) * (0.86 + 0.24 * n);
  col *= 1.0 - streak * 0.2;
  col = mix(col, vec3(0.3, 0.3, 0.29), joint);
  return S(col, n * 0.3 - joint * 0.5, 0.9, 1.0 - joint * 0.5, 0.0);
}`;

/** 2 m of track ballast: crushed grey-brown stone, rust-stained near the rails. */
export const BALLAST = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 36.0, vec2(36.0));
  vec3 w2 = worley(uv * 80.0 + 5.0, vec2(80.0));
  float edge = w.y - w.x;
  float rock = sqrt(smoothstep(0.0, 0.35, edge));
  float rock2 = smoothstep(0.0, 0.3, w2.y - w2.x);
  float tone = w.z;
  vec3 col = mix(vec3(0.2, 0.18, 0.16), vec3(0.38, 0.34, 0.3), tone) * (0.55 + 0.45 * rock);
  col = mix(col, vec3(0.32, 0.2, 0.12), smoothstep(0.6, 0.85, fbm(uv * 3.0, vec2(3.0), 4)) * 0.4);
  col *= 0.85 + 0.15 * rock2;
  return S(col, rock * 0.8 + rock2 * 0.3, 0.92, 0.55 + 0.45 * rock, 0.0);
}`;

/** 6 m of beach sand (七里ヶ浜): dark grey-beige iron sand, wind ripples, footprints. */
export const SAND = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 10.0, vec2(10.0), 6);
  float big = fbm(uv * 2.0 + 3.0, vec2(2.0), 4);
  float rip = sin((uv.y * 60.0 + gnoise(uv * 4.0, vec2(4.0)) * 3.0) * 6.2831) * 0.5 + 0.5;
  vec3 w = worley(uv * 18.0, vec2(18.0));
  float print = smoothstep(0.22, 0.12, w.x) * step(0.75, w.z);
  vec3 col = mix(vec3(0.22, 0.2, 0.17), vec3(0.34, 0.31, 0.26), n) * (0.88 + 0.2 * big);
  col *= 0.94 + 0.08 * rip;
  col *= 1.0 - print * 0.12;
  return S(col, rip * 0.25 + n * 0.3 - print * 0.3, 0.95, 1.0, 0.0);
}`;

/** 3 m of sunny garden ground: grass in clumps over sandy soil. */
export const GROUND = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 8.0, vec2(8.0), 6);
  float clumps = smoothstep(0.35, 0.65, fbm(uv * 3.0 + 2.0, vec2(3.0), 5));
  float blade = vnoise(uv * vec2(400.0, 120.0), vec2(400.0, 120.0));
  vec3 soil = mix(vec3(0.11, 0.095, 0.07), vec3(0.19, 0.165, 0.125), n);
  vec3 grass = mix(vec3(0.04, 0.07, 0.025), vec3(0.11, 0.15, 0.05), blade) * (0.8 + 0.4 * n);
  vec3 col = mix(soil, grass, clumps);
  return S(col, n * 0.5 + clumps * blade * 0.4, 0.92, 0.75 + 0.25 * n, 0.0);
}`;

/** 1 m of sprayed stucco (吹付け): fine bumps; white, tinted per use. */
export const STUCCO = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 90.0, vec2(90.0));
  float bump = smoothstep(0.55, 0.0, w.x);
  float n = fbm(uv * 12.0, vec2(12.0), 5);
  float dirt = smoothstep(0.6, 0.9, fbm(vec2(uv.x * 8.0, uv.y * 1.0) + 3.0, vec2(8.0, 1.0), 4));
  vec3 col = vec3(0.86, 0.85, 0.83) * (0.95 + 0.06 * n) * (1.0 - 0.12 * dirt);
  return S(col, bump * 0.6 + n * 0.2, 0.86, 0.88 + 0.12 * bump, 0.0);
}`;

/** 2 m of hedge and shrub mass seen from a distance: clustered leaves, dark gaps. */
export const SHRUB = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 40.0, vec2(40.0));
  vec3 w2 = worley(uv * 90.0 + 2.0, vec2(90.0));
  float leaf = smoothstep(0.6, 0.15, w.x);
  float leaf2 = smoothstep(0.55, 0.1, w2.x);
  float n = fbm(uv * 5.0, vec2(5.0), 4);
  vec3 col = mix(vec3(0.025, 0.045, 0.015), vec3(0.11, 0.17, 0.05), leaf * (0.6 + 0.4 * w.z));
  col = mix(col, vec3(0.16, 0.22, 0.08), leaf2 * 0.35 * w2.z);
  col *= 0.8 + 0.4 * n;
  return S(col, leaf * 0.7 + leaf2 * 0.3, 0.75, 0.5 + 0.5 * leaf, 0.0);
}`;
