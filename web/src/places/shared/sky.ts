import { BackSide, ClampToEdgeWrapping, Color, LinearFilter, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Object3D, type Texture } from "three";
import type { Baker } from "./bake";

/**
 * The sky dome every place draws: the `gradient-sun-cloudpanorama` model of
 * the handheld's `sky_day_f.cg`, with the twilight terms of a sky after
 * sunset and an optional baked cloud panorama.
 *
 *   h  = d.y,   mu = max(d · sun, 0)
 *   sky    = mix(horizon, zenith, (h + 1e-5)^gradientPower)           (h ≥ 0)
 *          = mix(horizon, ground, min(−h · groundBlend, 1))           (h < 0)
 *   sky   += sunColor · glow.intensity · (wide.w · mu^wide.e + tight.w · mu^tight.e)
 *   sky   += sunColor · disc.intensity · smoothstep(disc.cosOuter, disc.cosInner, mu)
 *   ── twilight (`twilight` in the annotation) ──
 *   a      = dot(normalize(d.xz), normalize(sun.xz))  (azimuth cosine to the sun)
 *   sky   += band.color · exp(−|h| / band.height) · mix(1, ((a + 1) / 2)^band.sunPower, band.sunBias)
 *   sky   += belt.color · exp(−((h − belt.elevation) / belt.width)²) · ((1 − a) / 2)^belt.power
 *   sky   *= 1 − shadow.strength · exp(−|h| / shadow.height) · ((1 − a) / 2)^shadow.power
 *   ── clouds (`clouds`) ──
 *   sky    = sky · (1 − R·f) + (cloudSun · sunScale · G + cloudAmbient · B) · f,   f = smoothstep(0, fadeElevation, h)
 *
 * `band` is the warm afterglow along the horizon, strongest under the sun;
 * `belt` is the pink anti-twilight arch (Belt of Venus) opposite the sun and
 * `shadow` the Earth's blue-grey shadow beneath it. All colours are linear
 * HDR. The cloud panorama (`bakeCloudPanorama`) is laid out as
 *   azimuth a = atan2(d.x, −d.z) ∈ [0, 2π), elevation e = asin(d.y) ∈ [0, π/2]
 *   two halves: v ∈ [0, 0.5) covers a ∈ [0, π), v ∈ [0.5, 1) covers [π, 2π)
 *   u = fract(a / π), v = (half + sqrt(e / (π/2))) / 2, rows bottom-up
 * with R = opacity, G = sunlit radiance / sunScale, B = sky-lit radiance
 * (both already multiplied by the transmittance in front).
 */
export interface SkySpec {
  zenith: Color;
  horizon: Color;
  ground: Color;
  gradientPower: number;
  groundBlend: number;
  /** Unit vector toward the sun. */
  sun: Vector3;
  sunColor: Color;
  glow: { intensity: number; wide: [number, number]; tight: [number, number] };
  /** Sun disc; off when the sun is below the horizon. */
  disc?: { intensity: number };
  twilight?: {
    band: { color: Color; height: number; sunBias: number; sunPower: number };
    belt: { color: Color; elevation: number; width: number; power: number };
    shadow: { strength: number; height: number; power: number };
  };
  clouds?: SkyClouds;
}

/** How the dome composites a baked cloud panorama. */
export interface SkyClouds {
  texture: Texture;
  sunColor: Color;
  ambientColor: Color;
  fadeElevation: number;
  /** Panorama turns per second of place time. */
  drift: number;
  /** The bake's spec (layer heights for the annotation, sunScale). */
  bake: CloudSpec;
}

