import { CatmullRomCurve3, Vector3 } from "three";
import { ROAD_PLAN } from "./data";

/** Leavenworth / Lombard centre; metre frame is east / up / south. */
export const GEO = { lat: 37.8022186, lon: -122.4179869, altitude: 53.051 };
export const LOOP = 120;
export const BLOCK_LENGTH = 146.664;
export const UPHILL = new Vector3(-0.9855193, 0, 0.1695634);
export const NORTH_SIDE = new Vector3(-0.1695634, 0, -0.9855193);
export const ROAD_WIDTH = 5.8;
/** USGS 1 m DEM (2023-03-04), EPQS samples at quarter-block intervals.
 * Heights relative to Leavenworth 53.051 m. Interpolate the sampled axis;
 * individual planter/driveway micro-relief is authored from photographs. */
export const HEIGHT_PROFILE = [0, 6.54694, 15.794224, 25.601025, 32.842571];
export function heightAt(u: number): number {
  if (u < 0) return u * 0.14;
  if (u > BLOCK_LENGTH) return HEIGHT_PROFILE[4] + (u - BLOCK_LENGTH) * 0.11;
  const f = u / BLOCK_LENGTH * 4;
  const i = Math.min(3, Math.floor(f));
  return HEIGHT_PROFILE[i] + (HEIGHT_PROFILE[i + 1] - HEIGHT_PROFILE[i]) * (f - i);
}
/** Cross-street falls are estimated from photographs; fade into the surveyed block. */
export function crossGrade(u: number): number {
  const blend=(d:number)=>{const t=Math.min(1,Math.max(0,(d-9)/21));return 1-t*t*(3-2*t);};
  return -.11*blend(Math.abs(u))-.19*blend(Math.abs(u-BLOCK_LENGTH));
}
export function site(u: number, v = 0, above = 0): Vector3 {
  return new Vector3(UPHILL.x*u+NORTH_SIDE.x*v,heightAt(u)+crossGrade(u)*v+above,UPHILL.z*u+NORTH_SIDE.z*v);
}
export function siteUV(x: number, z: number): [number, number] {
  return [x * UPHILL.x + z * UPHILL.z, x * NORTH_SIDE.x + z * NORTH_SIDE.z];
}
export function groundY(x: number, z: number): number {
  const [u,v]=siteUV(x,z);return heightAt(u)+crossGrade(u)*v;
}
/** OSM way 402111597, 157 surveyed plan vertices, downhill from Hyde. */
export const ROAD = new CatmullRomCurve3(ROAD_PLAN.map(([x,z]) => new Vector3(x, groundY(x,z),z)),false,"centripetal");
ROAD.arcLengthDivisions = 2048;
export const ROAD_LENGTH = ROAD.getLength();
export function roadAt(t: number): Vector3 { return ROAD.getPointAt(Math.min(1,Math.max(0,t))); }
export function roadTangent(t: number): Vector3 { return ROAD.getTangentAt(Math.min(1,Math.max(0,t))); }
export function roadEdge(t: number, side: number, lift=0): Vector3 {
  const p=roadAt(t),d=roadTangent(t);const n=new Vector3(-d.z,0,d.x).normalize();
  const [u,v]=siteUV(p.x,p.z);p.addScaledVector(n,side);p.y+=crossGrade(u)*(siteUV(p.x,p.z)[1]-v)+lift;return p;
}
/** Distance in XZ to the surveyed road, for planting without blocking traffic. */
const roadSamples=ROAD.getPoints(512);
export function roadDistance(x: number,z: number): number {
  let d=Infinity; for(const p of roadSamples)d=Math.min(d,(x-p.x)**2+(z-p.z)**2);return Math.sqrt(d);
}

/** OSM separately surveyed sidewalk/stair centrelines, south then north. */
export const SIDEWALKS: [number,number][][] = [[[7.766, -8.773], [13.188, -10.1], [24.701, -10.095], [27.006, -9.642], [29.138, -8.959], [31.179, -8.529], [33.618, -8.335], [36.395, -8.4], [44.418, -9.019], [53.063, -8.74], [62.496, -7.749], [67.204, -7.673], [70.765, -7.931], [74.578, -8.303], [80.8, -8.52], [88.228, -7.965], [89.265, -7.922], [90.441, -7.855], [92.885, -7.898], [94.972, -7.685], [97.577, -7.418], [108.208, -7.995], [113.172, -7.954], [117.264, -7.826], [120.78, -7.718], [135.546, -8.001]], [[8.137, 7.59], [25.055, 7.971], [34.45, 9.079], [49.832, 8.02], [51.284, 7.931], [54.298, 7.896], [57.089, 8.377], [59.138, 8.966], [62.154, 8.92], [68.988, 8.933], [71.482, 8.707], [74.884, 7.971], [77.728, 8.144], [80.704, 8.848], [82.251, 8.154], [87.024, 9.359], [93.997, 10.175], [135.734, 10.409]]];

export function sidewalkV(u: number, side: number): number {
  const points=SIDEWALKS[side<0?0:1];
  if(u<=points[0][0])return points[0][1];
  for(let i=1;i<points.length;i++)if(u<=points[i][0]){
    const [a,va]=points[i-1],[b,vb]=points[i];return va+(vb-va)*(u-a)/(b-a);
  }
  return points[points.length-1][1];
}
export function sidewalkAt(u: number, side: number, above=0.22): Vector3 {
  return site(u,sidewalkV(u,side),above);
}
/** Outer lane edge tightens beside the surveyed stair; inner turn remains wide. */
export function laneEdge(t: number, side: number, lift=0): Vector3 {
  let width=ROAD_WIDTH/2;
  const p=roadEdge(t,side*width,lift),[u,v]=siteUV(p.x,p.z);
  const bound=sidewalkV(u,v<0?-1:1);
  const available=Math.abs(bound)-0.76;
  if(Math.abs(v)>available) width=Math.max(1.65,width-(Math.abs(v)-available));
  return roadEdge(t,side*width,lift);
}
