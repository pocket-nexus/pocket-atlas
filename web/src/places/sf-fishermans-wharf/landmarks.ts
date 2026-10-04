import { CircleGeometry, CylinderGeometry, ExtrudeGeometry, Group, Path, Shape, TorusGeometry } from "three";
import type { DayWorld } from "../shared/daylight/context";
import { batchStatic } from "../shared/geo";
import { source } from "../shared/provenance";
import { bar, box, label } from "./geometry";
import { LOOP } from "./layout";

export function buildCrabWheel(w: DayWorld) {
  const g = source("landmarks/crab-wheel", w.group()); g.name = "Crab wheel at Jefferson and Taylor";
  const timber = w.lib.paint(0x5b4531, .83), rim = w.lib.paint(0xddd0ad, .68), dark = w.lib.paint(0x42372c, .7);
  // The forked pile mast is as distinctive as the sign itself.
  for (const [x, y, h, r] of [[-.4, 4.6, 9.2, .32], [.28, 5.3, 10.6, .23], [.67, 3.9, 7.8, .22]]) {
    w.mesh(new CylinderGeometry(r * .91, r, h, 9), timber, x, y, -.22, g);
    for (let b = 1; b < 8; b += 1.6) w.mesh(new TorusGeometry(r + .016, .025, 4, 9).rotateX(Math.PI / 2), dark, x, b, -.22, g);
  }
  const rope = w.lib.plain(0x8b8267, .93);
  for (let i = 0; i < 22; i++) {
    const band = w.mesh(new TorusGeometry(.60, .035, 4, 16).rotateX(Math.PI / 2), rope, .12, .65 + i * .07, -.22, g); band.scale.z = .69;
  }
  for (let i = 0; i < 12; i++) {
    const band = w.mesh(new TorusGeometry(.49, .035, 4, 16).rotateX(Math.PI / 2), rope, .13, 7.87 + i * .07, -.22, g); band.scale.z = .69;
  }
  const wheel = w.group(0, 5.8, .2, -.32, g);
  w.mesh(new CylinderGeometry(1.95, 1.95, .36, 64).rotateX(Math.PI / 2), rim, 0, 0, 0, wheel);
  for (const z of [-.21, .21]) w.mesh(new TorusGeometry(1.9, .095, 6, 64), dark, 0, 0, z, wheel);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, x = Math.sin(a), y = Math.cos(a);
    bar(w, [x * 1.84, y * 1.84, 0], [x * 2.32, y * 2.32, 0], .072, dark, wheel, 8);
    bar(w, [x * 2.22, y * 2.22, 0], [x * 2.38, y * 2.38, 0], .105, timber, wheel, 8);
  }
  const cell = w.draw("wharf/crab-wheel-face", 1024, 1024, (c, ww, hh) => {
    c.fillStyle = "#e2d6af"; c.fillRect(0, 0, ww, hh); const cx = ww / 2, cy = hh / 2;
    c.strokeStyle = "#454638"; c.lineWidth = 14; c.beginPath(); c.arc(cx, cy, ww * .462, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 7; c.beginPath(); c.arc(cx, cy, ww * .29, 0, Math.PI * 2); c.stroke();
    const arc = (txt: string, radius: number, start: number, end: number, invert = false) => {
      c.fillStyle = "#343c31"; c.font = `700 ${ww * .079}px Georgia, serif`; c.textAlign = "center"; c.textBaseline = "middle";
      [...txt].forEach((ch, i) => { const a = start + (end - start) * i / (txt.length - 1); c.save(); c.translate(cx + Math.sin(a) * radius, cy - Math.cos(a) * radius); c.rotate(a + (invert ? Math.PI : 0)); c.fillText(ch, 0, 0); c.restore(); });
    };
    arc("FISHERMAN’S WHARF", ww * .365, -1.3, 1.3); arc("OF SAN FRANCISCO", ww * .365, -1.88, -4.40, true);
    c.fillStyle = "#d75b34"; c.beginPath(); c.ellipse(cx, cy + 5, ww * .16, hh * .094, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "#ca532e"; c.lineWidth = ww * .022; c.lineCap = "round";
    for (const side of [-1, 1]) {
      for (let leg = 0; leg < 4; leg++) { c.beginPath(); c.moveTo(cx + side * ww * .1, cy + leg * 17); c.lineTo(cx + side * ww * (.22 - leg * .013), cy + 30 + leg * 25); c.lineTo(cx + side * ww * .24, cy + 5 + leg * 40); c.stroke(); }
      c.beginPath(); c.moveTo(cx + side * ww * .09, cy - 30); c.lineTo(cx + side * ww * .2, cy - 90); c.lineTo(cx + side * ww * .16, cy - 128); c.stroke();
      c.beginPath(); c.arc(cx + side * ww * .16, cy - 132, 28, .3, Math.PI * 1.65); c.stroke();
    }
    c.fillStyle = "#553e23"; c.font = `600 ${ww * .032}px Georgia`; c.textAlign = "center"; c.fillText("SAN FRANCISCO BAY", cx, cy + hh * .215);
  });
  // Circular geometry maps only within the illustrated disc; the square cell never becomes a sign silhouette.
  for (const side of [-1, 1]) {
    const geo = new CircleGeometry(1.78, 64); const uv = geo.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, cell.u0 + uv.getX(i) * (cell.u1 - cell.u0), cell.v0 + uv.getY(i) * (cell.v1 - cell.v0));
    w.mesh(geo, w.printed, 0, 0, side * .235, wheel, { ry: side < 0 ? Math.PI : 0, cast: false });
  }
  box(w, [1.6, .18, 1.2], w.lib.concrete(), [0, .03, -.2], g);
  label(w, "jefferson-street", "JEFFERSON ST", 1.75, .27, [-1.8, 3.4, .1], 0, "#174735", "#f1ecd9", g);
}

