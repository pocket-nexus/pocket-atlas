import { BufferGeometry, CanvasTexture, Color, Float32BufferAttribute, Group, PlaneGeometry, RepeatWrapping, ShapeUtils, SRGBColorSpace, Vector2, Vector3 } from "three";
import { Rng } from "../../../core/random";
import type { Baker } from "../../shared/bake";
import { canvas } from "../../shared/canvas";
import { merge } from "../../shared/shapes";
import { bakeWaveNormals, createWater, foamMaterial, type Water } from "../../shared/water";
import { sail } from "../gfx/art";
import type { KamakuraWorld } from "./context";
import { COAST, LOOP, SEA_Y } from "./layout";
import { stations } from "./util";

/**
 * Sagami Bay: one water surface from the beach to past the horizon (15.8 km
 * from the canonical eye), the surf of Shichirigahama, a few sailboats, and
 * the coast in the haze: Inamuragasaki and the Miura peninsula to the east,
 * Koshigoe and Enoshima to the west.
 */

/** The bay's water: wind sea and swell from the south-west, July colours. */
export const WATER = {
  name: "sea",
  waves: [
    { repeatsPerMetre: 1 / 34, scroll: [0.45, 1.5] as [number, number] },
    { repeatsPerMetre: 1 / 7.3, scroll: [-0.55, 0.85] as [number, number] },
  ] as [{ repeatsPerMetre: number; scroll: [number, number] }, { repeatsPerMetre: number; scroll: [number, number] }],
  slope: 0.36,
  roughness: 0.08,
  distanceRoughness: 0.000015,
  body: new Color(0.0, 0.5, 0.52),
  envMapIntensity: 0.85,
};

