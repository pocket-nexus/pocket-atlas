/**
 * Winter road surfaces (GLSL bodies for `Baker.surface`). Albedo is linear.
 * Generators lay them with UVs in repeats: the size each tile covers is
 * noted next to it and in `kit/materials.ts`.
 */

/**
 * 4 m of settled snow on open ground: wind crust with low sastrugi ridges
 * running one way, soft hollows between them, fine grain. Pure snow is
 * about 0.9 albedo with the faintest blue; the tint of what lies under or
 * around it comes from the vertices. Under an overcast nothing shades the
 * relief, so the hollows carry a little of their own shade (the light they
 * lose to the ridges round them) and the glazed crust is smoother than the
 * drifted snow: that is all that tells the eye the ground is near.
 */
export const SNOW = /* glsl */ `
Surface surface(vec2 uv) {
  vec2 q = uv + 0.03 * vec2(gnoise(uv * 3.0, vec2(3.0)), gnoise(uv * 3.0 + 5.2, vec2(3.0)));
  float drift = fbm(vec2(q.x * 3.0, q.y * 9.0), vec2(3.0, 9.0), 4);
  float ridge = ridged(vec2(q.x * 2.0, q.y * 11.0) + 1.7, vec2(2.0, 11.0), 3);
  float crust = smoothstep(0.45, 0.75, fbm(uv * 5.0 + 3.1, vec2(5.0), 4));
  float grain = fbm(uv * 90.0, vec2(90.0), 3);
  float h = drift * 0.6 + ridge * 0.25 * crust + grain * 0.05;
  vec3 col = mix(vec3(0.775, 0.81, 0.875), vec3(0.9, 0.915, 0.94), smoothstep(0.25, 0.8, h));
  // The lee of each ridge.
  col *= 1.0 - 0.07 * crust * smoothstep(0.75, 0.4, ridge);
  col *= 0.97 + 0.05 * grain;
  float r = mix(0.92, 0.55, crust * smoothstep(0.5, 0.9, ridge));
  return S(col, h, r, 0.9 + 0.1 * smoothstep(0.2, 0.7, h), 0.0);
}`;

/**
 * A national route in mid-winter, across its ploughed width (u, 7.2 m: two
 * 3.25 m lanes, the shoulders lost to the banks) and 8 m along (v). Values
 * follow the research photos' ratios to fresh snow: packed snow 5–8 %
 * darker, the four wheel tracks (lane centres ±1.625 m, wheels ±0.75 m of
 * them, half a metre wide, frayed) 12–15 % darker where they are slush and
 * ice, about 65 % where the wet asphalt shows through, 35–40 % where it is
 * bare — in long tapering lengths, several per tile and each track its own,
 * so no one of them marks the repeat. A paler hump in each lane and down the
 * middle; where the middle's snow is thin a length of the centre line
 * shows; the outer half metre is whiter and scored by the plough.
 */
