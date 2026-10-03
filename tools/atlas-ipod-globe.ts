/** Globe-only performance grade. The opaque HDR encoder caps radiance at
 * 126, hence RGBA8 RGB at 254/255; the background is checked by the loader.
 * Exposure is one and this pass adds neither haze nor bloom. Consequently
 * sqrt(decode(encoded)/(1+decode(encoded))) is encoded itself. This removes
 * the round trip without changing the shared tone table, grain, or mask.
 * 255/256 also contains the binary16 rounding of the greatest legal texel. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const GLOBE_ENCODED_MAX = 255 / 256;

export function globeGradeSource(): string {
  return `#version 100
precision mediump float;
precision highp int;
varying highp vec2 vUv;
varying highp vec2 vGrain;
uniform mediump sampler2D uScene, uLut, uMask, uGrain;
uniform highp vec4 uGrade;
void main() {
 highp vec3 cell=clamp(texture2D(uScene,vUv).rgb,vec3(0.0),vec3(${GLOBE_ENCODED_MAX}))*31.0;
 highp float blue=floor(cell.b);
 highp vec2 uv=vec2((blue*32.0+cell.r+0.5)/1024.0,(cell.g+0.5)/32.0);
 vec3 color=mix(texture2D(uLut,uv).rgb,
   texture2D(uLut,uv+vec2((min(blue+1.0,31.0)-blue)/32.0,0.0)).rgb,cell.b-blue);
 color+=(texture2D(uGrain,vGrain).r-0.5)*(uGrade.z*2.4)*(1.0-color.g*0.7);
 gl_FragColor=vec4(color*texture2D(uMask,vUv).r,1.0);
}
`;
}

export function globeGradeShader(): string {
  const source = globeGradeSource();
  const key = "globe_grade_f-" + createHash("sha256").update(source).digest("hex").slice(0, 16);
  const output = resolve(import.meta.dir, "../.pocket-build/ipod/assets/shaders");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, key + ".glsl"), source);
  return key;
}
