import { BufferGeometry, CatmullRomCurve3, Float32BufferAttribute, Matrix4, Quaternion, Vector3, type Material } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Rng } from "../../../core/random";
import { canvas, toTexture, type Ctx } from "../../shared/canvas";
import type { SugaWorld } from "./context";
import { terraceY, WALL_X } from "./layout";

/** Tapered tube along a smooth curve; UVs in metres (u around, v along). */
function limb(pts: Vector3[], r0: number, r1: number, radial: number, perMeter = 3): BufferGeometry {
  const curve = new CatmullRomCurve3(pts, false, "centripetal");
  const len = curve.getLength();
  const segs = Math.max(3, Math.ceil(len * perMeter));
  const frames = curve.computeFrenetFrames(segs, false);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = curve.getPointAt(t);
    const r = r0 + (r1 - r0) * Math.pow(t, 0.8);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const n = N.clone().multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
      nor.push(n.x, n.y, n.z);
      uv.push((j / radial) * 2 * Math.PI * Math.max(r, 0.05), t * len);
    }
  }
  for (let i = 0; i < segs; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** One serrated cherry leaf, base at the origin pointing along −y. */
function leaf(g: Ctx, len: number, hue: number, light: number, under: boolean): void {
  const w = len * 0.46;
  const pts: [number, number][] = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Obovate outline with an acuminate tip.
    const half = w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.9) * (1 - 0.35 * Math.pow(t, 6));
    const saw = i > 1 && i < n - 1 ? (i % 2 ? 0.94 : 1.0) : 1;
    pts.push([half * saw, -t * len]);
  }
  g.beginPath();
  g.moveTo(0, 0);
  for (const [x, y] of pts) g.lineTo(x, y);
  for (let i = pts.length - 1; i >= 0; i--) g.lineTo(-pts[i][0], pts[i][1]);
  g.closePath();
  const sat = under ? 22 : 42;
  const l = under ? light + 14 : light;
  const grd = g.createLinearGradient(-w, 0, w, -len);
  grd.addColorStop(0, `hsl(${hue},${sat}%,${l - 5}%)`);
  grd.addColorStop(0.55, `hsl(${hue + 4},${sat + 6}%,${l + 4}%)`);
  grd.addColorStop(1, `hsl(${hue - 3},${sat}%,${l - 2}%)`);
  g.fillStyle = grd;
  g.fill();
  g.strokeStyle = `hsla(${hue},30%,${l + 18}%,0.55)`;
  g.lineWidth = Math.max(1, len * 0.02);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -len * 0.92);
  g.stroke();
  g.strokeStyle = `hsla(${hue},30%,${l + 10}%,0.3)`;
  g.lineWidth = Math.max(0.6, len * 0.01);
  for (let i = 1; i < 6; i++) {
    const y = -len * (0.12 + i * 0.13);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(s * w * 0.75, y - len * 0.1);
      g.stroke();
    }
  }
}

/**
 * Leaf atlas, 2×2 cells of 512 px: three sprays of cherry leaves on twigs
 * (dense, medium, sun-yellowed) and a cell of small shrub leaves.
 */
