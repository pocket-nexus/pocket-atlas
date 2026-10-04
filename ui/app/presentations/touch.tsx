// A touch panel and nothing else (the iPod touch, held sideways): every verb
// is a control under a finger. On the atlas a finger spins the globe and
// scrolls the lists; in a place two sticks stand in the lower corners, the
// left to walk and the right to look, and a tap elsewhere calls up the bar.
import { createEffect, createSignal, Match, on, onMount, Show, Switch as Case } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { createBrowser, type Browser } from "../browse.ts";
import { connectHost, type Host } from "../host.ts";
import { createSearch, SearchField, SearchKeyboard, Button, Chip, Fade, Fault, Loading, PlaceList, PlaceMenu, Postcard, Tabs, TitleCard, Touchable } from "../parts.tsx";
import { GLASS, HAIRLINE, tint } from "../theme.ts";
import { createPulse } from "../clock.ts";
import { createVisit, reportQuiet } from "../visit.ts";

const W = 480, H = 320;
/** A fingertip on this panel (Pocket HIG, touch modality). */
const TARGET = 44;
const FIELD = 36;
const PANEL = { x: 252, y: 8, w: 220, h: H - 16 };
const CARD_H = PANEL.w / 2;
const GLOBE = { x: 126, y: 164, r: 112 };

export default function TouchScreen() {
  const host = connectHost();
  const browser = createBrowser(host, GLOBE);
  return (
    <View class="w-full h-full">
      <Case>
        <Match when={host.scene() === "atlas"}><Atlas host={host} browser={browser} /></Match>
        <Match when={host.scene() === "loading"}><Loading host={host} visit={createVisit(host)} width={W} height={H} card={256} /></Match>
        <Match when={host.scene() === "place"}><Place host={host} /></Match>
        <Match when={host.scene() === "error"}>
          <Fault host={host} width={W} height={H}>
            <View style={{ marginT: 8 }}><Button label="Back to the atlas" width={180} height={TARGET} onPress={() => host.send({ type: "leave" })} /></View>
          </Fault>
        </Match>
      </Case>
    </View>
  );
}

function Atlas(props: { host: Host; browser: Browser }) {
  const browser = props.browser;
  const accent = () => browser.focused()?.accent ?? "#8fb4ff";
  const list = PANEL.h - CARD_H - TARGET - 12;
  const search = createSearch(browser);
  const searching = () => browser.tab() === "search";
  // A finger on the globe turns it.
  let globe: NodeMirror | undefined;
  createGesture({
    region: { node: () => globe },
    tapSlop: 9999,
    onMove: (c) => {
      if (c.fdx || c.fdy) props.host.send({ type: "spin", dx: c.fdx, dy: c.fdy });
    },
  });
  return (
    <View class="relative w-full h-full">
      <View ref={globe} class="absolute" style={{ insetL: 0, insetT: 0, width: PANEL.x - 4, height: H }} />
      <Text class="absolute text-lg font-bold text-white" style={{ insetL: 14, insetT: 10, hitPass: 1 }}>Pocket Atlas</Text>
      <Show when={browser.notice()}>
        <View class="absolute" style={{ insetL: 14, insetB: 12 }}><Chip text={browser.notice()} /></View>
      </Show>
      <View class="absolute flex-col overflow-hidden rounded-lg" style={{ insetL: PANEL.x, insetT: PANEL.y, width: PANEL.w, height: PANEL.h, bgColor: GLASS, borderWidth: 1, borderColor: HAIRLINE }}>
        <Show when={browser.focused()} fallback={<View style={{ width: PANEL.w, height: CARD_H }} />}>
          {(place) => <Postcard place={place()} width={PANEL.w} under={34} saved={browser.saved(place().id)} closed={browser.open(place()) ? "" : browser.closed(place())} />}
        </Show>
        <View class="absolute bg-gradient-to-b from-[#000000c0] to-[#00000000]" style={{ insetL: 0, insetT: 0, width: PANEL.w, height: 40 }} />
        <View class="absolute" style={{ insetL: 0, insetT: 0 }}>
          <Tabs tab={browser.tab()} width={PANEL.w} height={34} accent={accent()} onTab={browser.setTab} />
        </View>
        <View class="flex-row gap-2 px-2 py-1" style={{ width: PANEL.w, height: TARGET + 12, paddingT: 6 }}>
          <Button label={browser.focused() && browser.saved(browser.focused()!.id) ? "Saved" : "Save"} width={70} height={TARGET} onPress={() => browser.focused() && browser.toggleSaved(browser.focused()!.id)} />
          <Button label="Visit" width={PANEL.w - 70 - 24} height={TARGET} strong color={browser.focused() && browser.open(browser.focused()!) ? accent() : tint("#ffffff", 0.35)} onPress={() => browser.visit(browser.focused())} />
        </View>
        <Show when={searching()}><SearchField search={search} browser={browser} width={PANEL.w} height={FIELD} /></Show>
        <PlaceList browser={browser} width={PANEL.w} height={searching() ? list - FIELD : list} rowHeight={TARGET} />
      </View>
      <SearchKeyboard search={search} browser={browser} width={W} strip keyHeight={34} />
    </View>
  );
}

/** A stick's ring, how far around its centre a thumb still takes hold of it,
 *  and the play at its centre that does nothing. */
const STICK = 46, KNOB = 44, REACH = 84, SLACK = 0.18;

/** A stick that stays where it is drawn: a thumb landing on or near it
 *  pushes it toward where it landed. */
