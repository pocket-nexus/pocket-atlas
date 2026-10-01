import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Shape, Vector2, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { KamakuraWorld } from "./context";
import { COAST, SECTION } from "./layout";

/**
 * Route 134 traffic: a handful of cars, a van and a motorcycle in both
 * directions at about 50 km/h. Nothing stops for the crossing (the road has
 * no gate). Each vehicle runs a 60 s cycle: 56 s along the road from out of
 * sight west of the station to the haze 600 m east (or back), then 4 s
 * underground while it returns to its start. Bodies share one vertex-coloured
 * paint, one glass and one black material.
 */

type Kind = "kei" | "compact" | "minivan" | "suv" | "van" | "moto";

/** Side silhouettes (x along the car from the rear, y up): lower body to the beltline, greenhouse above it. */
const SPECS: Record<Exclude<Kind, "moto">, { len: number; wid: number; body: [number, number][]; glass: [number, number][]; wheel: number }> = {
  kei: {
    len: 3.4,
    wid: 1.48,
    wheel: 0.28,
    body: [
      [0, 0.3],
      [0.05, 1.0],
      [3.2, 1.0],
      [3.4, 0.62],
      [3.38, 0.3],
    ],
    glass: [
      [0.08, 1.0],
      [0.12, 1.7],
      [2.9, 1.72],
      [3.2, 1.0],
    ],
  },
  compact: {
    len: 4.0,
    wid: 1.7,
    wheel: 0.31,
    body: [
      [0, 0.32],
      [0.05, 0.9],
      [3.1, 0.92],
      [3.95, 0.72],
      [3.98, 0.32],
    ],
    glass: [
      [0.15, 0.9],
      [0.5, 1.42],
      [2.6, 1.46],
      [3.25, 0.92],
    ],
  },
  minivan: {
    len: 4.7,
    wid: 1.74,
    wheel: 0.32,
    body: [
      [0, 0.32],
      [0.04, 1.02],
      [3.9, 1.04],
      [4.68, 0.78],
      [4.7, 0.32],
    ],
    glass: [
      [0.08, 1.02],
      [0.15, 1.84],
      [3.7, 1.86],
      [4.25, 1.04],
    ],
  },
  suv: {
    len: 4.6,
    wid: 1.84,
    wheel: 0.36,
    body: [
      [0, 0.38],
      [0.06, 1.05],
      [3.7, 1.08],
      [4.55, 0.92],
      [4.6, 0.4],
    ],
    glass: [
      [0.2, 1.05],
      [0.4, 1.64],
      [3.15, 1.66],
      [3.75, 1.08],
    ],
  },
  van: {
    len: 4.7,
    wid: 1.69,
    wheel: 0.31,
    body: [
      [0, 0.3],
      [0.02, 1.12],
      [4.55, 1.12],
      [4.7, 0.85],
      [4.7, 0.3],
    ],
    glass: [
      [0.05, 1.12],
      [0.08, 1.96],
      [4.35, 1.98],
      [4.62, 1.12],
    ],
  },
};

function extrudeSide(pts: [number, number][], width: number): BufferGeometry {
  const shape = new Shape(pts.map(([x, y]) => new Vector2(x, y)));
  const g = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -width / 2);
  return g;
}

/** Merges vertex-coloured pieces (position, normal, colour), keeping the colours. */
function mergeColored(list: BufferGeometry[]): BufferGeometry {
  const flat = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal" && k !== "color") n.deleteAttribute(k);
    if (!n.getAttribute("normal")) n.computeVertexNormals();
    return n;
  });
  return mergeGeometries(flat, false)!;
}

function tint(g: BufferGeometry, c: Color): BufferGeometry {
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  return g;
}

