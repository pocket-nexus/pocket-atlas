import { BufferGeometry, Color, Float32BufferAttribute, MeshStandardMaterial, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { canvas, toTexture, type Ctx } from "../../shared/canvas";
import type { DayLib } from "../../shared/daylight/materials";

/** One 1024² cutout atlas: leaf shoots, hydrangea florets, vine bracts and palm pinnae. */
export const LEAF = { hydrangea: 0, hedge: 1, tree: 2, palm: 3, pink: 4, blue: 5, ivory: 6, mauve: 7, vine: 8, vineLeaf: 9, hydrangeaShoot: 10, clippedHedge: 11 } as const;
const GRID = 4;

function leaf(g: Ctx, x: number, y: number, length: number, width: number, angle: number, shade: number, serrated = false): void {
  g.save(); g.translate(x,y); g.rotate(angle);
  g.beginPath();g.moveTo(0,0);
  for(let side=0;side<2;side++)for(let j=0;j<=18;j++) {
    const t=side ? 1-j/18 : j/18;
    const serration=serrated ? (j%2 ? .84 : 1) : 1;
    g.lineTo((side ? -1 : 1)*Math.sin(Math.PI*t)**.78*width*.5*serration,-t*length);
  }
  g.closePath(); const gradient=g.createLinearGradient(-width*.5,0,width*.5,-length);
  gradient.addColorStop(0,`hsl(93 43% ${shade-7}%)`);gradient.addColorStop(.52,`hsl(85 43% ${shade+9}%)`);gradient.addColorStop(1,`hsl(92 48% ${shade}%)`);
  g.fillStyle=gradient;g.fill();g.strokeStyle=`hsla(76,42%,${shade+19}%,.65)`;g.lineWidth=Math.max(.7,length*.016);
  g.beginPath();g.moveTo(0,0);g.lineTo(0,-length*.96);g.stroke();
  g.lineWidth=Math.max(.45,length*.008);
  for(let j=2;j<8;j++) { const t=j/9;for(const sign of [-1,1]) {g.beginPath();g.moveTo(0,-t*length);g.lineTo(sign*Math.sin(Math.PI*t)*width*.41,-(t+.15)*length);g.stroke();} }
  g.restore();
}

function flower(g: Ctx, x:number,y:number,r:number,hue:number,sat:number,light:number,phase:number): void {
  g.save();g.translate(x,y);g.rotate(phase);
  for(let j=0;j<4;j++) {
    g.save();g.rotate(j*Math.PI*.5);g.beginPath();g.moveTo(0,0);g.bezierCurveTo(-r*.65,-r*.1,-r*.55,-r*.92,0,-r);g.bezierCurveTo(r*.61,-r*.86,r*.54,-r*.1,0,0);
    const gradient=g.createLinearGradient(0,0,0,-r);gradient.addColorStop(0,`hsl(${hue} ${sat}% ${light-20}%)`);gradient.addColorStop(.7,`hsl(${hue} ${sat}% ${light}%)`);gradient.addColorStop(1,`hsl(${hue} ${sat-8}% ${light+6}%)`);
    g.fillStyle=gradient;g.fill();g.strokeStyle=`hsla(${hue},${sat}%,${light-20}%,.38)`;g.lineWidth=.75;g.stroke();g.restore();
  }
  g.fillStyle="#dcc6a0";g.beginPath();g.arc(0,0,r*.1,0,Math.PI*2);g.fill();g.restore();
}

export function foliageMaterial(lib: DayLib): MeshStandardMaterial {
  const {c,g}=canvas(1024,1024),rng=new Rng(0x10401040);
  for(let tile=0;tile<12;tile++) {
    g.save();g.translate((tile%GRID)*256,Math.floor(tile/GRID)*256);g.beginPath();g.rect(4,4,248,248);g.clip();
    if(tile===LEAF.hydrangea) {
      // A full individual leaf: broad blade, pointed tip and serrated margin.
      leaf(g,128,246,229,172,0,26,true);
    } else if(tile===LEAF.hydrangeaShoot) {
      g.strokeStyle="#42632d";g.lineWidth=7;g.beginPath();g.moveTo(127,253);g.bezierCurveTo(127,196,138,90,125,18);g.stroke();
      for(let j=0;j<9;j++) {const side=j%2?1:-1,t=j/9;leaf(g,128,240-t*197,88+rng.range(-12,17),64+rng.range(-8,12),side*rng.range(.65,1.27),rng.range(23,32),true);}
      leaf(g,130,95,89,67,.08,32,true);
    } else if(tile===LEAF.clippedHedge) {
      // Dense individual boxwood blades with irregular tiny silhouette gaps.
      for(let j=0;j<115;j++) {const a=j*2.399963,rr=Math.sqrt((j+.5)/115)*111;leaf(g,128+Math.cos(a)*rr,142+Math.sin(a)*rr,rng.range(24,39),rng.range(16,25),rng.range(-3.14,3.14),rng.range(19,31));}
    } else if(tile===LEAF.hedge || tile===LEAF.tree || tile===LEAF.vineLeaf) {
      g.strokeStyle="#656140";g.lineWidth=3;g.beginPath();g.moveTo(130,248);g.quadraticCurveTo(116,120,133,22);g.stroke();
      const count=tile===LEAF.hedge?15:9;
      for(let j=0;j<count;j++) {const f=j/count;const side=j%2?1:-1;leaf(g,128+rng.range(-5,5),240-f*204,tile===LEAF.hedge?54:82,tile===LEAF.hedge?31:46,side*rng.range(.45,1.03),rng.range(tile===LEAF.hedge?28:22,tile===LEAF.hedge?40:36));}
      leaf(g,130,64,56,30,0,35);
    } else if(tile===LEAF.palm) {
      g.strokeStyle="#929147";g.lineWidth=3;g.beginPath();g.moveTo(128,250);g.lineTo(128,12);g.stroke();
      for(let j=0;j<22;j++) {const f=j/22;for(const sign of [-1,1])leaf(g,128,236-f*208,103*Math.sin((f*.82+.1)*Math.PI)+8,15,sign*(.95-.4*f),rng.range(21,34));}
    } else if(tile===LEAF.vine) {
      for(let j=0;j<42;j++) {const a=rng.range(0,Math.PI*2),rr=Math.sqrt(rng.next())*91;flower(g,128+Math.cos(a)*rr,128+Math.sin(a)*rr,rng.range(17,28),rng.range(307,329),rng.range(60,78),rng.range(31,50),a);}
    } else {
      const hues=[337,222,57,282],sats=[47,42,16,35],lights=[74,75,87,75],i=tile-4;
      // Each card is a small curved-looking group of actual four-sepal flowers.
      for(let j=0;j<28;j++) {const a=j*2.399963,rr=Math.sqrt((j+.3)/28)*94;flower(g,128+Math.cos(a)*rr,128+Math.sin(a)*rr,rng.range(16,24),hues[i]+rng.range(-7,7),sats[i],lights[i]+rng.range(-8,6),a);}
    }
    g.restore();
  }
  const tex=toTexture(c);tex.name="lombard-leaves-and-petals";
  const mat=lib.cutout("lombard-botanical-atlas",tex,{rough:.92});mat.vertexColors=true;
  return mat;
}

/** Explicit leaf cards, with an outward normal and per-shoot colour variation. */
export class FoliageCards {
  private positions:number[]=[]; private normals:number[]=[];private uvs:number[]=[];private colors:number[]=[];private indices:number[]=[];
  get triangles():number { return this.indices.length/3; }
  add(center:Vector3,width:number,height:number,normal:Vector3,roll:number,tile:number,tint=1):void {
    const n=normal.clone().normalize();
    const right=new Vector3().crossVectors(Math.abs(n.y)>.96?new Vector3(0,0,1):new Vector3(0,1,0),n).normalize();
    const up=new Vector3().crossVectors(n,right).normalize();
    const r=right.clone().multiplyScalar(Math.cos(roll)).addScaledVector(up,Math.sin(roll));
    const u=up.clone().multiplyScalar(Math.cos(roll)).addScaledVector(right,-Math.sin(roll));
    const i=this.positions.length/3,colour=new Color(tint,tint,tint),tx=(tile%4)/4,ty=1-Math.floor(tile/4)/4;
    for(const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
      const p=center.clone().addScaledVector(r,a*width*.5).addScaledVector(u,b*height*.5);
      this.positions.push(p.x,p.y,p.z);this.normals.push(n.x,n.y,n.z);this.colors.push(colour.r,colour.g,colour.b);
      this.uvs.push(tx+(a+1)*.125,ty-.25+(b+1)*.125);
    }
    this.indices.push(i,i+1,i+2,i,i+2,i+3);
  }
  geometry():BufferGeometry {
    const g=new BufferGeometry();g.setAttribute("position",new Float32BufferAttribute(this.positions,3));g.setAttribute("normal",new Float32BufferAttribute(this.normals,3));g.setAttribute("uv",new Float32BufferAttribute(this.uvs,2));g.setAttribute("color",new Float32BufferAttribute(this.colors,3));g.setIndex(this.indices);g.computeBoundingSphere();return g;
  }
}
