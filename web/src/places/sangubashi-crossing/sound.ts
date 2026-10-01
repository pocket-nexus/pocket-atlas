import { Vector3, type PerspectiveCamera } from "three";
import type { AudioEngine } from "../../core/audio";
import { RailwayAudio } from "../shared/railway-audio";
import { PASS, RAIL_YAW } from "./rail";

/** Quiet spring air and distant neighbourhood birds, with no borrowed soundtrack. */
export class SpringAudio {
  private out: GainNode | null = null;
  private sources = new Set<AudioScheduledSourceNode>();
  private cancel: (() => void) | null = null;
  private nextBird = 3;
  private railway: RailwayAudio;
  constructor(private engine: AudioEngine) {
    this.railway = new RailwayAudio(engine, PASS, new Vector3(Math.sin(RAIL_YAW) * 1.82, 0.102, Math.cos(RAIL_YAW) * 1.82), RAIL_YAW);
  }

  start(): void {
    this.railway.start();
    this.cancel = this.engine.whenReady(() => {
      this.cancel = null;
      const ctx = this.engine.ctx, bus = this.engine.bus();
      if (!ctx || !bus || this.out) return;
      const out = (this.out = ctx.createGain());
      out.gain.value = 0; out.connect(bus); this.engine.ramp(out.gain, 0.55, 2);
      for (const [frequency, gain, kind] of [[950, 0.05, 1], [130, 0.06, 2]] as const) {
        const source = ctx.createBufferSource(); source.buffer = this.engine.noiseBuffer(7, kind); source.loop = true;
        const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = frequency;
        const volume = ctx.createGain(); volume.gain.value = gain;
        source.connect(filter).connect(volume).connect(out); source.start(); this.sources.add(source);
      }
    });
  }

  update(dt: number, camera: PerspectiveCamera, time: number): void {
    this.railway.update(camera, time);
    if (!this.out || !this.engine.ctx) return;
    this.nextBird -= dt;
    if (this.nextBird > 0) return;
    this.nextBird = 7 + Math.random() * 9;
    const ctx = this.engine.ctx;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.2;
      osc.type = "sine"; osc.frequency.setValueAtTime(2500 + i * 200, t); osc.frequency.exponentialRampToValueAtTime(4100, t + 0.085); osc.frequency.exponentialRampToValueAtTime(2700, t + 0.15);
      gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.025, t + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(this.out); osc.start(t); osc.stop(t + 0.18);
      this.sources.add(osc); osc.onended = () => { this.sources.delete(osc); osc.disconnect(); gain.disconnect(); };
    }
  }

  stop(): void {
    this.railway.stop();
    this.cancel?.(); this.cancel = null;
    for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } source.disconnect(); }
    this.sources.clear(); this.out?.disconnect(); this.out = null;
  }
}
