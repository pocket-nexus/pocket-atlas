import { BufferGeometry, CatmullRomCurve3, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Rng } from "../../../core/random";
import type { SugaWorld } from "./context";
import { terraceY, WALL_X } from "./layout";
import { limb, leafMaterial, cluster, cardsGeometry, type Cards } from "../../shared/daylight/foliage";
export { foliage } from "../../shared/daylight/foliage";

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
