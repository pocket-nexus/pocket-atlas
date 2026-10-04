// The atlas screen's state: which list is showing, which place has the
// focus, what the visitor saved and what they are searching for. The globe
// follows the focus; the Explore list follows the globe.
import { createEffect, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import { nearness, PLACES, type Place } from "./catalog.ts";
import type { Host } from "./host.ts";

export const TABS = ["featured", "explore", "saved", "search"] as const;
export type Tab = (typeof TABS)[number];
export const TAB_LABELS: Record<Tab, string> = { featured: "Featured", explore: "Explore", saved: "Saved", search: "Search" };

/** What a search looks through, lower case, by place id. */
const SEARCHED = new Map(PLACES.map((place) => [
  place.id,
  [place.name, place.native, place.locality, place.country, place.kind.replace(/-/g, " "), place.tags.join(" "), place.weather, place.summary].join(" ").toLowerCase(),
]));

/** The places in which every word of `query` occurs. */
export function search(query: string): Place[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return PLACES.filter((place) => words.every((word) => SEARCHED.get(place.id)!.includes(word)));
}

/** Where the globe sits on the primary screen, logical px. */
export interface GlobeFrame { x: number; y: number; r: number }

export interface Browser {
  tab: Accessor<Tab>;
  setTab(tab: Tab): void;
  stepTab(by: number): void;
  list: Accessor<Place[]>;
  focus: Accessor<number>;
  setFocus(index: number): void;
  focused: Accessor<Place | undefined>;
  saved(id: string): boolean;
  toggleSaved(id: string): void;
  /** What the Search list looks for. */
  query: Accessor<string>;
  setQuery(text: string): void;
  /** The place's pack is on this device. */
  open(place: Place): boolean;
  /** What stands in for "Visit" when it is not. */
  closed(place: Place): string;
  visit(place: Place | undefined): void;
  /** One line under the tabs. */
  caption: Accessor<string>;
  /** A short notice (saved, not available), "" when none. */
  notice: Accessor<string>;
}

export function createBrowser(host: Host, globe: GlobeFrame): Browser {
  const [tab, setTabSignal] = createSignal<Tab>("featured");
  const [focusId, setFocusId] = createSignal(PLACES[0]?.id ?? "");
  const [savedIds, setSavedIds] = createSignal<string[]>([]);
  const [query, setQuerySignal] = createSignal("");
  const [notice, setNotice] = createSignal("");
  /** Explore sorts from here: the globe's facing when the list was opened or last spun. */
  const [from, setFrom] = createSignal<[number, number]>([PLACES[0]?.lat ?? 0, PLACES[0]?.lon ?? 0]);
  let noticeSerial = 0;
  const say = (text: string) => {
    setNotice(text);
    const serial = ++noticeSerial;
    // Cleared by the next focus change or after a while (see below).
    void serial;
  };

  // What the renderer stored for us last time.
  createEffect(() => {
    try {
      const prefs = JSON.parse(host.prefs() || "{}") as { saved?: string[] };
      if (Array.isArray(prefs.saved)) setSavedIds(prefs.saved.filter((id) => PLACES.some((place) => place.id === id)));
    } catch {
      // A damaged file starts over.
    }
  });

  const open = (place: Place) => host.installed().includes(place.id);
  const list = createMemo<Place[]>(() => {
    const current = tab();
    if (current === "featured") {
      const featured = PLACES.filter((place) => place.featured);
      return [...(featured.length ? featured : PLACES)].sort((a, b) => Number(open(b)) - Number(open(a)));
    }
    if (current === "saved") return savedIds().map((id) => PLACES.find((place) => place.id === id)!).filter(Boolean);
    const [lat, lon] = from();
    const nearest = (places: Place[]) => [...places].sort((a, b) => nearness(lat, lon, b) - nearness(lat, lon, a));
    // What can be visited comes first among the matches.
    if (current === "search") return nearest(search(query())).sort((a, b) => Number(open(b)) - Number(open(a)));
    return nearest(PLACES);
  });
  const focus = createMemo(() => Math.max(0, list().findIndex((place) => place.id === focusId())));
  const focused = createMemo(() => list()[focus()]);

  // The globe turns to the focused place and lights its pin.
  createEffect(() => {
    if (!host.ready()) return;
    const place = focused();
    const pin = place ? PLACES.indexOf(place) : -1;
    const [lat, lon] = place ? [place.lat, place.lon] : untrack(from);
    host.send({ type: "globe", x: globe.x, y: globe.y, r: globe.r, lat, lon, pin });
  });
  createEffect(() => {
    if (host.ready()) host.send({ type: "pins", list: PLACES.map((p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)},${p.accent.slice(1)}`).join(";") });
  });
  // A spin (stick or finger) re-sorts Explore around where the globe now faces.
  createEffect(() => {
    const at: [number, number] = [host.lat(), host.lon()];
    if (!host.ready() || untrack(tab) !== "explore") return;
    setFrom(at);
    setFocusId(untrack(list)[0]?.id ?? "");
  });

  const setTab = (next: Tab) => {
    if (next === "explore" || next === "search") {
      const place = untrack(focused);
      if (place) setFrom([place.lat, place.lon]);
    }
    setTabSignal(next);
    setNotice("");
    const places = untrack(list);
    if (!places.some((place) => place.id === untrack(focusId))) setFocusId(places[0]?.id ?? "");
  };

  return {
    tab, setTab, list, focus, focused, open, caption: createMemo(() => {
      const count = list().length;
      if (tab() === "featured") return `${count} picked for you`;
      if (tab() === "explore") return "Nearest the middle of the globe";
      if (tab() === "saved") return count ? `${count} saved` : "Nothing saved yet";
      if (!query().trim()) return "A name, a city or a tag";
      return count ? `${count} found` : "Nothing found";
    }),
    notice,
    query,
    setQuery(text) {
      setQuerySignal(text);
      setNotice("");
      setFocusId(untrack(list)[0]?.id ?? "");
    },
    stepTab: (by) => setTab(TABS[(TABS.indexOf(tab()) + by + TABS.length) % TABS.length]),
    setFocus(index) {
      const place = list()[index];
      if (!place || place.id === focusId()) return;
      setNotice("");
      setFocusId(place.id);
    },
    saved: (id) => savedIds().includes(id),
    toggleSaved(id) {
      const place = PLACES.find((entry) => entry.id === id);
      if (!place) return;
      const was = savedIds().includes(id);
      const next = was ? savedIds().filter((entry) => entry !== id) : [id, ...savedIds()];
      setSavedIds(next);
      host.send({ type: "prefs", value: JSON.stringify({ saved: next }) });
      say(was ? `Removed ${place.name}` : `Saved ${place.name}`);
    },
    closed: (place) => (place.live ? "Not on this device" : "Coming soon"),
    visit(place) {
      if (!place) return;
      if (open(place)) host.send({ type: "enter", place: place.id });
      else say(`${place.name}: ${place.live ? "not on this device" : "coming soon"}`);
    },
  };
}
