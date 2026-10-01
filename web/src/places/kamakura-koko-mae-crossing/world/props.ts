import { BoxGeometry, BufferGeometry, CircleGeometry, CylinderGeometry, PlaneGeometry, SphereGeometry, Vector3, type BufferAttribute, type Material } from "three";
import { rod } from "../../shared/shapes";
import type { CellKey } from "../gfx/equip";
import { Bag, type KamakuraWorld } from "./context";
import { COAST, SECTION, slopeEdges, slopeY } from "./layout";
import { hillY } from "./terrain";
import { buildWires } from "./wires";

/**
 * Street furniture: the curve mirror on its orange pole at the west kerb
 * (a convex stainless face that reflects the captured environment), the
 * road signs on the slope and at the Route 134 mouth, the two city map
 * boards by the park corner, Route 134's street lamps, the signalised
 * pedestrian crossing west of the junction and the speed sign. Poles and
 * overhead lines are built by `wires.ts` (called from here).
 */

type Put = (g: BufferGeometry, cell: CellKey, cast?: boolean) => void;

function place(g: BufferGeometry, p: Vector3, yaw = 0): BufferGeometry {
  if (yaw) g.rotateY(yaw);
  g.translate(p.x, p.y, p.z);
  return g;
}

/** Planar UVs across a disc of radius r in the xy plane. */
function discUV(g: BufferGeometry, r: number): BufferGeometry {
  const pos = g.getAttribute("position");
  const uv = g.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / (2 * r) + 0.5, pos.getY(i) / (2 * r) + 0.5);
  return g;
}

/** Sidewalk height beside the slope road at `n` metres north (the kerb's top; the banks rise behind it). */
const kerb = (_x: number, n: number) => slopeY(n) + 0.15;

