import { expect, test } from "bun:test";
import { PLACES } from "../web/src/places/registry";
import { native3dsPlaces, unsupported3dsPlaces } from "./atlas-3ds-support";

test("catalog includes every supported live place and rejects unsupported requested content", () => {
  const ids = native3dsPlaces(PLACES).map((p) => p.id);
  expect(ids).toContain("sf-lombard-street");
  expect(ids).toContain("tokyo-konbini");
  expect(ids).not.toContain("griffith-observatory");
  expect(() => native3dsPlaces(PLACES, "griffith-observatory")).toThrow("dusk-vista");
  expect(() => native3dsPlaces(PLACES, "missing-place")).toThrow("Unknown live place");
  expect(unsupported3dsPlaces(PLACES).map((p) => p.id)).toContain("griffith-observatory");
});

test("a place joins the catalog by its targets, not by its id", () => {
  const place = PLACES.find((p) => p.id === "sf-lombard-street")!;
  expect(native3dsPlaces([{ ...place, id: "another-daytime-slope" }])[0].id)
    .toBe("another-daytime-slope");
  expect(native3dsPlaces([{ ...place, targets: ["vita"] }])).toEqual([]);
  expect(native3dsPlaces([{ ...place, status: "soon", load: undefined }])).toEqual([]);
});
