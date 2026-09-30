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

function normalizeForMerge(g: BufferGeometry): BufferGeometry {
  let out = g;
  if (!out.index) {
    const n = out.getAttribute("position").count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    out.setIndex(new BufferAttribute(idx, 1));
  }
  for (const name of Object.keys(out.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") out.deleteAttribute(name);
  }
  if (!out.getAttribute("normal")) out.computeVertexNormals();
  if (!out.getAttribute("uv")) {
    out.setAttribute("uv", new Float32BufferAttribute(new Float32Array(out.getAttribute("position").count * 2), 2));
  }
  out.morphAttributes = {};
  out.clearGroups();
  return out;
}

/**
 * Collapses every static, single-material mesh under `root` into one mesh per
 * (material, shadow flags, layer mask). Authoring stays object-by-object while
 * the frame (and the planar reflection pass) pays a few dozen draw calls.
 * Meshes with `userData.dynamic` are left alone.
 */
export function batchStatic(root: Object3D): { before: number; after: number } {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { material: Material; cast: boolean; receive: boolean; layers: number; renderOrder: number; geos: BufferGeometry[]; worldUv: boolean }>();
  const remove: Mesh[] = [];
  let before = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    if (m.userData.dynamic || Array.isArray(m.material)) return;
    let skip = false;
    for (let p: Object3D | null = m.parent; p; p = p.parent) if (p.userData.dynamic) skip = true;
    if (skip) return;
    before++;
    const mat = m.material as Material;
    const key = `${mat.uuid}|${m.castShadow}|${m.receiveShadow}|${m.layers.mask}|${m.renderOrder}`;
    let grp = groups.get(key);
    if (!grp) {
      grp = { material: mat, cast: m.castShadow, receive: m.receiveShadow, layers: m.layers.mask, renderOrder: m.renderOrder, geos: [], worldUv: !!mat.userData.worldUV };
      groups.set(key, grp);
    }
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    grp.geos.push(normalizeForMerge(g));
    remove.push(m);
  });
  for (const m of remove) m.removeFromParent();
  let after = 0;
  for (const grp of groups.values()) {
    const merged = mergeGeometries(grp.geos, false);
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
    mesh.matrixAutoUpdate = false;
    mesh.name = `batch:${grp.material.name || grp.material.type}`;
    root.add(mesh);
    after++;
  }
  return { before, after };
}
