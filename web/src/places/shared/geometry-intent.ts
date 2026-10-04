import { Group, type Object3D } from "three";

/** World-space fidelity limits. Device recipes may be stricter, never looser. */
export interface GeometryIntent {
  role: "protected" | "structure" | "detail" | "background";
  maxErrorMeters: number;
}
export function validateGeometryIntent(value: unknown): asserts value is GeometryIntent {
  const v = value as GeometryIntent;
  if (!v || typeof v !== "object" || Object.keys(v).some(k => !["role", "maxErrorMeters"].includes(k)) ||
      !["protected", "structure", "detail", "background"].includes(v.role) || !Number.isFinite(v.maxErrorMeters) ||
      v.maxErrorMeters < 0 || v.maxErrorMeters > 1 || (v.role === "protected" && v.maxErrorMeters !== 0))
    throw new Error("Invalid geometry intent: expected a role and finite world-space error in [0, 1] metres (protected = 0)");
}
export function geometryIntent<T extends Object3D>(object: T, intent: GeometryIntent): T {
  validateGeometryIntent(intent);
  object.userData.pocketAtlas = { ...object.userData.pocketAtlas, geometry: { ...intent } };
  return object;
}

/** Alternative authored representations, retained together in PlaceIR. Web
 * displays the zero-error reference; a target recipe selects an admissible
 * alternative before material resolution, baking or static batching.
 * Error is an author-supplied upper bound, reviewed with the reference view.
 */
export function geometryAlternatives(id: string, intent: GeometryIntent,
  levels: { id: string; errorMeters: number; object: Object3D }[]): Group {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || levels.length < 2 || levels[0].errorMeters !== 0)
    throw new Error("Geometry alternatives need an id and a zero-error reference followed by alternatives");
  const ids = new Set<string>();
  let last = -1;
  const root = geometryIntent(new Group(), intent);
  root.name = id;
  root.userData.dynamic = true; // preserve alternative boundaries in the Web draw optimiser
  root.userData.pocketAtlas.lodGroup = { version: 1 };
  for (const level of levels) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(level.id) || ids.has(level.id) || !Number.isFinite(level.errorMeters) ||
        level.errorMeters <= last || level.errorMeters > 1 || level.object.parent)
      throw new Error(`Invalid geometry alternative: ${level.id}`);
    ids.add(level.id); last = level.errorMeters;
    level.object.name = level.id;
    level.object.visible = level.errorMeters === 0;
    level.object.userData.pocketAtlas = { ...level.object.userData.pocketAtlas, alternative: { id: level.id, errorMeters: level.errorMeters } };
    root.add(level.object);
  }
  return root;
}
