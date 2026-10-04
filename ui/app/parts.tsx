// The pieces every presentation is built from. A device chooses where they
// go and how large they are; what a place card, a list row or a switch looks
// like is decided here once.
import { createEffect, createSignal, For, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import { FocusScope, Image, Text, View } from "@pocketjs/framework/components";
import type { SurfaceId } from "@pocketjs/framework/display";
import { createGesture } from "@pocketjs/framework/gesture";
import { getOps } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame, pushButtonHandlerBlock } from "@pocketjs/framework/lifecycle";
import { createOsk, Osk, type OskController } from "@pocketjs/framework/osk";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";
import { TAB_LABELS, TABS, type Browser, type Tab } from "./browse.ts";
import type { Place } from "./catalog.ts";
import type { Host } from "./host.ts";
import type { MenuRow, Visit } from "./visit.ts";
import { DIM, FAINT, GLASS, HAIRLINE, INK, tint, WASH } from "./theme.ts";

/** Baked font slots: 12, 14, 16, 18, 20, 24 px regular, then their bold pairs. */
const SLOT: Record<number, number> = { 12: 0, 14: 1, 16: 2, 18: 3, 20: 4, 24: 5 };

/** The width of `text` in the baked font, px. */
export function measure(text: string, size: number, bold: boolean): number {
  return getOps().measureText?.(text, SLOT[size] + (bold ? 7 : 0)) ?? text.length * size * 0.55;
}

/** `text` cut to `width` px with an ellipsis, measured in the baked font. */
export function fit(text: string, size: number, bold: boolean, width: number): string {
  const ops = getOps();
  const slot = SLOT[size] + (bold ? 7 : 0);
  if (!ops.measureText || ops.measureText(text, slot) <= width) return text;
  let end = text.length;
  while (end > 1 && ops.measureText(text.slice(0, end).trimEnd() + "…", slot) > width) end--;
  return text.slice(0, end).trimEnd() + "…";
}

export function kindLabel(kind: string): string {
  return kind.replace(/-/g, " ").toUpperCase();
}

/**
 * A view a finger can tap, on the surface it is drawn on. It stays out of
 * the focus order, so a pad (which has its own button for the same verb, or
 * is steering the camera) never lands on it.
 */
export function Touchable(props: { surface?: SurfaceId; onTap?: () => void; class?: string; style?: Record<string, number | string>; children?: JSX.Element }) {
  let node: NodeMirror | undefined;
  const [down, setDown] = createSignal(false);
  createGesture({
    surface: props.surface,
    region: { node: () => node },
    onDown: () => setDown(!!props.onTap),
    onUp: () => setDown(false),
    onCancel: () => setDown(false),
    onTap: () => props.onTap?.(),
  });
  return <View ref={node} class={props.class} style={{ ...props.style, opacity: down() ? 0.55 : 1 }}>{props.children}</View>;
}

/** The place's baked preview, or a wash of its accent when none was exported. */
export function Picture(props: { place: Place; width: number; height: number }) {
  return (
    <View class="relative overflow-hidden" style={{ width: props.width, height: props.height }}>
      <Show
        when={props.place.preview}
        fallback={<View class="absolute bg-gradient-to-b" style={{ insetL: 0, insetT: 0, width: props.width, height: props.height, gradFrom: tint(props.place.accent, 0.55), gradTo: "#0c0e14" }} />}
      >
        <Image src={props.place.preview} class="absolute" style={{ insetL: 0, insetT: 0, width: props.width, height: props.height }} />
      </Show>
    </View>
  );
}

