// Atlas's PSPLINK mailbox contract; no device ownership or SDK provisioning.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export interface Status {
  target: "psp";
  frame: number;
  shot: string;
  shotIndex: number;
  time: number;
  fps: number;
  workMs: number;
  maxWorkMs: number;
  draws: number;
  triangles: number;
  controlNonce: number;
  packSha256: string;
  runtimeBuild: string;
}

export function readStatus(path: string): Status {
  if (Date.now() - statSync(path).mtimeMs > 10000) {
    throw new Error("PSP status is stale; check the app and PSPLINK host");
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value.target !== "psp" ||
    !/^[a-f0-9]{64}$/.test(value.packSha256) || !/^[a-f0-9]{32}$/.test(value.runtimeBuild) ||
    typeof value.shot !== "string" ||
    [
      "frame",
      "shotIndex",
      "time",
      "fps",
      "workMs",
      "maxWorkMs",
      "draws",
      "triangles",
      "controlNonce",
    ].some((key) => !Number.isFinite(value[key]))
  ) {
    throw new Error("Incomplete PSP status");
  }
  return value;
}

export interface Control {
  shot?: number;
  time?: number;
  pause?: boolean;
  rain?: boolean;
  reflection?: boolean;
}

export function encodeControl(c: Control, nonce: number): string {
  if (c === null || typeof c !== "object" || Array.isArray(c))
    throw new Error("Expected control object");
  const shot = c.shot ?? -1;
  const time = c.time ?? -1;
  if (!Number.isSafeInteger(shot) || shot < -1 || shot > 2147483647)
    throw new Error("Invalid shot index");
  if (!Number.isFinite(time) || (time < 0 && time !== -1) || time > 86400)
    throw new Error("Time must be -1 (live) or 0..86400 seconds");
  for (const [key, value] of Object.entries(c)) {
    if (!["shot", "time", "pause", "rain", "reflection"].includes(key))
      throw new Error(`Unknown control: ${key}`);
    if (
      ["pause", "rain", "reflection"].includes(key) &&
      typeof value !== "boolean"
    )
      throw new Error(`${key} must be boolean`);
  }
  return `${shot} ${time} ${Number(c.pause ?? false)} ${Number(c.rain ?? true)} ${Number(c.reflection ?? true)} ${nonce}\n`;
}

let nonce = Date.now() >>> 0;
export function writeControl(path: string, control: Control): number {
  nonce = (nonce + 1) >>> 0;
  const data = encodeControl(control, nonce);
  // Host filesystem rename prevents the PSP from reading a half-written command.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
  return nonce;
}

export function shotCount(bytes: Buffer): number {
  // PLPS v3 Header.shots is a Span at byte 48; Shot has 76 bytes.
  if (
    bytes.length < 48 + 8 ||
    bytes.toString("ascii", 0, 4) !== "PLPS" ||
    bytes.readUInt32LE(4) !== 3 ||
    bytes.readUInt32LE(8) !== bytes.length
  ) {
    throw new Error("Invalid PLPS v3 pack");
  }
  const offset = bytes.readUInt32LE(48);
  const count = bytes.readUInt32LE(52);
  if (count === 0 || offset % 16 !== 0 || offset + count * 76 > bytes.length) {
    throw new Error("Invalid PSP camera table");
  }
  return count;
}
