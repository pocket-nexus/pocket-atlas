import { LOOP } from "./layout";

/**
 * The place's clock over one loop (`LOOP` s, what the device repeats): one
 * Fujisawa-bound Enoden train (westbound, left to right in the canonical
 * view) and the crossing sequence that protects it. Every motion is a pure
 * function of `t mod LOOP`, so the web and the exported tracks agree and
 * the loop has no seam.
 *
 *   −49.9 s  the train rounds the bend from Shichirigahama behind the houses (45 km/h)
 *   −35 s    lamps and bell start (national standard: 35 s before the train)
 *   −27 s    gates start down; down by −20.5 s
 *     0 s    the front crosses the road (30 km/h, braking for the platform 107 m on)
 *   +6.9 s   the rear clears the road
 *   +10.4 s  bell stops, gates rise (3.5 s after the rear clears; up 6 s later)
 *   +26.3 s  the train stops at the platform, out of every shot
 * (times relative to T0, the moment the front reaches the crossing)
 */
/**
 * The front reaches the crossing at 23 s, so the whole train fills the
 * canonical frame at 25–27 s, when the preview card is taken.
 */
export const T0 = 23;

/** Train motion along the track (u, + east): westbound, so u falls with time. */
export const RUN = {
  hide: 575,
  cruise: 12.5,
  slowFrom: 180,
  slowTo: 40,
  pass: 8.3,
  brakeFrom: -112,
  brake: 0.65,
};
const DECEL = (RUN.cruise ** 2 - RUN.pass ** 2) / (2 * (RUN.slowFrom - RUN.slowTo));
const T_SLOW = (RUN.cruise - RUN.pass) / DECEL;
const T_PASS_IN = RUN.slowTo / RUN.pass;
const T_CRUISE = (RUN.hide - RUN.slowFrom) / RUN.cruise;
/** Seconds from the bend to the crossing. */
export const APPROACH = T_CRUISE + T_SLOW + T_PASS_IN;
const T_PASS_OUT = -RUN.brakeFrom / RUN.pass;
const T_BRAKE = RUN.pass / RUN.brake;
export const STOP_U = RUN.brakeFrom - (RUN.pass * RUN.pass) / (2 * RUN.brake);
/** Seconds from the crossing to the stop at the platform. */
export const ARRIVE = T_PASS_OUT + T_BRAKE;
/** The parked train sinks out of the world 6 s after it stops (out of every shot), and rises at the bend. */
const SINK = ARRIVE + 6;

/** Train length (two 25.4 m two-car units). */
export const TRAIN_LENGTH = 50.8;

/** Time relative to T0 in (−LOOP/2, LOOP/2]. */
function rel(t: number): number {
  let r = (((t - T0) % LOOP) + LOOP) % LOOP;
  if (r > LOOP - APPROACH - 1) r -= LOOP;
  return r;
}

/** Front of the train at place time t: arc length along the track and whether it is in the world. */
export function trainFront(t: number): { u: number; y: number } {
  const r = rel(t);
  // Hidden between the sink at the platform and the rise at the bend (underground, out of sight).
  if (r > SINK + 0.2 || r < -APPROACH - 0.2) return { u: r > 0 ? STOP_U : RUN.hide, y: -60 };
  if (r >= SINK) return { u: STOP_U, y: (-60 * (r - SINK)) / 0.2 };
  if (r < -APPROACH) return { u: RUN.hide, y: (-60 * (-APPROACH - r)) / 0.2 };
  let u: number;
  if (r <= -T_PASS_IN - T_SLOW) {
    // Cruising from the bend.
    u = RUN.slowFrom + (-T_PASS_IN - T_SLOW - r) * RUN.cruise;
  } else if (r <= -T_PASS_IN) {
    // Easing from 45 to 30 km/h.
    const s = r + T_PASS_IN + T_SLOW;
    u = RUN.slowFrom - (RUN.cruise * s - 0.5 * DECEL * s * s);
  } else if (r <= T_PASS_OUT) {
    u = -r * RUN.pass;
  } else {
    const s = Math.min(T_BRAKE, r - T_PASS_OUT);
    u = RUN.brakeFrom - (RUN.pass * s - 0.5 * RUN.brake * s * s);
  }
  return { u, y: 0 };
}

/** Crossing sequence (relative to T0). */
export const SEQ = {
  alarm: -35,
  gatesDown: [-27, -20.5] as const,
  clear: (TRAIN_LENGTH + 6.5) / RUN.pass,
  gatesUp: [0, 6] as const,
  /** Each lamp lights for half of a 1.2 s cycle (50 flashes a minute). */
  flash: 1.2,
};

export interface CrossingNow {
  /** Lamps and bell on. */
  alarm: boolean;
  /** Gate arms: 0 raised, 1 lowered. */
  gate: number;
  /** Which lamp of each pair is lit (0 or 1); −1 when dark. */
  lamp: number;
}

const ease = (x: number) => x * x * (3 - 2 * x);

export function crossingAt(t: number): CrossingNow {
  const r = rel(t);
  const up0 = SEQ.clear + 3.5;
  const alarm = r >= SEQ.alarm && r < up0;
  let gate = 0;
  if (r >= SEQ.gatesDown[0] && r < SEQ.gatesDown[1]) gate = ease((r - SEQ.gatesDown[0]) / (SEQ.gatesDown[1] - SEQ.gatesDown[0]));
  else if (r >= SEQ.gatesDown[1] && r < up0) gate = 1;
  else if (r >= up0 && r < up0 + SEQ.gatesUp[1]) gate = 1 - ease((r - up0) / SEQ.gatesUp[1]);
  // Flash phase from the loop clock (LOOP is a whole number of cycles).
  const ph = (((t % LOOP) + LOOP) % LOOP) / SEQ.flash;
  const lamp = alarm ? (ph - Math.floor(ph) < 0.5 ? 0 : 1) : -1;
  return { alarm, gate, lamp };
}
