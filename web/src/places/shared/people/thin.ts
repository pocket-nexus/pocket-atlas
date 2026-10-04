import { BufferAttribute, BufferGeometry, Sphere, type SkinnedMesh } from "three";
import type { Figure } from "./rig";

/**
 * Thins a figure to handheld size by vertex clustering in the bind pose:
 * vertices of every garment that fall in the same `cell` merge to the
 * cell's mean (shared across garments, so seams stay closed), keeping the
 * first vertex's skin weights and colour; collapsed and repeated triangles
 * drop out and normals are rebuilt.
 */
export function thinFigure(f: Figure, cell: number): void {
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
