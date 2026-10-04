import {
  CircleGeometry, CylinderGeometry, DoubleSide, ExtrudeGeometry, Group, Path, RingGeometry,
  Shape, ShapeGeometry, TorusGeometry, type BufferGeometry, type Material, type Vector3,
} from "three";
import { box } from "../geo";
import { atlasPlane, instance, Parts, quad, rod, tube, v3 } from "../shapes";
import { JP_SANS } from "../canvas";
import type { DayWorld } from "./context";
import { removeEnclosedTriangles, type SolidBox } from "./geometry";

/** A 20 m, four-door stainless commuter set. Site code supplies livery and formation. */
export interface CommuterCar {
  number: string;
  cab?: "front" | "rear";
  motor?: boolean;
  pantograph?: boolean;
}
export interface CommuterSpec {
  cars: CommuterCar[];
  stripe: number;
  destination: string;
  service: string;
  destinationLatin: string;
  serviceLatin: string;
}

const HALF = 9.72, SIDE = 1.456;
export const CAR_PITCH = 20;
export const WHEEL_RADIUS = 0.43;

function rounded(width: number, height: number, radius: number): Shape {
  const s = new Shape(), x = -width / 2, y = -height / 2, r = radius;
  s.moveTo(x + r, y); s.lineTo(x + width - r, y);
  s.quadraticCurveTo(x + width, y, x + width, y + r);
  s.lineTo(x + width, y + height - r); s.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  s.lineTo(x + r, y + height); s.quadraticCurveTo(x, y + height, x, y + height - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function ring(width: number, height: number, radius: number, thickness: number, segments = 5) {
  const outer = rounded(width, height, radius);
  const inner = rounded(width - thickness * 2, height - thickness * 2, Math.max(0.01, radius - thickness));
  outer.holes.push(new Path(inner.getPoints(segments)));
  return new ShapeGeometry(outer, segments);
}

function rectangleShape(x0: number, y0: number, x1: number, y1: number): Shape {
  const s = new Shape(); s.moveTo(x0, y0); s.lineTo(x1, y0); s.lineTo(x1, y1); s.lineTo(x0, y1); s.closePath(); return s;
}

/** Parts are merged inside each car; articulated nodes and wheelsets stay separately animated. */
export function commuter(w: DayWorld, spec: CommuterSpec) {
  const handheld = w.geometry === "handheld";
  const curves = handheld ? 1 : 5;
  const sheets = new Map<Material, Material>();
  const parts = () => {
    const p = new Parts();
    const solids: SolidBox[] = [];
    return {
      solid(size: [number, number, number], at: [number, number, number]) {
        if (handheld) solids.push({ min: at.map((v, i) => v - size[i] / 2) as SolidBox["min"], max: at.map((v, i) => v + size[i] / 2) as SolidBox["max"] });
      },
      add(mat: Material, geo: BufferGeometry, cast = true) {
        if (geo.userData.thinBand) {
          if (!sheets.has(mat)) {
            const sheet = mat.clone(); sheet.side = DoubleSide; sheet.name = `${mat.name}-thin-band`;
            sheets.set(mat, sheet);
          }
          mat = sheets.get(mat)!;
        }
        p.add(mat, geo, cast);
      },
      bake: () => p.bake().map(part => {
        if (handheld) removeEnclosedTriangles(part.geo, solids);
        return part;
      }),
    };
  };
  const cylinder = (r0: number, r1: number, height: number, sides: number) =>
    new CylinderGeometry(r0, r1, height, handheld ? Math.max(4, Math.min(12, Math.ceil(sides * 0.43))) : sides);
  const roundedRing = (width: number, height: number, radius: number, thickness: number) => ring(width, height, radius, thickness, curves);
  const shell = (shape: Shape, depth: number) => {
    const g = new ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: false, curveSegments: curves });
    // As for thin boxes, handheld keeps both broad faces. Millimetre reveal
    // edges do not affect the aperture silhouette at its native resolution.
    if (handheld) g.setIndex(Array.from({ length: g.groups[0].count }, (_, i) => i));
    return g;
  };
  const hose = (pts: Vector3[], radius: number) => tube(pts, radius, handheld ? 3 : 6, handheld ? 4 : 16);
  const hoop = (radius: number, thickness: number, radial: number, sides: number) => {
    if (!handheld) return new TorusGeometry(radius, thickness, radial, sides);
    // Small straps and spring turns stay hollow. Six sides differ from the
    // former eight-sided contour by at most 6 mm; larger guards keep twelve.
    const g = new RingGeometry(radius - thickness, radius + thickness, sides > 20 ? 12 : radius <= 0.1 ? 6 : 8);
    // Opaque, two-sided bands retain handles, fan guards and spring windings.
    g.userData.thinBand = true;
    return g;
  };
  const root = new Group(); root.name = "commuter-train"; root.userData.dynamic = true;
  const steel = w.lib.stainless(), edge = w.lib.plain(0xb8c0be, 0.29, 0.78);
  const rubber = w.lib.plain(0x242b2c, 0.91), chassis = w.lib.plain(0x424a4c, 0.78, 0.45);
  const dust = w.lib.plain(0x68665e, 0.88, 0.3), blue = w.lib.paint(spec.stripe, 0.34);
  const interior = w.lib.plain(0xc2bfa9, 0.79), seat = w.lib.plain(0x8e435a, 0.86);
  const glass = w.lib.clearGlass(), lens = w.lib.plain(0x6b6961, 0.18, 0.2);
  const light = w.lib.glow(0xffe5b0, 1.4), red = w.lib.glow(0xc83624, 1.1);
  const wheels: Group[] = [];
  const destination = w.draw(`rail-destination-${spec.destination}`, 768, 200, (c, cw, ch) => {
    c.fillStyle = "#202e38"; c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#e2e6ca"; c.textAlign = "center"; c.textBaseline = "middle";
    c.font = `${ch * 0.68}px ${JP_SANS}`; c.fillText(`${spec.service}  ${spec.destination}`, cw / 2, ch * 0.46);
    c.font = `${ch * 0.18}px sans-serif`; c.fillText(`${spec.serviceLatin}    ${spec.destinationLatin}`, cw / 2, ch * 0.86);
  });
  const notice = w.draw("rail-door-notice", 192, 256, (c, cw, ch) => {
    c.fillStyle = "#dedeca"; c.fillRect(0, 0, cw, ch);
    c.fillStyle = "#397c96"; c.fillRect(0, 0, cw, ch * 0.27);
    c.fillStyle = "#eeeade"; c.font = `bold ${ch * 0.15}px ${JP_SANS}`; c.textAlign = "center"; c.fillText("ドア注意", cw / 2, ch * 0.19);
    c.strokeStyle = "#c46349"; c.lineWidth = cw * 0.05; c.strokeRect(cw * 0.23, ch * 0.36, cw * 0.54, ch * 0.42);
    c.beginPath(); c.moveTo(cw * 0.5, ch * 0.37); c.lineTo(cw * 0.5, ch * 0.77); c.stroke();
    c.fillStyle = "#51636a"; c.fillRect(cw * 0.18, ch * 0.85, cw * 0.64, ch * 0.035);
  });
  const poster = w.draw("rail-spring-poster", 320, 240, (c, cw, ch) => {
    c.fillStyle = "#dfdeca"; c.fillRect(0, 0, cw, ch); c.fillStyle = "#4c7983"; c.fillRect(0, 0, cw, ch * 0.62);
    c.fillStyle = "#caafa1"; for (let i = 0; i < 15; i++) { c.beginPath(); c.arc(cw * (0.05 + (i * 0.167) % 0.9), ch * ((i * 0.123) % 0.56), ch * 0.06, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = "#374f51"; c.font = `bold ${ch * 0.2}px ${JP_SANS}`; c.textAlign = "center"; c.fillText("春を、歩こう。", cw / 2, ch * 0.88);
  });

  for (const [index, car] of spec.cars.entries()) {
    const body = new Group(); body.name = `car-${car.number}`;
    body.position.x = -index * CAR_PITCH - HALF;
    if (car.cab === "rear") body.rotation.y = Math.PI;
    root.add(body);
    const p = parts();
    const b = (mat: Material, size: [number, number, number], at: [number, number, number], mountedSide = 0) => {
      const g = box(...size);
      if (!mat.transparent && mat.alphaTest === 0) p.solid(size, at);
      if (handheld) {
        const axes = [0, 1, 2].sort((a, b) => size[a] - size[b]);
        const [thin, middle, long] = axes, idx = Array.from(g.index!.array);
        // Sub-pixel plate edges and the end caps of narrow trim are not visible
        // at handheld scale. Preserve both broad faces and their exact extent.
        if ((size[thin] <= 0.07 && size[thin] < size[middle] * 0.28) || (size[thin] <= 0.035 && size[middle] <= 0.08)) g.setIndex(idx.slice(thin * 12, thin * 12 + 12));
        else if (size[middle] <= 0.07 && size[middle] < size[long] * 0.15) g.setIndex(idx.filter((_v, i) => Math.floor(i / 12) !== long));
        // A plate explicitly mounted on an opaque side panel has no exposed
        // back. Keep its front and any previously retained edge faces.
        if (mountedSide) g.setIndex(Array.from(g.index!.array).filter(v => Math.floor(v / 4) !== 4 + (mountedSide > 0 ? 1 : 0)));
      }
      p.add(mat, g.translate(...at));
    };
    const bar = (mat: Material, a: [number, number, number], z: [number, number, number], r = 0.012, n = 8) => {
      if (handheld && r <= 0.007 && Math.abs(a[1] - z[1]) < 1e-8) {
        // Only luggage-rack wires and fan spokes use this radius range. A
        // two-sided strip keeps their longitudinal extent and exact width.
        // Fit halfway through the original triangular cross-section, bounding
        // displacement to <= 6.1 mm (< 0.5 px at the closest Train view).
        // Substantial rails and pipework stay round.
        const start = v3(...a), end = v3(...z), along = end.clone().sub(start).normalize();
        const normal = v3(0, 1, 0), side = along.clone().cross(normal).normalize();
        const source = rod(start, end, r, 3), position = source.getAttribute("position"), v = v3(0, 0, 0);
        let u0 = Infinity, u1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < position.count; i++) {
          v.fromBufferAttribute(position, i).sub(start);
          const u = v.dot(side); u0 = Math.min(u0, u); u1 = Math.max(u1, u);
          y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
        }
        source.dispose();
        start.y += (y0 + y1) / 2; end.y += (y0 + y1) / 2;
        const g = quad(start.clone().addScaledVector(side, u0), start.clone().addScaledVector(side, u1), end.clone().addScaledVector(side, u1), end.clone().addScaledVector(side, u0), normal);
        g.userData.thinBand = true; p.add(mat, g);
        return;
      }
      const g = rod(v3(...a), v3(...z), r, handheld ? (r <= 0.018 ? 3 : 5) : n);
      // The ends meet a support or another bar; leave them open on handheld.
      if (handheld) g.setIndex(Array.from(g.index!.array).slice(0, g.groups[0].count));
      p.add(mat, g);
    };
    const sideGeo = (mat: Material, geo: BufferGeometry, x: number, y: number, z: number, side: number, cast = true) => {
      if (side < 0) geo.rotateY(Math.PI);
      p.add(mat, geo.translate(x, y, z), cast);
    };
    const label = w.draw(`rail-number-${car.number}`, 480, 112, (c, cw, ch) => {
      c.fillStyle = "#b3baba"; c.fillRect(0, 0, cw, ch); c.fillStyle = "#246b92";
      c.font = `bold ${ch * 0.78}px sans-serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(car.number, cw / 2, ch * 0.54);
    });

    // Open shell: no solid box behind the windows. Rounded roof meets a fine drip rail.
    b(chassis, [19.3, 0.18, 2.72], [0, 1.15, 0]);
    b(w.lib.plain(0x797d76, 0.91), [19.2, 0.07, 2.68], [0, 1.28, 0]);
    const profile = new Shape();
    profile.moveTo(-SIDE, 3.3); profile.lineTo(-SIDE, 3.42); profile.quadraticCurveTo(-1.42, 3.77, -0.65, 3.83);
    profile.quadraticCurveTo(0, 3.88, 0.65, 3.83); profile.quadraticCurveTo(1.42, 3.77, SIDE, 3.42); profile.lineTo(SIDE, 3.3); profile.closePath();
    const roof = new ExtrudeGeometry(profile, { depth: HALF * 2, steps: 1, bevelEnabled: false, curveSegments: handheld ? 4 : 10 });
    roof.rotateY(Math.PI / 2).translate(-HALF, 0, 0); p.add(w.lib.plain(0x929895, 0.63, 0.5), roof);

    for (const s of [-1, 1]) {
      const z = SIDE * s;
      const windows: [number, number][] = [[-8.52, 1.91], [-4.3, 2.33], [0, 2.14], [4.3, 2.33], [8.52, car.cab ? 1.65 : 1.91]];
      // One pierced side skin replaces overlapping low/upper/post boxes.
      // The old boxes shared 30 mm and 10 mm strips of exactly the same plane.
      // Door notches include their separate headers and jambs; window holes
      // follow the metal surrounds, so no backing surface competes with them.
      const side = new Shape(); side.moveTo(-HALF, 1.28);
      for (const x of [-6.5, -2.1, 2.1, 6.5]) {
        side.lineTo(x - 0.78, 1.28); side.lineTo(x - 0.78, 3.295);
        side.lineTo(x + 0.78, 3.295); side.lineTo(x + 0.78, 1.28);
      }
      side.lineTo(HALF, 1.28); side.lineTo(HALF, 3.35); side.lineTo(-HALF, 3.35); side.closePath();
      for (const [x, width] of windows) {
        side.holes.push(new Path(rounded(width + 0.085, 1.1, 0.09).getPoints(curves).map(p => p.add({ x, y: 2.595 }))));
      }
      p.add(steel, shell(side, 0.065).translate(0, 0, z - 0.0325));
      // The low shell and waist band stop at the door pockets too, leaving their leaves recessed.
      const lowPanels: [number, number][] = [[-HALF, -7.25], [-5.75, -2.85], [-1.35, 1.35], [2.85, 5.75], [7.25, HALF]];
      for (const [a, end] of lowPanels) {
        b(blue, [end - a, 0.28, 0.012], [(a + end) / 2, 1.85, z + s * 0.042], s);
        for (const [y, h] of [[1.32, 0.025], [1.5, 0.018], [2.025, 0.022]] as const)
          b(edge, [end - a, h, 0.034], [(a + end) / 2, y, z + s * 0.04], s);
      }
      // Formed waist seam, sill extrusion, shoulder rain gutter and lower panel ribs.
      for (const [y, h] of [[3.14, 0.018], [3.37, 0.04]] as const)
        b(edge, [19.45, h, 0.034], [0, y, z + s * 0.04], s);
      for (let x = -9.5; x <= 9.5; x += 1.14) b(dust, [0.009, 0.19, 0.005], [x, 1.43, z + s * 0.036]);
      for (const [x, width] of windows) {
        // Three layers: metal reveal, black EPDM gasket, inset clear pane.
        sideGeo(edge, roundedRing(width + 0.085, 1.1, 0.09, 0.039), x, 2.595, z + s * 0.04, s);
        sideGeo(rubber, roundedRing(width + 0.015, 1.027, 0.064, 0.025), x, 2.595, z + s * 0.048, s);
        sideGeo(glass, new ShapeGeometry(rounded(width - 0.038, 0.975, 0.045), curves), x, 2.595, z + s * 0.026, s, false);
        if (width > 2) {
          b(edge, [0.044, 1, 0.026], [x, 2.595, z + s * 0.052]);
          for (const dx of [-0.23, 0.23]) b(edge, [0.14, 0.014, 0.04], [x + dx, 2.37, z - s * 0.035]);
        }
        // Cream interior lining under the sill; a bench faces across the aisle.
        b(interior, [width, 0.57, 0.055], [x, 1.75, z - s * 0.11]);
        if (!(car.cab && x > 7)) {
          b(chassis, [width - 0.08, 0.29, 0.43], [x, 1.51, s * 1.11]);
          b(seat, [width - 0.1, 0.13, 0.57], [x, 1.72, s * 1.05]);
          const back = box(width - 0.1, 0.48, 0.12); back.rotateX(-s * 0.1).translate(x, 1.98, s * 1.3); p.add(seat, back);
          for (let xx = x - width / 2 + 0.4; xx < x + width / 2 - 0.2; xx += 0.44) b(w.lib.plain(0xa35668, 0.9), [0.012, 0.009, 0.49], [xx, 1.79, s * 1.05]);
          for (const dx of [-width / 2 + 0.06, width / 2 - 0.06]) {
            b(interior, [0.04, 0.47, 0.51], [x + dx, 1.9, s * 1.07]);
            bar(edge, [x + dx, 1.4, s * 0.75], [x + dx, 3.22, s * 0.75], 0.017);
            bar(edge, [x + dx, 2.16, s * 0.75], [x + dx, 2.16, s * 1.3], 0.015);
          }
        }
      }
      // Four recessed pairs of sliding doors, real leaf windows and separate seals.
      for (const x of [-6.5, -2.1, 2.1, 6.5]) {
        const dz = z - s * 0.018;
        b(rubber, [1.54, 0.035, 0.085], [x, 1.32, z + s * 0.015]);
        for (const dx of [-0.747, 0.747]) {
          b(steel, [0.038, 1.885, 0.08], [x + dx, 2.2425, z]);
          b(blue, [0.038, 0.28, 0.014], [x + dx, 1.85, z + s * 0.049], s);
        }
        b(steel, [1.56, 0.11, 0.1], [x, 3.24, z]);
        for (const dx of [-0.367, 0.367]) {
          const xx = x + dx;
          // A single leaf with a real rounded opening also removes the
          // coplanar overlaps between its former four rectangular pieces.
          const leaf = rectangleShape(-0.3585, 1.335, 0.3585, 3.205);
          leaf.holes.push(new Path(rounded(0.51, 0.87, 0.075).getPoints(curves).map(p => p.add({ x: 0, y: 2.655 }))));
          p.add(steel, shell(leaf, 0.045).translate(xx, 0, dz - 0.0225));
          b(blue, [0.717, 0.28, 0.012], [xx, 1.85, dz + s * 0.03], s);
          sideGeo(rubber, roundedRing(0.51, 0.87, 0.075, 0.027), xx, 2.655, dz + s * 0.03, s);
          sideGeo(glass, new ShapeGeometry(rounded(0.455, 0.813, 0.053), curves), xx, 2.655, dz + s * 0.018, s, false);
          sideGeo(w.decal, atlasPlane(0.11, 0.15, notice), xx, 2.4, dz + s * 0.042, s, false);
          b(edge, [0.019, 0.1, 0.018], [xx + Math.sign(dx) * 0.27, 2.17, dz + s * 0.035]);
        }
        b(rubber, [0.02, 1.88, 0.017], [x, 2.26, z + s * 0.014]);
        for (const yy of [1.329, 1.343]) b(edge, [1.5, 0.009, 0.15], [x, yy, z - s * 0.045]);
        b(interior, [1.42, 0.075, 0.025], [x, 3.15, z - s * 0.11]);
        // Pocket lights and inspection screw heads alongside the door header.
        b(chassis, [0.085, 0.045, 0.03], [x + 0.84, 3.26, z + s * 0.05]);
        b(lens, [0.051, 0.018, 0.01], [x + 0.84, 3.26, z + s * 0.069]);
      }
      sideGeo(w.decal, atlasPlane(0.46, 0.11, label), -4.3, 1.56, z + s * 0.048, s, false);
      sideGeo(w.lit, atlasPlane(0.73, 0.17, destination), 0, 3.24, z + s * 0.046, s, false);
      // Interior rails, mesh luggage racks, hanging straps and advertising frames.
      bar(edge, [-9.25, 3.05, s * 0.7], [car.cab ? 7.55 : 9.25, 3.05, s * 0.7], 0.018);
      for (let x = -9; x < (car.cab ? 7.5 : 9.2); x += 0.48) {
        bar(interior, [x, 3.03, s * 0.7], [x, 2.79, s * 0.7], 0.017, 5);
        p.add(interior, hoop(0.07, 0.014, 5, 12).translate(x, 2.72, s * 0.7));
      }
      for (const [x, width] of windows) {
        if (car.cab && x > 7) continue;
        bar(edge, [x - width / 2, 2.93, s * 1.05], [x + width / 2, 2.93, s * 1.05], 0.017);
        for (let xx = x - width / 2; xx < x + width / 2; xx += 0.15) bar(edge, [xx, 2.93, s * 1.05], [xx, 2.93, s * 1.35], 0.006, 5);
        sideGeo(w.printed, atlasPlane(0.45, 0.25, poster), x, 3.11, z - s * 0.16, -s, false);
      }
      b(interior, [18.8, 0.07, 0.1], [0, 3.29, s * 0.68]);
      b(w.lib.plain(0xe2e0cf, 0.52), [18.6, 0.022, 0.075], [0, 3.245, s * 0.68]);
    }

    // Roof: four individual coolers with intake slots, fan guards, access seams and rain tracks.
    for (const x of [-6.3, -2.35, 2.35, 6.3]) {
      b(dust, [2.53, 0.055, 1.67], [x, 3.86, 0]);
      b(w.lib.plain(0xa2aaa8, 0.56, 0.45), [2.48, 0.23, 1.6], [x, 4.0, 0]);
      for (const s of [-1, 1]) {
        b(chassis, [1.73, 0.12, 0.012], [x, 3.99, s * 0.806], s);
        for (let xx = -0.83; xx < 0.86; xx += 0.08) b(edge, [0.025, 0.12, 0.022], [x + xx, 3.99, s * 0.818], s);
        for (const dx of [-1.12, 1.12]) b(chassis, [0.025, 0.025, 0.017], [x + dx, 4.03, s * 0.81]);
      }
      for (const dx of [-0.62, 0.62]) {
        p.add(chassis, new CircleGeometry(0.41, handheld ? 12 : 24).rotateX(-Math.PI / 2).translate(x + dx, 4.121, 0));
        for (const r of [0.15, 0.28, 0.4]) p.add(edge, hoop(r, 0.009, 4, 24).rotateX(Math.PI / 2).translate(x + dx, 4.129, 0));
        for (const a of [0, Math.PI / 4, Math.PI / 2, Math.PI * 0.75]) {
          const vx = Math.cos(a) * 0.4, vz = Math.sin(a) * 0.4;
          bar(edge, [x + dx - vx, 4.13, -vz], [x + dx + vx, 4.13, vz], 0.007, 5);
        }
      }
      b(edge, [0.018, 0.015, 1.57], [x, 4.125, 0]);
    }
    if (car.pantograph) {
      for (const x of [8.2, 9]) for (const z of [-0.58, 0.58]) {
        bar(chassis, [x, 3.84, z], [x, 4.14, z], 0.03);
        for (let y = 3.92; y < 4.13; y += 0.044) p.add(interior, cylinder(0.076, 0.076, 0.027, 12).translate(x, y, z));
      }
      b(chassis, [1.3, 0.085, 1.33], [8.5, 4.16, 0]);
      for (const z of [-0.42, 0.42]) {
        bar(edge, [8.05, 4.19, z], [9.15, 4.85, z], 0.036);
        bar(edge, [9.15, 4.85, z], [8.12, 5.5, z], 0.024);
        bar(chassis, [8.17, 4.2, z], [9.25, 4.86, z], 0.012);
        bar(chassis, [9.25, 4.86, z], [8.2, 5.5, z], 0.012);
      }
      bar(edge, [9.15, 4.85, -0.45], [9.15, 4.85, 0.45], 0.028);
      for (const x of [8.02, 8.21]) {
        bar(chassis, [x, 5.55, -0.88], [x, 5.55, 0.88], 0.025);
        p.add(edge, hose([v3(x, 5.48, -1.02), v3(x, 5.55, -0.8), v3(x, 5.55, 0.8), v3(x, 5.48, 1.02)], 0.014));
      }
      b(dust, [0.48, 0.18, 0.34], [7.65, 3.98, -0.6]);
      bar(chassis, [7.65, 4.04, -0.6], [-8.9, 3.82, -0.67], 0.018);
    }

    // Underfloor services: suspension beams, distinct inverter/battery/compressor boxes, tanks and conduit.
    for (const z of [-0.88, 0.88]) b(chassis, [18.9, 0.2, 0.13], [0, 1.02, z]);
    for (const [j, x] of [-4.85, -2.95, -0.6, 1.65, 4.2].entries()) {
      const len = j === 2 && car.motor ? 2.35 : 1.45;
      b(chassis, [len, 0.57, 1.8], [x, 0.7, 0]);
      for (const s of [-1, 1]) {
        b(dust, [len - 0.055, 0.51, 0.035], [x, 0.7, s * 0.92], s);
        if ((j + index) % 2 === 0) for (let xx = -len / 2 + 0.12; xx < len / 2 - 0.08; xx += 0.09) b(chassis, [0.027, 0.31, 0.014], [x + xx, 0.74, s * 0.947], s);
        else for (const dx of [-len * 0.27, len * 0.27]) {
          b(chassis, [0.012, 0.43, 0.014], [x + dx, 0.7, s * 0.947]);
          b(edge, [0.075, 0.019, 0.02], [x + dx + 0.17, 0.75, s * 0.953]);
        }
        for (const dx of [-len * 0.45, len * 0.45]) for (const y of [0.5, 0.9]) p.add(edge, new CircleGeometry(0.018, handheld ? 4 : 6).rotateY(s < 0 ? Math.PI : 0).translate(x + dx, y, s * 0.953));
      }
    }
    for (const z of [-0.48, 0.48]) {
      p.add(dust, cylinder(0.18, 0.18, 1.23, 14).rotateZ(Math.PI / 2).translate(3.28, 0.48, z));
      bar(chassis, [-8, 0.98, z], [8, 0.98, z], 0.031);
    }

    for (const bx of [-6.9, 6.9]) {
      b(chassis, [2.95, 0.2, 1.98], [bx, 0.74, 0]);
      for (const s of [-1, 1]) {
        b(dust, [2.92, 0.17, 0.18], [bx, 0.57, s * 0.93]);
        b(chassis, [1.0, 0.14, 0.19], [bx, 0.83, s * 0.97]);
        p.add(rubber, cylinder(0.3, 0.33, 0.17, 18).translate(bx, 0.92, s * 0.7));
        for (const dx of [-0.97, 0.97]) {
          p.add(chassis, cylinder(0.165, 0.165, 0.16, 16).rotateX(Math.PI / 2).translate(bx + dx, 0.44, s * 1.015));
          for (let y = 0.58; y < 0.8; y += 0.044) p.add(edge, hoop(0.09, 0.016, 5, 10).rotateX(Math.PI / 2).translate(bx + dx, y, s * 0.94));
          bar(edge, [bx + dx * 0.85, 0.47, s * 0.99], [bx + dx * 0.4, 0.81, s * 0.99], 0.025);
          b(chassis, [0.1, 0.27, 0.19], [bx + dx * 0.68, 0.39, s * 0.64]);
        }
        bar(dust, [bx - 1.2, 0.35, s * 0.76], [bx + 1.2, 0.35, s * 0.76], 0.032);
      }
      // Axles rotate about local Z; the wheel tread meets the 1,067 mm rails.
      for (const dx of [-0.97, 0.97]) {
        const axle = new Group(); axle.name = `wheelset-${car.number}-${bx}-${dx}`; axle.position.set(bx + dx, WHEEL_RADIUS, 0);
        axle.userData.dynamic = true; body.add(axle); wheels.push(axle);
        const q = parts();
        q.add(chassis, cylinder(0.074, 0.074, 1.9, 10).rotateX(Math.PI / 2));
        for (const s of [-1, 1]) {
          q.add(edge, cylinder(WHEEL_RADIUS, WHEEL_RADIUS, 0.12, 28).rotateX(Math.PI / 2).translate(0, 0, s * 0.5335));
          q.add(chassis, cylinder(0.38, 0.38, 0.132, 28).rotateX(Math.PI / 2).translate(0, 0, s * 0.5335));
          q.add(dust, cylinder(0.15, 0.15, 0.19, 16).rotateX(Math.PI / 2).translate(0, 0, s * 0.54));
          const flange = hoop(0.429, 0.019, 5, 28);
          if (handheld) {
            // The rear face is inside the wheel: share its opaque metal draw.
            delete flange.userData.thinBand;
            if (s < 0) flange.rotateY(Math.PI);
          }
          q.add(edge, flange.translate(0, 0, s * 0.484));
          for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) {
            // The inner bolt cap is buried in the wheel disk; the 12 mm barrel
            // is subpixel. Keep each head at its exact exposed face position.
            const bolt = handheld ? new CircleGeometry(0.018, 4).rotateY(s < 0 ? Math.PI : 0)
              : cylinder(0.018, 0.018, 0.012, 6).rotateX(Math.PI / 2);
            q.add(edge, bolt.translate(Math.cos(a) * 0.23, Math.sin(a) * 0.23, s * (handheld ? 0.611 : 0.605)));
          }
        }
        instance(q.bake(), axle);
      }
    }

    // Inter-car diaphragms, gangway doors, couplers and hanging brake hoses.
    for (const end of [-1, 1]) {
      if (car.cab && end === 1) continue;
      const x = end * HALF;
      for (const z of [-0.99, 0.99]) b(steel, [0.07, 2.16, 0.88], [x, 2.35, z]);
      b(steel, [0.07, 0.32, 1.13], [x, 3.22, 0]);
      b(interior, [0.04, 1.93, 0.78], [x - end * 0.04, 2.27, 0]);
      p.add(glass, new ShapeGeometry(rounded(0.44, 0.68, 0.05), curves).rotateY(end * Math.PI / 2).translate(x + end * 0.023, 2.7, 0), false);
      for (let i = 0; i < 6; i++) {
        const xx = x + end * (0.02 + i * 0.041);
        for (const z of [-0.56, 0.56]) b(i % 2 ? dust : rubber, [0.025, 2.12, 0.09], [xx, 2.32, z]);
        b(i % 2 ? dust : rubber, [0.025, 0.09, 1.21], [xx, 3.38, 0]);
      }
      b(chassis, [0.55, 0.16, 0.2], [x + end * 0.19, 0.96, 0]);
      for (const z of [-0.78, 0.78]) p.add(rubber, hose([v3(x, 1.08, z), v3(x + end * 0.35, 0.78, z), v3(x + end * 0.2, 0.49, z), v3(x, 0.72, z)], 0.028));
    }

    if (car.cab) {
      // Cab face: two windscreens, central emergency door and low rectangular lamp clusters.
      const x = HALF + 0.012;
      const face = w.lib.plain(0xb7c2c3, 0.38, 0.48);
      b(face, [0.14, 0.8, 2.86], [x - 0.02, 1.66, 0]);
      b(blue, [0.018, 0.29, 2.86], [x + 0.06, 1.87, 0]);
      b(face, [0.14, 0.21, 2.74], [x - 0.02, 3.31, 0]);
      for (const z of [-1.39, -0.46, 0.46, 1.39]) b(face, [0.14, 1.29, 0.07], [x - 0.02, 2.625, z]);
      b(face, [0.17, 0.73, 0.83], [x + 0.014, 1.65, 0]);
      for (const z of [-0.388, 0.388]) b(edge, [0.07, 1.94, 0.036], [x + 0.10, 2.29, z]);
      for (const z of [-0.94, 0.94, 0]) {
        const width = z === 0 ? 0.65 : 0.83, height = z === 0 ? 0.86 : 1.17;
        const y = z === 0 ? 2.51 : 2.62;
        p.add(rubber, roundedRing(width + 0.05, height + 0.05, 0.095, 0.04).rotateY(Math.PI / 2).translate(x + 0.076, y, z));
        p.add(glass, new ShapeGeometry(rounded(width - 0.025, height - 0.025, 0.07), curves).rotateY(Math.PI / 2).translate(x + 0.064, y, z), false);
      }
      b(face, [0.075, 0.14, 0.77], [x + 0.055, 2.995, 0]);
      for (const z of [-0.94, 0.94]) b(w.lib.plain(0x253d45, 0.2), [0.015, 0.24, 0.79], [x + 0.063, 3.055, z]);
      p.add(w.lit, atlasPlane(0.75, 0.23, destination).rotateY(Math.PI / 2).translate(x + 0.10, 3.16, 0), false);
      p.add(w.decal, atlasPlane(0.38, 0.11, label).rotateY(Math.PI / 2).translate(x + 0.106, 1.55, 0), false);
      for (const z of [-0.94, 0.94]) {
        bar(rubber, [x + 0.12, 2.04, z - 0.11], [x + 0.13, 2.46, z + 0.14], 0.017);
        bar(rubber, [x + 0.14, 2.31, z + 0.06], [x + 0.14, 2.77, z + 0.29], 0.014);
        b(chassis, [0.058, 0.24, 0.56], [x + 0.086, 1.865, z]);
        p.add(edge, roundedRing(0.56, 0.24, 0.035, 0.022).rotateY(Math.PI / 2).translate(x + 0.12, 1.865, z));
        for (const dz of [-0.13, 0.13]) {
          const lit = (z * dz < 0) === (car.cab === "front");
          p.add(lit ? (car.cab === "front" ? light : red) : lens, new ShapeGeometry(rounded(0.2, 0.16, 0.035), curves).rotateY(Math.PI / 2).translate(x + 0.123, 1.865, z + dz), false);
        }
      }
      // Door handle, hinges, hand rails, anti-climber and open coupler notch in the skirt.
      for (const z of [-0.42, 0.42]) bar(edge, [x + 0.15, 1.4, z], [x + 0.15, 2.05, z], 0.015);
      bar(edge, [x + 0.14, 2.06, -0.31], [x + 0.14, 2.06, -0.18], 0.018);
      for (const y of [1.45, 2.83]) b(edge, [0.035, 0.12, 0.05], [x + 0.14, y, 0.35]);
      for (const z of [-1.03, 1.03]) b(steel, [0.26, 0.51, 0.72], [x - 0.11, 0.99, z]);
      b(steel, [0.19, 0.12, 2.62], [x - 0.12, 0.69, 0]);
      b(chassis, [0.59, 0.15, 0.28], [x + 0.09, 1.01, 0]);
      b(dust, [0.16, 0.22, 0.43], [x + 0.42, 1.01, 0]);
      for (const z of [-1.07, 1.07]) for (const y of [1.23, 1.27, 1.31]) b(edge, [0.23, 0.022, 0.67], [x + 0.04, y, z]);
      b(w.lib.plain(0x3d6367, 0.63), [0.63, 0.17, 2.45], [8.98, 2.13, 0]);
      b(chassis, [0.43, 0.35, 0.44], [8.5, 1.6, -0.7]);
      b(seat, [0.45, 0.13, 0.48], [8.5, 1.81, -0.7]);
      // Cab partition stops the saloon benches before the driving compartment.
      b(interior, [0.06, 1.95, 2.63], [7.73, 2.29, 0]);
      for (const z of [-0.82, 0.82]) b(w.lib.plain(0x385253, 0.2), [0.068, 0.76, 0.59], [7.73, 2.67, z]);
      b(chassis, [0.16, 0.2, 0.18], [9, 3.91, 0]);
      bar(chassis, [9, 3.96, 0], [9, 4.37, 0], 0.025);
    }
    instance(p.bake(), body);
  }
  return { root, wheels };
}
