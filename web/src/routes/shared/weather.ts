import { Color, Vector3 } from "three";
import type { PostLook } from "../../places/shared/post";
import type { CloudSpec, SkyClouds, SkySpec } from "../../places/shared/sky";
import { LIGHT_SNOW, type SnowSpec } from "./fx/snow";

/**
 * The light of a `snow-road` route: an overcast winter afternoon in light
 * snow. No sun reaches the ground; the cloud deck is brightest toward the
 * low sun and the snow sends most of that light back up, so shade is barely
 * darker than open ground and nothing casts a shadow. Relief comes from the
 * sky's brighter side (the probe carries it into the baked vertices and the
 * moving car) and from occlusion under banks, trees and eaves.
 *
 * Everything the handheld needs is in the exported annotations: the sky
 * (`gradient-sun-cloudpanorama`: the gradient is the thin veil, the baked
 * panorama the heavier cloud under it, no disc), the hemisphere, the fog,
 * the probe, `post` and `snow`.
 */
export interface Weather {
  sky: (sun: Vector3) => SkySpec;
  /** The cloud deck baked into the dome's panorama (`bakeCloudPanorama`), and how the dome composites it. */
  clouds?: Omit<SkyClouds, "texture">;
  /** Hemisphere light: from the cloud deck and back from the snow. */
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  environmentIntensity: number;
  /** FogExp2 density (1/m): snow in the air takes the far hills. */
  fogDensity: number;
  exposure: number;
  look: PostLook;
  snow: SnowSpec;
}

/**
 * A stratus deck 1.4 km up, baked as the panorama's flat layer (the model's
 * `cirrus` term: a sheet at one height, no cumulus under it): lumpy cloud
 * bases a few kilometres across drawn out along the north-west wind, heavier
 * where a snow shower hangs, thinned to almost nothing round the point where
 * the low sun's light comes through. Perspective packs them into bands
 * toward the horizon, where the snow in the air takes them.
 */
const STRATUS: CloudSpec = {
  size: 1024,
  tiles: 8,
  eye: 2,
  sunScale: 2.5,
  // No cumulus: an empty layer just above the deck, crossed in a few steps.
  layer: { base: 3000, top: 3100, cell: 3000, sigma: 0.01 },
  coverage: 0,
  shape: { warp: [0, 1], site: 0.9, radius: [0.1, 0.1], tall: [0.3, 0.3], turrets: 1, spread: 0.8, dome: [0.5, 0.4], turret: [0.3, 0.2], bulge: 0.3, ramp: 60 },
  density: { cutoff: -0.5, scale: [200, 60], detail: 1, billow: [0.5, 1, 0.3, 0.3], gain: 2, bias: 0.05 },
  march: { reach: 200, coarse: 100, fine: 50, steps: 4, hold: 1, edge: -0.5, light: [50, 1.8] },
  light: { phase: [0.6, 0.5, 0.4, -0.2], multiple: [0.2, 0.2], ambient: [0.3, 0.7, 0.8] },
  haze: { kind: "layer", top: 1400, length: 13000 },
  cirrus: {
    height: 1400,
    opacity: 0.92,
    forward: 0.3,
    ambient: 1,
    glsl: /* glsl */ `
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * xz / 2800.0;
  q.x *= 0.55;
  vec2 w = vec2(fbm(q * 0.7 + 3.1, vec2(0.0), 3), fbm(q * 0.7 + 9.4, vec2(0.0), 3)) - 0.5;
  float cells = fbm(q + 1.7 * w, vec2(0.0), 5);
  float big = fbm(xz / 21000.0 + 7.3, vec2(0.0), 3);
  float d = smoothstep(0.36, 0.66, cells) * (0.4 + 0.6 * smoothstep(0.35, 0.65, big)) + 0.6 * smoothstep(0.5, 0.72, big);
  // Thin where the sun's light reaches the deck.
  vec2 s = (xz - uSun.xz / max(uSun.y, 0.08) * CI) / 9000.0;
  d *= 1.0 - 0.75 * exp(-dot(s, s));
  return clamp(d, 0.0, 1.0);`,
  },
  note: "a stratus deck as the flat layer; baked once, the handheld only samples the panorama",
};

export const OVERCAST_SNOW: Weather = {
  sky: (sun) => ({
    // A snow-cloud deck, almost even and about as bright as the snow under it (research §2): a little heavier
    // overhead than at the horizon, whose colour is also the fog's.
    zenith: new Color(0.68, 0.71, 0.77),
    horizon: new Color(0.82, 0.85, 0.89),
    ground: new Color(0.8, 0.83, 0.88),
    gradientPower: 0.5,
    groundBlend: 5,
    sun,
    // The deck thins toward the hidden sun: a wide warm-white lobe low in the south-west, no disc.
    sunColor: new Color(1.0, 0.94, 0.84),
    glow: { intensity: 0.3, wide: [0.6, 2.6], tight: [0.4, 12] },
  }),
  clouds: { bake: STRATUS, sunColor: new Color(0.17, 0.165, 0.15), ambientColor: new Color(0.4, 0.43, 0.49), fadeElevation: 0.03, drift: 0.00003 },
  // Under an overcast a wall takes about 0.8 of what open ground does: less sky, but the snow's light from below.
  hemiSky: new Color(0.87, 0.9, 0.97),
  hemiGround: new Color(0.42, 0.45, 0.52),
  hemiIntensity: 3.6,
  environmentIntensity: 0.5,
  // Light snow (research §6): half the contrast gone at 800 m, things gone by 2 km (FogExp2: 2 % left at 1.98 / density).
  fogDensity: 0.00105,
  exposure: 0.8,
  look: {
    tone: "aces",
    ao: { radius: 2.2, intensity: 3.2, color: [0.06, 0.085, 0.14] },
    bloom: { threshold: 1.4, smoothing: 0.5, intensity: 0.25, radius: 0.6, levels: 6 },
    grade: { grain: 0.012, vignette: 0.18, lift: [0.015, 0.03, 0.065], gain: [1.0, 1.0, 1.02], saturation: 1.0, contrast: 1.12 },
  },
  snow: LIGHT_SNOW,
};
