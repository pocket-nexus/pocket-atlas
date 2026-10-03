/** GLES display-space post processing. Scene colours are already graded;
 * retain glow, atmosphere and film finish without a second tone lookup. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

type DisplayPostOptions = { bloom: boolean; haze: boolean };

function writePostShader(source: string): string {
  const key = "composite_f-" + createHash("sha256").update(source).digest("hex").slice(0,16);
  const out = resolve(import.meta.dir,"../.pocket-build/ipod/assets/shaders");
  mkdirSync(out,{recursive:true});
  writeFileSync(join(out,key+".glsl"),source);
  return key;
}

/** Performance scene and its effects already contain display-sRGB. Retain
 * atmosphere/glow and film finish without HDR conversion or a tone lookup.
 * Effects::post combines enabled effects in the existing bloom texture slot;
 * its weight reverses any linear storage scale, including haze-only frames. */
export function ldrPostSource(options: DisplayPostOptions): string {
  return `#version 100
precision mediump float;
varying highp vec2 vUv;
varying highp vec2 vGrain;
uniform sampler2D uScene, uMask, uGrain;
${options.bloom || options.haze ? "uniform sampler2D uBloom;\nuniform vec4 uBloomK;" : ""}
uniform vec4 uGrade;
void main() {
 vec3 color=texture2D(uScene,vUv).rgb;
 ${options.bloom || options.haze ? "color+=texture2D(uBloom,vUv).rgb*uBloomK.x;" : ""}
 color+=(texture2D(uGrain,vGrain).r-0.5)*(uGrade.z*2.4)*(1.0-color.g*0.7);
 gl_FragColor=vec4(color*texture2D(uMask,vUv).r,1.0);
}
`;
}

export function ldrPostShader(options: DisplayPostOptions): string {
  return writePostShader(ldrPostSource(options));
}
