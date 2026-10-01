import { Color, type Texture, type Vector3 } from "three";
import type { Baker } from "../../shared/bake";
import { bakeCloudPanorama, buildSky, type CloudSpec, type Sky } from "../../shared/sky";
import type { KamakuraWorld } from "./context";

/**
 * Summer afternoon sky over Sagami Bay (late July, 15:30): a blue zenith
 * fading to the milky horizon of a humid day, the sun high in the west, and a
 * cloud panorama baked once for this place. The dome, its annotation and the
 * panorama's layout are the `gradient-sun-cloudpanorama` sky of
 * `shared/sky.ts`, which the handheld draws (`sky_day_f.cg`).
 *
 * The panorama holds what a July afternoon shows from the coast:
 *  - fair-weather cumulus (base 900 m, tops to 2.9 km) that grow over land
 *    (the Kamakura hills to the north, the Miura peninsula to the east and
 *    south-east, Hakone and Izu far to the west-south-west) and stay sparse
 *    over the bay;
 *  - a thin cirrus layer at 8.5 km, streaked along the upper wind;
 *  - the haze of the boundary layer (the lowest 1.5 km), which fades the
 *    distant clouds into the horizon band.
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

/** The cumulus, cirrus and haze of the panorama (`shared/sky.ts` bakes it). */
const CLOUDS: CloudSpec = {
  size: 2048,
  tiles: 48,
  eye: 17,
  sunScale: 2.5,
  layer: { base: 900, top: 2900, cell: 1900, sigma: 0.028 },
  coverage: 0.08,
  land: {
    // Land under the cloud field (x east, z south, metres from the crossing):
    // cumulus build over the hills in a sea breeze and stay sparse over the bay.
    glsl: /* glsl */ `
  float d = length(xz);
  float az = degrees(atan(xz.x, -xz.y));
  if (az < 0.0) az += 360.0;
  float north = 1.0 - smoothstep(-2600.0, -500.0, xz.y);
  float miura = smoothstep(94.0, 101.0, az) * (1.0 - smoothstep(150.0, 158.0, az)) * smoothstep(5500.0, 8500.0, d);
  float izu = smoothstep(212.0, 222.0, az) * (1.0 - smoothstep(272.0, 285.0, az)) * smoothstep(32000.0, 45000.0, d);
  float shonan = smoothstep(252.0, 262.0, az) * smoothstep(4000.0, 8000.0, d);
  return clamp(north + miura + izu + shonan, 0.0, 1.0);`,
    coverage: 0.24,
    size: 0.35,
    height: 0.8,
    turrets: 0.3,
    warp: [140, 520],
  },
  // Humilis over the sea, fuller clouds over the hills.
  shape: { warp: [0.25, 0.5], site: 0.9, radius: [0.07, 0.15], tall: [0.3, 0.45], turrets: 0.6, spread: 0.85, dome: [0.5, 0.4], turret: [0.3, 0.22], bulge: 0.3, ramp: 60 },
  // Cauliflower turrets on the sunlit tops, ragged wisps at the sides, a flat base, a soft rim.
  density: { cutoff: -0.5, scale: [210, 55], detail: 3, billow: [0.8, 1.5, 0.45, 0.5], gain: 2.2, bias: 0.06, rim: 0.25 },
  march: { reach: 26000, coarse: 120, fine: 24, steps: 1400, hold: 14, edge: -0.55, light: [40, 1.8] },
  light: { phase: [0.6, 0.6, 0.4, -0.25], multiple: [0.22, 0.22], powder: 0.55, ambient: [0.22, 0.78, 0.8] },
  haze: { kind: "layer", top: 1500, length: 20000 },
  cirrus: {
    height: 8500,
    opacity: 0.42,
    forward: 0.75,
    ambient: 0.85,
    // Fibrous streaks along the upper wind (from the west-south-west).
    glsl: /* glsl */ `
  vec2 q = mat2(0.93, -0.37, 0.37, 0.93) * xz;
  q *= vec2(1.0 / 9000.0, 1.0 / 2200.0);
  float big = fbm(q * 0.35 + 4.0, vec2(0.0), 4);
  float fib = fbm(q * vec2(1.0, 3.5), vec2(0.0), 5);
  float m = smoothstep(0.52, 0.72, big);
  return m * smoothstep(0.45, 0.8, fib);`,
  },
  note: "baked offline (cumulus over land, sparse over the bay, cirrus streaks, boundary-layer haze); the handheld only samples the panorama",
};

/** Bakes the cloud panorama for a sun direction (unit vector toward the sun); `size` px square (the cooker stores 1024). */
export function bakeClouds(baker: Baker, sun: Vector3, size: number): Texture {
  return bakeCloudPanorama(baker, sun, { ...CLOUDS, size });
}

/** The dome with the baked clouds; its annotation carries every parameter the handheld needs to redraw it. */
export function buildDaySky(w: KamakuraWorld, sunDir: Vector3, clouds: Texture): Sky {
  const size = (clouds.image as { width?: number } | undefined)?.width ?? CLOUDS.size;
  return buildSky(w.root, {
    zenith: SKY.zenith,
    horizon: SKY.horizon,
    ground: SKY.ground,
    gradientPower: SKY.gradientPower,
    groundBlend: 6,
    sun: sunDir,
    sunColor: SKY.sun,
    glow: { intensity: SKY.glow, wide: [0.35, 6], tight: [1, 48] },
    disc: { intensity: SKY.disc },
    clouds: { texture: clouds, sunColor: SKY.cloudSun, ambientColor: SKY.cloudAmbient, fadeElevation: SKY.fadeElevation, drift: 0.00004, bake: { ...CLOUDS, size } },
  });
}
