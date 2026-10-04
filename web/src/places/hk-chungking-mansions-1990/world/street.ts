import { CylinderGeometry } from "three";
import type { DayWorld } from "../../shared/daylight/context";
import { source } from "../../shared/provenance";
import { atlasPlane } from "../../shared/shapes";
import { block, bar, label, lamp } from "./fabric";

export function buildStreet(w: DayWorld) {
  const asphalt = w.lib.asphalt(4, 0x969b96), stone = w.lib.concrete([.75, .77, .70]);
  block(w, w.lib.plain(0x343e36, .95), [500, .2, 1100], [0, -.22, 0]);
  source("nathan-road/asphalt", block(w, asphalt, [24, .18, 1000], [-16.5, -.09, 0]));
  for (const [x, width] of [[-2.4, 4.8], [-30.55, 4.2]] as const) {
    block(w, stone, [width, .26, 1000], [x, .03, 0]);
    for (let z = -119; z <= 119; z += 1.6) block(w, w.lib.plain(0x636b61, .95), [width, .009, .018], [x, .167, z]);
    for (let dx = -width / 2; dx <= width / 2; dx += .8) block(w, w.lib.plain(0x636b61, .95), [.015, .009, 1000], [x + dx, .167, 0]);
  }
  for (const x of [-4.9, -28.5]) {
    block(w, w.lib.granite([.86, .87, .79]), [.23, .3, 1000], [x, .02, 0]);
    for (let z = -100; z <= 100; z += 12) {
      block(w, w.lib.plain(0x262e2b, .7, .5), [.55, .03, .75], [x + (x < -10 ? .36 : -.36), .012, z]);
      for (let s = 0; s < 6; s++) block(w, w.lib.plain(0x71786e, .8, .6), [.5, .02, .024], [x + (x < -10 ? .36 : -.36), .031, z - .29 + s * .11]);
    }
    for (const offset of [.55, .73]) block(w, w.lib.roadPaint(0xb6a36e), [.09, .012, 226], [x + (x < -10 ? offset : -offset), .012, 0]);
  }
  for (const x of [-10.8, -16.6, -22.4]) for (let z = -118; z < 118; z += 8)
    block(w, w.lib.roadPaint(0xd0cfb7), [.105, .013, 3.9], [x, .015, z]);
  // Cross-street Peking Road opposite the entrance: far-field continuation behind the west footpath.
  block(w, asphalt, [58, .2, 13.5], [-59, -.1, 0]);
  for (const x of [-26.9, -24.6, -22.3, -20, -17.7, -15.4, -13.1, -10.8, -8.5, -6.2])
    block(w, w.lib.roadPaint(0xc5b55d), [1.05, .013, 3.8], [x, .016, 26.8]);
  // Galvanised pedestrian guardrail interrupted at crossings and entrances.
  const rail = w.lib.plain(0x747f77, .5, .6);
  for (const x of [-4.5, -28.9]) for (let z = -88; z <= 87; z += 3) {
    if (Math.abs(z - 27) < 4 || Math.abs(z) < 4) continue;
    bar(w, rail, [x, .17, z], [x, 1.18, z], .033);
    for (const y of [.52, 1.06]) bar(w, rail, [x, y, z], [x, y, z + 2.9], .026);
    for (let dz = .4; dz <= 2.8; dz += .4) bar(w, rail, [x, .48, z + dz], [x, 1.08, z + dz], .012);
  }
  // Period bent-arm sodium luminaires. No contemporary LED streetlights or smart poles.
  for (const x of [-4.25, -29.2]) for (const z of [-68, -22, 25, 72]) {
    const lean = x < -10 ? 1 : -1;
    bar(w, rail, [x, .15, z], [x, 9.6, z], .076);
    bar(w, rail, [x, 9.6, z], [x + lean * 2.9, 10.03, z], .059);
    block(w, w.lib.plain(0x4d5850, .4, .5), [1.12, .24, .36], [x + lean * 2.9, 9.95, z]);
    block(w, w.lib.glow(0xffd199, 3), [.94, .04, .25], [x + lean * 2.9, 9.81, z]);
    lamp(w, [x + lean * 2.9, 9.45, z], 0xffce8b, 63, 18);
  }
  for (const z of [23.5, 30]) for (const x of [-4.0, -29.4]) {
    bar(w, w.lib.paint(0x333d35), [x, .2, z], [x, 3.7, z], .048);
    block(w, w.lib.plain(0x192822), [.24, .75, .24], [x, 3.5, z]);
    for (let i = 0; i < 3; i++) {
      const disk = w.mesh(new CylinderGeometry(.084, .084, .02, 10), w.lib.glow(i === 0 ? 0xd0542f : 0x252d23, i === 0 ? 2 : .35), x, 3.7 - i * .21, z + .135);
      disk.rotation.x = Math.PI / 2;
    }
  }
  // Painted stop text is part of the road, with worn empty border instead of an invented route number.
  const text = w.draw("hk-bus-stop-stencil", 280, 480, (g, cw, ch) => {
    g.clearRect(0, 0, cw, ch); g.fillStyle = "#b9bba3"; g.textAlign = "center";
    g.font = `bold ${cw * .32}px Arial`; g.fillText("BUS", cw / 2, ch * .2); g.fillText("STOP", cw / 2, ch * .44);
    g.font = `bold ${cw * .28}px "PingFang TC", sans-serif`; g.fillText("巴士站", cw / 2, ch * .77);
  });
  const stencil = w.lib.cutout("hk-road-stencil", w.atlas.texture, { rough: .95 });
  const marking = w.mesh(atlasPlane(2.8, 4.8, text), stencil, -7.4, .023, 9); marking.rotation.x = -Math.PI / 2;
}