/** Distinct cosines keep a renderer's smoothstep finite when the disc is off. */
const DISC = { cosInner: 0.99999, cosOuter: 0.99995 };

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
uniform vec2 uGradient;
uniform vec3 uSunDir;
uniform vec3 uSunGlow;
uniform vec4 uLobes;
uniform vec3 uSunDisc;
uniform vec2 uDiscCos;
uniform float uProbe;
#ifdef TWILIGHT
uniform vec3 uBand;
uniform vec3 uBandShape;
uniform vec3 uBelt;
uniform vec3 uBeltShape;
uniform vec3 uShadow;
#endif
#ifdef CLOUDS
uniform sampler2D uClouds;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmbient;
uniform float uSunScale;
uniform float uFade;
uniform float uDrift;
uniform float uTime;
uniform float uHalfRows;
#endif
varying vec3 vDir;
#define PI 3.14159265
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0) + 1e-5, uGradient.x));
  if (h < 0.0) col = mix(uHorizon, uGround, clamp(-h * uGradient.y, 0.0, 1.0));
  // Light-probe capture only (setProbe): the sky above 17° moves toward its
  // luminance grey (all of uProbe above 49°); the band the sea reflects keeps its colour.
  col = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), uProbe * smoothstep(0.3, 0.75, h));
  float mu = max(dot(d, uSunDir), 0.0);
  col += uSunGlow * (uLobes.x * pow(mu, uLobes.y) + uLobes.z * pow(mu, uLobes.w));
  col += uSunDisc * smoothstep(uDiscCos.x, uDiscCos.y, mu);
#ifdef TWILIGHT
  vec2 dh = normalize(d.xz + vec2(1e-5));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  float a = clamp(dot(dh, sh), -1.0, 1.0);
  float hp = abs(h);
  float toward = max((a + 1.0) * 0.5, 0.0);
  float away = max((1.0 - a) * 0.5, 0.0);
  col += uBand * exp(-hp / uBandShape.x) * mix(1.0, pow(toward, uBandShape.z), uBandShape.y);
  float bz = (h - uBeltShape.x) / uBeltShape.y;
  col += uBelt * exp(-bz * bz) * pow(away, uBeltShape.z);
  col *= 1.0 - uShadow.x * exp(-hp / uShadow.y) * pow(away, uShadow.z);
#endif
#ifdef CLOUDS
  if (h > 0.0) {
    float az = atan(d.x, -d.z) / (2.0 * PI);
    float a01 = fract(az + uDrift * uTime);
    float halfIdx = floor(a01 * 2.0);
    float u = fract(a01 * 2.0);
    float lv = sqrt(asin(clamp(h, 0.0, 1.0)) / (PI * 0.5));
    float v = (halfIdx + clamp(lv, 0.5 / uHalfRows, 1.0 - 0.5 / uHalfRows)) * 0.5;
    vec3 c = texture2D(uClouds, vec2(u, v)).rgb;
    float f = smoothstep(0.0, uFade, h);
    col = col * (1.0 - c.r * f) + (uCloudSun * uSunScale * c.g + uCloudAmbient * c.b) * f;
  }
