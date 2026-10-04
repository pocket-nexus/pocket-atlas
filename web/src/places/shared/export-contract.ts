import { Material, type MeshBasicMaterial, type MeshPhysicalMaterial, type MeshStandardMaterial, type Object3D } from "three";

export function validateExportMaterial(material: Material): void {
  const pc = material.userData.pocketAtlas ?? {};
  if (pc.kind === "lights") return;
  const standard = material as MeshStandardMaterial;
  if (!(material as MeshBasicMaterial).isMeshBasicMaterial && !standard.isMeshStandardMaterial)
    throw new Error(`Unsupported material ${material.name || material.type}: ${material.type}; add an Atlas semantic lowering before export`);
  if (standard.displacementMap || standard.lightMap)
    throw new Error(`Unsupported displacement/light map on ${material.name || material.type}; bake it into supported geometry/material data`);
  if (standard.wireframe) throw new Error(`Wireframe has no Atlas material lowering: ${material.name || material.type}`);
  if (material.onBeforeCompile !== Material.prototype.onBeforeCompile &&
      !pc.kind && !pc.wet && !pc.damp && !pc.tint && !pc.vistaHaze && !pc.emissionShade)
    throw new Error(`Unannotated shader patch on ${material.name || material.type}; an Atlas material contract is required`);
  const physical = material as MeshPhysicalMaterial;
  if (physical.isMeshPhysicalMaterial && (physical.transmission > 0 || physical.sheen > 0 || physical.iridescence > 0 || physical.anisotropy > 0 || physical.clearcoatMap || physical.clearcoatNormalMap || physical.clearcoatRoughnessMap || physical.dispersion > 0 || physical.thickness > 0 || physical.ior !== 1.5 || physical.specularIntensity !== 1 || physical.specularColor.toArray().some(v => v !== 1)))
    throw new Error(`Unsupported physical extension on ${material.name || material.type}; define its target lowering first`);
}

export function validateExportObject(object: Object3D): void {
  const mesh = object as Object3D & { isMesh?: boolean; geometry?: { morphAttributes: Record<string, unknown[]> } };
  if (mesh.isMesh && Object.values(mesh.geometry?.morphAttributes ?? {}).some(values => values.length))
    throw new Error(`Morph targets are not supported: ${object.userData.pocketAtlas?.sourceId ?? object.name}`);
}
