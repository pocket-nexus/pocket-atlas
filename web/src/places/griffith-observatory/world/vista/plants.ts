import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, MeshStandardMaterial } from "three";
import coverUrl from "../../data/cover-park.bin?url";
import { canvas, toTexture } from "../../../shared/canvas";
import type { GriffithWorld } from "../context";
import { groundY } from "../dem";
import { EYES } from "./eyes";
import { inSite, vistaTolerance } from "./terrain";
import { HIDDEN, SKYLINE } from "./viewshed";

/**
 * Planting outside SITE where the shots see it: coast live oaks (and a few
 * pines) on the canopy cells of the cover map, chaparral clumps on the scrub
 * cells, as crossed alpha-tested cards. The cover map (`data/cover-park.bin`,
 * `scripts/vista-cover.ts`) classes 4 m cells of the Esri World Imagery z16
 * mosaic: paved, bare, chaparral, canopy. Density follows what the eyes see:
 * full where a plant stands against the sky or the lit basin (the viewshed's
 * skyline: the ridges below the terraces, the hill in front of the overlook),
 * thin where it is seen against more hillside, none where it is hidden.
 */

async function loadCover(): Promise<{ x0: number; z0: number; step: number; nx: number; nz: number; cells: Uint8Array }> {
  const res = await fetch(coverUrl);
  const raw = new Uint8Array(await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + hl)));
  return { ...h, cells: raw.slice(8 + hl) };
}

const COVER = await loadCover();

/** Cells: 0 paved, 1 bare, 2 chaparral, 3 canopy. */
export function coverAt(x: number, z: number): number {
  const i = Math.floor((x - COVER.x0) / COVER.step);
  const j = Math.floor((z - COVER.z0) / COVER.step);
  if (i < 0 || j < 0 || i >= COVER.nx || j >= COVER.nz) return -1;
  return COVER.cells[j * COVER.nx + i];
}

/** Atlas cells (u0, u1): oak, pine, shrub; v spans the full height. */
const CELL = { oak: [0, 0.5], pine: [0.5, 0.75], shrub: [0.75, 1] } as const;

/** 512 × 256: an oak (broad rounded crown on a short trunk), a pine (umbrella on a tall trunk), a chaparral clump. */
function plantAtlas() {
  const { c, g } = canvas(512, 256);
  g.clearRect(0, 0, 512, 256);
  let seed = 11;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const leaves = (cx: number, cy: number, rx: number, ry: number, n: number, size: number, tone: number) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      const x = cx + Math.cos(a) * rx * r;
      const y = cy + Math.sin(a) * ry * r;
      const v = Math.round(tone * (0.7 + 0.5 * rnd()));
      g.fillStyle = `rgb(${Math.round(v * 0.85)},${v},${Math.round(v * 0.62)})`;
      g.beginPath();
      g.arc(x, y, size * (0.6 + 0.8 * rnd()), 0, Math.PI * 2);
      g.fill();
    }
  };
  // Oak: trunk, then lumpy crown clusters.
  g.fillStyle = "rgb(58,48,40)";
  g.fillRect(120, 150, 16, 106);
  g.fillRect(100, 150, 10, 40);
  for (let k = 0; k < 9; k++) leaves(128 + (rnd() - 0.5) * 150, 105 + (rnd() - 0.5) * 80, 52, 38, 160, 5, 120);
  // Pine: tall trunk, umbrella crown.
  g.fillStyle = "rgb(62,50,42)";
  g.fillRect(316, 70, 10, 186);
  for (let k = 0; k < 6; k++) leaves(320 + (rnd() - 0.5) * 80, 52 + (rnd() - 0.5) * 30, 34, 20, 110, 4, 110);
  // Chaparral clump: a rounded mound, darker at the base.
  for (let k = 0; k < 7; k++) leaves(448 + (rnd() - 0.5) * 70, 170 + (rnd() - 0.5) * 60, 36, 40, 140, 5, 115);
  const t = toTexture(c, false, 4);
  t.name = "vista-plants";
  return t;
}

