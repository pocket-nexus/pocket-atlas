import { Color } from "three";
import { Haze } from "../../shared/haze";
import { BLUE_HOUR } from "./sky";

/**
 * The basin's haze at blue hour (contract 2, `shared/haze.ts`). The
 * inversion top sits at 286 m ASL (y −60), below the terraces: the
 * observatory stands in clear air above the layer. Under it the
 * path-averaged extinction is ≈ ρ0 for every basin point: T ≈ 0.79 at
 * 1.5 km (Los Feliz), 0.24 at 9 km (downtown), 0.04 at 20 km, so the far
 * carpet dissolves into the horizon. Gain 1 and no glow: an infinitely far
 * point takes the dome's own horizon colour, so terrain meets sky at h = 0
 * without a step in every azimuth; the city's light dome is carried by the
 * sky's horizon term (world/sky.ts). `band` 0.25 keeps near hills toward the
 * afterglow dark (Sign: Mt Lee (7, 8, 11) at 960 × 540; p10 shows
 * silhouettes); scale 60 m keeps the air above the layer thin.
 * Terrace (p09) band: −0.3° (29, 39, 53) / p09 (22, 34, 56), −0.6°
 * (33, 40, 54) / (28, 37, 58), −0.9° (35, 42, 56) / (35, 43, 61).
 */
export const HAZE = new Haze({
  density: 1.6e-4,
  inversion: -60,
  scale: 60,
  gain: 1,
  band: 0.25,
  glow: new Color(0, 0, 0),
  sky: BLUE_HOUR,
});
