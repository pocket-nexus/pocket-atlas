/**
 * Exports a place for the Pocket Atlas cooker: glTF 2.0 (binary) with
 * `extras.pocketAtlas`, the HDR environment cube, any extra files the place
 * names (baked sky layers), and a report. Needs a running dev server
 * (`bun run dev`) and a local Google Chrome.
 *
 *   bun scripts/export-place.ts [--place tokyo-konbini] [--out ../.pocket-build/places/<place>] [--seconds 20] [--geometry full|handheld] [--base http://127.0.0.1:5173]
 *
 * The device loops the recorded tracks; the Tokyo konbini pack uses 20 s.
 * Every place stage exposes `window.pocketAtlasExport` under `?export`
 * (`src/places/shared/export.ts`).
 */
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const place = opt("place", "tokyo-konbini");
const out = resolve(opt("out", join(import.meta.dir, `../../.pocket-build/places/${place}`)));
const seconds = Number(opt("seconds", "20"));
const base = opt("base", "http://127.0.0.1:5173");
const geometry = opt("geometry", "full");
if (geometry !== "full" && geometry !== "handheld") throw new Error("--geometry must be full or handheld");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => {
  if (m.type() === "error" || /^\[[a-z-]+\]/.test(m.text())) console.log(`[page] ${m.text()}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

const files = new Map<string, number>();
await page.exposeFunction("__pcChunk", (name: string, b64: string) => {
  let fd = files.get(name);
  if (fd === undefined) {
    fd = openSync(join(out, name), "w");
    files.set(name, fd);
  }
  writeSync(fd, Buffer.from(b64, "base64"));
});

await page.goto(`${base}/?shot&export&q=ultra&geometry=${geometry}#/place/${place}`, { waitUntil: "load" });
await page.waitForFunction(() => typeof (window as unknown as { pocketAtlasExport?: unknown }).pocketAtlasExport === "function", null, { timeout: 180_000 });
console.log("scene built; exporting");
const t0 = Date.now();
const report = await page.evaluate(async (secs: number) => {
  type Out = { glb: ArrayBuffer; env: Uint16Array | null; files: { name: string; bytes: Uint8Array }[]; report: Record<string, unknown> };
  const w = window as unknown as { pocketAtlasExport: (s: number) => Promise<Out>; __pcChunk: (n: string, b: string) => Promise<void> };
  const r = await w.pocketAtlasExport(secs);
  const send = async (name: string, bytes: Uint8Array) => {
    const step = 3 * 1024 * 1024;
    for (let i = 0; i < bytes.length; i += step) {
      const part = bytes.subarray(i, Math.min(bytes.length, i + step));
      let s = "";
      for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode(...part.subarray(j, j + 0x8000));
      await w.__pcChunk(name, btoa(s));
    }
  };
  await send("scene.glb", new Uint8Array(r.glb));
  if (r.env) await send("env.rgba16f", new Uint8Array(r.env.buffer, r.env.byteOffset, r.env.byteLength));
  for (const f of r.files) await send(f.name, f.bytes);
  return r.report;
}, seconds);
for (const fd of files.values()) closeSync(fd);
writeFileSync(join(out, "report.json"), JSON.stringify({ ...report, geometry, wallMs: Date.now() - t0 }, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
console.log(`wrote ${out}`);
await browser.close();
