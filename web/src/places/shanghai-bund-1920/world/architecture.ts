import { CircleGeometry, CylinderGeometry, ExtrudeGeometry, Group, Shape, SphereGeometry, TorusGeometry, Vector3, type Material } from "three";
import type { DayWorld } from "../../shared/daylight/context";
import { box } from "../../shared/geo";
import { mapUV } from "../../shared/atlas";
import { atlasPlane, rod } from "../../shared/shapes";
import { source } from "../../shared/provenance";

/** Building-local frontage faces +X, width runs along Z. Metres; see README for evidence grades. */
export function block(w: DayWorld, p: Group, mat: Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  return w.mesh(box(sx, sy, sz), mat, x, y, z, p);
}
export function bar(w: DayWorld, p: Group, mat: Material, a: number[], b: number[], radius: number, radial = 6) {
  return w.mesh(rod(new Vector3(...a), new Vector3(...b), radius, radial), mat, 0, 0, 0, p);
}
export function label(w: DayWorld, p: Group, key: string, text: string, width: number, height: number, x: number, y: number, z: number, bg = "#d6cbbb", ink = "#332d26") {
  const r = w.draw(`bund-${key}`, 768, 128, (g, sw, sh) => {
    g.fillStyle = bg; g.fillRect(0, 0, sw, sh); g.fillStyle = ink;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `bold ${Math.floor(sh * 0.58)}px Georgia, "Noto Serif CJK SC", serif`;
    g.fillText(text, sw / 2, sh / 2, sw * 0.94);
  });
  const m = w.mesh(atlasPlane(width, height, r), w.printed, x, y, z, p);
  m.rotation.y = Math.PI / 2;
  return m;
}

function gable(w: DayWorld, p: Group, mat: Material, x: number, y: number, z: number, width: number, rise: number, depth: number) {
  const s = new Shape(); s.moveTo(-width / 2, 0); s.lineTo(width / 2, 0); s.lineTo(0, rise); s.closePath();
  const geo = new ExtrudeGeometry(s, { depth, bevelEnabled: false, steps: 1 });
  geo.rotateY(Math.PI / 2); geo.translate(x - depth, y, z);
  w.mesh(geo, mat, 0, 0, 0, p);
}
function window(w: DayWorld, p: Group, x: number, y: number, z: number, width: number, height: number, trim: Material, arch = false) {
  // The dark recess, sill, lintel and jambs are geometry; normal mapping is not relied on at distance.
  block(w, p, w.lib.glass("dark"), x, y, z, 0.06, height, width);
  for (const s of [-1, 1]) block(w, p, trim, x + 0.1, y, z + s * (width / 2 + 0.08), 0.22, height + 0.3, 0.16);
  block(w, p, trim, x + 0.15, y - height / 2 - 0.12, z, 0.42, 0.24, width + 0.48);
  block(w, p, trim, x + 0.1, y + height / 2 + 0.09, z, 0.25, 0.18, width + 0.34);
  block(w, p, trim, x + 0.15, y, z, 0.09, height, 0.09);
  block(w, p, trim, x + 0.15, y + height * 0.14, z, 0.09, 0.1, width);
  if (arch) {
    const a = new Shape(); a.moveTo(-width / 2 - 0.22, 0); a.quadraticCurveTo(0, width * 0.9, width / 2 + 0.22, 0);
    a.lineTo(width / 2, 0); a.quadraticCurveTo(0, width * 0.6, -width / 2, 0); a.closePath();
    const geo = new ExtrudeGeometry(a, { depth: 0.22, bevelEnabled: false, curveSegments: 6 });
    geo.rotateY(Math.PI / 2); w.mesh(geo, trim, x, y + height / 2, z, p);
  }
}
function dentils(w: DayWorld, p: Group, mat: Material, x: number, y: number, width: number, z = 0) {
  for (let dz = -width / 2; dz <= width / 2; dz += 0.82) block(w, p, mat, x, y, z + dz, 0.35, 0.24, 0.3);
}
function column(w: DayWorld, p: Group, mat: Material, x: number, y: number, z: number, height: number, radius: number) {
  w.mesh(new CylinderGeometry(radius * 0.83, radius, height, 10), mat, x, y + height / 2, z, p);
  for (const yy of [y, y + height]) block(w, p, mat, x, yy, z, radius * 2.8, 0.28, radius * 2.8);
  w.mesh(new CylinderGeometry(radius * 1.23, radius * 1.1, 0.22, 10), mat, x, y + height - 0.2, z, p);
}
function balustrade(w: DayWorld, p: Group, mat: Material, x: number, y: number, width: number, z: number) {
  for (const yy of [0, 0.95]) block(w, p, mat, x, y + yy, z, 0.45, 0.18, width);
  for (let dz = -width / 2 + 0.45; dz < width / 2; dz += 0.62) {
    w.mesh(new CylinderGeometry(0.09, 0.1, 0.75, 6), mat, x, y + 0.47, z + dz, p);
    w.mesh(new SphereGeometry(0.15, 6, 4), mat, x, y + 0.5, z + dz, p);
  }
}

