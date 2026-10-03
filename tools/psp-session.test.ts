import { describe, expect, test } from "bun:test";
import { encodeControl, shotCount, packHash, readStatus } from "./psp-session";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PSP mailbox boundary", () => {
  test("rejects non-finite clocks, fractional indices and coercible flags", () => {
    for (const command of [
      { time: NaN },
      { time: Infinity },
      { shot: 1.5 },
      { time: -2 },
      { rain: "false" },
      { pause: 1 },
      { muted: "true" },
      { unknown: true },
      null,
    ]) {
      expect(() => encodeControl(command as any, 1)).toThrow();
    }
    expect(encodeControl({ shot: 2, time: 10, rain: false }, 7)).toBe(
      "2 10 0 0 1 7 0\n",
    );
    expect(encodeControl({ muted: true }, 8)).toBe("-1 -1 0 1 1 8 1\n");
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
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(16, 48);
    expect(() => shotCount(bytes)).toThrow();
  });
  test("runtime identity rejects an old build, another pack and stale telemetry", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-psp-status-"));
    const path = join(dir, "status.json");
    const expected = { build: "native-build", packVersion: 2, packHash: 0xe1234567 };
    const status = { target: "psp", ...expected, frame: 1, shot: "Crossing", shotIndex: 0, time: 25, fps: 30, workMs: 20, maxWorkMs: 21, draws: 10, triangles: 100, controlNonce: 2, muted: false, audioReady: true };
    try {
      writeFileSync(path, JSON.stringify(status));
      expect(readStatus(path, expected).packHash).toBe(0xe1234567);
      expect(() => readStatus(path, { ...expected, build: "old" })).toThrow("Another PSP build");
      expect(() => readStatus(path, { ...expected, packHash: 1 })).toThrow("Another PSP build");
      writeFileSync(path, JSON.stringify({ ...status, packVersion: 1 }));
      expect(() => readStatus(path, expected)).toThrow("Incomplete");
      writeFileSync(path, JSON.stringify(status));
      utimesSync(path, new Date(0), new Date(0));
      expect(() => readStatus(path, expected)).toThrow("stale");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("pack fingerprint matches unsigned FNV-1a32", () => {
    expect(packHash(Buffer.alloc(0))).toBe(2166136261);
    expect(packHash(Buffer.from("hello"))).toBe(0x4f9f2cab);
  });
});
