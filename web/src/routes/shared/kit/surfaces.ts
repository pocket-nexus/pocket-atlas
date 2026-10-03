/**
 * Winter road surfaces (GLSL bodies for `Baker.surface`). Albedo is linear.
 * Generators lay them with UVs in repeats: the size each tile covers is
 * noted next to it and in `kit/materials.ts`.
 */

/**
 * 4 m of settled snow on open ground: wind crust with low sastrugi ridges
 * running one way, soft hollows between them, fine grain. Pure snow is
 * about 0.9 albedo with the faintest blue; the tint of what lies under or
 * around it comes from the vertices.
 */
export const SNOW = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 q = uv + 0.03 * vec2(gnoise(uv * 3.0, vec2(3.0)), gnoise(uv * 3.0 + 5.2, vec2(3.0)));
  float drift = fbm(vec2(q.x * 3.0, q.y * 9.0), vec2(3.0, 9.0), 4);
  float ridge = ridged(vec2(q.x * 2.0, q.y * 11.0) + 1.7, vec2(2.0, 11.0), 3);
  float crust = smoothstep(0.45, 0.75, fbm(uv * 5.0 + 3.1, vec2(5.0), 4));
  float grain = fbm(uv * 90.0, vec2(90.0), 3);
  float h = drift * 0.6 + ridge * 0.25 * crust + grain * 0.05;
  vec3 col = mix(vec3(0.83, 0.86, 0.91), vec3(0.9, 0.915, 0.94), smoothstep(0.3, 0.8, h));
  col *= 0.97 + 0.05 * grain;
  float r = mix(0.9, 0.62, crust * smoothstep(0.5, 0.9, ridge));
  return S(col, h, r, 0.92 + 0.08 * smoothstep(0.2, 0.7, h), 0.0);
}`;

/**
 * A national route in mid-winter, across its ploughed width (u, 8.5 m: two
 * 3.25 m lanes and 1 m shoulders) and 8 m along (v): compacted snow gone
 * grey-brown with grit, four wheel tracks polished to ice with the asphalt
 * showing dark through the thinnest of it, a paler hump between the tracks
 * and down the middle, whiter shoulders with the plough's striations.
 */
export const ROAD = /* glsl */ `
float track(float u, float c, float w) {
  float d = abs(u - c) / w;
  return exp(-d * d);
}
Surface surface(vec2 uv) {
  float u = uv.x;
  // Wheel tracks: lane centres ±1.625 m, wheels ±0.72 m of them, wandering a little along the road.
  float wob = 0.006 * gnoise(vec2(uv.y * 3.0, 0.5), vec2(3.0, 1.0)) + 0.003 * gnoise(vec2(uv.y * 9.0, 2.5), vec2(9.0, 4.0));
  float t = track(u + wob, 0.5 - 0.276, 0.034) + track(u + wob, 0.5 - 0.106, 0.034) + track(u - wob, 0.5 + 0.106, 0.034) + track(u - wob, 0.5 + 0.276, 0.034);
  t = clamp(t, 0.0, 1.0);
  float n = fbm(uv * vec2(34.0, 32.0), vec2(34.0, 32.0), 5);
  float streak = fbm(vec2(uv.x * 60.0, uv.y * 3.0), vec2(60.0, 3.0), 4);
  float worn = fbm(uv * vec2(8.0, 4.0) + 2.3, vec2(8.0, 4.0), 4);
  // Shoulders: outside the outer wheel tracks.
  float shoulder = smoothstep(0.36, 0.47, abs(u - 0.5));
  // Packed snow with grit; cleaner toward the shoulders and on the centre hump.
  vec3 packed = mix(vec3(0.5, 0.49, 0.47), vec3(0.69, 0.69, 0.69), n * 0.6 + streak * 0.4);
  packed = mix(packed, vec3(0.8, 0.82, 0.85), shoulder * (0.6 + 0.4 * streak));
  float hump = track(u, 0.5, 0.03) + track(u, 0.5 - 0.191, 0.03) + track(u, 0.5 + 0.191, 0.03);
  packed = mix(packed, vec3(0.74, 0.75, 0.76), clamp(hump, 0.0, 1.0) * 0.5);
  // In the tracks: grey ice, and bare wet asphalt where it has worn through.
  float bare = t * smoothstep(0.42, 0.7, worn + 0.25 * streak);
  vec3 ice = mix(vec3(0.36, 0.37, 0.39), vec3(0.47, 0.48, 0.5), n);
  vec3 col = mix(packed, ice, t * 0.85);
  col = mix(col, vec3(0.085, 0.085, 0.09) * (0.8 + 0.5 * n), bare * 0.8);
  // Plough striations and tyre lugs.
  col *= 0.94 + 0.1 * streak;
  float h = (1.0 - t) * 0.6 + n * 0.25 + shoulder * 0.25 - bare * 0.15 + streak * 0.08;
  float r = mix(0.82, 0.3, t);
  r = mix(r, 0.22, bare);
  r += (n - 0.5) * 0.12;
  return S(col, h, clamp(r, 0.12, 0.95), 1.0 - t * 0.12, 0.0);
}`;

/**
 * 4 m of packed snow on a ploughed side street, yard or lay-by: white-grey,
 * crossed by tyre prints and plough scrapes with no single direction.
 */
export const LANE = /* glsl */ `
Surface surface(vec2 uv) {
  float n = fbm(uv * 24.0, vec2(24.0), 5);
  float scrape = fbm(vec2(uv.x * 4.0, uv.y * 40.0), vec2(4.0, 40.0), 4);
  float scrape2 = fbm(vec2(uv.x * 36.0 + 3.0, uv.y * 5.0), vec2(36.0, 5.0), 4);
  float dirt = smoothstep(0.5, 0.8, fbm(uv * 3.0 + 7.1, vec2(3.0), 4));
  vec3 col = mix(vec3(0.66, 0.67, 0.69), vec3(0.83, 0.845, 0.87), n * 0.5 + scrape * 0.3 + scrape2 * 0.2);
  col = mix(col, vec3(0.55, 0.53, 0.5), dirt * 0.35);
  float polish = smoothstep(0.6, 0.85, scrape * 0.6 + scrape2 * 0.6);
  float h = n * 0.4 + scrape * 0.3 + scrape2 * 0.3;
  return S(col, h, mix(0.8, 0.42, polish), 0.96, 0.0);
}`;
