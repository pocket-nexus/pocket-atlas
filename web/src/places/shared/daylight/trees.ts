import { BufferGeometry, CatmullRomCurve3, Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, InstancedMesh, MeshStandardMaterial, Object3D, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture } from "../canvas";
import { merge } from "../shapes";
import type { DayWorld } from "./context";
import { cardsGeometry, cluster, leafMaterial, limb, type Cards } from "./foliage";

/** A twig atlas, with individually drawn five-petalled flowers and visible stamens. */
function blossomMaterial(w: DayWorld) {
  const { c, g } = canvas(1024, 1024);
  const r = new Rng(305);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * 512, oy = Math.floor(cell / 2) * 512;
    g.save(); g.translate(ox, oy);
    g.lineCap = "round";
    for (let j = 0; j < 7; j++) {
      const a = -Math.PI / 2 + (j - 3) * 0.39;
      g.strokeStyle = "#78554d"; g.lineWidth = 3;
      g.beginPath(); g.moveTo(245, 437);
      g.quadraticCurveTo(260 + Math.cos(a) * 105, 340 + Math.sin(a) * 100, 256 + Math.cos(a) * 230, 304 + Math.sin(a) * 230); g.stroke();
    }
    for (let j = 0; j < 104; j++) {
      const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 206;
      const x = 256 + Math.cos(a) * d, y = 244 + Math.sin(a) * d * 0.86;
      const radius = r.range(12, 23);
      g.save(); g.translate(x, y); g.rotate(r.range(-3, 3));
      const shade = r.range(79, 95) - (cell === 1 ? 8 : 0);
      for (let p = 0; p < 5; p++) {
        g.rotate(Math.PI * 0.4);
        const color = g.createLinearGradient(0, 0, 0, -radius);
        color.addColorStop(0, `hsl(340,55%,${shade - 11}%)`);
        color.addColorStop(1, `hsl(338,62%,${Math.min(99, shade + 5)}%)`);
        g.fillStyle = color; g.beginPath(); g.moveTo(0, 0);
        g.bezierCurveTo(-radius * 0.8, -radius * 0.4, -radius * 0.58, -radius * 1.12, -radius * 0.12, -radius);
        g.lineTo(0, -radius * 0.85); g.lineTo(radius * 0.13, -radius);
        g.bezierCurveTo(radius * 0.62, -radius * 1.05, radius * 0.76, -radius * 0.36, 0, 0); g.fill();
      }
      g.fillStyle = "#b65778"; g.beginPath(); g.arc(0, 0, 2.8, 0, 7); g.fill();
      g.fillStyle = "#efd49d";
      for (let k = 0; k < 7; k++) {
        const a = k * 0.898;
        g.beginPath(); g.arc(Math.cos(a) * 4.7, Math.sin(a) * 4.7, 1.0, 0, 7); g.fill();
      }
      g.restore();
    }
    g.restore();
  }
  const tex = toTexture(c);
  const mat = w.lib.cutout("spring-blossom", tex, { rough: 0.9 });
  mat.emissive.set(0xffbdd5); mat.emissiveMap = tex; mat.emissiveIntensity = 0.19;
  return mat;
}

const blossoms = new WeakMap<DayWorld, MeshStandardMaterial>();

export interface TreeSpec {
  at: [number, number, number];
  height: number;
  radius: number;
  seed: number;
  bloom?: boolean;
  lean?: [number, number];
}

/** Branch-led crown: open gaps, tapering wood and radial normals, never solid spheres. */
export function tree(w: DayWorld, spec: TreeSpec): void {
  const r = new Rng(spec.seed), base = new Vector3(...spec.at);
  const h = spec.height, radius = spec.radius;
  const top = base.clone().add(new Vector3(spec.lean?.[0] ?? 0.25, h * 0.4, spec.lean?.[1] ?? 0));
  const woods: BufferGeometry[] = [limb([base, base.clone().lerp(top, 0.5).add(new Vector3(-0.12, 0, 0.08)), top], h * 0.045, h * 0.026, 10)];
  for (let j = 0; j < 5; j++) {
    const a = j * 1.256;
    woods.push(limb([base.clone().add(new Vector3(Math.cos(a) * 0.5, 0.02, Math.sin(a) * 0.5)), base.clone().add(new Vector3(0, 0.7, 0))], 0.1, 0.13, 5));
  }
  const crown = base.clone().add(new Vector3(top.x - base.x, h * 0.73, 0));
  const cr = new Vector3(radius, h * 0.4, radius);
  const cards: Cards = { pos: [], nor: [], uv: [], idx: [] };
  const density = w.quality.level === "low" ? 7 : 13;
  for (let j = 0; j < 9; j++) {
    const a = j * 2.399 + r.range(-0.3, 0.3);
    const dir = new Vector3(Math.cos(a), 0, Math.sin(a));
    const length = radius * r.range(0.68, 1.12), rise = h * r.range(0.22, 0.47);
    const tip = top.clone().addScaledVector(dir, length).add(new Vector3(0, rise, 0));
    const mid = top.clone().lerp(tip, 0.53).add(new Vector3(0, 0.5, 0));
    const curve = new CatmullRomCurve3([top, mid, tip]);
    woods.push(limb([top, mid, tip], h * 0.021, 0.025, 7));
    for (let k = 0; k < 9; k++) {
      const t = 0.22 + k * 0.088;
      const p = curve.getPoint(t);
      const side = new Vector3(-dir.z, r.range(0.08, 0.4), dir.x).multiplyScalar((k % 2 ? 1 : -1) * radius * r.range(0.2, 0.43));
      side.y = r.range(0.05, h * 0.15);
      const end = p.clone().add(side).addScaledVector(dir, radius * 0.15);
      woods.push(limb([p, p.clone().lerp(end, 0.6).add(new Vector3(0, 0.15, 0)), end], 0.034, 0.006, 5));
      for (const f of [0.48, 0.8, 1.0]) {
        const at = p.clone().lerp(end, f);
        cluster(cards, r, at, crown, cr, radius * 0.11, density, spec.bloom ? r.pick([0, 0, 2, 3]) : r.pick([0, 1, 2]), spec.bloom ? 0.55 : 0.73);
      }
    }
  }
  let material = leafMaterial(w);
  if (spec.bloom) {
    if (!blossoms.has(w)) blossoms.set(w, blossomMaterial(w));
    material = blossoms.get(w)!;
  }
  // Irregular crown fill softens the branch skeleton without closing every sky gap.
  for (let j = 0; j < 75; j++) {
    const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * radius * 0.92;
    const at = crown.clone().add(new Vector3(Math.cos(a) * d, h * 0.1 - d * 0.18 + r.range(-0.65, 0.7), Math.sin(a) * d));
    cluster(cards, r, at, crown, cr, radius * 0.16, density + 5, spec.bloom ? r.pick([0, 2, 3]) : r.pick([0, 1, 2]), spec.bloom ? 0.7 : 0.84);
  }
  w.mesh(merge(woods), w.lib.bark(0x9a8279));
  w.mesh(cardsGeometry(cards), material);
}

