import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lowerGlsl100Arrays } from "./atlas-ipod-glsl";

test("GLSL100 lowering expands old-tool bone copies without changing dynamic joints or weights", () => {
  // Shape reproduced with glslang 15.1.0 + SPIRV-Cross sdk-1.3.239.0.
  // The current macOS tools no longer emit these illegal array operations.
  const source = `#version 100
uniform vec4 uBones[6];
attribute vec4 aPosition;
attribute vec4 aJoints;
attribute vec4 aWeights;
void main() {
    vec4 original[6] = vec4[](uBones[0], uBones[1], uBones[2], uBones[3], uBones[4], uBones[5]);
    vec3 p = vec3(0.0);
    for (int k = 0; k < 4; k++) {
        if (aWeights[k] > 0.0) {
            int joint = int(aJoints[k]) * 3;
            vec4 rows[6] = original;
            p += vec3(dot(rows[joint], aPosition), dot(rows[joint + 1], aPosition), dot(rows[joint + 2], aPosition)) * aWeights[k];
        }
    }
    gl_Position = vec4(p, 1.0);
}
`;
  const result = lowerGlsl100Arrays(source);
  expect(result).not.toMatch(/vec4\[\]|\[6\] =/);
  for (let i = 0; i < 6; i++) {
    expect(result).toContain(`original[${i}] = uBones[${i}];`);
    expect(result).toContain(`rows[${i}] = original[${i}];`);
  }
  expect(result).toContain(source.split("            p +=")[1].split("\n")[0]);
  expect(result).toContain("if (aWeights[k] > 0.0)");
  expect(result).toContain("int joint = int(aJoints[k]) * 3;");
  expect(lowerGlsl100Arrays(result)).toBe(result);
  const output = resolve(import.meta.dir, "../.pocket-build/validation/ipod/glsl100-arrays");
  mkdirSync(output, { recursive: true });
  const vertex = join(output, "skinning.vert"), fragment = join(output, "skinning.frag");
  writeFileSync(vertex, result);
  writeFileSync(fragment, "#version 100\nprecision mediump float;\nvoid main(){gl_FragColor=vec4(1.0);}\n");
  const linked = Bun.spawnSync(["glslangValidator", "-l", vertex, fragment], { stdout: "pipe", stderr: "pipe" });
  expect(linked.exitCode, linked.stdout.toString() + linked.stderr.toString()).toBe(0);
});

test("array initializers retain precision, nested arguments, element order and declaration scope", () => {
  const source = `void main() {
    mediump vec2 a[2] = vec2[2](vec2(1.0, 2.0),
        mix(vec2(3.0), vec2(4.0), 0.5));
    if (true) {
        mediump vec2 b[2] = a;
    }
}`;
  expect(lowerGlsl100Arrays(source)).toBe(`void main() {
    mediump vec2 a[2];
    a[0] = vec2(1.0, 2.0);
    a[1] = mix(vec2(3.0), vec2(4.0), 0.5);
    if (true) {
        mediump vec2 b[2];
        b[0] = a[0];
        b[1] = a[1];
    }
}`);
  const unchanged = "uniform vec4 uBones[24];\nvoid main() { vec4 a[3]; a[0] = uBones[2]; }";
  expect(lowerGlsl100Arrays(unchanged)).toBe(unchanged);
});

test("unsupported array lifetime and malformed constructors fail rather than emitting invalid GLSL", () => {
  for (const source of ["vec4 a[2] = vec4[](vec4(1.0), vec4(2.0));",
    "void main() {\n const vec4 a[2] = vec4[](vec4(1.0),vec4(2.0));\n}",
    "void main() {\n vec4 a[2] = vec4[3](vec4(1.0),vec4(2.0));\n}",
    "void main() {\n vec4 a[2] = vec4[](vec4(1.0));\n}",
    "void main() {\n vec4 a[2] = unknownArrayFunction();\n}"])
    expect(() => lowerGlsl100Arrays(source)).toThrow();
});
