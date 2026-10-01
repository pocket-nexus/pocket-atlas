import { Vector3, type Object3D } from "three";
import { box } from "../../shared/geo";
import { phone } from "../../shared/people/gear";
import { stand, walk, wander, type Gait } from "../../shared/people/motion";
import { patrol } from "../../shared/people/paths";
import { Figure, type Build, type Look } from "../../shared/people/rig";
import { Wear } from "../../shared/people/wear";
import type { AkibaWorld } from "./context";

/*
 * Generic pedestrians on the shared procedural rig (one
 * skeleton, vertex-coloured skinned meshes per roughness class). The street
 * is closed to vehicles 16:00–19:00, so people walk down the middle of the
 * carriageway as well as on the sidewalks; two wait by the entrance, one
 * reads a phone under the clock. Motion is a pure function of the clock.
 */

const _a = new Vector3();
const _b = new Vector3();
const _pole = new Vector3();

type Outfit = [Build, Look];
const skinTones = [0xc49c82, 0xb48e76, 0xcca68e, 0xa47e66];
const hairs = [0x15110f, 0x2a1c16, 0x0f0d0c, 0x3a2a20];

/** October evening, 17 °C: light jackets, hoodies, cardigans, shirts. */
function outfit(i: number): Outfit {
  const skin = { hex: skinTones[i % 4], rough: 0.55 };
  const hair = { hex: hairs[(i * 3) % 4], rough: 0.4 };
  const list: Outfit[] = [
    [{ height: 1.74, hair: "short", top: { t: 0.022, hem: 0.8, hood: true, cuff: -0.004 }, legs: { loose: 0.004 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0x2b2f38, rough: 0.6 }, bottom: { hex: 0x22304a, rough: 0.55 }, shoes: { hex: 0xd8d6cc, rough: 0.5 } }],
    [{ height: 1.62, fem: 1, hair: "bob", top: { t: 0.018, hem: 0.62, flare: 0.08, cuff: 0.006 }, legs: { tights: true }, shoe: "boot" }, { skin, hair, top: { hex: 0xb8a48a, rough: 0.7 }, bottom: { hex: 0x1d1d22, rough: 0.5 }, shoes: { hex: 0x3a2a20, rough: 0.45 }, scarf: { hex: 0x8a3a40, rough: 0.85 } }],
    [{ height: 1.76, hair: "short", top: { t: 0.016, hem: 0.8, vneck: true, cuff: 0.004 }, legs: { loose: 0.007 } }, { skin, hair, top: { hex: 0x2a2d34, rough: 0.5 }, bottom: { hex: 0x24272e, rough: 0.5 }, shoes: { hex: 0x101010, rough: 0.25 }, shirt: { hex: 0xdfe4ea, rough: 0.55 }, tie: { hex: 0x5a2030, rough: 0.4 } }],
    [{ height: 1.7, hair: "short", top: { t: 0.02, hem: 0.78, cuff: 0.004 }, legs: { loose: 0.006 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0x5a6a4a, rough: 0.7 }, bottom: { hex: 0x3a3a40, rough: 0.6 }, shoes: { hex: 0x202022, rough: 0.5 }, cap: { hex: 0x161718, rough: 0.5 } }],
    [{ height: 1.58, fem: 1, hair: "bob", top: { t: 0.016, hem: 0.74, cuff: 0.004 }, legs: { loose: 0.012 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0xe8e2d6, rough: 0.75 }, bottom: { hex: 0x3c4a64, rough: 0.6 }, shoes: { hex: 0xeeeeea, rough: 0.5 } }],
    [{ height: 1.8, hair: "short", top: { t: 0.024, hem: 0.66, flare: 0.06, cuff: 0.008 }, legs: { loose: 0.006 } }, { skin, hair, top: { hex: 0x4a3a2c, rough: 0.6 }, bottom: { hex: 0x1e1f24, rough: 0.5 }, shoes: { hex: 0x2a1c14, rough: 0.35 }, mask: { hex: 0xe4e6e8, rough: 0.8 } }],
    [{ height: 1.66, fem: 1, hair: "bob", top: { t: 0.02, hem: 0.56, flare: 0.12, cuff: 0.006 }, legs: { tights: true }, shoe: "boot" }, { skin, hair, top: { hex: 0x1c2438, rough: 0.6 }, bottom: { hex: 0x161618, rough: 0.5 }, shoes: { hex: 0x121212, rough: 0.35 } }],
    [{ height: 1.72, hair: "short", top: { t: 0.02, hem: 0.8, hood: true, cuff: -0.004 }, legs: { loose: 0.006 }, shoe: "sneaker" }, { skin, hair, top: { hex: 0x8a2a2c, rough: 0.65 }, bottom: { hex: 0x2a3550, rough: 0.55 }, shoes: { hex: 0x303236, rough: 0.5 }, mask: { hex: 0x22252a, rough: 0.8 } }],
  ];
  return list[i % list.length];
}

