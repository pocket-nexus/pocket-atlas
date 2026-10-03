/** Root .place + compiler-owned geometry sidecars form one delivery unit. */
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
export function drivePages(pack:string): {source:string;name:string}[] {
  const b=readFileSync(pack);
  if(b.toString("ascii",0,4)!=="PLCE")throw new Error(`Invalid place: ${pack}`);
  if(b.readUInt32LE(4)!==7)throw new Error(`Re-cook ${pack}: this renderer requires pack version 7`);
  const count=b.readUInt32LE(8);
  let meta:any=null;
  for(let i=0;i<count;i++){
    const at=16+i*16;
    if(at+16>b.length)throw new Error("Truncated place header");
    if(b.toString("ascii",at,at+4)==="META"){
      const offset=b.readUInt32LE(at+4),len=b.readUInt32LE(at+8);
      if(offset+len>b.length)throw new Error("Truncated place metadata");
      meta=JSON.parse(b.toString("utf8",offset,offset+len));
    }
  }
  if(!meta)throw new Error("Missing place metadata");
  return (meta.driving?.pages??[]).map((p:{file:string;bytes:number;checksum:number})=>{
    if(!/^\d+\.bin$/.test(p.file)||p.bytes<=0||p.bytes>8*1024*1024)throw new Error("Invalid geometry page descriptor");
    const source=join(`${pack}.pages`,p.file);
    if(!existsSync(source))throw new Error(`Missing streamed geometry: ${source}`);
    const data=readFileSync(source);let hash=2166136261;
    for(const byte of data)hash=Math.imul(hash^byte,16777619)>>>0;
    if(data.length!==p.bytes||hash!==p.checksum)throw new Error(`Corrupt geometry page: ${source}`);
    return {source,name:p.file};
  });
}
export function copyDrivePages(pack:string,target:string):number {
  const pages=drivePages(pack);
  for(const p of pages){const to=join(`${target}.pages`,p.name);mkdirSync(dirname(to),{recursive:true});copyFileSync(p.source,to);}
  return pages.length;
}
