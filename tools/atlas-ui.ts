#!/usr/bin/env bun
/**
 * Compiles the interface (`ui/`, one PocketJS app) for a device. PocketJS
 * resolves `ui/pocket.json` against the device's profile, picks the
 * presentation its modality asks for and writes the bundle and its pak.
 *
 *   bun tools/atlas-ui.ts <psp|vita|3ds|ipod|android>   → .pocket-build/ui/<device>/atlas.{js,pak}, plan.json
 *   bun tools/atlas-ui.ts prepare               → the generated catalogue and preview cards only
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractHostBuildInputs, type HostBuildInputs } from "../vendor/pocketjs/framework/src/manifest/index.ts";
import { POCKET_CAPABILITIES, definePlatformContractRegistry, defineTargetRegistry } from "../vendor/pocketjs/contracts/spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve.ts";
import { resolve3dsBuildPlan } from "../vendor/pocketjs/tools/3ds-profile.ts";
import { IPODTOUCH4_DEV_HOST_ABI } from "../vendor/pocketjs/tools/ipodtouch4-profile.ts";
import { MOTO_G_PLAY_CONTRACTS, MOTO_G_PLAY_TARGET } from "../vendor/pocketjs/tools/moto-g-play-profile.ts";

export const DEVICES = ["psp", "vita", "3ds", "ipod", "android"] as const;
export type Device = (typeof DEVICES)[number];

const root = resolve(import.meta.dir, "..");
const pocket = join(root, "vendor/pocketjs");
const project = join(root, "ui");
const manifest = join(project, "pocket.json");
/**
 * The iPod touch 4 as Pocket Atlas presents it. PocketJS's own profile for
 * the device describes its host, which draws at the panel's 640×960; here
 * the interface shares the place's drawable, 480×320 on its side at one
 * sample per logical pixel (ipod/src/main.c).
 */
const IPOD_TARGET = "ipodtouch4-atlas";
const IPOD_CONTRACTS = definePlatformContractRegistry(POCKET_CAPABILITIES, defineTargetRegistry({
  [IPOD_TARGET]: {
    hostAbi: IPODTOUCH4_DEV_HOST_ABI,
    platform: "ios",
    form: "takeover",
    display: { physicalViewport: [480, 320], logicalViewports: [[480, 320]], presentations: ["native"], rasterDensity: 1 },
    capabilities: ["input.touch", "text.glyphs.baked"],
  },
}));
function resolveIPodBuildPlan(manifest: unknown): unknown {
  const resolution = validateAndResolveBuildPlan(manifest, { target: IPOD_TARGET }, IPOD_CONTRACTS);
  if (!resolution.ok) throw new Error(`atlas-ui: ${resolution.diagnostics.map((d) => `${d.path || "/"}: ${d.message}`).join("; ")}`);
  return resolution.plan;
}
/**
 * The Redmi 1S as Pocket Atlas presents it: the landscape window, 1280×720,
 * with the interface at 640×360 logical pixels of two samples each
 * (android/src/main.c). A touch panel and no pad: the back and menu keys
 * reach the interface as buttons without making the phone a pad device.
 */
const ANDROID_TARGET = "redmi1s-atlas";
const ANDROID_CONTRACTS = definePlatformContractRegistry(POCKET_CAPABILITIES, defineTargetRegistry({
  [ANDROID_TARGET]: {
    hostAbi: MOTO_G_PLAY_CONTRACTS.targets[MOTO_G_PLAY_TARGET].hostAbi,
    platform: "android",
    form: "takeover",
    display: { physicalViewport: [1280, 720], logicalViewports: [[640, 360]], presentations: ["native"], rasterDensity: 2 },
    capabilities: ["input.touch", "text.glyphs.baked"],
  },
}));
/** Devices outside PocketJS's public registry resolve through a profile kept with their tool. */
function resolver(target: string, contracts: Parameters<typeof validateAndResolveBuildPlan>[2]) {
  return (manifest: unknown): unknown => {
    const resolution = validateAndResolveBuildPlan(manifest, { target }, contracts);
    if (!resolution.ok) throw new Error(`atlas-ui: ${resolution.diagnostics.map((d) => `${d.path || "/"}: ${d.message}`).join("; ")}`);
    return resolution.plan;
  };
}
const PRIVATE: Partial<Record<Device, (manifest: unknown) => unknown>> = { "3ds": resolve3dsBuildPlan, ipod: resolveIPodBuildPlan, android: resolver(ANDROID_TARGET, ANDROID_CONTRACTS) };

