import { RepeatWrapping, Vector3, type Object3D, type Texture } from "three";
import { canvas, toTexture } from "../../shared/canvas";
import { basket, briefcase, closedUmbrella, magazine, magazineTexture, openUmbrella, phone } from "../../shared/people/gear";
import { pulse, stand, walk, wander, type Gait } from "../../shared/people/motion";
import { patrol } from "../../shared/people/paths";
import { Figure } from "../../shared/people/rig";
import { smooth } from "../../shared/people/shape";
import { Wear } from "../../shared/people/wear";
import type { World } from "./context";
import { L } from "./layout";

/*
 * People: a reader at the magazine rack, the clerk at the register and a
 * shopper in the aisle (interior-lit), plus a man waiting under the fascia
 * with his phone and two pedestrians under umbrellas (street-lit, casting
 * shadows). Every figure is one skeleton with a skinned mesh per material;
 * all motion is a pure function of the scene clock.
 */

const K = L.konbini;
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _pole = new Vector3();

function place(f: Figure, parent: Object3D, x: number, z: number, ry: number): Figure {
  f.root.position.set(x, 0, z);
  f.root.rotation.y = ry;
  parent.add(f.root);
  f.root.updateMatrixWorld(true);
  return f;
}

/** Root-space position of a point in `o`'s local frame (matrices must be current). */
function rootPoint(f: Figure, o: Object3D, x: number, y: number, z: number, out: Vector3): Vector3 {
  return f.root.worldToLocal(o.localToWorld(out.set(x, y, z)));
}

/** Vertical pinstripes in the shop's blue and green on white (u is meters around the body). */
function uniformStripes(): Texture {
  const { c, g } = canvas(64, 4);
  g.fillStyle = "#eef2f4";
  g.fillRect(0, 0, 64, 4);
  g.fillStyle = "#2f6fc0";
  g.fillRect(6, 0, 9, 4);
  g.fillStyle = "#1c9a78";
  g.fillRect(38, 0, 5, 4);
  const t = toTexture(c, true, 4);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1 / 0.03, 1);
  return t;
}