/** Neighbour massing and signs frame the actual frontage; individual inferred tenants remain unbranded. */
export function buildNeighbours(w: DayWorld) {
  const frame = w.lib.plain(0x727f78, .55, .4), dark = w.lib.glass("dark"), ledge = w.lib.concrete([.84, .84, .73]);
  // Imperial immediately south, Mirador north beyond Mody Road; west street blocks have a Peking Road gap.
  for (const [x, z, width, depth, height, tint] of [[12, 32, 27, 29, 40, 0xbcb7a5], [15, -64, 32, 39, 53, 0xa9afa0], [-43, 30, 23, 40, 52, 0x9eada6], [-43, -32, 23, 45, 46, 0xaaa796], [11, 84, 24, 45, 54, 0x87938b], [9, -112, 25, 30, 45, 0xb2b4a0]] as const) {
    const g = source(`nathan-road/neighbour-${z}`, w.group(x > 0 ? 0 : -33, 0, z, x > 0 ? -Math.PI / 2 : Math.PI / 2));
    block(w, w.lib.stucco(tint), [depth, height, width], [0, height / 2, -width / 2], g);
    for (let y = 5; y < height - 2; y += 3.1) {
      block(w, ledge, [depth + .2, .21, .5], [0, y - .9, .11], g);
      for (let xx = -depth / 2 + 1.5; xx < depth / 2 - 1; xx += 2.45) {
        block(w, dark, [1.96, 1.56, .03], [xx, y, .02], g);
        block(w, frame, [.045, 1.66, .07], [xx, y, .056], g);
        if ((Math.round(xx * 10) + Math.round(y * 10)) % 3 === 0) block(w, w.lib.plain(0xa9ad9f), [.64, .44, .38], [xx + .47, y - 1.14, .21], g);
      }
    }
    for (let xx = -depth / 2 + 2; xx < depth / 2 - 1; xx += 4.8) {
      block(w, w.lib.plain(0x23362d), [4.35, 2.7, .05], [xx, 1.65, .08], g);
      block(w, w.lib.paint(0x635743), [4.5, .7, 1.4], [xx, 3.5, .55], g);
      label(w, g, "neighbour-jewellery", "珠寶鐘錶", "JEWELLERY & WATCHES", 4.2, .59, [xx, 3.49, 1.27], { lit: true, bg: "#6a362b" });
    }
  }
  // Coarse continuing street canyon disappears into fog before the road geometry ends.
  for (const side of [-1, 1]) for (const z of [-380, -292, -215, -157, 153, 211, 288, 380]) {
    const g = w.group(side < 0 ? -33 : 0, 0, z, side < 0 ? Math.PI / 2 : -Math.PI / 2);
    block(w, w.lib.stucco(0x969f92), [55, 42, 26], [0, 21, -13], g);
    for (let y = 6; y < 41; y += 3.1) {
      block(w, dark, [53, 1.5, .025], [0, y, .022], g);
      for (let x = -25; x < 26; x += 2.7) block(w, ledge, [.23, 1.7, .06], [x, y, .07], g);
    }
  }
  // Traditional solid metal sign boxes and their diagonal trusses, not modern video/LED screens.
  const signs = [
    [-1.9, 9.3, -18, "賓館", "GUEST HOUSE", "#244c45", "#e4d5a6"],
    [-2.5, 6.5, -9, "找換", "EXCHANGE", "#9b3328", "#f3dca9"],
    [-2.5, 12.7, 15, "電器", "RADIO", "#1e4d5e", "#e4d8af"],
    [-3.0, 10.4, 30, "酒店", "HOTEL", "#345750", "#e8d6aa"],
    [-3.1, 15.2, -38, "珠寶", "JEWELLERY", "#70372b", "#e6d096"],
    [-2.6, 8.5, 54, "洋服", "TAILOR", "#866843", "#ede5c5"],
    [-29.0, 12.3, -20, "海鮮酒家", "RESTAURANT", "#204459", "#e4dabb"],
    [-29.8, 9.5, 21, "旅行社", "TRAVEL", "#5c3c28", "#e7d69c"],
    [-30.0, 16.0, 43, "鐘錶", "WATCHES", "#782f22", "#e9d3a7"],
    [-2.8, 16, -76, "酒樓", "RESTAURANT", "#315445", "#f4d59c"],
  ] as const;
  // Layer broad perpendicular boards at several depths, a defining feature of the 1981/1994 street photographs.
  // Their trade-only lettering is an inferred period treatment, not a claimed historical shop inventory.
  for (let i = 0; i < 12; i++) {
    const east = i % 3 !== 0, z = -81 + i * 13.7, x = east ? -3.5 : -29.4;
    const g = source(`nathan-road/inferred-horizontal-sign-${i}`, w.group(x, 6.6 + (i % 3) * 2.6, z));
    const width = 5.6 + (i % 3) * 1.2, height = 1.5 + (i % 2) * .6;
    block(w, w.lib.paint(0x626958), [width, height, .32], [0, 0, 0], g);
    const trades = [["海鮮酒家", "SEAFOOD RESTAURANT"], ["賓館服務", "ROOMS AVAILABLE"], ["珠寶金行", "JEWELLERY"], ["洋服公司", "CUSTOM TAILOR"]];
    const trade = trades[i % trades.length];
    for (const side of [-1, 1]) label(w, g, `wide-trade-${i % 4}`, trade[0], trade[1], width - .12, height - .10, [0, 0, side * .17], { lit: true, bg: i % 2 ? "#335443" : "#70382e", ry: side === -1 ? Math.PI : 0 });
    const wallX = east ? -x : -33 - x;
    for (const dz of [-.22, .22]) {
      bar(w, frame, [wallX, height / 2 + .7, dz], [east ? -width / 2 : width / 2, height / 2, dz], .028, g);
      bar(w, frame, [wallX, -height / 2, dz], [east ? -width / 2 : width / 2, -height / 2, dz], .028, g);
    }
  }
  for (const [i, [x, y, z, zh, en, bg, ink]] of signs.entries()) {
    const g = source(`nathan-road/inferred-sign-${i}`, w.group(x, y, z));
    const h = zh.length * 1.25 + .8, width = 1.8 + (i % 3) * .3;
    block(w, w.lib.paint(0x475448), [width + .17, h + .16, .34], [0, 0, 0], g);
    for (const side of [-1, 1]) label(w, g, `projecting-${i}`, zh, en, width, h, [0, 0, side * .18], { bg, ink, lit: true, vertical: true, ry: side === -1 ? Math.PI : 0 });
    const wallX = x < -15 ? -31.5 : 0;
    for (const yy of [-h / 2, h / 2]) {
      bar(w, frame, [wallX - x, yy, 0], [-width / 2, yy, 0], .036, g);
      bar(w, frame, [wallX - x, yy + 1, -.4], [0, yy, 0], .023, g);
    }
    lamp(w, [x, y - h / 2 - .1, z + .3], i % 2 ? 0xffa65b : 0x95c5b3, 18, 8);
  }
}
