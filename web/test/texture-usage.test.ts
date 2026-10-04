import { expect, test } from "bun:test";
import { MeshStandardMaterial, Texture } from "three";
import { exportedTextureUsages, materialTextureUsage, textureUsage } from "../src/places/shared/texture-usage";
import { validateExportMaterial } from "../src/places/shared/export-contract";
import { DayLib } from "../src/places/shared/daylight/materials";
import { makeQuality } from "../src/core/quality";
import type { Baker } from "../src/places/shared/bake";

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

test("daylight decals keep depth offset and texture intent through shared material validation", () => {
  const atlas = textureUsage(new Texture(), "text-atlas");
  const lib = new DayLib({} as Baker, makeQuality("ultra"));
  const print = lib.printed("atlas", atlas), decal = lib.decal("atlas", atlas);
  const lit = lib.printed("atlas-lit", atlas, 0.3, 0.55);
  for (const material of [print, decal, lit]) {
    expect(() => validateExportMaterial(material)).not.toThrow();
    expect(material.map).toBe(atlas);
    expect(exportedTextureUsages(material).albedo).toBe("text-atlas");
  }
  expect(print.polygonOffset).toBe(false);
  expect(decal.polygonOffset).toBe(true);
  expect([decal.polygonOffsetFactor, decal.polygonOffsetUnits]).toEqual([-1, -1]);
  expect(decal).not.toBe(print);
  expect(exportedTextureUsages(lit).emission).toBe("text-atlas");
});
