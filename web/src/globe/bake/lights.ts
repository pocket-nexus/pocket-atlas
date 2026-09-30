import { Rng } from "../../core/random";
import { arcDeg, DEG } from "../geo";
import { EXTRA_SOURCES, litCities, type LitCity } from "./cityTable";
import { landAt } from "./land";

/** Encoded range: shaders decode `v = e² · LIGHTS_MAX`. */
export const LIGHTS_MAX = 3;

class Splatter {
  readonly land: Float32Array;
  readonly sea: Float32Array;
  private wx: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.land = new Float32Array(w * h);
    this.sea = new Float32Array(w * h);
    this.wx = new Float32Array(w);
  }

  /** Adds an elliptical gaussian of peak `amp`, σ in degrees of latitude, isotropic on the sphere. */
  splat(buf: Float32Array, lat: number, lon: number, sigmaDeg: number, amp: number): void {
    const { w, h } = this;
    const pxDeg = w / 360;
    const cy = ((90 - lat) / 180) * h;
    const cx = ((lon + 180) / 360) * w;
    const sy = Math.max(0.5, sigmaDeg * pxDeg);
    const sx = Math.min(w / 8, Math.max(0.5, sy / Math.max(0.05, Math.cos(lat * DEG))));
    const rx = Math.ceil(sx * 2.6);
    const ry = Math.ceil(sy * 2.6);
    const x0 = Math.floor(cx - rx);
    const nx = 2 * rx + 2;
    const ax = 1 / (2 * sx * sx);
    const ay = 1 / (2 * sy * sy);
    const wx = this.wx;
    for (let i = 0; i < nx; i++) {
      const dx = x0 + i + 0.5 - cx;
      wx[i] = Math.exp(-dx * dx * ax);
    }
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const wy = amp * Math.exp(-dy * dy * ay);
      if (wy < 1e-4) continue;
      const row = y * w;
      for (let i = 0; i < nx; i++) {
        let x = x0 + i;
        if (x < 0) x += w;
        else if (x >= w) x -= w;
        buf[row + x] += wy * wx[i];
      }
    }
  }
}

/** Moves (lat, lon) by (north, east) degrees of arc. */
function offset(lat: number, lon: number, dn: number, de: number): [number, number] {
  const la = Math.max(-89.5, Math.min(89.5, lat + dn));
  return [la, lon + de / Math.max(0.1, Math.cos(la * DEG))];
}

interface Road {
  a: LitCity;
  b: LitCity;
  d: number;
}

