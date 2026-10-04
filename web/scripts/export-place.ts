/** Fresh browser scene -> sealed web export. --seconds is an explicit override, never a default. */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { describePlace, resolveAuthoring, type Sampling } from "../src/places/shared/authoring";
import { placeById } from "../src/places/registry";
import { localOutputName, sha256, sourceSnapshot, verifyResources } from "./export-source";
import { canonicalGlb } from "./canonical-glb";

export interface ExportOptions {
  place: string;
  out?: string;
  base?: string;
  geometry?: "full" | "handheld";
  seed?: number;
  sampling?: Partial<Sampling>;
}

export async function exportPlaceSource(options: ExportOptions) {
  const root = resolve(import.meta.dir, "..");
  const entry = placeById(options.place);
  if (!entry?.load) throw new Error(`No implemented place: ${options.place}`);
  const { definition } = await entry.load();
  if (!definition) throw new Error(`${entry.id} has no authoring definition; migrate its entry before reproducible export`);
  if (definition.id !== entry.id || definition.kind !== entry.kind) throw new Error("Registry/definition mismatch");
  const authoring = resolveAuthoring(definition, options.geometry ?? "full", options);
  verifyResources(root, describePlace(definition));
  const source = sourceSnapshot(root);
  const base = new URL(options.base ?? "http://127.0.0.1:5173");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:")
    throw new Error("Export requires a loopback Atlas Vite server");
  const server = await fetch(new URL("/__atlas/source", base)).then(r => {
    if (!r.ok) throw new Error("Atlas source identity endpoint unavailable");
    return r.json();
  }) as { sha256: string };
  if (server.sha256 !== source.sha256) throw new Error("Export server belongs to a different source snapshot/worktree");
  const out = resolve(options.out ?? join(root, `../.pocket-build/places/${entry.id}`));
  mkdirSync(out, { recursive: true });
  const temporary = mkdtempSync(join(out, ".export-"));
  const files = new Map<string, number>();
  const errors: string[] = [];
  const started = Date.now();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // GPU canvas rasterization can vary at glyph edges between fresh processes.
    // Keep procedural 2D textures on the CPU; WebGL environment baking still uses the recorded GPU.
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-accelerated-2d-canvas"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === base.origin) return route.continue();
      errors.push(`External resource is not locked: ${url.origin}${url.pathname}`);
      return route.abort();
    });
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.exposeFunction("__pcChunk", (name: string, b64: string) => {
      localOutputName(name);
      let fd = files.get(name);
      if (fd === undefined) {
        fd = openSync(join(temporary, name), "wx");
        files.set(name, fd);
      }
      writeSync(fd, Buffer.from(b64, "base64"));
    });
    const url = new URL("/", base);
    url.search = new URLSearchParams({ shot: "", export: "", q: "ultra", geometry: authoring.geometry,
      seed: String(authoring.seed), "sample-start": String(authoring.sampling.startSeconds),
      "sample-seconds": String(authoring.sampling.durationSeconds), "sample-fps": String(authoring.sampling.fps) }).toString();
    url.hash = `/place/${entry.id}`;
    await page.goto(url.href, { waitUntil: "load" });
    await page.waitForFunction(() => typeof (window as unknown as { pocketAtlasExport?: unknown }).pocketAtlasExport === "function", null, { timeout: 180000 });
    if (errors.length) throw new Error(errors.join("\n"));
    const report = await page.evaluate(async () => {
      type Out = { glb: ArrayBuffer; env: Uint16Array | null; files: { name: string; bytes: Uint8Array }[]; report: Record<string, unknown> };
      const w = window as unknown as { pocketAtlasExport: () => Promise<Out>; __pcChunk: (name: string, bytes: string) => Promise<void> };
      const output = await w.pocketAtlasExport();
      const send = async (name: string, bytes: Uint8Array) => {
        if (!bytes.length) throw new Error(`Empty export resource: ${name}`);
        for (let i = 0; i < bytes.length; i += 3 * 1024 * 1024) {
          const part = bytes.subarray(i, i + 3 * 1024 * 1024);
          let text = "";
          for (let j = 0; j < part.length; j += 0x8000) text += String.fromCharCode(...part.subarray(j, j + 0x8000));
          await w.__pcChunk(name, btoa(text));
        }
      };
      await send("scene.glb", new Uint8Array(output.glb));
      if (output.env) await send("env.rgba16f", new Uint8Array(output.env.buffer, output.env.byteOffset, output.env.byteLength));
      for (const file of output.files) await send(file.name, file.bytes);
      return output.report;
    });
    if (errors.length) throw new Error(errors.join("\n"));
    if (sourceSnapshot(root).sha256 !== source.sha256) throw new Error("Authoring sources changed during export; retry from a stable snapshot");
    if (!files.has("scene.glb")) throw new Error("Missing exported scene");
    for (const fd of files.values()) closeSync(fd);
    const names = [...files.keys()].sort();
    files.clear();
    writeFileSync(join(temporary, "scene.glb"), canonicalGlb(readFileSync(join(temporary, "scene.glb"))));
    const gpu = await page.evaluate(() => {
      const gl = document.querySelector("canvas")?.getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return gl && info ? { vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL) } : null;
    });
    const receipt = { schemaVersion: 1, authoring, source,
      toolchain: { bun: Bun.version, browser: browser.version(), platform: process.platform, arch: process.arch, canvas: "cpu", gpu },
      resources: names.map(path => ({ path, sha256: sha256(readFileSync(join(temporary, path))) })) };
    // The receipt is the commit marker; interrupted publication is rejected by import hash checks.
    for (const name of names) renameSync(join(temporary, name), join(out, name));
    writeFileSync(join(temporary, "export.json"), JSON.stringify(receipt, null, 2) + "\n");
    renameSync(join(temporary, "export.json"), join(out, "export.json"));
    writeFileSync(join(out, "report.json"), JSON.stringify({ ...report, wallMs: Date.now() - started }, null, 2) + "\n");
    return receipt;
  } finally {
    for (const fd of files.values()) closeSync(fd);
    try {
      if (browser?.isConnected()) {
        // Bun/Playwright can leave close() pending after Chrome disconnected.
        // Both are public completion signals; do not publish a timeout as success.
        const disconnected = new Promise<void>(resolve => browser!.once("disconnected", () => resolve()));
        await Promise.race([browser.close(), disconnected]);
      }
    }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const at = args.indexOf(`--${name}`); if (at < 0) return undefined; if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`Missing --${name} value`); return args[at + 1]; };
  const geometry = opt("geometry") ?? "full";
  if (geometry !== "full" && geometry !== "handheld") throw new Error("--geometry must be full or handheld");
  const receipt = await exportPlaceSource({ place: opt("place") ?? "tokyo-konbini", out: opt("out"), base: opt("base"), geometry,
    ...(opt("seed") !== undefined ? { seed: Number(opt("seed")) } : {}),
    sampling: { ...(opt("seconds") !== undefined ? { durationSeconds: Number(opt("seconds")) } : {}),
      ...(opt("fps") !== undefined ? { fps: Number(opt("fps")) } : {}),
      ...(opt("start") !== undefined ? { startSeconds: Number(opt("start")) } : {}) } });
  await Bun.write(Bun.stdout, JSON.stringify(receipt, null, 2) + "\n");
  // This is a one-shot CLI. Chrome is disconnected and all files are closed;
  // do not let residual Playwright driver handles keep the Bun process alive.
  process.exit(0);
}
