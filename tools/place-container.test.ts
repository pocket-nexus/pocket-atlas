import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VITA_PACK_VERSION, PICA_PACK_VERSION, readPack } from "./place-container";

function fixture(magic: "PLCE" | "ATLS", version: number) {
  const meta = Buffer.from(JSON.stringify(magic === "ATLS"
    ? { version: 1, places: [] }
    : { version: VITA_PACK_VERSION, camera: { shots: [{ name: "Crossing" }] } }));
  const bytes = Buffer.alloc(32 + meta.length);
  bytes.write(magic);
  bytes.writeUInt32LE(version, 4);
  bytes.writeUInt32LE(1, 8);
  bytes.write("META", 16);
  bytes.writeUInt32LE(32, 20);
  bytes.writeUInt32LE(meta.length, 24);
  bytes.writeUInt32LE(4, 28);
  meta.copy(bytes, 32);
  return bytes;
}

for (const [magic, version] of [["PLCE", VITA_PACK_VERSION], ["ATLS", VITA_PACK_VERSION], ["PLCE", PICA_PACK_VERSION]] as const) {
  describe(`${magic} v${version} container`, () => {
    const read = (bytes: Buffer) => readPack(bytes, magic, version);
    test("reads the target envelope independently of the payload schema", () => {
      const meta = JSON.parse(read(fixture(magic, version)).section("META").toString());
      expect(meta.version).toBe(magic === "ATLS" ? 1 : VITA_PACK_VERSION);
      if (magic === "PLCE") expect(meta.camera.shots[0].name).toBe("Crossing");
    });
    test("rejects old, other-target and future versions before interpreting sections", () => {
      for (const other of [4, 5, 6, 7, 8].filter(v => v !== version)) {
        const bytes = fixture(magic, other);
        expect(() => read(bytes)).toThrow(`Unsupported ${magic} version ${other}`);
      }
    });
    test("rejects truncated headers, tables and payloads safely", () => {
      const bytes = fixture(magic, version);
      for (let length = 0; length < 16; length++)
        expect(() => read(bytes.subarray(0, length))).toThrow(`Truncated ${magic} header`);
      expect(() => read(bytes.subarray(0, 31))).toThrow("section table");
      expect(() => read(bytes.subarray(0, -1))).toThrow("Truncated META");
      bytes.writeUInt32LE(0xffffffff, 8);
      expect(() => read(bytes)).toThrow("section table");
    });
    test("rejects wrong containers and ranges into the section table", () => {
      const bytes = fixture(magic, version);
      expect(() => readPack(bytes, magic === "PLCE" ? "ATLS" : "PLCE", version)).toThrow("Expected");
      expect(() => read(bytes).section("GEOM")).toThrow("Missing GEOM");
      bytes.writeUInt32LE(16, 20);
      expect(() => read(bytes)).toThrow("overlaps header");
    });
  });
}

test("host tool versions follow each target's writer and C reader", () => {
  const rust = readFileSync(new URL("../crates/pocket3d-place/src/lib.rs", import.meta.url), "utf8");
  const pica = readFileSync(new URL("../crates/pocket3d-place-cook/src/pica.rs", import.meta.url), "utf8");
  const c = readFileSync(new URL("../n3ds/src/format.h", import.meta.url), "utf8");
  expect(VITA_PACK_VERSION).toBe(Number(rust.match(/pub const VERSION: u32 = (\d+);/)![1]));
  expect(PICA_PACK_VERSION).toBe(Number(pica.match(/const CONTAINER_VERSION: u32 = (\d+);/)![1]));
  expect(PICA_PACK_VERSION).toBe(Number(c.match(/#define ATLAS_PICA_CONTAINER_VERSION (\d+)/)![1]));
});
