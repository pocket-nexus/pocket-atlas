import { BufferAttribute, Color, Object3D, PlaneGeometry, PointLight, RectAreaLight, SpotLight, Vector3, type BufferGeometry } from "three";
import type { AtlasRect } from "../../shared/atlas";
import type { AkibaWorld } from "./context";

/** Plane (facing +z) whose UVs sample the sub-rectangle [a, b] × [c, d] (fractions, v up) of an atlas cell. */
export function cellPlane(w: number, h: number, r: AtlasRect, a = 0, b = 1, c = 0, d = 1): PlaneGeometry {
  const g = new PlaneGeometry(w, h);
  const uv = g.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const u = a + uv.getX(i) * (b - a);
    const v = c + uv.getY(i) * (d - c);
    uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
  }
  return g;
}

/** Rotates a geometry to face −Z (toward the street from a south-side facade) about its own origin. */
export function facingNorth(g: BufferGeometry): BufferGeometry {
  g.rotateY(Math.PI);
  return g;
}

/**
 * A spot light aimed at `target` whose direction survives the glTF export:
 * the light looks along its −Z and its target is a child at (0, 0, −1).
 */
export function spot(w: AkibaWorld, color: number | Color, intensity: number, distance: number, angle: number, penumbra: number, pos: Vector3, target: Vector3): SpotLight {
  const s = new SpotLight(color, intensity, distance, angle, penumbra, 2);
  s.position.copy(pos);
  w.root.add(s);
  s.lookAt(target);
  const t = new Object3D();
  t.position.set(0, 0, -1);
  s.add(t);
  s.target = t;
  return s;
}

export function point(w: AkibaWorld, color: number | Color, intensity: number, distance: number, pos: Vector3): PointLight {
  const p = new PointLight(color, intensity, distance, 2);
  p.position.copy(pos);
  w.root.add(p);
  return p;
}

/** Rectangular emitter (exported as `rectLights`, baked by the cooker) facing `toward`. */
export function rect(w: AkibaWorld, color: number | Color, intensity: number, width: number, height: number, pos: Vector3, toward: Vector3): RectAreaLight {
  const r = new RectAreaLight(color, intensity, width, height);
  r.position.copy(pos);
  w.root.add(r);
  r.lookAt(toward);
  return r;
}

export const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
