import { BufferGeometry, CylinderGeometry, Float32BufferAttribute, PlaneGeometry, Quaternion, SphereGeometry, TorusGeometry, Vector3 } from "three";
import { mapUV } from "../../../shared/atlas";
import { parkingSign, stopSign } from "../../gfx/canvas";
import { box } from "../../../shared/geo";
import type { World } from "../context";
import { L } from "../layout";
import { hazardStripes } from "./poles";
import { palette, rod, v3, type Kit } from "./util";

const UP = new Vector3(0, 1, 0);

/** Inverted-triangle sign face in the xy-plane facing +z, UVs following the stopSign() canvas. */
function triangle(side: number, facing: 1 | -1): BufferGeometry {
  const h = side * 0.866;
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([-side / 2, h / 3, 0, side / 2, h / 3, 0, 0, (-2 * h) / 3, 0], 3));
  g.setAttribute("normal", new Float32BufferAttribute([0, 0, facing, 0, 0, facing, 0, 0, facing], 3));
  g.setAttribute("uv", new Float32BufferAttribute([0.02, 0.92, 0.98, 0.92, 0.5, 0.08], 2));
  g.setIndex(facing > 0 ? [0, 2, 1] : [0, 1, 2]);
  return g;
}

/**
 * Stop sign (止まれ) for southbound traffic on the cross street, on its own
 * galvanised post. The face points north (−z), toward approaching drivers.
 */
export function buildStopSign(w: World, kit: Kit): void {
  const lib = w.lib;
  const x = L.crossWest - 0.2;
  const z = -4.6;
  const P = palette(lib);
  const post = P.galv;
  w.mesh(new CylinderGeometry(0.03, 0.03, 2.95, 10), post, x, 1.475, z, w.root);
  w.mesh(new CylinderGeometry(0.035, 0.035, 0.02, 10), post, x, 2.955, z, w.root, { cast: false });
  const cell = kit.draw("stop", 192, 192, (g, cw, ch) => g.drawImage(stopSign(), 0, 0, cw, ch));
  const face = mapUV(triangle(0.8, 1), cell);
  face.rotateY(Math.PI);
  w.mesh(face, kit.labels, x, 2.45, z - 0.045, w.root, { cast: false });
  const back = triangle(0.8, -1);
  back.rotateY(Math.PI);
  w.mesh(back, P.gray, x, 2.45, z - 0.04, w.root);
  for (const y of [2.62, 2.2]) w.mesh(box(0.1, 0.05, 0.05), post, x, y, z - 0.02, w.root, { cast: false });
}

/**
 * Curve mirror (カーブミラー) at the south-east corner of the intersection:
 * two convex heads on one orange post, facing the blind konbini corner.
 */
export function buildMirror(w: World): void {
  const lib = w.lib;
  const P = palette(lib);
  const orange = P.orange;
  const x = L.crossEast + 0.3;
  const z = L.mainSouth - 0.32;
  const top = 3.35;
  w.mesh(new CylinderGeometry(0.04, 0.04, top, 12), orange, x, top / 2, z, w.root);
  w.mesh(new SphereGeometry(0.045, 10, 6), orange, x, top, z, w.root, { cast: false });
  const heads: [Vector3, number][] = [
    [v3(-0.63, -0.06, -0.77), -0.36],
    [v3(-0.97, -0.06, 0.22), 0.36],
  ];
  const R = 0.32;
  const cap = 0.42;
  const sphR = R / Math.sin(cap);
  for (const [dir, off] of heads) {
    const n = dir.clone().normalize();
    const side = v3(-n.z, 0, n.x).normalize();
    const c = v3(x, 2.95, z).addScaledVector(side, off).addScaledVector(n, 0.08);
    const q = new Quaternion().setFromUnitVectors(UP, n);
    // Convex mirror: shallow spherical cap bulging toward the viewer.
    const mirror = new SphereGeometry(sphR, 28, 6, 0, Math.PI * 2, 0, cap);
    mirror.translate(0, -sphR * Math.cos(cap), 0);
    mirror.applyQuaternion(q);
    w.mesh(mirror, P.chrome, c.x, c.y, c.z, w.root, { cast: false });
    // Back shell and rim.
    const shell = new SphereGeometry(sphR * 0.9, 24, 5, 0, Math.PI * 2, 0, cap * 1.1);
    shell.translate(0, -sphR * 0.9 * Math.cos(cap * 1.1), 0);
    shell.applyQuaternion(new Quaternion().setFromUnitVectors(UP, n.clone().negate()));
    w.mesh(shell, orange, c.x, c.y, c.z, w.root);
    const rim = new TorusGeometry(R + 0.012, 0.028, 8, 36);
    rim.applyQuaternion(new Quaternion().setFromUnitVectors(v3(0, 0, 1), n));
    w.mesh(rim, orange, c.x, c.y, c.z, w.root);
    // Bracket back to the post.
    const back = c.clone().addScaledVector(n, -0.07);
    w.mesh(rod(back, v3(x, 2.95, z), 0.022, 6), orange, 0, 0, 0, w.root);
  }
  // Mirror number plate on the post.
  w.mesh(box(0.08, 0.18, 0.012), P.white, x - 0.03, 2.2, z - 0.035, w.root, { cast: false, ry: -0.4 });
}

