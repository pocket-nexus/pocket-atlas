import { Group, Mesh, type BufferGeometry, type Material, type Object3D } from "three";
import type { Quality } from "../../../core/quality";
import type { Baker } from "../../shared/bake";
import type { ExportFogLight } from "../../shared/export";
import { merge } from "../../shared/shapes";

export type Updater = (dt: number, t: number) => void;

/** Collects geometry per (material, casts shadow) and emits one mesh each (static props). */
export class Bag {
  private m = new Map<string, { mat: Material; geos: BufferGeometry[]; cast: boolean }>();
  add(mat: Material, g: BufferGeometry, cast = true): void {
    const key = `${mat.uuid}|${cast}`;
    let e = this.m.get(key);
    if (!e) this.m.set(key, (e = { mat, geos: [], cast }));
    e.geos.push(g);
  }
  emit(w: GriffithWorld, parent: Object3D = w.root): Mesh[] {
    const out: Mesh[] = [];
    for (const e of this.m.values()) out.push(w.mesh(merge(e.geos), e.mat, 0, 0, 0, parent, { cast: e.cast }));
    this.m.clear();
    return out;
  }
}

/** Everything a Griffith builder needs, and where it registers what it makes. */
export class GriffithWorld {
  readonly root = new Group();
  readonly updaters: Updater[] = [];
  /** Lamps whose glow lights the haze (none: the vista haze is the sky's, not the lamps'). */
  readonly fogLights: ExportFogLight[] = [];
  readonly baker: Baker;
  readonly quality: Quality;

  constructor(baker: Baker, quality: Quality) {
    this.baker = baker;
    this.quality = quality;
    this.root.name = "world";
  }

  mesh(geo: BufferGeometry, mat: Material, x = 0, y = 0, z = 0, parent: Object3D = this.root, opts: { cast?: boolean; receive?: boolean; ry?: number } = {}): Mesh {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    if (opts.ry) m.rotation.y = opts.ry;
    m.castShadow = opts.cast ?? true;
    m.receiveShadow = opts.receive ?? true;
    parent.add(m);
    return m;
  }
}
