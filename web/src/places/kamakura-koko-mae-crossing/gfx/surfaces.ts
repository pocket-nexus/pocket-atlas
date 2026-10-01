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
  vec3 col = vec3(0.34, 0.333, 0.318) * (0.82 + 0.32 * n) * (0.88 + 0.2 * m);
  float streak = smoothstep(0.55, 0.9, fbm(vec2(uv.x * 16.0, uv.y * 1.0), vec2(16.0, 1.0), 4));
  col *= 1.0 - streak * 0.18;
  col *= 1.0 - pore * 0.45;
  return S(col, n * 0.5 - pore * 0.6, 0.84 + 0.1 * n, 1.0 - pore * 0.4, 0.0);
}`;

/**
 * 2.4 m of random rubble masonry (雑割石積み), the retaining walls under the
 * villas: dark grey andesite and brown tuff stones of 25–45 cm with domed,
 * split faces, set in wide light-grey mortar; run-off streaks below the
 * joints, salt bloom on the stone faces, moss low in the mortar.
 */
export const RUBBLE = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 q = uv + 0.035 * vec2(gnoise(uv * 6.0, vec2(6.0)), gnoise(uv * 6.0 + 4.1, vec2(6.0)));
  vec3 w = worley(q * vec2(5.0, 8.0), vec2(5.0, 8.0));
  float edge = w.y - w.x;
  float jw = 0.025 + 0.035 * hash12(vec2(floor(w.z * 97.0), 3.0));
  float gap = 1.0 - smoothstep(jw, jw + 0.05, edge);
  // Chinking: small stones packed into the wider joints.
  vec3 c = worley(uv * vec2(22.0, 30.0), vec2(22.0, 30.0));
  float chink = gap * smoothstep(0.02, 0.12, c.y - c.x) * step(0.35, c.z);
  float joint = gap * (1.0 - chink);
  float face = smoothstep(0.02, 0.5, edge);
  float dome = sqrt(clamp(edge * 2.0, 0.0, 1.0));
  // Split faces: coarse facets, pitting and lichen, different per stone.
  float facet = fbm(uv * 12.0 + w.z * 31.0, vec2(12.0), 4);
  float split = fbm(uv * 34.0, vec2(34.0), 5);
  float grain = fbm(uv * 120.0, vec2(120.0), 3);
  float tone = w.z;
  vec3 stone = mix(vec3(0.07, 0.066, 0.06), vec3(0.17, 0.155, 0.13), smoothstep(0.1, 0.95, tone));
  stone = mix(stone, vec3(0.2, 0.15, 0.1), step(0.78, tone) * 0.8);
  stone = mix(stone, vec3(0.045, 0.045, 0.047), step(tone, 0.16) * 0.75);
  stone *= 0.45 + 0.95 * facet + 0.3 * (split - 0.5) + 0.12 * grain;
  // Weathered arrises: stone edges paler than the faces.
  stone *= 1.0 + (1.0 - face) * 0.25;
  float lichen = smoothstep(0.7, 0.85, fbm(uv * 16.0 + 3.3, vec2(16.0), 4)) * face;
  stone = mix(stone, vec3(0.24, 0.24, 0.2), lichen * 0.45);
  float streak = smoothstep(0.5, 0.85, fbm(vec2(uv.x * 22.0, uv.y * 1.0), vec2(22.0, 1.0), 4));
  stone *= 1.0 - streak * 0.35;
  vec3 chinkCol = mix(vec3(0.06, 0.058, 0.055), vec3(0.14, 0.13, 0.11), c.z) * (0.7 + 0.6 * grain);
  vec3 mortar = vec3(0.17, 0.165, 0.155) * (0.75 + 0.4 * grain);
  mortar = mix(mortar, mortar * 0.5, streak * 0.8);
  float moss = smoothstep(0.58, 0.8, fbm(uv * 5.0 + 9.0, vec2(5.0), 4));
  mortar = mix(mortar, vec3(0.045, 0.07, 0.025), moss * 0.65);
  vec3 col = mix(stone, mortar, joint);
  col = mix(col, chinkCol, chink);
  float h = dome * 0.6 + facet * 0.8 + split * 0.3 + grain * 0.06 - joint * 0.6 + chink * 0.2;
  return S(col, h, mix(0.82, 0.95, joint), 1.0 - joint * 0.45 - (1.0 - face) * 0.15, 0.0);
}`;

