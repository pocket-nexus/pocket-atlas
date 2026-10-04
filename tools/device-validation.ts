/** Atlas-specific link between deterministic compilation and nondeterministic device evidence. */
import { readFileSync } from "node:fs";
import { fileSha256 } from "../vendor/pocketjs/tools/device-evidence.ts";

/** A repeated status or absent metric is not another rendered-frame sample. */
export function assertFrameSample(sample: Record<string, any>, previousFrame: number, metrics: string[]) {
  if (!Number.isSafeInteger(previousFrame) || previousFrame < -1 || !Number.isSafeInteger(sample.frame) || sample.frame <= previousFrame ||
      metrics.some(key => !Number.isFinite(sample[key]) || sample[key] < 0))
    throw new Error("Incomplete, non-finite or non-advancing device timing sample");
}

/** A requested fixed view or setting must be echoed by the runtime, not just written by the host. */
export function assertVitaMeasurement(sample: Record<string, any>, expected: {
  view?: { pos: number[]; target: number[]; fov: number };
  time?: number;
  settings?: Record<string, unknown>;
}) {
  const same = (actual: unknown, wanted: unknown): boolean => {
    if (typeof wanted === "number") return typeof actual === "number" && Number.isFinite(actual) &&
      Number.isFinite(wanted) && Math.abs(actual - wanted) <= Math.max(1e-4, Math.abs(wanted) * 1e-6);
    if (Array.isArray(wanted)) return Array.isArray(actual) && actual.length === wanted.length && wanted.every((v, i) => same(actual[i], v));
    return actual === wanted;
  };
  if (expected.view && ["pos", "target", "fov"].some(k => !same(sample.view?.[k], expected.view![k as keyof typeof expected.view])))
    throw new Error("Vita has not applied the requested camera");
  if (expected.time !== undefined && !same(sample.time, expected.time)) throw new Error("Vita has not applied the requested fixed time");
  for (const [key, value] of Object.entries(expected.settings ?? {})) {
    if (!same(key === "profile" ? sample.profiling : sample.settings?.[key], value))
      throw new Error(`Vita has not applied setting ${key}`);
  }
  if (expected.settings?.profile === true && (!Array.isArray(sample.passes) || sample.passes.length === 0 ||
      sample.passes.some((p: unknown) => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || !Number.isFinite(p[1]) || p[1] < 0)))
    throw new Error("Vita serialized GPU timing is missing or invalid");
}

export function compileIdentity(pack: string, target: "vita" | "3ds" | "psp", reportPath = pack.replace(/\.place$/, ".compile.json")) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const packSha256 = fileSha256(pack);
  if (report.schemaVersion !== 1 || report.artifact?.sha256 !== packSha256 ||
      report.profile?.definition?.target !== target || report.validation?.structuralBudgets !== "passed")
    throw new Error("Pack does not match a successful compile receipt for this device");
  const budgetMs = Number(report.validation.frameBudget?.milliseconds);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("Compile receipt has no valid frame budget");
  return { receiptSha256: fileSha256(reportPath), packSha256, budgetMs, compiler: report.compiler,
    source: report.source, profile: report.profile, recipe: report.recipe };
}
