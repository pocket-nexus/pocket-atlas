// tools/listing.ts: Pocket Atlas's listing on Pocket Studio.
//
//   bun tools/listing.ts                  film every clip and still → dist/listing/
//   bun tools/listing.ts --only NAME      one file of it (konbini.mp4, suga.jpg, card.jpg, …)
//   bun tools/listing.ts --upload         then `pocket-studio listing dist/listing`
//
// A listing is what a game's page on Pocket Studio shows: one sentence, a few
// paragraphs, clips and stills, and the picture a link preview carries. The
// words are `listing/listing.json`, in Git. The pictures are filmed here from
// the game: the renderer of the browser tab (`wgpu/`, the PS Vita's passes
// from the PS Vita's packs) on this machine's GPU, one frame for each line of
// a list (`wgpu/src/bin/film.rs`), encoded by ffmpeg. A frame is a function of
// its line, so a run gives the pictures the run before it gave. No picture
// goes to Git: `dist/` is ignored.
//
// A clip is a row of cuts. A cut is one of the place's authored shots (the
// camera moves the tour makes), from one part of its length to another, with
// the place's loop running from a second of its own; the picture dips to black
// between two cuts and at the clip's two ends, as the tour's own cuts do, so
// the clip loops through a dip. A still is one frame of a shot.
//
// It needs the packs under `.pocket-build/places` (`bun tools/atlas.ts
// export`), the globe's export under `.pocket-build/atlas/globe`, ffmpeg and
// ffprobe. `--upload` runs from the repository's root, where `pocket-studio
// register` wrote `.pocket-studio.json`; POCKET_STUDIO_CLI names the command
// when it is not on PATH.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLACES } from "../web/src/places/registry";
import { globeSurface } from "./atlas-globe";

const ROOT = resolve(import.meta.dir, "..");
const CRATE = join(ROOT, "wgpu");
const WORK = join(ROOT, ".pocket-build/listing");
const OUT = join(ROOT, "dist/listing");
const FILM = join(CRATE, "target/release/atlas-film");
const SHOT = join(CRATE, "target/release/atlas-shot");
const pack = (place: string) => join(ROOT, ".pocket-build/places", place, `${place}.place`);

/** The PS Vita's screen, which the browser tab draws at, and the frames a second of a place there. */
const WIDTH = 960, HEIGHT = 544, RATE = 30;
/** Frames a dip to black takes on each side of a cut. */
const DIP = 10;
const MIB = 1 << 20;
/** What Pocket Studio takes (the listing contract): a clip, a picture, the share picture, the whole directory. */
const LIMIT = { video: 12 * MIB, image: 2 * MIB, card: 1 * MIB, total: 96 * MIB };

/** One of a place's authored shots between two parts of its length, with the loop from `time` seconds. */
interface Cut {
  shot: number;
  part: [number, number];
  time: number;
  seconds: number;
}
interface Clip {
  place: string;
  cuts: Cut[];
  /** The second of the clip its poster shows. */
  poster: number;
}
/** One frame of a place: a shot at a part of its length and a second of the loop. */
interface Still {
  place: string;
  shot: number;
  part: number;
  time: number;
}

