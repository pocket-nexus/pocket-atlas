import { Rng } from "../../../core/random";

const TAU = Math.PI * 2;

export interface DriftingPetal {
  side: number;
  x: number;
  height: number;
  z: number;
  phase: number;
  size: number;
}

/** Small, metre-scale petals in the roadside tree canopy, with a stable seed. */
export function driftingPetalSeeds(count: number, seed = 500): DriftingPetal[] {
  const r = new Rng(seed);
  return Array.from({ length: count }, () => ({
    side: r.pick([-1, 1]), x: r.range(0, 4), height: r.range(0.65, 9.5),
    z: r.range(-36, 20), phase: r.range(0, TAU), size: r.range(0.025, 0.05),
  }));
}

/**
 * Closed wind eddies: no teleport, scale fade or camera-dependent state to lose
 * during export. Integer harmonics also close the angular velocity at the loop.
 * Keeping the paths outside the walking corridor prevents near-eye polygons in
 * both renderers, including free camera views above normal standing height.
 */
export function petalPose(p: DriftingPetal, time: number, period: number, groundY: (z: number) => number, clearHalfWidth = 3.8) {
  const phase = ((time % period) + period) % period;
  const a = phase / period * TAU;
  const z = p.z + Math.sin(a * 2 + p.phase) * 0.9;
  const rise = Math.min(1.1, p.height - 0.25);
  return {
    x: p.side * (clearHalfWidth + p.x + 0.7 + Math.sin(a * 2 + p.phase) * 0.7),
    y: groundY(z) + p.height + Math.sin(a + p.phase) * rise,
    z,
    rx: a * 6 + p.phase,
    ry: Math.sin(a * 5 + p.phase) * 0.7,
    rz: a * 4 + p.phase,
  };
}
