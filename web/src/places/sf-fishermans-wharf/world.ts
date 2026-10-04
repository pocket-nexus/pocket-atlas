import { BufferGeometry, Float32BufferAttribute, Color, CylinderGeometry, PlaneGeometry, SphereGeometry, TorusGeometry, Vector3 } from "three";
import { foliage } from "../shared/daylight/foliage";
import type { DayWorld } from "../shared/daylight/context";
import { source } from "../shared/provenance";
import { BUILDINGS, COAST, ROADS } from "./layout";
import { bar, box, label, prism } from "./geometry";

/** OSM plan, then photo-based facade relief; no downloaded image is a shipped texture. */
export function buildGround(w: DayWorld) {
  const water = w.water({ name: "sheltered-bay", waves: [
    { repeatsPerMetre: .25, scroll: [1 / 15, 0] }, { repeatsPerMetre: .5, scroll: [0, 1 / 30] },
  ], slope: .22, roughness: .22, distanceRoughness: .000045, mask: .08, body: new Color(.045, .105, .09), envMapIntensity: .86 }, { seed: 1884, heading: -.8, size: 512, strength: .22 });
  const sea = source("bay/water", w.mesh(new PlaneGeometry(12000, 12000, 1, 1).rotateX(-Math.PI / 2), water.material, 0, -2.1, -4200, w.root, { cast: false, receive: false }));
  sea.name = "San Francisco Bay";
  source("coast/osm-32648495", w.mesh(prism([...COAST, [-950, 500], [720, 500]], 1.6), w.lib.concrete([.88, .88, .81]), 0, -1.65, 0));
  // Separate road ribbons retain the surveyed Jefferson/Taylor skew and leave the basin open.
  for (const r of ROADS) for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1], b = r.points[i], dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dz, dx);
    source(`street/osm-${r.osm}/${i}`, box(w, [len + .3, .08, r.width], w.lib.asphalt(4, 0xb7b2a5), [(a[0] + b[0]) / 2, .01, (a[1] + b[1]) / 2], w.root, yaw));
    for (const side of [-1, 1]) {
      const nx = -dz / len * (r.width / 2 + .2) * side, nz = dx / len * (r.width / 2 + .2) * side;
      box(w, [len, .19, .38], w.lib.concrete([1.03, 1, .9]), [(a[0] + b[0]) / 2 + nx, .055, (a[1] + b[1]) / 2 + nz], w.root, yaw);
    }
  }
  // F-Market rails run west on Jefferson. They do not continue north up Taylor.
  for (const offset of [-.7175, .7175]) bar(w, [-165, .074, 38 + offset], [270, .074, -30.4 + offset], .032, w.lib.plain(0x4d5050, .3, .75));
  for (let x = -4; x < 6; x += 1.3) box(w, [.62, .015, 7.8], w.lib.roadPaint(0xddcfad), [x, .066, 13], w.root, .157);
  for (let z = -21; z < -9; z += 1.3) box(w, [9, .015, .62], w.lib.roadPaint(0xdac9a6), [-7, .066, z]);
  // Seawall piles and fenders follow the real shoreline; the water stays below the deck.
  for (let i = 1; i < COAST.length; i++) {
    const a = COAST[i - 1], b = COAST[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (Math.max(Math.abs(a[0]), Math.abs(b[0])) > 450 || a[1] > 40 || len < 8) continue;
    const count = Math.ceil(len / 8);
    for (let j = 0; j < count; j++) {
      const u = j / count, x = a[0] + (b[0] - a[0]) * u, z = a[1] + (b[1] - a[1]) * u;
      w.mesh(new CylinderGeometry(.32, .4, 4.4, 7), w.lib.paint(0x5a5241, .8), x, -1.4, z);
      box(w, [.65, 1.7, .52], w.lib.plain(0x282e2b), [x, -1, z]);
    }
  }
  for (let x = -140; x < -53; x += 2.8) {
    box(w, [.14, .04, 7], w.lib.plain(0x858578), [x, .06, 20 - (x + 145) * .157]);
  }
  for (let i = 0; i < 12; i++) {
    const x = -120 + i * 25, z = 17 - x * .157;
    w.mesh(new CylinderGeometry(.37, .37, .045, 16), w.lib.plain(0x53574f, .7, .35), x, .063, z);
    for (let k = -2; k <= 2; k++) box(w, [.44, .018, .025], w.lib.plain(0x303a36), [x, .091, z + k * .07]);
  }
}

