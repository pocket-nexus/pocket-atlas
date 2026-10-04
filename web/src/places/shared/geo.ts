import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Float32BufferAttribute,
  Mesh,
  PlaneGeometry,
  TubeGeometry,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { identifySources, sourceIds } from "./provenance";


/**
 * Unit vector for a compass bearing and an elevation (degrees) in world
 * axes: y up, −Z facing the bearing `forward` (0 when −Z is north).
 */
export function bearing(azimuth: number, elevation = 0, forward = 0): Vector3 {
  const a = ((azimuth - forward) * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}
/** Box whose UVs are in meters on every face (textures tile by physical size). */
export function box(w: number, h: number, d: number): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  const uv = g.getAttribute("uv") as BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z; four vertices each.
  const sizes: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * sizes[f][0], uv.getY(i) * sizes[f][1]);
    }
  }
  return g;
}

/** Plane (XY, facing +z) with UVs in meters. */
export function plane(w: number, h: number, sx = 1, sy = 1): PlaneGeometry {
  const g = new PlaneGeometry(w, h, sx, sy);
  const uv = g.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

/** A hanging cable between two points (parabolic sag, good enough for spans < 40 m). */
export function cable(a: Vector3, b: Vector3, sag: number, radius: number, segments = 24): TubeGeometry {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = new Vector3().lerpVectors(a, b, t);
    p.y -= sag * 4 * t * (1 - t);
    pts.push(p);
  }
  return new TubeGeometry(new CatmullRomCurve3(pts), segments, radius, 5, false);
}

/**
 * Rewrites UVs from world position using the dominant normal axis, so that
 * separate pieces sharing a material line up (walls continue across boxes).
 */
export function worldUV(g: BufferGeometry): void {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  if (!pos || !nor) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ay >= ax && ay >= az) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = -z;
    } else if (ax >= az) {
      uv[i * 2] = nor.getX(i) > 0 ? -z : z;
      uv[i * 2 + 1] = y;
    } else {
      uv[i * 2] = nor.getZ(i) > 0 ? x : -x;
      uv[i * 2 + 1] = y;
    }
  }
  g.setAttribute("uv", new BufferAttribute(uv, 2));
}

/**
 * Indexed, with position, normal and uv only; with `color` too when `color`
 * is 3 or 4 (its components): Float32, white where the mesh has none.
 */
function normalizeForMerge(g: BufferGeometry, color: 0 | 3 | 4): BufferGeometry {
  const out = g;
  const n = out.getAttribute("position").count;
  if (!out.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    out.setIndex(new BufferAttribute(idx, 1));
  }
  const src = color ? out.getAttribute("color") : undefined;
  for (const name of Object.keys(out.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") out.deleteAttribute(name);
  }
  if (!out.getAttribute("normal")) out.computeVertexNormals();
  if (!out.getAttribute("uv")) out.setAttribute("uv", new Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (color) {
    const rgba = new Float32Array(n * color).fill(1);
    if (src) for (let i = 0; i < n; i++) for (let c = 0; c < Math.min(color, src.itemSize); c++) rgba[i * color + c] = src.getComponent(i, c);
    out.setAttribute("color", new Float32BufferAttribute(rgba, color));
  }
  out.morphAttributes = {};
  out.clearGroups();
  return out;
}

/**
 * Collapses every static, single-material mesh under `root` into one mesh per
 * (material, shadow flags, layer mask, render order, culling). Authoring
 * stays object-by-object while the frame (and the planar reflection pass)
 * pays a few dozen draw calls. The merged geometry keeps position, normal
 * and UV, and vertex colours (RGB or RGBA, white where a mesh has none) when
 * the material uses them. Meshes under `userData.dynamic` are left alone.
 */
export function batchStatic(root: Object3D, options: { preserveObjects?: boolean } = {}): { before: number; after: number } {
  identifySources(root);
  root.updateMatrixWorld(true);
  const retainWorldUV = (m: Mesh) => {
    const world = m.geometry.clone().applyMatrix4(m.matrixWorld);
    worldUV(world);
    m.geometry = m.geometry.clone();
    m.geometry.setAttribute("uv", world.getAttribute("uv").clone());
    world.dispose();
  };
  if (options.preserveObjects) {
    let count = 0;
    root.traverse(o => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      count++;
      const mat = m.material;
      // The Web batcher generates world UVs. Apply the same mapping without
      // discarding authored object/prototype/quality boundaries in the IR.
      let dynamic = false;
      for (let p: Object3D | null = m; p; p = p.parent) dynamic ||= !!p.userData.dynamic;
      if (!dynamic && !(m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh && !Array.isArray(mat) && mat.userData.worldUV) {
        retainWorldUV(m);
      }
    });
    return { before: count, after: count };
  }

  type Batch = { material: Material; cast: boolean; receive: boolean; layers: number; renderOrder: number; culled: boolean; color: 0 | 3 | 4; geos: BufferGeometry[]; worldUv: boolean; sources: Set<string> };
  const groups = new Map<string, Batch>();
  const remove: Mesh[] = [];
  let before = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    if (m.userData.dynamic || Array.isArray(m.material)) return;
    let skip = false;
    for (let p: Object3D | null = m.parent; p; p = p.parent) if (p.userData.dynamic) skip = true;
    if (skip) return;
    let alternative = false;
    for (let p: Object3D | null = m.parent; p; p = p.parent) alternative ||= !!p.userData.pocketAtlas?.lodGroup;
    if (alternative) {
      // Keep representation visibility/ownership without declaring static
      // objects animated or moving their hidden geometry into a visible batch.
      if (m.material.userData.worldUV) retainWorldUV(m);
      return;
    }
    before++;
    const mat = m.material as Material & { vertexColors?: boolean };
    const vc = !!mat.vertexColors;
    const key = `${mat.uuid}|${m.castShadow}|${m.receiveShadow}|${m.layers.mask}|${m.renderOrder}|${m.frustumCulled}|${vc}`;
    let grp = groups.get(key);
    if (!grp) {
      grp = { material: mat, cast: m.castShadow, receive: m.receiveShadow, layers: m.layers.mask, renderOrder: m.renderOrder, culled: m.frustumCulled, color: vc ? 3 : 0, geos: [], worldUv: !!mat.userData.worldUV, sources: new Set() };
      groups.set(key, grp);
    }
    if (vc && m.geometry.getAttribute("color")?.itemSize === 4) grp.color = 4;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    grp.geos.push(g);
    for (const id of sourceIds(m)) grp.sources.add(id);
    remove.push(m);
  });
  for (const m of remove) m.removeFromParent();
  let after = 0;
  for (const grp of groups.values()) {
    const merged = mergeGeometries(
      grp.geos.map((g) => normalizeForMerge(g, grp.color)),
      false,
    );
    for (const g of grp.geos) g.dispose();
    if (!merged) continue;
    if (grp.worldUv) worldUV(merged);
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const mesh = new Mesh(merged, grp.material);
    mesh.castShadow = grp.cast;
    mesh.receiveShadow = grp.receive;
    mesh.layers.mask = grp.layers;
    mesh.renderOrder = grp.renderOrder;
    mesh.frustumCulled = grp.culled;
    mesh.matrixAutoUpdate = false;
    mesh.name = `batch:${grp.material.name || grp.material.type}`;
    mesh.userData.pocketAtlas = { sources: [...grp.sources].sort() };
    root.add(mesh);
    after++;
  }
  return { before, after };
}