#endif
  gl_FragColor = vec4(col, 1.0);
}`;

export interface Sky {
  sky: Mesh;
  /** Follows the camera and drifts the clouds on the place clock. */
  update(t: number, cam: Vector3): void;
  /** Probe desaturation of the upper sky (0 = the dome as seen; set only while capturing the light probe). */
  setProbe(k: number): void;
}

const arr = (c: Color) => [c.r, c.g, c.b];

/** Builds the dome under `parent`; its annotation carries every term for the handheld. */
export function buildSky(parent: Object3D, s: SkySpec, radius = 1800): Sky {
  const sun = s.sun.clone();
  const disc = s.disc?.intensity ?? 0;
  const uniforms: Record<string, { value: unknown }> = {
    uZenith: { value: s.zenith },
    uHorizon: { value: s.horizon },
    uGround: { value: s.ground },
    uGradient: { value: [s.gradientPower, s.groundBlend] },
    uSunDir: { value: sun },
    uSunGlow: { value: s.sunColor.clone().multiplyScalar(s.glow.intensity) },
    uLobes: { value: [s.glow.wide[0], s.glow.wide[1], s.glow.tight[0], s.glow.tight[1]] },
    uSunDisc: { value: s.sunColor.clone().multiplyScalar(disc) },
    uDiscCos: { value: [DISC.cosOuter, DISC.cosInner] },
    uProbe: { value: 0 },
  };
  const defines: Record<string, string> = {};
  const tw = s.twilight;
  if (tw) {
    defines.TWILIGHT = "";
    Object.assign(uniforms, {
      uBand: { value: tw.band.color },
      uBandShape: { value: [tw.band.height, tw.band.sunBias, tw.band.sunPower] },
      uBelt: { value: tw.belt.color },
      uBeltShape: { value: [tw.belt.elevation, tw.belt.width, tw.belt.power] },
      uShadow: { value: [tw.shadow.strength, tw.shadow.height, tw.shadow.power] },
    });
  }
  const cl = s.clouds;
  if (cl) {
    defines.CLOUDS = "";
    Object.assign(uniforms, {
      uClouds: { value: cl.texture },
      uCloudSun: { value: cl.sunColor },
      uCloudAmbient: { value: cl.ambientColor },
      uSunScale: { value: cl.bake.sunScale },
      uFade: { value: cl.fadeElevation },
      uDrift: { value: cl.drift },
      uTime: { value: 0 },
      uHalfRows: { value: cl.bake.size / 2 },
    });
  }
  const mat = new ShaderMaterial({ uniforms, defines, vertexShader: VERT, fragmentShader: FRAG, side: BackSide, depthWrite: false, fog: false });
  const sky = new Mesh(new SphereGeometry(radius, 64, 32), mat);
  sky.name = "sky";
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.dynamic = true;
  const ann: Record<string, unknown> = {
    kind: "sky",
    model: "gradient-sun-cloudpanorama",
    zenith: arr(s.zenith),
    horizon: arr(s.horizon),
    ground: arr(s.ground),
    gradientPower: s.gradientPower,
    groundBlend: s.groundBlend,
    sunDirection: [sun.x, sun.y, sun.z],
    sunColor: arr(s.sunColor),
    glow: { intensity: s.glow.intensity, wide: s.glow.wide, tight: s.glow.tight },
    disc: { intensity: disc, ...DISC },
    clouds: cl ? cloudAnnotation(cl) : { sunColor: [0, 0, 0], ambientColor: [0, 0, 0], fadeElevation: 0.04, driftTurnsPerSecond: 0 },
  };
  if (tw)
    ann.twilight = {
      band: { color: arr(tw.band.color), height: tw.band.height, sunBias: tw.band.sunBias, sunPower: tw.band.sunPower },
      belt: { color: arr(tw.belt.color), elevation: tw.belt.elevation, width: tw.belt.width, power: tw.belt.power },
      shadow: { strength: tw.shadow.strength, height: tw.shadow.height, power: tw.shadow.power },
      note: "a = cos of the azimuth difference to the sun (xz); h = d.y; see places/shared/sky.ts",
    };
  sky.userData.pocketAtlas = ann;
  parent.add(sky);
  return {
    sky,
    update: (t, cam) => {
      if (cl) mat.uniforms.uTime.value = t;
      sky.position.copy(cam);
    },
    setProbe: (k) => {
      mat.uniforms.uProbe.value = k;
    },
  };
}

function cloudAnnotation(cl: SkyClouds): Record<string, unknown> {
  const b = cl.bake;
  const layer: Record<string, unknown> = { base: b.layer.base, top: b.layer.top, cell: b.layer.cell };
  if (b.cirrus) layer.cirrus = b.cirrus.height;
  if (b.haze.kind === "layer") layer.haze = { top: b.haze.top, length: b.haze.length };
  layer.note = b.note;
  return {
    file: "sky-clouds.png",
    size: [b.size, b.size],
    mapping: "two-half azimuth × sqrt(elevation); u = fract(a/π), v = (half + sqrt(e/(π/2)))/2; rows bottom-up",
    azimuthZero: [0, 0, -1],
    channels: { r: "opacity", g: "sunlit / sunScale", b: "skylit" },
    sunScale: b.sunScale,
    sunColor: arr(cl.sunColor),
    ambientColor: arr(cl.ambientColor),
    fadeElevation: cl.fadeElevation,
    driftTurnsPerSecond: cl.drift,
    layer,
  };
}

/** Sky radiance in direction `d` without clouds or disc (hemisphere and fog colour picks). */
export function skyColor(s: SkySpec, d: Vector3): Color {
  const h = d.y;
  const out = new Color();
  if (h >= 0) out.copy(s.horizon).lerp(s.zenith, Math.pow(h + 1e-5, s.gradientPower));
  else out.copy(s.horizon).lerp(s.ground, Math.min(1, -h * s.groundBlend));
  const sun = s.sun;
  const mu = Math.max(d.dot(sun), 0);
  out.add(s.sunColor.clone().multiplyScalar(s.glow.intensity * (s.glow.wide[0] * Math.pow(mu, s.glow.wide[1]) + s.glow.tight[0] * Math.pow(mu, s.glow.tight[1]))));
  const tw = s.twilight;
  if (!tw) return out;
  const dl = Math.hypot(d.x, d.z) || 1;
  const sl = Math.hypot(sun.x, sun.z) || 1;
  const a = (d.x * sun.x + d.z * sun.z) / (dl * sl);
  const hp = Math.abs(h);
  out.add(tw.band.color.clone().multiplyScalar(Math.exp(-hp / tw.band.height) * (1 + (Math.pow((a + 1) / 2, tw.band.sunPower) - 1) * tw.band.sunBias)));
  const bz = (h - tw.belt.elevation) / tw.belt.width;
  const away = (1 - a) / 2;
  out.add(tw.belt.color.clone().multiplyScalar(Math.exp(-bz * bz) * Math.pow(away, tw.belt.power)));
  out.multiplyScalar(1 - tw.shadow.strength * Math.exp(-hp / tw.shadow.height) * Math.pow(away, tw.shadow.power));
  return out;
}

// ------------------------------------------------------- cloud panorama

/**
 * Fair-weather cumulus baked once into the panorama, by ray marching a
 * layer of Worley-cell clouds (each three flat-based domes and up to three
 * rounded turrets, billowed by 3D noise) with single scattering toward the
 * sun, a soft multiple-scattering lobe and sky light rising with height.
 * Every number below is the place's own; `land` grows the clouds over land,
 * `cirrus` adds a streaked deck above, `haze` fades the distance.
 */
export interface CloudSpec {
  /** Panorama edge (pixels; the cooker stores it at 1024) and bake tiles. */
  size: number;
  tiles: number;
  /** Eye height of the panorama (m). */
  eye: number;
  /** Sunlit radiance is stored divided by this. */
  sunScale: number;
  /** Cumulus layer base and top (m), Worley cell (m), extinction (1/m). */
  layer: { base: number; top: number; cell: number; sigma: number };
  /** Share of cells that hold a cloud (over sea or open country). */
  coverage: number;
  /**
   * Land under the cloud field: GLSL body of `float landness(vec2 xz)`
   * (x east, z south, metres from the place) in 0..1; over land the share is
   * `coverage`, clouds grow `size` wider and `height` taller and keep more
   * turrets, and the domes' outline warps by `warp` = [metres, scale].
   */
  land?: { glsl: string; coverage: number; size: number; height: number; turrets: number; warp: [number, number] };
  /** Cloud shape: cell-grid warp [amplitude, frequency], site radius², radius, height, turret skip, dome spread, dome and turret radii, dome bulge, base ramp (m). */
  shape: {
    warp: [number, number];
    site: number;
    radius: [number, number];
    tall: [number, number];
    turrets: number;
    spread: number;
    dome: [number, number];
    turret: [number, number];
    bulge: number;
    ramp: number;
  };
  /** Density from the shape: cutoff, noise scales (m), detail octaves, billow coefficients, edge gain, bias, soft rim. */
  density: { cutoff: number; scale: [number, number]; detail: number; billow: [number, number, number, number]; gain: number; bias: number; rim?: number };
  /** Marching: distance cap past the base (m), coarse and fine steps (m), step budget, fine hold, shape threshold, light steps [first, growth]. */
  march: { reach: number; coarse: number; fine: number; steps: number; hold: number; edge: number; light: [number, number] };
  /** Phase [w1, g1, w2, g2], multiple scattering [weight, od scale], powder darkening, sky light [a, b, exponent]. */
  light: { phase: [number, number, number, number]; multiple: [number, number]; powder?: number; ambient: [number, number, number] };
  /** Haze: by distance to the cloud base, or a boundary layer of `top` m traversed per sample. */
  haze: { kind: "distance"; length: number } | { kind: "layer"; top: number; length: number };
  /** Cirrus deck: height (m), opacity, forward-scatter g, ambient, GLSL body of `float cirrus(vec2 xz)`. */
  cirrus?: { height: number; opacity: number; forward: number; ambient: number; glsl: string };
  /** For the annotation. */
  note: string;
}

/** A GLSL float literal. */
const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

function cloudGlsl(s: CloudSpec): { header: string; body: string } {
  const L = s.land;
  const sh = s.shape;
  const dn = s.density;
  const m = s.march;
  const li = s.light;
  const hz = s.haze;
  const ci = s.cirrus;
  const header = /* glsl */ `
