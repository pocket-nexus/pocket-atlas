import type { Material, Mesh, Object3D } from "three";

const part = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, "-") || "object";

/** Assign IDs before batching. IDs use author names/tree order, never Three's global counter or UUID. */
export function identifySources(root: Object3D, prefix = "world"): void {
  const used = new Set<string>();
  const materials = new Map<Material, Set<string>>();
  const visit = (object: Object3D, path: string) => {
    const pc = object.userData.pocketAtlas ?? {};
    const sourceId = pc.sourceId ?? path;
    if (typeof sourceId !== "string" || !sourceId || used.has(sourceId)) throw new Error(`Duplicate or invalid source ID: ${sourceId}`);
    if (pc.sources && (!Array.isArray(pc.sources) || pc.sources.some((id: unknown) => typeof id !== "string" || !id)))
      throw new Error(`Invalid source contributors: ${sourceId}`);
    used.add(sourceId);
    object.userData.pocketAtlas = { ...pc, sourceId, sources: pc.sources ?? [sourceId] };
    const material = (object as Mesh).material;
    for (const m of material ? (Array.isArray(material) ? material : [material]) : []) {
      let sources = materials.get(m);
      if (!sources) materials.set(m, sources = new Set(m.userData.pocketAtlas?.sources ?? []));
      for (const id of object.userData.pocketAtlas.sources) sources.add(id);
    }
    const counts = new Map<string, number>();
    for (const child of object.children) {
      const key = part(child.name || child.type);
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      visit(child, `${sourceId}/${key}-${index}`);
    }
  };
  visit(root, prefix);
  for (const [material, sources] of materials)
    material.userData.pocketAtlas = { ...material.userData.pocketAtlas, sources: [...sources].sort() };
}

/** Name an authored group so reports retain a stable semantic anchor. */
export function source<T extends Object3D>(id: string, object: T): T {
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(id)) throw new Error(`Invalid source ID: ${id}`);
  object.userData.pocketAtlas = { ...object.userData.pocketAtlas, sourceId: id };
  return object;
}

export function sourceIds(object: Object3D | Material): string[] {
  return object.userData.pocketAtlas?.sources ?? [];
}