function Stick(props: { at: { x: number; y: number }; shown: boolean; onChange: (x: number, y: number) => void }) {
  let area: NodeMirror | undefined;
  const [knob, setKnob] = createSignal({ x: 0, y: 0 });
  const [held, setHeld] = createSignal(false);
  const push = (c: { x: number; y: number }) => {
    let x = (c.x - props.at.x) / STICK, y = (c.y - props.at.y) / STICK;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    setKnob({ x, y });
    // Past the slack the push grows from nothing, so the camera never jumps.
    const drive = length <= SLACK ? 0 : (Math.min(1, length) - SLACK) / (1 - SLACK) / Math.min(1, length);
    props.onChange(x * drive, y * drive);
  };
  const rest = () => {
    setHeld(false);
    setKnob({ x: 0, y: 0 });
    props.onChange(0, 0);
  };
  createGesture({
    region: { node: () => area },
    tapSlop: 9999,
    onDown: (c) => {
      setHeld(true);
      push(c);
    },
    onMove: push,
    onUp: rest,
    onCancel: rest,
  });
  const alpha = () => (held() ? 0.5 : 0.24);
  return (
    <View ref={area} class="absolute" style={{ insetL: props.at.x - REACH, insetT: props.at.y - REACH, width: REACH * 2, height: REACH * 2 }}>
      <View class="absolute rounded-full w-[92] h-[92]" style={{ display: props.shown ? 0 : 1, insetL: REACH - STICK, insetT: REACH - STICK, bgColor: tint("#ffffff", alpha() * 0.35), borderWidth: 2, borderColor: tint("#ffffff", alpha()) }} />
      <View class="absolute rounded-full w-[44] h-[44]" style={{ display: props.shown ? 0 : 1, insetL: REACH - KNOB / 2, insetT: REACH - KNOB / 2, translateX: knob().x * STICK, translateY: knob().y * STICK, bgColor: tint("#ffffff", alpha() + 0.15) }} />
    </View>
  );
}

function Place(props: { host: Host }) {
  const host = props.host;
  const visit = createVisit(host);
  const [menu, setMenu] = createSignal(false);
  const [bar, showBar] = createPulse(5);
  const [title, showTitle] = createPulse(5);
  // The sticks stand in their corners while the visitor has the camera. On
  // a tour they show on arrival and at a tap, then leave the view clear; with
  // nothing showing the renderer draws the place alone.
  const [hint, showHint] = createPulse(5);
  const hands = () => hint() || !host.tour();
  const wake = () => {
    showBar();
    showHint();
  };
  onMount(() => {
    showTitle();
    wake();
  });
  reportQuiet(host, () => bar() || title() || hands() || menu() || !!visit.on("stats"));
  createEffect(on(host.shot, () => showBar(), { defer: true }));
  // The sticks: move y is forward, look y is up. Sent when they change.
  const sticks = { mx: 0, my: 0, lx: 0, ly: 0 };
  let sent = "0,0,0,0";
  onFrame(() => {
    const now = [sticks.mx, -sticks.my, sticks.lx, -sticks.ly].map((v) => Math.round(v * 100));
    const key = now.join(",");
    if (key === sent) return;
    sent = key;
    host.send({ type: "drive", mx: now[0], my: now[1], lx: now[2], ly: now[3] });
  });
  const top = TARGET + 12;
  return (
    <View class="relative w-full h-full">
      <Touchable class="absolute" style={{ insetL: 0, insetT: 0, width: W, height: H }} onTap={wake} />
      <Stick at={{ x: 82, y: H - 82 }} shown={hands()} onChange={(x, y) => { sticks.mx = x; sticks.my = y; }} />
      <Stick at={{ x: W - 82, y: H - 82 }} shown={hands()} onChange={(x, y) => { sticks.lx = x; sticks.ly = y; }} />
      <View class="absolute" style={{ insetL: 14, insetT: top + 8, hitPass: 1 }}><TitleCard visit={visit} shown={title() && !menu()} /></View>
      <Show when={visit.on("stats")}>
        <View class="absolute" style={{ insetR: 10, insetT: top + 8 }}><Chip text={host.stats()} /></View>
      </Show>
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: W, display: bar() && !menu() ? 0 : 1 }}>
        <Fade shown={bar() && !menu()}>
          <View class="relative flex-row items-center gap-2 px-2" style={{ width: W, height: top, bgColor: GLASS }}>
            <Button label="‹ Atlas" width={72} height={TARGET} onPress={visit.leave} />
            <Button label="‹" width={TARGET} height={TARGET} onPress={() => { visit.step(-1); showBar(); }} />
            <View class="items-center justify-center" style={{ width: W - 16 - 72 - TARGET * 2 - (TARGET + 12) - (TARGET + 8) - 8 * 5, height: TARGET }}>
              <Text class="text-sm font-bold text-white">{visit.shotLabel()}</Text>
            </View>
            <Button label="›" width={TARGET} height={TARGET} onPress={() => { visit.step(1); showBar(); }} />
            <Button label={visit.playLabel() === "pause" ? "Pause" : visit.playLabel() === "play" ? "Play" : "Tour"} width={TARGET + 12} height={TARGET} onPress={() => { visit.play(); showBar(); }} />
            <Button label="Menu" width={TARGET + 8} height={TARGET} onPress={() => setMenu(true)} />
            <View class="absolute" style={{ insetL: 0, insetB: 0, width: W, height: 1, bgColor: HAIRLINE }} />
          </View>
        </Fade>
      </View>
      <PlaceMenu visit={visit} open={menu} onClose={() => setMenu(false)} width={W} height={H} panelWidth={280} rowHeight={40} />
    </View>
  );
}
