import type { Material, Texture } from "three";

/** Compiler intent. Each target recipe chooses its own size and encoding. */
export type TextureUsage = "surface" | "text-atlas" | "flipbook" | "emissive-strip";
export type TextureSlot = "albedo" | "normal" | "orm" | "emission";
export type TextureUsages = Partial<Record<TextureSlot, TextureUsage>>;

/** Give an image a default purpose; materials may override it per slot. */
export function textureUsage<T extends Texture>(texture: T, usage: TextureUsage): T {
  texture.userData.pocketAtlas = { ...texture.userData.pocketAtlas, usage };
  return texture;
}

/** Override image defaults without duplicating or mutating the shared image. */
export function materialTextureUsage<T extends Material>(material: T, usage: TextureUsages): T {
  const pc = material.userData.pocketAtlas ?? {};
  material.userData.pocketAtlas = { ...pc, textureUsage: { ...pc.textureUsage, ...usage } };
  return material;
}

/** Used at export time, before conversion changes Three.js material classes. */
export function exportedTextureUsages(material: Material): TextureUsages {
  const m = material as Material & { map?: Texture; normalMap?: Texture; roughnessMap?: Texture; metalnessMap?: Texture; emissiveMap?: Texture };
  const pc = m.userData.pocketAtlas ?? {};
  const slots: Partial<Record<TextureSlot, Texture>> = {
    albedo: pc.kind === "products" ? pc.pack : m.map,
    normal: m.normalMap, orm: m.roughnessMap ?? m.metalnessMap, emission: m.emissiveMap,
  };
  const usages: TextureUsages = {};
  for (const [slot, texture] of Object.entries(slots)) {
    const usage = texture?.userData.pocketAtlas?.usage;
    if (usage) usages[slot as TextureSlot] = usage;
  }
  return { ...usages, ...pc.textureUsage };
}
