import type { QualityLevel } from "./quality";

/**
 * URL switches. They exist for development and for deterministic captures:
 *   ?q=low|medium|high|ultra   force a quality preset
 *   ?shot                      capture mode: no UI, no intro, fixed clock
 *   ?t=12.5                    start the simulation clock at this time (s)
 *   ?cam=hero|street|door|...  start a city at a named camera shot
 *   ?stats                     frame-time readout
 *   #/city/<id>                deep-link straight into a city
 */
export interface Params {
  quality: QualityLevel | null;
  shot: boolean;
  startTime: number;
  cam: string | null;
  stats: boolean;
  mute: boolean;
  /** Explicit camera: px,py,pz,tx,ty,tz[,fov] (debug captures). */
  view: number[] | null;
  /** Build the scene for the Vita cooker and expose `window.pocketCityExport`. */
  exporting: boolean;
}

export function readParams(): Params {
  const q = new URLSearchParams(location.search);
  const level = q.get("q");
  const quality =
    level === "low" || level === "medium" || level === "high" || level === "ultra" ? level : null;
  const t = Number(q.get("t"));
  return {
    quality,
    shot: q.has("shot"),
    startTime: Number.isFinite(t) ? t : 0,
    cam: q.get("cam"),
    stats: q.has("stats"),
    mute: q.has("mute") || q.has("shot"),
    view: q.get("view")?.split(",").map(Number).filter(Number.isFinite) ?? null,
    exporting: q.has("export"),
  };
}

export function cityFromHash(): string | null {
  const m = /^#\/city\/([a-z0-9-]+)/.exec(location.hash);
  return m ? m[1] : null;
}