/**
 * Coin parking (コインパーキング) on the north-east corner: four bays off the
 * cross street and one off the main street, flap locks, wheel stops, a pay
 * station and the lit yellow "P" on a post.
 */
export function buildParking(w: World, kit: Kit): { bays: { x: number; z: number; ry: number }[] } {
  const lib = w.lib;
  const x0 = L.crossEast;
  const x1 = 22;
  const z0 = -12;
  const z1 = L.mainNorth;
  const root = w.group();
  root.name = "parking";

  // Surface.
  const flat = (ax: number, bx: number, az: number, bz: number, y: number) => {
    const p = new PlaneGeometry(bx - ax, bz - az);
    p.rotateX(-Math.PI / 2);
    p.translate((ax + bx) / 2, y, (az + bz) / 2);
    return p;
  };
  w.mesh(flat(x0, x1, z0, z1, 0.0015), lib.road(), 0, 0, 0, root, { cast: false });
  const paint = lib.roadPaint();
  const line = (ax: number, bx: number, az: number, bz: number) => w.mesh(flat(ax, bx, az, bz, 0.006), paint, 0, 0, 0, root, { cast: false });

  const bays: { x: number; z: number; ry: number }[] = [];
  const bx0 = 13.4;
  const bx1 = 18.4;
  const zs = [-1.4, -3.9, -6.4, -8.9, -11.4];
  for (const zz of zs) line(bx0, bx1, zz - 0.05, zz + 0.05);
  line(bx1 - 0.05, bx1 + 0.05, -11.4, -1.4);
  for (let i = 0; i < 4; i++) bays.push({ x: (bx0 + bx1) / 2, z: (zs[i] + zs[i + 1]) / 2, ry: Math.PI });
  // East bay off the main street.
  line(19.2 - 0.05, 19.2 + 0.05, -6.4, -1.4);
  line(21.7 - 0.05, 21.7 + 0.05, -6.4, -1.4);
  line(19.2, 21.7, -6.45, -6.35);
  bays.push({ x: 20.45, z: -3.9, ry: -Math.PI / 2 });

  // Flap locks (ロック板) and wheel stops.
  const P = palette(lib);
  const lockBase = P.dark;
  const stripe = kit.draw("stripe", 128, 176, (g, cw, ch) => hazardStripes(g, cw, ch, cw / 4));
  const wheelStop = P.yellow;
  bays.forEach((b, i) => {
    const alongX = Math.abs(Math.cos(b.ry)) > 0.5;
    const g = w.group(b.x, 0, b.z, alongX ? 0 : Math.PI / 2, root);
    w.mesh(box(0.34, 0.06, 0.9), lockBase, 0, 0.03, 0, g);
    const plate = new PlaneGeometry(0.3, 0.84);
    plate.rotateX(-Math.PI / 2);
    mapUV(plate, stripe);
    w.mesh(plate, kit.labels, 0, 0.061, 0, g, { cast: false });
    // Wheel stops at the back of the bay (cars reverse in).
    const back = i < 4 ? 1.8 : 2.0;
    for (const s of [-0.55, 0.55]) w.mesh(box(0.14, 0.1, 0.5), wheelStop, back, 0.05, s, g);
    // Bay number plate on the back line.
    const num = kit.draw(`bay${i}`, 64, 64, (c, cw, ch) => {
      c.fillStyle = "#f4f4ef";
      c.fillRect(0, 0, cw, ch);
      c.fillStyle = "#1a1a1a";
      c.font = `900 ${ch * 0.78}px "Helvetica Neue", Arial, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(i + 1), cw / 2, ch * 0.54);
    });
    const sign = mapUV(planeZ(0.22, 0.22), num);
    sign.rotateY(-Math.PI / 2);
    w.mesh(sign, kit.labels, back + 0.3, 0.32, 0, g, { cast: false });
    w.mesh(box(0.04, 0.26, 0.26), lockBase, back + 0.325, 0.32, 0, g);
    w.mesh(box(0.04, 0.2, 0.04), lockBase, back + 0.33, 0.1, 0, g);
  });

  // Block walls on the back and east boundaries.
  const block = lib.concrete([0.5, 0.5, 0.48]);
  w.mesh(box(x1 - x0 - 0.3, 1.3, 0.14), block, (x0 + 0.3 + x1) / 2, 0.65, z0 + 0.07, root);
  w.mesh(box(0.14, 1.3, z1 - z0 - 0.6), block, x1 - 0.07, 0.65, (z0 + z1 - 0.6) / 2, root);

  // Pay station (精算機) with a rain hood and a lit screen.
  const pay = w.group(18.8, 0, -1.55, 0, root);
  w.mesh(box(0.52, 1.32, 0.42), P.white, 0, 0.66, 0, pay);
  w.mesh(box(0.54, 0.16, 0.44), P.yellow, 0, 1.24, 0, pay);
  w.mesh(box(0.66, 0.04, 0.6), P.dark, 0, 1.44, 0.04, pay);
  w.mesh(box(0.04, 0.12, 0.04), P.dark, 0.28, 1.38, -0.22, pay, { cast: false });
  w.mesh(box(0.04, 0.12, 0.04), P.dark, -0.28, 1.38, -0.22, pay, { cast: false });
  const face = kit.draw("paystation", 128, 192, (c, cw, ch) => {
    c.fillStyle = "#e8e4d6";
    c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#1a1a1a";
    c.fillRect(cw * 0.1, ch * 0.06, cw * 0.8, ch * 0.3);
    c.fillStyle = "#8fe0ff";
    c.fillRect(cw * 0.14, ch * 0.09, cw * 0.72, ch * 0.24);
    c.fillStyle = "#0a2a3a";
    c.font = `800 ${ch * 0.07}px "Hiragino Sans", sans-serif`;
    c.textAlign = "center";
    c.fillText("駐車番号を", cw / 2, ch * 0.18);
    c.fillText("押してください", cw / 2, ch * 0.27);
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 3; k++) {
        c.fillStyle = "#4a4d52";
        c.fillRect(cw * (0.2 + k * 0.22), ch * (0.42 + r * 0.07), cw * 0.16, ch * 0.05);
      }
    c.fillStyle = "#1a1a1a";
    c.fillRect(cw * 0.3, ch * 0.74, cw * 0.4, ch * 0.03);
    c.fillStyle = "#d8201a";
    c.fillRect(cw * 0.1, ch * 0.84, cw * 0.8, ch * 0.1);
    c.fillStyle = "#fff";
    c.font = `800 ${ch * 0.06}px "Hiragino Sans", sans-serif`;
    c.fillText("精算機", cw / 2, ch * 0.91);
  });
  w.mesh(mapUV(planeZ(0.44, 0.66), face), kit.labels, 0, 0.82, 0.212, pay, { cast: false });
  w.mesh(box(0.3, 0.14, 0.01), P.screen, 0, 1.02, 0.214, pay, { cast: false });

  // The lit "P" sign: a double-sided light box on a post facing the cross street.
  // Back corner of the lot, clear of every bay, facing the cross street.
  const px = x0 + 0.35;
  const pz = -11.66;
  const post = P.dark;
  w.mesh(new CylinderGeometry(0.055, 0.06, 4.4, 10), post, px, 2.2, pz, root);
  w.mesh(box(0.2, 1.22, 0.84), post, px, 3.8, pz, root);
  const pcell = kit.draw("parking", 192, 288, (g, cw, ch) => g.drawImage(parkingSign(), 0, 0, cw, ch));
  for (const s of [1, -1]) {
    const f = mapUV(planeZ(0.78, 1.17), pcell);
    f.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
    w.mesh(f, kit.lit, px + s * 0.101, 3.8, pz, root, { cast: false });
  }
  w.fog(new Vector3(px, 3.8, pz), 0xffd24a, 0.45, 0.8);

  return { bays };
}

/** Plane facing +z with 0..1 UVs (atlas-ready). */
function planeZ(wd: number, ht: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([-wd / 2, -ht / 2, 0, wd / 2, -ht / 2, 0, wd / 2, ht / 2, 0, -wd / 2, ht / 2, 0], 3));
  g.setAttribute("normal", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
