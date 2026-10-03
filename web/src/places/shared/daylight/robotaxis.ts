import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { canvas, toTexture } from "../canvas";
import { glazedPanel } from "./glazing";

export type RobotaxiKind = "waymo-ipace" | "tesla-cybercab";
export interface RobotaxiModel { root: Group; wheels: Group[]; wheelRadius: number; wheelbase: number; }
// Metres. I-PACE length/height/wheelbase: Jaguar specifications. Cybercab
// width/height: Tesla rider guide; length/wheelbase: official photo estimates.
export const ROBOTAXI_DIMENSIONS = {
  "waymo-ipace": { length: 4.682, width: 1.895, height: 1.566, wheelbase: 2.990, wheelRadius: .365, envelopeWidth: 2.14 },
  "tesla-cybercab": { length: 4.42, width: 1.754, height: 1.408, wheelbase: 2.74, wheelRadius: .355, envelopeWidth: 1.754 },
} as const;

type Point = [number, number, number];
const DARK = 0x191e22, RUBBER = 0x171b1e, CHROME = 0x9da5aa;
const paintMat = new MeshStandardMaterial({ vertexColors: true, roughness: .38, metalness: .22 });
paintMat.name = "daylight-robotaxi-paint-trim";
const glassMat = new MeshStandardMaterial({ vertexColors: true, roughness: .20, metalness: 0, envMapIntensity: .45 });
glassMat.name = "daylight-robotaxi-glazing";
let markingMat: MeshStandardMaterial | undefined;

function textures(): void {
  if (typeof document === "undefined" || glassMat.map) return;
  const { c, g } = canvas(256, 256), grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#4d6571"); grad.addColorStop(.45, "#253e4c"); grad.addColorStop(1, "#111e26");
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#8398a518"; g.beginPath(); g.moveTo(27, 0); g.lineTo(83, 0); g.lineTo(189, 256); g.lineTo(155, 256); g.closePath(); g.fill();
  glassMat.map = toTexture(c); glassMat.map.name = "day-car-glass-sky-reflection"; glassMat.needsUpdate = true;
  const label = canvas(256, 64);
  label.g.fillStyle = "#eceded"; label.g.fillRect(0, 0, 256, 64);
  label.g.fillStyle = "#394c50"; label.g.font = "500 47px Arial"; label.g.textAlign = "center"; label.g.textBaseline = "middle"; label.g.fillText("Waymo", 128, 33);
  markingMat = new MeshStandardMaterial({ map: toTexture(label.c), roughness: .65 });
  markingMat.name = "robotaxi-waymo-lettering";
}
function paint(g: BufferGeometry, hex: number): BufferGeometry {
  const c = new Color(hex), values = new Float32Array(g.getAttribute("position").count * 3);
  for (let i = 0; i < values.length; i += 3) values.set([c.r, c.g, c.b], i);
  g.setAttribute("color", new Float32BufferAttribute(values, 3)); return g;
}
function box(out: BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number, color: number, angle = 0): void {
  const g = paint(new BoxGeometry(w, h, d), color); g.rotateY(angle); g.translate(x, y, z); out.push(g);
}
function quad(out: BufferGeometry[], points: Point[], color: number): void {
  const g = new BufferGeometry(); g.setAttribute("position", new Float32BufferAttribute(points.flat(), 3));
  g.setAttribute("uv", new Float32BufferAttribute(points.length === 3 ? [0, 0, 1, 0, 1, 1] : [0, 0, 1, 0, 1, 1, 0, 1], 2)); g.setIndex(points.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals(); out.push(paint(g, color));
}
function cylinder(out: BufferGeometry[], radius: number, height: number, at: Point, color: number, direction = new Vector3(0, 1, 0), topRadius = radius, segments = 16): void {
  const g = paint(new CylinderGeometry(topRadius, radius, height, segments), color);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction));
  g.translate(...at); out.push(g);
}
function merged(root: Group, geometry: BufferGeometry[], material: MeshStandardMaterial, name: string): void {
  const mesh = new Mesh(mergeGeometries(geometry, false)!, material); mesh.name = name; mesh.castShadow = true; root.add(mesh);
  geometry.forEach(g => g.dispose());
}

