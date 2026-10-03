import { BufferGeometry, CatmullRomCurve3, Float32BufferAttribute, Matrix4, Quaternion, Vector3, type Material } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture, type Ctx } from "../canvas";
import type { DayWorld } from "./context";

/** Tapered tube along a smooth curve; UVs in metres (u around, v along). */
export function limb(pts: Vector3[], r0: number, r1: number, radial: number, perMeter = 3, chordError = 0): BufferGeometry {
  const curve = new CatmullRomCurve3(pts, false, "centripetal");
  const len = curve.getLength();
  const limit = Math.max(3, Math.ceil(len * perMeter));
  let segs = limit;
  if (chordError > 0) {
    // Thin twigs often need only their bend and endpoints. Keep the complete
    // branch skeleton, and retain the original segmentation on tighter bends.
    const a = new Vector3(), b = new Vector3(), linear = new Vector3();
    for (let n = 2; n < limit; n++) {
      let within = true;
      for (let segment = 0; segment < n && within; segment++) {
        curve.getPointAt(segment / n, a); curve.getPointAt((segment + 1) / n, b);
        for (let sample = 1; sample < 16; sample++) {
          const t = sample / 16;
          if (curve.getPointAt((segment + t) / n).distanceTo(linear.lerpVectors(a, b, t)) > chordError) { within = false; break; }
        }
      }
      if (within) { segs = n; break; }
    }
  }
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
      idx.push(a, b, a + 1);
      // A pointed twig ends in one vertex, not a ring of degenerate faces.
      if (i !== segs - 1 || r1 !== 0) idx.push(b, b + 1, a + 1);
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

const leafMats = new WeakMap<DayWorld, Material>();

/** The shared alpha-tested leaf material (cherry sprays and shrub leaves in one atlas). */
export function leafMaterial(w: DayWorld): Material {
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
export function foliage(w: DayWorld) {
  return {
    begin: (): Cards => ({ pos: [], nor: [], uv: [], idx: [] }),
    clump: (c: Cards, r: Rng, at: Vector3, radius: number, count: number) =>
      cluster(c, r, at, at.clone().setY(at.y - radius * 0.6), new Vector3(radius, radius, radius), radius * 0.6, w.geometry === "handheld" ? Math.max(4, Math.round(count * 0.55)) : count, 3, radius * 1.1),
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
export function cluster(out: Cards, r: Rng, c: Vector3, crown: Vector3, crownR: Vector3, radius: number, count: number, cell: number, size: number, thinInterior = false): void {
  const u0 = (cell % 2) * 0.5;
  const v0 = cell < 2 ? 0.5 : 0;
  const q = new Quaternion();
  const m = new Matrix4();
  for (let i = 0; i < count; i++) {
    const p = c.clone().add(new Vector3(r.range(-1, 1), r.range(-0.6, 0.8), r.range(-1, 1)).multiplyScalar(radius));
    const outward = p.clone().sub(crown).divide(crownR);
    const crownDistance = outward.length();
    outward.normalize();
    // Card normal: mostly outward and up, with scatter.
    const n = outward.clone().multiplyScalar(0.6).add(new Vector3(r.range(-0.6, 0.6), r.range(0.1, 0.9), r.range(-0.6, 0.6))).normalize();
    q.setFromUnitVectors(new Vector3(0, 0, 1), n);
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), r.range(0, Math.PI * 2)));
    const s = size * r.range(0.8, 1.2);
    // Keep every card in the outer crown, including its original orientation
    // and size. Inside it, retain several layers per twig instead of stacking
    // seven or twelve almost coincident sprays. Consume the same random values
    // even when omitting a card, so every later branch and outer spray is stable.
    if (thinInterior && crownDistance < 0.9) {
      const t = Math.max(0, Math.min(1, (crownDistance - 0.6) / 0.3));
      const fraction = 0.2 + 0.8 * t * t * (3 - 2 * t);
      if (i >= Math.max(2, Math.ceil(count * fraction))) continue;
    }
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

export function cardsGeometry(c: Cards): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(c.pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(c.nor, 3));
  g.setAttribute("uv", new Float32BufferAttribute(c.uv, 2));
  g.setIndex(c.idx);
  g.computeBoundingSphere();
  return g;
}