function customs(w: DayWorld) {
  const p = source("bund/customs-house-1893", w.group()); p.name = "Customs House 1893 — 135 ft frontage, 110 ft tower";
  const brick = w.lib.brickWall(0x6b3d30), stone = w.lib.stucco(0x9a9e93), roof = w.lib.tileRoof(0x683e32);
  const width = 41.148, depth = 47.244;
  // Three-storey gabled wings are ahead of the recessed centre; not the 1927 monumental block.
  block(w, p, brick, -(depth + 16) / 2, 8.7, 0, depth - 16, 17.4, width);
  // Front court removed from the opaque core by using side/rear wings rather than a facade slab.
  // The two front wings and centre tower give the Tudor silhouette of the 1908 frontal photograph.
  for (const z of [-15.75, 15.75]) {
    block(w, p, brick, -8, 9.1, z, 16, 18.2, 9.65);
    gable(w, p, brick, 0.02, 18.2, z, 9.65, 5.8, 0.32);
    for (const s of [-1, 1]) {
      const slab = block(w, p, roof, -20, 21.1, z + s * 2.45, 40.6, 0.22, 7.55);
      slab.rotation.x = s * Math.atan2(5.8, 4.825);
      bar(w, p, stone, [0.18, 18.2, z + s * 4.92], [0.18, 24.12, z], 0.13);
      w.mesh(new CylinderGeometry(0.18, 0.27, 2, 6), stone, 0.03, 19.1, z + s * 4.6, p);
      w.mesh(new CylinderGeometry(0, 0.4, 0.7, 6), stone, 0.03, 20.45, z + s * 4.6, p);
    }
    for (let row = 0; row < 3; row++) for (let col = -1; col <= 1; col++) {
      window(w, p, 0.06, 3.3 + row * 5.1, z + col * 2.9, col === 0 ? 2.2 : 1.65, 3.15, stone, row === 2 && col === 0);
    }
    for (const dz of [-1, 1]) window(w, p, 0.07, 20.05, z + dz * 1.12, 0.8, 2.05, stone);
    for (const y of [0.85, 6, 11.1, 16.9]) block(w, p, stone, 0.05, y, z, 0.25, 0.3, 9.85);
    for (const dz of [-4.65, 4.65]) for (let y = 1.2; y < 17.9; y += 0.65) block(w, p, stone, 0.07, y, z + dz, 0.28, 0.31, y % 1.3 < 0.7 ? 0.64 : 0.36);
  }
  // Windowed inner returns, plainly visible in Wright's 1908 frontal photograph.
  for (const side of [-1, 1]) {
    const inner = w.group(-8, 0, side * 10.9, side * Math.PI / 2, p);
    for (let row = 0; row < 3; row++) for (let col = -1; col <= 1; col++) window(w, inner, 0.1, 3.3 + row * 5.1, col * 4.7, 2.1, 3.15, stone);
    for (const y of [0.85, 6, 11.1, 16.9]) block(w, inner, stone, 0.05, y, 0, 0.25, 0.3, 16);
  }
  for (const z of [-7.4, 7.4]) for (let row = 0; row < 3; row++) window(w, p, -15.9, 3.3 + row * 5.1, z, 2.5, 3.15, stone);
  // Tower stands slightly back; castellated crown with four pinnacles, no spire.
  block(w, p, brick, -4.1, 15.7, 0, 7.4, 31.4, 6.5);
  for (const y of [5.8, 11.1, 16.8, 22, 26.2, 30.8]) block(w, p, stone, -0.29, y, 0, 0.26, 0.26, 6.75);
  for (const z of [-3.1, 3.1]) block(w, p, stone, -0.29, 15.6, z, 0.3, 31.1, 0.32);
  for (const y of [3.3, 8.55, 13.55]) window(w, p, -0.31, y, 0, 2.15, 3.3, stone);
  for (const z of [-0.8, 0.8]) {
    window(w, p, -0.31, 21.2, z, 0.8, 4.1, stone, true);
    for (let y = 19.5; y < 23.1; y += 0.32) block(w, p, brick, -0.08, y, z, 0.2, 0.12, 0.77);
  }
  const dial = w.draw("bund-customs-clock", 512, 512, (g, sw, sh) => {
    g.fillStyle = "#a7a394"; g.fillRect(0, 0, sw, sh); g.fillStyle = "#e3dbc6";
    g.beginPath(); g.arc(sw / 2, sh / 2, sw * 0.47, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#33302d"; g.lineWidth = sw * 0.012;
    for (let i = 0; i < 60; i++) { const a = i * Math.PI / 30; const r = i % 5 ? 0.425 : 0.37;
      g.beginPath(); g.moveTo(sw / 2 + Math.sin(a) * sw * r, sh / 2 - Math.cos(a) * sh * r);
      g.lineTo(sw / 2 + Math.sin(a) * sw * 0.455, sh / 2 - Math.cos(a) * sh * 0.455); g.stroke(); }
    g.fillStyle = "#38352e"; g.font = `bold ${Math.round(sw * 0.085)}px Georgia,serif`; g.textAlign = "center"; g.textBaseline = "middle";
    const roman = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; g.fillText(roman[i], sw * (0.5 + Math.sin(a) * 0.325), sh * (0.5 - Math.cos(a) * 0.325)); }
    g.lineWidth = sw * 0.035; g.beginPath(); g.moveTo(sw * 0.5, sh * 0.5); g.lineTo(sw * 0.3, sh * 0.38); g.stroke();
    g.lineWidth = sw * 0.022; g.beginPath(); g.moveTo(sw * 0.5, sh * 0.5); g.lineTo(sw * 0.5, sh * 0.14); g.stroke();
  });
  for (let side = 0; side < 4; side++) {
    const g = w.group(-4, 0, 0, side * Math.PI / 2, p);
    const m = w.mesh(mapUV(new CircleGeometry(1.675, 40), dial), w.printed, 3.74, 27.7, 0, g); m.rotation.y = Math.PI / 2;
    const rim = w.mesh(new TorusGeometry(1.75, 0.1, 6, 40), stone, 3.76, 27.7, 0, g); rim.rotation.y = Math.PI / 2;
  }
  for (let z = -2.7; z <= 2.7; z += 1.08) block(w, p, brick, -0.45, 31.85, z, 0.55, 0.9, 0.58);
  for (const x of [-7.5, -0.5]) for (const z of [-3, 3]) {
    block(w, p, stone, x, 31.4, z, 0.64, 2.5, 0.64);
    w.mesh(new CylinderGeometry(0, 0.43, 0.95, 4), stone, x, 33.054, z, p, { ry: Math.PI / 4 });
  }
  label(w, p, "customs-name", "江 海 關", 3.3, 0.65, -0.12, 16.05, 0, "#a9aaa0", "#4c4840");
  for (const z of [-9, -5, 5, 9]) {
    block(w, p, stone, 1.3, 1.35, z, 0.55, 2.7, 0.55);
    w.mesh(new CylinderGeometry(0, 0.43, 0.8, 6), stone, 1.3, 3.02, z, p);
  }
  for (const z of [-7, 0, 7]) for (let zz = z - 1.7; zz < z + 1.8; zz += 0.25) block(w, p, w.lib.paint(0x373b38), 1.3, 1.35, zz, 0.065, 2.15, 0.055);
  // Rear and visible north return carry the same storey rhythm.
  for (let i = 0; i < 10; i++) for (let row = 0; row < 3; row++) {
    const g = w.group(-4.5 - i * 4, 0, -20.66, Math.PI / 2, p);
    window(w, g, 0, 3.3 + row * 5.1, 0, 1.6, 3, stone);
  }
}

