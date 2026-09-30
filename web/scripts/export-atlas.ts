/**
 * Exports the atlas screen for the Pocket Atlas cooker: the globe's surface
 * maps, the view-ray bakes for a handheld's fixed camera (sky and halo,
 * atmosphere over the disc), the globe parameters and the place registry.
 * Needs a running dev server (`bun run dev`) and a local Google Chrome.
 *
 *   bun scripts/export-atlas.ts [--out ../.pocket-build/atlas/globe]
 *
 * Files are raw texels (`<name>.u8` or `<name>.f32`, top row first) described
 * by `globe.json`; `places.json` lists every place on the globe.
 */
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PLACES } from "../src/places/registry";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const out = resolve(opt("out", join(import.meta.dir, "../../.pocket-build/atlas/globe")));
const base = opt("base", "http://127.0.0.1:5173");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => {
  if (m.type() === "error" || m.text().startsWith("[export]") || m.text().startsWith("[globe]")) console.log(`[page] ${m.text()}`);
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

await page.goto(`${base}/?shot&export&q=ultra`, { waitUntil: "load" });
await page.waitForFunction(() => typeof (window as unknown as { pocketAtlasExportGlobe?: unknown }).pocketAtlasExportGlobe === "function", null, { timeout: 180_000 });
console.log("globe built; exporting");
const t0 = Date.now();
const meta = await page.evaluate(async () => {
  type File = { name: string; width: number; height: number; channels: number; format: "u8" | "f32"; srgb?: boolean; data: Uint8Array };
  const w = window as unknown as {
    pocketAtlasExportGlobe: () => Promise<{ files: File[]; meta: Record<string, unknown> }>;
    __pcChunk: (n: string, b: string) => Promise<void>;
  };
  const r = await w.pocketAtlasExportGlobe();
  const send = async (name: string, bytes: Uint8Array) => {
    const step = 3 * 1024 * 1024;
    for (let i = 0; i < bytes.length; i += step) {
      const part = bytes.subarray(i, Math.min(bytes.length, i + step));
      let s = "";
      for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode(...part.subarray(j, j + 0x8000));
      await w.__pcChunk(name, btoa(s));
    }
  };
  const list = [];
  for (const f of r.files) {
    const file = `${f.name}.${f.format}`;
    await send(file, f.data);
    list.push({ name: f.name, file, width: f.width, height: f.height, channels: f.channels, format: f.format, srgb: !!f.srgb });
  }
  return { ...r.meta, files: list };
});
for (const fd of files.values()) closeSync(fd);
writeFileSync(join(out, "globe.json"), JSON.stringify({ ...meta, wallMs: Date.now() - t0 }, null, 2) + "\n");
const places = PLACES.map(({ load, ...p }) => ({ ...p, enterable: p.status === "live" && !!load }));
writeFileSync(join(out, "places.json"), JSON.stringify(places, null, 2) + "\n");
console.log(`wrote ${out} (${(meta as { files: unknown[] }).files.length} maps, ${places.length} places) in ${Date.now() - t0} ms`);
await browser.close();
