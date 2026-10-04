import { MeshStandardMaterial, PointLight, type Material, type Object3D } from "three";
import type { DayWorld } from "../../shared/daylight/context";
import { atlasPlane, rod, v3 } from "../../shared/shapes";
import { box } from "../../shared/geo";
import { source } from "../../shared/provenance";

export function block(w: DayWorld, mat: Material, size: [number, number, number], at: [number, number, number], parent: Object3D = w.root) {
  return w.mesh(box(...size), mat, ...at, parent);
}
export function bar(w: DayWorld, mat: Material, a: [number, number, number], b: [number, number, number], r = .025, parent: Object3D = w.root) {
  return w.mesh(rod(v3(...a), v3(...b), r, 6), mat, 0, 0, 0, parent);
}
export function lamp(w: DayWorld, at: [number, number, number], color = 0xffdb9b, power = 22, reach = 9, parent: Object3D = w.root) {
  const l = new PointLight(color, power, reach, 2); l.name = "period-lamp"; l.position.set(...at); parent.add(l); return l;
}

/** Plain typography, never a traced logo. Most tenant panels are explicitly conjectural trade categories. */
export function label(w: DayWorld, parent: Object3D, key: string, zh: string, en: string, width: number, height: number, at: [number, number, number], opts: { bg?: string; ink?: string; lit?: boolean; vertical?: boolean; ry?: number } = {}) {
  const rect = w.draw(`chungking-${key}`, opts.vertical ? 224 : 640, opts.vertical ? 640 : 192, (g, cw, ch) => {
    g.fillStyle = opts.bg ?? "#1a302d"; g.fillRect(0, 0, cw, ch);
    g.strokeStyle = opts.ink ?? "#efe8cc"; g.lineWidth = Math.max(2, cw * .012); g.strokeRect(cw * .035, ch * .055, cw * .93, ch * .89);
    g.fillStyle = opts.ink ?? "#efe8cc"; g.textAlign = "center"; g.textBaseline = "middle";
    if (opts.vertical) {
      g.font = `600 ${Math.min(cw * .65, ch * .76 / zh.length)}px "PingFang TC", "Noto Sans CJK TC", sans-serif`;
      [...zh].forEach((c, i) => g.fillText(c, cw / 2, ch * (.10 + (i + .5) * .72 / zh.length)));
      g.font = `bold ${cw * .12}px Arial`; g.fillText(en, cw / 2, ch * .9, cw * .86);
    } else {
      g.font = `600 ${ch * .43}px "PingFang TC", "Noto Sans CJK TC", sans-serif`; g.fillText(zh, cw / 2, ch * .36, cw * .9);
      g.font = `bold ${ch * .20}px Arial`; g.fillText(en, cw / 2, ch * .75, cw * .88);
    }
  });
  const material = opts.lit ? w.lib.printed("chungking-backlit", w.atlas.texture, .5, 2.1) : w.printed;
  const plane = w.mesh(atlasPlane(width, height, rect), material, ...at, parent, { ry: opts.ry });
  plane.name = `lettering-${key}`; return plane;
}

