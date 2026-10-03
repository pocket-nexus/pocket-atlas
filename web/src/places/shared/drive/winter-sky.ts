import { Color, Vector3, type Object3D } from "three";
import type { Baker } from "../bake";
import { bakeCloudPanorama, buildSky, type CloudSpec } from "../sky";

/** Estimated low winter cloud deck. Both renderers sample one cooked panorama. */
const DECK: CloudSpec = {
  size: 1024, tiles: 16, eye: 20, sunScale: 1.5,
  layer: { base: 800, top: 1600, cell: 1700, sigma: 0.012 },
  coverage: 1,
  shape: { warp: [0.18, 0.6], site: 2.3, radius: [0.58, 0.3], tall: [0.3, 0.22], turrets: 0.08, spread: 0.5, dome: [0.8, 0.35], turret: [0.22, 0.12], bulge: 0.15, ramp: 100 },
  density: { cutoff: -0.35, scale: [330, 120], detail: 3, billow: [0.28, 0.25, 0.1, 0.1], gain: 1.8, bias: 0.01, rim: 0.22 },
  march: { reach: 18000, coarse: 160, fine: 65, steps: 300, hold: 6, edge: -0.4, light: [65, 1.85] },
  light: { phase: [0.4, 0.35, 0.3, -0.15], multiple: [0.5, 0.22], ambient: [0.62, 0.38, 0.5] },
  haze: { kind: "distance", length: 13000 },
  note: "Estimated overcast winter deck; baked once, no runtime ray march.",
};

export function buildWinterSky(parent: Object3D, baker: Baker) {
  const sun = new Vector3(-0.42, 0.24, 0.875).normalize();
  const clouds = bakeCloudPanorama(baker, sun, DECK);
  const sky = buildSky(parent, {
    zenith: new Color(0.39, 0.46, 0.53), horizon: new Color(0.6, 0.66, 0.71),
    ground: new Color(0.4, 0.43, 0.46), gradientPower: 0.5, groundBlend: 5,
    sun, sunColor: new Color(0.9, 0.88, 0.84),
    glow: { intensity: 0.045, wide: [0.5, 3], tight: [0.25, 16] },
    clouds: { texture: clouds, sunColor: new Color(0.25, 0.24, 0.22), ambientColor: new Color(0.67, 0.72, 0.77), fadeElevation: 0.07, drift: 0.000012, bake: DECK },
  }, 1700);
  return { sky, clouds };
}
