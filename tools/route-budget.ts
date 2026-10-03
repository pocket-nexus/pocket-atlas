// What the Vita would draw along a cooked route, estimated on the host: for
// a driving camera every 250 m, the cells each layer has loaded, the draws
// that pass the frustum and the triangles of the reduced level the renderer
// would pick (its rule: the coarsest level whose error projects under one
// pixel of the 480×272 frame). No fog culling: what is counted is submitted.
//
//   bun tools/route-budget.ts [--route hokkaido-r237] [--step 250] [--fov 55]
//
// This is planning evidence (draws and triangles against the guides of
// about 250 draws and 130k triangles), not a device measurement: frame time
// comes from `bun tools/atlas.ts drive`.

import { openSync, readFileSync, readSync } from "node:fs";
import { resolve } from "node:path";

const argv = Bun.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const id = opt("route", "hokkaido-r237");
const path = resolve(import.meta.dir, `../.pocket-build/routes/${id}/${id}.route`);
const STEP = Number(opt("step", "250"));
const FOV = Number(opt("fov", "55"));

const fd = openSync(path, "r");
const read = (at: number, n: number) => {
  const b = Buffer.alloc(n);
  readSync(fd, b, 0, n, at);
  return b;
};
const head = read(0, 16);
if (head.toString("latin1", 0, 4) !== "ROUT") throw new Error(`${path}: not a route pack`);
const count = head.readUInt32LE(8);
const table = read(16, count * 16);
const sections = new Map<string, { offset: number; size: number }>();
for (let i = 0; i < count; i++) sections.set(table.toString("latin1", i * 16, i * 16 + 4), { offset: table.readUInt32LE(i * 16 + 4), size: table.readUInt32LE(i * 16 + 8) });
const sec = (tag: string) => {
  const s = sections.get(tag);
  if (!s) throw new Error(`missing section ${tag}`);
  return s;
};
const meta = JSON.parse(read(sec("META").offset, sec("META").size).toString("utf8"));
const lineB = read(sec("LINE").offset, sec("LINE").size);
const n = lineB.length / 16;
const lx = new Float64Array(n);
const ly = new Float64Array(n);
const lz = new Float64Array(n);
for (let i = 0; i < n; i++) {
  lx[i] = lineB.readFloatLE(i * 16);
  ly[i] = lineB.readFloatLE(i * 16 + 4);
  lz[i] = lineB.readFloatLE(i * 16 + 8);
}
// The kit's material names, for the per-material breakdown.
const kit = sec("KIT ");
const kitHead = read(kit.offset, 16);
const kitCount = kitHead.readUInt32LE(8);
const kitTable = read(kit.offset + 16, kitCount * 16);
let materials: string[] = [];
for (let i = 0; i < kitCount; i++) {
  if (kitTable.toString("latin1", i * 16, i * 16 + 4) === "META") {
    const m = JSON.parse(read(kit.offset + kitTable.readUInt32LE(i * 16 + 4), kitTable.readUInt32LE(i * 16 + 8)).toString("utf8"));
    materials = m.materials.map((x: { name: string }) => x.name);
  }
}

interface Draw {
  material: number;
  indexCount: number;
  min: [number, number, number];
  max: [number, number, number];
  lods: [number, number][];
}
interface Cell {
  layer: number;
  ix: number;
  iz: number;
  origin: [number, number, number];
  size: number;
  draws: Draw[];
}
const idx = read(sec("CIDX").offset, sec("CIDX").size);
const cellsAt = sec("CELL").offset;
const cells: Cell[] = [];
for (let o = 0; o + 36 <= idx.length; o += 36) {
  const offset = idx.readUInt32LE(o + 8);
  const size = idx.readUInt32LE(o + 12);
  const origin: [number, number, number] = [idx.readFloatLE(o + 16), idx.readFloatLE(o + 20), idx.readFloatLE(o + 24)];
  const h = read(cellsAt + offset, Math.min(size, 16 + 124 * 64));
  const nd = h.readUInt32LE(4);
  const draws: Draw[] = [];
  const rec = nd * 124 + 16 <= h.length ? h : read(cellsAt + offset, 16 + nd * 124);
  for (let k = 0; k < nd; k++) {
    const b = 16 + k * 124;
    const f3 = (at: number): [number, number, number] => [rec.readFloatLE(b + at) + origin[0], rec.readFloatLE(b + at + 4) + origin[1], rec.readFloatLE(b + at + 8) + origin[2]];
    const lodCount = rec.readUInt32LE(b + 84);
    const lods: [number, number][] = [];
    for (let l = 0; l < Math.min(3, lodCount); l++) lods.push([rec.readUInt32LE(b + 92 + l * 12), rec.readFloatLE(b + 96 + l * 12)]);
    draws.push({ material: rec.readUInt32LE(b), indexCount: rec.readUInt32LE(b + 16), min: f3(60), max: f3(72), lods });
  }
  cells.push({ layer: idx[o]!, ix: idx.readInt16LE(o + 2), iz: idx.readInt16LE(o + 4), origin, size, draws });
}
console.log(`${id}: ${cells.length} cells, ${cells.reduce((s, c) => s + c.draws.length, 0)} draws in the pack, ${(cells.reduce((s, c) => s + c.size, 0) / 1048576).toFixed(0)} MiB of cells`);

