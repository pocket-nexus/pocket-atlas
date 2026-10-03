import { Vector3, type PerspectiveCamera } from "three";
import type { AudioEngine } from "../../core/audio";
import { railState, type RailPass } from "./railway-motion";

/** Synthesised wheel rumble and crossing bell, driven by the same seekable clock as the train. */
export class RailwayAudio {
  private cancel: (() => void) | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private nodes: AudioNode[] = [];
  private rail: GainNode | null = null;
  private bell: GainNode | null = null;
  private pan: StereoPannerNode | null = null;
  private bellPan: StereoPannerNode | null = null;
  private right = new Vector3();
  private offset = new Vector3();

  constructor(private engine: AudioEngine, private pass: RailPass, private origin: Vector3, private yaw: number) {}

  start(): void {
    this.cancel = this.engine.whenReady(() => {
      this.cancel = null;
      const ctx = this.engine.ctx, bus = this.engine.bus();
      if (!ctx || !bus || this.rail) return;
      this.rail = ctx.createGain(); this.rail.gain.value = 0;
      this.bell = ctx.createGain(); this.bell.gain.value = 0;
      this.pan = ctx.createStereoPanner(); this.bellPan = ctx.createStereoPanner();
      this.rail.connect(this.pan).connect(bus); this.bell.connect(this.bellPan).connect(bus);
      this.nodes.push(this.rail, this.bell, this.pan, this.bellPan);
      const noise = ctx.createBufferSource(); noise.buffer = this.engine.noiseBuffer(5, 1); noise.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 860;
      noise.connect(filter).connect(this.rail); noise.start(); this.sources.push(noise); this.nodes.push(filter);
      for (const [hz, gain, busNode] of [[126, 0.08, this.rail], [251, 0.023, this.rail], [1046, 0.055, this.bell], [1568, 0.014, this.bell]] as const) {
        const osc = ctx.createOscillator(), amp = ctx.createGain(); osc.frequency.value = hz; amp.gain.value = gain;
        osc.connect(amp).connect(busNode); osc.start(); this.sources.push(osc); this.nodes.push(amp);
      }
    });
  }

  update(camera: PerspectiveCamera, time: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.rail || !this.bell || !this.pan || !this.bellPan) return;
    const s = railState(this.pass, time), cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    this.offset.copy(camera.position).sub(this.origin);
    const localX = this.offset.x * cos - this.offset.z * sin;
    const closest = Math.max(s.tail, Math.min(s.front, localX));
    this.offset.set(this.origin.x + closest * cos, this.origin.y + 0.7, this.origin.z - closest * sin).sub(camera.position);
    const distance = this.offset.length();
    this.right.setFromMatrixColumn(camera.matrixWorld, 0);
    const pan = this.offset.clone().normalize().dot(this.right);
    const clatter = 0.88 + 0.12 * Math.pow(Math.max(0, Math.cos(s.front / 10 * Math.PI)), 8);
    const gain = s.visible ? 0.28 * clatter / Math.pow(1 + distance / 13, 1.6) : 0;
    this.rail.gain.setTargetAtTime(gain, ctx.currentTime, 0.08);
    this.pan.pan.setTargetAtTime(pan * 0.85, ctx.currentTime, 0.1);
    this.offset.copy(this.origin).sub(camera.position);
    const bellDistance = this.offset.length();
    const pulse = Math.exp(-((s.phase * 2.2) % 1) * 5);
    this.bell.gain.setTargetAtTime(s.warning ? pulse / (1 + bellDistance / 22) : 0, ctx.currentTime, 0.018);
    this.bellPan.pan.setTargetAtTime(this.offset.normalize().dot(this.right) * 0.8, ctx.currentTime, 0.1);
  }

  stop(): void {
    this.cancel?.(); this.cancel = null;
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } s.disconnect(); }
    for (const n of this.nodes) n.disconnect();
    this.sources = []; this.nodes = []; this.rail = this.bell = null; this.pan = this.bellPan = null;
  }
}