function leafAtlas(): HTMLCanvasElement {
  const { c, g } = canvas(1024, 1024);
  g.clearRect(0, 0, 1024, 1024);
  const r = new Rng(77);
  const spray = (ox: number, oy: number, count: number, hue: number, light: number) => {
    const cx = ox + 256;
    const cy = oy + 256;
    // Twigs radiating from the lower middle.
    const twigs: [number, number, number][] = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.5 + r.range(-0.15, 0.15);
      twigs.push([a, r.range(150, 230), r.range(2, 4)]);
    }
    g.lineCap = "round";
    for (const [a, len, wdt] of twigs) {
      g.strokeStyle = "#4a3326";
      g.lineWidth = wdt;
      g.beginPath();
      g.moveTo(cx, cy + 190);
      g.quadraticCurveTo(cx + Math.cos(a) * len * 0.5, cy + 190 + Math.sin(a) * len * 0.6, cx + Math.cos(a) * len, cy + 170 + Math.sin(a) * len);
      g.stroke();
    }
    for (let i = 0; i < count; i++) {
      const [a, len] = twigs[i % twigs.length];
      const t = r.range(0.25, 1.0);
      const px = cx + Math.cos(a) * len * t + r.range(-40, 40);
      const py = cy + 180 + Math.sin(a) * len * t + r.range(-40, 30);
      g.save();
      g.translate(px, py);
      g.rotate(a + Math.PI / 2 + r.range(-1.1, 1.1));
      leaf(g, r.range(62, 96), hue + r.range(-6, 6), light + r.range(-6, 6), r.chance(0.18));
      g.restore();
    }
  };
  spray(0, 0, 58, 102, 30);
  spray(512, 0, 44, 98, 33);
  spray(0, 512, 50, 86, 38);
  // Shrub cell: small glossy oval leaves (azalea, boxwood) packed densely.
  for (let i = 0; i < 260; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * 220;
    g.save();
    g.translate(768 + Math.cos(a) * d, 768 + Math.sin(a) * d * 0.9);
    g.rotate(r.range(0, Math.PI * 2));
    const len = r.range(22, 38);
    g.fillStyle = `hsl(${r.range(90, 110)},${r.range(38, 52)}%,${r.range(20, 34)}%)`;
    g.beginPath();
    g.ellipse(0, -len / 2, len * 0.32, len / 2, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  return c;
}

const leafMats = new WeakMap<SugaWorld, Material>();

/** The shared alpha-tested leaf material (cherry sprays and shrub leaves in one atlas). */
function leafMaterial(w: SugaWorld): Material {
  let m = leafMats.get(w);
  if (!m) {
    const tex = toTexture(leafAtlas());
    const mat = w.lib.cutout("cherry-leaves", tex, { rough: 0.55 });
    // Light through the leaves: a faint emission of the leaf colour, so shaded
    // and backlit cards read as translucent green rather than grey.
    mat.emissive.setRGB(0.55, 0.75, 0.3);
    mat.emissiveMap = tex;
    mat.emissiveIntensity = 0.1;
    m = mat;
    leafMats.set(w, m);
  }
  return m;
}

/** Leaf clumps for pots and hedges, batched into one mesh per call site. */
export function foliage(w: SugaWorld) {
  return {
    begin: (): Cards => ({ pos: [], nor: [], uv: [], idx: [] }),
    clump: (c: Cards, r: Rng, at: Vector3, radius: number, count: number) =>
      cluster(c, r, at, at.clone().setY(at.y - radius * 0.6), new Vector3(radius, radius, radius), radius * 0.6, count, 3, radius * 1.1),
    end: (c: Cards) => {
      if (c.idx.length) w.mesh(cardsGeometry(c), leafMaterial(w), 0, 0, 0, w.root);
    },
  };
}

export interface Cards {
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
}

/**
 * A cluster of leaf cards around `c`: cards face away from the crown centre
 * and carry normals blended toward the crown's outward direction, so the
 * canopy shades as a volume rather than as flat cards.
 */
function cluster(out: Cards, r: Rng, c: Vector3, crown: Vector3, crownR: Vector3, radius: number, count: number, cell: number, size: number): void {
  const u0 = (cell % 2) * 0.5;
  const v0 = cell < 2 ? 0.5 : 0;
  const q = new Quaternion();
  const m = new Matrix4();
  for (let i = 0; i < count; i++) {
    const p = c.clone().add(new Vector3(r.range(-1, 1), r.range(-0.6, 0.8), r.range(-1, 1)).multiplyScalar(radius));
    const outward = p.clone().sub(crown).divide(crownR).normalize();
    // Card normal: mostly outward and up, with scatter.
    const n = outward.clone().multiplyScalar(0.6).add(new Vector3(r.range(-0.6, 0.6), r.range(0.1, 0.9), r.range(-0.6, 0.6))).normalize();
    q.setFromUnitVectors(new Vector3(0, 0, 1), n);
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), r.range(0, Math.PI * 2)));
    const s = size * r.range(0.8, 1.2);
    m.compose(p, q, new Vector3(s, s, s));
    const base = out.pos.length / 3;
    const corners = [
      [-0.5, -0.5, 0, 0],
      [0.5, -0.5, 1, 0],
      [0.5, 0.5, 1, 1],
      [-0.5, 0.5, 0, 1],
    ];
    const sn = n.clone().multiplyScalar(0.35).add(outward.clone().multiplyScalar(0.65)).normalize();
    for (const [x, y, u, v] of corners) {
      const w = new Vector3(x, y, 0).applyMatrix4(m);
      out.pos.push(w.x, w.y, w.z);
      out.nor.push(sn.x, sn.y, sn.z);
      out.uv.push(u0 + u * 0.5, v0 + v * 0.5);
    }
    out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function cardsGeometry(c: Cards): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(c.pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(c.nor, 3));
  g.setAttribute("uv", new Float32BufferAttribute(c.uv, 2));
  g.setIndex(c.idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * The large Somei-yoshino cherry on the terrace above the left of the flight,
 * in full summer leaf: a short leaning trunk, five spreading limbs arching
 * over the stairs and the fence, secondary branches, about two thousand
 * alpha-tested leaf cards, and shrubs along the terrace edge.
 */
export function buildTree(w: SugaWorld): void {
  const lib = w.lib;
  const r = new Rng(3108);
  const bark = lib.bark();
  const leaves = leafMaterial(w);
  const cards: Cards = { pos: [], nor: [], uv: [], idx: [] };
  const woods: BufferGeometry[] = [];

  const baseZ = -3.3;
  const base = new Vector3(-4.7, terraceY(baseZ) - 0.1, baseZ);
  const trunkTop = base.clone().add(new Vector3(0.5, 2.6, -0.2));
  woods.push(limb([base, base.clone().add(new Vector3(0.12, 1.2, -0.05)), trunkTop], 0.34, 0.24, 12, 4));
  // Root flare.
  woods.push(limb([base.clone().add(new Vector3(-0.3, -0.1, 0.2)), base.clone().add(new Vector3(0.05, 0.5, 0))], 0.28, 0.2, 10, 4));

  const crown = new Vector3(-2.4, 5.2, -3.6);
  const crownR = new Vector3(5.2, 2.4, 5.0);
  const limbs = [
    { az: 0.15, len: 5.6, rise: 2.2 },
    { az: -0.55, len: 6.2, rise: 2.8 },
    { az: 0.85, len: 5.4, rise: 2.2 },
    { az: 2.3, len: 4.6, rise: 2.6 },
    { az: -2.2, len: 4.2, rise: 3.0 },
    { az: 3.1, len: 3.8, rise: 2.4 },
  ];
  for (const L of limbs) {
    // az measured from +x (over the stairs), counter-clockwise seen from above (toward −z).
    const dir = new Vector3(Math.cos(L.az), 0, -Math.sin(L.az));
    const p0 = trunkTop.clone();
    const p1 = p0.clone().addScaledVector(dir, L.len * 0.3).add(new Vector3(0, L.rise * 0.6, 0));
    const p2 = p0.clone().addScaledVector(dir, L.len * 0.65).add(new Vector3(r.range(-0.3, 0.3), L.rise, r.range(-0.3, 0.3)));
    const p3 = p0.clone().addScaledVector(dir, L.len).add(new Vector3(0, L.rise * 0.8, 0));
    const pts = [p0, p1, p2, p3];
    woods.push(limb(pts, 0.17, 0.05, 9, 3));
    const curve = new CatmullRomCurve3(pts, false, "centripetal");
    // Secondary branches with leaf clusters toward their ends.
    const nb = 6 + r.int(0, 3);
    for (let i = 0; i < nb; i++) {
      const t = 0.3 + (0.7 * (i + r.next() * 0.6)) / nb;
      const s0 = curve.getPointAt(Math.min(1, t));
      const tan = curve.getTangentAt(Math.min(1, t));
      const side = new Vector3().crossVectors(tan, new Vector3(0, 1, 0)).normalize().multiplyScalar(i % 2 ? 1 : -1);
      const bd = tan.clone().multiplyScalar(0.5).add(side.multiplyScalar(0.8)).add(new Vector3(0, r.range(0.1, 0.6), 0)).normalize();
      const blen = r.range(1.3, 2.6) * (1.1 - t * 0.4);
      const s1 = s0.clone().addScaledVector(bd, blen * 0.5).add(new Vector3(0, 0.15, 0));
      const s2 = s0.clone().addScaledVector(bd, blen).add(new Vector3(0, -r.range(0.0, 0.35), 0));
      woods.push(limb([s0, s1, s2], 0.05, 0.012, 5, 3));
      for (const tt of [0.55, 0.85, 1.0]) {
        const c = new CatmullRomCurve3([s0, s1, s2]).getPointAt(tt);
        cluster(cards, r, c, crown, crownR, 0.55, 9, r.pick([0, 1, 1, 2]), 0.72);
      }
    }
    // Clusters along the limb's outer part.
    for (let t = 0.45; t <= 1.0; t += 0.14) cluster(cards, r, curve.getPointAt(t).add(new Vector3(0, 0.25, 0)), crown, crownR, 0.7, 10, r.pick([0, 1, 2]), 0.8);
  }
  // Fill the crown's top so it reads as a dome.
  for (let i = 0; i < 26; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * 3.6;
    const c = crown.clone().add(new Vector3(Math.cos(a) * d, 0.8 + r.range(-0.4, 0.6) - d * 0.2, Math.sin(a) * d));
    cluster(cards, r, c, crown, crownR, 0.8, 10, r.pick([0, 1, 2]), 0.85);
  }
  w.mesh(mergeGeometries(woods, false)!, bark, 0, 0, 0, w.root);
  w.mesh(cardsGeometry(cards), leaves, 0, 0, 0, w.root);

  // A clipped hedge of azalea and camellia along the fence, showing above it.
  const shrub: Cards = { pos: [], nor: [], uv: [], idx: [] };
  for (let z = 0.4; z > -19.2; z -= r.range(0.6, 0.9)) {
    const x = WALL_X - 0.75 - r.range(0, 0.35) - Math.max(0, -z) * 0.04;
    const y = terraceY(z);
    const rad = r.range(0.5, 0.75);
    const c = new Vector3(x, y + 0.75 + rad * 0.6, z);
    cluster(shrub, r, c, c.clone().setY(y), new Vector3(rad * 1.3, rad, rad * 1.3), rad * 0.75, 16, 3, 0.6);
    if (r.chance(0.35)) cluster(shrub, r, c.clone().add(new Vector3(-0.8, -0.2, 0)), c.clone().setY(y), new Vector3(rad, rad, rad), rad * 0.6, 10, 3, 0.55);
  }
  // Smaller evergreen trees further down the terrace.
  for (const [x, z, h, cr] of [
    [-6.4, -9.0, 3.6, 1.7],
    [-4.9, -13.4, 3.0, 1.4],
    [-7.6, -16.6, 3.8, 1.9],
    [-9.5, -4.8, 3.2, 1.6],
  ] as const) {
    const b = new Vector3(x, terraceY(z) - 0.05, z);
    const top = b.clone().add(new Vector3(r.range(-0.3, 0.3), h * 0.62, r.range(-0.3, 0.3)));
    woods.length = 0;
    const t = limb([b, b.clone().add(new Vector3(0.05, h * 0.3, 0)), top], 0.12, 0.05, 7, 3);
    w.mesh(t, bark, 0, 0, 0, w.root);
    const crownC = b.clone().setY(b.y + h * 0.68);
    for (let i = 0; i < 9; i++) {
      const c = crownC.clone().add(new Vector3(r.range(-1, 1) * cr * 0.6, r.range(-0.5, 0.7) * cr * 0.6, r.range(-1, 1) * cr * 0.6));
      cluster(shrub, r, c, crownC, new Vector3(cr, cr * 0.9, cr), cr * 0.55, 12, r.pick([1, 3, 3]), 0.75);
    }
  }
  // Low ground cover (ferns, ivy, weeds) scattered over the terrace.
  for (let i = 0; i < 70; i++) {
    const z = r.range(-19.4, 0.8);
    const x = r.range(-15.5, WALL_X - 0.6);
    const rad = r.range(0.25, 0.5);
    const c = new Vector3(x, terraceY(z) + rad * 0.35, z);
    cluster(shrub, r, c, c.clone().setY(terraceY(z) - 0.2), new Vector3(rad * 1.5, rad, rad * 1.5), rad * 0.8, 7, r.pick([2, 3, 3]), 0.5);
  }
  w.mesh(cardsGeometry(shrub), leaves, 0, 0, 0, w.root);
}
