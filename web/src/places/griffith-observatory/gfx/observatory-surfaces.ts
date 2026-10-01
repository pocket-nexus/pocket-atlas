/**
 * Procedural PBR surfaces of the observatory and its grounds (GLSL bodies for
 * `Baker.surface`). Each tile covers the physical size noted next to it;
 * materials set `texture.repeat` to 1 / size because the geometry carries
 * UVs in metres. Colours are linear albedo, sampled from the daylight
 * photographs (p16–p19, p21) and held below the blue-hour photographs'
 * values, which include the floodlights.
 */

/**
 * 4 m of cast concrete in the 2004–05 warm-white elastomeric coating: a
 * faint trowel mottle, board-form ghosts 0.3 m apart, hairline crazing,
 * grey runoff under ledges every few metres (p18: rust-brown streaks under
 * the dome rings), a darker splash band at the foot.
 */
export const COATED = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 per = vec2(16.0);
  float mottle = fbm(uv * 6.0, vec2(6.0), 5);
  float fine = fbm(uv * 64.0, vec2(64.0), 3);
  float board = smoothstep(0.46, 0.5, abs(fract(uv.y * 13.33) - 0.5)) * 0.35;
  float craze = smoothstep(0.955, 0.99, ridged(uv * 9.0, vec2(9.0), 4));
  float runs = smoothstep(0.55, 0.9, fbm(vec2(uv.x * 28.0, uv.y * 1.5), vec2(28.0, 1.5), 4));
  float rust = smoothstep(0.72, 0.95, fbm(vec2(uv.x * 40.0 + 7.0, uv.y * 2.0), vec2(40.0, 2.0), 3));
  vec3 base = vec3(0.70, 0.67, 0.60) * (0.94 + 0.08 * mottle + 0.03 * fine);
  base *= 1.0 - board * 0.04 - craze * 0.08;
  base = mix(base, base * vec3(0.86, 0.85, 0.84), runs * 0.35);
  base = mix(base, vec3(0.42, 0.28, 0.2), rust * 0.12);
  float h = mottle * 0.25 + fine * 0.1 - craze * 0.4 - board * 0.15;
  return S(base, h, 0.74 + 0.1 * mottle, 1.0 - craze * 0.2, 0.0);
}`;

/**
 * 4 m of roof-deck and terrace concrete (p14, p23): sealed grey-tan topping in
 * 1.33 m saw-cut bays, foot-traffic polish down the middle, drain stains.
 */
export const DECK = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = uv * 3.0;
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f);
  float joint = 1.0 - smoothstep(0.004, 0.012, min(e.x, e.y));
  float mottle = fbm(uv * 8.0, vec2(8.0), 5);
  float fine = fbm(uv * 96.0, vec2(96.0), 3);
  float stain = smoothstep(0.6, 0.85, fbm(uv * 3.0 + 4.1, vec2(3.0), 4));
  vec3 col = vec3(0.30, 0.285, 0.26) * (0.86 + 0.24 * mottle + 0.06 * fine);
  col = mix(col, vec3(0.19, 0.18, 0.17), stain * 0.35);
  col = mix(col, vec3(0.1, 0.095, 0.09), joint * 0.8);
  float h = mottle * 0.15 + fine * 0.12 - joint * 0.6;
  return S(col, h, 0.62 - 0.12 * mottle + joint * 0.2, 1.0 - joint * 0.4, 0.0);
}`;

/**
 * 3 m of broom-finished walk concrete (lawn walks, entrance plaza, p21): pale
 * grey, 1.5 m tooled joints, a light broom grain across the walk, gum spots.
 */
export const WALK = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = uv * 2.0;
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f);
  float joint = 1.0 - smoothstep(0.003, 0.009, min(e.x, e.y));
  float mottle = fbm(uv * 5.0, vec2(5.0), 5);
  float broom = fbm(vec2(uv.x * 300.0, uv.y * 6.0), vec2(300.0, 6.0), 2);
  vec3 w = worley(uv * 40.0, vec2(40.0));
  float gum = smoothstep(0.08, 0.03, w.x) * step(0.93, w.z);
  vec3 col = vec3(0.46, 0.44, 0.40) * (0.88 + 0.2 * mottle + 0.05 * broom);
  col = mix(col, vec3(0.16, 0.15, 0.14), gum * 0.8);
  col = mix(col, vec3(0.2, 0.19, 0.18), joint * 0.75);
  float h = broom * 0.12 + mottle * 0.1 - joint * 0.7;
  return S(col, h, 0.8 - 0.08 * mottle, 1.0 - joint * 0.45, 0.0);
}`;

/** 4 m of park-road asphalt: worn binder, chip aggregate, patched seams. */
export const ASPHALT = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 per = vec2(64.0);
  vec3 w = worley(uv * per, per);
  float stone = smoothstep(0.62, 0.18, w.x) * step(0.35, w.z);
  float grime = fbm(uv * 6.0, vec2(6.0), 5);
  float patchA = smoothstep(0.55, 0.57, fbm(uv * 2.0 + 0.3, vec2(2.0), 4));
  float crack = smoothstep(0.94, 0.985, ridged(uv * 5.0, vec2(5.0), 4));
  vec3 binder = mix(vec3(0.045, 0.045, 0.047), vec3(0.075, 0.073, 0.072), grime);
  binder = mix(binder, vec3(0.03, 0.03, 0.032), patchA * 0.8);
  vec3 col = mix(binder, vec3(0.12, 0.115, 0.11), stone * (1.0 - patchA * 0.7) * 0.6);
  col *= 1.0 - crack * 0.6;
  float h = stone * 0.35 + grime * 0.2 - crack * 0.6;
  return S(col, h, mix(0.86, 0.72, stone), 1.0 - crack * 0.5, 0.0);
}`;