export function buildSea(w: KamakuraWorld, baker: Baker): Water {
  // The shore is to the north (−z, texture −v) of every shot: tilt the mean normal toward it.
  const waves = bakeWaveNormals(baker, { seed: 11, heading: -Math.PI / 2 - 0.25, spread: 1.3, tilt: [0, -0.3] });
  const water = createWater(WATER, waves);
  w.update((_dt, t) => water.update(t));

  // ---- the water surface: a few large triangles from under the beach to 24 km out.
  const shore: [number, number][] = [];
  for (const u of [-700, -150, 420, 1120, 1300]) {
    const p = COAST.offset(u, 44, new Vector3());
    shore.push([p.x, p.z]);
  }
  const ring: [number, number][] = [
    [-2350, 1010],
    [-1300, 360],
    ...shore,
    [2350, 640],
    [9000, 3600],
    [21000, 9000],
    [12000, 22000],
    [0, 25000],
    [-12000, 22000],
    [-21000, 9000],
    [-9000, 2900],
  ];
  const pts2 = ring.map(([x, z]) => new Vector2(x, z));
  const tris = ShapeUtils.triangulateShape(pts2, []);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  for (const t of tris) {
    // Shape winding is in (x, z); emit counter-clockwise from above (+y).
    const [a, b, c] = t.map((i) => pts2[i]);
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const order = cross < 0 ? [a, b, c] : [a, c, b];
    for (const q of order) {
      pos.push(q.x, SEA_Y, q.y);
      nrm.push(0, 1, 0);
      uv.push(q.x / 34, q.y / 34);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  const sea = w.mesh(g, water.material, 0, 0, 0, w.root, { cast: false, receive: false });
  sea.name = "sea";
  sea.frustumCulled = false;

  surf(w);
  sailboats(w);
  return water;
}

/** Breaking-wave foam: bands of white across the strip, broken by gaps; tiles in u, scrolls in v. */
function foamTexture(seed: number, lines: number): CanvasTexture {
  const { c, g } = canvas(512, 256);
  const r = new Rng(seed);
  g.clearRect(0, 0, 512, 256);
  for (let k = 0; k < lines; k++) {
    const y0 = ((k + 0.25) * 256) / lines;
    // A crest line with a fading trail of whitewater behind it (toward +v, offshore).
    for (let x = 0; x < 512; x += 2) {
      const phase = (x / 512) * Math.PI * 2;
      const wob = Math.sin(phase * 3 + k) * 4 + Math.sin(phase * 7 + k * 2) * 2;
      const broken = 0.55 + 0.45 * Math.sin(phase * 5 + k * 1.7) * Math.sin(phase * 2 + k);
      const crest = y0 + wob;
      for (let y = -6; y < 46; y++) {
        const yy = (((crest + y) % 256) + 256) % 256;
        const a = y < 0 ? Math.max(0, 1 + y / 6) : Math.exp(-y / 14) * (0.55 + 0.45 * r.next());
        const alpha = a * broken * (0.8 + 0.2 * r.next());
        if (alpha < 0.03) continue;
        g.fillStyle = `rgba(250,252,250,${alpha.toFixed(3)})`;
        g.fillRect(x, yy, 2, 1);
      }
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  t.name = `foam-${seed}`;
  return t;
}

/**
 * Two surf strips along the beach: the shore break at the waterline and a
 * line of breakers further out. The foam scrolls shoreward (one crest every
 * ~9 s) and each strip's vertex alpha fades it in and out across its width;
 * the strips also surge up and down the beach a metre or two with the sets.
 * Each strip is one moving mesh (one draw on the handheld).
 */
function surf(w: KamakuraWorld): void {
  const strips = [
    { name: "surf-shore", s: [51, 56, 61, 66] as const, alpha: [0, 0.95, 0.7, 0], period: 9, tile: 40, lines: 1, seed: 3, surge: 2.2, y: 0.03 },
    { name: "surf-outer", s: [92, 102, 114, 128] as const, alpha: [0, 0.45, 0.35, 0], period: 9, tile: 60, lines: 1, seed: 8, surge: 1.0, y: 0.04 },
  ];
  for (const st of strips) {
    const tex = foamTexture(st.seed, st.lines);
    // v runs offshore: 1 texture repeat per `tile` metres; scrolling +v moves foam shoreward.
    const speed = st.tile / st.period;
    const foam = foamMaterial(tex, [0, speed / st.tile], st.name);
    const us = stations(-600, 1100, 40, 60, 90);
    const pos: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const p = new Vector3();
    const n = st.s.length;
    for (let i = 0; i < us.length; i++) {
      for (let j = 0; j < n; j++) {
        COAST.offset(us[i], st.s[j], p);
        pos.push(p.x, SEA_Y + st.y, p.z);
        col.push(1, 1, 1, st.alpha[j]);
        uv.push(us[i] / 52, (st.s[j] - st.s[0]) / st.tile);
      }
    }
    for (let i = 0; i < us.length - 1; i++)
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j;
        idx.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
      }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new Float32BufferAttribute(col, 4));
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const holder = new Group();
    holder.name = st.name;
    holder.userData.dynamic = true;
    w.root.add(holder);
    const m = w.mesh(g, foam.material, 0, 0, 0, holder, { cast: false, receive: false });
    m.renderOrder = 1;
    // The surge: toward the shore and back, a whole number of sets per loop.
    const sets = Math.round(LOOP / st.period);
    const dir = COAST.offset(0, 1, new Vector3()).sub(COAST.point(0, new Vector3())).normalize();
    w.update((_dt, t) => {
      foam.update(t);
      const k = Math.sin((2 * Math.PI * sets * (t % LOOP)) / LOOP);
      holder.position.copy(dir).multiplyScalar(-k * st.surge);
    });
  }
}

/** Sailboats off Shichirigahama in two loose groups, bobbing (one moving mesh). */
function sailboats(w: KamakuraWorld): void {
  const cell = w.draw("sail", 128, 192, sail);
  const r = new Rng(21);
  const sails: BufferGeometry[] = [];
  const hulls: BufferGeometry[] = [];
  const spots: [number, number, number][] = [
    // x, z, count: bearings ~170–200° from the canonical eye, 1.4–3.2 km out.
    [-260, 1500, 4],
    [380, 2300, 3],
    [-700, 3100, 2],
  ];
  for (const [cx, cz, count] of spots) {
    for (let i = 0; i < count; i++) {
      const x = cx + r.range(-90, 90);
      const z = cz + r.range(-60, 60);
      const h = r.range(6, 9);
      const yaw = r.range(0, Math.PI * 2);
      for (const a of [0, Math.PI / 2]) {
        const g = new PlaneGeometry(h * 0.62, h);
        const uv = g.getAttribute("uv");
        for (let k = 0; k < uv.count; k++) uv.setXY(k, cell.u0 + uv.getX(k) * (cell.u1 - cell.u0), cell.v0 + uv.getY(k) * (cell.v1 - cell.v0));
        g.translate(0, h / 2 + 0.6, 0);
        g.rotateY(yaw + a);
        g.translate(x, SEA_Y, z);
        sails.push(g);
      }
      const hull = w.tint(new PlaneGeometry(h * 0.55, 0.6), "white");
      hull.rotateY(yaw + Math.PI / 2);
      hull.translate(x, SEA_Y + 0.3, z);
      hulls.push(hull);
    }
  }
  const holder = new Group();
  holder.name = "sailboats";
  holder.userData.dynamic = true;
  w.root.add(holder);
  // Sails and hulls in one alpha-tested mesh (the hulls sample an opaque patch): one draw.
  w.mesh(merge([...sails, ...hulls]), w.cut, 0, 0, 0, holder, { cast: false, receive: false });
  w.update((_dt, t) => {
    holder.position.y = 0.12 * Math.sin((2 * Math.PI * 20 * (t % LOOP)) / LOOP);
  });
}