/** A place as a postcard: its picture with the name over it. */
export function Postcard(props: { place: Place; width: number; saved: boolean; closed: string; children?: JSX.Element }) {
  const height = () => props.width / 2;
  // The "not on this device" badge shares the last line with the locality,
  // which gives way on a narrow card.
  const badge = () => (props.closed ? measure(props.closed.toUpperCase(), 12, true) + 24 : 0);
  return (
    <View class="relative overflow-hidden" style={{ width: props.width, height: height() }}>
      <Picture place={props.place} width={props.width} height={height()} />
      <View class="absolute bg-gradient-to-b from-[#00000000] to-[#000000d0]" style={{ insetL: 0, insetB: 0, width: props.width, height: 58 }} />
      <Text class="absolute text-base font-bold text-white" style={{ insetL: 10, insetB: 23 }}>
        {fit(props.place.name, 16, true, props.width - 20)}
      </Text>
      <Text class="absolute text-xs" style={{ insetL: 10, insetB: 8, textColor: DIM }}>
        {props.width - 20 - badge() < 64 ? "" : fit(`${props.place.locality} · ${props.place.country}`, 12, false, props.width - 20 - badge())}
      </Text>
      <Show when={props.closed}>
        <View class="absolute rounded px-2" style={{ insetR: 8, insetB: 8, bgColor: "#000000a0" }}>
          <Text class="text-xs font-bold" style={{ textColor: FAINT }}>{props.closed.toUpperCase()}</Text>
        </View>
      </Show>
      <Show when={props.saved}>
        <View class="absolute rounded px-2" style={{ insetR: 8, insetT: 8, bgColor: "#000000a0" }}>
          <Text class="text-xs font-bold" style={{ textColor: props.place.accent }}>SAVED</Text>
        </View>
      </Show>
      {props.children}
    </View>
  );
}

/** The lists as labels with a rule under the current one. `onTab` makes them
 *  tappable (touch); a pad switches them with its shoulder buttons. */
export function Tabs(props: { tab: Tab; width: number; height: number; accent: string; surface?: SurfaceId; onTab?: (tab: Tab) => void }) {
  // Each label takes its own width and an equal share of what is left over.
  const labels = TABS.map((tab) => TAB_LABELS[tab]);
  const widths = labels.map((label) => measure(label, 12, true));
  const pad = () => Math.max(0, (props.width - widths.reduce((sum, width) => sum + width, 0)) / (2 * TABS.length));
  const left = (index: number) => widths.slice(0, index).reduce((sum, width) => sum + width + 2 * pad(), 0);
  return (
    <View class="relative flex-row" style={{ width: props.width, height: props.height }}>
      <For each={TABS}>
        {(tab, index) => (
          <Touchable surface={props.surface} class="items-center justify-center" style={{ width: widths[index()] + 2 * pad(), height: props.height }} onTap={props.onTab ? () => props.onTab!(tab) : undefined}>
            <Text class={props.tab === tab ? "text-xs font-bold" : "text-xs"} style={{ textColor: props.tab === tab ? INK : FAINT }}>{labels[index()]}</Text>
          </Touchable>
        )}
      </For>
      <View class="absolute rounded-sm transition-transform duration-200 ease-out" style={{ insetL: 0, insetB: 2, width: widths[TABS.indexOf(props.tab)], height: 2, translateX: left(TABS.indexOf(props.tab)) + pad(), bgColor: props.accent }} />
    </View>
  );
}

/** The keyboard that edits the search: PocketJS's own, which takes the form
 *  of the surface it is on (a grid for a d-pad, keys for a finger). */
export function createSearch(browser: Browser): OskController {
  return createOsk({ value: browser.query, setValue: browser.setQuery, maxLength: 20 });
}

/** What is being searched for. A tap opens the keyboard; a pad has a button for it. */
export function SearchField(props: { search: OskController; browser: Browser; width: number; height: number; surface?: SurfaceId }) {
  const typing = () => props.search.isOpen();
  return (
    <Touchable surface={props.surface} class="relative" style={{ width: props.width, height: props.height }} onTap={() => props.search.open()}>
      <View class="absolute rounded-md" style={{ insetL: 8, insetT: 4, width: props.width - 16, height: props.height - 8, bgColor: typing() ? "#ffffff2a" : "#ffffff14", borderWidth: 1, borderColor: HAIRLINE }} />
      <Text class="absolute text-sm" style={{ insetL: 16, insetT: props.height / 2 - 9, textColor: typing() || props.browser.query() ? INK : FAINT }}>
        {typing() ? props.search.display() : props.browser.query() || "Search places"}
      </Text>
    </Touchable>
  );
}

/** The keyboard, along the bottom of its surface while it is open. Where
 *  the list and its field lie under the keys (`strip`), a strip above them
 *  shows what is typed and how many places it finds. */
