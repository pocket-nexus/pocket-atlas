import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lowerGlsl100Arrays } from "./atlas-ipod-glsl";
import { hdrFragment } from "./atlas-ipod-hdr";
import { samplerDeclarations } from "./atlas-ipod-textures";
import { shader } from "./atlas-ipod-shaders";
import { windowParameterFragment, windowParameterVertex } from "./atlas-ipod-window";
import { windowRayFragment, windowRayVertex } from "./atlas-ipod-window-ray";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".pocket-build/validation/ipod/window-ray");
const read = (name: string) => readFileSync(join(root, "vita/shaders", name), "utf8");
const expand = (name: string): string => read(name).replace(/#include "([^"\n]+)"/g, (_, n) => expand(n));
const vertex = () => windowParameterVertex(expand("surface_v.cg"), expand("common.cgh"));
const fragment = () => windowParameterFragment(expand("window_f.cg"));

test("window ray lowering changes only the flat frame dataflow", () => {
  const old = fragment(), fs = windowRayFragment(old), vs = windowRayVertex(vertex());
  // Spatial illumination, room hit/coverage and all discrete decisions are
  // byte-identical to the parameter adapter after replacing just its ray.
  const spatial = (s: string) => s.slice(s.indexOf("        d.z = max"), s.indexOf("    // Pane:"));
  expect(spatial(fs)).toBe(spatial(old));
  for (const code of ["float3 d = normalize(vWindowRay);", "float dist = length(vWindowReflect);",
    "float dotNV = saturate(vWindowRay.z / dist);", "octUv(vWindowReflect)",
    "fogFactor(dist, uFog.w)", "return float4(color, dist);"])
    expect(fs).toContain(code);
  expect(fs).not.toMatch(/\bvWorld\b|\bvNormal\b|\bvTangent\b|\bcross\(|\breflect\(/);
  expect(vs).toContain("half3 windowNormal = (half3)normalize(n);");
  expect(vs).toContain("float3 windowN = normalize((float3)windowNormal);");
  expect(vs).toContain("float3 windowIncident = world - uEye.xyz;");
  expect(vs).toContain("oWindowReflect = reflect(windowIncident, windowN);");
  expect(vs).not.toMatch(/\boWorld\b|\boNormal\b|\boTangent\b/);
  expect(() => windowRayVertex(expand("surface_v.cg"))).toThrow("proved window parameter");
  expect(() => windowRayFragment(expand("window_f.cg"))).toThrow("proved window parameter");
  expect(() => windowRayFragment(old.replace("octUv(reflect(V, N))", "octUv(V)"))).toThrow("contract changed");
});

test("shader selection rejects unproved, animated and reflection ray combinations", () => {
  expect(() => shader("window_f",{SGX_WINDOW_RAY_PARAMS:1})).toThrow("window parameter recipe");
  expect(() => shader("window_f",{SGX_WINDOW_RAY_PARAMS:1,SGX_WINDOW_PARAMS:1,REFLECTION:1})).toThrow("main interior-window pair");
  const invalid: Record<string, number>[] = [{}, {STATIC_WORLD:1,SKINNED:1}, {STATIC_WORLD:1,SUN:1}];
  for (const extra of invalid) {
    expect(() => shader("surface_v",{COLOR:1,TANGENT:1,SGX_WINDOW_PARAMS:1,SGX_WINDOW_RAY_PARAMS:1,...extra}))
      .toThrow("static main window pair");
  }
});

function run(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(args.join(" ") + "\n" + result.stdout + result.stderr);
  return result.stdout.toString();
}

// This test compiles the optional source in its own ignored directory. It does
// not call shader(), modify that cache, or select the adapter in a pipeline.
function compile(stage: "vert" | "frag", source: string, defines: Record<string, number>, name: string): string {
  const glslang = process.env.ATLAS_TEST_GLSLANG ?? "glslangValidator";
  const cross = process.env.ATLAS_TEST_SPIRV_CROSS ?? "spirv-cross";
  const hlsl = join(output, name + ".hlsl"), spv = join(output, name + ".spv");
  writeFileSync(hlsl, source.replace(/: POSITION\b/g, ": SV_Position")
    .replace(/: COLOR\b/g, ": SV_Target").replace(/\bhalf([234]?)\b/g, "min16float$1"));
  run([glslang, "-D", "--hlsl-dx9-compatible", "--auto-map-bindings", "--auto-map-locations", "-V", "-S", stage,
    "-e", "main", ...Object.entries(defines).map(([k, v]) => `-D${k}=${v}`), hlsl, "-o", spv]);
  let glsl = lowerGlsl100Arrays(run([cross, spv, "--es", "--version", "100"]));
  for (const block of [...glsl.matchAll(/struct (\w+)\n\{\n([\s\S]*?)\n\};\n/g)]) {
    const declaration = new RegExp(`uniform ${block[1]} (\\w+);`), instance = glsl.match(declaration);
    if (instance) glsl = glsl.replace(block[0], block[2].split("\n").map(l => "uniform " + l.trim()).join("\n") + "\n")
      .replace(declaration, "").replace(new RegExp(`\\b${instance[1]}\\.`, "g"), "");
  }
  glsl = glsl.replace(/\bo(World|Normal|Tangent|Uv|Haze|RoomA|RoomB|RoomC|WindowRay|WindowReflect)\b/g, "v$1")
    .replace(/uniform highp (sampler2D|samplerCube)/g, "uniform mediump $1")
    .replace(/uniform highp vec4 (u(?:Base|Emissive|Pbr|EnvK|Wet2?|ReflOn|HemiSky|HemiGround))\b/g, "uniform mediump vec4 $1");
  if (stage === "frag") glsl = hdrFragment(glsl, "window_f", defines);
  writeFileSync(join(output, name + "." + stage), glsl);
  return glsl;
}

test("optional ray pair links with six or seven varying vectors and unchanged samplers", () => {
  mkdirSync(output, { recursive: true });
  const metrics: unknown[] = [];
  for (const fog of ["none", "FOG", "VISTA"]) {
    const vd = { COLOR: 1, TANGENT: 1, STATIC_WORLD: 1, FLOAT_VERTEX: 1, SGX_WINDOW_PARAMS: 1,
      ...(fog === "VISTA" ? { VISTA: 1 } : {}) };
    const fd = { ATLAS_LDR: 1, ATLAS_BLEND: 0, ...(fog === "none" ? {} : { [fog]: 1 }) };
    const before = compile("frag", fragment(), fd, fog + "-reference");
    const vs = compile("vert", windowRayVertex(vertex()), vd, fog + "-ray");
    const fs = compile("frag", windowRayFragment(fragment()), fd, fog + "-ray");
    const varyings = [...fs.matchAll(/^varying (?:highp |mediump |lowp )?vec([234]) (\w+);/gm)];
    expect(varyings.length).toBe(fog === "VISTA" ? 7 : 6);
    expect(varyings.reduce((sum, m) => sum + +m[1], 0)).toBe(fog === "VISTA" ? 24 : 20);
    for (const name of ["vWindowRay", "vWindowReflect"]) {
      expect(fs).toContain(`varying highp vec3 ${name};`);
      expect(vs).toMatch(new RegExp(`varying (?:highp )?vec3 ${name};`));
    }
    expect(fs).not.toMatch(/\bvWorld\b|\bvNormal\b|\bvTangent\b|\bcross\(|\breflect\(|\buEye\b/);
    expect(fs.match(/\bnormalize\(/g)).toHaveLength(1);
    expect(fs.match(/\blength\(/g)).toHaveLength(1);
    expect(fs).toMatch(/highp vec3 \w+ = normalize\(vWindowRay\);/);
    expect(fs).not.toMatch(/texture2D\(uPuddles,\s*mp_copy_|(?:floor|fract)\(mp_copy_/);
    expect(samplerDeclarations(fs)).toEqual(samplerDeclarations(before));
    expect(fs.match(/\bsin\(/g)).toHaveLength(1);
    expect(vs.match(/\bsin\(/g)).toHaveLength(2);
    const paths = [join(output, fog + "-ray.vert"), join(output, fog + "-ray.frag")];
    run([process.env.ATLAS_TEST_GLSLANG ?? "glslangValidator", "-l", ...paths]);
    metrics.push({ fog, vertexBytes: vs.length, fragmentBytes: fs.length, referenceFragmentBytes: before.length,
      varyingVectors: varyings.length, fragmentNormalize: (fs.match(/\bnormalize\(/g) ?? []).length,
      referenceNormalize: (before.match(/\bnormalize\(/g) ?? []).length });
  }
  writeFileSync(join(output, "shaders.json"), JSON.stringify(metrics, null, 2));
}, 30_000);

type V = [number, number, number];
type Frame = { n: V; t: V; b: V };
const dot = (a: V, b: V) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const scale = (a: V, k: number): V => a.map(x => x*k) as V;
const sub = (a: V, b: V): V => a.map((x,k) => x-b[k]) as V;
const norm = (a: V): V => scale(a, 1/Math.sqrt(dot(a,a)));
const cross = (a: V,b: V): V => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const project = (i: V, f: Frame): V => [dot(i,f.t),dot(i,f.b),-dot(i,f.n)];
const reflect = (i: V, n: V): V => sub(i,scale(n,2*dot(n,i)));
const oct = (a: V): number[] => {
  let [x,y,z] = scale(a,1/(Math.abs(a[0])+Math.abs(a[1])+Math.abs(a[2])));
  if (y<0) [x,z]=[(1-Math.abs(z))*(x>=0?1:-1),(1-Math.abs(x))*(z>=0?1:-1)];
  return [x*.5+.5,z*.5+.5];
};
const difference = (a: number[], b: number[]) => Math.max(...a.map((v,k) => Math.abs(v-b[k])));
function randomGenerator() {
  let state=0x70616e65;
  return () => { state ^= state<<13; state ^= state>>>17; state ^= state<<5; return (state>>>0)/4294967296; };
}

test("perspective interpolation commutes with a constant skew frame, preserving distance and Fresnel sign", () => {
  const random=randomGenerator();
  for(let k=0;k<4096;k++) {
    const n=norm([random()-.5,random()-.5,random()-.5]);
    const t=norm(Math.abs(n[0])<.8 ? cross(n,[1,0,0]) : cross(n,[0,1,0]));
    // A skew tangent is deliberately included: normalising projected unit V
    // and projected unnormalised I still gives the same room direction.
    const f:Frame={n,t:norm(sub(t,scale(n,(random()-.5)*1.5))),b:[0,0,0]};
    f.b=scale(cross(f.n,f.t),k&1?-1:1);
    const rays=Array.from({length:3},():V=>[random()*40-20,random()*40-20,random()*40-20]);
    const q=[random()/(.1+random()),random()/(.1+random()),random()/(.1+random())];
    const w=q.map(v=>v/q.reduce((s,x)=>s+x,0));
    const interpolate=(v:V[]):V=>[0,1,2].map(c=>v.reduce((s,a,j)=>s+a[c]*w[j],0)) as V;
    const i=interpolate(rays), ray=interpolate(rays.map(r=>project(r,f))), r=interpolate(rays.map(r=>reflect(r,n)));
    const d=Math.sqrt(dot(i,i)), rd=Math.sqrt(dot(r,r));
    expect(difference(norm(project(norm(i),f)),norm(ray))).toBeLessThan(3e-14);
    expect(Math.abs(rd/d-1)).toBeLessThan(2e-14);
    expect(Math.abs(-dot(n,norm(i))-ray[2]/rd)).toBeLessThan(2e-14);
    expect(difference(oct(reflect(norm(i),n)),oct(r))).toBeLessThan(2e-14);
  }
});

test("float32 ray transport is bounded across half frames, near views, mirrors and perspective interpolation", () => {
  const f=Math.fround, halfStorage=new Float16Array(1), random=randomGenerator();
  const half=(x:number)=>{halfStorage[0]=x;return halfStorage[0];};
  const fdot=(a:V,b:V)=>f(f(f(a[0]*b[0])+f(a[1]*b[1]))+f(a[2]*b[2]));
  const fscale=(a:V,k:number)=>a.map(x=>f(x*k)) as V;
  const fsub=(a:V,b:V)=>a.map((x,k)=>f(x-b[k])) as V;
  const fnorm=(a:V)=>fscale(a,f(1/Math.sqrt(fdot(a,a))));
  const fcross=(a:V,b:V):V=>[f(f(a[1]*b[2])-f(a[2]*b[1])),f(f(a[2]*b[0])-f(a[0]*b[2])),f(f(a[0]*b[1])-f(a[1]*b[0]))];
  const fproject=(i:V,frame:Frame):V=>[fdot(i,frame.t),fdot(i,frame.b),-fdot(i,frame.n)];
  const freflect=(i:V,n:V)=>fsub(i,fscale(n,f(2*fdot(n,i))));
  const clamp=(d:V):V=>[d[0]>=0?Math.max(d[0],1e-4):Math.min(d[0],-1e-4),d[1]>=0?Math.max(d[1],1e-4):Math.min(d[1],-1e-4),Math.max(d[2],.05)];
  const metrics={samples:32768,maxDirection:0,maxRelativeDistance:0,maxFresnel:0,maxOctUv:0,maxRoomHit:0,maxReflectionLength:0,faceChanges:0};
  for(let k=0;k<metrics.samples;k++) {
    const originalN=norm([random()-.5,random()-.5,random()-.5]);
    const perpendicular=norm(Math.abs(originalN[0])<.8?cross(originalN,[1,0,0]):cross(originalN,[0,1,0]));
    const originalT=norm(sub(perpendicular,scale(originalN,(random()-.5)*1.5)));
    const mirror:V=[1,k&1?-1:1,1];
    const hn=fnorm(originalN.map((x,c)=>f(x*mirror[c])) as V).map(half) as V;
    const ht=fnorm(originalT.map((x,c)=>f(x*mirror[c])) as V).map(half) as V;
    const frame:Frame={n:fnorm(hn),t:fnorm(ht),b:[0,0,0]};
    frame.b=fscale(fcross(frame.n,frame.t),k&2?-1:1);
    const centre:V=[f((random()-.5)*2048),f((random()-.5)*2048),f((random()-.5)*2048)];
    const size=.25+random()*16;
    const vertices=[centre,sub(centre,scale(originalT,size)),sub(centre,scale(cross(originalN,originalT),size))].map(v=>v.map(f) as V);
    const q=[random()/(.1+random()),random()/(.1+random()),random()/(.1+random())];
    const w=q.map(x=>f(x/q.reduce((s,v)=>s+v,0)));
    const interpolate=(v:V[]):V=>[0,1,2].map(c=>f(f(f(v[0][c]*w[0])+f(v[1][c]*w[1]))+f(v[2][c]*w[2]))) as V;
    // The old half varyings also pass through the interpolator. A constant
    // triangle remains the same binary16 value in this float32-weight model.
    const oldN=fnorm(interpolate([hn,hn,hn]).map(half) as V);
    const oldT=fnorm(interpolate([ht,ht,ht]).map(half) as V);
    const oldFrame:Frame={n:oldN,t:oldT,b:fscale(fcross(oldN,oldT),k&2?-1:1)};
    const world=interpolate(vertices), distance=.5+4096*random()**4;
    const eye=sub(world,scale(norm([random()-.5,random()-.5,random()-.5]),distance)).map(f) as V;
    const incident=fsub(world,eye), oldDistance=f(Math.sqrt(fdot(incident,incident)));
    const ray=interpolate(vertices.map(v=>fproject(fsub(v,eye),frame)));
    const reflection=interpolate(vertices.map(v=>freflect(fsub(v,eye),frame.n)));
    const newDistance=f(Math.sqrt(fdot(reflection,reflection)));
    const oldV=fscale(incident,f(1/oldDistance)), oldDirection=clamp(fnorm(fproject(oldV,oldFrame))), newDirection=clamp(fnorm(ray));
    metrics.maxDirection=Math.max(metrics.maxDirection,difference(oldDirection,newDirection));
    metrics.maxRelativeDistance=Math.max(metrics.maxRelativeDistance,Math.abs(newDistance/oldDistance-1));
    metrics.maxReflectionLength=Math.max(metrics.maxReflectionLength,Math.abs(Math.sqrt(fdot(freflect(incident,frame.n),freflect(incident,frame.n)))/oldDistance-1));
    metrics.maxFresnel=Math.max(metrics.maxFresnel,Math.abs(Math.max(0,Math.min(1,-fdot(oldFrame.n,oldV)))-Math.max(0,Math.min(1,ray[2]/newDistance))));
    metrics.maxOctUv=Math.max(metrics.maxOctUv,difference(oct(freflect(oldV,oldFrame.n)),oct(reflection)));
    const room:V=[1.7+random()*8,2.6,3.2+random()*2.5], p:V=[.7+random()*(room[0]-1.4),.18+random()*1.4,0];
    const hit=(d:V)=>{
      const ts=[(d[0]>0?room[0]-p[0]:-p[0])/d[0],(d[1]>0?room[1]-p[1]:-p[1])/d[1],room[2]/d[2]];
      const t=Math.min(...ts); return {p:sub(p,scale(d,-t)),face:ts.indexOf(t)};
    };
    const a=hit(oldDirection),b=hit(newDirection);
    metrics.maxRoomHit=Math.max(metrics.maxRoomHit,difference(a.p,b.p));
    metrics.faceChanges+=+(a.face!==b.face);
  }
  // Finite, deterministic test domain; this is not a global image-error bound.
  // Discontinuous furniture/face decisions can still differ arbitrarily close
  // to an edge, so report hit displacement rather than asserting RGB equality.
  expect(metrics.maxDirection).toBeLessThan(0.001);
  expect(metrics.maxRelativeDistance).toBeLessThan(0.001);
  expect(metrics.maxFresnel).toBeLessThan(0.001);
  expect(metrics.maxReflectionLength).toBeLessThan(0.000002);
  expect(metrics.maxOctUv).toBeLessThan(0.001);
  expect(metrics.maxRoomHit).toBeLessThan(0.03);
  mkdirSync(output,{recursive:true});
  writeFileSync(join(output,"float32.json"),JSON.stringify(metrics,null,2));
});
