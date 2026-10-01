import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import { rod } from "../shapes";

/** Accumulates quads with explicit normals and UVs into one geometry. */
export class QuadBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  /** p0..p3 around the quad; uv per corner; the winding is fixed up to face `n`. */
  quad(p: Vector3[], n: Vector3, uv: [number, number][]): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i].x, p[i].y, p[i].z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(uv[i][0], uv[i][1]);
    }
    const face = new Vector3().subVectors(p[1], p[0]).cross(new Vector3().subVectors(p[2], p[0]));
    if (face.dot(n) >= 0) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  /** Triangle p0 p1 p2 facing `n`. */
  tri(p: Vector3[], n: Vector3, uv: [number, number][]): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < 3; i++) {
      this.pos.push(p[i].x, p[i].y, p[i].z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(uv[i][0], uv[i][1]);
    }
    const face = new Vector3().subVectors(p[1], p[0]).cross(new Vector3().subVectors(p[2], p[0]));
    if (face.dot(n) >= 0) this.idx.push(base, base + 1, base + 2);
    else this.idx.push(base, base + 2, base + 1);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Scales a geometry's 0..1 UVs to metres (u × su, v × sv). */
export function scaleUV(g: BufferGeometry, su: number, sv: number): BufferGeometry {
  const uv = g.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** Straight pipe with UVs in metres. */
export function pipe(a: Vector3, b: Vector3, r: number, radial: number): BufferGeometry {
  return scaleUV(rod(a, b, r, radial), 2 * Math.PI * r, a.distanceTo(b));
}
