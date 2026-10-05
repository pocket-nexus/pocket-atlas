#!/usr/bin/env bun
// Pocket Atlas's packages for Pocket Studio: one file per device, built from
// the checked-out commit by the commands a developer runs (tools/atlas.ts,
// atlas-psp.ts, atlas-3ds.ts, atlas-ipod.ts).
//
//   bun tools/release.ts [--export] [--targets vita,psp,3ds,ipod-touch] [--out dist/release]
//                        [--vita-gxp DIR] [--no-build] [--upload]
//
// For each target it cooks every live place of that target from its export
// (.pocket-build/places/<id>/scene.glb) with this commit's compiler, builds
// the program and writes one file to --out:
//
//   vita        pocket-atlas-<version>.vpk        the atlas, the places, the interface and the console's programs inside
//   psp         pocket-atlas-<version>-psp.zip    PSP/GAME/PocketAtlas/, for the root of a Memory Stick
//   3ds         pocket-atlas-<version>-3ds.zip    3ds/pocket-atlas.3dsx and pocket-atlas/<sha256>.place, for the root of the SD card
//   ipod-touch  pocket-atlas-<version>-ipod.ipa   Payload/PocketAtlas.app
//
// and release.json beside them: the commit, the version (ui/pocket.json),
// each file's size and SHA-256, the inputs and the toolchains. A target that
// fails is reported, the others still build, and the exit status is 1.
//
// --export        Write the exports first, from this commit: each live place
//                 (`tools/place.ts export`), the globe and the previews
//                 (web/scripts/export-atlas.ts, preview-place.ts). Chrome and
//                 the GPU do the work. Without it the exports on disk are
//                 used, and a place's is refused when it was made from other
//                 web sources than the checkout holds.
// --vita-gxp DIR  The programs a console compiled: `manifest.txt` and the
//                 `<hash>.gxp` files a development run leaves in its share's
//                 `atlas/gxp` (default .pocket-build/vita-usb/share/atlas/gxp).
//                 SceShaccCg runs on the console only, so the package carries
//                 what it compiled. The set is refused when a program in it
//                 was not compiled from this commit's vita/shaders.
// --no-build      Take the packages release.json lists; their hashes are checked.
// --upload        Send each package to Pocket Studio with `pocket-studio package`,
//                 run here, where `pocket-studio register` wrote .pocket-studio.json.
//                 POCKET_STUDIO_CLI names the command when it is not on PATH.
//
// The PSP build holds PocketJS's `psp:usb` lease while it runs, as
// `tools/atlas-psp.ts build` does. No package goes to Git or to a GitHub
// release (AGENTS.md); the 3DS package is a `.3dsx`, never a CIA.

import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { sourceSnapshot } from "../web/scripts/export-source";
import { PLACES } from "../web/src/places/registry";

const ROOT = resolve(import.meta.dir, "..");
const POCKETJS = join(ROOT, "vendor/pocketjs");
const WORK = join(ROOT, ".pocket-build/release");
const NAME = "pocket-atlas";
const TITLE = "Pocket Atlas";

const argv = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const at = argv.indexOf(key);
  return at < 0 ? fallback : (argv[at + 1] ?? fallback);
};
const OUT = resolve(option("--out", join(ROOT, "dist/release")));

/** A package as release.json lists it. */
interface Package {
  target: Target;
  filename: string;
  bytes: number;
  sha256: string;
}

/** Pocket Studio's ids for the devices this repository builds for. It also takes `android`; nothing here builds one. */
const TARGETS = ["vita", "psp", "3ds", "ipod-touch"] as const;
type Target = (typeof TARGETS)[number];

interface Build {
  /** The target's name in the registry's `targets`. */
  device: string;
  filename: (version: string) => string;
  /** Where the cook leaves a place's pack. */
  pack: (id: string) => string;
  cook: (log: string, places: string[]) => Promise<void>;
  build: (log: string, output: string) => Promise<void>;
}

