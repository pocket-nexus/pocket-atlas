#!/usr/bin/env bun
// Pocket Atlas drawn with wgpu (wgpu/): the atlas screen in a browser tab over
// WebGPU, and on this machine, where a frame goes to a file.
//
//   bun tools/wgpu.ts build                        wasm32 + wasm-bindgen + the page + the interface for the four
//                                                  devices (tools/atlas-ui.ts) on PocketJS's UI core + the globe's
//                                                  surface (tools/atlas-globe.ts) → .pocket-build/wgpu/site
//   bun tools/wgpu.ts serve [--port 8788]          the site, with byte ranges
//   bun tools/wgpu.ts dist [--piece 2]             the directory a static host serves → .pocket-build/wgpu/dist:
//                                                  the page, the module under its build's name, and the globe's
//                                                  surface cut into pieces of that many MiB with their manifest
//   bun tools/wgpu.ts serve --dist                 that directory as such a host serves it: no byte ranges
//   bun tools/wgpu.ts shot [--out f.png] [--shape ipod] [--at x,y,r] [--face lat,lon] [--pin N] [--pins LIST]
//                                                  the globe on this machine's GPU (Metal) → a PNG and the status
//   bun tools/wgpu.ts check [--headed] [--seconds 3] [--dist]   the page in Chrome, driven by keys, pointer and
//                                                  touch: each device's atlas screen, its lists, a place that is
//                                                  not here, another device picked, what a frame and a redraw of
//                                                  the interface cost, what the first frame needs on a slow line
//                                                  → .pocket-build/validation/web/
//
// `build` compiles the interface as tools/atlas-ui.ts does: it needs `bun install` in vendor/pocketjs and in
// web/, the globe's export (.pocket-build/atlas/globe, web/scripts/export-atlas.ts) and, for the cards'
// pictures, the places' previews (.pocket-build/places/<id>/preview.png).
// The site and the captures stay under the ignored .pocket-build/.

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { POCKET3D_ICON } from "../vendor/pocketjs/tools/pocket3d-icon.ts";
import { cutPack, stagePocket3dWeb } from "../vendor/pocketjs/tools/pocket3d-web.ts";
import { globeSurface } from "./atlas-globe.ts";
import { compileInterface, DEVICES } from "./atlas-ui.ts";

const ROOT = resolve(import.meta.dir, "..");
const CRATE = join(ROOT, "wgpu");
const BUILD = join(ROOT, ".pocket-build/wgpu");
const SITE = join(BUILD, "site");
const DIST = join(BUILD, "dist");
// The globe's surface in a tab: 1 024 texels round the equator, for a disc 400 pixels across on the PS Vita's
// screen (the iPod touch and the PSP read 512).
const SURFACE = 1024;
// What the host a build is deployed to allows (Pocket Studio's site deployments): the size of a file, the
// files and the bytes of a deployment, and the top-level names it keeps for itself.
const HOST = { file: 32 << 20, files: 4000, bytes: 1 << 30, reserved: ["play", "runtime"] };

const [command, ...rest] = process.argv.slice(2);
const option = (flag: string, fallback = "") => {
  const i = rest.indexOf(flag);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback;
};

/** The wasm module, its JavaScript side, the page, the interface and the globe's surface, as one directory a
 * static server can serve. */
async function build() {
  // The crate and the command line tool write two halves of one interface: their versions must be the same.
  const lock = readFileSync(join(CRATE, "Cargo.lock"), "utf8").match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
  const tool = (await $`wasm-bindgen --version`.text()).trim().split(" ")[1];
  if (lock !== tool) throw new Error(`wasm-bindgen ${tool} is installed and wgpu/Cargo.lock has ${lock}: cargo install wasm-bindgen-cli --version ${lock}`);
  await $`cargo build --release --locked --lib --target wasm32-unknown-unknown`.cwd(CRATE);
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "pkg"), { recursive: true });
  await $`wasm-bindgen --target web --no-typescript --out-dir ${join(SITE, "pkg")} ${join(CRATE, "target/wasm32-unknown-unknown/release/atlas_wgpu.wasm")}`;
  for (const file of ["index.html", "main.js"]) cpSync(join(CRATE, "page", file), join(SITE, file));
  // What the page loads from PocketJS's browser kernel (vendor/pocketjs/devices/web/pocket-web-wgpu), as
  // PocketJS stages it: the page's modules and their stylesheet, the Pocket3D title card, the realm of the
  // interface's guest with the UI core, and the host helpers of the framework. Then the icon of the tab.
  await stagePocket3dWeb(SITE);
  cpSync(POCKET3D_ICON.ios2x, join(SITE, "icon.png"));
  // The game's interface for each device, as its own build compiles it, with the plan PocketJS resolved.
  for (const device of DEVICES) {
    const built = await compileInterface(device);
    mkdirSync(join(SITE, "ui", device), { recursive: true });
    for (const file of ["atlas.js", "atlas.pak", "plan.json"]) cpSync(join(built.directory, file), join(SITE, "ui", device, file));
  }
  writeFileSync(join(SITE, "globe.rgba"), globeSurface(SURFACE));

  const sizes: Record<string, { bytes: number; gzip: number }> = {};
  for (const file of files(SITE).sort()) {
    const bytes = readFileSync(join(SITE, file));
    sizes[file] = { bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  }
  writeFileSync(join(BUILD, "site.json"), JSON.stringify({ wasmBindgen: tool, sizes }, null, 1));
  return sizes;
}