/**
 * 1.8 m of split-face ashlar cladding (乱形石張り) on the villa bases and the
 * garage: 0.3 m courses, 3–6 blocks a course, half the blocks split into two
 * 0.15 m pieces; cream, tan, warm grey and pinkish sandstone, recessed joints.
 */
export const STONE_CLAD = /* glsl */ `
Surface surface(vec2 uv) {
  float y = uv.y * 6.0;
  float row = floor(y);
  float ry = fract(y);
  float n = 3.0 + floor(hash12(vec2(row, 3.7)) * 4.0);
  float x = uv.x * n + floor(hash12(vec2(row, 9.1)) * n) + 0.5 * hash12(vec2(row, 2.2));
  float cx = mod(floor(x), n);
  float rx = fract(x);
  float id = hash12(vec2(cx + 0.37, row + 1.9));
  float halves = step(0.55, id);
  float sy = mix(ry, fract(ry * 2.0), halves);
  float hh = mix(0.3, 0.15, halves);
  float id2 = mix(id, hash12(vec2(cx + floor(ry * 2.0) * 7.1, row + 4.3)), halves);
  float bw = 1.8 / n;
  vec2 e = vec2(min(rx, 1.0 - rx) * bw, min(sy, 1.0 - sy) * hh);
  float d = min(e.x, e.y);
  float joint = 1.0 - smoothstep(0.004, 0.011, d);
  float bevel = smoothstep(0.0, 0.035, d);
  float rough = fbm(uv * 40.0, vec2(40.0), 5);
  float fine = fbm(uv * 160.0, vec2(160.0), 2);
  vec3 cream = vec3(0.6, 0.53, 0.41);
  vec3 tanc = vec3(0.47, 0.38, 0.28);
  vec3 grey = vec3(0.46, 0.44, 0.4);
  vec3 pink = vec3(0.58, 0.47, 0.4);
  vec3 col = id2 < 0.35 ? mix(cream, tanc, id2 / 0.35) : (id2 < 0.7 ? mix(cream, grey, (id2 - 0.35) / 0.35) : mix(tanc, pink, (id2 - 0.7) / 0.3));
  col *= 0.8 + 0.3 * rough + 0.08 * fine;
  float stain = smoothstep(0.55, 0.9, fbm(vec2(uv.x * 10.0, uv.y * 1.0), vec2(10.0, 1.0), 4));
  col *= 1.0 - stain * 0.18;
  col = mix(col, vec3(0.12, 0.105, 0.09), joint);
  float h = bevel * 0.65 + rough * 0.4 + fine * 0.05 - joint * 0.3;
  return S(col, h, 0.88, 1.0 - joint * 0.55, 0.0);
}`;

/**
 * 1.2 m of brown stacked ledgestone (積み石調) on the round-tower villa's
 * columns: 75 mm courses of long thin stones, each set proud or back by a
 * few centimetres, dark gaps; brown, umber and grey-brown.
 */
export const LEDGE = /* glsl */ `
Surface surface(vec2 uv) {
  float y = uv.y * 16.0;
  float row = floor(y);
  float ry = fract(y);
  float n = 3.0 + floor(hash12(vec2(row, 1.3)) * 4.0);
  float x = uv.x * n + floor(hash12(vec2(row, 5.7)) * n) + 0.5 * hash12(vec2(row, 8.8));
  float cx = mod(floor(x), n);
  float rx = fract(x);
  float id = hash12(vec2(cx + 0.71, row + 3.3));
  float bw = 1.2 / n;
  vec2 e = vec2(min(rx, 1.0 - rx) * bw, min(ry, 1.0 - ry) * 0.075);
  float d = min(e.x, e.y);
  float gap = 1.0 - smoothstep(0.003, 0.009, d);
  float proud = hash12(vec2(cx + 3.1, row + 0.6));
  float rough = fbm(uv * vec2(60.0, 30.0), vec2(60.0, 30.0), 4);
  vec3 a = vec3(0.2, 0.14, 0.095);
  vec3 b = vec3(0.3, 0.24, 0.18);
  vec3 c = vec3(0.24, 0.22, 0.2);
  vec3 col = id < 0.5 ? mix(a, b, id * 2.0) : mix(b, c, (id - 0.5) * 2.0);
  col *= 0.75 + 0.45 * rough;
  col *= 0.85 + 0.25 * proud;
  col = mix(col, vec3(0.02, 0.018, 0.016), gap);
  float h = proud * 0.7 + smoothstep(0.0, 0.02, d) * 0.4 + rough * 0.3 - gap * 0.8;
  return S(col, h, 0.86, 1.0 - gap * 0.75 - (1.0 - proud) * 0.12, 0.0);
}`;

