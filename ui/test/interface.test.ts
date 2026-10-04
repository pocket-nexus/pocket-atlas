// The interface on each kind of device, compiled as the device's tool
// compiles it and run on PocketJS's wasm core: what a visitor presses and
// touches, and what the interface then asks of the renderer (scenario.ts).
// Needs `bun install` and `bun tools/wasm.ts` in vendor/pocketjs.
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { Device } from "./harness.ts";

const root = resolve(import.meta.dir, "../..");

/** Compiles the interface for `device` and runs its scenario. */
function visit(device: Device): Record<string, string[]> {
  for (const script of [join(root, "tools/atlas-ui.ts"), join(import.meta.dir, "scenario.ts")]) {
    const run = Bun.spawnSync(["bun", script, device], { cwd: root });
    if (run.exitCode !== 0) throw new Error(`${device}: ${run.stderr}`);
    if (script.endsWith("scenario.ts")) return JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
  }
  throw new Error("unreachable");
}

for (const device of ["psp", "vita"] as const)
  test(`a pad on one screen (${device})`, () => {
    const asked = visit(device);
    // The globe is told where it sits and faces the first place.
    expect(asked.boot).toEqual(["globe:0", "pins"]);
    expect(asked.down).toEqual(["globe:1"]);
    expect(asked.save).toEqual(['prefs:{"saved":["suga-shrine-stairs"]}']);
    if (device === "psp") {
      // △ opens the keyboard on the Search list, empty until something is
      // typed; "to" finds Tokyo's places, the nearest first.
      expect(asked.search[0]).toBe("globe:-1");
      expect(asked.search.at(-1)).toBe("globe:1");
    } else {
      // The Vita's panel takes taps beside the pad.
      expect(asked["third row"]).toEqual(["globe:2"]);
      expect(asked.up).toEqual(["globe:1"]);
    }
    expect(asked.visit).toEqual(["enter:suga-shrine-stairs"]);
    expect(asked["next shot"]).toEqual(["shot:1"]);
    // An open menu holds the pad; its first row after Tour is the first option.
    expect(asked.menu).toEqual(["hold:true"]);
    expect(asked["first option"]).toEqual(["option:rain=0"]);
    expect(asked["menu closed"]).toEqual(["hold:false"]);
    expect(asked["left alone"]).toEqual(["quiet:true"]);
    expect(asked.pause).toEqual(["pause:true", "quiet:false"]);
    expect(asked.leave).toContain("leave");
  }, 60000);

test("two screens and a stylus (3ds)", () => {
  const asked = visit("3ds");
  expect(asked.boot).toEqual(["globe:0", "pins"]);
  // A tap moves the focus; a tap on the focused row visits.
  expect(asked["second row"]).toEqual(["globe:1"]);
  expect(asked.visit).toEqual(["enter:suga-shrine-stairs"]);
  expect(asked["fourth shot"]).toEqual(["shot:3"]);
  expect(asked["look pad"]).toEqual(["look:-1,-1"]);
  expect(asked.menu).toEqual(["hold:true"]);
  expect(asked["menu closed"]).toEqual(["hold:false"]);
  expect(asked["previous shot"]).toEqual(["shot:2"]);
  expect(asked.leave).toContain("leave");
  expect(asked.search.at(-1)).toBe("globe:1");
}, 60000);

test("a touch panel alone (ipod)", () => {
  const asked = visit("ipod");
  expect(asked.boot).toEqual(["globe:0", "pins"]);
  expect(asked.spin).toEqual(["spin:-1,-1"]);
  expect(asked["second row"]).toEqual(["globe:1"]);
  expect(asked.visit).toEqual(["enter:suga-shrine-stairs"]);
  // The left stick pushed up walks forward, the right pushed right looks right.
  expect(asked.sticks).toEqual(["drive:0,1,1,0"]);
  expect(asked["sticks let go"]).toEqual(["drive:0,0,0,0"]);
  expect(asked["next shot"]).toEqual(["shot:1"]);
  expect(asked.tour).toEqual(["tour:true"]);
  expect(asked["left alone"]).toEqual(["quiet:true"]);
  expect(asked.leave).toContain("leave");
}, 60000);
