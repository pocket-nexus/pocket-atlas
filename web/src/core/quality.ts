import type { WebGLRenderer } from "three";

export type QualityLevel = "low" | "medium" | "high" | "ultra";

export interface Quality {
  level: QualityLevel;
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  /** Render-resolution scale applied on top of the pixel ratio. */
  renderScale: number;
  msaa: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Planar reflection resolution relative to the drawing buffer. */
  reflectionScale: number;
  ao: boolean;
  rainDrops: number;
  splashes: number;
  /** Largest procedural texture edge. */
  textureSize: number;
  volumetrics: boolean;
}

const PRESETS: Record<QualityLevel, Omit<Quality, "level">> = {
  low: {
    maxPixelRatio: 1,
    renderScale: 0.75,
    msaa: 0,
    shadows: false,
    shadowMapSize: 512,
    reflectionScale: 0.25,
    ao: false,
    rainDrops: 6000,
    splashes: 300,
    textureSize: 512,
    volumetrics: false,
  },
  medium: {
    maxPixelRatio: 1.25,
    renderScale: 1,
    msaa: 0,
    shadows: true,
    shadowMapSize: 1024,
    reflectionScale: 0.35,
    ao: false,
    rainDrops: 14000,
    splashes: 700,
    textureSize: 1024,
    volumetrics: true,
  },
  high: {
    maxPixelRatio: 1.25,
    renderScale: 1,
    msaa: 4,
    shadows: true,
    shadowMapSize: 2048,
    reflectionScale: 0.42,
    ao: true,
    rainDrops: 26000,
    splashes: 1400,
    textureSize: 2048,
    volumetrics: true,
  },
  ultra: {
    maxPixelRatio: 2,
    renderScale: 1,
    msaa: 4,
    shadows: true,
    shadowMapSize: 4096,
    reflectionScale: 0.6,
    ao: true,
    rainDrops: 42000,
    splashes: 2200,
    textureSize: 2048,
    volumetrics: true,
  },
};

export const QUALITY_LEVELS: QualityLevel[] = ["low", "medium", "high", "ultra"];

export function makeQuality(level: QualityLevel): Quality {
  return { level, ...PRESETS[level] };
}

/** Picks a starting preset from the GPU string and device class. */
export function detectQuality(renderer: WebGLRenderer): QualityLevel {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent) && innerWidth < 1100;
  if (/SwiftShader|llvmpipe|Software/i.test(gpu)) return "low";
  if (mobile) return "medium";
  if (/Intel\(R\) (UHD|HD)|Intel.*Iris(?! Xe)|Apple M1(?! (Pro|Max|Ultra))/i.test(gpu)) return "medium";
  // Ultra (full-res AO, 4K shadow maps, 2× pixel ratio) is opt-in from the UI.
  return "high";
}
