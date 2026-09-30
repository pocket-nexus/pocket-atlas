import type { Camera, Scene, WebGLRenderer } from "three";
import type { AudioEngine } from "./audio";
import type { Params } from "./params";
import type { Quality } from "./quality";
import type { Overlay } from "../ui/overlay";

/** Reports build progress in [0, 1]; resolves after the UI had a chance to paint. */
export type Progress = (fraction: number, label?: string) => Promise<void>;

export interface StageContext {
  renderer: WebGLRenderer;
  canvas: HTMLCanvasElement;
  quality: Quality;
  overlay: Overlay;
  audio: AudioEngine;
  params: Params;
  nav: Navigator;
}

/**
 * A full-screen experience (the globe, or one city). The App owns exactly one
 * active stage; the stage owns its scene, camera, post-processing chain and
 * any GPU resources, and releases them in dispose().
 */
export interface Stage {
  readonly scene: Scene;
  readonly camera: Camera;
  /** Called once the stage becomes visible (after the fade-in starts). */
  enter(): void;
  /** Called before the stage is hidden (it may be kept alive, e.g. the globe). */
  leave(): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Advance simulation and draw one frame to the canvas. */
  frame(dt: number, time: number): void;
  dispose(): void;
}

export interface CityModule {
  createStage(ctx: StageContext, city: CityDef, progress: Progress): Promise<Stage>;
}

export type CityStatus = "live" | "soon";

export interface CityDef {
  id: string;
  name: string;
  /** Name in the local script. */
  native: string;
  country: string;
  lat: number;
  lon: number;
  /** IANA zone for the live clock shown in the UI. */
  timeZone: string;
  status: CityStatus;
  scene: string;
  sceneNative: string;
  weather: string;
  accent: string;
  load?: () => Promise<CityModule>;
}

/** What stages may ask of the app shell. */
export interface Navigator {
  openCity(city: CityDef): void;
  closeCity(): void;
}
