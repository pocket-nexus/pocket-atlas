import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { lowerGlsl100Arrays } from "./atlas-ipod-glsl";
import { shader } from "./atlas-ipod-shaders";
import { unrollSkinVertex } from "./atlas-ipod-skin";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".pocket-build/validation/ipod/skin-unroll");
const source = readFileSync(join(root, "vita/shaders/surface_v.cg"), "utf8");

test("skin adapter changes only attribute slot selection and preserves all guarded contributions", () => {
  const lowered = unrollSkinVertex(source);
  expect(lowered).not.toMatch(/for \(int k|aWeights\[k\]|aJoints\[k\]/);
  expect(lowered.match(/if \(w > 0\.0\)/g)).toHaveLength(4);
  for (const accumulator of ["sp", "sn", "st"])
    expect(lowered.match(new RegExp(`${accumulator} \\+= w \\*`, "g"))).toHaveLength(4);
  let previous = -1;
  for (const component of "xyzw") {
    const at = lowered.indexOf(`float w = aWeights.${component};`);
    expect(at).toBeGreaterThan(previous);
    expect(lowered.slice(at)).toContain(`int j = (int)aJoints.${component} * 3;`);
    previous = at;
  }
  expect(lowered.slice(lowered.indexOf("    local = float4(sp, 1.0);")))
    .toBe(source.slice(source.indexOf("    local = float4(sp, 1.0);")));
  for (const broken of [source.replace("k < 4", "k < 3"), source.replace("aWeights[k]", "aWeights[k + 1]"),
    source.replace("if (w > 0.0)", "if (w >= 0.0)"), source.replace("int j =", "int unknown = k; int j =")])
    expect(() => unrollSkinVertex(broken)).toThrow("SGX skin contract changed");
});

test("slot expansion preserves float32 accumulation and never fetches zero-weight garbage joints", () => {
  let seed = 0x736b696e;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const f = Math.fround;
  for (let trial = 0; trial < 8192; trial++) {
    const weights = Array.from({length:4}, (_,slot) => trial % 16 & (1<<slot) ? 0 : Math.floor(random()*255)+1);
    const joints = weights.map(w => w ? Math.floor(random()*8) : 255);
    const bones = Array.from({length:8}, () => Array.from({length:12}, () => f(random()*8-4)));
    const p = [f(random()*100-50),f(random()*100-50),f(random()*100-50),1];
    const n = [f(random()*2-1),f(random()*2-1),f(random()*2-1),0];
    const t = [f(random()*2-1),f(random()*2-1),f(random()*2-1),0];
    const evaluate = (unrolled: boolean) => {
      const out = [0,0,0,0,0,0,0,0,0];
      const add = (slot:number) => {
        const w=f(weights[slot]/255);
        if (w>0) {
          const b=bones[joints[slot]];
          expect(b).toBeDefined();
          for (const [kind,v] of [p,n,t].entries()) for(let row=0;row<3;row++) {
            const d=f(f(f(f(b[row*4]*v[0])+f(b[row*4+1]*v[1]))+f(b[row*4+2]*v[2]))+f(b[row*4+3]*v[3]));
            out[kind*3+row]=f(out[kind*3+row]+f(w*d));
          }
        }
      };
      if(unrolled) { add(0);add(1);add(2);add(3); }
      else for(let k=0;k<4;k++) add(k);
      return out;
    };
    expect(evaluate(true)).toEqual(evaluate(false));
  }
});

function run(args: string[]): string {
  const result = Bun.spawnSync(args,{stdout:"pipe",stderr:"pipe"});
  if(result.exitCode) throw new Error(args.join(" ")+"\n"+result.stdout+result.stderr);
  return result.stdout.toString();
}

test("four-slot expansion compiles to constant attribute components on the selected Khronos toolchain", () => {
  mkdirSync(output,{recursive:true});
  const glslang=process.env.ATLAS_TEST_GLSLANG ?? "glslangValidator";
  const cross=process.env.ATLAS_TEST_SPIRV_CROSS ?? "spirv-cross";
  const rows=[];
  for(const display of [true,false]) for(const expanded of [false,true]) {
    const name=`test-${+display}-${+expanded}`;
    const hlsl=join(output,name+".hlsl"),spv=join(output,name+".spv"),vert=join(output,name+".vert");
    writeFileSync(hlsl,(expanded?unrollSkinVertex(source):source).replace(/#include "vista.cgh"/,"")
      .replace(/: POSITION\b/g,": SV_Position").replace(/\bhalf([234]?)\b/g,"min16float$1"));
    const defines={SKINNED:1,MAX_BONES:32,SKIP_ZERO_WEIGHTS:1,COLOR:1,...(display?{DISPLAY_COLOR:1,LDR_COLOR:1}:{TANGENT:1})};
    run([glslang,"-D","--hlsl-dx9-compatible","--auto-map-bindings","--auto-map-locations","-V","-S","vert","-e","main",
      ...Object.entries(defines).map(([k,v])=>`-D${k}=${v}`),hlsl,"-o",spv]);
    const glsl=lowerGlsl100Arrays(run([cross,spv,"--es","--version","100"]));
    writeFileSync(vert,glsl);
    run([glslang,"-S","vert",vert]);
    if(expanded) {
      expect(glsl).not.toMatch(/\bfor\s*\(|a(?:Weights|Joints)\[/);
      expect(glsl.match(/if \(aWeights\.[xyzw] > 0\.0\)/g)).toHaveLength(4);
      for(const component of "xyzw") expect(glsl).toContain(`aJoints.${component}`);
    } else expect(glsl).toMatch(/\bfor\s*\(/);
    rows.push({display,expanded,bytes:glsl.length,loops:(glsl.match(/\bfor\s*\(/g)??[]).length});
  }
  writeFileSync(join(output,"test-metrics.json"),JSON.stringify(rows,null,2));
},30_000);

test("production selector unfolds only performance skinning and links a display pair", () => {
  const defines={SKINNED:1,MAX_BONES:4,DISPLAY_COLOR:1,COLOR:1};
  const read=(key:string)=>readFileSync(join(root,".pocket-build/ipod/assets/shaders",key+".glsl"),"utf8");
  const reference=read(shader("surface_v",defines));
  const performance=read(shader("surface_v",{...defines,SKIP_ZERO_WEIGHTS:1}));
  expect(reference).toMatch(/\bfor\s*\(/);
  expect(performance).not.toMatch(/\bfor\s*\(|a(?:Weights|Joints)\[/);
  expect(performance.match(/if \(aWeights\.[xyzw] > 0\.0\)/g)).toHaveLength(4);
  const fragment=read(shader("color_f",{ATLAS_OUTPUT_LDR:1,ATLAS_LDR:1,ATLAS_BLEND:0,DEPTH_UNUSED:1}));
  const vert=join(output,"production.vert"),frag=join(output,"production.frag");
  writeFileSync(vert,performance);writeFileSync(frag,fragment);
  run(["glslangValidator","-l",vert,frag]);
},30_000);
