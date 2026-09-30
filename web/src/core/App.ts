import { NoToneMapping, SRGBColorSpace, Timer, WebGLRenderer } from "three";
import { cityById } from "../cities/registry";
import { AudioEngine } from "./audio";
import { cityFromHash, type Params } from "./params";
import { detectQuality, makeQuality, type Quality, type QualityLevel } from "./quality";
import type { CityDef, Navigator, Progress, Stage, StageContext } from "./types";
import { Overlay } from "../ui/overlay";

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Owns the WebGL renderer, the frame loop, and the one active Stage. The globe
 * is built once and parked while a city is open so "back" is instant; cities
 * are built on entry and disposed on exit.
 */
export class App implements Navigator {
  readonly renderer: WebGLRenderer;
  readonly overlay: Overlay;
  readonly audio: AudioEngine;
  readonly params: Params;
  quality: Quality;

  private canvas: HTMLCanvasElement;
  private stage: Stage | null = null;
  private globe: Stage | null = null;
  private busy = false;
  private pendingRoute = false;
  private timer = new Timer();
  private time: number;
  private frames = 0;
  private statAccum = 0;
  private currentCity: CityDef | null = null;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement, params: Params) {
    this.canvas = canvas;
    this.params = params;
    this.time = params.startTime;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: params.shot,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setClearColor(0x000000, 1);
    // Post-processing issues several draws per frame; count them all.
    this.renderer.info.autoReset = false;

    const level: QualityLevel = params.quality ?? (localStorage.getItem("pc.quality") as QualityLevel | null) ?? detectQuality(this.renderer);
    this.quality = makeQuality(level);

    this.overlay = new Overlay(ui, params.shot);
    this.audio = new AudioEngine(params.mute || localStorage.getItem("pc.muted") === "1");
    this.overlay.setMuted(this.audio.isMuted);
    this.overlay.setQuality(level);
    this.overlay.onToggleMute = () => {
      const m = !this.audio.isMuted;
      this.audio.setMuted(m);
      localStorage.setItem("pc.muted", m ? "1" : "0");
      this.overlay.setMuted(m);
    };
    this.overlay.onQuality = (next) => {
      localStorage.setItem("pc.quality", next);
      // Quality touches render targets, shadow maps and instance counts; a
      // reload is the one path that rebuilds all of them consistently.
      location.reload();
    };

    addEventListener("resize", () => this.resize());
    addEventListener("hashchange", () => void this.route());
    this.resize();
  }

  get context(): StageContext {
    return {
      renderer: this.renderer,
      canvas: this.canvas,
      quality: this.quality,
      overlay: this.overlay,
      audio: this.audio,
      params: this.params,
      nav: this,
    };
  }

  async start(): Promise<void> {
    this.timer.connect(document);
    this.renderer.setAnimationLoop((ts) => this.tick(ts));
    await this.route();
  }

  private async route(): Promise<void> {
    // A transition is running: remember to re-evaluate the hash afterwards.
    if (this.busy) {
      this.pendingRoute = true;
      return;
    }
    const id = cityFromHash();
    const city = id ? cityById(id) : undefined;
    if (city?.status === "live" && city.load) {
      if (this.currentCity?.id !== city.id) await this.enterCity(city);
    } else if (!this.stage || this.currentCity) {
      await this.enterGlobe();
    }
  }

  /** Public entry used by the globe once its fly-in finishes. */
  openCity(city: CityDef): void {
    if (location.hash !== `#/city/${city.id}`) location.hash = `#/city/${city.id}`;
    else void this.route();
  }

  closeCity(): void {
    history.pushState(null, "", location.pathname + location.search);
    void this.route();
  }

  private async enterGlobe(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const fromCity = !!this.currentCity;
      if (this.stage) {
        await this.overlay.fadeTo(1, 700);
        this.swapOut();
      }
      if (!this.globe) {
        const { createGlobeStage } = await import("../globe/GlobeStage");
        this.globe = await createGlobeStage(this.context, this);
      }
      this.currentCity = null;
      this.show(this.globe);
      await this.overlay.fadeTo(0, fromCity ? 900 : 1600);
    } finally {
      this.busy = false;
      this.flushRoute();
    }
  }

  private flushRoute(): void {
    if (!this.pendingRoute) return;
    this.pendingRoute = false;
    void this.route();
  }

  private async enterCity(city: CityDef): Promise<void> {
    if (this.busy || !city.load) return;
    this.busy = true;
    try {
      this.overlay.showLoading(city);
      await nextFrame();
      await this.overlay.fadeTo(0, 0);
      const progress: Progress = async (f, label) => {
        this.overlay.setLoading(f, label);
        await nextFrame();
      };
      await progress(0.02, "Fetching scene");
      const mod = await city.load();
      const stage = await mod.createStage(this.context, city, async (f, label) => progress(0.04 + f * 0.86, label));
      await progress(0.92, "Compiling shaders");
      await this.renderer.compileAsync(stage.scene, stage.camera);
      await progress(1, "Ready");
      this.swapOut();
      this.currentCity = city;
      this.show(stage);
      // Two frames so the first expensive frame is behind the curtain.
      await nextFrame();
      await nextFrame();
      await this.overlay.hideLoading();
    } catch (err) {
      console.error(err);
      this.overlay.toast(`Could not open ${city.name}: ${(err as Error).message}`);
      await this.overlay.hideLoading();
      this.busy = false;
      this.currentCity = null;
      history.replaceState(null, "", location.pathname + location.search);
      this.pendingRoute = false;
      await this.enterGlobe();
      return;
    } finally {
      this.busy = false;
      this.flushRoute();
    }
  }

  private swapOut(): void {
    const prev = this.stage;
    if (!prev) return;
    prev.leave();
    if (prev !== this.globe) prev.dispose();
    this.stage = null;
  }

  private show(stage: Stage): void {
    this.stage = stage;
    // Captures are reproducible: the clock starts at ?t when a stage appears,
    // however long loading took.
    if (this.params.shot) this.time = this.params.startTime;
    this.resize();
    stage.enter();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    const pr = Math.min(devicePixelRatio || 1, this.quality.maxPixelRatio) * this.quality.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.stage?.resize(w, h, pr);
  }

  private tick(ts: number): void {
    this.timer.update(ts);
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    this.time += dt;
    if (!this.stage) return;
    this.renderer.info.reset();
    this.stage.frame(dt, this.time);
    if (this.params.stats) {
      this.frames++;
      this.statAccum += dt;
      if (this.statAccum > 0.5) {
        const info = this.renderer.info;
        this.overlay.setStats(
          `${(this.frames / this.statAccum).toFixed(0)} fps  ${((this.statAccum / this.frames) * 1000).toFixed(1)} ms\n` +
            `${info.render.calls} calls  ${(info.render.triangles / 1000).toFixed(0)}k tris  ${this.quality.level}`,
        );
        this.frames = 0;
        this.statAccum = 0;
      }
    }
  }
}