/** A vehicle in its own frame: nose toward +x, ground at y = 0, centred. */
function vehicle(w: KamakuraWorld, kind: Kind, paint: Color, mats: { paint: MeshStandardMaterial }): Group {
  const root = new Group();
  const tail = new Color(0.55, 0.04, 0.03);
  const paints: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const black: BufferGeometry[] = [];
  if (kind === "moto") {
    const frame = new BoxGeometry(1.7, 0.45, 0.32);
    frame.translate(0, 0.62, 0);
    paints.push(tint(frame, paint));
    for (const x of [-0.7, 0.72]) {
      const wh = new CylinderGeometry(0.3, 0.3, 0.12, 10);
      wh.rotateX(Math.PI / 2);
      wh.translate(x, 0.3, 0);
      black.push(wh);
    }
    // Rider: torso, helmet, legs (dark riding gear).
    const torso = new BoxGeometry(0.3, 0.6, 0.42);
    torso.rotateZ(-0.25);
    torso.translate(-0.15, 1.2, 0);
    black.push(torso);
    const helmet = new CylinderGeometry(0.15, 0.15, 0.26, 8);
    helmet.translate(-0.05, 1.62, 0);
    paints.push(tint(helmet, new Color(0.9, 0.9, 0.9)));
    const legs = new BoxGeometry(0.55, 0.2, 0.4);
    legs.translate(0.05, 0.85, 0);
    black.push(legs);
  } else {
    const s = SPECS[kind];
    const body = extrudeSide(s.body, s.wid);
    body.translate(-s.len / 2, 0, 0);
    paints.push(tint(body, paint));
    const gl = extrudeSide(s.glass, s.wid - 0.14);
    gl.translate(-s.len / 2, 0, 0);
    glass.push(gl);
    // Roof skin over the greenhouse.
    const top = Math.max(...s.glass.map((p) => p[1]));
    const xs = s.glass.filter((p) => p[1] > top - 0.1).map((p) => p[0]);
    const roof = new BoxGeometry(Math.max(...xs) - Math.min(...xs) + 0.05, 0.05, s.wid - 0.12);
    roof.translate((Math.max(...xs) + Math.min(...xs)) / 2 - s.len / 2, top + 0.02, 0);
    paints.push(tint(roof, paint));
    // Bumpers, wheels, tail lamps.
    for (const x of [-s.len / 2 + 0.06, s.len / 2 - 0.06]) {
      const bump = new BoxGeometry(0.14, 0.22, s.wid + 0.02);
      bump.translate(x, 0.42, 0);
      black.push(bump);
    }
    const axle = s.len * 0.32;
    for (const x of [-axle, axle])
      for (const z of [-1, 1]) {
        const wh = new CylinderGeometry(s.wheel, s.wheel, 0.2, 10);
        wh.rotateX(Math.PI / 2);
        wh.translate(x, s.wheel, z * (s.wid / 2 - 0.08));
        black.push(wh);
      }
    for (const z of [-1, 1]) {
      const tl = new BoxGeometry(0.04, 0.18, 0.28);
      tl.translate(-s.len / 2 - 0.005, 0.85, z * (s.wid / 2 - 0.22));
      paints.push(tint(tl, tail));
    }
  }
  // One mesh per vehicle (glass and tyres as dark paint colours): one draw on the handheld.
  const dark = new Color(0.03, 0.035, 0.04);
  const tyre = new Color(0.02, 0.02, 0.02);
  w.mesh(mergeColored([...paints, ...glass.map((g) => tint(g, dark)), ...black.map((g) => tint(g, tyre))]), mats.paint, 0, 0, 0, root, { cast: false });
  return root;
}

const PERIOD = 60;
const RUN_T = 56;
const WEST = -250;
const EAST = 590;

export function buildTraffic(w: KamakuraWorld): void {
  const paint = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.35, vertexColors: true, envMapIntensity: 1.1 });
  paint.name = "car-paint";
  const mats = { paint };
  const holder = w.group();
  holder.name = "traffic";
  holder.userData.dynamic = true;
  // [kind, colour, eastbound?, phase s]
  const fleet: [Kind, number, boolean, number][] = [
    ["kei", 0xf2f2ee, true, 3],
    ["suv", 0x9a9fa3, true, 18],
    ["moto", 0x1a1a1a, true, 33],
    ["minivan", 0x16181c, true, 47],
    ["compact", 0xb8bcc0, false, 9],
    ["van", 0xf0f0ec, false, 24],
    ["kei", 0x6f8f8a, false, 38],
    ["compact", 0x2a3f6a, false, 52],
  ];
  const p = new Vector3();
  const t = new Vector3();
  for (const [kind, hex, east, phase] of fleet) {
    const c = new Color(hex);
    const car = vehicle(w, kind, c, mats);
    car.name = `car-${kind}`;
    holder.add(car);
    const s = east ? SECTION.lanes.east : SECTION.lanes.west;
    w.update((_dt, time) => {
      const r = (((time + phase) % PERIOD) + PERIOD) % PERIOD;
      let u: number;
      let y = 0;
      const start = east ? WEST : EAST;
      const end = east ? EAST : WEST;
      if (r < RUN_T) u = start + (end - start) * (r / RUN_T);
      else if (r < RUN_T + 0.2) {
        u = end;
        y = (-30 * (r - RUN_T)) / 0.2;
      } else if (r < PERIOD - 0.2) {
        u = start;
        y = -30;
      } else {
        u = start;
        y = (-30 * (PERIOD - r)) / 0.2;
      }
      COAST.offset(u, s, p);
      COAST.tangent(u, t);
      if (!east) t.negate();
      car.position.set(p.x, 0.06 + y, p.z);
      car.rotation.y = Math.atan2(-t.z, t.x);
    });
  }
}