function findRoads(cities: LitCity[]): Road[] {
  // Spatial hash on a 5° grid keeps the neighbour search linear.
  const cell = 5;
  const grid = new Map<string, number[]>();
  const key = (la: number, lo: number) => `${Math.floor(la / cell)},${Math.floor(lo / cell)}`;
  cities.forEach((c, i) => {
    const k = key(c.lat, c.lon);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const roads: Road[] = [];
  const seen = new Set<number>();
  cities.forEach((a, ia) => {
    if (a.w < 0.05) return;
    const reach = Math.min(7.5, 1.6 + 2.2 * Math.sqrt(a.w));
    const cand: { j: number; d: number }[] = [];
    const cy = Math.floor(a.lat / cell);
    const cx = Math.floor(a.lon / cell);
    for (let gy = cy - 2; gy <= cy + 2; gy++) {
      for (let gx = cx - 3; gx <= cx + 3; gx++) {
        for (const j of grid.get(`${gy},${gx}`) ?? []) {
          if (j === ia) continue;
          const b = cities[j];
          const d = arcDeg(a.lat, a.lon, b.lat, b.lon);
          if (d < reach && d > 0.15) cand.push({ j, d });
        }
      }
    }
    cand.sort((p, q) => p.d - q.d);
    const k = a.w > 3 ? 5 : a.w > 0.6 ? 3 : 2;
    for (const { j, d } of cand.slice(0, k)) {
      const id = ia < j ? ia * 100000 + j : j * 100000 + ia;
      if (seen.has(id)) continue;
      seen.add(id);
      roads.push({ a, b: cities[j], d });
    }
  });
  return roads;
}

/**
 * Night lights as an RG8 equirectangular map: R = lights on land (masked by
 * the land map in the shader), G = lights on water (fleets, platforms).
 * Values are sqrt-encoded against LIGHTS_MAX.
 */
export function bakeLights(width: number, height: number, small: Float32Array, townCount: number): Uint8Array {
  const rng = new Rng(0x6e1647);
  const S = new Splatter(width, height);
  const pxDeg = width / 360;
  const pixelSigma = 0.6 / pxDeg;
  const cities = litCities();
  const gauss = () => rng.gauss();

  // --- Urban cores: hierarchical clusters so every city has districts, arms and grain.
  for (const c of cities) {
    const R = 0.06 + 0.12 * Math.sqrt(c.w);
    const big = Math.min(1, c.w / 8);
    S.splat(S.land, c.lat, c.lon, R * 1.7, 0.035 * Math.min(1.6, Math.sqrt(c.w)));
    S.splat(S.land, c.lat, c.lon, R * 0.3, 0.35 + 0.55 * big);
    // A random elongation reads like a coastline, river valley or ridge the city grew along.
    const ang = rng.range(0, Math.PI);
    const stretch = rng.range(1, 1.9);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const nParents = 2 + Math.round(2.4 * Math.sqrt(c.w));
    const parents: [number, number][] = [];
    for (let i = 0; i < nParents; i++) {
      const u = gauss() * R * 0.62 * stretch;
      const v = gauss() * R * 0.62;
      parents.push([u * ca - v * sa, u * sa + v * ca]);
    }
    const nSub = Math.round(4 + 18 * Math.pow(c.w, 0.62));
    for (let i = 0; i < nSub; i++) {
      const [pn, pe] = parents[i % nParents];
      const dn = pn + gauss() * R * 0.34;
      const de = pe + gauss() * R * 0.34;
      const [la, lo] = offset(c.lat, c.lon, dn, de);
      if (landAt(small, la, lo) < 0.25) continue;
      const fall = Math.exp(-(dn * dn + de * de) / (2 * R * R));
      const u = rng.next();
      S.splat(S.land, la, lo, R * (0.05 + 0.11 * rng.next()), 0.3 * (0.25 + 0.75 * u * u) * (0.35 + 0.65 * fall));
    }
    const nSpeck = Math.round(6 + 34 * Math.pow(c.w, 0.7));
    for (let i = 0; i < nSpeck; i++) {
      const [pn, pe] = parents[i % nParents];
      const dn = pn + gauss() * R * 0.7;
      const de = pe + gauss() * R * 0.7;
      const [la, lo] = offset(c.lat, c.lon, dn, de);
      if (landAt(small, la, lo) < 0.3) continue;
      const u = rng.next();
      S.splat(S.land, la, lo, pixelSigma * (0.8 + 0.8 * rng.next()), 0.1 + 0.35 * u * u * u);
    }
  }

  // --- Towns: heavy-tailed scatter around the cities → fractal regional density.
  let total = 0;
  const cum = new Float64Array(cities.length);
  cities.forEach((c, i) => {
    total += Math.pow(c.w, 0.7);
    cum[i] = total;
  });
  for (let n = 0; n < townCount; n++) {
    const t = rng.next() * total;
    let lo = 0;
    let hi = cities.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const c = cities[lo];
    const R0 = 0.3 + 0.22 * Math.sqrt(c.w);
    const r = Math.min(8, R0 * (Math.pow(Math.max(1e-4, rng.next()), -0.55) - 1) + R0 * 0.5);
    const th = rng.range(0, Math.PI * 2);
    const [la, lon] = offset(c.lat, c.lon, r * Math.sin(th), r * Math.cos(th));
    if (landAt(small, la, lon) < 0.5) continue;
    const u = rng.next();
    S.splat(S.land, la, lon, 0.035 + 0.06 * rng.next(), 0.04 + 0.32 * Math.pow(u, 5));
  }

  // --- Roads: faint wiggling filaments with towns strung along them.
  for (const { a, b, d } of findRoads(cities)) {
    let dLon = b.lon - a.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const dLat = b.lat - a.lat;
    let wet = 0;
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      if (landAt(small, a.lat + dLat * t, a.lon + dLon * t) < 0.5) wet++;
    }
    if (wet > 2) continue;
    const strength = 0.045 * Math.min(1.3, Math.pow(a.w * b.w, 0.18)) * (1.15 - d / 8);
    if (strength <= 0.004) continue;
    const w1 = rng.range(-1, 1) * 0.07 * d;
    const w2 = rng.range(-1, 1) * 0.025 * d;
    const nLen = Math.hypot(dLat, dLon) || 1;
    const perpLat = -dLon / nLen;
    const perpLon = dLat / nLen;
    const steps = Math.ceil(d / (0.7 / pxDeg));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const o = Math.sin(Math.PI * t) * w1 + Math.sin(3 * Math.PI * t) * w2;
      const la = a.lat + dLat * t + perpLat * o;
      const lo = a.lon + dLon * t + perpLon * o;
      S.splat(S.land, la, lo, pixelSigma * 0.85, strength * (0.55 + 0.45 * rng.next()));
    }
    const beads = Math.floor((d / 0.4) * rng.range(0.4, 1));
    for (let i = 0; i < beads; i++) {
      const t = rng.range(0.08, 0.92);
      const o = Math.sin(Math.PI * t) * w1 + Math.sin(3 * Math.PI * t) * w2;
      const u = rng.next();
      S.splat(S.land, a.lat + dLat * t + perpLat * o, a.lon + dLon * t + perpLon * o, 0.03 + 0.04 * rng.next(), 0.05 + 0.25 * u * u * u);
    }
  }

  // --- Flares, fleets, platforms.
  for (const [lat, lon, spread, count, bright, water] of EXTRA_SOURCES) {
    for (let i = 0; i < count; i++) {
      const [la, lo] = offset(lat, lon, gauss() * spread, gauss() * spread * 1.3);
      const onLand = landAt(small, la, lo);
      if (water ? onLand > 0.05 : onLand < 0.5) continue;
      const u = rng.next();
      S.splat(water ? S.sea : S.land, la, lo, pixelSigma * (0.8 + 0.6 * rng.next()), bright * (0.12 + 0.3 * u * u));
    }
  }

  // Soft knee above 2, hard ceiling at LIGHTS_MAX, sqrt encoding for the dim end.
  const out = new Uint8Array(width * height * 2);
  const enc = (v: number) => {
    if (v > 2) v = 2 + (v - 2) / (1 + (v - 2));
    return Math.round(Math.sqrt(Math.min(1, v / LIGHTS_MAX)) * 255);
  };
  const { land, sea } = S;
  for (let i = 0; i < land.length; i++) {
    out[i * 2] = enc(land[i]);
    out[i * 2 + 1] = enc(sea[i]);
  }
  return out;
}
