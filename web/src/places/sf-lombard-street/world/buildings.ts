import { BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, Matrix4, ShapeUtils, Vector2, Vector3, type Material } from "three";
import { Rng } from "../../../core/random";
import { box, plane } from "../../shared/geo";
import { atlasPlane, merge, quad, rod } from "../../shared/shapes";
import type { LombardWorld } from "./context";
import { FOOTPRINTS } from "./data";
import { GEO, groundY, NORTH_SIDE, siteUV, UPHILL } from "./layout";

type Footprint = typeof FOOTPRINTS[number];
type Kit = ReturnType<typeof materials>;
const UP = new Vector3(0, 1, 0);

/** Photographic facade colours; only the footprint and tagged height are measured. */
function materials(w: LombardWorld) {
  return {
    walls: [0xe6dfcc, 0xc5b79a, 0xb6b7a3, 0xe3dfd5, 0xcbb9aa, 0xabc0cb].map(c => w.lib.stucco(c)),
    siding: w.lib.siding(0xb9c0b9), trim: w.lib.paint(0xe4e1d7, 0.6),
    iron: w.lib.paint(0x333b3f), blue: w.lib.paint(0x394852),
    dark: w.lib.plain(0x283136), glass: w.lib.glass(), curtain: w.lib.glass("curtain"),
    foundation: w.lib.concrete([0.9, 0.86, 0.79]), roof: w.lib.sheetRoof(0x656d6b),
    tile: w.lib.tileRoof(0x975b46), wood: w.lib.paint(0x625446, 0.7),
  };
}

function solid(w: LombardWorld, name: string, g: BufferGeometry, mat: Material, m?: Matrix4) {
  if (m) g.applyMatrix4(m);
  const mesh = w.mesh(g, mat);
  mesh.name = name;
  return mesh;
}

function slab(w: LombardWorld, name: string, mat: Material, m: Matrix4, x: number, y: number, z: number, width: number, height: number, depth: number) {
  solid(w, name, box(width, height, depth).translate(x, y, z), mat, m);
}

function pane(w: LombardWorld, name: string, mat: Material, m: Matrix4, x: number, y: number, z: number, width: number, height: number) {
  solid(w, name, plane(width, height).translate(x, y, z), mat, m);
}

function frameAt(w: LombardWorld, k: Kit, m: Matrix4, name: string, x: number, y: number, width: number, height: number, detail: boolean, curtain = false, z = 0.045) {
  if (!detail) {
    const rect = w.draw(`sf-distant-window-${curtain ? "curtain" : "blue"}`, 112, 160, (g, ww, hh) => {
      g.fillStyle = "#dad7c9"; g.fillRect(0, 0, ww, hh);
      const sky = g.createLinearGradient(0, 0, ww, hh);
      sky.addColorStop(0, curtain ? "#777d7d" : "#53646e"); sky.addColorStop(1, curtain ? "#b1b0a2" : "#26353c");
      g.fillStyle = sky; g.fillRect(ww * 0.065, hh * 0.05, ww * 0.87, hh * 0.88);
      if (curtain) { g.fillStyle = "#aaa89d"; g.fillRect(ww * 0.1, hh * 0.09, ww * 0.25, hh * 0.8); g.fillRect(ww * 0.68, hh * 0.09, ww * 0.22, hh * 0.8); }
      g.fillStyle = "#d5d3c9"; g.fillRect(ww * 0.47, 0, ww * 0.055, hh); g.fillRect(0, hh * 0.5, ww, hh * 0.037);
      g.fillStyle = "#aca99f"; g.fillRect(0, hh * 0.94, ww, hh * 0.06);
    });
    solid(w, `${name}:framed-window`, atlasPlane(width, height, rect).translate(x, y, z + 0.028), w.printed, m);
    return;
  }
  if (detail) pane(w, `${name}:reveal`, k.dark, m, x, y, z, width + 0.15, height + 0.14);
  pane(w, `${name}:glass`, curtain ? k.curtain : k.glass, m, x, y, z + 0.028, width - 0.14, height - 0.14);
  if (!detail) return;
  // A hollow, bevelled frame: front rim plus genuine depth into the reveal.
  // Hidden backs of eight little boxes would cost more than the window itself.
  const outer = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b]) => new Vector3(x + a! * width / 2, y + b! * height / 2, z + 0.12));
  const inner = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b]) => new Vector3(x + a! * (width / 2 - 0.075), y + b! * (height / 2 - 0.075), z + 0.12));
  const gs: BufferGeometry[] = [];
  for (let i=0; i<4; i++) {
    const j=(i+1)%4, ia=inner[i]!, ib=inner[j]!;
    gs.push(quad(outer[i]!,outer[j]!,ib,ia,new Vector3(0,0,1)));
    gs.push(quad(ia,ib,ib.clone().setZ(z+0.03),ia.clone().setZ(z+0.03),new Vector3(x-(ia.x+ib.x)/2,y-(ia.y+ib.y)/2,0).normalize()));
  }
  solid(w, `${name}:frame-reveals`, merge(gs), k.trim, m);
  pane(w, `${name}:sash`, k.trim, m, x, y + height * 0.08, z + 0.13, width, 0.045);
  if (width > 1.1) pane(w, `${name}:mullion`, k.trim, m, x, y, z + 0.135, 0.055, height);
  slab(w, `${name}:projecting-sill`, k.trim, m, x, y - height / 2 - 0.05, z + 0.12, width + 0.24, 0.1, 0.24);
}

