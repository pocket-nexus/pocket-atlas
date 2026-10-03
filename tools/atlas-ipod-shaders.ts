import { displayCubeFragment } from "./atlas-ipod-cube";
import { hdrFragment } from "./atlas-ipod-hdr";
import { wetVertex, wetFragment, wetResponseFragment, wetResolveFragment } from "./atlas-ipod-wet";
import { createHash } from "node:crypto";
/** Translate the shared Cg material algorithms to GLES 2 using Khronos tools.
 * No generated shader copies belong in git. Sources remain in vita/shaders. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "..");
const dir = join(root, ".pocket-build/ipod/shaders");
mkdirSync(dir, { recursive: true });
const out = join(root, ".pocket-build/ipod/assets/shaders");
mkdirSync(out, { recursive: true });
function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(p.stdout.toString() + p.stderr.toString());
  return p.stdout.toString();
}
function expand(name: string): string {
  return readFileSync(join(root, "vita/shaders", name), "utf8").replace(
    /#include "([^"\n]+)"/g,
    (_, n) => expand(n),
  );
}

/** SGX field appearance lowering. Keep the shared point's geometry, energy,
 * motion and visibility equations; evaluate its immutable colour response in
 * a cooked row texture instead of a dependent 3-D tone lookup per fragment. */
export function fieldAppearanceVertex(source: string): string {
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`Field appearance contract changed: ${from}`);
    source = source.replace(from, to);
  };
  replace("float4 aBlink,", "float aCurve,\n    float4 aBlink,");
  replace("uniform float4 uFieldT,", "uniform float4 uAppearance, // width, inverse width, inverse height, -\n    uniform float4 uFieldT,");
  replace("out half3 oColor : TEXCOORD0", "out float2 oAppearance : TEXCOORD0");
  replace("float3 c = (float3)srgbToLinear((half3)aColor.rgb) * (aLight.x * uField.w * k * k * twinkle * on);",
    "float amplitude = aLight.x * uField.w * k * k * twinkle * on;");
  replace("c *= vistaTransmittance(p, d, rho);", "amplitude *= vistaTransmittance(p, d, rho);");
  replace("oColor = (half3)c;", `float scalar = clamp(amplitude, 0.0, 65504.0);
    float response = sqrt(scalar / (1.0 + scalar));
    oAppearance = float2((response * (uAppearance.x - 1.0) + 0.5) * uAppearance.y,
        (aCurve + 0.5) * uAppearance.z);`);
  return source;
}

/** Hoist ray-independent haze geometry to six CPU uniform records. The
 * integral, spot cone, dry interval, curtain and grade stay shared. */
export function preparedHazeFragment(source: string): string {
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`Prepared haze contract changed: ${from}`);
    source = source.replace(from, to);
  };
  replace("uniform float4 uFogPos[HAZE_LIGHTS];", "uniform float4 uFogMetric[HAZE_LIGHTS]; // squared light-eye length\nuniform float4 uFogPos[HAZE_LIGHTS];");
  replace("(uBoxMin.xyz - ro) * inv", "uBoxMin.xyz * inv");
  replace("(uBoxMax.xyz - ro) * inv", "uBoxMax.xyz * inv");
  replace("float3 L = uFogPos[i].xyz - ro;", "float3 L = uFogPos[i].xyz;");
  replace("float r = uFogPos[i].w;", "float radiusSquared = uFogPos[i].w;");
  replace("max(dot(L, L) - tca * tca, 0.0) + r * r", "max(uFogMetric[i].x - tca * tca, 0.0) + radiusSquared");
  replace("float3 P = ro + rd * clamp(tca, 0.0, dist);", "float3 toSample = rd * clamp(tca, 0.0, dist) - L;");
  replace("normalize(P - uFogPos[i].xyz)", "normalize(toSample)");
  replace("float3 col = acc * uHaze.x + uAmbient.rgb * amb;", "float3 col = acc + uAmbient.rgb * amb;");
  return source;
}

/** Display glass needs the view direction's length only for Fresnel. The
 * octahedral environment projection is homogeneous, so reflect the original
 * vector and avoid normalizing it first. Normal reversal also cancels out in
 * reflection; abs(dot) supplies the same two-sided Fresnel. */
export function displayGlassFragment(source: string): string {
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`Display glass contract changed: ${from}`);
    source = source.replace(from, to);
  };
  replace(`    float dist = length(toEye);
    half3 V = (half3)(toEye / dist);
    half3 N = normalize(vNormal);
    if (dot(N, V) < 0.0) N = -N;`, `    float distSquared = dot(toEye, toEye);
    half3 N = normalize(vNormal);
    half viewFacing = (half)saturate(abs(dot((float3)N, toEye)) * rsqrt(max(distSquared, 1e-8)));`);
  replace("half k = (half)1.0 - saturate(dot(N, V));", "half k = (half)1.0 - viewFacing;");
  replace("octUv((float3)reflect(-V, N))", "octUv((float3)N * (2.0 * dot((float3)N, toEye)) - toEye)");
  replace("(half)fogFactor(dist, uFog.w)", "(half)(1.0 - exp(-(uFog.w * uFog.w) * distSquared))");
  return source;
}

