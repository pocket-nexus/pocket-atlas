import { CLOUD_RADIUS, PLANET_RADIUS } from "../geo";
import { ATMOSPHERE, COMMON, f, NOISE } from "./chunks";

export const SPHERE_VERT = /* glsl */ `
out vec3 vObj;
out vec3 vWorld;
void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const LIGHT_UNIFORMS = /* glsl */ `
uniform mat3 uEarthRot;
uniform vec3 uSunDir;
uniform float uLightsMax;
uniform float uLightsGain;
uniform float uNight;
uniform vec2 uCloudOffset;
uniform float uTime;
uniform float uSurface;
`;

/** Night side: 1 once the sun is ~8° below the horizon, fading through twilight. */
const NIGHT_FN = /* glsl */ `
float nightFactor(float mu) { return 1.0 - smoothstep(-0.14, 0.05, mu); }
vec3 lightsColor(float lum) {
  // Sodium orange at the fringe, whiter where the cores saturate.
  return mix(vec3(1.0, 0.46, 0.15), vec3(1.0, 0.76, 0.42), saturate(lum * 0.55));
}`;

export function earthFrag(steps: number): string {
  return /* glsl */ `
precision highp float;
#define ATMOS_STEPS ${steps}
${COMMON}
${ATMOSPHERE}
${NOISE}
${LIGHT_UNIFORMS}
${NIGHT_FN}
uniform sampler2D tAlbedo;
uniform sampler2D tNormal;
uniform sampler2D tLights;
uniform sampler2D tClouds;
uniform float uCloudShadow;
uniform float uSpecular;
uniform float uDetail;
// High-resolution coastline around the destination (lat, lon, halfLat, halfLon in radians).
uniform sampler2D tCoast;
uniform vec4 uCoastRect;
uniform float uCoastOn;
in vec3 vObj;
in vec3 vWorld;
out vec4 fragColor;