const BUILDS: Record<Target, Build> = {
  vita: {
    device: "vita",
    filename: (v) => `${NAME}-${v}.vpk`,
    pack: (id) => join(ROOT, ".pocket-build/places", id, `${id}.place`),
    cook: async (log, places) => {
      for (const id of places) await run(log, ["bun", "tools/atlas.ts", "cook", "--place", id]);
      await run(log, ["bun", "tools/atlas.ts", "cook-atlas"]);
    },
    build: vita,
  },
  psp: {
    device: "psp",
    filename: (v) => `${NAME}-${v}-psp.zip`,
    pack: (id) => join(ROOT, ".pocket-build/places", id, `${id}.psp.place`),
    cook: async (log, places) => {
      for (const id of places) await run(log, ["bun", "tools/atlas-psp.ts", "cook", "--place", id]);
    },
    build: psp,
  },
  "3ds": {
    device: "3ds",
    filename: (v) => `${NAME}-${v}-3ds.zip`,
    pack: (id) => join(ROOT, ".pocket-build/3ds/places", `${id}.place`),
    cook: (log) => run(log, ["bun", "tools/atlas-3ds.ts", "cook"]),
    build: n3ds,
  },
  "ipod-touch": {
    device: "ipod",
    filename: (v) => `${NAME}-${v}-ipod.ipa`,
    pack: (id) => join(ROOT, ".pocket-build/ipod/assets", `${id}.place`),
    cook: (log) => run(log, ["bun", "tools/atlas-ipod.ts", "cook"]),
    build: ipod,
  },
};

const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const fileSha256 = (path: string) => sha256(readFileSync(path));

/** The first line a command prints, or null when it cannot run. */
function line(command: string[], cwd = ROOT): string | null {
  try {
    const done = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
    return done.exitCode === 0 ? (done.stdout.toString().trim().split("\n")[0] ?? "") : null;
  } catch {
    return null;
  }
}

/** Runs a build command with its output in `log`; a failure carries the log's last lines. */
async function run(log: string, command: string[]): Promise<void> {
  const fd = openSync(log, "a");
  writeSync(fd, `\n$ ${command.join(" ")}\n`);
  const code = await Bun.spawn(command, { cwd: ROOT, stdin: "ignore", stdout: fd, stderr: fd }).exited;
  closeSync(fd);
  if (code !== 0) throw new Error(`\`${command.join(" ")}\` exited ${code}; ${log} ends:\n${readFileSync(log, "utf8").trimEnd().split("\n").slice(-20).join("\n")}`);
}

// ---------------------------------------------------------------- archives

/** Every file and directory under `directory`, named from `prefix`. A directory's name ends in a slash and it has no path. */
function tree(directory: string, prefix: string): { name: string; path?: string }[] {
  return [
    { name: `${prefix}/` },
    ...readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? tree(join(directory, entry.name), `${prefix}/${entry.name}`) : [{ name: `${prefix}/${entry.name}`, path: join(directory, entry.name) }],
    ),
  ];
}

/**
 * Writes a zip whose bytes follow from its entries alone: entries in the
 * order of their names, every date 1980-01-01 00:00, modes 0644, or 0755 for
 * a directory and for a file its owner may execute, no extra fields. An entry
 * is deflated at level 6 unless that makes it longer.
 */