export function buildFerryArch(w: DayWorld) {
  const g = source("landmarks/pier-43-ferry-arch", w.group(209.7, 0, -103.0, 1.102));
  const stone = w.lib.stucco(0xd0cab7), edge = w.lib.paint(0xc0bda9, .82);
  const shape = new Shape(); shape.moveTo(-10.3, 0); shape.lineTo(10.3, 0); shape.lineTo(10.3, 12.6); shape.lineTo(7.5, 12.6); shape.lineTo(0, 15); shape.lineTo(-7.5, 12.6); shape.lineTo(-10.3, 12.6); shape.closePath();
  const hole = new Path(); hole.moveTo(-4.55, 0); hole.lineTo(-4.55, 6.75); hole.absarc(0, 6.75, 4.55, Math.PI, 0, true); hole.lineTo(4.55, 0); hole.closePath(); shape.holes.push(hole);
  w.mesh(new ExtrudeGeometry(shape, { depth: 6.5, bevelEnabled: false, curveSegments: 24 }), stone, 0, 0, -3.25, g);
  for (const z of [-3.28, 3.28]) {
    for (let s = -1; s <= 1; s += 2) {
      box(w, [2.05, 12.5, .3], edge, [s * 8.2, 6.25, z], g);
      for (let y = .8; y < 12; y += .6) box(w, [2.13, .065, .34], stone, [s * 8.2, y, z], g);
      box(w, [5.6, .38, .6], edge, [s * 7.6, 12.6, z], g);
      bar(w, [s * 7.6, 12.88, z], [0, 15.3, z], .20, edge, g, 4);
      bar(w, [s * 7.6, 13.14, z], [0, 15.55, z], .12, stone, g, 4);
      box(w, [.23, 6.8, .3], edge, [s * 4.73, 3.4, z], g);
    }
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 32, b = (i + 1) * Math.PI / 32;
      bar(w, [Math.cos(a) * 4.76, 6.75 + Math.sin(a) * 4.76, z], [Math.cos(b) * 4.76, 6.75 + Math.sin(b) * 4.76, z], .13, edge, g, 4);
    }
  }
  box(w, [3.9, 6.2, 6.2], stone, [-12.2, 3.1, 0], g);
  box(w, [4.25, .26, 6.55], edge, [-12.2, 6.35, 0], g);
  for (const z of [-3.55, 3.55]) {
    for (let i = -9; i <= 9; i++) {
      const y = Math.abs(i) < 7.5 ? 14.95 - Math.abs(i) * .318 : 12.57;
      box(w, [.24, .28, .33], edge, [i, y - .42, z], g);
    }
  }
  const timber = w.lib.paint(0x655b47, .88), steel = w.lib.plain(0x62584a, .8, .35);
  // The former railroad transfer bridge is equipment, not a road through the arch.
  box(w, [8.5, .25, 31], timber, [0, -.2, -11], g);
  for (let z = -26; z < 5; z += .75) box(w, [8.5, .08, .24], timber, [0, -.02, z], g);
  for (const x of [-2.35, -.91, .91, 2.35]) box(w, [.085, .1, 31], steel, [x, .08, -11], g);
  for (const x of [-4.4, 4.4]) {
    for (let z = -25; z < 4; z += 2.5) bar(w, [x, -.1, z], [x, 1.1, z], .065, steel, g);
    for (const y of [.5, 1.1]) bar(w, [x, y, -26], [x, y, 5], .055, steel, g);
  }
}

