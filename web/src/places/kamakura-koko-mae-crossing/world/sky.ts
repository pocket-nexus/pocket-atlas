import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Texture } from "three";
import { SKY as SUGA_SKY } from "../../suga-shrine-stairs/world/sky";
import type { KamakuraWorld } from "./context";

export { bakeClouds } from "../../suga-shrine-stairs/world/sky";

/**
 * Summer afternoon sky over Sagami Bay: a deep blue zenith fading to the
 * milky horizon of a humid July day (no Fuji, no Ōshima), the sun high in the
 * west and scattered fair-weather cumulus (the panorama baked by Suga Shrine
 * Stairs' cloud model, `bakeClouds`). The model and its annotation are the
 * `gradient-sun-cloudpanorama` sky the handheld draws (`sky_day_f.cg`).
 */
export const SKY = {
  zenith: new Color(0.085, 0.27, 0.74),
  horizon: new Color(0.6, 0.72, 0.86),
  ground: new Color(0.36, 0.42, 0.46),
  sun: new Color(1.0, 0.94, 0.82),
  gradientPower: 0.36,
  glow: 0.24,
  disc: 40,
  cloudSun: new Color(1.0, 0.96, 0.88).multiplyScalar(1.35),
  cloudAmbient: new Color(0.5, 0.6, 0.76),
  /** The panorama stores sunlit radiance / sunScale (fixed by the bake). */
  sunScale: SUGA_SKY.sunScale,
  fadeElevation: 0.05,
};

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
uniform sampler2D uClouds;
varying vec3 vDir;
#define PI 3.14159265
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), uPower));
  col = h < 0.0 ? mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0)) : col;
  float mu = dot(d, uSunDir);
  col += uSun * uGlow * (0.35 * pow(max(mu, 0.0), 6.0) + pow(max(mu, 0.0), 48.0));
  col += uSun * uDisc * smoothstep(0.99995, 0.99999, mu);
  if (h > 0.0) {
    float az = atan(d.x, -d.z) / (2.0 * PI);
    float a01 = fract(az + uDrift * uTime);
    float halfIdx = floor(a01 * 2.0);
    float u = fract(a01 * 2.0);
    float lv = sqrt(asin(clamp(h, 0.0, 1.0)) / (PI * 0.5));
    float v = (halfIdx + clamp(lv, 0.5 / 512.0, 1.0 - 0.5 / 512.0)) * 0.5;
    vec3 c = texture2D(uClouds, vec2(u, v)).rgb;
    float f = smoothstep(0.0, uFade, h);
    col = col * (1.0 - c.r * f) + (uCloudSun * ${SKY.sunScale.toFixed(1)} * c.g + uCloudAmbient * c.b) * f;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** Sky dome; its annotation carries every parameter the handheld needs to redraw it. */
export function buildSky(w: KamakuraWorld, sunDir: Vector3, clouds: Texture): { sky: Mesh; update: (t: number, cam: Vector3) => void } {
  const drift = 0.00004;
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
      uClouds: { value: clouds },
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
      size: [1024, 1024],
      mapping: "two-half azimuth × sqrt(elevation); u = fract(a/π), v = (half + sqrt(e/(π/2)))/2; rows bottom-up",
      azimuthZero: [0, 0, -1],
      channels: { r: "opacity", g: "sunlit / sunScale", b: "skylit" },
      sunScale: SKY.sunScale,
      sunColor: arr(SKY.cloudSun),
      ambientColor: arr(SKY.cloudAmbient),
      fadeElevation: SKY.fadeElevation,
      driftTurnsPerSecond: drift,
      layer: { base: 1400, top: 4600, cell: 3300, note: "baked offline (Suga Shrine Stairs' cumulus model); the handheld only samples the panorama" },
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
  if (h >= 0) out.copy(SKY.horizon).lerp(SKY.zenith, Math.pow(h, SKY.gradientPower));
  else out.copy(SKY.horizon).lerp(SKY.ground, Math.min(1, -h * 6));
  return out;
}
