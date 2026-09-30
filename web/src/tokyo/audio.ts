import type { PerspectiveCamera, Vector3 } from "three";
import type { AudioEngine } from "../core/audio";

/**
 * Procedural soundscape: a two-layer rain bed, a loop of drop ticks on hard
 * surfaces, occasional gutter drips, far traffic rumble, the 50 Hz hum of the
 * shop's LED drivers near the entrance, and the two-note door chime.
 */
export class TokyoAudio {
  private engine: AudioEngine;
  private out: GainNode | null = null;
  private hum: GainNode | null = null;
  private hissGain: GainNode | null = null;
  private hissFilter: BiquadFilterNode | null = null;
  private humPan: StereoPannerNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private dripTimer = 0;
  private lastChime = -10;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  private cancelPending: (() => void) | null = null;

  start(): void {
    this.cancelPending = this.engine.whenReady(() => this.begin());
  }

  private begin(): void {
    this.cancelPending = null;
    const ctx = this.engine.ctx;
    const bus = this.engine.bus();
    if (!ctx || !bus || this.out) return;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus);
    this.engine.ramp(this.out.gain, 1, 2.5);

    // Rain bed: bright hiss plus a low body.
    const hiss = this.loop(this.engine.noiseBuffer(6, 1));
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 8500;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.32;
    hiss?.connect(hp).connect(lp).connect(hissGain).connect(this.out);
    this.hissGain = hissGain;
    this.hissFilter = lp;

    const body = this.loop(this.engine.noiseBuffer(7, 2));
    const blp = ctx.createBiquadFilter();
    blp.type = "lowpass";
    blp.frequency.value = 380;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.28;
    body?.connect(blp).connect(bodyGain).connect(this.out);

    // Drops ticking on awnings, bins and car roofs.
    const ticks = this.loop(this.tickBuffer(5));
    const tbp = ctx.createBiquadFilter();
    tbp.type = "bandpass";
    tbp.frequency.value = 3200;
    tbp.Q.value = 0.7;
    const tickGain = ctx.createGain();
    tickGain.gain.value = 0.5;
    ticks?.connect(tbp).connect(tickGain).connect(this.out);

    // Distant traffic: slow breathing rumble.
    const traffic = this.loop(this.engine.noiseBuffer(9, 2));
    const tlp = ctx.createBiquadFilter();
    tlp.type = "lowpass";
    tlp.frequency.value = 140;
    const trafficGain = ctx.createGain();
    trafficGain.gain.value = 0.18;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.08;
    lfo.connect(lfoGain).connect(trafficGain.gain);
    lfo.start();
    this.sources.push(lfo);
    traffic?.connect(tlp).connect(trafficGain).connect(this.out);

    // Shop hum (Tokyo mains are 50 Hz; drivers buzz at 100 Hz and harmonics).
    this.hum = ctx.createGain();
    this.hum.gain.value = 0;
    this.humPan = ctx.createStereoPanner();
    for (const [f, a] of [
      [100, 0.5],
      [200, 0.22],
      [300, 0.1],
      [1200, 0.015],
    ] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = a * 0.05;
      o.connect(g).connect(this.hum);
      o.start();
      this.sources.push(o);
    }
    this.hum.connect(this.humPan).connect(this.out);
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

  /** Sparse, decaying noise impulses: rain hitting hard things nearby. */
  private tickBuffer(seconds: number): AudioBuffer | null {
    const ctx = this.engine.ctx;
    if (!ctx) return null;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const n = seconds * 55;
      for (let k = 0; k < n; k++) {
        const at = Math.floor(Math.random() * (len - 2000));
        const amp = Math.pow(Math.random(), 3) * 0.9;
        const decay = 80 + Math.random() * 400;
        for (let i = 0; i < 1600; i++) d[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / decay);
      }
    }
    return buf;
  }

  private drip(): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.6 - 0.8;
    const f = 900 + Math.random() * 900;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.05);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.05, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(p).connect(this.out);
    o.start(t);
    o.stop(t + 0.15);
  }

  /** "Pin-pon": the two-note entrance chime. */
  chime(): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out || ctx.currentTime - this.lastChime < 3) return;
    this.lastChime = ctx.currentTime;
    const t = ctx.currentTime + 0.05;
    const notes: [number, number][] = [
      [659.25, 0],
      [523.25, 0.42],
    ];
    for (const [freq, at] of notes) {
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const g = ctx.createGain();
      car.frequency.value = freq;
      mod.frequency.value = freq * 3.5;
      modGain.gain.setValueAtTime(freq * 1.2, t + at);
      modGain.gain.exponentialRampToValueAtTime(1, t + at + 1.2);
      mod.connect(modGain).connect(car.frequency);
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(0.16, t + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 1.8);
      car.connect(g).connect(this.out);
      car.start(t + at);
      mod.start(t + at);
      car.stop(t + at + 2);
      mod.stop(t + at + 2);
    }
  }

  /** Rain loudness follows the visual intensity; gusts brighten the hiss. */
  setIntensity(rain: number, gust: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.hissGain || !this.hissFilter) return;
    this.hissGain.gain.setTargetAtTime(0.26 * rain + 0.06 * gust, ctx.currentTime, 0.5);
    this.hissFilter.frequency.setTargetAtTime(7000 + 3500 * gust, ctx.currentTime, 0.5);
  }

  update(dt: number, camera: PerspectiveCamera, shop: Vector3): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.out) return;
    this.dripTimer -= dt;
    if (this.dripTimer <= 0) {
      this.drip();
      this.dripTimer = 0.6 + Math.random() * 2.2;
    }
    if (this.hum && this.humPan) {
      const d = camera.position.distanceTo(shop);
      this.hum.gain.setTargetAtTime(Math.max(0, 1 - d / 7) * 0.9, ctx.currentTime, 0.2);
      const right = camera.matrixWorld.elements;
      // Pan by the shop's position relative to the camera's right vector.
      const dx = shop.x - camera.position.x;
      const dz = shop.z - camera.position.z;
      const pan = (dx * right[0] + dz * right[2]) / Math.max(1, Math.hypot(dx, dz));
      this.humPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), ctx.currentTime, 0.2);
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
    this.hum = null;
    this.hissGain = null;
    this.hissFilter = null;
    this.humPan = null;
  }
}