/**
 * 1.13 m of cast-block retaining wall (間知ブロック): 0.4 × 0.2 m faces laid on
 * the diagonal, warm light grey with darker joints, rust and run-off streaks
 * (the walls under the villas west of the slope and up the hill, p09). The
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
  float d = min(e.x, e.y);
  float joint = 1.0 - smoothstep(0.005, 0.012, d);
  float bevel = smoothstep(0.0, 0.03, d);
  float id = hash12(floor(g) * 0.37);
  float n = fbm(uv * 20.0, vec2(20.0), 5);
  vec3 w = worley(uv * 90.0, vec2(90.0));
  float pore = smoothstep(0.2, 0.04, w.x) * step(0.6, w.z);
  float streak = smoothstep(0.48, 0.88, fbm(vec2(uv.x * 14.0, uv.y * 1.0), vec2(14.0, 1.0), 4));
  vec3 col = vec3(0.4, 0.39, 0.365) * (0.84 + 0.16 * id) * (0.86 + 0.24 * n);
  col *= 1.0 - streak * 0.28;
  col *= 1.0 - pore * 0.3;
  col = mix(col, vec3(0.16, 0.155, 0.145), joint);
  return S(col, bevel * 0.6 + n * 0.25 - joint * 0.5 - pore * 0.2, 0.9, 1.0 - joint * 0.5, 0.0);
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

/**
 * 3 m of sunny grass (the bank above the slope road, the park lawn, villa
 * gardens): blades in clumps, yellow-green in the sun, dry straw patches and
 * a little sandy soil showing through.
 */
export const GROUND = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 6.0, vec2(6.0), 5);
  float clump = fbm(uv * 20.0 + 3.0, vec2(20.0), 4);
  vec3 w = worley(uv * 300.0, vec2(300.0));
  vec3 w2 = worley(uv * 140.0 + 7.0, vec2(140.0));
  float blade = smoothstep(0.55, 0.08, w.x);
  float tuft = smoothstep(0.6, 0.15, w2.x) * step(0.45, w2.z);
  vec3 green = mix(vec3(0.045, 0.085, 0.018), vec3(0.15, 0.22, 0.045), w.z);
  vec3 col = mix(green * 0.45, green, blade);
  col = mix(col, vec3(0.19, 0.25, 0.06), tuft * 0.45);
  col = mix(col, vec3(0.2, 0.17, 0.08), smoothstep(0.6, 0.8, n) * 0.55);
  col = mix(col, vec3(0.13, 0.11, 0.075), smoothstep(0.74, 0.88, clump) * 0.5);
  col *= 0.85 + 0.3 * clump;
  float h = blade * 0.5 + tuft * 0.4 + clump * 0.3;
  return S(col, h, 0.9, 0.6 + 0.4 * blade, 0.0);
}`;

/** 1 m of sprayed stucco (吹付け): fine bumps, faint run-off; white, tinted per use. */
export const STUCCO = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 90.0, vec2(90.0));
  float bump = smoothstep(0.55, 0.0, w.x);
  float n = fbm(uv * 12.0, vec2(12.0), 5);
  float dirt = smoothstep(0.58, 0.9, fbm(vec2(uv.x * 9.0, uv.y * 1.0) + 3.0, vec2(9.0, 1.0), 4));
  vec3 col = vec3(0.84, 0.83, 0.81) * (0.95 + 0.06 * n) * (1.0 - 0.1 * dirt);
  return S(col, bump * 0.6 + n * 0.2, 0.84, 0.9 + 0.1 * bump, 0.0);
}`;

/**
 * 2 m of clipped hedge face (トベラ / マサキ): small glossy leaves in layers,
 * yellow-green new shoots on the outside, dark gaps into the interior.
 */
