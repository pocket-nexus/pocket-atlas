// One device's interface driven through a visit, for interface.test.ts:
//   bun ui/test/scenario.ts <psp|vita|3ds|ipod|android>
// prints, step by step, what the interface asked of the renderer. The bundle
// owns the process's globals, so each device runs in a process of its own.
import { BTN } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import type { Command } from "../app/protocol.ts";
import { boot, type Device } from "./harness.ts";

const device = process.argv[2] as Device;
const rig = await boot(device, ["tokyo-konbini", "suga-shrine-stairs", "akihabara-radio-kaikan"]);
const steps: Record<string, string[]> = {};
let seen = 0;
/** A command as a word, with what a test wants to know of it. */
const word = (command: Command): string => {
  switch (command.type) {
    case "globe": return `globe:${command.pin}`;
    case "enter": return `enter:${command.place}`;
    case "shot": return `shot:${command.index}`;
    case "tour": case "pause": case "hold": case "quiet": return `${command.type}:${command.on}`;
    case "option": return `option:${command.key}=${command.value}`;
    case "prefs": return `prefs:${command.value}`;
    case "drive": return `drive:${Math.sign(command.mx)},${Math.sign(command.my)},${Math.sign(command.lx)},${Math.sign(command.ly)}`;
    case "look": case "spin": return `${command.type}:${Math.sign(command.dx)},${Math.sign(command.dy)}`;
    default: return command.type;
  }
};
/** Names what the interface asked since the last step, without repeats. */
const step = (name: string, settle = 12) => {
  rig.step(settle);
  steps[name] = [...new Set(rig.mock.log.slice(seen).map(word))];
  seen = rig.mock.log.length;
};
const drag = (from: [number, number], to: [number, number]) => {
  for (let i = 0; i <= 6; i++) rig.step(1, { touch: [{ x: from[0] + ((to[0] - from[0]) * i) / 6, y: from[1] + ((to[1] - from[1]) * i) / 6 }] });
  rig.step(2);
};

step("boot");
if (device === "psp" || device === "vita") {
  rig.press(BTN.DOWN);
  step("down");
  rig.press(BTN.SQUARE);
  step("save");
  if (device === "psp") {
    // The d-pad's keyboard: the fifth key along the top row, twice (t, o).
    rig.press(BTN.TRIANGLE);
    rig.step(12);
    for (let key = 0; key < 2; key++) {
      for (let i = 0; i < 4; i++) rig.press(BTN.RIGHT);
      rig.press(BTN.CIRCLE);
    }
    rig.press(BTN.START);
    step("search");
  } else {
    // The Vita's panel: a tap on the third row, then back up with the pad.
    rig.tap(360, 200);
    step("third row");
    rig.press(BTN.UP);
    step("up");
  }
  rig.press(BTN.CIRCLE);
  step("visit");
  rig.mock.loaded();
  step("loaded");
  rig.press(BTN.RTRIGGER);
  step("next shot");
  rig.press(BTN.TRIANGLE);
  step("menu");
  rig.press(BTN.DOWN);
  rig.press(BTN.CIRCLE);
  step("first option");
  rig.press(BTN.CROSS);
  step("menu closed");
  // Fifteen seconds with nothing pressed: every chip and legend has gone.
  step("left alone", 450);
  rig.press(BTN.START);
  step("pause");
  rig.press(BTN.CROSS);
  step("leave");
} else if (device === "3ds") {
  // The stylus on the lower screen: the second row, then the same row again.
  rig.tap(160, 103);
  step("second row");
  rig.tap(160, 103);
  step("visit");
  rig.mock.loaded();
  step("loaded");
  rig.tap(60, 141);
  step("fourth shot");
  drag([270, 120], [220, 110]);
  step("look pad");
  rig.tap(233, 18);
  step("menu");
  rig.press(BTN.CROSS);
  step("menu closed");
  rig.press(BTN.LTRIGGER);
  step("previous shot");
  rig.tap(289, 18);
  step("leave");
  rig.press(BTN.TRIANGLE);
  rig.step(12);
  rig.tap(144, 120);
  rig.tap(271, 120);
  rig.press(BTN.START);
  step("search");
} else {
  // A finger: the globe, the second row, Visit; then both sticks. The panel
  // is the iPod touch's 480 × 320 or a phone's 640 × 360, and the layout
  // follows it: the list at the right edge, the sticks in the lower corners.
  const wide = device === "android";
  const [w, h] = wide ? [640, 360] : [480, 320];
  drag([120, 160], [90, 150]);
  step("spin");
  rig.tap(w - 120, wide ? 260 : 240);
  step("second row");
  rig.tap(w - 80, wide ? 170 : 150);
  step("visit");
  rig.mock.loaded();
  step("loaded");
  for (let i = 0; i < 8; i++) rig.step(1, { touch: [{ id: 1, x: 82, y: h - 82 - i * 4 }, { id: 2, x: w - 82 + i * 4, y: h - 82 }] });
  step("sticks", 0);
  rig.step(2);
  step("sticks let go");
  // The bar: next shot, then back to the tour, and fifteen seconds alone.
  rig.tap(w / 2, 120);
  rig.step(6);
  rig.tap(w - 154, 24);
  step("next shot");
  rig.tap(w - 96, 24);
  step("tour");
  step("left alone", 450);
  if (wide) {
    // A phone's keys: menu opens the sheet, back closes it, back again leaves.
    rig.press(BTN.TRIANGLE);
    step("menu key");
    rig.press(BTN.CROSS);
    step("back", 30);
    rig.press(BTN.CROSS);
    step("leave");
  } else {
    rig.tap(w / 2, 120);
    rig.step(6);
    rig.tap(40, 24);
    step("leave");
  }
}
console.log(JSON.stringify(steps));