export function buildProps(w: KamakuraWorld): void {
  const E = w.equip;
  const lib = w.lib;
  const bag = new Bag();
  const put: Put = (g, cell, cast = true) => bag.add(E.material, E.map(g, cell), cast);
  const add = (m: Material, g: BufferGeometry, cast = true) => bag.add(m, g, cast);
  const facing = (yaw: number) => new Vector3(Math.sin(yaw), 0, Math.cos(yaw));

  // ------------------------------------------------------------ signs
  /**
   * A sign post (60 mm galvanised pipe with a cap) carrying plates from the
   * top down: round (r), square or triangular faces with a galvanised back
   * and two clamp bands.
   */
  type Plate = { cell: CellKey; shape: "disc" | "square" | "tri" | "rect"; w: number; h: number };
  const signPost = (base: Vector3, yaw: number, plates: Plate[], height = 2.6) => {
    put(rod(base.clone(), base.clone().setY(base.y + height + 0.05), 0.03, 8), "galv");
    put(place(new SphereGeometry(0.032, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2), base.clone().setY(base.y + height + 0.05)), "galv", false);
    const f = facing(yaw);
    let y = base.y + height;
    for (const pl of plates) {
      const c = base.clone().setY(y - pl.h / 2).addScaledVector(f, 0.05);
      if (pl.shape === "disc") {
        const r = pl.w / 2;
        put(place(discUV(new CircleGeometry(r, 26), r), c.clone().addScaledVector(f, 0.009), yaw), pl.cell, false);
        put(place(new CylinderGeometry(r, r, 0.016, 26).rotateX(Math.PI / 2), c, yaw), "signBack");
      } else if (pl.shape === "tri") {
        const g = new CircleGeometry(pl.w / Math.sqrt(3), 3, Math.PI / 2);
        const pos = g.getAttribute("position");
        const uv = g.getAttribute("uv") as BufferAttribute;
        for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / pl.w + 0.5, (pos.getY(i) + pl.w / Math.sqrt(3) / 2) / pl.h);
        g.translate(0, -pl.w / Math.sqrt(3) / 2 + pl.h / 2, 0);
        put(place(g, c.clone().addScaledVector(f, 0.009), yaw), pl.cell, false);
        const back = new CylinderGeometry(pl.w / Math.sqrt(3), pl.w / Math.sqrt(3), 0.016, 3);
        back.rotateX(Math.PI / 2);
        back.rotateZ(Math.PI);
        back.translate(0, -pl.w / Math.sqrt(3) / 2 + pl.h / 2, 0);
        put(place(back, c, yaw), "signBack");
      } else {
        put(place(new PlaneGeometry(pl.w, pl.h), c.clone().addScaledVector(f, 0.009), yaw), pl.cell, false);
        put(place(new BoxGeometry(pl.w, pl.h, 0.016), c, yaw), "signBack");
      }
      for (const dy of [pl.h * 0.25, -pl.h * 0.25]) put(place(new BoxGeometry(0.08, 0.035, 0.07), base.clone().setY(c.y + dy).addScaledVector(f, 0.025), yaw), "galv", false);
      y -= pl.h + 0.06;
    }
  };
  const disc = (cell: CellKey, d = 0.6): Plate => ({ cell, shape: "disc", w: d, h: d });
  const square = (cell: CellKey, s = 0.6): Plate => ({ cell, shape: "square", w: s, h: s });
  const NORTH = Math.PI;
  {
    // East kerb: the pedestrian-crossing sign above the zebra, no parking further up (and its twin facing up the slope).
    const [, e9] = slopeEdges(9.5);
    signPost(new Vector3(e9 - 0.45, kerb(e9 - 0.45, 9.5), -9.5), NORTH - 0.08, [square("pedCrossing")]);
    const [, e24] = slopeEdges(24);
    signPost(new Vector3(e24 - 0.4, kerb(e24 - 0.4, 24), -24), NORTH - 0.1, [disc("noParking")]);
    const [, e31] = slopeEdges(31);
    signPost(new Vector3(e31 - 0.35, kerb(e31 - 0.35, 31), -31), 0.1, [disc("noParking")], 2.3);
    // West kerb: the pedestrian-crossing sign facing down the slope, the triangular plate facing Route 134.
    const [w8] = slopeEdges(8.5);
    signPost(new Vector3(w8 - 0.3, kerb(w8 - 0.3, 8.5), -8.5), NORTH + 0.08, [square("pedCrossing")]);
    const [w7] = slopeEdges(6.6);
    signPost(new Vector3(w7 - 0.25, kerb(w7 - 0.25, 6.6), -6.6), 0.1, [{ cell: "triangle", shape: "tri", w: 0.75, h: 0.65 }], 2.75);
    // Route 134 mouth, west side: straight on only (for large vehicles), facing the coast road.
    signPost(new Vector3(-4.35, 0.21, 6.4), 0, [disc("straightOnly"), { cell: "truckPlate", shape: "rect", w: 0.6, h: 0.26 }], 2.7);
  }

  // ------------------------------------------------------------ curve mirror
  {
    const n = 12.6;
    const [wx] = slopeEdges(n);
    const base = new Vector3(wx - 0.45, kerb(wx - 0.45, n), -n);
    const pole = new CylinderGeometry(0.038, 0.038, 2.95, 10, 1, true);
    put(place(pole, base.clone().setY(base.y + 1.47)), "orange");
    put(place(new CylinderGeometry(0.05, 0.06, 0.12, 10), base.clone().setY(base.y + 0.06)), "orange");
    // 800 mm convex mirror facing down the slope and across the corner, orange rim and hood, clamp bracket.
    const yaw = Math.PI - 0.26;
    const f = facing(yaw);
    const c = base.clone().setY(base.y + 2.95 + 0.38).addScaledVector(f, 0.09);
    const R = 0.4;
    const face = new SphereGeometry(1.0, 24, 6, 0, Math.PI * 2, 0, Math.asin(R / 1.0));
    face.rotateX(Math.PI / 2);
    face.translate(0, 0, -Math.cos(Math.asin(R / 1.0)) + 0.02);
    add(lib.mirror(), place(face, c.clone(), yaw));
    const rim = new CylinderGeometry(R + 0.03, R + 0.03, 0.09, 28, 1, true);
    rim.rotateX(Math.PI / 2);
    put(place(rim, c.clone(), yaw), "orange");
    const lip = new CylinderGeometry(R + 0.03, R, 0.012, 28, 1, true);
    lip.rotateX(Math.PI / 2);
    put(place(lip, c.clone().addScaledVector(f, 0.05), yaw), "orange", false);
    const hood = new CylinderGeometry(R + 0.05, R + 0.04, 0.16, 20, 1, true, Math.PI - 1.2, 2.4);
    hood.rotateX(Math.PI / 2);
    hood.translate(0, 0, 0.08);
    put(place(hood, c.clone(), yaw), "orange");
    const back = new SphereGeometry(R + 0.03, 20, 3, 0, Math.PI * 2, 0, 0.5);
    back.rotateX(-Math.PI / 2);
    back.scale(1, 1, 0.25);
    put(place(back, c.clone().addScaledVector(f, -0.04), yaw), "orange");
    put(rod(base.clone().setY(c.y), c.clone().addScaledVector(f, -0.08), 0.03, 6), "galv", false);
    for (const dy of [-0.12, 0.12]) put(place(new BoxGeometry(0.1, 0.04, 0.1), base.clone().setY(c.y + dy)), "galv", false);
  }

  // ------------------------------------------------------------ city map boards by the park corner
  for (const [cell, n] of [
    ["map1", 14.4],
    ["map2", 16.2],
  ] as [CellKey, number][]) {
    const [xw] = slopeEdges(n);
    const x = xw - 1.9;
    const y = hillY(x, -n);
    const yaw = 2.45;
    const f = facing(yaw);
    const p = new Vector3(x, y + 1.35, -n);
    put(place(new PlaneGeometry(0.9, 1.12), p.clone().addScaledVector(f, 0.031), yaw), cell, false);
    put(place(new BoxGeometry(0.98, 1.2, 0.05), p.clone(), yaw), "black");
    put(place(new BoxGeometry(1.06, 0.06, 0.14), p.clone().add(new Vector3(0, 0.63, 0)).addScaledVector(f, 0.03), yaw), "black");
    for (const s of [-0.5, 0.5]) {
      const lp = p.clone().add(new Vector3(Math.cos(yaw) * s, 0, -Math.sin(yaw) * s));
      put(rod(lp.clone().setY(y - 0.1), lp.clone().setY(y + 2.0), 0.035, 6), "black");
    }
  }

  // ------------------------------------------------------------ Route 134: street lamps, signals, speed sign
  for (let u = -156; u <= 264; u += 42) {
    const base = COAST.offset(u, 17.6, new Vector3()).setY(0.21);
    const t = COAST.tangent(u, new Vector3());
    const n = new Vector3(-t.z, 0, t.x);
    put(rod(base, base.clone().setY(8.6), 0.085, 10, 0.06), "galv");
    put(place(new CylinderGeometry(0.14, 0.16, 0.5, 10), base.clone().setY(0.46)), "galv");
    const tip = base.clone().setY(8.75).addScaledVector(n, -1.7);
    put(rod(base.clone().setY(8.5), tip, 0.04, 6), "galv", false);
    const head = new BoxGeometry(0.68, 0.1, 0.3);
    head.rotateY(Math.atan2(t.x, t.z));
    put(head.translate(tip.x, tip.y - 0.04, tip.z), "galv");
  }
  const green = lib.glow(0x2bff9a, 3);
  const red = lib.glow(0xff2a1a, 3);
  {
    const u = -13.6;
    const s = 17.55;
    const armTo = SECTION.lanes.west - 0.5;
    const base = COAST.offset(u, s, new Vector3()).setY(0.21);
    put(rod(base, base.clone().setY(5.6), 0.09, 10, 0.075), "galv");
    const arm = COAST.offset(u, armTo, new Vector3()).setY(5.4);
    put(rod(base.clone().setY(5.4), arm, 0.05, 6), "galv", false);
    // Horizontal three-light vehicle signal (green lit) with its visor plate, facing approaching traffic.
    const t = COAST.tangent(u, new Vector3());
    const yaw = Math.atan2(t.x, t.z);
    const hc = arm.clone().setY(5.65);
    put(place(new BoxGeometry(1.25, 0.42, 0.22), hc.clone(), yaw + Math.PI / 2), "black");
    put(place(new BoxGeometry(1.45, 0.62, 0.02), hc.clone().addScaledVector(t, -0.13), yaw + Math.PI / 2), "black");
    const side = new Vector3(-t.z, 0, t.x);
    [-0.4, 0, 0.4].forEach((o, i) => {
      const lp = hc.clone().addScaledVector(t, 0.115).addScaledVector(side, o);
      const lens = new CircleGeometry(0.13, 14);
      lens.rotateY(yaw);
      if (i === 2) add(green, lens.translate(lp.x, lp.y, lp.z), false);
      else put(lens.translate(lp.x, lp.y, lp.z), "blackMatte", false);
      const hood = new CylinderGeometry(0.15, 0.15, 0.18, 12, 1, true, Math.PI - 1.3, 2.6);
      hood.rotateX(Math.PI / 2);
      hood.translate(0, 0, 0.09);
      put(place(hood, lp.clone(), yaw), "black", false);
    });
    // Pedestrian signal at the kerb, red.
    const pp = base.clone().setY(2.8);
    put(place(new BoxGeometry(0.32, 0.62, 0.22), pp.clone()), "black");
    const pl = new PlaneGeometry(0.24, 0.24);
    pl.rotateY(Math.PI);
    add(red, pl.translate(pp.x, pp.y + 0.13, pp.z - 0.115), false);
  }
  {
    const base = COAST.offset(36, 17.7, new Vector3()).setY(0.21);
    const t = COAST.tangent(36, new Vector3());
    signPost(base, Math.atan2(-t.x, -t.z), [disc("speed50")], 2.4);
  }

  bag.emit(w);
  buildWires(w);
}
