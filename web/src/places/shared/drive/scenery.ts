import {
  BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, Group, Mesh, SphereGeometry, Vector3,
  type Material,
} from "three";
import { Rng, hash2, valueNoise } from "../../../core/random";
import { batchStatic, box, cable } from "../geo";
import { atlasPlane, Parts, rod, v3 } from "../shapes";
import type { DriveRoute, RouteSample } from "./types";
import type { EquipmentCell, WinterMaterials } from "./winter-materials";
import { roadBounds } from "./simulation";
export { createWinterMaterials, type WinterMaterials } from "./winter-materials";

/** Widths stay life size even when the compiler shortens the route distance. */
export const WINTER_ROAD_WIDTH = 7;
const HALF_ROAD = WINTER_ROAD_WIDTH / 2;
const UP = v3(0, 1, 0);

function pointAt(route: DriveRoute, s: number): RouteSample {
  const pts = route.points;
  const ss = Math.max(0, Math.min(pts[pts.length - 1].s, s));
  let lo = 0, hi = pts.length - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >>> 1; if (pts[m].s <= ss) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  const t = (ss - a.s) / Math.max(0.00001, b.s - a.s);
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
  return { s: ss, real_m: a.real_m + (b.real_m - a.real_m) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, dx, dz, yaw: Math.atan2(-dx, -dz) };
}

/** Averaged tangent only affects ribbon width; centreline remains the OSM polyline. */
function frameAt(route: DriveRoute, s: number): RouteSample {
  const p = pointAt(route, s), a = pointAt(route, s - 1.2), b = pointAt(route, s + 1.2);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len > 0.01) { p.dx = (b.x - a.x) / len; p.dz = (b.z - a.z) / len; p.yaw = Math.atan2(-p.dx, -p.dz); }
  return p;
}

/** Road-right offset, height above centreline, distance forward. */
function local(p: RouteSample, offset: number, up = 0, along = 0): Vector3 {
  return v3(p.x - p.dz * offset + p.dx * along, p.y + up, p.z + p.dx * offset + p.dz * along);
}

interface NearestRoad { distance: number; lateral: number; y: number; s: number }
function nearestRoad(route: DriveRoute, x: number, z: number): NearestRoad {
  let best = Infinity, lateral = 0, lenSq = 1, y = 0, s = 0;
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i], dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / Math.max(0.001, dx * dx + dz * dz)));
    const d = (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2;
    if (d < best) {
      best = d; y = a.y + (b.y - a.y) * t; s = a.s + (b.s - a.s) * t;
      lateral = -dz * (x - a.x - dx * t) + dx * (z - a.z - dz * t); lenSq = dx * dx + dz * dz;
    }
  }
  return { distance: Math.sqrt(best), lateral: lateral / Math.sqrt(lenSq), y, s };
}

/** Scenic terrain is an authored winter reconstruction, not surveyed elevation off the road. */
function rawFieldHeight(route: DriveRoute, x: number, z: number): number {
  const near = nearestRoad(route, x, z);
  const hills = (valueNoise(x / 220, z / 220, 241) - 0.5) * 18 + (valueNoise(x / 640, z / 640, 517) - 0.5) * 45;
  const ramp = Math.pow(1 - Math.exp(-Math.max(0, near.distance - 12) / 180), 1.3);
  return near.y - 0.17 + hills * ramp + Math.sin(x * 0.06 + z * 0.027) * 0.045 * ramp;
}

function fieldSteps(distance: number): number { return distance < 64 ? 4 : distance < 130 ? 2 : 1; }

/** Place props on the actual terrain triangles, not the unmeshed height field. */
function fieldHeight(route: DriveRoute, x: number, z: number): number {
  const size = 32, cellX = Math.floor(x / size) * size, cellZ = Math.floor(z / size) * size;
  const step = size / fieldSteps(nearestRoad(route, cellX + size / 2, cellZ + size / 2).distance);
  const ax = Math.floor(x / step) * step, az = Math.floor(z / step) * step;
  const u = (x - ax) / step, v = (z - az) / step;
  const a = rawFieldHeight(route, ax, az), b = rawFieldHeight(route, ax + step, az);
  const d = rawFieldHeight(route, ax, az + step), e = rawFieldHeight(route, ax + step, az + step);
  return (u + v <= 1 ? a + (b - a) * u + (d - a) * v : e + (d - e) * (1 - u) + (b - e) * (1 - v)) - 0.07;
}

function stopInfluence(route: DriveRoute, s: number): number {
  return roadBounds(route, s).layby;
}

function settled(route: DriveRoute, s: number): number {
  const end = route.points[route.points.length - 1].s;
  let weight = Math.max(Math.exp(-s / 540), Math.exp(-(end - s) / 550));
  for (const stop of route.stops) if (stop.kind !== "finish") weight = Math.max(weight, Math.exp(-Math.abs(s - stop.s) / 450));
  return weight;
}

/** Avoid the entire route, including the other side of a station hairpin. */
function clearForProp(route: DriveRoute, p: Vector3, radius: number): boolean {
  const near = nearestRoad(route, p.x, p.z);
  if (near.distance < HALF_ROAD + 2.8 + radius) return false;
  const edge = roadBounds(route, near.s);
  return near.lateral > 0 || near.distance > -edge.clearedLeft + 2.8 + radius;
}

