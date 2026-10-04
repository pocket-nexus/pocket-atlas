import { BufferGeometry, Color, Float32BufferAttribute, Vector3, type Material } from "three";
import { box } from "../../shared/geo";
import { merge, quad, rod } from "../../shared/shapes";
import type { LombardWorld } from "./context";
import { BLOCK_LENGTH, groundY, heightAt, laneEdge, ROAD_LENGTH, roadAt, roadDistance, SIDEWALKS, sidewalkAt, site, UPHILL } from "./layout";

const UP = new Vector3(0,1,0);
function strip(points: [Vector3,Vector3][], meters: number): BufferGeometry {
  const p:number[]=[],uv:number[]=[],indices:number[]=[];
  points.forEach(([a,b],i)=>{p.push(...a.toArray(),...b.toArray());uv.push(0,i/(points.length-1)*meters,a.distanceTo(b),i/(points.length-1)*meters);if(i) {const k=i*2;indices.push(k-2,k-1,k,k-1,k+1,k);} });
  const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(p,3));g.setAttribute('uv',new Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();
  // Ribbon order may face down when authored along the opposite axis.
  const n=g.getAttribute('normal');if(n.getY(0)<0){const ix=g.index!;for(let i=0;i<ix.count;i+=3){const a=ix.getX(i+1);ix.setX(i+1,ix.getX(i+2));ix.setX(i+2,a);}g.computeVertexNormals();}
  return g;
}

/** Surveyed eight curves, retaining kerbs, stepped footways, adjoining streets. */
export function buildGround(w: LombardWorld): void {
  const brick=w.lib.brickPaving(),concrete=w.lib.concrete([1.02,1.0,.94]),asphalt=w.lib.asphalt();
  const n=512,road:[Vector3,Vector3][]=[];
  const curbParts:BufferGeometry[]=[];
  for(let i=0;i<=n;i++)road.push([laneEdge(i/n,-1,.015),laneEdge(i/n,1,.015)]);
  const ribbon=w.mesh(strip(road,ROAD_LENGTH),brick);ribbon.name='OSM 402111597 — eight brick switchbacks';
  for(const side of [-1,1]) {
    for(let i=0;i<n;i++) {
      const a=laneEdge(i/n,side),b=laneEdge((i+1)/n,side);
      const ca=roadAt(i/n),cb=roadAt((i+1)/n);
      const ao=a.clone().addScaledVector(a.clone().sub(ca).setY(0).normalize(),.22);
      const bo=b.clone().addScaledVector(b.clone().sub(cb).setY(0).normalize(),.22);
      const at=a.clone();at.y+=.19;const bt=b.clone();bt.y+=.19;
      ao.y=at.y;bo.y=bt.y;
      curbParts.push(quad(at,bt,bo,ao,UP));
      const baseA=a.clone().add(new Vector3(0,-.35,0)),baseB=b.clone().add(new Vector3(0,-.35,0));
      const normal=a.clone().sub(ca).setY(0).normalize().negate();
      curbParts.push(quad(baseA,baseB,bt,at,normal));
      // Retaining back wall connects the terraced bed with the lane at bends.
      const ga=ao.clone(),gb=bo.clone();ga.y=groundY(ga.x,ga.z)+.08;gb.y=groundY(gb.x,gb.z)+.08;
      curbParts.push(quad(ao,bo,gb,ga,normal.clone().negate()));
    }
  }
  w.mesh(merge(curbParts),concrete).name='weathered concrete kerbs and planter retaining edges';

  // A fine height field is cut below the road. Street-bank relief connects
  // to the kerb walls; parcel ground beyond the stairs keeps the DEM profile.
  const positions:number[]=[],colors:number[]=[],uvs:number[]=[],ind:number[]=[];
  const soil=w.lib.ground().clone();soil.name='terraced garden earth';soil.vertexColors=true;
  const nu=300,nv=84,du=160/nu,dv=42/nv;
  for(let i=0;i<=nu;i++)for(let j=0;j<=nv;j++){
    const u=-5+i*du,v=-21+j*dv,p=site(u,v,-.04),d=roadDistance(p.x,p.z);
    if(u>7&&u<139&&d<3.8)p.y-=Math.max(0,1-d/3.8)*1.2;
    if(u<7||u>139)p.y-=.4;
    positions.push(...p.toArray());uvs.push(p.x,p.z);
    const c=new Color().setRGB(.8+.1*Math.sin(u*.39),.87+.06*Math.sin(v),.75);colors.push(...c.toArray());
    if(i&&j&&u>8&&u<137.5){const k=i*(nv+1)+j;ind.push(k-nv-2,k-1,k,k-nv-2,k,k-nv-1);}
  }
  const terrain=new BufferGeometry();terrain.setAttribute('position',new Float32BufferAttribute(positions,3));terrain.setAttribute('normal',new Float32BufferAttribute(new Float32Array(positions.length),3));terrain.setAttribute('uv',new Float32BufferAttribute(uvs,2));terrain.setAttribute('color',new Float32BufferAttribute(colors,3));terrain.setIndex(ind);terrain.computeVertexNormals();
  // u cross v points downward; reverse to the exposed slope.
  const ni=terrain.index!;for(let i=0;i<ni.count;i+=3){const a=ni.getX(i+1);ni.setX(i+1,ni.getX(i+2));ni.setX(i+2,a);}terrain.computeVertexNormals();
  w.mesh(terrain,soil).name='USGS terraced slope';
  const groundBase:BufferGeometry[]=[];
  for(let u=-240;u<250;u+=8)for(let v=-180;v<180;v+=8){
    if(u>0&&u<144&&v>-16&&v<16)continue;
    groundBase.push(quad(site(u,v,-.20),site(u+8,v,-.20),site(u+8,v+8,-.20),site(u,v+8,-.20),UP));
  }
  w.mesh(merge(groundBase),w.lib.concrete([.62,.60,.55])).name='continuous Russian Hill ground under streets and parcels';


  for(const side of [-1,1])stairs(w,side,concrete);
  street(w,0,asphalt,concrete);street(w,BLOCK_LENGTH,asphalt,concrete);
  for(const [a,b] of [[6.8,8.4],[137,140]]){
    for(const side of [-1,1]){
      const va=side*4.5,vb=side*21;
      w.mesh(quad(site(a,va,-.06),site(b,va,-.06),site(b,vb,-.06),site(a,vb,-.06),UP),concrete);
    }
  }
  // The continuation toward North Beach, and approach west of Hyde.
  for(const [a,b] of [[-220,-6.5],[153,250]]) {
    const rows:[Vector3,Vector3][]=[];
    for(let u=a;u<=b;u+=1)rows.push([site(u,-6.8,.03),site(u,6.8,.03)]);
    w.mesh(strip(rows,b-a),asphalt).name='Lombard continuation';
  }
}

