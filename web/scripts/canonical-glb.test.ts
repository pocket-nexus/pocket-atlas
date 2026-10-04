import { expect, test } from "bun:test";
import { canonicalGlb } from "./canonical-glb";
function glb(reverse: boolean) {
  const images = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])];
  const doc = {asset:{version:"2.0"}, buffers:[{byteLength:8}], bufferViews:[{buffer:0,byteOffset:0,byteLength:4},{buffer:0,byteOffset:4,byteLength:4}], images:[{bufferView:reverse?1:0},{bufferView:reverse?0:1}]};
  let json=JSON.stringify(doc);json += " ".repeat((4-json.length%4)%4);
  const header=Buffer.alloc(20);header.write("glTF");header.writeUInt32LE(2,4);header.writeUInt32LE(36+json.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  const bin=Buffer.alloc(8);bin.writeUInt32LE(8);bin.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,Buffer.from(json),bin,...(reverse?images.reverse():images)]);
}
test("asynchronous image completion order normalizes to identical bytes and is idempotent",()=>{
  const a=canonicalGlb(glb(false)),b=canonicalGlb(glb(true));
  expect(a.equals(b)).toBe(true);expect(canonicalGlb(a).equals(a)).toBe(true);
});
test("truncated or out-of-bounds export never becomes a valid sealed GLB",()=>{
  expect(()=>canonicalGlb(glb(false).subarray(0,25))).toThrow();
  const input=glb(false);input.writeUInt32LE(input.length+4,8);expect(()=>canonicalGlb(input)).toThrow();
});
