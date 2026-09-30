import { Vector3 } from "three";

/**
 * Globe conventions shared by the CPU bakes, the shaders and the camera rig.
 *
 * Object space: unit sphere, +Y = north pole, longitude 0 faces +Z and 90°E
 * faces +X, so p = (cos φ sin λ, sin φ, cos φ cos λ).
 * Equirectangular textures: u = (λ + 180°) / 360°, v = (90° − φ) / 180°, so
 * texel row 0 is the north pole (no flipY on uploads).
 */
export const DEG = Math.PI / 180;

export const PLANET_RADIUS = 1;
/** Top of the (visually exaggerated) atmosphere shell. */
export const ATMOSPHERE_RADIUS = 1.03;
export const CLOUD_RADIUS = 1.0045;

export function latLonToVec(latDeg: number, lonDeg: number, out = new Vector3()): Vector3 {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const c = Math.cos(la);
  return out.set(c * Math.sin(lo), Math.sin(la), c * Math.cos(lo));
}

/** Great-circle distance in degrees. */
export function arcDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a1 = lat1 * DEG;
  const a2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const c = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dl);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** Wraps an angle in degrees into (-180, 180]. */
export function wrapDeg(a: number): number {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Lets the browser paint / handle input between bake steps. */
export const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));