function oldBank(w: DayWorld) {
  const p = source("bund/hsbc-1875", w.group(-0.7, 0, 46)); p.name = "HSBC 1875 office — pre-redevelopment interpretation";
  const stone = w.lib.stucco(0xb5af9f), trim = w.lib.stucco(0xd2c9b8), roof = w.lib.tileRoof(0x56524a);
  block(w, p, stone, -18, 8.4, 0, 36, 16.8, 37);
  for (const y of [0.6, 5.5, 10.8, 16.3, 17]) block(w, p, trim, 0.14, y, 0, 0.4, 0.36, 37.5);
  for (let col = 0; col < 9; col++) for (let row = 0; row < 3; row++) window(w, p, 0.09, 3.1 + row * 5.15, (col - 4) * 3.9, 1.75, 3.2, trim, row === 1);
  for (let side = 0; side < 2; side++) {
    const g = w.group(-18, 0, (side ? -1 : 1) * 18.6, side ? Math.PI / 2 : -Math.PI / 2, p);
    for (let col = 0; col < 8; col++) for (let row = 0; row < 3; row++) window(w, g, 0.05, 3.1 + row * 5.15, (col - 3.5) * 4.1, 1.65, 3.2, trim);
  }
  for (const s of [-1, 1]) { const m = block(w, p, roof, -18, 18.75, s * 9.3, 36.7, 0.22, 19.1); m.rotation.x = s * 0.2; }
  dentils(w, p, trim, 0.4, 16.68, 37);
  for (let z = -15; z <= 15; z += 7.5) { block(w, p, stone, -8, 20.5, z, 1.2, 3.8, 0.85); block(w, p, trim, -8, 22.45, z, 1.45, 0.3, 1.1); }
  // Projecting ground-floor classical portico and upper balustrade from the 1908 bank photograph.
  block(w, p, trim, 2.9, 5.7, 0, 6.8, 0.5, 14.3);
  for (const z of [-6, -3.8, 3.8, 6]) column(w, p, trim, 5.7, 0.65, z, 4.7, 0.35);
  gable(w, p, trim, 6.32, 6, 0, 8.5, 1.85, 0.32);
  balustrade(w, p, trim, 5.8, 6.2, 14.2, 0);
  for (let i = 0; i < 4; i++) block(w, p, trim, 6.4 + i * 0.36, 0.62 - i * 0.15, 0, 0.7, 0.15, 14.4 + i * 0.2);
  label(w, p, "old-bank-name", "HONGKONG & SHANGHAI BANK", 13, 0.65, 6.37, 5.64, 0);
}

