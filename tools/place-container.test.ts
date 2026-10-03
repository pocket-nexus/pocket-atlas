import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PACK_VERSION, readPack } from "./place-container";

function fixture(magic: "PLCE" | "ATLS") {
  const meta = Buffer.from(JSON.stringify(magic === "ATLS"
    ? { version: 1, places: [] }
    : { version: PACK_VERSION, camera: { shots: [{ name: "Crossing" }] } }));
  const bytes = Buffer.alloc(32 + meta.length);
  bytes.write(magic);
  bytes.writeUInt32LE(PACK_VERSION, 4);
  bytes.writeUInt32LE(1, 8);
  bytes.write("META", 16);
  bytes.writeUInt32LE(32, 20);
  bytes.writeUInt32LE(meta.length, 24);
  bytes.writeUInt32LE(4, 28);
  meta.copy(bytes, 32);
  return bytes;
}

for (const magic of ["PLCE", "ATLS"] as const) {
  describe(`${magic} container`, () => {
    test("reads v7 without reinterpreting the payload version", () => {
      const meta = JSON.parse(readPack(fixture(magic), magic).section("META").toString());
      expect(meta.version).toBe(magic === "ATLS" ? 1 : 7);
      if (magic === "PLCE") expect(meta.camera.shots[0].name).toBe("Crossing");
    });
    test("rejects old and future versions before interpreting sections", () => {
      for (const version of [5, 6, 8]) {
        const bytes = fixture(magic);
        bytes.writeUInt32LE(version, 4);
        expect(() => readPack(bytes, magic)).toThrow(`Unsupported ${magic} version ${version}`);
      }
    });
    test("rejects truncated headers, tables and payloads safely", () => {
      const bytes = fixture(magic);
      for (let length = 0; length < 16; length++)
        expect(() => readPack(bytes.subarray(0, length), magic)).toThrow(`Truncated ${magic} header`);
      expect(() => readPack(bytes.subarray(0, 31), magic)).toThrow("section table");
      expect(() => readPack(bytes.subarray(0, -1), magic)).toThrow("Truncated META");
      bytes.writeUInt32LE(0xffffffff, 8);
      expect(() => readPack(bytes, magic)).toThrow("section table");
    });
    test("rejects wrong containers and ranges into the section table", () => {
      const bytes = fixture(magic);
      expect(() => readPack(bytes, magic === "PLCE" ? "ATLS" : "PLCE")).toThrow("Expected");
      expect(() => readPack(bytes, magic).section("GEOM")).toThrow("Missing GEOM");
      bytes.writeUInt32LE(16, 20);
      expect(() => readPack(bytes, magic)).toThrow("overlaps header");
    });
  });
}

test("host tool container gate follows the Rust writer", () => {
  const rust = readFileSync(new URL("../crates/pocket3d-place/src/lib.rs", import.meta.url), "utf8");
  expect(PACK_VERSION).toBe(Number(rust.match(/pub const VERSION: u32 = (\d+);/)![1]));
});
