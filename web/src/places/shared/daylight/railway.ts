import { CircleGeometry, CylinderGeometry, TorusGeometry, Vector3, type Material, type Object3D } from "three";
import { box, cable } from "../geo";
import { atlasPlane, rod, v3 } from "../shapes";
import { JP_SANS } from "../canvas";
import type { DayWorld } from "./context";

function striped(w: DayWorld, a: Vector3, b: Vector3, radius: number, parent: Object3D, interval = 0.38) {
  const n = Math.ceil(a.distanceTo(b) / interval);
  const yellow = w.lib.paint(0xdcb438), black = w.lib.paint(0x252a2a);
  for (let i = 0; i < n; i++) w.mesh(rod(a.clone().lerp(b, i / n), a.clone().lerp(b, (i + 1) / n), radius, 10), i % 2 ? black : yellow, 0, 0, 0, parent);
}

/** Open Japanese level-crossing equipment, authored in road-facing local coordinates. */
export function crossingSignal(w: DayWorld, x: number, z: number, yaw = 0): void {
  const g = w.group(x, 0, z, yaw);
  const yellow = w.lib.paint(0xdcb438), dark = w.lib.paint(0x252a2a), steel = w.lib.plain(0x777f79, 0.38, 0.7);
  w.mesh(box(0.48, 0.22, 0.48), w.lib.concrete(), 0, 0.11, 0, g);
  striped(w, v3(0, 0.21, 0), v3(0, 4.8, 0), 0.08, g);
  w.mesh(new CylinderGeometry(0.16, 0.12, 0.18, 12), dark, 0, 4.64, 0, g);
  for (const angle of [-Math.PI / 4, Math.PI / 4]) {
    const m = w.mesh(box(1.35, 0.22, 0.075), yellow, 0, 4.25, 0.025, g); m.rotation.z = angle;
  }
  // Two hooded lamps offset vertically, with ribbed lenses, backing and fasteners.
  for (const y of [2.93, 3.55]) {
    w.mesh(rod(v3(0, y, 0), v3(-0.38, y, 0.08), 0.025), steel, 0, 0, 0, g);
    const disk = w.mesh(new CylinderGeometry(0.215, 0.215, 0.09, 32), dark, -0.38, y, 0.04, g); disk.rotation.x = Math.PI / 2;
    w.mesh(new CircleGeometry(0.148, 32), w.lib.plain(0x241e21, 0.18), -0.38, y, 0.1, g);
    const rim = w.mesh(new TorusGeometry(0.159, 0.014, 6, 32), steel, -0.38, y, 0.106, g); rim.rotation.z = 0.1;
    const hood = w.mesh(new CylinderGeometry(0.18, 0.185, 0.28, 24, 1, true, 0, Math.PI * 1.16), dark, -0.38, y + 0.03, 0.2, g); hood.rotation.x = Math.PI / 2; hood.rotation.y = -Math.PI * 0.08;
    for (const dx of [-0.065, 0, 0.065]) w.mesh(box(0.007, 0.21, 0.005), w.lib.plain(0x483333, 0.3), -0.38 + dx, y, 0.109, g);
  }
  w.mesh(box(0.5, 0.48, 0.31), dark, 0, 2.15, 0.08, g);
  const arrow = w.draw("crossing-direction", 320, 272, (c, width, height) => {
    c.fillStyle = "#292f2c"; c.fillRect(0, 0, width, height);
    c.strokeStyle = "#b7bfae"; c.lineWidth = width * 0.01; c.strokeRect(width * 0.04, height * 0.04, width * 0.92, height * 0.92);
    c.fillStyle = "#b7bfae"; c.font = `${height * 0.8}px ${JP_SANS}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("←", width / 2, height * 0.49);
  });
  w.mesh(atlasPlane(0.43, 0.37, arrow), w.printed, 0, 2.15, 0.24, g);
  w.mesh(box(0.34, 0.38, 0.3), steel, 0.05, 1.55, -0.08, g);
  w.mesh(rod(v3(0.12, 0.35, -0.08), v3(0.12, 2.9, -0.08), 0.012), dark, 0, 0, 0, g);
  for (const xx of [0.17, 0.46]) w.mesh(rod(v3(xx, 0.25, -0.16), v3(xx, 3.98, -0.16), 0.018), steel, 0, 0, 0, g);
  for (let yy = 0.5; yy < 4; yy += 0.28) w.mesh(rod(v3(0.17, yy, -0.16), v3(0.46, yy, -0.16), 0.012), steel, 0, 0, 0, g);
  for (const yy of [0.4, 1.3, 2.5, 3.85]) w.mesh(new CylinderGeometry(0.1, 0.1, 0.045, 16), steel, 0, yy, 0, g);
  // Separate barrier machine, with the pole tilted very slightly away from the opening.
  w.mesh(box(0.4, 0.73, 0.58), yellow, 0.72, 0.48, 0.06, g);
  const stripe = w.mesh(box(0.43, 0.15, 0.6), dark, 0.72, 0.46, 0.06, g); stripe.rotation.z = 0.36;
  striped(w, v3(0.66, 0.78, 0.09), v3(0.82, 6.6, 0.09), 0.048, g, 0.44);
  w.mesh(new CylinderGeometry(0.105, 0.105, 0.16, 16), steel, 0.67, 0.8, 0.08, g).rotation.x = Math.PI / 2;
  for (const yy of [0.26, 0.6]) for (const xx of [0.59, 0.85]) w.mesh(new CircleGeometry(0.02, 8), steel, xx, yy, 0.356, g);
  const notice = w.draw("crossing-warning", 560, 160, (c, width, height) => {
    c.fillStyle = "#d0bb4e"; c.fillRect(0, 0, width, height); c.strokeStyle = "#363b30"; c.lineWidth = height * 0.065; c.strokeRect(width * 0.02, height * 0.055, width * 0.96, height * 0.89);
    c.fillStyle = "#32392d"; c.font = `bold ${height * 0.67}px ${JP_SANS}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("踏切注意", width / 2, height * 0.51);
  });
  w.mesh(box(0.93, 0.3, 0.075), dark, 0, 1.03, 0.03, g);
  w.mesh(atlasPlane(0.88, 0.25, notice), w.printed, 0, 1.03, 0.072, g);
}

