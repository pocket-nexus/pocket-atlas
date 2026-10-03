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
  expect(samplerDeclarations("uniform samplerCube uEnv;")).toEqual(["uEnv"]);
  expect(() => samplerDeclarations("uniform sampler3D uEnv;")).toThrow("Unsupported");
  expect(() => samplerDeclarations("uniform sampler2D tex[SLOTS];")).toThrow("Unsupported");
});

test("wet response samplers remain resident and their exact program identity joins the manifest", () => {
  const sources: Record<string, string> = {
    v: "", resolve: "uniform sampler2D uAlbedo, uWetResponse;",
    response: "uniform sampler2D uPuddles, uRipples, uDisplayReflSharp, uDisplayReflBlur;",
    sky: "uniform sampler2D uClouds;",
  };
  const manifest = textureUsage([
    { performance: ["v", "resolve"], wet_response: ["v", "response"] },
    { performance: ["v", "resolve"], wet_response: null },
  ], ["v", "sky"], key => sources[key]);
  expect(manifest.draws[0]).toEqual({
    program: ["v", "resolve"], response_program: ["v", "response"],
    samplers: ["uAlbedo", "uDisplayReflBlur", "uDisplayReflSharp", "uPuddles", "uRipples", "uWetResponse"],
  });
  expect(manifest.draws[1]).not.toHaveProperty("response_program");
  expect(manifest.sky).not.toHaveProperty("response_program");
});

test("water response retains normal and environment samplers independently of wet response", () => {
  const sources: Record<string, string> = {
    v: "", resolve: "uniform sampler2D uWaterResponse;",
    water: "uniform sampler2D uNormalMap; uniform samplerCube uDisplayEnv;",
    sky: "",
  };
  const manifest = textureUsage([
    { performance: ["v", "resolve"], water_response: ["v", "water"] },
  ], ["v", "sky"], name => sources[name]);
  expect(manifest.draws[0]).toEqual({
    program: ["v", "resolve"], water_response_program: ["v", "water"],
    samplers: ["uDisplayEnv", "uNormalMap", "uWaterResponse"],
  });
  expect(manifest.draws[0]).not.toHaveProperty("response_program");
});

test("display reflection program participates in identity and sampler residency", () => {
  const sources: Record<string, string> = {
    v: "", main: "uniform sampler2D uPuddles;",
    reflection: "uniform sampler2D uEnv, uAtlasLut;", sky: "",
  };
  const manifest = textureUsage([
    { performance: ["v", "main"], performance_reflection: ["v", "reflection"] },
  ], ["v", "sky"], name => sources[name]);
  expect(manifest.draws[0]).toEqual({
    program: ["v", "main"], reflection_program: ["v", "reflection"],
    samplers: ["uAtlasLut", "uEnv", "uPuddles"],
  });
});