// The loops: the Konbini's is 20 s, with a taxi along the street from 11 to 13 s and people walking close
// past the corner from 11 to 16 s and up the side street from 12 to 15 s. Sangubashi's is 64 s: the lamps start at 3 s, the arms come down from
// 6 to 10 s, the train's nose is at the crossing at 18 s, its last car has passed by 33 s and the arms rise
// from 34 to 39 s (`web/src/places/sangubashi-crossing/rail.ts`). Kamakura's is 120 s, with the train on the
// crossing from 23 to 30 s. Griffith's is 120 s.
const CLIPS: Record<string, Clip> = {
  "konbini.mp4": {
    place: "tokyo-konbini",
    cuts: [
      { shot: 0, part: [0.08, 0.72], time: 0, seconds: 8 }, // Konbini: the corner, from across the street
      { shot: 1, part: [0.1, 0.8], time: 13, seconds: 7 }, // Puddles: the front, from the wet road
      { shot: 3, part: [0.1, 0.7], time: 3.5, seconds: 7 }, // Crossing: the side street, with Tokyo Tower at its end
    ],
    poster: 3,
  },
  "sangubashi.mp4": {
    place: "sangubashi-crossing",
    cuts: [
      { shot: 0, part: [0, 0.6], time: 1.5, seconds: 10 }, // Crossing: the lamps, the arms come down
      { shot: 2, part: [0.3, 0.63], time: 15.8, seconds: 4 }, // Tracks: the train arrives
      { shot: 4, part: [0.3, 0.68], time: 20.5, seconds: 4.5 }, // Lane: the train, from down the lane
      { shot: 0, part: [0.6, 1], time: 29.5, seconds: 11 }, // Crossing: the last cars, the arms rise
    ],
    poster: 9.3,
  },
  "kamakura.mp4": {
    place: "kamakura-koko-mae-crossing",
    cuts: [
      { shot: 3, part: [0.2, 0.75], time: 19.8, seconds: 5.5 }, // along Route 134: the train comes
      { shot: 0, part: [0.2, 0.85], time: 25.3, seconds: 7.5 }, // the slope road: the train on the crossing, the sea
    ],
    poster: 7.5,
  },
  "griffith.mp4": {
    place: "griffith-observatory",
    cuts: [
      { shot: 3, part: [0.15, 0.7], time: 20, seconds: 6.5 }, // the domes, with downtown behind them
      { shot: 1, part: [0.2, 0.7], time: 26.5, seconds: 6 }, // the terrace, over the basin
    ],
    poster: 2.5,
  },
};

const STILLS: Record<string, Still> = {
  "suga.jpg": { place: "suga-shrine-stairs", shot: 1, part: 0.5, time: 0 },
  "kaikan.jpg": { place: "akihabara-radio-kaikan", shot: 1, part: 0.5, time: 6 },
  "lombard.jpg": { place: "sf-lombard-street", shot: 0, part: 0.5, time: 5 },
};

/** The share picture: the Konbini's corner, at the size a link preview shows. */
const CARD = { file: "card.jpg", place: "tokyo-konbini", shot: 0, part: 0.3, time: 2.5, width: 1200, height: 630 };

/** The atlas screen's globe turned to Japan, with a pin on each place and the Konbini's lit. */
const GLOBE = { file: "globe.jpg", face: [30, 139.7], at: [240, 136, 118] };

// ---------------------------------------------------------------- the pictures