/** Vertices exactly on source bends prevent four-metre sampling from cutting across a turn. */
function stations(route: DriveRoute, start: number, end: number, step: number): number[] {
  const out = [start, end];
  for (let s = Math.ceil(start / step) * step; s < end; s += step) if (s > start) out.push(s);
  for (const p of route.points) if (p.s > start && p.s < end) out.push(p.s);
  return [...new Set(out)].sort((a, b) => a - b);
}

function ribbon(route: DriveRoute, ss: number[], offsets: number[] | ((p: RouteSample) => number[]), height: (p: RouteSample, off: number) => number, roadUV = false, clearRoad = false): BufferGeometry {
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (const s of ss) {
    const p = frameAt(route, s);
    for (const off of typeof offsets === "function" ? offsets(p) : offsets) {
      const at = local(p, off); at.y = height(p, off);
      positions.push(at.x, at.y, at.z);
      uv.push(roadUV ? (off + HALF_ROAD) / WINTER_ROAD_WIDTH : at.x / 7, roadUV ? s / 22 : -at.z / 7);
    }
  }
  const w = typeof offsets === "function" ? offsets(frameAt(route, ss[0])).length : offsets.length;
  const bends = clearRoad ? route.points.filter((_, i, a) => {
    if (i === 0 || i === a.length - 1) return false;
    const p = a[i - 1], q = a[i], r = a[i + 1];
    return ((q.x - p.x) * (r.x - q.x) + (q.z - p.z) * (r.z - q.z)) / (Math.hypot(q.x - p.x, q.z - p.z) * Math.hypot(r.x - q.x, r.z - q.z)) < 0.98;
  }).map(p => p.s) : [];
  const emit = (a: number, b: number, d: number, clip: boolean): void => {
    if (clip) for (const weights of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3]]) {
      const x = positions[a * 3] * weights[0] + positions[b * 3] * weights[1] + positions[d * 3] * weights[2];
      const y = positions[a * 3 + 1] * weights[0] + positions[b * 3 + 1] * weights[1] + positions[d * 3 + 1] * weights[2];
      const z = positions[a * 3 + 2] * weights[0] + positions[b * 3 + 2] * weights[1] + positions[d * 3 + 2] * weights[2];
      const near = nearestRoad(route, x, z);
      // At station corners a side ribbon can cut the next road leg even when
      // its vertices do not. Omit that bank face; the shared terrain remains
      // underneath, and the asphalt is never hidden by an apparent snow wall.
      const bounds = roadBounds(route, near.s);
      if (near.lateral > Math.min(-HALF_ROAD, bounds.clearedLeft) + 0.05 && near.lateral < HALF_ROAD - 0.05 && near.distance < Math.max(HALF_ROAD, -bounds.clearedLeft) + 0.2 && y > near.y + 0.08) return;
    }
    indices.push(a, b, d);
  };
  for (let j = 0; j + 1 < ss.length; j++) for (let i = 0; i + 1 < w; i++) {
    const a = j * w + i, b = a + w;
    // +right then +forward faces up (the frame's forward is -Z).
    const clip = clearRoad && (bends.some(s => s >= ss[j] - 20 && s <= ss[j + 1] + 20) || route.stops.some(stop => stop.s >= ss[j] - 64 && stop.s <= ss[j + 1] + 64));
    emit(a, a + 1, b, clip); emit(b, a + 1, b + 1, clip);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3)); g.setAttribute("uv", new Float32BufferAttribute(uv, 2)); g.setIndex(indices); g.computeVertexNormals();
  return g;
}

/** A chunk owns independent geometry and borrows the stage's shared palette. */
class ChunkBuilder {
  readonly group = new Group();
  readonly parts = new Parts();
  private source: BufferGeometry[] = [];
  constructor(readonly m: WinterMaterials) {}
  add(material: Material, geo: BufferGeometry, cast = true): void { this.source.push(geo); this.parts.add(material, geo, cast); }
  eq(geo: BufferGeometry, cell: EquipmentCell = "steel", cast = true): void { this.add(this.m.equipment.material, this.m.equipment.map(geo, cell), cast); }
  box(w: number, h: number, d: number, at: Vector3, cell: EquipmentCell, yaw = 0): void {
    this.eq(new BoxGeometry(w, h, d).rotateY(yaw).translate(at.x, at.y, at.z), cell);
  }
  finish(): Group {
    for (const e of this.parts.bake()) {
      const mesh = new Mesh(e.geo, e.mat); mesh.castShadow = e.cast; mesh.receiveShadow = true; this.group.add(mesh);
    }
    for (const g of this.source) g.dispose();
    const before: BufferGeometry[] = [];
    this.group.traverse((o) => { if (o instanceof Mesh) before.push(o.geometry); });
    batchStatic(this.group);
    for (const g of before) g.dispose();
    return this.group;
  }
}

