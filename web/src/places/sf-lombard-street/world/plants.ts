import { CylinderGeometry, Vector3 } from "three";
import { Rng } from "../../../core/random";
import { FoliageCards, foliageMaterial, LEAF } from "../gfx/foliage";
import type { LombardWorld } from "./context";
import { BLOCK_LENGTH, ROAD_LENGTH, ROAD_WIDTH, groundY, roadDistance, roadEdge, sidewalkV, site, siteUV } from "./layout";

/** Garden limits follow both the OSM road and the surveyed stairways. */
function garden(p:Vector3,radius:number):boolean {
  const [u,v]=siteUV(p.x,p.z);
  return u>3 && u<BLOCK_LENGTH-3 && v>sidewalkV(u,-1)+1.08+radius && v<sidewalkV(u,1)-1.08-radius && roadDistance(p.x,p.z)>ROAD_WIDTH*.5+.45+radius;
}

function branch(w:LombardWorld,a:Vector3,b:Vector3,r:number):void {
  const d=b.clone().sub(a),m=w.mesh(new CylinderGeometry(r*.55,r,d.length(),6,1),w.lib.bark());m.position.copy(a).add(b).multiplyScalar(.5);m.quaternion.setFromUnitVectors(new Vector3(0,1,0),d.normalize());
}

function hydrangea(cards:FoliageCards,p:Vector3,rng:Rng,r:number,flowerTile:number):void {
  // Open structure: individually veined leaves around woody shoots, flowerheads above.
  for(let j=0;j<23;j++) {
    const a=j*2.399963+rng.range(-.3,.3),h=rng.range(.23,.85)*r;
    const rr=Math.sqrt(rng.next())*r*.62;
    const c=p.clone().add(new Vector3(Math.cos(a)*rr,h,Math.sin(a)*rr));
    const normal=new Vector3(Math.cos(a),rng.range(.4,1.25),Math.sin(a));
    const shoot=j%3!==0;
    cards.add(c,shoot?rng.range(.48,.61):rng.range(.25,.38),shoot?rng.range(.62,.78):rng.range(.33,.48),normal,rng.range(-.65,.65),shoot?LEAF.hydrangeaShoot:LEAF.hydrangea,rng.range(.74,1.02));
  }
  for(let j=0;j<6;j++) {
    const a=j*2.399963,rr=r*Math.sqrt((j+.4)/7)*.72;
    const c=p.clone().add(new Vector3(Math.cos(a)*rr,r*rng.range(.70,.94)+.14,Math.sin(a)*rr));
    // Three small sepal cards form a head; never an opaque sphere.
    const size=rng.range(.25,.39);
    for(let k=0;k<3;k++) {const angle=a+k*2.094;const n=new Vector3(Math.cos(angle)*.78,.65,Math.sin(angle)*.78);cards.add(c.clone().addScaledVector(n,.04),size,size,n,rng.range(0,6.28),flowerTile,rng.range(.86,1.03));}
  }
}

function hedge(cards:FoliageCards,p:Vector3,rng:Rng):void {
  // Clipped outline: little surface shoots make a low rectangular contour.
  for(let j=0;j<13;j++) {
    const a=rng.range(0,Math.PI*2),h=rng.range(.14,.65),top=j>8;
    const c=p.clone().add(new Vector3(Math.cos(a)*rng.range(.1,.31),top?.65:h,Math.sin(a)*rng.range(.1,.31)));
    cards.add(c,rng.range(.36,.48),rng.range(.39,.50),top?new Vector3(Math.cos(a)*.35,1,Math.sin(a)*.35):new Vector3(Math.cos(a),.25,Math.sin(a)),rng.range(-1.2,1.2),j%4===0?LEAF.hedge:LEAF.clippedHedge,rng.range(.74,1.04));
  }
}

function tree(w:LombardWorld,cards:FoliageCards,p:Vector3,rng:Rng,h:number,r:number):void {
  const top=p.clone().add(new Vector3(.12,h*.67,.13));branch(w,p,top,.15);
  for(let j=0;j<5;j++) {const a=j*2.399963;branch(w,p.clone().add(new Vector3(0,h*.37,0)),p.clone().add(new Vector3(Math.cos(a)*r*.72,h*.81,Math.sin(a)*r*.72)),.065);}
  for(let j=0;j<115;j++) {
    const az=j*2.399963,el=Math.acos(1-2*(j+.5)/115),d=rng.range(.55,1);
    const n=new Vector3(Math.sin(el)*Math.cos(az),Math.cos(el),Math.sin(el)*Math.sin(az));
    const c=p.clone().add(new Vector3(n.x*r*d,h*.69+n.y*r*1.12*d,n.z*r*d));
    cards.add(c,rng.range(.48,.77),rng.range(.55,.86),n.clone().add(new Vector3(0,.5,0)),rng.range(-3.14,3.14),LEAF.tree,rng.range(.72,1.1));
  }
}

