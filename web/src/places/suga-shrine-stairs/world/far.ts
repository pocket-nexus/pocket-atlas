import { BufferGeometry, CylinderGeometry, PlaneGeometry, RepeatWrapping, Vector3, type Material } from "three";
import { Rng } from "../../../core/random";
import { canvas, JP_SANS, toTexture } from "../../shared/canvas";
import { box } from "../../shared/geo";
import { merge, rod, v3 } from "../../shared/shapes";
import type { SugaWorld } from "./context";
import { bearing, groundY } from "./layout";

/** Apartment frontage, 4 bays × 2 floors (24 m × 5.8 m): balcony parapets, dark recesses, sliding doors, laundry. */
function apartmentTexture(seed: number, parapet: string, recess: string) {
  const { c, g } = canvas(512, 256);
  const r = new Rng(seed);
  const bw = 512 / 4;
  const fh = 128;
  for (let f = 0; f < 2; f++) {
    const y0 = f * fh;
    g.fillStyle = recess;
    g.fillRect(0, y0, 512, fh);
    for (let b = 0; b < 4; b++) {
      const x0 = b * bw;
      // Sliding door and window in the recess.
      g.fillStyle = r.chance(0.5) ? "#2a3038" : "#8e9398";
      g.fillRect(x0 + bw * 0.12, y0 + fh * 0.08, bw * 0.46, fh * 0.52);
      g.fillStyle = r.chance(0.6) ? "#262b31" : "#b5b3aa";
      g.fillRect(x0 + bw * 0.64, y0 + fh * 0.12, bw * 0.24, fh * 0.3);
      // Laundry and futons over the rail.
      if (r.chance(0.55)) {
        const n = r.int(1, 4);
        for (let i = 0; i < n; i++) {
          g.fillStyle = r.pick(["#f2f2ee", "#e8b7c0", "#9fb8d8", "#f1e7c8", "#ffffff", "#c9d7a8"]);
          g.fillRect(x0 + bw * r.range(0.08, 0.75), y0 + fh * 0.2, bw * r.range(0.08, 0.2), fh * r.range(0.25, 0.42));
        }
      }
      // Divider between units.
      g.fillStyle = "#c9c6bf";
      g.fillRect(x0, y0, bw * 0.04, fh);
    }
    // Parapet band (lower 40%) with its shadow line.
    g.fillStyle = parapet;
    g.fillRect(0, y0 + fh * 0.6, 512, fh * 0.4);
    g.fillStyle = "rgba(0,0,0,0.25)";
    g.fillRect(0, y0 + fh * 0.6, 512, fh * 0.04);
    g.fillStyle = "rgba(0,0,0,0.12)";
    g.fillRect(0, y0 + fh * 0.96, 512, fh * 0.04);
  }
  const t = toTexture(c, true);
  t.repeat.set(1 / 24, 1 / 5.8);
  return t;
}

/** Plain facade with small windows in a grid (3 m × 2.9 m cell). */
function sideTexture(wall: string) {
  const { c, g } = canvas(128, 128);
  g.fillStyle = wall;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#3a4048";
  g.fillRect(44, 38, 40, 44);
  g.fillStyle = "rgba(0,0,0,0.12)";
  g.fillRect(0, 124, 128, 4);
  const t = toTexture(c, true);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1 / 3, 1 / 2.9);
  return t;
}

