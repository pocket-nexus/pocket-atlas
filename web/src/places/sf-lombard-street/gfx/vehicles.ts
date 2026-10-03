import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { canvas, toTexture } from "../../shared/canvas";

export type CarKind="hatch"|"suv"|"sedan";
export interface CarModel { root:Group; wheels:Group[]; wheelRadius:number; wheelbase:number; }
const RUBBER=0x202124,CHROME=0xb8bebd,DARK=0x292c2e,LAMP=0xe4e4ce,RED=0x8f161b;
const bodyMat=new MeshStandardMaterial({vertexColors:true,roughness:.4,metalness:.17});bodyMat.name="lombard-car-paint-trim";
const glassMat=new MeshStandardMaterial({vertexColors:true,roughness:.2,metalness:0,envMapIntensity:.45});glassMat.name="lombard-car-glazing";

function glassTexture():void {
  if(glassMat.map)return;
  const {c,g}=canvas(256,256),grad=g.createLinearGradient(0,0,0,256);
  grad.addColorStop(0,"#364c56");grad.addColorStop(.28,"#243a45");grad.addColorStop(.7,"#14232c");grad.addColorStop(1,"#0d151c");g.fillStyle=grad;g.fillRect(0,0,256,256);
  g.fillStyle="#64798324";g.beginPath();g.moveTo(17,0);g.lineTo(86,0);g.lineTo(188,256);g.lineTo(145,256);g.closePath();g.fill();
  g.strokeStyle="#121b21";g.lineWidth=7;g.strokeRect(1,1,254,254);
  glassMat.map=toTexture(c);glassMat.map.name="day-car-glass-sky-reflection";glassMat.needsUpdate=true;
}

function paint(g:BufferGeometry,hex:number):BufferGeometry {
  const c=new Color(hex),n=g.getAttribute("position").count,v=new Float32Array(n*3);for(let i=0;i<n;i++)v.set([c.r,c.g,c.b],i*3);g.setAttribute("color",new Float32BufferAttribute(v,3));return g;
}
function box(out:BufferGeometry[],w:number,h:number,d:number,x:number,y:number,z:number,c:number,ry=0):void {
  const g=paint(new BoxGeometry(w,h,d),c);g.rotateY(ry);g.translate(x,y,z);out.push(g);
}
function quad(out:BufferGeometry[],points:[number,number,number][],c:number):void {
  const g=new BufferGeometry();g.setAttribute("position",new Float32BufferAttribute(points.flat(),3));g.setAttribute("uv",new Float32BufferAttribute([0,0,1,0,1,1,0,1],2));g.setIndex([0,1,2,0,2,3]);g.computeVertexNormals();out.push(paint(g,c));
}

