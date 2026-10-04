import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFrameSample, assertVitaMeasurement, compileIdentity } from "./device-validation";
import { fileSha256 } from "../vendor/pocketjs/tools/device-evidence";
test("device evidence refuses stale packs, wrong targets and failed compile receipts", () => {
  const dir=mkdtempSync(join(tmpdir(),"atlas-evidence-"));
  try {
    const pack=join(dir,"scene.place"), report=join(dir,"scene.compile.json");
    writeFileSync(pack,"pack-a");
    const receipt={schemaVersion:1,artifact:{sha256:fileSha256(pack)},profile:{definition:{target:"psp"}},validation:{structuralBudgets:"passed",frameBudget:{milliseconds:1000/30}}};
    writeFileSync(report,JSON.stringify(receipt));
    expect(compileIdentity(pack,"psp").packSha256).toBe(fileSha256(pack));
    expect(()=>compileIdentity(pack,"vita")).toThrow();
    receipt.validation.structuralBudgets="failed";writeFileSync(report,JSON.stringify(receipt));
    expect(()=>compileIdentity(pack,"psp")).toThrow();
    receipt.validation.structuralBudgets="passed";writeFileSync(report,JSON.stringify(receipt));writeFileSync(pack,"pack-b");
    expect(()=>compileIdentity(pack,"psp")).toThrow();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("a stalled renderer and missing timing fields cannot pass a measurement window", () => {
  const sample={frame:10,frameMs:33.3,gpuMs:12};
  assertFrameSample(sample,9,["frameMs","gpuMs"]);
  expect(()=>assertFrameSample(sample,10,["frameMs"])).toThrow();
  expect(()=>assertFrameSample(sample,NaN,["frameMs"])).toThrow();
  expect(()=>assertFrameSample({...sample,gpuMs:NaN},9,["gpuMs"])).toThrow();
  expect(()=>assertFrameSample(sample,9,["workMax"])).toThrow();
});
test("Vita evidence rejects unapplied controls and absent serialized GPU timings", () => {
  const view = { pos: [0, 1.1, 2], target: [0, 0, 0], fov: 45 };
  const sample = { view: { ...view, pos: [0, Math.fround(1.1), 2] }, time: 10, settings: { step: 2, hold: true }, profiling: true, passes: [["main", 5]] };
  const requested = { view, time: 10, settings: { step: 2, hold: true, profile: true } };
  assertVitaMeasurement(sample, requested);
  for (const drift of [{ view: { ...view, fov: 60 } }, { time: 11 }, { settings: { step: 1 } }, { profiling: false }, { passes: [] }, { passes: [["main", NaN]] }])
    expect(() => assertVitaMeasurement({ ...sample, ...drift }, requested)).toThrow();
});
