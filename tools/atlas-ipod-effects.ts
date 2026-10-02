/** GLES bindings for the shared Atlas effect shaders. The Cg sources remain
 * authoritative; only attribute names and GXM point-sprite semantics differ. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shader } from "./atlas-ipod-shaders";

const assets = resolve(import.meta.dir, "../.pocket-build/ipod/assets");
const output = join(assets, "shaders");

function effectShader(
  name: string,
  defines: Record<string, number> = {},
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
        ? { aPath: "aTangent", aBlink: "aWeights" }
        : {};
  for (const [from, to] of Object.entries(aliases))
    source = source.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  if (name === "lights_f") {
    source = source.replace(
      /^varying (?:lowp |mediump |highp )?vec2 vCoord;\s*$/m,
      "",
    );
    source = source.replace(/\bvCoord\b/g, "gl_PointCoord");
  }
  const key = `${name}-effect-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
  writeFileSync(join(output, `${key}.glsl`), source);
  return key;
}

/** One table shared by every place; the native runtime instantiates only
 * effects present in that place's authored metadata. */
export function writeEffects(): void {
  mkdirSync(output, { recursive: true });
  const post = (fragment: string, defines: Record<string, number> = {}) => [
    effectShader("post_v"),
    effectShader(fragment, defines),
  ];
  const particles = ["STREAK", "DRIP", "SPLASH", "STEAM", "BEACON"].map(
    (kind) => [
      effectShader("fx_v", { [kind]: 1 }),
      effectShader("fx_f", {
        [kind === "DRIP" ? "STREAK" : kind]: 1,
        ATLAS_BLEND: kind === "STEAM" ? 3 : 2,
      }),
    ],
  );
  const config = {
    field: [
      effectShader("lights_v"),
      effectShader("lights_f", { ATLAS_BLEND: 2 }),
    ],
    field_vista: [
      effectShader("lights_v", { VISTA: 1 }),
      effectShader("lights_f", { ATLAS_BLEND: 2 }),
    ],
    particles,
    haze: post("haze_f", { HAZE_LIGHTS: 6 }),
    prefilter: post("prefilter_f"),
    prefilter_points: post("prefilter_f", { PER_PIXEL: 1 }),
    down: post("down_f"),
    up: post("up_f"),
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
      name === "particles" ? (value as string[][]) : [value as string[]];
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