float ggx(float NdH, float a2) {
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

void main() {
  vec3 p = normalize(vObj);
  vec2 uv = sphereUvSeamless(p);
  vec4 A = texture(tAlbedo, uv);
  vec3 albedo = A.rgb;
  float water = A.a;
  if (uCoastOn > 0.5) {
    float dl = atan(p.x, p.z) - uCoastRect.y;
    dl -= TAU * floor((dl + PI) / TAU);
    vec2 d = vec2(dl / uCoastRect.w, (asin(clamp(p.y, -1.0, 1.0)) - uCoastRect.x) / uCoastRect.z);
    float m = max(abs(d.x), abs(d.y));
    if (m < 1.0) {
      float landHi = texture(tCoast, vec2(d.x * 0.5 + 0.5, 0.5 - d.y * 0.5)).r;
      water = mix(water, 1.0 - landHi, smoothstep(1.0, 0.8, m));
    }
  }

  vec4 NM = texture(tNormal, uv);
  vec3 tn = NM.xyz * 2.0 - 1.0;
  float elev = NM.w;
  vec3 east = vec3(p.z, 0.0, -p.x);
  float el = length(east);
  east = el > 1e-5 ? east / el : vec3(1.0, 0.0, 0.0);
  vec3 north = cross(p, east);
  vec3 nObj = normalize(east * tn.x + north * tn.y + p * tn.z);

  vec3 Ng = normalize(uEarthRot * p);
  vec3 N = normalize(uEarthRot * nObj);
  N = normalize(mix(N, Ng, water));
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorld);
  float mu = dot(Ng, L);
  vec3 E = uSunI * uSurface * sunTransmittance(0.0, mu);

  // Cloud shadows: sample the cover a little towards the sun.
  vec3 Lo = transpose(uEarthRot) * L;
  vec3 ps = normalize(p + (Lo - p * dot(Lo, p)) * 0.009);
  float cs = textureLod(tClouds, sphereUv(ps) + uCloudOffset, 2.0).r;
  float shadow = 1.0 - uCloudShadow * cs;

  float NdL = max(dot(N, L), 0.0);
  vec3 col = albedo * (1.0 / PI) * E * NdL * shadow;

  // Skylight: blue by day, amber in the twilight band.
  float dayAmt = smoothstep(-0.16, 0.3, mu);
  vec3 skyCol = mix(vec3(0.9, 0.42, 0.22), vec3(0.32, 0.52, 1.0), smoothstep(-0.06, 0.12, mu));
  col += albedo * skyCol * uSunI * uSurface * 0.012 * dayAmt * (1.0 - 0.3 * cs);

  // Ocean: GGX sun glint plus Fresnel sky reflection.
  float NdV = max(dot(Ng, V), 1e-3);
  vec3 H = normalize(L + V);
  float NdH = max(dot(Ng, H), 0.0);
  float VdH = max(dot(V, H), 0.0);
  float NgL = max(mu, 0.0);
  const float a2 = 0.0035;
  float k = 0.03;
  float G = (NgL / (NgL * (1.0 - k) + k)) * (NdV / (NdV * (1.0 - k) + k));
  float F = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
  float spec = ggx(NdH, a2) * F * G / (4.0 * NdV + 1e-4);
  // A broad second lobe gives the glint a soft halo on the swell.
  spec += ggx(NdH, 0.05) * F * G / (4.0 * NdV + 1e-4) * 0.35;
  col += water * E * spec * shadow * (1.0 - 0.7 * cs) * uSpecular;
  float Fv = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  col += water * Fv * skyCol * uSunI * 0.02 * dayAmt;

  // City lights, fading in through twilight. Cloud overhead covers them by its
  // alpha when the shell composites, and re-emits them as glow.
  float night = nightFactor(mu);
  vec2 li = texture(tLights, uv).rg;
  float lum = (li.r * li.r * saturate((1.0 - water) * 1.6) + li.g * li.g) * uLightsMax;
  // Mountain country is dark at night; bright city cores keep their light.
  float mtn = smoothstep(0.12, 0.4, elev);
  lum *= 1.0 - 0.75 * mtn * (1.0 - smoothstep(0.4, 1.5, lum));
  if (uDetail > 0.001 && lum > 0.001) {
    // The baked map is ~10 km per texel. Up close, break it into districts, a
    // road network (ridged noise at three scales, gently warped) and point
    // lights. A scale fades to its mean once it is well below a pixel, and is
    // skipped entirely then.
    vec3 x = p * 6371.0;
    float kmPerPx = length(fwidth(x));
    float towns = smoothstep(0.26, 0.7, fbm(x * 0.08, 2) * 0.5 + 0.5);
    float wn = snoise(x * 0.02);
    vec3 xw = x + vec3(wn, -0.6 * wn, 0.8 * wn) * 4.0;
    float l2 = 1.0 - smoothstep(0.3, 1.2, kmPerPx * 0.14);
    float l3 = 1.0 - smoothstep(0.3, 1.2, kmPerPx * 0.6);
    float r1 = pow(1.0 - abs(snoise(xw * 0.03 + 3.1)), 30.0);
    float r2 = 0.053;
    if (l2 > 0.0) r2 = mix(r2, pow(1.0 - abs(snoise(xw * 0.14 - 7.3)), 18.0), l2);
    float r3 = 0.077;
    float pts = 0.1;
    if (l3 > 0.0) {
      r3 = mix(r3, pow(1.0 - abs(snoise(x * 0.6 + 1.9)), 12.0), l3);
      pts = mix(pts, pow(hash33(floor(x * 1.3)).x, 12.0) * 2.5, l3) + pow(hash33(floor(x * 4.1) + 17.0).y, 16.0) * 1.5 * towns * l3;
    }
    towns *= 1.0 - 0.7 * mtn;
    float pat = towns * 0.3 + (r1 * 1.3 + r2 * 0.9) * (1.0 - 0.6 * mtn) + r3 * 0.55 * towns + pts;
    lum = mix(lum, lum * pat * 1.5, uDetail);
  }
  col += lightsColor(lum) * lum * uLightsGain * night;

  // Moonlight keeps the night hemisphere legible.
  col += (albedo * vec3(0.26, 0.40, 0.85) + vec3(0.002, 0.004, 0.012) * water) * uNight * (1.0 - dayAmt);

  vec3 ins, tr;
  scatter(cameraPosition, -V, length(vWorld - cameraPosition), L, ign(gl_FragCoord.xy), ins, tr);
  fragColor = vec4(col * tr + ins, 1.0);
}`;
}

export function cloudFrag(steps: number): string {
  return /* glsl */ `
