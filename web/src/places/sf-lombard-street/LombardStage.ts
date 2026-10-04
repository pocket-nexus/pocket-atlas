import { Color, DirectionalLight, FogExp2, HemisphereLight, Object3D, PCFShadowMap, PerspectiveCamera, Vector3 } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { Atlas } from "../shared/atlas";
import { Baker } from "../shared/bake";
import type { Box6, Shot, ShotKey } from "../shared/camera";
import { DayLib } from "../shared/daylight/materials";
import { batchStatic, bearing } from "../shared/geo";
import { createPlacePost, type PostLook } from "../shared/post";
import { buildSky, type Sky } from "../shared/sky";
import { PlaceStage } from "../shared/stage";
import { LombardAudio } from "./audio";
import { buildBuildings } from "./world/buildings";
import { LombardWorld } from "./world/context";
import { buildGround } from "./world/ground";
import { GEO, LOOP, sidewalkAt, site } from "./world/layout";
import { buildPeople } from "./world/people";
import { buildPlants } from "./world/plants";
import { buildProps } from "./world/props";
import { buildTraffic } from "./world/traffic";

const vec=(p:Vector3):[number,number,number]=>[p.x,p.y,p.z];
const key=(u:number,v:number,eye:number,tu:number,tv:number,lift:number,fov:number):ShotKey=>({pos:vec(site(u,v,eye)),target:vec(site(tu,tv,lift)),fov});
export const SHOTS:Shot[]=[
  {name:'Postcard',from:key(-24,1.2,1.8,75,0,3.5,29),to:key(-22,.5,1.8,77,0,3.7,29),duration:20},
  {name:'Switchbacks',from:key(34,8.9,1.75,68,-3,1.2,48),to:key(36,8.9,1.75,70,-3,1.2,48),duration:20},
  {name:'Hydrangeas',from:key(52,-10.1,1.7,67,2,1.4,47),to:key(54,-10.1,1.7,69,2,1.4,47),duration:20},
  {name:'Glass House',from:key(50,-6.0,1.7,59,14,6.2,43),to:key(52,-5.7,1.7,60,14,6.2,43),duration:20},
  {name:'Downhill',from:key(138,4.0,1.8,-150,0,48,48),to:key(136,4.0,1.8,-155,0,47,48),duration:20},
  {name:'Hyde',from:key(144,-7.0,1.7,56,0,1.4,49),to:key(142,-6.8,1.7,52,0,1.5,49),duration:20},
];
const WALKABLE:Box6[]=[];
for(const side of [-1,1])for(let u=8;u<138;u+=3){const p=sidewalkAt(u,side);WALKABLE.push([p.x-2,p.y+.3,p.z-2,p.x+2,p.y+6,p.z+2]);}
// Named viewpoints are valid free-camera volumes too: otherwise selecting a
// postcard outside a stair corridor silently moves it onto the nearest tread.
for(const shot of SHOTS)for(const k of [shot.from,shot.to]){
  const [x,y,z]=k.pos;WALKABLE.push([x-1.8,y-.15,z-1.8,x+1.8,y+2,z+1.8]);
}
const LOOK:PostLook={tone:'aces',ao:{radius:.75,intensity:1.5,color:[.08,.09,.11]},bloom:{threshold:2,smoothing:.5,intensity:.12,radius:.6,levels:5},grade:{grain:.006,vignette:.15,lift:[.025,.035,.05],gain:[1.02,1.0,.98],saturation:1.02,contrast:1.025}};
/** NOAA approximation: 2022-07-20 11:00 PDT; clockwise from true north. */
const SUN={azimuth:110.37,elevation:56.13};
const HORIZON=new Color(.56,.67,.76);

