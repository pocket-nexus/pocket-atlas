import { Color, FogExp2, Group, HemisphereLight, Mesh, PerspectiveCamera, Scene, Vector3, type Texture } from "three";
import type { Stage, StageContext, PlaceDef, Progress } from "../../../core/types";
import { Baker } from "../bake";
import { createPlacePost, postMeta, type PlacePost, type PostLook } from "../post";
import { exportPlace } from "../export";
import type { Shot } from "../camera";
import { buildWinterChunk, createWinterMaterials } from "./scenery";
import { Snowfall } from "./snowfall";
import { createKeiCar, animateKeiCar } from "./vehicle";
import { initialState, restoreState, stepDrive, sampleRoute, routePitch, type DriveState, type DriveInput } from "./simulation";
import type { DriveRoute } from "./types";
import "./drive.css";
import { captureEnvironmentProbe } from "../probe";
import { buildWinterSky } from "./winter-sky";

const CHUNK = 384;
const LOOK: PostLook = {
  tone: "aces", ao: {radius: 1.2, intensity: 1.6, color:[0,0,0]},
  bloom: {threshold:1.4,smoothing:0.6,intensity:0.18,radius:0.6,levels:5},
  grade: {grain:0.012,vignette:0.2,lift:[0.015,0.019,0.025],gain:[1.01,1.0,0.99],saturation:0.85,contrast:1.035},
};
const disposeGeometry=(g:Group)=>g.traverse(o=>{if((o as Mesh).isMesh)(o as Mesh).geometry.dispose();});

