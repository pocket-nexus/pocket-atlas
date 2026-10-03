import type { Line } from "./line";

/**
 * The route's world is cut into square cells on four layers that tile the
 * ground without overlapping work:
 *
 *   detail  256 m   small things by the road: poles, signs, wires, near trees
 *   base    256 m   the corridor: roads and banks, terrain at 8 m, buildings, woods
 *   mid    1024 m   terrain at 32 m and the woods' canopy out to 4 km
 *   far    8192 m   terrain at 512 m to the mountains
 *
 * Which cells exist is fixed by the driven line (`reach`: a cell exists when
 * it comes within that distance of the line). A coarser layer still covers
 * the ground under a finer one, sunk below it, so a finer cell that is not
 * loaded leaves no hole. A device loads the cells of each layer within
 * `radius` of the vehicle.
 */
export interface Layer {
  index: number;
  name: "detail" | "base" | "mid" | "far";
  /** Cell edge (m). */
  size: number;
  /** A cell exists when its square comes within this distance of the driven line (m). */
  reach: number;
  /** Cells load within this distance of the vehicle (m), and unload beyond `radius + size`. */
  radius: number;
  /** Terrain grid step (m); 0: the layer has no terrain. */
  step: number;
  /** How far the layer's terrain sinks under the next finer layer's cells (m). */
  sink: number;
}

export const LAYERS: readonly Layer[] = [
  { index: 0, name: "detail", size: 256, reach: 360, radius: 640, step: 0, sink: 0 },
  { index: 1, name: "base", size: 256, reach: 360, radius: 2400, step: 8, sink: 0 },
  { index: 2, name: "mid", size: 1024, reach: 4000, radius: 7200, step: 32, sink: 5 },
  { index: 3, name: "far", size: 8192, reach: 28000, radius: 48000, step: 512, sink: 40 },
];

export const DETAIL = LAYERS[0];
export const BASE = LAYERS[1];
export const MID = LAYERS[2];
export const FAR = LAYERS[3];

const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

/** Which cells of every layer exist for a driven line. */
export class Cells {
  private sets: Set<number>[] = [];
  /** Per layer: [ix, iz] of every cell, in the order of first approach along the line. */
  readonly lists: [number, number][][] = [];

  constructor(line: Line) {
    for (const layer of LAYERS) {
      const set = new Set<number>();
      const list: [number, number][] = [];
      const r = Math.ceil(layer.reach / layer.size) + 1;
      // Walk the line in steps a fraction of the cell: every cell within reach is met.
      const stride = Math.max(1, Math.floor(layer.size / 4 / (line.length / (line.n - 1) || 1)));
      for (let i = 0; i < line.n; i += stride) {
        const cx = Math.floor(line.x[i] / layer.size);
        const cz = Math.floor(line.z[i] / layer.size);
        for (let ix = cx - r; ix <= cx + r; ix++)
          for (let iz = cz - r; iz <= cz + r; iz++) {
            const k = key(ix, iz);
            if (set.has(k)) continue;
            // Distance from the line point to the cell's square.
            const dx = Math.max(ix * layer.size - line.x[i], 0, line.x[i] - (ix + 1) * layer.size);
            const dz = Math.max(iz * layer.size - line.z[i], 0, line.z[i] - (iz + 1) * layer.size);
            if (Math.hypot(dx, dz) > layer.reach) continue;
            set.add(k);
            list.push([ix, iz]);
          }
      }
      this.sets.push(set);
      this.lists.push(list);
    }
  }

  has(layer: Layer, ix: number, iz: number): boolean {
    return this.sets[layer.index].has(key(ix, iz));
  }

  /** Whether the layer's cell holding a point exists. */
  covers(layer: Layer, x: number, z: number): boolean {
    return this.has(layer, Math.floor(x / layer.size), Math.floor(z / layer.size));
  }

  /** Existing cells of a layer whose square comes within `radius` of a point. */
  around(layer: Layer, x: number, z: number, radius: number, out: [number, number][] = []): [number, number][] {
    out.length = 0;
    const s = layer.size;
    const x0 = Math.floor((x - radius) / s);
    const x1 = Math.floor((x + radius) / s);
    const z0 = Math.floor((z - radius) / s);
    const z1 = Math.floor((z + radius) / s);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        if (!this.has(layer, ix, iz)) continue;
        const dx = Math.max(ix * s - x, 0, x - (ix + 1) * s);
        const dz = Math.max(iz * s - z, 0, z - (iz + 1) * s);
        if (dx * dx + dz * dz <= radius * radius) out.push([ix, iz]);
      }
    return out;
  }
}
