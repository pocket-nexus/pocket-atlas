import { loadFiles } from "./route-probe";
import { RouteSource } from "../src/routes/shared/source";
import { RouteWorld } from "../src/routes/shared/world";
const world = new RouteWorld(await RouteSource.decode(loadFiles()));
const src = world.source;
const kinds = new Map<string, number>();
for (const f of src.features) { const k = f.kind + ":" + (f.kind === "point" || f.kind === "land" || f.kind==="power"||f.kind==="tower" ? f.type : ""); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
console.log([...kinds].sort().map(([k, v]) => `${k} ${v}`).join("\n"));
console.log("limits", JSON.stringify(src.route.limits));
console.log("names", JSON.stringify(src.route.names));
console.log("length", world.main.line.length);
for (const f of src.features) if (f.kind === "point" && f.type.startsWith("place")) { const p = world.main.line.project(f.pts[0], f.pts[1], 5000); console.log(f.type, f.name, JSON.stringify(f.tags), p ? `s ${(p.s/1000).toFixed(2)} d ${p.d.toFixed(0)}` : "far"); }
let n = 0;
for (const f of src.features) if (f.kind === "point" && !f.type.startsWith("place") && n++ < 400) { const p = world.main.line.project(f.pts[0], f.pts[1], 40); if (p && (f.type==="traffic_signals"||f.type==="bus_stop")) console.log(f.type, f.name, JSON.stringify(f.tags), `s ${(p.s/1000).toFixed(2)} d ${p.d.toFixed(1)}`); }
console.log("junctions", world.junctions.length, world.junctions.slice(0, 12).map(j => `${(j.s/1000).toFixed(2)} ${j.side} ${j.road.type}`).join("; "));
const bl = []; let on=false; const l=world.main.line; for (let i=0;i<l.n;i++){ const b=world.main.bridge[i]; if(b&&!on){bl.push((l.s[i]/1000).toFixed(2));on=true;} if(!b&&on){bl[bl.length-1]+="-"+(l.s[i]/1000).toFixed(2);on=false;} } console.log("bridges", bl.join(" "));
const ex = src.features.find(f => f.kind==="power"); console.log("power ex", ex?.type, JSON.stringify(ex?.tags), ex?.pts.length);
