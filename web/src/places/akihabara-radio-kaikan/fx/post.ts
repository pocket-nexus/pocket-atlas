import { BloomEffect, ChromaticAberrationEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode, type Effect } from "postprocessing";
import { N8AOPostPass } from "n8ao";
import { Color, HalfFloatType, Vector2, Vector3, type PerspectiveCamera, type Scene, type WebGLRenderer } from "three";
import type { Quality } from "../../../core/quality";
import { GradeEffect } from "../../shared/grade";

export interface DuskPost {
  composer: EffectComposer;
  grade: GradeEffect;
  bloom: BloomEffect;
  setSize(w: number, h: number): void;
  render(dt: number): void;
  dispose(): void;
}

/**
 * Blue-hour finish: ambient occlusion for the contact shadows the sky
 * probe cannot give, a wide bloom that LED signage and lamp globes drive
 * (threshold just above white), AgX tone mapping (saturated signs roll off
 * to white instead of clipping) and a grade with cool shadows and warm
 * highlights.
 */
export function createDuskPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, quality: Quality): DuskPost {
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: quality.msaa, stencilBuffer: false });
  composer.addPass(new RenderPass(scene, camera));

  if (quality.ao) {
    const ao = new N8AOPostPass(scene, camera, 16, 16);
    ao.configuration.aoRadius = 1.0;
    ao.configuration.distanceFalloff = 0.6;
    ao.configuration.intensity = 2.4;
    ao.configuration.gammaCorrection = false;
    ao.configuration.halfRes = quality.level !== "ultra";
    ao.configuration.color = new Color(0.0, 0.0, 0.02);
    composer.addPass(ao);
  }

  const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.45, intensity: 0.95, radius: 0.72, levels: quality.level === "low" ? 5 : 8 });
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const grade = new GradeEffect();
  const u = grade.uniforms;
  u.get("uGrain")!.value = 0.022;
  u.get("uVignette")!.value = 0.32;
  (u.get("uLift")!.value as Vector3).set(0.05, 0.22, 0.55);
  (u.get("uGain")!.value as Vector3).set(1.06, 1.0, 0.92);
  u.get("uSaturation")!.value = 1.16;
  u.get("uContrast")!.value = 1.1;
  const finals: Effect[] = [];
  if (quality.msaa === 0) finals.push(new SMAAEffect());
  else finals.push(new ChromaticAberrationEffect({ offset: new Vector2(0.0004, 0.0003), radialModulation: true, modulationOffset: 0.3 }));
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
