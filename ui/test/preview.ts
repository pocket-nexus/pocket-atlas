// Writes pictures of the interface on one device to .pocket-build/ui/preview/.
//   bun ui/test/preview.ts <psp|vita|3ds|ipod|android>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BTN } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import { boot, type Device } from "./harness.ts";

const device = (process.argv[2] ?? "psp") as Device;
const out = resolve(import.meta.dir, "../../.pocket-build/ui/preview");
mkdirSync(out, { recursive: true });
const rig = await boot(device, ["tokyo-konbini", "suga-shrine-stairs", "akihabara-radio-kaikan", "kamakura-koko-mae-crossing", "griffith-observatory"]);
const place = resolve(import.meta.dir, device === "android" ? "../../.pocket-build/validation/android/shots/tokyo-konbini-0.png" : "../../.pocket-build/validation/ipod/sweep-7/tokyo-konbini-0.png");
const names: string[] = [];
const save = async (name: string, backdrop?: string) => {
  const file = join(out, `${device}-${name}.png`);
  writeFileSync(file, (await rig.shot(backdrop)).toBuffer("image/png"));
  names.push(file);
};

rig.step(20);
await save("atlas");
if (device === "android") {
  // A phone's 640 × 360: the Search tab and two keys, the second row, a visit, the sticks, the menu key.
  rig.tap(606, 24);
  rig.step(10);
  rig.tap(520, 216);
  rig.step(20);
  for (const x of [294, 544]) {
    rig.tap(x, 232);
    rig.step(4);
  }
  await save("atlas-search");
  rig.tap(614, 340);
  rig.step(10);
  await save("atlas-found");
  rig.tap(424, 24);
  rig.step(10);
  rig.tap(520, 260);
  rig.step(20);
  await save("atlas-second");
  rig.tap(560, 170);
  rig.step(10);
  await save("loading");
  rig.mock.loaded();
  rig.step(30);
  await save("place", place);
  for (let i = 0; i < 12; i++) rig.step(1, { touch: [{ id: 1, x: 82, y: 278 - i * 3 }, { id: 2, x: 558 + i * 3, y: 278 }] });
  await save("place-sticks", place);
  rig.step(400);
  await save("place-quiet", place);
  rig.press(BTN.TRIANGLE);
  rig.step(30);
  await save("place-menu", place);
} else if (device === "ipod") {
  // The Search tab, its field, and three keys.
  rig.tap(446, 24);
  rig.step(10);
  rig.tap(360, 190);
  rig.step(20);
  for (const x of [220, 408]) {
    rig.tap(x, 196);
    rig.step(4);
  }
  await save("atlas-search");
  rig.tap(460, 300);
  rig.step(10);
  await save("atlas-found");
  rig.tap(276, 24);
  rig.step(10);
  rig.tap(360, 240);
  rig.step(20);
  await save("atlas-second");
  rig.tap(290, 150);
  rig.tap(362, 24);
  rig.step(20);
  await save("atlas-explore");
  rig.tap(290, 24);
  rig.step(5);
  rig.tap(360, 196);
  rig.tap(400, 150);
  rig.step(10);
  await save("loading");
  rig.mock.loaded();
  rig.step(30);
  await save("place", place);
  // Both thumbs down: walk forward, look right.
  for (let i = 0; i < 12; i++) rig.step(1, { touch: [{ id: 1, x: 80, y: 250 - i * 3 }, { id: 2, x: 400 + i * 3, y: 250 }] });
  await save("place-sticks", place);
  rig.step(400);
  await save("place-quiet", place);
  rig.tap(240, 20);
  rig.step(10);
  rig.tap(446, 28);
  rig.step(30);
  await save("place-menu", place);
} else {
  // △: the Search list and its keyboard; three keys, then START commits.
  rig.press(BTN.TRIANGLE);
  rig.step(20);
  if (device === "3ds") {
    rig.tap(144, 120);
    rig.tap(271, 120);
  } else {
    for (let key = 0; key < 2; key++) {
      for (let i = 0; i < 4; i++) rig.press(BTN.RIGHT);
      rig.press(BTN.CIRCLE);
    }
  }
  rig.step(10);
  await save("atlas-search");
  rig.press(BTN.START);
  rig.step(10);
  await save("atlas-found");
  rig.press(BTN.LTRIGGER);
  rig.press(BTN.LTRIGGER);
  rig.press(BTN.LTRIGGER);
  rig.step(10);
  rig.press(BTN.DOWN);
  rig.press(BTN.DOWN);
  rig.step(20);
  await save("atlas-third");
  rig.press(BTN.SQUARE);
  rig.press(BTN.RTRIGGER);
  rig.step(20);
  await save("atlas-explore");
  rig.press(BTN.LTRIGGER);
  rig.press(BTN.UP);
  rig.press(BTN.UP);
  rig.press(BTN.CIRCLE);
  rig.step(10);
  await save("loading");
  rig.mock.loaded();
  rig.step(30);
  await save("place", place);
  rig.press(BTN.RTRIGGER);
  rig.step(20);
  await save("place-shot", place);
  rig.step(400);
  await save("place-quiet", place);
  rig.press(BTN.TRIANGLE);
  rig.step(30);
  await save("place-menu", place);
}
const sheet = join(out, `sheet-${device}.png`);
Bun.spawnSync(["magick", "montage", ...names, "-tile", "2x", "-geometry", `${device === "psp" || device === "3ds" ? "+4+4" : "50%x50%+4+4"}`, "-background", "#333333", sheet]);
console.log(sheet);
console.log(JSON.stringify(rig.mock.log.slice(-8)));