export function buildPlants(w: GriffithWorld): { triangles: number; trees: number; shrubs: number } {
  const { shed } = vistaTolerance();
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  let seed = 1935;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const eyes = EYES.filter((e) => e.name !== "Sign");
  const near = (x: number, z: number) => Math.min(...eyes.map((e) => Math.hypot(x - e.x, z - e.z)));

  /** Two crossed vertical cards `wd` wide, `h` tall, standing on (x, y, z). */
  const plant = (cell: readonly [number, number], x: number, y: number, z: number, wd: number, h: number, tint: number[]) => {
    const a0 = rnd() * Math.PI;
    for (let k = 0; k < 2; k++) {
      const a = a0 + (k * Math.PI) / 2;
      const dx = (Math.cos(a) * wd) / 2;
      const dz = (Math.sin(a) * wd) / 2;
      const [u0, u1] = cell;
      const P = [
        [x - dx, y - 0.3, z - dz, u0, 0],
        [x + dx, y - 0.3, z + dz, u1, 0],
        [x + dx, y + h, z + dz, u1, 1],
        [x - dx, y + h, z - dz, u0, 1],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        pos.push(P[i][0], P[i][1], P[i][2]);
        uv.push(P[i][3], P[i][4]);
        // Leaves catch the sky: normals tilted up.
        nor.push(-Math.sin(a) * 0.5, 0.85, Math.cos(a) * 0.5);
        col.push(tint[0], tint[1], tint[2]);
      }
    }
  };

  let trees = 0;
  let shrubs = 0;
  const step = COVER.step;
  for (let j = 0; j < COVER.nz; j++)
    for (let i = 0; i < COVER.nx; i++) {
      const c = COVER.cells[j * COVER.nx + i];
      if (c < 2) continue;
      const x = COVER.x0 + (i + rnd()) * step;
      const z = COVER.z0 + (j + rnd()) * step;
      if (inSite(x, z)) continue;
      const d = near(x, z);
      if (c === 3) {
        if (d > 1100) continue;
        // One oak per ~5 canopy cells near the eyes, thinner out.
        const base = d < 300 ? 0.2 : d < 600 ? 0.12 : 0.07;
        if (rnd() > base) continue;
        const pine = rnd() < 0.15;
        const h = pine ? 10 + rnd() * 6 : 6.5 + rnd() * 5;
        const y = groundY(x, z);
        const sight = shed.sight(x, y + h, z, 0.0005);
        if (sight === HIDDEN || (sight !== SKYLINE && rnd() > 0.3)) continue;
        const v = 0.75 + rnd() * 0.35;
        plant(pine ? CELL.pine : CELL.oak, x, y, z, pine ? h * 0.75 : h * 1.25, h, [0.42 * v, 0.48 * v, 0.36 * v]);
        trees++;
      } else if (d < 320) {
        if (rnd() > 0.28) continue;
        const h = 1.4 + rnd() * 2;
        const y = groundY(x, z);
        const sight = shed.sight(x, y + h, z, 0.0005);
        if (sight === HIDDEN || (sight !== SKYLINE && rnd() > 0.2)) continue;
        const v = 0.7 + rnd() * 0.4;
        plant(CELL.shrub, x, y, z, h * 1.6, h, [0.55 * v, 0.55 * v, 0.42 * v]);
        shrubs++;
      }
    }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  const mat = new MeshStandardMaterial({ name: "vista-plants", map: plantAtlas(), alphaTest: 0.5, side: DoubleSide, vertexColors: true, roughness: 0.9, metalness: 0, color: new Color(0.55, 0.6, 0.5) });
  w.mesh(geo, mat, 0, 0, 0, w.root, { cast: false, receive: false }).name = "vista-plants";
  return { triangles: pos.length / 9, trees, shrubs };
}
