/** Read metadata from the iPod target ABI, never from a Vita device pack. */
import { readFileSync } from "node:fs";

export function parseIPodMetadata(bytes: Buffer): any {
  if (bytes.length < 16 || bytes.toString("ascii", 0, 4) !== "PLIP" ||
      bytes.readUInt32LE(4) !== 1 || bytes.readUInt32LE(12) !== 0)
    throw new Error("Expected an iPod PLIP v1 pack; rebuild from PlaceIR with --target ipod");
  const count = bytes.readUInt32LE(8);
  const tableEnd = 16 + count * 16;
  if (count < 4 || count > 16 || tableEnd > bytes.length)
    throw new Error("Invalid iPod section table");
  const sections = new Map<string, { start: number; end: number }>();
  for (let i = 0; i < count; ++i) {
    const at = 16 + i * 16;
    const tag = bytes.toString("ascii", at, at + 4);
    const start = bytes.readUInt32LE(at + 4);
    const size = bytes.readUInt32LE(at + 8);
    const align = bytes.readUInt32LE(at + 12);
    const end = start + size;
    if (!align || (align & (align - 1)) !== 0 || start % align || start < tableEnd ||
        end > bytes.length || sections.has(tag) || [...sections.values()].some(
          (previous) => size > 0 && previous.end > previous.start && start < previous.end && previous.start < end))
      throw new Error(`Invalid iPod section ${tag}`);
    sections.set(tag, { start, end });
  }
  for (const tag of ["META", "TEXD", "GEOM", "ANIM"])
    if (!sections.has(tag)) throw new Error(`Missing iPod section ${tag}`);
  const meta = sections.get("META")!;
  const result = JSON.parse(bytes.toString("utf8", meta.start, meta.end));
  if (result.version !== 1) throw new Error("Unsupported iPod metadata version");
  return result;
}

export function readIPodMetadata(path: string): any {
  return parseIPodMetadata(readFileSync(path));
}
