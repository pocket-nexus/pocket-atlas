import { ExtrudeGeometry, Shape, Vector3, type Material, type Object3D } from "three";
import { box as metricBox } from "../shared/geo";
import type { DayWorld } from "../shared/daylight/context";
import { atlasPlane, rod } from "../shared/shapes";
import { fitText, LATIN } from "../shared/canvas";

export function box(w: DayWorld, size: [number, number, number], mat: Material, p: [number, number, number], parent: Object3D = w.root, ry = 0) {
  return w.mesh(metricBox(...size), mat, ...p, parent, { ry });
}
export function bar(w: DayWorld, a: number[], b: number[], radius: number, mat: Material, parent: Object3D = w.root, segments = 6) {
  return w.mesh(rod(new Vector3(a[0], a[1], a[2]), new Vector3(b[0], b[1], b[2]), radius, segments), mat, 0, 0, 0, parent);
}
export function prism(points: number[][], height: number) {
  const s = new Shape(); points.forEach((p, i) => i ? s.lineTo(p[0], -p[1]) : s.moveTo(p[0], -p[1])); s.closePath();
  return new ExtrudeGeometry(s, { depth: height, bevelEnabled: false, steps: 1 }).rotateX(-Math.PI / 2);
}
export function label(w: DayWorld, key: string, text: string, width: number, height: number, p: [number, number, number], ry = 0, bg = "#ede6cd", fg = "#252b29", parent: Object3D = w.root) {
  const r = w.draw(`wharf/${key}`, 768, 128, (g, ww, hh) => {
    g.fillStyle = bg; g.fillRect(0, 0, ww, hh); g.strokeStyle = fg; g.lineWidth = 4; g.strokeRect(7, 7, ww - 14, hh - 14);
    g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "middle"; fitText(g, text, ww / 2, hh * .52, ww - 30, hh * .64, LATIN, "700 ");
  });
  return w.mesh(atlasPlane(width, height, r), w.printed, ...p, parent, { ry, cast: false });
}
