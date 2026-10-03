import { CatmullRomCurve3, Matrix4, Vector3 } from "three";
import { makeCar, type CarKind } from "../gfx/vehicles";
import type { LombardWorld } from "./context";
import { BLOCK_LENGTH, LOOP, heightAt, roadAt, site } from "./layout";

/** Ingress/egress use the real cross streets; the reset is beyond the houses. */
function crossStreet(u:number,v:number,grade:number):Vector3 {const p=site(u,v);p.y=heightAt(u)-grade*v+.025;return p;}
const ROUTE=new CatmullRomCurve3([
  crossStreet(BLOCK_LENGTH+1,22,.19),crossStreet(BLOCK_LENGTH+1,12,.19),crossStreet(BLOCK_LENGTH+1,5,.19),
  ...Array.from({length:513},(_,i)=>roadAt(i/512).add(new Vector3(0,.025,0))),
  crossStreet(-1,-5,.11),crossStreet(-1,-12,.11),crossStreet(-1,-22,.11),
],false,"centripetal");
ROUTE.arcLengthDivisions=4096;
const LENGTH=ROUTE.getLength(),RUN=118,RESET=LOOP-RUN;
export const TRAFFIC_SPEED=LENGTH/RUN;

export interface TrafficPose { position:Vector3; forward:Vector3; distance:number; steer:number; sink:number; }
/** Pure periodic state, also used to verify the export loop and spacing. */
export function trafficPose(t:number,offset:number,wheelbase=2.55):TrafficPose {
  const age=((t+offset)%LOOP+LOOP)%LOOP,dist=Math.min(age,RUN)*TRAFFIC_SPEED;
  const sample=(d:number)=>ROUTE.getPointAt(Math.max(0,Math.min(1,d/LENGTH)));
  const p=sample(dist),front=sample(dist+wheelbase*.5),back=sample(dist-wheelbase*.5),forward=front.clone().sub(back).normalize();
  const before=ROUTE.getTangentAt(Math.max(0,(dist-.65)/LENGTH)),after=ROUTE.getTangentAt(Math.min(1,(dist+.65)/LENGTH));
  const turn=Math.atan2(before.z*after.x-before.x*after.z,before.x*after.x+before.z*after.z);
  const steer=Math.max(-.58,Math.min(.58,Math.atan(wheelbase*turn/1.3)));
  const sink=age>RUN?1:Math.max(0,1-age/.35,1-(RUN-age)/.35);
  // During RESET, both the departure and return endpoints are well offstage.
  if(age>RUN+RESET*.5)p.copy(sample(0));
  return {position:p,forward,distance:dist,steer,sink};
}

export function buildTraffic(w:LombardWorld):void {
  const root=w.group();root.name="slow-downhill-traffic";root.userData.dynamic=true;
  const fleet:{kind:CarKind;color:number;offset:number}[]=[{kind:"hatch",color:0xe1e1d8,offset:8},{kind:"suv",color:0xaab0ae,offset:43},{kind:"sedan",color:0x633e44,offset:78}];
  for(const item of fleet) {
    const car=makeCar(item.kind,item.color);root.add(car.root);
    const right=new Vector3(),up=new Vector3(),matrix=new Matrix4();
    w.update((_dt,t)=> {
      const pose=trafficPose(t,item.offset,car.wheelbase);
      car.root.position.copy(pose.position);car.root.position.y-=12*pose.sink;
      right.crossVectors(new Vector3(0,1,0),pose.forward).normalize();up.crossVectors(pose.forward,right).normalize();matrix.makeBasis(right,up,pose.forward);car.root.quaternion.setFromRotationMatrix(matrix);
      car.wheels.forEach((wheel,i)=>wheel.rotation.set(-pose.distance/car.wheelRadius,i<2?pose.steer:0,0,"YXZ"));
    });
  }
}
