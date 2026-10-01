import type { PerspectiveCamera } from "three";
import type { AudioEngine } from "../../core/audio";

/** One cricket: carrier (Hz), chirps per second, pulses per chirp, pulse rate (Hz), level, pan. */
interface Cricket {
  freq: number;
  rate: number;
  pulses: number;
  pulseHz: number;
  level: number;
  pan: number;
}

/**
 * The terrace on a September evening, synthesised: field and tree crickets
 * in the chaparral below the parapets (a chorus of chirps near 2.6–4.6 kHz,
 * about two chirps a second at 21 °C), the basin's low city hum rising from
 * 350 m below, a light wind over the hillside, and now and then the far
 * drone of an airliner on the approach to LAX.
 */
export class GriffithAudio {
  private engine: AudioEngine;
  private out: GainNode | null = null;
  private crickets: { c: Cricket; gain: GainNode; next: number }[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private cancelPending: (() => void) | null = null;
  private nextJet = 8;

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

    // City hum: brown noise low-passed, with a faint mid band of freeway hiss.
    const hum = this.loop(this.engine.noiseBuffer(9, 2));
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 180;
    const hg = ctx.createGain();
    hg.gain.value = 0.12;
    this.lfo(0.03, 0.03, hg.gain);
    hum?.connect(lp).connect(hg).connect(this.out);
    const hiss = this.loop(this.engine.noiseBuffer(7, 1));
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    const sg = ctx.createGain();
    sg.gain.value = 0.025;
    this.lfo(0.05, 0.01, sg.gain);
    hiss?.connect(bp).connect(sg).connect(this.out);

    // Wind over the chaparral: pink noise through a slowly wandering band.
    const wind = this.loop(this.engine.noiseBuffer(11, 1));
    const wf = ctx.createBiquadFilter();
    wf.type = "bandpass";
    wf.frequency.value = 420;
    wf.Q.value = 0.5;
    this.lfo(0.09, 160, wf.frequency);
    const wg = ctx.createGain();
    wg.gain.value = 0.05;
    this.lfo(0.13, 0.03, wg.gain);
    this.lfo(0.031, 0.02, wg.gain);
    wind?.connect(wf).connect(wg).connect(this.out);

    // The cricket chorus: each one a sine carrier gated into pulses.
    const chorus: Cricket[] = [
      { freq: 4450, rate: 2.1, pulses: 3, pulseHz: 32, level: 0.035, pan: -0.6 },
      { freq: 4620, rate: 1.7, pulses: 4, pulseHz: 28, level: 0.025, pan: 0.5 },
      { freq: 4280, rate: 2.4, pulses: 3, pulseHz: 34, level: 0.02, pan: 0.1 },
      { freq: 2750, rate: 2.15, pulses: 1, pulseHz: 14, level: 0.03, pan: -0.2 },
      { freq: 2680, rate: 2.15, pulses: 1, pulseHz: 14, level: 0.022, pan: 0.7 },
      { freq: 4900, rate: 1.3, pulses: 5, pulseHz: 40, level: 0.012, pan: -0.85 },
    ];
    for (const c of chorus) {
      const o = ctx.createOscillator();
      o.frequency.value = c.freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner();
      p.pan.value = c.pan;
      o.connect(g).connect(p).connect(this.out);
      o.start();
      this.sources.push(o);
      this.crickets.push({ c, gain: g, next: ctx.currentTime + Math.random() / c.rate });
    }
  }

  /** A distant airliner: a low, slowly swelling drone over ~25 s. */
  private jet(): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out) return;
    const t0 = ctx.currentTime + 0.05;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noiseBuffer(3, 2);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 12);
    g.gain.linearRampToValueAtTime(0, t0 + 26);
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(-0.5, t0);
    p.pan.linearRampToValueAtTime(0.5, t0 + 26);
    src.connect(lp).connect(g).connect(p).connect(this.out);
    src.start(t0);
    src.stop(t0 + 26.2);
  }

  update(dt: number, _time: number, _camera: PerspectiveCamera): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out) return;
    // Schedule each cricket's chirps a little ahead of the audio clock.
    const ahead = ctx.currentTime + 0.25;
    for (const k of this.crickets) {
      const { c, gain } = k;
      if (k.next < ctx.currentTime) k.next = ctx.currentTime + 0.02;
      while (k.next < ahead) {
        const pulse = 1 / c.pulseHz;
        for (let i = 0; i < c.pulses; i++) {
          const t = k.next + i * pulse;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(c.level, t + pulse * 0.2);
          gain.gain.linearRampToValueAtTime(c.level * 0.7, t + pulse * 0.55);
          gain.gain.linearRampToValueAtTime(0, t + pulse * 0.75);
        }
        k.next += (1 / c.rate) * (0.94 + 0.12 * Math.random());
      }
    }
    this.nextJet -= dt;
    if (this.nextJet <= 0) {
      this.jet();
      this.nextJet = 55 + Math.random() * 45;
    }
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
    this.crickets = [];
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
  }
}
