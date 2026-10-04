// One 480×272 screen with a pad: the PSP, and the Vita, whose panel also
// takes taps and drags. The globe (drawn by the renderer) sits at the left,
// the lists at the right; in a place the scene has the screen and the
// interface shows only what was just asked for.
import { createEffect, createSignal, Match, on, onMount, Show, Switch as Case } from "solid-js";
import { useActions } from "@pocketjs/framework/actions";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { surfaceHasTouch } from "@pocketjs/framework/modality";
import { createBrowser, type Browser } from "../browse.ts";
import { connectHost, type Host } from "../host.ts";
import { Chip, createSearch, Fade, Fault, Legend, Loading, PlaceList, PlaceMenu, Postcard, SearchField, SearchKeyboard, Tabs, TitleCard } from "../parts.tsx";
import { GLASS, HAIRLINE } from "../theme.ts";
import { createPulse } from "../clock.ts";
import { createVisit, reportQuiet } from "../visit.ts";

const W = 480, H = 272;
const FOOTER = 24;
const PANEL = { x: 258, y: 6, w: 216, h: H - FOOTER - 12 };
const CARD_H = PANEL.w / 2;
const ROW = (PANEL.h - CARD_H) / 4;
// Where the Vita's globe is baked to sit (its view rays are cooked for one
// camera); the PSP's globe goes where it is told, so it is told the same.
const GLOBE = { x: 150, y: 136, r: 100 };

export default function SingleScreen() {
  const host = connectHost();
  const browser = createBrowser(host, GLOBE);
  return (
    <View class="w-full h-full">
      <Case>
        <Match when={host.scene() === "atlas"}><Atlas host={host} browser={browser} /></Match>
        <Match when={host.scene() === "loading"}><Loading host={host} visit={createVisit(host)} width={W} height={H} card={256} /></Match>
        <Match when={host.scene() === "place"}><Place host={host} /></Match>
        <Match when={host.scene() === "error"}><Failed host={host} /></Match>
      </Case>
    </View>
  );
}

function Atlas(props: { host: Host; browser: Browser }) {
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
    <View class="relative w-full h-full">
      <Text class="absolute text-lg font-bold text-white" style={{ insetL: 14, insetT: 8 }}>Pocket Atlas</Text>
      <View class="absolute flex-col overflow-hidden rounded-lg" style={{ insetL: PANEL.x, insetT: PANEL.y, width: PANEL.w, height: PANEL.h, bgColor: GLASS, borderWidth: 1, borderColor: HAIRLINE }}>
        <Show when={browser.focused()} fallback={<View style={{ width: PANEL.w, height: CARD_H }} />}>
          {(place) => <Postcard place={place()} width={PANEL.w} under={26} saved={browser.saved(place().id)} closed={browser.open(place()) ? "" : browser.closed(place())} />}
        </Show>
        <View class="absolute bg-gradient-to-b from-[#000000c0] to-[#00000000]" style={{ insetL: 0, insetT: 0, width: PANEL.w, height: 34 }} />
        <View class="absolute" style={{ insetL: 0, insetT: 0 }}>
          <Tabs tab={browser.tab()} width={PANEL.w} height={26} accent={accent()} onTab={surfaceHasTouch() ? browser.setTab : undefined} />
        </View>
        <Show when={searching()}><SearchField search={search} browser={browser} width={PANEL.w} height={ROW} /></Show>
        <PlaceList browser={browser} width={PANEL.w} height={searching() ? ROW * 3 : ROW * 4} rowHeight={ROW} />
      </View>
      <View class="absolute" style={{ insetL: 0, insetB: 0 }}>
        <Legend width={W} left={browser.notice() || browser.caption()} legend={actions.legend()} />
      </View>
      <SearchKeyboard search={search} browser={browser} width={W} strip />
    </View>
  );
}

function Failed(props: { host: Host }) {
  const actions = useActions({ back: { label: "atlas", run: () => props.host.send({ type: "leave" }) } });
  return (
    <View class="relative w-full h-full">
      <Fault host={props.host} width={W} height={H} />
      <View class="absolute" style={{ insetL: 0, insetB: 0 }}><Legend width={W} left="" legend={actions.legend()} /></View>
    </View>
  );
}

function Place(props: { host: Host }) {
  const host = props.host;
  const visit = createVisit(host);
  const [menu, setMenu] = createSignal(false);
  const [legend, showLegend] = createPulse(5);
  const [title, showTitle] = createPulse(5);
  const [shot, showShot] = createPulse(3);
  onMount(() => {
    showTitle();
    showLegend();
  });
  createEffect(on(host.shot, () => showShot(), { defer: true }));
  // Any button brings the legend back for a while.
  onFrame((buttons) => {
    if (buttons) showLegend();
  });
  const actions = useActions(() => ({
    sectionPrev: { label: "shot", run: () => visit.step(-1) },
    sectionNext: { label: "shot", run: () => visit.step(1) },
    media: { label: visit.playLabel(), run: visit.play },
    action: { label: "menu", run: () => setMenu(true) },
    back: { label: "atlas", run: visit.leave },
  }));
  reportQuiet(host, () => legend() || title() || shot() || menu() || host.paused() || !!visit.on("stats"));
  // While the menu is up the pad is the interface's, not the camera's.
  createEffect(() => host.send({ type: "hold", on: menu() }));
  return (
    <View class="relative w-full h-full">
      <View class="absolute" style={{ insetL: 14, insetB: FOOTER + 10 }}><TitleCard visit={visit} shown={title() && !menu()} /></View>
      <View class="absolute" style={{ insetL: 10, insetT: 10 }}><Fade shown={shot() && !menu()}><Chip text={visit.shotLabel()} /></Fade></View>
      <Show when={visit.on("stats")}>
        <View class="absolute" style={{ insetR: 10, insetT: 10 }}><Chip text={host.stats()} /></View>
      </Show>
      <Show when={host.paused() && !menu()}>
        <View class="absolute" style={{ insetL: W / 2 - 30, insetT: 10 }}><Chip text="PAUSED" /></View>
      </Show>
      <View class="absolute" style={{ insetL: 0, insetB: 0 }}>
        <Fade shown={legend() && !menu()}><Legend width={W} left={host.tour() ? "Tour" : "Free camera"} legend={actions.legend()} /></Fade>
      </View>
      <PlaceMenu visit={visit} open={menu} onClose={() => setMenu(false)} width={W} height={H} panelWidth={240} rowHeight={30} />
    </View>
  );
}
