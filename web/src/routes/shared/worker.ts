/// <reference lib="webworker" />
import { buildCell } from "./cell";
import { Cells } from "./layers";
import { transferables, type CellData } from "./mesh";
import { RouteSource, type RouteFiles } from "./source";
import { RouteWorld } from "./world";

/**
 * Builds cells off the page's thread. The page sends the route's files
 * once, then asks for cells by layer and index; each comes back with its
 * buffers transferred.
 */
export type WorkerRequest = { type: "init"; files: RouteFiles } | { type: "cell"; id: number; layer: number; ix: number; iz: number };
export type WorkerReply = { type: "ready"; roads: number; junctions: number } | { type: "cell"; id: number; cell: CellData; ms: number } | { type: "error"; id: number; message: string };

let world: RouteWorld | null = null;
let cells: Cells | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === "init") {
    world = new RouteWorld(await RouteSource.decode(m.files));
    cells = new Cells(world.main.line);
    ctx.postMessage({ type: "ready", roads: world.roads.length, junctions: world.junctions.length } satisfies WorkerReply);
    return;
  }
  try {
    if (!world || !cells) throw new Error("worker not initialised");
    const t0 = performance.now();
    const cell = buildCell(world, cells, m.layer, m.ix, m.iz);
    ctx.postMessage({ type: "cell", id: m.id, cell, ms: performance.now() - t0 } satisfies WorkerReply, transferables(cell));
  } catch (err) {
    ctx.postMessage({ type: "error", id: m.id, message: (err as Error).message } satisfies WorkerReply);
  }
};