export function buildSkyStar(w: DayWorld) {
  const g = source("landmarks/skystar", w.group(203.39, 0, -44.56, .1)); g.name = "SkyStar, current waterfront location";
  const white = w.lib.plain(0xc9cbd0, .4, .25), dark = w.lib.plain(0x4d6470, .19, .45), red = w.lib.plain(0xa24e3f, .55);
  const centerY = 24.8, radius = 20.9;
  for (const z of [-3.2, 3.2]) for (const x of [-10, 10]) bar(w, [x, .5, z * 1.5], [0, centerY, z], .37, white, g, 8);
  box(w, [24, .8, 14], w.lib.concrete(), [0, .2, 0], g);
  const rotor = source("landmarks/skystar/rotor", new Group()); rotor.name = "SkyStar wheel rotor";
  for (const z of [-2.0, 2.0]) {
    w.mesh(new TorusGeometry(radius, .16, 5, 108), white, 0, 0, z, rotor);
    for (let i = 0; i < 36; i++) {
      const a = i * Math.PI / 18, b = a + Math.PI / 18;
      bar(w, [0, 0, z], [Math.sin(a) * radius, Math.cos(a) * radius, z], .044, white, rotor, 4);
      bar(w, [Math.sin(a) * radius, Math.cos(a) * radius, z], [Math.sin(b) * radius, Math.cos(b) * radius, -z], .045, white, rotor, 4);
    }
  }
  w.mesh(new CylinderGeometry(1.05, 1.05, 5, 16).rotateX(Math.PI / 2), white, 0, 0, 0, rotor);
  batchStatic(rotor); rotor.userData.dynamic = true; rotor.position.y = centerY; g.add(rotor);
  const cabins: Group[] = [];
  for (let i = 0; i < 36; i++) {
    const cabin = source(`landmarks/skystar/gondola-${i}`, new Group()); cabin.name = `SkyStar gondola ${i + 1}`;
    box(w, [1.75, .65, 2.2], white, [0, -.85, 0], cabin); box(w, [1.7, 1.15, 2.06], dark, [0, .02, 0], cabin); box(w, [1.85, .2, 2.2], white, [0, .7, 0], cabin);
    batchStatic(cabin); cabin.userData.dynamic = true; cabins.push(cabin); g.add(cabin);
  }
  w.update((_dt, t) => {
    const phase = (t % LOOP) / LOOP * Math.PI * 2; rotor.rotation.z = -phase;
    cabins.forEach((c, i) => { const a = i * Math.PI / 18 + phase; c.position.set(Math.sin(a) * radius, centerY + Math.cos(a) * radius - .65, 0); });
    w.shadowsDirty = true;
  });
  box(w, [20, 1.25, 5], red, [0, 2.7, 7.2], g);
  label(w, "skystar", "SKYSTAR", 13, 1.05, [0, 2.9, 9.8], 0, "#994a3b", "#fff1c9", g);
}