/** Original horizontal concrete spandrels and inset metal windows; no post-2011 glass/LED wrapper. */
export function buildMansions(w: DayWorld) {
  const facade = source("chungking/original-frontage", w.group(0, 0, 0, -Math.PI / 2));
  const wall = w.lib.stucco(0xb1b09d), ledge = w.lib.concrete([.82, .81, .72]);
  const patch = [w.lib.stucco(0x858b81), w.lib.stucco(0xa8a995), w.lib.stucco(0xc6c0aa)];
  const metal = w.lib.plain(0x737a72, .55, .55), dark = w.lib.plain(0x283536, .7), sill = w.lib.plain(0xadb0a3, .55, .15);
  const warmWindow = new MeshStandardMaterial({ color: 0x716347, emissive: 0xa28b52, emissiveIntensity: .48, roughness: .5 }); warmWindow.name = "chungking-warm-window";
  const coolWindow = new MeshStandardMaterial({ color: 0x526660, emissive: 0x9fb5a5, emissiveIntensity: .32, roughness: .45 }); coolWindow.name = "chungking-cool-window";
  const windowMats = [w.lib.glass("dark"), w.lib.glass("curtain"), warmWindow, coolWindow];
  // A thin facade skin, not a filled building: the ground-level arcade remains open.
  block(w, wall, [44, 45.2, 1.4], [0, 31.6, -1.05], facade);
  for (let floor = 0; floor < 14; floor++) {
    const y = 9.7 + floor * 3.15;
    block(w, ledge, [44.3, .19, 1.12], [0, y - .08, .13], facade);
    block(w, wall, [44, .86, .34], [0, y + .48, .18], facade);
    // The narrow continuous brown water line below each slab is visible in old photographs.
    block(w, w.lib.plain(0x62665b, .98), [44.25, .075, .04], [0, y - .18, .71], facade);
    for (let bay = 0; bay < 22; bay++) {
      const x = -21 + bay * 2, wy = y + 1.86;
      const mat = windowMats[(bay * 17 + floor * 13) % 11 < 3 ? 2 + ((floor + bay) % 2) : (bay + floor) % 2];
      block(w, dark, [1.89, 1.92, .14], [x, wy, -.13], facade);
      block(w, mat, [1.64, 1.70, .04], [x, wy, -.038], facade);
      for (const xx of [-.85, 0, .85]) block(w, metal, [.042, 1.82, .14], [x + xx, wy, .023], facade);
      for (const yy of [-.87, .29, .87]) block(w, metal, [1.76, .04, .14], [x, wy + yy, .023], facade);
      block(w, sill, [1.95, .09, .48], [x, y + .90, .13], facade);
      if ((bay * 3 + floor * 5) % 7 !== 0) {
        const ax = x + ((bay + floor) % 2 ? .39 : -.43), ay = y + .55;
        block(w, w.lib.plain(0xaaa794, .86), [.67, .44, .43], [ax, ay, .57], facade);
        block(w, dark, [.48, .29, .02], [ax - .035, ay, .8], facade);
        for (let slat = 0; slat < (floor < 5 ? 5 : 3); slat++)
          block(w, metal, [.48, .025, .026], [ax - .035, ay - .11 + slat * .055, .822], facade);
        if (floor < 5) for (const dx of [-.25, .25]) bar(w, metal, [ax + dx, ay - .24, .2], [ax + dx, ay - .24, .8], .018, facade);
      }
      if ((bay + floor * 3) % 9 === 0) block(w, patch[(floor + bay) % 3], [.7, .56, .025], [x - .36, y + .47, .36], facade);
    }
  }
  // Irregular downpipes, cables and open drying frames interrupt the regular fenestration.
  for (const x of [-20.6, -10.5, -.4, 10.2, 21.5]) {
    bar(w, w.lib.plain(0x645e51, .93), [x, 7.1, .9], [x, 53.8, .9], .058, facade);
    for (let y = 10.8; y < 52; y += 3.15) bar(w, metal, [x - .1, y, .15], [x + .11, y, 1], .022, facade);
  }
  // Long lettered boards between floors echo the period frontage without inventing a guesthouse roster.
  for (const [x, y, width, zh, en] of [[-10.4, 8.7, 16, "賓館  洋服  找換", "GUEST HOUSES · TAILORS · EXCHANGE"], [11.2, 5.85, 15.4, "餐廳  電器  鐘錶", "RESTAURANTS · ELECTRONICS · WATCHES"], [5.4, 12.2, 19.8, "重慶商場", "CHUNGKING ARCADE"]] as const)
    label(w, facade, `front-trades-${y}`, zh, en, width, .82, [x, y, .97], { bg: "#b1a995", ink: "#544b39" });
  for (let i = 0; i < 22; i++) {
    const x = -19 + (i * 11 % 38), y = 11 + (i * 7 % 38);
    bar(w, metal, [x - .62, y, .1], [x - .62, y, 1.35], .018, facade);
    bar(w, metal, [x + .62, y, .1], [x + .62, y, 1.35], .018, facade);
    bar(w, metal, [x - .64, y, 1.35], [x + .64, y, 1.35], .017, facade);
    if (i % 3 === 0) block(w, w.lib.plain(0x6d817e, .95), [.38, .66, .015], [x, y - .32, 1.34], facade);
  }
  block(w, ledge, [44.4, .36, 2.2], [0, 54.1, -.2], facade);
  block(w, wall, [44.2, .85, .22], [0, 54.65, .42], facade);
  // Three commercial levels: large windows, concrete fins, entrance gap underneath.
  for (const y of [3.7, 6.6, 9.3]) block(w, ledge, [44.6, .3, 3.4], [0, y, -.8], facade);
  for (let bay = 0; bay < 16; bay++) {
    const x = -20.6 + bay * 2.75;
    for (const y of [5.2, 7.9]) {
      block(w, windowMats[bay % 4], [2.4, 2.05, .06], [x, y, -.19], facade);
      for (const dx of [-1.22, 0, 1.22]) block(w, metal, [.065, 2.12, .16], [x + dx, y, -.05], facade);
    }
  }
  for (let x = -21; x <= 21; x += 7) block(w, ledge, [.55, 9.2, 1.2], [x, 4.6, -.30], facade);
  label(w, facade, "building-title", "重 慶 大 廈", "CHUNGKING MANSIONS", 10.9, 1.52, [0, 4.28, .94], { bg: "#b8b49d", ink: "#892f28", lit: true });
  // Deep overhead entrance lintel and terrazzo jambs give an actual view into the arcade.
  block(w, w.lib.granite([.76, .70, .60]), [.42, 3.48, 2.8], [-2.7, 1.92, -.5], facade);
  block(w, w.lib.granite([.76, .70, .60]), [.42, 3.48, 2.8], [2.7, 1.92, -.5], facade);
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const x = side * (5.8 + i * 4.5);
    block(w, w.lib.paint(0x5a685e), [4.28, .55, .24], [x, 3.23, .29], facade);
    block(w, w.lib.plain(0x17231e), [4.25, 2.65, .1], [x, 1.84, -.88], facade);
    for (const dx of [-2.0, 0, 2.0]) block(w, metal, [.075, 2.67, .8], [x + dx, 1.84, -.3], facade);
    // Open centre with inset display cabinets; the facade is not an opaque window decal.
    for (const dx of [-1.38, 1.38]) {
      block(w, w.lib.plain(0x776c4e, .8), [1.02, 1.05, .64], [x + dx, .86, .09], facade);
      block(w, w.lib.plain(0xd0c299, .56), [1.08, .055, .70], [x + dx, 1.42, .09], facade);
      for (let row = 0; row < 3; row++) {
        block(w, metal, [.95, .033, .33], [x + dx, 1.7 + row * .38, -.39], facade);
        for (let item = 0; item < 4; item++) {
          block(w, w.lib.plain(item % 2 ? 0x9c8961 : 0x3c4840), [.14, .21, .17], [x + dx - .32 + item * .21, 1.84 + row * .38, -.37], facade);
          block(w, w.lib.plain(0xc5bd9d), [.08, .05, .01], [x + dx - .32 + item * .21, 1.83 + row * .38, -.278], facade);
        }
      }
    }
    for (let shutter = 0; shutter < 5; shutter++) block(w, metal, [4.08, .075, .04], [x, 2.88 - shutter * .085, .12], facade);
    const trades = [["找換", "EXCHANGE"], ["電器", "ELECTRONICS"], ["洋服", "TAILOR"], ["鐘錶", "WATCHES"]];
    label(w, facade, `shop-${i}`, trades[i][0], trades[i][1], 3.9, .57, [x, 3.22, .43], { lit: true, bg: i % 2 ? "#24543c" : "#772b22" });
    for (let k = 0; k < 7; k++) block(w, w.lib.plain(k % 2 ? 0x88785e : 0x33372f), [.35, .25 + (k % 3) * .08, .38], [x - 1.6 + k * .52, .8, .12], facade);
    lamp(w, [x, 2.8, 1], 0xffdeb4, 12, 5, facade);
  }

  // The west street elevation is 36.4 m wide in the retained Block A footprint.
  facade.scale.x = 36.4 / 44;
  return facade;
}

