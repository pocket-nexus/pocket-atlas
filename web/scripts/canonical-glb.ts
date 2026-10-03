import { createHash } from "node:crypto";

/** GLTFExporter finishes PNG jobs asynchronously. Normalize their buffer-view order without changing pixels. */
export function canonicalGlb(bytes: Uint8Array): Buffer {
  const input = Buffer.from(bytes);
  if (input.length < 28 || input.toString("ascii", 0, 4) !== "glTF" || input.readUInt32LE(4) !== 2 || input.readUInt32LE(8) !== input.length)
    throw new Error("Invalid GLB envelope");
  const jsonSize = input.readUInt32LE(12);
  const binAt = 20 + jsonSize;
  if (input.readUInt32LE(16) !== 0x4e4f534a || binAt + 8 > input.length || input.readUInt32LE(binAt + 4) !== 0x004e4942)
    throw new Error("Expected JSON and BIN chunks");
  const doc = JSON.parse(input.toString("utf8", 20, binAt));
  const bin = input.subarray(binAt + 8);
  if (input.readUInt32LE(binAt) !== bin.length || doc.buffers?.length !== 1 || doc.buffers[0].uri || !Array.isArray(doc.bufferViews))
    throw new Error("Canonical export requires one embedded buffer");
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  const views = doc.bufferViews.map((view: any) => {
    const { buffer = 0, byteOffset = 0, ...layout } = view;
    if (buffer !== 0 || !Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(layout.byteLength) || layout.byteLength < 0 || byteOffset + layout.byteLength > bin.length)
      throw new Error("Invalid export buffer view");
    const data = bin.subarray(byteOffset, byteOffset + layout.byteLength);
    const key = JSON.stringify(stable(layout)) + ":" + createHash("sha256").update(data).digest("hex");
    return { key, layout, data };
  });
  const unique = [...new Map<string, typeof views[number]>(views.map((v: typeof views[number]) => [v.key, v])).values()]
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const indices = new Map(unique.map((v, i) => [v.key, i]));
  const remap = (value: any): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "bufferView") {
        if (!Number.isSafeInteger(child) || !views[child as number]) throw new Error("Invalid bufferView reference");
        value[key] = indices.get(views[child as number].key);
      } else remap(child);
    }
  };
  delete doc.bufferViews;
  remap(doc);
  let offset = 0;
  const chunks: Buffer[] = [];
  doc.bufferViews = unique.map(v => {
    const view = { buffer: 0, byteOffset: offset, ...v.layout };
    const padding = (4 - v.data.length % 4) % 4;
    chunks.push(v.data, Buffer.alloc(padding));
    offset += v.data.length + padding;
    return view;
  });
  doc.buffers[0].byteLength = offset;
  const json = Buffer.from(JSON.stringify(stable(doc)));
  const jsonPadding = Buffer.alloc((4 - json.length % 4) % 4, 32);
  const header = Buffer.alloc(20);
  header.write("glTF"); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + jsonPadding.length + offset, 8);
  header.writeUInt32LE(json.length + jsonPadding.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(offset); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, jsonPadding, binHeader, ...chunks]);
}
