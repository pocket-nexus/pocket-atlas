import { Vector3, type PerspectiveCamera } from "three";
import type { AudioEngine } from "../../core/audio";
import { BELL_AT as BELL, type CrossingState } from "./world/crossing";
import { TRACK } from "./world/layout";
import { TRAIN_LENGTH, trainFront } from "./world/timeline";

/** The shore break, broadly south of the crossing. */
const SURF = new Vector3(0, -9, 64);

/**
 * Procedural seaside afternoon: surf breaking on Shichirigahama in sets,
 * the onshore breeze, the hum of Route 134, cicadas on the hill behind, the
 * crossing's two-tone electronic bell while it rings, and the Enoden's motor
 * and wheels as it passes. All synthesised; sources pan with the camera.
 */
export class KamakuraAudio {
  private engine: AudioEngine;
  private out: GainNode | null = null;
  private surfGain: GainNode | null = null;
  private bell: GainNode | null = null;
  private bellPan: StereoPannerNode | null = null;
  private train: GainNode | null = null;
  private trainPan: StereoPannerNode | null = null;
  private trainTone: BiquadFilterNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private cancelPending: (() => void) | null = null;
  private dingAt = 0;
  private dingHigh = false;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  start(): void {
    this.cancelPending = this.engine.whenReady(() => this.begin());
  }

  private loop(buf: AudioBuffer | null): AudioBufferSourceNode | null {
    const ctx = this.engine.ctx;
    if (!ctx || !buf) return null;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(ctx.currentTime + Math.random() * 0.1);
    this.sources.push(s);
    return s;
  }

  private lfo(freq: number, depth: number, param: AudioParam): void {
    const ctx = this.engine.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(param);
    o.start();
    this.sources.push(o);
  }

  private begin(): void {
    this.cancelPending = null;
    const ctx = this.engine.ctx;
    const bus = this.engine.bus();
    if (!ctx || !bus || this.out) return;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus);
    this.engine.ramp(this.out.gain, 1, 3);

    // Surf: low-passed noise swelling with each set (~9 s), plus a hiss as it breaks.
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0.5;
    this.surfGain.connect(this.out);
    const roar = this.loop(this.engine.noiseBuffer(6, 2));
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    const rg = ctx.createGain();
    rg.gain.value = 0.22;
    this.lfo(1 / 9, 0.16, rg.gain);
    roar?.connect(lp).connect(rg).connect(this.surfGain);
    const hiss = this.loop(this.engine.noiseBuffer(5, 1));
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2200;
    const hg = ctx.createGain();
    hg.gain.value = 0.04;
    this.lfo(1 / 9, 0.035, hg.gain);
    hiss?.connect(hp).connect(hg).connect(this.surfGain);

    // Route 134 and the breeze.
    const road = this.loop(this.engine.noiseBuffer(8, 2));
    const rl = ctx.createBiquadFilter();
    rl.type = "bandpass";
    rl.frequency.value = 260;
    rl.Q.value = 0.6;
    const rgn = ctx.createGain();
    rgn.gain.value = 0.07;
    this.lfo(0.07, 0.04, rgn.gain);
    road?.connect(rl).connect(rgn).connect(this.out);

    // Cicadas on the hillside, far off.
    const cic = this.loop(this.engine.noiseBuffer(5, 0));
    const cb = ctx.createBiquadFilter();
    cb.type = "bandpass";
    cb.frequency.value = 4600;
    cb.Q.value = 1.2;
    const cg = ctx.createGain();
    cg.gain.value = 0.025;
    this.lfo(0.05, 0.012, cg.gain);
    cic?.connect(cb).connect(cg).connect(this.out);

    // Bell bus and train bus (gains driven per frame).
    this.bell = ctx.createGain();
    this.bell.gain.value = 0;
    this.bellPan = ctx.createStereoPanner();
    this.bell.connect(this.bellPan).connect(this.out);
    this.train = ctx.createGain();
    this.train.gain.value = 0;
    this.trainPan = ctx.createStereoPanner();
    this.trainTone = ctx.createBiquadFilter();
    this.trainTone.type = "lowpass";
    this.trainTone.frequency.value = 700;
    const motor = this.loop(this.engine.noiseBuffer(4, 2));
    motor?.connect(this.trainTone).connect(this.train);
    const hum = ctx.createOscillator();
    hum.type = "sawtooth";
    hum.frequency.value = 118;
    const humG = ctx.createGain();
    humG.gain.value = 0.05;
    hum.connect(humG).connect(this.train);
    hum.start();
    this.sources.push(hum);
    this.train.connect(this.trainPan).connect(this.out);
  }

  /** One strike of the electronic bell: a short two-partial tone. */
  private ding(high: boolean): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.bell) return;
    const t0 = ctx.currentTime + 0.01;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.32, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
    for (const [f, a] of [
      [high ? 1460 : 1300, 1],
      [high ? 3650 : 3250, 0.35],
    ]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t0);
      o.stop(t0 + 0.55);
    }
    g.connect(this.bell);
  }

  private pan(p: Vector3, camera: PerspectiveCamera): number {
    const e = camera.matrixWorld.elements;
    const dx = p.x - camera.position.x;
    const dz = p.z - camera.position.z;
    return Math.max(-0.9, Math.min(0.9, (dx * e[0] + dz * e[2]) / Math.max(1, Math.hypot(dx, dz))));
  }

  update(dt: number, time: number, camera: PerspectiveCamera, crossing: CrossingState): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out || !this.bell || !this.bellPan || !this.train || !this.trainPan || !this.trainTone || !this.surfGain) return;
    const now = ctx.currentTime;
    // Bell: about 1.5 strikes a second, alternating pitch, while the crossing rings.
    if (crossing.alarm) {
      this.dingAt -= dt;
      if (this.dingAt <= 0) {
        this.ding(this.dingHigh);
        this.dingHigh = !this.dingHigh;
        this.dingAt += 0.34;
      }
    } else this.dingAt = 0;
    const db = camera.position.distanceTo(BELL);
    this.bell.gain.setTargetAtTime(Math.min(1, 14 / (8 + db)), now, 0.2);
    this.bellPan.pan.setTargetAtTime(this.pan(BELL, camera), now, 0.2);
    // Surf louder near the wall.
    const ds = camera.position.distanceTo(SURF);
    this.surfGain.gain.setTargetAtTime(Math.min(1, 40 / (20 + ds)), now, 0.5);
    // Train: loudness by distance to the nearest body, tone by speed.
    const f = trainFront(time);
    if (f.y < -1) {
      this.train.gain.setTargetAtTime(0, now, 0.3);
      return;
    }
    const mid = TRACK.point(f.u + TRAIN_LENGTH / 2, new Vector3());
    const dtn = camera.position.distanceTo(mid);
    const ahead = trainFront(time + 0.5).u;
    const speed = Math.abs(ahead - f.u) * 2;
    this.train.gain.setTargetAtTime(Math.min(0.9, (speed / 12) * (60 / (25 + dtn))), now, 0.25);
    this.trainTone.frequency.setTargetAtTime(300 + speed * 70, now, 0.3);
    this.trainPan.pan.setTargetAtTime(this.pan(mid, camera), now, 0.2);
  }

  stop(): void {
    this.cancelPending?.();
    this.cancelPending = null;
    const ctx = this.engine.ctx;
    if (!ctx || !this.out) return;
    const out = this.out;
    this.engine.ramp(out.gain, 0, 0.8);
    const sources = this.sources;
    this.sources = [];
    setTimeout(() => {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
      out.disconnect();
    }, 900);
    this.out = null;
    this.bell = null;
    this.train = null;
  }
}
