/** GLES bindings for the shared Atlas effect shaders. The Cg sources remain
 * authoritative; only attribute names and GXM point-sprite semantics differ. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shader } from "./atlas-ipod-shaders";

const assets = resolve(import.meta.dir, "../.pocket-build/ipod/assets");
const output = join(assets, "shaders");

export const BLOOM_RGBM_RANGE = 128;
export const BLOOM_RADIANCE_LIMIT = 126;
export type BloomStorage = "write" | "both" | "read";

export function withoutBloomHaze(source: string): string {
  // Selected only when no haze pass contributed: remove the texture read
  // at compile time, including its otherwise wasted scene-HDR decode.
  const sample = /\batlasDecode\(texture2D\(uHazeTex,\s*vUv\)\)/g;
  if (!sample.test(source)) throw new Error("Missing bloom haze sample");
  return source.replace(sample, "vec4(0.0)");
}

function replaceFunction(source: string, name: string, replacement: string): string {
  const start = source.indexOf(`highp vec4 ${name}(`);
  if (start < 0) throw new Error(`Missing HDR codec ${name}`);
  let end = source.indexOf("{", start) + 1;
  let depth = 1;
  for (; end < source.length && depth; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  if (depth) throw new Error(`Unclosed HDR codec ${name}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

/** Keep the authoritative threshold/filter kernels, but use RGBM8 while
 * blurring. Its sample decode is four multiplies rather than three channel
 * reciprocals plus transcendental HDR conversion. The last upsample returns
 * to the main HDR codec, so no other renderer consumes RGBM accidentally. */
export function bloomStorage(source: string, storage: BloomStorage): string {
  if (storage !== "write") {
    source = replaceFunction(source, "atlasDecode", `highp vec4 atlasDecode(highp vec4 c) {
 return vec4(c.rgb*(c.a*${BLOOM_RGBM_RANGE.toFixed(1)}), 1.0);
}`);
  }
  if (storage !== "read") {
    source = replaceFunction(source, "atlasEncode", `highp vec4 atlasEncode(highp vec4 c) {
 highp vec3 rgb=clamp(c.rgb,vec3(0.0),vec3(${BLOOM_RADIANCE_LIMIT.toFixed(1)}));
 highp float m=max(max(rgb.r,rgb.g),rgb.b);
 m=max(ceil(m*(255.0/${BLOOM_RGBM_RANGE.toFixed(1)})),1.0)/255.0;
 return vec4(rgb*(1.0/(m*${BLOOM_RGBM_RANGE.toFixed(1)})),m);
}`);
  }
  return source;
}

export function pointCoverage(source: string): string {
  const color = /atlasColor\s*=\s*vec4\(vColor\s*\*\s*\((\w+)\s*\*\s*\1\),\s*0\.0\);/;
  if (!color.test(source)) throw new Error("Missing shared point-light falloff");
  return source.replace(color, (_, f: string) => `atlasColor = vec4(vColor * (${f} * ${f}), ${f} * ${f});`);
}

/** Density compensation belongs after display tone and coverage. Scaling
 * radiance before the nonlinear LUT would dim retained distant city lights. */
export function displayFieldWeight(source: string): string {
  if (!source.includes("uAtlasLut") || source.match(/void main\(\)/g)?.length !== 1)
    throw new Error("Missing display field entry point");
  return source.replace("void main()", "void atlasField()") + `
varying mediump float vDensity;
void main() {
 atlasField();
 gl_FragColor.rgb*=vDensity;
}
`;
}

export function displayHazeDepth(source: string): string {
  return replaceFunction(source, "atlasDecode", `highp vec4 atlasDecode(highp vec4 c) {
 return vec4(c.rgb, 32.0*(1.0/max(c.a,1e-6)-1.0));
}`);
}