function palm(w:LombardWorld,cards:FoliageCards,p:Vector3,rng:Rng,h:number):void {
  const crown=p.clone().add(new Vector3(.24,h,.1));branch(w,p,crown,.19);
  for(let j=0;j<17;j++) {
    const a=j*Math.PI*2/17,d=new Vector3(Math.cos(a),0,Math.sin(a));
    for(let k=0;k<4;k++) {const t=(k+.5)/4,c=crown.clone().addScaledVector(d,t*2);c.y+=.48*Math.sin(t*Math.PI)-t*t*.85;
      cards.add(c,.9,1.05,new Vector3(d.x*.25,1,d.z*.25),-a+Math.PI*.5,LEAF.palm,rng.range(.78,.98));}
  }
}

function bougainvillea(w:LombardWorld,cards:FoliageCards,rng:Rng):void {
  const trunk=site(64.7,11.58);trunk.y=14.0;
  for(let j=0;j<4;j++) {const a=trunk.clone().add(new Vector3(0,j*1.85,0)),b=site(64.6-j*.62,11.45);b.y=16.2+j*2;branch(w,a,b,.06);}
  for(let j=0;j<630;j++) {
    const u=j<390?rng.range(62.2,65.8):rng.range(55.4,65.3);
    const y=j<390?rng.range(17.6,25.3):rng.range(23.15,25.4);
    const p=site(u,rng.range(10.88,11.72));p.y=y;
    const n=new Vector3(rng.range(-.7,.7),rng.range(-.2,.8),1).normalize();
    cards.add(p,rng.range(.66,.96),rng.range(.6,.93),n,rng.range(-3.14,3.14),j%8?LEAF.vine:LEAF.vineLeaf,rng.range(.78,1.02));
  }
  // Lower, sparse blossom sprays leave the central sash windows visible.
  for(let j=0;j<22;j++) {const p=site(rng.range(61.3,64.9),rng.range(11.15,11.65));p.y=rng.range(15.25,17.5);cards.add(p,.48,.5,new Vector3(-.17,.15,1),rng.range(-2,2),LEAF.vine,rng.range(.8,1));}
}

export function buildPlants(w:LombardWorld):void {
  const cards=new FoliageCards(),rng=new Rng(0x4c4f4d42);
  // The serpentine garden borders are clipped into the stair and lane envelopes.
  const hedgeSites:Vector3[]=[];
  for(let d=2;d<ROAD_LENGTH-2;d+=.68)for(const side of [-1,1]) {
    const p=roadEdge(d/ROAD_LENGTH,side*(ROAD_WIDTH*.5+1.11));p.y=groundY(p.x,p.z)+.13;
    if(!garden(p,.58)||hedgeSites.some(q=>q.distanceToSquared(p)<.43**2))continue;
    hedgeSites.push(p);hedge(cards,p,rng);
  }
  // Staggered flowering beds, with soil between broad individual leaf clusters.
  const shrubs:Vector3[]=[];
  for(let u=5;u<BLOCK_LENGTH-4;u+=1.72)for(let v=-9;v<=9;v+=1.5) {
    const p=site(u+rng.range(-.35,.35),v+rng.range(-.28,.28),.17);
    if(!garden(p,.85)||shrubs.some(q=>q.distanceToSquared(p)<1.12**2))continue;
    shrubs.push(p);
    const colors=[LEAF.pink,LEAF.pink,LEAF.ivory,LEAF.mauve,LEAF.blue];
    hydrangea(cards,p,rng,rng.range(.6,.85),colors[Math.floor(u/19)%colors.length]);
  }
  // Small pollarded trees are anchored in the larger gardens, not in the stairway.
  for(const [u,v,h,r] of [[11,-6.5,4.6,1.2],[35,-4.8,4.1,1.1],[50,3.8,4.4,1.05],[80,4.9,4.5,1.2],[95,-3.7,4.1,1.15],[125,-3.3,4.8,1.2],[139,6.5,4.4,1.15]]) {
    const p=site(u,v,.1);if(garden(p,r+.43))tree(w,cards,p,rng,h,r);
  }
  // Narrow crowns at the upper block: slender fan/pinnate silhouettes against sky.
  for(const [u,v,h] of [[138,5.5,7.8],[109,3.3,6.7]]) {const p=site(u,v,.1);if(garden(p,2.3))palm(w,cards,p,rng,h);}
  bougainvillea(w,cards,rng);
  const mesh=w.mesh(cards.geometry(),foliageMaterial(w.lib));mesh.name="hydrangeas-hedges-leaf-cards";
  console.info("[lombard] botanical geometry",{hedgePlants:hedgeSites.length,hydrangeas:shrubs.length,triangles:cards.triangles});
}
