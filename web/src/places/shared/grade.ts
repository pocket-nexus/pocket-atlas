import { BlendFunction, Effect } from "postprocessing";
import { Uniform, Vector3 } from "three";

/**
 * Final grade shared by the places: contrast around middle grey, saturation,
 * a shadow lift and highlight gain on soft curves, vignette, film grain, the
 * fade to black between shots and the 2.39:1 letterbox of the cinematic
 * camera. Each place sets the uniforms for its own look.
 */
const GRADE = /* glsl */ `
uniform float uGrain;
uniform float uVignette;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uSaturation;
uniform float uContrast;
uniform float uFade;
uniform float uBars;
float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  // Contrast pivoting on middle grey.
  c = 0.18 * pow(c / 0.18, vec3(uContrast));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  // Lift shadows toward teal, push highlights warm (applied on a soft curve).
  float sh = 1.0 - smoothstep(0.0, 0.35, l);
  float hi = smoothstep(0.35, 1.0, l);
  c += uLift * sh * 0.04;
  c *= mix(vec3(1.0), uGain, hi);
  vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
  float v = smoothstep(1.05, 0.25, length(d));
  c *= mix(1.0 - uVignette, 1.0, v);
  float n = gHash(uv * resolution + fract(time * 7.13) * 911.0) + gHash(uv * resolution * 1.37 - fract(time * 3.1) * 517.0) - 1.0;
  c += n * uGrain * (0.35 + 0.65 * (1.0 - smoothstep(0.0, 0.5, l)));
  c = mix(c, vec3(0.0), uFade);
  // Letterbox toward 2.39:1 while the cinematic camera runs.
  float bar = uBars * max(0.0, 0.5 - (aspect / 2.39) * 0.5);
  c *= smoothstep(bar - 0.001, bar + 0.001, min(uv.y, 1.0 - uv.y));
  outputColor = vec4(c, inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", GRADE, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["uGrain", new Uniform(0.03)],
        ["uVignette", new Uniform(0.45)],
        ["uLift", new Uniform(new Vector3(0.1, 0.35, 0.45))],
        ["uGain", new Uniform(new Vector3(1.04, 0.99, 0.94))],
        ["uSaturation", new Uniform(1.18)],
        ["uContrast", new Uniform(1.16)],
        ["uFade", new Uniform(0)],
        ["uBars", new Uniform(0)],
      ]),
    });
  }
}
