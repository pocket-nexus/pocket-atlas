import { hdrFragment } from "./atlas-ipod-hdr";
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
export function shader(
  name: string,
  defines: Record<string, number> = {},
): string {
  const stage = name.endsWith("_v") ? "vert" : "frag";
  const identity =
    "gles2-v6:" +
    readFileSync(import.meta.path, "utf8") +
    readFileSync(join(root, "tools/atlas-ipod-hdr.ts"), "utf8") +
    expand(name + ".cg") +
    JSON.stringify(Object.entries(defines).sort());
  const key =
    name +
    "-" +
    createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (existsSync(join(out, key + ".glsl"))) return key;
  const hlsl = join(dir, key + ".hlsl"),
    spv = join(dir, key + ".spv");
  let source = expand(name + ".cg")
    .replace(/: POSITION\b/g, ": SV_Position")
    .replace(/: COLOR\b/g, ": SV_Target")
    .replace(/\bhalf([234]?)\b/g, "min16float$1");
  // Very smooth glass can exceed the finite half range before the HDR
  // encoder clamps highlights. Keep its BRDF accumulation and varyings full
  // precision on SGX535 to avoid inf * 0 producing coloured NaN fragments.
  if (name === "glass_f")
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
    /\bo(World|Normal|Tangent|Uv2?|Screen|Color|Light|Haze|Ray|Grain|Local|ShadowUv|N|East|North|V|SunE|CloudE|Package)\b/g,
    "v$1",
  );
  if (name === "glass_f")
    glsl = glsl.replace(
      /^varying highp (vec[34] v(?:Normal|Light|Haze));$/gm,
      "varying mediump $1;",
    );
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