async function run(command: string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  const child = Bun.spawn(command, { cwd: options.cwd ?? ROOT, stdin: "ignore", stdout: "pipe", stderr: options.quiet ? "pipe" : "inherit" });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}${options.quiet ? `: ${await new Response(child.stderr as ReadableStream).text()}` : ""}`);
  return text;
}

/** The frames of `lines` (the film binary's words) at a size, handed to ffmpeg with `encode` after its input. */
async function film(place: string, name: string, lines: string[], size: [number, number], encode: string[]): Promise<void> {
  if (!existsSync(pack(place))) throw new Error(`no pack for ${place} under .pocket-build/places: bun tools/atlas.ts export ${place}`);
  const list = join(WORK, `${name}.txt`);
  writeFileSync(list, lines.join("\n") + "\n");
  const camera = Bun.spawn([FILM, "--place", pack(place), "--frames", list, "--size", size.join("x"), "--rate", String(RATE)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const coder = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", size.join("x"), "-r", String(RATE), "-i", "-", ...encode], { stdin: camera.stdout, stdout: "inherit", stderr: "inherit" });
  const [said, filmed, coded] = await Promise.all([new Response(camera.stderr).text(), camera.exited, coder.exited]);
  if (filmed !== 0) throw new Error(`atlas-film exited ${filmed} for ${name}: ${said.trim()}`);
  if (coded !== 0) throw new Error(`ffmpeg exited ${coded} for ${name}`);
  const trouble = /"trouble":"([^"]+)"/.exec(said)?.[1];
  if (trouble) throw new Error(`${name}: the renderer reported "${trouble}"`);
}

/** A JPEG of one frame. `-q:v 2` is ffmpeg's second finest quantiser; the chroma is not halved. */
const JPEG = ["-frames:v", "1", "-vf", "scale=in_range=pc:out_range=pc:out_color_matrix=bt601,format=yuvj444p", "-q:v", "2", "-map_metadata", "-1", "-fflags", "+bitexact"];

/** A clip's frames as lines, in order. */
function lines(clip: Clip): string[] {
  const out: string[] = [];
  for (const cut of clip.cuts) {
    const count = Math.round(cut.seconds * RATE);
    for (let i = 0; i < count; i++) {
      const along = count > 1 ? i / (count - 1) : 0;
      const dip = Math.max(0, 1 - (i + 1) / (DIP + 1), 1 - (count - i) / (DIP + 1));
      out.push(`time=${(cut.time + i / RATE).toFixed(4)} shot=${cut.shot} part=${(cut.part[0] + (cut.part[1] - cut.part[0]) * along).toFixed(5)} dip=${dip.toFixed(4)}`);
    }
  }
  return out;
}

async function clip(file: string, take: Clip): Promise<void> {
  const frames = lines(take), seconds = frames.length / RATE;
  // The rate is held under what keeps the file inside the Studio's limit, with a twentieth to spare.
  const most = Math.floor((LIMIT.video * 8 * 0.95) / seconds / 1000);
  await film(take.place, file, frames, [WIDTH, HEIGHT], [
    "-vf", "scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p",
    "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "20", "-maxrate", `${most}k`, "-bufsize", `${most * 2}k`, "-g", String(RATE * 2),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-an", "-movflags", "+faststart", "-map_metadata", "-1", "-fflags", "+bitexact", join(OUT, file),
  ]);
  // The poster is that frame drawn again, not a frame taken back out of the encoded clip.
  const at = Math.min(frames.length - 1, Math.round(take.poster * RATE));
  await film(take.place, file.replace(/\.mp4$/, ".poster"), [frames[at].replace(/ dip=\S+/, "")], [WIDTH, HEIGHT], [...JPEG, join(OUT, file.replace(/\.mp4$/, ".jpg"))]);
}

async function still(file: string, take: Still, size: [number, number] = [WIDTH, HEIGHT]): Promise<void> {
  await film(take.place, file, [`time=${take.time} shot=${take.shot} part=${take.part}`], size, [...JPEG, join(OUT, file)]);
}

async function globe(): Promise<void> {
  const surface = join(WORK, "globe.rgba"), frame = join(WORK, "globe.png");
  writeFileSync(surface, globeSurface(1024));
  const live = PLACES.filter((place) => place.status === "live");
  const pins = live.map((place) => `${place.lat},${place.lon},${place.accent.replace("#", "")}`).join(";");
  await run([SHOT, "--globe", surface, "--shape", "vita", "--out", frame, "--at", GLOBE.at.join(","), "--face", GLOBE.face.join(","), "--pin", String(live.findIndex((place) => place.id === "tokyo-konbini")), "--pins", pins], { quiet: true });
  await run(["ffmpeg", "-v", "error", "-y", "-i", frame, ...JPEG, join(OUT, GLOBE.file)]);
}

// ---------------------------------------------------------------- the listing

interface Media {
  kind: "video" | "image";
  file: string;
  poster?: string;
  width: number;
  height: number;
  seconds?: number;
  from: string;
  caption: string;
}
interface Listing {
  tagline: string;
  description: string[];
  media: Media[];
  card: string;
}

async function probe(file: string): Promise<{ codec: string; pixels: string; width: number; height: number; seconds: number; streams: number; profile: string }> {
  const said = JSON.parse(await run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", file], { quiet: true }));
  const video = said.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  return { codec: video.codec_name, pixels: video.pix_fmt, width: video.width, height: video.height, seconds: Number(said.format.duration ?? 0), streams: said.streams.length, profile: video.profile ?? "" };
}

/** Holds the directory to the contract: the words' lengths, every file named and there, its kind, its size. */
async function check(listing: Listing): Promise<{ file: string; bytes: number; seconds?: number }[]> {
  const faults: string[] = [], files: { file: string; bytes: number; seconds?: number }[] = [];
  const name = /^[a-z0-9-]+\.(mp4|jpg|webp|png)$/;
  if (!listing.tagline || listing.tagline.length > 120) faults.push("the tagline is one sentence of at most 120 characters");
  if (listing.description.length < 1 || listing.description.length > 6 || listing.description.some((p) => !p || p.length > 600)) faults.push("the description is one to six paragraphs of at most 600 characters");
  if (listing.media.length < 2 || listing.media.length > 12) faults.push("media has 2 to 12 entries");
  if (listing.media[0]?.kind !== "video") faults.push("the first entry is the lead clip");
  const picture = async (file: string, width: number, height: number, most: number) => {
    if (!name.test(file)) return void faults.push(`${file}: a file is named [a-z0-9-]+ with .mp4, .jpg, .webp or .png`);
    const path = join(OUT, file);
    if (!existsSync(path)) return void faults.push(`${file}: not filmed`);
    const bytes = statSync(path).size, seen = await probe(path);
    if (bytes > most) faults.push(`${file}: ${bytes} bytes, over ${most}`);
    if (seen.width !== width || seen.height !== height) faults.push(`${file}: ${seen.width} x ${seen.height}, and the listing says ${width} x ${height}`);
    files.push({ file, bytes });
  };
  for (const entry of listing.media) {
    if (!entry.caption || entry.caption.length > 140) faults.push(`${entry.file}: a caption has at most 140 characters`);
    if (!["browser", "psp", "vita", "3ds", "ipod-touch", "android"].includes(entry.from)) faults.push(`${entry.file}: from "${entry.from}"`);
    if (entry.width / entry.height < 4 / 3 || entry.width / entry.height > 2) faults.push(`${entry.file}: a picture is between 4:3 and 2:1`);
    if (entry.kind === "image") {
      await picture(entry.file, entry.width, entry.height, LIMIT.image);
      continue;
    }
    if (!name.test(entry.file) || !existsSync(join(OUT, entry.file))) {
      faults.push(`${entry.file}: not filmed`);
      continue;
    }
    const bytes = statSync(join(OUT, entry.file)).size, seen = await probe(join(OUT, entry.file));
    if (seen.codec !== "h264" || !["High", "Main"].includes(seen.profile) || seen.pixels !== "yuv420p" || seen.streams !== 1) faults.push(`${entry.file}: ${seen.codec} ${seen.profile} ${seen.pixels} in ${seen.streams} stream(s); a clip is H.264 High or Main, yuv420p, with no sound`);
    if (seen.width !== entry.width || seen.height !== entry.height) faults.push(`${entry.file}: ${seen.width} x ${seen.height}, and the listing says ${entry.width} x ${entry.height}`);
    // Pocket Studio takes a whole number of seconds: the clip's length, rounded
    if (Math.round(seen.seconds) !== entry.seconds) faults.push(`${entry.file}: ${seen.seconds} s, and the listing says ${entry.seconds}; it states the length rounded to a whole second`);
    if (seen.seconds < 6 || seen.seconds > 30) faults.push(`${entry.file}: a clip is 6 to 30 seconds`);
    if (bytes > LIMIT.video) faults.push(`${entry.file}: ${bytes} bytes, over ${LIMIT.video}`);
    files.push({ file: entry.file, bytes, seconds: seen.seconds });
    if (!entry.poster) faults.push(`${entry.file}: a clip has a poster`);
    else await picture(entry.poster, entry.width, entry.height, LIMIT.image);
  }
  await picture(listing.card, CARD.width, CARD.height, LIMIT.card);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > LIMIT.total) faults.push(`the directory is ${total} bytes, over ${LIMIT.total}`);
  if (faults.length) throw new Error(`listing: ${faults.join("\n         ")}`);
  return files;
}

async function upload(): Promise<void> {
  const link = join(ROOT, ".pocket-studio.json");
  if (!existsSync(link)) throw new Error(`no ${link}: run \`pocket-studio register --title "Pocket Atlas"\` here, or copy the file of the checkout that did`);
  const project = JSON.parse(readFileSync(link, "utf8"));
  const cli = process.env.POCKET_STUDIO_CLI?.trim().split(/\s+/) ?? (Bun.which("pocket-studio") ? ["pocket-studio"] : null);
  if (!cli) throw new Error("no pocket-studio on PATH: install it from the Studio, or set POCKET_STUDIO_CLI to its command");
  console.log(`listing: uploading ${OUT} to ${project.server} (${project.app})`);
  const code = await Bun.spawn([...cli, "listing", OUT], { cwd: ROOT, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited;
  if (code !== 0) throw new Error(`pocket-studio listing exited ${code}`);
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
if (argv.includes("--help")) {
  console.log("usage: bun tools/listing.ts [--only FILE] [--upload]");
  process.exit(0);
}
const listing = JSON.parse(readFileSync(join(ROOT, "listing/listing.json"), "utf8")) as Listing;
const named = new Set([...listing.media.map((entry) => entry.file), listing.card]);
const takes = [...Object.keys(CLIPS), ...Object.keys(STILLS), CARD.file, GLOBE.file];
for (const file of named) if (!takes.includes(file)) throw new Error(`listing/listing.json names ${file}, and tools/listing.ts has no take for it`);
for (const file of takes) if (!named.has(file)) throw new Error(`tools/listing.ts films ${file}, and listing/listing.json does not name it`);
if (only && !takes.includes(only)) throw new Error(`no take named ${only}: ${takes.join(", ")}`);

mkdirSync(WORK, { recursive: true });
if (!only) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
await run(["cargo", "build", "--release", "--locked", "--bin", "atlas-film", "--bin", "atlas-shot"], { cwd: CRATE });
const wanted = (file: string) => !only || only === file;
for (const [file, take] of Object.entries(CLIPS)) {
  if (!wanted(file)) continue;
  await clip(file, take);
  console.log(`listing: ${file}  ${(take.cuts.reduce((sum, cut) => sum + cut.seconds, 0)).toFixed(1)} s  ${(statSync(join(OUT, file)).size / MIB).toFixed(2)} MiB`);
}
for (const [file, take] of Object.entries(STILLS)) {
  if (!wanted(file)) continue;
  await still(file, take);
  console.log(`listing: ${file}`);
}
if (wanted(CARD.file)) {
  await still(CARD.file, CARD, [CARD.width, CARD.height]);
  console.log(`listing: ${CARD.file}`);
}
if (wanted(GLOBE.file)) {
  await globe();
  console.log(`listing: ${GLOBE.file}`);
}
if (!only) {
  const files = await check(listing);
  writeFileSync(join(OUT, "listing.json"), JSON.stringify(listing, null, 2) + "\n");
  for (const file of files) console.log(`  ${file.file.padEnd(18)} ${String(file.bytes).padStart(9)} bytes${file.seconds ? `  ${file.seconds.toFixed(1)} s` : ""}`);
  console.log(`listing: ${files.length} files, ${(files.reduce((sum, file) => sum + file.bytes, 0) / MIB).toFixed(1)} MiB in ${OUT}`);
  if (argv.includes("--upload")) await upload();
} else if (argv.includes("--upload")) throw new Error("--upload sends the whole listing: run it without --only");
