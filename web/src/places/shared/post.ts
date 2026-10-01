import { BloomEffect, ChromaticAberrationEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode, type Effect } from "postprocessing";
import { N8AOPostPass } from "n8ao";
import { Color, HalfFloatType, Vector2, Vector3, type PerspectiveCamera, type Scene, type WebGLRenderer } from "three";
import type { Quality } from "../../core/quality";
import { GradeEffect } from "./grade";

/**
 * A place's finish, as data: the tone curve, screen-space ambient occlusion
 * (for the contact shadows a sky probe cannot give), bloom and the final
 * grade (`shared/grade.ts`). The same record is exported as `post` for the
 * handheld (see `postMeta`).
 */
export interface PostLook {
  /** Tone curve; the cooker reads it as `post.tone`. */
  tone: "aces" | "agx";
  /** N8AO: radius (m), intensity and the occlusion colour (linear RGB). */
  ao: { radius: number; intensity: number; color: [number, number, number] };
  /** Bloom: luminance threshold and smoothing, intensity, radius, mip levels (5 on the low preset). */
  bloom: { threshold: number; smoothing: number; intensity: number; radius: number; levels: number };
  grade: { grain: number; vignette: number; lift: [number, number, number]; gain: [number, number, number]; saturation: number; contrast: number };
  /** Radial chromatic aberration on the web when MSAA is on (SMAA takes its slot otherwise). */
  aberration?: { offset: [number, number]; modulationOffset: number };
}

export interface PlacePost {
  look: PostLook;
  composer: EffectComposer;
  grade: GradeEffect;
  bloom: BloomEffect;
  setSize(w: number, h: number): void;
  render(dt: number): void;
  dispose(): void;
}

/** The composer for a place: render, N8AO (when the preset has AO), then SMAA or aberration, bloom, tone curve and grade. */
export function createPlacePost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, quality: Quality, look: PostLook): PlacePost {
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: quality.msaa, stencilBuffer: false });
  composer.addPass(new RenderPass(scene, camera));

  if (quality.ao) {
    const ao = new N8AOPostPass(scene, camera, 16, 16);
    ao.configuration.aoRadius = look.ao.radius;
    ao.configuration.distanceFalloff = 0.6;
    ao.configuration.intensity = look.ao.intensity;
    ao.configuration.gammaCorrection = false;
    ao.configuration.halfRes = quality.level !== "ultra";
    ao.configuration.color = new Color(...look.ao.color);
    composer.addPass(ao);
  }

  const b = look.bloom;
  const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: b.threshold, luminanceSmoothing: b.smoothing, intensity: b.intensity, radius: b.radius, levels: quality.level === "low" ? 5 : b.levels });
  const tone = new ToneMappingEffect({ mode: look.tone === "aces" ? ToneMappingMode.ACES_FILMIC : ToneMappingMode.AGX });
  const grade = new GradeEffect();
  const u = grade.uniforms;
  const gl = look.grade;
  u.get("uGrain")!.value = gl.grain;
  u.get("uVignette")!.value = gl.vignette;
  (u.get("uLift")!.value as Vector3).set(...gl.lift);
  (u.get("uGain")!.value as Vector3).set(...gl.gain);
  u.get("uSaturation")!.value = gl.saturation;
  u.get("uContrast")!.value = gl.contrast;
  const finals: Effect[] = [];
  if (quality.msaa === 0) finals.push(new SMAAEffect());
  else if (look.aberration) finals.push(new ChromaticAberrationEffect({ offset: new Vector2(...look.aberration.offset), radialModulation: true, modulationOffset: look.aberration.modulationOffset }));
  finals.push(bloom, tone, grade);
  composer.addPass(new EffectPass(camera, ...finals));

  return {
    look,
    composer,
    grade,
    bloom,
    setSize: (w, h) => composer.setSize(w, h, false),
    render: (dt) => composer.render(dt),
    dispose: () => composer.dispose(),
  };
}

/** The tone curve, grade and bloom as the composer holds them, for the handheld (`post` in the export). */
export function postMeta(post: PlacePost, exposure: number): Record<string, unknown> {
  const u = post.grade.uniforms;
  const v3 = (k: string) => (u.get(k)!.value as Vector3).toArray();
  const b = post.bloom;
  return {
    tone: post.look.tone,
    exposure,
    contrast: u.get("uContrast")!.value,
    saturation: u.get("uSaturation")!.value,
    lift: v3("uLift"),
    gain: v3("uGain"),
    vignette: u.get("uVignette")!.value,
    grain: u.get("uGrain")!.value,
    bloomThreshold: b.luminanceMaterial.threshold,
    bloomSmoothing: b.luminanceMaterial.smoothing,
    bloomIntensity: b.intensity,
  };
}