function writeZip(output: string, entries: { name: string; path?: string }[]): void {
  const fd = openSync(output, "w");
  const directory: Buffer[] = [];
  let at = 0;
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const data = entry.path === undefined ? Buffer.alloc(0) : readFileSync(entry.path);
    const deflated = data.length ? deflateRawSync(data, { level: 6 }) : data;
    const body = deflated.length < data.length ? deflated : data;
    const method = body === data ? 0 : 8;
    const mode = entry.path === undefined ? 0o040755 : statSync(entry.path).mode & 0o100 ? 0o100755 : 0o100644;
    const name = Buffer.from(entry.name);
    const crc = Bun.hash.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made on Unix, so the upper half of the external attributes is a file mode.
    central.writeUInt16LE((3 << 8) | 20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(((mode << 16) | (entry.path === undefined ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(at, 42);
    directory.push(central, name);
    for (const part of [local, name, body]) writeSync(fd, part);
    at += local.length + name.length + body.length;
  }
  const list = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(list.length, 12);
  end.writeUInt32LE(at, 16);
  writeSync(fd, list);
  writeSync(fd, end);
  closeSync(fd);
}

// ---------------------------------------------------------------- the Vita's programs

/** `vita/shaders` as the console and `tools/atlas.ts` name it: one hash over each file's name and bytes in the order of the names. */
function shaderSources(): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const name of readdirSync(join(ROOT, "vita/shaders")).sort()) hash.update(name).update(readFileSync(join(ROOT, "vita/shaders", name)));
  return hash.digest("hex");
}

/**
 * A program's name as the console computes it (`build` in vita/src/shaders.rs):
 * FNV-1a over the source with its `#include` lines expanded, then a zero byte
 * and each definition in the label's order, then "v" or "f". `label` is a
 * manifest row's second word, `file.cg` or `file.cg[A,B=1]`.
 */
function programHash(label: string): string {
  const shaders = join(ROOT, "vita/shaders");
  const expand = (name: string, depth: number): string => {
    if (depth > 4 || !existsSync(join(shaders, name))) throw new Error(`no source ${name}`);
    const lines = readFileSync(join(shaders, name), "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines
      .map((text, i) => {
        const row = text.replace(/\r$/, "");
        if (!row.trimStart().startsWith("#include")) return `${row}\n`;
        const included = row.trimStart().slice("#include".length).trim().replace(/^"+|"+$/g, "");
        return `#line 1 "${included}"\n${expand(included, depth + 1)}\n#line ${i + 2} "${name}"\n`;
      })
      .join("");
  };
  const fold = (hash: bigint, bytes: Uint8Array) => {
    for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & ((1n << 64n) - 1n);
    return hash;
  };
  const text = new TextEncoder();
  const [, file, defines] = /^([^[\]]+)(?:\[(.*)\])?$/.exec(label) ?? [];
  if (!file) throw new Error(`no source named by "${label}"`);
  let hash = fold(0xcbf29ce484222325n, text.encode(expand(file, 0)));
  for (const define of defines ? defines.split(",") : []) hash = fold(fold(hash, Uint8Array.of(0)), text.encode(define));
  return fold(hash, text.encode(file.endsWith("_v.cg") ? "v" : "f")).toString(16).padStart(16, "0");
}

/**
 * Checks the programs a console compiled against this commit's sources. Each
 * row of the console's `manifest.txt` is a program's name and its label; the
 * name is computed again from `vita/shaders` here. Refused: a row whose name
 * differs (its source changed since the console compiled it, or left the
 * repository), a missing `.gxp`. Not checked: that the manifest lists every
 * program this commit's renderer asks for. A place asks for its programs when
 * it loads (`warm` in vita/src/frame.rs), so the set covers the places that
 * were entered on the console, under the settings they ran with.
 */
function vitaPrograms(directory: string): string[] {
  const manifest = join(directory, "manifest.txt");
  if (!existsSync(manifest)) {
    throw new Error(
      `no programs for the Vita: ${manifest} is missing. A console compiles them: run the development build there (\`bun tools/atlas.ts native\`, README "Vita") and enter each place, then pass its share's atlas/gxp as --vita-gxp`,
    );
  }
  const rows = readFileSync(manifest, "utf8").split("\n").filter(Boolean);
  const stale: string[] = [];
  for (const row of rows) {
    const [, name, label] = /^([0-9a-f]{16}) (\S+)$/.exec(row) ?? [];
    if (!name || !label) throw new Error(`${manifest}: "${row}" is not a program's name and label`);
    if (!existsSync(join(directory, `${name}.gxp`))) throw new Error(`${join(directory, `${name}.gxp`)} is missing: the manifest lists a program the directory does not hold`);
    let expected: string;
    try {
      expected = programHash(label);
    } catch (error) {
      expected = (error as Error).message;
    }
    if (expected !== name) stale.push(`${label} (${name}: ${expected})`);
  }
  if (stale.length) {
    throw new Error(
      `the Vita's programs in ${directory} are stale: ${stale.length} of ${rows.length} were not compiled from this commit's vita/shaders (${shaderSources().slice(0, 12)}), the first: ${stale.slice(0, 3).join("; ")}. Run this commit's development build on a console and pass its programs`,
    );
  }
  return rows;
}

// ---------------------------------------------------------------- targets

let programs: { count: number; manifestSha256: string; sourcesSha256: string } | undefined;

/** The standalone VPK (`tools/atlas.ts vpk`), from a share that holds only the checked programs. */
async function vita(log: string, output: string): Promise<void> {
  const source = resolve(option("--vita-gxp", join(ROOT, ".pocket-build/vita-usb/share/atlas/gxp")));
  const rows = vitaPrograms(source);
  const share = join(WORK, "vita-share");
  rmSync(share, { recursive: true, force: true });
  mkdirSync(join(share, "atlas/gxp"), { recursive: true });
  writeFileSync(join(share, "atlas/gxp/manifest.txt"), rows.join("\n") + "\n");
  for (const row of rows) cpSync(join(source, `${row.slice(0, 16)}.gxp`), join(share, `atlas/gxp/${row.slice(0, 16)}.gxp`));
  programs = { count: rows.length, manifestSha256: sha256(rows.join("\n") + "\n"), sourcesSha256: shaderSources() };
  await run(log, ["bun", "tools/atlas.ts", "vpk", "--share", share]);
  cpSync(join(ROOT, "dist/vita/pocket-atlas-PKAT00001.vpk"), output);
}

/** The Memory Stick folder (`tools/atlas-psp.ts package`, staged through a share of its own), zipped from the card's root. */
async function psp(log: string, output: string): Promise<void> {
  const share = join(WORK, "psp-share");
  rmSync(share, { recursive: true, force: true });
  await run(log, ["bun", "tools/atlas-psp.ts", "package", "--share", share]);
  writeZip(output, [{ name: "PSP/" }, { name: "PSP/GAME/" }, ...tree(join(ROOT, "dist/PSP/GAME/PocketAtlas"), "PSP/GAME/PocketAtlas")]);
}

/**
 * The `.3dsx` and the places beside it as the SD card holds them
 * (`tools/atlas-3ds.ts package` stages both, and refuses a `.3dsx` over the
 * 32 MiB the wire installs).
 */
async function n3ds(log: string, output: string): Promise<void> {
  await run(log, ["bun", "tools/atlas-3ds.ts", "package"]);
  const stage = join(ROOT, ".pocket-build/3ds/release");
  writeZip(output, [...tree(join(stage, "3ds"), "3ds"), ...tree(join(stage, "pocket-atlas"), "pocket-atlas")]);
}

/** The app bundle (`tools/atlas-ipod.ts package`), zipped as an `.ipa`. */
async function ipod(log: string, output: string): Promise<void> {
  await run(log, ["bun", "tools/atlas-ipod.ts", "package"]);
  writeZip(output, tree(join(ROOT, ".pocket-build/ipod/Payload"), "Payload"));
}

/** What Pocket Studio accepts as a package: its name, its first bytes and its size. */
function accept(path: string): void {
  const name = basename(path);
  const bytes = statSync(path).size;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error(`${name}: a package's name is 1 to 80 letters, digits, dots, underscores and hyphens`);
  if (bytes > 512 * 1024 * 1024) throw new Error(`${name} is ${bytes} bytes: a package is at most 512 MiB`);
  const head = Buffer.alloc(4);
  const fd = openSync(path, "r");
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  if (head.toString("latin1") !== "PK\x03\x04") throw new Error(`${name} does not start with the bytes of a zip`);
}

// ---------------------------------------------------------------- what the build came from

/** The live places a device carries. */
const placesOf = (device: string) => PLACES.filter((p) => p.status === "live" && p.targets?.includes(device as never)).map((p) => p.id);

/**
 * The exports the packs are cooked from: the globe, and each live place's
 * `scene.glb` with the files its `export.json` lists and its preview. A
 * browser writes them (README "Releases"); this tool reads them. A place's
 * export is refused when its receipt names other sources than `web/` holds
 * now (`sourceSnapshot`, the identity `tools/place.ts export` seals), when its
 * geometry is not the one the release takes, or when a file is not the one
 * the receipt lists. The globe's export has no receipt;
 * its hash is recorded.
 */
function exports() {
  const globe = join(ROOT, ".pocket-build/atlas/globe");
  if (!existsSync(join(globe, "globe.json"))) throw new Error(`no globe export at ${globe}: run this tool with --export (README "Releases")`);
  const hash = new Bun.CryptoHasher("sha256");
  // `globe.json` also says how long the export took: left out, two exports of one commit hash alike.
  const described = JSON.stringify({ ...JSON.parse(readFileSync(join(globe, "globe.json"), "utf8")), wallMs: undefined });
  for (const name of readdirSync(globe).sort()) hash.update(name).update(name === "globe.json" ? described : readFileSync(join(globe, name)));
  const sources = sourceSnapshot(join(ROOT, "web")).sha256;
  const browsers = new Set<string>();
  const places = PLACES.filter((p) => p.status === "live").map((p) => {
    const directory = join(ROOT, ".pocket-build/places", p.id);
    const again = `run \`bun tools/place.ts export --place ${p.id} --geometry ${geometryOf(p.id)}\`, or this tool with --export`;
    if (!existsSync(join(directory, "export.json"))) throw new Error(`no export of ${p.id} at ${directory}: ${again} first (README "Releases")`);
    const receipt = JSON.parse(readFileSync(join(directory, "export.json"), "utf8"));
    if (receipt.source.sha256 !== sources) throw new Error(`the export of ${p.id} is stale: it was made from web sources ${receipt.source.sha256.slice(0, 12)}, and web/ is now ${sources.slice(0, 12)}; ${again}`);
    if (receipt.authoring.geometry !== geometryOf(p.id)) throw new Error(`the export of ${p.id} has ${receipt.authoring.geometry} geometry and the release takes ${geometryOf(p.id)}; ${again}`);
    for (const resource of receipt.resources as { path: string; sha256: string }[]) {
      if (!existsSync(join(directory, resource.path)) || fileSha256(join(directory, resource.path)) !== resource.sha256) throw new Error(`${join(directory, resource.path)} is not the file its export.json lists; ${again}`);
    }
    // The preview is a capture of the running scene: two exports give two pictures, and the interface's card follows.
    const preview = join(directory, "preview.png");
    if (!existsSync(preview)) console.warn(`release: ${p.id} has no preview.png: its card in the interface is a wash of its accent`);
    browsers.add(`Chrome ${receipt.toolchain.browser}, ${receipt.toolchain.gpu?.renderer ?? "no GPU recorded"}`);
    return {
      id: p.id,
      sceneSha256: fileSha256(join(directory, "scene.glb")),
      previewSha256: existsSync(preview) ? fileSha256(preview) : null,
      geometry: receipt.authoring.geometry as string,
      sampling: receipt.authoring.sampling as unknown,
    };
  });
  return { webSourcesSha256: sources, exportedWith: [...browsers], globeSha256: hash.digest("hex"), places };
}

/**
 * What a place's export takes beyond its authoring definition
 * (`tools/place.ts export`), so that its packs fit every device the registry
 * publishes it for. One export feeds all of a place's targets.
 */
const EXPORT_OPTIONS: Record<string, { geometry: "full" | "handheld" }> = {
  // Its full geometry (874 000 triangles) cooks to 51.7 MB of geometry for the 3DS, whose reader takes 24 MiB (docs/AUTHORING.md).
  "sangubashi-crossing": { geometry: "handheld" },
};
const geometryOf = (id: string) => EXPORT_OPTIONS[id]?.geometry ?? "full";

/**
 * Writes the exports from this commit. Each live place goes through
 * `tools/place.ts export`, which starts the reference's server itself and
 * seals what the browser wrote. The globe and the previews are drawn by the
 * reference too, served here on a port the system picks.
 */
async function exportAll(log: string): Promise<void> {
  rmSync(log, { force: true });
  for (const place of PLACES.filter((p) => p.status === "live")) await run(log, ["bun", "tools/place.ts", "export", "--place", place.id, "--geometry", geometryOf(place.id)]);
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: join(ROOT, "web"), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`${base}/__atlas/source`).then((r) => r.ok, () => false)) break;
      if (i >= 150) throw new Error(`the reference's server did not start on ${base}: run \`bun install\` in web/`);
      await Bun.sleep(100);
    }
    await run(log, ["bun", "web/scripts/export-atlas.ts", "--base", base]);
    await run(log, ["bun", "web/scripts/preview-place.ts", "--base", base]);
  } finally {
    server.kill();
    await server.exited;
  }
}

