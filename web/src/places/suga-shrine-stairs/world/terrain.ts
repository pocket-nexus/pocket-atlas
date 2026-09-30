import { BufferGeometry, CylinderGeometry, PlaneGeometry, Vector3, type Material } from "three";
import { canvas, JP_SANS, toTexture } from "../../shared/canvas";
import { box } from "../../shared/geo";
import { merge, rod, v3 } from "../../shared/shapes";
import type { SugaWorld } from "./context";
import { groundY, LANE, pitchY, roadX, STAIRS, terraceY, WALL_X } from "./layout";
import { QuadBuilder } from "../gfx/geometry";

/** Flat ground piece (top at y) from a box so its edges are closed. */
function slabAt(w: SugaWorld, m: Material, x0: number, x1: number, z0: number, z1: number, y: number, t = 0.3, cast = false): void {
  const g = box(x1 - x0, t, z1 - z0);
  g.translate((x0 + x1) / 2, y - t / 2, (z0 + z1) / 2);
  w.mesh(g, m, 0, 0, 0, w.root, { cast });
}

/** A terraced lot: a solid block from the valley floor to `top` (its sides are retaining walls). */
export function lot(w: SugaWorld, wall: Material, topMat: Material, x0: number, x1: number, z0: number, z1: number, top: number, bottom = LANE.y - 0.3): void {
  const h = top - bottom;
  const sides = box(x1 - x0, h - 0.02, z1 - z0);
  sides.translate((x0 + x1) / 2, bottom + (h - 0.02) / 2, (z0 + z1) / 2);
  w.mesh(sides, wall, 0, 0, 0, w.root, { cast: true });
  slabAt(w, topMat, x0, x1, z0, z1, top, 0.04);
}

/** 止まれ as drivers read it: three characters side by side across the lane, stretched along it. */
function stopTexture() {
  const { c, g } = canvas(512, 512);
  g.clearRect(0, 0, 512, 512);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `900 150px ${JP_SANS}`;
  const chars = ["止", "ま", "れ"];
  chars.forEach((ch, i) => {
    g.save();
    g.translate(512 * ((i + 0.5) / 3), 256);
    g.scale(1, 3.1);
    g.fillText(ch, 0, 4);
    g.restore();
  });
  const t = toTexture(c);
  return t;
}

/**
 * Ground: the plateau street at the stair head, the lane in the hollow with
 * its gutters, edge lines and 止まれ, the five-way junction, 東福院坂 climbing
 * to the ridge, the terraced lots on both slopes and the left terrace with
 * its rubble retaining wall, cut-stone corner, coping and mesh fence.
 */