uniform vec3 uSun;
${L ? "uniform float uSeaCover;\nuniform float uLandCover;" : "uniform float uCoverage;"}
#define PI 3.14159265
const float RE = 6371000.0;
const float CB = ${f(s.layer.base)};
const float CT = ${f(s.layer.top)};
const float CELL = ${f(s.layer.cell)};
const float SIGMA = ${f(s.layer.sigma)};
${ci ? `const float CI = ${f(ci.height)};` : ""}
${hz.kind === "layer" ? `const float HAZE_TOP = ${f(hz.top)};\nconst float HAZE_LEN = ${f(hz.length)};` : ""}

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
${L ? `float landness(vec2 xz) {\n${L.glsl}\n}` : ""}
// Worley sites carry a cloud of three flat-based domes and up to three
// turrets; the outline is billowed by 3D noise in cloudDensity.
// Returns the shape's signed edge; hL = height within the cloud (0 at the base, 1 at the top).
float cloudShape(vec3 p, float alt, out float hL) {
  hL = 0.0;
  float h = alt - CB;
  if (h < 0.0 || h > CT - CB) return -1.0;
  vec2 q = p.xz / CELL;
  q += ${f(sh.warp[0])} * vec2(gnoise(q * ${f(sh.warp[1])}, vec2(0.0)), gnoise(q * ${f(sh.warp[1])} + 7.3, vec2(0.0)));
  vec2 i = floor(q), f = fract(q);
  float edge = -1.0;
  float top = 0.0;
  // Union over the neighbouring sites, so no cloud is cut at a cell border.
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 bc = i + o;
    vec2 site = o + hash22(bc) - f;
    if (dot(site, site) > ${f(sh.site)}) continue;
    vec3 hc = hash32(bc + 11.0);
${
  L
    ? `    float land = landness((bc + 0.5) * CELL);
    if (hc.x > mix(uSeaCover, uLandCover, land)) continue;
    vec2 rel = -site * CELL + ${f(L.warp[0])} * vec2(gnoise(p.xz / ${f(L.warp[1])}, vec2(0.0)), gnoise(p.xz / ${f(L.warp[1])} + 5.2, vec2(0.0)));
    float rb = CELL * (${f(sh.radius[0])} + ${f(sh.radius[1])} * hc.y) * (1.0 + ${f(L.size)} * land);
    float tall = (${f(sh.tall[0])} + ${f(sh.tall[1])} * hc.z) * (1.0 + ${f(L.height)} * land * hc.z);`
    : `    if (hc.x > uCoverage) continue;
    vec2 rel = -site * CELL;
    float rb = CELL * (${f(sh.radius[0])} + ${f(sh.radius[1])} * hc.y);
    float tall = ${f(sh.tall[0])} + ${f(sh.tall[1])} * hc.z;`
}
    for (int k = 0; k < 6; k++) {
      vec3 hk = hash32(bc * 3.1 + float(k) * 17.7);
      vec3 hk2 = hash32(bc * 5.7 + float(k) * 31.3);
      if (k >= 3 && hk2.z > ${L ? `${f(sh.turrets)} + ${f(L.turrets)} * land` : f(sh.turrets)}) continue;
      float spread = k < 3 ? ${f(sh.spread)} : 0.5;
      vec2 off = (hk.xy - 0.5) * 2.0 * rb * spread * (k == 0 ? 0.3 : 1.0);
      float r = rb * (k < 3 ? ${f(sh.dome[0])} + ${f(sh.dome[1])} * hk.z : ${f(sh.turret[0])} + ${f(sh.turret[1])} * hk.z);
      float e;
      float tk;
      if (k < 3) {
        // Flat-based dome; above its top the edge keeps falling, so no noise column rises from it.
        float ht = r * tall * (0.8 + 0.4 * hk2.x);
        tk = h / ht;
        float rr = r * sqrt(max(1.0 - tk * tk, 0.0)) * (1.0 + ${f(sh.bulge)} * (1.0 - tk));
        e = (rr - length(rel - off)) / rb - max(tk - 1.0, 0.0) * (r / rb) * 2.0;
      } else {
        // Turret: a sphere standing on the domes.
        float cy = r * tall * (1.0 + 0.9 * hk2.x);
        vec2 dxz = rel - off;
        e = (r - length(vec3(dxz.x, (h - cy) * 1.15, dxz.y))) / rb;
        tk = h / (cy + r);
      }
      if (e > edge) { edge = e; top = tk; }
    }
  }
  hL = clamp(top, 0.0, 1.0);
  float ramp = smoothstep(0.0, ${f(sh.ramp)}, h);
  return edge * ramp - (1.0 - ramp);
}
// Density from the shape: billows grow with height; the base stays crisp and flat.
float cloudDensity(vec3 p, float edge, float hL) {
  if (edge < ${f(dn.cutoff)}) return 0.0;
  float n = fbm3(p / ${f(dn.scale[0])}, 4);
  float det = fbm3(p / ${f(dn.scale[1])} + 3.1, ${dn.detail});
  float billow = (n - 0.5) * (${f(dn.billow[0])} + ${f(dn.billow[1])} * hL) + (det - 0.5) * (${f(dn.billow[2])} + ${f(dn.billow[3])} * hL);
  float d = edge * ${f(dn.gain)} + billow - ${f(dn.bias)};
  return ${dn.rim !== undefined ? `clamp(d, 0.0, 1.0) * smoothstep(0.0, ${f(dn.rim)}, d)` : "clamp(d, 0.0, 1.0)"};
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
${
  hz.kind === "layer"
    ? `// Transmittance of the hazy boundary layer along a ray to distance t.
float hazeT(vec3 d, float t) {
  float path = min(t, HAZE_TOP / max(d.y, 0.012));
  return exp(-path / HAZE_LEN);
}`
    : ""
}
${ci ? `float cirrus(vec2 xz) {\n${ci.glsl}\n}` : ""}
`;
  const layered = hz.kind === "layer";
  const body = /* glsl */ `
  float halfIdx = vUv.y < 0.5 ? 0.0 : 1.0;
  float lv = fract(vUv.y * 2.0);
  float el = lv * lv * PI * 0.5;
  float az = (vUv.x + halfIdx) * PI;
  vec3 dir = vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
  vec3 o = vec3(0.0, ${f(s.eye)}, 0.0);
  float t0 = shell(o, dir, RE + CB);
  float t1 = min(shell(o, dir, RE + CT), t0 + ${f(m.reach)});
  float mu = dot(dir, uSun);
  float phase = ${f(li.phase[0])} * hg(mu, ${f(li.phase[1])}) + ${f(li.phase[2])} * hg(mu, ${f(li.phase[3])});
  float T = 1.0, sunAcc = 0.0, ambAcc = 0.0;
  // Coarse steps test the noise-free shape (grown by the noise's reach), so
  // thin wisps are never stepped over; fine steps integrate the density.
  const float DC = ${f(m.coarse)};
  const float DF = ${f(m.fine)};
  float t = t0 + 0.5 * DC;
  int fine = 0;
  for (int i = 0; i < ${m.steps}; i++) {
    if (t > t1 || T < 0.01) break;
    vec3 p = o + dir * t;
    float hL;
    float edge = cloudShape(p, altitude(p), hL);
    if (fine == 0) {
      if (edge > ${f(m.edge)}) { t = max(t0, t - DC); fine = ${m.hold}; continue; }
      t += DC;
      continue;
    }
    t += DF;
    if (edge <= ${f(m.edge)}) { fine--; continue; }
    fine = ${m.hold};
    float dens = cloudDensity(p, edge, hL);
    if (dens <= 0.0) continue;
    float a = 1.0 - exp(-dens * SIGMA * DF);
    float od = 0.0, ls = ${f(m.light[0])};
    vec3 q = p;
    for (int j = 0; j < 6; j++) {
      q += uSun * ls;
      float hq;
      od += cumulus(q, altitude(q), hq) * ls;
      ls *= ${f(m.light[1])};
    }
    float Tl = exp(-od * SIGMA);
${
  li.powder !== undefined
    ? `    // Single scattering, a soft multiple-scattering lobe, and the darker
    // "powder" edge of a cloud seen away from the sun.
    float powder = 1.0 - ${f(li.powder)} * exp(-dens * 6.0);
    float sunL = (Tl * phase + ${f(li.multiple[0])} * exp(-od * SIGMA * ${f(li.multiple[1])})) * powder;`
    : `    // Single scattering plus a soft multiple-scattering lobe.
    float sunL = Tl * phase + ${f(li.multiple[0])} * exp(-od * SIGMA * ${f(li.multiple[1])});`
}
    float ambL = ${f(li.ambient[0])} + ${f(li.ambient[1])} * pow(hL, ${f(li.ambient[2])});
${
  layered
    ? `    float hz = hazeT(dir, t);
    sunAcc += T * a * sunL * hz;
    ambAcc += T * a * ambL * hz;
    T *= 1.0 - a * hz;`
    : `    sunAcc += T * a * sunL;
    ambAcc += T * a * ambL;
    T *= 1.0 - a;`
}
  }
${
  ci
    ? `  // Cirrus in front of the cumulus tops' sky (above the haze).
  float tc = shell(o, dir, RE + CI);
  vec3 pc = o + dir * tc;
  float ci = cirrus(pc.xz) * ${f(ci.opacity)} * ${layered ? "hazeT(dir, tc)" : "1.0"} * smoothstep(0.0, 0.03, dir.y);
  float ciSun = ci * (0.5 * hg(mu, ${f(ci.forward)}) + 0.35);
  float cov = 1.0 - T;
  outColor = vec4(
    clamp(cov + ci * T, 0.0, 1.0),
    clamp((sunAcc + ciSun * T) / ${f(s.sunScale)}, 0.0, 1.0),
    clamp(ambAcc + ci * ${f(ci.ambient)} * T, 0.0, 1.0),
    1.0);`
    : hz.kind === "distance"
      ? `  float haze = exp(-t0 / ${f(hz.length)});
  outColor = vec4((1.0 - T) * haze, clamp(sunAcc * haze / ${f(s.sunScale)}, 0.0, 1.0), clamp(ambAcc * haze, 0.0, 1.0), 1.0);`
      : `  outColor = vec4(1.0 - T, clamp(sunAcc / ${f(s.sunScale)}, 0.0, 1.0), clamp(ambAcc, 0.0, 1.0), 1.0);`
}
`;
  return { header, body };
}

/** Bakes the cloud panorama for a sun direction (unit vector toward the sun). */
export function bakeCloudPanorama(baker: Baker, sun: Vector3, spec: CloudSpec): Texture {
  const { header, body } = cloudGlsl(spec);
  const uniforms: Record<string, { value: unknown }> = { uSun: { value: sun.clone() } };
  if (spec.land) {
    uniforms.uSeaCover = { value: spec.coverage };
    uniforms.uLandCover = { value: spec.land.coverage };
  } else uniforms.uCoverage = { value: spec.coverage };
  const tex = baker.bake(spec.size, spec.size, body, { header, uniforms, mipmaps: false, repeat: false, tiles: spec.tiles });
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.name = "sky-clouds";
  return tex;
}
