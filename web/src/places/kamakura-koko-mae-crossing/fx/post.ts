import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode, type Effect } from "postprocessing";
import { N8AOPostPass } from "n8ao";
import { Color, HalfFloatType, Vector3, type PerspectiveCamera, type Scene, type WebGLRenderer } from "three";
import type { Quality } from "../../../core/quality";
import { GradeEffect } from "../../shared/grade";

export interface CoastPost {
  composer: EffectComposer;
  grade: GradeEffect;
  bloom: BloomEffect;
  setSize(w: number, h: number): void;
  render(dt: number): void;
  dispose(): void;
}

/**
 * Seaside daylight finish: screen-space ambient occlusion for contact shadows
 * the sky probe cannot give, a restrained bloom for the lit crossing lamps
 * and sun glints, ACES tone mapping and a clear, slightly cool summer grade.
 */
export function createCoastPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, quality: Quality): CoastPost {
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: quality.msaa, stencilBuffer: false });
  composer.addPass(new RenderPass(scene, camera));

  if (quality.ao) {
    const ao = new N8AOPostPass(scene, camera, 16, 16);
    ao.configuration.aoRadius = 0.9;
    ao.configuration.distanceFalloff = 0.6;
    ao.configuration.intensity = 2.6;
    ao.configuration.gammaCorrection = false;
    ao.configuration.halfRes = quality.level !== "ultra";
    // Neutral: contact shadows darken the paint and asphalt without tinting them.
    ao.configuration.color = new Color(0, 0, 0);
    composer.addPass(ao);
  }

  const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.5, luminanceSmoothing: 0.5, intensity: 0.4, radius: 0.6, levels: quality.level === "low" ? 5 : 7 });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  const grade = new GradeEffect();
  const u = grade.uniforms;
  u.get("uGrain")!.value = 0.01;
  u.get("uVignette")!.value = 0.22;
  (u.get("uLift")!.value as Vector3).set(0.04, 0.05, 0.07);
  (u.get("uGain")!.value as Vector3).set(1.03, 1.0, 0.95);
  u.get("uSaturation")!.value = 1.12;
  u.get("uContrast")!.value = 1.08;
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
