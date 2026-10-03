import { expect, test } from "bun:test";
import type { PlaceDef } from "../web/src/core/types";
import { PLACES } from "../web/src/places/registry";
import { isIPodAsset, selectIPodPlaces } from "./atlas-ipod-catalog";

type Entry = Pick<PlaceDef, "id" | "status" | "load" | "targets">;
const load = () => { throw new Error("Catalog selection must never load a scene"); };
const eligible: Entry = { id: "eligible", status: "live", load, targets: ["ipod"] };
const entries: readonly Entry[] = Object.freeze([
  { ...eligible, id: "undeclared", targets: undefined },
  { ...eligible, id: "other-target", targets: ["vita", "3ds"] },
  { ...eligible, id: "empty-targets", targets: [] },
  { ...eligible, id: "soon", status: "soon" },
  { ...eligible, id: "missing-loader", load: undefined },
  eligible,
  { ...eligible, id: "second", targets: ["vita", "ipod"] },
]);

test("iPod release catalog requires live, load and explicit target while retaining order", () => {
  const result = selectIPodPlaces(entries);
  expect(result.map((place) => place.id)).toEqual(["eligible", "second"]);
  expect(result[0]).toBe(eligible);
  expect(entries).toHaveLength(7);
  expect(selectIPodPlaces(entries, "")).toEqual(result);
});

test("selected place narrows the eligible catalog without bypassing publication gates", () => {
  expect(selectIPodPlaces(entries, "second").map((place) => place.id)).toEqual(["second"]);
  for (const id of ["undeclared", "other-target", "empty-targets", "soon", "missing-loader", "unknown", "elig"])
    expect(selectIPodPlaces(entries, id)).toEqual([]);
});

test("the current five iPod places and their registry order stay unchanged", () => {
  expect(selectIPodPlaces(PLACES).map((place) => place.id)).toEqual([
    "tokyo-konbini", "suga-shrine-stairs", "akihabara-radio-kaikan",
    "kamakura-koko-mae-crossing", "griffith-observatory",
  ]);
});

test("asset publication allows only shared assets and explicit selected scene suffixes", () => {
  const places = selectIPodPlaces(entries, "eligible");
  for (const file of [
    "effects.json", "globe.pipelines.json", "globe/earth.bin", "globe/maps/clouds.rgba",
    "shaders/sky-f.glsl", "eligible.place", "eligible.pipelines.json", "eligible.shadow.json",
    "eligible.audio.caf", "eligible.preview.png", "eligible.ipod-color.bin",
    "eligible.ipod-color.json", "eligible.ipod-clusters.bin",
  ]) expect(isIPodAsset(file, places)).toBe(true);
  for (const file of [
    "undeclared.place", "unknown.place", "second.place", "other-target.preview.png",
    "eligible-extra.place", "eligible.place.bak", "eligible.unknown", "eligible.place/nested",
    "effects.json.bak", "globe-extra/file", "other/eligible.place", "/shaders/sky.glsl",
    "shaders/../unknown.place", "shaders//sky.glsl", "globe/./earth.bin", "shaders\\sky.glsl",
  ]) expect(isIPodAsset(file, places)).toBe(false);
});
