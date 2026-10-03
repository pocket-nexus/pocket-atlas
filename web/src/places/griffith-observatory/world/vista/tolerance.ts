import { EYES, metresPerPixel } from "./eyes";
import { HIDDEN, SKYLINE, Viewshed } from "./viewshed";

/**
 * Height error the terrain mesh may have, in pixels from the nearest eye: on
 * the skyline, against farther ground, hidden from every eye. Lights stand
 * at least the tolerance (in metres) above the DEM so they stay above the
 * simplified mesh. Shared by the scene and the light-field script.
 */
export const ERR_SKY = 0.6;
export const ERR_GROUND = 1.8;
export const ERR_HIDDEN = 25;

/** The eyes the viewshed is built from (the others stand close to these). */
export const SHED_EYES = EYES.filter((e) => ["Terrace", "Lawn", "Roof", "Overlook"].includes(e.name));

export interface Tolerance {
  shed: Viewshed;
  /** Mesh height tolerance (m) at (x, y, z). */
  at(x: number, y: number, z: number): number;
}

export function makeTolerance(groundY: (x: number, z: number) => number): Tolerance {
  const shed = new Viewshed(groundY, SHED_EYES);
  return {
    shed,
    at(x, y, z) {
      const sight = shed.sight(x, y, z);
      return Math.max(0.25, (sight === SKYLINE ? ERR_SKY : sight === HIDDEN ? ERR_HIDDEN : ERR_GROUND) * metresPerPixel(x, z).m);
    },
  };
}
