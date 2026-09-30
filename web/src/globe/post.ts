import {
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";
import { HalfFloatType, Uniform, Vector2, type Camera, type Scene, type WebGLRenderer } from "three";

/** Film grain and a fade-to-black that belongs to the image (it survives the DOM fade being dropped). */
class GradeEffect extends Effect {
  constructor() {
    super(
      "GlobeGrade",
      /* glsl */ `
      uniform float fade;
      uniform float grain;
      uniform float seed;
      float gh(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        // Grain lives in a perceptual (square-root) space so black stays black.
        vec3 pc = sqrt(max(inputColor.rgb, vec3(0.0)));
        float gn = gh(gl_FragCoord.xy + vec2(seed)) + gh(gl_FragCoord.xy * 1.37 - vec2(seed)) - 1.0;
        pc = max(pc + gn * grain * smoothstep(vec3(0.0), vec3(0.2), pc), vec3(0.0));
        outputColor = vec4(pc * pc * (1.0 - fade), inputColor.a);
      }`,
      {
        uniforms: new Map<string, Uniform>([
          ["fade", new Uniform(0)],
          ["grain", new Uniform(0.022)],
          ["seed", new Uniform(0)],
        ]),
      },
    );
  }
}

/** Radial zoom blur toward a screen point, used while diving into a city. */
class ZoomBlurEffect extends Effect {
  constructor() {
    super(
      "GlobeZoomBlur",
      /* glsl */ `
      uniform float strength;
      uniform vec2 center;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 dir = uv - center;
        vec3 acc = inputColor.rgb;
        float wsum = 1.0;
        // Per-pixel jitter turns tap banding into fine noise.
        float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        for (int i = 1; i < 16; i++) {
          float t = (float(i) - j) / 15.0;
          float w = 1.0 - 0.6 * t;
          acc += texture2D(inputBuffer, center + dir * (1.0 - strength * t)).rgb * w;
          wsum += w;
        }
        outputColor = vec4(acc / wsum, inputColor.a);
      }`,
      {
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map<string, Uniform>([
          ["strength", new Uniform(0)],
          ["center", new Uniform(new Vector2(0.5, 0.5))],
        ]),
      },
    );
  }
}

export class GlobePost {
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  private grade = new GradeEffect();
  private zoom = new ZoomBlurEffect();
  private zoomPass: EffectPass;
  private frame = 0;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera, msaa: number, lowEnd: boolean) {
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: msaa });
    this.composer.addPass(new RenderPass(scene, camera));
    this.zoomPass = new EffectPass(camera, this.zoom);
    this.zoomPass.enabled = false;
    this.composer.addPass(this.zoomPass);
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.35,
      intensity: 0.95,
      radius: 0.78,
      levels: lowEnd ? 6 : 8,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.58 });
    const pass = new EffectPass(camera, this.bloom, tone, vignette, this.grade);
    pass.dithering = true;
    this.composer.addPass(pass);
  }

  set fade(v: number) {
    this.grade.uniforms.get("fade")!.value = v;
  }

  setZoomBlur(strength: number, cx: number, cy: number): void {
    this.zoomPass.enabled = strength > 0.002;
    this.zoom.uniforms.get("strength")!.value = strength;
    (this.zoom.uniforms.get("center")!.value as Vector2).set(cx, cy);
  }

  render(dt: number, deterministic: boolean): void {
    this.frame++;
    this.grade.uniforms.get("seed")!.value = deterministic ? 0 : (this.frame % 64) * 7.31;
    this.composer.render(dt);
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
