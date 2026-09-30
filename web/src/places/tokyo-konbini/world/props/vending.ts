import { CircleGeometry, CylinderGeometry, PlaneGeometry, RectAreaLight, Vector3 } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mapUV } from "../../gfx/atlas";
import { canvas, JP_SANS, LATIN, toTexture, vendingFront } from "../../gfx/canvas";
import { box } from "../../gfx/geo";
import type { World } from "../context";
import { L } from "../layout";
import { atlasPlane, palette, type Kit } from "./util";

/** Drink vending machines (自動販売機) at the alley mouth, fronts on the north building line. */
export const VENDING = { x0: L.alley.x0 + 0.05, x1: L.alley.x1 - 0.05, z: L.mainNorth, depth: 0.74, height: 1.83 };

/** Brightest cool-white source on the street: 1.9 × 1.2 m of backlit display. */
const PANEL = { color: 0xe6f1ff, intensity: 9, emissive: 2.3 };

export function buildVending(w: World, kit: Kit): void {
  const lib = w.lib;
  const root = w.group();
  root.name = "vending";
  const V = VENDING;
  const zf = V.z;
  const H = V.height;
  const D = V.depth;
  const gap = 0.02;
  const W = (V.x1 - V.x0 - gap) / 2;

  // Both fronts share one texture (one material, one draw call).
  const { c, g } = canvas(1024, 1024);
  g.drawImage(vendingFront("TOKYO COLA", "#c71f1b", 3), 0, 0, 512, 1024);
  g.drawImage(vendingFront("AQUA BLUE", "#1c5fc4", 8), 512, 0, 512, 1024);
  // The lower service panel is not backlit.
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(0, 1024 * 0.64, 1024, 1024 * 0.36);
  const frontMat = lib.sign(toTexture(c), PANEL.emissive, { key: "vending-fronts", rough: 0.2 });
  const P = palette(lib);
  const bodies = [P.red, P.blue];
  const dark = P.black;
  const glass = lib.storeGlass();

  for (let i = 0; i < 2; i++) {
    const cx = V.x0 + W / 2 + i * (W + gap);
    const body = bodies[i];
    // Plinth, cabinet, visor.
    w.mesh(box(W - 0.04, 0.06, D - 0.06), dark, cx, 0.03, zf - D / 2 - 0.01, root);
    w.mesh(box(W, H - 0.06, D - 0.02), body, cx, 0.06 + (H - 0.06) / 2, zf - 0.02 - (D - 0.02) / 2, root);
    w.mesh(box(W + 0.02, 0.045, D + 0.02), body, cx, H + 0.012, zf - D / 2 + 0.005, root);
    // Emissive front (whole canvas half), inset in the cabinet.
    const pw = W - 0.07;
    const ph = H - 0.13;
    const py = 0.06 + (H - 0.06) / 2 + 0.015;
    const front = new PlaneGeometry(pw, ph);
    mapUV(front, { u0: i * 0.5 + 0.002, u1: i * 0.5 + 0.498, v0: 0.002, v1: 0.998 });
    w.mesh(front, frontMat, cx, py, zf - 0.012, root, { cast: false });
    // Display window glass over the sample rows (canvas y 0.09..0.61).
    const gy = py + ph / 2 - ph * 0.35;
    w.mesh(new PlaneGeometry(pw - 0.04, ph * 0.54), glass, cx, gy, zf - 0.004, root, { cast: false, receive: false });
    // Coin/bill unit bezel and the dispenser mouth.
    const unitY = py + ph / 2 - ph * 0.73;
    w.mesh(box(0.26, 0.15, 0.035), dark, cx + pw * 0.29, unitY, zf - 0.005, root, { cast: false });
    w.mesh(box(0.08, 0.02, 0.012), P.screen, cx + pw * 0.29, unitY + 0.04, zf + 0.014, root, { cast: false });
    const dispY = py - ph / 2 + ph * 0.1;
    w.mesh(box(pw - 0.12, 0.18, 0.05), dark, cx, dispY, zf, root);
    w.mesh(box(pw - 0.16, 0.12, 0.02), P.dark, cx, dispY + 0.005, zf + 0.022, root, { cast: false });
    // Coin return cup.
    w.mesh(box(0.1, 0.06, 0.05), dark, cx + pw * 0.29, unitY - 0.14, zf, root, { cast: false });
  }
  // Side panels read the brand colour; a thin light gap between the two cabinets.
  w.mesh(box(gap, H - 0.1, 0.02), P.screen, (V.x0 + V.x1) / 2, H / 2, zf - 0.03, root, { cast: false });

  // Recycling box (空き缶・ペットボトル) beside the machines, on the konbini apron.
  const bx = V.x1 + 0.3;
  const bz = zf - 0.28;
  const bin = w.group(bx, 0, bz, -0.08, root);
  w.mesh(new RoundedBoxGeometry(0.46, 0.86, 0.38, 2, 0.025), P.white, 0, 0.43, 0, bin);
  w.mesh(box(0.48, 0.035, 0.4), P.blue, 0, 0.875, 0, bin);
  const label = kit.draw("recycle", 128, 128, (g2, cw, ch) => {
    g2.fillStyle = "#f4f4f0";
    g2.fillRect(0, 0, cw, ch);
    g2.fillStyle = "#1c5fc4";
    g2.fillRect(0, 0, cw, ch * 0.2);
    g2.fillStyle = "#fff";
    g2.textAlign = "center";
    g2.textBaseline = "middle";
    g2.font = `800 ${ch * 0.1}px ${LATIN}`;
    g2.fillText("RECYCLE", cw / 2, ch * 0.1);
    g2.fillStyle = "#222";
    g2.font = `900 ${ch * 0.14}px ${JP_SANS}`;
    g2.fillText("空き缶", cw / 2, ch * 0.62);
    g2.fillText("ペットボトル", cw / 2, ch * 0.82);
    g2.fillStyle = "#1a1a1a";
    for (const x of [0.3, 0.7]) {
      g2.beginPath();
      g2.arc(cw * x, ch * 0.36, ch * 0.1, 0, Math.PI * 2);
      g2.fill();
    }
  });
  w.mesh(atlasPlane(0.4, 0.4, label), kit.labels, 0, 0.62, 0.192, bin, { cast: false });
  // Two insertion holes on the top face.
  for (const x of [-0.11, 0.11]) {
    const hole = new CircleGeometry(0.055, 16);
    hole.rotateX(-Math.PI / 2);
    w.mesh(hole, dark, x, 0.895, 0.05, bin, { cast: false });
  }
  // An overflow bottle on top and a can on the ground.
  w.mesh(new CylinderGeometry(0.032, 0.034, 0.2, 10), lib.vinyl(), -0.12, 0.995, -0.08, bin, { cast: false });
  w.mesh(new CylinderGeometry(0.018, 0.018, 0.02, 8), P.white, -0.12, 1.105, -0.08, bin, { cast: false });
  const can = new CylinderGeometry(0.033, 0.033, 0.122, 12);
  can.rotateZ(Math.PI / 2);
  can.rotateY(0.7);
  w.mesh(can, P.chrome, bx + 0.34, 0.033, bz + 0.52, root);

  // Light: one area light across both fronts, plus its haze.
  const rect = new RectAreaLight(PANEL.color, PANEL.intensity, V.x1 - V.x0, 1.2);
  rect.position.set((V.x0 + V.x1) / 2, 1.15, zf + 0.02);
  rect.lookAt((V.x0 + V.x1) / 2, 0.9, zf + 6);
  w.light(rect, root);
  w.fog(new Vector3((V.x0 + V.x1) / 2, 1.2, zf + 0.35), 0xe4f0ff, 0.6, 0.6);
}