export function SearchKeyboard(props: { search: OskController; browser: Browser; width: number; surface?: SurfaceId; strip?: boolean; keyHeight?: number }) {
  return (
    <View class="absolute flex-col" style={{ insetL: 0, insetB: 0, width: props.width, hitPass: 1 }}>
      <Show when={props.strip && props.search.isOpen()}>
        <View class="relative" style={{ width: props.width, height: 26, bgColor: "#10151c" }}>
          <View class="absolute" style={{ insetL: 0, insetT: 0, width: props.width, height: 1, bgColor: HAIRLINE }} />
          <Text class="absolute text-sm" style={{ insetL: 12, insetT: 4, textColor: INK }}>{props.search.display()}</Text>
          <Text class="absolute text-xs" style={{ insetR: 12, insetT: 6, textColor: DIM }}>{props.browser.caption()}</Text>
        </View>
      </Show>
      <Osk osk={props.search} surface={props.surface} keyHeight={props.keyHeight} />
    </View>
  );
}

/** One place in a list. */
function PlaceRow(props: { place: Place; active: boolean; width: number; height: number; thumb: boolean; browser: Browser }) {
  const two = () => props.height >= 40;
  const left = () => (props.thumb ? (props.height - 8) * 2 + 16 : 12);
  const room = () => props.width - left() - 30;
  return (
    <View class="relative" style={{ width: props.width, height: props.height, bgColor: props.active ? tint(props.place.accent, 0.2) : "#00000000" }}>
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: 3, height: props.height, bgColor: props.active ? props.place.accent : "#00000000" }} />
      <Show when={props.thumb}>
        <View class="absolute overflow-hidden rounded" style={{ insetL: 8, insetT: 4, width: (props.height - 8) * 2, height: props.height - 8 }}>
          <Picture place={props.place} width={(props.height - 8) * 2} height={props.height - 8} />
        </View>
      </Show>
      <Text class="absolute text-sm font-bold" style={{ insetL: left(), insetT: two() ? props.height / 2 - 17 : props.height / 2 - 9, textColor: props.browser.open(props.place) ? INK : DIM }}>
        {fit(props.place.name, 14, true, room())}
      </Text>
      <Show when={two()}>
        <Text class="absolute text-xs" style={{ insetL: left(), insetT: props.height / 2 + 2, textColor: FAINT }}>{fit(props.place.locality, 12, false, room())}</Text>
      </Show>
      <Text class="absolute text-xs font-bold" style={{ insetR: 10, insetT: props.height / 2 - 8, textColor: props.browser.open(props.place) ? props.place.accent : FAINT }}>
        {props.browser.saved(props.place.id) ? "★" : props.browser.open(props.place) ? "›" : ""}
      </Text>
      <View class="absolute" style={{ insetL: 0, insetB: 0, width: props.width, height: 1, bgColor: HAIRLINE }} />
    </View>
  );
}

/** The current list. The d-pad or a tap moves the focus (and the globe);
 *  confirming, or tapping the row that already has the focus, visits. */
export function PlaceList(props: { browser: Browser; width: number; height: number; rowHeight: number; thumb?: boolean; surface?: SurfaceId; active?: () => boolean }) {
  const [handle, setHandle] = createSignal<VirtualListHandle | null>(null);
  // The framework list owns scrolling and the d-pad walk. Its focused row
  // becomes the browser's focus when the visitor moved it, and the browser's
  // focus becomes its focused row when the list or the focus changed here.
  let seen: number | null = null;
  /** The focus before this frame: a press is delivered after the hooks below ran. */
  let settled = -1;
  onFrame(() => {
    settled = untrack(props.browser.focus);
    const at = handle()?.focusedIndex() ?? null;
    if (at === seen) return;
    seen = at;
    if (at !== null && at !== settled) props.browser.setFocus(at);
  });
  createEffect(() => {
    const list = handle();
    const at = props.browser.focus();
    if (!list || !props.browser.list().length) return;
    seen = at;
    list.focusRow(at);
  });
  return (
    <Show when={props.browser.list().length} fallback={<View class="items-center justify-center" style={{ width: props.width, height: props.height }}><Text class="text-xs" style={{ textColor: FAINT }}>{props.browser.caption()}</Text></View>}>
      <VirtualList
        surface={props.surface}
        count={props.browser.list().length}
        rowHeight={props.rowHeight}
        height={props.height}
        inputActive={props.active}
        ref={setHandle}
        onRowPress={(index) => (index === settled ? props.browser.visit(props.browser.list()[index]) : props.browser.setFocus(index))}
        renderRow={(index) => (
          <Show when={props.browser.list()[index]}>
            {(place) => <PlaceRow place={place()} active={props.browser.focus() === index} width={props.width} height={props.rowHeight} thumb={!!props.thumb} browser={props.browser} />}
          </Show>
        )}
      />
    </Show>
  );
}