const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Every file under a directory, as paths from it. */
function files(directory: string, under = ""): string[] {
  return readdirSync(join(directory, under), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(directory, join(under, entry.name)) : [join(under, entry.name)]));
}

/**
 * The directory a static host serves, for a host that limits a file's size and keeps a file for ten minutes
 * in a browser's cache. Only the page is asked for again at every visit, so everything it names has a name of
 * its own contents: the module, its scripts and the interface under `app/<build>/`, the globe's manifest by
 * the surface's hash, a piece by its own. A deployment of new code leaves the surface's files as they are.
 */
async function dist(pieceBytes: number) {
  await build();
  rmSync(DIST, { recursive: true, force: true });
  // (everything of the site but the page, its icon and the surface: the module, the scripts, the interface)
  const app = files(SITE).filter((file) => !["index.html", "icon.png", "globe.rgba"].includes(file)).sort().map((file) => [file, readFileSync(join(SITE, file))] as const);
  const id = sha256(Buffer.concat(app.flatMap(([file, bytes]) => [Buffer.from(file), bytes]))).slice(0, 12);
  for (const [file, bytes] of app) {
    mkdirSync(join(DIST, "app", id, file, ".."), { recursive: true });
    writeFileSync(join(DIST, "app", id, file), bytes);
  }
  // The surface in pieces of one size, each named by its hash, and the manifest that lists them
  // (pocket_web_wgpu::source::Manifest), named by the surface's: a host that answers no byte ranges serves it.
  const cut = cutPack(join(SITE, "globe.rgba"), join(DIST, "globe"), pieceBytes);
  const manifest = `globe/${cut.manifest}`;
  // The page names its build and its surface.
  let page = readFileSync(join(SITE, "index.html"), "utf8");
  for (const [from, to] of [
    [`<meta name="pocket-globe" content="globe.rgba">`, `<meta name="pocket-globe" content="${manifest}">`],
    [`href="pocket3d-stage.css"`, `href="app/${id}/pocket3d-stage.css"`],
    [`src="main.js"`, `src="app/${id}/main.js"`],
  ] as const) {
    if (!page.includes(from)) throw new Error(`wgpu/page/index.html has no ${from}`);
    page = page.replace(from, to);
  }
  writeFileSync(join(DIST, "index.html"), page);
  cpSync(join(SITE, "icon.png"), join(DIST, "icon.png"));

  // What was written is what the host takes.
  const all = files(DIST).map((file) => ({ file, bytes: statSync(join(DIST, file)).size }));
  const total = all.reduce((sum, f) => sum + f.bytes, 0);
  const largest = all.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const part = (prefix: string) => all.filter((f) => f.file.startsWith(prefix)).reduce((sum, f) => ({ files: sum.files + 1, bytes: sum.bytes + f.bytes }), { files: 0, bytes: 0 });
  const refused = [
    ...all.filter((f) => f.bytes > HOST.file).map((f) => `${f.file} is ${f.bytes} bytes (a file is at most ${HOST.file})`),
    ...(all.length > HOST.files ? [`${all.length} files (at most ${HOST.files})`] : []),
    ...(total > HOST.bytes ? [`${total} bytes (at most ${HOST.bytes})`] : []),
    ...readdirSync(DIST).filter((name) => HOST.reserved.includes(name)).map((name) => `${name}/ is the host's own`),
  ];
  if (refused.length) throw new Error(`the host would refuse the directory: ${refused.join("; ")}`);
  const report = { directory: DIST, files: all.length, bytes: total, largest, build: id, page: part("index.html"), app: part("app/"), globe: { ...part("globe/"), manifest, pieces: cut.pieces.length, piece: pieceBytes, sha256: cut.sha256 } };
  writeFileSync(join(BUILD, "dist.json"), JSON.stringify(report, null, 1));
  return report;
}

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", wasm: "application/wasm", json: "application/json", png: "image/png" };