function northBanks(w: DayWorld) {
  // A low corner office at Hankow and the former Deutsch-Asiatische Bank are visible in the 1919/1920 plates.
  const stone = w.lib.stucco(0xb8b3a4), trim = w.lib.stucco(0xd8d0bf), roof = w.lib.sheetRoof(0x565b58);
  const corner = source("bund/hankow-corner-office", w.group(-1, 0, -42));
  block(w, corner, stone, -17, 7.1, 0, 34, 14.2, 23);
  for (let i = -2; i <= 2; i++) for (let row = 0; row < 2; row++) window(w, corner, 0.08, 3.4 + row * 5.4, i * 4.2, 1.9, 3.35, trim);
  for (const y of [0.7, 6, 12.9, 14.3]) block(w, corner, trim, 0.2, y, 0, 0.55, 0.34, 23.5);
  const p = source("bund/former-deutsch-asiatische-bank", w.group(-1, 0, -74));
  block(w, p, stone, -17.5, 11.2, 0, 35, 22.4, 30);
  for (let col = -3; col <= 3; col++) for (let row = 0; row < 4; row++) window(w, p, 0.08, 3.2 + row * 5.15, col * 4.05, 1.9, 3.4, trim, row === 2);
  for (const y of [0.8, 5.7, 10.8, 16.1, 21.8, 23]) block(w, p, trim, 0.18, y, 0, 0.6, 0.35, 30.6);
  dentils(w, p, trim, 0.4, 22.55, 30);
  for (const z of [-13.5, 13.5]) { block(w, p, trim, 0.24, 14.4, z, 0.6, 14, 0.85); }
  // Cupola geometry is a conservative reading of the period plate, not a survey of the lost roof.
  w.mesh(new CylinderGeometry(3.4, 4, 3.2, 8), stone, -5, 24.8, -10.3, p);
  w.mesh(new SphereGeometry(3.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), roof, -5, 26.4, -10.3, p);
  w.mesh(new CylinderGeometry(0.8, 1.05, 1.2, 8), stone, -5, 29.65, -10.3, p);
  w.mesh(new SphereGeometry(1.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), roof, -5, 30.25, -10.3, p);
  bar(w, p, w.lib.paint(0x454b46), [-5, 31.25, -10.3], [-5, 32.1, -10.3], 0.055);
  const r = source("bund/russo-asiatic-bank-1902", w.group(-1, 0, -110));
  block(w, r, stone, -16, 8.9, 0, 32, 17.8, 30);
  for (let col = -3; col <= 3; col++) for (let row = 0; row < 3; row++) window(w, r, 0.08, 3.15 + row * 5.3, col * 4.1, 1.85, 3.3, trim, row === 1);
  for (const z of [-6.4, -2.15, 2.15, 6.4]) column(w, r, trim, 0.6, 5.9, z, 9.7, 0.44);
  for (const y of [0.7, 5.5, 16.3, 18]) block(w, r, trim, 0.35, y, 0, 0.8, 0.4, 30.4);
  balustrade(w, r, trim, 0.4, 18.3, 30, 0);
}

