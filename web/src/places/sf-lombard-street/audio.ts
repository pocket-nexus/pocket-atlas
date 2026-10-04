import type { AudioEngine } from "../../core/audio";
/** Soft wind through planting and distant urban traffic, generated locally. */
export class LombardAudio {
  private cancel:(()=>void)|null=null;
  private out:GainNode|null=null;
  private sources:AudioScheduledSourceNode[]=[];
  constructor(private readonly engine:AudioEngine){}
  start():void{this.cancel=this.engine.whenReady(()=>{
    const c=this.engine.ctx,bus=this.engine.bus();if(!c||!bus||this.out)return;
    this.out=c.createGain();this.out.gain.value=0;this.out.connect(bus);
    for(const [color,freq,gain] of [[1,1100,.055],[2,210,.08]] as const){
      const b=this.engine.noiseBuffer(12,color);if(!b)continue;
      const s=c.createBufferSource();s.buffer=b;s.loop=true;
      const f=c.createBiquadFilter();f.type='lowpass';f.frequency.value=freq;
      const g=c.createGain();g.gain.value=gain;s.connect(f).connect(g).connect(this.out);s.start();this.sources.push(s);
    }
    this.engine.ramp(this.out.gain,1,1.5);
  });}
  stop():void{this.cancel?.();this.cancel=null;for(const s of this.sources){s.stop();s.disconnect();}this.sources=[];this.out?.disconnect();this.out=null;}
}
