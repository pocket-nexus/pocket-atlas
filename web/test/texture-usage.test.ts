import { expect, test } from "bun:test";
import { MeshStandardMaterial, Texture } from "three";
import { exportedTextureUsages, materialTextureUsage, textureUsage } from "../src/places/shared/texture-usage";

test("one shared image can carry different material purposes without mutating its default", () => {
  const shared = textureUsage(new Texture(), "text-atlas");
  const lettering = new MeshStandardMaterial({ map: shared });
  const surface = materialTextureUsage(new MeshStandardMaterial({ map: shared }), { albedo: "surface" });
  expect(exportedTextureUsages(lettering)).toEqual({ albedo: "text-atlas" });
  expect(exportedTextureUsages(surface)).toEqual({ albedo: "surface" });
  expect(shared.userData.pocketAtlas.usage).toBe("text-atlas");
  const legacy = new MeshStandardMaterial({ map: new Texture() });
  expect(exportedTextureUsages(legacy)).toEqual({});
});