export function buildPeople(w: AkibaWorld): void {
  const root = w.group();
  root.name = "people";
  root.userData.dynamic = true;
  const wear = new Wear(w.lib, false);
  const backpack = w.lib.plain(0x1a1c20, 0.6);
  const strap = w.lib.plain(0x101114, 0.6);

  // Walkers: [lane out, lane back, x0, x1, speed, phase].
  const walkers: [number, number, number, number, number, number][] = [
    [-8.6, -7.6, -56, 38, 1.25, 0],
    [-10.9, -10.0, -52, 36, 1.15, 70],
    [-3.2, -2.4, -46, 30, 1.3, 140],
    [-17.4, -16.7, -50, 33, 1.2, 30],
    [-6.6, -9.8, -40, 40, 1.05, 110],
    [-11.8, -6.9, -58, 20, 1.35, 160],
    [-4.4, -3.6, -36, 26, 1.1, 55],
    [-14.4, -14.95, -30, 40, 1.28, 90],
  ];
  walkers.forEach(([l0, l1, x0, x1, speed, phase], i) => {
    const [build, look] = outfit(i);
    const f = new Figure(build, look, wear);
    root.add(f.root);
    const s = f.d.s;
    const path = patrol("x", x0, x1, l0, l1);
    const gait: Gait = { stride: 1.12 * s, lift: 0.1, arm: 0.2, lean: 0.04, look: 0.1 };
    const pack = i % 3 === 0;
    if (pack) {
      const bp = box(0.3 * s, 0.4 * s, 0.14 * s);
      const m = w.mesh(bp, backpack, 0, -0.08 * s, -0.17 * s, f.chest);
      m.castShadow = false;
      for (const sx of [-0.09, 0.09]) w.mesh(box(0.035, 0.36 * s, 0.24 * s), strap, sx * s, 0.0, -0.05 * s, f.chest);
    }
    const looking = i % 4 === 1;
    let ph: Object3D | null = null;
    if (looking) {
      ph = phone(w.lib.plain(0x121316, 0.25, 0.3), w.lib.glow(0xd2e2ff, 1.4), f.chest);
      ph.position.set(-0.04, -0.09, 0.26);
      ph.rotation.set(1.1, 0.1, 0.05);
    }
    w.update((_dt, t) => {
      const d = t * speed + phase;
      f.root.rotation.y = path.at(d, f.root.position);
      walk(f, d / gait.stride, gait, [true, !looking]);
      if (looking && ph) {
        ph.updateMatrixWorld();
        f.reach(1, f.root.worldToLocal(ph.localToWorld(_a.set(0.01, -0.1, 0.03))), _pole.set(-1, -0.8, -0.3).normalize());
        f.aim(1, f.root.worldToLocal(ph.localToWorld(_b.set(0.005, -0.03, 0.012))));
      }
    });
  });

  // Standing: two by the entrance (one on a phone), one under the pole clock.
  const standers: [number, number, number, number][] = [
    [-10.1, -1.15, Math.PI * 0.9, 8],
    [-9.2, -1.45, -Math.PI * 0.85, 9],
    [16.9, -16.3, -0.6, 10],
  ];
  for (const [x, z, ry, i] of standers) {
    const [build, look] = outfit(i);
    const f = new Figure(build, look, wear);
    f.root.position.set(x, 0, z);
    f.root.rotation.y = ry;
    root.add(f.root);
    const s = f.d.s;
    const withPhone = i !== 9;
    const ph = withPhone ? phone(w.lib.plain(0x121316, 0.25, 0.3), w.lib.glow(0xd2e2ff, 1.4), f.chest) : null;
    if (ph) {
      ph.position.set(-0.04, -0.085, 0.25);
      ph.rotation.set(1.12, 0.12, 0.08);
    }
    const feet: [Vector3, Vector3] = [new Vector3(0.12, 0.075 * s, 0.03), new Vector3(-0.1, 0.075 * s, -0.03)];
    w.update((_dt, t) => {
      stand(f, {
        feet,
        toe: [0.16, -0.16],
        weight: 0.5 * Math.tanh(2 * Math.sin(t * 0.12 + i)),
        lean: 0.04,
        twist: 0.04 * wander(t * 0.3, i),
        breath: t * 1.4,
        yaw: 0.25 * wander(t * 0.4, i + 3) * (withPhone ? 0.3 : 1),
        pitch: withPhone ? 0.6 : 0.05 * wander(t * 0.5, i + 5),
      });
      if (ph) {
        ph.updateMatrixWorld();
        f.reach(1, f.root.worldToLocal(ph.localToWorld(_a.set(0.01, -0.105, 0.03))), _pole.set(-1, -0.8, -0.3).normalize());
        f.aim(1, f.root.worldToLocal(ph.localToWorld(_b.set(0.005, -0.03, 0.012))));
        f.swing(0, 0.05, -0.03, 0.2, 0.1);
      } else {
        f.swing(0, 0.04, -0.04, 0.25, 0.1);
        f.swing(1, -0.03, -0.04, 0.25, 0.1);
      }
    });
  }
}
