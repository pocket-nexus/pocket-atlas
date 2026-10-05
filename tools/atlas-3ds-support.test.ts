import { expect, test } from "bun:test";
import { PLACES } from "../web/src/places/registry";
import { native3dsPlaces, unsupported3dsPlaces } from "./atlas-3ds-support";

test("catalog includes every supported live place and rejects unsupported requested content", () => {
  const ids = native3dsPlaces(PLACES).map((p) => p.id);
  expect(ids).toContain("sf-lombard-street");
  expect(ids).toContain("tokyo-konbini");
  expect(ids).toContain("sangubashi-crossing");
  expect(ids).toContain("griffith-observatory");
  const vista = PLACES.find((p) => p.id === "griffith-observatory")!;
  const elsewhere = [...PLACES, { ...vista, id: "another-dusk-vista", targets: ["vita"] as const }];
  expect(native3dsPlaces(elsewhere).map((p) => p.id)).not.toContain("another-dusk-vista");
  expect(() => native3dsPlaces(elsewhere, "another-dusk-vista")).toThrow("dusk-vista");
  expect(() => native3dsPlaces(PLACES, "missing-place")).toThrow("Unknown live place");
  expect(unsupported3dsPlaces(elsewhere).map((p) => p.id)).toEqual(["another-dusk-vista"]);
});

test("a place joins the catalog by its targets, not by its id", () => {
  const place = PLACES.find((p) => p.id === "sf-lombard-street")!;
  expect(native3dsPlaces([{ ...place, id: "another-daytime-slope" }])[0].id)
    .toBe("another-daytime-slope");
  expect(native3dsPlaces([{ ...place, targets: ["vita"] }])).toEqual([]);
  expect(native3dsPlaces([{ ...place, status: "soon", load: undefined }])).toEqual([]);
});