function addRoad(c: ChunkBuilder, route: DriveRoute, start: number, end: number): void {
  const roadStations = stations(route, start, end, 3);
  c.add(c.m.road, ribbon(route, roadStations, [-3.5, -2.42, -1.1, 0, 1.1, 2.42, 3.5], (p, off) => p.y + 0.02 + 0.035 * (1 - Math.abs(off) / HALF_ROAD), true), false);
  for (const side of [-1, 1]) {
    const inner = (p: RouteSample): number => side < 0 ? Math.max(HALF_ROAD, -roadBounds(route, p.s).clearedLeft) : HALF_ROAD;
    const offsets = (p: RouteSample): number[] => {
      const edge = inner(p), wobble = Math.sin(p.s * 0.27) * 0.16 + Math.sin(p.s * 0.079) * 0.21;
      return [edge, edge + 0.30, edge + 0.84 + wobble * 0.35, edge + 1.8 + wobble, edge + 2.7 + wobble, edge + 4.5, edge + 8].map(x => x * side).sort((a, b) => a - b);
    };
    c.add(c.m.snow, ribbon(route, roadStations, offsets, (p, off) => {
      const at = local(p, off), d = Math.abs(off) - inner(p);
      // The blade face, rounded crest and slumped powder have actual relief.
      // Height and crest wander at two scales so banks do not read as kerbs.
      const profile = Math.max(0, 1 - Math.abs(d - 1.9) / (d < 1.9 ? 1.9 : 3.9));
      const bank = Math.pow(profile, 0.72) * (0.78 + Math.sin(p.s * 0.047 + side) * 0.17 + Math.sin(p.s * 0.41) * 0.075);
      const ground = d < 4 ? p.y : fieldHeight(route, at.x, at.z);
      const base = d < 0.05 ? p.y + 0.026 : ground + 0.025 + bank;
      const near = nearestRoad(route, at.x, at.z);
      // Snow from another branch of a tight corner may never cover asphalt.
      return near.distance < HALF_ROAD - 0.1 && Math.abs(near.s - p.s) > 8 ? near.y - 0.15 : base;
    }, false, true), false);

  }
  // The stops have a cleared shoulder connected to the left lane, without
  // teleported garages or a snow bank obstructing the completion area.
  for (const stop of route.stops) if (stop.s + 44 >= start && stop.s - 44 <= end) {
    const lo = Math.max(start, stop.s - 44), hi = Math.min(end, stop.s + 44);
    if (hi <= lo) continue;
    const apron = ribbon(route, stations(route, lo, hi, 3), p => {
      const edge = Math.min(-HALF_ROAD, roadBounds(route, p.s).clearedLeft);
      return [edge, edge * 0.67 - HALF_ROAD * 0.33, edge * 0.33 - HALF_ROAD * 0.67, -HALF_ROAD];
    }, p => p.y + 0.023);
    c.add(c.m.shoulder, apron, false);
  }
}

/**
 * World-aligned terrain cells have one owner: the nearest route station at
 * their centre. Wide bend-following ribbons fold over each other and can cover
 * the asphalt at switchbacks; this grid never does. Extra subdivision is only
 * needed beside the road. Vertex heights are deterministic in world space.
 */
function addFields(c: ChunkBuilder, route: DriveRoute, start: number, end: number): void {
  const points = stations(route, start, end, 96).map(s => pointAt(route, s));
  const size = 32, reach = 920;
  const x0 = Math.floor((Math.min(...points.map(p => p.x)) - reach) / size) * size;
  const x1 = Math.ceil((Math.max(...points.map(p => p.x)) + reach) / size) * size;
  const z0 = Math.floor((Math.min(...points.map(p => p.z)) - reach) / size) * size;
  const z1 = Math.ceil((Math.max(...points.map(p => p.z)) + reach) / size) * size;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const final = end >= route.points.at(-1)!.s;
  const vertex = (x: number, z: number): number => {
    const i = pos.length / 3; pos.push(x, rawFieldHeight(route, x, z) - 0.07, z); uv.push(x / 7, -z / 7); return i;
  };
  for (let z = z0; z < z1; z += size) for (let x = x0; x < x1; x += size) {
    const owner = nearestRoad(route, x + size / 2, z + size / 2);
    if (owner.distance > 900 || owner.s < start || (owner.s >= end && !final)) continue;
    const steps = fieldSteps(owner.distance);
    const step = size / steps;
    for (let j = 0; j < steps; j++) for (let i = 0; i < steps; i++) {
      const ax = x + i * step, az = z + j * step;
      const a = vertex(ax, az), b = vertex(ax + step, az), d = vertex(ax, az + step), e = vertex(ax + step, az + step);
      idx.push(a, d, b, b, d, e);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
  c.add(c.m.snow, geo, false);
}

function marker(c: ChunkBuilder, p: RouteSample, side: number): void {
  const base = local(p, side * 6.05, 0.24);
  const shoulder = local(p, side * 6.05, 5.5), bend = local(p, side * 5.72, 5.95), tip = local(p, side * 4.1, 5.95);
  c.eq(rod(base, shoulder, 0.065, 5), "steel"); c.eq(rod(shoulder, bend, 0.065, 5), "steel"); c.eq(rod(bend, tip, 0.065, 5), "steel");
  c.eq(rod(tip, local(p, side * 4.1, 4.4), 0.04, 5), "red");
  for (let i = 0; i < 4; i++) {
    c.eq(rod(local(p, side * 4.1, 4.45 + i * 0.3), local(p, side * 4.1, 4.60 + i * 0.3), 0.053, 5), "white");
  }
  const a = local(p, side * 4.1 - 0.33, 4.47), b = local(p, side * 4.1 + 0.33, 4.47), d = local(p, side * 4.1, 3.74);
  const tri = new BufferGeometry(); tri.setAttribute("position", new Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z, b.x, b.y, b.z, a.x, a.y, a.z, d.x, d.y, d.z], 3));
  tri.setAttribute("uv", new Float32BufferAttribute([0, 1, 1, 1, 0.5, 0, 1, 1, 0, 1, 0.5, 0], 2)); tri.computeVertexNormals(); c.eq(tri, "red");
}

