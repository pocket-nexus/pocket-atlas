import { Color, type Texture, type Vector3 } from "three";
import type { Baker } from "../bake";
import { bakeCloudPanorama, buildSky as createSky, type CloudSpec, type Sky } from "../sky";
import type { DayWorld } from "./context";

/**
 * Summer afternoon sky over Yotsuya: a clear blue gradient, the sun, and a
 * field of fair-weather cumulus baked once into a 1024² panorama (the dome
 * and the panorama's layout are `shared/sky.ts`).
 */
export const SKY = {
  zenith: new Color(0.075, 0.25, 0.78),
  horizon: new Color(0.62, 0.76, 0.92),
  ground: new Color(0.42, 0.44, 0.45),
  sun: new Color(1.0, 0.93, 0.8),
  glow: 0.22,
  disc: 40,
  cloudSun: new Color(1.0, 0.95, 0.86).multiplyScalar(1.35),
  cloudAmbient: new Color(0.46, 0.56, 0.72),
  fadeElevation: 0.04,
};

/**
 * Cumulus 1.4–4.6 km up in 3.3 km cells, six in ten cells holding a cloud,
 * faded by distance to the cloud base.
 */
const CLOUDS: CloudSpec = {
  size: 1024,
  tiles: 16,
  eye: 30,
  sunScale: 2.5,
  layer: { base: 1400, top: 4600, cell: 3300, sigma: 0.02 },
  coverage: 0.6,
  shape: { warp: [0.2, 0.6], site: 0.85, radius: [0.12, 0.2], tall: [0.45, 0.75], turrets: 0.7, spread: 0.75, dome: [0.55, 0.35], turret: [0.32, 0.22], bulge: 0.25, ramp: 70 },
  density: { cutoff: -0.4, scale: [300, 100], detail: 4, billow: [0.6, 1.1, 0.25, 0.3], gain: 2.3, bias: 0.03 },
  march: { reach: 30000, coarse: 150, fine: 35, steps: 900, hold: 12, edge: -0.45, light: [50, 1.85] },
  light: { phase: [0.55, 0.55, 0.45, -0.2], multiple: [0.3, 0.25], ambient: [0.28, 0.72, 0.7] },
  haze: { kind: "distance", length: 42000 },
  note: "baked offline; the handheld only samples the panorama",
};

/** Bakes the cumulus panorama for a sun direction (unit vector toward the sun). */
export function bakeClouds(baker: Baker, sun: Vector3): Texture {
  return bakeCloudPanorama(baker, sun, CLOUDS);
}

/** The dome with the baked clouds; its annotation carries every parameter a handheld needs to redraw it. */
export function buildSky(w: DayWorld, sunDir: Vector3, clouds: Texture): Sky {
  return createSky(w.root, {
    zenith: SKY.zenith,
    horizon: SKY.horizon,
    ground: SKY.ground,
    gradientPower: 0.42,
    groundBlend: 6,
    sun: sunDir,
    sunColor: SKY.sun,
    glow: { intensity: SKY.glow, wide: [0.35, 6], tight: [1, 48] },
    disc: { intensity: SKY.disc },
    clouds: { texture: clouds, sunColor: SKY.cloudSun, ambientColor: SKY.cloudAmbient, fadeElevation: SKY.fadeElevation, drift: 0.00004, bake: CLOUDS },
  });
}