/** A directory as a static host serves it. `ranges`: a request for a byte range is answered with that range
 * (the site, whose surface is one file); without, every answer is a whole file, the page is asked for again
 * at every visit and the rest is kept ten minutes (the deployable directory on its host). */
function serve(directory: string, port: number, ranges: boolean) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = join(directory, path === "/" ? "index.html" : path);
      if (!file.startsWith(directory) || !existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
      const type = file.split(".").pop()!;
      const head: Record<string, string> = { "Content-Type": TYPES[type] ?? "application/octet-stream", "Cache-Control": !ranges && type !== "html" ? "public, max-age=600" : ranges ? "no-store" : "no-cache" };
      const range = ranges ? request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/) : null;
      if (!range) return new Response(Bun.file(file), { headers: ranges ? { ...head, "Accept-Ranges": "bytes" } : head });
      const size = statSync(file).size;
      const from = Number(range[1]);
      const to = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
      if (from > to) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      return new Response(Bun.file(file).slice(from, to + 1), { status: 206, headers: { ...head, "Accept-Ranges": "bytes", "Content-Range": `bytes ${from}-${to}/${size}`, "Content-Length": String(to - from + 1) } });
    },
  });
}

const SHOT = join(CRATE, "target/release/atlas-shot");

/** The globe on this machine's GPU, from the surface's file or from a manifest of its pieces. Returns the
 * status the run printed. */