function stairs(w:LombardWorld,side:number,mat:Material):void {
  const bounds=SIDEWALKS[side<0?0:1],start=bounds[0][0],end=bounds[bounds.length-1][0];
  const parts:BufferGeometry[]=[],rail:BufferGeometry[]=[];
  // 0.55 m tread including occasional wider entrances, 0.11–0.15 m
  // rise from the DEM; actual runs interrupt at the measured driveways.
  const count=Math.ceil((end-start)/.55),step=(end-start)/count;
  for(let i=0;i<count;i++){
    const u=start+i*step,p=sidewalkAt(u,side),next=sidewalkAt(u+step,side);
    const h=next.y-p.y;
    const g=box(1.35,Math.max(.12,h+.08),step+.015);g.rotateY(Math.atan2(UPHILL.x,UPHILL.z));g.translate(p.x,p.y+(h-.08)/2,p.z);parts.push(g);
  }
  w.mesh(merge(parts),mat).name=`${side<0?'south':'north'} measured stair walk`;
  const dark=w.lib.paint(0x4e5551,.65);
  for(let u=start;u<end-1;u+=2.5){
    if(side>0&&u>54.5&&u<62)continue;
    const a=sidewalkAt(u,side,1.07),b=sidewalkAt(Math.min(end,u+2.5),side,1.07);
    const nx=-UPHILL.z*side,nz=UPHILL.x*side;a.x-=nx*.54;a.z-=nz*.54;b.x-=nx*.54;b.z-=nz*.54;
    rail.push(rod(a,b,.027,5));rail.push(rod(a.clone().add(new Vector3(0,-.85,0)),a,.023,5));
  }
  w.mesh(merge(rail),dark).name='continuous stair handrails';
}
function street(w:LombardWorld,u:number,asphalt:Material,concrete:Material):void {
  const rows:[Vector3,Vector3][]=[];
  for(let v=-130;v<=130;v+=2){const a=site(u-6.8,v,.025),b=site(u+6.8,v,.025);rows.push([a,b]);}
  w.mesh(strip(rows,260),asphalt).name=u>100?'Hyde Street':'Leavenworth Street';
  // Sidewalks at the four corners, leaving the crooked road entrance clear.
  for(const edge of [-1,1])for(const side of [-1,1]){
    const panels:[Vector3,Vector3][]=[];
    for(let v=side*12;Math.abs(v)<=130;v+=side*2){const a=site(u+edge*7,v,.18),b=site(u+edge*9,v,.18);panels.push([a,b]);}
    w.mesh(strip(panels,118),concrete);
  }
  const paint=w.lib.roadPaint();
  for(const v of [-8.2,8.2])for(let x=-5.5;x<6;x+=1.2){
    const g=box(.65,.015,2.2);g.rotateY(Math.atan2(UPHILL.z,-UPHILL.x));const p=site(u+x,v,.055);g.translate(p.x,p.y,p.z);w.mesh(g,paint,0,0,0,w.root,{cast:false});
  }
  if(u>100){
    // Powell-Hyde cable-car rails plus the narrow central cable slot.
    const rail=w.lib.plain(0x808789,.36,.7),slot=w.lib.plain(0x292929,1);
    for(const off of [-2.05,-.615,.615,2.05, -1.33,1.33]){
      const ps:BufferGeometry[]=[];for(let v=-110;v<110;v+=5){const a=site(u+off,v,.065),b=site(u+off,v+5,.065);a.y=heightAt(u)-v*.19+.065;b.y=heightAt(u)-(v+5)*.19+.065;ps.push(rod(a,b,Math.abs(off)===1.33?.027:.034,4));}
      w.mesh(merge(ps),Math.abs(off)===1.33?slot:rail,0,0,0,w.root,{cast:false});
    }
  }
}
