import { Vector3 } from "three";
import { bearing } from "../../shared/geo";

/**
 * Site frame of Griffith Observatory on the south shoulder of Mount
 * Hollywood, Los Angeles, and the basin it overlooks.
 *
 * Frame: metres, origin at the centre of the planetarium dome (OSM,
 * 34.118116 N, 118.300377 W), +X east, −Z north, y up. Heights are relative
 * to the front lawn, 346.0 m above mean sea level (USGS 3DEP 1 m), so sea
 * level lies at y = −346. Local metres use the spherical conversion of the
 * research frame (R = 6378137 m); geometry farther than a few kilometres also
 * drops below the tangent plane by `curvatureDrop` (Earth's curvature with
 * standard refraction), which puts the Pacific horizon 0.56° down from the
 * terraces as the research measures.
 *
 *              −Z (north): Mount Hollywood, Cathy's Corner, the Valley
 *                    lawn ░ Astronomers Monument (z −88)
 *        W dome ●──── north façade (z −35) ────● E (Zeiss) dome
 *                 ◯ planetarium dome (origin), drum r 15.5 m
 *              +Z (south): Los Feliz, Hollywood, the basin, downtown at 150°
 */
export const GEO = {
  lat: 34.118116,
  lon: -118.300377,
  /** The front lawn (m above mean sea level). */
  datum: 346.0,
  address: "Griffith Observatory, 2800 E Observatory Rd, Los Angeles, CA 90027",
};

/** Mean sea level in place coordinates. */
export const SEA_Y = -GEO.datum;

/** Height above sea level (m) to place y. */
export const asl = (m: number): number => m - GEO.datum;

/**
 * 8 September 2015, 19:30 PDT: mid blue hour (civil dusk ends 19:35), in the
 * weeks the film shot in Griffith Park; the Moon (a waning crescent) is below
 * the horizon. Sun azimuth 280.1°, elevation −5.0° (research sun table).
 */
export const SUN = { azimuth: 280.1, elevation: -5.0, date: "2015-09-08T19:30:00-07:00" };

/** Unit vector toward the (set) sun. */
export const SUN_DIR: Vector3 = bearing(SUN.azimuth, SUN.elevation);

/** Seconds of motion the device loops (traffic, aircraft, beacons). */
export const LOOP = 120;

const R = 6378137;
const M_LAT = (R * Math.PI) / 180;
const M_LON = M_LAT * Math.cos((GEO.lat * Math.PI) / 180);

/** Latitude / longitude to place x, z (m) on the tangent plane. */
export function local(lat: number, lon: number): { x: number; z: number } {
  return { x: (lon - GEO.lon) * M_LON, z: -(lat - GEO.lat) * M_LAT };
}

/** Place x, z (m) back to latitude / longitude. */
export function geo(x: number, z: number): { lat: number; lon: number } {
  return { lat: GEO.lat - z / M_LAT, lon: GEO.lon + x / M_LON };
}

/** Effective Earth radius with standard refraction (k = 0.13). */
const R_EFF = 6371008.8 / (1 - 0.13);

/** How far a point at horizontal distance `d` (m) from the origin sits below the tangent plane. */
export function curvatureDrop(d: number): number {
  return (d * d) / (2 * R_EFF);
}

/** A point at (lat, lon, metres above sea level) in place coordinates, curvature included. */
export function place(lat: number, lon: number, metresAsl: number, out = new Vector3()): Vector3 {
  const { x, z } = local(lat, lon);
  return out.set(x, asl(metresAsl) - curvatureDrop(Math.hypot(x, z)), z);
}

/**
 * Viewpoints of the research (`geometry/viewpoints.txt`): eye positions in
 * place coordinates, with the heading and vertical field of view measured from
 * the reference photos.
 */
export const VIEW = {
  /** O1: the front lawn on the axis, looking south at the lit north façade. */
  lawn: { ...local(34.119288, -118.300377), eye: asl(347.3), heading: 180, fov: 45 },
  /** O2: the upper west terrace over the basin (downtown at 150°). */
  terrace: { ...local(34.118008, -118.300637), eye: asl(348.1), heading: 150, fov: 40 },
  /** O3: the west lawn toward the Hollywood Sign (311.9°, 2.57 km). */
  sign: { ...local(34.118675, -118.300854), eye: asl(348.7), heading: 312, fov: 30 },
  /** O4: Tiffany & Co. Foundation Overlook, telephoto: the domes against downtown. */
  overlook: { ...local(34.12626, -118.305593), eye: asl(385.1), heading: 151.5, fov: 5 },
};
