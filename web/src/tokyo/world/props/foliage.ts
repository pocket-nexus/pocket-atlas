import {
  BufferGeometry,
  DoubleSide,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Rng } from "../../../core/random";
import { canvas, toTexture } from "../../gfx/canvas";
import { makeDamp, type WetShared } from "../../gfx/wet";

/**
 * Four leaf shapes in a 2×2 canvas: broad (rubber plant), lance (aspidistra),
 * a small round cluster (boxwood) and a fern frond. Alpha-tested cards.
 */
function leafAtlas(): HTMLCanvasElement {
  const { c, g } = canvas(512, 512);
  g.clearRect(0, 0, 512, 512);
  const cell = 256;
  const leaf = (ox: number, oy: number, w: number, h: number, hue: number) => {
    const cx = ox + cell / 2;
    const grd = g.createLinearGradient(cx - w, oy, cx + w, oy + h);
    grd.addColorStop(0, `hsl(${hue},45%,22%)`);
    grd.addColorStop(0.5, `hsl(${hue + 6},50%,32%)`);
    grd.addColorStop(1, `hsl(${hue - 4},42%,18%)`);
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(cx, oy + cell - 8);
    g.bezierCurveTo(cx - w, oy + cell * 0.72, cx - w * 0.9, oy + cell * 0.22, cx, oy + 8 + (cell - h));
    g.bezierCurveTo(cx + w * 0.9, oy + cell * 0.22, cx + w, oy + cell * 0.72, cx, oy + cell - 8);
    g.fill();
    g.strokeStyle = `hsla(${hue},30%,60%,0.35)`;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx, oy + cell - 8);
    g.lineTo(cx, oy + 12 + (cell - h));
    g.stroke();
  };
  leaf(0, 0, 70, 240, 112);
  leaf(cell, 0, 34, 246, 104);
  // Boxwood cluster: many small round leaves.
  for (let i = 0; i < 70; i++) {
    const a = (i / 70) * Math.PI * 2 * 3.1;
    const r = 20 + (i % 9) * 9;
    const x = cell * 0.5 + Math.cos(a) * r;
    const y = cell * 1.5 + Math.sin(a) * r;
    g.fillStyle = `hsl(${100 + (i % 5) * 3},${40 + (i % 3) * 6}%,${18 + (i % 4) * 4}%)`;
    g.beginPath();
    g.ellipse(x, y, 13, 9, a, 0, Math.PI * 2);
    g.fill();
  }
  // Fern frond: a rachis with paired pinnae.
  const fx = cell * 1.5;
  g.strokeStyle = "hsl(98,40%,24%)";
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(fx, cell * 2 - 6);
  g.lineTo(fx, cell + 10);
  g.stroke();
  for (let k = 0; k < 16; k++) {
    const y = cell * 2 - 16 - k * 14;
    const len = 90 * Math.sin(((k + 1) / 17) * Math.PI) + 12;
    g.fillStyle = `hsl(${100 + (k % 3) * 4},46%,${24 + (k % 2) * 4}%)`;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(fx + s * len * 0.5, y - 4, len * 0.5, 6, s * -0.25, 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}

export type LeafKind = 0 | 1 | 2 | 3;

export class Foliage {
  readonly material: MeshStandardMaterial;

  constructor(wet: WetShared) {
    const tex = toTexture(leafAtlas());
    const m = new MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: DoubleSide, roughness: 0.42, metalness: 0 });
    // Rain-wet leaves: glossy, a touch darker.
    this.material = makeDamp(m, wet, { darken: 0.85, roughness: 0.55, streaks: 0 });
    this.material.name = "foliage";
  }

  /**
   * A clump of leaf cards around the origin (base at y = 0): leaves spray out
   * from the stems, upper ones more upright, lower ones drooping.
   */
  clump(r: Rng, kind: LeafKind, radius: number, height: number, count: number): BufferGeometry {
    const parts: BufferGeometry[] = [];
    const u0 = (kind % 2) * 0.5;
    const v0 = kind < 2 ? 0.5 : 0;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < count; i++) {
      const size = radius * (kind === 2 ? 0.55 : 0.7) * r.range(0.75, 1.2);
      const g = new PlaneGeometry(size * (kind === 1 ? 0.45 : 0.8), size * 1.3);
      g.translate(0, size * 0.62, 0);
      const uv = g.getAttribute("uv");
      for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * 0.5, v0 + uv.getY(k) * 0.5);
      const t = i / count;
      const yaw = t * Math.PI * 2 * 2.618 + r.range(-0.3, 0.3);
      const hgt = height * (0.25 + 0.75 * Math.sqrt(r.next()));
      const tilt = (1 - hgt / height) * 1.1 + r.range(0.25, 0.6);
      const dir = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      // Stand the card up, lean it outward by `tilt`, then spin it about its own axis.
      q.setFromAxisAngle(up, yaw);
      const lean = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tilt);
      const twist = new Quaternion().setFromAxisAngle(up, r.range(-0.6, 0.6));
      q.multiply(lean).multiply(twist);
      const pos = dir.multiplyScalar(radius * 0.25 * r.next()).setY(hgt * 0.55);
      m.compose(pos, q, new Vector3(1, 1, 1));
      g.applyMatrix4(m);
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false)!;
    for (const p of parts) p.dispose();
    return merged;
  }
}