export function buildTerrain(w: SugaWorld): void {
  const lib = w.lib;
  const asphalt = lib.asphalt();
  const paint = lib.roadPaint();
  const concrete = lib.concrete([0.95, 0.94, 0.9]);
  const lotTop = lib.concrete([0.8, 0.79, 0.76]);
  const block = lib.block();
  const form = lib.formConcrete();
  const zb = STAIRS.bottomZ;

  // ---- plateau at the stair head (y = 0)
  slabAt(w, asphalt, -40, 40, 1.2, 6.2, 0);
  slabAt(w, lotTop, -40, 40, 6.2, 60, 0.02);
  // Paving between the curbs and the street beside the landing.
  slabAt(w, concrete, -2.3, -1.8, -0.1, 1.2, 0.01);
  for (const [x0, x1] of [
    [-40, -1.2],
    [1.2, 40],
  ] as const) {
    const line = box(x1 - x0, 0.004, 0.15);
    line.translate((x0 + x1) / 2, 0.002, 1.55);
    w.mesh(line, paint, 0, 0, 0, w.root, { cast: false });
  }

  // ---- the lane in the hollow
  const y = LANE.y;
  slabAt(w, asphalt, -LANE.half, LANE.half, LANE.junction.z0, zb + 0.02, y);
  // Gutters: concrete channels with steel gratings every 6 m.
  const grate = lib.paint(0x2a2b2c, 0.6);
  for (const s of [-1, 1]) {
    const x0 = s * LANE.half;
    const x1 = s * (LANE.half + 0.36);
    slabAt(w, concrete, Math.min(x0, x1), Math.max(x0, x1), LANE.junction.z0, zb - 0.3, y + 0.012);
    for (let z = zb - 2.5; z > LANE.junction.z0 + 1; z -= 6) {
      const gr = box(0.3, 0.02, 0.5);
      gr.translate(s * (LANE.half + 0.18), y + 0.015, z);
      w.mesh(gr, grate, 0, 0, 0, w.root, { cast: false });
    }
    // Edge line (路側帯).
    const line = box(0.15, 0.004, zb - 0.6 - (LANE.stopZ + 0.4));
    line.translate(s * 1.72, y + 0.003, (zb - 0.6 + LANE.stopZ + 0.4) / 2);
    w.mesh(line, paint, 0, 0, 0, w.root, { cast: false });
  }
  // Stop line and 止まれ before the junction.
  const stop = box(3.6, 0.004, 0.45);
  stop.translate(0, y + 0.003, LANE.stopZ);
  w.mesh(stop, paint, 0, 0, 0, w.root, { cast: false });
  const text = new PlaneGeometry(3.3, 3.3);
  text.rotateX(-Math.PI / 2);
  text.translate(0, y + 0.004, LANE.stopZ + 2.6);
  w.mesh(text, lib.roadText(stopTexture()), 0, 0, 0, w.root, { cast: false });

  // ---- junction and the roads leaving it
  const jz0 = LANE.junction.z0;
  const jz1 = LANE.junction.z1;
  slabAt(w, asphalt, -90, 90, jz1, jz0, y);
  // The fifth arm: a short lane leaving the junction toward the north-east.
  {
    const g = box(4.2, 0.3, 14);
    g.rotateY(Math.PI / 4);
    g.translate(9.5, y - 0.14, jz1 - 4.2);
    w.mesh(g, asphalt, 0, 0, 0, w.root, { cast: false });
  }
  // Valley floor lots (under houses and gardens).
  slabAt(w, lotTop, -160, -LANE.half - 0.36, jz0, -19.8, y + 0.005);
  slabAt(w, lotTop, LANE.half + 0.36, 160, jz0, zb, y + 0.005);

  // 東福院坂: a ribbon following the far slope, and the slope's ground grid.
  {
    const q = new QuadBuilder();
    const q2 = new QuadBuilder();
    const up = v3(0, 1, 0);
    for (let z = jz1; z > -430; z -= 5) {
      const z2 = z - 5;
      const y1 = groundY(z) + 0.02;
      const y2 = groundY(z2) + 0.02;
      const c1 = roadX(z);
      const c2 = roadX(z2);
      if (z > -240)
        q.quad([v3(c1 - 2.6, y1, z), v3(c1 + 2.6, y1, z), v3(c2 + 2.6, y2, z2), v3(c2 - 2.6, y2, z2)], up, [
          [c1 - 2.6, -z],
          [c1 + 2.6, -z],
          [c2 + 2.6, -z2],
          [c2 - 2.6, -z2],
        ]);
      for (const [x0, x1] of (z > -95
        ? [
            [-420, -2.6],
            [2.6, 420],
          ]
        : [[-420, 420]]) as [number, number][]) {
        q2.quad([v3(x0, y1 - 0.02, z), v3(x1, y1 - 0.02, z), v3(x1, y2 - 0.02, z2), v3(x0, y2 - 0.02, z2)], up, [
          [x0, -z],
          [x1, -z],
          [x1, -z2],
          [x0, -z2],
        ]);
      }
    }
    const road = q.build();
    road.computeVertexNormals();
    w.mesh(road, asphalt, 0, 0, 0, w.root, { cast: false });
    const g2 = q2.build();
    g2.computeVertexNormals();
    w.mesh(g2, lotTop, 0, 0, 0, w.root, { cast: false });
  }

  // ---- right slope: stepped lots down from the plateau
  const levels: [number, number, number][] = [
    [-4.6, 1.2, 0],
    [-10.6, -4.6, -2.3],
    [zb, -10.6, -5.2],
  ];
  for (const [z0, z1, top] of levels) lot(w, form, lotTop, 2.12, 60, z0, z1, top);

  // ---- left: the shrine terrace behind the stone wall
  buildTerrace(w);
  // Further left, lots stepping down beside the terrace.
  const leftLevels: [number, number, number][] = [
    [-6.5, 1.2, 0.2],
    [-13, -6.5, -2.2],
    [-19.8, -13, -4.6],
  ];
  for (const [z0, z1, top] of leftLevels) lot(w, block, lotTop, -60, -16, z0, z1, top);
}

