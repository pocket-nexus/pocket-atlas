import type { CarState } from "./vehicle";

/**
 * The trip: one drive from the route's first stop to its last. Stops are
 * the places the road passes (a station, a pass, a town's convenience
 * store); reaching one is remembered, so a trip can resume from it. The
 * handheld keeps the same state (`vita/src/drive/trip.rs`).
 */
export interface Stop {
  /** Name in Latin script and in the local script. */
  name: string;
  native: string;
  /** Arc length on the driven road (m). */
  s: number;
}

export type TripEvent = { type: "stop"; index: number } | { type: "arrived" };

export interface TripState {
  phase: "ready" | "driving" | "arrived";
  /** The last stop reached (0: the start). */
  reached: number;
  /** Seconds at the wheel and metres driven on this trip. */
  seconds: number;
  metres: number;
  /** Times the body met a bank. */
  scrapes: number;
  /** Fastest speed (m/s). */
  top: number;
}

export function newTrip(reached = 0): TripState {
  return { phase: "ready", reached, seconds: 0, metres: 0, scrapes: 0, top: 0 };
}

/** How close to a stop counts as reaching it (m), and how close to the end counts as arriving. */
const NEAR = 30;

/** Advances the trip with the car's state; returns what happened this step. */
export function stepTrip(t: TripState, c: CarState, stops: readonly Stop[], dt: number, moved: number, scraped: boolean): TripEvent[] {
  const events: TripEvent[] = [];
  if (t.phase === "arrived") return events;
  if (t.phase === "ready" && Math.abs(c.vx) > 0.3) t.phase = "driving";
  if (t.phase !== "driving") return events;
  t.seconds += dt;
  t.metres += moved;
  t.top = Math.max(t.top, Math.abs(c.vx));
  if (scraped) t.scrapes++;
  const last = stops.length - 1;
  while (t.reached < last && c.s >= stops[t.reached + 1].s - NEAR) {
    t.reached++;
    if (t.reached === last) {
      t.phase = "arrived";
      events.push({ type: "arrived" });
    } else events.push({ type: "stop", index: t.reached });
  }
  return events;
}

/** The stop ahead of an arc length, and the metres to it. */
export function nextStop(stops: readonly Stop[], s: number): { index: number; metres: number } {
  for (let i = 0; i < stops.length; i++) if (stops[i].s > s + 1) return { index: i, metres: stops[i].s - s };
  return { index: stops.length - 1, metres: 0 };
}
