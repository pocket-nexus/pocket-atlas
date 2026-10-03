import { BoxGeometry, BufferAttribute, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type BufferGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Line } from "../line";
import { TRAFFIC_BODIES, TRAFFIC_CARS, type Traffic } from "../drive/traffic";

/**
 * The other vehicles on the road: four plain, unbranded bodies (a kei
 * truck, a saloon, a van, a box lorry), each one mesh coloured by its
 * vertices plus one mesh of lamps, so a vehicle is two draws on the
 * handheld. They are met at a closing speed of 100 km/h in falling snow:
 * silhouette, colour and headlamps are what is seen. The handheld drives
 * the same nodes by name (`traffic-0` … `traffic-4`, annotated `driven`).
 *
 * Local frame as the player's car: origin on the road, −Z forward, y up.
 */
export interface TrafficFleet {
  root: Group;
  cars: Group[];
  /** Places every vehicle for the traffic's state. */
  pose(t: Traffic, line: Line): void;
}

type Rgb = [number, number, number];

/** A box with one colour: centre x, base y, centre z, width, height, length. */
function box(x: number, y: number, z: number, w: number, h: number, l: number, c: Rgb): BufferGeometry {
  const g = new BoxGeometry(w, h, l).translate(x, y + h / 2, z).toNonIndexed();
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  const lin = new Color().setRGB(c[0], c[1], c[2]);
  for (let i = 0; i < n; i++) col.set([lin.r, lin.g, lin.b], i * 3);
  g.setAttribute("color", new BufferAttribute(col, 3));
  return g;
}

function wheel(x: number, z: number, r: number, w: number): BufferGeometry {
  const g = new CylinderGeometry(r, r, w, 10, 1).rotateZ(Math.PI / 2).translate(x, r, z).toNonIndexed();
  const n = g.getAttribute("position").count;
  g.setAttribute("color", new BufferAttribute(new Float32Array(n * 3).fill(0.012), 3));
  return g;
}

interface Body {
  paint: BufferGeometry[];
  lamps: BufferGeometry[];
}

const GLASS: Rgb = [0.03, 0.04, 0.05];
const TRIM: Rgb = [0.02, 0.02, 0.022];
/** Lamp colours are multiplied by the lamp material's HDR white. */
const HEAD: Rgb = [1, 0.95, 0.8];
const TAIL: Rgb = [0.3, 0.012, 0.008];

function lamps(front: number, rear: number, half: number, y: number, size = 0.2): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    out.push(box(sx * (half - 0.22), y, front - 0.01, size * 1.3, size * 0.7, 0.04, HEAD));
    out.push(box(sx * (half - 0.16), y + 0.05, rear + 0.01, size * 0.8, size, 0.04, TAIL));
  }
  return out;
}

function wheels(half: number, front: number, rear: number, r: number): BufferGeometry[] {
  return [wheel(-(half - 0.1), front, r, 0.18), wheel(half - 0.1, front, r, 0.18), wheel(-(half - 0.1), rear, r, 0.18), wheel(half - 0.1, rear, r, 0.18)];
}

/** A kei truck: a cab-over cab and a low bed with snow in it. */
function keiTruck(): Body {
  const c: Rgb = [0.8, 0.81, 0.8];
  return {
    paint: [
      box(0, 0.42, -0.2, 1.42, 0.3, 3.3, TRIM),
      box(0, 0.6, -1.25, 1.44, 1.2, 1.1, c),
      box(0, 1.25, -1.32, 1.3, 0.48, 0.9, GLASS),
      box(0, 0.6, 0.45, 1.44, 0.34, 2.2, c),
      box(0, 0.9, 0.45, 1.3, 0.16, 2.05, [0.86, 0.88, 0.92]),
      ...wheels(0.72, -1.15, 0.85, 0.26),
    ],
    lamps: lamps(-1.8, 1.55, 0.72, 0.62, 0.18),
  };
}

