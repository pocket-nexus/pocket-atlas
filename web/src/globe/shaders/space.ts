import { COMMON } from "./chunks";

export const SKY_VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSky;
uniform vec3 uSunDir;
uniform float uSkyGain;
uniform float uSunGlow;
in vec3 vDir;
out vec4 fragColor;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = texture(tSky, sphereUvSeamless(d)).rgb * uSkyGain;
  // Unresolved stars: pixel-scale dust whose density follows the band.
  vec3 cell = floor(d * 1400.0);
  vec3 h = fract(sin(vec3(dot(cell, vec3(127.1, 311.7, 74.7)), dot(cell, vec3(269.5, 183.3, 246.1)), dot(cell, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
  float band = saturate(dot(col, vec3(0.33)) * 40.0);
  float thr = 0.9985 - 0.012 * band;
  col += vec3(0.9, 0.93, 1.0) * smoothstep(thr, 1.0, h.x) * (0.03 + 0.25 * band) * (0.4 + h.y);
  float c = max(dot(d, uSunDir), 0.0);
  // Sun: disc, corona and a wide veiling glare that leaks into frame.
  col += vec3(1.0, 0.9, 0.78) * uSunGlow * (40.0 * pow(c, 4000.0) + 0.35 * pow(c, 300.0) + 0.05 * pow(c, 24.0) + 0.03 * pow(c, 5.0));
  fragColor = vec4(col, 1.0);
}`;

export const STAR_VERT = /* glsl */ `
in float aSize;
in vec3 aColor;
uniform float uPixelRatio;
uniform float uBright;
out vec3 vColor;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio;
  vColor = aColor * uBright;
}`;

export const STAR_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 7.0) + 0.06 * exp(-r2 * 1.8);
  fragColor = vec4(vColor * a, 1.0);
}`;
