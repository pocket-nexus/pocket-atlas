import { ExtrudeGeometry, Shape } from "three";
import type { DayWorld } from "../../shared/daylight/context";
import { source } from "../../shared/provenance";
import { block, bar } from "./fabric";

/** Modern OSM outlines of the retained 1961 blocks, fetched 2026-10-04. Their persistence in 1990 is inferred from period photos.
 * Source ways A 223292956, B 223292961, C 223292965, D 223292968, E 223292970; ODbL, © OpenStreetMap contributors.
 * East/north-metre projection rounded to 0.1 m; +4 m east offsets the photo origin onto the west threshold. */
const FOOTPRINTS = [
  [[9.3,-8.7],[8.6,-18.8],[-3.9,-17.8],[-1.3,17.6],[11.2,16.7],[10.5,7.1],[15.3,6.8],[15.8,14.3],[26.4,13.5],[24,-17.7],[13.5,-16.9],[14.1,-9.1]],
  [[60.4,3.2],[55.4,3.6],[55.2,1.9],[51.1,2.2],[51.5,6.7],[40.5,7.4],[40.4,4.8],[30.6,5.5],[29.2,-15.7],[39,-16.3],[38.8,-20],[49.7,-20.7],[50.1,-15],[54.1,-15.2],[54,-17],[59.1,-17.4]],
  [[60.4,3.2],[59.1,-17.4],[64.3,-17.7],[64.4,-15.9],[68.3,-16.1],[68,-21.9],[79.1,-22.6],[79.4,-16.9],[82.9,-17.1],[84,.1],[80.2,.3],[80.5,4.9],[69.7,5.6],[69.4,1],[65.5,1.2],[65.6,2.9]],
  [[62.2,34.6],[57.1,34.9],[57,33.2],[52.9,33.5],[53.2,38],[42.3,38.7],[42.1,36.1],[32.4,36.8],[31,15.6],[40.8,14.9],[40.5,11.3],[51.4,10.6],[51.8,16.3],[55.9,16.1],[55.8,14.3],[60.8,14]],
  [[62.2,34.6],[60.8,14],[66,13.7],[66.1,15.4],[70.1,15.1],[69.7,9.4],[80.8,8.7],[81.2,14.4],[84.6,14.2],[85.7,31.3],[81.9,31.6],[82.2,36.1],[71.5,36.9],[71.2,32.3],[67.2,32.5],[67.3,34.3]],
];

export function buildMeasuredBlocks(w: DayWorld) {
  const wall = w.lib.stucco(0xadae9a), ledge = w.lib.concrete([.82,.81,.72]);
  const dark = w.lib.glass("dark"), edge = w.lib.plain(0x80867a,.53,.4);
  const base = 9.35, top = 54.0;
  for (const [index, footprint] of FOOTPRINTS.entries()) {
    const shape = new Shape();
    footprint.forEach(([x,z], i) => i ? shape.lineTo(x+4,-z) : shape.moveTo(x+4,-z)); shape.closePath();
    // B–E meet the common shopping/service podium; never leave upper blocks floating.
    if (index > 0) {
      const podium = new ExtrudeGeometry(shape, { depth: base, bevelEnabled: false, steps: 1 }); podium.rotateX(-Math.PI / 2);
      source(`chungking/block-${"ABCDE"[index]}-podium`, w.mesh(podium, wall));
    }
    const geo = new ExtrudeGeometry(shape,{ depth:top-base, bevelEnabled:false, steps:1 }); geo.rotateX(-Math.PI/2);
    source(`chungking/block-${"ABCDE"[index]}-osm`,w.mesh(geo,wall,0,base,0));
    const area = footprint.reduce((sum, a, i) => { const b = footprint[(i + 1) % footprint.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0);
    // OSM does not guarantee uniform polygon winding: A is clockwise; B–E are counterclockwise.
    // Windows follow each measured perimeter segment. Omit the main front already authored in relief.
    for(let i=0;i<footprint.length;i++) {
      const a=footprint[i], b=footprint[(i+1)%footprint.length];
      const dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz);
      if(len<3.0 || (index===0 && a[0]<0 && b[0]<0)) continue;
      const group=w.group((a[0]+b[0])/2+4,0,(a[1]+b[1])/2,-Math.atan2(dz,dx));
      // Reverse only counterclockwise rings so local +Z always points outside the solid.
      if (area > 0) group.rotation.y += Math.PI;
      const columns=Math.max(1,Math.floor(len/2.3));
      for(let floor=0;floor<14;floor++) {
        const y=11.9+floor*3.15;
        block(w,ledge,[len,.10,.28],[0,y-1.07,.12],group);
        for(let col=0;col<columns;col++) {
          const x=(col+.5)*len/columns-len/2;
          block(w,dark,[Math.min(1.45,len/columns-.25),1.58,.035],[x,y,.025],group);
          block(w,edge,[.042,1.61,.065],[x,y,.06],group);
          if((col+floor+index)%3===0) block(w,w.lib.plain(0xa0a18d,.85),[.61,.43,.36],[x+.30,y-1.28,.18],group);
        }
      }
      if (index > 0 && len > 4) for (let floor = 0; floor < 3; floor++) for (let col = 0; col < columns; col++) {
        const x = (col + .5) * len / columns - len / 2, y = 1.8 + floor * 3.05;
        block(w, w.lib.plain(0x354239, .83), [Math.min(1.55, len / columns - .22), 1.70, .04], [x, y, .035], group);
        block(w, edge, [.055, 1.78, .11], [x, y, .10], group);
        block(w, edge, [1.40, .055, .11], [x, y + .37, .10], group);
      }
      if(len>10) for(const x of [-len*.34,len*.34]) bar(w,w.lib.plain(0x53574b,.88),[x,4,.23],[x,52,.23],.058,group);
    }
  }
  // Street block podium flanks the real modelled aisle and stores, rather than filling their opening.
  for (const z of [-12.4, 12.4]) block(w, wall, [29.8, 9.15, 9.8], [15.1, 4.58, z]);
  // Common podium roof / court floor around the rear masses. Exact 1990 service fit-out remains conjectural.
  block(w,w.lib.concrete([.53,.56,.47]),[60,.22,58],[61,.12,8]);
}
