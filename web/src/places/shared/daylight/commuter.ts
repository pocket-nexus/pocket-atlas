import {
  CircleGeometry, CylinderGeometry, ExtrudeGeometry, Group, Path,
  Shape, ShapeGeometry, TorusGeometry, type BufferGeometry, type Material,
} from "three";
import { box } from "../geo";
import { atlasPlane, instance, Parts, rod, tube, v3 } from "../shapes";
import { JP_SANS } from "../canvas";
import type { DayWorld } from "./context";

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
function ring(width: number, height: number, radius: number, thickness: number) {
  const outer = rounded(width, height, radius);
  const inner = rounded(width - thickness * 2, height - thickness * 2, Math.max(0.01, radius - thickness));
  outer.holes.push(new Path(inner.getPoints(5)));
  return new ShapeGeometry(outer, 5);
}

/** Parts are merged inside each car; articulated nodes and wheelsets stay separately animated. */
export function commuter(w: DayWorld, spec: CommuterSpec) {
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
    const p = new Parts();
    const b = (mat: Material, size: [number, number, number], at: [number, number, number]) => p.add(mat, box(...size).translate(...at));
    const bar = (mat: Material, a: [number, number, number], z: [number, number, number], r = 0.012, n = 8) => p.add(mat, rod(v3(...a), v3(...z), r, n));
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
    const roof = new ExtrudeGeometry(profile, { depth: HALF * 2, steps: 1, bevelEnabled: false, curveSegments: 10 });
    roof.rotateY(Math.PI / 2).translate(-HALF, 0, 0); p.add(w.lib.plain(0x929895, 0.63, 0.5), roof);

    for (const s of [-1, 1]) {
      const z = SIDE * s;
      // The low shell and waist band stop at the door pockets too, leaving their leaves recessed.
      const lowPanels: [number, number][] = [[-HALF, -7.25], [-5.75, -2.85], [-1.35, 1.35], [2.85, 5.75], [7.25, HALF]];
      for (const [a, end] of lowPanels) {
        b(steel, [end - a, 0.8, 0.065], [(a + end) / 2, 1.68, z]);
        b(blue, [end - a, 0.28, 0.012], [(a + end) / 2, 1.85, z + s * 0.042]);
        for (const [y, h] of [[1.32, 0.025], [1.5, 0.018], [2.025, 0.022]] as const)
          b(edge, [end - a, h, 0.034], [(a + end) / 2, y, z + s * 0.04]);
      }
      b(steel, [19.42, 0.23, 0.065], [0, 3.235, z]);
      // Formed waist seam, sill extrusion, shoulder rain gutter and lower panel ribs.
      for (const [y, h] of [[3.14, 0.018], [3.37, 0.04]] as const)
        b(edge, [19.45, h, 0.034], [0, y, z + s * 0.04]);
      for (let x = -9.5; x <= 9.5; x += 1.14) b(dust, [0.009, 0.19, 0.005], [x, 1.43, z + s * 0.036]);
      const windows: [number, number][] = [[-8.52, 1.91], [-4.3, 2.33], [0, 2.14], [4.3, 2.33], [8.52, car.cab ? 1.65 : 1.91]];
      const openings = [...windows.map(([x, width]) => [x - width / 2, x + width / 2]), ...[-6.5, -2.1, 2.1, 6.5].map(x => [x - 0.75, x + 0.75])].sort((a, b) => a[0] - b[0]);
      let panelStart = -HALF;
      for (const [a, end] of [...openings, [HALF, HALF]]) {
        if (a > panelStart) b(steel, [a - panelStart, 1.08, 0.065], [(a + panelStart) / 2, 2.59, z]);
        panelStart = end;
      }
      for (const [x, width] of windows) {
        // Three layers: metal reveal, black EPDM gasket, inset clear pane.
        sideGeo(edge, ring(width + 0.085, 1.1, 0.09, 0.039), x, 2.595, z + s * 0.04, s);
        sideGeo(rubber, ring(width + 0.015, 1.027, 0.064, 0.025), x, 2.595, z + s * 0.048, s);
        sideGeo(glass, new ShapeGeometry(rounded(width - 0.038, 0.975, 0.045), 5), x, 2.595, z + s * 0.026, s, false);
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
          b(steel, [0.038, 1.98, 0.08], [x + dx, 2.29, z]);
          b(blue, [0.038, 0.28, 0.014], [x + dx, 1.85, z + s * 0.049]);
        }
        b(steel, [1.56, 0.11, 0.1], [x, 3.24, z]);
        for (const dx of [-0.367, 0.367]) {
          const xx = x + dx;
          b(steel, [0.717, 0.93, 0.045], [xx, 1.8, dz]);
          b(blue, [0.717, 0.28, 0.012], [xx, 1.85, dz + s * 0.03]);
          b(steel, [0.717, 0.15, 0.045], [xx, 3.13, dz]);
          for (const wx of [-0.299, 0.299]) b(steel, [0.119, 0.86, 0.045], [xx + wx, 2.665, dz]);
          sideGeo(rubber, ring(0.51, 0.87, 0.075, 0.027), xx, 2.655, dz + s * 0.03, s);
          sideGeo(glass, new ShapeGeometry(rounded(0.455, 0.813, 0.053), 5), xx, 2.655, dz + s * 0.018, s, false);
          sideGeo(w.printed, atlasPlane(0.11, 0.15, notice), xx, 2.4, dz + s * 0.042, s, false);
          b(edge, [0.019, 0.1, 0.018], [xx + Math.sign(dx) * 0.27, 2.17, dz + s * 0.035]);
        }
        b(rubber, [0.02, 1.88, 0.017], [x, 2.26, z + s * 0.014]);
        for (const yy of [1.329, 1.343]) b(edge, [1.5, 0.009, 0.15], [x, yy, z - s * 0.045]);
        b(interior, [1.42, 0.075, 0.025], [x, 3.15, z - s * 0.11]);
        // Pocket lights and inspection screw heads alongside the door header.
        b(chassis, [0.085, 0.045, 0.03], [x + 0.84, 3.26, z + s * 0.05]);
        b(lens, [0.051, 0.018, 0.01], [x + 0.84, 3.26, z + s * 0.069]);
      }
      sideGeo(w.printed, atlasPlane(0.46, 0.11, label), -4.3, 1.56, z + s * 0.048, s, false);
      sideGeo(w.lit, atlasPlane(0.73, 0.17, destination), 0, 3.24, z + s * 0.046, s, false);
      // Interior rails, mesh luggage racks, hanging straps and advertising frames.
      bar(edge, [-9.25, 3.05, s * 0.7], [car.cab ? 7.55 : 9.25, 3.05, s * 0.7], 0.018);
      for (let x = -9; x < (car.cab ? 7.5 : 9.2); x += 0.48) {
        bar(interior, [x, 3.03, s * 0.7], [x, 2.79, s * 0.7], 0.017, 5);
        p.add(interior, new TorusGeometry(0.07, 0.014, 5, 12).translate(x, 2.72, s * 0.7));
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
        b(chassis, [1.73, 0.12, 0.012], [x, 3.99, s * 0.806]);
        for (let xx = -0.83; xx < 0.86; xx += 0.08) b(edge, [0.025, 0.12, 0.022], [x + xx, 3.99, s * 0.818]);
        for (const dx of [-1.12, 1.12]) b(chassis, [0.025, 0.025, 0.017], [x + dx, 4.03, s * 0.81]);
      }
      for (const dx of [-0.62, 0.62]) {
        p.add(chassis, new CircleGeometry(0.41, 24).rotateX(-Math.PI / 2).translate(x + dx, 4.121, 0));
        for (const r of [0.15, 0.28, 0.4]) p.add(edge, new TorusGeometry(r, 0.009, 4, 24).rotateX(Math.PI / 2).translate(x + dx, 4.129, 0));
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
        for (let y = 3.92; y < 4.13; y += 0.044) p.add(interior, new CylinderGeometry(0.076, 0.076, 0.027, 12).translate(x, y, z));
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
        p.add(edge, tube([v3(x, 5.48, -1.02), v3(x, 5.55, -0.8), v3(x, 5.55, 0.8), v3(x, 5.48, 1.02)], 0.014));
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
        b(dust, [len - 0.055, 0.51, 0.035], [x, 0.7, s * 0.92]);
        if ((j + index) % 2 === 0) for (let xx = -len / 2 + 0.12; xx < len / 2 - 0.08; xx += 0.09) b(chassis, [0.027, 0.31, 0.014], [x + xx, 0.74, s * 0.947]);
        else for (const dx of [-len * 0.27, len * 0.27]) {
          b(chassis, [0.012, 0.43, 0.014], [x + dx, 0.7, s * 0.947]);
          b(edge, [0.075, 0.019, 0.02], [x + dx + 0.17, 0.75, s * 0.953]);
        }
        for (const dx of [-len * 0.45, len * 0.45]) for (const y of [0.5, 0.9]) p.add(edge, new CircleGeometry(0.018, 6).rotateY(s < 0 ? Math.PI : 0).translate(x + dx, y, s * 0.953));
      }
    }
    for (const z of [-0.48, 0.48]) {
      p.add(dust, new CylinderGeometry(0.18, 0.18, 1.23, 14).rotateZ(Math.PI / 2).translate(3.28, 0.48, z));
      bar(chassis, [-8, 0.98, z], [8, 0.98, z], 0.031);
    }

    for (const bx of [-6.9, 6.9]) {
      b(chassis, [2.95, 0.2, 1.98], [bx, 0.74, 0]);
      for (const s of [-1, 1]) {
        b(dust, [2.92, 0.17, 0.18], [bx, 0.57, s * 0.93]);
        b(chassis, [1.0, 0.14, 0.19], [bx, 0.83, s * 0.97]);
        p.add(rubber, new CylinderGeometry(0.3, 0.33, 0.17, 18).translate(bx, 0.92, s * 0.7));
        for (const dx of [-0.97, 0.97]) {
          p.add(chassis, new CylinderGeometry(0.165, 0.165, 0.16, 16).rotateX(Math.PI / 2).translate(bx + dx, 0.44, s * 1.015));
          for (let y = 0.58; y < 0.8; y += 0.044) p.add(edge, new TorusGeometry(0.09, 0.016, 5, 10).rotateX(Math.PI / 2).translate(bx + dx, y, s * 0.94));
          bar(edge, [bx + dx * 0.85, 0.47, s * 0.99], [bx + dx * 0.4, 0.81, s * 0.99], 0.025);
          b(chassis, [0.1, 0.27, 0.19], [bx + dx * 0.68, 0.39, s * 0.64]);
        }
        bar(dust, [bx - 1.2, 0.35, s * 0.76], [bx + 1.2, 0.35, s * 0.76], 0.032);
      }
      // Axles rotate about local Z; the wheel tread meets the 1,067 mm rails.
      for (const dx of [-0.97, 0.97]) {
        const axle = new Group(); axle.name = `wheelset-${car.number}-${bx}-${dx}`; axle.position.set(bx + dx, WHEEL_RADIUS, 0);
        axle.userData.dynamic = true; body.add(axle); wheels.push(axle);
        const q = new Parts();
        q.add(chassis, new CylinderGeometry(0.074, 0.074, 1.9, 10).rotateX(Math.PI / 2));
        for (const s of [-1, 1]) {
          q.add(edge, new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.12, 28).rotateX(Math.PI / 2).translate(0, 0, s * 0.5335));
          q.add(chassis, new CylinderGeometry(0.38, 0.38, 0.132, 28).rotateX(Math.PI / 2).translate(0, 0, s * 0.5335));
          q.add(dust, new CylinderGeometry(0.15, 0.15, 0.19, 16).rotateX(Math.PI / 2).translate(0, 0, s * 0.54));
          q.add(edge, new TorusGeometry(0.429, 0.019, 5, 28).translate(0, 0, s * 0.484));
          for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) q.add(edge, new CylinderGeometry(0.018, 0.018, 0.012, 6).rotateX(Math.PI / 2).translate(Math.cos(a) * 0.23, Math.sin(a) * 0.23, s * 0.605));
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
      p.add(glass, new ShapeGeometry(rounded(0.44, 0.68, 0.05), 5).rotateY(end * Math.PI / 2).translate(x + end * 0.023, 2.7, 0), false);
      for (let i = 0; i < 6; i++) {
        const xx = x + end * (0.02 + i * 0.041);
        for (const z of [-0.56, 0.56]) b(i % 2 ? dust : rubber, [0.025, 2.12, 0.09], [xx, 2.32, z]);
        b(i % 2 ? dust : rubber, [0.025, 0.09, 1.21], [xx, 3.38, 0]);
      }
      b(chassis, [0.55, 0.16, 0.2], [x + end * 0.19, 0.96, 0]);
      for (const z of [-0.78, 0.78]) p.add(rubber, tube([v3(x, 1.08, z), v3(x + end * 0.35, 0.78, z), v3(x + end * 0.2, 0.49, z), v3(x, 0.72, z)], 0.028));
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
        p.add(rubber, ring(width + 0.05, height + 0.05, 0.095, 0.04).rotateY(Math.PI / 2).translate(x + 0.076, y, z));
        p.add(glass, new ShapeGeometry(rounded(width - 0.025, height - 0.025, 0.07), 5).rotateY(Math.PI / 2).translate(x + 0.064, y, z), false);
      }
      b(face, [0.075, 0.14, 0.77], [x + 0.055, 2.995, 0]);
      for (const z of [-0.94, 0.94]) b(w.lib.plain(0x253d45, 0.2), [0.015, 0.24, 0.79], [x + 0.063, 3.055, z]);
      p.add(w.lit, atlasPlane(0.75, 0.23, destination).rotateY(Math.PI / 2).translate(x + 0.10, 3.16, 0), false);
      p.add(w.printed, atlasPlane(0.38, 0.11, label).rotateY(Math.PI / 2).translate(x + 0.106, 1.55, 0), false);
      for (const z of [-0.94, 0.94]) {
        bar(rubber, [x + 0.12, 2.04, z - 0.11], [x + 0.13, 2.46, z + 0.14], 0.017);
        bar(rubber, [x + 0.14, 2.31, z + 0.06], [x + 0.14, 2.77, z + 0.29], 0.014);
        b(chassis, [0.058, 0.24, 0.56], [x + 0.086, 1.865, z]);
        p.add(edge, ring(0.56, 0.24, 0.035, 0.022).rotateY(Math.PI / 2).translate(x + 0.12, 1.865, z));
        for (const dz of [-0.13, 0.13]) {
          const lit = (z * dz < 0) === (car.cab === "front");
          p.add(lit ? (car.cab === "front" ? light : red) : lens, new ShapeGeometry(rounded(0.2, 0.16, 0.035), 5).rotateY(Math.PI / 2).translate(x + 0.123, 1.865, z + dz), false);
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
