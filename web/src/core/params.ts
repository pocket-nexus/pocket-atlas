import type { QualityLevel } from "./quality";
import type { Sampling } from "../places/shared/authoring";

/** Authoring density is independent of lighting, textures and render quality. */
export type GeometryProfile = "full" | "handheld";

/**
 * URL switches. They exist for development and for deterministic captures:
 *   ?q=low|medium|high|ultra   force a quality preset
 *   ?geometry=handheld        use geometry intended for the handheld cooker
 *   ?shot                      capture mode: no UI, no title card, no intro, fixed clock
 *   ?t=12.5                    start the simulation clock at this time (s)
 *   ?cam=hero|street|door|...  start a place at a named camera shot
 *   ?stats                     frame-time readout
 *   #/place/<id>               deep-link straight into a place
 */
export interface Params {
  authoring?: { seed?: number; sampling?: Partial<Sampling> };
  quality: QualityLevel | null;
  geometry: GeometryProfile;
  shot: boolean;
  startTime: number;
  cam: string | null;
  stats: boolean;
  mute: boolean;
  /** Explicit camera: px,py,pz,tx,ty,tz[,fov] (debug captures). */
  view: number[] | null;
  /** Build the scene for the Vita cooker and expose `window.pocketAtlasExport`. */
  exporting: boolean;
}

export function readParams(search = location.search): Params {
  const q = new URLSearchParams(search);
  const level = q.get("q");
  const quality =
    level === "low" || level === "medium" || level === "high" || level === "ultra" ? level : null;
  const t = Number(q.get("t"));
  return {
    authoring: {
      ...(q.has("seed") ? { seed: Number(q.get("seed")) } : {}),
      sampling: {
        ...(q.has("sample-start") ? { startSeconds: Number(q.get("sample-start")) } : {}),
        ...(q.has("sample-seconds") ? { durationSeconds: Number(q.get("sample-seconds")) } : {}),
        ...(q.has("sample-fps") ? { fps: Number(q.get("sample-fps")) } : {}),
      },
    },
    quality,
    geometry: q.get("geometry") === "handheld" ? "handheld" : "full",
    shot: q.has("shot"),
    startTime: Number.isFinite(t) ? t : 0,
    cam: q.get("cam"),
    stats: q.has("stats"),
    mute: q.has("mute") || q.has("shot"),
    view: q.get("view")?.split(",").map(Number).filter(Number.isFinite) ?? null,
    exporting: q.has("export"),
  };
}

export function placeFromHash(): string | null {
  const m = /^#\/place\/([a-z0-9-]+)/.exec(location.hash);
  return m ? m[1] : null;
}
