/**
 * Preview card for a place: its `preview` shot (registry) captured at 16:9
 * with the UI hidden, written next to its export for the atlas cook. Needs a
 * running dev server (`bun run dev`) and a local Google Chrome.
 *
 *   bun scripts/preview-place.ts [--place ID] [--wait 15000]
 *
 * Without --place, every enterable place with a preview shot. The clock
 * starts at t = 25 s when the stage appears, however long loading took, and
 * the card is taken 1 s later (after the loading screen's fade), so it shows
 * the place at t ≈ 26 s. `--wait` bounds how long the loading screen may
 * take to appear.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { PLACES } from "../src/places/registry";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : dflt;
};
const base = opt("base", "http://127.0.0.1:5173");
const wait = Number(opt("wait", "15000"));
const only = opt("place", "");
const places = PLACES.filter((p) => p.load && p.preview && (!only || p.id === only));
if (!places.length) throw new Error(`no enterable place with a preview shot${only ? ` named ${only}` : ""}`);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
for (const p of places) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (e) => console.log(`[${p.id}] ${e.message}`));
  // At the shot's end framing and a fixed clock, so cards are reproducible.
  await page.goto(`${base}/?shot&q=ultra&cam=${encodeURIComponent(p.preview!)}&t=25#/place/${p.id}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector(".pc-loading")?.classList.contains("is-visible"), null, { timeout: wait }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".pc-loading")?.classList.contains("is-visible"), null, { timeout: 240_000 });
  await page.waitForTimeout(1000);
  const out = resolve(join(import.meta.dir, `../../.pocket-build/places/${p.id}`));
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, "preview.png") });
  console.log(`${p.id}: ${join(out, "preview.png")} (${p.preview})`);
  await page.close();
}
await browser.close();
