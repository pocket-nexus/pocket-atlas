import { BufferAttribute, BufferGeometry, Sphere, Vector3, type SkinnedMesh } from "three";
import type { MaterialLib } from "../../tokyo-konbini/gfx/materials";
import { stand, walk, wander, type Gait } from "../../tokyo-konbini/world/people/motion";
import { Figure, type Build, type Look } from "../../tokyo-konbini/world/people/rig";
import { Wear } from "../../tokyo-konbini/world/people/wear";
import type { KamakuraWorld } from "./context";
import { COAST, LOOP, SECTION } from "./layout";

/*
 * Two ordinary summer visitors on the procedural, skinned rig of Rainy
 * Night Konbini: a man in a cap standing at the sea-wall fence west of the
 * junction, looking out over the bay, and a woman strolling the Route 134 sidewalk
 * east of the junction and back. No crowd, no costumes. Paints use two
 * roughness classes, so a figure costs two draws on the handheld. All
 * motion is periodic in the loop: the stroll covers its circuit once per
 * loop with a whole number of gait cycles, the idle sways repeat a whole
 * number of times.
 */

/** Clustering cell for the handheld figures (m): about 1.5k triangles a person. */
const CELL = 0.05;

/** Sidewalk height above the rail (road 0.06 + kerb 0.15). */
const WALK_Y = 0.21;

/** Out along one line of the sidewalk, a tight U-turn, back along another (u, s on the coast line). */
function stroll(u0: number, u1: number, s0: number, s1: number) {
  const r = Math.abs(s1 - s0) / 2;
  const sc = (s0 + s1) / 2;
  const run = u1 - u0;
  const turn = Math.PI * r;
  const length = 2 * run + 2 * turn;
  const p = new Vector3();
  const q = new Vector3();
  /** Point at distance d along the circuit and the yaw that faces the way ahead. */
  const at = (d: number, out: Vector3): number => {
    const uv = (dd: number): [number, number] => {
      dd = ((dd % length) + length) % length;
      if (dd < run) return [u0 + dd, s0];
      dd -= run;
      if (dd < turn) {
        const a = dd / r;
        return [u1 + r * Math.sin(a), sc - (sc - s0) * Math.cos(a)];
      }
      dd -= turn;
      if (dd < run) return [u1 - dd, s1];
      dd -= run;
      const a = dd / r;
      return [u0 - r * Math.sin(a), sc - (sc - s1) * Math.cos(a)];
    };
    const [u, s] = uv(d);
    const [ua, sa] = uv(d + 0.05);
    COAST.offset(u, s, out);
    COAST.offset(u, s, p);
    COAST.offset(ua, sa, q);
    return Math.atan2(q.x - p.x, q.z - p.z);
  };
  return { length, at };
}

/**
 * Thins a figure to handheld size by vertex clustering in the bind pose:
 * vertices of every garment that fall in the same `cell` merge to the
 * cell's mean (shared across garments, so seams stay closed), keeping the
 * first vertex's skin weights and colour; collapsed and repeated triangles
 * drop out and normals are rebuilt.
 */
function thin(f: Figure, cell: number): void {
  const meshes = f.meshes as SkinnedMesh[];
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const sum = new Map<string, [number, number, number, number]>();
  for (const m of meshes) {
    const p = m.geometry.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const k = keyOf(p.getX(i), p.getY(i), p.getZ(i));
      const e = sum.get(k) ?? [0, 0, 0, 0];
      e[0] += p.getX(i);
      e[1] += p.getY(i);
      e[2] += p.getZ(i);
      e[3]++;
      sum.set(k, e);
    }
  }
  for (const m of meshes) {
    const g = m.geometry;
    const p = g.getAttribute("position");
    const keep = ["skinIndex", "skinWeight", "color", "uv"].filter((n) => g.getAttribute(n));
    const slot = new Map<string, number>();
    const remap: number[] = [];
    const src: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const k = keyOf(p.getX(i), p.getY(i), p.getZ(i));
      let j = slot.get(k);
      if (j === undefined) {
        j = src.length;
        slot.set(k, j);
        src.push(i);
      }
      remap.push(j);
    }
    const index = g.index ? Array.from(g.index.array) : Array.from({ length: p.count }, (_, i) => i);
    const tris: number[] = [];
    const seen = new Set<string>();
    for (let t = 0; t < index.length; t += 3) {
      const a = remap[index[t]];
      const b = remap[index[t + 1]];
      const c = remap[index[t + 2]];
      if (a === b || b === c || a === c) continue;
      const key = [a, b, c].sort((x, y) => x - y).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      tris.push(a, b, c);
    }
    const out = new BufferGeometry();
    const pos = new Float32Array(src.length * 3);
    src.forEach((i, j) => {
      const e = sum.get(keyOf(p.getX(i), p.getY(i), p.getZ(i)))!;
      pos.set([e[0] / e[3], e[1] / e[3], e[2] / e[3]], j * 3);
    });
    out.setAttribute("position", new BufferAttribute(pos, 3));
    for (const n of keep) {
      const a = g.getAttribute(n) as BufferAttribute;
      const Arr = a.array.constructor as new (n: number) => Float32Array;
      const arr = new Arr(src.length * a.itemSize);
      src.forEach((i, j) => {
        for (let c = 0; c < a.itemSize; c++) arr[j * a.itemSize + c] = a.array[i * a.itemSize + c];
      });
      out.setAttribute(n, new BufferAttribute(arr, a.itemSize, a.normalized));
    }
    out.setIndex(tris);
    out.computeVertexNormals();
    out.boundingSphere = (g.boundingSphere ?? new Sphere()).clone();
    g.dispose();
    m.geometry = out;
  }
}