function pole(c: ChunkBuilder, route: DriveRoute, s: number): void {
  const p = frameAt(route, s), next = frameAt(route, Math.min(route.points.at(-1)!.s, s + 48));
  const at = local(p, 9.5, 0.1), top = local(p, 9.5, 9.2);
  // No electrical pole on another leg of the station approach.
  if (!clearForProp(route, at, 0.25)) return;
  c.eq(rod(at, top, 0.15, 7, 0.10), "steel");
  c.box(2.5, 0.13, 0.12, local(p, 9.5, 8.65), "dark", p.yaw);
  c.box(1.6, 0.12, 0.13, local(p, 9.5, 7.7), "steel", p.yaw);
  for (const u of [-0.95, 0, 0.95]) {
    c.eq(rod(local(p, 9.5 + u, 8.62), local(p, 9.5 + u, 9.05), 0.075, 5), "white");
    // Three low-resolution catenaries: 16 triangles per metre would waste
    // handheld work on subpixel wires. Eight spans keep the sag legible.
    if (next.s > s + 1) c.eq(cable(local(p, 9.5 + u, 9.03), local(next, 9.5 + u, 9.03), 0.92, 0.022, 8), "dark", false);
  }
  c.box(0.42, 0.7, 0.4, local(p, 9.88, 7.4), "steel", p.yaw);
}

function guardrail(c: ChunkBuilder, route: DriveRoute, s: number, side: number): void {
  const a = frameAt(route, s), b = frameAt(route, s + 6);
  for (const h of [0.53, 0.72]) {
    const p = local(a, side * 4.5, h), q = local(b, side * 4.5, h);
    c.eq(rod(p, q, 0.07, 4), "steel");
  }
  c.box(0.13, 0.83, 0.13, local(a, side * 4.5, 0.41), "steel", a.yaw);
  c.box(0.20, 0.13, 0.055, local(a, side * 4.5, 0.81), "white", a.yaw);
  const p = local(a, side * 4.5, 0.85), q = local(b, side * 4.5, 0.85);
  c.add(c.m.snow, rod(p, q, 0.11, 5), false);
  c.box(0.18, 0.14, 0.065, local(a, side * 4.47, 0.64), side < 0 ? "red" : "white", a.yaw);
}

function drift(c: ChunkBuilder, at: Vector3, width: number, height: number, depth: number, yaw: number): void {
  // Only the exposed dome is modelled; the underside is buried in terrain.
  const cap = new SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  c.add(c.m.snow, cap.scale(width, height, depth).rotateY(yaw).translate(at.x, at.y, at.z), false);
}

function roadsideDetails(c: ChunkBuilder, route: DriveRoute, start: number, end: number): void {
  for (let s = Math.ceil(start / 20) * 20; s < end; s += 20) {
    const r = new Rng(s * 683 + 134), p = frameAt(route, s), side = r.pick([-1, 1]);
    if (stopInfluence(route, s) > 0.01) continue;
    const at = local(p, side * r.range(6.0, 7.6), 0.13);
    if (nearestRoad(route, at.x, at.z).distance < 5.8) continue;
    if (r.chance(0.75)) drift(c, at, r.range(0.7, 1.2), r.range(0.25, 0.6), r.range(1.1, 2.1), p.yaw + r.range(-0.3, 0.3));
    if (Math.round(s / 20) % 4 !== 0) continue;
    // Delineators rise above the ploughed bank; broad reflective blocks still
    // resolve at handheld resolution, unlike thin paint-only stripe detail.
    const base = local(p, side * 5.35, 0.15), top = local(p, side * 5.35, 1.74);
    c.eq(rod(base, top, 0.065, 5), "white");
    c.box(0.15, 0.38, 0.15, local(p, side * 5.35, 1.37), "red", p.yaw);
    c.add(c.m.snow, new BoxGeometry(0.20, 0.085, 0.20).rotateY(p.yaw).translate(top.x, top.y + 0.03, top.z), false);
  }
  // Short wind fences and exposed grasses break up long open field edges.
  // They are authored scenery, not a claim about surveyed fence positions.
  for (let s = Math.ceil(start / 12) * 12; s < end; s += 12) {
    if (stopInfluence(route, s) > 0.01 || settled(route, s) > 0.5) continue;
    const r = new Rng(s * 433 + 190), p = frameAt(route, s);
    const side = Math.floor(s / 768) % 2 === 0 ? 1 : -1;
    if (valueNoise(s / 160, 0.23, 561) > 0.75) {
      const a = local(p, side * 11, 0, -5), b = local(p, side * 11, 0, 5);
      if (clearForProp(route, a, 0.4) && clearForProp(route, b, 0.4)) {
        a.y = fieldHeight(route, a.x, a.z); b.y = fieldHeight(route, b.x, b.z);
        for (const v of [a, b]) c.eq(rod(v, v.clone().add(v3(0, 1.42, 0)), 0.08, 5), "wood");
        for (const h of [0.52, 1.10]) c.eq(rod(a.clone().add(v3(0, h, 0)), b.clone().add(v3(0, h, 0)), 0.058, 4), "wood");
        for (let i = 0; i <= 10; i++) {
          const at = a.clone().lerp(b, i / 10).add(v3(0, 0.75, 0));
          c.box(0.20, 1.08, 0.065, at, "wood", p.yaw + Math.PI / 2);
        }
        c.add(c.m.snow, rod(a.clone().add(v3(0, 1.20, 0)), b.clone().add(v3(0, 1.20, 0)), 0.10, 5), false);
      }
    }
    if (r.chance(0.4)) for (let i = 0; i < 3; i++) {
      const at = local(p, side * r.range(8.4, 11.5), 0, r.range(-4, 4));
      if (!clearForProp(route, at, 0.1)) continue;
      at.y = fieldHeight(route, at.x, at.z);
      for (let j = 0; j < 3; j++) {
        const tip = at.clone().add(v3(r.range(-0.22, 0.22), r.range(0.42, 0.9), r.range(-0.22, 0.22)));
        c.eq(rod(at, tip, 0.025, 3, 0.008), "ochre", false);
      }
    }
  }
}