function southernOffices(w: DayWorld) {
  const wall = w.lib.stucco(0xb0aa97), trim = w.lib.stucco(0xcec6b3);
  // 1920 redevelopment plot south of the old bank; unnamed low offices avoid false tenant precision.
  for (const [z, width, height] of [[82, 26, 11], [111, 23, 14.5], [145, 36, 17.5], [-152, 33, 16]] as const) {
    const p = source(`bund/period-office-${z}`, w.group(-2, 0, z));
    block(w, p, wall, -17, height / 2, 0, 34, height, width);
    const rows = Math.floor(height / 4.5), columns = Math.floor(width / 4);
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) window(w, p, 0.07, 2.5 + row * 4.4, (col - (columns - 1) / 2) * 3.9, 1.7, 2.8, trim, row === 0);
    for (let row = 0; row <= rows; row++) block(w, p, trim, 0.1, row * 4.4 + 0.6, 0, 0.4, 0.23, width + 0.3);
    block(w, p, trim, -17, height + 0.2, 0, 35, 0.4, width + 0.8);
    for (let z0 = -width / 2 + 3; z0 < width / 2; z0 += 6) block(w, p, wall, -22, height + 1.6, z0, 0.8, 2.8, 0.75);
  }
}

export function buildArchitecture(w: DayWorld) { customs(w); oldBank(w); northBanks(w); southernOffices(w); }