/** Sectioned bodywork and cabin; vehicle axis is +Z, wheel contact Y=0. */
export function makeCar(kind:CarKind,bodyColor:number):CarModel {
  glassTexture();
  const root=new Group(),solid:BufferGeometry[]=[],glass:BufferGeometry[]=[];
  const suv=kind==="suv",sedan=kind==="sedan",width=suv?1.86:1.76,length=sedan?4.52:suv?4.38:4.14,roof=suv?1.69:1.45;
  const w=width*.5,half=length*.5,r=suv?.34:.31,wheelbase=suv?2.64:sedan?2.67:2.52;
  const zFront=wheelbase*.5,zRear=-wheelbase*.5;
  // Nine-point section: bevels at the shoulder and bottom sill soften silhouette.
  const sections=[[-half,.88,.38,.85],[-half+.26,1,.36,.90],[-half+.75,1,.35,.92],[half-.8,1,.35,.94],[half-.24,.94,.37,.89],[half,.82,.41,.82]];
  const samples=[...sections.map(s=>s[0]),...[zFront,zRear].flatMap(z=>Array.from({length:9},(_,i)=>z+(i/8*2-1)*r*1.08))].sort((a,b)=>a-b);
  const rings=samples.map(z=> {
    const next=sections.findIndex(s=>s[0]>z),i=next<0?sections.length-2:Math.max(0,next-1);
    const a=sections[i],b=sections[i+1],t=Math.max(0,Math.min(1,(z-a[0])/(b[0]-a[0]))),s=a[1]+(b[1]-a[1])*t,hi=a[3]+(b[3]-a[3])*t;
    let lo=a[2]+(b[2]-a[2])*t;
    for(const wheelZ of [zFront,zRear]) {const dz=z-wheelZ,rr=r*1.08;if(Math.abs(dz)<rr)lo=Math.max(lo,r+Math.sqrt(rr*rr-dz*dz));}
    return [[-w*s,lo,z],[-w*s,hi-.10,z],[-w*s*.9,hi,z],[w*s*.9,hi,z],[w*s,hi-.10,z],[w*s,lo,z],[w*s*.76,lo-.06,z],[-w*s*.76,lo-.06,z]] as [number,number,number][];
  });
  for(let j=0;j<rings.length-1;j++)for(let k=0;k<8;k++)quad(solid,[rings[j+1][k],rings[j+1][(k+1)%8],rings[j][(k+1)%8],rings[j][k]],bodyColor);
  quad(solid,[rings[0][1],rings[0][4],rings[0][5],rings[0][0]],bodyColor);quad(solid,[rings.at(-1)![5],rings.at(-1)![4],rings.at(-1)![1],rings.at(-1)![0]],bodyColor);
  // Close both shoulder bevels and underbody bevels at the bumpers.
  for(const [ring,frontCap] of [[rings[0],false],[rings.at(-1)!,true]] as const) {
    const top=[ring[1],ring[2],ring[3],ring[4]],bottom=[ring[0],ring[5],ring[6],ring[7]];
    quad(solid,frontCap?top.reverse():top,bodyColor);quad(solid,frontCap?bottom.reverse():bottom,bodyColor);
  }
  const back=sedan?-1.18:-1.48,front=.98,roofBack=sedan?-.75:-1.03,roofFront=.40,belt=.87,roofWidth=w*.80;
  // Closed cabin faces; dark glazing sits proud of each frame by a few millimetres.
  quad(solid,[[-roofWidth,roof,roofBack],[roofWidth,roof,roofBack],[w*.94,belt,back],[-w*.94,belt,back]],bodyColor);
  quad(solid,[[-roofWidth,roof,roofFront],[roofWidth,roof,roofFront],[roofWidth,roof,roofBack],[-roofWidth,roof,roofBack]],bodyColor);
  quad(solid,[[-w*.88,belt,front],[w*.88,belt,front],[roofWidth,roof,roofFront],[-roofWidth,roof,roofFront]],bodyColor);
  // The windscreen has a shallow transverse bow, with a continuous reflection map.
  { const positions:number[]=[],uv:number[]=[],index:number[]=[];
    for(let row=0;row<2;row++)for(let j=0;j<=8;j++) {const s=j/8,x=(s*2-1)*(row?roofWidth*.93:w*.80),y=row?roof-.075:belt+.08,z=(row?roofFront+.055:front+.009)+Math.sin(s*Math.PI)*.068;positions.push(x,y,z);uv.push(s,row);}
    for(let j=0;j<8;j++)index.push(j,j+1,j+10,j,j+10,j+9);
    const g=new BufferGeometry();g.setAttribute("position",new Float32BufferAttribute(positions,3));g.setAttribute("uv",new Float32BufferAttribute(uv,2));g.setIndex(index);g.computeVertexNormals();glass.push(paint(g,0xc5d4d8));
  }
  quad(glass,[[w*.81,belt+.07,back-.008],[-w*.81,belt+.07,back-.008],[-roofWidth*.93,roof-.08,roofBack-.03],[roofWidth*.93,roof-.08,roofBack-.03]],0xa0b3b9);
  for(const sign of [-1,1]) {
    const x=sign*w*.945,xr=sign*roofWidth;
    const side:[[number,number,number],[number,number,number],[number,number,number],[number,number,number]]=[[x,belt,back],[x,belt,front],[xr,roof,roofFront],[xr,roof,roofBack]];
    quad(solid,sign<0?side:[side[3],side[2],side[1],side[0]],bodyColor);
    // Two panes split by a genuine opaque B pillar and thin rubber seals.
    const middle=-.28;
    const panes=[[[x*1.008,belt+.08,back+.12],[x*1.008,belt+.08,middle-.065],[xr*1.018,roof-.085,middle-.065],[xr*1.018,roof-.085,roofBack+.075]],[[x*1.008,belt+.08,middle+.065],[x*1.008,belt+.08,front-.15],[xr*1.018,roof-.085,roofFront-.08],[xr*1.018,roof-.085,middle+.065]]] as [number,number,number][][];
    for(const pane of panes)quad(glass,sign<0?pane:[pane[3],pane[2],pane[1],pane[0]],0xacbdc5);
    box(solid,.025,.035,2.65,sign*w*.987,belt-.04,-.08,CHROME);
    box(solid,.034,.023,.18,sign*w*1.008,.76,.19,CHROME);box(solid,.034,.023,.18,sign*w*1.008,.76,-.89,CHROME);
    box(solid,.024,.025,length-.45,sign*w*.91,.35,0,DARK);
    // Door shut-lines, mirrors and the fuel flap are real relief at close range.
    box(solid,.008,.38,.009,sign*w*1.003,.64,-.27,DARK);
    box(solid,.14,.035,.035,sign*(w+.04),1.04,.63,DARK);
    box(solid,.14,.1,.2,sign*(w+.14),1.07,.61,bodyColor);box(solid,.115,.068,.013,sign*(w+.14),1.072,.50,CHROME);
  }
  // Front grille, inset air intake, paired light housings and rear reflectors.
  box(solid,width*.46,.16,.025,0,.60,half+.006,DARK);
  for(let j=0;j<4;j++)box(solid,width*.44,.008,.03,0,.55+j*.037,half+.023,CHROME);
  box(solid,width*.77,.045,.06,0,.4,half-.045,DARK);
  for(const sign of [-1,1]) {
    box(solid,.40,.095,.025,sign*w*.64,.755,half-.009,DARK,sign*.14);
    box(solid,.37,.071,.026,sign*w*.64,.756,half+.005,LAMP,sign*.14);
    box(solid,.048,.07,.029,sign*w*.84,.748,half-.006,0xe3a23c);
    box(solid,.33,.13,.065,sign*w*.68,.76,-half+.012,RED);
    box(solid,.17,.045,.07,sign*w*.63,.76,-half+.016,0xd8d5bc);
  }
  box(solid,.47,.13,.03,0,.53,half+.039,0xe7e5df);box(solid,.47,.13,.03,0,.58,-half-.018,0xe6e3d9);
  for(let j=0;j<7;j++) {box(solid,.023,.045,.006,-.115+j*.038,.53,half+.058,0x343746);box(solid,.023,.045,.006,-.115+j*.038,.58,-half-.036,0x343746);}
  box(solid,width*.83,.04,.06,0,.45,-half-.005,DARK);
  if(suv)for(const sign of [-1,1])box(solid,.045,.035,1.78,sign*.60,roof+.026,-.3,CHROME);
  // A narrow antenna and rear wiper preserve recognisable everyday car details.
  box(solid,.018,.16,.022,0,roof+.08,roofBack+.11,DARK);
  box(solid,.47,.018,.016,.08,roof-.31,back+.09,DARK);
  const body=new Mesh(mergeGeometries(solid,false)!,bodyMat);body.castShadow=false;body.name="bodywork-lamps-grille";root.add(body);
  const windows=new Mesh(mergeGeometries(glass,false)!,glassMat);windows.castShadow=false;windows.name="inset-windscreens";root.add(windows);
  for(const g of [...solid,...glass])g.dispose();
  const wheels:Group[]=[];
  for(const z of [zFront,zRear])for(const sign of [-1,1]) {
    const wheel=new Group();wheel.position.set(sign*(w-.045),r,z);root.add(wheel);wheels.push(wheel);
    const parts:BufferGeometry[]=[];
    const tire=paint(new CylinderGeometry(r,r,.19,14,1),RUBBER);tire.rotateZ(Math.PI*.5);parts.push(tire);
    const rim=paint(new CylinderGeometry(r*.65,r*.65,.194,12,1),0x878d8c);rim.rotateZ(Math.PI*.5);parts.push(rim);
    for(let j=0;j<6;j++) {
      const a=j*Math.PI/3,g=paint(new BoxGeometry(.203,.027,r*1.18),CHROME);g.rotateX(a);parts.push(g);
    }
    const hub=paint(new CylinderGeometry(.056,.056,.209,8,1),DARK);hub.rotateZ(Math.PI*.5);parts.push(hub);
    const mesh=new Mesh(mergeGeometries(parts,false)!,bodyMat);mesh.castShadow=false;wheel.add(mesh);parts.forEach(g=>g.dispose());
  }
  root.name=`${kind}-car`;
  return {root,wheels,wheelRadius:r,wheelbase};
}
