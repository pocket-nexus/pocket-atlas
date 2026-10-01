import { Vector3, type PerspectiveCamera } from "three";
import type { AudioEngine } from "../../core/audio";
import { SOBU_TRAIN } from "./world/far";

/** Where the sounds come from: the Sobu Line bridge north of the street, and the Radio Kaikan entrance. */
const BRIDGE = new Vector3(-10, 16, -40);
/** The rumble starts as the train's nose reaches the bridge over the street (it peaks 3.5–6 s later). */
const TRAIN_SOUND_AT = (BRIDGE.x - SOBU_TRAIN.start) / ((SOBU_TRAIN.end - SOBU_TRAIN.start) / SOBU_TRAIN.run);
const ENTRANCE = new Vector3(-11, 2, 0);

/**
 * Procedural Akihabara at dusk with the street closed to traffic: a crowd
 * murmur, footsteps, the city's low hum and Chuo-dori's traffic, a shop
 * jingle near the entrance, and the Sobu Line train crossing the bridge,
 * timed on the place clock with the train in world/far.ts (every 40 s). All
 * synthesised; the train and the jingle pan with the camera.
 */
export class AkibaAudio {
  private engine: AudioEngine;
  private out: GainNode | null = null;
  private jingle: GainNode | null = null;
  private jinglePan: StereoPannerNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private cancelPending: (() => void) | null = null;
  /** Train period of the last rumble, so each crossing sounds once. */
  private trainCycle: number | null = null;
  private nextNote = 0;
  private step = 0;

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

    // Crowd murmur: pink noise through a voice-band filter, slowly swelling.
    const crowd = this.loop(this.engine.noiseBuffer(8, 1));
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 520;
    bp.Q.value = 0.8;
    const cg = ctx.createGain();
    cg.gain.value = 0.16;
    this.lfo(0.07, 0.05, cg.gain);
    this.lfo(2.3, 0.02, cg.gain);
    crowd?.connect(bp).connect(cg).connect(this.out);

    // City hum and Chuo-dori's traffic beyond the closed street.
    const hum = this.loop(this.engine.noiseBuffer(9, 2));
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220;
    const hg = ctx.createGain();
    hg.gain.value = 0.14;
    this.lfo(0.04, 0.05, hg.gain);
    hum?.connect(lp).connect(hg).connect(this.out);

    this.jingle = ctx.createGain();
    this.jingle.gain.value = 0;
    this.jinglePan = ctx.createStereoPanner();
    this.jingle.connect(this.jinglePan).connect(this.out);
  }

  /** A Sobu Line train: rumble and wheel clatter rising and falling over ~9 s. */
  private train(pan: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out) return;
    const t0 = ctx.currentTime + 0.05;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer(2, 2);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.32, t0 + 3.5);
    g.gain.linearRampToValueAtTime(0.28, t0 + 6);
    g.gain.linearRampToValueAtTime(0, t0 + 9.5);
    const clack = ctx.createGain();
    clack.gain.value = 0.6;
    const o = ctx.createOscillator();
    o.frequency.value = 7.5;
    const og = ctx.createGain();
    og.gain.value = 0.4;
    o.connect(og).connect(clack.gain);
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(-pan, t0);
    p.pan.linearRampToValueAtTime(pan, t0 + 9.5);
    src.connect(lp).connect(clack).connect(g).connect(p).connect(this.out);
    src.start(t0);
    o.start(t0);
    src.stop(t0 + 9.6);
    o.stop(t0 + 9.6);
  }

  /** A shop jingle phrase near the entrance: a soft square-wave melody, one note. */
  private note(freq: number, len: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.jingle) return;
    const t0 = ctx.currentTime + 0.02;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
    o.connect(lp).connect(g).connect(this.jingle);
    o.start(t0);
    o.stop(t0 + len + 0.05);
  }

  update(dt: number, time: number, camera: PerspectiveCamera): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out || !this.jingle || !this.jinglePan) return;
    const e = camera.matrixWorld.elements;
    const panTo = (p: Vector3) => {
      const dx = p.x - camera.position.x;
      const dz = p.z - camera.position.z;
      return Math.max(-0.9, Math.min(0.9, (dx * e[0] + dz * e[2]) / Math.max(1, Math.hypot(dx, dz))));
    };
    const cycle = Math.floor((time - TRAIN_SOUND_AT) / SOBU_TRAIN.period);
    if (this.trainCycle !== null && cycle !== this.trainCycle) this.train(panTo(BRIDGE) * 0.5 + 0.4);
    this.trainCycle = cycle;
    this.nextNote -= dt;
    if (this.nextNote <= 0) {
      const tune = [659, 784, 880, 784, 659, 587, 659, 0, 523, 587, 659, 784, 659, 0, 0, 0];
      const f = tune[this.step++ % tune.length];
      if (f > 0) this.note(f, 0.32);
      this.nextNote = 0.24;
    }
    const d = camera.position.distanceTo(ENTRANCE);
    this.jingle.gain.setTargetAtTime(Math.min(1, 6 / (4 + d)), ctx.currentTime, 0.3);
    this.jinglePan.pan.setTargetAtTime(panTo(ENTRANCE), ctx.currentTime, 0.2);
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
    this.jingle = null;
    this.jinglePan = null;
    this.trainCycle = null;
  }
}