/** The toolchain a tool names in `rustup run <toolchain> cargo`. */
function named(tool: string): string | null {
  return / run (\S+) cargo /.exec(readFileSync(join(ROOT, tool), "utf8"))?.[1] ?? null;
}

function toolchains() {
  const rustc = (toolchain: string | null) => (toolchain ? `${toolchain}: ${line(["rustup", "run", toolchain, "rustc", "-V"]) ?? "not installed"}` : null);
  const pinned = (file: string) => JSON.parse(readFileSync(join(POCKETJS, "tools/cli", file), "utf8"));
  const vitasdk = process.env.VITASDK || `${process.env.HOME}/vitasdk`;
  const container = /"(devkitpro\/devkitarm@sha256:[0-9a-f]{64})"/.exec(readFileSync(join(POCKETJS, "tools/3ds-toolchain.ts"), "utf8"))?.[1] ?? null;
  return {
    pocketjs: line(["git", "-C", POCKETJS, "rev-parse", "HEAD"]),
    bun: Bun.version,
    rustc: {
      cook: line(["rustc", "-V"]),
      vita: rustc(named("tools/atlas.ts")),
      psp: rustc(pinned("psp-toolchain.json").rust.toolchain),
      // The 3DS and iPod touch programs are C; their Rust is PocketJS's UI core.
      "3ds": line(["rustc", "-V"], join(POCKETJS, "hosts/3ds/core")),
      "ipod-touch": rustc(pinned("iphone4s-toolchain.json").compiler.rustToolchain),
    },
    vitasdk: {
      gcc: line([`${vitasdk}/bin/arm-vita-eabi-gcc`, "--version"]),
      versionInfoSha256: existsSync(`${vitasdk}/version_info.txt`) ? fileSha256(`${vitasdk}/version_info.txt`) : null,
      cargoVita: line(["cargo", "vita", "--version"]),
    },
    pspSdk: pinned("psp-toolchain.json").sdk.sha256 as string,
    devkitarm: container,
    clang: line(["xcrun", "clang", "--version"]),
  };
}