export function buildPeople(w: KamakuraWorld): void {
  if (new URLSearchParams(location.search).has("nopeople")) return;
  const root = w.group();
  root.name = "people";
  root.userData.dynamic = true;
  const wear = new Wear(w.lib as unknown as MaterialLib, false);
  let tris = 0;
  let draws = 0;
  const count = (f: Figure) => {
    draws += f.meshes.length;
    for (const m of f.meshes) {
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    }
  };

  // ---- standing at the sea-wall fence west of the junction, looking out over the bay
  {
    const build: Build = { height: 1.74, hair: "short", top: { t: 0.014, hem: 0.74, cuff: 0.02 }, legs: { loose: 0.01 }, shoe: "sneaker" };
    const look: Look = {
      skin: { hex: 0xb48e76, rough: 0.55 },
      hair: { hex: 0x15110f, rough: 0.55 },
      top: { hex: 0x2c3e5a, rough: 0.75 },
      bottom: { hex: 0xb9ab8e, rough: 0.75 },
      shoes: { hex: 0xe6e4de, rough: 0.55 },
      cap: { hex: 0xd8d4c8, rough: 0.75 },
    };
    const f = new Figure(build, look, wear);
    // On the sea-wall top inside the fence, west of the junction, facing the bay toward Enoshima.
    COAST.offset(-7, SECTION.wallFence - 0.55, f.root.position).setY(WALK_Y);
    const t = COAST.tangent(-7, new Vector3());
    f.root.rotation.y = Math.atan2(-t.z, t.x) - 0.45;
    root.add(f.root);
    thin(f, CELL);
    count(f);
    const s = f.d.s;
    const feet: [Vector3, Vector3] = [new Vector3(0.11, 0.075 * s, 0.02), new Vector3(-0.1, 0.075 * s, -0.03)];
    const k = (2 * Math.PI) / LOOP;
    w.update((_dt, t) => {
      const tl = ((t % LOOP) + LOOP) % LOOP;
      stand(f, {
        feet,
        toe: [0.16, -0.16],
        weight: 0.5 * Math.tanh(2 * Math.sin(tl * k * 5 + 1)),
        lean: 0.03,
        twist: 0.04 * Math.sin(tl * k * 7 + 1),
        breath: tl * k * 40,
        // Turns toward the train as it passes (t ≈ 20–30), then back to the sea.
        yaw: 0.25 * Math.sin(tl * k * 3 + 2) + 0.1 * wander(0, 1),
        pitch: 0.05 * Math.sin(tl * k * 6 + 1),
      });
      f.swing(0, 0.04, -0.04, 0.25, 0.1);
      f.swing(1, -0.03, -0.04, 0.25, 0.1);
    });
  }

  // ---- strolling the Route 134 sidewalk east of the junction and back, once per loop
  {
    const build: Build = { height: 1.62, fem: 1, hair: "bob", top: { t: 0.012, hem: 0.62, cuff: 0.02 }, legs: { loose: 0.02 }, shoe: "sneaker" };
    const look: Look = {
      skin: { hex: 0xc9a08a, rough: 0.55 },
      hair: { hex: 0x2a1c16, rough: 0.55 },
      top: { hex: 0xa9c4d8, rough: 0.75 },
      bottom: { hex: 0xeceae2, rough: 0.75 },
      shoes: { hex: 0xf0efe9, rough: 0.55 },
      cap: { hex: 0xe9dfc8, rough: 0.75 },
    };
    const f = new Figure(build, look, wear);
    root.add(f.root);
    thin(f, CELL);
    count(f);
    const path = stroll(-14, 40, 4.3, 5.1);
    // One circuit per loop, a whole number of gait cycles in it.
    const speed = path.length / LOOP;
    const cycles = Math.round(path.length / 1.12);
    const gait: Gait = { stride: path.length / cycles, lift: 0.09, arm: 0.2, lean: 0.03, look: 0.06 };
    // Start the circuit so she is mid-sidewalk, walking east, as the train arrives (t ≈ 23).
    const d0 = path.length - 23 * speed + 22;
    w.update((_dt, t) => {
      const d = (((t * speed + d0) % path.length) + path.length) % path.length;
      f.root.rotation.y = path.at(d, f.root.position);
      f.root.position.y = WALK_Y;
      walk(f, (d / path.length) * cycles, gait, [true, true]);
    });
  }
  root.userData.triangles = tris;
  console.info(`[kamakura:people] ${Math.round(tris)} triangles in ${root.children.length} figures, ${draws} meshes`);
}
