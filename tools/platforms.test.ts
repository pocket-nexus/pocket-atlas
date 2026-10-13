// A device the game has a package for is a device its browser page plays as.
//
// Every place that lists the game's devices is read here and held to the
// others: the packages a release builds (tools/release.ts), the handhelds the
// page shows and the targets it says the game runs on (wgpu/page/main.js),
// the screens the renderer draws (wgpu/src/app.rs), the interface bundles the
// site is built with (tools/wgpu.ts), and what the page tells Pocket Studio
// (<meta name="pocket-devices"> in wgpu/page/index.html, which
// `pocket-studio site` and `pocket-studio package` read). A new target lands
// with its shape, its bundle and its place in the page in one change, and the
// site is deployed before the package is uploaded.
//
//   bun test ./tools/platforms.test.ts

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const names = (list: string) => [...list.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);

// The page's `id` of a handheld is a shell of PocketJS's player; a package's target is Pocket Studio's
// name for the device. They differ for one device.
const TARGET_OF: Record<string, string> = { ipod: "ipod-touch" };

function platforms() {
  const page = read("wgpu/page/main.js");
  const devices = page.match(/^const DEVICES = \[\n?([\s\S]*?)\];$/m)![1]!;
  return {
    shown: [...devices.matchAll(/\bid: "([a-z0-9-]+)"/g)].map((m) => m[1]!),
    runsOn: names(page.match(/^\s*runsOn: \[([^\]]*)\],$/m)![1]!),
    shapes: [...read("wgpu/src/app.rs").matchAll(/Shape \{ name: "([a-z0-9]+)"/g)].map((m) => m[1]!),
    built: names(read("tools/wgpu.ts").match(/const SHOWN = \[([^\]]*)\]/)![1]!),
    released: names(read("tools/release.ts").match(/^const TARGETS = \[([^\]]*)\] as const;$/m)![1]!),
    said: read("wgpu/page/index.html").match(/<meta name="pocket-devices" content="([^"]*)">/)?.[1]?.split(" ") ?? [],
  };
}

const sorted = (list: string[]) => [...list].sort();

test("the page's handhelds are the renderer's shapes and the interface bundles of the site", () => {
  const { shown, shapes, built } = platforms();
  expect(shown.length).toBeGreaterThan(0);
  expect(sorted(shapes)).toEqual(sorted(shown));
  expect(sorted(built)).toEqual(sorted(shown));
});

test("every package's device is one the page plays as, and every device of the page has a package", () => {
  const { shown, runsOn, released } = platforms();
  const targets = shown.map((id) => TARGET_OF[id] ?? id);
  expect(sorted(released)).toEqual(sorted(targets));
  expect(sorted(runsOn)).toEqual(sorted(targets));
});

test("the page tells Pocket Studio the devices it plays as", () => {
  const { shown, said } = platforms();
  expect(said).toEqual(shown.map((id) => TARGET_OF[id] ?? id));
});
