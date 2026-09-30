/**
 * Thin WebAudio wrapper. The AudioContext is created on the first user
 * gesture (browser autoplay policy); stages queue their graphs with
 * `whenReady()`, attach them to `bus()` and fade them with `ramp()`.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted: boolean;
  private listeners = new Set<(muted: boolean) => void>();
  private pending: (() => void)[] = [];

  constructor(muted: boolean) {
    this.muted = muted;
    const unlock = () => {
      if (!this.ctx) this.create();
      void this.ctx?.resume();
    };
    addEventListener("pointerdown", unlock, { passive: true });
    addEventListener("keydown", unlock);
  }

  private create(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor({ latencyHint: "playback" });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(this.ctx.destination);
    const queued = this.pending;
    this.pending = [];
    for (const fn of queued) fn();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Runs `fn` once audio is available (immediately if it already is). */
  whenReady(fn: () => void): () => void {
    if (this.ctx) {
      fn();
      return () => {};
    }
    this.pending.push(fn);
    return () => {
      this.pending = this.pending.filter((f) => f !== fn);
    };
  }

  bus(): AudioNode | null {
    return this.master;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.15);
      if (!muted) void this.ctx.resume();
    }
    for (const fn of this.listeners) fn(muted);
  }

  onMuteChange(fn: (muted: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  ramp(param: AudioParam, value: number, seconds: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  /** A looping buffer of noise, `seconds` long. `color` 0 = white, 1 = pink, 2 = brown. */
  noiseBuffer(seconds: number, color: 0 | 1 | 2): AudioBuffer | null {
    if (!this.ctx) return null;
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const fade = Math.min(4096, len >> 3);
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    const d = new Float32Array(len + fade);
    for (let ch = 0; ch < 2; ch++) {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (let i = 0; i < len + fade; i++) {
        const w = Math.random() * 2 - 1;
        if (color === 0) d[i] = w * 0.5;
        else if (color === 1) {
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        } else {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        }
      }
      // Blend the overrun into the head so the loop point is continuous.
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        d[i] = d[i] * t + d[len + i] * (1 - t);
      }
      buf.copyToChannel(d.subarray(0, len), ch);
    }
    return buf;
  }
}
