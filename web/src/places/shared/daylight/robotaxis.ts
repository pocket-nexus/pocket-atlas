import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Quaternion, Raycaster, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { canvas, toTexture } from "../canvas";
import { vehicleShell, type VehicleShellProfile } from "./vehicle-shell";

export type RobotaxiKind = "waymo-ipace" | "tesla-cybercab";
export interface RobotaxiModel { root: Group; wheels: Group[]; wheelRadius: number; wheelbase: number; }
// Metres. I-PACE length/height/wheelbase: Jaguar specifications. Cybercab
// width/height: Tesla rider guide; length/wheelbase: official photo estimates.
export const ROBOTAXI_DIMENSIONS = {
  "waymo-ipace": { length: 4.682, width: 1.895, height: 1.566, wheelbase: 2.990, wheelRadius: .365, envelopeWidth: 2.14 },
  "tesla-cybercab": { length: 4.42, width: 1.754, height: 1.408, wheelbase: 2.74, wheelRadius: .355, envelopeWidth: 1.754 },
} as const;

// Cross sections are photographic estimates, in metres: Z, half width, sill,
// window belt, centre crown, roof half width. The roof and shoulder are one
// loft; both the windscreen and side openings cut this same outer surface.
export const ROBOTAXI_PROFILES: Record<RobotaxiKind, VehicleShellProfile> = {
  "waymo-ipace": {
    wheelbase: 2.990, wheelRadius: .365,
    sideWindows: [[-1.73,-.43],[-.37,1.12]], windscreen: [.48,1.19], rearWindow: [-1.98,-1.38],
    sections: [
      [-2.341,.80,.36,.90,.94,.68], [-2.11,.91,.28,1.035,1.075,.76],
      [-1.80,.942,.255,1.065,1.24,.755], [-1.495,.9475,.25,1.055,1.43,.733],
      [-1.04,.910,.245,1.02,1.535,.715], [-.43,.890,.245,.997,1.566,.703],
      [.15,.908,.245,.997,1.554,.697], [.48,.929,.25,1.006,1.482,.697],
      [1.19,.9475,.255,.974,1.016,.841], [1.495,.945,.26,.958,.999,.843],
      [1.97,.897,.30,.825,.876,.780], [2.341,.752,.36,.703,.748,.639],
    ],
  },
  "tesla-cybercab": {
    wheelbase: 2.74, wheelRadius: .355,
    sideWindows: [[-.96,1.12]], windscreen: [.31,1.22],
    sections: [
      [-2.21,.768,.275,.895,.941,.66], [-1.94,.852,.225,.973,1.013,.717],
      [-1.37,.877,.21,.972,1.183,.723], [-.96,.859,.20,.938,1.320,.707],
      [-.53,.836,.20,.909,1.390,.691], [-.06,.827,.20,.881,1.408,.674],
      [.31,.841,.20,.874,1.366,.665], [.74,.861,.21,.879,1.180,.717],
      [1.22,.877,.22,.871,.944,.766], [1.37,.875,.23,.864,.918,.770],
      [1.78,.835,.25,.788,.839,.730], [2.21,.685,.30,.601,.661,.582],
    ],
  },
};

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
function wheelDisc(out: BufferGeometry[], radius: number, x: number, color: number, segments: number): void {
  const positions = [x,0,0], uv = [.5,.5], indices: number[] = [];
  for (let i=0;i<segments;i++) {
    const a=i*Math.PI*2/segments;
    positions.push(x,Math.cos(a)*radius,Math.sin(a)*radius);
    uv.push(.5+Math.cos(a)*.5,.5+Math.sin(a)*.5);
    const b=1+i,c=1+(i+1)%segments;
    indices.push(...(x>0?[0,b,c]:[0,c,b]));
  }
  const g=new BufferGeometry();g.setAttribute("position",new Float32BufferAttribute(positions,3));
  g.setAttribute("uv",new Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();out.push(paint(g,color));
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
  const shell = vehicleShell(ROBOTAXI_PROFILES[kind]);
  solid.push(paint(shell.paint, color)); glass.push(paint(shell.glass, 0xb6c7d0));
  const body = new Mesh(shell.paint, paintMat), projector = new Raycaster();
  const onBody = (p: Point, direction: Point, offset = .006): Point => {
    projector.set(new Vector3(...p), new Vector3(...direction));
    const hit = projector.intersectObject(body, false)[0];
    if (!hit) throw new Error(`Vehicle trim misses the shell: ${kind} ${p}`);
    return hit.point.addScaledVector(projector.ray.direction, -offset).toArray() as Point;
  };
  const bodyLine = (side: number, path: [z: number,y: number][], width: number, tint: number) => {
    const sampled: [number,number][] = [];
    for(let i=0;i<path.length-1;i++) {
      const a=path[i],b=path[i+1],steps=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.22);
      for(let k=0;k<steps;k++)sampled.push([a[0]+(b[0]-a[0])*k/steps,a[1]+(b[1]-a[1])*k/steps]);
    }
    sampled.push(path.at(-1)!);
    for(let i=0;i<sampled.length-1;i++) {
      const a=sampled[i],b=sampled[i+1],len=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const dy=(b[0]-a[0])/len*width*.5,dz=-(b[1]-a[1])/len*width*.5;
      const points=[[side*3,a[1]-dy,a[0]-dz],[side*3,b[1]-dy,b[0]-dz],
        [side*3,b[1]+dy,b[0]+dz],[side*3,a[1]+dy,a[0]+dz]]
        .map(p=>onBody(p as Point,[-side,0,0],.008));
      quad(solid,side>0?points.reverse():points,tint);
    }
  };
  for(const side of [-1,1]) {
    if(waymo) {
      bodyLine(side,[[-.40,.974],[-.405,.64],[-.43,.32]],.0045,0x7c8588);
      bodyLine(side,[[-1.05,.32],[-.45,.30],[.18,.31],[.95,.355]],.034,0x263239);
    } else {
      bodyLine(side,[[-.952,.914],[-.79,.34],[.64,.32],[1.00,.69],[1.095,.849]],.004,0x7c705b);
      bodyLine(side,[[-.87,.244],[.0,.222],[.84,.255]],.029,0x34342d);
    }
  }
  const roof = d.height;
  if (waymo) {
    for (const s of [-1,1]) {
      // Small trim follows the sculpted belt instead of becoming a boxy cabin.
      box(solid,.019,.018,.17,s*w*.973,.84,.14,CHROME);
      box(solid,.019,.018,.17,s*w*.963,.86,-.91,CHROME);
      box(solid,.10,.030,.05,s*(w-.015),1.04,.74,DARK);
      box(solid,.13,.09,.20,s*(w+.045),1.075,.70,color);
      box(solid,.115,.057,.010,s*(w+.045),1.075,.598,CHROME);
    }
  }
  if (waymo) {
    box(solid,.88,.22,.034,0,.57,half+.012,DARK);
    for (let row=0;row<4;row++) box(solid,.81,.009,.038,0,.495+row*.05,half+.025,0x545e63);
    box(solid,.08,.028,.04,0,.58,half+.037,CHROME);
    box(solid,1.42,.072,.06,0,.355,half-.035,DARK);
    for (const s of [-1,1]) {
      const lamp = [[s*.46,3,2.255],[s*.77,3,2.06],[s*.72,3,2.035],[s*.435,3,2.23]]
        .map(p => onBody(p as Point,[0,-1,0]));
      quad(solid,s>0?lamp.reverse():lamp,0xd6e2e5);
      box(solid,.49,.055,.045,s*.62,.938,-half+.05,0x8e171e,s*-.17);
      box(solid,.13,.12,.35,s*(w-.04),.97,1.51,color);
      cylinder(solid,.095,.022,[s*(w+.03),.96,1.52],DARK,new Vector3(s,0,0));
      box(solid,.16,.26,.18,s*(w-.055),1.12,1.29,color);
      box(solid,.165,.102,.108,s*(w-.055),1.15,1.302,DARK);
      box(solid,.16,.19,.32,s*(w-.032),.71,-1.99,color);
      cylinder(solid,.074,.027,[s*(w+.052),.72,-2.01],DARK,new Vector3(s,0,0));
      box(solid,.047,.058,1.52,s*.61,roof+.045,-.28,0x353e43);
      box(solid,.055,.070,.08,s*.61,roof+.001,-.78,0x353e43);
      box(solid,.055,.070,.08,s*.61,roof+.001,.20,0x353e43);
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
  if(waymo && markingMat) {
    const labels:BufferGeometry[]=[];
    for (const s of [-1,1]) for (let i=0;i<4;i++) {
      const a=.56-i*.69/4,b=.56-(i+1)*.69/4;
      const p = [[s*3,.73,a],[s*3,.73,b],[s*3,.90,b],[s*3,.90,a]]
        .map(p => onBody(p as Point,[-s,0,0],.009));
      quad(labels,s>0?p:[p[1],p[0],p[3],p[2]],0xffffff);
      const uv=labels.at(-1)!.getAttribute("uv");
      for(let j=0;j<uv.count;j++) uv.setX(j,((s>0?i:3-i)+uv.getX(j))/4);
    }
    merged(root,labels,markingMat,"Waymo-door-lettering");
  }
  merged(root,solid,paintMat,"sculpted-body-lights-sensors"); merged(root,glass,glassMat,"open-cabin-glazing");
  const wheels:Group[]=[];
  for(const z of [wb/2,-wb/2])for(const s of [-1,1]) {
    const wheel=new Group();wheel.name=`${z>0?"front":"rear"}-${s>0?"right":"left"}-wheel`;wheel.position.set(s*(w-.113),r,z);root.add(wheel);wheels.push(wheel);
    const parts:BufferGeometry[]=[];
    cylinder(parts,r,.20,[0,0,0],RUBBER,new Vector3(1,0,0),r,24);
    for(const side of [-1,1]) {
      wheelDisc(parts,r*.79,side*.104,waymo?0x4e575c:color,24);
      wheelDisc(parts,waymo?.062:.047,side*.113,waymo?DARK:0x756344,8);
    }
    if(waymo) {
      for (const side of [-1,1]) for (let i=0;i<5;i++) {
        const a=i*Math.PI*2/5, b=a+.15, x=side*.107;
        const points:Point[]=[[x,Math.sin(a)*.045,Math.cos(a)*.045],
          [x,Math.sin(a)*r*.75,Math.cos(a)*r*.75],
          [x,Math.sin(b)*r*.75,Math.cos(b)*r*.75],
          [x,Math.sin(b)*.045,Math.cos(b)*.045]];
        quad(parts,side>0?points.reverse():points,CHROME);
      }
    }
    merged(wheel,parts,paintMat,"tire-and-wheel");
  }
  return { root, wheels, wheelRadius:r, wheelbase:wb };
}