/** The cast: build and outfit per figure (materials from the indoor or outdoor wardrobe). */
const LOOKS = {
  /** Salaryman in a charcoal suit. */
  reader: (wr: Wear) =>
    new Figure(
      { height: 1.73, hair: "short", top: { t: 0.014, hem: 0.8, vneck: true, cuff: 0.004 }, legs: { loose: 0.006 } },
      {
        skin: { hex: 0xc49c82, rough: 0.55, lit: 0.72 },
        hair: { hex: 0x15110f, rough: 0.42, lit: 0.7 },
        top: { hex: 0x30343b, rough: 0.66, lit: 0.8 },
        bottom: { hex: 0x2b2e34, rough: 0.62, lit: 0.78 },
        shoes: { hex: 0x141414, rough: 0.32, lit: 0.7 },
        shirt: { hex: 0xe2e6ea, rough: 0.6, lit: 0.85 },
        tie: { hex: 0x2a3a5c, rough: 0.42, lit: 0.8 },
      },
      wr,
    ),
  /** Store uniform: pinstriped smock, navy bib apron, name badge, mask. */
  clerk: (wr: Wear) => {
    const stripes = { hex: 0xffffff, rough: 0.7, lit: 0.85, map: uniformStripes() };
    return new Figure(
      { height: 1.7, hair: "short", top: { t: 0.009, hem: 0.84, cuff: 0.003 }, legs: { loose: 0.006 }, shoe: "sneaker" },
      {
        skin: { hex: 0xc9a288, rough: 0.55, lit: 0.72 },
        hair: { hex: 0x1a1512, rough: 0.45, lit: 0.65 },
        top: stripes,
        bottom: { hex: 0x202228, rough: 0.7, lit: 0.75 },
        shoes: { hex: 0x1c1c1e, rough: 0.5, lit: 0.7 },
        apron: { hex: 0x1f3558, rough: 0.72, lit: 0.8 },
        badge: { hex: 0xf4f4ef, rough: 0.5, lit: 0.95 },
        mask: { hex: 0xe9ecee, rough: 0.85, lit: 0.92 },
        shirt: stripes,
      },
      wr,
    );
  },
  /** Woman in a knee-length camel coat, scarf, dark tights, ankle boots. */
  shopper: (wr: Wear) =>
    new Figure(
      { height: 1.6, fem: 1, hair: "bob", top: { t: 0.02, hem: 0.52, flare: 0.12, cuff: 0.008 }, legs: { tights: true }, shoe: "boot" },
      {
        skin: { hex: 0xcca68e, rough: 0.55, lit: 0.74 },
        hair: { hex: 0x2a1c16, rough: 0.45, lit: 0.72 },
        top: { hex: 0xa99a80, rough: 0.72, lit: 0.78 },
        bottom: { hex: 0x1b1b20, rough: 0.5, lit: 0.7 },
        shoes: { hex: 0x3a2a20, rough: 0.45, lit: 0.7 },
        scarf: { hex: 0x7b3037, rough: 0.85, lit: 0.78 },
      },
      wr,
    ),
  /** Charcoal hoodie, jeans, sneakers, black cap and mask. */
  waiter: (wr: Wear) =>
    new Figure(
      { height: 1.76, hair: "short", top: { t: 0.024, hem: 0.8, hood: true, cuff: -0.006 }, legs: { loose: 0.003 }, shoe: "sneaker", cast: true },
      {
        skin: { hex: 0xb48e76, rough: 0.5 },
        hair: { hex: 0x0f0d0c, rough: 0.34 },
        top: { hex: 0x3a3d44, rough: 0.58 },
        bottom: { hex: 0x1e2636, rough: 0.52 },
        shoes: { hex: 0xbfbdb5, rough: 0.48 },
        cap: { hex: 0x141518, rough: 0.5 },
        mask: { hex: 0xdfe2e5, rough: 0.78 },
      },
      wr,
    ),
  /** Long wet wool coat and scarf. */
  south: (wr: Wear) =>
    new Figure(
      { height: 1.74, hair: "short", top: { t: 0.024, hem: 0.52, flare: 0.1, cuff: 0.01 }, legs: { loose: 0.008 }, cast: true },
      {
        skin: { hex: 0xb48e76, rough: 0.5 },
        hair: { hex: 0x100d0c, rough: 0.3 },
        top: { hex: 0x1f232b, rough: 0.55 },
        bottom: { hex: 0x17181c, rough: 0.42 },
        shoes: { hex: 0x0c0c0d, rough: 0.2 },
        scarf: { hex: 0x6b6862, rough: 0.72 },
      },
      wr,
    ),
  /** Suit, shirt and tie; rain-dark. */
  cross: (wr: Wear) =>
    new Figure(
      { height: 1.75, hair: "short", top: { t: 0.016, hem: 0.8, vneck: true, cuff: 0.004 }, legs: { loose: 0.007 }, cast: true },
      {
        skin: { hex: 0xb08a73, rough: 0.5 },
        hair: { hex: 0x0e0c0b, rough: 0.32 },
        top: { hex: 0x22252c, rough: 0.42 },
        bottom: { hex: 0x1f2127, rough: 0.45 },
        shoes: { hex: 0x0a0a0b, rough: 0.16 },
        shirt: { hex: 0xd4d8dd, rough: 0.5 },
        tie: { hex: 0x3b1f29, rough: 0.4 },
      },
      wr,
    ),
};

export function buildPeople(w: World): void {
  const root = w.group();
  root.name = "people";
  root.userData.dynamic = true;
  const inside = new Wear(w.lib, true);
  const outside = new Wear(w.lib, false);
  reader(w, root, inside);
  clerk(w, root, inside);
  shopper(w, root, inside);
  waiter(w, root, outside);
  southWalker(w, root, outside);
  crossWalker(w, root, outside);
}

// ================================================================== inside

