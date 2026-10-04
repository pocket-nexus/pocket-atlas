/** Human-scale view of a deterministic receipt; counts are compiler source
 * geometry, not guessed device milliseconds or per-object packed byte totals. */
export function explainCompile(report: any, limit = 12) {
  if (report?.schemaVersion !== 1 || typeof report.artifact?.sha256 !== "string") throw new Error("Not an Atlas compile receipt");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("top must be an integer in 1..100");
  const groups = new Map<string, { sources: string[]; inputTriangles: number; outputTriangles: number; outputVertices: number; baseErrorMeters: number; protected: boolean }>();
  for (const object of report.provenance?.geometry ?? []) {
    const sources = [...object.sources].sort();
    const key = JSON.stringify(sources);
    const group = groups.get(key) ?? { sources, inputTriangles: 0, outputTriangles: 0, outputVertices: 0, baseErrorMeters: 0, protected: false };
    group.inputTriangles += object.inputTriangles;
    group.outputTriangles += object.outputTriangles;
    group.outputVertices += object.outputVertices;
    group.baseErrorMeters = Math.max(group.baseErrorMeters, object.baseErrorMeters);
    group.protected ||= object.protected;
    groups.set(key, group);
  }
  const geometry = [...groups.values()].sort((a, b) => b.outputVertices - a.outputVertices || JSON.stringify(a.sources).localeCompare(JSON.stringify(b.sources), "en"));
  const contributors = (value: any) => Array.isArray(value?.sources)
    ? { ...value, sourceCount: value.sources.length, sources: value.sources.slice(0, limit) } : value;
  const passResult = (p: any) => {
    if (p.id.endsWith("-lowering")) return { bytes: p.result.bytes, sections: p.result.sections };
    if (p.id === "select-geometry") {
      const { prototypeInstances, ...summary } = p.result;
      return summary;
    }
    return p.result;
  };
  return {
    source: report.source.name, target: report.profile.definition.target,
    artifact: { sha256: report.artifact.sha256, bytes: report.artifact.bytes, sections: report.artifact.sections },
    validation: report.validation, diagnostics: (report.diagnostics ?? []).map(contributors),
    representations: report.provenance?.sourceGraph?.alternatives ?? [],
    passes: (report.passes ?? []).map((p: any) => ({ id: p.id, version: p.version, result: passResult(p) })),
    geometryCosts: { stage: "reduce-geometry", attribution: "object contributor sets; source lists capped by --top; sums are not per-object packed bytes", objects: geometry.length, top: geometry.slice(0, limit).map(contributors) },
  };
}
