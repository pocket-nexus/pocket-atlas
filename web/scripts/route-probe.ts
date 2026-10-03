/**
 * Builds cells of a route under Bun (no browser) and prints what they hold:
 * a quick check of the generators.
 *
 *   bun scripts/route-probe.ts [--route hokkaido-r237] [--km 12.5] [--layer base]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCell } from "../src/routes/shared/cell";
import { Cells, LAYERS } from "../src/routes/shared/layers";
import { triangles } from "../src/routes/shared/mesh";
import { RouteSource, type RouteFiles } from "../src/routes/shared/source";
import { RouteWorld } from "../src/routes/shared/world";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dir = join(import.meta.dir, `../src/routes/${opt("route", "hokkaido-r237")}/data`);
const buf = (name: string) => {
  const b = readFileSync(join(dir, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
export function loadFiles(): RouteFiles {
  return { route: JSON.parse(readFileSync(join(dir, "route.json"), "utf8")), centerline: buf("centerline.bin"), features: buf("features.bin"), demNear: buf("dem-near.bin"), demMid: buf("dem-mid.bin"), demFar: buf("dem-far.bin") };
}

if (import.meta.main) {
  let t = performance.now();
  const world = new RouteWorld(await RouteSource.decode(loadFiles()));
  const cells = new Cells(world.main.line);
  console.log(`world: ${world.roads.length} roads, ${world.junctions.length} junctions, ${world.source.features.length} features (${(performance.now() - t).toFixed(0)} ms)`);
  console.log(`cells: ${LAYERS.map((l, i) => `${l.name} ${cells.lists[i].length}`).join(", ")}`);
  const km = Number(opt("km", "12.5"));
  const p = world.main.line.at(km * 1000);
  console.log(`km ${km}: x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)}`);
  for (const layer of LAYERS) {
    const ix = Math.floor(p.x / layer.size);
    const iz = Math.floor(p.z / layer.size);
    t = performance.now();
    const cell = buildCell(world, cells, layer.index, ix, iz);
    const ms = performance.now() - t;
    console.log(`${layer.name} ${ix},${iz}: ${triangles(cell.prims)} triangles in ${ms.toFixed(0)} ms — ${cell.prims.map((q) => `${q.material} ${q.index.length / 3}`).join(", ")}`);
  }
}
