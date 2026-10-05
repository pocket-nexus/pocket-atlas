// Two screens (the 3DS): the scene and what it is on the top screen, the
// controls on the touch screen below. Lists scroll under a finger or the
// d-pad; in a place the lower screen is the shot list and a pad to look
// around with, and the buttons keep their meaning beside it.
import { createEffect, createSignal, For, Match, on, onMount, Show, Switch as Case } from "solid-js";
import { useActions } from "@pocketjs/framework/actions";
import { AuxiliarySurface, FocusScope, Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { createBrowser, type Browser } from "../browse.ts";
import { connectHost, type Host } from "../host.ts";
import { Button, Chip, createSearch, Fade, Fault, fit, kindLabel, Legend, Loading, PlaceList, PlaceMenu, Postcard, SearchField, SearchKeyboard, Tabs, TitleCard, Touchable } from "../parts.tsx";
import { DIM, FAINT, GLASS, HAIRLINE, INK, tint } from "../theme.ts";
import { createPulse } from "../clock.ts";
import { createVisit, type Visit } from "../visit.ts";

const TOP = { w: 400, h: 240 };
const LOW = { w: 320, h: 240 };
const BAR = 36, FOOTER = 24;
const BODY = LOW.h - BAR - FOOTER;
const FIELD = 36;
const GLOBE = { x: 112, y: 126, r: 96 };
const CARD = { x: 224, y: 46, w: 164 };

export default function DualScreen() {
  const host = connectHost();
  const browser = createBrowser(host, GLOBE);
  const visit = createVisit(host);
  return (
    <>
      <View style={{ width: TOP.w, height: TOP.h }}>
        <Case>
          <Match when={host.scene() === "atlas"}><AtlasTop browser={browser} /></Match>
          <Match when={host.scene() === "loading"}><Loading host={host} visit={visit} width={TOP.w} height={TOP.h} card={256} /></Match>
          <Match when={host.scene() === "place"}><PlaceTop host={host} visit={visit} /></Match>
          <Match when={host.scene() === "error"}><Fault host={host} width={TOP.w} height={TOP.h} /></Match>
        </Case>
      </View>
      <AuxiliarySurface>
        {() => (
          // The d-pad walks the focusable nodes of the active focus scope,
          // which is the top screen unless a scope says otherwise.
          <FocusScope autoFocus={false} restoreFocus={false} class="relative" style={{ width: LOW.w, height: LOW.h, bgColor: "#0c0e14" }}>
            <Case>
              <Match when={host.scene() === "atlas"}><AtlasLow browser={browser} /></Match>
              <Match when={host.scene() === "loading"}><Waiting text="Loading the place…" /></Match>
              <Match when={host.scene() === "place"}><PlaceLow host={host} visit={visit} /></Match>
              <Match when={host.scene() === "error"}><Failed host={host} /></Match>
            </Case>
          </FocusScope>
        )}
      </AuxiliarySurface>
    </>
  );
}

function AtlasTop(props: { browser: Browser }) {
  const browser = props.browser;
  return (
    <View class="relative" style={{ width: TOP.w, height: TOP.h }}>
      <Text class="absolute text-lg font-bold text-white" style={{ insetL: 12, insetT: 8 }}>Pocket Atlas</Text>
      <Text class="absolute text-xs" style={{ insetR: 12, insetT: 14, textColor: DIM }}>{browser.caption()}</Text>
      <Show when={browser.focused()}>
        {(place) => (
          <View class="absolute flex-col overflow-hidden rounded-lg" style={{ insetL: CARD.x, insetT: CARD.y, width: CARD.w, bgColor: GLASS, borderWidth: 1, borderColor: HAIRLINE }}>
            <Postcard place={place()} width={CARD.w} saved={browser.saved(place().id)} closed={browser.open(place()) ? "" : browser.closed(place())} />
            <View class="flex-col gap-1 px-2 py-2">
              <Text class="text-xs font-bold tracking-wide" style={{ textColor: place().accent }}>{kindLabel(place().kind)}</Text>
              <Text class="text-xs" style={{ textColor: DIM }}>{fit(place().weather, 12, false, CARD.w - 16)}</Text>
              <Text class="text-xs" style={{ textColor: FAINT }}>{fit(place().tags.join(" · "), 12, false, CARD.w - 16)}</Text>
            </View>
          </View>
        )}
      </Show>
      <Show when={browser.notice()}>
        <View class="absolute" style={{ insetL: 12, insetB: 10 }}><Chip text={browser.notice()} /></View>
      </Show>
    </View>
  );
}

function AtlasLow(props: { browser: Browser }) {
  const browser = props.browser;
  const accent = () => browser.focused()?.accent ?? "#8fb4ff";
  const search = createSearch(browser);
  const searching = () => browser.tab() === "search";
  const actions = useActions(() => ({
    confirm: { label: "visit", when: () => !!browser.focused() },
    option: { label: browser.focused() && browser.saved(browser.focused()!.id) ? "unsave" : "save", run: () => browser.focused() && browser.toggleSaved(browser.focused()!.id), when: () => !!browser.focused() },
    action: { label: searching() ? "type" : "search", run: () => (browser.setTab("search"), search.open()) },
    sectionPrev: { label: "lists", run: () => browser.stepTab(-1) },
    sectionNext: { label: "lists", run: () => browser.stepTab(1) },
  }));
  return (
    <View class="relative flex-col" style={{ width: LOW.w, height: LOW.h }}>
      <View class="relative" style={{ width: LOW.w, height: BAR, bgColor: "#161a24" }}>
        <Tabs tab={browser.tab()} width={LOW.w} height={BAR} accent={accent()} surface="auxiliary" onTab={browser.setTab} />
        <View class="absolute" style={{ insetL: 0, insetB: 0, width: LOW.w, height: 1, bgColor: HAIRLINE }} />
      </View>
      <Show when={searching()}><SearchField search={search} browser={browser} width={LOW.w} height={FIELD} surface="auxiliary" /></Show>
      <PlaceList browser={browser} width={LOW.w} height={searching() ? BODY - FIELD : BODY} rowHeight={BODY / 4} thumb surface="auxiliary" />
      <Legend width={LOW.w} left="" legend={actions.legend()} />
      <SearchKeyboard search={search} browser={browser} width={LOW.w} surface="auxiliary" />
    </View>
  );
}

function Waiting(props: { text: string }) {
  return (
    <View class="items-center justify-center" style={{ width: LOW.w, height: LOW.h }}>
      <Text class="text-sm" style={{ textColor: DIM }}>{props.text}</Text>
    </View>
  );
}

function Failed(props: { host: Host }) {
  const leave = () => props.host.send({ type: "leave" });
  const actions = useActions({ back: { label: "atlas", run: leave } });
  return (
    <View class="relative items-center justify-center" style={{ width: LOW.w, height: LOW.h }}>
      <Button label="Back to the atlas" width={180} height={40} surface="auxiliary" onPress={leave} />
      <View class="absolute" style={{ insetL: 0, insetB: 0 }}><Legend width={LOW.w} left="" legend={actions.legend()} /></View>
    </View>
  );
}

function PlaceTop(props: { host: Host; visit: Visit }) {
  const [title, showTitle] = createPulse(5);
  const [shot, showShot] = createPulse(3);
  onMount(showTitle);
  createEffect(on(props.host.shot, () => showShot(), { defer: true }));
  return (
    <View class="relative" style={{ width: TOP.w, height: TOP.h }}>
      <View class="absolute" style={{ insetL: 12, insetB: 12 }}><TitleCard visit={props.visit} shown={title()} /></View>
      <View class="absolute" style={{ insetL: 10, insetT: 10 }}><Fade shown={shot()}><Chip text={props.visit.shotLabel()} /></Fade></View>
      <Show when={props.visit.on("stats")}>
        <View class="absolute" style={{ insetR: 10, insetT: 10 }}><Chip text={props.host.stats()} /></View>
      </Show>
      <Show when={props.host.paused()}>
        <View class="absolute" style={{ insetL: TOP.w / 2 - 30, insetT: 10 }}><Chip text="PAUSED" /></View>
      </Show>
    </View>
  );
}

const SHOTS_W = 148;
const PAD = { x: SHOTS_W + 8, y: BAR + 8, w: LOW.w - SHOTS_W - 16, h: BODY - 16 };

function PlaceLow(props: { host: Host; visit: Visit }) {
  const host = props.host, visit = props.visit;
  const [menu, setMenu] = createSignal(false);
  const accent = () => visit.place()?.accent ?? "#8fb4ff";
  const actions = useActions(() => ({
    sectionPrev: { label: "shot", run: () => visit.step(-1) },
    sectionNext: { label: "shot", run: () => visit.step(1) },
    media: { label: visit.playLabel(), run: visit.play },
    action: { label: "menu", run: () => setMenu(true) },
    back: { label: "atlas", run: visit.leave },
  }));
  createEffect(() => host.send({ type: "hold", on: menu() }));
  // A finger on the pad turns the camera by what it travels.
  let pad: NodeMirror | undefined;
  createGesture({
    surface: "auxiliary",
    region: { node: () => pad },
    tapSlop: 9999,
    onMove: (c) => {
      if (c.fdx || c.fdy) host.send({ type: "look", dx: c.fdx, dy: c.fdy });
    },
  });
  const rowHeight = () => Math.min(34, BODY / Math.max(1, host.shots().length));
  return (
    <View class="relative" style={{ width: LOW.w, height: LOW.h }}>
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: LOW.w, height: BAR, bgColor: "#161a24" }}>
        <Text class="absolute text-sm font-bold text-white" style={{ insetL: 10, insetT: 9 }}>{fit(visit.place()?.name ?? "", 14, true, 134)}</Text>
        <View class="absolute" style={{ insetR: 116, insetT: 5 }}><Button label={visit.playLabel() === "pause" ? "Pause" : visit.playLabel() === "play" ? "Play" : "Tour"} width={52} height={26} surface="auxiliary" onPress={visit.play} /></View>
        <View class="absolute" style={{ insetR: 60, insetT: 5 }}><Button label="Menu" width={52} height={26} surface="auxiliary" onPress={() => setMenu(true)} /></View>
        <View class="absolute" style={{ insetR: 4, insetT: 5 }}><Button label="Atlas" width={52} height={26} surface="auxiliary" onPress={visit.leave} /></View>
        <View class="absolute" style={{ insetL: 0, insetB: 0, width: LOW.w, height: 1, bgColor: HAIRLINE }} />
      </View>
      <View class="absolute flex-col" style={{ insetL: 0, insetT: BAR, width: SHOTS_W, height: BODY }}>
        <For each={host.shots()}>
          {(name, index) => (
            <Touchable surface="auxiliary" class="relative" style={{ width: SHOTS_W, height: rowHeight(), bgColor: host.shot() === index() ? tint(accent(), 0.22) : "#00000000" }} onTap={() => visit.cut(index())}>
              <View class="absolute" style={{ insetL: 0, insetT: 0, width: 3, height: rowHeight(), bgColor: host.shot() === index() ? accent() : "#00000000" }} />
              <Text class="absolute text-xs font-bold" style={{ insetL: 10, insetT: rowHeight() / 2 - 8, textColor: FAINT }}>{`${index() + 1}`}</Text>
              <Text class="absolute text-sm" style={{ insetL: 26, insetT: rowHeight() / 2 - 9, textColor: INK }}>{fit(name, 14, false, SHOTS_W - 34)}</Text>
              <View class="absolute" style={{ insetL: 0, insetB: 0, width: SHOTS_W, height: 1, bgColor: HAIRLINE }} />
            </Touchable>
          )}
        </For>
      </View>
      <View ref={pad} class="absolute rounded-lg items-center justify-center flex-col gap-1" style={{ insetL: PAD.x, insetT: PAD.y, width: PAD.w, height: PAD.h, bgColor: "#ffffff0d", borderWidth: 1, borderColor: HAIRLINE }}>
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: FAINT }}>LOOK</Text>
        <Text class="text-xs" style={{ textColor: FAINT }}>{host.tour() ? "Drag to take the camera" : "Drag to look around"}</Text>
      </View>
      <View class="absolute" style={{ insetL: 0, insetB: 0 }}>
        <Legend width={LOW.w} left={host.tour() ? "Tour" : "Free camera"} legend={actions.legend()} />
      </View>
      <PlaceMenu visit={visit} open={menu} onClose={() => setMenu(false)} surface="auxiliary" width={LOW.w} height={LOW.h} panelWidth={240} rowHeight={30} />
    </View>
  );
}