export function buildArcade(w: DayWorld) {
  const g = source("chungking/arcade-conjectural-fitout", w.group(0, 0, 0, -Math.PI / 2));
  const tile = w.lib.granite([.81, .79, .68]), wall = w.lib.stucco(0xc0b99e), steel = w.lib.plain(0x969b91, .3, .5);
  block(w, tile, [20, .2, 33], [0, .15, -16], g);
  block(w, wall, [20, .28, 25], [0, 3.56, -12.5], g);
  for (let z = -1; z >= -30; z -= 1) block(w, w.lib.plain(0x484d41, .88), [20, .006, .015], [0, .254, z], g);
  for (let x = -9.5; x <= 9.5; x += 1) block(w, w.lib.plain(0x484d41, .88), [.015, .006, 32], [x, .254, -16], g);
  for (const side of [-1, 1]) for (let i = 0; i < 5; i++) {
    const shop = w.group(side * 3.9, 0, -2.7 - i * 4.45, -side * Math.PI / 2, g);
    block(w, wall, [4.25, 3.3, .2], [0, 1.9, -3.0], shop);
    for (const x of [-2.15, 2.15]) block(w, wall, [.16, 3.3, 3.2], [x, 1.9, -1.4], shop);
    block(w, w.lib.plain(0x8e7052, .86), [3.85, .88, .7], [0, .70, -.2], shop);
    block(w, steel, [3.88, .09, .82], [0, 1.18, -.2], shop);
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = .57 + shelf * .57;
      block(w, steel, [3.85, .045, .6], [0, y, -2.4], shop);
      for (let item = 0; item < 10; item++) {
        const m = w.lib.plain([0xab945d, 0x546b64, 0x704b35, 0xbbc0ac][(item + shelf + i) % 4], .8);
        block(w, m, [.23 + (item % 2) * .07, .23 + (item % 3) * .05, .23], [-1.7 + item * .37, y + .18, -2.37], shop);
        if (shelf === 2) block(w, w.lib.plain(0xd6cdab), [.16, .09, .007], [-1.7 + item * .37, y + .16, -2.247], shop);
      }
    }
    if (i % 2 === 0) for (let r = 0; r < 6; r++) block(w, steel, [3.96, .075, .04], [0, 2.8 + r * .08, .04], shop);
    const category = [["找換", "MONEY EXCHANGE"], ["電器", "RADIO & CAMERA"], ["餐廳", "RESTAURANT"], ["百貨", "GENERAL STORE"], ["賓館", "GUEST HOUSE"]][i];
    label(w, shop, `arcade-trade-${i}`, category[0], category[1], 3.95, .46, [0, 3.1, .17], { bg: i % 2 ? "#86422c" : "#285949", lit: true });
    lamp(w, [0, 2.95, -.8], i % 2 ? 0xe3eacb : 0xffd9a4, 10, 4.5, shop);
  }
  for (let z = -2; z >= -24; z -= 4.4) {
    block(w, steel, [1.32, .09, .2], [0, 3.33, z], g);
    block(w, w.lib.glow(0xe0edd5, 2.6), [1.2, .045, .11], [0, 3.27, z], g);
    lamp(w, [0, 3.15, z], 0xd4e9d7, 17, 7, g);
    bar(w, steel, [-2.45, 3.15, z], [2.45, 3.15, z], .026, g);
  }
  // The lift lobby is visible as an end bay; no claim to reproduce a documented 1990 lift interior.
  block(w, wall, [8, 3.4, .22], [0, 1.93, -25.5], g);
  for (const x of [-1.95, 1.65]) {
    block(w, w.lib.plain(0x303a33), [1.55, 2.6, .12], [x, 1.57, -25.3], g);
    block(w, steel, [1.32, 2.3, .04], [x, 1.48, -25.21], g);
    block(w, w.lib.plain(0x444b43), [.025, 2.3, .04], [x, 1.48, -25.17], g);
    label(w, g, "lift", "升降機", "LIFT", 1.48, .35, [x, 2.98, -25.19], { lit: true });
  }
  // Side opening to the service court is modelled, but its precise position is an estimate.
  block(w, w.lib.concrete([.56, .59, .49]), [20, .2, 20], [0, .10, -35.4], g);
  for (let i = 0; i < 8; i++) {
    const x = -7 + (i % 4) * 1.8, z = -30.5 - Math.floor(i / 4) * 5;
    block(w, w.lib.plain(0x615b48), [.9, .64 + (i % 3) * .3, .8], [x, .55, z], g);
    block(w, w.lib.plain(0x9b8560), [.68, .34, .66], [x, 1.07, z], g);
  }
  for (const x of [-7.2, 6.9]) for (let z = -28; z >= -44; z -= 6) {
    bar(w, steel, [x, .25, z], [x, 2.4, z], .045, g);
    lamp(w, [x, 3.2, z], 0xe2bc7b, 9, 7, g);
  }
  // Thin catenaries through the lightwell, using deterministic geometry rather than a sky overlay.
  for (let y = 8; y < 34; y += 6) for (let n = 0; n < 2; n++) {
    let previous: [number, number, number] = [-10, y, -29 - n * 9];
    for (let k = 1; k <= 8; k++) {
      const t = k / 8, next: [number, number, number] = [-10 + t * 20, y - .7 * Math.sin(t * Math.PI), -29 - n * 9];
      bar(w, w.lib.plain(0x343d33), previous, next, .022, g); previous = next;
    }
  }
}
