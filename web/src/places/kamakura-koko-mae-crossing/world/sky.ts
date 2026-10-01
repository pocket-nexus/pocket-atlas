import { BackSide, ClampToEdgeWrapping, Color, LinearFilter, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Texture } from "three";
import type { Baker } from "../../shared/bake";
import type { KamakuraWorld } from "./context";

/**
 * Summer afternoon sky over Sagami Bay (late July, 15:30): a blue zenith
 * fading to the milky horizon of a humid day, the sun high in the west, and a
 * cloud panorama baked once for this place. The model and its annotation are
 * the `gradient-sun-cloudpanorama` sky the handheld draws (`sky_day_f.cg`).
 *
 * The panorama holds what a July afternoon shows from the coast:
 *  - fair-weather cumulus (base 900 m, tops to 2.9 km) that grow over land
 *    (the Kamakura hills to the north, the Miura peninsula to the east and
 *    south-east, Hakone and Izu far to the west-south-west) and stay sparse
 *    over the bay;
 *  - a thin cirrus layer at 8.5 km, streaked along the upper wind;
 *  - the haze of the boundary layer (the lowest 1.5 km), which fades the
 *    distant clouds into the horizon band.
 *
 * Cloud panorama layout (the handheld samples it the same way):
 *   azimuth a = atan2(d.x, −d.z) ∈ [0, 2π), elevation e = asin(d.y) ∈ [0, π/2]
 *   two halves: v ∈ [0, 0.5) covers a ∈ [0, π), v ∈ [0.5, 1) covers [π, 2π)
 *   u = fract(a / π), v = (half + sqrt(e / (π/2))) / 2, rows bottom-up
 * Channels: R = opacity, G = sunlit radiance / sunScale, B = sky-lit
 * radiance (both already multiplied by the transmittance in front). The
 * clouds composite as  sky · (1 − R·f) + (cloudSun · sunScale · G +
 * cloudAmbient · B) · f  with f = smoothstep(0, fadeElevation, d.y).
 */
export const SKY = {
  zenith: new Color(0.035, 0.2, 0.78),
  horizon: new Color(0.5, 0.67, 0.9),
  ground: new Color(0.3, 0.38, 0.44),
  sun: new Color(1.0, 0.93, 0.8),
  gradientPower: 0.46,
  glow: 0.2,
  disc: 40,
  cloudSun: new Color(1.0, 0.95, 0.86).multiplyScalar(1.3),
  cloudAmbient: new Color(0.5, 0.6, 0.75),
  /** The panorama stores sunlit radiance / sunScale (fixed by the bake). */
  sunScale: 2.5,
  fadeElevation: 0.03,
};

/**
 * The afternoon's light balance (July, 15:20, sun 40° up in the west). The
 * cooker bakes the hemisphere, the probe and sky occlusion into the
 * handheld's vertices and lights the sun per pixel, so these numbers set the
 * device's balance too.
 *
 * Shade in the photos is a soft grey-blue at about two thirds of the sunlit
 * value (asphalt #5f6873 beside #a49e93): sky light plus the bounce off
 * sunlit asphalt, walls and the hill, through a camera's tone curve. The
 * dome's zenith (0.035, 0.2, 0.78) reproduces the photographed sky, but as
 * the probe's light it filled the shaded road with blue at three times red
 * (#2d446a on screen). So the probe is captured with the sky above 17° moved
 * toward its luminance grey (`probeSky` of the way above 49°; the band the
 * sea reflects keeps its colour), and the hemisphere carries most of the
 * fill: a grey-blue sky (0.56 of the sun's irradiance on level ground) and
 * the bounce of sunlit asphalt below.
 */
export const DAYLIGHT = {
  sunColor: 0xffecd4,
  sunIntensity: 6.2,
  hemiSky: new Color(0.58, 0.67, 0.84),
  hemiGround: new Color(0.62, 0.53, 0.4),
  hemiIntensity: 2.9,
  environmentIntensity: 0.85,
  probeSky: 0.8,
  exposure: 0.94,
};