export function buildBuildings(w: DayWorld) {
  const palette = [0xb8ac91, 0xc7bfaa, 0xa19983, 0xc5b596, 0xaea79b, 0x9d7960];
  const window = w.lib.glass("dark"), trim = w.lib.paint(0xc5c0ad, .75);
  for (let n = 0; n < BUILDINGS.length; n++) {
    const b = BUILDINGS[n], shed = b.name.startsWith("Shed"), h = b.height;
    if (b.osm === 37312428) continue; // Boudin's glazed gable and timber roof are authored below.
    const mat = shed ? w.lib.stucco(0x979384) : w.lib.stucco(palette[n % palette.length]);
    const root = source(`buildings/osm-${b.osm}`, w.group()); root.name = b.name;
    w.mesh(prism(b.points, h), mat, 0, .1, 0, root);
    w.mesh(prism(b.points, .22), w.lib.sheetRoof(shed ? 0x656963 : 0x77776d), 0, h + .1, 0, root);
    const area = b.points.reduce((s, p, i) => { const q = b.points[(i + 1) % b.points.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
    const side = area > 0 ? -1 : 1;
    for (let i = 0; i < b.points.length; i++) {
      const a = b.points[i], c = b.points[(i + 1) % b.points.length], dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
      if (len < 3) continue;
      const yaw = Math.atan2(-dz, dx), edge = w.group((a[0] + c[0]) / 2, 0, (a[1] + c[1]) / 2, yaw, root);
      box(w, [len, .26, .22], trim, [0, h - .25, side * .09], edge);
      if (shed) {
        const bays = Math.max(1, Math.floor(len / 7.5)), spacing = len / bays;
        for (let j = 0; j < bays; j++) {
          const xx = -len / 2 + spacing * (j + .5), ww = spacing - .75;
          // Broad loading shutters at ground level and continuous clerestory are documented on Pier 45.
          box(w, [ww, 4.35, .07], w.lib.paint(j % 4 === 0 ? 0x414a44 : 0x737a70, .87), [xx, 2.33, side * .10], edge);
          box(w, [ww, 1.2, .05], window, [xx, h - 1.2, side * .14], edge);
          box(w, [.45, h - .7, .31], mat, [xx - spacing / 2, (h - .7) / 2, side * .17], edge);
          box(w, [ww + .2, .18, .2], trim, [xx, 4.65, side * .17], edge);
          if (b.osm === 25372350) {
            for (let k = 1; k < 4; k++) box(w, [.07, 1.25, .10], trim, [xx - ww / 2 + k * ww / 4, h - 1.2, side * .19], edge);
            for (let k = 0; k < 5; k++) box(w, [ww, .035, .08], w.lib.plain(0x5a645b), [xx, .6 + k * .73, side * .15], edge);
          }
        }
        continue;
      }
      const bays = Math.max(1, Math.floor(len / 4.4)), spacing = len / bays, floors = Math.min(3, Math.max(1, Math.floor(h / 3.6)));
      for (let j = 0; j < bays; j++) for (let floor = 0; floor < floors; floor++) {
        const xx = -len / 2 + spacing * (j + .5), yy = 1.8 + floor * 3.35;
        const ww = Math.min(spacing - .8, floor ? 1.6 : 2.5), hh = floor ? 1.65 : 2.2;
        box(w, [ww, hh, .05], window, [xx, yy, side * .14], edge);
        box(w, [ww + .18, .13, .25], trim, [xx, yy - hh / 2, side * .19], edge);
        // Near viewpoints get reveals; distant service blocks retain only silhouette and glazing.
        if (Math.abs((a[0] + c[0]) / 2) < 80 && Math.abs((a[1] + c[1]) / 2) < 80) {
          for (const sx of [-1, 1]) box(w, [.11, hh + .13, .17], trim, [xx + sx * (ww / 2 + .04), yy, side * .18], edge);
          box(w, [ww + .18, .12, .2], trim, [xx, yy + hh / 2, side * .18], edge);
          box(w, [.055, hh, .075], trim, [xx, yy, side * .21], edge);
        }
      }
    }
    const cx = b.points.reduce((s, p) => s + p[0], 0) / b.points.length, cz = b.points.reduce((s, p) => s + p[1], 0) / b.points.length;
    box(w, [2.3, .9, 1.3], w.lib.plain(0x9a9d90, .8), [cx, h + .65, cz], root);
  }
  buildBoudin(w); buildLoadingEquipment(w);
  label(w, "franciscan", "THE FRANCISCAN", 20, 1.35, [92, 7.2, -71], 0, "#e4dfce", "#8b362c");
  label(w, "chowder", "CHOWDER HUT", 10, 1, [8, 4.0, -43], 0, "#4b3c30", "#e6c787");
  label(w, "sabellas", "SABELLA & LA TORRE", 14, 1, [-26, 4.9, -9], .157, "#5c352c", "#efdaa7");
  label(w, "scoma", "SCOMA’S", 14, 1.1, [-239, 4.5, -60], 0, "#263e38", "#d3cdb4");
  label(w, "shed", "PIER 45", 10, 1.45, [-11, 8.35, -97.5], .70, "#aaa28b", "#4b4d43");
  label(w, "musee", "MUSÉE MÉCANIQUE", 13, 1.1, [-9, 3.2, -100], .70, "#e2d8b9", "#333e3c");
  // Red/cream awnings and recessed seafood counters along the west side of Taylor.
  for (let i = 0; i < 5; i++) {
    const zz = -7 - i * 7;
    box(w, [2.1, .18, 6], w.lib.paint(i % 2 ? 0x8e3427 : 0xb4a27c), [-15.1, 2.9, zz]);
    box(w, [2.25, .85, 5.6], w.lib.paint(0x686e62), [-15, .7, zz]);
    box(w, [2.2, .12, 5.6], w.lib.stainless(), [-15, 1.2, zz]);
    for (let j = 0; j < 3; j++) box(w, [.43, .14, 1.2], w.lib.plain(0xc4b5a0, .3, .5), [-14.55, 1.32, zz - 1.6 + j * 1.5]);
  }
  // The working pier has loading equipment, stacked totes and hose reels rather than an empty road.
  for (let i = 0; i < 12; i++) {
    const x = -76 - i * 10.8, z = -112 - i * 9.1;
    box(w, [2.3, .25, 1.7], w.lib.plain(0x756449), [x, .2, z]);
    for (let j = 0; j < 3; j++) box(w, [2.1, .75, 1.5], w.lib.plain(i % 2 ? 0x82978e : 0xb9b8a4), [x, .68 + j * .78, z]);
  }
}


function buildLoadingEquipment(w: DayWorld) {
  const g = source("pier45/loading-forklift", w.group(-86, .05, -118, -.65));
  const yellow = w.lib.paint(0xbc813a, .76), steel = w.lib.plain(0x46514b, .67, .45), rubber = w.lib.plain(0x303934, .85);
  box(w, [1.3, .85, 2.45], yellow, [0, .67, 0], g); box(w, [1.2, .35, .8], yellow, [0, 1.21, .7], g);
  box(w, [.52, .14, .6], rubber, [0, 1.31, .07], g); box(w, [.52, .58, .13], rubber, [0, 1.63, .34], g);
  for (const x of [-.68, .68]) for (const z of [-.8, .84]) {
    const wheel = w.mesh(new CylinderGeometry(.39, .39, .23, 12).rotateZ(Math.PI / 2), rubber, x, .41, z, g); wheel.castShadow = true;
    w.mesh(new CylinderGeometry(.19, .19, .25, 10).rotateZ(Math.PI / 2), steel, x, .41, z, g);
  }
  for (const x of [-.58, .58]) for (const z of [-.65, .7]) bar(w, [x, 1.05, z], [x, 2.65, z], .05, steel, g);
  box(w, [1.45, .13, 1.6], yellow, [0, 2.73, 0], g);
  for (const x of [-.4, .4]) {
    box(w, [.16, 3.1, .18], steel, [x, 1.64, -1.23], g);
    box(w, [.12, .1, 1.5], steel, [x, .34, -1.9], g);
    box(w, [.1, 1.1, .12], steel, [x, .87, -1.22], g);
  }
  for (const y of [.5, 1.5, 2.8]) box(w, [.95, .12, .13], steel, [0, y, -1.24], g);
  for (let i = 0; i < 5; i++) {
    const x = -72 + i % 2 * 1.4, y = .35 + Math.floor(i / 2) * .67, z = -111;
    for (const yy of [y, y + .55]) w.mesh(new TorusGeometry(.58, .034, 4, 14).rotateX(Math.PI / 2), steel, x, yy, z);
    for (let j = 0; j < 10; j++) { const a = j / 10 * Math.PI * 2; bar(w, [x + Math.cos(a) * .58, y, z + Math.sin(a) * .58], [x + Math.cos(a) * .58, y + .55, z + Math.sin(a) * .58], .021, steel); }
  }
}

function buildBoudin(w: DayWorld) {
  const g = source("buildings/osm-37312428/boudin-glazed-gable", w.group(77, .1, -25, .157));
  const stone = w.lib.stucco(0xbcb8a6), timber = w.lib.paint(0x635442, .82), metal = w.lib.paint(0x484f48, .62), glass = w.lib.plain(0x688486, .2, .16), brick = w.lib.stucco(0x996749);
  box(w, [74, 3.5, 22], stone, [0, 1.75, 0], g);
  box(w, [73.6, 3.6, 21.6], glass, [0, 5.2, 0], g);
  // Pitched roof runs the long east-west block, with a tall western glazed gable facing the crab wheel.
  for (const side of [-1, 1]) {
    const roof = box(w, [77, .23, 12.1], w.lib.sheetRoof(0x4b514a), [0, 8.66, side * 5.65], g);
    roof.rotation.x = side * .315;
  }
  for (const xx of [-37.1, 37.1]) {
    const v = [new Vector3(xx, 6.96, -10.8), new Vector3(xx, 10.52, 0), new Vector3(xx, 6.96, 10.8)];
    const geom = new BufferGeometry(); geom.setAttribute("position", new Float32BufferAttribute(v.flatMap(p => p.toArray()), 3)); geom.setIndex(xx < 0 ? [0, 2, 1] : [0, 1, 2]); geom.computeVertexNormals();
    w.mesh(geom, glass, 0, 0, 0, g);
    for (let z = -9; z <= 9; z += 3) { const top = 10.5 - Math.abs(z) * .33; box(w, [.18, top - 3.5, .11], metal, [xx, (top + 3.5) / 2, z], g); }
    for (const yy of [3.5, 6.35]) box(w, [.18, .15, 22], metal, [xx, yy, 0], g);
    for (const side of [-1, 1]) bar(w, [xx, 7.0, side * 11.2], [xx, 10.72, 0], .13, timber, g, 4);
  }
  for (const side of [-1, 1]) {
    for (let x = -35; x <= 35; x += 5) {
      box(w, [.37, 7.1, .4], brick, [x, 3.55, side * 11.04], g);
      box(w, [.08, 3.4, .10], metal, [x + 2.5, 5.2, side * 10.86], g);
      box(w, [4.4, 2.45, .06], glass, [x + 2.5, 1.65, side * 11.06], g);
      if (side > 0) {
        const awning = box(w, [4.65, .1, 2.1], w.lib.paint(0x9d3429, .84), [x + 2.5, 3.15, 11.9], g); awning.rotation.x = .2;
        box(w, [4.65, .45, .1], w.lib.paint(0x963526, .84), [x + 2.5, 2.74, 12.91], g);
      }
    }
    box(w, [74, .25, .3], timber, [0, 7.05, side * 11], g);
  }
  label(w, "boudin", "BOUDIN BAKERY", 20, 1.05, [-13, 4, 11.27], 0, "#4a3e30", "#e8d8b4", g);
  label(w, "boudin-est", "SAN FRANCISCO  •  SINCE 1849", 14, .7, [-13, .85, 11.29], 0, "#88745b", "#ede1bd", g);
}

export function buildDistantBay(w: DayWorld) {
  // Alcatraz is 2.1 km offshore, never moved to fill the waterfront foreground.
  const island = source("bay/alcatraz-silhouette", w.group(-665, -1.8, -2046, -.3));
  const rock = w.mesh(new SphereGeometry(1, 20, 9), w.lib.plain(0x757b69), 0, 12, 0, island); rock.scale.set(240, 39, 125);
  box(w, [130, 21, 42], w.lib.plain(0xaaa89b), [15, 44, 0], island);
  box(w, [110, 5, 45], w.lib.plain(0x666d65), [15, 57, 0], island);
  w.mesh(new CylinderGeometry(3, 4, 25, 9), w.lib.plain(0xc1bca9), 79, 51, 11, island);
  box(w, [8, 5, 8], w.lib.plain(0x777c70), [79, 65, 11], island);
  for (let i = 0; i < 16; i++) box(w, [3, 8, .3], w.lib.plain(0x666f67), [-44 + i * 7.5, 47, 21.5], island);
  // Low distant Marin shore, atmosphere does the depth separation.
  for (let i = 0; i < 14; i++) {
    const x = -2800 + i * 480, y = 75 + (i % 4) * 32;
    const m = w.mesh(new SphereGeometry(1, 10, 5), w.lib.plain(0x7b8d88), x, -y * .35, -6200, w.root, { cast: false }); m.scale.set(480, y, 230);
  }
}

export function buildPromenade(w: DayWorld) {
  const iron = w.lib.paint(0x35413c), wood = w.lib.paint(0x968568, .85);
  // Pedestrian rails follow the inner basin and the open-water promenade.
  const spans = [[-144, 20, -57, 6], [-47, -18, -45, -57], [-93, -64, -47, -61], [32, -92, 107, -101], [147, -75, 194, -76], [235, -83, 248, -73]];
  for (const [ax, az, bx, bz] of spans) {
    const len = Math.hypot(bx - ax, bz - az), count = Math.ceil(len / 2.4);
    for (let i = 0; i <= count; i++) bar(w, [ax + (bx - ax) * i / count, 0, az + (bz - az) * i / count], [ax + (bx - ax) * i / count, 1.15, az + (bz - az) * i / count], .048, iron);
    for (const yy of [.3, .75, 1.15]) bar(w, [ax, yy, az], [bx, yy, bz], .04, iron);
  }
  // Seven pergolas are documented by the Port's November 2024 promenade opening.
  for (let n = 0; n < 7; n++) {
    const x = 35 + n * 24, z = -65 + n * .4, g = source(`promenade/pergola-${n}`, w.group(x, 0, z));
    for (const xx of [-2.6, 2.6]) for (const zz of [-2.4, 2.4]) box(w, [.18, 3.1, .18], iron, [xx, 1.55, zz], g);
    for (let i = 0; i < 11; i++) box(w, [5.8, .18, .17], wood, [0, 3.1, -2.5 + i * .5], g);
    for (const zz of [-2.5, 2.5]) box(w, [5.7, .22, .18], iron, [0, 2.98, zz], g);
    for (const xx of [-2.1, 2.1]) {
      box(w, [.7, .5, 3.7], iron, [xx, .25, 0], g);
      for (let j = 0; j < 5; j++) box(w, [.125, .055, 3.7], wood, [xx - .28 + j * .14, .53, 0], g);
    }
  }
  const shrubs = foliage(w), cards = shrubs.begin();
  for (let i = 0; i < 14; i++) {
    const x = 29 + i * 13, z = -72 + (i % 2) * 12;
    box(w, [1.45, .75, 1.45], w.lib.paint(0x566b61, .82), [x, .375, z]);
    box(w, [1.27, .035, 1.27], w.lib.plain(0x494538, .92), [x, .77, z]);
    shrubs.clump(cards, w.rng, new Vector3(x, 1.11, z), .67, 20);
  }
  shrubs.end(cards);
  // Lamps, bins, bollards, benches and tactile kerbs sit at pedestrian scale.
  for (let i = 0; i < 18; i++) {
    const x = -135 + i * 21, z = -3 - x * .157;
    const g = w.group(x, 0, z);
    w.mesh(new CylinderGeometry(.07, .12, 5.5, 8), iron, 0, 2.75, 0, g);
    w.mesh(new CylinderGeometry(.26, .17, .5, 8), w.lib.plain(0xb4bba4, .35), 0, 5.65, 0, g);
    w.mesh(new CylinderGeometry(0, .36, .32, 8), iron, 0, 6.04, 0, g);
    w.mesh(new CylinderGeometry(.18, .23, .2, 8), iron, 0, .1, 0, g);
    if (i % 2 === 0) {
      box(w, [.6, .93, .55], iron, [1.15, .46, 0], g);
      for (let j = 0; j < 9; j++) box(w, [.025, .76, .045], w.lib.plain(0x111e1a), [.89 + j * .066, .46, .28], g);
      box(w, [2.4, .16, .68], wood, [3, .48, .1], g); box(w, [2.4, .66, .11], wood, [3, .85, -.2], g);
      for (const xx of [2.1, 3.9]) box(w, [.12, .48, .6], iron, [xx, .24, .1], g);
    }
  }
  for (let i = 0; i < 9; i++) {
    const x = -7.6, z = -12 - i * 7;
    w.mesh(new CylinderGeometry(.13, .16, .84, 9), iron, x, .42, z);
  }
  // Overhead trolley contact wire and suspension stay on the Jefferson alignment.
  for (let i = 0; i < 5; i++) {
    const x = -120 + i * 80, z = 11 - x * .157;
    bar(w, [x, 0, z - 11], [x, 7.5, z - 11], .075, iron);
    bar(w, [x, 0, z + 12], [x, 7.5, z + 12], .075, iron);
    bar(w, [x, 7.2, z - 11], [x, 6.9, z + 12], .018, iron);
  }
  for (const dz of [-.3, .3]) bar(w, [-175, 6.8, 39.5 + dz], [280, 6.8, -32 + dz], .019, iron);
  // Welcome kiosk: simple teal container at the Powell end, as installed in 2024.
  box(w, [6, 2.6, 2.4], w.lib.paint(0x378c8a), [236, 1.3, -52]);
  label(w, "welcome", "FISHERMAN’S WHARF  •  WELCOME", 5.6, .7, [236, 2.06, -50.77], 0, "#286b6c", "#f2e6c6");
  box(w, [3.7, 1.0, .06], w.lib.glass(), [235.6, 1.14, -50.75]);
}
