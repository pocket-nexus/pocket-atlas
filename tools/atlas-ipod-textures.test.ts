import { expect, test } from "bun:test";
import { samplerDeclarations, textureUsage } from "./atlas-ipod-textures";

test("samplers include both stages, arrays and unused declarations, excluding comments", () => {
  const sources: Record<string, string> = {
    v: "uniform highp sampler2D uVertex[2]; // uniform sampler2D omitted;\n",
    f: "/* uniform sampler2D ignored; */ uniform mediump sampler2D uAlbedo, uNormalMap; uniform float uValue;",
    sky: "uniform sampler2D uClouds; uniform sampler2D uAlbedo;",
  };
  expect(textureUsage([{ performance: ["v", "f"] }, null], ["v", "sky"], name => sources[name])).toEqual({
    version: 1,
    draws: [{ program: ["v", "f"], samplers: ["uAlbedo", "uNormalMap", "uVertex"] }, null],
    sky: { program: ["v", "sky"], samplers: ["uAlbedo", "uClouds", "uVertex"] },
  });
  expect(() => samplerDeclarations("uniform samplerCube uEnv;")).toThrow("Unsupported");
  expect(() => samplerDeclarations("uniform sampler2D tex[SLOTS];")).toThrow("Unsupported");
});
