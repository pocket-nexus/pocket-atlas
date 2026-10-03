import { CylinderGeometry, DataTexture, DoubleSide, ExtrudeGeometry, Group, LinearFilter, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, RGBAFormat, Shape, SpotLight, TorusGeometry, Vector2, Vector3, type BufferGeometry, type Material } from "three";
import { box } from "../geo";
import { glassMaterial } from "../glass";
import { instance, Parts, quad, rod, v3 } from "../shapes";

/** Generic Japanese 3.395 m / 1.475 m kei wagon. Metres; ground at zero, nose -Z. */
export const KEI_CAR = { length: 3.395, width: 1.475, height: 1.82, wheelbase: 2.43, wheelRadius: 0.285 };
const rigs = new WeakMap<Group, { front: Group[]; spins: Group[]; steering: Group }>();

/** One small contact decal for a parked or moving vehicle under broad overcast sky. */
function contactShadow(): Mesh {
  const w = 64, h = 128, data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = ((i + 0.5) / w - 0.5) * 2.25, z = (0.5 - (j + 0.5) / h) * 4;
    let a = 0.36 * Math.exp(-1.6 * ((x / 0.77) ** 4 + (z / 1.58) ** 4));
    for (const tx of [-0.643, 0.643]) for (const tz of [-1.11, 1.32]) {
      a += 0.38 * Math.exp(-2 * (((x - tx) / 0.19) ** 2 + ((z - tz) / 0.27) ** 2));
    }
    const k = (j * w + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255; data[k + 3] = Math.round(Math.min(0.66, a) * 255);
  }
  const map = new DataTexture(data, w, h, RGBAFormat); map.name = "drive-vehicle-contact";
  map.magFilter = map.minFilter = LinearFilter; map.needsUpdate = true;
  const mat = new MeshBasicMaterial({ color: "#15252b", map, transparent: true, depthWrite: false });
  mat.name = "drive:vehicle-contact"; mat.userData.pocketAtlas = { kind: "unlit" };
  const mesh = new Mesh(new PlaneGeometry(2.25, 4).rotateX(-Math.PI / 2), mat);
  mesh.name = "drive_contact_shadow"; mesh.position.y = 0.012;
  return mesh;
}

function material(name: string, color: string, roughness: number, metalness = 0): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color, roughness, metalness }); m.name = `drive:${name}`; return m;
}
function arch(u: number): Vector2[] {
  const out: Vector2[] = [], radius = 0.335, sill = 0.23;
  const a0 = Math.asin((KEI_CAR.wheelRadius - sill) / radius);
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI + a0 - i / 12 * (Math.PI + 2 * a0);
    out.push(new Vector2(u + Math.cos(a) * radius, KEI_CAR.wheelRadius + Math.sin(a) * radius));
  }
  return out;
}

