/** Link every shipped GLES variant on the host. Driver compilation and actual
 * framebuffer-fetch behavior are separately checked by launching each place. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const assets = resolve(import.meta.dir, "../.pocket-build/ipod/assets");
const validation = resolve(assets, "../shader-validation");
mkdirSync(validation, { recursive: true });
const pairs = new Map<string, [string, string]>();
function visit(value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((v) => typeof v === "string")) {
      pairs.set(value.join(":"), value as [string, string]);
    } else value.forEach(visit);
  } else if (value && typeof value === "object")
    Object.values(value).forEach(visit);
}
for (const file of readdirSync(assets)) {
  if (
    file.endsWith(".pipelines.json") ||
    file.endsWith(".shadow.json") ||
    file === "effects.json"
  ) {
    visit(JSON.parse(readFileSync(join(assets, file), "utf8")));
  }
}
const attributes = new Set([
  "aPosition",
  "aNormal",
  "aTangent",
  "aUv",
  "aColor",
  "aLight",
  "aJoints",
  "aWeights",
]);
for (const pair of pairs.values()) {
  const stages = pair.map((name, i) => {
    let source = readFileSync(join(assets, "shaders", name + ".glsl"), "utf8");
    if (!i)
      for (const match of source.matchAll(
        /^attribute\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+);/gm,
      )) {
        if (!attributes.has(match[1]))
          throw new Error(`${name}: unbound attribute ${match[1]}`);
      }
    // glslang has no Apple driver builtins. Stub only the prior pixel input in
    // validation copies; the shipping sources still require the real extension.
    source = source
      .replace(
        "#extension GL_EXT_shader_framebuffer_fetch : require",
        "uniform highp vec4 atlasPriorFragment[1];",
      )
      .replace(/\bgl_LastFragData\b/g, "atlasPriorFragment");
    const path = join(validation, name + (i ? ".frag" : ".vert"));
    writeFileSync(path, source);
    return path;
  });
  const result = Bun.spawnSync(["glslangValidator", "-l", ...stages], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode)
    throw new Error(pair.join(" + ") + "\n" + result.stdout + result.stderr);
}
console.log(
  `Linked ${pairs.size} unique GLES stage pairs; framebuffer fetch still requires device validation.`,
);
