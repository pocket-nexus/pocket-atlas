import { Color } from "three";
import { buildSky, type Sky, type SkySpec } from "../../shared/sky";
import type { GriffithWorld } from "./context";
import { SUN_DIR } from "./layout";

/** Blue hour, sun 5° below the horizon at 280°: placeholder terms until area C measures them against the photos. */
export const BLUE_HOUR: SkySpec = {
  zenith: new Color(0.01, 0.025, 0.09),
  horizon: new Color(0.09, 0.08, 0.14),
  ground: new Color(0.02, 0.02, 0.03),
  gradientPower: 0.45,
  groundBlend: 6,
  sun: SUN_DIR,
  sunColor: new Color(0.5, 0.22, 0.08),
  glow: { intensity: 0.4, wide: [0.4, 3], tight: [0.6, 24] },
  twilight: {
    band: { color: new Color(0.45, 0.17, 0.05), height: 0.08, sunBias: 0.9, sunPower: 2.4 },
    belt: { color: new Color(0.08, 0.04, 0.07), elevation: 0.12, width: 0.09, power: 1.5 },
    shadow: { strength: 0.35, height: 0.07, power: 1.6 },
  },
};

/** The dome (area C owns the sky, haze, light balance and grade). */
export function buildBlueHourSky(w: GriffithWorld): Sky {
  return buildSky(w.root, BLUE_HOUR);
}
