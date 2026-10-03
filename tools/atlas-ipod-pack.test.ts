import { expect, test } from "bun:test";
import { parseIPodMetadata } from "./atlas-ipod-pack";

function pack() {
  const json = Buffer.from(JSON.stringify({ version: 1, name: "test" }));
  const bytes = Buffer.alloc(80 + json.length);
  bytes.write("PLIP"); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(4, 8);
  ["META", "TEXD", "GEOM", "ANIM"].forEach((tag, i) => {
    const at = 16 + 16 * i;
    bytes.write(tag, at); bytes.writeUInt32LE(80, at + 4);
    bytes.writeUInt32LE(i === 0 ? json.length : 0, at + 8);
    bytes.writeUInt32LE(1, at + 12);
  });
  json.copy(bytes, 80);
  return bytes;
}

test("iPod metadata tooling accepts its ABI and rejects Vita packs", () => {
  expect(parseIPodMetadata(pack()).name).toBe("test");
  const vita = pack(); vita.write("PLCE"); vita.writeUInt32LE(6, 4);
  expect(() => parseIPodMetadata(vita)).toThrow("PLIP");
});

test("metadata never reads outside or aliases sections", () => {
  for (const [at, value] of [[8, 0xffffffff], [20, 0], [24, 0xffffffff], [28, 3], [56, 4]]) {
    const bytes = pack(); bytes.writeUInt32LE(value, at);
    expect(() => parseIPodMetadata(bytes)).toThrow();
  }
  const bytes = pack(); bytes.write("META", 32);
  expect(() => parseIPodMetadata(bytes)).toThrow();
});
