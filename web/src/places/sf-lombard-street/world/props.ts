import { CircleGeometry, CylinderGeometry, Matrix4, SphereGeometry, Vector3, type BufferGeometry, type Material } from "three";
import { mapUV, type AtlasRect } from "../../shared/atlas";
import type { Ctx } from "../../shared/canvas";
import { box, cable } from "../../shared/geo";
import { atlasPlane, rod, tube } from "../../shared/shapes";
import type { LombardWorld } from "./context";
import { NORTH_SIDE, site, sidewalkV, UPHILL } from "./layout";

/** Everyday equipment is estimated from the dated street photos, in metres. */
export function buildProps(w: LombardWorld): void {
  const iron = w.lib.paint(0x333b3f), pale = w.lib.paint(0xe4e1d7, 0.6);
  const steel = w.lib.plain(0x969d9b, 0.42, 0.35), red = w.lib.paint(0xab291f), dark = w.lib.plain(0x283136);
  const emit = (name: string, g: BufferGeometry, mat: Material, m?: Matrix4) => {
    if (m) g.applyMatrix4(m);
    const mesh = w.mesh(g, mat); mesh.name = name; return mesh;
  };
  const frame = (p: Vector3, normal: Vector3) => new Matrix4().makeBasis(new Vector3(normal.z, 0, -normal.x), new Vector3(0,1,0), normal).setPosition(p);
  const pole = (p: Vector3, h: number, radius = 0.038) => {
    emit("sign:galvanised-post", rod(p, p.clone().add(new Vector3(0,h,0)), radius, 7), steel);
    for (let y = 0.45; y < h; y += 0.16) emit("sign:post-hole", box(0.013, 0.018, 0.007).translate(p.x,p.y+y,p.z+radius), dark);
  };
  const plate = (name: string, rect: AtlasRect, p: Vector3, width: number, height: number, normal: Vector3) => {
    const m = frame(p,normal);
    emit(`${name}:metal-back`,box(width+0.025,height+0.025,0.035),pale,m);
    emit(`${name}:print`,atlasPlane(width,height,rect).translate(0,0,0.023),w.printed,m);
  };
  const text = (g: Ctx, str: string, x: number, y: number, size: number, weight = 700) => {
    g.font = `${weight} ${size}px Arial, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(str,x,y);
  };
  const street = (name: string) => w.draw(`sf-street-${name}`,512,104,(g,ww,hh)=>{
    g.fillStyle="#f0ede0";g.fillRect(0,0,ww,hh);g.strokeStyle="#222a2b";g.lineWidth=5;g.strokeRect(6,6,ww-12,hh-12);
    g.fillStyle="#202728";text(g,name,ww*0.49,hh*0.53,hh*0.63);text(g,"ST",ww*0.94,hh*0.54,hh*0.27);
  });
  const lombard=street("LOMBARD"),hy=street("HYDE"),leav=street("LEAVENWORTH");
  const dont=w.draw("sf-do-not-enter",384,384,(g,ww,hh)=>{
    g.fillStyle="#c33330";g.fillRect(0,0,ww,hh);g.strokeStyle="#faf6e7";g.lineWidth=ww*0.025;g.beginPath();g.arc(ww/2,hh/2,ww*0.474,0,Math.PI*2);g.stroke();
    g.fillStyle="#faf6e7";g.fillRect(ww*0.1,hh*0.405,ww*0.8,hh*0.19);text(g,"DO NOT",ww/2,hh*0.25,hh*0.135);text(g,"ENTER",ww/2,hh*0.76,hh*0.155);
  });
  const oneWay=w.draw("sf-one-way",384,160,(g,ww,hh)=>{
    g.fillStyle="#f4f0e4";g.fillRect(0,0,ww,hh);g.fillStyle="#202526";
    g.beginPath();g.moveTo(ww*0.07,hh*0.22);g.lineTo(ww*0.68,hh*0.22);g.lineTo(ww*0.68,hh*0.05);g.lineTo(ww*0.95,hh*0.5);g.lineTo(ww*0.68,hh*0.95);g.lineTo(ww*0.68,hh*0.78);g.lineTo(ww*0.07,hh*0.78);g.closePath();g.fill();
    g.fillStyle="#f4f0e4";text(g,"ONE WAY",ww*0.4,hh*0.51,hh*0.29);
  });
  const speed=w.draw("sf-speed-five",256,320,(g,ww,hh)=>{
    g.fillStyle="#ece9de";g.fillRect(0,0,ww,hh);g.strokeStyle="#222626";g.lineWidth=7;g.strokeRect(8,8,ww-16,hh-16);g.fillStyle="#222626";
    text(g,"SPEED",ww/2,hh*0.19,hh*0.145);text(g,"LIMIT",ww/2,hh*0.34,hh*0.145);text(g,"5",ww/2,hh*0.67,hh*0.45);
  });
  const noStop=w.draw("sf-no-stopping",192,288,(g,ww,hh)=>{
    g.fillStyle="#eae8df";g.fillRect(0,0,ww,hh);g.strokeStyle="#952e2a";g.lineWidth=6;g.strokeRect(5,5,ww-10,hh-10);g.fillStyle="#952e2a";
    text(g,"NO",ww/2,hh*0.17,hh*0.16);text(g,"STOPPING",ww/2,hh*0.38,hh*0.112);text(g,"ANY",ww/2,hh*0.57,hh*0.145);text(g,"TIME",ww/2,hh*0.77,hh*0.145);
  });
  // The crooked block is one-way downhill; round red signs face Leavenworth.
  for (const s of [-1,1]) {
    const p=site(1.9, s*9.5,0.18);pole(p,3.0);
    const m=frame(p.clone().add(new Vector3(0,2.37,0)),UPHILL.clone().negate());
    emit("do-not-enter:back",new CylinderGeometry(0.39,0.39,0.04,24).rotateX(Math.PI/2),pale,m);
    emit("do-not-enter:face",mapUV(new CircleGeometry(0.375,24),dont).translate(0,0,0.026),w.printed,m);
  }
  for (const [u,v,other] of [[-4,11.8,leav],[148.8,-11.6,hy]] as const) {
    const p=site(u,v,0.12);pole(p,3.75,0.047);
    plate("street:lombard",lombard,p.clone().add(new Vector3(0,3.58,0)),1.33,0.27,NORTH_SIDE.clone().negate());
    plate("street:cross-street",other,p.clone().add(new Vector3(0,3.25,0)),other===leav?1.66:0.95,0.25,UPHILL.clone().negate());
    if(u>100)plate("one-way",oneWay,p.clone().add(new Vector3(0,2.61,0)),0.92,0.38,NORTH_SIDE.clone().negate());
  }
  const speedPost=site(139,sidewalkV(139,1)+0.52,0.16);pole(speedPost,3.3);
  plate("speed-five",speed,speedPost.clone().add(new Vector3(0,2.72,0)),0.5,0.64,UPHILL);
  for(const [u,s] of [[9,-1],[48,1],[93,-1]] as const){
    const p=site(u,sidewalkV(u,s)+s*0.55,0.17);pole(p,2.85);
    plate("no-stopping",noStop,p.clone().add(new Vector3(0,2.45,0)),0.32,0.48,NORTH_SIDE.clone().multiplyScalar(-s));
  }

  // Curved cobra-head luminaires: poles are unlit in the summer daylight scene.
  for(const [u,v,sign] of [[-6,-12,1],[43,13,-1],[111,-13,1],[149,12,-1]] as const){
    const p=site(u,v,0.08), h=8.2, arm=NORTH_SIDE.clone().multiplyScalar(sign);
    emit("streetlight:shaft",new CylinderGeometry(0.068,0.14,h,8).translate(p.x,p.y+h/2,p.z),steel);
    emit("streetlight:foot",new CylinderGeometry(0.22,0.28,0.42,8).translate(p.x,p.y+0.21,p.z),steel);
    const pts=[p.clone().add(new Vector3(0,h-0.25,0)),p.clone().add(new Vector3(0,h+0.7,0)).addScaledVector(arm,0.5),p.clone().add(new Vector3(0,h+1,0)).addScaledVector(arm,1.35),p.clone().add(new Vector3(0,h+1,0)).addScaledVector(arm,2.6)];
    emit("streetlight:curved-arm",tube(pts,0.057,5,5),steel);
    const end=pts[pts.length-1]!;const lamp=new SphereGeometry(1,10,6);lamp.scale(0.27,0.13,0.53);lamp.rotateY(Math.atan2(arm.x,arm.z));lamp.translate(end.x,end.y-0.09,end.z);
    emit("streetlight:cobra-head",lamp,steel);
    const glass=new SphereGeometry(1,10,4);glass.scale(0.19,0.053,0.37);glass.rotateY(Math.atan2(arm.x,arm.z));glass.translate(end.x,end.y-0.18,end.z);emit("streetlight:diffuser",glass,pale);
    emit("streetlight:access-door",box(0.13,0.32,0.045).translate(p.x,p.y+0.55,p.z+0.128),iron);
  }

  // Hyde cable-car power wires and the Leavenworth crossing are outside the turns.
  for(const u of [-3,149]){
    const a=site(u,-42,8.65),b=site(u,42,8.65);
    for(const du of [-0.45,0.45])emit("crossing:overhead-wire",cable(a.clone().addScaledVector(UPHILL,du),b.clone().addScaledVector(UPHILL,du),0.23,0.023,32),iron);
    for(const v of [-21,24]){
      const p=site(u,v,0);emit("crossing:wire-pole",rod(p,p.clone().add(new Vector3(0,9.05,0)),0.085,7),iron);
      emit("crossing:wire-hanger",rod(p.clone().add(new Vector3(0,8.7,0)).addScaledVector(UPHILL,-0.66),p.clone().add(new Vector3(0,8.7,0)).addScaledVector(UPHILL,0.66),0.022,5),iron);
    }
  }

  for(const [u,v] of [[-4,-9.9],[146.5,9.8]] as const){
    const p=site(u,v,0.16);
    emit("hydrant:barrel",new CylinderGeometry(0.14,0.17,0.61,10).translate(p.x,p.y+0.31,p.z),pale);
    emit("hydrant:cap",new SphereGeometry(0.19,10,5,0,Math.PI*2,0,Math.PI/2).translate(p.x,p.y+0.61,p.z),red);
    emit("hydrant:foot",new CylinderGeometry(0.24,0.24,0.09,10).translate(p.x,p.y+0.045,p.z),iron);
    for(const side of [-1,1])emit("hydrant:side-nozzle",new CylinderGeometry(0.08,0.09,0.22,8).rotateZ(Math.PI/2).translate(p.x+side*0.19,p.y+0.4,p.z),red);
  }
  // Utility covers and slotted rain drains at the two intersections, not in flower beds.
  for(const u of [-4.4,148.1]){
    const p=site(u,3.4,0.035);
    emit("utility:manhole",new CylinderGeometry(0.42,0.42,0.025,20).translate(p.x,p.y,p.z),iron);
    for(let j=-3;j<=3;j++){
      const g=box(0.57,0.006,0.025).rotateY(Math.atan2(UPHILL.x,UPHILL.z));g.translate(p.x+NORTH_SIDE.x*j*0.085,p.y+0.016,p.z+NORTH_SIDE.z*j*0.085);emit("utility:manhole-rib",g,steel);
    }
  }
  // Entrance intercoms and mailboxes belong to facades; no street furniture row is invented.
  const p=site(2,-10.4,0.22), binM=frame(p,NORTH_SIDE);
  emit("bin:body",box(0.55,0.77,0.5).translate(0,0.42,0),iron,binM);
  emit("bin:lid",box(0.6,0.075,0.55).translate(0,0.84,0),iron,binM);
  emit("bin:slot",box(0.34,0.09,0.018).translate(0,0.74,0.26),dark,binM);
}