function board(c: ChunkBuilder, p: RouteSample, offset: number, type: keyof WinterMaterials["signCells"], w = 3.2, h = 1.65): void {
  const front = local(p, offset, 3.5), yaw = p.yaw;
  c.box(w + 0.09, h + 0.09, 0.12, front, "steel", yaw);
  // +Z faces the approaching car; local -Z is the route's forward.
  const face = atlasPlane(w, h, c.m.signCells[type]).rotateY(yaw);
  const at = local(p, offset, 3.5, -0.071); face.translate(at.x, at.y, at.z); c.add(c.m.signs, face);
  for (const off of [-w * 0.32, w * 0.32]) c.eq(rod(local(p, offset + off, 0.1), local(p, offset + off, 3.52), 0.065, 6), "steel");
  c.add(c.m.snow, new BoxGeometry(w + 0.15, 0.09, 0.25).rotateY(yaw).translate(front.x, front.y + h / 2 + 0.055, front.z));
}

function conifer(c: ChunkBuilder, base: Vector3, height: number, r: Rng): void {
  const yaw = r.range(0, Math.PI), width = height * r.range(0.36, 0.48);
  const cell = r.chance(0.82) ? r.pick(c.m.leaves.snowVariants) : c.m.leaves.spruce;
  c.eq(rod(base, base.clone().add(v3(0, height * 0.72, 0)), Math.max(0.09, height * 0.018), 5, 0.035), "wood");
  for (let i = 0; i < 3; i++) {
    const g = atlasPlane(width, height, cell).translate(0, height * 0.5, 0).rotateY(yaw + i * Math.PI / 3).translate(base.x, base.y, base.z);
    c.add(c.m.vegetation, g);
  }
}

function birch(c: ChunkBuilder, base: Vector3, height: number, r: Rng): void {
  const lean = v3(r.range(-0.6, 0.6), height, r.range(-0.6, 0.6));
  const trunk = base.clone().addScaledVector(lean, 0.67);
  c.eq(rod(base, trunk, height * 0.017, 6, height * 0.008), "birch");
  c.eq(rod(trunk, base.clone().add(lean), height * 0.008, 5, 0.025), "birch");
  for (let i = 0; i < 5; i++) {
    const angle = i * 2.4 + r.range(-0.4, 0.4), length = height * r.range(0.16, 0.28);
    const a = base.clone().addScaledVector(lean, 0.35 + i * 0.095);
    const b = a.clone().add(v3(Math.cos(angle) * length, height * 0.2, Math.sin(angle) * length));
    c.eq(rod(a, b, height * 0.006, 4, 0.018), "birch");
    c.eq(rod(b, b.clone().add(v3(Math.cos(angle + 0.45) * length * 0.6, height * 0.11, Math.sin(angle + 0.45) * length * 0.6)), 0.018, 4, 0.009), "wood");
  }
  // Fine twigs use cards, while trunks and branches retain near-camera relief.
  for (let i = 0; i < 2; i++) {
    const g = atlasPlane(height * 0.9, height, c.m.leaves.bare).translate(0, height * 0.54, 0).rotateY(r.range(0, Math.PI) + i * Math.PI / 2).translate(base.x, base.y, base.z);
    c.add(c.m.vegetation, g);
  }
}

