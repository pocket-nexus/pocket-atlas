import { VIEW } from "../layout";

/**
 * Where the vista is seen from: the shots' eyes (`GriffithStage.ts`) with
 * their headings and fields of view, and the angular precision the terrain
 * and the light field are built to from them. A direction inside a shot's
 * frame gets that shot's pixel size (the Sign at 14°, the Overlook at 5°);
 * every eye also stands for free looking around at 40°, so the vista holds
 * up in any direction from the walkable areas.
 */
export interface Eye {
  name: string;
  x: number;
  y: number;
  z: number;
  /** Compass heading of the shot (degrees). */
  heading: number;
  /** Vertical field of view of the shot (degrees). */
  fov: number;
}

const S = VIEW.sign;

/** Mid-shot eyes of `GriffithStage.ts` (eye 1.62 m over the DEM; the roof deck at 8.6 m). */
export const EYES: Eye[] = [
  { name: "Lawn", x: -12.5, y: 2.0, z: -88.6, heading: 171.5, fov: 38 },
  { name: "Terrace", x: -16.5, y: 10.2, z: -1.6, heading: 174.5, fov: 40 },
  { name: "Sign", x: S.x, y: S.eye, z: S.z, heading: 312, fov: 14 },
  { name: "Overlook", x: -438, y: 44.2, z: -912, heading: 153, fov: 3.15 },
  { name: "Drum", x: -101.5, y: -43.6, z: 41, heading: 59.5, fov: 32 },
  { name: "Roof", x: 25, y: 10.2, z: -9.2, heading: 182.5, fov: 44 },
];

/** Frame height of the handheld (pixels). */
export const FRAME_H = 272;
/** Frame aspect of the handheld. */
const ASPECT = 480 / 272;
/** Field of view of free looking (degrees). */
const FREE_FOV = 40;

const RAD = Math.PI / 180;

/** Half the horizontal field of view of a shot (degrees). */
function halfH(fov: number): number {
  return Math.atan(Math.tan((fov / 2) * RAD) * ASPECT) / RAD;
}

/**
 * Metres per pixel at (x, z): the smallest footprint of one pixel among the
 * eyes, for the disc of radius `r` there (a shot's own field of view inside
 * its frame, 40° elsewhere); with the distance to the nearest eye.
 */
export function metresPerPixel(x: number, z: number, r = 0): { m: number; d: number } {
  let best = Infinity;
  let dmin = Infinity;
  for (const e of EYES) {
    const dx = x - e.x;
    const dz = z - e.z;
    const d = Math.max(Math.hypot(dx, dz) - r, 1);
    dmin = Math.min(dmin, d);
    let fov = FREE_FOV;
    if (e.fov < FREE_FOV) {
      const az = (Math.atan2(dx, -dz) / RAD + 360) % 360;
      let off = Math.abs(az - e.heading) % 360;
      if (off > 180) off = 360 - off;
      const spread = r > 0 ? Math.atan(r / Math.max(Math.hypot(dx, dz), 1)) / RAD : 0;
      if (off - spread <= halfH(e.fov) + 1) fov = e.fov;
    }
    const m = (d * fov * RAD) / FRAME_H;
    if (m < best) best = m;
  }
  return { m: best, d: dmin };
}
