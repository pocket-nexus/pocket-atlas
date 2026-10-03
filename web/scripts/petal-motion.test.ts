import { describe, expect, test } from "bun:test";
import { Euler, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3 } from "three";
import { driftingPetalSeeds, petalPose } from "../src/places/shared/daylight/petal-motion";
import { rigidParticles, RIGID_PARTICLE_BATCH_SIZE } from "../src/places/shared/rigid-particles";

const ground = (z: number) => z * 0.05;
const rotation = (p: ReturnType<typeof petalPose>) => new Quaternion().setFromEuler(new Euler(p.rx, p.ry, p.rz));

describe("exportable drifting petals", () => {
  for (const period of [64, 48]) {
    test(`${period}s drift is seekable and closes position, orientation and velocity`, () => {
      for (const seed of driftingPetalSeeds(12)) {
        for (const t of [-0.01, 0, 11.3, period - 0.01]) {
          const a = petalPose(seed, t, period, ground), b = petalPose(seed, t + period * 3, period, ground);
          for (const k of ["x", "y", "z"] as const) expect(a[k]).toBeCloseTo(b[k], 10);
          expect(Math.abs(rotation(a).dot(rotation(b)))).toBeCloseTo(1, 10);
        }
        const d = 0.001, before = petalPose(seed, period - d, period, ground), at = petalPose(seed, 0, period, ground), after = petalPose(seed, d, period, ground);
        for (const k of ["x", "y", "z"] as const) {
          expect(Math.abs(after[k] - before[k])).toBeLessThan(0.001);
          expect((at[k] - before[k]) / d).toBeCloseTo((after[k] - at[k]) / d, 3);
        }
        expect(Math.abs(rotation(before).dot(rotation(after)))).toBeGreaterThan(0.99999);
      }
    });
  }
  test("real petal sizes and a camera-independent clearance hold for the whole loop", () => {
    for (const seed of driftingPetalSeeds(260)) {
      expect(seed.size).toBeGreaterThanOrEqual(0.025);
      expect(seed.size).toBeLessThanOrEqual(0.05);
      for (let t = 0; t < 64; t += 0.25) {
        const pose = petalPose(seed, t, 64, ground);
        expect(Math.abs(pose.x)).toBeGreaterThanOrEqual(3.8);
        expect(pose.y - ground(pose.z)).toBeGreaterThanOrEqual(0.25 - 1e-10);
      }
    }
  });
  test("24-bone batches preserve every particle and bake scale into vertices", () => {
    const geo = new PlaneGeometry(1, 1), mat = new MeshStandardMaterial();
    for (const count of [90, 260]) {
      const sizes = Array.from({ length: count }, (_, i) => 0.025 + (i % 10) * 0.002);
      const particles = rigidParticles(geo, mat, sizes, `test-${count}`);
      expect(particles.bones).toHaveLength(count);
      expect(particles.meshes).toHaveLength(Math.ceil(count / RIGID_PARTICLE_BATCH_SIZE));
      particles.bones.forEach((bone, i) => {
        bone.position.set(i * 0.01, 2, -3);
        bone.rotation.set(0.4, 0.1, i * 0.2);
        expect(bone.scale.toArray()).toEqual([1, 1, 1]);
      });
      particles.root.updateMatrixWorld(true);
      let first = 0;
      for (const mesh of particles.meshes) {
        expect(mesh.skeleton.bones.length).toBeLessThanOrEqual(RIGID_PARTICLE_BATCH_SIZE);
        mesh.skeleton.update();
        const skin = mesh.geometry.getAttribute("skinIndex"), weights = mesh.geometry.getAttribute("skinWeight");
        const pos = mesh.geometry.getAttribute("position");
        for (let i = 0; i < mesh.skeleton.bones.length; i++) {
          const bone = particles.bones[first + i], vertex = i * 4;
          expect(skin.getX(vertex)).toBe(i);
          expect(weights.getX(vertex)).toBe(1);
          expect(weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex)).toBe(0);
          const actual = mesh.applyBoneTransform(vertex, new Vector3().fromBufferAttribute(pos, vertex));
          const expected = new Vector3().fromBufferAttribute(geo.getAttribute("position"), 0)
            .multiplyScalar(sizes[first + i]).applyQuaternion(bone.quaternion).add(bone.position);
          expect(actual.distanceTo(expected)).toBeLessThan(1e-7);
        }
        first += mesh.skeleton.bones.length;
        mesh.geometry.dispose(); mesh.skeleton.dispose();
      }
      expect(first).toBe(count);
    }
    geo.dispose(); mat.dispose();
  });
});
