// Pocket Atlas in a browser tab: the wgpu shell (../src, built to pkg/) and
// the game's own interface (../../ui, one bundle a device, compiled by
// tools/atlas-ui.ts), which a realm of the page runs on PocketJS's UI core and
// the shell lays over the globe or the place. The page around them is the
// Pocket3D player of PocketJS's browser kernel
// (vendor/pocketjs/devices/web/pocket-web-wgpu, staged beside this file): the
// bar, the device's shell with the screens in it and its keys as the controls,
// the dock. What is Atlas's here is what it says of itself, and the frame.
//
// The page shows one of the handhelds the atlas runs on: its screens at their
// own size in its shell, its presentation of the interface. The Pocket3D title
// card plays first; the interface and the globe's surface are read while it
// plays.
//
// The address chooses the device:
//
//   ?device=vita|psp|3ds|ipod   the handheld (without it: an iPod touch for a finger, a PS Vita otherwise)
//   ?globe=URL                  the globe's surface: its file, on a server that answers byte ranges, or the
//                               manifest (.json) of one cut into pieces. Without it, the page's own
//                               (<meta name="pocket-globe">)
//   ?words=enter=<place>        what a development host would send the shell
//   ?interface=off              the globe alone: no guest is started
//
// `window.pocketAtlas` is the running shell, for a console and for tools/wgpu.ts.
import { playTitle } from "./pocket3d-title.js";
import { frames, hasWebGPU, titleCard } from "./pocket3d-shell.js";
import { openInterface, screens } from "./pocket3d-interface.js";
import { createPlayer } from "./pocket3d-player.js";
import init, { Atlas, shapes, surface, turns } from "./pkg/atlas_wgpu.js";

// The handhelds: each one's screen is the shell's shape of the same name and its interface the bundle under
// ui/<id>/. `sticks` says what the device's keys stand for: on the atlas screen the left stick spins the
// globe, and a device with a touch panel alone has no buttons at all. `note` is what the player's Simulated
// mark says of the device: every layout here draws the PS Vita build's places (wgpu/README.md, "What
// differs from the PS Vita") and the iPod touch build's globe, and the device itself draws its own.
const DEVICES = [
  {
    id: "vita",
    label: "PS Vita",
    sticks: 2,
    note: "This page draws the PS Vita build's places from the same packs, at about twice the sharpness. On a PS Vita, surfaces more than 18 metres away are not shadowed by the buildings and trees around them and, unless they are wet, do not shine. The shadows of wires and railings break into dots, and the people inside the Konbini are pale. The globe here is the iPod touch build's. The PS Vita draws its own.",
  },
  {
    id: "psp",
    label: "PSP",
    sticks: 1,
    note: "This page draws the PS Vita build's places and the iPod touch build's globe. A PSP has two of the seven places, Rainy Night Konbini and Lombard Street, with lower detail and light that is worked out when the place is built.",
  },
  {
    id: "3ds",
    label: "Nintendo 3DS",
    sticks: 1,
    note: "This page draws the PS Vita build's places and the iPod touch build's globe. A 3DS has all seven places at 400 by 240, with lower detail and light that is worked out when the place is built.",
  },
  {
    id: "ipod",
    label: "iPod touch",
    sticks: 0,
    note: "The globe is the iPod touch build's own. The places are the PS Vita build's. An iPod touch 4 has five of the seven, without Sangubashi Crossing and Lombard Street, at 480 by 320 with lower detail and light that is worked out when the place is built.",
  },
];
// Where the interface's saved places are kept between visits (a device keeps them in a file).
const KEPT = "pocket-atlas.interface";

const query = new URLSearchParams(location.search);
const beside = (name) => new URL(name, import.meta.url).href;
const message = (error) => String(error?.message ?? error);
const meta = (name) => document.querySelector(`meta[name="${name}"]`).content;
const coarse = matchMedia("(pointer: coarse)").matches;
const started = performance.now();

