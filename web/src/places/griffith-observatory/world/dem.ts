import obsUrl from "../data/dem-obs-1m.bin?url";
import parkUrl from "../data/dem-park-5m.bin?url";
import nearUrl from "../data/dem-near-50m.bin?url";
import farUrl from "../data/dem-far-200m.bin?url";
import { decodeGrid, HeightField, type Grid } from "./vista/pdem";

/**
 * Ground heights of Griffith Park and the basin from USGS 3DEP bare earth
 * (2024 lidar), as four nested grids packed by the research script
 * `scripts/vista-dem.ts`:
 *
 * | grid | spacing | covers |
 * | --- | --- | --- |
 * | obs-1m | 1.0 × 1.2 m | ±400 m E–W, ±483 m N–S around the planetarium dome (all of `SITE`) |
 * | park-5m | 5 × 6 m | Mount Hollywood, Mt Lee and Cahuenga Peak, Los Feliz (x −2270 … 1420, z −3380 … 1300) |
 * | near-50m | 46 × 56 m | ±26 km E–W, ±24 km N–S |
 * | far-200m | 184 × 223 m | 119° W – 117.55° W, 33.55° N – 34.65° N (Palos Verdes, the San Gabriels, Mt Baldy) |
 *
 * `groundY` samples the finest grid that covers a point (bilinear, pixel
 * centres) and blends it into the next one over a band at its edge, so
 * meshes built at any resolution meet. Heights come back in place y with
 * the Earth-curvature drop of `layout.ts` included everywhere (it is under
 * 1 cm inside `SITE`), so `groundY(local(lat, lon))` and
 * `place(lat, lon, h).y` agree. The data loads once, when this module is
 * first imported (top-level await).
 */

async function load(url: string, band: number): Promise<Grid> {
  const res = await fetch(url);
  const raw = new Uint8Array(await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  return decodeGrid(raw, band);
}

/** Finest first. */
const FIELD = new HeightField(await Promise.all([load(obsUrl, 40), load(parkUrl, 20), load(nearUrl, 8), load(farUrl, 1)]));

/** The loaded height field (for builders that pass it on, e.g. the viewshed). */
export const DEM: HeightField = FIELD;

/** Ground height above mean sea level (m) at a latitude / longitude. Sea and no-data read as 0. */
export function heightAsl(lat: number, lon: number): number {
  return FIELD.heightAsl(lat, lon);
}

/** Ground height in place y at place (x, z), Earth curvature included. */
export function groundY(x: number, z: number): number {
  return FIELD.groundY(x, z);
}

/** Spacing (m) of the finest grid that fully answers at place (x, z): 1, 5, 50 or 200. */
export function demSpacing(x: number, z: number): number {
  return FIELD.spacing(x, z);
}

