import { describe, expect, test } from 'bun:test';
import { BLOCK_LENGTH, GEO, HEIGHT_PROFILE, ROAD, ROAD_LENGTH, roadAt, roadTangent, SIDEWALKS, sidewalkAt, site, siteUV } from './layout';

describe('Lombard survey and street geometry',()=>{
 test('keeps metre east/north frame and measured elevation profile',()=>{
  expect(GEO.altitude).toBeCloseTo(53.051,3);
  for(const [u,v] of [[0,0],[73.3,8.2],[BLOCK_LENGTH,-10]]) {
   const p=site(u,v);const recovered=siteUV(p.x,p.z);expect(recovered[0]).toBeCloseTo(u,4);expect(recovered[1]).toBeCloseTo(v,4);
  }
  expect(site(BLOCK_LENGTH).y).toBeCloseTo(32.842571,5);
  HEIGHT_PROFILE.slice(1).forEach((h,i)=>expect(h).toBeGreaterThan(HEIGHT_PROFILE[i]));
 });
 test('contains eight principal switchback extrema and flows downhill',()=>{
  const samples=ROAD.getSpacedPoints(1000).map(p=>({p,uv:siteUV(p.x,p.z)}));
  const turns:number[]=[];
  for(let i=1;i<samples.length-1;i++){
   const [u,v]=samples[i].uv;
   if(u>15&&u<133&&Math.abs(v)>5.4&&(v-samples[i-1].uv[1])*(samples[i+1].uv[1]-v)<0)turns.push(v);
   expect(samples[i].p.y).toBeLessThanOrEqual(samples[i-1].p.y+.025);
  }
  expect(turns).toHaveLength(8);turns.slice(1).forEach((v,i)=>expect(v*turns[i]).toBeLessThan(0));
  expect(ROAD_LENGTH).toBeGreaterThan(197);expect(ROAD_LENGTH).toBeLessThan(205);
  expect(roadAt(0).distanceTo(site(BLOCK_LENGTH))).toBeLessThan(.002);
  expect(roadAt(1).length()).toBeLessThan(.002);
 });
 test('surveyed footways are finite and separated from each other',()=>{
  for(let u=8;u<136;u+=.5){const a=sidewalkAt(u,-1),b=sidewalkAt(u,1);expect(a.distanceTo(b)).toBeGreaterThan(14);expect(a.toArray().every(Number.isFinite)).toBe(true);expect(roadTangent(u/146).length()).toBeCloseTo(1,6);}
  expect(SIDEWALKS[0].length).toBeGreaterThan(20);expect(SIDEWALKS[1].length).toBeGreaterThan(15);
 });
});