// The page: PocketJS's player, with the device the address asks for, or an iPod touch under a finger.
const wanted = query.get("device");
let device = DEVICES.find((d) => d.id === wanted) ?? DEVICES.find((d) => d.id === (coarse ? "ipod" : "vita"));
let present = () => {};
const player = createPlayer({
  title: "Pocket Atlas",
  tagline: "The world in your pocket.",
  devices: DEVICES,
  device: device.id,
  // (the devices Atlas is built for)
  runsOn: ["psp", "vita", "3ds", "ipod-touch", "android"],
  pick: (id) => present(DEVICES.find((d) => d.id === id)),
});
const { canvas, stage, controls } = player;
const say = (text) => player.say(text);

function kept() {
  try {
    return localStorage.getItem(KEPT) ?? "";
  } catch {
    return "";
  }
}

async function start() {
  // The card is the first picture of every launch, and covers the page while the atlas is read. No frame is
  // drawn while it plays.
  const title = titleCard(playTitle);
  if (!hasWebGPU()) {
    await title;
    say("This browser has no WebGPU, which Pocket Atlas draws with.");
    return;
  }
  await init();
  const all = JSON.parse(shapes());

  // The shell, on the first device's screen. It draws before the globe is there: the night, and the interface.
  const first = all.find((s) => s.name === device.id);
  stage.show({ device: device.id, width: first.width, height: first.height });
  const atlas = await Atlas.open(canvas, first.name, kept());
  atlas.packs(meta("pocket-places"));
  let shape = first;

  // What a frame's parts cost, in milliseconds summed since the start: the guest's turns, the redraws of
  // its picture (`redrawMs`: the UI core's drawing, `drawMs` of it, then the upload), and the second
  // screen's redraws.
  const timing = { turns: 0, turnMs: 0, redraws: 0, redrawMs: 0, drawMs: 0, lowers: 0, lowerMs: 0 };
  // (milliseconds from the page's start: the globe read, the interface up, the first frame, the first with the globe)
  const report = { atlas, device: () => device.id, shape: () => shape, globe: 0, globeRead: null, interfaceReady: 0, firstFrame: 0, firstGlobe: 0, frames: 0, failure: "", timing };
  window.pocketAtlas = report;

  // The globe's surface, read beside everything else.
  const globe = new URL(query.get("globe") ?? meta("pocket-globe"), location.href).href;
  surface(globe).then((read) => {
    atlas.globe(read);
    report.globe = performance.now() - started;
    report.globeRead = { requests: read.requests(), bytes: read.bytes() };
  }).catch((error) => {
    // Without its surface the globe is not drawn; the interface's lists are still there.
    report.failure = message(error);
    atlas.fail(report.failure);
  });

  // A device on the page: its screens, its controls, and its presentation of the interface in a new realm.
  let ui = null;
  let lower = null;
  present = async (next) => {
    device = next;
    const plan = await (await fetch(beside(`ui/${next.id}/plan.json`))).json();
    if (device !== next) return;
    // The screens are the plan's: the scene has the primary surface's pixels, the globe is placed in its
    // logical ones.
    const of = screens(plan);
    const to = all.find((s) => s.name === next.id);
    // The device's shell with its screens in it, its keys as the controls, and the screen that takes touch.
    player.show(next.id, { width: of.physical[0], height: of.physical[1], lower: of.auxiliary, sticks: next.sticks, glyphs: of.glyphs, touch: of.touch, viewport: of.viewport });
    shape = JSON.parse(atlas.reshape(to.name, of.physical[0], of.physical[1], to.samples, to.hz, of.viewport[0], of.viewport[1]));
    lower = of.auxiliary ? new ImageData(of.auxiliary[0], of.auxiliary[1]) : null;
    // The guest of the device before goes with its realm; the new one is told the whole state on its first turn.
    ui?.close();
    ui = null;
    atlas.overlay_hide();
    if (query.get("interface") === "off") return;
    try {
      // The guest is turned as on the handhelds, and told so before its bundle runs.
      const opened = await openInterface({ realm: beside("app-instance.html"), wasm: beside("pocketjs.wasm"), bundle: beside(`ui/${next.id}/atlas.js`), pak: beside(`ui/${next.id}/atlas.pak`), plan, simHz: turns() });
      // (another device was chosen while this one's interface was read)
      if (device !== next) return opened.close();
      atlas.interface_opened();
      ui = opened;
      report.interfaceReady ||= performance.now() - started;
    } catch (error) {
      // Without its interface the page shows the globe alone, and says why nothing is over it.
      report.failure = message(error);
      say(report.failure);
    }
  };
  const presented = present(device);

  // One frame: the globe's turn, the guest's turn when one is due, its pictures when they have changed, the scene.
  const frame = (now) => {
    const held = controls.read();
    atlas.step(now, held.buttons, held.left[0], held.left[1], held.right[0], held.right[1]);
    const ticks = ui !== null ? atlas.guest_due(held.buttons, held.touching) : 0;
    if (ticks) {
      const from = performance.now();
      const line = atlas.heard();
      if (line) ui.send(line);
      ui.turn(held.buttons, held.contacts, ticks);
      for (const said of ui.drain()) atlas.say(said);
      const turnedAt = performance.now();
      let moved = false;
      if (ui.changed()) {
        // One drawing by the UI core, with its alpha, and the upload.
        const picture = ui.picture();
        const drew = performance.now();
        atlas.overlay(picture.pixels, picture.width, picture.height);
        moved = true;
        timing.redraws++;
        timing.drawMs += drew - turnedAt;
        timing.redrawMs += performance.now() - turnedAt;
      }
      const drawn = performance.now();
      if (lower && ui.lowerChanged()) {
        // The second screen is the interface's alone: its pixels go to its canvas as they are.
        lower.data.set(ui.lower());
        stage.lower.putImageData(lower, 0, 0);
        moved = true;
        timing.lowers++;
        timing.lowerMs += performance.now() - drawn;
      }
      // What the guest asked for is done before the frame is drawn.
      atlas.turned(moved);
      timing.turns++;
      timing.turnMs += turnedAt - from;
    }
    controls.next(ticks > 0);
    const saved = atlas.prefs_take();
    if (saved) {
      try {
        localStorage.setItem(KEPT, saved);
      } catch {
        // A browser that keeps nothing starts with nothing saved next time.
      }
    }
    atlas.draw();
    report.frames++;
    report.firstFrame ||= performance.now() - started;
    if (!report.firstGlobe && report.globe) {
      report.firstGlobe = performance.now() - started;
      // (the globe is on the screen: the player may read what it kept back)
      player.ready();
    }
  };

  await title;
  canvas.hidden = false;
  stage.fit();
  if (query.get("words")) atlas.control(query.get("words"));
  const loop = frames(() => shape.hz, (now) => {
    try {
      frame(now);
    } catch (error) {
      // A frame the canvas had no texture for is skipped; anything else stops the page and says why.
      report.failure = message(error);
      if (!/Outdated|Lost|Timeout/.test(report.failure)) {
        loop.stop();
        say(report.failure);
      }
    }
  });

  // For a console and for tools/wgpu.ts.
  report.presented = () => presented;
  // Another device while the page runs: `pocketAtlas.present("psp")`.
  report.present = (id) => present(DEVICES.find((d) => d.id === id));
  report.interface = () => ui;
  // The frame as the canvases hold it, a pixel to a pixel: PNGs as data URLs.
  report.capture = () => {
    frame(performance.now());
    return { upper: canvas.toDataURL("image/png"), lower: stage.second.hidden ? null : stage.second.toDataURL("image/png") };
  };
  // Milliseconds a frame costs the processor and the GPU together, over `count` frames made without
  // waiting for the display: the globe, the guest's turns and redraws, the scene.
  report.burst = async (count = 300) => {
    const gpu = canvas.getContext("webgpu").getConfiguration().device;
    const from = performance.now();
    for (let i = 0; i < count; i++) frame(from + ((i + 1) * 1000) / shape.hz);
    await gpu.queue.onSubmittedWorkDone();
    return (performance.now() - from) / count;
  };
}

start().catch((error) => {
  window.pocketAtlas = { failure: message(error) };
  say(window.pocketAtlas.failure);
});