/** Reference runtime for compiler-authored, streamed driving works. */
export class DriveStage implements Stage {
  readonly scene=new Scene();
  readonly camera=new PerspectiveCamera(56,1,0.08,1800);
  private world=new Group();
  private car=createKeiCar();
  private baker: Baker;
  private mats: ReturnType<typeof createWinterMaterials>;
  private snow: Snowfall;
  private post: PlacePost;
  private weatherSky: ReturnType<typeof buildWinterSky>;
  private probe: ReturnType<typeof captureEnvironmentProbe> | null=null;
  private chunks=new Map<number,Group>();
  private state: DriveState;
  private keys=new Set<string>();
  private paused=true;
  private cockpit=false;
  private reverse=false;
  private disposed=false;
  private saving=0;
  private saved=false;
  private ui=document.createElement("div");
  private map=document.createElement("canvas");
  private lastPad=false;
  private padEdges = new Set<number>();
  private sound:{engine:OscillatorNode;gain:GainNode;wind:AudioBufferSourceNode;windGain:GainNode}|null=null;
  private cancelSound=()=>{};
  private unload=()=>this.save();
  private blur=()=>{this.keys.clear();this.paused=true;this.save();};
  private keydown=(e:KeyboardEvent)=>{
    if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space","Backspace"].includes(e.code))e.preventDefault();
    this.keys.add(e.code);
    if(e.repeat)return;
    if(e.code==="Escape"){this.paused=!this.paused;this.save();}
    if(e.code==="KeyC")this.cockpit=!this.cockpit;
    if(e.code==="KeyR"&&Math.abs(this.state.speed)<0.5)this.reverse=!this.reverse;
  };
  private keyup=(e:KeyboardEvent)=>this.keys.delete(e.code);
  private constructor(private ctx:StageContext,private place:PlaceDef,readonly route:DriveRoute){
    let save:unknown=null;
    try{save=JSON.parse(localStorage.getItem(this.saveKey())??"null");}catch{}
    const restored=restoreState(route,save);
    this.saved=!!restored;
    this.state=ctx.params.exporting||ctx.params.shot?initialState(route):restored??initialState(route);
    const at=new URLSearchParams(location.search).get("distance");
    if(ctx.params.shot&&at!==null){
      const p=sampleRoute(route,Math.max(0,Math.min(route.points.at(-1)!.s,Number(at)||0)));
      Object.assign(this.state,{x:p.x+p.dz*1.6,y:p.y,z:p.z-p.dx*1.6,yaw:p.yaw,s:p.s});
    }
    this.baker=new Baker(ctx.renderer);
    this.mats=createWinterMaterials(this.baker);
    const sky=new Color("#bac5cf");
    this.scene.background=sky;
    this.scene.fog=new FogExp2(sky,0.0017);
    this.world.add(new HemisphereLight(0xd6dee4,0x92938f,0.95));
    this.weatherSky=buildWinterSky(this.world,this.baker);
    this.world.add(this.car);
    this.scene.add(this.world);
    this.snow=new Snowfall(this.scene);
    this.post=createPlacePost(ctx.renderer,this.scene,this.camera,ctx.quality,LOOK);
    this.ui.className="drive-ui";
    this.ui.innerHTML=`<header class="drive-header"><button data-act="back" aria-label="Return to atlas">↖ ATLAS</button><span>NORTHBOUND <i>北海道雪便り</i></span><button data-act="pause">II &nbsp; PAUSE</button></header>
      <section class="drive-dispatch"><small>WINTER DELIVERY · ROUTE 237</small><h2></h2><p class="drive-next"></p><div class="drive-progress"><i></i></div><p class="drive-distance"></p></section>
      <section class="drive-instruments"><div class="drive-speed"><b>0</b><span>km/h</span></div><div class="drive-gear">D</div><div class="drive-condition"></div></section>
      <div class="drive-prompt"></div><div class="drive-map"></div><footer class="drive-controls">W / ↑ accelerate &nbsp; S / ↓ brake &nbsp; A D steer &nbsp; R reverse &nbsp; C view &nbsp; E deliver / service &nbsp; Backspace recover</footer>
      <section class="drive-menu"><small>POCKET ATLAS PRESENTS</small><h1>NORTH<br>BOUND<span>北海道雪便り</span></h1><p class="drive-menu-copy"></p><div class="drive-menu-actions"><button data-act="resume">START JOURNEY →</button><button data-act="restart">NEW JOURNEY</button><button data-act="back">RETURN TO ATLAS</button></div><p class="drive-route-note">FURANO → NAKAFURANO → KAMIFURANO → BIEI<br>33.4 km of Hokkaido · distance scale 1 : 0.7</p><small class="drive-credit">© OpenStreetMap contributors · GSI elevation</small></section>`;
    this.map.width=224;this.map.height=174;
    this.ui.querySelector(".drive-map")!.append(this.map);
    this.ui.addEventListener("click",e=>{
      const act=(e.target as Element).closest("[data-act]")?.getAttribute("data-act");
      if(act==="back"){this.save();this.ctx.nav.closePlace();}
      if(act==="resume"&&!this.state.completed)this.paused=false;
      if(act==="pause"){this.paused=!this.paused;this.save();}
      if(act==="restart"){this.state=initialState(this.route);this.reverse=false;this.paused=false;this.save();}
    });
  }
  static async create(ctx:StageContext,place:PlaceDef,route:DriveRoute,progress:Progress):Promise<DriveStage>{
    await progress(0.05,"Preparing your winter journey");
    const s=new DriveStage(ctx,place,route);
    const total=Math.ceil(route.points.at(-1)!.s/CHUNK);
    if(ctx.params.exporting){
      for(let i=0;i<total;i++){s.addChunk(i);if(i%4===0)await progress(0.1+0.8*i/total,"Building Route 237");}
    }else s.stream();
    s.moveCamera(0,true);
    // A sky-only probe travels with the whole corridor: no one town reflected
    // into the car for the entire journey. The snow ground is the dome's lower half.
    const probeScene=new Scene();
    probeScene.add(s.weatherSky.sky.sky);
    s.weatherSky.sky.update(0,new Vector3());
    s.probe=captureEnvironmentProbe(ctx.renderer,probeScene,new Vector3(),{near:0.1,far:1800});
    s.world.add(s.weatherSky.sky.sky);
    s.scene.environment=s.probe.filtered.texture;
    s.scene.environmentIntensity=0.85;
    s.weatherSky.sky.update(0,s.camera.position);
    s.expose();
    await progress(1,"Ready in Furano");
    return s;
  }
  private saveKey(){return `pocket-atlas.drive.${this.route.id}.v1`;}
  private save(){if(this.ctx.params.exporting||this.ctx.params.shot)return;try{localStorage.setItem(this.saveKey(),JSON.stringify(this.state));this.saved=true;}catch{this.ui.dataset.saveError="true";}}
  private addChunk(i:number){
    if(this.chunks.has(i))return;
    const g=buildWinterChunk(this.route,i*CHUNK,Math.min((i+1)*CHUNK,this.route.points.at(-1)!.s),this.mats);
    this.world.add(g);this.chunks.set(i,g);
  }
  private stream(){
    const n=Math.ceil(this.route.points.at(-1)!.s/CHUNK), c=Math.floor(this.state.s/CHUNK);
    for(let i=Math.max(0,c-3);i<Math.min(n,c+4);i++)this.addChunk(i);
    for(const [i,g] of this.chunks)if(Math.abs(i-c)>3){this.world.remove(g);disposeGeometry(g);this.chunks.delete(i);}
  }
  private moveCamera(dt:number,immediate=false){
    const s=this.state,dir=new Vector3(-Math.sin(s.yaw),0,-Math.cos(s.yaw));
    this.car.position.set(s.x,s.y+0.05,s.z);this.car.rotation.set(routePitch(this.route,s.s),s.yaw,0,"YXZ");
    animateKeiCar(this.car,s.steer,s.odometer,s.speed);
    // Right-hand-drive eye; exterior wagon remains visible around the windscreen.
    const eye=this.cockpit?new Vector3(0.32,1.4,-0.25).applyQuaternion(this.car.quaternion).add(this.car.position):new Vector3(s.x,s.y+3.0,s.z).addScaledVector(dir,-6.6);
    this.camera.position.lerp(eye,immediate||this.cockpit?1:1-Math.exp(-dt*8));
    const target=this.cockpit?new Vector3(0,0,-30).applyQuaternion(this.car.quaternion).add(eye):new Vector3(s.x,s.y+1.25,s.z).addScaledVector(dir,9);
    this.camera.lookAt(target);this.camera.updateMatrixWorld();
    if(this.ctx.params.view){const v=this.ctx.params.view;this.camera.position.set(v[0],v[1],v[2]);this.camera.lookAt(v[3],v[4],v[5]);this.camera.fov=v[6]??56;this.camera.updateProjectionMatrix();}
  }
  private expose(){
    const w=window as unknown as Record<string,unknown>;
    w.pocketAtlasDrive={route:this.route,get state(){return s.state;},get paused(){return s.paused;},get residentChunks(){return s.chunks.size;}};
    const s=this;
    if(!this.ctx.params.exporting)return;
    w.pocketAtlasExport=async()=>{
      const p=sampleRoute(this.route,0);
      this.car.position.set(0,0,0);this.car.rotation.set(0,0,0);
      const shots:Shot[]=[0,this.route.stops[0].s,this.route.stops[1].s,this.route.stops[2].s,this.route.stops[3].s].map((d,i)=>{
        const a=sampleRoute(this.route,d);const key={pos:[a.x-a.dx*6,a.y+3,a.z-a.dz*6] as [number,number,number],target:[a.x+a.dx*12,a.y+1,a.z+a.dz*12] as [number,number,number],fov:56};
        return {name:["Furano","Nakafurano","Kamifurano","Miyama","Biei"][i],from:key,to:key,duration:10,driveS:d};
      });
      const fog=this.scene.fog as FogExp2;
      return exportPlace({renderer:this.ctx.renderer,world:{root:this.world,updaters:[],fogLights:[]},baker:this.baker,env:this.probe?.cube??null,envPosition:[p.x,p.y+1.5,p.z],shots,walkable:[],intro:shots[0].from,fog:{color:fog.color.toArray(),density:fog.density},environmentIntensity:this.scene.environmentIntensity,record:0.1,fps:10,files:[{name:"sky-clouds.png",texture:this.weatherSky.clouds}],
        meta:c=>({...c,...c.special,kind:"winter-road",name:this.place.name,post:postMeta(this.post,1),driving:{route:this.route,vehicle:this.car.name},bake:{skyOcclusion:{rays:16,reach:1.6,foliage:0.5}}})});
    };
  }
  enter(){
    this.ctx.overlay.hidePlace();
    if(!this.ctx.params.shot)document.body.append(this.ui);
    addEventListener("keydown",this.keydown);addEventListener("keyup",this.keyup);addEventListener("blur",this.blur);addEventListener("pagehide",this.unload);
    this.cancelSound=this.ctx.audio.whenReady(()=>{
      if(this.disposed||this.ctx.params.mute)return;
      const ac=this.ctx.audio.ctx!,bus=this.ctx.audio.bus()!;
      const engine=ac.createOscillator(),gain=ac.createGain(),filter=ac.createBiquadFilter();
      engine.type="triangle";engine.frequency.value=40;gain.gain.value=0;filter.type="lowpass";filter.frequency.value=320;
      engine.connect(filter).connect(gain).connect(bus);engine.start();
      const wind=ac.createBufferSource(),windGain=ac.createGain();wind.buffer=this.ctx.audio.noiseBuffer(3,1);wind.loop=true;windGain.gain.value=0;wind.connect(windGain).connect(bus);wind.start();
      this.sound={engine,gain,wind,windGain};
    });
  }
  leave(){this.save();this.ui.remove();this.keys.clear();removeEventListener("keydown",this.keydown);removeEventListener("keyup",this.keyup);removeEventListener("blur",this.blur);removeEventListener("pagehide",this.unload);}
  resize(w:number,h:number){this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.post.setSize(w,h);}
  frame(dt:number,time:number){
    const k=(...names:string[])=>names.some(n=>this.keys.has(n));
    const pad=navigator.getGamepads?.().find(g=>g?.connected);
    const dead=(v:number)=>Math.abs(v)<0.15?0:v;
    const pressed=(i:number)=>!!pad?.buttons[i]?.pressed&&!this.padEdges.has(i);
    if(pad?.buttons[9]?.pressed&&!this.lastPad){this.paused=!this.paused;this.save();}
    if(pressed(3))this.cockpit=!this.cockpit;
    if(pressed(2)&&Math.abs(this.state.speed)<0.5)this.reverse=!this.reverse;
    if(pressed(0)&&this.paused&&!this.state.completed)this.paused=false;
    this.padEdges=new Set(pad?.buttons.flatMap((b,i)=>b.pressed?[i]:[])??[]);
    this.lastPad=!!pad?.buttons[9]?.pressed;
    const input:DriveInput={throttle:Math.max(k("KeyW","ArrowUp")?1:0,pad?.buttons[7]?.value??0),brake:Math.max(k("KeyS","ArrowDown","Space")?1:0,pad?.buttons[6]?.value??0),steer:dead(pad?.axes[0]??0)||(k("KeyD","ArrowRight")?1:0)-(k("KeyA","ArrowLeft")?1:0),reverse:this.reverse,interact:k("KeyE")||!!pad?.buttons[0]?.pressed,recover:k("Backspace")||!!pad?.buttons[1]?.pressed};
    const stop=this.state.nextStop;
    if(!this.paused&&!this.ctx.params.shot)stepDrive(this.route,this.state,input,dt);
    if(this.state.nextStop!==stop)this.save();
    this.saving+=dt;if(this.saving>10){this.save();this.saving=0;}
    if(!this.ctx.params.exporting)this.stream();
    this.moveCamera(dt);this.weatherSky.sky.update(time,this.camera.position);this.snow.update(time,this.camera,this.car,this.state.speed);this.post.render(dt);
    if(this.sound){const t=this.ctx.audio.ctx!.currentTime,v=Math.abs(this.state.speed);this.sound.engine.frequency.setTargetAtTime(34+v*4.5+input.throttle*15,t,0.1);this.sound.gain.gain.setTargetAtTime(this.paused?0:0.065,t,0.15);this.sound.windGain.gain.setTargetAtTime(this.paused?0:0.055+v*.004,t,0.2);}
    this.updateHud();
  }
  private updateHud(){
    const s=this.state,stop=this.route.stops[s.nextStop],end=this.route.points.at(-1)!;
    const put=(sel:string,t:string)=>{this.ui.querySelector(sel)!.textContent=t;};
    this.ui.classList.toggle("is-paused",this.paused||s.completed);
    this.ui.classList.toggle("is-complete",s.completed);
    put(".drive-dispatch h2",stop?.name??"Biei / 美瑛");
    put(".drive-next",s.completed?"All deliveries complete":`${s.nextStop+1} / ${this.route.stops.length} · ${stop?.kind==="service"?"Fuel & warm-up stop":stop?.kind==="finish"?"Final delivery":"Parcel delivery"}`);
    put(".drive-distance",`${(Math.max(0,(stop?.s??end.s)-s.s)/this.route.distance_scale/1000).toFixed(1)} km to stop · ${(s.s/end.s*100).toFixed(0)}% of route`);
    (this.ui.querySelector(".drive-progress i") as HTMLElement).style.width=`${Math.min(100,s.s/end.s*100)}%`;
    put(".drive-speed b",Math.round(Math.abs(s.speed)*3.6).toString());put(".drive-gear",this.reverse?"R":"D");
    put(".drive-condition",`FUEL ${s.fuel.toFixed(1)} L\nCONDITION ${Math.max(0,100-s.damage).toFixed(0)}%\n−8°C · SNOW`);
    const near=stop&&Math.abs(s.s-stop.s)<stop.radius;
    put(".drive-prompt",this.ui.dataset.saveError?"Storage unavailable · progress cannot be saved":s.completed?"Journey complete — thank you for driving":near?(Math.abs(s.speed)<0.5?"E / ×  ·  Deliver & continue":"Slow down and park for your delivery"):s.damage>75||s.fuel<0.2?"Backspace · Call recovery":stop&&stop.s<s.s-30?"Delivery missed · turn back safely":"KEEP LEFT · Snow tyres fitted");
    put(".drive-menu-copy",s.completed?`Delivered to Biei. ${(s.odometer/1000).toFixed(1)} km driven · ${Math.floor((s.elapsed+s.penaltySeconds)/60)} min · ${s.recoveries} recoveries. Start a new journey whenever you like.`:`A small car, a long road, and snow across the Furano valley. Carry parcels north through four stops. Pull over and press E at each delivery. Your journey saves along the way.`);
    const resume=this.ui.querySelector('[data-act="resume"]') as HTMLButtonElement;resume.hidden=s.completed;resume.textContent=this.saved?"CONTINUE JOURNEY →":"START JOURNEY →";
    const m=this.map.getContext("2d")!;m.clearRect(0,0,224,174);m.save();m.translate(112,116);m.rotate(-s.yaw);const scale=.095;
    m.lineCap="round";m.lineWidth=7;m.strokeStyle="#334852";m.beginPath();
    for(let d=Math.max(0,s.s-700),i=0;d<Math.min(end.s,s.s+1300);d+=20,i++){const p=sampleRoute(this.route,d),x=(p.x-s.x)*scale,z=(p.z-s.z)*scale;if(i===0)m.moveTo(x,z);else m.lineTo(x,z);}m.stroke();
    m.lineWidth=2;m.strokeStyle="#e5c99a";m.stroke();
    if(stop){const p=sampleRoute(this.route,stop.s);m.fillStyle="#f2bd67";m.beginPath();m.arc((p.x-s.x)*scale,(p.z-s.z)*scale,6,0,Math.PI*2);m.fill();}m.restore();
    m.fillStyle="#f2f6f5";m.beginPath();m.moveTo(112,107);m.lineTo(106,122);m.lineTo(118,122);m.closePath();m.fill();m.fillStyle="#a9bec7";m.font="10px sans-serif";m.fillText("R237  /  NORTHBOUND",12,20);
  }
  dispose(){
    this.disposed=true;this.leave();this.cancelSound();this.sound?.engine.stop();this.sound?.wind.stop();this.sound?.gain.disconnect();this.sound?.windGain.disconnect();this.snow.dispose();this.post.dispose();this.probe?.cube.dispose();this.probe?.filtered.dispose();this.baker.dispose();
    this.world.traverse(o=>{const m=o as Mesh;if(m.isMesh)m.geometry.dispose();});
    const materials=new Set<import("three").Material>();this.world.traverse(o=>{const m=o as Mesh;if(m.isMesh)for(const mat of Array.isArray(m.material)?m.material:[m.material])materials.add(mat);});
    materials.forEach(m=>{Object.values(m).forEach(t=>{if(t&&typeof t==="object"&&"isTexture"in t)(t as Texture).dispose();});m.dispose();});
    delete (window as unknown as Record<string,unknown>).pocketAtlasDrive;delete (window as unknown as Record<string,unknown>).pocketAtlasExport;
  }
}