/** Curved, notched petal with a pale edge and pink base. Used for settled and airborne petals. */
function petalGeometry(): BufferGeometry {
  const pos = [0, 0, 0, -0.35, 0.3, 0.08, -0.45, 0.7, 0.14, -0.21, 1, 0.22, 0, 0.88, 0.25, 0.21, 1, 0.22, 0.45, 0.7, 0.14, 0.35, 0.3, 0.08];
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 6, 0, 6, 7]);
  g.computeVertexNormals();
  return g;
}

export function petalDrift(w: DayWorld, groundY: (z: number) => number): void {
  const r = new Rng(500), dummy = new Object3D();
  const mat = new MeshStandardMaterial({ color: 0xffd5e3, roughness: 0.9, side: DoubleSide, emissive: 0x5e283e, emissiveIntensity: 0.16 });
  mat.name = "fallen-cherry-petal";
  const settled = new InstancedMesh(petalGeometry(), mat, 2100);
  settled.name = "petals-in-gutters";
  for (let i = 0; i < settled.count; i++) {
    const z = r.range(-40, 29);
    const x = r.chance(0.76) ? r.pick([-1, 1]) * r.range(2.0, 2.75) : r.range(-2.7, 2.7);
    dummy.position.set(x, groundY(z) + 0.028, z);
    dummy.rotation.set(-Math.PI / 2, 0, r.range(0, 6.28));
    dummy.scale.setScalar(r.range(0.025, 0.057)); dummy.updateMatrix();
    settled.setMatrixAt(i, dummy.matrix);
    settled.setColorAt(i, new Color().setHSL(r.range(0.91, 0.97), 0.45, r.range(0.7, 0.94)));
  }
  settled.receiveShadow = true; w.root.add(settled);
  const count = w.quality.level === "low" ? 90 : 260;
  const flying = new InstancedMesh(petalGeometry(), mat, count);
  flying.name = "petals-on-the-breeze"; flying.userData.dynamic = true;
  flying.instanceMatrix.setUsage(DynamicDrawUsage); flying.frustumCulled = false;
  const seeds = Array.from({ length: count }, () => ({ x: r.range(-9, 9), y: r.range(0, 11), z: r.range(-36, 20), phase: r.range(0, 6.28), size: r.range(0.035, 0.08) }));
  const update = (_dt: number, t: number) => {
    seeds.forEach((p, i) => {
      const x = ((p.x + t * 0.23 + 9) % 18 + 18) % 18 - 9;
      const z = p.z + Math.sin(t * 0.19 + p.phase) * 0.9;
      const height = ((p.y - t * 0.13) % 11 + 11) % 11;
      dummy.position.set(x + Math.sin(t * 0.7 + p.phase) * 0.55, groundY(z) + height + 0.05, z);
      dummy.rotation.set(t * 0.65 + p.phase, Math.sin(t * 0.6 + p.phase), t * 0.37 + p.phase);
      // Suppress near-eye intersections: a tiny petal must never cover the view as a giant polygon.
      const nearFade = Math.min(1, Math.max(0, (dummy.position.distanceTo(w.viewPosition) - 0.8) / 1.2));
      dummy.scale.setScalar(p.size * nearFade); dummy.updateMatrix(); flying.setMatrixAt(i, dummy.matrix);
    });
    flying.instanceMatrix.needsUpdate = true;
  };
  update(0, 0); w.update(update); w.root.add(flying);
}
