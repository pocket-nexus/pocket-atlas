import { expect, test } from "bun:test";
import { explainCompile } from "./compile-report";
test("cost summaries keep contributor sets without assigning shared work twice", () => {
  const object = { sources: ["railing", "stairs"], inputTriangles: 12, outputTriangles: 6, outputVertices: 10, baseErrorMeters: 0.003, protected: false };
  const report = { schemaVersion: 1, artifact: { sha256: "a".repeat(64) }, source: { name: "example" }, profile: { definition: { target: "3ds" } },
    provenance: { geometry: [object, { ...object, sources: ["stairs", "railing"] }, { ...object, sources: ["sign"], protected: true }] } };
  const result = explainCompile(report, 1);
  expect(result.geometryCosts.objects).toBe(2);
  expect(result.geometryCosts.top[0].outputVertices).toBe(20);
  expect(result.geometryCosts.top[0].outputTriangles).toBe(12);
  expect(result.geometryCosts.top[0].sources).toEqual(["railing"]);
  expect(result.geometryCosts.top[0].sourceCount).toBe(2);
  expect(() => explainCompile(report, NaN)).toThrow("top");
  expect(() => explainCompile({}, 1)).toThrow("receipt");
});
test("explain omits full prototype and warning ownership tables while retaining counts", () => {
  const sources = Array.from({ length: 5000 }, (_, i) => `tree/${i}`);
  const report = { schemaVersion: 1, artifact: { sha256: "a".repeat(64) }, source: { name: "park" }, profile: { definition: { target: "3ds" } },
    diagnostics: [{ code: "LEGACY", sources }], passes: [{ id: "select-geometry", version: 1, result: { objects: 5000, prototypeInstances: Object.fromEntries(sources.map(s => [s, 1])) } }] };
  const result = explainCompile(report, 5);
  expect(result.diagnostics[0].sourceCount).toBe(5000);
  expect(result.diagnostics[0].sources).toHaveLength(5);
  expect(result.passes[0].result.objects).toBe(5000);
  expect(JSON.stringify(result).length).toBeLessThan(1500);
});