precision highp float;
#define ATMOS_STEPS ${steps}
#define CLOUD_H ${f(CLOUD_RADIUS - PLANET_RADIUS)}
${COMMON}
${ATMOSPHERE}
${NOISE}
${LIGHT_UNIFORMS}
${NIGHT_FN}
uniform sampler2D tClouds;
uniform sampler2D tLights;
uniform float uOpacity;
uniform float uGlow;
uniform float uDetail;
uniform vec4 uTarget; // xyz: dive city (object space), w: strength
uniform vec4 uNadir;  // xyz: point under the camera (object space), w: strength
in vec3 vObj;
in vec3 vWorld;
out vec4 fragColor;

void main() {
  vec3 p = normalize(vObj);
  vec2 uv = sphereUvSeamless(p);
  vec4 c = texture(tClouds, uv + uCloudOffset);
  float dens = c.r;
  // Close to the layer the baked cover is magnified; erode its edges with 3D fbm
  // evaluated in kilometres on the sphere.
  if (uDetail > 0.001) {
    vec3 x = p * 6371.0;
    float e = fbm(x * 0.011, 5);
    float dd = smoothstep(0.0, 1.0, (dens - 0.5) * 1.7 + e * 0.75 + 0.5);
    dens = mix(dens, dd, uDetail);
    if (uTarget.w > 0.0) {
      // Broken rain cloud around the destination, and the deck under the
      // camera that it descends into at the end of the plunge.
      float n2 = snoise(x * 0.12 + 2.0);
      float e2 = e * 0.5 + 0.5;
      float ang = acos(clamp(dot(p, uTarget.xyz), -1.0, 1.0));
      float deck = smoothstep(0.55, 0.82, e2 + n2 * 0.14) * exp(-sq(ang / 0.035));
      float angN = acos(clamp(dot(p, uNadir.xyz), -1.0, 1.0));
      float sheet = smoothstep(0.3, 0.6, e2 + n2 * 0.2 + 0.12) * exp(-sq(angN / 0.02));
      dens = max(dens, max(deck * 0.75 * uTarget.w, sheet * uNadir.w));
    }
  }
  if (dens < 0.004) discard;

  vec3 Ng = normalize(uEarthRot * p);
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorld);
  float mu = dot(Ng, L);
  vec3 E = uSunI * uSurface * sunTransmittance(CLOUD_H, mu);
  float thick = c.g;

  // Thick decks scatter like a lambertian volume with a wrapped terminator;
  // thin veils glow when back-lit.
  float wrapL = saturate(mu * 0.85 + 0.15);
  float shade = (0.5 + 0.55 * thick) * (0.82 + 0.3 * c.b);
  // Relief: treat cover as height. Slopes facing the sun brighten, slopes
  // facing away darken, strongest where the sun is low (near the terminator).
  vec2 texel = 1.5 / vec2(textureSize(tClouds, 0));
  vec2 cuv = uv + uCloudOffset;
  const vec3 hw = vec3(0.55, 0.45, 0.2);
  float gu = dot(texture(tClouds, cuv + vec2(texel.x, 0.0)).rgb - texture(tClouds, cuv - vec2(texel.x, 0.0)).rgb, hw);
  float gv = dot(texture(tClouds, cuv + vec2(0.0, texel.y)).rgb - texture(tClouds, cuv - vec2(0.0, texel.y)).rgb, hw);
  vec3 eastC = normalize(vec3(p.z, 0.0, -p.x) + vec3(1e-5, 0.0, 0.0));
  vec3 northC = cross(p, eastC);
  vec3 Lo = transpose(uEarthRot) * L;
  vec2 lt = vec2(dot(Lo, eastC), dot(Lo, northC));
  float slope = dot(vec2(gu, -gv), lt) / (length(lt) + 1e-3);
  shade *= clamp(1.0 - slope * 2.2 * (1.0 - 0.6 * saturate(mu)), 0.45, 1.35);
  vec3 col = vec3(0.8) * (1.0 / PI) * E * (0.15 + 0.85 * wrapL) * shade;
  float back = pow(saturate(dot(-V, L)), 6.0);
  col += E * back * (1.0 - thick) * 0.05;
  float dayAmt = smoothstep(-0.16, 0.3, mu);
  col += vec3(0.30, 0.45, 0.9) * uSunI * uSurface * 0.012 * dayAmt;

  // Night: lit from below by the cities, plus faint moonlight on the tops.
  float night = nightFactor(mu);
  vec2 li = textureLod(tLights, uv, 3.0).rg;
  float lum = (li.r * li.r + li.g * li.g) * uLightsMax;
  // Seen from below (camera under the deck) the base is what the city lights.
  float below = step(length(cameraPosition), ${f(CLOUD_RADIUS)});
  col += vec3(1.0, 0.52, 0.24) * lum * uGlow * uLightsGain * night * (0.45 + 0.55 * thick) * (1.0 + 1.5 * below);
  col += vec3(0.26, 0.38, 0.75) * uNight * (0.6 + 0.5 * thick) * (1.0 - dayAmt);

  float NdV = saturate(dot(Ng, V));
  float alpha = saturate(dens * uOpacity * (0.75 + 0.25 * thick) * (1.0 + 0.9 * (1.0 - NdV)));

  vec3 ins, tr;
  scatter(cameraPosition, -V, length(vWorld - cameraPosition), L, ign(gl_FragCoord.xy + 17.0), ins, tr);
  fragColor = vec4(col * tr + ins, alpha);
}`;
}

export function atmosphereFrag(steps: number): string {
  return /* glsl */ `