// ---------------------------------------------------------------- Pocket Studio

/** Sends the packages with the Studio's own CLI, from this directory's project link. */
async function upload(packages: Package[], version: string): Promise<boolean> {
  const link = join(ROOT, ".pocket-studio.json");
  if (!existsSync(link)) {
    console.error(
      `release: ${link} is missing, so this checkout names no Pocket Studio project. Once, in ${ROOT}:\n` +
        `  pocket-studio link <CODE>                       # the link code from the room, when this computer is not linked to an account\n` +
        `  pocket-studio register --title "${TITLE}"   # writes .pocket-studio.json, which Git ignores\n` +
        `then: bun tools/release.ts --no-build --upload`,
    );
    return false;
  }
  const project = JSON.parse(readFileSync(link, "utf8"));
  if (project.kind !== "site") throw new Error(`${link} links a device session, not a registered game: run \`pocket-studio register --title "${TITLE}"\` in a directory without one`);
  const cli = process.env.POCKET_STUDIO_CLI?.trim().split(/\s+/) ?? (Bun.which("pocket-studio") ? ["pocket-studio"] : null);
  if (!cli) throw new Error("no pocket-studio on PATH: install it from the Studio, or set POCKET_STUDIO_CLI to its command");
  console.log(`release: uploading ${packages.length} package(s) to ${project.server} (${project.app})`);
  for (const pkg of packages) {
    const command = [...cli, "package", join(OUT, pkg.filename), "--target", pkg.target, "--version", version];
    console.log(`$ ${command.join(" ")}`);
    const code = await Bun.spawn(command, { cwd: ROOT, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited;
    if (code !== 0) throw new Error(`pocket-studio package exited ${code} for ${pkg.filename}`);
  }
  return true;
}

// ---------------------------------------------------------------- main

const asked = option("--targets", TARGETS.join(",")).split(",").filter(Boolean);
const unknown = asked.filter((t) => !(TARGETS as readonly string[]).includes(t));
if (unknown.length || argv.includes("--help")) {
  if (unknown.length) console.error(`release: no build for ${unknown.join(", ")}: the targets are ${TARGETS.join(", ")}`);
  console.log("usage: bun tools/release.ts [--export] [--targets vita,psp,3ds,ipod-touch] [--out dist/release] [--vita-gxp DIR] [--no-build] [--upload]");
  process.exit(unknown.length ? 1 : 0);
}
const targets = TARGETS.filter((t) => asked.includes(t));
const version = JSON.parse(readFileSync(join(ROOT, "ui/pocket.json"), "utf8")).version as string;
const commit = line(["git", "rev-parse", "HEAD"]);
const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ROOT }).stdout.toString().trim() !== "";
const record = join(OUT, "release.json");
if (argv.includes("--upload") && dirty) throw new Error("the checkout has uncommitted changes: a package names the commit it was built from, so commit before --upload");
let packages: Package[] = [];
const failed: { target: Target; error: string }[] = [];

