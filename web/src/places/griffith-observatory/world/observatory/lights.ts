import { Color, Object3D, PointLight, SpotLight } from "three";
import type { ObsLib } from "../../gfx/observatory-materials";
import type { GriffithWorld } from "../context";
import { groundY } from "../dem";
import type { DomeLights } from "./domes";
import { drumPoint, type DrumLights } from "./drum";
import { Kits, type V3 } from "./kit";
import { DRUM, FACADE, LEVEL, ROTUNDA } from "./plan";

/**
 * The floodlighting at blue hour (p01, p02, p04, p05, p09, p14): warm
 * uplights (2700–3000 K, est.) at the foot of every pilaster grazing up the
 * drum, wall-washers in the planters along the north façade, uplights on
 * the promenade's arch walls for the upper drum, washers on the telescope
 * drums. The domes themselves are not floodlit. Every fixture is a real
 * three.js spot light that the exporter writes and the cooker bakes into
 * the vertices; the walls they graze are cut into ~0.7–1.3 m strips so the
 * fans keep their shape before the cooker refines them.
 */

/**
 * Colour temperatures (linear RGB, max channel 1) as the photographs' white
 * balance renders them: 2700–3000 K under a camera balanced for the mixed
 * dusk light reads (1.0, 0.72, 0.5), not the D65-balanced (1.0, 0.45, 0.13)
 * that comes out saturated orange through the AgX grade (C, from p01 / p04).
 */
export const K2700 = new Color(1.0, 0.7, 0.47);
export const K3000 = new Color(1.0, 0.73, 0.52);

/** Intensities (candela) and reach; tuned against p02 / p04 at the stage's exposure. */
const WASHER = { intensity: 115, distance: 12, angle: 0.3, penumbra: 0.85 };
const UPLIGHT = { intensity: 300, distance: 17, angle: 0.28, penumbra: 0.6 };
const BAY = { intensity: 135, distance: 15, angle: 0.55, penumbra: 0.9 };
const UPPER = { intensity: 58, distance: 4.8, angle: 0.55, penumbra: 0.8 };

/** A spot light aimed at `target`, its direction kept through the glTF export (target child at (0, 0, −1)). */
export function spot(w: GriffithWorld, color: Color, intensity: number, distance: number, angle: number, penumbra: number, pos: V3, target: V3): SpotLight {
  const s = new SpotLight(color, intensity, distance, angle, penumbra, 2);
  s.position.set(pos[0], pos[1], pos[2]);
  w.root.add(s);
  s.lookAt(target[0], target[1], target[2]);
  const t = new Object3D();
  t.position.set(0, 0, -1);
  s.add(t);
  s.target = t;
  s.name = "griffith-floodlight";
  return s;
}

export function point(w: GriffithWorld, color: Color, intensity: number, distance: number, pos: V3): PointLight {
  const p = new PointLight(color, intensity, distance, 2);
  p.position.set(pos[0], pos[1], pos[2]);
  w.root.add(p);
  return p;
}

/** A ground fixture: a dark box with a glowing lens facing up. */
function fixture(K: Kits, lib: ObsLib, p: V3): void {
  const steel = K.of(lib.steel());
  steel.box(p[0] - 0.12, p[0] + 0.12, p[1] - 0.15, p[1] + 0.05, p[2] - 0.12, p[2] + 0.12, "ny");
  const lens = K.of(lib.glow(K3000, 1.6, "lens"));
  lens.flat(
    [
      [p[0] - 0.06, p[2] - 0.06],
      [p[0] + 0.06, p[2] - 0.06],
      [p[0] + 0.06, p[2] + 0.06],
      [p[0] - 0.06, p[2] + 0.06],
    ],
    p[1] + 0.055,
    1,
  );
}