export const SHRUB = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 w = worley(uv * 56.0, vec2(56.0));
  vec3 w2 = worley(uv * 118.0 + 2.0, vec2(118.0));
  float leaf = smoothstep(0.66, 0.18, w.x);
  float rim = smoothstep(0.2, 0.45, w.x) * leaf;
  float leaf2 = smoothstep(0.52, 0.12, w2.x) * step(0.42, w2.z);
  float n = fbm(uv * 4.0, vec2(4.0), 4);
  float gapN = smoothstep(0.62, 0.8, fbm(uv * 9.0 + 5.0, vec2(9.0), 4));
  vec3 base = mix(vec3(0.04, 0.075, 0.016), vec3(0.13, 0.21, 0.045), w.z);
  vec3 col = mix(vec3(0.008, 0.014, 0.005), base, leaf);
  col = mix(col, vec3(0.2, 0.28, 0.06), leaf2 * 0.55);
  col *= 1.0 - rim * 0.25;
  col *= (0.8 + 0.35 * n) * (1.0 - gapN * 0.55);
  float h = leaf * 0.8 + leaf2 * 0.45 - gapN * 0.6;
  return S(col, h, 0.62 + 0.2 * (1.0 - leaf), 0.35 + 0.65 * leaf * (1.0 - gapN * 0.6), 0.0);
}`;

/**
 * 4 m of the slope road's dry, sun-bleached asphalt (日坂): light grey
 * aggregate worn proud of the binder, sand-coloured fines, voids, short
 * hairline cracks and a dust film in the low spots. Wheel paths, kerb
 * grime, repair patches and the long tar-sealed cracks are geometry and
 * vertex colour on top (world/slope.ts), so this tile stays even.
 */
export const SLOPE_ASPHALT = /* glsl */ `
Surface surface(vec2 uv) {
  vec3 a = worley(uv * 300.0, vec2(300.0));
  vec3 b = worley(uv * 760.0 + 1.3, vec2(760.0));
  float big = fbm(uv * 3.0, vec2(3.0), 4);
  float mid = fbm(uv * 16.0, vec2(16.0), 4);
  float stone = smoothstep(0.62, 0.34, a.x) * step(0.2, a.z);
  float dome = sqrt(clamp(1.0 - a.x * 1.7, 0.0, 1.0));
  float fines = smoothstep(0.55, 0.22, b.x) * step(0.38, b.z);
  float pit = smoothstep(0.7, 0.95, a.x) * step(a.z, 0.5) * (1.0 - fines);
  vec3 binder = mix(vec3(0.07, 0.063, 0.052), vec3(0.1, 0.091, 0.076), mid);
  vec3 stoneCol = mix(vec3(0.17, 0.16, 0.142), vec3(0.4, 0.38, 0.34), smoothstep(0.2, 1.0, a.z));
  stoneCol = mix(stoneCol, vec3(0.25, 0.2, 0.155), step(0.88, a.z) * 0.8);
  stoneCol = mix(stoneCol, vec3(0.085, 0.085, 0.085), step(a.z, 0.3) * 0.7);
  vec3 col = mix(binder, stoneCol, stone * 0.9);
  col = mix(col, vec3(0.22, 0.2, 0.17), fines * 0.45);
  col *= 1.0 - pit * 0.45;
  float dust = smoothstep(0.45, 0.75, big) * (1.0 - stone * 0.6);
  col = mix(col, vec3(0.21, 0.195, 0.165), dust * 0.35);
  col *= 0.93 + 0.12 * mid;
  float crack = smoothstep(0.972, 0.996, ridged(uv * 5.0 + 2.0, vec2(5.0), 5)) * smoothstep(0.5, 0.72, fbm(uv * 2.0 + 7.0, vec2(2.0), 3));
  col = mix(col, vec3(0.03, 0.028, 0.026), crack * 0.7);
  float h = stone * dome * 0.6 + fines * 0.22 + mid * 0.12 - pit * 0.3 - crack * 0.7;
  float r = 0.9 - stone * 0.08 - dust * 0.02;
  return S(col, h, r, 1.0 - pit * 0.35 - crack * 0.5 - (1.0 - stone) * 0.12, 0.0);
}`;
