import { BoxGeometry, Color, CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Shape, type BufferGeometry, type Material } from "three";
import { glassMaterial } from "../../../places/shared/glass";
import { KEI, type CarState } from "../drive/vehicle";

/**
 * The car the player drives: a tall kei wagon (3.395 × 1.475 × 1.79 m, the
 * class limits), unbranded. Its root follows the vehicle state; the wheels
 * are children that spin, the front pair also steers. The handheld drives
 * the same nodes by name (`car`, `wheel-fl`, `wheel-fr`, `wheel-rl`,
 * `wheel-rr`): the root is annotated `driven`, so the compiler keeps the
 * hierarchy instead of baking it into the place.
 *
 * Local frame: origin on the road under the centre of mass, −Z forward,
 * +X right, y up.
 */
export interface Car {
  root: Group;
  wheels: Group[];
  /** Lamps whose brightness follows the controls. */
  brake: MeshBasicMaterial;
  head: MeshBasicMaterial;
  /** Places the car for a vehicle state. */
  pose(c: CarState, braking: boolean): void;
}

const LENGTH = 3.395;
const WIDTH = 1.475;
const HEIGHT = 1.79;

/** The body's side silhouette (z forward negative, y up), nose first, extruded across the width. */
function silhouette(): Shape {
  const front = -KEI.nose;
  const rear = KEI.tail;
  const s = new Shape();
  // Shape coordinates: x = −z (so the nose is at +x), y up.
  const p = (z: number, y: number): [number, number] => [-z, y];
  s.moveTo(...p(front + 0.04, 0.32));
  s.lineTo(...p(front, 0.5));
  s.lineTo(...p(front + 0.02, 0.86));
  s.quadraticCurveTo(...p(front + 0.06, 0.98), ...p(front + 0.5, 1.03));
  // Windscreen, steep and far forward.
  s.lineTo(...p(front + 0.98, 1.66));
  s.quadraticCurveTo(...p(front + 1.1, HEIGHT - 0.02), ...p(front + 1.4, HEIGHT));
  s.lineTo(...p(rear - 0.22, HEIGHT - 0.03));
  s.quadraticCurveTo(...p(rear - 0.03, HEIGHT - 0.06), ...p(rear - 0.02, 1.5));
  s.lineTo(...p(rear, 0.62));
  s.lineTo(...p(rear - 0.04, 0.3));
  s.lineTo(...p(front + 0.04, 0.3));
  return s;
}

function wheel(tyre: Material, hub: Material): Group {
  const g = new Group();
  const r = KEI.wheelRadius;
  const t = new Mesh(new CylinderGeometry(r, r, 0.155, 18, 1).rotateZ(Math.PI / 2), tyre);
  const h = new Mesh(new CylinderGeometry(r * 0.62, r * 0.62, 0.165, 12, 1).rotateZ(Math.PI / 2), hub);
  g.add(t, h);
  return g;
}