function farmhouse(c: ChunkBuilder, base: Vector3, yaw: number, r: Rng, barn = false): void {
  const w = r.range(barn ? 9 : 6, barn ? 13 : 9), d = r.range(barn ? 11 : 6, barn ? 18 : 10);
  const h = barn ? r.range(3.4, 4.6) : r.range(3.6, 5.7), rise = w * r.range(0.27, 0.34);
  const wall = r.pick<EquipmentCell>(barn ? ["red", "blue", "ochre"] : ["cream", "blue", "ochre"]);
  const world = (x: number, y: number, z: number): Vector3 => v3(x, y, z).applyAxisAngle(UP, yaw).add(base);
  const shape = (g: BufferGeometry): BufferGeometry => g.rotateY(yaw).translate(base.x, base.y, base.z);
  c.eq(shape(new BoxGeometry(w + 0.18, 0.48, d + 0.18).translate(0, 0.15, 0)), "dark");
  c.eq(shape(new BoxGeometry(w, h, d).translate(0, h / 2 + 0.35, 0)), wall);
  // Real pitched volume, including both gables; snow is a separate thick cap.
  for (const z of [-d / 2, d / 2]) {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute([-w / 2, h + 0.35, z, w / 2, h + 0.35, z, 0, h + rise + 0.35, z], 3));
    g.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2)); g.setIndex(z > 0 ? [0, 1, 2] : [0, 2, 1]); g.computeVertexNormals(); c.eq(shape(g), wall);
  }
  const pitch = Math.atan2(rise, w / 2), slope = Math.hypot(w / 2 + 0.45, rise + 0.18);
  for (const side of [-1, 1]) {
    c.add(c.m.roof, shape(box(slope, 0.12, d + 0.7).rotateZ(-side * pitch).translate(side * w / 4, h + rise / 2 + 0.4, 0)));
    c.add(c.m.snow, shape(new BoxGeometry(slope + 0.02, 0.26, d + 0.84).rotateZ(-side * pitch).translate(side * w / 4, h + rise / 2 + 0.60, 0)));
    c.eq(rod(world(side * (w / 2 + 0.36), h + 0.30, -d / 2 - 0.32), world(side * (w / 2 + 0.36), h + 0.30, d / 2 + 0.32), 0.07, 5), "steel");
    for (let z = -d / 2 + 0.3; z < d / 2; z += r.range(0.8, 1.7)) {
      const at = world(side * (w / 2 + 0.34), h + 0.22, z);
      c.add(c.m.snow, rod(at, at.clone().add(v3(0, -r.range(0.16, 0.45), 0)), 0.055, 4, 0.006), false);
    }
  }
  if (barn) {
    c.eq(shape(new BoxGeometry(w * 0.64, h * 0.7, 0.12).translate(0, h * 0.35 + 0.4, d / 2 + 0.08)), "dark");
    for (let x = -w * 0.3; x < w * 0.32; x += 0.55) c.eq(shape(new BoxGeometry(0.055, h * 0.67, 0.15).translate(x, h * 0.35 + 0.4, d / 2 + 0.13)), "steel");
  } else {
    // Inset warm panes, separate sill and aluminium surround survive Vita's
    // detail-map cutoff. Their light is modest on an overcast afternoon.
    for (const zSide of [-1, 1]) for (const x of [-w * 0.27, w * 0.27]) for (let floor = 0; floor < (h > 4.8 ? 2 : 1); floor++) {
      const wy = 1.8 + floor * 2.25, wz = zSide * (d / 2 + 0.06), ww = w * 0.23, wh = 1.2;
      c.eq(shape(new BoxGeometry(ww + 0.19, wh + 0.17, 0.14).translate(x, wy, wz)), "dark");
      const pane = atlasPlane(ww, wh, c.m.equipment.rect("window")).rotateY(zSide < 0 ? Math.PI : 0).translate(x, wy, wz + zSide * 0.079);
      c.add(c.m.windows, shape(pane));
      c.eq(shape(new BoxGeometry(0.055, wh, 0.16).translate(x, wy, wz + zSide * 0.01)), "white");
      c.eq(shape(new BoxGeometry(ww + 0.27, 0.12, 0.30).translate(x, wy - wh / 2 - 0.04, wz)), "white");
      c.add(c.m.snow, shape(new BoxGeometry(ww + 0.25, 0.055, 0.24).translate(x, wy - wh / 2 + 0.04, wz + zSide * 0.05)));
    }
    c.eq(shape(new BoxGeometry(1.0, 2.15, 0.17).translate(0, 1.39, d / 2 + 0.06)), "wood");
    c.eq(shape(new BoxGeometry(0.11, 0.055, 0.09).translate(0.31, 1.38, d / 2 + 0.19)), "steel");
    c.add(c.m.roof, shape(new BoxGeometry(2.0, 0.1, 1.2).rotateX(0.12).translate(0, 2.78, d / 2 + 0.43)));
    c.add(c.m.snow, shape(new BoxGeometry(2.1, 0.19, 1.28).rotateX(0.12).translate(0, 2.91, d / 2 + 0.43)));
    c.eq(shape(new BoxGeometry(1.7, 0.2, 1.1).translate(0, 0.30, d / 2 + 0.50)), "steel");
  }
  const chimneyAt = world(-w * 0.19, h + rise * 0.91 + 0.65, -d * 0.2);
  c.box(0.43, 1.35, 0.43, chimneyAt, "dark", yaw);
  c.add(c.m.snow, new BoxGeometry(0.60, 0.13, 0.60).rotateY(yaw).translate(chimneyAt.x, chimneyAt.y + 0.75, chimneyAt.z));
  if (!barn) {
    const tank = world(w / 2 + 0.85, 1.02, -d / 3);
    c.eq(new CylinderGeometry(0.33, 0.33, 1.35, 8).translate(tank.x, tank.y, tank.z), "white");
    c.box(0.82, 0.18, 0.8, tank.clone().add(v3(0, 0.77, 0)), "steel", yaw);
    c.add(c.m.snow, new BoxGeometry(0.89, 0.16, 0.87).rotateY(yaw).translate(tank.x, tank.y + 0.91, tank.z));
    // Heating-oil pipe, vent and a small split-log stack add scale at stops.
    c.eq(rod(tank.clone().add(v3(0, -0.35, 0)), world(w / 2 + 0.04, 0.7, -d / 3), 0.035, 4), "dark");
    const vent = world(w / 2 + 0.17, 2.6, d * 0.12);
    c.eq(new CylinderGeometry(0.12, 0.12, 0.42, 6).rotateZ(Math.PI / 2).rotateY(yaw).translate(vent.x, vent.y, vent.z), "steel");
    for (let j = 0; j < 2; j++) for (let i = 0; i < 4 - j; i++) {
      const a = world(w / 2 + 0.5 + i * 0.22, 0.31 + j * 0.22, d / 2 - 0.5);
      c.eq(rod(a, a.clone().add(v3(0, 0, -0.7).applyAxisAngle(UP, yaw)), 0.125, 6), "wood");
    }
    const pile = world(w / 2 + 0.88, 0.56, d / 2 - 0.85);
    drift(c, pile, 0.65, 0.14, 0.52, yaw);
  }
}

