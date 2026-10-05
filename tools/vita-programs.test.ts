import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverageFault, profileNames, PROGRAM_SETTINGS, shaderSources, vitaPlaces, type Coverage } from "./vita-programs";

const MANIFEST = "0022eb1fd0700fb0 standard_f.cg[BAKED,FOG,LIGHTS=0]\n007aaa79aa1d0023 composite_f.cg[HAZE]\n";

/** A directory with the record of a pass, `change` applied to a complete one. */
function recorded(change: (coverage: Coverage) => void = () => {}): string {
  const directory = mkdtempSync(join(tmpdir(), "vita-programs-"));
  const coverage: Coverage = {
    schema: 1, at: "2026-10-06T00:00:00.000Z", nativeBuild: "0".repeat(32), shaderSourcesSha256: shaderSources(), places: vitaPlaces(), profiles: profileNames(),
    settings: PROGRAM_SETTINGS, programs: 2, manifestSha256: createHash("sha256").update(MANIFEST).digest("hex"), compiled: 0, renderErrors: [],
  };
  change(coverage);
  writeFileSync(join(directory, "coverage.json"), JSON.stringify(coverage));
  return directory;
}
const fault = (change?: (coverage: Coverage) => void, manifest = MANIFEST) => {
  const directory = recorded(change);
  try {
    return coverageFault(directory, manifest);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("the Vita package's program set", () => {
  test("the frame rates are the profiles of vita/src/profile.rs, and each has its label in the settings", () => {
    expect(profileNames().sort()).toEqual(["cinematic", "vita30", "vita60"]);
    const labels = readFileSync(join(import.meta.dir, "../vita/src/settings.rs"), "utf8");
    for (const name of profileNames()) expect(labels).toContain(`"${name}" =>`);
  });

  test("the pass sets each pair of Bloom and Haze, and each switch both ways", () => {
    const pairs = PROGRAM_SETTINGS.filter((s) => "bloom" in s && "haze" in s).map((s) => `${s.bloom} ${s.haze}`).sort();
    expect(pairs).toEqual(["false false", "false true", "true false", "true true"]);
    for (const key of ["msaa", "reflection", "rain"]) expect(PROGRAM_SETTINGS.filter((s) => key in s).map((s) => s[key]).sort()).toEqual([false, true]);
  });

  test("a set the pass collected for this commit is taken", () => {
    expect(fault()).toBeNull();
  });

  test("a set without the pass's record is refused", () => {
    const directory = mkdtempSync(join(tmpdir(), "vita-programs-"));
    try {
      expect(coverageFault(directory, MANIFEST)).toContain("coverage.json is missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a pass that left out a place, a frame rate or a switch is refused", () => {
    expect(fault((c) => void (c.places = c.places.slice(1)))).toContain("the pass entered");
    expect(fault((c) => void (c.profiles = c.profiles.filter((p) => p !== "cinematic")))).toContain("the pass ran under");
    expect(fault((c) => void (c.settings = c.settings.filter((s) => !("haze" in s && !s.bloom && s.haze))))).toContain('the pass did not set {"bloom":false,"haze":true}');
  });

  test("other shader sources, and a list that changed after the pass, are refused", () => {
    expect(fault((c) => void (c.shaderSourcesSha256 = "f".repeat(64)))).toContain("this commit's are");
    expect(fault(undefined, MANIFEST + "00ae26ffc5314e62 sky_f.cg\n")).toContain("is not the list the pass recorded");
  });
});
