import { BufferAttribute, BufferGeometry, Group, Mesh, type Material } from "three";
import { LAYERS, type Cells, type Layer } from "./layers";
import type { CellData } from "./mesh";
import type { RouteFiles } from "./source";
import type { WorkerReply, WorkerRequest } from "./worker";

const SRGB_TO_LINEAR = Uint8Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 255);
});

/**
 * Streams the route's cells around a point: asks the worker for the cells
 * of every layer within its radius (nearest first), turns each into one
 * mesh per material, and frees the ones left behind.
 */
export class Streamer {
  readonly group = new Group();
  private worker: Worker;
  private loaded = new Map<string, Group>();
  private pending = new Map<number, string>();
  private queue: { key: string; layer: Layer; ix: number; iz: number; d2: number }[] = [];
  private nextId = 1;
  private ready: Promise<void>;
  private scratch: [number, number][] = [];
  /** Cells built so far and the milliseconds the worker spent on them. */
  stats = { built: 0, ms: 0, triangles: 0, meshes: 0 };
  /** Radius scale (a capture or a weak machine may load less). */
  reach = 1;

  constructor(
    files: RouteFiles,
    private cells: Cells,
    private material: (name: string) => Material,
    private inFlight = 3,
  ) {
    this.group.name = "cells";
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const m = e.data;
        if (m.type === "ready") resolve();
        else if (m.type === "cell") this.accept(m.id, m.cell, m.ms);
        else {
          console.error(`[route] cell ${this.pending.get(m.id)}: ${m.message}`);
          this.pending.delete(m.id);
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message));
    });
    this.worker.postMessage({ type: "init", files } satisfies WorkerRequest);
  }

  /** Resolves once the worker has decoded the route. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private accept(id: number, cell: CellData, ms: number): void {
    const key = this.pending.get(id);
    this.pending.delete(id);
    if (!key) return;
    const g = new Group();
    g.name = key;
    g.position.set(cell.origin[0], cell.origin[1], cell.origin[2]);
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    for (const p of cell.prims) {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(p.position, 3));
      geo.setAttribute("normal", new BufferAttribute(p.normal, 3));
      geo.setAttribute("uv", new BufferAttribute(p.uv, 2));
      // Cell colours are sRGB (the handheld decodes them in its shader); three.js reads vertex colours as linear.
      for (let i = 0; i < p.color.length; i++) if ((i & 3) !== 3) p.color[i] = SRGB_TO_LINEAR[p.color[i]];
      geo.setAttribute("color", new BufferAttribute(p.color, 4, true));
      geo.setIndex(new BufferAttribute(p.index, 1));
      geo.computeBoundingSphere();
      const mesh = new Mesh(geo, this.material(p.material));
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
      this.stats.triangles += p.index.length / 3;
      this.stats.meshes++;
    }
    g.updateMatrixWorld(true);
    this.loaded.set(key, g);
    this.group.add(g);
    this.stats.built++;
    this.stats.ms += ms;
  }

  /** Cells still to arrive for the current point. */
  get outstanding(): number {
    return this.pending.size + this.queue.length;
  }

  /** Requests what is missing around a point and drops what is far. */
  update(x: number, z: number): void {
    const want = new Set<string>();
    this.queue.length = 0;
    for (const layer of LAYERS) {
      const radius = layer.radius * (layer.name === "far" ? 1 : this.reach);
      for (const [ix, iz] of this.cells.around(layer, x, z, radius, this.scratch)) {
        const key = `${layer.index}:${ix}:${iz}`;
        want.add(key);
        if (this.loaded.has(key) || [...this.pending.values()].includes(key)) continue;
        const dx = (ix + 0.5) * layer.size - x;
        const dz = (iz + 0.5) * layer.size - z;
        // The ground first, then what stands on it.
        const rank = layer.name === "base" ? 0 : layer.name === "detail" ? 0.5 : 1;
        this.queue.push({ key, layer, ix, iz, d2: (dx * dx + dz * dz) * (1 + rank) });
      }
    }
    this.queue.sort((a, b) => a.d2 - b.d2);
    while (this.pending.size < this.inFlight && this.queue.length) {
      const q = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, q.key);
      this.worker.postMessage({ type: "cell", id, layer: q.layer.index, ix: q.ix, iz: q.iz } satisfies WorkerRequest);
    }
    for (const [key, g] of this.loaded) {
      if (want.has(key)) continue;
      const [li, ix, iz] = key.split(":").map(Number);
      const layer = LAYERS[li];
      const dx = Math.max(ix * layer.size - x, 0, x - (ix + 1) * layer.size);
      const dz = Math.max(iz * layer.size - z, 0, z - (iz + 1) * layer.size);
      if (Math.hypot(dx, dz) < layer.radius * this.reach + layer.size) continue;
      this.group.remove(g);
      g.traverse((o) => (o as Mesh).geometry?.dispose());
      this.loaded.delete(key);
    }
  }

  dispose(): void {
    this.worker.terminate();
    for (const g of this.loaded.values()) g.traverse((o) => (o as Mesh).geometry?.dispose());
    this.loaded.clear();
  }
}