/** A saloon: three boxes, a low glasshouse. */
function saloon(): Body {
  const c: Rgb = [0.34, 0.35, 0.37];
  return {
    paint: [
      box(0, 0.3, 0, 1.72, 0.55, 4.5, c),
      box(0, 0.85, 0.25, 1.56, 0.5, 2.3, GLASS),
      box(0, 1.33, 0.25, 1.5, 0.06, 2.1, c),
      box(0, 1.39, 0.25, 1.4, 0.07, 1.9, [0.86, 0.88, 0.92]),
      box(0, 0.28, -2.26, 1.72, 0.2, 0.06, TRIM),
      ...wheels(0.86, -1.4, 1.35, 0.31),
    ],
    lamps: lamps(-2.25, 2.25, 0.86, 0.6),
  };
}

/** A one-box van. */
function van(): Body {
  const c: Rgb = [0.1, 0.16, 0.3];
  return {
    paint: [
      box(0, 0.32, 0, 1.76, 0.72, 4.7, c),
      box(0, 1.04, 0.35, 1.72, 0.78, 3.9, c),
      box(0, 1.1, -1.72, 1.6, 0.6, 0.3, GLASS),
      box(-0.87, 1.12, 0.3, 0.02, 0.5, 3.4, GLASS),
      box(0.87, 1.12, 0.3, 0.02, 0.5, 3.4, GLASS),
      box(0, 1.82, 0.35, 1.6, 0.08, 3.6, [0.86, 0.88, 0.92]),
      ...wheels(0.88, -1.45, 1.4, 0.33),
    ],
    lamps: lamps(-2.35, 2.35, 0.88, 0.68),
  };
}

/** A four-tonne box lorry: a cab and an aluminium box, snow on its roof. */
function lorry(): Body {
  const cab: Rgb = [0.78, 0.8, 0.82];
  const alu: Rgb = [0.6, 0.62, 0.64];
  return {
    paint: [
      box(0, 0.55, 0.6, 2.1, 0.35, 7.4, TRIM),
      box(0, 0.9, -3.15, 2.2, 1.75, 1.7, cab),
      box(0, 1.75, -3.85, 2.0, 0.75, 0.3, GLASS),
      box(0, 0.9, 1.25, 2.3, 2.5, 6.0, alu),
      box(0, 3.4, 1.25, 2.2, 0.12, 5.8, [0.86, 0.88, 0.92]),
      ...wheels(1.05, -3.0, 2.6, 0.42),
    ],
    lamps: lamps(-4.0, 4.25, 1.1, 0.75, 0.24),
  };
}

export function buildTraffic(): TrafficFleet {
  const root = new Group();
  root.name = "traffic";
  const paint = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 });
  paint.name = "traffic-body";
  // Headlamps bloom in the grey afternoon; tail lamps are the same material, dimmed by their vertex colour.
  const lamp = new MeshBasicMaterial({ vertexColors: true, color: new Color(5.5, 5.5, 5.5) });
  lamp.name = "traffic-lamp";
  const makers = [keiTruck, saloon, van, lorry];
  if (makers.length !== TRAFFIC_BODIES) throw new Error("traffic bodies and TRAFFIC_BODIES disagree");
  const cars: Group[] = [];
  for (let i = 0; i < TRAFFIC_CARS; i++) {
    const g = new Group();
    g.name = `traffic-${i}`;
    g.userData.pocketAtlas = { driven: true };
    // A slot always wears the same body: one mesh pair per slot on the handheld.
    const b = makers[i % TRAFFIC_BODIES]();
    g.add(new Mesh(mergeGeometries(b.paint), paint), new Mesh(mergeGeometries(b.lamps), lamp));
    g.traverse((o) => (o.userData.dynamic = true));
    g.visible = false;
    root.add(g);
    cars.push(g);
  }
  const p = { x: 0, y: 0, z: 0, tx: 0, tz: -1, grade: 0 };
  return {
    root,
    cars,
    pose(t, line) {
      for (let i = 0; i < cars.length; i++) {
        const c = t.cars[i];
        const g = cars[i];
        g.visible = c.s >= 0;
        if (c.s < 0) continue;
        line.at(c.s, p);
        g.position.set(p.x - p.tz * c.d, p.y - 0.02 * Math.abs(c.d), p.z + p.tx * c.d);
        // Heading: clockwise from −Z along the direction of travel.
        const dir = c.v < 0 ? -1 : 1;
        g.rotation.set(Math.atan(p.grade) * dir, -Math.atan2(p.tx * dir, -p.tz * dir), 0, "YXZ");
      }
    },
  };
}