async function shot(out: string, extra: string[], from: string) {
  await $`cargo build --release --locked --bin atlas-shot`.cwd(CRATE).quiet();
  mkdirSync(resolve(out, ".."), { recursive: true });
  return JSON.parse(await $`${SHOT} --globe ${from} --out ${out} ${extra}`.text());
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const validation = (run: string) => {
  const directory = join(ROOT, ".pocket-build/validation/web", run);
  mkdirSync(directory, { recursive: true });
  return directory;
};
const built = () => existsSync(join(SITE, "pkg/atlas_wgpu_bg.wasm"));

if (command === "build") {
  console.log(JSON.stringify(await build(), null, 1));
} else if (command === "dist") {
  console.log(JSON.stringify(await dist(Math.round(Number(option("--piece", "2")) * (1 << 20))), null, 1));
} else if (command === "serve" && rest.includes("--dist")) {
  if (!existsSync(join(DIST, "index.html"))) await dist(2 << 20);
  const server = serve(DIST, Number(option("--port", "8788")), false);
  console.log(`http://127.0.0.1:${server.port}/   (${DIST})`);
} else if (command === "serve") {
  if (!built()) await build();
  const server = serve(SITE, Number(option("--port", "8788")), true);
  console.log(`http://127.0.0.1:${server.port}/   (${SITE})`);
} else if (command === "shot") {
  if (!existsSync(join(SITE, "globe.rgba"))) {
    mkdirSync(SITE, { recursive: true });
    writeFileSync(join(SITE, "globe.rgba"), globeSurface(SURFACE));
  }
  const out = resolve(option("--out", join(validation(`shot-${stamp()}`), "globe.png")));
  const passed = ["--shape", "--size", "--logical", "--samples", "--at", "--face", "--pin", "--pins", "--status"].flatMap((flag) => (option(flag) ? [flag, option(flag)] : []));
  console.log(JSON.stringify(await shot(out, passed, resolve(option("--globe", join(SITE, "globe.rgba")))), null, 1));
  console.log(out);
} else if (command === "check") {
  // (--dist: the deployable directory, served whole files only, with the surface in pieces)
  const deployed = rest.includes("--dist") ? await dist(Math.round(Number(option("--piece", "2")) * (1 << 20))) : null;
  const sizes = deployed ? JSON.parse(readFileSync(join(BUILD, "site.json"), "utf8")).sizes : await build();
  // (the browser driver is the reference's: web/ has it)
  const { chromium } = await import("../web/node_modules/playwright-core");
  const server = deployed ? serve(DIST, 0, false) : serve(SITE, 0, true);
  const directory = validation(`check-${deployed ? "dist-" : ""}${stamp()}`);
  const seconds = Number(option("--seconds", "3"));
  const origin = `http://127.0.0.1:${server.port}`;
  // WebGPU needs the real GPU: headless Chrome is given Metal through ANGLE; --headed opens a window instead.
  const browser = await chromium.launch({ channel: "chrome", headless: !rest.includes("--headed"), args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--no-proxy-server"] });
  const report: Record<string, any> = { chrome: browser.version(), deployed };
  const expect = (what: string, ok: boolean) => {
    if (!ok) throw new Error(`the page: ${what}`);
  };
  type Page = Awaited<ReturnType<typeof browser.newPage>>;
  type Context = Awaited<ReturnType<typeof browser.newContext>>;
  /** A page on the site, and what a person does to it: keys held for a moment, a pointer down and up at a
   * place of a screen given in that screen's logical pixels, a drag. */
  const visit = async (address: string, context?: Context) => {
    const page: Page = await (context ?? browser).newPage({ viewport: { width: 1280, height: 800 } });
    const problems: string[] = [];
    page.on("console", (message: { type(): string; text(): string }) => message.type() === "error" && problems.push(message.text()));
    page.on("pageerror", (error: unknown) => problems.push(String(error)));
    await page.goto(`${origin}/${address}`);
    const status = async () => JSON.parse((await page.evaluate("pocketAtlas.atlas.status()")) as string);
    const at = async (screen: "upper" | "lower", size: number[], x: number, y: number) => {
      const box = (await page.locator(`[data-pocket-screen=${screen}]`).boundingBox())!;
      return [box.x + (x / size[0]!) * box.width, box.y + (y / size[1]!) * box.height] as const;
    };
    return {
      page,
      problems,
      status,
      /** The globe is drawn, the interface is up and has placed it and its pins, and the card has left. */
      async up() {
        await page.waitForFunction("window.pocketAtlas && ((pocketAtlas.firstGlobe && pocketAtlas.interface?.() && JSON.parse(pocketAtlas.atlas.status()).globe.pins > 0) || pocketAtlas.failure)", undefined, { timeout: 60_000 });
        const failure = (await page.evaluate("pocketAtlas.failure")) as string;
        if (failure) throw new Error(`${address}: ${failure}`);
        // (the globe has turned to the place the list starts on)
        await page.waitForTimeout(1500);
      },
      async key(code: string, hold = 90) {
        await page.keyboard.down(code);
        await page.waitForTimeout(hold);
        await page.keyboard.up(code);
        await page.waitForTimeout(250);
      },
      async tap(screen: "upper" | "lower", size: number[], x: number, y: number) {
        const [px, py] = await at(screen, size, x, y);
        await page.mouse.move(px, py);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        await page.waitForTimeout(300);
      },
      async drag(screen: "upper" | "lower", size: number[], from: number[], to: number[]) {
        const [ax, ay] = await at(screen, size, from[0]!, from[1]!);
        const [bx, by] = await at(screen, size, to[0]!, to[1]!);
        await page.mouse.move(ax, ay);
        await page.mouse.down();
        await page.mouse.move(bx, by, { steps: 12 });
        await page.waitForTimeout(80);
        await page.mouse.up();
        await page.waitForTimeout(300);
      },
      /** The screens as their canvases hold them, a pixel to a pixel: `<name>.png`, and `<name>-lower.png`. */
      async save(name: string) {
        const shot = (await page.evaluate("pocketAtlas.capture()")) as { upper: string; lower: string | null };
        const write = (file: string, url: string) => writeFileSync(join(directory, file), Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
        write(`${name}.png`, shot.upper);
        if (shot.lower) write(`${name}-lower.png`, shot.lower);
        return join(directory, `${name}.png`);
      },
    };
  };
  type Visit = Awaited<ReturnType<typeof visit>>;
  const compare = async (a: string, b: string, inside?: number[]) => JSON.parse(await $`${SHOT} --compare ${a} ${b} ${inside ? ["--inside", inside.join(",")] : []}`.text());
  /** How far round the world two longitudes are apart, degrees. */
  const round = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  const measure = async (p: Visit) => {
    const read = `({ frames: pocketAtlas.frames, at: performance.now(), timing: { ...pocketAtlas.timing } })`;
    const from = (await p.page.evaluate(read)) as { frames: number; at: number; timing: Record<string, number> };
    await p.page.waitForTimeout(seconds * 1000);
    const to = (await p.page.evaluate(read)) as typeof from;
    const span = (to.at - from.at) / 1000;
    const d = (key: string) => to.timing[key]! - from.timing[key]!;
    const frameMs = (await p.page.evaluate("pocketAtlas.burst(300)")) as number;
    // (the turns and the redraws since the page started: what the visitor did made them)
    const before = (await p.page.evaluate("({ ...pocketAtlas.timing })")) as Record<string, number>;
    const status = await p.status();
    const fix = (n: number) => +n.toFixed(3);
    return {
      fps: fix((to.frames - from.frames) / span),
      // (300 frames made without waiting for the display: the globe, the guest's turns and redraws, the scene)
      frameMs: fix(frameMs),
      // (at rest: nothing is held and nothing changes, so the guest is looked in on about once a second)
      turnsPerSecondAtRest: fix(d("turns") / span),
      turnMs: fix(before.turnMs! / Math.max(1, before.turns!)),
      // (a redraw: the UI core draws the interface once with its alpha, `drawMs`; the rest is the upload)
      redraws: before.redraws,
      redrawMs: fix(before.redrawMs! / Math.max(1, before.redraws!)),
      drawMs: fix(before.drawMs! / Math.max(1, before.redraws!)),
      lowers: before.lowers,
      lowerMs: fix(before.lowerMs! / Math.max(1, before.lowers!)),
      triangles: status.triangles,
      shape: status.shape,
    };
  };

  try {
    await $`cargo build --release --locked --bin atlas-shot`.cwd(CRATE).quiet();
    // The GPU the tab is given.
    const probe = await browser.newPage();
    await probe.goto(`${origin}/index.html?interface=off`);
    report.gpu = await probe.evaluate(`(async () => {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return null;
      const { vendor, architecture, device, description } = adapter.info ?? {};
      return { vendor, architecture, device, description, fallback: adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? false, format: navigator.gpu.getPreferredCanvasFormat(), features: [...adapter.features].filter((f) => f.startsWith("texture-compression") || f.includes("float")).sort() };
    })()`);
    await probe.close();

    // ---- the globe alone: the title card first, then the tab's frame beside this machine's own
    {
      const p = await visit("?device=ipod&interface=off");
      await p.page.waitForTimeout(1200);
      const during = (await p.page.evaluate("[document.querySelectorAll('[aria-label=Pocket3D]').length, document.getElementById('scene').hidden]")) as [number, boolean];
      await p.page.screenshot({ path: join(directory, "title-card.png") });
      expect(`the Pocket3D title card covers the page before the atlas is shown (${during})`, during[0] === 1 && during[1] === true);
      await p.page.waitForFunction("window.pocketAtlas?.firstGlobe > 0", undefined, { timeout: 60_000 });
      const afterwards = (await p.page.evaluate("[document.querySelectorAll('[aria-label=Pocket3D]').length, document.getElementById('scene').hidden]")) as [number, boolean];
      expect(`the card has left and the atlas is shown (${afterwards})`, afterwards[0] === 0 && afterwards[1] === false);
      // (with no guest the globe is where the shell first has it, facing where it first faces)
      await p.page.waitForTimeout(600);
      const tab = await p.save("globe-tab");
      const here = join(directory, "globe-here.png");
      await shot(here, ["--shape", "ipod"], deployed ? join(DIST, deployed.globe.manifest) : join(SITE, "globe.rgba"));
      report.globeTabAgainstHere = await compare(tab, here);
      expect(`the tab's frame is this machine's (${JSON.stringify(report.globeTabAgainstHere)})`, report.globeTabAgainstHere.mean < 0.5);
      report.globeRead = await p.page.evaluate("pocketAtlas.globeRead");
      expect(`no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }

    // ---- each device's atlas screen through its own interface
    const pad = [480, 272], top3ds = [400, 240], low3ds = [320, 240], ipod = [480, 320];
    report.devices = {};
    {
      // PS Vita: the d-pad walks the list and the globe turns to each place; the stick spins the globe; ○ on a
      // place whose pack is not here says so and stays on the atlas; □ saves a place, and the page keeps it.
      const p = await visit("?device=vita");
      await p.up();
      const first = await p.status();
      expect(`vita: the interface has placed the globe and its pins (${JSON.stringify(first.globe)})`, first.scene === "atlas" && first.globe.surface === SURFACE && first.globe.pins >= 7 && first.globe.lit >= 0 && first.globe.at[2] === 100 && first.installed === 0);
      expect(`vita: the screen is the plan's (${JSON.stringify(first.shape)})`, first.shape.width === 960 && first.shape.height === 544 && first.shape.logical[0] === 480 && first.shape.logical[1] === 272);
      await p.save("vita-atlas");
      await p.key("ArrowDown");
      await p.page.waitForTimeout(1500);
      const second = await p.status();
      expect(`vita: the d-pad moves down the list and the globe turns to the next place (pin ${first.globe.lit} to ${second.globe.lit})`, second.globe.lit !== first.globe.lit);
      await p.save("vita-second");
      // ○: a visit to a place that is not here.
      await p.key("KeyZ");
      await p.page.waitForTimeout(400);
      const asked = await p.status();
      expect(`vita: a place whose pack is not here is not entered (${asked.scene}, "${asked.place}")`, asked.scene === "atlas" && asked.place === "");
      await p.save("vita-not-here");
      // The left stick spins the globe to the east, and Explore sorts from where it settles.
      await p.key("KeyE");
      await p.page.keyboard.down("KeyD");
      await p.page.waitForTimeout(900);
      await p.page.keyboard.up("KeyD");
      const spun = await p.status();
      expect(`vita: the stick spins the globe (${asked.globe.facing[1]} to ${spun.globe.facing[1]})`, round(spun.globe.facing[1], asked.globe.facing[1]) > 20);
      await p.page.waitForTimeout(1500);
      await p.save("vita-explore");
      // □ saves the focused place: the page keeps what the interface asked to have stored.
      await p.key("KeyC");
      await p.page.waitForTimeout(400);
      const kept = (await p.page.evaluate(`localStorage.getItem("pocket-atlas.interface")`)) as string | null;
      expect(`vita: a saved place is kept by the page (${kept})`, Array.isArray(JSON.parse(kept ?? "{}").saved) && JSON.parse(kept!).saved.length === 1);
      report.kept = kept;
      report.devices.vita = await measure(p);
      // A place entered all the same (a development host's word) is answered at once: why, and the way back.
      await p.page.evaluate(`pocketAtlas.atlas.control("enter=tokyo-konbini")`);
      await p.page.waitForTimeout(700);
      const refused = await p.status();
      expect(`vita: no place opens in this build, and the shell says why (${refused.scene}: "${refused.message}")`, refused.scene === "error" && refused.message === "Places cannot be opened in the browser yet.");
      await p.save("vita-refused");
      await p.key("KeyX");
      await p.page.waitForTimeout(700);
      const back = await p.status();
      expect(`vita: ✕ goes back to the atlas (${back.scene})`, back.scene === "atlas");
      // The saved place is there on the next visit.
      await p.page.reload();
      await p.up();
      await p.key("KeyE");
      await p.key("KeyE");
      await p.page.waitForTimeout(600);
      await p.save("vita-saved-list");
      expect(`vita: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }
    {
      // PSP: the same presentation at one sample a logical pixel.
      const p = await visit("?device=psp");
      await p.up();
      const first = await p.status();
      expect(`psp: the screen is the plan's (${JSON.stringify(first.shape)})`, first.shape.width === 480 && first.shape.height === 272 && first.globe.pins >= 7);
      await p.save("psp-atlas");
      await p.key("ArrowDown");
      await p.key("ArrowDown");
      await p.page.waitForTimeout(1500);
      const third = await p.status();
      expect(`psp: the list moves (pin ${first.globe.lit} to ${third.globe.lit})`, third.globe.lit !== first.globe.lit);
      await p.key("Enter");
      await p.page.waitForTimeout(400);
      expect("psp: a place whose pack is not here is not entered", (await p.status()).scene === "atlas");
      await p.save("psp-not-here");
      report.devices.psp = await measure(p);
      expect(`psp: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }
    {
      // Nintendo 3DS: the globe and the card on the upper screen, the lists on the lower one under the
      // pointer as under a stylus.
      const p = await visit("?device=3ds");
      await p.up();
      const first = await p.status();
      const sizes = (await p.page.evaluate("[...document.querySelectorAll('[data-pocket-screen]')].map((c) => [c.width, c.height, c.hidden])")) as [number, number, boolean][];
      expect(`3ds: two screens (${JSON.stringify(sizes)}), the globe where the upper one's presentation puts it (${first.globe.at})`, JSON.stringify(sizes) === "[[400,240,false],[320,240,false]]" && first.globe.at[0] === 112 && first.globe.at[2] === 96);
      await p.save("3ds-atlas");
      // The third row of the list, under the stylus.
      await p.tap("lower", low3ds, 160, 36 + 45 * 2 + 20);
      await p.page.waitForTimeout(1500);
      const tapped = await p.status();
      expect(`3ds: a row tapped on the lower screen is the place the globe turns to (pin ${first.globe.lit} to ${tapped.globe.lit})`, tapped.globe.lit !== first.globe.lit);
      await p.save("3ds-tapped");
      // The Explore tab, tapped; then the Circle Pad spins the globe.
      await p.tap("lower", low3ds, 120, 18);
      await p.page.keyboard.down("KeyA");
      await p.page.waitForTimeout(900);
      await p.page.keyboard.up("KeyA");
      const spun = await p.status();
      expect(`3ds: the Circle Pad spins the globe (${tapped.globe.facing[1]} to ${spun.globe.facing[1]})`, round(spun.globe.facing[1], tapped.globe.facing[1]) > 20);
      await p.page.waitForTimeout(1500);
      await p.save("3ds-explore");
      await p.key("KeyZ");
      await p.page.waitForTimeout(400);
      expect("3ds: A on a place whose pack is not here stays on the atlas", (await p.status()).scene === "atlas");
      await p.save("3ds-not-here");
      report.devices["3ds"] = await measure(p);
      await p.page.screenshot({ path: join(directory, "page-3ds.png") });
      expect(`3ds: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }
    {
      // iPod touch: no buttons; a finger on a row, on Visit, and on the globe itself.
      const p = await visit("?device=ipod");
      await p.up();
      const first = await p.status();
      expect(`ipod: the globe where the touch presentation puts it (${first.globe.at})`, first.globe.at[0] === 126 && first.globe.at[2] === 112 && first.shape.hz === 60);
      await p.save("ipod-atlas");
      await p.tap("upper", ipod, 362, 174 + 44 + 22);
      await p.page.waitForTimeout(1500);
      const tapped = await p.status();
      expect(`ipod: a row under a finger is the place the globe turns to (pin ${first.globe.lit} to ${tapped.globe.lit})`, tapped.globe.lit !== first.globe.lit);
      // Visit, on a place whose pack is not here.
      await p.tap("upper", ipod, 401, 146);
      await p.page.waitForTimeout(400);
      expect("ipod: Visit on a place whose pack is not here stays on the atlas", (await p.status()).scene === "atlas");
      await p.save("ipod-not-here");
      // A finger drags the globe: the surface follows it.
      await p.drag("upper", ipod, [90, 170], [170, 150]);
      const dragged = await p.status();
      expect(`ipod: a finger on the globe turns it (${tapped.globe.facing} to ${dragged.globe.facing})`, round(dragged.globe.facing[1], tapped.globe.facing[1]) > 15);
      await p.page.waitForTimeout(1200);
      await p.save("ipod-dragged");
      report.devices.ipod = await measure(p);
      // The shell's refusal on a touch panel has its own way back: a button under a finger.
      await p.page.evaluate(`pocketAtlas.atlas.control("enter=tokyo-konbini")`);
      await p.page.waitForTimeout(700);
      expect("ipod: the refusal is shown", (await p.status()).scene === "error");
      await p.save("ipod-refused");
      expect(`ipod: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }

    // ---- another device picked from the page's own text: the new guest places the globe again
    {
      const p = await visit("?device=vita");
      await p.up();
      await p.key("ArrowDown");
      await p.page.waitForTimeout(800);
      const before = await p.status();
      await p.page.getByRole("button", { name: "Nintendo 3DS" }).click();
      await p.page.waitForFunction("pocketAtlas.device() === '3ds' && pocketAtlas.interface() && JSON.parse(pocketAtlas.atlas.status()).globe.at[0] === 112", undefined, { timeout: 20_000 });
      await p.page.waitForTimeout(1500);
      const after = await p.status();
      const sizes = (await p.page.evaluate("[...document.querySelectorAll('[data-pocket-screen]')].map((c) => [c.width, c.height, c.hidden])")) as [number, number, boolean][];
      expect(`a device picked on the page has its own screens (${JSON.stringify(sizes)}) and its own place for the globe (${before.globe.at} to ${after.globe.at})`, after.shape.name === "3ds" && after.scene === "atlas" && after.globe.pins === before.globe.pins && JSON.stringify(sizes) === "[[400,240,false],[320,240,false]]");
      await p.save("switched-3ds");
      await p.page.getByRole("button", { name: "iPod touch" }).click();
      await p.page.waitForFunction("pocketAtlas.device() === 'ipod' && pocketAtlas.interface() && JSON.parse(pocketAtlas.atlas.status()).globe.at[0] === 126", undefined, { timeout: 20_000 });
      await p.page.waitForTimeout(1500);
      const last = await p.status();
      expect(`the next device too (${last.shape.name}, ${last.fps} frames a second)`, last.shape.name === "ipod" && Math.abs(last.fps - 60) < 8);
      await p.save("switched-ipod");
      await p.page.screenshot({ path: join(directory, "page-ipod.png") });
      report.switched = { from: before.shape.name, to: [after.shape.name, last.shape.name], globeAt: [before.globe.at, after.globe.at, last.globe.at] };
      expect(`no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }

    // ---- a browser whose pointer is a finger: the iPod touch first, and a device's buttons on the page
    {
      const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
      const p = await visit("", context);
      await p.up();
      expect("a finger gets the iPod touch first", (await p.page.evaluate("pocketAtlas.device()")) === "ipod");
      await p.page.screenshot({ path: join(directory, "finger-ipod.png") });
      await p.page.close();
      const q = await visit("?device=psp", context);
      await q.up();
      const named = (await q.page.evaluate("[...document.querySelectorAll('[data-pocket-button]')].map((b) => b.textContent).join(' ')")) as string;
      expect(`a device with buttons has them on the page (${named})`, ["L", "R", "△", "○", "✕", "□", "START", "SELECT", "▲"].every((name) => named.split(" ").includes(name)));
      const cdp = await context.newCDPSession(q.page);
      const touch = async (label: string, hold = 120) => {
        const box = (await q.page.locator(`[data-pocket-button="${label}"]`).boundingBox())!;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
        await q.page.waitForTimeout(hold);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await q.page.waitForTimeout(300);
      };
      const before = await q.status();
      await touch("▼");
      await q.page.waitForTimeout(1200);
      const moved = await q.status();
      expect(`the d-pad on the page moves down the list (pin ${before.globe.lit} to ${moved.globe.lit})`, moved.globe.lit !== before.globe.lit);
      // The stick on the page, under a thumb, spins the globe.
      const stick = (await q.page.locator("[data-pocket-stick]").boundingBox())!;
      const centre = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...centre, id: 1 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: centre.x + stick.width * 0.4, y: centre.y, id: 1 }] });
      await q.page.waitForTimeout(900);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await q.page.waitForTimeout(200);
      const spun = await q.status();
      expect(`the stick on the page spins the globe (${moved.globe.facing[1]} to ${spun.globe.facing[1]})`, round(spun.globe.facing[1], moved.globe.facing[1]) > 15);
      await q.page.screenshot({ path: join(directory, "finger-psp.png") });
      expect(`no error on the page (${q.problems.join("; ")})`, q.problems.length === 0);
      await context.close();
      report.finger = { first: "ipod", buttons: named };
    }

    // ---- what the first frame of the atlas needs: the page on a line of 16 Mbit/s
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: 2_000_000, uploadThroughput: 1_000_000 });
      let received = 0;
      let counting = true;
      cdp.on("Network.dataReceived", (event: { encodedDataLength: number; dataLength: number }) => {
        if (counting) received += event.encodedDataLength || event.dataLength;
      });
      await page.goto(`${origin}/?device=vita`);
      await page.waitForFunction("window.pocketAtlas && ((pocketAtlas.firstGlobe && pocketAtlas.interfaceReady) || pocketAtlas.failure)", undefined, { timeout: 120_000 });
      counting = false;
      const first = (await page.evaluate("({ globe: pocketAtlas.globe, interfaceReady: pocketAtlas.interfaceReady, firstFrame: pocketAtlas.firstFrame, firstGlobe: pocketAtlas.firstGlobe, failure: pocketAtlas.failure, globeRead: pocketAtlas.globeRead })")) as Record<string, any>;
      await page.screenshot({ path: join(directory, "first-frame.png") });
      report.firstFrame = { bytesPerSecond: 2_000_000, bytesReceived: received, globeMs: Math.round(first.globe), interfaceMs: Math.round(first.interfaceReady), firstFrameMs: Math.round(first.firstFrame), firstGlobeFrameMs: Math.round(first.firstGlobe), globeRead: first.globeRead, failure: first.failure };
      await page.close();
    }

    // ---- a browser without WebGPU is told so in one sentence, after the card
    {
      const without = await browser.newPage();
      await without.addInitScript("Object.defineProperty(Navigator.prototype, 'gpu', { get: undefined, configurable: true }); delete Navigator.prototype.gpu;");
      await without.goto(`${origin}/`);
      await without.waitForFunction("document.getElementById('say').textContent !== ''", undefined, { timeout: 20_000 });
      report.withoutWebGPU = await without.locator("#say").textContent();
      const cover = (await without.evaluate("document.querySelectorAll('[aria-label=Pocket3D]').length")) as number;
      expect(`a browser without WebGPU is told so, once the card has left ("${report.withoutWebGPU}", ${cover})`, report.withoutWebGPU === "This browser has no WebGPU, which Pocket Atlas draws with." && cover === 0);
      await without.close();
    }
  } finally {
    await browser.close();
    server.stop(true);
    report.sizes = sizes;
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 1));
  }
  const { sizes: _, ...brief } = report;
  console.log(JSON.stringify({ ...brief, module: sizes["pkg/atlas_wgpu_bg.wasm"], uiCore: sizes["pocketjs.wasm"], globe: sizes["globe.rgba"] }, null, 1));
  console.log(directory);
} else throw new Error("usage: build | serve [--port N] [--dist] | dist [--piece MiB] | shot [--out PNG] [--shape NAME] [--at X,Y,R] [--face LAT,LON] [--pin N] [--pins LIST] | check [--headed] [--seconds N] [--dist]");
