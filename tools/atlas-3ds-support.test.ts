import { expect, test } from "bun:test";
import { PLACES } from "../web/src/places/registry";
import { browser3dsFlags, native3dsPlaces, unsupported3dsPlaces, validate3dsBrowserCatalog } from "./atlas-3ds-support";

test("catalog includes every supported live place and rejects unsupported requested content", () => {
  const ids = native3dsPlaces(PLACES).map((p) => p.id);
  expect(ids).toContain("sf-lombard-street");
  expect(ids).toContain("tokyo-konbini");
  expect(ids).not.toContain("griffith-observatory");
  expect(() => native3dsPlaces(PLACES, "griffith-observatory")).toThrow("dusk-vista");
  expect(() => native3dsPlaces(PLACES, "missing-place")).toThrow("Unknown live place");
  expect(unsupported3dsPlaces(PLACES).map((p) => p.id)).toContain("griffith-observatory");
});

test("browser keeps unavailable live places distinct from planned places", () => {
  const place = PLACES.find((p) => p.id === "sf-lombard-street")!;
  expect(browser3dsFlags(place) & 1).toBe(1);
  expect(browser3dsFlags({ ...place, targets: ["vita"] }) & 5).toBe(4);
  expect(browser3dsFlags({ ...place, status: "soon", load: undefined }) & 5).toBe(0);
  expect(browser3dsFlags({ ...place, featured: true }) & 2).toBe(2);
  expect(native3dsPlaces([{ ...place, id: "another-daytime-slope" }])[0].id)
    .toBe("another-daytime-slope");
});

test("build rejects stale browser availability instead of advertising an unlaunchable scene", () => {
  const entries = [PLACES.find((p) => p.id === "sf-lombard-street")!,
    PLACES.find((p) => p.id === "griffith-observatory")!];
  const bytes = Buffer.alloc(96 + 2 * 68 + 128);
  bytes.write("AT3B");
  bytes.writeUInt32LE(entries.length, 8);
  bytes.writeUInt32LE(96, 12);
  entries.forEach((p, i) => {
    const start = 96 + 2 * 68 + i * 64;
    bytes.writeUInt32LE(start, 96 + i * 68);
    bytes.write(p.id, start);
    bytes.writeUInt32LE(browser3dsFlags(p), 96 + i * 68 + 56);
  });
  expect(() => validate3dsBrowserCatalog(bytes, entries)).not.toThrow();
  bytes.writeUInt32LE(1, 96 + 68 + 56);
  expect(() => validate3dsBrowserCatalog(bytes, entries)).toThrow("availability is stale");
  bytes.writeUInt32LE(4, 96 + 68 + 56);
  bytes.writeUInt32LE(bytes.length, 96 + 68);
  expect(() => validate3dsBrowserCatalog(bytes, entries)).toThrow();
});
