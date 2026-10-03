import { expect, test } from "bun:test";
import { BLOOM_RADIANCE_LIMIT, BLOOM_RGBM_RANGE, bloomStorage, withoutBloomHaze, pointCoverage, displayHazeDepth, displayBloomSource, displayHazeBloomSource, displayFieldWeight } from "./atlas-ipod-effects";
import { hdrFragment } from "./atlas-ipod-hdr";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const byte = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255) / 255;

test("field density scales final display energy after the original LUT and coverage", () => {
  const original = `precision mediump float;
uniform sampler2D uAtlasLut;
void main() { gl_FragColor=vec4(texture2D(uAtlasLut,vec2(0.5)).rgb*0.25,0.25); }`;
  const source = displayFieldWeight(original);
  expect(source.replace("void atlasField()", "void main()").slice(0, original.length)).toBe(original);
  expect(source).toContain("atlasField();\n gl_FragColor.rgb*=vDensity;");
  expect(source).not.toContain("gl_FragColor.a*=");
  expect(() => displayFieldWeight("void main() {}")).toThrow();
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-effects-tests/density");
  mkdirSync(directory, { recursive: true });
  const vert=join(directory,"density.vert"),frag=join(directory,"density.frag");
  writeFileSync(vert,"attribute vec4 aPosition; attribute float aUv; varying mediump float vDensity; void main(){gl_Position=aPosition;vDensity=aUv;}");
  writeFileSync(frag,source);
  const result=Bun.spawnSync(["glslangValidator","-l",vert,frag],{stdout:"pipe",stderr:"pipe"});
  expect(result.exitCode,result.stdout.toString()+result.stderr.toString()).toBe(0);
});