export function buildCar(): Car {
  const root = new Group();
  root.name = "car";
  root.userData.dynamic = true;
  root.userData.pocketAtlas = { driven: true };

  const paint = new MeshPhysicalMaterial({ color: new Color(0.82, 0.83, 0.82), roughness: 0.42, metalness: 0.0, clearcoat: 0.7, clearcoatRoughness: 0.12 });
  paint.name = "car-paint";
  const trim = new MeshStandardMaterial({ color: new Color(0.03, 0.03, 0.035), roughness: 0.7 });
  trim.name = "car-trim";
  const tyre = new MeshStandardMaterial({ color: new Color(0.025, 0.025, 0.027), roughness: 0.92 });
  tyre.name = "car-tyre";
  const hub = new MeshStandardMaterial({ color: new Color(0.55, 0.56, 0.58), roughness: 0.4, metalness: 0.8 });
  hub.name = "car-hub";
  const glass = glassMaterial({ color: new Color(0.02, 0.03, 0.035), roughness: 0.06, metalness: 0, opacity: 0.82 });
  glass.name = "car-glass";
  const brake = new MeshBasicMaterial({ color: new Color(1.6, 0.05, 0.03) });
  brake.name = "car-brake";
  const head = new MeshBasicMaterial({ color: new Color(6, 5.6, 4.8) });
  head.name = "car-head";

  // Body: the silhouette across the width, less the wheel arches' depth.
  const body: BufferGeometry = new ExtrudeGeometry(silhouette(), { depth: WIDTH - 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 6 });
  // Extrusion runs along +z of the shape: turn it so the shape's x (the nose) faces −Z and the depth spans x.
  body.translate(0, 0, -(WIDTH - 0.06) / 2);
  body.rotateY(Math.PI / 2);
  root.add(new Mesh(body, paint));

  const front = -KEI.nose;
  const rear = KEI.tail;
  const hw = WIDTH / 2;
  const add = (geo: BufferGeometry, mat: Material, x: number, y: number, z: number, rx = 0, ry = 0): Mesh => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    root.add(m);
    return m;
  };
  // Side glass, windscreen and rear window, a hair outside the body.
  for (const sx of [-1, 1]) {
    add(new BoxGeometry(0.012, 0.5, 1.95), glass, sx * (hw + 0.004), 1.36, front + 2.05);
    add(new BoxGeometry(0.014, 0.16, 2.9), trim, sx * (hw + 0.003), 0.36, 0.02);
    // Mirrors.
    add(new BoxGeometry(0.16, 0.11, 0.07), paint, sx * (hw + 0.1), 1.12, front + 0.98);
  }
  add(new BoxGeometry(WIDTH - 0.24, 0.66, 0.012), glass, 0, 1.36, front + 0.76, Math.atan2(0.48, 0.63));
  add(new BoxGeometry(WIDTH - 0.3, 0.5, 0.012), glass, 0, 1.4, rear - 0.045, -0.05);
  // Bumpers, grille, plates.
  add(new BoxGeometry(WIDTH - 0.1, 0.2, 0.05), trim, 0, 0.42, front - 0.005);
  add(new BoxGeometry(WIDTH - 0.5, 0.1, 0.04), trim, 0, 0.72, front - 0.012);
  add(new BoxGeometry(WIDTH - 0.1, 0.2, 0.05), trim, 0, 0.42, rear + 0.005);
  // Lamps.
  for (const sx of [-1, 1]) {
    add(new BoxGeometry(0.26, 0.15, 0.03), head, sx * (hw - 0.22), 0.8, front - 0.008);
    add(new BoxGeometry(0.1, 0.42, 0.03), brake, sx * (hw - 0.09), 1.12, rear + 0.002);
  }

  const wheels: Group[] = [];
  const places: [string, number, number][] = [
    ["wheel-fl", -(hw - 0.085), -KEI.front],
    ["wheel-fr", hw - 0.085, -KEI.front],
    ["wheel-rl", -(hw - 0.085), KEI.rear],
    ["wheel-rr", hw - 0.085, KEI.rear],
  ];
  for (const [name, x, z] of places) {
    const w = wheel(tyre, hub);
    w.name = name;
    w.position.set(x, KEI.wheelRadius, z);
    root.add(w);
    wheels.push(w);
  }
  root.traverse((o) => {
    o.userData.dynamic = true;
  });

  return {
    root,
    wheels,
    brake,
    head,
    pose(c, braking) {
      root.position.set(c.x, c.y, c.z);
      // Heading is clockwise from −Z seen from above; three.js yaw is counter-clockwise.
      const roll = Math.max(-0.06, Math.min(0.06, c.ay * 0.012));
      const dive = Math.max(-0.04, Math.min(0.04, c.ax * 0.008));
      root.rotation.set(c.pitch + dive, -c.heading, roll, "YXZ");
      for (let i = 0; i < 4; i++) wheels[i].rotation.set(-c.wheel, i < 2 ? -c.steer : 0, 0, "YXZ");
      brake.color.setRGB(braking ? 5 : 1.2, braking ? 0.16 : 0.04, braking ? 0.1 : 0.025);
    },
  };
}

export const CAR_SIZE = { length: LENGTH, width: WIDTH, height: HEIGHT };