/** +Z forward, +Y up, wheel contact at Y=0. Shared source assets for all cooks. */
export function makeRobotaxi(kind: RobotaxiKind): RobotaxiModel {
  textures();
  const root = new Group(); root.name = kind; root.userData.dynamic = true;
  const waymo = kind === "waymo-ipace", d = ROBOTAXI_DIMENSIONS[kind];
  const w = d.width / 2, half = d.length / 2, r = d.wheelRadius, wb = d.wheelbase;
  const color = waymo ? 0xeceded : 0xb9a077, solid: BufferGeometry[] = [], glass: BufferGeometry[] = [];
  // Longitudinal shoulder sections. Wheel arches remove bodywork rather than
  // painting black circles over a closed side; silhouettes survive target LOD.
  const sections = waymo
    ? [[-half, .86, .37, .92], [-half + .32, .99, .29, 1.01], [-1.45, 1, .27, 1.03], [1.48, 1, .26, .96], [half - .24, .93, .31, .81], [half, .78, .36, .71]]
    : [[-half, .89, .26, .85], [-half + .28, 1, .22, .91], [-1.25, 1, .21, .96], [1.37, 1, .21, .86], [half - .25, .92, .28, .65], [half, .76, .32, .59]];
  const samples = [...new Set([...sections.map(s => s[0]), ...[-wb / 2, wb / 2].flatMap(z => Array.from({ length: 13 }, (_, i) => z + (i / 6 - 1) * r * 1.08))])].sort((a, b) => a - b);
  const rings = samples.map(z => {
    const next = sections.findIndex(s => s[0] > z), i = next < 0 ? sections.length - 2 : Math.max(0, next - 1);
    const a = sections[i], b = sections[i + 1], t = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0])));
    const s = a[1] + (b[1] - a[1]) * t, hi = a[3] + (b[3] - a[3]) * t;
    let lo = a[2] + (b[2] - a[2]) * t;
    for (const wheelZ of [-wb / 2, wb / 2]) { const dz = z - wheelZ, rr = r * 1.08; if (Math.abs(dz) < rr) lo = Math.max(lo, r + Math.sqrt(rr * rr - dz * dz)); }
    return [[-w*s,lo,z],[-w*s,hi-.075,z],[-w*s*.9,hi,z],[w*s*.9,hi,z],[w*s,hi-.075,z],[w*s,lo,z],[w*s*.77,lo-.035,z],[-w*s*.77,lo-.035,z]] as Point[];
  });
  for (let j = 0; j < rings.length - 1; j++) for (let k = 0; k < 8; k++) quad(solid, [rings[j+1][k], rings[j+1][(k+1)%8], rings[j][(k+1)%8], rings[j][k]], color);
  for (const [ring, front] of [[rings[0], false], [rings.at(-1)!, true]] as const) {
    for (const face of [[ring[1],ring[4],ring[5],ring[0]], [ring[1],ring[2],ring[3],ring[4]], [ring[0],ring[5],ring[6],ring[7]]]) quad(solid, front ? face.reverse() : face, color);
  }
  const belt = waymo ? 1.01 : .94, back = waymo ? -1.84 : -1.11, front = waymo ? 1.05 : 1.29;
  const roofBack = waymo ? -1.23 : -.48, roofFront = waymo ? .36 : .18, rw = w * (waymo ? .77 : .79), roof = d.height;
  const panel = (corners: Parameters<typeof glazedPanel>[0], options: Parameters<typeof glazedPanel>[1] = {}) => {
    const g = glazedPanel(corners, { left: .035, right: .965, bottom: .055, top: .95, ...options });
    solid.push(...g.frame.map(f => paint(f, waymo ? 0x242c31 : color))); glass.push(paint(g.glass, 0xb6c7d0));
  };
  quad(solid, [[-rw,roof,roofFront],[rw,roof,roofFront],[rw,roof,roofBack],[-rw,roof,roofBack]], waymo ? DARK : color);
  panel([[-w*.90,belt,front],[w*.90,belt,front],[rw,roof,roofFront],[-rw,roof,roofFront]], { bow: .045, columns: 8, rows: 4 });
  if (waymo) panel([[w*.90,belt,back],[-w*.90,belt,back],[-rw,roof,roofBack],[rw,roof,roofBack]], { bow: .025, columns: 4, rows: 2 });
  else {
    // Cybercab's closed gold fastback has no rear window.
    quad(solid, [[w*.80,.85,-half],[-w*.80,.85,-half],[-rw,roof,roofBack],[rw,roof,roofBack]], color);
    for (const s of [-1, 1]) {
      const p: Point[] = [[s*w*.80,.85,-half],[s*w*.94,belt,back],[s*rw,roof,roofBack]];
      quad(solid, s > 0 ? p.reverse() : p, color);
    }
  }
  for (const s of [-1, 1]) {
    const x = s*w*.94, xr = s*rw;
    if (waymo) {
      panel([[x,belt,back],[x,belt,-.37],[xr,roof,-.37],[xr,roof,roofBack]], { flip: s > 0 });
      panel([[x,belt,-.37],[x,belt,front],[xr,roof,roofFront],[xr,roof,-.37]], { flip: s > 0 });
      box(solid,.025,.021,.21,s*w*1.003,.85,.18,CHROME); box(solid,.025,.021,.21,s*w*1.003,.88,-.99,CHROME);
      box(solid,.008,.51,.012,s*w*1.005,.71,-.36,DARK);
      box(solid,.12,.035,.05,s*(w+.02),1.09,.69,DARK);
      box(solid,.12,.10,.22,s*(w+.062),1.11,.68,color); box(solid,.105,.065,.012,s*(w+.062),1.11,.565,CHROME);
      box(solid,.016,.017,2.68,s*w*.953,1.018,-.25,CHROME);
    } else {
      panel([[x,belt,back],[x,belt,front],[xr,roof,roofFront],[xr,roof,roofBack]], { flip: s > 0 });
      box(solid,.012,.49,.011,s*w*.972,.66,-.98,0x635d50);
      // Flush release/camera in the B pillar, no handles or mirror stalks.
      box(solid,.017,.036,.047,s*w*.95,1.02,-.91,DARK);
    }
    box(solid,.022,.065,d.length-.58,s*w*.95,.26,0,DARK);
  }
  if (waymo) {
    box(solid,.88,.22,.034,0,.57,half+.012,DARK);
    for (let row=0;row<4;row++) box(solid,.81,.009,.038,0,.495+row*.05,half+.025,0x545e63);
    box(solid,.08,.028,.04,0,.58,half+.037,CHROME);
    box(solid,1.42,.072,.06,0,.355,half-.035,DARK);
    for (const s of [-1,1]) {
      const lamp: Point[] = [[s*.46,.744,2.255],[s*.80,.814,2.06],[s*.76,.834,2.035],[s*.435,.774,2.23]];
      quad(solid,s>0?lamp:lamp.reverse(),0xd6e2e5);
      box(solid,.49,.055,.045,s*.62,.938,-half+.05,0x8e171e,s*-.17);
      box(solid,.13,.12,.35,s*(w-.04),.97,1.51,color);
      cylinder(solid,.095,.022,[s*(w+.03),.96,1.52],DARK,new Vector3(s,0,0));
      box(solid,.16,.26,.18,s*(w-.055),1.12,1.29,color);
      box(solid,.165,.102,.108,s*(w-.055),1.15,1.302,DARK);
      box(solid,.16,.19,.32,s*(w-.032),.71,-1.99,color);
      cylinder(solid,.074,.027,[s*(w+.052),.72,-2.01],DARK,new Vector3(s,0,0));
      box(solid,.047,.058,1.52,s*.61,roof+.045,-.28,0x353e43);
    }
    const deck = paint(new CylinderGeometry(.66,.66,.095,24),color); deck.scale(1,1,.79); deck.translate(0,roof+.13,-.08);solid.push(deck);
    const visor = paint(new CylinderGeometry(.625,.625,.067,24),DARK);visor.scale(1,1,.79);visor.translate(0,roof+.19,-.08);solid.push(visor);
    cylinder(solid,.29,.105,[0,roof+.26,-.08],color);
    cylinder(solid,.253,.15,[0,roof+.385,-.08],DARK,new Vector3(0,1,0),.225);
    cylinder(solid,.225,.035,[0,roof+.475,-.08],color,new Vector3(0,1,0),.20);
    for(let i=0;i<6;i++) {const a=i*Math.PI/3; cylinder(solid,.041,.037,[Math.sin(a)*.293,roof+.255,-.08+Math.cos(a)*.293],0x11242e,new Vector3(Math.sin(a),0,Math.cos(a)),.041,10);}
    box(solid,.38,.026,.019,0,roof+.207,.394,0x2aa9a7);
    // Roof rear spoiler follows the I-PACE's short hatch silhouette.
    box(solid,1.43,.034,.23,0,1.36,-1.62,color);
  } else {
    // Narrow full-width signatures, separate lower front lamps, flat aero discs.
    box(solid,1.30,.032,.027,0,.574,half+.010,0xd6e6e9);
    box(solid,1.49,.033,.035,0,.765,-half-.009,0xa82625);
    for(const s of [-1,1]) {box(solid,.18,.055,.034,s*.64,.398,half-.035,DARK); box(solid,.12,.022,.04,s*.64,.40,half-.014,0xd9e1df);}
    box(solid,1.27,.085,.05,0,.283,half-.005,DARK); box(solid,1.42,.14,.045,0,.319,-half-.016,DARK);
    cylinder(solid,.023,.02,[0,.55,half+.026],DARK,new Vector3(0,0,1),.023,8);
  }
  box(solid,.43,.12,.025,0,.47,-half-.026,0xddded9);
  for(let i=0;i<6;i++)box(solid,.023,.046,.007,-.105+i*.041,.47,-half-.042,0x353a40);
  merged(root,solid,paintMat,"sculpted-body-lights-sensors"); merged(root,glass,glassMat,"open-cabin-glazing");
  if(waymo && markingMat) {
    const labels:BufferGeometry[]=[];
    for(const s of [-1,1]) {const x=s*(w+.015),p:Point[]=[[x,.73,.56],[x,.73,-.13],[x,.90,-.13],[x,.90,.56]];quad(labels,s>0?p:[p[1],p[0],p[3],p[2]],0xffffff);}
    merged(root,labels,markingMat,"Waymo-door-lettering");
  }
  const wheels:Group[]=[];
  for(const z of [wb/2,-wb/2])for(const s of [-1,1]) {
    const wheel=new Group();wheel.name=`${z>0?"front":"rear"}-${s>0?"right":"left"}-wheel`;wheel.position.set(s*(w-.113),r,z);root.add(wheel);wheels.push(wheel);
    const parts:BufferGeometry[]=[];
    cylinder(parts,r,.20,[0,0,0],RUBBER,new Vector3(1,0,0),r,24);
    cylinder(parts,r*.79,.208,[0,0,0],waymo?0x4e575c:0x98815e,new Vector3(1,0,0),r*.79,24);
    if(waymo) {
      for(let i=0;i<10;i++){const g=paint(new BoxGeometry(.216,.021,r*1.52),CHROME);g.rotateX(i*Math.PI/5);parts.push(g);}
      cylinder(parts,.062,.227,[0,0,0],DARK,new Vector3(1,0,0),.062,12);
    } else {
      cylinder(parts,r*.69,.216,[0,0,0],color,new Vector3(1,0,0),r*.69,24);
      cylinder(parts,.047,.221,[0,0,0],0x756344,new Vector3(1,0,0),.047,12);
    }
    merged(wheel,parts,paintMat,"tire-and-wheel");
  }
  return { root, wheels, wheelRadius:r, wheelbase:wb };
}