function stopFacilities(c: ChunkBuilder, route: DriveRoute, p: RouteSample, kind: "delivery" | "service" | "finish"): void {
  const shift = [0, 4, 8, 12, 16, 24, 32].find(d => clearForProp(route, local(p, -16.85 - d, 0, -9), 3.8));
  if (shift === undefined) return;
  const at = (off: number, up: number, along: number): Vector3 => local(p, off - shift, up, along);
  // A small covered waiting/loading area sits beyond the drivable apron.
  // It shares the ordinary equipment/roof/snow batches and emits no new light.
  for (const off of [-18.4, -15.3]) for (const along of [-10.5, -7.5]) {
    c.box(0.12, 2.55, 0.12, at(off, 1.3, along), "wood", p.yaw);
  }
  c.add(c.m.roof, new BoxGeometry(3.7, 0.12, 3.6).rotateX(0.07).rotateY(p.yaw).translate(...at(-16.85, 2.66, -9).toArray()));
  c.add(c.m.snow, new BoxGeometry(3.8, 0.21, 3.7).rotateX(0.07).rotateY(p.yaw).translate(...at(-16.85, 2.80, -9).toArray()));
  c.box(0.13, 1.80, 3.0, at(-18.4, 1.1, -9), "wood", p.yaw);
  c.box(0.46, 0.10, 2.50, at(-17.8, 0.54, -9), "wood", p.yaw);
  for (const along of [-9.9, -8.1]) c.box(0.36, 0.48, 0.13, at(-17.8, 0.26, along), "dark", p.yaw);
  if (kind === "delivery") {
    for (let i = 0; i < 5; i++) c.box(0.55, 0.40, 0.50, at(-16.75 + (i % 2) * 0.6, 0.24 + Math.floor(i / 2) * 0.40, -8.3), "ochre", p.yaw);
    c.box(1.6, 0.13, 1.1, at(-16.5, 0.07, -8.3), "wood", p.yaw);
  } else {
    c.box(0.75, 1.7, 0.7, at(-16.2, 0.88, -10.0), "blue", p.yaw);
    c.box(0.055, 0.9, 0.5, at(-15.79, 1.1, -10.0), "dark", p.yaw);
    c.box(0.065, 0.07, 0.44, at(-15.75, 0.8, -10.0), "white", p.yaw);
  }
  for (const along of [-19, -15, 12, 17]) {
    const pile = at(-14.5, 0.15, along);
    if (clearForProp(route, pile, 2.1)) drift(c, pile, 1.4, 0.95, 2.1, p.yaw);
  }
  // Red snow shovel beside the shelter; the broad blade reads in silhouette.
  c.eq(rod(at(-15.35, 0.26, -7.0), at(-15.6, 1.55, -7.0), 0.025, 5), "wood");
  c.box(0.38, 0.37, 0.055, at(-15.35, 0.2, -7.0), "red", p.yaw);
}

function addSettlement(c: ChunkBuilder, route: DriveRoute, start: number, end: number): void {
  for (let s = Math.ceil(start / 56) * 56; s < end; s += 56) {
    const r = new Rng(Math.round(s) * 313 + 237), density = settled(route, s);
    if (r.next() > 0.055 + density * 0.90) continue;
    const p = frameAt(route, s), side = r.pick([-1, 1]), off = side * r.range(density > 0.35 ? 21 : 37, density > 0.35 ? 35 : 85);
    const at = local(p, off); at.y = fieldHeight(route, at.x, at.z) + 0.05;
    if (!clearForProp(route, at, 9)) continue;
    const yaw = Math.atan2(side * p.dz, -side * p.dx);
    farmhouse(c, at, yaw + r.range(-0.09, 0.09), r);
    if (density < 0.5 && r.chance(0.6)) {
      const barn = local(p, off + side * 22, 0, r.range(-18, 22)); barn.y = fieldHeight(route, barn.x, barn.z);
      if (clearForProp(route, barn, 13)) farmhouse(c, barn, yaw + Math.PI / 2, r, true);
    }
    // An occasional windbreak protects the farmstead; broad fields stay open.
    for (let i = 0; i < 5; i++) {
      const tree = local(p, off + side * 17, 0, -23 + i * 5); tree.y = fieldHeight(route, tree.x, tree.z);
      if (clearForProp(route, tree, 2.5)) conifer(c, tree, r.range(8, 12), r);
    }
  }
  for (const stop of route.stops) if (stop.s >= start && stop.s < end) {
    const p = frameAt(route, stop.s);
    const signOffset = [-16, -20, -24, -28, -36].find(off => clearForProp(route, local(p, off), 2.1));
    if (signOffset !== undefined) board(c, p, signOffset, stop.kind === "finish" ? "finish" : stop.kind === "service" ? "service" : "delivery", 3.8, 1.8);
    stopFacilities(c, route, p, stop.kind);
    const at = local(p, -25.5, 0, 15); at.y = fieldHeight(route, at.x, at.z);
    if (nearestRoad(route, at.x, at.z).distance > 16) farmhouse(c, at, Math.atan2(-p.dz, p.dx), new Rng(Math.round(stop.s) + 327), stop.kind === "delivery");
  }
}

