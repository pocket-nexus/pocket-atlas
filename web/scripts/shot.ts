/**
 * Headless capture for visual checks. Needs a running dev server
 * (`bun run dev`) and a local Google Chrome.
 *
 *   bun scripts/shot.ts "/?shot&q=high#/city/tokyo" out.png --wait 8000 --size 1600x900
 *
 * Prints page console errors so shader compile failures surface in the log.
 */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const path = args[0] ?? "/";
const out = args[1] ?? "shot.png";
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const wait = Number(opt("wait", "6000"));
const [w, h] = opt("size", "1600x900").split("x").map(Number);
const base = opt("base", "http://127.0.0.1:5173");
const evalJs = opt("eval", "");
const frames = Number(opt("frames", "0"));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: Number(opt("dpr", "1")) });
const logs: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning" || m.type() === "info") logs.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + path, { waitUntil: "load" });
await page.waitForTimeout(wait);
if (evalJs) {
  await page.evaluate(evalJs);
  await page.waitForTimeout(Number(opt("after", "1500")));
}
if (frames > 0) {
  // Burst of frames: several captures for motion checks.
  for (let i = 0; i < frames; i++) {
    await page.screenshot({ path: out.replace(/\.png$/, `-${i}.png`) });
    await page.waitForTimeout(Number(opt("interval", "500")));
  }
} else {
  await page.screenshot({ path: out });
}
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
});
const stats = await page.evaluate(() => document.querySelector(".pc-stats")?.textContent ?? "");
console.log(`gpu: ${gpu}`);
if (stats) console.log(`stats: ${stats}`);
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
