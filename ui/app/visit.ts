// A visit to a place: what the visitor can do there, on any device.
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { placeById, type Place } from "./catalog.ts";
import type { Host } from "./host.ts";

/** What the settings a renderer may offer are called. */
const LABELS: Record<string, string> = {
  rain: "Rain",
  reflection: "Wet reflections",
  glow: "Light glow",
  bloom: "Bloom",
  haze: "Haze",
  sound: "Sound",
  stats: "Statistics",
  rate: "Frame rate",
  quality: "Quality",
  resolution: "Resolution",
  smoothing: "Anti-aliasing",
  exposure: "Exposure",
};

/** A row of a place's menu. */
export interface MenuRow {
  label: string;
  /** A switch's state, or undefined for a row with a named value or none. */
  on?: boolean;
  /** The named value of a choice. */
  value?: string;
  press(): void;
}

export interface Visit {
  place: Accessor<Place | undefined>;
  /** "2/6 · Corner" */
  shotLabel: Accessor<string>;
  step(by: number): void;
  cut(index: number): void;
  /** Resume the tour, or pause and continue it. */
  play(): void;
  /** What `play` would do: "tour", "pause" or "play". */
  playLabel: Accessor<string>;
  leave(): void;
  /** Whether the renderer's `key` switch is on. */
  on(key: string): boolean;
  /** The menu: the tour, the renderer's settings, the way out. */
  menu: Accessor<MenuRow[]>;
}

export function createVisit(host: Host): Visit {
  const cut = (index: number) => host.send({ type: "shot", index });
  return {
    place: createMemo(() => placeById(host.place())),
    shotLabel: createMemo(() => {
      const shots = host.shots();
      return shots.length ? `${host.shot() + 1}/${shots.length} · ${shots[host.shot()] ?? ""}` : "";
    }),
    cut,
    step(by) {
      const count = host.shots().length;
      if (count) cut((host.shot() + by + count) % count);
    },
    play() {
      if (!host.tour()) host.send({ type: "tour", on: true });
      else host.send({ type: "pause", on: !host.paused() });
    },
    playLabel: () => (!host.tour() ? "tour" : host.paused() ? "play" : "pause"),
    leave: () => host.send({ type: "leave" }),
    on: (key) => !!host.options().find((setting) => setting.key === key)?.value,
    menu: createMemo(() => [
      { label: "Tour", on: host.tour(), press: () => host.send({ type: "tour", on: !host.tour() }) },
      ...host.options().map((setting): MenuRow => {
        const label = LABELS[setting.key] ?? setting.key;
        const choices = setting.choices;
        if (!choices) return { label, on: !!setting.value, press: () => host.send({ type: "option", key: setting.key, value: setting.value ? 0 : 1 }) };
        return { label, value: choices[setting.value] ?? "", press: () => host.send({ type: "option", key: setting.key, value: (setting.value + 1) % choices.length }) };
      }),
      { label: "Back to the atlas", press: () => host.send({ type: "leave" }) },
    ]),
  };
}

/** Tells the renderer when a place's interface shows nothing at all. */
export function reportQuiet(host: Host, showing: Accessor<boolean>): void {
  createEffect(() => host.send({ type: "quiet", on: !showing() }));
  onCleanup(() => host.send({ type: "quiet", on: false }));
}
