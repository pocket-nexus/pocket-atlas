import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode, type Effect } from "postprocessing";
import { N8AOPostPass } from "n8ao";
import { Color, HalfFloatType, Vector3, type PerspectiveCamera, type Scene, type WebGLRenderer } from "three";
import type { Quality } from "../../../core/quality";
import { GradeEffect } from "../../shared/grade";

export interface DayPost {
  composer: EffectComposer;
  grade: GradeEffect;
  bloom: BloomEffect;
  setSize(w: number, h: number): void;
  render(dt: number): void;
  dispose(): void;
}

/**
 * Daylight finish: screen-space ambient occlusion for the contact shadows the
 * sky probe cannot give, a restrained bloom for sun glints and the sun disc,
 * AgX tone mapping and a clean, saturated summer grade.
 */
export function createDayPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, quality: Quality): DayPost {
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: quality.msaa, stencilBuffer: false });
  composer.addPass(new RenderPass(scene, camera));

  if (quality.ao) {
    const ao = new N8AOPostPass(scene, camera, 16, 16);
    ao.configuration.aoRadius = 0.9;
    ao.configuration.distanceFalloff = 0.6;
    ao.configuration.intensity = 3.0;
    ao.configuration.gammaCorrection = false;
    ao.configuration.halfRes = quality.level !== "ultra";
    ao.configuration.color = new Color(0.02, 0.03, 0.06);
    composer.addPass(ao);
  }

  const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.6, luminanceSmoothing: 0.5, intensity: 0.35, radius: 0.65, levels: quality.level === "low" ? 5 : 7 });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  const grade = new GradeEffect();
  const u = grade.uniforms;
  u.get("uGrain")!.value = 0.012;
  u.get("uVignette")!.value = 0.3;
  (u.get("uLift")!.value as Vector3).set(0.02, 0.14, 0.3);
  (u.get("uGain")!.value as Vector3).set(1.05, 1.0, 0.93);
  u.get("uSaturation")!.value = 1.1;
  u.get("uContrast")!.value = 1.06;
  // No chromatic aberration: it tints the fine wire mesh and cables magenta.
  const finals: Effect[] = [];
  if (quality.msaa === 0) finals.push(new SMAAEffect());
  finals.push(bloom, tone, grade);
  composer.addPass(new EffectPass(camera, ...finals));

  return {
    composer,
    grade,
    bloom,
    setSize: (w, h) => composer.setSize(w, h, false),
    render: (dt) => composer.render(dt),
    dispose: () => composer.dispose(),
  };
}