const CLOUD_BAKE = /* glsl */ `
uniform vec3 uSun;
uniform float uSeaCover;
uniform float uLandCover;
#define PI 3.14159265
const float RE = 6371000.0;
// Fair-weather cumulus of a humid July afternoon on the coast.
const float CB = 900.0;
const float CT = 2900.0;
const float CELL = 1900.0;
const float SIGMA = 0.028;
// Cirrus deck and the top of the hazy boundary layer.
const float CI = 8500.0;
const float HAZE_TOP = 1500.0;
const float HAZE_LEN = 20000.0;

float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
float fbm3(vec3 p, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * vnoise3(p); n += a; p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s / n;
}
// Land under the cloud field (x east, z south, metres from the crossing):
// cumulus build over the hills in a sea breeze and stay sparse over the bay.
float landness(vec2 xz) {
  float d = length(xz);
  float az = degrees(atan(xz.x, -xz.y));
  if (az < 0.0) az += 360.0;
  float north = 1.0 - smoothstep(-2600.0, -500.0, xz.y);
  float miura = smoothstep(94.0, 101.0, az) * (1.0 - smoothstep(150.0, 158.0, az)) * smoothstep(5500.0, 8500.0, d);
  float izu = smoothstep(212.0, 222.0, az) * (1.0 - smoothstep(272.0, 285.0, az)) * smoothstep(32000.0, 45000.0, d);
  float shonan = smoothstep(252.0, 262.0, az) * smoothstep(4000.0, 8000.0, d);
  return clamp(north + miura + izu + shonan, 0.0, 1.0);
}
// Cumulus: Worley sites carry a cloud of three flat-based domes and up to
// three turrets; the outline is billowed by 3D noise in cloudDensity.
float cloudShape(vec3 p, float alt, out float hL) {
  hL = 0.0;
  float h = alt - CB;
  if (h < 0.0 || h > CT - CB) return -1.0;
  vec2 q = p.xz / CELL;
  q += 0.25 * vec2(gnoise(q * 0.5, vec2(0.0)), gnoise(q * 0.5 + 7.3, vec2(0.0)));
  vec2 i = floor(q), f = fract(q);
  float edge = -1.0;
  float top = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 bc = i + o;
    vec2 site = o + hash22(bc) - f;
    if (dot(site, site) > 0.9) continue;
    vec3 hc = hash32(bc + 11.0);
    float land = landness((bc + 0.5) * CELL);
    if (hc.x > mix(uSeaCover, uLandCover, land)) continue;
    // Warp the domes so no cloud is a set of spheres.
    vec2 rel = -site * CELL + 140.0 * vec2(gnoise(p.xz / 520.0, vec2(0.0)), gnoise(p.xz / 520.0 + 5.2, vec2(0.0)));
    // Humilis over the sea, fuller clouds over the hills.
    float rb = CELL * (0.07 + 0.15 * hc.y) * (1.0 + 0.35 * land);
    float tall = (0.3 + 0.45 * hc.z) * (1.0 + 0.8 * land * hc.z);
    for (int k = 0; k < 6; k++) {
      vec3 hk = hash32(bc * 3.1 + float(k) * 17.7);
      vec3 hk2 = hash32(bc * 5.7 + float(k) * 31.3);
      if (k >= 3 && hk2.z > 0.6 + 0.3 * land) continue;
      float spread = k < 3 ? 0.85 : 0.5;
      vec2 off = (hk.xy - 0.5) * 2.0 * rb * spread * (k == 0 ? 0.3 : 1.0);
      float r = rb * (k < 3 ? 0.5 + 0.4 * hk.z : 0.3 + 0.22 * hk.z);
      float e;
      float tk;
      if (k < 3) {
        float ht = r * tall * (0.8 + 0.4 * hk2.x);
        tk = h / ht;
        float rr = r * sqrt(max(1.0 - tk * tk, 0.0)) * (1.0 + 0.3 * (1.0 - tk));
        e = (rr - length(rel - off)) / rb - max(tk - 1.0, 0.0) * (r / rb) * 2.0;
      } else {
        float cy = r * tall * (1.0 + 0.9 * hk2.x);
        vec2 dxz = rel - off;
        e = (r - length(vec3(dxz.x, (h - cy) * 1.15, dxz.y))) / rb;
        tk = h / (cy + r);
      }
      if (e > edge) { edge = e; top = tk; }
    }
  }
  hL = clamp(top, 0.0, 1.0);
  float ramp = smoothstep(0.0, 60.0, h);
  return edge * ramp - (1.0 - ramp);
}
// Density from the shape: the outline erodes into cauliflower billows and
// wisps (stronger with height), the flat base stays crisp.
float cloudDensity(vec3 p, float edge, float hL) {
  if (edge < -0.5) return 0.0;
  float n = fbm3(p / 210.0, 4);
  float det = fbm3(p / 55.0 + 3.1, 3);
  // Cauliflower turrets on the sunlit tops, ragged wisps at the sides, a flat base.
  float billow = (n - 0.5) * (0.8 + 1.5 * hL) + (det - 0.5) * (0.45 + 0.5 * hL);
  float d = edge * 2.2 + billow - 0.06;
  // Soft rim: thin density over the outer tenth instead of a hard surface.
  return clamp(d, 0.0, 1.0) * smoothstep(0.0, 0.25, d);
}
float cumulus(vec3 p, float alt, out float hL) {
  float e = cloudShape(p, alt, hL);
  return cloudDensity(p, e, hL);
}
float altitude(vec3 p) { return length(p + vec3(0.0, RE, 0.0)) - RE; }
float shell(vec3 o, vec3 d, float r) {
  vec3 oc = o + vec3(0.0, RE, 0.0);
  float b = dot(oc, d);
  float c = dot(oc, oc) - r * r;
  return -b + sqrt(max(b * b - c, 0.0));
}
float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5); }
// Transmittance of the hazy boundary layer along a ray to distance t.
float hazeT(vec3 d, float t) {
  float path = min(t, HAZE_TOP / max(d.y, 0.012));
  return exp(-path / HAZE_LEN);
}
// Cirrus: fibrous streaks along the upper wind (from the west-south-west).
float cirrus(vec2 xz) {
  vec2 q = mat2(0.93, -0.37, 0.37, 0.93) * xz;
  q *= vec2(1.0 / 9000.0, 1.0 / 2200.0);
  float big = fbm(q * 0.35 + 4.0, vec2(0.0), 4);
  float fib = fbm(q * vec2(1.0, 3.5), vec2(0.0), 5);
  float m = smoothstep(0.52, 0.72, big);
  return m * smoothstep(0.45, 0.8, fib);
}
`;

