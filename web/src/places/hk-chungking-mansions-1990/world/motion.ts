import { BoxGeometry, CylinderGeometry, Group, type Material } from "three";
import type { DayWorld } from "../../shared/daylight/context";
import { vehicleShell } from "../../shared/daylight/vehicle-shell";
import { Parts, instance } from "../../shared/shapes";
import { source } from "../../shared/provenance";
import { Figure } from "../../shared/people/rig";
import { Wear } from "../../shared/people/wear";
import { thinFigure } from "../../shared/people/thin";
import { walk } from "../../shared/people/motion";
import { LOOP } from "./layout";
import { label } from "./fabric";

const mod = (t: number) => ((t % LOOP) + LOOP) % LOOP;

/** Photo-derived 9.7 m two-axle MCW-era bus: cream/red, opening windows, no modern air-con roof pod. */
function bus(w: DayWorld) {
  const root = source("traffic/period-double-decker", w.group()); root.userData.dynamic = true;
  const p = new Parts(), cream = w.lib.paint(0xc9c7a8, .49), red = w.lib.paint(0x973f2e, .45);
  const rubber = w.lib.plain(0x1e2826, .85), metal = w.lib.plain(0x788680, .42, .6), glazing = w.lib.glass("dark");
  const b = (mat: Material, size: [number, number, number], at: [number, number, number]) => p.add(mat, new BoxGeometry(...size).translate(...at));
  b(rubber, [2.22, .22, 9.1], [0, .55, 0]);
  b(red, [2.44, .85, 9.55], [0, .92, 0]);
  b(cream, [2.45, .40, 9.60], [0, 2.19, 0]);
  b(cream, [2.42, .18, 9.54], [0, 4.15, 0]);
  b(cream, [2.38, .10, 9.25], [0, 2.64, 0]);
  // Window ribbons have a genuine open hollow shell with rows of seats inside.
  for (const side of [-1, 1]) {
    for (let bay = 0; bay < 7; bay++) {
      const z = -4.1 + bay * 1.35;
      for (const y of [1.7, 3.36]) {
        b(glazing, [.026, y < 2 ? 1.08 : 1.28, 1.23], [side * 1.222, y, z]);
        b(metal, [.07, y < 2 ? 1.15 : 1.36, .052], [side * 1.24, y, z + .65]);
        b(metal, [.035, .038, 1.30], [side * 1.242, y + .29, z]);
      }
      b(cream, [.08, .27, 1.28], [side * 1.235, 2.47, z]);
    }
    for (const level of [0, 1]) for (let row = 0; row < 8; row++) {
      b(w.lib.plain(0x684832, .94), [.83, .44, .17], [side * .69, 1.31 + level * 1.65, -3.98 + row * 1.07]);
      b(w.lib.plain(0x684832, .94), [.83, .11, .65], [side * .69, 1.11 + level * 1.65, -3.72 + row * 1.07]);
    }
  }
  for (const z of [-4.79, 4.79]) {
    b(glazing, [2.20, 1.11, .025], [0, 1.71, z]);
    b(glazing, [2.21, 1.23, .025], [0, 3.4, z]);
    b(cream, [.085, 3.40, .08], [-1.16, 2.43, z]); b(cream, [.085, 3.40, .08], [1.16, 2.43, z]);
    b(metal, [.05, 1.22, .04], [0, 3.42, z + Math.sign(z) * .018]);
    b(rubber, [2.34, .15, .12], [0, .55, z]);
    for (const x of [-.88, .88]) b(w.lib.glow(z > 0 ? 0xffdc97 : 0xe05b3b, z > 0 ? 1.4 : .8), [.20, .13, .04], [x, .95, z + Math.sign(z) * .035]);
  }
  // Period roll-blind; empty destination avoids inventing a documented run through Nathan Road.
  b(rubber, [1.75, .36, .05], [0, 2.49, 4.83]);
  b(cream, [2.4, .22, .14], [0, 2.77, 4.79]);
  for (const z of [3.85, .85]) { // left-hand front entry and centre exit
    b(rubber, [.03, 1.96, .94], [-1.265, 1.35, z]);
    for (const dz of [-.26, .26]) b(glazing, [.045, 1.6, .38], [-1.29, 1.49, z + dz]);
    b(metal, [.05, 1.85, .035], [-1.32, 1.44, z]);
  }
  for (let i = 0; i < 9; i++) b(metal, [1.65, .035, .025], [0, .91 + i * .055, -4.82]);
  instance(p.bake(), root);
  const wheels: Group[] = [];
  for (const x of [-1.16, 1.16]) for (const z of [-2.7, 2.65]) {
    const wheel = w.group(x, .48, z, 0, root); wheels.push(wheel);
    const tire = w.mesh(new CylinderGeometry(.47, .47, .29, 16).rotateZ(Math.PI / 2), rubber, 0, 0, 0, wheel);
    tire.name = "period-bus-tire";
    w.mesh(new CylinderGeometry(.25, .25, .30, 12).rotateZ(Math.PI / 2), metal, 0, 0, 0, wheel);
  }
  label(w, root, "bus-fleet", "九龍巴士", "KOWLOON MOTOR BUS", 3.05, .46, [0, 2.45, -4.87], { bg: "#bebea2", ink: "#833729", ry: Math.PI });
  return { root, wheels };
}

