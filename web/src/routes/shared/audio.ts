import type { AudioEngine } from "../../core/audio";
import type { PlaceAudio } from "../../places/shared/stage";
import type { CarState } from "./drive/vehicle";

/**
 * A kei car on packed snow, synthesised: the three-cylinder engine (its
 * firing frequency follows the revs a CVT holds: low when cruising, high
 * under load), the tyres on snow (a low rumble that grows with speed and
 * hisses when they slide), the wind over the body, and the muffled thump
 * and scrape of a snowbank. The handheld mixes the same four voices from the
 * same numbers (`vita/src/drive/audio.rs`).
 */
export interface DriveSound {
  /** Engine speed (rev/min). */
  rpm: number;
  /** 0..1: how hard the engine works. */
  load: number;
  /** Road speed (m/s) and the share of grip in use (0..1+). */
  speed: number;
  slip: number;
  /** 0..1: the body against a bank, decaying. */
  scrape: number;
}

/** What the car sounds like for its state; `rpm` eases toward the CVT's target. */
export function driveSound(c: CarState, throttle: number, prev: DriveSound, dt: number): DriveSound {
  const speed = Math.abs(c.vx);
  // A CVT: revs rise with demand first, with speed second.
  const target = 900 + speed * 62 + throttle * (1500 + speed * 28);
  const rpm = prev.rpm + (Math.min(6200, target) - prev.rpm) * (1 - Math.exp(-dt * 3.2));
  const load = prev.load + (throttle - prev.load) * (1 - Math.exp(-dt * 6));
  const scrape = c.scrape < 0.08 ? Math.min(1, 0.35 + c.impact * 0.12 + speed * 0.03) : prev.scrape * Math.exp(-dt * 5);
  return { rpm, load, speed, slip: c.slip, scrape };
}

export const QUIET: DriveSound = { rpm: 900, load: 0, speed: 0, slip: 0, scrape: 0 };

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0x1234567;
  for (let i = 0; i < d.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  return buf;
}

export class RouteAudio implements PlaceAudio {
  private out: GainNode | null = null;
  private saw: OscillatorNode | null = null;
  private sub: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private tyreGain: GainNode | null = null;
  private tyreFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private scrapeGain: GainNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private cancel: (() => void) | null = null;

  constructor(private engine: AudioEngine) {}

  start(): void {
    this.cancel = this.engine.whenReady(() => this.begin());
  }

  private begin(): void {
    const ctx = this.engine.ctx;
    const bus = this.engine.bus();
    if (!ctx || !bus) return;
    const out = (this.out = ctx.createGain());
    out.gain.value = 0;
    out.connect(bus);
    out.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 1.5);

    // Engine: a saw at the firing frequency and a square an octave below, under a low-pass that opens with load.
    const saw = (this.saw = ctx.createOscillator());
    saw.type = "sawtooth";
    const sub = (this.sub = ctx.createOscillator());
    sub.type = "square";
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    const filter = (this.engineFilter = ctx.createBiquadFilter());
    filter.type = "lowpass";
    filter.Q.value = 1.2;
    const eg = (this.engineGain = ctx.createGain());
    eg.gain.value = 0.1;
    saw.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(eg).connect(out);
    saw.start();
    sub.start();
    this.sources.push(saw, sub);

    const noise = noiseBuffer(ctx, 3);
    const voice = (type: BiquadFilterType, freq: number, q: number): [GainNode, BiquadFilterNode] => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(out);
      src.start(ctx.currentTime + Math.random() * 0.2);
      this.sources.push(src);
      return [g, f];
    };
    [this.tyreGain, this.tyreFilter] = voice("lowpass", 220, 0.4);
    [this.windGain] = voice("bandpass", 900, 0.5);
    [this.scrapeGain] = voice("bandpass", 420, 0.9);
  }

  /** Follows the car. */
  update(s: DriveSound): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.saw || !this.sub) return;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.04);
    // Three cylinders, four strokes: 1.5 firings per revolution.
    const f = (s.rpm / 60) * 1.5;
    set(this.saw.frequency, f);
    set(this.sub.frequency, f / 2);
    set(this.engineFilter!.frequency, 260 + s.load * 900 + s.rpm * 0.08);
    set(this.engineGain!.gain, 0.05 + s.load * 0.09 + Math.min(0.04, s.rpm / 100000));
    const v = Math.min(1, s.speed / 28);
    set(this.tyreGain!.gain, 0.02 + v * 0.3 + Math.max(0, s.slip - 0.75) * 0.25 * Math.min(1, s.speed / 4));
    set(this.tyreFilter!.frequency, 160 + v * 380 + Math.max(0, s.slip - 0.75) * 1800);
    set(this.windGain!.gain, v * v * 0.16);
    set(this.scrapeGain!.gain, s.scrape * 0.7);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
    const ctx = this.engine.ctx;
    if (ctx && this.out) {
      const out = this.out;
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
      const sources = this.sources;
      setTimeout(() => {
        for (const s of sources) {
          try {
            s.stop();
          } catch {
            // Already stopped.
          }
        }
        out.disconnect();
      }, 900);
    }
    this.out = null;
    this.saw = null;
    this.sub = null;
    this.sources = [];
  }
}
