import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Authoring } from "../src/places/shared/authoring";

export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Conservative source closure: authoring, exporter, locked dependencies and local assets. */
export function sourceSnapshot(root: string) {
  const files: { path: string; sha256: string }[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Export source symlinks are unsupported: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (stat.isFile()) files.push({ path: relative(root, path).split(sep).join("/"), sha256: sha256(readFileSync(path)) });
  };
  for (const name of ["src", "public", "scripts", "examples", "index.html", "package.json", "bun.lock", "tsconfig.json", "vite.config.ts"]) walk(join(root, name));
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sha256: sha256(JSON.stringify(files)), files };
}

export function verifyResources(root: string, definition: Authoring): void {
  const publicRoot = resolve(root, "public");
  for (const resource of definition.resources) {
    const path = realpathSync(resolve(publicRoot, resource.path));
    if (!path.startsWith(`${publicRoot}${sep}`)) throw new Error(`Resource escapes web/public: ${resource.path}`);
    if (sha256(readFileSync(path)) !== resource.sha256) throw new Error(`Resource lock mismatch: ${resource.path}`);
  }
}

export function localOutputName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || ["export.json", "report.json"].includes(name))
    throw new Error(`Invalid export resource name: ${name}`);
  return name;
}
