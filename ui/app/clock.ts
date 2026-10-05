// The interface's own clock. A renderer draws as fast as its place allows
// (17 to 60 frames a second) and gives the interface about a turn a second
// while nothing changes, so a count of turns is no measure of time. This
// clock follows the wall, by at least one turn's worth each turn (a host
// without a wall clock then counts turns, as the tests do) and at most two
// seconds (a place loading for ten does not use up what was waiting).
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { simulationHz } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";

interface Timer {
  at: number;
  fire(): void;
}

let elapsed = 0;
let wall = 0;
const waiting = new Set<Timer>();

/** Advances the clock every turn; once, from the root of the interface. */
export function runClock(): void {
  onFrame(() => {
    const now = Date.now();
    elapsed += Math.min(2, Math.max(1 / simulationHz(), (now - wall) / 1000));
    wall = now;
    for (const timer of waiting) {
      if (elapsed < timer.at) continue;
      waiting.delete(timer);
      timer.fire();
    }
  });
}

/** True for `seconds` after each `show()`. */
export function createPulse(seconds: number): [Accessor<boolean>, () => void] {
  const [shown, setShown] = createSignal(false);
  let timer: Timer | undefined;
  const stop = () => {
    if (timer) waiting.delete(timer);
    timer = undefined;
  };
  onCleanup(stop);
  return [shown, () => {
    stop();
    setShown(true);
    timer = { at: elapsed + seconds, fire: () => setShown(false) };
    waiting.add(timer);
  }];
}
