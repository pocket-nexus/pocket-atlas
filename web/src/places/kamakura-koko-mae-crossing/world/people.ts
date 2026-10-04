import { Vector3 } from "three";
import { thinFigure } from "../../shared/people/thin";
import { stand, walk, wander, type Gait } from "../../shared/people/motion";
import { mapPath, patrol } from "../../shared/people/paths";
import { Figure, type Build, type Look } from "../../shared/people/rig";
import { Wear } from "../../shared/people/wear";
import type { KamakuraWorld } from "./context";
import { COAST, LOOP, SECTION } from "./layout";

/*
 * Two ordinary summer visitors on the shared procedural, skinned rig: a man in a cap standing at the sea-wall fence west of the
 * junction, looking out over the bay, and a woman strolling the Route 134 sidewalk
 * east of the junction and back. No crowd, no costumes. Paints use two
 * roughness classes, so a figure costs two draws on the handheld. All
 * motion is periodic in the loop: the stroll covers its circuit once per
 * loop with a whole number of gait cycles, the idle sways repeat a whole
 * number of times.
 */

/** Clustering cell for the handheld figures (m): about 1.5k triangles a person. */
const CELL = 0.05;

/** Sidewalk height above the rail (road 0.06 + kerb 0.15). */
const WALK_Y = 0.21;


export function buildPeople(w: KamakuraWorld): void {
  const root = w.group();
  root.name = "people";
  root.userData.dynamic = true;
  const wear = new Wear(w.lib, false);

  // ---- standing at the sea-wall fence west of the junction, looking out over the bay
  {
    const build: Build = { height: 1.74, hair: "short", top: { t: 0.014, hem: 0.74, cuff: 0.02 }, legs: { loose: 0.01 }, shoe: "sneaker" };
    const look: Look = {
      skin: { hex: 0xb48e76, rough: 0.55 },
      hair: { hex: 0x15110f, rough: 0.55 },
      top: { hex: 0x2c3e5a, rough: 0.75 },
      bottom: { hex: 0xb9ab8e, rough: 0.75 },
      shoes: { hex: 0xe6e4de, rough: 0.55 },
      cap: { hex: 0xd8d4c8, rough: 0.75 },
    };
    const f = new Figure(build, look, wear);
    // On the sea-wall top inside the fence, west of the junction, facing the bay toward Enoshima.
    COAST.offset(-7, SECTION.wallFence - 0.55, f.root.position).setY(WALK_Y);
    const t = COAST.tangent(-7, new Vector3());
    f.root.rotation.y = Math.atan2(-t.z, t.x) - 0.45;
    root.add(f.root);
    thinFigure(f, CELL);
    const s = f.d.s;
    const feet: [Vector3, Vector3] = [new Vector3(0.11, 0.075 * s, 0.02), new Vector3(-0.1, 0.075 * s, -0.03)];
    const k = (2 * Math.PI) / LOOP;
    w.update((_dt, t) => {
      const tl = ((t % LOOP) + LOOP) % LOOP;
      stand(f, {
        feet,
        toe: [0.16, -0.16],
        weight: 0.5 * Math.tanh(2 * Math.sin(tl * k * 5 + 1)),
        lean: 0.03,
        twist: 0.04 * Math.sin(tl * k * 7 + 1),
        breath: tl * k * 40,
        // A slow look left and right along the bay, three times a loop.
        yaw: 0.25 * Math.sin(tl * k * 3 + 2) + 0.1 * wander(0, 1),
        pitch: 0.05 * Math.sin(tl * k * 6 + 1),
      });
      f.swing(0, 0.04, -0.04, 0.25, 0.1);
      f.swing(1, -0.03, -0.04, 0.25, 0.1);
    });
  }

  // ---- strolling the Route 134 sidewalk east of the junction and back, once per loop
  {
    const build: Build = { height: 1.62, fem: 1, hair: "bob", top: { t: 0.012, hem: 0.62, cuff: 0.02 }, legs: { loose: 0.02 }, shoe: "sneaker" };
    const look: Look = {
      skin: { hex: 0xc9a08a, rough: 0.55 },
      hair: { hex: 0x2a1c16, rough: 0.55 },
      top: { hex: 0xa9c4d8, rough: 0.75 },
      bottom: { hex: 0xeceae2, rough: 0.75 },
      shoes: { hex: 0xf0efe9, rough: 0.55 },
      cap: { hex: 0xe9dfc8, rough: 0.75 },
    };
    const f = new Figure(build, look, wear);
    root.add(f.root);
    thinFigure(f, CELL);
    // Out along s = 4.3 m of the coast line, back along 5.1 m.
    const path = mapPath(patrol("x", -14, 40, 4.3, 5.1), (u, s, out) => COAST.offset(u, s, out));
    // One circuit per loop, a whole number of gait cycles in it.
    const speed = path.length / LOOP;
    const cycles = Math.round(path.length / 1.12);
    const gait: Gait = { stride: path.length / cycles, lift: 0.09, arm: 0.2, lean: 0.03, look: 0.06 };
    // Start the circuit so she is mid-sidewalk, walking east, as the train arrives (t ≈ 23).
    const d0 = path.length - 23 * speed + 22;
    w.update((_dt, t) => {
      const d = (((t * speed + d0) % path.length) + path.length) % path.length;
      f.root.rotation.y = path.at(d, f.root.position);
      f.root.position.y = WALK_Y;
      walk(f, (d / path.length) * cycles, gait, [true, true]);
    });
  }
}
