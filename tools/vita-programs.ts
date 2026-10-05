// The PS Vita package's programs, and the record of how they were collected.
//
// SceShaccCg runs on a console, so a package carries programs a console
// compiled. Which programs a place asks for depends on what a member has set:
// the frame rate's profile lights surfaces per vertex or per pixel, and Bloom
// and Haze choose the composite. `bun tools/atlas.ts programs` enters every
// Vita place under every frame rate in a process started for the pass, throws
// each of those switches both ways, and writes the console's list, its
// `.gxp` files and `coverage.json` to `.pocket-build/vita-programs/`.
// `tools/release.ts` packs that directory and refuses one whose coverage is
// not this commit's places, frame rates, switches and shader sources.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLACES } from "../web/src/places/registry";

const ROOT = resolve(import.meta.dir, "..");

/** Where the pass leaves the programs, the list and the coverage: no development run writes here. */
export const PROGRAMS_DIR = join(ROOT, ".pocket-build/vita-programs");

/**
 * What a member can set that selects programs, as the development control sets it (`settings` in
 * `host0:atlas/control.json`), in the order the pass throws it in each place under each frame rate. Bloom and
 * Haze go through all four pairs: the composite has a program for each. `step` is the Quality choice.
 * Resolution and Exposure change targets and uniforms, never a program, and are not thrown.
 */
export const PROGRAM_SETTINGS: Record<string, boolean | number>[] = [
  { msaa: false },
  { msaa: true },
  { bloom: false, haze: true },
  { bloom: false, haze: false },
  { bloom: true, haze: false },
  { bloom: true, haze: true },
  { reflection: false },
  { reflection: true },
  { rain: false },
  { rain: true },
  ...[0, 1, 2, 3, 4, 5].map((step) => ({ step, hold: true })),
];

/** The frame rates a member chooses between: the `name` of each profile in vita/src/profile.rs. */
export function profileNames(): string[] {
  return [...readFileSync(join(ROOT, "vita/src/profile.rs"), "utf8").matchAll(/^\s*name: "([a-z0-9]+)",$/gm)].map((m) => m[1]!);
}

/** The places the Vita package holds. */
export const vitaPlaces = (): string[] => PLACES.filter((p) => p.status === "live" && p.targets?.includes("vita")).map((p) => p.id);

/** The SHA-256 of vita/shaders, names and contents: the stamp a console reports for the sources it compiled. */
export function shaderSources(): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(join(ROOT, "vita/shaders")).sort()) hash.update(name).update(readFileSync(join(ROOT, "vita/shaders", name)));
  return hash.digest("hex");
}

export interface Coverage {
  schema: 1;
  at: string;
  /** The development build that ran the pass. */
  nativeBuild: string;
  shaderSourcesSha256: string;
  places: string[];
  profiles: string[];
  settings: Record<string, boolean | number>[];
  programs: number;
  manifestSha256: string;
  /** Programs the console compiled during the pass; the others came from the share's cache. */
  compiled: number;
  /** Renderer errors seen during the pass that are not a program's (a render target the console refused). */
  renderErrors: { profile: string; place: string; error: string }[];
}

const same = (a: unknown[], b: unknown[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Why `directory` is not a complete program set for this commit, or null. `manifest` is the text of its
 * `manifest.txt`. Refused: no coverage record; a pass over other places or frame rates than this commit has, or
 * without a switch of PROGRAM_SETTINGS; a list that changed after the pass (any development run started later
 * rewrites the share's list with what it has asked for so far); shader sources that changed after it.
 */
export function coverageFault(directory: string, manifest: string): string | null {
  const file = join(directory, "coverage.json");
  if (!existsSync(file)) return `${file} is missing: the programs were not collected by the pass over every setting`;
  const c = JSON.parse(readFileSync(file, "utf8")) as Coverage;
  const rows = manifest.split("\n").filter(Boolean).length;
  const thrown = (c.settings ?? []).map((s) => JSON.stringify(s));
  const unthrown = PROGRAM_SETTINGS.map((s) => JSON.stringify(s)).filter((s) => !thrown.includes(s));
  if (c.schema !== 1) return `${file} has schema ${c.schema}`;
  if (!same(c.places ?? [], vitaPlaces())) return `the pass entered ${c.places?.join(", ")}, and the Vita's places are ${vitaPlaces().join(", ")}`;
  if (!same(c.profiles ?? [], profileNames())) return `the pass ran under ${c.profiles?.join(", ")}, and the frame rates are ${profileNames().join(", ")}`;
  if (unthrown.length) return `the pass did not set ${unthrown.join(" ")}`;
  if (c.shaderSourcesSha256 !== shaderSources()) return `the pass compiled vita/shaders at ${c.shaderSourcesSha256?.slice(0, 12)}, and this commit's are ${shaderSources().slice(0, 12)}`;
  if (c.programs !== rows || c.manifestSha256 !== createHash("sha256").update(manifest).digest("hex")) return `manifest.txt (${rows} programs) is not the list the pass recorded (${c.programs})`;
  return null;
}
