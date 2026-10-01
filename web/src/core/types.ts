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
 * A full-screen experience (the globe, or one place). The App owns exactly one
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

export interface PlaceModule {
  createStage(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage>;
}

export type PlaceStatus = "live" | "soon";

/** One place on the globe: a remembered spot, not a whole city. */
export interface PlaceDef {
  id: string;
  name: string;
  /** Place name in the local script. */
  native: string;
  /** Town or city the place is in, and its name in the local script. */
  locality: string;
  localityNative: string;
  country: string;
  lat: number;
  lon: number;
  /** IANA zone for the live clock shown in the UI. */
  timeZone: string;
  status: PlaceStatus;
  weather: string;
  accent: string;
  /** Who made the place ("Pocket Atlas" for first-party places). */
  author?: string;
  /** Kind of place, the rendering work it draws on (night-street, daytime-slope, …). */
  kind?: string;
  /** Short descriptors for cards: time of day, weather, what is there. */
  tags?: string[];
  /** One sentence about the place. */
  summary?: string;
  /** Listed under Featured. */
  featured?: boolean;
  /** Cinematic shot the preview card is captured from. */
  preview?: string;
  load?: () => Promise<PlaceModule>;
}

/** What stages may ask of the app shell. */
export interface Navigator {
  openPlace(place: PlaceDef): void;
  closePlace(): void;
}