/** Salaryman reading a weekly at the window rack, head down, facing the street. */
function reader(w: World, parent: Object3D, wr: Wear): void {
  const f = place(LOOKS.reader(wr), parent, -1.4, K.front - 0.97, 0);
  const s = f.d.s;
  const mag = magazine(wr.cloth(0xffffff, 0.55, 0.92, magazineTexture()), f.chest);
  mag.group.position.set(0, -0.02 * s, 0.29);
  mag.group.rotation.x = 0.9;
  const W = 0.19;
  const feet: [Vector3, Vector3] = [new Vector3(0.105, 0.075 * s, 0.03), new Vector3(-0.1, 0.075 * s, -0.05)];
  w.update((_dt, t) => {
    stand(f, {
      feet,
      toe: [0.12, -0.16],
      weight: 0.6 * Math.tanh(2.5 * Math.sin(t * 0.105 + 1.3)),
      lean: 0.07,
      twist: 0.04 * wander(t * 0.3, 1),
      breath: t * 1.45,
      yaw: 0.05 * wander(t * 0.8, 2),
      pitch: 0.78 + 0.04 * wander(t * 0.7, 3),
    });
    // Page turn every 13 s: the left hand lifts the leaf over to the right.
    const u = (t + 4) % 13;
    const k = u < 1.3 ? smooth(0.35, 1.3, u) : 0;
    const back = u >= 1.3 ? 1 - smooth(1.3, 1.9, u) : 0;
    const ang = mag.fold + (Math.PI - 2 * mag.fold) * k;
    mag.leaf.rotation.y = ang;
    const lift = Math.max(k > 0 && k < 1 ? 1 : 0, back);
    // Grips on the outer edges, wrists just outside and below them.
    const gl = rootPoint(f, mag.group, W * Math.cos(mag.fold) - 0.012, -0.035, -W * Math.sin(mag.fold), _a);
    if (lift > 0) {
      const a = k > 0 && k < 1 ? ang : Math.PI - mag.fold;
      const leafEdge = rootPoint(f, mag.group, (W - 0.02) * Math.cos(a), -0.03, -(W - 0.02) * Math.sin(a) - 0.01, _c);
      gl.lerp(leafEdge, k > 0 && k < 1 ? smooth(0, 0.25, k) : back);
    }
    f.reach(0, rootPoint(f, mag.group, 0, 0, 0, _b).sub(gl).multiplyScalar(-0.28).add(gl).add(_pole.set(0.02, -0.035, -0.02)), _pole.set(0.35, -1, -0.25).normalize());
    f.aim(0, gl);
    const gr = rootPoint(f, mag.group, -W * Math.cos(mag.fold) + 0.012, -0.035, -W * Math.sin(mag.fold), _a);
    f.reach(1, rootPoint(f, mag.group, 0, 0, 0, _b).sub(gr).multiplyScalar(-0.28).add(gr).add(_pole.set(-0.02, -0.035, -0.02)), _pole.set(-0.35, -1, -0.25).normalize());
    f.aim(1, gr);
  });
}

/** Night-shift clerk behind the counter at the first register, masked, facing the aisle. */
function clerk(w: World, parent: Object3D, wr: Wear): void {
  const f = place(LOOKS.clerk(wr), parent, 4.46, -7.32, -Math.PI / 2);
  const s = f.d.s;
  const feet: [Vector3, Vector3] = [new Vector3(0.11, 0.075 * s, 0.02), new Vector3(-0.1, 0.075 * s, -0.02)];
  w.update((_dt, t) => {
    // Glances at the door (front-left) every 14 s; otherwise watches the register.
    const door = pulse(t, 14, 3.4, 0.7, 6);
    const tap = pulse(t, 9, 2.2, 0.45, 2) * (1 - door);
    stand(f, {
      feet,
      toe: [0.1, -0.12],
      weight: 0.5 * Math.tanh(2 * Math.sin(t * 0.13)),
      lean: 0.1,
      twist: 0.12 * door,
      breath: t * 1.3,
      yaw: 0.06 * wander(t * 0.6, 4) + 0.95 * door,
      pitch: 0.42 - 0.38 * door + 0.04 * wander(t * 0.5, 5),
      forward: 0.02,
    });
    // Hands resting on the counter top, palms down; the right one taps the register.
    f.reach(0, _a.set(0.21, 1.06 * s + 0.01, 0.35), _pole.set(1, -0.4, -0.6).normalize());
    f.aim(0, _b.set(0.2, 1.04 * s, 0.5));
    _a.set(-0.17, 1.06 * s + 0.01, 0.34).lerp(_c.set(0.0, 1.22, 0.44), tap);
    f.reach(1, _a, _pole.set(-1, -0.4, -0.6).normalize());
    f.aim(1, _b.set(-0.15, 1.04 * s, 0.5).lerp(_c.set(0.02, 1.2, 0.56), tap));
  });
}

