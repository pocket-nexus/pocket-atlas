import { Bone, Float32BufferAttribute, Group, Skeleton, SkinnedMesh, Uint16BufferAttribute, type BufferGeometry, type Material } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Matches the shared Vita skin shader's palette. No particle-specific renderer is needed. */
export const RIGID_PARTICLE_BATCH_SIZE = 24;

/**
 * Independent rigid pieces carried by one bone each. Unlike animated instance
 * matrices, these transforms survive the ordinary glTF animation export. Sizes
 * are baked into vertices: callers animate translation/quaternion, never scale.
 * The input geometry and material remain owned by the caller.
 */
export function rigidParticles(geometry: BufferGeometry, material: Material, sizes: readonly number[], name: string) {
  const root = new Group();
  root.name = name;
  root.userData.dynamic = true;
  const bones: Bone[] = [], meshes: SkinnedMesh[] = [];
  for (let first = 0; first < sizes.length; first += RIGID_PARTICLE_BATCH_SIZE) {
    const batch = new Group();
    batch.name = `${name}-batch-${meshes.length}`;
    root.add(batch);
    const batchBones: Bone[] = [], pieces: BufferGeometry[] = [];
    for (let i = first; i < Math.min(sizes.length, first + RIGID_PARTICLE_BATCH_SIZE); i++) {
      const size = sizes[i];
      if (!(size > 0) || !Number.isFinite(size)) throw new Error("rigid particle size must be finite and positive");
      const g = geometry.clone().scale(size, size, size);
      const count = g.getAttribute("position").count;
      const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) {
        indices[v * 4] = batchBones.length;
        weights[v * 4] = 1;
      }
      g.setAttribute("skinIndex", new Uint16BufferAttribute(indices, 4));
      g.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
      pieces.push(g);
      const bone = new Bone();
      bone.name = `${name}-${i}`;
      batch.add(bone); batchBones.push(bone); bones.push(bone);
    }
    const combined = mergeGeometries(pieces, false);
    for (const piece of pieces) piece.dispose();
    if (!combined) throw new Error("rigid particle geometry merge failed");
    const mesh = new SkinnedMesh(combined, material);
    mesh.name = `${batch.name}-mesh`;
    // Petals do not cast discernible shadows. Rest vertices are all at the
    // origin; native bounds are taken from the skin's animated bone positions.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    batch.add(mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new Skeleton(batchBones));
    meshes.push(mesh);
  }
  return { root, bones, meshes };
}
