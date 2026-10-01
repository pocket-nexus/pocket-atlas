import {
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  PlaneGeometry,
  RectAreaLight,
  SpotLight,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mapUV, type AtlasRect } from "../../shared/atlas";
import {
  chillerAtlas,
  coolerAtlas,
  JP_SANS,
  konbiniFascia,
  LATIN,
  lightboxSign,
  magazineAtlas,
  poster,
  POSTER_COUNT,
  productAtlas,
  tobaccoWall,
  toTexture,
} from "../gfx/canvas";
import { box } from "../../shared/geo";
import { seedWindowUV } from "../../shared/interior";
import { ProductBatch, type Shape } from "./products";
import type { World } from "./context";
import { L } from "./layout";

const K = L.konbini;

/** Plane facing +z with UVs mapped to an atlas cell. */
function atlasPlane(w: number, h: number, r: AtlasRect): PlaneGeometry {
  return mapUV(new PlaneGeometry(w, h), r) as PlaneGeometry;
}

export interface Konbini {
  door: { left: Object3D; right: Object3D; open: number };
  fascia: Mesh;
}

export function buildKonbini(w: World): Konbini {
  const lib = w.lib;
  const root = w.group();
  root.name = "konbini";

  const frame = lib.brushed([0.72, 0.74, 0.76]);
  const darkFrame = lib.brushed([0.2, 0.21, 0.22]);
  const glass = lib.storeGlass();
  const wallLower = lib.wallTile("gray");
  const wallUpper = lib.wallTile("beige");
  const slabMat = lib.concrete([0.5, 0.5, 0.48]);
  const white = lib.paint(0xe9ecee, 0.35);

  // ----------------------------------------------------------- shell
  const H = K.height;
  // West wall, back wall, solid part of the east wall.
  w.mesh(box(0.25, H, K.front - K.z0), wallLower, K.x0 + 0.125, H / 2, (K.front + K.z0) / 2, root);
  w.mesh(box(K.x1 - K.x0, H, 0.25), wallLower, (K.x0 + K.x1) / 2, H / 2, K.z0 + 0.125, root);
  w.mesh(box(0.25, H, -5.35 - K.z0), wallLower, K.x1 - 0.125, H / 2, (-5.35 + K.z0) / 2, root);
  // Front pillars under the fascia.
  w.mesh(box(0.38, 2.95, 0.36), wallLower, K.x0 + 0.19, 1.475, K.front - 0.18, root);
  w.mesh(box(0.36, 2.95, 0.36), wallLower, K.x1 - 0.18, 1.475, K.front - 0.18, root);
  // Low plinth under the glazing.
  w.mesh(box(K.x1 - K.x0 - 0.7, 0.07, 0.2), darkFrame, (K.x0 + K.x1) / 2, 0.035, K.front - 0.1, root);

  // ------------------------------------------------------ fascia sign
  const fasciaTex = toTexture(konbiniFascia());
  const fasciaMat = lib.sign(fasciaTex, 2.25, { rough: 0.3, key: "fascia" });
  const fW = K.x1 - K.x0 + 0.1;
  w.mesh(box(fW, 0.95, 0.3), white, (K.x0 + K.x1) / 2, 3.425, K.front + 0.15, root);
  const fascia = w.mesh(new PlaneGeometry(fW - 0.04, 0.9), fasciaMat, (K.x0 + K.x1) / 2, 3.425, K.front + 0.302, root, { cast: false });
  // East return of the fascia along the cross street.
  const eastLen = 6.2;
  w.mesh(box(0.3, 0.95, eastLen), white, K.x1 + 0.15, 3.425, K.front + 0.3 - eastLen / 2, root);
  const eastSign = new PlaneGeometry(eastLen - 0.04, 0.9);
  eastSign.rotateY(Math.PI / 2);
  w.mesh(eastSign, fasciaMat, K.x1 + 0.302, 3.425, K.front + 0.3 - eastLen / 2, root, { cast: false });
  // Soffit with downlights.
  const soffit = new PlaneGeometry(fW, 0.3);
  soffit.rotateX(Math.PI / 2);
  w.mesh(soffit, lib.plain(0xdadde0, 0.6), (K.x0 + K.x1) / 2, 2.951, K.front + 0.15, root, { cast: false });
  const dl = new CircleGeometry(0.07, 20);
  dl.rotateX(Math.PI / 2);
  const dlMat = lib.glow(0xfff4e6, 14);
  for (let x = K.x0 + 0.8; x < K.x1 - 0.5; x += 1.6) w.mesh(dl, dlMat, x, 2.948, K.front + 0.15, root, { cast: false });
  // Slab edge above the fascia.
  w.mesh(box(fW + 0.3, 0.22, 0.7), slabMat, (K.x0 + K.x1) / 2 + 0.15, 4.0, K.front + 0.05, root);

  // --------------------------------------------------- front glazing
  const zf = K.front;
  const mullX = [K.x0 + 0.38, -2.75, -0.85, 1.05, 3.15, K.x1 - 0.36];
  for (const x of mullX) w.mesh(box(0.07, 2.95, 0.14), frame, x, 1.475, zf, root);
  const railY = [0.1, 2.39, 2.92];
  for (const y of railY) w.mesh(box(K.x1 - K.x0 - 0.7, 0.07, 0.13), frame, (K.x0 + K.x1) / 2, y, zf, root);
  // Panes (the door opening gets moving panels instead of a fixed pane).
  const paneCells: [number, number][] = [];
  for (let i = 0; i < mullX.length - 1; i++) {
    const x0 = mullX[i] + 0.035;
    const x1 = mullX[i + 1] - 0.035;
    const cx = (x0 + x1) / 2;
    const pw = x1 - x0;
    const isDoor = i === 3;
    if (!isDoor) {
      const g = new PlaneGeometry(pw, 2.39 - 0.135 - 0.035);
      w.mesh(g, glass, cx, (0.135 + 2.355) / 2, zf, root, { cast: false, receive: false });
      paneCells.push([x0, x1]);
    }
    const t = new PlaneGeometry(pw, 2.885 - 2.425);
    w.mesh(t, glass, cx, (2.425 + 2.885) / 2, zf, root, { cast: false, receive: false });
  }

  // Automatic doors (animated; excluded from batching).
  const doorGroup = new Group();
  doorGroup.userData.dynamic = true;
  root.add(doorGroup);
  const makeDoor = (x: number): Object3D => {
    const g = new Group();
    g.position.set(x, 0, zf - 0.05);
    const dw = 1.02;
    const dh = 2.3;
    const pieces: [number, number, number, number][] = [
      [dw, 0.06, 0, 0.1],
      [dw, 0.06, 0, dh],
      [0.05, dh, -dw / 2 + 0.025, dh / 2 + 0.05],
      [0.05, dh, dw / 2 - 0.025, dh / 2 + 0.05],
    ];
    for (const [bw, bh, bx, by] of pieces) {
      const m = new Mesh(box(bw, bh, 0.06), frame);
      m.position.set(bx, by, 0);
      m.castShadow = true;
      g.add(m);
    }
    const pane = new Mesh(new PlaneGeometry(dw - 0.1, dh - 0.06), glass);
    pane.position.set(0, dh / 2 + 0.1, 0);
    g.add(pane);
    // "自動ドア" sticker band.
    const sticker = w.atlas.draw(512, 64, (c, cw, ch) => {
      c.fillStyle = "#0b4ea2";
      c.fillRect(0, 0, cw, ch);
      c.fillStyle = "#fff";
      c.font = `700 ${ch * 0.6}px ${JP_SANS}`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("自動ドア  AUTOMATIC DOOR", cw / 2, ch / 2);
    });
    const st = new Mesh(atlasPlane(dw - 0.12, 0.06, sticker), lib.sign(w.atlas.texture, 0.35, { key: "atlas-sticker" }));
    st.position.set(0, 1.25, 0.004);
    g.add(st);
    doorGroup.add(g);
    return g;
  };
  const left = makeDoor(1.6);
  const right = makeDoor(2.6);
  w.mesh(box(2.1, 0.12, 0.2), frame, 2.1, 2.45, zf - 0.05, root);

  // East glazing near the corner.
  const ex = K.x1;
  const ez0 = K.front - 0.36;
  const ez1 = -5.3;
  const eLen = ez0 - ez1;
  const ezc = (ez0 + ez1) / 2;
  for (const z of [ez0, ez1]) w.mesh(box(0.14, 2.95, 0.07), frame, ex, 1.475, z, root);
  for (const y of railY) w.mesh(box(0.13, 0.07, eLen), frame, ex, y, ezc, root);
  const eastPane = new PlaneGeometry(eLen - 0.07, 2.22);
  eastPane.rotateY(Math.PI / 2);
  w.mesh(eastPane, glass, ex, 1.245, ezc, root, { cast: false, receive: false });
  const eastTrans = new PlaneGeometry(eLen - 0.07, 0.46);
  eastTrans.rotateY(Math.PI / 2);
  w.mesh(eastTrans, glass, ex, 2.655, ezc, root, { cast: false, receive: false });

  // Posters taped inside the glass.
  const posterMat = lib.interior(0xffffff, 0.75, 0.6, w.atlas.texture, "atlas");
  const posterSpots: [number, number, number][] = [
    [-4.2, 1.55, 0],
    [-2.3, 1.62, 1],
    [-1.72, 1.62, 3],
    [0.62, 1.58, 4],
    [3.6, 1.6, 5],
    [4.45, 1.6, 2],
  ];
  const paperBack = lib.interior(0xe8e6e0, 0.6, 0.8);
  for (const [x, y, idx] of posterSpots) {
    // Taped to the inside of the glass, print facing the street.
    const r = w.atlas.put(poster(idx % POSTER_COUNT));
    w.mesh(atlasPlane(0.44, 0.62, r), posterMat, x, y, zf - 0.015, root, { cast: false });
    w.mesh(new PlaneGeometry(0.44, 0.62), paperBack, x, y, zf - 0.02, root, { cast: false, ry: Math.PI });
  }

  // Door mats.
  w.mesh(box(2.2, 0.012, 0.9), lib.plain(0x2a2c30, 0.95), 2.1, 0.006, zf + 0.5, root, { cast: false });

  // ---------------------------------------------------------- interior
  buildInterior(w, root);

  // -------------------------------------------------- apartments above
  buildUpper(w, root, wallUpper, slabMat, darkFrame);

  // -------------------------------------------------------- forecourt
  buildForecourt(w, root);

  // ----------------------------------------------------------- lights
  // Light pouring out through the glass, with mullion and rack shadows.
  const spill = new SpotLight(0xeef4ff, 90, 26, 1.15, 0.85, 1.6);
  spill.position.set(0.2, 2.75, -4.3);
  spill.target.position.set(0.2, 0, 4.0);
  spill.castShadow = w.quality.shadows;
  spill.shadow.mapSize.set(Math.min(2048, w.quality.shadowMapSize), Math.min(2048, w.quality.shadowMapSize));
  spill.shadow.bias = -0.0004;
  spill.shadow.normalBias = 0.02;
  spill.shadow.camera.near = 0.3;
  spill.shadow.camera.far = 24;
  w.light(spill);
  w.light(spill.target);
  const spillE = new SpotLight(0xeef4ff, 30, 16, 1.0, 0.9, 1.6);
  spillE.position.set(4.6, 2.6, -4.3);
  spillE.target.position.set(11, 0, -4.8);
  w.light(spillE);
  w.light(spillE.target);
  // The fascia washes the forecourt and street.
  const fasciaLight = new RectAreaLight(0xf2f7ff, 3.2, fW, 0.9);
  fasciaLight.position.set((K.x0 + K.x1) / 2, 3.42, K.front + 0.32);
  fasciaLight.lookAt((K.x0 + K.x1) / 2, 0.5, K.front + 6);
  w.light(fasciaLight);
  const fasciaLightE = new RectAreaLight(0xf2f7ff, 4, eastLen, 0.9);
  fasciaLightE.position.set(K.x1 + 0.32, 3.42, K.front + 0.3 - eastLen / 2);
  fasciaLightE.lookAt(K.x1 + 6, 0.5, K.front + 0.3 - eastLen / 2);
  w.light(fasciaLightE);

  for (const x of [-3.4, 0.2, 3.8]) w.fog(new Vector3(x, 3.4, K.front + 0.6), 0xe8f0ff, 0.36, 1.0);
  w.fog(new Vector3(0.2, 2.6, K.front + 0.9), 0xeef4ff, 0.22, 1.8, { direction: new Vector3(0, -0.5, 1), cosOuter: 0.3, cosInner: 0.75 });
  w.fog(new Vector3(K.x1 + 0.4, 3.4, -5.5), 0xe8f0ff, 0.35, 0.7);

  // Keep rain out of the shop and from under the balconies' dry strip.
  w.dry([K.x0, 0, K.z0], [K.x1, 4.2, K.front]);
  // Water running off the fascia and the balcony parapets.
  w.drip([K.x0, 2.93, K.front + 0.31], [K.x1 + 0.05, 2.93, K.front + 0.31]);
  w.drip([K.x1 + 0.31, 2.93, K.front + 0.3], [K.x1 + 0.31, 2.93, K.front + 0.3 - eastLen]);
  for (let f = 1; f < K.upperFloors; f++) w.drip([K.x0 - 0.1, K.height + f * K.upperFloorH - 0.1, K.front + 0.45], [K.x1 + 0.1, K.height + f * K.upperFloorH - 0.1, K.front + 0.45]);

  return { door: { left, right, open: 0 }, fascia };
}

