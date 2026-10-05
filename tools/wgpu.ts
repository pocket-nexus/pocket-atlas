#!/usr/bin/env bun
// Pocket Atlas drawn with wgpu (wgpu/): the atlas screen and the places in a
// browser tab over WebGPU, and on this machine, where a frame goes to a file.
//
//   bun tools/wgpu.ts build                        wasm32 + wasm-bindgen + the page + the interface for the four
//                                                  devices (tools/atlas-ui.ts) on PocketJS's UI core + the globe's
//                                                  surface (tools/atlas-globe.ts) + the places' packs that are
//                                                  here → .pocket-build/wgpu/site
//   bun tools/wgpu.ts serve [--port 8788]          the site, with byte ranges
//   bun tools/wgpu.ts dist [--piece 2]             the directory a static host serves → .pocket-build/wgpu/dist:
//                                                  the page, the module under its build's name, and the globe's
//                                                  surface and every pack cut into pieces of that many MiB with
//                                                  their manifests
//   bun tools/wgpu.ts serve --dist                 that directory as such a host serves it: no byte ranges
//   bun tools/wgpu.ts shot [--out f.png] [--shape ipod] [--at x,y,r] [--face lat,lon] [--pin N] [--pins LIST]
//                                                  the globe on this machine's GPU (Metal) → a PNG and the status
//   bun tools/wgpu.ts shot --place ID [--out f.png] [--shape vita] [--shot 0] [--part 0.5] [--time 25] [--tour S]
//                                                  a place from one of its authored shots, or after S seconds of
//                                                  its tour
//   bun tools/wgpu.ts check [--headed] [--seconds 3] [--dist] [--quick]
//                                                  the page in Chrome, driven by keys, pointer and touch: each
//                                                  device's atlas screen and its lists, a place entered through
//                                                  the interface and left again, every place's held view beside
//                                                  this machine's own, the player with every device in its shell
//                                                  in a 1440 by 900 window and on a phone, what a frame costs,
//                                                  what a first frame needs on a slow line (--quick: of one place)
//                                                  → .pocket-build/validation/web/
//
// `build` compiles the interface as tools/atlas-ui.ts does: it needs `bun install` in vendor/pocketjs and in
// web/, the globe's export (.pocket-build/atlas/globe, web/scripts/export-atlas.ts) and, for the cards'
// pictures, the places' previews (.pocket-build/places/<id>/preview.png). A place can be entered when its pack
// for the PS Vita is here: .pocket-build/places/<id>/<id>.place (`bun tools/atlas.ts place <id>`).
// The site and the captures stay under the ignored .pocket-build/.

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
// The devices the page shows (`DEVICES` in wgpu/page/main.js): each has a shell in the kernel's player.
const SHOWN: readonly string[] = ["vita", "psp", "3ds", "ipod"];
// The places' packs as the PS Vita reads them: the browser draws the same file.
const PACKS = join(ROOT, ".pocket-build/places");
const pack = (id: string) => join(PACKS, id, `${id}.place`);
const places = () => (existsSync(PACKS) ? readdirSync(PACKS).filter((id) => existsSync(pack(id))).sort() : []);
/** The page with its packs named: a place's id to where its pack is, from the page. */
function named(page: string, packs: Record<string, string>) {
  const tag = /<meta name="pocket-places" content="[^"]*">/;
  if (!tag.test(page)) throw new Error("wgpu/page/index.html has no pocket-places");
  return page.replace(tag, `<meta name="pocket-places" content="${JSON.stringify(packs).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`);
}

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
  // The game's interface for each device the page shows, as its own build compiles it, with the plan
  // PocketJS resolved. (An Android phone has no shell in the player: its bundle is not staged.)
  for (const device of DEVICES.filter((d) => SHOWN.includes(d))) {
    const built = await compileInterface(device);
    mkdirSync(join(SITE, "ui", device), { recursive: true });
    for (const file of ["atlas.js", "atlas.pak", "plan.json"]) cpSync(join(built.directory, file), join(SITE, "ui", device, file));
  }
  writeFileSync(join(SITE, "globe.rgba"), globeSurface(SURFACE));
  // The packs that are here, each one file the site's server answers byte ranges of: a link, not a copy.
  const here = places();
  mkdirSync(join(SITE, "places"));
  for (const id of here) symlinkSync(realpathSync(pack(id)), join(SITE, "places", `${id}.place`));
  writeFileSync(join(SITE, "index.html"), named(readFileSync(join(SITE, "index.html"), "utf8"), Object.fromEntries(here.map((id) => [id, `places/${id}.place`]))));

  const sizes: Record<string, { bytes: number; gzip: number }> = {};
  for (const file of files(SITE).sort()) {
    // (a pack's blocks are compressed already)
    if (file.startsWith("places/")) {
      sizes[file] = { bytes: statSync(join(SITE, file)).size, gzip: 0 };
      continue;
    }
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
  const app = files(SITE).filter((file) => !["index.html", "icon.png", "globe.rgba"].includes(file) && !file.startsWith("places/")).sort().map((file) => [file, readFileSync(join(SITE, file))] as const);
  const id = sha256(Buffer.concat(app.flatMap(([file, bytes]) => [Buffer.from(file), bytes]))).slice(0, 12);
  for (const [file, bytes] of app) {
    mkdirSync(join(DIST, "app", id, file, ".."), { recursive: true });
    writeFileSync(join(DIST, "app", id, file), bytes);
  }
  // The surface in pieces of one size, each named by its hash, and the manifest that lists them
  // (pocket_web_wgpu::source::Manifest), named by the surface's: a host that answers no byte ranges serves it.
  const cut = cutPack(join(SITE, "globe.rgba"), join(DIST, "globe"), pieceBytes);
  const manifest = `globe/${cut.manifest}`;
  // Every pack the same way, under the place's id: a place's first frame fetches the pieces its table, its
  // geometry and its animation lie in, and a texture's pieces as the texture is read.
  const packs: Record<string, { manifest: string; pieces: number; bytes: number; sha256: string }> = {};
  for (const id of places()) {
    const cut = cutPack(pack(id), join(DIST, "places", id), pieceBytes);
    packs[id] = { manifest: `places/${id}/${cut.manifest}`, pieces: cut.pieces.length, bytes: cut.bytes, sha256: cut.sha256 };
  }
  // The page names its build, its surface and its packs.
  let page = named(readFileSync(join(SITE, "index.html"), "utf8"), Object.fromEntries(Object.entries(packs).map(([id, p]) => [id, p.manifest])));
  for (const [from, to] of [
    [`<meta name="pocket-globe" content="globe.rgba">`, `<meta name="pocket-globe" content="${manifest}">`],
    [`href="pocket3d-stage.css"`, `href="app/${id}/pocket3d-stage.css"`],
    [`href="pocket3d-player.css"`, `href="app/${id}/pocket3d-player.css"`],
    [`src="main.js"`, `src="app/${id}/main.js"`],
  ] as const) {
    if (!page.includes(from)) throw new Error(`wgpu/page/index.html has no ${from}`);
    page = page.replace(from, to);
  }
  // The game in Pocket Studio, for the player's door to it where the host answers no /app.json: the project
  // this checkout is registered as (`pocket-studio register` wrote .pocket-studio.json, which Git ignores).
  // A checkout that is not registered deploys a page whose door is the Studio's front one.
  const link = join(ROOT, ".pocket-studio.json");
  const project = existsSync(link) ? (JSON.parse(readFileSync(link, "utf8")) as { kind?: string; server?: string; app?: string }) : null;
  const studio = project?.kind === "site" && /^[A-Za-z0-9_-]+$/.test(project.app ?? "") && /^https:\/\/[A-Za-z0-9.-]+$/.test(project.server ?? "") ? { app: project.app!, server: project.server! } : null;
  if (studio) {
    if (!page.includes(`<meta name="pocket-globe"`)) throw new Error("wgpu/page/index.html has no pocket-globe");
    page = page.replace(`<meta name="pocket-globe"`, `<meta name="pocket-app" content="${studio.app}">\n<meta name="pocket-studio" content="${studio.server}">\n<meta name="pocket-globe"`);
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
  const report = { directory: DIST, files: all.length, bytes: total, largest, build: id, studio, page: part("index.html"), app: part("app/"), globe: { ...part("globe/"), manifest, pieces: cut.pieces.length, piece: pieceBytes, sha256: cut.sha256 }, places: { ...part("places/"), packs } };
  writeFileSync(join(BUILD, "dist.json"), JSON.stringify(report, null, 1));
  return report;
}

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", wasm: "application/wasm", json: "application/json", png: "image/png", webp: "image/webp", woff2: "font/woff2", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };

/**
 * What a game's host of Pocket Studio answers at `/app.json`, for the site's server here: the player reads
 * the game's name and its packages from it. (The packages and their sizes are examples.)
 */
const APP = {
  kind: "site", id: "local", slug: null, url: null, title: "Pocket Atlas", author: "local", tagline: "The world in your pocket.", verified: true, status: "published",
  packages: [{ target: "psp", filename: "pocket-atlas-psp.zip", size: 31_000_000, version: "0.0.0" }, { target: "3ds", filename: "pocket-atlas.3dsx", size: 64_000_000, version: "0.0.0" }],
};

/** A directory as a static host serves it. `ranges`: a request for a byte range is answered with that range
 * (the site, whose surface is one file); without, every answer is a whole file, the page is asked for again
 * at every visit and the rest is kept ten minutes (the deployable directory on its host). */
function serve(directory: string, port: number, ranges: boolean) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      // (the site's server answers as a game's host does; the deployable directory's answers nothing there,
      // and the page's own two words stand)
      if (ranges && path === "/app.json") return Response.json(APP, { headers: { "Cache-Control": "no-store" } });
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

/** A place on this machine's GPU, from its pack or from a manifest of its pieces. */
async function placeShot(id: string, out: string, extra: string[], from = pack(id)) {
  await $`cargo build --release --locked --bin atlas-shot`.cwd(CRATE).quiet();
  mkdirSync(resolve(out, ".."), { recursive: true });
  return JSON.parse(await $`${SHOT} --place ${from} --out ${out} ${extra}`.text());
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
} else if (command === "shot" && option("--place")) {
  const id = option("--place");
  if (!existsSync(pack(id))) throw new Error(`${pack(id)} is not here: bun tools/atlas.ts place ${id}`);
  const out = resolve(option("--out", join(validation(`shot-${stamp()}`), `${id}.png`)));
  const passed = ["--shape", "--size", "--samples", "--shot", "--part", "--time", "--frames", "--tour", "--status"].flatMap((flag) => (option(flag) ? [flag, option(flag)] : []));
  console.log(JSON.stringify(await placeShot(id, out, passed), null, 1));
  console.log(out);
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
  const here = places();
  if (!here.length) throw new Error(`no place's pack is under ${PACKS}: bun tools/atlas.ts place tokyo-konbini`);
  // (the place that is entered through the interface and measured on a slow line when --quick asks for one)
  const one = here.includes("tokyo-konbini") ? "tokyo-konbini" : here[0]!;
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
    // (the deployable directory's server answers no /app.json: the player asks, and the page's own words stand)
    page.on("console", (message: { type(): string; text(): string; location(): { url: string } }) => message.type() === "error" && !message.location().url.endsWith("/app.json") && problems.push(message.text()));
    page.on("pageerror", (error: unknown) => problems.push(String(error)));
    await page.goto(`${origin}/${address}`);
    const status = async () => JSON.parse((await page.evaluate("pocketAtlas.atlas.status()")) as string);
    /** The shell's scene is one of `scenes`; with `settled`, every texture of the open place is on the GPU. */
    const scene = async (scenes: string[], settled = false) => {
      await page.waitForFunction(`(() => { const s = JSON.parse(pocketAtlas.atlas.status()); return ${JSON.stringify(scenes)}.includes(s.scene) && (${!settled} || s.scene !== "place" || s.visit.waiting === 0); })()`, undefined, { timeout: 180_000 });
      return status();
    };
    const at = async (screen: "upper" | "lower", size: number[], x: number, y: number) => {
      const box = (await page.locator(`[data-pocket-screen=${screen}]`).boundingBox())!;
      return [box.x + (x / size[0]!) * box.width, box.y + (y / size[1]!) * box.height] as const;
    };
    return {
      page,
      problems,
      status,
      scene,
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
      const during = (await p.page.evaluate("[document.querySelectorAll('[aria-label=Pocket3D]').length, document.querySelector('[data-pocket-screen=upper]').hidden]")) as [number, boolean];
      await p.page.screenshot({ path: join(directory, "title-card.png") });
      expect(`the Pocket3D title card covers the page before the atlas is shown (${during})`, during[0] === 1 && during[1] === true);
      await p.page.waitForFunction("window.pocketAtlas?.firstGlobe > 0", undefined, { timeout: 60_000 });
      const afterwards = (await p.page.evaluate("[document.querySelectorAll('[aria-label=Pocket3D]').length, document.querySelector('[data-pocket-screen=upper]').hidden]")) as [number, boolean];
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
      expect(`vita: the interface has placed the globe and its pins (${JSON.stringify(first.globe)})`, first.scene === "atlas" && first.globe.surface === SURFACE && first.globe.pins >= 7 && first.globe.lit >= 0 && first.globe.at[2] === 100 && first.places === true && first.installed === here.length && first.visit === null);
      expect(`vita: the screen is the plan's (${JSON.stringify(first.shape)})`, first.shape.width === 960 && first.shape.height === 544 && first.shape.logical[0] === 480 && first.shape.logical[1] === 272);
      await p.save("vita-atlas");
      await p.key("ArrowDown");
      await p.page.waitForTimeout(1500);
      const second = await p.status();
      expect(`vita: the d-pad moves down the list and the globe turns to the next place (pin ${first.globe.lit} to ${second.globe.lit})`, second.globe.lit !== first.globe.lit);
      await p.save("vita-second");
      const asked = second;
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
      // A place whose pack is not here (a development host's word for one) is answered at once: why, and the
      // way back.
      await p.page.evaluate(`pocketAtlas.atlas.control("enter=nowhere")`);
      await p.page.waitForTimeout(700);
      const refused = await p.status();
      expect(`vita: a place whose pack is not here does not open, and the shell says why (${refused.scene}: "${refused.message}")`, refused.scene === "error" && refused.message === "This place's pack is not here.");
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
      report.devices.psp = await measure(p);
      // ○ enters the place the list is on; ✕ leaves it.
      await p.key("Enter");
      const inside = await p.scene(["place", "error"], true);
      expect(`psp: ○ enters the place (${inside.scene} "${inside.message}", ${JSON.stringify(inside.visit?.size)})`, inside.scene === "place" && inside.visit.size[0] === 480 && inside.visit.size[1] === 272 && inside.visit.trouble === "");
      await p.page.waitForTimeout(1500);
      await p.save("psp-place");
      await p.key("KeyX");
      expect("psp: ✕ leaves the place", (await p.scene(["atlas"])).visit === null);
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
      // A enters the place the row is: the upper screen is the place's, the lower one its controls. B leaves.
      await p.key("KeyZ");
      const inside = await p.scene(["place", "error"], true);
      expect(`3ds: A enters the place (${inside.scene} "${inside.message}", ${JSON.stringify(inside.visit?.size)})`, inside.scene === "place" && inside.visit.size[0] === 400 && inside.visit.size[1] === 240 && inside.visit.trouble === "");
      await p.page.waitForTimeout(1500);
      await p.save("3ds-place");
      await p.key("KeyX");
      expect("3ds: B leaves the place", (await p.scene(["atlas"])).visit === null);
      await p.page.waitForTimeout(800);
      // The Explore tab, tapped; then the Circle Pad spins the globe.
      await p.tap("lower", low3ds, 120, 18);
      await p.page.keyboard.down("KeyA");
      await p.page.waitForTimeout(900);
      await p.page.keyboard.up("KeyA");
      const spun = await p.status();
      expect(`3ds: the Circle Pad spins the globe (${tapped.globe.facing[1]} to ${spun.globe.facing[1]})`, round(spun.globe.facing[1], tapped.globe.facing[1]) > 20);
      await p.page.waitForTimeout(1500);
      await p.save("3ds-explore");
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
      // A finger drags the globe: the surface follows it.
      await p.drag("upper", ipod, [90, 170], [170, 150]);
      const dragged = await p.status();
      expect(`ipod: a finger on the globe turns it (${tapped.globe.facing} to ${dragged.globe.facing})`, round(dragged.globe.facing[1], tapped.globe.facing[1]) > 15);
      await p.page.waitForTimeout(1200);
      await p.save("ipod-dragged");
      report.devices.ipod = await measure(p);
      // The shell's refusal on a touch panel has its own way back: a button under a finger.
      await p.page.evaluate(`pocketAtlas.atlas.control("enter=nowhere")`);
      await p.page.waitForTimeout(700);
      expect("ipod: the refusal is shown", (await p.status()).scene === "error");
      await p.save("ipod-refused");
      await p.page.evaluate(`pocketAtlas.atlas.control("leave")`);
      await p.page.waitForTimeout(1200);
      // Visit, under a finger, enters the place.
      await p.tap("upper", ipod, 401, 146);
      const inside = await p.scene(["place", "error"], true);
      expect(`ipod: Visit enters the place (${inside.scene} "${inside.message}")`, inside.scene === "place" && inside.visit.trouble === "");
      await p.page.waitForTimeout(1500);
      await p.save("ipod-place");
      expect(`ipod: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }

    // ---- a place through the interface (PS Vita): entered from the list, its shots, its pause, its menu,
    // and back to the atlas
    {
      const p = await visit("?device=vita");
      await p.up();
      let inside = await p.status();
      for (let row = 0; row < here.length + 2; row++) {
        await p.key("KeyZ");
        inside = await p.scene(["place", "error"]);
        if (inside.place === one) break;
        await p.key("KeyX");
        await p.scene(["atlas"]);
        await p.key("ArrowDown");
        await p.page.waitForTimeout(600);
      }
      expect(`${one} is entered from the list (${inside.scene}: "${inside.place}" "${inside.message}")`, inside.scene === "place" && inside.place === one);
      await p.save("place-entering");
      inside = await p.scene(["place"], true);
      expect(`${one}: every texture is on the GPU and nothing went wrong (${JSON.stringify(inside.visit)})`, inside.visit.waiting === 0 && inside.visit.trouble === "" && inside.visit.draws > 50 && inside.visit.tour === true);
      await p.page.waitForTimeout(1000);
      await p.save("place-tour");
      // R: the next shot. START: the tour pauses and goes on. △: the menu, which holds the pad. ✕ closes it.
      await p.key("KeyE");
      const cut = await p.status();
      expect(`R cuts to the next shot (${inside.visit.shot} to ${cut.visit.shot})`, cut.visit.shot !== inside.visit.shot);
      await p.key("Space");
      const paused = await p.status();
      await p.key("Space");
      const resumed = await p.status();
      expect(`START pauses the tour and resumes it (${paused.visit.paused}, ${resumed.visit.paused})`, paused.visit.paused === true && resumed.visit.paused === false);
      await p.key("KeyV");
      await p.page.waitForTimeout(400);
      const menu = await p.status();
      await p.save("place-menu");
      await p.key("KeyX");
      await p.page.waitForTimeout(400);
      const closed = await p.status();
      expect(`△ opens the menu, which holds the pad, and ✕ closes it (${menu.held}, ${closed.held}, ${closed.scene})`, menu.held === true && closed.held === false && closed.scene === "place");
      // The left stick walks: the tour ends and the camera is the visitor's.
      await p.page.keyboard.down("KeyW");
      await p.page.waitForTimeout(900);
      await p.page.keyboard.up("KeyW");
      const walked = await p.status();
      expect(`the stick takes the camera from the tour (${walked.visit.tour}, ${closed.visit.eye} to ${walked.visit.eye})`, walked.visit.tour === false);
      await p.save("place-walked");
      await p.key("KeyX");
      const back = await p.scene(["atlas"]);
      expect(`✕ leaves the place (${back.scene}, "${back.place}")`, back.place === "" && back.visit === null);
      await p.page.waitForTimeout(800);
      await p.save("place-left");
      report.entered = { place: one, arrival: inside.visit.arrival, openMs: inside.visit.openMs, completeMs: inside.visit.completeMs };
      expect(`no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await p.page.close();
    }

    // ---- every place: a held view in the tab beside this machine's own, and what the place costs, on the PS
    // Vita's screen and on the PSP's
    report.places = {};
    for (const id of here) {
      const of: Record<string, any> = {};
      for (const device of ["vita", "psp"]) {
        const p = await visit(`?device=${device}`);
        await p.up();
        await p.page.evaluate(`pocketAtlas.atlas.control("enter=${id}")`);
        const inside = await p.scene(["place", "error"], true);
        expect(`${id} on ${device} opens (${inside.scene}: "${inside.message}" "${inside.visit?.trouble}")`, inside.scene === "place" && inside.visit.trouble === "");
        // (the tour, for what a frame costs while everything moves)
        const from = (await p.page.evaluate("({ frames: pocketAtlas.frames, at: performance.now() })")) as { frames: number; at: number };
        await p.page.waitForTimeout(seconds * 1000);
        const to = (await p.page.evaluate("({ frames: pocketAtlas.frames, at: performance.now() })")) as typeof from;
        const frameMs = (await p.page.evaluate("pocketAtlas.burst(200)")) as number;
        // The view held for a picture, once the interface shows nothing over it.
        await p.page.evaluate(`pocketAtlas.atlas.control("shot=0 part=0.5 time=25")`);
        await p.page.waitForFunction("JSON.parse(pocketAtlas.atlas.status()).quiet", undefined, { timeout: 30_000 });
        await p.page.waitForTimeout(400);
        const tab = await p.save(`${id}-${device}`);
        const held = await p.status();
        const v = held.visit;
        of[device] = { fps: +((to.frames - from.frames) / ((to.at - from.at) / 1000)).toFixed(2), frameMs: +frameMs.toFixed(3), size: v.size, draws: v.draws, mirrorDraws: v.mirrorDraws, shadowDraws: v.shadowDraws, points: v.points, particles: v.particles, triangles: v.triangles, variants: v.variants, pipelines: v.pipelines, textureBytes: v.textureBytes, geometryBytes: v.geometryBytes, targetBytes: v.targetBytes, firstFrameRead: v.headRead, read: v.read, arrival: v.arrival, completeMs: v.completeMs };
        if (device === "vita") {
          const mine = join(directory, `${id}-here.png`);
          const native = await placeShot(id, mine, ["--shape", "vita", "--shot", "0", "--part", "0.5", "--time", "25"], deployed ? join(DIST, deployed.places.packs[id].manifest) : pack(id));
          of.here = { frameMs: native.frameMs, frameMsWorst: native.frameMsWorst, firstFrameMs: native.firstFrameMs, variants: native.variants, pipelines: native.pipelines };
          of.tabAgainstHere = await compare(tab, mine);
          expect(`${id}: the tab's frame is this machine's (${JSON.stringify(of.tabAgainstHere)})`, of.tabAgainstHere.mean < 3);
        }
        expect(`${id} on ${device}: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
        await p.page.close();
      }
      report.places[id] = of;
    }

    // ---- what a place's first frame needs: the place entered on a line of 16 Mbit/s, in a browser that has
    // nothing of it yet
    report.slow = {};
    for (const id of rest.includes("--quick") ? [one] : here) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const p = await visit("?device=vita", context);
      await p.up();
      const cdp = await context.newCDPSession(p.page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: 2_000_000, uploadThroughput: 1_000_000 });
      let received = 0;
      cdp.on("Network.dataReceived", (event: { encodedDataLength: number; dataLength: number }) => (received += event.encodedDataLength || event.dataLength));
      await p.page.evaluate(`pocketAtlas.atlas.control("enter=${id}")`);
      await p.page.waitForTimeout(2500);
      const loading = await p.status();
      await p.save(`${id}-loading`);
      if (id === one) await p.page.screenshot({ path: join(directory, "loading-page.png") });
      expect(`${id}: the loading screen says how much has arrived (${loading.scene}: "${loading.message}")`, loading.scene === "loading" && /^Reading the place: \d+ of \d+ MB$/.test(loading.message));
      const first = await p.scene(["place", "error"]);
      expect(`${id} opens on a slow line (${first.scene}: "${first.message}")`, first.scene === "place");
      await p.page.waitForFunction("JSON.parse(pocketAtlas.atlas.status()).visit.arrival >= 0", undefined, { timeout: 60_000 });
      const arrived = (await p.status()).visit;
      const firstBytes = received;
      await p.save(`${id}-first-frame`);
      const whole = (await p.scene(["place"], true)).visit;
      report.slow[id] = { bytesPerSecond: 2_000_000, firstFrameMs: Math.round(arrived.arrival), firstFrameBytes: firstBytes, firstFrameRead: arrived.read, waitingAtFirstFrame: arrived.waiting, completeMs: Math.round(whole.completeMs), completeBytes: received, read: whole.read };
      expect(`${id}: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
      await context.close();
    }

    // ---- a GPU that reads no BC blocks is told so in one sentence, where a place would be
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(`{
        const features = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, "features").get;
        Object.defineProperty(GPUAdapter.prototype, "features", { get() { return new Set([...features.call(this)].filter((f) => !f.startsWith("texture-compression"))); } });
      }`);
      const p = await visit("?device=vita", context);
      await p.up();
      await p.page.evaluate(`pocketAtlas.atlas.control("enter=${one}")`);
      const refused = await p.scene(["place", "error"]);
      await p.page.waitForTimeout(600);
      await p.save("no-bc");
      await p.page.screenshot({ path: join(directory, "no-bc-page.png") });
      report.withoutBC = refused.message;
      expect(`a GPU without BC textures is told so (${refused.scene}: "${refused.message}")`, refused.scene === "error" && refused.message === "Places need a desktop browser for now.");
      await context.close();
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

    // ---- the player around the game, in a desktop window and on a phone: every device in its shell on the
    // atlas screen and inside a place, the mark that says the picture is simulated, the door to Pocket
    // Studio, the shell's own keys under a pointer or a finger. A finger gets the iPod touch first.
    report.player = {};
    const WINDOWS = [
      { name: "1440", options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }, coarse: false },
      { name: "phone", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true }, coarse: true },
    ];
    const LABELS: Record<string, string> = { vita: "PS Vita", psp: "PSP", "3ds": "Nintendo 3DS", ipod: "iPod touch" };
    expect(`the page's devices are the ones whose interface is staged (${Object.keys(LABELS)}, ${SHOWN})`, JSON.stringify(Object.keys(LABELS).sort()) === JSON.stringify([...SHOWN].sort()));
    for (const window of WINDOWS) {
      const context = await browser.newContext(window.options);
      if (window.coarse) {
        const first = await visit("", context);
        await first.up();
        expect("a finger gets the iPod touch first", (await first.page.evaluate("pocketAtlas.device()")) === "ipod");
        await first.page.close();
      }
      for (const id of Object.keys(LABELS)) {
        const p = await visit(`?device=${id}`, context);
        await p.up();
        const tag = `${window.name} ${id}`;
        const cdp = await context.newCDPSession(p.page);
        // A pointer, or a finger, down on a place of the page; `then` runs while it is held.
        const held = async (x: number, y: number, then: () => Promise<void>, to?: [number, number]) => {
          if (window.coarse) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
            if (to) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to[0], y: to[1], id: 1 }] });
            await then();
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else {
            await p.page.mouse.move(x, y);
            await p.page.mouse.down();
            if (to) await p.page.mouse.move(to[0], to[1], { steps: 6 });
            await then();
            await p.page.mouse.up();
          }
          await p.page.waitForTimeout(250);
        };
        const middle = async (selector: string) => {
          const box = (await p.page.locator(selector).first().boundingBox())!;
          return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
        };
        // The shell is whole between the bar and the dock, its screens are where its picture has them, and
        // nothing of the page lies over a screen.
        const look = async () => (await p.page.evaluate(`(async () => {
          const box = (selector) => { const el = document.querySelector(selector); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map((n) => +n.toFixed(2)); };
          const art = document.querySelector("[data-pocket-shell-art]");
          await art.decode().catch(() => {});
          const { SHELLS } = await import(new URL("shells/profiles.js", document.querySelector('link[href$="pocket3d-stage.css"]').href).href);
          const shell = SHELLS[${JSON.stringify(id)}];
          const covered = [...document.querySelectorAll("[data-pocket-screen]:not([hidden])")].map((canvas) => {
            const r = canvas.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return top === canvas ? "" : (top?.outerHTML ?? "").slice(0, 80);
          });
          return { view: [innerWidth, innerHeight], bar: box("[data-pocket-bar]"), stage: box("[data-pocket-stage=root]"), dock: box("[data-pocket-studio]"), shell: box("[data-pocket-shell]"), upper: box("[data-pocket-screen=upper]"), lower: box("[data-pocket-screen=lower]"),
            art: [art.naturalWidth, art.naturalHeight, art.currentSrc.split("/").pop()], profile: { width: shell.width, height: shell.height, screens: shell.screens }, covered,
            face: [getComputedStyle(document.querySelector("[data-pocket-game] h1")).fontFamily.split(",")[0].replaceAll('"', ""), document.fonts.check('800 22px "Gabarito"')],
            words: [document.querySelector("[data-pocket-game] h1").textContent, document.querySelector("[data-pocket-game] p").textContent],
            scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
        })()`)) as Record<string, any>;
        const whole = (seen: Record<string, any>, where: string) => {
          const { shell, stage, bar, dock, upper, lower, profile } = seen;
          expect(`${tag} ${where}: the page is one window, with no scroll (${seen.scroll} in ${seen.view})`, seen.scroll[0] <= seen.view[0] && seen.scroll[1] <= seen.view[1]);
          expect(`${tag} ${where}: the bar, the stage and the dock are inside the window (${JSON.stringify({ bar, stage, dock })} in ${seen.view})`, [bar, stage, dock].every((box: number[]) => box[0]! >= -0.5 && box[2]! <= seen.view[0] + 0.5 && box[1]! >= -0.5 && box[3]! <= seen.view[1] + 0.5));
          expect(`${tag} ${where}: the shell's picture is the device's (${seen.art})`, seen.art[0] === profile.width && seen.art[1] === profile.height);
          expect(`${tag} ${where}: the shell is whole inside the stage, under the bar and over the dock (${JSON.stringify({ shell, stage, bar, dock })})`, shell[0] >= stage[0] - 0.5 && shell[2] <= stage[2] + 0.5 && shell[1] >= bar[3] - 0.5 && shell[3] <= dock[1] + 0.5 && shell[2] - shell[0] > 100);
          const perPixel = (shell[2] - shell[0]) / profile.width;
          for (const [name, canvas] of [["upper", upper], ["lower", lower]] as const) {
            if (!canvas) continue;
            const rect = profile.screens[name] as number[];
            const want = [shell[0] + rect[0]! * perPixel, shell[1] + rect[1]! * perPixel, shell[0] + (rect[0]! + rect[2]!) * perPixel, shell[1] + (rect[1]! + rect[3]!) * perPixel];
            // (the game's canvas is fitted inside the picture's screen: within it, and within a fiftieth of its width)
            const slack = (want[2]! - want[0]!) * 0.02 + 1;
            expect(`${tag} ${where}: the ${name} screen is where the shell's picture has it (${canvas} in ${want.map((n) => n.toFixed(1))})`, canvas[0] >= want[0]! - 1 && canvas[1] >= want[1]! - 1 && canvas[2] <= want[2]! + 1 && canvas[3] <= want[3]! + 1 && canvas[0] - want[0]! < slack && want[2]! - canvas[2] < slack);
          }
          expect(`${tag} ${where}: nothing lies over a screen (${seen.covered})`, seen.covered.every((over: string) => over === ""));
        };
        const seen = await look();
        whole(seen, "atlas");
        expect(`${tag}: the game's name and its sentence, the name in the kernel's own face (${seen.words}, ${seen.face})`, seen.words[0] === "Pocket Atlas" && seen.words[1] === "The world in your pocket." && seen.face[0] === "Gabarito" && seen.face[1] === true);
        expect(`${tag}: the 3DS has its lower screen, and no other device has one (${seen.lower})`, (seen.lower !== null) === (id === "3ds"));
        await p.page.screenshot({ path: join(directory, `player-${window.name}-${id}-atlas.png`) });

        // The mark beside the device's name: a pointer that rests on it, or a finger, shows what it says.
        const mark = await middle("[data-pocket-mark]");
        if (window.coarse) await held(mark.x, mark.y, async () => {});
        else await p.page.mouse.move(mark.x, mark.y);
        await p.page.waitForTimeout(250);
        const said = (await p.page.evaluate(`(() => { const tip = document.getElementById("pocket-simulated"); const r = tip.getBoundingClientRect(); return { hidden: tip.hidden, text: tip.textContent, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; })()`)) as Record<string, any>;
        expect(`${tag}: the mark says the picture is simulated, and how this device's differs (${JSON.stringify(said)})`, said.hidden === false && said.inside && said.text.includes("Your browser draws this picture") && said.text.includes(`A real ${LABELS[id]}`) && said.text.includes("PS Vita build's") && said.text.includes("iPod touch build's") && !said.text.includes("—"));
        (report.player.notes ??= {})[id] = said.text;
        await p.page.screenshot({ path: join(directory, `player-${window.name}-${id}-simulated.png`) });
        if (window.coarse) await held(mark.x, mark.y, async () => {});
        else await p.page.mouse.move(4, seen.view[1] / 2);
        await p.page.waitForTimeout(200);
        expect(`${tag}: the mark's words leave again`, (await p.page.evaluate(`document.getElementById("pocket-simulated").hidden`)) === true);

        // The door to Pocket Studio: the game's card there, and the Studio's own front door.
        const door = (await p.page.evaluate(`({ get: document.querySelector('[data-pocket-action=get]').href, make: document.querySelector('[data-pocket-action=make]').href, words: document.querySelector('[data-pocket-pitch]').textContent, shown: document.querySelector('[data-pocket-action=get]').getBoundingClientRect().width > 40 })`)) as Record<string, any>;
        report.player.door ??= door;
        const card = deployed ? (deployed.studio ? `${deployed.studio.server}/studio/?app=${deployed.studio.app}` : "https://studio.pocket.nexus/") : "https://studio.pocket.nexus/studio/?app=local";
        expect(`${tag}: the door leads to the game in Pocket Studio (${JSON.stringify(door)}, wanted ${card})`, door.shown && door.get === card && new URL(door.make).pathname === "/" && door.words.includes("Pocket Atlas is built for PSP, PS Vita, Nintendo 3DS, iPod touch and Android."));
        if (!deployed) expect(`${tag}: the door says what the host holds (${door.words})`, door.words.includes("Pocket Studio has its packages for PSP (31 MB) and Nintendo 3DS (64 MB)."));

        // The shell's own keys: the d-pad's lower arm moves down the list and goes down while it is held; the
        // stick's cap slides and the globe spins. An iPod touch has neither: its screen is under the finger.
        const before = await p.status();
        if (id === "ipod") {
          expect(`${tag}: a touch panel's shell has no key`, (await p.page.locator("[data-pocket-control], [data-pocket-stick], [data-pocket-pad]").count()) === 0);
        } else {
          const pad = await middle("[data-pocket-pad]");
          let arm = 0;
          await held(pad.x, pad.y + pad.height * 0.32, async () => {
            await p.page.waitForTimeout(120);
            arm = await p.page.locator("[data-pocket-part][data-held]").count();
          });
          await p.page.waitForTimeout(1200);
          const moved = await p.status();
          expect(`${tag}: the shell's d-pad moves down the list, and its arm goes down while it is held (pin ${before.globe.lit} to ${moved.globe.lit}, ${arm} held)`, moved.globe.lit !== before.globe.lit && arm >= 1);
          const stick = await middle("[data-pocket-stick=left]");
          let cap = "";
          await held(stick.x, stick.y, async () => {
            await p.page.waitForTimeout(900);
            cap = (await p.page.evaluate(`document.querySelector('[data-pocket-part-kind=cap][data-held]')?.style.transform ?? ""`)) as string;
          }, [stick.x + stick.width * 0.4, stick.y]);
          const spun = await p.status();
          expect(`${tag}: the shell's stick spins the globe, and its cap slides (${moved.globe.facing[1]} to ${spun.globe.facing[1]}, "${cap}")`, round(spun.globe.facing[1], moved.globe.facing[1]) > 10 && cap !== "");
        }

        // A place inside the shell: its letterbox bars while the tour runs, the interface over it, and on the
        // 3DS its controls on the lower screen.
        await p.page.evaluate(`pocketAtlas.atlas.control("enter=${one}")`);
        const inside = await p.scene(["place", "error"], true);
        expect(`${tag}: ${one} opens inside the shell (${inside.scene}: "${inside.message}" "${inside.visit?.trouble}")`, inside.scene === "place" && inside.visit.trouble === "" && inside.visit.tour === true);
        await p.page.waitForTimeout(2500);
        whole(await look(), "place");
        await p.page.screenshot({ path: join(directory, `player-${window.name}-${id}-place.png`) });
        if (id !== "ipod") {
          // ✕ on the shell leaves the place.
          const leave = await middle("[data-pocket-control=cross]");
          await held(leave.x, leave.y, async () => p.page.waitForTimeout(120));
          expect(`${tag}: the shell's ✕ leaves the place`, (await p.scene(["atlas"])).visit === null);
        }
        if (window.name === "1440" && id === "vita") {
          // The keys as a list, and the notices.
          await p.page.locator("[data-pocket-open=controls]").click();
          await p.page.waitForTimeout(200);
          report.player.controls = await p.page.evaluate(`document.getElementById("pocket-controls").textContent`);
          await p.page.screenshot({ path: join(directory, "player-1440-vita-controls.png") });
          await p.page.locator("[data-pocket-open=about]").click();
          await p.page.waitForTimeout(200);
          report.player.about = await p.page.evaluate(`document.getElementById("pocket-about").textContent`);
          expect(`the notices name the devices as their owners' marks (${report.player.about})`, /PS Vita, PSP, Nintendo 3DS and iPod touch are trademarks of their owners\. Pocket Nexus is not affiliated with them\./.test(report.player.about));
          await p.page.screenshot({ path: join(directory, "player-1440-vita-about.png") });
        }
        expect(`${tag}: no error on the page (${p.problems.join("; ")})`, p.problems.length === 0);
        await p.page.close();
      }
      await context.close();
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
      await without.waitForFunction("document.querySelector('[data-pocket-say]')?.textContent !== ''", undefined, { timeout: 20_000 });
      report.withoutWebGPU = await without.locator("[data-pocket-say]").textContent();
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