/**
 * The terrace between the stairs and the shrine grounds: ground sloping from
 * 0.55 m above the stair head to 4 m above the lane, held by a battered
 * rubble wall along the flight and cut-stone blocks where it meets the lane,
 * topped with a concrete coping, galvanised posts and green wire mesh.
 */
function buildTerrace(w: SugaWorld): void {
  const lib = w.lib;
  const rubble = lib.rubble();
  const cut = lib.cutStone();
  const coping = lib.concrete([0.85, 0.84, 0.8]);
  const soil = lib.ground();
  const zb = STAIRS.bottomZ;
  const zCorner = -19.8;
  const xLane = -2.6;
  const batter = 0.18;
  const X0 = WALL_X;

  // Rubble face along the flight: base just under the curb, top at the terrace.
  {
    const q = new QuadBuilder();
    const n = v3(1, batter, 0).normalize();
    const steps = 24;
    const z0 = 1.2;
    const z1 = zb;
    for (let i = 0; i < steps; i++) {
      const za = z0 + ((z1 - z0) * i) / steps;
      const zc = z0 + ((z1 - z0) * (i + 1)) / steps;
      const ba = Math.max(pitchY(Math.min(za, 0)), LANE.y) - 0.3;
      const bc = Math.max(pitchY(Math.min(zc, 0)), LANE.y) - 0.3;
      const ta = terraceY(za);
      const tc = terraceY(zc);
      const xa = X0 - batter * (ta - ba);
      const xc = X0 - batter * (tc - bc);
      q.quad([v3(X0, ba, za), v3(X0, bc, zc), v3(xc, tc, zc), v3(xa, ta, za)], n, [
        [-za, ba],
        [-zc, bc],
        [-zc, tc],
        [-za, ta],
      ]);
    }
    w.mesh(q.build(), rubble, 0, 0, 0, w.root);
  }
  // Cut-stone foot: along the lane to the corner, then back west along the corner.
  {
    const q = new QuadBuilder();
    const top = terraceY(zb);
    const base = LANE.y - 0.05;
    // Short return where the wall steps out to the lane edge.
    q.quad([v3(X0, base, zb), v3(xLane, base, zb), v3(xLane, top, zb), v3(X0 - batter * (top - base), top, zb)], v3(0, 0, -1), [
      [X0, base],
      [xLane, base],
      [xLane, top],
      [X0, top],
    ]);
    const t2 = terraceY(zCorner);
    q.quad([v3(xLane, base, zb), v3(xLane, base, zCorner), v3(xLane, t2, zCorner), v3(xLane, top, zb)], v3(1, 0, 0), [
      [-zb, base],
      [-zCorner, base],
      [-zCorner, t2],
      [-zb, top],
    ]);
    q.quad([v3(xLane, base, zCorner), v3(-16, base, zCorner), v3(-16, t2, zCorner), v3(xLane, t2, zCorner)], v3(0, 0, -1), [
      [xLane, base],
      [-16, base],
      [-16, t2],
      [xLane, t2],
    ]);
    w.mesh(q.build(), cut, 0, 0, 0, w.root);
  }
  // Terrace ground and the coping along its edge.
  {
    const q = new QuadBuilder();
    const up = v3(0, 1, 0);
    const zs = [1.2, 0, -3, -6, -9, -12, -15, zb, -17.5, zCorner];
    for (let i = 0; i < zs.length - 1; i++) {
      const za = zs[i];
      const zc = zs[i + 1];
      const xa = za < zb ? xLane : X0 - batter * (terraceY(za) - Math.max(pitchY(Math.min(za, 0)), LANE.y) + 0.3);
      const xc = zc < zb + 0.01 ? xLane : X0 - batter * (terraceY(zc) - Math.max(pitchY(Math.min(zc, 0)), LANE.y) + 0.3);
      q.quad([v3(-16, terraceY(za), za), v3(xa, terraceY(za), za), v3(xc, terraceY(zc), zc), v3(-16, terraceY(zc), zc)], up, [
        [-16, -za],
        [xa, -za],
        [xc, -zc],
        [-16, -zc],
      ]);
    }
    const g = q.build();
    g.computeVertexNormals();
    w.mesh(g, soil, 0, 0, 0, w.root, { cast: false });
  }
  // Coping, fence posts, rails and mesh along the wall top.
  const path: Vector3[] = [];
  for (let z = 1.2; z > zb; z -= 1.0) {
    const b = Math.max(pitchY(Math.min(z, 0)), LANE.y) - 0.3;
    const t = terraceY(z);
    path.push(v3(X0 - batter * (t - b) - 0.12, t, z));
  }
  path.push(v3(xLane - 0.12, terraceY(zb), zb));
  path.push(v3(xLane - 0.12, terraceY(zCorner), zCorner + 0.12));
  path.push(v3(-16, terraceY(zCorner), zCorner + 0.12));
  const copes: BufferGeometry[] = [];
  const pipes: BufferGeometry[] = [];
  const mesh = new QuadBuilder();
  const meshTex = fenceMeshTexture();
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const len = a.distanceTo(b);
    const c = box(0.3, 0.12, len + 0.02);
    c.lookAt(new Vector3().subVectors(b, a));
    c.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.05, (a.z + b.z) / 2);
    copes.push(c);
  }
  // Fence: posts every ~2 m on the coping, top and bottom rails, mesh between.
  const fence: Vector3[] = [];
  for (let i = 0; i < path.length; i += 2) fence.push(path[i].clone().setY(path[i].y + 0.1));
  const last = path[path.length - 1];
  if (fence[fence.length - 1].distanceTo(last) > 0.5) fence.push(last.clone().setY(last.y + 0.1));
  const H = 1.25;
  let u = 0;
  for (let i = 0; i < fence.length; i++) {
    const p = fence[i];
    pipes.push(rod(p, p.clone().setY(p.y + H), 0.024, 8));
    const cap = new CylinderGeometry(0.03, 0.03, 0.03, 8);
    cap.translate(p.x, p.y + H + 0.01, p.z);
    pipes.push(cap);
    if (i === fence.length - 1) break;
    const n = fence[i + 1];
    pipes.push(rod(p.clone().setY(p.y + H - 0.03), n.clone().setY(n.y + H - 0.03), 0.02, 6));
    pipes.push(rod(p.clone().setY(p.y + 0.08), n.clone().setY(n.y + 0.08), 0.016, 6));
    const len = p.distanceTo(n);
    const dir = new Vector3().subVectors(n, p).setY(0).normalize();
    const normal = v3(dir.z, 0, -dir.x);
    mesh.quad([p.clone().setY(p.y + 0.08), n.clone().setY(n.y + 0.08), n.clone().setY(n.y + H - 0.03), p.clone().setY(p.y + H - 0.03)], normal, [
      [u / 0.5, 0.08 / 0.5],
      [(u + len) / 0.5, 0.08 / 0.5],
      [(u + len) / 0.5, (H - 0.03) / 0.5],
      [u / 0.5, (H - 0.03) / 0.5],
    ]);
    u += len;
  }
  w.mesh(merge(copes), coping, 0, 0, 0, w.root);
  w.mesh(merge(pipes), lib.paint(0x8f9597, 0.45), 0, 0, 0, w.root);
  w.mesh(mesh.build(), lib.cutout("fence-mesh", meshTex, { color: 0xffffff, rough: 0.5, metal: 0.2 }), 0, 0, 0, w.root, { cast: true });
}

/** Green PVC-coated diamond wire mesh (菱形金網), 50 mm pitch; one tile covers 0.5 m. */
function fenceMeshTexture() {
  const { c, g } = canvas(256, 256);
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = "#2f6a3c";
  g.lineWidth = 3.2;
  g.lineCap = "round";
  const n = 10;
  const s = 256 / n;
  for (let i = -n; i <= 2 * n; i++) {
    g.beginPath();
    g.moveTo(i * s, 0);
    g.lineTo(i * s + 256, 256);
    g.stroke();
    g.beginPath();
    g.moveTo(i * s, 256);
    g.lineTo(i * s + 256, 0);
    g.stroke();
  }
  // Highlights on the wire so it reads as round.
  g.strokeStyle = "rgba(150,200,150,0.55)";
  g.lineWidth = 1;
  for (let i = -n; i <= 2 * n; i++) {
    g.beginPath();
    g.moveTo(i * s - 0.8, 0);
    g.lineTo(i * s + 256 - 0.8, 256);
    g.stroke();
  }
  return toTexture(c, true);
}
