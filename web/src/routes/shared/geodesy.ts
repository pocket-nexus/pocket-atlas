/**
 * The route frame: a Gauss–Krüger plane (GRS80, the Krüger n-series the GSI
 * publishes for Japan's plane rectangular coordinate systems), moved to a
 * local origin. +X east, −Z north, y the elevation above sea level, metres.
 * Over a 60 km route a tangent plane would stretch distances by 0.4 %; the
 * conformal projection keeps survey coordinates (and so OSM, the GSI
 * elevation tiles and PLATEAU) within centimetres of each other.
 */

const A = 6378137;
const F = 298.257222101;

export interface Zone {
  /** Latitude and longitude of the system's origin (degrees) and its scale factor. */
  lat0: number;
  lon0: number;
  k0: number;
}

/** Japan Plane Rectangular CS XII (Hokkaido, between 140°30′ and 143°E). */
export const JPRCS_XII: Zone = { lat0: 44, lon0: 142.25, k0: 0.9999 };

const N = 1 / (2 * F - 1);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N3 * N;
const N5 = N4 * N;
const ALPHA = [
  N / 2 - (2 * N2) / 3 + (5 * N3) / 16 + (41 * N4) / 180 - (127 * N5) / 288,
  (13 * N2) / 48 - (3 * N3) / 5 + (557 * N4) / 1440 + (281 * N5) / 630,
  (61 * N3) / 240 - (103 * N4) / 140 + (15061 * N5) / 26880,
  (49561 * N4) / 161280 - (179 * N5) / 168,
  (34729 * N5) / 80640,
];
const ARC = [
  1 + N2 / 4 + N4 / 64,
  (-3 / 2) * (N - N3 / 8 - N5 / 64),
  (15 / 16) * (N2 - N4 / 4),
  (-35 / 48) * (N3 - (5 * N5) / 16),
  (315 / 512) * N4,
  (-693 / 1280) * N5,
];
const E2N = (2 * Math.sqrt(N)) / (1 + N);
const RAD = Math.PI / 180;

/** Northing and easting (m) of a point in a zone. */
export function project(zone: Zone, lat: number, lon: number): { north: number; east: number } {
  const scale = (zone.k0 * A) / (1 + N);
  const phi0 = zone.lat0 * RAD;
  let s0 = ARC[0] * phi0;
  for (let j = 1; j <= 5; j++) s0 += ARC[j] * Math.sin(2 * j * phi0);
  s0 *= scale;
  const abar = scale * ARC[0];
  const sp = Math.sin(lat * RAD);
  const t = Math.sinh(Math.atanh(sp) - E2N * Math.atanh(E2N * sp));
  const tbar = Math.sqrt(1 + t * t);
  const dl = (lon - zone.lon0) * RAD;
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / tbar);
  let north = xi;
  let east = eta;
  for (let j = 1; j <= 5; j++) {
    north += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    east += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { north: abar * north - s0, east: abar * east };
}

/** A route's frame: a zone and the plane coordinates of the local origin. */
export interface Frame {
  zone: Zone;
  /** Plane coordinates (m) of the local origin. */
  north0: number;
  east0: number;
}

/** Local (x east, z south) of a geographic point. */
export function toLocal(frame: Frame, lat: number, lon: number): [number, number] {
  const p = project(frame.zone, lat, lon);
  return [p.east - frame.east0, -(p.north - frame.north0)];
}

/** Geographic coordinates of a local point (Newton on `toLocal`; exact to 10⁻⁹° in three rounds). */
export function toGeo(frame: Frame, x: number, z: number): [number, number] {
  const north = frame.north0 - z;
  const east = frame.east0 + x;
  let lat = frame.zone.lat0 + north / 111_133;
  let lon = frame.zone.lon0 + east / (111_320 * Math.cos(lat * RAD));
  for (let i = 0; i < 4; i++) {
    const p = project(frame.zone, lat, lon);
    const h = 1e-5;
    const pn = project(frame.zone, lat + h, lon);
    const pe = project(frame.zone, lat, lon + h);
    const a = (pn.north - p.north) / h;
    const b = (pe.north - p.north) / h;
    const c = (pn.east - p.east) / h;
    const d = (pe.east - p.east) / h;
    const det = a * d - b * c;
    const rn = north - p.north;
    const re = east - p.east;
    lat += (d * rn - b * re) / det;
    lon += (a * re - c * rn) / det;
  }
  return [lat, lon];
}

/**
 * The sun's azimuth (degrees clockwise from north) and elevation at a place
 * and a UTC instant (NOAA's low-accuracy formulas, within 0.1° this century).
 */
export function sunPosition(lat: number, lon: number, utc: Date): { azimuth: number; elevation: number } {
  const jd = utc.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const la = lat * RAD;
  const elevation = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { azimuth: ((azimuth / RAD) % 360 + 360) % 360, elevation: elevation / RAD };
}
