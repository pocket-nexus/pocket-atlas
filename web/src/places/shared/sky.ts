import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Object3D } from "three";

/**
 * Twilight sky dome for places lit after sunset (blue hour, dusk). It extends
 * the daytime `gradient-sun-cloudpanorama` model (Suga Shrine Stairs) with
 * the terms a sky needs once the sun is below the horizon, and exports under
 * the same model name so a renderer that only knows the daytime model still
 * draws the gradient and the sun's glow:
 *
 *   h  = d.y,   mu = max(d · sun, 0)
 *   sky    = mix(horizon, zenith, h^gradientPower)               (h ≥ 0)
 *          = mix(horizon, ground, min(−h · groundBlend, 1))      (h < 0)
 *   sky   += sunColor · glow.intensity · (wide.w · mu^wide.e + tight.w · mu^tight.e)   (tight.w = 1 in the daytime model)
 *   ── twilight extension (`twilight` in the annotation) ──
 *   a      = dot(normalize(d.xz), normalize(sun.xz))  (azimuth cosine to the sun)
 *   sky   += band.color · exp(−|h| / band.height) · mix(1, ((a + 1) / 2)^band.sunPower, band.sunBias)
 *   sky   += belt.color · exp(−((h − belt.elevation) / belt.width)²) · ((1 − a) / 2)^belt.power
 *   sky   *= 1 − shadow.strength · exp(−|h| / shadow.height) · ((1 − a) / 2)^shadow.power
 *
 * `band` is the warm afterglow along the horizon, strongest under the sun;
 * `belt` is the pink anti-twilight arch (Belt of Venus) opposite the sun and
 * `shadow` the Earth's blue-grey shadow beneath it. The sun disc is off
 * (disc.intensity = 0) below the horizon. All colours are linear HDR.
 */
export interface TwilightSky {
  zenith: Color;
  horizon: Color;
  ground: Color;
  gradientPower: number;
  groundBlend: number;
  sun: Vector3;
  sunColor: Color;
  glow: { intensity: number; wide: [number, number]; tight: [number, number] };
  band: { color: Color; height: number; sunBias: number; sunPower: number };
  belt: { color: Color; elevation: number; width: number; power: number };
  shadow: { strength: number; height: number; power: number };
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
uniform vec2 uGradient;
uniform vec3 uSunDir;
uniform vec3 uSunGlow;
uniform vec4 uLobes;
uniform vec3 uBand;
uniform vec3 uBandShape;
uniform vec3 uBelt;
uniform vec3 uBeltShape;
uniform vec3 uShadow;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0) + 1e-5, uGradient.x));
  if (h < 0.0) col = mix(uHorizon, uGround, clamp(-h * uGradient.y, 0.0, 1.0));
  float mu = max(dot(d, uSunDir), 0.0);
  col += uSunGlow * (uLobes.x * pow(mu, uLobes.y) + uLobes.z * pow(mu, uLobes.w));
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
  gl_FragColor = vec4(col, 1.0);
}`;

/** Builds the dome under `parent`; its annotation carries every term for the handheld. */
export function buildTwilightSky(parent: Object3D, s: TwilightSky, radius = 1800): { sky: Mesh; update: (cam: Vector3) => void } {
  const mat = new ShaderMaterial({
    uniforms: {
      uZenith: { value: s.zenith },
      uHorizon: { value: s.horizon },
      uGround: { value: s.ground },
      uGradient: { value: [s.gradientPower, s.groundBlend] },
      uSunDir: { value: s.sun.clone().normalize() },
      uSunGlow: { value: s.sunColor.clone().multiplyScalar(s.glow.intensity) },
      uLobes: { value: [s.glow.wide[0], s.glow.wide[1], s.glow.tight[0], s.glow.tight[1]] },
      uBand: { value: s.band.color },
      uBandShape: { value: [s.band.height, s.band.sunBias, s.band.sunPower] },
      uBelt: { value: s.belt.color },
      uBeltShape: { value: [s.belt.elevation, s.belt.width, s.belt.power] },
      uShadow: { value: [s.shadow.strength, s.shadow.height, s.shadow.power] },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new Mesh(new SphereGeometry(radius, 64, 32), mat);
  sky.name = "sky";
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.dynamic = true;
  const arr = (c: Color) => [c.r, c.g, c.b];
  const sun = s.sun.clone().normalize();
  sky.userData.pocketAtlas = {
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
    // Below the horizon there is no disc; distinct cosines keep a renderer's smoothstep finite.
    disc: { intensity: 0, cosInner: 0.99999, cosOuter: 0.99995 },
    clouds: { sunColor: [0, 0, 0], ambientColor: [0, 0, 0], fadeElevation: 0.04, driftTurnsPerSecond: 0 },
    twilight: {
      band: { color: arr(s.band.color), height: s.band.height, sunBias: s.band.sunBias, sunPower: s.band.sunPower },
      belt: { color: arr(s.belt.color), elevation: s.belt.elevation, width: s.belt.width, power: s.belt.power },
      shadow: { strength: s.shadow.strength, height: s.shadow.height, power: s.shadow.power },
      note: "a = cos of the azimuth difference to the sun (xz); h = d.y; see places/shared/sky.ts",
    },
  };
  parent.add(sky);
  return {
    sky,
    update: (cam) => sky.position.copy(cam),
  };
}

/** Sky colour in direction `d` (for the hemisphere light and fog colour picks). */
export function twilightColor(s: TwilightSky, d: Vector3): Color {
  const h = d.y;
  const out = new Color();
  if (h >= 0) out.copy(s.horizon).lerp(s.zenith, Math.pow(h + 1e-5, s.gradientPower));
  else out.copy(s.horizon).lerp(s.ground, Math.min(1, -h * s.groundBlend));
  const sun = s.sun.clone().normalize();
  const mu = Math.max(d.dot(sun), 0);
  out.add(s.sunColor.clone().multiplyScalar(s.glow.intensity * (s.glow.wide[0] * Math.pow(mu, s.glow.wide[1]) + s.glow.tight[0] * Math.pow(mu, s.glow.tight[1]))));
  const dl = Math.hypot(d.x, d.z) || 1;
  const sl = Math.hypot(sun.x, sun.z) || 1;
  const a = (d.x * sun.x + d.z * sun.z) / (dl * sl);
  const hp = Math.abs(h);
  out.add(s.band.color.clone().multiplyScalar(Math.exp(-hp / s.band.height) * (1 + (Math.pow((a + 1) / 2, s.band.sunPower) - 1) * s.band.sunBias)));
  const bz = (h - s.belt.elevation) / s.belt.width;
  const away = (1 - a) / 2;
  out.add(s.belt.color.clone().multiplyScalar(Math.exp(-bz * bz) * Math.pow(away, s.belt.power)));
  out.multiplyScalar(1 - s.shadow.strength * Math.exp(-hp / s.shadow.height) * Math.pow(away, s.shadow.power));
  return out;
}