export function buildFloodlights(w: GriffithWorld, lib: ObsLib, K: Kits, at: { piers: number[]; drum: DrumLights; domes: DomeLights }): number {
  let n = 0;
  // North façade: a washer in the planter at the foot of each pilaster.
  for (const x of at.piers) {
    const p: V3 = [x, 1.5, FACADE.z - 0.75];
    spot(w, K3000, WASHER.intensity, WASHER.distance, WASHER.angle, WASHER.penumbra, p, [x, 8.0, FACADE.z]);
    fixture(K, lib, p);
    n++;
  }
  // Pavilion: one on each corner block's pilaster pair, aimed at the lettering's ends too.
  const { pav } = FACADE;
  for (const x of [(pav.x0 + FACADE.recess.x0) / 2, (FACADE.recess.x1 + pav.x1) / 2]) {
    const p: V3 = [x, 1.95, pav.z - 1.0];
    spot(w, K3000, WASHER.intensity * 1.3, WASHER.distance + 2, WASHER.angle + 0.08, WASHER.penumbra, p, [x, 7.5, pav.z]);
    fixture(K, lib, p);
    n++;
  }
  // Lower drum: an uplight a metre out from each pilaster's foot, grazing up its face,
  // and a wider washer in each bay between them (p01: the whole lower drum reads cream).
  const bay = (2 * Math.PI) / DRUM.bays;
  for (const { t, y } of at.drum.lower) {
    const p = drumPoint(DRUM.r + 1.25, t, y + 0.15);
    const g = groundY(p[0], p[2]);
    p[1] = Math.max(p[1], g + 0.15);
    spot(w, K2700, UPLIGHT.intensity, UPLIGHT.distance, UPLIGHT.angle, UPLIGHT.penumbra, p, drumPoint(DRUM.r + 0.45, t, p[1] + 10));
    fixture(K, lib, p);
    n++;
    const tb = t + bay / 2;
    if (!at.drum.lower.some((o) => Math.abs(o.t - (t + bay)) < 1e-3)) continue;
    const q = drumPoint(DRUM.r + 2.6, tb, 0);
    q[1] = groundY(q[0], q[2]) + 0.25;
    spot(w, K2700, BAY.intensity, BAY.distance, BAY.angle, BAY.penumbra, q, drumPoint(DRUM.r, tb, q[1] + 7));
    fixture(K, lib, q);
    n++;
  }
  // Upper drum: on the arch walls (south) or the deck (north), grazing up the stepped pilasters.
  for (const { t, y } of at.drum.upper) {
    const p = drumPoint(DRUM.rUpper + 1.0, t, y);
    const reach = 15.6 - y;
    spot(w, K2700, UPPER.intensity, Math.max(UPPER.distance, reach + 0.8), UPPER.angle, UPPER.penumbra, p, drumPoint(DRUM.rUpper + 0.62, t, y + 1.3));
    fixture(K, lib, p);
    n++;
  }
  // Rotunda: four uplights in its light well on the octagon's diagonal faces (p02, p04: the drum glows under the green roof).
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const p: V3 = [ROTUNDA.x + Math.cos(a) * (ROTUNDA.r + 0.55), LEVEL.deck - 1.9, ROTUNDA.z + Math.sin(a) * (ROTUNDA.r + 0.55)];
    spot(w, K3000, 65, 7, 0.6, 0.85, p, [ROTUNDA.x + Math.cos(a) * (ROTUNDA.r - 0.4), ROTUNDA.wallTop - 0.5, ROTUNDA.z + Math.sin(a) * (ROTUNDA.r - 0.4)]);
    n++;
  }
  // Side walls of the block (p01: the walls beside the drum read lit; p14: the east wing): washers at their feet.
  const sides: [number, number, number, number][] = [
    // x, z of the fixture, then the wall point it aims at (x, z) — at 6 m up.
    [-18.1, -5.5, -17.2, -5.5],
    [-18.1, -0.5, -17.2, -0.5],
    [-16.2, -17.0, -15.3, -17.0],
    [-16.2, -11.0, -15.3, -11.0],
    [-28.0, -20.8, -28.0, -21.7],
    [-22.5, -20.8, -22.5, -21.7],
    [32.0, -19.5, 31.1, -19.5],
    [32.0, -13.0, 31.1, -13.0],
    [22.0, -7.4, 22.0, -8.3],
    [28.0, -7.4, 28.0, -8.3],
    [19.7, -3.0, 18.8, -3.0],
  ];
  for (const [x0, z0, tx, tz] of sides) {
    // 1.4 m out from the wall, a broad wash (the photos show these walls evenly lit, not fanned).
    const dx = x0 - tx;
    const dz = z0 - tz;
    const l = Math.hypot(dx, dz) || 1;
    const x = tx + (dx / l) * 1.4;
    const z = tz + (dz / l) * 1.4;
    const p: V3 = [x, groundY(x, z) + 0.2, z];
    spot(w, K3000, WASHER.intensity * 1.3, WASHER.distance + 3, WASHER.angle + 0.32, 1, p, [tx, p[1] + 5, tz]);
    fixture(K, lib, p);
    n++;
  }
  // Telescope drums.
  for (const { pos, aim } of at.domes.washers) {
    spot(w, K3000, WASHER.intensity, WASHER.distance, WASHER.angle + 0.1, WASHER.penumbra, pos, aim);
    fixture(K, lib, pos);
    n++;
  }
  return n;
}