export function shader(
  name: string,
  defines: Record<string, number> = {},
): string {
  // PLIP's RGBA8 shadow target keeps the RGB24 contract. Vita's default
  // R32f/RG16-pair storage is a different backend, not a quality toggle.
  if (name === "shadow_f" || name === "standard_f")
    defines = { ...defines, PACKED_SHADOW: 1 };
  const stage = name.endsWith("_v") ? "vert" : "frag";
  const identity =
    "gles2-v6:" +
    readFileSync(import.meta.path, "utf8") +
    readFileSync(join(root, "tools/atlas-ipod-hdr.ts"), "utf8") +
    readFileSync(join(root, "tools/atlas-ipod-wet.ts"), "utf8") +
    readFileSync(join(root, "tools/atlas-ipod-cube.ts"), "utf8") +
    expand(name + ".cg") +
    JSON.stringify(Object.entries(defines).sort());
  const key =
    name +
    "-" +
    createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (existsSync(join(out, key + ".glsl"))) return key;
  const hlsl = join(dir, key + ".hlsl"),
    spv = join(dir, key + ".spv");
  let source = expand(name + ".cg");
  if (name === "lights_v" && defines.SGX_FIELD_APPEARANCE)
    source = fieldAppearanceVertex(source);
  if (name === "haze_f" && defines.SGX_HAZE_PREPARED) source = preparedHazeFragment(source);
  if (name === "glass_f" && defines.DISPLAY_COLOR && defines.LITE) source = displayGlassFragment(source);
  if ((name === "glass_f" || name === "water_f") && defines.DISPLAY_COLOR) source = displayCubeFragment(name, source);
  if (name === "surface_v" && defines.SGX_WET) source = wetVertex(source);
  if (name === "color_f" && defines.WET) {
    if (defines.SGX_WET_RESPONSE && defines.SGX_WET_RESOLVE)
      throw new Error("Wet response and resolve are separate programs");
    source = defines.SGX_WET_RESPONSE ? wetResponseFragment(source)
      : defines.SGX_WET_RESOLVE ? wetResolveFragment(source) : wetFragment(source);
  }
  source = source
    .replace(/: POSITION\b/g, ": SV_Position")
    .replace(/: COLOR\b/g, ": SV_Target")
    .replace(/\bhalf([234]?)\b/g, "min16float$1");
  // Very smooth glass can exceed the finite half range before the HDR
  // encoder clamps highlights. Keep its BRDF accumulation and varyings full
  // precision on SGX535 to avoid inf * 0 producing coloured NaN fragments.
  if (name === "glass_f" && (defines.LIGHTS ?? 0) > 0)
    source = source.replace(/\bmin16float([234]?)\b/g, "float$1");
  // The iPod color table is sampled over the render-target encoding. This
  // avoids a per-pixel log2 on SGX535; the CPU still evaluates the shared grade.
  if (name === "composite_f")
    source = source.replace(
      "clamp((log2(max(c, 1e-10)) + 12.47393) * (31.0 / 16.5), 0.0, 31.0)",
      "sqrt(saturate(c / (1.0 + c))) * 31.0",
    );
  // GLSL framebuffer textures have bottom-left coordinates. GXM has top-left.
  source = source.replace("0.5 - aPosition.y * 0.5", "0.5 + aPosition.y * 0.5");
  source = source.replace(/float2\(0\.5, -0\.5\)/g, "float2(0.5, 0.5)");
  writeFileSync(hlsl, source);
  run([
    "glslangValidator",
    "-D",
    "--hlsl-dx9-compatible",
    "--auto-map-bindings",
    "--auto-map-locations",
    "-V",
    "-S",
    stage,
    "-e",
    "main",
    ...Object.entries(defines).map(([k, v]) => `-D${k}=${v}`),
    hlsl,
    "-o",
    spv,
  ]);
  let glsl = run(["spirv-cross", spv, "--es", "--version", "100"]);
  // OpenGL has individual uniforms. Preserve the shared renderer's names
  // instead of exposing compiler-generated uniform-block instance names.
  const blocks = [...glsl.matchAll(/struct (\w+)\n\{\n([\s\S]*?)\n\};\n/g)];
  for (const block of blocks) {
    const re = new RegExp(`uniform ${block[1]} (\\w+);`);
    const instance = glsl.match(re);
    if (instance) {
      glsl = glsl
        .replace(
          block[0],
          block[2]
            .split("\n")
            .map((l) => "uniform " + l.trim())
            .join("\n") + "\n",
        )
        .replace(re, "")
        .replace(new RegExp(`\\b${instance[1]}\\.`, "g"), "");
    }
  }
  // Link varyings by the common semantic rather than stage-local spelling.
  glsl = glsl.replace(
    /\bo(World|Normal|Tangent|Uv2?|Screen|Color|Light|Haze|Ray|Grain|Fog|Depth|Local|ShadowUv|N|East|North|V|SunE|CloudE|Package|Appearance|WetFresnel|WetUv)\b/g,
    "v$1",
  );
  if (name === "glass_f")
    glsl = glsl.replace(
      /^varying highp (vec[34] v(?:Normal|Light|Haze));$/gm,
      "varying mediump $1;",
    );
  // RGBA8 texture samples and material colors need half precision; keeping
  // them highp promotes otherwise-half shared lighting on Series5.
  glsl = glsl.replace(/uniform highp (sampler2D|samplerCube)/g, "uniform mediump $1");
  glsl = glsl.replace(/uniform highp vec4 (u(?:Base|Emissive|Pbr|EnvK|Wet2?|ReflOn|HemiSky|HemiGround))\b/g, "uniform mediump vec4 $1");
  // Cg POSITION uses depth [0,1]; the surface uses an OpenGL projection and
  // needs no fixup. SPIRV-Cross's default output leaves the position unchanged.
  if (stage === "frag") glsl = hdrFragment(glsl, name, defines);
  writeFileSync(join(out, key + ".glsl"), glsl);
  return key;
}
if (import.meta.main) {
  const name = Bun.argv[2] ?? "standard_f";
  console.log(
    shader(
      name,
      JSON.parse(
        Bun.argv[3] ?? '{"BAKED":1,"ALBEDO_MAP":1,"LIGHTS":0,"FOG":1}',
      ),
    ),
  );
}