function addTrees(c: ChunkBuilder, route: DriveRoute, start: number, end: number): void {
  // Station-anchored seeds make rebuilding/evicting a page exactly repeatable.
  for (let s = Math.ceil(start / 18) * 18; s < end; s += 18) {
    const r = new Rng(Math.round(s) * 193 + 87), p = frameAt(route, s), urban = settled(route, s);
    const belt = valueNoise(s / 420, 0.1, 344) > 0.53;
    for (const side of [-1, 1]) {
      const count = belt ? r.int(3, 6) : r.int(0, 2);
      for (let i = 0; i < count; i++) {
        const off = side * (i < 2 && belt ? r.range(18, 45) : r.range(65, 190));
        if (urban > 0.55 && Math.abs(off) < 70) continue;
        const at = local(p, off, 0, r.range(-8, 8)); at.y = fieldHeight(route, at.x, at.z);
        if (!clearForProp(route, at, 3.3)) continue;
        if (r.chance(belt ? 0.84 : 0.55)) conifer(c, at, r.range(6.3, 13.5), r);
        else birch(c, at, r.range(6.5, 11.5), r);
      }
    }
  }
  // Recognisable rows of leafless shelterbelt trees divide agricultural plots.
  for (let s = Math.ceil(start / 420) * 420; s < end; s += 420) {
    if (hash2(s, 0, 716) < 0.35 || settled(route, s) > 0.5) continue;
    const p = frameAt(route, s), r = new Rng(s * 791 + 834), side = r.pick([-1, 1]);
    for (let i = 0; i < 10; i++) {
      const at = local(p, side * (32 + i * 6.5), 0, Math.sin(i * 0.31) * 2); at.y = fieldHeight(route, at.x, at.z);
      if (clearForProp(route, at, 3)) birch(c, at, r.range(8, 11), r);
    }
  }
}

/**
 * Compiler-first winter corridor. The caller streams ~384 m pieces on web and
 * exports every piece for the target cooker. No texture or material is allocated
 * here. Scenery placement is authored from route position and seeds; only the
 * road centreline and sampled on-road elevation claim real-world measurements.
 */
export function buildWinterChunk(route: DriveRoute, startS: number, endS: number, materials: WinterMaterials): Group {
  if (route.points.length < 2) throw new Error("Winter route needs at least two centreline points");
  const end = Math.min(endS, route.points[route.points.length - 1].s), start = Math.max(0, startS);
  const c = new ChunkBuilder(materials);
  c.group.name = `winter-corridor:${Math.round(start)}-${Math.round(end)}`;
  if (end <= start) return c.group;
  addFields(c, route, start, end);
  addRoad(c, route, start, end);
  for (let s = Math.ceil(start / 72) * 72; s < end; s += 72) if (stopInfluence(route, s) < 0.3) {
    const p = frameAt(route, s);
    for (const side of [-1, 1]) if (nearestRoad(route, local(p, side * 6.05).x, local(p, side * 6.05).z).distance > 5.1) marker(c, p, side);
  }
  for (let s = Math.ceil(start / 48) * 48; s < end; s += 48) pole(c, route, s);
  for (let s = Math.ceil(start / 6) * 6; s < end; s += 6) {
    const a = frameAt(route, s - 18), b = frameAt(route, s + 18);
    const dot = a.dx * b.dx + a.dz * b.dz;
    if (dot < 0.94 && stopInfluence(route, s) < 0.01) guardrail(c, route, s, a.dx * b.dz - a.dz * b.dx > 0 ? -1 : 1);
  }
  for (let s = Math.ceil(start / 930) * 930; s < end; s += 930) {
    const p = frameAt(route, s + 6);
    if (stopInfluence(route, s) < 0.1 && nearestRoad(route, local(p, -8).x, local(p, -8).z).distance > 7) board(c, p, -8.0, Math.round(s / 930) % 3 === 0 ? "biei" : "ice", 2.8, 1.4);
  }
  for (let s = Math.ceil((start - 120) / 1550) * 1550 + 120; s < end; s += 1550) if (s >= start) board(c, frameAt(route, s), -7.2, "route", 0.58, 0.86);
  addSettlement(c, route, start, end);
  roadsideDetails(c, route, start, end);
  addTrees(c, route, start, end);
  const group = c.finish();
  group.userData.winterChunk = { start, end };
  return group;
}