const CLOUD_BODY = /* glsl */ `
  float halfIdx = vUv.y < 0.5 ? 0.0 : 1.0;
  float lv = fract(vUv.y * 2.0);
  float el = lv * lv * PI * 0.5;
  float az = (vUv.x + halfIdx) * PI;
  vec3 dir = vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
  vec3 o = vec3(0.0, 17.0, 0.0);
  float t0 = shell(o, dir, RE + CB);
  float t1 = min(shell(o, dir, RE + CT), t0 + 26000.0);
  float mu = dot(dir, uSun);
  float phase = 0.6 * hg(mu, 0.6) + 0.4 * hg(mu, -0.25);
  float T = 1.0, sunAcc = 0.0, ambAcc = 0.0;
  // Coarse steps test the noise-free shape (grown by the noise's reach), so
  // thin wisps are never stepped over; fine steps integrate the density.
  const float DC = 120.0;
  const float DF = 24.0;
  float t = t0 + 0.5 * DC;
  int fine = 0;
  for (int i = 0; i < 1400; i++) {
    if (t > t1 || T < 0.01) break;
    vec3 p = o + dir * t;
    float hL;
    float edge = cloudShape(p, altitude(p), hL);
    if (fine == 0) {
      if (edge > -0.55) { t = max(t0, t - DC); fine = 14; continue; }
      t += DC;
      continue;
    }
    t += DF;
    if (edge <= -0.55) { fine--; continue; }
    fine = 14;
    float dens = cloudDensity(p, edge, hL);
    if (dens <= 0.0) continue;
    float a = 1.0 - exp(-dens * SIGMA * DF);
    float od = 0.0, ls = 40.0;
    vec3 q = p;
    for (int j = 0; j < 6; j++) {
      q += uSun * ls;
      float hq;
      od += cumulus(q, altitude(q), hq) * ls;
      ls *= 1.8;
    }
    float Tl = exp(-od * SIGMA);
    // Single scattering, a soft multiple-scattering lobe, and the darker
    // "powder" edge of a cloud seen away from the sun.
    float powder = 1.0 - 0.55 * exp(-dens * 6.0);
    float sunL = (Tl * phase + 0.22 * exp(-od * SIGMA * 0.22)) * powder;
    float ambL = 0.22 + 0.78 * pow(hL, 0.8);
    float hz = hazeT(dir, t);
    sunAcc += T * a * sunL * hz;
    ambAcc += T * a * ambL * hz;
    T *= 1.0 - a * hz;
  }
  // Cirrus in front of the cumulus tops' sky (above the haze).
  float tc = shell(o, dir, RE + CI);
  vec3 pc = o + dir * tc;
  float ci = cirrus(pc.xz) * 0.42 * hazeT(dir, tc) * smoothstep(0.0, 0.03, dir.y);
  float ciSun = ci * (0.5 * hg(mu, 0.75) + 0.35);
  float cov = 1.0 - T;
  outColor = vec4(
    clamp(cov + ci * T, 0.0, 1.0),
    clamp((sunAcc + ciSun * T) / ${SKY.sunScale.toFixed(1)}, 0.0, 1.0),
    clamp(ambAcc + ci * 0.85 * T, 0.0, 1.0),
    1.0);
`;