function balcony(w: LombardWorld, k: Kit, m: Matrix4, x: number, y: number, width: number, z = 0.9) {
  slab(w, "balcony:slab", k.foundation, m, x, y, z / 2, width + 0.2, 0.18, z + 0.2);
  for (const railY of [0.15, 1.02]) slab(w, "balcony:horizontal-rail", k.iron, m, x, y + railY, z, width, 0.04, 0.04);
  const count = Math.ceil(width / 0.19);
  for (let i = 0; i <= count; i++) slab(w, "balcony:baluster", k.iron, m, x - width / 2 + width * i / count, y + 0.57, z, 0.024, 0.93, 0.024);
  for (const sx of [-1, 1]) {
    slab(w, "balcony:return-rail", k.iron, m, x + sx * width / 2, y + 1.02, z / 2, 0.04, 0.04, z);
    for (let j = 1; j < 5; j++) slab(w, "balcony:return-baluster", k.iron, m, x + sx * width / 2, y + 0.57, z * j / 5, 0.024, 0.93, 0.024);
  }
}

/** Three-sided bay, with actual window relief on every exposed side. */
function bay(w: LombardWorld, k: Kit, m: Matrix4, x: number, y: number, width: number, height: number, wall: Material) {
  slab(w, "bay:body", wall, m, x, y, 0.31, width, height + 0.42, 0.6);
  frameAt(w, k, m, "bay:front", x, y, width * 0.74, height, true, false, 0.64);
  slab(w, "bay:cornice", k.trim, m, x, y + height / 2 + 0.2, 0.33, width + 0.26, 0.15, 0.86);
  slab(w, "bay:apron", k.trim, m, x, y - height / 2 - 0.2, 0.33, width + 0.15, 0.13, 0.82);
  for (const s of [-1, 1]) {
    const side = m.clone().multiply(new Matrix4().makeTranslation(x + s * width / 2, y, 0.31)).multiply(new Matrix4().makeRotationY(s * Math.PI / 2));
    frameAt(w, k, side, "bay:side", 0, 0, 0.43, height, true);
  }
}

function garage(w: LombardWorld, k: Kit, m: Matrix4, x: number, y: number, width: number, blue = false) {
  slab(w, "garage:reveal", k.dark, m, x, y + 1.13, 0.035, width + 0.24, 2.4, 0.09);
  slab(w, "garage:door", blue ? k.walls[5]! : k.wood, m, x, y + 1.1, 0.11, width, 2.18, 0.07);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const xx = x + width * ((col + 0.5) / 4 - 0.5), yy = y + 0.28 + row * 0.54;
    slab(w, "garage:panel", blue ? k.walls[5]! : k.wood, m, xx, yy, 0.16, width / 4 - 0.11, 0.4, 0.07);
  }
  for (const s of [-1, 1]) slab(w, "garage:jamb", k.trim, m, x + s * (width / 2 + 0.12), y + 1.15, 0.13, 0.14, 2.45, 0.22);
  slab(w, "garage:lintel", k.trim, m, x, y + 2.4, 0.13, width + 0.4, 0.16, 0.24);
}