// Shared by the bloom-only and fused passes: the same four quadrant samples,
// threshold and display headroom, in the same accumulation order.
const displayBloomKernel = `uniform mediump vec4 uTexel, uThreshold;
vec3 extractGlow(vec3 color) {
 float l=dot(color,vec3(0.2126,0.7152,0.0722));
 return color*(smoothstep(uThreshold.x,uThreshold.x+uThreshold.y,l)*uThreshold.w);
}
vec3 displayBloom() {
 vec2 o=uTexel.xy;
 vec3 c=extractGlow(texture2D(uScene,vUv+vec2(-o.x,-o.y)).rgb);
 c+=extractGlow(texture2D(uScene,vUv+vec2(o.x,-o.y)).rgb);
 c+=extractGlow(texture2D(uScene,vUv+vec2(-o.x,o.y)).rgb);
 c+=extractGlow(texture2D(uScene,vUv+vec2(o.x,o.y)).rgb);
 return c*0.25;
}
`;

export function displayBloomSource(): string {
  return `#version 100
precision mediump float;
varying highp vec2 vUv;
uniform sampler2D uScene;
${displayBloomKernel}
void main() {
 gl_FragColor=vec4(displayBloom(),1.0);
}
`;
}

/** Reuse the translated six-light haze and its display grade verbatim. The
 * scene remains linearly filtered for bloom; sampling a source texel centre
 * gives exactly the old nearest depth, without a second scene texture. */
export function displayHazeBloomSource(haze: string): string {
  const depth = /texture2D\(uScene,\s*vUv\)/g;
  if (haze.match(depth)?.length !== 1 || !haze.includes("void atlasMaterial()") ||
      !haze.includes("void main()")) throw new Error("Missing display haze contract");
  haze = haze.replace(depth,
    "texture2D(uScene, (floor(vUv*uSceneTexel.zw)+0.5)*uSceneTexel.xy)")
    .replace("void atlasMaterial()", "uniform highp vec4 uSceneTexel;\nvoid atlasMaterial()")
    .replace("void main()", "highp vec4 atlasHazeColor;\nvoid atlasHaze()")
    .replace(/\bgl_FragColor\b/g, "atlasHazeColor");
  return haze + `
${displayBloomKernel}
uniform highp vec4 uEffectMix; // bloom intensity, reciprocal storage scale
highp vec3 displayByte(highp vec3 c) {
 return floor(clamp(c,0.0,1.0)*255.0+0.5)*(1.0/255.0);
}
void main() {
 atlasHaze();
 // Preserve the old intermediate RGBA8 rounding before applying its
 // nonlinear threshold. Only the final combined storage adds quantization.
 highp vec3 haze=displayByte(atlasHazeColor.rgb);
 highp vec3 bloom=displayByte(displayBloom()+extractGlow(haze)*uThreshold.z);
 gl_FragColor=vec4((haze*uThreshold.z+bloom*uEffectMix.x)*uEffectMix.y,1.0);
}
`;
}

