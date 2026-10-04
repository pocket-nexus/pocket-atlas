// The renderer's state as signals, and the way to command it.
import { createSignal, type Accessor } from "solid-js";
import { connectOverlay } from "@pocketjs/framework/overlay-host";
import { runClock } from "./clock.ts";
import type { Command, HostState, Scene } from "./protocol.ts";

/** One signal per field: a statistics line once a second must not re-run
 *  what reads the shot list. */
type Signals = { [K in keyof HostState]: Accessor<HostState[K]> };

const initial: HostState = {
  scene: "atlas", place: "", message: "", installed: [], shots: [], shot: 0, tour: true, paused: false,
  options: [], stats: "", lat: 0, lon: 0, prefs: "",
};

function same(a: unknown, b: unknown): boolean {
  return typeof a === "object" ? JSON.stringify(a) === JSON.stringify(b) : a === b;
}

export interface Host extends Signals {
  send(command: Command): void;
  /** True once the renderer has reported its state. */
  ready: Accessor<boolean>;
}

export function connectHost(): Host {
  const [ready, setReady] = createSignal(false);
  const set = {} as { [K in keyof HostState]: (value: HostState[K]) => void };
  const host = { ready } as Host;
  const last = { ...initial };
  for (const key of Object.keys(initial) as (keyof HostState)[]) {
    const [get, put] = createSignal<unknown>(initial[key], { equals: false });
    (host as unknown as Record<string, unknown>)[key] = get;
    (set as unknown as Record<string, unknown>)[key] = put;
  }
  const overlay = connectOverlay<Partial<HostState>, Command>((state) => {
    for (const key of Object.keys(state) as (keyof HostState)[]) {
      if (!(key in initial) || same(last[key], state[key])) continue;
      (last as Record<string, unknown>)[key] = state[key];
      (set[key] as (value: unknown) => void)(state[key]);
    }
    setReady(true);
  });
  host.send = overlay.send;
  runClock();
  return host;
}

export type { Scene };