const pixel = (2 * Math.tan((FOV * Math.PI) / 360)) / 272;
const tanY = Math.tan((FOV * Math.PI) / 360);
const tanX = tanY * (960 / 544);
const rows: { km: number; draws: number; tris: number; loaded: number; bytes: number; by: Map<number, [number, number, number]> }[] = [];
for (let i = 2; i + 20 < n; i += Math.max(1, Math.round(STEP / meta.step))) {
  // The chase camera: 5.5 m behind and 2.2 m above a car in the left lane, looking along the road.
  const tx = lx[i + 2]! - lx[i]!;
  const tz = lz[i + 2]! - lz[i]!;
  const tl = Math.hypot(tx, tz) || 1;
  const f: [number, number, number] = [tx / tl, -0.06, tz / tl];
  const r: [number, number, number] = [-f[2], 0, f[0]];
  const eye: [number, number, number] = [lx[i]! - f[0] * 5.5 + r[0] * -1.65, ly[i]! + 2.25, lz[i]! - f[2] * 5.5 + r[2] * -1.65];
  const up: [number, number, number] = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  let draws = 0;
  let tris = 0;
  let loaded = 0;
  let bytes = 0;
  const by = new Map<number, [number, number, number]>();
  for (const c of cells) {
    const layer = meta.layers[c.layer];
    const dx = Math.max(c.ix * layer.size - eye[0], 0, eye[0] - (c.ix + 1) * layer.size);
    const dz = Math.max(c.iz * layer.size - eye[2], 0, eye[2] - (c.iz + 1) * layer.size);
    if (Math.hypot(dx, dz) > layer.radius) continue;
    loaded++;
    bytes += c.size;
    for (const d of c.draws) {
      // Box against the four side planes and the near plane, in camera space.
      let out = [true, true, true, true, true];
      let near = Infinity;
      for (let k = 0; k < 8; k++) {
        const p = [k & 1 ? d.max[0] : d.min[0], k & 2 ? d.max[1] : d.min[1], k & 4 ? d.max[2] : d.min[2]];
        const v = [p[0]! - eye[0], p[1]! - eye[1], p[2]! - eye[2]];
        const z = v[0]! * f[0] + v[1]! * f[1] + v[2]! * f[2];
        const x = v[0]! * r[0] + v[1]! * r[1] + v[2]! * r[2];
        const y = v[0]! * up[0] + v[1]! * up[1] + v[2]! * up[2];
        if (x <= z * tanX) out[0] = false;
        if (x >= -z * tanX) out[1] = false;
        if (y <= z * tanY) out[2] = false;
        if (y >= -z * tanY) out[3] = false;
        if (z >= 0.3) out[4] = false;
      }
      if (out.some(Boolean)) continue;
      const cx = Math.max(d.min[0], Math.min(d.max[0], eye[0])) - eye[0];
      const cy = Math.max(d.min[1], Math.min(d.max[1], eye[1])) - eye[1];
      const cz = Math.max(d.min[2], Math.min(d.max[2], eye[2])) - eye[2];
      near = Math.hypot(cx, cy, cz);
      const limit = Math.max(near, 0.1) * pixel;
      let indices = d.indexCount;
      for (const [cnt, err] of d.lods) if (err < limit) indices = cnt;
      if (indices === 0) continue;
      draws++;
      tris += indices / 3;
      // Per material and layer; the full level's triangles ride along for the reduction ratio.
      const key = d.material * 8 + c.layer;
      const m = by.get(key) ?? [0, 0, 0];
      by.set(key, [m[0] + 1, m[1] + indices / 3, m[2] + d.indexCount / 3]);
    }
  }
  rows.push({ km: (i * meta.step) / 1000, draws, tris, loaded, bytes, by });
}
const worst = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, b) => (f(b) > f(a) ? b : a));
const mean = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
console.log(`${rows.length} camera positions, chase view, ${FOV}° vertical`);
console.log(`draws      mean ${mean((r) => r.draws).toFixed(0)}, worst ${worst((r) => r.draws).draws} at km ${worst((r) => r.draws).km.toFixed(2)}`);
console.log(`triangles  mean ${(mean((r) => r.tris) / 1000).toFixed(0)}k, worst ${(worst((r) => r.tris).tris / 1000).toFixed(0)}k at km ${worst((r) => r.tris).km.toFixed(2)}`);
console.log(`cells      mean ${mean((r) => r.loaded).toFixed(0)}, worst ${worst((r) => r.loaded).loaded}; memory mean ${(mean((r) => r.bytes) / 1048576).toFixed(1)} MiB, worst ${(worst((r) => r.bytes).bytes / 1048576).toFixed(1)} MiB at km ${worst((r) => r.bytes).km.toFixed(2)}`);
console.log(`over 250 draws at ${rows.filter((r) => r.draws > 250).length} positions, over 130k triangles at ${rows.filter((r) => r.tris > 130_000).length}`);
for (const [label, r] of [["most triangles", worst((x) => x.tris)]] as const) {
  console.log(`${label} (km ${r.km.toFixed(2)}): ${[...r.by].sort((a, b) => b[1][1] - a[1][1]).map(([k, [dn, tn, full]]) => `${materials[k >> 3] ?? k >> 3}@${meta.layers[k & 7].name} ${dn}/${(tn / 1000).toFixed(1)}k of ${(full / 1000).toFixed(1)}k`).join(", ")}`);
}
if (argv.includes("--all")) for (const r of rows) console.log(`km ${r.km.toFixed(2).padStart(6)}  ${String(r.draws).padStart(4)} draws  ${(r.tris / 1000).toFixed(0).padStart(4)}k tris  ${String(r.loaded).padStart(4)} cells  ${(r.bytes / 1048576).toFixed(1)} MiB`);