if (argv.includes("--no-build")) {
  if (!existsSync(record)) throw new Error(`${record} is missing: run without --no-build first`);
  const built = JSON.parse(readFileSync(record, "utf8"));
  if (built.commit !== commit) throw new Error(`${record} was built from ${built.commit}; the checkout is at ${commit}`);
  packages = (built.packages as Package[]).filter((p) => targets.includes(p.target));
  for (const pkg of packages) {
    if (fileSha256(join(OUT, pkg.filename)) !== pkg.sha256) throw new Error(`${pkg.filename} is not the file release.json lists`);
    console.log(`release: ${pkg.target.padEnd(10)} ${pkg.filename}  ${pkg.bytes} bytes  sha256 ${pkg.sha256}`);
  }
} else {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(WORK, "logs"), { recursive: true });
  console.log(`release: ${TITLE} ${version} at ${commit}${dirty ? " with uncommitted changes" : ""}`);
  if (argv.includes("--export")) {
    console.log(`release: exporting the places, the globe and the previews (log: ${join(WORK, "logs/export.log")})`);
    await exportAll(join(WORK, "logs/export.log"));
  }
  const sources = exports();
  const packs: Partial<Record<Target, Record<string, { bytes: number; sha256: string }>>> = {};
  const seconds: Partial<Record<Target, number>> = {};
  // One at a time: each device's interface is compiled into the same generated files under ui/.
  for (const target of targets) {
    const { device, filename, pack, cook, build } = BUILDS[target];
    const log = join(WORK, "logs", `${target}.log`);
    const output = join(OUT, filename(version));
    const places = placesOf(device);
    const start = performance.now();
    rmSync(log, { force: true });
    rmSync(output, { force: true });
    try {
      console.log(`release: ${target}: cooking ${places.length} places, building (log: ${log})`);
      await cook(log, places);
      packs[target] = Object.fromEntries(places.map((id) => [id, { bytes: statSync(pack(id)).size, sha256: fileSha256(pack(id)) }]));
      await build(log, output);
      accept(output);
      packages.push({ target, filename: filename(version), bytes: statSync(output).size, sha256: fileSha256(output) });
    } catch (error) {
      rmSync(output, { force: true });
      failed.push({ target, error: error instanceof Error ? error.message : String(error) });
      console.error(`release: ${target} failed: ${failed.at(-1)!.error}`);
    }
    seconds[target] = Math.round((performance.now() - start) / 100) / 10;
  }
  writeFileSync(
    record,
    JSON.stringify(
      {
        schema: 1,
        name: NAME,
        title: TITLE,
        version,
        commit,
        dirty,
        packages,
        failed: failed.map(({ target, error }) => ({ target, error: error.split("\n")[0] })),
        inputs: { ...sources, packs, vitaPrograms: programs ?? null },
        toolchains: toolchains(),
      },
      null,
      2,
    ) + "\n",
  );
  for (const pkg of packages) console.log(`release: ${pkg.target.padEnd(10)} ${pkg.filename}  ${pkg.bytes} bytes  sha256 ${pkg.sha256}  ${seconds[pkg.target]} s`);
  for (const { target } of failed) console.log(`release: ${target.padEnd(10)} not built  ${seconds[target]} s`);
  console.log(`release: ${record}`);
}

if (argv.includes("--upload")) {
  if (failed.length) throw new Error(`not uploading: ${failed.map((f) => f.target).join(", ")} did not build`);
  if (!(await upload(packages, version))) process.exit(1);
}
process.exit(failed.length ? 1 : 0);