function roofGeometry(points: [number, number][], y: number): BufferGeometry {
  const shape = points.map(([x, z]) => new Vector2(x, z));
  const triangles = ShapeUtils.triangulateShape(shape, []);
  const pos: number[] = [], uv: number[] = [];
  for (const face of triangles) {
    const a = shape[face[0]!]!, b = shape[face[1]!]!, c = shape[face[2]!]!;
    const order = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0 ? [a, c, b] : [a, b, c];
    for (const p of order) { pos.push(p.x, y, p.y); uv.push(p.x, p.y); }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** 1040's recognisable steel-blue framing, diagonal braces and glazed sash bands. */
function blueHouse(w: LombardWorld, k: Kit, m: Matrix4, width: number, base: number, top: number) {
  for (const yy of [base + 2.7, base + 6.25, base + 9.4, top - 0.15]) slab(w, "1040:steel-transom", k.blue, m, 0, yy, 0.16, width, 0.18, 0.21);
  for (const x of [-width / 2 + 0.16, -width * 0.2, width * 0.22, width / 2 - 0.16]) slab(w, "1040:steel-upright", k.blue, m, x, (base + top) / 2, 0.14, 0.18, top - base, 0.22);
  for (const yy of [base + 4.3, base + 7.75]) for (let i = 0; i < 5; i++) frameAt(w, k, m, "1040:white-sash", -width * 0.32 + i * width * 0.157, yy, width * 0.146, 2.15, true, true, 0.17);
  for (const yy of [base + 2.8, base + 9.5]) for (let i = 0; i < 3; i++) {
    const x0 = -width / 2 + 0.18 + width * i / 3, x1 = x0 + width / 3 - 0.15;
    for (const reverse of [false, true]) {
      const a = new Vector3(x0, yy + (reverse ? 1.25 : 0), 0.22), b = new Vector3(x1, yy + (reverse ? 0 : 1.25), 0.22);
      solid(w, "1040:diagonal-brace", rod(a, b, 0.045, 4), k.blue, m);
    }
  }
  garage(w, k, m, width * 0.17, base + 0.02, width * 0.48, true);
  pane(w, "1040:recessed-entry", k.dark, m, -width * 0.37, base + 1.22, 0.045, 1.3, 2.42);
  balcony(w, k, m, 0, top + 0.05, width - 0.3, 0.3);
}

function building(w: LombardWorld, k: Kit, b: Footprint) {
  const ps = b.points.slice(0, -1) as [number, number][];
  if (ps.length < 3) return;
  const cx = ps.reduce((s, p) => s + p[0], 0) / ps.length, cz = ps.reduce((s, p) => s + p[1], 0) / ps.length;
  const [u, v] = siteUV(cx, cz), r = new Rng(b.id);
  const near = u > -26 && u < 174 && Math.abs(v) < 38;
  const immediate = u > 0 && u < 148 && Math.abs(v) < 27;
  const base = groundY(cx, cz), top = base + b.height - (b.address === "4" ? 2.1 : 0);
  const wall = b.address === "1040" ? k.walls[5]! : b.address === "4" ? k.walls[1]! : b.id === 262552541 ? k.walls[3]! : b.id % 5 === 0 ? k.siding : k.walls[b.id % 5]!;
  const area = ps.reduce((s, p, i) => { const q = ps[(i + 1) % ps.length]!; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  const name = `osm:${b.id}:${b.address || "residence"}`;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i]!, z = ps[(i + 1) % ps.length]!, dx = z[0] - a[0], dz = z[1] - a[1], len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const n = new Vector3(dz, 0, -dx).normalize().multiplyScalar(area > 0 ? 1 : -1);
    const along = new Vector3(n.z, 0, -n.x);
    const mid = new Vector3((a[0] + z[0]) / 2, 0, (a[1] + z[1]) / 2);
    const m = new Matrix4().makeBasis(along, UP, n).setPosition(mid);
    const wallGeo = quad(new Vector3(a[0], groundY(...a) - 0.6, a[1]), new Vector3(z[0], groundY(...z) - 0.6, z[1]), new Vector3(z[0], top, z[1]), new Vector3(a[0], top, a[1]), n);
    wallGeo.setAttribute("uv", new Float32BufferAttribute([0,groundY(...a)-0.6,len,groundY(...z)-0.6,len,top,0,top],2));
    solid(w, `${name}:wall`, wallGeo, wall);
    if (len < 2.9) continue;
    const [, mv] = siteUV(mid.x, mid.z);
    const towardStreet = n.dot(NORTH_SIDE) * Math.sign(v) < -0.65;
    const front = immediate && towardStreet && Math.abs(mv) < 21;
    const endFace = immediate && ((u < 25 && n.dot(UPHILL) < -0.7) || (u > 125 && n.dot(UPHILL) > 0.7));
    const detail = front || endFace;
    if (near) {
      slab(w, `${name}:cornice`, k.trim, m, 0, top - 0.12, 0.11, len + 0.08, 0.18, 0.3);
      slab(w, `${name}:parapet`, wall, m, 0, top + 0.21, -0.045, len, 0.48, 0.17);
      if (front) slab(w, `${name}:base-course`, k.foundation, m, 0, base + 0.28, 0.06, len, 0.56, 0.17);
    }
    if (b.address === "1040" && front && len > 9) { blueHouse(w, k, m, len, base, top); continue; }
    const floors = Math.max(1, Math.min(8, Math.round((top - base) / 3.25)));
    const fh = (top - base) / floors;
    const columns = Math.max(1, Math.min(detail ? 6 : 5, Math.floor(len / (detail ? 2.6 : 3.9))));
    // Far facades retain rhythm, without making every garden-side wall a hero asset.
    if (!near && (!towardStreet || len < 6)) continue;
    for (let f = 0; f < floors; f++) {
      const y = base + fh * (f + 0.5);
      for (let j = 0; j < columns; j++) {
        const x = len * ((j + 0.5) / columns - 0.5), ww = Math.min(1.65, len / columns * 0.53), hh = Math.min(1.85, fh * 0.57);
        if (front && f === 0 && len > 6) continue;
        if (detail && f > 0 && j % 2 === 0 && b.id % 3 === 0) bay(w, k, m, x, y, ww + 0.32, hh, wall);
        else frameAt(w, k, m, `${name}:window`, x, y, ww, hh, detail, r.chance(0.45));
      }
      if (front && f > 0) {
        slab(w, `${name}:floor-course`, k.trim, m, 0, base + fh * f, 0.06, len, 0.11, 0.13);
        if (b.id % 4 === 1 && f === 1 && len > 6) balcony(w, k, m, 0, base + fh * f + 0.15, Math.min(len - 1, 5.1));
      }
    }
    if (front && len > 6) {
      const entryY = groundY(mid.x, mid.z) + 0.04;
      garage(w, k, m, -len * 0.17, entryY, Math.min(3.8, len * 0.46));
      const doorX = len * 0.34;
      pane(w, `${name}:entry-reveal`, k.dark, m, doorX, entryY + 1.23, 0.04, 1.12, 2.47);
      slab(w, `${name}:front-door`, k.wood, m, doorX, entryY + 1.22, 0.07, 0.89, 2.3, 0.06);
      pane(w, `${name}:door-glass`, k.curtain, m, doorX, entryY + 1.56, 0.115, 0.63, 1.1);
      slab(w, `${name}:door-handle`, k.trim, m, doorX + 0.3, entryY + 1, 0.17, 0.035, 0.16, 0.06);
      slab(w, `${name}:door-canopy`, k.trim, m, doorX, entryY + 2.61, 0.38, 1.42, 0.14, 0.78);
      if (b.address) {
        const label = b.address.split(";")[0]!;
        const rect = w.draw(`house-number-${label}`, 112, 56, (g, ww, hh) => {
          g.fillStyle = "#dfdbcc"; g.fillRect(0, 0, ww, hh); g.fillStyle = "#303632";
          g.font = `600 ${hh * 0.61}px Georgia`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(label, ww / 2, hh / 2);
        });
        solid(w, `${name}:number`, atlasPlane(0.35, 0.175, rect).translate(doorX + 0.82, entryY + 1.82, 0.08), w.printed, m);
      }
    }
    if (front && len > 5) {
      solid(w, `${name}:downpipe`, rod(new Vector3(len / 2 - 0.14, base + 0.2, 0.19), new Vector3(len / 2 - 0.14, top - 0.15, 0.19), 0.044, 6), k.iron, m);
      for (let x = -len / 2 + 0.5; x < len / 2; x += 0.84) slab(w, `${name}:cornice-bracket`, k.trim, m, x, top - 0.37, 0.16, 0.11, 0.32, 0.32);
    }
  }
  solid(w, `${name}:roof`, roofGeometry(ps, top), k.roof);
  // Distinct slate mansard of the house immediately uphill from 1040.
  if (b.address === "4") {
    const us = ps.map(p => siteUV(...p)[0]), vs = ps.map(p => siteUV(...p)[1]);
    const u0 = Math.min(...us) + 0.35, u1 = Math.max(...us) - 0.25, v0 = Math.min(...vs) + 0.1, v1 = Math.max(...vs) - 0.35;
    const at = (uu: number, vv: number, y: number) => new Vector3(UPHILL.x * uu + NORTH_SIDE.x * vv, y, UPHILL.z * uu + NORTH_SIDE.z * vv);
    const corners = [at(u0, v0, top), at(u1, v0, top), at(u1, v1, top), at(u0, v1, top)];
    const upper = [at(u0 + 1, v0 + 1.2, top + 2.1), at(u1 - 1, v0 + 1.2, top + 2.1), at(u1 - 1, v1 - 1.2, top + 2.1), at(u0 + 1, v1 - 1.2, top + 2.1)];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; const n = corners[i]!.clone().add(corners[j]!).multiplyScalar(0.5).sub(new Vector3(cx, top - 8, cz)).normalize(); solid(w, "mansard:slate", quad(corners[i]!, corners[j]!, upper[j]!, upper[i]!, n), k.roof); }
    solid(w, "mansard:cap", quad(upper[0]!, upper[1]!, upper[2]!, upper[3]!, UP), k.roof);
  }
  if (near && b.id % 3 === 0) {
    solid(w, `${name}:chimney`, box(0.8, 1.65, 0.9).translate(cx + 1.5, top + 0.68, cz), wall);
    solid(w, `${name}:chimney-cap`, box(1, 0.13, 1.1).translate(cx + 1.5, top + 1.54, cz), k.trim);
  }
}

/** Distant context is deliberately estimated massing; measured OSM ends at ~250 m. */
function northBeach(w: LombardWorld, k: Kit) {
  const r = new Rng(0x53464241);
  const originAltitude = GEO.altitude;
  const hillY = (x: number, z: number) => 7 + 80 * Math.exp(-(((x - 1068) / 230) ** 2 + ((z + 20) / 300) ** 2)) - originAltitude;
  const terrain = new BufferGeometry(), terrainPos: number[] = [], terrainUV: number[] = [], terrainIndices: number[] = [], terrainColors: number[] = [];
  const nx=36,nz=24;
  for(let iz=0;iz<=nz;iz++)for(let ix=0;ix<=nx;ix++){
    const x=220+ix/nx*1110,z=-455+iz/nz*900;
    const blend=Math.min(1,Math.max(0,(x-220)/100));
    const y=groundY(220,z)*(1-blend)+hillY(x,z)*blend-0.18;
    terrainPos.push(x,y,z);terrainUV.push(x/20,z/20);
    const park=Math.exp(-(((x-1068)/120)**2+((z+20)/145)**2));
    const color=new Color(0x85887e).lerp(new Color(0x4c624d),park);terrainColors.push(color.r,color.g,color.b);
  }
  for(let iz=0;iz<nz;iz++)for(let ix=0;ix<nx;ix++){const a=iz*(nx+1)+ix,b=a+1,c=a+nx+1,d=c+1;terrainIndices.push(a,c,b,b,c,d);}
  terrain.setAttribute("position",new Float32BufferAttribute(terrainPos,3));terrain.setAttribute("uv",new Float32BufferAttribute(terrainUV,2));terrain.setAttribute("color",new Float32BufferAttribute(terrainColors,3));terrain.setIndex(terrainIndices);terrain.computeVertexNormals();
  const hillMaterial=w.lib.plain(0xffffff,0.95);hillMaterial.vertexColors=true;
  solid(w,"north-beach:estimated-terrain",terrain,hillMaterial);
  const facadeRects=["#d2cfbf","#b6b9b1","#d8cec1","#cdc6ab"].map((wall,i)=>w.draw(`sf-far-facade-${i}`,256,384,(g,ww,hh)=>{
    g.fillStyle=wall;g.fillRect(0,0,ww,hh);
    g.fillStyle="#ede8da";g.fillRect(0,0,ww,hh*.045);
    for(let row=0;row<4;row++)for(let col=0;col<3;col++){
      const x=ww*(.13+col*.29),y=hh*(.1+row*.218),pw=ww*.16,ph=hh*.14;
      g.fillStyle="#e5e0d3";g.fillRect(x-3,y-3,pw+6,ph+7);
      g.fillStyle=(col+row+i)%3?"#4d5b62":"#93958a";g.fillRect(x,y,pw,ph);
      g.fillStyle="#c9c5b8";g.fillRect(x,y+ph*.53,pw,2);g.fillRect(x+pw*.49,y,2,ph);
    }
    for(let row=1;row<4;row++){g.fillStyle="#b5b2a7";g.fillRect(0,hh*(.075+row*.218),ww,2);}
  }));
  // The real north/east street grid leaves readable corridors between city blocks.
  for (let ix = 0; ix < 24; ix++) for (let iz = 0; iz < 17; iz++) {
    const x = 290 + ix * 39 + r.range(-9, 9), z = -370 + iz * 45 + r.range(-8, 8);
    if (Math.hypot(x - 1068, (z + 20) * 0.82) < 80 || r.chance(0.05)) continue;
    const width = r.range(14, 29), depth = r.range(21, 36), h = r.range(7, 21) + (r.chance(.08)?r.range(5,11):0), y = hillY(x, z);
    solid(w, "north-beach:estimated-block", box(width, h, depth).translate(x, y + h / 2, z), k.walls[r.int(0, 4)]!);
    solid(w, "north-beach:flat-roof", box(width + 0.4, 0.45, depth + 0.4).translate(x, y + h, z), ix % 11 === 0 ? k.tile : k.trim);
    const rect=facadeRects[r.int(0,facadeRects.length-1)]!;
    solid(w,"north-beach:facade",atlasPlane(depth-.4,h-.3,rect).rotateY(-Math.PI/2).translate(x-width/2-.028,y+h/2,z),w.printed);
    if(iz%3===0)solid(w,"north-beach:side-facade",atlasPlane(width-.3,h-.3,rect).translate(x,y+h/2,z+depth/2+.025),w.printed);
    if(r.chance(.25))solid(w,"north-beach:roof-stairwell",box(width*.33,r.range(1.2,2.5),depth*.25).translate(x+width*.2,y+h+1,z-depth*.18),k.walls[r.int(0,4)]!);
  }
  // Coit centre: Geonames 37.8024,-122.40584; SF Rec Park height 210 ft.
  const x = (-122.40584 - GEO.lon) * 111320 * Math.cos(GEO.lat * Math.PI / 180), z = -(37.8024 - GEO.lat) * 111320;
  const base = 87 - originAltitude;
  solid(w, "coit:tapered-shaft", new CylinderGeometry(5.2, 6.2, 53.5, 20, 1).translate(x, base + 26.75, z), k.walls[0]!);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, dx = Math.sin(a), dz = Math.cos(a);
    solid(w, "coit:fluted-pier", new CylinderGeometry(0.58, 0.7, 53, 5).translate(x + dx * 5.7, base + 27, z + dz * 5.7), k.trim);
  }
  solid(w, "coit:observation-crown", new CylinderGeometry(5.9, 5.9, 10.1, 20).translate(x, base + 58.3, z), k.walls[0]!);
  // Draw crown openings on its outside surface, with one light mullion per bay.
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, m = new Matrix4().makeRotationY(a).setPosition(x + Math.sin(a) * 5.92, base + 57.5, z + Math.cos(a) * 5.92);
    pane(w, "coit:open-gallery", k.dark, m, 0, 0, 0.025, 1.32, 4.6);
  }
  solid(w, "coit:crown-rim", new CylinderGeometry(6.1, 6.1, 0.9, 20).translate(x, base + 63.55, z), k.trim);
}

export function buildBuildings(w: LombardWorld): void {
  const k = materials(w);
  for (const b of FOOTPRINTS) building(w, k, b);
  northBeach(w, k);
}