precision highp float;
#define ATMOS_STEPS ${steps}
${COMMON}
${ATMOSPHERE}
uniform vec3 uSunDir;
uniform float uAirglow;
uniform float uLimbBoost;
uniform float uTerminator;
in vec3 vObj;
in vec3 vWorld;
out vec4 fragColor;

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec2 tp = raySphere(ro, rd, PLANET_R);
  if (tp.x < tp.y && tp.y > 0.0) discard; // the surface shader owns these rays
  vec3 ins, tr;
  scatter(ro, rd, 1e9, uSunDir, ign(gl_FragCoord.xy), ins, tr);
  ins *= uLimbBoost;
  // Airglow: a thin emissive layer that outlines the night limb.
  float b = dot(ro, rd);
  vec3 closest = ro - rd * b;
  float hmin = length(closest) - PLANET_R;
  float dayAt = smoothstep(-0.25, 0.15, dot(normalize(closest), uSunDir));
  float glow = exp(-sq((hmin - 0.3 * ATMOS_H) / (0.12 * ATMOS_H))) + 0.25 * exp(-hmin / (0.35 * ATMOS_H));
  ins += vec3(0.18, 0.42, 0.85) * glow * uAirglow * (1.0 - dayAt);
  // Sunset band: where the limb crosses the terminator, sunlight grazes the
  // low atmosphere and arrives red.
  float term = exp(-sq((dot(normalize(closest), uSunDir) + 0.02) / 0.1));
  ins += vec3(1.0, 0.36, 0.1) * term * exp(-hmin / (0.22 * ATMOS_H)) * uTerminator;
  fragColor = vec4(ins, dot(tr, vec3(1.0 / 3.0)));
}`;
}
