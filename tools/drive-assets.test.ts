import {test,expect} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {drivePages,copyDrivePages} from "./drive-assets";
function pack(meta:unknown){const m=Buffer.from(JSON.stringify(meta)),b=Buffer.alloc(32+m.length);b.write("PLCE");b.writeUInt32LE(7,4);b.writeUInt32LE(1,8);b.write("META",16);b.writeUInt32LE(32,20);b.writeUInt32LE(m.length,24);m.copy(b,32);return b;}
test("streamed delivery validates the complete unit and rejects missing/corrupt/escaping sidecars",()=>{
  const dir=mkdtempSync(join(tmpdir(),"atlas-drive-")),src=join(dir,"route.place"),to=join(dir,"copy.place");
  const bytes=Buffer.from("hello");
  try{
    writeFileSync(src,pack({driving:{pages:[{file:"00000.bin",bytes:5,checksum:0x4f9f2cab}]}}));
    expect(()=>drivePages(src)).toThrow("Missing streamed geometry");
    mkdirSync(`${src}.pages`);writeFileSync(`${src}.pages/00000.bin`,bytes);
    expect(copyDrivePages(src,to)).toBe(1);expect(readFileSync(`${to}.pages/00000.bin`)).toEqual(bytes);
    writeFileSync(`${src}.pages/00000.bin`,"Hello");expect(()=>drivePages(src)).toThrow("Corrupt geometry page");
    writeFileSync(src,pack({driving:{pages:[{file:"../00000.bin",bytes:5,checksum:0}]}}));expect(()=>drivePages(src)).toThrow("Invalid geometry page descriptor");
    writeFileSync(src,pack({driving:null}));expect(drivePages(src)).toEqual([]);
    const old=pack({});old.writeUInt32LE(6,4);writeFileSync(src,old);expect(()=>drivePages(src)).toThrow("Re-cook");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