/** Woman in a long coat browsing an aisle with a basket, reaching for the shelf now and then. */
function shopper(w: World, parent: Object3D, wr: Wear): void {
  const f = place(LOOKS.shopper(wr), parent, 0.46, -7.05, -Math.PI / 2);
  const s = f.d.s;
  const bk = basket(wr.cloth(0x2458b8, 0.45, 0.85), [wr.cloth(0xe9e5da, 0.5, 0.9), wr.cloth(0xd9a13c, 0.5, 0.9), wr.cloth(0x3f8f5a, 0.5, 0.9)], f.root);
  bk.position.set(-0.2, 0.73 * s, 0.05);
  bk.rotation.y = -0.15;
  const feet: [Vector3, Vector3] = [new Vector3(0.095, 0.075 * s, 0.0), new Vector3(-0.09, 0.075 * s, 0.06)];
  w.update((_dt, t) => {
    const reach = pulse(t, 11, 4.2, 1.1, 3);
    stand(f, {
      feet,
      toe: [0.2, -0.1],
      weight: -0.45 + 0.2 * wander(t * 0.3, 6),
      lean: 0.08 + 0.08 * reach,
      twist: 0.1 * reach + 0.05 * wander(t * 0.4, 7),
      breath: t * 1.6,
      yaw: 0.28 * wander(t * 0.35, 8) * (1 - reach) + 0.12 * reach,
      pitch: 0.32 + 0.12 * wander(t * 0.5, 9) - 0.1 * reach,
    });
    // Right hand carries the basket; left hand hangs or reaches to the shelf.
    f.reach(1, _a.set(bk.position.x + 0.01, bk.position.y + 0.075, bk.position.z - 0.01), _pole.set(-0.4, 0, -1).normalize());
    f.aim(1, _b.copy(bk.position));
    _a.set(0.2, 0.8 * s, 0.03).lerp(_c.set(0.12, 1.15, 0.43), reach);
    f.reach(0, _a, _pole.set(1, -0.6, -0.4).normalize());
    f.aim(0, _b.set(0.21, 0.6 * s, 0.06).lerp(_c.set(0.1, 1.18, 0.62), reach));
  });
}

// ================================================================= outside

/** Young man under the fascia by the doors, reading his phone, a closed clear umbrella in hand. */
function waiter(w: World, parent: Object3D, wr: Wear): void {
  const lib = w.lib;
  const f = place(LOOKS.waiter(wr), parent, 4.5, K.front + 0.56, 0.32);
  const s = f.d.s;
  const ph = phone(lib.plain(0x121316, 0.25, 0.3), lib.glow(0xd2e2ff, 1.35), f.chest);
  ph.position.set(-0.04, -0.085, 0.25);
  ph.rotation.set(1.12, 0.12, 0.08);
  const umb = closedUmbrella({ canopy: lib.vinyl(), frame: lib.plain(0xbfc4c8, 0.3, 0.8), handle: lib.plain(0xeef0f2, 0.3) }, 0.82, true);
  f.root.add(umb);
  umb.position.set(0.22, 0.82 * s, 0.07);
  umb.rotation.set(-0.15, 0, 0.05);
  const glow = w.fog(new Vector3(), 0xcfe0ff, 0.05, 0.28);
  const feet: [Vector3, Vector3] = [new Vector3(0.12, 0.075 * s, 0.04), new Vector3(-0.1, 0.075 * s, -0.03)];
  w.update((_dt, t) => {
    const up = pulse(t, 17, 2.9, 0.55, 5);
    const scroll = Math.max(0, Math.sin(t * 0.9)) ** 4;
    stand(f, {
      feet,
      toe: [0.16, -0.18],
      weight: -0.55 + 0.25 * wander(t * 0.25, 10),
      lean: 0.03,
      twist: -0.03,
      breath: t * 1.35,
      yaw: 0.04 * wander(t * 0.6, 11) - 0.35 * up,
      pitch: 0.62 - 0.62 * up + 0.03 * wander(t, 12),
    });
    ph.rotation.x = 1.12 + 0.04 * Math.sin(t * 7) * scroll - 0.25 * up;
    ph.updateMatrixWorld();
    // Right hand cradles the phone from below; thumb side toward the screen.
    const grip = rootPoint(f, ph, 0.005, -0.03, 0.012, _b);
    f.reach(1, rootPoint(f, ph, 0.01, -0.105, 0.03, _a), _pole.set(-1, -0.8, -0.3).normalize());
    f.aim(1, grip);
    // Left hand on the umbrella grip.
    f.reach(0, _a.copy(umb.position).add(_c.set(0.0, 0.075, -0.01)), _pole.set(0.6, 0, -1).normalize());
    f.aim(0, umb.position);
    ph.getWorldPosition(glow.position);
  });
}