export interface Interface {
  /** Directory holding `atlas.js`, `atlas.pak` and `plan.json`. */
  directory: string;
  inputs: HostBuildInputs;
  plan: { features: Record<string, boolean> };
}

function run(args: string[]) {
  const done = Bun.spawnSync(args, { cwd: pocket, stdout: "inherit", stderr: "inherit" });
  if (done.exitCode !== 0) throw new Error(`atlas-ui: ${args.slice(0, 3).join(" ")} failed`);
}

/**
 * Writes what the interface compiles from the web registry: the catalogue of
 * places and, for each place of this device whose preview has been exported,
 * its card at both raster densities (`ui/app/generated/`, ignored). A place
 * the device cannot visit is listed without a picture.
 */
export async function prepareInterface(device?: Device): Promise<void> {
  const { PLACES } = await import("../web/src/places/registry.ts");
  const generated = join(project, "app/generated");
  rmSync(generated, { recursive: true, force: true });
  mkdirSync(generated, { recursive: true });
  const magick = Bun.which("magick");
  const places = PLACES.map(({ load, ...place }) => {
    const source = join(root, ".pocket-build/places", place.id, "preview.png");
    const here = !device || place.targets?.includes(device);
    const preview = magick && here && existsSync(source) ? `generated/${place.id}.png` : "";
    if (preview) {
      // Cards are 2:1 (the middle of the 16:9 preview), power-of-two texels.
      for (const [suffix, size] of [["", "256x128"], ["@2x", "512x256"]] as const) {
        const done = Bun.spawnSync([magick!, source, "-resize", `${size}^`, "-gravity", "center", "-extent", size, "-strip",
          "-define", "png:color-type=2", "-depth", "8", join(generated, `${place.id}${suffix}.png`)]);
        if (done.exitCode !== 0) throw new Error(`atlas-ui: preview ${place.id}: ${done.stderr}`);
      }
    }
    return {
      id: place.id, name: place.name, native: place.native, locality: place.locality, country: place.country,
      lat: place.lat, lon: place.lon, accent: place.accent, kind: place.kind ?? "", tags: place.tags ?? [],
      summary: place.summary ?? "", weather: place.weather, featured: !!place.featured, live: place.status === "live" && !!load, preview,
    };
  });
  writeFileSync(join(generated, "catalog.ts"),
    `// Generated by tools/atlas-ui.ts from web/src/places/registry.ts.\nimport type { Place } from "../catalog.ts";\n\nexport const PLACES: Place[] = ${JSON.stringify(places, null, 2)};\n`);
  // The PSP keeps its cards as 16-bit texels: they share 24 MB with a place.
  const sixteen = device === "psp" ? Object.fromEntries(places.filter((p) => p.preview).map((p) => [p.preview, { psm: 0 }])) : {};
  writeFileSync(join(project, "app/images.json"), JSON.stringify(sixteen, null, 2) + "\n");
}

export async function compileInterface(device: Device): Promise<Interface> {
  await prepareInterface(device);
  const directory = join(root, ".pocket-build/ui", device);
  mkdirSync(directory, { recursive: true });
  const planPath = join(directory, "plan.json");
  const resolver = PRIVATE[device];
  if (resolver) {
    writeFileSync(planPath, JSON.stringify(resolver(await Bun.file(manifest).json()), null, 2) + "\n");
    run(["bun", "tools/build.ts", `--plan=${planPath}`, `--project-root=${project}`, `--outdir=${directory}`]);
  } else {
    run(["bun", "tools/pocket.ts", "compile", "--target", device, "--manifest", manifest, "--project-root", project, "--outdir", directory]);
    await Bun.write(planPath, Bun.file(join(project, ".pocket", device, "plan.json")));
  }
  const plan = await Bun.file(planPath).json();
  return { directory, plan, inputs: extractHostBuildInputs(plan) };
}

if (import.meta.main) {
  const device = process.argv[2] as Device;
  if ((device as string) === "prepare") {
    await prepareInterface();
    process.exit(0);
  }
  if (!DEVICES.includes(device)) throw new Error(`usage: bun tools/atlas-ui.ts <${DEVICES.join("|")}|prepare>`);
  const built = await compileInterface(device);
  console.log(`${device}: ${built.inputs.target}, ${built.inputs.viewport.logical.join("×")} @${built.inputs.viewport.rasterDensity}x → ${built.directory}`);
}