/** Rooftop billboard: a fictional estate agent. */
function billboardTexture() {
  const { c, g } = canvas(512, 160);
  g.fillStyle = "#f4f1e8";
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = "#0b4ea2";
  g.fillRect(0, 0, 150, 160);
  g.fillStyle = "#fff";
  g.font = `900 70px ${JP_SANS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("四", 75, 82);
  g.fillStyle = "#0b3f85";
  g.font = `900 64px ${JP_SANS}`;
  g.fillText("四谷ハウジング", 330, 62);
  g.fillStyle = "#c8161d";
  g.font = `800 34px ${JP_SANS}`;
  g.fillText("賃貸・売買 0120-41-8800", 330, 122);
  return toTexture(c);
}

interface Block {
  x: number;
  z: number;
  len: number;
  depth: number;
  floors: number;
  yaw: number;
  front: Material;
  side: Material;
  roof: Material;
}

/**
 * Far field: the ridge of 6–10 storey apartment blocks about 300 m ahead
 * (balconies facing south, toward the stairs), a red-brown block with a
 * rooftop billboard, guyed rooftop radio masts, a thinner layer of taller
 * blocks behind, and the Ministry of Defense communications tower at
 * Ichigaya about 1 km away on the view line. Low-poly boxes with printed
 * facades; everything is static and batches into a handful of draws.
 */
export function buildFar(w: SugaWorld): void {
  const lib = w.lib;
  const r = new Rng(8080);
  const fronts = [
    lib.printed("apt-white", apartmentTexture(1, "#eeece6", "#6d6c68"), 0.7),
    lib.printed("apt-beige", apartmentTexture(2, "#e6dcc8", "#6a655c"), 0.7),
    lib.printed("apt-grey", apartmentTexture(3, "#d8dad8", "#5f6266"), 0.7),
  ];
  const brick = lib.printed("apt-brick", apartmentTexture(4, "#9a5a44", "#4a3a34"), 0.75);
  const sides = [lib.printed("side-white", sideTexture("#e4e1da"), 0.8), lib.printed("side-beige", sideTexture("#d9cdb6"), 0.8)];
  const brickSide = lib.printed("side-brick", sideTexture("#8e5341"), 0.8);
  const roof = lib.concrete([0.72, 0.72, 0.7], false);
  const steel = lib.paint(0x9aa0a4, 0.45);
  const white = lib.paint(0xe6e6e0, 0.4);
  const orange = lib.paint(0xe2621b, 0.4);
  const parts = new Map<Material, BufferGeometry[]>();
  const add = (m: Material, g: BufferGeometry) => {
    let l = parts.get(m);
    if (!l) parts.set(m, (l = []));
    l.push(g);
  };

  const blocks: Block[] = [];
  // The ridge line, ~270–380 m ahead.
  for (let x = -230; x < 230; ) {
    const len = r.range(22, 58);
    const z = -r.range(275, 330);
    blocks.push({ x: x + len / 2, z, len, depth: r.range(10, 14), floors: r.int(6, 10), yaw: r.range(-0.12, 0.12), front: r.pick(fronts), side: r.pick(sides), roof });
    x += len + r.range(4, 16);
  }
  // The red-brown block with the billboard, slightly right of the view line.
  blocks.push({ x: 38, z: -262, len: 30, depth: 13, floors: 8, yaw: 0.05, front: brick, side: brickSide, roof });
  // Taller blocks beyond the ridge.
  for (let i = 0; i < 26; i++) {
    const a = r.range(-0.9, 0.9);
    const d = r.range(420, 850);
    blocks.push({ x: Math.sin(a) * d, z: -Math.cos(a) * d, len: r.range(20, 45), depth: r.range(12, 18), floors: r.int(8, 15), yaw: r.range(-0.3, 0.3), front: r.pick(fronts), side: r.pick(sides), roof });
  }

  for (const [i, b] of blocks.entries()) {
    const base = groundY(b.z) - 0.5;
    const h = b.floors * 2.9 + 0.5;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const at = (lx: number, ly: number, lz: number) => v3(b.x + lx * c + lz * s, base + ly, b.z - lx * s + lz * c);
    const body = box(b.len, h, b.depth);
    body.rotateY(b.yaw);
    body.translate(b.x, base + h / 2, b.z);
    add(b.side, body);
    const front = new PlaneGeometry(b.len, h - 0.5);
    const uv = front.getAttribute("uv");
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * b.len, uv.getY(k) * (h - 0.5));
    front.translate(0, 0.5 + (h - 0.5) / 2, b.depth / 2 + 0.6);
    front.rotateY(b.yaw);
    front.translate(b.x, base, b.z);
    add(b.front, front);
    // Balcony slab edges read as white lines in the haze.
    const slabs = box(b.len, 0.12, 1.2);
    for (let f = 1; f < b.floors; f++) {
      const g = slabs.clone();
      g.translate(0, f * 2.9 + 0.5 - 0.06, b.depth / 2 + 0.6);
      g.rotateY(b.yaw);
      g.translate(b.x, base, b.z);
      add(white, g);
    }
    // Rooftop: a penthouse, a water tank, sometimes a guyed radio mast.
    const top = base + h;
    const ph = box(4, 2.6, 4);
    ph.translate(0, 1.3, 0);
    ph.rotateY(b.yaw);
    const pp = at(r.range(-b.len / 3, b.len / 3), h, 0);
    ph.translate(pp.x, pp.y, pp.z);
    add(b.side, ph);
    if (r.chance(0.6)) {
      const tank = new CylinderGeometry(1.1, 1.1, 2.2, 10);
      const tp = at(r.range(-b.len / 3, b.len / 3), h + 1.1, r.range(-2, 2));
      tank.translate(tp.x, tp.y, tp.z);
      add(steel, tank);
    }
    if ((i % 4 === 1 && b.z > -400) || b.front === brick) {
      const mp = at(r.range(-b.len / 3, b.len / 3), h, r.range(-2, 2));
      const mh = r.range(12, 22);
      add(steel, rod(mp, mp.clone().setY(top + mh), 0.12, 5));
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + b.yaw;
        const foot = mp.clone().add(v3(Math.cos(a) * 5, 0, Math.sin(a) * 5));
        add(steel, rod(foot, mp.clone().setY(top + mh * 0.8), 0.025, 3));
      }
      add(steel, rod(mp.clone().setY(top + mh * 0.9).add(v3(-0.8, 0, 0)), mp.clone().setY(top + mh * 0.9).add(v3(0.8, 0, 0)), 0.05, 4));
    }
    if (b.front === brick) {
      // Billboard frame and face, facing the stairs.
      const bw = 16;
      const bh = 5;
      const face = new PlaneGeometry(bw, bh);
      face.translate(0, h + 1.2 + bh / 2, b.depth / 2 - 1.5);
      face.rotateY(b.yaw);
      face.translate(b.x, base, b.z);
      add(lib.printed("billboard", billboardTexture(), 0.6), face);
      const frame = box(bw + 0.4, bh + 0.4, 0.3);
      frame.translate(0, h + 1.2 + bh / 2, b.depth / 2 - 1.7);
      frame.rotateY(b.yaw);
      frame.translate(b.x, base, b.z);
      add(steel, frame);
      for (const lx of [-bw / 3, 0, bw / 3]) add(steel, rod(at(lx, h, b.depth / 2 - 1.8), at(lx, h + 1.4, b.depth / 2 - 1.8), 0.12, 4));
    }
    const rf = box(b.len - 0.3, 0.06, b.depth - 0.3);
    rf.rotateY(b.yaw);
    rf.translate(b.x, top + 0.03, b.z);
    add(roof, rf);
  }

  buildTower(add, orange, white);
  for (const [m, gs] of parts) w.mesh(merge(gs), m, 0, 0, 0, w.root, { cast: false, receive: false });
}

/**
 * The steel lattice communications tower of the Ministry of Defense at
 * Ichigaya (about 220 m), bearing ~27° and ~1 km from the stair head. Four
 * tapering legs, a ring every 20 m, X-bracing on every face, painted in the
 * orange-and-white day marking bands.
 */
function buildTower(add: (m: Material, g: BufferGeometry) => void, orange: Material, white: Material): void {
  const dir = bearing(27);
  const c = dir.clone().multiplyScalar(1020).setY(groundY(-1000) - 2);
  const H = 196;
  const mast = 26;
  const half = (y: number) => 12 - (9.2 * y) / H;
  const band = (y: number) => (Math.floor((y / (H + mast)) * 7) % 2 === 0 ? orange : white);
  const corner = (y: number, i: number) => {
    const hw = half(y);
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sz = i < 2 ? -1 : 1;
    return c.clone().add(new Vector3(sx * hw, y, sz * hw));
  };
  const seg = 20;
  for (let y = 0; y < H; y += seg) {
    const y1 = Math.min(H, y + seg);
    const m = band((y + y1) / 2);
    for (let i = 0; i < 4; i++) {
      add(m, rod(corner(y, i), corner(y1, i), 0.9 - (0.5 * y) / H, 4));
      const j = (i + 1) % 4;
      add(m, rod(corner(y1, i), corner(y1, j), 0.35, 3));
      add(m, rod(corner(y, i), corner(y1, j), 0.25, 3));
      add(m, rod(corner(y, j), corner(y1, i), 0.25, 3));
    }
  }
  // Platforms and the top mast.
  for (const y of [120, 160, H]) {
    const g = new CylinderGeometry(half(y) * 1.5, half(y) * 1.5, 1.2, 8);
    g.translate(c.x, c.y + y, c.z);
    add(band(y), g);
  }
  for (let y = H; y < H + mast; y += 6.5) add(band(y + 3), rod(c.clone().setY(c.y + y), c.clone().setY(c.y + y + 6.5), 0.9, 6));
}
