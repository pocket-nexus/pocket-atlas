import {
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Float32BufferAttribute,
  Mesh,
  PlaneGeometry,
  Quaternion,
  TubeGeometry,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mapUV, type AtlasRect } from "../../gfx/atlas";
import type { Ctx } from "../../gfx/canvas";
import type { MaterialLib } from "../../gfx/materials";

const UP = new Vector3(0, 1, 0);

export function v3(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

/** Straight round bar from `a` to `b` (radius `r` at a, `r2` at b). */
export function rod(a: Vector3, b: Vector3, r: number, radial = 6, r2 = r): BufferGeometry {
  const d = new Vector3().subVectors(b, a);
  const len = d.length();
  const g = new CylinderGeometry(r2, r, len, radial, 1, false);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Smooth tube through control points (bent pipes, bicycle frames, handlebars). */
export function tube(pts: Vector3[], r: number, radial = 6, perMeter = 16): TubeGeometry {
  const c = new CatmullRomCurve3(pts, false, "centripetal");
  const n = Math.max(6, Math.min(80, Math.ceil(c.getLength() * perMeter)));
  return new TubeGeometry(c, n, r, radial, false);
}

/** Point on a `cable()` span: straight lerp minus the parabolic sag. */
export function cablePoint(a: Vector3, b: Vector3, sag: number, t: number): Vector3 {
  const p = new Vector3().lerpVectors(a, b, t);
  p.y -= sag * 4 * t * (1 - t);
  return p;
}

/** Plane facing +z whose UVs sample an atlas cell. */
export function atlasPlane(w: number, h: number, r: AtlasRect): PlaneGeometry {
  return mapUV(new PlaneGeometry(w, h), r) as PlaneGeometry;
}

/** Reverses a geometry's facing (winding and normals) without a negative scale. */
export function flip(g: BufferGeometry): BufferGeometry {
  const idx = g.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
  }
  const n = g.getAttribute("normal");
  if (n) {
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    n.needsUpdate = true;
  }
  return g;
}

/** Single quad (p0 p1 p2 p3 in order around the edge) facing `normal`, UVs 0..1. */
export function quad(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, normal: Vector3): BufferGeometry {
  const g = new BufferGeometry();
  const pos = [p0, p1, p2, p3].flatMap((p) => [p.x, p.y, p.z]);
  const n = normal.clone().normalize();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z], 3));
  g.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  const face = new Vector3().subVectors(p1, p0).cross(new Vector3().subVectors(p2, p0));
  g.setIndex(face.dot(n) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  return g;
}

/** Merges arbitrary generated geometries into one (position/normal/uv only). */
export function merge(geos: BufferGeometry[]): BufferGeometry {
  const list = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") n.deleteAttribute(k);
    if (!n.getAttribute("normal")) n.computeVertexNormals();
    if (!n.getAttribute("uv")) n.setAttribute("uv", new Float32BufferAttribute(new Float32Array(n.getAttribute("position").count * 2), 2));
    n.morphAttributes = {};
    n.clearGroups();
    return n;
  });
  const m = mergeGeometries(list, false);
  if (!m) throw new Error("props: geometry merge failed");
  m.computeBoundingSphere();
  return m;
}

/**
 * Collects pieces per material so a reusable object (bicycle, car) becomes a
 * handful of meshes: one per (material, casts-shadow) pair.
 */
export class Parts {
  private groups = new Map<string, { mat: Material; cast: boolean; geos: BufferGeometry[] }>();

  add(mat: Material, g: BufferGeometry, cast = true): void {
    const key = `${mat.uuid}|${cast}`;
    let e = this.groups.get(key);
    if (!e) {
      e = { mat, cast, geos: [] };
      this.groups.set(key, e);
    }
    e.geos.push(g);
  }

  /** Merged geometry per entry (reusable across instances). */
  bake(): { mat: Material; cast: boolean; geo: BufferGeometry }[] {
    return [...this.groups.values()].map((e) => ({ mat: e.mat, cast: e.cast, geo: merge(e.geos) }));
  }
}

/** Instantiates baked parts under `parent`. */
export function instance(baked: { mat: Material; cast: boolean; geo: BufferGeometry }[], parent: Object3D): Mesh[] {
  return baked.map((b) => {
    const m = new Mesh(b.geo, b.mat);
    m.castShadow = b.cast;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  });
}

/**
 * Signage hooks for the street furniture: keyed cells in the shared world
 * atlas (each key painted once) and the two shared atlas materials, so every
 * plate, sticker and sign merges into the same batches as the buildings'.
 */
export interface Kit {
  /** Paints (once per key) a cell of w×h pixels in the shared atlas. */
  draw(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect;
  /** Passive printed plates and retroreflective film. */
  labels: Material;
  /** Internally lit sign faces. */
  lit: Material;
}

/**
 * The few shared finishes every prop draws from. Each entry is one memoized
 * library material, so everything painted "red" (vending cabinets, post box,
 * cones, crates) collapses into a single batch.
 */
export function palette(lib: MaterialLib) {
  return {
    black: lib.plain(0x0f1011, 0.5),
    galv: lib.paint(0x80868a, 0.4),
    gray: lib.paint(0xa9aeb1, 0.38),
    dark: lib.paint(0x3c3f43, 0.45),
    white: lib.paint(0xe4e4de, 0.38),
    yellow: lib.paint(0xd6a81a, 0.45),
    red: lib.paint(0xc01b18, 0.38),
    blue: lib.paint(0x1c5ab8, 0.35),
    orange: lib.paint(0xe0611b, 0.38),
    porcelain: lib.plain(0xe6e3da, 0.22),
    screen: lib.glow(0x9fe4ff, 1.5),
    chrome: lib.chrome(),
    rubber: lib.rubber(),
  };
}