test("cached field phase removes only the vertex sine and leaves full/Vita defaults intact", () => {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-effects-tests/phase");
  mkdirSync(directory, { recursive: true });
  const expand = (name: string): string => readFileSync(resolve(import.meta.dir, "../vita/shaders", name), "utf8")
    .replace(/#include "([^"\n]+)"/g, (_, include: string) => expand(include));
  const hlsl = join(directory, "lights.hlsl");
  writeFileSync(hlsl, expand("lights_v.cg").replace(/: POSITION\b/g, ": SV_Position"));
  for (const vista of [false, true]) for (const cached of [false, true]) {
    const spv = join(directory, `lights-${Number(vista)}-${Number(cached)}.spv`);
    const args = ["glslangValidator", "-D", "--hlsl-dx9-compatible", "--auto-map-bindings", "--auto-map-locations",
      "-V", "-S", "vert", "-e", "main", ...(vista ? ["-DVISTA=1"] : []),
      ...(cached ? ["-DPHASE_CACHED=1"] : []), hlsl, "-o", spv];
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    const translated = Bun.spawnSync(["spirv-cross", spv, "--es", "--version", "100"], { stdout: "pipe", stderr: "pipe" });
    expect(translated.exitCode, translated.stderr.toString()).toBe(0);
    const source = translated.stdout.toString();
    expect(/\bsin\s*\(/.test(source)).toBe(!cached);
    expect(/attribute vec2 aPhase;/.test(source)).toBe(cached);
    // Motion, periodic blinking, physical sprite size, energy and haze
    // remain part of both programs; no source light is dropped by this path.
    expect(source).toContain("aPath");
    expect(source).toContain("aBlink");
    expect(source).toContain("gl_PointSize");
    expect(source).toContain("aLight");
    expect(/\bexp2\s*\(/.test(source)).toBe(vista);
  }
});

const clampRadiance = (c: number[]) => c.map(x => Math.max(0, Math.min(BLOOM_RADIANCE_LIMIT, x)));
function encode(c: number[]): number[] {
  c = clampRadiance(c);
  const m = Math.max(1, Math.ceil(Math.max(...c) * 255 / BLOOM_RGBM_RANGE)) / 255;
  return [...c.map(x => byte(x / (m * BLOOM_RGBM_RANGE))), byte(m)];
}
const decode = (c: number[]) => c.slice(0, 3).map(x => x * c[3] * BLOOM_RGBM_RANGE);

test("RGBM quantization is bounded, finite and preserves the existing radiance limit", () => {
  for (let exponent = -4; exponent <= Math.log10(126); exponent += 0.025) {
    for (const ratio of [[1, 1, 1], [1, 0.1, 0.01], [0.05, 0.8, 1]]) {
      const color = ratio.map(x => 10 ** exponent * x);
      const packed = encode(color);
      const decoded = decode(packed);
      const halfStep = packed[3] * BLOOM_RGBM_RANGE / 510;
      for (let c = 0; c < 3; c++) {
        expect(Number.isFinite(decoded[c])).toBe(true);
        expect(Math.abs(decoded[c] - color[c])).toBeLessThanOrEqual(halfStep + 1e-6);
      }
      expect(packed.every(x => x >= 0 && x <= 1)).toBe(true);
    }
  }
  expect(decode(encode([0, 0, 0]))).toEqual([0, 0, 0]);
  const clipped = decode(encode([200, -1, 126]));
  expect(clipped[0]).toBeCloseTo(126, 0);
  expect(clipped[1]).toBe(0);
  expect(clipped[2]).toBeCloseTo(126, 0);
});

// A single coloured light through the actual five-tap downsample pattern,
// including RGBA8 quantization and hardware bilinear interpolation. RGBM
// interpolation is approximate; this checks that it loses less bright-point
// energy than bilinear interpolation of the main nonlinear HDR encoding.
test("a bright isolated light survives the bloom downsample better than the scene codec", () => {
  const pixels = Array.from({ length: 32 * 32 }, (_, i) => i === 16 * 32 + 16 ? [24, 12, 3] : [0, 0, 0]);
  const filter = (pack: (c: number[]) => number[], unpack: (c: number[]) => number[]) => {
    const source = pixels.map(pack);
    const energy = [0, 0, 0];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      for (const [dx, dy, weight] of [[0, 0, 0.5], [-1, -1, 0.125], [1, 1, 0.125], [1, -1, 0.125], [-1, 1, 0.125]]) {
        const sx = x * 2 + 0.5 + dx, sy = y * 2 + 0.5 + dy;
        const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
        const sample = [0, 0, 0, 0];
        for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
          const c = source[Math.min(31, Math.max(0, iy + j)) * 32 + Math.min(31, Math.max(0, ix + k))];
          const w = (k ? fx : 1 - fx) * (j ? fy : 1 - fy);
          for (let channel = 0; channel < 4; channel++) sample[channel] += c[channel] * w;
        }
        const color = unpack(sample);
        for (let channel = 0; channel < 3; channel++) energy[channel] += color[channel] * weight;
      }
    }
    return energy;
  };
  const reference = filter(c => [...c, 1], c => c.slice(0, 3));
  const mainHdr = filter(c => [...c.map(x => byte(Math.sqrt(x / (1 + x)))), 0],
    c => c.slice(0, 3).map(x => x * x / Math.max(1 - x * x, 1 / 255)));
  const rgbm = filter(encode, decode);
  expect(reference).toEqual([6, 3, 0.75]);
  for (let c = 0; c < 3; c++) {
    expect(rgbm[c]).toBeGreaterThan(mainHdr[c]);
    expect(rgbm[c]).toBeLessThanOrEqual(reference[c]);
  }
  expect(rgbm[0] / rgbm[1]).toBeCloseTo(2, 4);
  expect(Math.abs(rgbm[0] / rgbm[2] / 8 - 1)).toBeLessThan(0.01);
});

const shader = `#version 100
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uHazeTex;
uniform vec4 uThreshold;
varying vec2 vUv;
highp vec4 atlasDecode(highp vec4 c) {
 highp vec3 q=c.rgb*c.rgb;
 return vec4(q/max(vec3(1.0)-q,vec3(1.0/255.0)),exp2(c.a*16.0)-1.0);
}
highp vec4 atlasEncode(highp vec4 c) {
 highp vec3 rgb=clamp(c.rgb,vec3(0.0),vec3(126.0));
 return vec4(sqrt(rgb/(vec3(1.0)+rgb)),log2(1.0+c.a)/16.0);
}
void main() {
 highp vec3 c=atlasDecode(texture2D(uScene,vUv)).rgb;
 highp vec3 h=atlasDecode(texture2D(uHazeTex, vUv)).rgb*uThreshold.z;
 gl_FragColor=atlasEncode(vec4(c+h,1.0));
}`;

test("codec direction keeps scene inputs and the public bloom output in the main format", () => {
  const prefilter = bloomStorage(shader, "write");
  expect(prefilter).toContain("q/max");
  expect(prefilter).toContain("ceil(m*");
  const blur = bloomStorage(shader, "both");
  expect(blur).toContain("c.rgb*(c.a*128.0)");
  expect(blur).not.toContain("sqrt(");
  expect(blur).not.toContain("log2(");
  expect(blur).not.toContain("exp2(");
  const final = bloomStorage(shader, "read");
  expect(final).toContain("c.rgb*(c.a*128.0)");
  expect(final).toContain("sqrt(rgb/(vec3(1.0)+rgb))");
  expect(final).not.toContain("ceil(m*");
});

test("no-haze variant removes its sampler read and malformed codec contracts fail explicitly", () => {
  const lean = withoutBloomHaze(bloomStorage(shader, "write"));
  expect(lean).not.toContain("texture2D(uHazeTex");
  expect(lean).toContain("texture2D(uScene");
  expect(() => bloomStorage("void main(){}", "both")).toThrow("Missing HDR codec");
  expect(() => withoutBloomHaze(bloomStorage(shader.replace("uHazeTex, vUv", "anotherSampler, vUv"), "write"))).toThrow("Missing bloom haze sample");
});

test("LDR point coverage preserves the shared radial profile and fails on changed output", () => {
  const source = "atlasColor = vec4(vColor * (_71 * _71), 0.0);";
  expect(pointCoverage(source)).toBe("atlasColor = vec4(vColor * (_71 * _71), _71 * _71);");
  expect(() => pointCoverage("atlasColor = vec4(vColor, 0.0);")).toThrow("Missing shared point-light");
});

test("LDR haze reads inverse depth without decoding display RGB", () => {
  const source = displayHazeDepth(shader);
  expect(source).toContain("vec4(c.rgb, 32.0*(1.0/max(c.a,1e-6)-1.0))");
  expect(source).not.toContain("exp2(c.a");
  expect(source).not.toContain("q/max");
});

test("LDR bloom compiles and samples display RGB without a tone or codec", () => {
  const output = resolve(import.meta.dir, "../.pocket-build/validation/ipod-effects-tests");
  mkdirSync(output, { recursive: true });
    const source = displayBloomSource();
    expect(source).not.toContain("uHazeTex");
    expect(source).not.toMatch(/atlasDecode|atlasEncode|uAtlasLut|gl_LastFragData/);
    const path = join(output, "bloom-ldr.frag");
    writeFileSync(path, source);
    const result = Bun.spawnSync(["glslangValidator", "-S", "frag", path], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
});

test("CPU particle variants exclude lighting before compilation and link the original coverage shader", () => {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-effects-tests/display-color");
  mkdirSync(directory, { recursive: true });
  const run = (args: string[]) => {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  const compile = (stage: "vert" | "frag", kind: string, display: boolean) => {
    const name = stage === "vert" ? "fx_v" : "fx_f";
    const key = `${kind}-${display ? "display" : "full"}-${stage}`;
    const hlsl = join(directory, `${key}.hlsl`), spv = join(directory, `${key}.spv`);
    const source = readFileSync(resolve(import.meta.dir, `../vita/shaders/${name}.cg`), "utf8")
      .replace(/: POSITION\b/g, ": SV_Position")
      .replace(/: COLOR\b/g, ": SV_Target")
      .replace(/\bhalf([234]?)\b/g, "min16float$1");
    writeFileSync(hlsl, source);
    const defines = [`-D${kind}=1`, ...(display && stage === "vert" ? ["-DDISPLAY_COLOR=1"] : [])];
    if (stage === "vert") {
      const preprocessed = run(["glslangValidator", "-D", "-E", "-S", stage, ...defines, hlsl]);
      expect(preprocessed.includes("lightAt")).toBe(!display);
      expect(preprocessed.includes("uFogPos")).toBe(!display);
      expect(preprocessed.includes("uFogCol")).toBe(!display);
      expect(preprocessed.includes("uAmbient")).toBe(!display);
      expect(preprocessed.includes("aColor")).toBe(display);
      // Geometry, hidden rejection, UVs and lifetime outputs exist in both.
      for (const output of ["oPosition", "oUv", "oLife"]) expect(preprocessed).toContain(output);
    }
    run(["glslangValidator", "-D", "--hlsl-dx9-compatible", "--auto-map-bindings", "--auto-map-locations",
      "-V", "-S", stage, "-e", "main", ...defines, hlsl, "-o", spv]);
    return run(["spirv-cross", spv, "--es", "--version", "100"])
      .replace(/\bo(Color|Uv|Life)\b/g, "v$1");
  };
  for (const kind of ["STREAK", "DRIP", "SPLASH", "STEAM", "BEACON"]) {
    const vertex = compile("vert", kind, true);
    compile("vert", kind, false);
    expect(vertex).not.toMatch(/uFogPos|uFogCol|uAmbient|lightAt/);
    expect(vertex).toMatch(/attribute (?:mediump )?vec4 aColor;/);
    expect(vertex).toMatch(/vColor = aColor\.(?:rgb|xyz);/);
    const fragment = hdrFragment(compile("frag", kind === "DRIP" ? "STREAK" : kind, true), "fx_f",
      { ATLAS_LDR: 1, ATLAS_OUTPUT_LDR: 1, ATLAS_BLEND: kind === "STEAM" ? 3 : 2 });
    expect(fragment).not.toMatch(/uAtlasLut|gl_LastFragData|atlasDisplay/);
    expect(fragment).toContain("gl_FragColor=vec4(atlasColor.rgb,clamp(atlasColor.a,0.0,1.0))");
    const vert = join(directory, `${kind}.vert`), frag = join(directory, `${kind}.frag`);
    writeFileSync(vert, vertex);
    writeFileSync(frag, fragment);
    const reflection = run(["glslangValidator", "-l", "-q", vert, frag]);
    expect(reflection).not.toMatch(/uFogPos|uFogCol|uAmbient/);
  }
});

// Compile the real shared haze independently of the global asset generator.
// Its translated integration body must survive fusion byte-for-byte apart
// from the coordinate of the one nearest-depth sample.
function translatedDisplayHaze(): string {
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-effects-tests/fused");
  mkdirSync(directory, { recursive: true });
  const run = (args: string[]) => {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  const hlsl = join(directory, "haze.hlsl"), spv = join(directory, "haze.spv");
  writeFileSync(hlsl, readFileSync(resolve(import.meta.dir, "../vita/shaders/haze_f.cg"), "utf8")
    .replace(/: COLOR\b/g, ": SV_Target"));
  run(["glslangValidator", "-D", "--hlsl-dx9-compatible", "--auto-map-bindings", "--auto-map-locations",
    "-V", "-S", "frag", "-e", "main", "-DHAZE_LIGHTS=6", hlsl, "-o", spv]);
  let glsl = run(["spirv-cross", spv, "--es", "--version", "100"]);
  for (const block of [...glsl.matchAll(/struct (\w+)\n\{\n([\s\S]*?)\n\};\n/g)]) {
    const re = new RegExp(`uniform ${block[1]} (\\w+);`), instance = glsl.match(re);
    if (instance) glsl = glsl.replace(block[0], block[2].split("\n").map(l => "uniform " + l.trim()).join("\n") + "\n")
      .replace(re, "").replace(new RegExp(`\\b${instance[1]}\\.`, "g"), "");
  }
  return displayHazeDepth(hdrFragment(glsl, "haze_f", { ATLAS_LDR: 1, ATLAS_BLEND: 2 }));
}

test("fused display effects retain the shared six-light integral and use nearest depth with linear bloom", () => {
  const original = translatedDisplayHaze();
  const fused = displayHazeBloomSource(original);
  const integral = (s: string) => s.slice(s.indexOf("void atlasMaterial()"), s.indexOf("uniform mediump sampler2D uAtlasLut;"));
  expect(integral(fused).replace("(floor(vUv*uSceneTexel.zw)+0.5)*uSceneTexel.xy", "vUv")).toBe(integral(original));
  expect(fused).not.toMatch(/uHazeTex|gl_LastFragData/);
  expect(fused.match(/texture2D\(uScene,/g)?.length).toBe(5); // One depth plus the original four RGB taps.
  expect(fused).toContain("uFogPos[6]");
  expect(fused).toContain("uFogDir[6]");
  expect(fused).toContain("uAmbient");
  expect(fused).toContain("uCurtain");
  expect(() => displayHazeBloomSource("void main() {} ")).toThrow("Missing display haze contract");
  const directory = resolve(import.meta.dir, "../.pocket-build/validation/ipod-effects-tests/fused");
  const vert = join(directory, "fused.vert"), frag = join(directory, "fused.frag");
  writeFileSync(vert, `#version 100
attribute vec2 aPosition;
varying highp vec2 vUv;
varying highp vec3 vRay;
uniform highp vec4 uRayX,uRayY,uRayZ;
void main(){gl_Position=vec4(aPosition,0.5,1.0);vUv=aPosition*0.5+0.5;vRay=uRayZ.xyz+uRayX.xyz*aPosition.x+uRayY.xyz*aPosition.y;}`);
  writeFileSync(frag, fused);
  const result = Bun.spawnSync(["glslangValidator", "-l", "-q", vert, frag], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("uSceneTexel");
  expect(result.stdout.toString()).toContain("uEffectMix");
});

test("fused storage preserves threshold rounding and bounds the additional error after bilinear reconstruction", () => {
  let seed = 0x96d52ef1;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x-a)/(b-a)));
    return t*t*(3-2*t);
  };
  for (const intensity of [0, 0.35, 0.4, 0.85, 0.95, 4]) {
    const scale = 1 + intensity;
    for (const low of [0.05, 0.3, 0.6, 0.9]) for (const width of [0.025, 0.05, 0.25]) {
      const glow = (rgb: number[]) => {
        const k = smooth(low, low+width, rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722) * Math.max(1-low,0.08);
        return rgb.map(x => x*k);
      };
      for (let trial=0; trial<64; trial++) {
        const reference: number[][] = [], packed: number[][] = [];
        for (let corner=0; corner<4; corner++) {
          const haze = Array.from({length:3}, () => byte(random()));
          const samples = Array.from({length:4}, () => glow(Array.from({length:3}, random)));
          const hazeGlow = glow(haze);
          const bloom = hazeGlow.map((x,c) => byte(x + samples.reduce((a,s) => a+s[c],0)*0.25));
          const sum = haze.map((x,c) => x + bloom[c]*intensity);
          const encoded = sum.map(x => byte(x/scale));
          expect(encoded.every(x => x>=0 && x<=1)).toBe(true);
          reference.push(sum); packed.push(encoded);
        }
        const fx=random(),fy=random(), weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy];
        for(let c=0;c<3;c++) {
          const expected=weights.reduce((v,w,k) => v+w*reference[k][c],0);
          const actual=weights.reduce((v,w,k) => v+w*packed[k][c]*scale,0);
          expect(Math.abs(actual-expected)).toBeLessThanOrEqual(scale/510+1e-12);
        }
      }
    }
  }
});

test("snapped depth coordinates select the same source pixel including edge and silhouette boundaries", () => {
  for (const width of [160,213,320,426,480,640,960]) {
    for (let pixel=0;pixel<width;pixel++) for (const phase of [0,0.0001,0.4999,0.9999]) {
      const uv=(pixel+phase)/width;
      const nearest=Math.min(width-1,Math.floor(uv*width));
      const snapped=(Math.floor(uv*width)+0.5)/width;
      expect(Math.round(snapped*width-0.5)).toBe(nearest);
      expect(Math.abs(snapped*width-0.5-nearest)).toBeLessThan(1e-10);
    }
  }
});
