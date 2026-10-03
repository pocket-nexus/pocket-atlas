import { buildings } from "./gen/buildings";
import { plants } from "./gen/plants";
import { roadside } from "./gen/roadside";
import { strips } from "./gen/strip";
import { structures } from "./gen/structures";
import { terrain } from "./gen/terrain";
import { BASE, LAYERS, type Cells, type Layer } from "./layers";
import { MeshBuilder, type CellData } from "./mesh";
import type { RouteWorld } from "./world";

/** What a generator is given: the world, the cell and where to put triangles. */
export interface CellContext {
  world: RouteWorld;
  cells: Cells;
  layer: Layer;
  ix: number;
  iz: number;
  /** The cell's square: min x, min z, max x, max z. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  mb: MeshBuilder;
}

export type Generator = (c: CellContext) => void;

/**
 * The generators of each layer, in order. A generator emits what it owns
 * inside the cell's square (a thing belongs to the cell that holds its
 * anchor point: a building's centroid, a tree's foot, a quad's centre), so
 * neighbouring cells never draw the same thing twice.
 */
export const GENERATORS: Record<Layer["name"], Generator[]> = {
  detail: [roadside, plants, buildings, structures],
  base: [(c) => terrain(c.world, c.cells, c.layer, c.ix, c.iz, c.mb), (c) => strips(c.world, c.x0, c.z0, c.x1, c.z1, c.mb), structures, buildings, plants, roadside],
  mid: [(c) => terrain(c.world, c.cells, c.layer, c.ix, c.iz, c.mb), plants],
  far: [(c) => terrain(c.world, c.cells, c.layer, c.ix, c.iz, c.mb)],
};

/** Builds one cell of a layer. */
export function buildCell(world: RouteWorld, cells: Cells, layerIndex: number, ix: number, iz: number): CellData {
  const layer = LAYERS[layerIndex];
  const x0 = ix * layer.size;
  const z0 = iz * layer.size;
  const origin: [number, number, number] = [x0, 0, z0];
  const mb = new MeshBuilder(origin);
  const ctx: CellContext = { world, cells, layer, ix, iz, x0, z0, x1: x0 + layer.size, z1: z0 + layer.size, mb };
  for (const g of GENERATORS[layer.name]) g(ctx);
  return { layer: layerIndex, ix, iz, origin, prims: mb.finish() };
}

export { BASE };
