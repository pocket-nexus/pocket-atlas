/** Atlas authoring -> sealed PlaceIR -> target recipe. No device SDK or physical device required. */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { describePlace } from "../web/src/places/shared/authoring";
import { placeById } from "../web/src/places/registry";
import { exportPlaceSource, type ExportOptions } from "../web/scripts/export-place";
import { sha256 } from "../web/scripts/export-source";

const root = resolve(import.meta.dir, "..");
const commands = ["inspect", "export", "import", "check", "cook", "build", "report", "recipe", "profiles"];
export function parseOptions(args: string[]) {
  const command = args[0];
  if (!commands.includes(command)) throw new Error(`usage: bun tools/place.ts <${commands.join("|")}> [--place ID] [--profile ID] [--in PATH] [--out PATH]`);
  const options: Record<string, string> = {};
  const allowed = new Set(["place", "profile", "in", "out", "base", "geometry", "seed", "seconds", "fps", "start", "tex", "cell", "report", "asset"]);
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !allowed.has(key) || key in options || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`Unknown, repeated or incomplete option: ${args[i]}`);
    options[key] = args[i + 1];
  }
  return { command, options };
}
async function compiler(args: string[]) {
  const p = Bun.spawn(["cargo", "run", "--release", "--locked", "-p", "pocket3d-place-cook", "--", ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "inherit" });
  const [output, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code) throw new Error(`Atlas compiler exited ${code}`);
  return JSON.parse(output);
}
async function exportSource(options: ExportOptions) {
  if (options.base) return exportPlaceSource(options);
  // Own only this server. A busy port fails instead of silently borrowing another worktree.
  const port = 5197;
  const instance = randomUUID();
  const server = Bun.spawn([process.execPath, join(root, "web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: join(root, "web"), env: { ...process.env, ATLAS_EXPORT_SERVER_ID: instance }, stdout: "ignore", stderr: "inherit" });
  let exited = false;
  void server.exited.then(() => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(100);
      if (exited) throw new Error(`Export server failed to start on ${base}; supply --base for an existing Atlas server`);
      let ready = false;
      try { const response = await fetch(`${base}/__atlas/source`); ready = response.ok && (await response.json() as { instance?: string }).instance === instance; }
      catch (error) { if (!(error instanceof TypeError) && (error as {code?:string}).code !== "ConnectionRefused") throw error; }
      if (ready) return await exportPlaceSource({ ...options, base });
    }
    throw new Error("Timed out starting the export server");
  } finally { server.kill(); await server.exited; }
}
export async function run(args: string[]) {
  const { command, options: o } = parseOptions(args);
  const id = o.place ?? "tokyo-konbini";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Invalid place id");
  const directory = join(root, ".pocket-build/places", id);
  const input = resolve(o.in ?? join(directory, "place.ir"));
  const profile = o.profile ?? "vita30";
  const flags = ["--profile", profile, ...["tex", "cell", "report"].flatMap(k => o[k] ? [`--${k}`, resolveIfReport(k, o[k])] : [])];
  if (command === "inspect") {
    const catalog = placeById(id);
    const definition = (await catalog?.load?.())?.definition;
    if (!definition) throw new Error(`No authored definition: ${id}`);
    return { authoring: describePlace(definition), releaseTargets: catalog!.targets, capabilityCheckRequired: true };
  }
  if (command === "report") {
    if (!o.in) throw new Error("report requires --in <compile.json>");
    const report = JSON.parse(readFileSync(input, "utf8"));
    if (report.schemaVersion !== 1 || !report.artifact?.sha256) throw new Error("Not an Atlas compile receipt");
    if (o.asset && sha256(readFileSync(resolve(o.asset))) !== report.artifact.sha256) throw new Error("Asset disagrees with compile receipt");
    return report;
  }
  if (command === "profiles" || command === "recipe") return compiler([command, ...flags]);
  if (command === "export" || command === "build") {
    const geometry = o.geometry ?? "full";
    if (geometry !== "full" && geometry !== "handheld") throw new Error("Unknown geometry profile");
    const exported = await exportSource({ place: id, out: command === "export" ? o.out ?? directory : directory, base: o.base, geometry,
      ...(o.seed === undefined ? {} : { seed: Number(o.seed) }),
      sampling: { ...(o.start === undefined ? {} : { startSeconds: Number(o.start) }), ...(o.seconds === undefined ? {} : { durationSeconds: Number(o.seconds) }), ...(o.fps === undefined ? {} : { fps: Number(o.fps) }) } });
    if (command === "export") return exported;
    await compiler(["import", "--in", directory, "--out", input]);
  }
  if (command === "import") return compiler(["import", "--in", resolve(o.in ?? directory), "--out", resolve(o.out ?? join(directory, "place.ir"))]);
  if (!existsSync(join(input, "manifest.json"))) throw new Error(`No sealed PlaceIR at ${input}; run import first`);
  if (command === "check") return compiler(["check", "--in", input, ...flags]);
  return compiler(["--in", input, "--out", resolve(o.out ?? join(directory, `${id}.${profile}.place`)), ...flags]);
}
function resolveIfReport(key: string, value: string) { return key === "report" ? resolve(value) : value; }
if (import.meta.main) {
  try { console.log(JSON.stringify(await run(Bun.argv.slice(2)), null, 2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