/**
 * 2 m of mown lawn (Bermuda / fescue mix, irrigated): dense blades, clover
 * patches, mower stripes too faint to read at dusk.
 */
export const LAWN = /* glsl */ `
Surface surface(vec2 uv) {
  float blades = fbm(uv * vec2(220.0, 260.0), vec2(220.0, 260.0), 3);
  float clump = fbm(uv * 14.0, vec2(14.0), 4);
  float dry = smoothstep(0.62, 0.8, fbm(uv * 3.0 + 2.0, vec2(3.0), 4));
  vec3 col = mix(vec3(0.035, 0.07, 0.022), vec3(0.075, 0.12, 0.035), blades);
  col *= 0.8 + 0.4 * clump;
  col = mix(col, vec3(0.12, 0.11, 0.05), dry * 0.35);
  return S(col, blades * 0.6 + clump * 0.3, 0.9, 0.75 + 0.25 * blades, 0.0);
}`;

/**
 * 6 m of the hillside: decomposed-granite soil, gravel, dry grass in August,
 * leaf litter under the shrubs (p03, p06, p25).
 */
export const HILLSIDE = /* glsl */ `
Surface surface(vec2 uv) {
  float soil = fbm(uv * 10.0, vec2(10.0), 5);
  vec3 w = worley(uv * 70.0, vec2(70.0));
  float gravel = smoothstep(0.35, 0.1, w.x) * step(0.6, w.z);
  float grass = smoothstep(0.42, 0.62, fbm(uv * 5.0 + 7.0, vec2(5.0), 5));
  float blades = fbm(uv * vec2(160.0, 40.0), vec2(160.0, 40.0), 2);
  float litter = smoothstep(0.6, 0.8, fbm(uv * 18.0 + 3.0, vec2(18.0), 3));
  vec3 dirt = mix(vec3(0.16, 0.12, 0.085), vec3(0.24, 0.185, 0.13), soil);
  dirt = mix(dirt, vec3(0.3, 0.27, 0.22), gravel * 0.5);
  vec3 straw = mix(vec3(0.26, 0.21, 0.12), vec3(0.38, 0.31, 0.17), blades);
  vec3 col = mix(dirt, straw, grass * 0.85);
  col = mix(col, vec3(0.1, 0.08, 0.05), litter * 0.4);
  float h = soil * 0.3 + gravel * 0.4 + grass * blades * 0.4;
  return S(col, h, 0.92, 0.85 + 0.15 * soil, 0.0);
}`;

/**
 * 8 standing-seam pans × 4 courses of the re-clad copper domes (2004): dark
 * chocolate-brown oxidised copper (no green; p18), each pan its own shade,
 * raised seams lighter where they catch the sky, flat-lock course joints,
 * a few darker drip lines. u spans 8 pans, v 4 courses.
 */
export const COPPER = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 8.0, uv.y * 4.0);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float seam = 1.0 - smoothstep(0.0, 0.06, min(f.x, 1.0 - f.x));
  float course = 1.0 - smoothstep(0.0, 0.025, min(f.y, 1.0 - f.y));
  float id = hash12(mod(cell, vec2(8.0, 4.0)) + 1.7);
  float mottle = fbm(uv * vec2(24.0, 12.0), vec2(24.0, 12.0), 4);
  float drip = smoothstep(0.6, 0.9, fbm(vec2(uv.x * 64.0, uv.y * 2.0), vec2(64.0, 2.0), 3));
  vec3 brown = mix(vec3(0.055, 0.03, 0.022), vec3(0.095, 0.055, 0.038), id);
  brown *= 0.8 + 0.4 * mottle;
  brown = mix(brown, vec3(0.03, 0.022, 0.02), drip * 0.4);
  vec3 col = mix(brown, vec3(0.13, 0.08, 0.055), seam * 0.6);
  col = mix(col, brown * 0.6, course * 0.6);
  float h = seam * 0.9 - course * 0.3 + mottle * 0.08;
  return S(col, h, 0.42 + 0.12 * mottle - seam * 0.08, 1.0 - course * 0.3, 0.45);
}`;

/** 2 m of the 1935 rotunda roof copper: verdigris over brown, washed lighter on the ribs. */
export const PATINA = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 g = vec2(uv.x * 4.0, uv.y * 3.0);
  vec2 f = fract(g);
  float seam = 1.0 - smoothstep(0.0, 0.05, min(f.x, 1.0 - f.x));
  float course = 1.0 - smoothstep(0.0, 0.03, min(f.y, 1.0 - f.y));
  float wash = fbm(vec2(uv.x * 20.0, uv.y * 4.0), vec2(20.0, 4.0), 4);
  float dark = smoothstep(0.6, 0.85, fbm(uv * 9.0 + 1.0, vec2(9.0), 4));
  vec3 col = mix(vec3(0.14, 0.38, 0.33), vec3(0.24, 0.52, 0.45), wash);
  col = mix(col, vec3(0.07, 0.07, 0.05), dark * 0.4);
  col = mix(col, vec3(0.26, 0.46, 0.38), seam * 0.5);
  col *= 1.0 - course * 0.35;
  return S(col, seam * 0.8 - course * 0.3 + wash * 0.1, 0.62, 1.0 - course * 0.3, 0.05);
}`;