/** Standard, exportable materials and merged Parts; no place-specific shaders or borrowed internals. */
export function createKeiCar(): Group {
  const root = new Group(); root.name = "drive_vehicle";
  root.userData.dynamic = true; root.userData.pocketAtlas = { dynamic: true };
  root.add(contactShadow());
  const paint = material("kei-sage-paint", "#b6c2b5", 0.34, 0.35);
  const roof = material("kei-ivory-roof", "#d9d9cd", 0.5, 0.12);
  const trim = material("kei-black-trim", "#252a2a", 0.77);
  const rubber = material("kei-snow-tyres", "#202221", 0.96);
  const steel = material("kei-wheel-steel", "#929c9d", 0.37, 0.74);
  const cabin = material("kei-cabin", "#555b57", 0.94);
  const seats = material("kei-cloth-seats", "#66716e", 0.96);
  const snow = material("kei-snow-dust", "#dee2dd", 0.97);
  const headlight = material("kei-warm-headlamps", "#f2e7be", 0.23);
  headlight.emissive.set("#eed69f"); headlight.emissiveIntensity = 1.6;
  const taillight = material("kei-taillamps", "#a02722", 0.27);
  taillight.emissive.set("#c6241c"); taillight.emissiveIntensity = 0.5;
  const amber = material("kei-indicators", "#cf852b", 0.25);
  const plate = material("kei-yellow-plate", "#d9c563", 0.74);
  const glass = glassMaterial({ color: "#87999b", roughness: 0.19, metalness: 0.08, opacity: 0.2, side: DoubleSide });
  glass.name = "drive:kei-clear-glass";
  const body = new Parts();
  const addBox = (mat: Material, w: number, h: number, d: number, x: number, y: number, z: number) => body.add(mat, box(w, h, d).translate(x, y, z));
  const bar = (mat: Material, a: [number, number, number], b: [number, number, number], r: number, sides = 6) => body.add(mat, rod(v3(...a), v3(...b), r, sides));
  const pane = (mat: Material, points: [number, number, number][], normal: [number, number, number]) => body.add(mat, quad(v3(...points[0]), v3(...points[1]), v3(...points[2]), v3(...points[3]), v3(...normal)), false);

  // Extruded lower shell has actual wheel cut-outs, a short bonnet and a tall van nose.
  const profile = [new Vector2(1.65, 0.23), new Vector2(1.66, 0.88), new Vector2(1.42, 1.035),
    new Vector2(-1.62, 1.035), new Vector2(-1.66, 0.86), new Vector2(-1.66, 0.23),
    ...arch(-1.32), ...arch(1.11)];
  const shell = new ExtrudeGeometry(new Shape(profile), { depth: 1.36, bevelEnabled: true, bevelThickness: 0.027, bevelSize: 0.018, bevelSegments: 2, curveSegments: 3 });
  shell.translate(0, 0, -0.68); shell.rotateY(Math.PI / 2); body.add(paint, shell);
  addBox(trim, 1.23, 0.11, 2.58, 0, 0.25, 0.04);
  addBox(cabin, 1.31, 0.055, 2.51, 0, 0.5, 0.2);
  addBox(roof, 1.3, 0.12, 2.68, 0, 1.755, 0.27);
  addBox(snow, 1.24, 0.018, 2.36, 0, 1.82, 0.38);
  addBox(trim, 1.4, 0.11, 0.09, 0, 0.38, -1.65);
  addBox(trim, 1.4, 0.1, 0.09, 0, 0.39, 1.65);
  addBox(steel, 0.8, 0.034, 0.023, 0, 0.775, -1.67);
  addBox(trim, 0.74, 0.12, 0.025, 0, 0.665, -1.682);
  for (const y of [0.623, 0.655, 0.687]) addBox(steel, 0.66, 0.008, 0.01, 0, y, -1.69);
  addBox(plate, 0.33, 0.166, 0.018, 0, 0.43, -1.684);
  addBox(plate, 0.33, 0.166, 0.018, 0, 0.56, 1.684);
  // Abstract legal-sized embossed plate marks, no copied make badges or logos.
  for (const z of [-1.696, 1.696]) for (const x of [-0.105, -0.035, 0.035, 0.105]) addBox(trim, 0.028, 0.055, 0.003, x, z < 0 ? 0.43 : 0.56, z);
  for (const sign of [-1, 1]) {
    addBox(headlight, 0.265, 0.18, 0.04, sign * 0.51, 0.82, -1.668);
    addBox(amber, 0.065, 0.13, 0.044, sign * 0.665, 0.82, -1.666);
    addBox(taillight, 0.1, 0.32, 0.034, sign * 0.62, 0.86, 1.668);
    addBox(amber, 0.105, 0.062, 0.038, sign * 0.62, 0.96, 1.668);
    addBox(steel, 0.06, 0.021, 0.14, sign * 0.723, 1.0, -0.31);
    addBox(steel, 0.06, 0.021, 0.15, sign * 0.723, 1.0, 0.72);
    addBox(trim, 0.04, 0.055, 2.62, sign * 0.713, 0.775, 0.11);
    bar(paint, [sign * 0.69, 1.02, -1.39], [sign * 0.61, 1.7, -1.02], 0.041);
    bar(paint, [sign * 0.7, 1.03, -0.21], [sign * 0.635, 1.7, -0.22], 0.034);
    bar(paint, [sign * 0.7, 1.03, 0.77], [sign * 0.635, 1.7, 0.78], 0.035);
    bar(paint, [sign * 0.69, 1.0, 1.63], [sign * 0.61, 1.7, 1.59], 0.043);
    // Windows sit between geometry pillars; view through them reveals the seats and dashboard.
    pane(glass, [[sign * 0.701, 1.045, -1.34], [sign * 0.697, 1.045, -0.265], [sign * 0.63, 1.688, -0.266], [sign * 0.626, 1.688, -1.01]], [sign, 0, 0]);
    pane(glass, [[sign * 0.701, 1.045, -0.17], [sign * 0.701, 1.045, 0.72], [sign * 0.639, 1.688, 0.728], [sign * 0.639, 1.688, -0.17]], [sign, 0, 0]);
    pane(glass, [[sign * 0.701, 1.045, 0.82], [sign * 0.695, 1.045, 1.58], [sign * 0.622, 1.688, 1.55], [sign * 0.639, 1.688, 0.825]], [sign, 0, 0]);
    bar(trim, [sign * 0.7, 1.03, -0.21], [sign * 0.7, 0.37, -0.21], 0.006, 4);
    bar(trim, [sign * 0.706, 1.03, 0.77], [sign * 0.706, 0.38, 0.77], 0.006, 4);
    bar(trim, [sign * 0.68, 1.06, -1.24], [sign * 0.8, 1.12, -1.19], 0.026);
    addBox(paint, 0.14, 0.13, 0.25, sign * 0.807, 1.145, -1.14);
    addBox(steel, 0.014, 0.102, 0.2, sign * 0.884, 1.145, -1.13);
    addBox(snow, 0.022, 0.027, 1.21, sign * 0.714, 1.046, 0.72);
    // Slight mud/snow on sill and flexible rear mud flap.
    addBox(snow, 0.03, 0.065, 1.47, sign * 0.708, 0.29, 0.045);
    addBox(rubber, 0.16, 0.18, 0.02, sign * 0.64, 0.15, 1.635);
  }
  pane(glass, [[-0.656, 1.053, -1.39], [0.656, 1.053, -1.39], [0.593, 1.683, -1.036], [-0.593, 1.683, -1.036]], [0, 0.49, -0.87]);
  pane(glass, [[0.642, 1.066, 1.637], [-0.642, 1.066, 1.637], [-0.584, 1.684, 1.597], [0.584, 1.684, 1.597]], [0, 0.065, 0.998]);
  for (const x of [-0.32, 0.3]) {
    bar(trim, [x + 0.16, 1.068, -1.399], [x - 0.11, 1.29, -1.282], 0.009, 4);
    bar(trim, [x - 0.25, 1.29, -1.283], [x + 0.11, 1.29, -1.283], 0.013, 4);
  }
  bar(trim, [-0.15, 1.128, 1.646], [0.32, 1.2, 1.642], 0.012, 4);
  addBox(trim, 0.32, 0.045, 0.055, 0, 1.653, -0.987);
  addBox(taillight, 0.24, 0.038, 0.023, 0, 1.673, 1.624);
  // A real right-hand-drive cabin, including lower windscreen dash and visible instrument binnacle.
  addBox(cabin, 1.27, 0.19, 0.42, 0, 0.995, -1.015);
  addBox(trim, 0.35, 0.085, 0.17, 0.34, 1.123, -0.965);
  addBox(steel, 0.25, 0.038, 0.006, 0.34, 1.13, -0.874);
  for (const x of [-0.49, -0.18, 0.08, 0.53]) addBox(trim, 0.11, 0.055, 0.014, x, 1.024, -0.796);
  addBox(trim, 0.2, 0.12, 0.014, -0.065, 0.967, -0.796);
  addBox(steel, 0.12, 0.045, 0.018, -0.065, 0.985, -0.786);
  addBox(cabin, 0.22, 0.33, 0.28, -0.01, 0.675, -0.65);
  bar(trim, [0.0, 0.79, -0.64], [0.0, 0.96, -0.7], 0.022);
  for (const x of [-0.33, 0.33]) {
    addBox(seats, 0.5, 0.13, 0.5, x, 0.665, -0.17);
    const seatBack = box(0.49, 0.54, 0.115); seatBack.rotateX(-0.1); seatBack.translate(x, 0.94, 0.07); body.add(seats, seatBack);
    addBox(seats, 0.255, 0.18, 0.13, x, 1.315, 0.096);
    bar(steel, [x - 0.07, 1.18, 0.083], [x - 0.07, 1.25, 0.09], 0.01, 5);
    bar(steel, [x + 0.07, 1.18, 0.083], [x + 0.07, 1.25, 0.09], 0.01, 5);
  }
  addBox(seats, 1.2, 0.13, 0.44, 0, 0.69, 0.82);
  addBox(seats, 1.2, 0.54, 0.12, 0, 0.98, 1.06);
  for (const x of [-0.35, 0.35]) addBox(seats, 0.25, 0.18, 0.13, x, 1.31, 1.07);
  // A parcel box reinforces the delivery mission in both the exterior and cockpit views.
  const carton = material("kei-parcel-cardboard", "#ad9571", 0.99);
  addBox(carton, 0.5, 0.31, 0.35, -0.18, 0.71, 1.385);
  addBox(roof, 0.055, 0.014, 0.357, -0.18, 0.873, 1.385);
  instance(body.bake(), root);

  // A single dynamic beam serves both lenses. Its per-pixel light is retained by the cooker,
  // rather than baked into the road at the car's export position. No shadow-map pass.
  const beam = new SpotLight("#ffdfa6", 360, 52, 0.46, 0.52, 2);
  beam.name = "drive_headlights"; beam.position.set(0, 0.82, -1.71);
  root.add(beam); beam.lookAt(new Vector3(0, 0.18, -21));
  const beamTarget = new Object3D(); beamTarget.name = "drive_headlight_target"; beamTarget.position.z = -1;
  beam.add(beamTarget); beam.target = beamTarget;

  const steering = new Group(); steering.name = "drive_steering_wheel"; steering.position.set(0.34, 1.15, -0.7); steering.rotation.x = -0.47;
  const steeringParts = new Parts(); steeringParts.add(trim, new TorusGeometry(0.156, 0.016, 6, 20));
  steeringParts.add(trim, box(0.083, 0.075, 0.045));
  for (const a of [0, Math.PI, -Math.PI / 2]) steeringParts.add(trim, rod(v3(Math.cos(a) * 0.035, Math.sin(a) * 0.035, 0), v3(Math.cos(a) * 0.14, Math.sin(a) * 0.14, 0), 0.012, 5));
  instance(steeringParts.bake(), steering); root.add(steering);

  const wheelParts = new Parts();
  const alongX = (g: BufferGeometry) => g.rotateZ(Math.PI / 2);
  wheelParts.add(rubber, alongX(new CylinderGeometry(0.285, 0.285, 0.17, 20, 1)));
  wheelParts.add(steel, alongX(new CylinderGeometry(0.176, 0.176, 0.176, 16, 1)));
  wheelParts.add(trim, alongX(new CylinderGeometry(0.115, 0.115, 0.183, 12, 1)));
  wheelParts.add(steel, alongX(new CylinderGeometry(0.06, 0.06, 0.19, 10, 1)));
  for (let i = 0; i < 20; i++) {
    const a = i / 20 * Math.PI * 2;
    const tread = box(0.174, 0.015, 0.043).rotateX(-a).translate(0, Math.cos(a) * 0.282, Math.sin(a) * 0.282);
    wheelParts.add(trim, tread);
  }
  for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    wheelParts.add(steel, rod(v3(side * 0.094, Math.cos(a) * 0.063, Math.sin(a) * 0.063), v3(side * 0.094, Math.cos(a) * 0.158, Math.sin(a) * 0.158), 0.014, 5));
  }
  const bakedWheel = wheelParts.bake();
  const front: Group[] = [], spins: Group[] = [];
  for (const [name, x, z] of [["fl", -0.643, -1.11], ["fr", 0.643, -1.11], ["rl", -0.643, 1.32], ["rr", 0.643, 1.32]] as const) {
    const pivot = new Group(); pivot.name = `drive_wheel_${name}`; pivot.position.set(x, KEI_CAR.wheelRadius, z);
    const spin = new Group(); spin.name = `drive_wheel_spin_${name}`; instance(bakedWheel, spin); pivot.add(spin); root.add(pivot);
    if (name[0] === "f") front.push(pivot); spins.push(spin);
  }
  rigs.set(root, { front, spins, steering });
  return root;
}

/** Optional local animation only. The stage controls the vehicle's world transform. */
export function animateKeiCar(root: Group, steer: number, distance: number, speed = 0): void {
  const angle = -steer * 0.48 / (1 + Math.abs(speed) * 0.035);
  const rig = rigs.get(root); if (!rig) return;
  for (const pivot of rig.front) pivot.rotation.y = angle;
  for (const spin of rig.spins) spin.rotation.x = -distance / KEI_CAR.wheelRadius;
  rig.steering.rotation.z = -steer * 2.4;
}