export function safetyRail(w: DayWorld, points: Vector3[]): void {
  const g = w.root;
  for (const p of points) striped(w, p, p.clone().add(v3(0, 0.94, 0)), 0.045, g, 0.3);
  for (let i = 1; i < points.length; i++) for (const y of [0.4, 0.86]) striped(w, points[i - 1].clone().add(v3(0, y, 0)), points[i].clone().add(v3(0, y, 0)), 0.038, g, 0.38);
}

/** A narrow-gauge double line: ballast, concrete sleepers, steel rails and rubber crossing panels. */
export function railway(w: DayWorld, skew: number, halfLength = 66): void {
  const g = w.group(0, 0, 0, -Math.atan(skew));
  const ballast = w.lib.granite([0.39, 0.37, 0.4]);
  w.mesh(box(halfLength * 2, 0.25, 8.25), ballast, 0, -0.245, 0, g);
  const sleeper = w.lib.concrete([0.53, 0.5, 0.47]), rust = w.lib.plain(0x71554a, 0.83), top = w.lib.plain(0xb4b7b2, 0.29, 0.82);
  for (const center of [-1.82, 1.82]) {
    for (let x = -halfLength; x < halfLength; x += 0.66) {
      if (Math.abs(x) < 3) continue;
      w.mesh(box(0.22, 0.14, 2.05), sleeper, x, -0.075, center, g);
      for (const dz of [-0.5335, 0.5335]) {
        w.mesh(box(0.3, 0.04, 0.2), rust, x, 0.015, center + dz, g);
        for (const s of [-1, 1]) w.mesh(box(0.06, 0.05, 0.06), rust, x, 0.038, center + dz + s * 0.11, g);
      }
    }
    for (const dz of [-0.5335, 0.5335]) {
      w.mesh(box(halfLength * 2, 0.11, 0.057), rust, 0, 0.022, center + dz, g);
      w.mesh(box(halfLength * 2, 0.036, 0.074), top, 0, 0.084, center + dz, g);
      // Check rails keep road infill clear of the wheel flanges.
      w.mesh(box(5.9, 0.075, 0.048), rust, 0, 0.045, center + dz - Math.sign(dz) * 0.13, g);
    }
    w.mesh(box(5.8, 0.12, 0.84), w.lib.plain(0x393b3c, 0.97), 0, 0.018, center, g);
    for (let x = -2.9; x < 2.9; x += 0.44) w.mesh(box(0.012, 0.004, 0.82), rust, x, 0.081, center, g);
  }
  // Cable troughs, boundary mesh and overhead gantries run with the railway.
  const fence = w.lib.paint(0x768a7d, 0.57), wire = w.lib.plain(0x494b49, 0.62, 0.4);
  for (const z of [-4.25, 4.25]) for (const side of [-1, 1]) {
    w.mesh(box(halfLength - 4, 0.19, 0.34), w.lib.concrete(), side * (halfLength + 4) / 2, -0.04, z, g);
    for (let x = 4; x < halfLength; x += 2) {
      w.mesh(rod(v3(x * side, 0, z), v3(x * side, 1.32, z), 0.026), fence, 0, 0, 0, g);
      for (const yy of [0.22, 1.28]) w.mesh(rod(v3(x * side, yy, z), v3((x + 2) * side, yy, z), 0.018), fence, 0, 0, 0, g);
      for (let xx = 0; xx < 2; xx += 0.23) w.mesh(rod(v3((x + xx) * side, 0.2, z), v3((x + xx) * side, 1.28, z), 0.006), fence, 0, 0, 0, g);
    }
  }
  for (const x of [-48, -21, 20, 48]) {
    for (const z of [-4.6, 4.6]) w.mesh(rod(v3(x, -0.2, z), v3(x, 8.5, z), 0.115, 12, 0.085), w.lib.concrete(), 0, 0, 0, g);
    for (const y of [7.75, 8.35]) w.mesh(rod(v3(x, y, -4.6), v3(x, y, 4.6), 0.043), fence, 0, 0, 0, g);
    for (let z = -4.6; z < 4.5; z += 0.65) w.mesh(rod(v3(x, 7.75, z), v3(x, 8.35, z + 0.65), 0.022), fence, 0, 0, 0, g);
    for (const z of [-1.82, 1.82]) {
      w.mesh(rod(v3(x, 8.1, z), v3(x + 0.75, 5.75, z), 0.026), wire, 0, 0, 0, g);
      for (let y = 7; y < 7.35; y += 0.07) w.mesh(new CylinderGeometry(0.065, 0.065, 0.03, 12), w.lib.plain(0xb7bbb1), x + 0.28, y, z, g);
    }
  }
  for (const z of [-1.82, 1.82]) {
    w.mesh(rod(v3(-halfLength, 5.65, z), v3(halfLength, 5.65, z), 0.012), wire, 0, 0, 0, g);
    for (const [a, b] of [[-66, -48], [-48, -21], [-21, 20], [20, 48], [48, 66]]) {
      w.mesh(cable(v3(a, 7.3, z), v3(b, 7.3, z), 0.9, 0.016), wire, 0, 0, 0, g);
      for (let x = a + 3; x < b; x += 4.5) {
        const t = (x - a) / (b - a), y = 7.3 - 3.6 * t * (1 - t);
        w.mesh(rod(v3(x, 5.65, z), v3(x, y, z), 0.006), wire, 0, 0, 0, g);
      }
    }
  }
}

/** Plate helper for site-specific railway signs. */
export function sign(w: DayWorld, text: string, width: number, height: number, material: Material, at: Vector3, color = "#ede9d3", ink = "#404c45") {
  const rect = w.draw(`sign-${text}`, 480, 220, (c, cw, ch) => {
    c.fillStyle = color; c.fillRect(0, 0, cw, ch); c.fillStyle = ink;
    const lines = text.split("\n");
    const size = Math.min(cw * 0.88 / Math.max(...lines.map((s) => s.length)), ch * 0.8 / lines.length);
    c.font = `bold ${size}px ${JP_SANS}`; c.textAlign = "center"; c.textBaseline = "middle";
    lines.forEach((line, i) => c.fillText(line, cw / 2, ch / 2 + (i - (lines.length - 1) / 2) * size * 1.12));
  });
  w.mesh(box(width + 0.04, height + 0.04, 0.04), material, at.x, at.y, at.z);
  w.mesh(atlasPlane(width, height, rect), w.printed, at.x, at.y, at.z + 0.025);
}
