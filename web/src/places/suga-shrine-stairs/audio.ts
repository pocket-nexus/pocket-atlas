import { Vector3, type PerspectiveCamera } from "three";
import type { AudioEngine } from "../../core/audio";

/** Where the cicadas sing from: the cherry over the upper left of the flight. */
const TREE = new Vector3(-4.2, 4, -3.2);

/**
 * Procedural summer afternoon: the sizzling chorus of abura-zemi in the
 * cherry, bouts of min-min-zemi, leaves stirring in a light breeze and the
 * low hum of the city. All synthesised; the chorus pans with the camera.
 */
export class SugaAudio {
  private engine: AudioEngine;
  private out: GainNode | null = null;
  private tree: GainNode | null = null;
  private treePan: StereoPannerNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private cancelPending: (() => void) | null = null;
  private nextBout = 2;

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

    this.tree = ctx.createGain();
    this.tree.gain.value = 1;
    this.treePan = ctx.createStereoPanner();
    this.tree.connect(this.treePan).connect(this.out);

    // Abura-zemi: band-limited noise chopped by a fast, uneven buzz, swelling in bouts.
    const sizzle = this.loop(this.engine.noiseBuffer(5, 0));
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 4800;
    bp.Q.value = 1.1;
    const buzz = ctx.createGain();
    buzz.gain.value = 0.5;
    this.lfo(97, 0.35, buzz.gain);
    this.lfo(151, 0.15, buzz.gain);
    const swell = ctx.createGain();
    swell.gain.value = 0.11;
    this.lfo(0.045, 0.05, swell.gain);
    sizzle?.connect(bp).connect(buzz).connect(swell).connect(this.tree);

    // Leaves: pink noise, high-passed, breathing with a slow gust cycle.
    const leaves = this.loop(this.engine.noiseBuffer(7, 1));
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1400;
    const lg = ctx.createGain();
    lg.gain.value = 0.035;
    this.lfo(0.11, 0.03, lg.gain);
    leaves?.connect(hp).connect(lg).connect(this.tree);

    // City hum from the valley.
    const city = this.loop(this.engine.noiseBuffer(9, 2));
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 180;
    const cg = ctx.createGain();
    cg.gain.value = 0.12;
    this.lfo(0.05, 0.04, cg.gain);
    city?.connect(lp).connect(cg).connect(this.out);
  }

  /** One min-min-zemi bout: a rising "miiin", a run of "min" pulses, a falling tail. */
  private minmin(): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.tree) return;
    const t0 = ctx.currentTime + 0.05;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer(1, 0);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 9;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pulses = 7 + Math.floor(Math.random() * 6);
    const len = 0.42;
    bp.frequency.setValueAtTime(3200, t0);
    bp.frequency.linearRampToValueAtTime(4600, t0 + 1.2);
    g.gain.linearRampToValueAtTime(0.5, t0 + 1.2);
    let t = t0 + 1.3;
    for (let i = 0; i < pulses; i++) {
      g.gain.setValueAtTime(0.55, t);
      g.gain.linearRampToValueAtTime(0.12, t + len * 0.75);
      bp.frequency.setValueAtTime(4700, t);
      bp.frequency.linearRampToValueAtTime(4100, t + len * 0.75);
      t += len;
    }
    g.gain.linearRampToValueAtTime(0.4, t + 0.2);
    bp.frequency.linearRampToValueAtTime(3000, t + 1.4);
    g.gain.linearRampToValueAtTime(0, t + 1.5);
    src.connect(bp).connect(g).connect(this.tree);
    src.start(t0);
    src.stop(t + 1.6);
  }

  update(dt: number, camera: PerspectiveCamera): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out || !this.tree || !this.treePan) return;
    this.nextBout -= dt;
    if (this.nextBout <= 0) {
      this.minmin();
      this.nextBout = 9 + Math.random() * 14;
    }
    const d = camera.position.distanceTo(TREE);
    this.tree.gain.setTargetAtTime(Math.min(1.2, 9 / (6 + d)), ctx.currentTime, 0.3);
    const e = camera.matrixWorld.elements;
    const dx = TREE.x - camera.position.x;
    const dz = TREE.z - camera.position.z;
    const pan = (dx * e[0] + dz * e[2]) / Math.max(1, Math.hypot(dx, dz));
    this.treePan.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, pan)), ctx.currentTime, 0.2);
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
    this.tree = null;
    this.treePan = null;
  }
}
