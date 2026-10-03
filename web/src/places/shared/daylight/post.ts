import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { Quality } from "../../../core/quality";
import { createPlacePost, type PlacePost, type PostLook } from "../post";

export type DayPost = PlacePost;

/** Seasonal daylight data over the common composer, also used by coastal and dusk places. */
export function createDayPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, quality: Quality, season: "summer" | "spring" = "summer"): DayPost {
  const spring = season === "spring";
  const look: PostLook = {
    tone: "aces",
    ao: { radius: 0.9, intensity: 3, color: [0.02, 0.03, 0.06] },
    bloom: { threshold: 1.6, smoothing: 0.5, intensity: spring ? 0.22 : 0.35, radius: 0.65, levels: 7 },
    grade: spring
      ? { grain: 0.006, vignette: 0.18, lift: [0.09, 0.09, 0.22], gain: [1.035, 1, 0.985], saturation: 1.04, contrast: 1.025 }
      : { grain: 0.012, vignette: 0.3, lift: [0.02, 0.14, 0.3], gain: [1.05, 1, 0.93], saturation: 1.1, contrast: 1.06 },
  };
  return createPlacePost(renderer, scene, camera, quality, look);
}
