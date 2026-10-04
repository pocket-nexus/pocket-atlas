// What crosses between a device's renderer and the interface. The renderer
// owns the 3D scene, the camera and the files; the interface owns every 2D
// pixel and what each button and gesture means. Both sides speak JSON lines
// over PocketJS's in-process overlay service: the renderer sends its state
// as it changes, the interface sends commands.
//
// The four renderers parse commands with small scanners, so commands are
// flat objects of numbers, booleans and short strings.
//
// A renderer sends the fields of its state that changed, and need not give
// the interface every turn. While no button or touch is down and neither
// the state nor what the interface drew has just changed, a turn a second
// does: its timers follow the wall (clock.ts).

export type Scene = "atlas" | "loading" | "place" | "error";

export interface HostState {
  /** What is drawn behind the interface. */
  scene: Scene;
  /** The place being loaded or visited. */
  place: string;
  /** Why `scene` is "error". */
  message: string;
  /** Ids of the places whose pack is on the device. */
  installed: string[];
  /** The visited place's authored shots, and the one the camera is on. */
  shots: string[];
  shot: number;
  /** The camera follows the authored tour; false once the visitor moves it. */
  tour: boolean;
  paused: boolean;
  /** What the renderer lets the visitor set here, in menu order. */
  options: Setting[];
  /** One line of renderer statistics while the `stats` setting is on. */
  stats: string;
  /** Where the globe faces, degrees; sent when a spin settles. */
  lat: number;
  lon: number;
  /** What the interface last stored with `prefs`. */
  prefs: string;
}

/** A switch (0 or 1), or with `choices` one of several named values. */
export interface Setting {
  key: string;
  value: number;
  choices?: string[];
}

export type Command =
  /** Where the globe sits on the primary screen (logical px), where it turns
   *  to face, and which pin is lit (-1: none). */
  | { type: "globe"; x: number; y: number; r: number; lat: number; lon: number; pin: number }
  /** Every place on the globe: "lat,lon,rrggbb" joined with ";". */
  | { type: "pins"; list: string }
  /** A finger dragging the globe: logical px since the last command. */
  | { type: "spin"; dx: number; dy: number }
  | { type: "enter"; place: string }
  | { type: "leave" }
  | { type: "shot"; index: number }
  | { type: "tour"; on: boolean }
  | { type: "pause"; on: boolean }
  | { type: "option"; key: string; value: number }
  /** Virtual sticks, -100…100 on each axis; move y is forward. */
  | { type: "drive"; mx: number; my: number; lx: number; ly: number }
  /** A finger dragging the view: logical px since the last command. */
  | { type: "look"; dx: number; dy: number }
  /** The interface holds the pad (a sheet is open): the renderer leaves the
   *  d-pad and sticks alone. */
  | { type: "hold"; on: boolean }
  | { type: "prefs"; value: string }
  /** The interface shows nothing just now: a renderer that lays it over the
   *  frame as a texture may skip that. */
  | { type: "quiet"; on: boolean };