export class LombardStage extends PlaceStage<LombardWorld,LombardAudio>{
  private sky!:Sky;
  private readonly sunDir=bearing(SUN.azimuth,SUN.elevation,0);
  private constructor(ctx:StageContext,place:PlaceDef){super(ctx,place,new PerspectiveCamera(43,1,.1,18000),{shots:SHOTS,walkable:WALKABLE,focus:[-170,-30,-100,230,80,100],intro:key(-12,-55,65,72,0,0,45),introSeconds:7},new LombardAudio(ctx.audio));}
  static async create(ctx:StageContext,place:PlaceDef,progress:Progress):Promise<LombardStage>{const s=new LombardStage(ctx,place);await s.build(progress);return s;}
  private async build(progress:Progress):Promise<void>{
    const {renderer,quality}=this.ctx;renderer.shadowMap.enabled=quality.shadows;renderer.shadowMap.type=PCFShadowMap;renderer.shadowMap.autoUpdate=false;
    this.scene.fog=new FogExp2(HORIZON.clone(),.00055);this.scene.background=HORIZON.clone();
    await progress(.04,'Firing the red bricks');this.baker=new Baker(renderer);const lib=new DayLib(this.baker,quality,{relief:.10});lib.bakeAll();lib.brickPaving();
    this.world=new LombardWorld(lib,new Atlas(1024,{pad:2}),quality,20220720);
    await progress(.18,'Tracing the eight switchbacks');buildGround(this.world);
    await progress(.34,'Building Russian Hill');buildBuildings(this.world);
    await progress(.5,'Setting street signs');buildProps(this.world);
    await progress(.62,'Growing the hydrangeas');buildPlants(this.world);
    await progress(.72,'Taking the slow way down');buildTraffic(this.world);buildPeople(this.world);
    this.sky=buildSky(this.world.root,{zenith:new Color(.015,.085,.28),horizon:HORIZON,ground:new Color(.25,.24,.20),gradientPower:.20,groundBlend:5,sun:this.sunDir,sunColor:new Color(1,.97,.89),glow:{intensity:.075,wide:[.35,6],tight:[1,48]},disc:{intensity:25}});
    this.addLights();
    await progress(.80,'Preparing the handheld geometry');const stats=batchStatic(this.world.root);console.info(`[lombard] batched ${stats.before} meshes into ${stats.after}`);this.scene.add(this.world.root);
    await progress(.88,'Capturing the summer light');this.captureProbe(site(70,0,8),{near:.2,far:15000,intensity:.60,before:()=>this.sky.setProbe(.65),after:()=>this.sky.setProbe(0)});
    this.post=createPlacePost(renderer,this.scene,this.camera,quality,LOOK);this.startRig();
    if(this.ctx.params.exporting)this.exposeExport({seconds:LOOP,meta:c=>({version:c.version,units:c.units,up:c.up,kind:this.place.kind,geo:{...GEO,bearing:0},loopSeconds:LOOP,sun:{...SUN,direction:this.sunDir.toArray()},fog:c.fog,hemisphere:c.hemisphere,directionalLights:c.directionalLights,environment:c.environment,camera:c.camera,...c.special,tracks:c.tracks,post:this.postMeta(),bake:{skyOcclusion:{rays:32,reach:1.8,foliage:.45}}})});
    await progress(1,'A clear morning on Russian Hill');
  }
  private addLights():void{
    const sun=this.sun=new DirectionalLight(0xfff5e6,5.2),c=site(73,0,12);sun.name='sun';sun.position.copy(c).addScaledVector(this.sunDir,220);sun.lookAt(c);
    const target=new Object3D();target.position.set(0,0,-1);sun.add(target);sun.target=target;sun.castShadow=this.ctx.quality.shadows;
    const size=this.ctx.quality.level==='ultra'?4096:2048;sun.shadow.mapSize.set(size,size);sun.shadow.bias=-.00015;sun.shadow.normalBias=.035;sun.shadow.radius=1.4;
    this.fitSunShadow(sun,[-170,25],[-5,65],[-55,65]);this.world.root.add(sun,new HemisphereLight(0xc5d0da,0x8f897b,.65));
  }
  protected advance(dt:number,time:number):void{const t=((time%LOOP)+LOOP)%LOOP;for(const f of this.world.updaters)f(dt,t);this.sky.update(t,this.camera.position);}
}
