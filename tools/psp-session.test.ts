import { describe, expect, test } from "bun:test";
import { encodeControl, shotCount } from "./psp-session";

describe("PSP mailbox boundary", () => {
  test("rejects non-finite clocks, fractional indices and coercible flags", () => {
    for (const command of [
      { time: NaN },
      { time: Infinity },
      { shot: 1.5 },
      { time: -2 },
      { rain: "false" },
      { pause: 1 },
      { unknown: true },
      null,
    ]) {
      expect(() => encodeControl(command as any, 1)).toThrow();
    }
    expect(encodeControl({ shot: 2, time: 10, rain: false }, 7)).toBe(
      "2 10 0 0 1 7\n",
    );
  });
  test("camera table requires matching magic, version, length and bounded span", () => {
    const bytes = Buffer.alloc(160 + 76);
    bytes.write("PLPS");
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(160, 48);
    bytes.writeUInt32LE(1, 52);
    expect(shotCount(bytes)).toBe(1);
    bytes.writeUInt32LE(2, 52);
    expect(() => shotCount(bytes)).toThrow();
    bytes.writeUInt32LE(1, 52);
    bytes.writeUInt32LE(1, 4);
    expect(() => shotCount(bytes)).toThrow();
  });
});