/** The strip along the bottom of a screen with buttons: a notice or count at
 *  the left, what the buttons do at the right. */
export function Legend(props: { width: number; left: string; legend: string }) {
  return (
    <View class="relative" style={{ width: props.width, height: 24, bgColor: GLASS }}>
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: props.width, height: 1, bgColor: HAIRLINE }} />
      <Text class="absolute text-xs" style={{ insetL: 10, insetT: 5, textColor: DIM }}>{fit(props.left, 12, false, props.width - 32 - measure(props.legend, 12, false))}</Text>
      <Text class="absolute text-xs" style={{ insetR: 10, insetT: 5, textColor: INK }}>{props.legend}</Text>
    </View>
  );
}

/** A pill of text over the scene. */
export function Chip(props: { text: string; color?: string }) {
  return (
    <View class="rounded-md px-2 py-1" style={{ bgColor: "#000000a0" }}>
      <Text class="text-xs font-bold" style={{ textColor: props.color ?? INK }}>{props.text}</Text>
    </View>
  );
}

/** A row of a menu: its label, and a switch or the chosen value at the right. */
function MenuItem(props: { row: MenuRow; active: boolean; width: number; height: number }) {
  return (
    <View class="relative" style={{ width: props.width, height: props.height, bgColor: props.active ? "#ffffff24" : "#00000000" }}>
      <Text class={props.row.on === undefined && props.row.value === undefined ? "absolute text-sm font-bold" : "absolute text-sm"} style={{ insetL: 14, insetT: props.height / 2 - 9, textColor: INK }}>{props.row.label}</Text>
      <Show when={props.row.on !== undefined}>
        <View class="absolute rounded-full w-[34] h-[18]" style={{ insetR: 14, insetT: props.height / 2 - 9, bgColor: props.row.on ? "#4fd08a" : "#ffffff30" }}>
          <View class="absolute rounded-full w-[14] h-[14] bg-white transition-transform duration-150" style={{ insetL: 2, insetT: 2, translateX: props.row.on ? 16 : 0 }} />
        </View>
      </Show>
      <Show when={props.row.value !== undefined}>
        <Text class="absolute text-sm" style={{ insetR: 14, insetT: props.height / 2 - 9, textColor: DIM }}>{`${props.row.value} ›`}</Text>
      </Show>
      <View class="absolute" style={{ insetL: 0, insetB: 0, width: props.width, height: 1, bgColor: HAIRLINE }} />
    </View>
  );
}

/** A button for a finger: at least as tall as a fingertip on its surface. */
export function Button(props: { label: string; width: number; height: number; color?: string; strong?: boolean; surface?: SurfaceId; onPress: () => void }) {
  return (
    <Touchable surface={props.surface} class="rounded-lg items-center justify-center" style={{ width: props.width, height: props.height, bgColor: props.strong ? props.color ?? "#ffffff" : "#ffffff1f", borderWidth: 1, borderColor: HAIRLINE }} onTap={props.onPress}>
      <Text class="text-sm font-bold" style={{ textColor: props.strong ? "#0c0e14" : props.color ?? INK }}>{props.label}</Text>
    </Touchable>
  );
}

/**
 * A panel over a scrim, in the middle of a surface. While it is open the
 * pad and taps are its own: the back button or a tap outside closes it.
 */
export function Sheet(props: { open: Accessor<boolean>; onClose: () => void; width: number; height: number; panelWidth: number; panelHeight: number; surface?: SurfaceId; children: JSX.Element }) {
  createEffect(() => {
    if (props.open()) onCleanup(pushButtonHandlerBlock());
  });
  onButtonPress(BTN.CROSS, () => props.onClose(), { active: props.open, allowWhenBlocked: true });
  return (
    <View class="absolute" style={{ insetL: 0, insetT: 0, width: props.width, height: props.height, zIndex: 50, display: props.open() ? 0 : 1 }}>
      <Touchable surface={props.surface} class="absolute" style={{ insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: "#000000a6" }} onTap={props.onClose} />
      {/* FocusScope takes its props once, so the sized box is a plain view around it. */}
      <View class="absolute rounded-lg overflow-hidden" style={{ insetL: (props.width - props.panelWidth) / 2, insetT: Math.max(4, (props.height - props.panelHeight) / 2), width: props.panelWidth, height: props.panelHeight, bgColor: "#10141cf5", borderWidth: 1, borderColor: "#ffffff26" }}>
        <FocusScope active={props.open} class="flex-col w-full h-full">
          {props.children}
        </FocusScope>
      </View>
    </View>
  );
}

