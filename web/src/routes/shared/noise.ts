/** Deterministic hashes and value noise for the route generators (no state, same on every machine). */

/** 0..1 from two integers. */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** 0..1 from an integer and a stream. */
export function hash1(i: number, stream = 0): number {
  return hash2(i, stream * 7919 + 13);
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Value noise in 0..1, one feature per unit. */
export function noise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const u = fade(x - ix);
  const v = fade(y - iy);
  const a = hash2(ix + seed * 131, iy);
  const b = hash2(ix + 1 + seed * 131, iy);
  const c = hash2(ix + seed * 131, iy + 1);
  const d = hash2(ix + 1 + seed * 131, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in 0..1. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x, y, seed + o) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A small seeded generator for sequences (per building, per tree clump). */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = (seed | 0) || 0x9e3779b9;
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s;
    return (s >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this.next() * list.length))];
  }
}