/** Man in a long coat under a clear vinyl umbrella, walking the south edge of the main street. */
function southWalker(w: World, parent: Object3D, wr: Wear): void {
  const lib = w.lib;
  const f = LOOKS.south(wr);
  parent.add(f.root);
  const s = f.d.s;
  const umb = openUmbrella({ canopy: lib.vinyl(), frame: lib.plain(0xc4c9cd, 0.3, 0.8), handle: lib.plain(0xeef0f2, 0.3) }, { radius: 0.47, drop: 0.22, ribs: 8, shaft: 0.84, cast: true });
  umb.children[0].castShadow = false;
  f.root.add(umb);
  // Past the parked bicycles at x ≈ −8…−4 the walker steps out toward the road.
  const bikes = (x: number) => smooth(-10.4, -8.8, x) * (1 - smooth(-3.6, -2.0, x));
  const path = patrol("x", -40, 40, 6.42, 6.14, (x) => -0.4 * bikes(x));
  const gait: Gait = { stride: 1.1, lift: 0.1, arm: 0.2, lean: 0.05, look: 0.14 };
  const speed = 1.05;
  w.update((_dt, t) => {
    const d = t * speed + 36;
    f.root.rotation.y = path.at(d, f.root.position);
    const drop = walk(f, d / gait.stride, gait, [true, false]);
    umb.position.set(-0.07, 1.09 * s - drop * 0.9, 0.21);
    umb.rotation.set(-0.12, 0, -0.07);
    f.reach(1, _a.copy(umb.position).add(_c.set(-0.035, -0.02, -0.065)), _pole.set(-0.7, -1, -0.35).normalize());
    f.aim(1, _b.copy(umb.position).add(_c.set(0.01, 0.0, 0.03)));
  });
}

/** Salaryman under a black umbrella with a briefcase, on the cross street's west edge. */
function crossWalker(w: World, parent: Object3D, wr: Wear): void {
  const lib = w.lib;
  const f = LOOKS.cross(wr);
  parent.add(f.root);
  const s = f.d.s;
  const umb = openUmbrella({ canopy: lib.plain(0x0c0d0f, 0.3), frame: lib.plain(0x2a2c30, 0.35, 0.6), handle: lib.plain(0x151212, 0.35) }, { radius: 0.52, drop: 0.25, ribs: 8, shaft: 0.87, cast: true, twoSided: true });
  f.root.add(umb);
  const bag = briefcase(lib.plain(0x141415, 0.32), lib.plain(0x9a9ea2, 0.3, 1), f.arms[1].end, true);
  bag.position.copy(f.arms[1].rest).multiplyScalar(0.08 * s);
  const path = patrol("z", -44, 24, 8.18, 8.46);
  const gait: Gait = { stride: 1.14, lift: 0.1, arm: 0.12, lean: 0.06, look: 0.1 };
  const speed = 1.22;
  w.update((_dt, t) => {
    const d = t * speed + 20;
    f.root.rotation.y = path.at(d, f.root.position);
    const c = d / gait.stride;
    const drop = walk(f, c, gait, [false, false]);
    // Briefcase arm: short swing, hand kept hanging so the case stays upright.
    const k = -Math.cos(Math.PI * 2 * c - 0.3);
    f.swing(1, 0.12 * k, 0.1, 0.06, 0.12 * k - 0.06);
    umb.position.set(0.075, 1.1 * s - drop * 0.9, 0.2);
    umb.rotation.set(-0.1, 0, 0.07);
    f.reach(0, _a.copy(umb.position).add(_c.set(0.035, -0.02, -0.065)), _pole.set(0.7, -1, -0.35).normalize());
    f.aim(0, _b.copy(umb.position).add(_c.set(-0.01, 0.0, 0.03)));
  });
}