/** Angular pre-Comfort taxi silhouette; no Toyota Comfort/JPN Taxi introduced after 1990. */
function taxi(w: DayWorld) {
  const root = source("traffic/period-red-sedan", w.group()); root.userData.dynamic = true;
  const shell = vehicleShell({ wheelbase: 2.68, wheelRadius: .31,
    sideWindows: [[-1.12, -.13], [.01, 1.01]], windscreen: [.75, 1.27], rearWindow: [-1.46, -.98],
    sections: [[-2.30,.76,.31,.85,.89,.69], [-1.77,.85,.24,.98,1.01,.76], [-1.44,.85,.24,1.02,1.13,.72], [-.94,.85,.24,1.02,1.42,.64], [.59,.85,.24,1.02,1.45,.64], [1.28,.85,.24,.98,1.05,.74], [1.85,.84,.25,.91,.98,.74], [2.30,.78,.3,.82,.9,.70]] });
  w.mesh(shell.paint, w.lib.paint(0xa43c32, .26), 0, 0, 0, root);
  w.mesh(shell.glass, w.lib.glass("dark"), 0, 0, 0, root);
  const p = new Parts(), silver = w.lib.paint(0xc2c4b8, .35), dark = w.lib.plain(0x28312e, .8), steel = w.lib.plain(0x969e93, .32, .7);
  const b = (mat: Material, size: [number, number, number], at: [number, number, number]) => p.add(mat, new BoxGeometry(...size).translate(...at));
  b(silver, [1.27, .055, 1.59], [0, 1.443, -.17]);
  b(dark, [1.61, .14, .18], [0, .43, 2.31]); b(dark, [1.61, .14, .18], [0, .43, -2.31]);
  b(steel, [1.61, .035, .2], [0, .53, 2.31]); b(steel, [1.61, .035, .2], [0, .53, -2.31]);
  b(dark, [.74, .22, .025], [0, .72, 2.325]);
  for (let i = 0; i < 6; i++) b(steel, [.72, .015, .028], [0, .63 + i * .035, 2.34]);
  for (const side of [-1, 1]) {
    for (const z of [-.60, .56]) b(steel, [.026, .044, .13], [side * .855, .95, z]);
    b(steel, [.014, .027, 3.78], [side * .86, .73, 0]);
    b(dark, [.14, .10, .21], [side * .925, 1.10, .90]);
    b(w.lib.glow(0xf8e5b1, 1.4), [.4, .19, .04], [side * .59, .74, 2.32]);
    b(w.lib.glow(0xc53e21, .7), [.42, .18, .04], [side * .59, .72, -2.32]);
  }
  b(silver, [.47, .19, .24], [0, 1.57, 0]); instance(p.bake(), root);
  label(w, root, "taxi-roof", "的士", "TAXI", .42, .17, [0, 1.585, .131], { bg: "#dbd7af", ink: "#b3402c", lit: true });
  const wheels: Group[] = [];
  for (const x of [-.80, .80]) for (const z of [-1.34, 1.34]) {
    const wheel = w.group(x, .31, z, 0, root); wheels.push(wheel);
    w.mesh(new CylinderGeometry(.31, .31, .19, 16).rotateZ(Math.PI / 2), dark, 0, 0, 0, wheel);
    w.mesh(new CylinderGeometry(.18, .18, .20, 12).rotateZ(Math.PI / 2), steel, 0, 0, 0, wheel);
  }
  return { root, wheels };
}

export function buildMotion(w: DayWorld) {
  const coach = bus(w), cab = taxi(w);
  coach.root.position.x = -21.0; coach.root.rotation.y = Math.PI;
  cab.root.position.x = -8.0;
  w.update((_dt, t) => {
    const bt = mod(t + 35), ct = mod(t + 38);
    coach.root.position.z = 450 - bt * 7.5;
    cab.root.position.z = -500 + ct * (1000 / LOOP);
    for (const wheel of coach.wheels) wheel.rotation.x = -bt * 7.5 / .47;
    for (const wheel of cab.wheels) wheel.rotation.x = ct * (1000 / LOOP) / .31;
  });
  const wear = new Wear(w.lib, false);
  const palette = [[0xb48d70, 0xc5bd9c, 0x465358], [0x885d43, 0x73827a, 0x3c4541], [0xc6a283, 0x9d6e50, 0x505952]];
  for (let i = 0; i < 3; i++) {
    const [skin, top, bottom] = palette[i];
    const figure = new Figure({ height: 1.64 + i * .045, fem: i === 2 ? .75 : .1, hair: i === 2 ? "bob" : "short", top: { t: .01, hem: .91, cuff: .01 }, legs: { loose: .01 }, shoe: "shoe" }, {
      skin: { hex: skin, rough: .75 }, hair: { hex: 0x242b26, rough: .75 }, top: { hex: top, rough: .75 }, bottom: { hex: bottom, rough: .75 }, shoes: { hex: 0x282f2a, rough: .55 },
    }, wear);
    thinFigure(figure, .036);
    source(`people/ordinary-passerby-${i}`, figure.root); w.root.add(figure.root);
    const baseZ = [-8, 7, -18][i];
    w.update((_dt, t) => {
      const tt = mod(t), phase = tt / LOOP * Math.PI * 2 + i * 1.7;
      if (i === 2) {
        figure.root.position.set(12.6, .25, -1.65); figure.root.rotation.y = -Math.PI / 2;
        figure.reset(); figure.head.rotation.y = Math.sin(phase) * .12; figure.chest.rotation.z = Math.sin(phase * 2) * .015; figure.sync();
      } else {
        // A closed, narrow pavement ellipse avoids teleports and repeats exactly at 120 s.
        const z = baseZ + Math.sin(phase) * 8.5, x = -2.0 - i * .65 + Math.cos(phase) * .45;
        figure.root.position.set(x, .17, z); figure.root.rotation.y = Math.atan2(-.45 * Math.sin(phase), 8.5 * Math.cos(phase));
        walk(figure, tt * .6 + i * .25, { stride: .52, lift: .075, arm: .21, lean: .035, look: -.03 }, [true, true]);
      }
    });
  }
}
