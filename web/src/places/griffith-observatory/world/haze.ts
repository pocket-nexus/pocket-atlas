import { Color } from "three";
import { Haze } from "../../shared/haze";
import { BLUE_HOUR } from "./sky";

/**
 * The basin's haze at blue hour (contract 2, `shared/haze.ts`). The
 * inversion top sits at 286 m ASL (y −60), below the terraces: the
 * observatory stands in clear air above the layer and the Hollywood Hills
 * read as near-black silhouettes against the afterglow (p10; scale 60 m
 * keeps the air above the layer thin, T ≈ 0.94 to Mt Lee). Under it the
 * path-averaged extinction is ≈ ρ0 for every basin point: T ≈ 0.79 at
 * 1.5 km (Los Feliz), 0.24 at 9 km (downtown), 0.04 at 20 km, so the far
 * carpet dissolves into a pale band at the horizon with no hard line.
 * Measured in the Terrace shot against p09 (31 Aug 2015): −0.3° (19, 31, 46)
 * / p09 (22, 34, 56), −0.6° (27, 37, 51) / (28, 37, 58), −0.9° (38, 46, 61)
 * / (35, 43, 61). Gain and glow make the band's limit p09's pale line
 * (32, 41, 60): 1.25 × the horizon sky plus a warm-grey city glow.
 */
export const HAZE = new Haze({
  density: 1.6e-4,
  inversion: -60,
  scale: 60,
  gain: 1.25,
  band: 0.25,
  glow: new Color(0.0045, 0.003, 0.0035),
  sky: BLUE_HOUR,
});
