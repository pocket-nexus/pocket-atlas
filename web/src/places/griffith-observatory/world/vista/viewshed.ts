import type { Eye } from "./eyes";

/**
 * What the eyes see of the ground: per eye, rays every `azStep`° marched out
 * over the DEM at distances growing by `growth` per step, holding the running
 * maximum of the elevation angle (tan) before each sample and the maximum
 * beyond it. A point is hidden when nearer ground rises above its line of
 * sight; it stands on the skyline when no farther ground rises above it (the
 * ridge outlines against the sky that the terrain keeps most precisely).
 */
export const HIDDEN = 0;
export const VISIBLE = 1;
export const SKYLINE = 2;
export type Sight = typeof HIDDEN | typeof VISIBLE | typeof SKYLINE;

export interface ViewshedOptions {
  azStep: number;
  d0: number;
  growth: number;
  dMax: number;
}

interface Table {
  eye: Eye;
  /** Max tan before and including sample k. */
  pre: Float32Array;
  /** Max tan at and beyond sample k. */
  suf: Float32Array;
}

export class Viewshed {
  private readonly tables: Table[] = [];
  private readonly nAz: number;
  private readonly K: number;
  private readonly opts: ViewshedOptions;
  private readonly logG: number;

  constructor(height: (x: number, z: number) => number, eyes: Eye[], opts: Partial<ViewshedOptions> = {}) {
    this.opts = { azStep: 0.25, d0: 20, growth: 0.015, dMax: 72000, ...opts };
    const { azStep, d0, growth, dMax } = this.opts;
    this.nAz = Math.round(360 / azStep);
    this.logG = Math.log(1 + growth);
    this.K = Math.ceil(Math.log(dMax / d0) / this.logG) + 1;
    const K = this.K;
    for (const eye of eyes) {
      const pre = new Float32Array(this.nAz * K);
      const suf = new Float32Array(this.nAz * K);
      for (let a = 0; a < this.nAz; a++) {
        const az = (a * azStep * Math.PI) / 180;
        const sx = Math.sin(az);
        const sz = -Math.cos(az);
        let m = -Infinity;
        const row = a * K;
        for (let k = 0; k < K; k++) {
          const d = this.dist(k);
          const t = (height(eye.x + sx * d, eye.z + sz * d) - eye.y) / d;
          suf[row + k] = t;
          m = Math.max(m, t);
          pre[row + k] = m;
        }
        for (let k = K - 2; k >= 0; k--) suf[row + k] = Math.max(suf[row + k], suf[row + k + 1]);
      }
      this.tables.push({ eye, pre, suf });
    }
  }

  private dist(k: number): number {
    return this.opts.d0 * Math.exp(k * this.logG);
  }

  /**
   * How the best-placed eye sees the point (x, y, z): `margin` is an angle
   * (radians) the point may sit below the occluding line and still count as
   * seen (and below the farther ground and still count as skyline).
   */
  sight(x: number, y: number, z: number, margin = 0.0005): Sight {
    let best: Sight = HIDDEN;
    for (const { eye, pre, suf } of this.tables) {
      const dx = x - eye.x;
      const dz = z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d < this.opts.d0 * 1.5) return SKYLINE;
      const t = (y - eye.y) / d;
      let a = Math.round(((Math.atan2(dx, -dz) * 180) / Math.PI / this.opts.azStep + this.nAz) % this.nAz);
      if (a >= this.nAz) a = 0;
      const row = a * this.K;
      // Last sample nearer than the point by a step, first sample beyond it by two.
      const kn = Math.floor(Math.log(d / this.opts.d0) / this.logG) - 1;
      if (kn >= 0 && pre[row + Math.min(kn, this.K - 1)] > t + margin) continue;
      const kf = kn + 4;
      if (kf >= this.K || suf[row + kf] <= t + margin) return SKYLINE;
      best = VISIBLE;
    }
    return best;
  }
}
