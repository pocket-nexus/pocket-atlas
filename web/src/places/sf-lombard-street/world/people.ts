import { Vector3 } from "three";
import { stand } from "../../shared/people/motion";
import { Figure, type Build, type Look } from "../../shared/people/rig";
import { thinFigure } from "../../shared/people/thin";
import { Wear } from "../../shared/people/wear";
import type { LombardWorld } from "./context";
import { LOOP, SIDEWALKS, UPHILL, sidewalkAt } from "./layout";

/** A few ordinary neighbours/visitors resting on the stairs, with quiet periodic poses. */
export function buildPeople(w:LombardWorld):void {
  const root=w.group();root.name="ordinary-summer-pedestrians";root.userData.dynamic=true;
  const wear=new Wear(w.lib,false);
  const specs=[
    {u:18,side:-1,height:1.76,fem:0,skin:0xb58e72,hair:0x302b24,top:0x4c646f,bottom:0xb0a489,yaw:.75},
    {u:57,side:1,height:1.65,fem:1,skin:0xd3aa8d,hair:0x3e2c22,top:0x365c73,bottom:0x5c6870,yaw:-1.9},
    {u:129,side:-1,height:1.72,fem:0,skin:0x93694e,hair:0x241e1a,top:0xd2d0ba,bottom:0x3f515b,yaw:1.85},
  ];
  specs.forEach((s,i)=> {
    const build:Build={height:s.height,fem:s.fem,hair:s.fem?"bob":"short",top:{t:.013,hem:s.fem?.64:.73,cuff:.018},legs:{loose:.017},shoe:"sneaker",cast:false};
    const look:Look={skin:{hex:s.skin,rough:.55},hair:{hex:s.hair,rough:.55},top:{hex:s.top,rough:.75},bottom:{hex:s.bottom,rough:.75},shoes:{hex:0xd9d7cb,rough:.55}};
    const f=new Figure(build,look,wear);thinFigure(f,.05);root.add(f.root);
    // Match the authored 0.55 m treads, with the soles on the top of one tread.
    const path=SIDEWALKS[s.side<0?0:1],start=path[0][0],end=path.at(-1)![0],step=(end-start)/Math.ceil((end-start)/.55);
    const u=start+Math.round((s.u-start)/step)*step;
    f.root.position.copy(sidewalkAt(u,s.side));f.root.position.y=sidewalkAt(u+step,s.side).y;
    f.root.rotation.y=Math.atan2(UPHILL.x,UPHILL.z)+s.yaw;
    const scale=f.d.s,feet:[Vector3,Vector3]=[new Vector3(.10,.075*scale,.015),new Vector3(-.10,.075*scale,-.025)];
    w.update((_dt,t)=> {
      const phase=(((t%LOOP)+LOOP)%LOOP)/LOOP*Math.PI*2;
      stand(f,{feet,toe:[.12,-.13],weight:.32*Math.sin(phase*3+i),lean:.015,twist:.05*Math.sin(phase*4+i),breath:phase*36+i,yaw:.20*Math.sin(phase*2+i*.8),pitch:.04*Math.sin(phase*5+i)});
      f.swing(0,.04,-.04,.24,.10);f.swing(1,-.03,-.05,.21,.08);
    });
  });
}
