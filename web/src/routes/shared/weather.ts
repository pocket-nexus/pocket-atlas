import { Color, Vector3 } from "three";
import type { PostLook } from "../../places/shared/post";
import type { SkySpec } from "../../places/shared/sky";
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
 * (`gradient-sun-cloudpanorama` without a panorama or disc), the
 * hemisphere, the fog, the probe, `post` and `snow`.
 */
export interface Weather {
  sky: (sun: Vector3) => SkySpec;
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

export const OVERCAST_SNOW: Weather = {
  sky: (sun) => ({
    zenith: new Color(0.46, 0.5, 0.57),
    horizon: new Color(0.8, 0.82, 0.85),
    ground: new Color(0.74, 0.77, 0.82),
    gradientPower: 0.42,
    groundBlend: 5,
    sun,
    // The deck glows around the hidden sun: a wide warm-white lobe, no disc.
    sunColor: new Color(1.0, 0.95, 0.86),
    glow: { intensity: 0.34, wide: [0.7, 2.2], tight: [0.3, 9] },
  }),
  hemiSky: new Color(0.8, 0.85, 0.94),
  hemiGround: new Color(0.76, 0.79, 0.86),
  hemiIntensity: 2.3,
  environmentIntensity: 0.55,
  fogDensity: 0.00042,
  exposure: 0.8,
  look: {
    tone: "aces",
    ao: { radius: 1.6, intensity: 2.2, color: [0.05, 0.07, 0.12] },
    bloom: { threshold: 1.4, smoothing: 0.5, intensity: 0.25, radius: 0.6, levels: 6 },
    grade: { grain: 0.012, vignette: 0.18, lift: [0.02, 0.04, 0.09], gain: [1.0, 1.0, 1.02], saturation: 1.0, contrast: 1.1 },
  },
  snow: LIGHT_SNOW,
};
