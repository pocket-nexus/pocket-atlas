/**
 * Rasterises the 1:10m land polygons around one point into a square-ish
 * lat/lon patch. The fly-in reads it for a coastline ~40× sharper than the
 * global mask. Runs off the main thread: the source file is ~3 MB.
 */
import { feature } from "topojson-client";
import type { MultiPolygon, Topology } from "topojson-specification";
import type { CoastRequest, CoastResult } from "./coastPatch";

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<CoastRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent<CoastRequest>) => {
  const req = e.data;
  try {
    const res = await fetch(req.url);
    if (!res.ok) throw new Error(`land-10m.json: HTTP ${res.status}`);
    const topo = (await res.json()) as Topology;
    const data = rasterize(topo, req);
    const out: CoastResult = { ...req, data };
    ctx.postMessage(out, [data.buffer]);
  } catch (err) {
    ctx.postMessage({ ...req, error: (err as Error).message });
  }
};

function rasterize(topo: Topology, req: CoastRequest): Uint8Array {
  const { lat, lon, halfLat, halfLon, size } = req;
  const minLat = lat - halfLat;
  const maxLat = lat + halfLat;
  const minLon = lon - halfLon;
  const maxLon = lon + halfLon;

  // Arc bounding boxes from the delta-encoded, quantised arcs.
  const t = topo.transform!;
  const boxes = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [dx, dy] of arc) {
      x += dx;
      y += dy;
      const px = x * t.scale[0] + t.translate[0];
      const py = y * t.scale[1] + t.translate[1];
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    return [x0, y0, x1, y1];
  });
  const hits = (i: number) => {
    const b = boxes[i < 0 ? ~i : i];
    return b[2] >= minLon && b[0] <= maxLon && b[3] >= minLat && b[1] <= maxLat;
  };

  const land = topo.objects.land as unknown as { type: string; geometries: { type: string; arcs: number[][][] | number[][] }[] };
  const polys: number[][][] = [];
  for (const g of land.geometries) {
    const list = g.type === "Polygon" ? [g.arcs as number[][]] : (g.arcs as number[][][]);
    for (const poly of list) if (poly.some((ring) => ring.some(hits))) polys.push(poly);
  }

  const canvas = new OffscreenCanvas(size, size);
  const c2d = canvas.getContext("2d", { willReadFrequently: true })!;
  c2d.fillStyle = "#000";
  c2d.fillRect(0, 0, size, size);
  if (polys.length) {
    const geo: MultiPolygon = { type: "MultiPolygon", arcs: polys };
    const f = feature(topo, geo);
    c2d.fillStyle = "#fff";
    c2d.beginPath();
    const sx = size / (maxLon - minLon);
    const sy = size / (maxLat - minLat);
    for (const poly of f.geometry.coordinates) {
      for (const ring of poly) {
        ring.forEach(([x, y], i) => {
          const px = (x - minLon) * sx;
          const py = (maxLat - y) * sy;
          if (i === 0) c2d.moveTo(px, py);
          else c2d.lineTo(px, py);
        });
        c2d.closePath();
      }
    }
    c2d.fill("evenodd");
  }
  const rgba = c2d.getImageData(0, 0, size, size).data;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
  return out;
}
