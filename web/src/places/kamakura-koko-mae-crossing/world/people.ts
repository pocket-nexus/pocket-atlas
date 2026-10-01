import { Vector3 } from "three";
import type { MaterialLib } from "../../tokyo-konbini/gfx/materials";
import { stand, wander } from "../../tokyo-konbini/world/people/motion";
import { Figure, type Build, type Look } from "../../tokyo-konbini/world/people/rig";
import { Wear } from "../../tokyo-konbini/world/people/wear";
import type { KamakuraWorld } from "./context";
import { LOOP } from "./layout";

/*
 * Two ordinary visitors on the procedural rig of Rainy Night Konbini, in
 * summer clothes: one by the rules board at the north-west corner looking
 * out to sea, one on the Route 134 sidewalk east of the crossing. No crowd,
 * no costumes. Their idle motion is periodic in the loop.
 */

const _a = new Vector3();

export function buildPeople(w: KamakuraWorld): void {
  if (new URLSearchParams(location.search).has("nopeople")) return;
  const root = w.group();
  root.name = "people";
  root.userData.dynamic = true;
  const wear = new Wear(w.lib as unknown as MaterialLib, false);
  const people: [Build, Look, Vector3, number][] = [
    [
      { height: 1.66, fem: 1, hair: "bob", top: { t: 0.012, hem: 0.62, cuff: 0.02 }, legs: { loose: 0.012 }, shoe: "sneaker" },
      { skin: { hex: 0xc49c82, rough: 0.55 }, hair: { hex: 0x2a1c16, rough: 0.4 }, top: { hex: 0xe8e4da, rough: 0.75 }, bottom: { hex: 0x5a6f8c, rough: 0.65 }, shoes: { hex: 0xeeeeea, rough: 0.5 } },
      new Vector3(-6.4, 0.24, -4.7),
      Math.PI * 0.82,
    ],
    [
      { height: 1.74, hair: "short", top: { t: 0.014, hem: 0.74, cuff: 0.02 }, legs: { loose: 0.008 }, shoe: "sneaker" },
      { skin: { hex: 0xb48e76, rough: 0.55 }, hair: { hex: 0x15110f, rough: 0.4 }, top: { hex: 0x2c3e5a, rough: 0.7 }, bottom: { hex: 0xb9ab8e, rough: 0.7 }, shoes: { hex: 0x30302e, rough: 0.5 }, cap: { hex: 0xd8d4c8, rough: 0.6 } },
      new Vector3(11.5, 0.21, 6.4),
      Math.PI * 0.95,
    ],
  ];
  people.forEach(([build, look, pos, ry], i) => {
    const f = new Figure(build, look, wear);
    f.root.position.copy(pos);
    f.root.rotation.y = ry;
    root.add(f.root);
    const s = f.d.s;
    const feet: [Vector3, Vector3] = [new Vector3(0.11, 0.075 * s, 0.02), new Vector3(-0.1, 0.075 * s, -0.03)];
    // Slow idle, a whole number of cycles per loop.
    const k = (2 * Math.PI) / LOOP;
    w.update((_dt, t) => {
      const tl = ((t % LOOP) + LOOP) % LOOP;
      stand(f, {
        feet,
        toe: [0.16, -0.16],
        weight: 0.5 * Math.tanh(2 * Math.sin(tl * k * 6 + i)),
        lean: 0.03,
        twist: 0.04 * Math.sin(tl * k * 9 + i),
        breath: tl * k * 40,
        yaw: 0.3 * Math.sin(tl * k * 5 + i * 2) + 0.1 * wander(0, i),
        pitch: 0.04 * Math.sin(tl * k * 7 + i),
      });
      f.swing(0, 0.04, -0.04, 0.25, 0.1);
      f.swing(1, -0.03, -0.04, 0.25, 0.1);
    });
  });
  void _a;
}
