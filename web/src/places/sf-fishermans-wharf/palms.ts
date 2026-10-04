import { BufferGeometry, CylinderGeometry, Float32BufferAttribute } from "three";
import type { DayWorld } from "../shared/daylight/context";
import { canvas, toTexture } from "../shared/canvas";
import { source } from "../shared/provenance";

/** Date-palm fronds visible in the 2026 Jefferson/Taylor references: cut-out leaflets on curved cards. */
export function buildPalms(w: DayWorld) {
  const { c, g } = canvas(256, 512); g.clearRect(0, 0, 256, 512);
  g.strokeStyle = "#626848"; g.lineWidth = 5; g.beginPath(); g.moveTo(128, 510); g.lineTo(128, 8); g.stroke();
  for (let i = 0; i < 30; i++) {
    const t = .08 + i * .027, yy = 506 - t * 490, reach = Math.sin(Math.PI * t) * 112;
    for (const side of [-1, 1]) {
      g.fillStyle = i % 3 ? "#667447" : "#788554";
      g.beginPath(); g.moveTo(127, yy + 14); g.quadraticCurveTo(128 + side * reach * .62, yy - 2, 128 + side * reach, yy - 41); g.quadraticCurveTo(128 + side * reach * .64, yy - 13, 128, yy + 3); g.closePath(); g.fill();
    }
  }
  const leaf = w.lib.cutout("wharf-date-palm", toTexture(c), { rough: .78 }), bark = w.lib.bark(0x92826b);
  for (const [x, z, height] of [[24, -1, 8.8], [33, -4, 9.5], [112, -15, 8.3]]) {
    const root = source(`planting/date-palm-${x}`, w.group(x, 0, z));
    w.mesh(new CylinderGeometry(.25, .36, height, 10, 4), bark, 0, height / 2, 0, root);
    // Persistent leaf bases make the trunk's broken diamond rhythm visible near the sign.
    for (let i = 0; i < 18; i++) {
      const m = w.mesh(new CylinderGeometry(.31, .35, .16, 8), bark, 0, height - i * .23, 0, root); m.rotation.y = (i % 2) * Math.PI / 8;
    }
    for (let j = 0; j < 22; j++) {
      const a = j * Math.PI * 2 / 11 + (j > 10 ? .28 : 0), length = j < 11 ? 4.2 : 3.25, lift = j < 11 ? 1.9 : 3.25;
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8, width = .85, r = t * length, y = height + Math.sin(t * Math.PI * .8) * lift - t * (j < 11 ? 2 : .25);
        for (const side of [-1, 1]) { pos.push(Math.sin(a) * r + Math.cos(a) * width * side, y, Math.cos(a) * r - Math.sin(a) * width * side); uv.push((side + 1) / 2, t); }
        if (k < 8) { const n = k * 2; idx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
      }
      const geo = new BufferGeometry(); geo.setAttribute("position", new Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals(); w.mesh(geo, leaf, 0, 0, 0, root);
    }
  }
}
