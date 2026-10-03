/**
 * Exports a route's world for the Pocket Atlas compiler (RouteIR): every
 * cell of every layer as float geometry by kit material name, the driven
 * line and the route's table. Runs under Bun: the generators need no
 * browser. The route's kit (materials, the car, the sky) is a place export
 * made with the dev server:
 *
 *   bun scripts/export-place.ts --place <id> --seconds 1 --out ../.pocket-build/routes/<id>/kit
 *   bun scripts/export-route.ts [--route hokkaido-r237] [--out ../.pocket-build/routes/<id>] [--km a,b]
 *
 * `--km a,b` exports only the cells within the layers' radii of that stretch
 * (a quick device test); without it, the whole route.
 *
 * Writes route.json, line.bin and cells.bin (formats: the compiler's
 * `crates/pocket3d-place-cook/src/route.rs`).
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { placeById } from "../src/places/registry";
import { buildCell } from "../src/routes/shared/cell";
import type { RouteDef, RouteView } from "../src/routes/shared/def";
import { KEI } from "../src/routes/shared/drive/vehicle";
import { JPRCS_XII, toLocal, type Frame } from "../src/routes/shared/geodesy";
import { Cells, LAYERS } from "../src/routes/shared/layers";
import type { Line } from "../src/routes/shared/line";
import type { CellData } from "../src/routes/shared/mesh";
import { RouteSource, type RouteFiles } from "../src/routes/shared/source";
import { RouteWorld } from "../src/routes/shared/world";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const id = opt("route", "hokkaido-r237");
const out = resolve(opt("out", join(import.meta.dir, `../../.pocket-build/routes/${id}`)));
const stretch = opt("km", "").split(",").filter(Boolean).map(Number);
mkdirSync(out, { recursive: true });

const dir = join(import.meta.dir, `../src/routes/${id}`);
const buf = (name: string) => {
  const b = readFileSync(join(dir, "data", name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const files: RouteFiles = { route: JSON.parse(readFileSync(join(dir, "data/route.json"), "utf8")), centerline: buf("centerline.bin"), features: buf("features.bin"), demNear: buf("dem-near.bin"), demMid: buf("dem-mid.bin"), demFar: buf("dem-far.bin") };
const def = ((await import(join(dir, "route.ts"))) as { ROUTE: RouteDef }).ROUTE;

const t0 = performance.now();
const world = new RouteWorld(await RouteSource.decode(files));
const line = world.main.line;
const cells = new Cells(line);
console.log(`[route] ${id}: ${(line.length / 1000).toFixed(2)} km, ${world.roads.length} roads, ${world.junctions.length} junctions (${(performance.now() - t0).toFixed(0)} ms)`);

// ---- which cells
const wanted: [number, number, number][] = [];
for (const layer of LAYERS) {
  for (const [ix, iz] of cells.lists[layer.index]) {
    if (stretch.length === 2) {
      // Within the layer's radius of the stretch.
      let near = false;
      for (let s = stretch[0] * 1000; s <= stretch[1] * 1000 && !near; s += layer.size / 4) {
        const p = line.at(s);
        const dx = Math.max(ix * layer.size - p.x, 0, p.x - (ix + 1) * layer.size);
        const dz = Math.max(iz * layer.size - p.z, 0, p.z - (iz + 1) * layer.size);
        near = Math.hypot(dx, dz) <= layer.radius;
      }
      if (!near) continue;
    }
    wanted.push([layer.index, ix, iz]);
  }
}

// ---- cells.bin
const names: string[] = [];
const nameIndex = new Map<string, number>();
const fd = openSync(join(out, "cells.bin"), "w");
const put = (b: Uint8Array) => writeSync(fd, b);
// The header (with the material names) is written last, into the room reserved here.
const HEAD = 4096;
put(new Uint8Array(HEAD));
let triangles = 0;
const perLayer = LAYERS.map(() => ({ cells: 0, triangles: 0, ms: 0 }));
const u32 = (...v: number[]) => new Uint8Array(Uint32Array.from(v).buffer);
function writeCell(cell: CellData): void {
  const head = new DataView(new ArrayBuffer(16 + 24));
  head.setUint32(0, cell.layer, true);
  head.setInt32(4, cell.ix, true);
  head.setInt32(8, cell.iz, true);
  head.setUint32(12, cell.prims.length, true);
  for (let k = 0; k < 3; k++) head.setFloat64(16 + k * 8, cell.origin[k], true);
  put(new Uint8Array(head.buffer));
  for (const p of cell.prims) {
    let m = nameIndex.get(p.material);
    if (m === undefined) {
      m = names.length;
      names.push(p.material);
      nameIndex.set(p.material, m);
    }
    put(u32(m, p.position.length / 3, p.index.length, 0));
    for (const a of [p.position, p.normal, p.uv, p.color, p.index]) put(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
}
let last = performance.now();
for (let i = 0; i < wanted.length; i++) {
  const [li, ix, iz] = wanted[i];
  const t = performance.now();
  const cell = buildCell(world, cells, li, ix, iz);
  const n = cell.prims.reduce((s, p) => s + p.index.length / 3, 0);
  triangles += n;
  perLayer[li].cells++;
  perLayer[li].triangles += n;
  perLayer[li].ms += performance.now() - t;
  writeCell(cell);
  if (performance.now() - last > 5000) {
    last = performance.now();
    console.log(`[route] ${i + 1}/${wanted.length} cells, ${(triangles / 1e6).toFixed(2)} M triangles`);
  }
}
const nameBytes: Uint8Array[] = [];
for (const n of names) {
  const b = new TextEncoder().encode(n);
  nameBytes.push(new Uint8Array(Uint16Array.of(b.length).buffer), b);
}
const header = Buffer.concat([Buffer.from("RCEL"), u32(1, names.length, wanted.length, HEAD), ...nameBytes]);
if (header.length > HEAD) throw new Error("too many kit materials for the cells.bin header");
writeSync(fd, header, 0, header.length, 0);
closeSync(fd);

// ---- line.bin: x, y, z, ploughed half width
const lineBin = new Float32Array(line.n * 4);
for (let i = 0; i < line.n; i++) lineBin.set([line.x[i], line.y[i], line.z[i], world.main.half], i * 4);
writeFileSync(join(out, "line.bin"), new Uint8Array(lineBin.buffer));

// ---- route.json
const json = files.route;
const frame: Frame = { zone: JPRCS_XII, north0: json.frame.north0, east0: json.frame.east0 };
const listed = placeById(id)?.route?.stops ?? [];
if (listed.length < 2) throw new Error(`${id} has no route stops in the registry`);
const stops = listed.map((s, i) => {
  if (i === 0) return { name: s.name, native: s.native, s: 0 };
  if (i === listed.length - 1) return { name: s.name, native: s.native, s: line.length };
  const [x, z] = toLocal(frame, s.lat, s.lon);
  const p = line.project(x, z, 400);
  if (!p) throw new Error(`stop ${s.name} is not within 400 m of the route`);
  return { name: s.name, native: s.native, s: p.s };
});
function view(l: Line, v: RouteView): { name: string; pos: number[]; target: number[]; fov: number } {
  const s = v.km * 1000 + (v.travel ?? 6) / 2;
  const p = l.at(s);
  const pos = [p.x - p.tz * v.right, p.y + v.up, p.z + p.tx * v.right];
  const q = l.at(s + v.ahead);
  const r = v.aheadRight ?? 0;
  return { name: v.name, pos, target: [q.x - q.tz * r, q.y + (v.aheadUp ?? 1), q.z + q.tx * r], fov: v.fov };
}
const dep = new Date(def.departure);
// Minutes after local midnight, from the offset written in the departure time.
const offset = /([+-])(\d\d):(\d\d)$/.exec(def.departure);
const offsetMin = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
const departure = (((dep.getUTCHours() * 60 + dep.getUTCMinutes() + offsetMin) % 1440) + 1440) % 1440;
writeFileSync(
  join(out, "route.json"),
  JSON.stringify(
    {
      version: 1,
      id,
      kit: "kit",
      length: line.length,
      step: json.step,
      samples: line.n,
      layers: LAYERS.map((l) => ({ name: l.name, size: l.size, radius: l.radius })),
      stops,
      limits: json.limits,
      car: KEI,
      departure,
      views: def.views.map((v) => view(line, v)),
      frame: json.frame,
      partial: stretch.length === 2 ? { km: stretch } : undefined,
      materials: names,
      report: { cells: wanted.length, triangles, layers: LAYERS.map((l, i) => ({ name: l.name, ...perLayer[i], ms: Math.round(perLayer[i].ms) })), seconds: Math.round((performance.now() - t0) / 1000) },
    },
    null,
    1,
  ) + "\n",
);
console.log(`[route] ${wanted.length} cells, ${(triangles / 1e6).toFixed(2)} M triangles, materials: ${names.join(", ")}`);
for (const [i, l] of LAYERS.entries()) console.log(`[route]   ${l.name}: ${perLayer[i].cells} cells, ${perLayer[i].triangles} triangles, ${(perLayer[i].ms / Math.max(1, perLayer[i].cells)).toFixed(0)} ms each`);
console.log(`[route] wrote ${out} in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