/** A place's menu as a sheet: rows the d-pad walks and a finger taps, and
 *  scrolls when the surface is shorter than the list. */
export function PlaceMenu(props: { visit: Visit; open: Accessor<boolean>; onClose: () => void; width: number; height: number; panelWidth: number; rowHeight: number; surface?: SurfaceId }) {
  const [handle, setHandle] = createSignal<VirtualListHandle | null>(null);
  const [focus, setFocus] = createSignal(0);
  const rows = () => props.visit.menu();
  const listHeight = () => Math.min(rows().length * props.rowHeight, Math.floor((props.height - 44) / props.rowHeight) * props.rowHeight);
  onFrame(() => {
    const at = handle()?.focusedIndex();
    if (at !== null && at !== undefined && at !== untrack(focus)) setFocus(at);
  });
  // The pad starts on the first row each time the sheet opens.
  createEffect(() => {
    if (props.open()) handle()?.focusRow(0);
  });
  return (
    <Sheet open={props.open} onClose={props.onClose} surface={props.surface} width={props.width} height={props.height} panelWidth={props.panelWidth} panelHeight={28 + listHeight()}>
      <View class="relative" style={{ width: props.panelWidth, height: 28 }}>
        <Text class="absolute text-xs font-bold tracking-wide" style={{ insetL: 14, insetT: 8, textColor: DIM }}>{fit((props.visit.place()?.name ?? "").toUpperCase(), 12, true, props.panelWidth - 28)}</Text>
        <View class="absolute" style={{ insetL: 0, insetB: 0, width: props.panelWidth, height: 1, bgColor: HAIRLINE }} />
      </View>
      <VirtualList
        surface={props.surface}
        count={rows().length}
        rowHeight={props.rowHeight}
        height={listHeight()}
        inputActive={props.open}
        ref={setHandle}
        onRowPress={(index) => {
          if (index === rows().length - 1) props.onClose();
          rows()[index]?.press();
        }}
        renderRow={(index) => <Show when={rows()[index]}>{(row) => <MenuItem row={row()} active={props.open() && focus() === index} width={props.panelWidth} height={props.rowHeight} />}</Show>}
      />
    </Sheet>
  );
}

/** The place's name as it appears when the visitor arrives. */
export function TitleCard(props: { visit: Visit; shown: boolean }) {
  return (
    <View class={props.shown ? "flex-col opacity-100 transition-opacity duration-300" : "flex-col opacity-0 transition-opacity duration-300"}>
      <Text class="text-xl font-bold text-white">{props.visit.place()?.name ?? ""}</Text>
      <Text class="text-xs" style={{ textColor: DIM }}>{props.visit.place() ? `${props.visit.place()!.locality} · ${props.visit.place()!.country} · ${props.visit.place()!.weather}` : ""}</Text>
    </View>
  );
}

/** A view that fades with `shown`. */
export function Fade(props: { shown: boolean; children: JSX.Element }) {
  return <View class={props.shown ? "opacity-100 transition-opacity duration-300" : "opacity-0 transition-opacity duration-300"}>{props.children}</View>;
}

/** The screen while a place loads, and when it could not be opened. */
export function Loading(props: { host: Host; visit: Visit; width: number; height: number; card: number }) {
  return (
    <View class="items-center justify-center flex-col gap-3" style={{ width: props.width, height: props.height, bgColor: "#05070bf0" }}>
      <Show when={props.visit.place()}>
        {(place) => (
          <View class="overflow-hidden rounded-lg" style={{ borderWidth: 1, borderColor: HAIRLINE }}>
            <Postcard place={place()} width={props.card} saved={false} closed="" />
          </View>
        )}
      </Show>
      <Text class="text-xs" style={{ textColor: DIM }}>{props.host.message() || "Loading the place…"}</Text>
    </View>
  );
}

export function Fault(props: { host: Host; width: number; height: number; children?: JSX.Element }) {
  return (
    <View class="items-center justify-center flex-col gap-2" style={{ width: props.width, height: props.height, bgColor: "#05070bf0" }}>
      <Text class="text-base font-bold text-white">This place could not be opened</Text>
      <Text class="text-xs" style={{ textColor: DIM }}>{fit(props.host.message(), 12, false, props.width - 24)}</Text>
      {props.children}
    </View>
  );
}

export { WASH };