/**
 * Bakes the cloud panorama for a sun direction (unit vector toward the
 * sun). `coverage` is the share of cumulus cells over the bay; over land it
 * is `landCoverage`. `size` is the panorama's edge in pixels (the cooker
 * stores it at 1024).
 */
export function bakeClouds(baker: Baker, sun: Vector3, opts: { coverage?: number; landCoverage?: number; size?: number } = {}): Texture {
  const size = opts.size ?? 2048;
  const tex = baker.bake(size, size, CLOUD_BODY, {
    header: CLOUD_BAKE,
    uniforms: { uSun: { value: sun.clone() }, uSeaCover: { value: opts.coverage ?? 0.1 }, uLandCover: { value: opts.landCoverage ?? 0.42 } },
    mipmaps: false,
    repeat: false,
    tiles: 48,
  });
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.name = "sky-clouds";
  return tex;
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform float uPower;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform float uGlow;
uniform float uDisc;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmbient;
uniform float uFade;
uniform float uDrift;
uniform float uTime;
uniform float uHalfRows;
uniform sampler2D uClouds;
uniform float uProbe;
varying vec3 vDir;
#define PI 3.14159265
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0) + 1e-5, uPower));
  col = h < 0.0 ? mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0)) : col;
  // Light-probe capture only: the sky above 17° moves toward its luminance
  // grey (all of uProbe above 49°); the band the sea reflects is unchanged.
  col = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), uProbe * smoothstep(0.3, 0.75, h));
  float mu = dot(d, uSunDir);
  col += uSun * uGlow * (0.35 * pow(max(mu, 0.0), 6.0) + pow(max(mu, 0.0), 48.0));
  col += uSun * uDisc * smoothstep(0.99995, 0.99999, mu);
  if (h > 0.0) {
    float az = atan(d.x, -d.z) / (2.0 * PI);
    float a01 = fract(az + uDrift * uTime);
    float halfIdx = floor(a01 * 2.0);
    float u = fract(a01 * 2.0);
    float lv = sqrt(asin(clamp(h, 0.0, 1.0)) / (PI * 0.5));
    float v = (halfIdx + clamp(lv, 0.5 / uHalfRows, 1.0 - 0.5 / uHalfRows)) * 0.5;
    vec3 c = texture2D(uClouds, vec2(u, v)).rgb;
    float f = smoothstep(0.0, uFade, h);
    col = col * (1.0 - c.r * f) + (uCloudSun * ${SKY.sunScale.toFixed(1)} * c.g + uCloudAmbient * c.b) * f;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** Sky dome; its annotation carries every parameter the handheld needs to redraw it. */
export function buildSky(w: KamakuraWorld, sunDir: Vector3, clouds: Texture): { sky: Mesh; update: (t: number, cam: Vector3) => void } {
  const drift = 0.00004;
  const size = (clouds.image as { width?: number } | undefined)?.width ?? 2048;
  const mat = new ShaderMaterial({
    uniforms: {
      uZenith: { value: SKY.zenith },
      uHorizon: { value: SKY.horizon },
      uGround: { value: SKY.ground },
      uPower: { value: SKY.gradientPower },
      uSunDir: { value: sunDir.clone() },
      uSun: { value: SKY.sun },
      uGlow: { value: SKY.glow },
      uDisc: { value: SKY.disc },
      uCloudSun: { value: SKY.cloudSun },
      uCloudAmbient: { value: SKY.cloudAmbient },
      uFade: { value: SKY.fadeElevation },
      uDrift: { value: drift },
      uTime: { value: 0 },
      uHalfRows: { value: size / 2 },
      uClouds: { value: clouds },
      uProbe: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(1800, 64, 32), mat);
  sky.name = "sky";
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.dynamic = true;
  const arr = (c: Color) => [c.r, c.g, c.b];
  sky.userData.pocketAtlas = {
    kind: "sky",
    model: "gradient-sun-cloudpanorama",
    zenith: arr(SKY.zenith),
    horizon: arr(SKY.horizon),
    ground: arr(SKY.ground),
    gradientPower: SKY.gradientPower,
    groundBlend: 6,
    sunDirection: [sunDir.x, sunDir.y, sunDir.z],
    sunColor: arr(SKY.sun),
    glow: { intensity: SKY.glow, wide: [0.35, 6], tight: [1, 48] },
    disc: { intensity: SKY.disc, cosInner: 0.99999, cosOuter: 0.99995 },
    clouds: {
      file: "sky-clouds.png",
      size: [size, size],
      mapping: "two-half azimuth × sqrt(elevation); u = fract(a/π), v = (half + sqrt(e/(π/2)))/2; rows bottom-up",
      azimuthZero: [0, 0, -1],
      channels: { r: "opacity", g: "sunlit / sunScale", b: "skylit" },
      sunScale: SKY.sunScale,
      sunColor: arr(SKY.cloudSun),
      ambientColor: arr(SKY.cloudAmbient),
      fadeElevation: SKY.fadeElevation,
      driftTurnsPerSecond: drift,
      layer: {
        base: 900,
        top: 2900,
        cell: 1900,
        cirrus: 8500,
        haze: { top: 1500, length: 20000 },
        note: "baked offline (cumulus over land, sparse over the bay, cirrus streaks, boundary-layer haze); the handheld only samples the panorama",
      },
    },
  };
  w.root.add(sky);
  return {
    sky,
    update: (t, cam) => {
      mat.uniforms.uTime.value = t;
      sky.position.copy(cam);
    },
  };
}

/** Sky radiance in direction `d` without clouds (fog and hemisphere picks). */
export function skyColor(d: Vector3): Color {
  const h = d.y;
  const out = new Color();
  if (h >= 0) out.copy(SKY.horizon).lerp(SKY.zenith, Math.pow(h + 1e-5, SKY.gradientPower));
  else out.copy(SKY.horizon).lerp(SKY.ground, Math.min(1, -h * 6));
  return out;
}