function writeEffectSource(name: string, source: string): string {
  const key = `${name}-effect-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
  writeFileSync(join(output, `${key}.glsl`), source);
  return key;
}

type EffectVariant = { bloom?: BloomStorage; noHaze?: boolean; displayDepth?: boolean };

function effectShader(
  name: string,
  defines: Record<string, number> = {},
  variant: EffectVariant = {},
): string {
  const shared = shader(name, defines);
  let source = readFileSync(join(output, `${shared}.glsl`), "utf8");
  // Program binds these eight attribute names to stable GLES locations.
  const aliases: Record<string, string> =
    name === "fx_v"
      ? {
          aSeed: "aPosition",
          aCorner: "aUv",
          aA: "aNormal",
          aB: "aTangent",
          oLife: "vLife",
        }
      : name === "lights_v"
        ? { aPath: "aTangent", aBlink: "aWeights", aPhase: "aNormal", aDensity: "aUv", oDensity: "vDensity" }
        : {};
  for (const [from, to] of Object.entries(aliases))
    source = source.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  if (name === "lights_f") {
    source = source.replace(
      /^varying (?:lowp |mediump |highp )?vec2 vCoord;\s*$/m,
      "",
    );
    source = source.replace(/\bvCoord\b/g, "gl_PointCoord");
    if (defines.ATLAS_COVERAGE) source = pointCoverage(source);
    if (defines.DENSITY_LOD) source = displayFieldWeight(source);
  }
  if (variant.bloom) source = bloomStorage(source, variant.bloom);
  if (variant.noHaze) source = withoutBloomHaze(source);
  if (variant.displayDepth) source = displayHazeDepth(source);
  return writeEffectSource(name, source);
}

/** One table shared by every place; the native runtime instantiates only
 * effects present in that place's authored metadata. */
export function writeEffects(): void {
  mkdirSync(output, { recursive: true });
  const post = (fragment: string, defines: Record<string, number> = {}, variant: EffectVariant = {}) => [
    effectShader("post_v"),
    effectShader(fragment, defines, variant),
  ];
  const particles = (display: boolean) => ["STREAK", "DRIP", "SPLASH", "STEAM", "BEACON"].map(
    (kind) => [
      effectShader("fx_v", { [kind]: 1, ...(display ? { DISPLAY_COLOR: 1 } : {}) }),
      effectShader("fx_f", {
        [kind === "DRIP" ? "STREAK" : kind]: 1,
        ATLAS_BLEND: kind === "STEAM" ? 3 : 2,
        ...(display ? { ATLAS_LDR: 1, ATLAS_OUTPUT_LDR: 1 } : {}),
      }),
    ],
  );
  const hazeLdr = post("haze_f", { HAZE_LIGHTS: 6, ATLAS_LDR: 1, ATLAS_BLEND: 2 }, { displayDepth: true });
  const config = {
    field: [
      effectShader("lights_v"),
      effectShader("lights_f", { ATLAS_BLEND: 2 }),
    ],
    field_vista: [
      effectShader("lights_v", { VISTA: 1 }),
      effectShader("lights_f", { ATLAS_BLEND: 2 }),
    ],
    field_ldr: [effectShader("lights_v", { PHASE_CACHED: 1, DENSITY_LOD: 1 }), effectShader("lights_f", { ATLAS_BLEND: 2, ATLAS_LDR: 1, ATLAS_COVERAGE: 1, DENSITY_LOD: 1 })],
    field_vista_ldr: [effectShader("lights_v", { VISTA: 1, PHASE_CACHED: 1, DENSITY_LOD: 1 }), effectShader("lights_f", { ATLAS_BLEND: 2, ATLAS_LDR: 1, ATLAS_COVERAGE: 1, DENSITY_LOD: 1 })],
    particles: particles(false),
    particles_ldr: particles(true),
    haze: post("haze_f", { HAZE_LIGHTS: 6 }),
    haze_ldr: hazeLdr,
    haze_bloom_ldr: [hazeLdr[0], writeEffectSource("haze_bloom_ldr_f",
      displayHazeBloomSource(readFileSync(join(output, `${hazeLdr[1]}.glsl`), "utf8")))],
    prefilter: post("prefilter_f", {}, { bloom: "write" }),
    prefilter_no_haze: post("prefilter_f", {}, { bloom: "write", noHaze: true }),
    prefilter_points: post("prefilter_f", { PER_PIXEL: 1 }, { bloom: "write" }),
    prefilter_points_no_haze: post("prefilter_f", { PER_PIXEL: 1 }, { bloom: "write", noHaze: true }),
    tiny_ldr: [effectShader("post_v"), writeEffectSource("bloom_ldr_f", displayBloomSource())],
    down: post("down_f", {}, { bloom: "both" }),
    up: post("up_f", {}, { bloom: "both" }),
    up_final: post("up_f", {}, { bloom: "read" }),
  };
  writeFileSync(join(assets, "effects.json"), JSON.stringify(config));
}

/** Validate stage interfaces and the GLES attribute contract on the host.
 * glslang does not implement Apple's framebuffer-fetch extension, so its
 * prior-pixel input is substituted only in these ignored validation copies.
 * Actual driver compilation is still required on the attached device. */
export function checkEffects(): void {
  const config = JSON.parse(
    readFileSync(join(assets, "effects.json"), "utf8"),
  ) as Record<string, string[] | string[][]>;
  const directory = resolve(assets, "../effects-validation");
  mkdirSync(directory, { recursive: true });
  let count = 0;
  for (const [name, value] of Object.entries(config)) {
    const pairs: string[][] =
      name.startsWith("particles") ? (value as string[][]) : [value as string[]];
    for (const [index, pair] of pairs.entries()) {
      const files = pair.map((key, stage) => {
        let source = readFileSync(join(output, `${key}.glsl`), "utf8");
        if (stage === 0) {
          const known = new Set([
            "aPosition",
            "aNormal",
            "aTangent",
            "aUv",
            "aColor",
            "aLight",
            "aJoints",
            "aWeights",
          ]);
          for (const match of source.matchAll(/^attribute \w+ (\w+);$/gm)) {
            if (!known.has(match[1]))
              throw new Error(`${name}: unbound attribute ${match[1]}`);
          }
          if (/\boLife\b/.test(source))
            throw new Error(`${name}: unmatched particle lifetime varying`);
          if (name === "particles_ldr" &&
              (!/attribute (?:\w+ )?vec4 aColor;/.test(source) ||
               /\bu(?:FogPos|FogCol|Ambient)\b/.test(source)))
            throw new Error(`${name}: CPU display colors must exclude vertex lighting`);
          if (name.startsWith("field") && name.endsWith("_ldr") &&
              (!/attribute (?:\w+ )?vec2 aNormal;/.test(source) || !/attribute (?:\w+ )?float aUv;/.test(source) || /\bsin\s*\(/.test(source)))
            throw new Error(`${name}: cached phase must replace the per-point sine`);
        } else if (
          name.startsWith("field") &&
          (!source.includes("gl_PointCoord") || /\bvCoord\b/.test(source))
        ) {
          throw new Error(`${name}: point sprite coordinate not mapped`);
        }
        source = source
          .replace(
            "#extension GL_EXT_shader_framebuffer_fetch : require",
            "uniform highp vec4 atlasPriorFragment[1];",
          )
          .replace(/\bgl_LastFragData\b/g, "atlasPriorFragment");
        const file = join(
          directory,
          `${name}-${index}.${stage === 0 ? "vert" : "frag"}`,
        );
        writeFileSync(file, source);
        return file;
      });
      const result = Bun.spawnSync(["glslangValidator", "-l", ...files], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode)
        throw new Error(
          `${name}: ${result.stdout.toString()}${result.stderr.toString()}`,
        );
      count++;
    }
  }
  console.log(
    `Validated ${count} GLES effect shader pairs and attribute bindings (host)`,
  );
}

/** Exercise visibility and sampling decisions without UIKit or a GL context.
 * The temporary harness imports the actual runtime modules and pinned crate
 * dependencies; no second copy of the effect algorithms is maintained. */
export function checkEffectsCpu(): void {
  const root = resolve(import.meta.dir, "..");
  const result = Bun.spawnSync(
    ["sh", join(root, "ipod/tests/scene/run.sh"), "effects::tests"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode)
    throw new Error(`${result.stdout.toString()}${result.stderr.toString()}`);
  console.log(result.stdout.toString().trim());
}

if (import.meta.main) {
  if (!Bun.argv.includes("--check-cpu") || Bun.argv.includes("--check"))
    writeEffects();
  if (Bun.argv.includes("--check")) checkEffects();
  if (Bun.argv.includes("--check-cpu")) checkEffectsCpu();
}