// ==================================================================== interior

function buildInterior(w: World, root: Object3D): void {
  const lib = w.lib;
  const rng = w.rng;
  const zf = K.front;

  // Floor and ceiling.
  const floor = new PlaneGeometry(K.x1 - K.x0 - 0.5, zf - K.z0 - 0.25);
  floor.rotateX(-Math.PI / 2);
  w.mesh(floor, lib.floor(), (K.x0 + K.x1) / 2, 0.003, (zf + K.z0) / 2, root, { cast: false });
  const ceil = new PlaneGeometry(K.x1 - K.x0 - 0.5, zf - K.z0 - 0.25);
  ceil.rotateX(Math.PI / 2);
  w.mesh(ceil, lib.interior(0xf2f2ef, 0.55, 0.9), (K.x0 + K.x1) / 2, K.ceiling, (zf + K.z0) / 2, root, { cast: false, receive: false });
  // LED troffers.
  const troffer = box(0.2, 0.03, 1.25);
  const lightMat = lib.glow(0xf4f8ff, 7, false);
  for (let x = -3.7; x < 5; x += 2.0)
    for (let z = zf - 1.2; z > K.z0 + 0.8; z -= 1.75) w.mesh(troffer, lightMat, x, K.ceiling - 0.012, z, root, { cast: false, receive: false });
  // Inner wall finish.
  const innerWall = lib.interior(0xe9ebea, 0.62, 0.8, undefined, "wall-lining");
  // A surface finish over the wall shell, separated by only 1 cm. Preserve
  // that layering when handheld depth precision cannot resolve the gap.
  innerWall.polygonOffset = true;
  innerWall.polygonOffsetFactor = -2;
  innerWall.polygonOffsetUnits = -2;
  const iw = new PlaneGeometry(zf - K.z0 - 0.3, K.ceiling);
  iw.rotateY(Math.PI / 2);
  w.mesh(iw, innerWall, K.x0 + 0.26, K.ceiling / 2, (zf + K.z0) / 2, root, { cast: false });
  const ie = new PlaneGeometry(-5.35 - K.z0 - 0.3, K.ceiling);
  ie.rotateY(-Math.PI / 2);
  w.mesh(ie, innerWall, K.x1 - 0.26, K.ceiling / 2, (-5.35 + K.z0) / 2, root, { cast: false });
  const ib = new PlaneGeometry(K.x1 - K.x0 - 0.5, K.ceiling);
  w.mesh(ib, innerWall, (K.x0 + K.x1) / 2, K.ceiling / 2, K.z0 + 0.26, root, { cast: false });

  // Product textures.
  const prodTex = toTexture(productAtlas(2048, 1024, 7));
  const prodMat = lib.interior(0xffffff, 1.0, 0.45, prodTex, "products");
  const shelfMat = lib.interior(0xf0f1f2, 0.72, 0.4);
  const plinthMat = lib.interior(0x5a5f66, 0.5, 0.5);
  const band = (i: number, u0: number, u1: number): AtlasRect => ({ u0, u1, v1: 1 - (i * 128 + 2) / 1024, v0: 1 - (i * 128 + 126) / 1024 });

  // Gondolas: double-sided, four product levels a side, stocked with 3D goods
  // in front of a printed backdrop that fills the depth behind them.
  const products = new ProductBatch(rng);
  const gondola = (cx: number, z0: number, z1: number, height: number, themes: Shape[][]) => {
    const len = z0 - z1;
    const cz = (z0 + z1) / 2;
    w.mesh(box(0.92, 0.12, len), plinthMat, cx, 0.06, cz, root, { cast: false });
    w.mesh(box(0.05, height, len), shelfMat, cx, height / 2, cz, root, { cast: false });
    const levels = height > 1.3 ? [0.12, 0.47, 0.82, 1.17] : [0.12, 0.47, 0.82];
    for (const side of [-1, 1]) {
      for (const [li, y] of levels.entries()) {
        const depth = 0.42 - li * 0.04;
        w.mesh(box(depth, 0.025, len), shelfMat, cx + side * (depth / 2 + 0.03), y, cz, root, { cast: false });
        const u0 = rng.range(0, 0.6);
        const facing = new PlaneGeometry(len - 0.02, 0.31);
        mapUV(facing, band(rng.int(0, 7), u0, u0 + len * 0.055));
        facing.rotateY(side * Math.PI / 2);
        w.mesh(facing, prodMat, cx + side * 0.045, y + 0.168, cz, root, { cast: false });
        const gap = (li + 1 < levels.length ? levels[li + 1] : height) - y - 0.05;
        products.fillRun(
          new Vector3(cx + side * (depth + 0.03), y + 0.013, z0 - 0.01),
          new Vector3(0, 0, -1),
          len - 0.02,
          new Vector3(side, 0, 0),
          themes[li % themes.length],
          2,
          0.02,
          gap,
        );
      }
      // top cap
      w.mesh(box(0.92, 0.03, len), shelfMat, cx, height, cz, root, { cast: false });
    }
    // End cap facing the windows, with a featured display.
    const cap = new PlaneGeometry(0.86, height - 0.14);
    mapUV(cap, band(rng.int(0, 7), 0.7, 0.75));
    w.mesh(cap, prodMat, cx, 0.12 + (height - 0.14) / 2, z0 + 0.005, root, { cast: false });
  };
  gondola(-2.55, -5.4, -12.6, 1.55, [["box", "bottle"], ["cup"], ["bag", "box"], ["bag"]]);
  gondola(-0.55, -5.4, -12.6, 1.55, [["bottle", "box"], ["box", "can"], ["cup", "box"], ["bag", "box"]]);
  gondola(1.45, -6.2, -11.2, 1.2, [["box"], ["bag"], ["bag", "box"]]);

  // Hanging aisle signs.
  const aisleNames = ["お菓子", "日用品", "カップ麺", "パン", "文具", "酒"];
  const hang = lib.interior(0xffffff, 1.0, 0.6, w.atlas.texture, "atlas");
  [-2.55, -0.55, 1.45].forEach((x, i) => {
    const r = w.atlas.draw(512, 160, (g, cw, ch) => {
      g.fillStyle = "#0b4ea2";
      g.fillRect(0, 0, cw, ch);
      g.fillStyle = "#fff";
      g.fillRect(0, ch * 0.78, cw, ch * 0.08);
      g.font = `800 ${ch * 0.48}px ${JP_SANS}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(`${aisleNames[i * 2]} ・ ${aisleNames[i * 2 + 1]}`, cw / 2, ch * 0.42);
    });
    const sg = atlasPlane(0.9, 0.28, r);
    w.mesh(sg, hang, x, 2.45, -6.0, root, { cast: false });
    w.mesh(box(0.004, 0.45, 0.004), lib.plain(0x888888, 0.4, 1, false), x - 0.4, 2.74, -6.0, root, { cast: false });
    w.mesh(box(0.004, 0.45, 0.004), lib.plain(0x888888, 0.4, 1, false), x + 0.4, 2.74, -6.0, root, { cast: false });
  });

  // Magazine rack along the front window (facings point inward, tops visible from the street).
  const magTex = toTexture(magazineAtlas());
  const magMat = lib.interior(0xffffff, 0.95, 0.5, magTex, "mags");
  const rackX0 = K.x0 + 0.5;
  const rackX1 = 0.85;
  const rackLen = rackX1 - rackX0;
  const rackCx = (rackX0 + rackX1) / 2;
  // Rack back as seen from the street: satin grey with a steel top rail.
  w.mesh(box(rackLen, 0.95, 0.06), lib.interior(0xb9bec4, 0.5, 0.35), rackCx, 0.475, zf - 0.28, root);
  w.mesh(box(rackLen + 0.02, 0.03, 0.08), lib.plain(0x9aa0a6, 0.3, 0.9, false), rackCx, 0.965, zf - 0.28, root);
  w.mesh(box(rackLen, 0.08, 0.5), plinthMat, rackCx, 0.04, zf - 0.5, root);
  for (let tier = 0; tier < 3; tier++) {
    const mg = new PlaneGeometry(rackLen - 0.04, 0.26);
    mapUV(mg, { u0: tier * 0.2, u1: tier * 0.2 + 0.8, v0: 0.02, v1: 0.98 });
    mg.rotateY(Math.PI);
    mg.rotateX(0.35);
    w.mesh(mg, magMat, rackCx, 0.22 + tier * 0.28, zf - 0.34 - tier * 0.06, root, { cast: false });
  }
  const topTier = new PlaneGeometry(rackLen - 0.04, 0.3);
  mapUV(topTier, { u0: 0.1, u1: 0.9, v0: 0.02, v1: 0.98 });
  topTier.rotateX(-1.1);
  w.mesh(topTier, magMat, rackCx, 0.98, zf - 0.36, root, { cast: false });

  // Walk-in cooler wall at the back.
  const coolTex = toTexture(coolerAtlas());
  const coolMat = lib.interior(0xffffff, 1.35, 0.3, coolTex, "cooler");
  const cz = K.z0 + 0.8;
  const doors = 7;
  const cx0 = K.x0 + 0.45;
  const dw = 0.94;
  const shelfGlow = lib.glow(0xf6fbff, 2.4, false);
  for (let i = 0; i < doors; i++) {
    const x = cx0 + dw * (i + 0.5);
    const face = new PlaneGeometry(dw - 0.06, 2.0);
    mapUV(face, { u0: (i % 3) * 0.3, u1: (i % 3) * 0.3 + 0.36, v0: 0, v1: 1 });
    w.mesh(face, coolMat, x, 1.15, cz - 0.5, root, { cast: false });
    for (let r = 0; r < 6; r++) {
      const y = 0.16 + r * 0.34;
      w.mesh(box(dw - 0.06, 0.012, 0.42), shelfGlow, x, y - 0.006, cz - 0.24, root, { cast: false });
      products.fillRun(new Vector3(x - dw / 2 + 0.05, y, cz - 0.02), new Vector3(1, 0, 0), dw - 0.1, new Vector3(0, 0, 1), r < 2 ? ["bottle"] : r < 4 ? ["bottle", "can"] : ["can"], 3, 0.02, 0.28);
    }
    w.mesh(box(0.05, 2.15, 0.08), lib.plain(0x2b2e33, 0.4, 0.6, false), x - dw / 2, 1.13, cz + 0.05, root);
    // Door handle bar.
    w.mesh(box(0.025, 0.9, 0.04), lib.plain(0xc0c4c8, 0.2, 1, false), x + dw / 2 - 0.1, 1.2, cz + 0.11, root);
  }
  w.mesh(box(dw * doors + 0.05, 0.1, 0.1), lib.plain(0x2b2e33, 0.4, 0.6, false), cx0 + (dw * doors) / 2, 2.22, cz + 0.05, root);
  w.mesh(box(dw * doors + 0.05, 0.12, 0.1), lib.plain(0x2b2e33, 0.4, 0.6, false), cx0 + (dw * doors) / 2, 0.06, cz + 0.05, root);
  const cg = new PlaneGeometry(dw * doors, 2.1);
  w.mesh(cg, lib.storeGlass(), cx0 + (dw * doors) / 2, 1.15, cz + 0.07, root, { cast: false, receive: false });
  // Header sign above the coolers.
  const drinkSign = w.atlas.draw(1024, 128, (g, cw, ch) => {
    g.fillStyle = "#0f9d74";
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = "#fff";
    g.font = `800 ${ch * 0.55}px ${JP_SANS}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("ドリンク ・ DRINKS ・ つめたい飲み物", cw / 2, ch / 2);
  });
  w.mesh(atlasPlane(dw * doors, 0.32, drinkSign), hang, cx0 + (dw * doors) / 2, 2.5, cz + 0.02, root, { cast: false });

  // Open chiller along the west wall (bento, onigiri, sandwiches).
  const chillTex = toTexture(chillerAtlas());
  const chillMat = lib.interior(0xffffff, 1.2, 0.35, chillTex, "chiller");
  const chX = K.x0 + 0.62;
  w.mesh(box(0.72, 0.62, 8.5), lib.interior(0x30343a, 0.4, 0.4), chX, 0.31, -9.6, root);
  w.mesh(box(0.2, 2.0, 8.5), lib.interior(0x30343a, 0.4, 0.4), K.x0 + 0.36, 1.0, -9.6, root);
  for (let t = 0; t < 4; t++) {
    const f = new PlaneGeometry(8.4, 0.34);
    mapUV(f, { u0: 0, u1: 1, v0: 1 - (t + 1) * 0.25 + 0.01, v1: 1 - t * 0.25 - 0.01 });
    f.rotateY(Math.PI / 2);
    w.mesh(f, chillMat, K.x0 + 0.5 + t * 0.06, 0.8 + t * 0.34, -9.6, root, { cast: false });
    w.mesh(box(0.5 - t * 0.06, 0.02, 8.4), lib.glow(0xffffff, 2.2, false), K.x0 + 0.72 - t * 0.03, 0.97 + t * 0.34, -9.6, root, { cast: false });
    const tierY = t === 0 ? 0.625 : 0.64 + t * 0.34;
    products.fillRun(new Vector3(K.x0 + 0.98 - t * 0.08, tierY, -5.4), new Vector3(0, 0, -1), 8.4, new Vector3(1, 0, 0), t === 0 ? ["tray"] : t === 1 ? ["onigiri"] : ["tray", "onigiri", "box"], 2, 0.03, 0.14);
  }

  // Counter with registers, hot snack case and coffee machine.
  const counterMat = lib.interior(0xf3f1ec, 0.7, 0.4);
  w.mesh(box(0.75, 0.98, 5.4), counterMat, 3.7, 0.49, -8.4, root);
  w.mesh(box(0.9, 0.04, 5.5), lib.interior(0xb9bcc0, 0.6, 0.25), 3.72, 1.0, -8.4, root);
  const stripe = new PlaneGeometry(5.4, 0.12);
  stripe.rotateY(-Math.PI / 2);
  w.mesh(stripe, lib.glow(0x0f9d74, 0.9, false), 3.32, 0.78, -8.4, root, { cast: false });
  // POS registers: body, clerk touchscreen, customer display on a stalk, card
  // pad and receipt printer. Japanese POS hardware is pale grey.
  const posBody = lib.interior(0xd9dbde, 0.62, 0.35);
  const posDark = lib.interior(0x2a2c30, 0.4, 0.3);
  for (const z of [-7.2, -9.4]) {
    w.mesh(box(0.34, 0.09, 0.42), posBody, 3.8, 1.065, z, root);
    const clerkScreen = w.group(3.98, 1.12, z, 0, root);
    clerkScreen.rotation.z = -0.5;
    w.mesh(box(0.03, 0.26, 0.36), posDark, 0, 0.13, 0, clerkScreen);
    const cs = new PlaneGeometry(0.33, 0.23);
    cs.rotateY(Math.PI / 2);
    w.mesh(cs, lib.glow(0x9fd8ff, 1.5, false), 0.017, 0.13, 0, clerkScreen, { cast: false });
    w.mesh(new CylinderGeometry(0.012, 0.012, 0.22, 8), posDark, 3.62, 1.2, z + 0.12, root);
    w.mesh(box(0.03, 0.1, 0.16), posDark, 3.62, 1.33, z + 0.12, root);
    const cust = new PlaneGeometry(0.14, 0.08);
    cust.rotateY(-Math.PI / 2);
    w.mesh(cust, lib.glow(0x7ff0c0, 1.2, false), 3.604, 1.33, z + 0.12, root, { cast: false });
    w.mesh(box(0.1, 0.03, 0.14), posDark, 3.55, 1.035, z - 0.14, root);
    w.mesh(box(0.14, 0.1, 0.14), posBody, 3.86, 1.07, z - 0.3, root);
  }
  // Hot snack warmer: steel frame, warm back light, two racks of fried chicken
  // and croquettes behind curved-front glass.
  const steel = lib.interior(0xb9bec2, 0.55, 0.25);
  const wz = -6.1;
  const wx = 3.72;
  w.mesh(box(0.5, 0.03, 0.9), steel, wx, 1.035, wz, root);
  w.mesh(box(0.5, 0.03, 0.9), steel, wx, 1.47, wz, root);
  for (const dz of [-0.44, 0.44]) w.mesh(box(0.5, 0.44, 0.02), steel, wx, 1.25, wz + dz, root);
  const back = new PlaneGeometry(0.86, 0.4);
  back.rotateY(-Math.PI / 2);
  w.mesh(back, lib.glow(0xffb468, 1.6, false), wx + 0.24, 1.25, wz, root, { cast: false });
  w.mesh(box(0.46, 0.015, 0.86), lib.glow(0xffc27a, 2.2, false), wx, 1.45, wz, root, { cast: false });
  const food = [lib.interior(0xb5651d, 1.0, 0.55), lib.interior(0xc98a3a, 1.0, 0.5), lib.interior(0x8a4a1a, 0.95, 0.55)];
  for (const [ri, y] of [1.05, 1.24].entries()) {
    w.mesh(box(0.44, 0.012, 0.84), steel, wx, y, wz, root, { cast: false });
    for (let i = 0; i < 6; i++)
      w.mesh(new RoundedBoxGeometry(0.1, 0.055, 0.11, 2, 0.022), food[(i + ri) % 3], wx - 0.08 + (i % 2) * 0.14, y + 0.035, wz - 0.3 + Math.floor(i / 2) * 0.28, root, { cast: false });
  }
  w.mesh(box(0.02, 0.4, 0.86), lib.storeGlass(), wx - 0.25, 1.25, wz, root, { cast: false, receive: false });
  w.mesh(box(0.45, 0.62, 0.5), lib.interior(0x16171a, 0.35, 0.3), 3.8, 1.32, -10.6, root);
  const cm = new PlaneGeometry(0.3, 0.18);
  cm.rotateY(-Math.PI / 2);
  w.mesh(cm, lib.glow(0xffd28a, 2.0, false), 3.57, 1.45, -10.6, root, { cast: false });
  // Tobacco wall behind the counter.
  const tobTex = toTexture(tobaccoWall());
  const tob = new PlaneGeometry(4.4, 1.3);
  tob.rotateY(-Math.PI / 2);
  w.mesh(tob, lib.interior(0xffffff, 1.3, 0.4, tobTex, "tobacco"), K.x1 - 0.3, 1.95, -8.3, root, { cast: false });
  // Shelf lips per row and a frame give the lit wall its depth.
  const lip = lib.interior(0xe4e6e8, 0.75, 0.3);
  for (let r = 0; r <= 7; r++) w.mesh(box(0.08, 0.018, 4.4), lip, K.x1 - 0.34, 1.3 + (r * 1.3) / 7, -8.3, root, { cast: false });
  for (const dz of [-2.22, 2.22]) w.mesh(box(0.12, 1.36, 0.04), lip, K.x1 - 0.33, 1.95, -8.3 + dz, root);
  w.mesh(box(0.12, 0.3, 4.48), lib.interior(0x0f9d74, 0.8, 0.4), K.x1 - 0.33, 2.76, -8.3, root);

  // ATM and multi-copy machine by the east window.
  w.mesh(box(0.62, 1.45, 0.62), lib.interior(0x6b7078, 0.55, 0.35), 4.72, 0.725, -3.95, root);
  const atmScreen = new PlaneGeometry(0.36, 0.28);
  atmScreen.rotateY(-Math.PI / 2);
  w.mesh(atmScreen, lib.glow(0x5fb7ff, 1.6, false), 4.405, 1.12, -3.95, root, { cast: false });
  w.mesh(box(0.7, 1.15, 0.85), lib.interior(0xdcdfe2, 0.7, 0.4), 4.7, 0.575, -4.85, root);
  const copyScreen = new PlaneGeometry(0.3, 0.2);
  copyScreen.rotateY(-Math.PI / 2);
  copyScreen.rotateZ(0.5);
  w.mesh(copyScreen, lib.glow(0x9fe3ff, 1.4, false), 4.33, 1.22, -4.85, root, { cast: false });

  // Staff door.
  w.mesh(box(0.9, 2.1, 0.05), lib.interior(0x9aa1a8, 0.55, 0.5), 3.9, 1.05, K.z0 + 0.3, root);

  // On "low" the printed shelf backdrops carry the shop on their own.
  if (w.quality.level !== "low") {
    const stock = new Group();
    stock.userData.dynamic = true;
    root.add(stock);
    products.build(stock, 0.95, prodTex);
    console.info(`[tokyo] ${products.count} products on the shelves`);
  }
}

// ================================================================ upstairs

function buildUpper(w: World, root: Object3D, wall: Material, slab: Material, frame: Material): void {
  const lib = w.lib;
  const rng = w.rng;
  const base = K.height;
  const fh = K.upperFloorH;
  const n = K.upperFloors;
  const top = base + fh * n;
  const recess = K.front - 0.9;
  const width = K.x1 - K.x0;
  const cx = (K.x0 + K.x1) / 2;
  const winMat = lib.interiorWindows();

  // Main mass (recessed front wall behind the balconies).
  w.mesh(box(width, top - base, recess - K.z0), wall, cx, (base + top) / 2, (recess + K.z0) / 2, root);
  // Parapet and roof furniture.
  w.mesh(box(width + 0.1, 0.9, 0.2), wall, cx, top + 0.45, K.z0 + 0.1, root);
  w.mesh(box(width + 0.1, 0.9, 0.2), wall, cx, top + 0.45, K.front + 0.2, root);
  w.mesh(box(0.2, 0.9, K.front - K.z0 + 0.4), wall, K.x0 - 0.05, top + 0.45, (K.front + K.z0) / 2 + 0.1, root);
  w.mesh(box(0.2, 0.9, K.front - K.z0 + 0.4), wall, K.x1 + 0.05, top + 0.45, (K.front + K.z0) / 2 + 0.1, root);
  w.mesh(new CylinderGeometry(0.9, 0.9, 1.6, 20), lib.paint(0xb9bdb6, 0.5), -2.4, top + 1.0, -12.5, root);
  w.mesh(box(2.4, 2.4, 2.6), wall, 2.8, top + 1.2, -12.0, root);
  w.mesh(new CylinderGeometry(0.03, 0.03, 4, 6), lib.paint(0x777777, 0.4), -3.8, top + 2.2, -6, root);
  w.mesh(box(1.4, 0.03, 0.03), lib.paint(0x777777, 0.4), -3.8, top + 3.6, -6, root);

  const bays = 3;
  const bayW = width / bays;
  for (let f = 0; f < n; f++) {
    const y0 = base + f * fh;
    // Balcony slab (floor 0's slab is the fascia roof, already built).
    if (f > 0) w.mesh(box(width + 0.2, 0.18, 1.35), slab, cx, y0, K.front - 0.23, root);
    // Solid tiled parapet with an aluminium top rail.
    w.mesh(box(width + 0.2, 0.95, 0.12), wall, cx, y0 + 0.09 + 0.475, K.front + 0.38, root);
    w.mesh(box(width + 0.24, 0.05, 0.16), frame, cx, y0 + 1.07, K.front + 0.38, root);
    // Partitions between units.
    for (let b = 1; b < bays; b++) w.mesh(box(0.06, 2.1, 1.2), lib.paint(0xd8d8d2, 0.5), K.x0 + b * bayW, y0 + 1.14, K.front - 0.25, root);
    for (let b = 0; b < bays; b++) {
      const bx = K.x0 + (b + 0.5) * bayW;
      // Sliding window onto a parallax room.
      const wg = seedWindowUV(new PlaneGeometry(bayW - 0.9, 2.0), rng.int(0, 999), 200 + f);
      w.mesh(wg, winMat, bx, y0 + 0.2 + 1.0, recess + 0.02, root, { cast: false });
      // Frame.
      w.mesh(box(bayW - 0.84, 0.06, 0.08), frame, bx, y0 + 0.2, recess + 0.04, root);
      w.mesh(box(bayW - 0.84, 0.06, 0.08), frame, bx, y0 + 2.2, recess + 0.04, root);
      w.mesh(box(0.05, 2.0, 0.08), frame, bx, y0 + 1.2, recess + 0.05, root);
      // Outdoor AC unit on some balconies.
      if (rng.chance(0.6)) {
        const ac = w.group(bx + rng.range(-0.6, 0.6), y0 + 0.09, K.front - 0.35, 0, root);
        acUnit(w, ac);
      }
    }
  }

  // East elevation: side windows of the flats, onto parallax rooms.
  for (let f = 0; f < n; f++) {
    for (const z of [-6.5, -10.5, -14]) {
      const g = seedWindowUV(new PlaneGeometry(0.9, 1.1), rng.int(0, 999), 300 + f);
      g.rotateY(Math.PI / 2);
      w.mesh(g, winMat, K.x1 + 0.005, base + f * fh + 1.5, z, root, { cast: false });
      w.mesh(box(0.08, 0.06, 1.0), frame, K.x1 + 0.03, base + f * fh + 0.92, z, root);
      w.mesh(box(0.06, 1.16, 0.05), frame, K.x1 + 0.02, base + f * fh + 1.5, z - 0.47, root);
      w.mesh(box(0.06, 1.16, 0.05), frame, K.x1 + 0.02, base + f * fh + 1.5, z + 0.47, root);
    }
  }

  // Tenant sign stack on the corner, facing the cross street.
  const signs = [
    { text: "整体院", sub: "2F", bg: "#ffffff", fg: "#1a7a3a" },
    { text: "英会話", sub: "3F", bg: "#e8332a", fg: "#ffffff" },
    { text: "占い館", sub: "4F", bg: "#3a1a6a", fg: "#ffd85a" },
    { text: "歯科", sub: "5F", bg: "#ffffff", fg: "#0b4ea2" },
  ];
  const stack = w.group(K.x1 + 0.55, base + 0.6, K.front + 0.1, 0, root);
  signs.forEach((s, i) => {
    const r = w.atlas.draw(256, 640, (g, cw, ch) => {
      const c = lightboxSign({ ...s, vertical: true }, cw, ch);
      g.drawImage(c, 0, 0);
    });
    const y = i * 1.35;
    w.mesh(box(0.22, 1.25, 0.62), lib.paint(0x222222, 0.5), 0, y + 0.625, 0, stack);
    for (const side of [-1, 1]) {
      const p = atlasPlane(0.58, 1.2, r);
      p.rotateY(side * Math.PI / 2);
      w.mesh(p, lib.sign(w.atlas.texture, 1.8, { key: "atlas-signs" }), side * 0.112, y + 0.625, 0, stack, { cast: false });
    }
  });
  w.mesh(box(0.08, 5.6, 0.08), lib.paint(0x333333, 0.5), -0.3, 2.8, 0, stack);
  w.fog(new Vector3(K.x1 + 0.8, base + 3.2, K.front), 0xffe0d0, 0.25, 1.4);
}

/** Outdoor air-conditioner unit (室外機). */
export function acUnit(w: World, parent: Object3D): void {
  const lib = w.lib;
  w.mesh(box(0.8, 0.6, 0.3), lib.paint(0xe6e2d6, 0.5), 0, 0.3, 0, parent);
  const grill = new CircleGeometry(0.22, 24);
  w.mesh(grill, lib.plain(0x1a1a1a, 0.7), -0.12, 0.3, 0.151, parent, { cast: false });
  for (let i = -3; i <= 3; i++) w.mesh(box(0.44, 0.012, 0.012), lib.plain(0x999999, 0.5, 0.5), -0.12, 0.3 + i * 0.06, 0.16, parent, { cast: false });
  w.mesh(box(0.05, 0.05, 0.3), lib.plain(0x333333, 0.6), -0.3, 0.02, 0, parent);
  w.mesh(box(0.05, 0.05, 0.3), lib.plain(0x333333, 0.6), 0.3, 0.02, 0, parent);
}

// ============================================================== forecourt

function buildForecourt(w: World, root: Object3D): void {
  const lib = w.lib;
  const zf = K.front;
  // Recycling station: burnables / PET / cans & bottles.
  const labels: [string, string][] = [
    ["燃えるゴミ", "#e8332a"],
    ["ペットボトル", "#1f6fd1"],
    ["かん・びん", "#1faa59"],
  ];
  const binBody = lib.paint(0x6f747a, 0.4);
  labels.forEach(([t, col], i) => {
    const x = -0.35 + i * 0.5;
    w.mesh(new RoundedBoxGeometry(0.46, 0.95, 0.42, 3, 0.03), binBody, x, 0.475, zf + 0.35, root);
    w.mesh(box(0.3, 0.1, 0.02), lib.plain(0x0a0a0a, 0.8), x, 0.8, zf + 0.565, root, { cast: false });
    const r = w.atlas.draw(256, 256, (g, cw, ch) => {
      g.fillStyle = col;
      g.fillRect(0, 0, cw, ch);
      g.fillStyle = "#fff";
      g.font = `800 ${cw * 0.13}px ${JP_SANS}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(t, cw / 2, ch * 0.4);
      g.font = `700 ${cw * 0.1}px ${LATIN}`;
      g.fillText(["BURNABLE", "PET", "CANS"][i], cw / 2, ch * 0.7);
    });
    w.mesh(atlasPlane(0.3, 0.3, r), lib.sign(w.atlas.texture, 0.3, { key: "atlas-labels" }), x, 0.52, zf + 0.563, root, { cast: false });
  });

  // Umbrella stand with forgotten clear umbrellas.
  const stand = w.group(3.55, 0, zf + 0.3, 0, root);
  const steel = lib.plain(0x9aa0a6, 0.35, 0.9);
  w.mesh(box(0.8, 0.04, 0.3), steel, 0, 0.62, 0, stand);
  w.mesh(box(0.8, 0.04, 0.3), steel, 0, 0.05, 0, stand);
  for (const x of [-0.38, 0.38]) w.mesh(box(0.03, 0.62, 0.03), steel, x, 0.32, 0, stand);
  const vinyl = lib.vinyl();
  const handle = lib.plain(0xf0f0f0, 0.3);
  for (let i = 0; i < 5; i++) {
    const u = w.group(-0.3 + i * 0.15, 0.03, w.rng.range(-0.06, 0.06), 0, stand);
    u.rotation.z = w.rng.range(-0.12, 0.12);
    u.rotation.x = w.rng.range(-0.1, 0.1);
    const canopy = new CylinderGeometry(0.035, 0.012, 0.62, 10, 1, true);
    w.mesh(canopy, vinyl, 0, 0.42, 0, u, { cast: false });
    w.mesh(new CylinderGeometry(0.006, 0.006, 0.9, 5), handle, 0, 0.5, 0, u);
    const hook = new CylinderGeometry(0.012, 0.012, 0.12, 6);
    hook.rotateZ(Math.PI / 2);
    w.mesh(hook, handle, 0.04, 0.95, 0, u);
  }
}
