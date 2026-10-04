import type { PlaceDef, PlaceKind, Progress, Stage, StageContext } from "../../core/types";
import type { GeometryProfile } from "../../core/params";
import type { DayPlace } from "./daylight/DayStage";
import type { Shot } from "./camera";

export interface Sampling {
  startSeconds: number;
  durationSeconds: number;
  fps: number;
}
export interface Authoring {
  version: 1;
  id: string;
  kind: PlaceKind;
  seed: number;
  cameras?: readonly Shot[];
  sampling: Sampling;
  /** Local web/public resources. The export runner verifies their SHA-256 before loading. */
  resources: readonly { path: string; sha256: string }[];
}
export interface EffectiveAuthoring extends Authoring {
  geometry: GeometryProfile;
}
export interface PlaceDefinition extends Authoring {
  create(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage>;
}
type Input = Omit<PlaceDefinition, "version" | "resources"> & { resources?: Authoring["resources"] };
const kinds = new Set<PlaceKind>(["night-street", "dusk-street", "daytime-street", "daytime-slope", "night-slope", "daytime-coast", "dusk-coast", "dusk-vista", "night-coast", "interior", "rooftop"]);

export function validateSampling(s: Sampling): void {
  if (!Number.isFinite(s.fps) || !Number.isInteger(s.fps) || s.fps < 1 || s.fps > 120)
    throw new Error("Sampling fps must be an integer in 1..120");
  if (!Number.isFinite(s.startSeconds) || s.startSeconds < 0 || s.startSeconds > 3600 ||
      !Number.isFinite(s.durationSeconds) || s.durationSeconds <= 0 || s.durationSeconds > 3600)
    throw new Error("Sampling requires startSeconds in 0..3600 and durationSeconds in (0,3600]");
  for (const seconds of [s.startSeconds, s.durationSeconds]) {
    if (Math.abs(seconds * s.fps - Math.round(seconds * s.fps)) > 1e-6)
      throw new Error("Sampling boundaries must align to whole frames");
  }
  if ((s.startSeconds + s.durationSeconds) * s.fps > 108000)
    throw new Error("Sampling exceeds 108000 simulation steps");
}

export function definePlace(input: Input): PlaceDefinition {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) throw new Error("Invalid place id");
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff)
    throw new Error("Authoring seed must be an unsigned 32-bit integer");
  validateSampling(input.sampling);
  if (!kinds.has(input.kind)) throw new Error(`Unknown place kind: ${input.kind}`);
  if (input.cameras) validateCameras(input.cameras);
  const resources = input.resources ?? [];
  const paths = new Set<string>();
  for (const resource of resources) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(resource.path) || resource.path.startsWith("/") ||
        resource.path.split("/").some(p => !p || p === "." || p === "..") ||
        !/^[a-f0-9]{64}$/.test(resource.sha256) || paths.has(resource.path))
      throw new Error(`Invalid or duplicate resource lock: ${resource.path}`);
    paths.add(resource.path);
  }
  return Object.freeze({ ...input, version: 1, sampling: Object.freeze({ ...input.sampling }),
    resources: Object.freeze(resources.map(r => Object.freeze({ ...r }))) });
}

/** JSON-safe descriptor. Executable builders are fingerprinted as source files by the runner. */
export function describePlace(definition: PlaceDefinition): Authoring {
  const { version, id, kind, seed, sampling, resources, cameras } = definition;
  return { version, id, kind, seed, sampling, resources, ...(cameras ? { cameras } : {}) };
}

export function resolveAuthoring(definition: PlaceDefinition, geometry: GeometryProfile, overrides: { seed?: number; sampling?: Partial<Sampling> } = {}): EffectiveAuthoring {
  const checked = definePlace({ ...definition, seed: overrides.seed ?? definition.seed,
    sampling: { ...definition.sampling, ...overrides.sampling } });
  if (geometry !== "full" && geometry !== "handheld") throw new Error("Unknown geometry profile");
  return { ...describePlace(checked), geometry };
}

/** The existing App ABI remains unchanged. Each call constructs a fresh runtime instance. */
export async function createDefinedStage(definition: PlaceDefinition, ctx: StageContext, place: PlaceDef, progress: Progress): Promise<Stage> {
  if (place.id !== definition.id || place.kind !== definition.kind)
    throw new Error(`Registry and authoring disagree for ${place.id}`);
  const authoring = resolveAuthoring(definition, ctx.params.geometry, ctx.params.authoring);
  return definition.create({ ...ctx, authoring }, place, progress);
}

type DayInput = Omit<DayPlace, "audio" | "loopSeconds"> & Omit<Input, "create" | "kind"> & {
  createAudio?: (ctx: StageContext) => DayPlace["audio"];
};

/** Atlas daylight definition; importing it creates neither GPU nor audio resources. */
export function defineDayPlace(input: DayInput): PlaceDefinition {
  if (!input.kind.startsWith("daytime-")) throw new Error("DayStage requires a daytime place kind");
  return defineOutdoorPlace(input);
}

/** Day and dusk streets/coasts share PBR, sky, baking and the same runtime lifecycle. */
export function defineOutdoorPlace(input: DayInput): PlaceDefinition {
  const daytime = input.kind.startsWith("daytime-");
  const dusk = input.kind === "dusk-street" || input.kind === "dusk-coast";
  if (!daytime && !dusk) throw new Error("Outdoor stage requires a daytime or dusk street/coast kind");
  if (dusk && !input.atmosphere) throw new Error("Dusk places require an explicit atmosphere");
  return definePlace({ ...input, cameras: input.shots, async create(ctx, place, progress) {
    const { DayStage } = await import("./daylight/DayStage");
    return DayStage.create(ctx, place, progress, { ...input, audio: ctx.params.exporting ? undefined : input.createAudio?.(ctx) });
  } });
}

function validateCameras(cameras: readonly Shot[]) {
  const names = new Set<string>();
  if (!cameras.length) throw new Error("A place needs at least one camera");
  for (const shot of cameras) {
    const name = shot.name.trim().toLowerCase();
    if (!name || names.has(name)) throw new Error(`Duplicate or empty camera name: ${shot.name}`);
    names.add(name);
    for (const key of [shot.from, shot.to]) {
      if (key.pos.length !== 3 || key.target.length !== 3 || ![...key.pos, ...key.target, key.fov].every(Number.isFinite) || key.fov <= 0 || key.fov >= 180)
        throw new Error(`Invalid camera: ${shot.name}`);
    }
    if (!Number.isFinite(shot.duration) || shot.duration <= 0) throw new Error(`Invalid camera duration: ${shot.name}`);
  }
}