export const ROAD = /* glsl */ `
float lane(float u, float c, float w, float soft) {
  return 1.0 - smoothstep(w, w + soft, abs(u - c));
}
Surface surface(vec2 uv) {
  float u = uv.x;
  float n = fbm(uv * vec2(30.0, 32.0), vec2(30.0, 32.0), 5);
  float fine = fbm(uv * vec2(120.0, 128.0), vec2(120.0, 128.0), 3);
  // The plough's and the tyres' marks: long along the road.
  float streak = fbm(vec2(uv.x * 62.0, uv.y * 3.0), vec2(62.0, 3.0), 4);
  float score = fbm(vec2(uv.x * 160.0, uv.y * 2.0) + 3.7, vec2(160.0, 2.0), 3);
  float fray = 0.024 * (fbm(uv * vec2(40.0, 14.0) + 1.3, vec2(40.0, 14.0), 4) - 0.5);
  float t = 0.0;
  float wet = 0.0;
  float bare = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float c = 0.5 + (i == 0 ? -0.33 : i == 1 ? -0.1215 : i == 2 ? 0.1215 : 0.33);
    float wob = 0.009 * gnoise(vec2(uv.y * 4.0, fi + 0.5), vec2(4.0, 4.0)) + 0.005 * gnoise(vec2(uv.y * 11.0, fi + 0.5), vec2(11.0, 4.0));
    // The inner tracks carry both directions' drift toward the middle: a little wider.
    float w = (i == 1 || i == 2) ? 0.032 : 0.027;
    t = max(t, lane(u + wob + fray, c, w, 0.02));
    // Worn toward the asphalt in long tapering lengths, more where both directions' wheels run.
    float worn = fbm(vec2(uv.y * 3.0 + fi * 1.3, fi * 2.0 + 0.5), vec2(3.0, 8.0), 4);
    float ww = w * 1.0 * smoothstep(i == 1 || i == 2 ? 0.34 : 0.44, 0.75, worn) - 0.003;
    wet = max(wet, lane(u + wob + fray * 2.0, c, max(ww, 0.0), 0.014) * smoothstep(-0.002, 0.01, ww));
    float bw = w * 0.75 * smoothstep(i == 1 || i == 2 ? 0.45 : 0.55, 0.8, worn) - 0.004;
    bare = max(bare, lane(u + wob + fray * 2.6, c, max(bw, 0.0), 0.008) * smoothstep(-0.002, 0.008, bw));
  }
  float shoulder = smoothstep(0.415, 0.475, abs(u - 0.5) + 0.012 * (streak - 0.5));
  // Packed snow with a little grit ground into it; cleaner on the humps and at the edges.
  vec3 packed = mix(vec3(0.5, 0.5, 0.49), vec3(0.66, 0.665, 0.67), n * 0.55 + streak * 0.45);
  float grit = smoothstep(0.52, 0.78, fbm(uv * vec2(20.0, 20.0) + 9.1, vec2(20.0, 20.0), 4));
  packed = mix(packed, vec3(0.42, 0.41, 0.39), grit * 0.3 * (1.0 - shoulder));
  float hump = lane(u, 0.5, 0.014, 0.06) + lane(u, 0.2743, 0.024, 0.06) + lane(u, 0.7257, 0.024, 0.06);
  packed = mix(packed, vec3(0.7, 0.71, 0.725) * (0.93 + 0.14 * n), clamp(hump, 0.0, 1.0) * 0.6);
  packed = mix(packed, vec3(0.76, 0.775, 0.8) * (0.92 + 0.12 * score), shoulder * (0.75 + 0.25 * streak));
  // Slush thrown to the tracks' lips.
  float lip = t * (1.0 - t) * 4.0;
  packed = mix(packed, vec3(0.46, 0.45, 0.43), lip * 0.4);
  // In the tracks: slush and grey ice streaked along the road, the asphalt wet under it, then bare.
  vec3 ice = mix(vec3(0.35, 0.355, 0.365), vec3(0.5, 0.505, 0.515), streak * 0.6 + n * 0.4);
  vec3 col = mix(packed, ice, t * 0.92);
  col = mix(col, vec3(0.2, 0.203, 0.21) * (0.8 + 0.4 * n), wet * 0.9);
  vec3 asphalt = vec3(0.066, 0.068, 0.072) * (0.75 + 0.6 * fine);
  col = mix(col, asphalt, bare * 0.92);
  // The centre line (a 15 cm stripe) where the middle's snow is thin.
  float thin = smoothstep(0.52, 0.7, fbm(vec2(uv.x * 2.0 + 4.4, uv.y * 4.0), vec2(2.0, 4.0), 4) + 0.3 * (n - 0.5)) * lane(u + fray * 2.2, 0.5, 0.01, 0.018);
  vec3 line = mix(vec3(0.2, 0.203, 0.21), vec3(0.42, 0.37, 0.2), lane(u + fray * 0.3, 0.5, 0.0075, 0.005) * smoothstep(0.35, 0.65, fine));
  col = mix(col, line, thin * 0.55);
  // Scoring and grain everywhere.
  col *= (0.95 + 0.07 * streak) * (0.97 + 0.06 * fine);
  float film = max(max(bare, wet * 0.7), thin * 0.4);
  float h = (1.0 - t) * 0.55 + n * 0.22 + shoulder * 0.3 + clamp(hump, 0.0, 1.0) * 0.12 + lip * 0.1 - film * 0.2 + score * 0.06 * shoulder + fine * 0.04;
  float r = mix(0.84, 0.42, t);
  r = mix(r, 0.22, film);
  r += (n - 0.5) * 0.14;
  return S(col, h, clamp(r, 0.12, 0.95), 1.0 - t * 0.08, 0.0);
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
