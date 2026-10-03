/** Shared PLCE/ATLS container gate for host tools. Payload schemas have
 * their own versions (AtlasMeta remains v1; PICA remains v3). */
export const VITA_PACK_VERSION = 7;
export const PICA_PACK_VERSION = 5;

export function readPack(bytes: Buffer, magic: "PLCE" | "ATLS", expectedVersion: number) {
  if (bytes.length < 16) throw new Error(`Truncated ${magic} header`);
  if (bytes.toString("ascii", 0, 4) !== magic)
    throw new Error(`Expected ${magic} pack`);
  const version = bytes.readUInt32LE(4);
  if (version !== expectedVersion)
    throw new Error(`Unsupported ${magic} version ${version}`);
  const count = bytes.readUInt32LE(8), tableEnd = 16 + count * 16;
  if (!count || tableEnd > bytes.length)
    throw new Error(`Truncated ${magic} section table`);
  const sections = new Map<string, Buffer>();
  const spans: { offset: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 16 + i * 16, tag = bytes.toString("ascii", at, at + 4);
    const offset = bytes.readUInt32LE(at + 4), size = bytes.readUInt32LE(at + 8);
    const align = bytes.readUInt32LE(at + 12);
    if (!align || (align & (align - 1)) !== 0 || offset % align !== 0)
      throw new Error(`Invalid ${tag} alignment`);
    if (offset < tableEnd || offset + size > bytes.length)
      throw new Error(`Truncated ${tag} or range overlaps header`);
    if (sections.has(tag)) throw new Error(`Duplicate ${tag} section`);
    sections.set(tag, bytes.subarray(offset, offset + size));
    spans.push({ offset, size });
  }
  spans.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i - 1].offset + spans[i - 1].size > spans[i].offset)
      throw new Error(`Overlapping ${magic} sections`);
  }
  return {
    section(tag: string): Buffer {
      const data = sections.get(tag);
      if (!data) throw new Error(`Missing ${tag} section`);
      return data;
    },
  };
}
