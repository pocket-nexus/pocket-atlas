import { Color } from "three";
import { buildSky, type Sky, type SkySpec } from "../../shared/sky";
import type { GriffithWorld } from "./context";
import { SUN_DIR } from "./layout";

/**
 * Blue hour over the basin, 8 September 2015, 19:30 PDT: the sun 5° below
 * the horizon at 280.1°, behind the Hollywood Hills. Every term is linear
 * HDR and was fitted through the place's post (exposure, AgX, grade) to the
 * photos' display values:
 *
 * - south (p09, 31 Aug 2015, ~9 min after the magic-hour frame p08, looking
 *   down the Vermont grid): navy from 25° up, sRGB (8, 28, 65), to a
 *   grey-blue horizon, (17, 31, 56) at 1°; the pale line under it is the
 *   haze over the far carpet (world/haze.ts), not the sky;
 * - west-north-west over the Hills: the afterglow band, orange at the
 *   horizon (~(130, 85, 55) at 0.5°) through peach at 5° to mauve-blue at
 *   10–15° (p10's ordering, 3° deeper and darker: p10 is ~10 min after
 *   sunset);
 * - east over the San Gabriels: the Earth's shadow, dark slate blue on the
 *   horizon, and the last of the Belt of Venus as a faint mauve arch near
 *   9° (p07 shows both at magic hour; by −5° the belt has nearly gone);
 * - zenith: deep blue, (5, 27, 68).
 *
 * The south's red channel sits a little above the photo's (AgX desaturates
 * the darkest blues; the photo's camera crushed red to ~1).
 */
export const BLUE_HOUR: SkySpec = {
  zenith: new Color(0.0078, 0.0116, 0.0435),
  horizon: new Color(0.0128, 0.019, 0.0295),
  ground: new Color(0.01, 0.01, 0.012),
  gradientPower: 0.22,
  groundBlend: 6,
  sun: SUN_DIR,
  sunColor: new Color(1.0, 0.55, 0.25),
  glow: { intensity: 0.008, wide: [0.3, 3], tight: [0.7, 18] },
  twilight: {
    band: { color: new Color(0.17, 0.068, 0.012), height: 0.08, sunBias: 1.0, sunPower: 5.2 },
    belt: { color: new Color(0.004, 0.0024, 0.0034), elevation: 0.16, width: 0.09, power: 1.5 },
    shadow: { strength: 0.26, height: 0.06, power: 1.6 },
  },
};

/** The dome; its annotation carries every term for the handheld (`sky_day_f.cg`). */
export function buildBlueHourSky(w: GriffithWorld): Sky {
  return buildSky(w.root, BLUE_HOUR);
}
