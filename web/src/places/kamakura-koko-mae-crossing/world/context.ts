import { Group, Mesh, type BufferGeometry, type Material, type Object3D, type Texture } from "three";
import type { Quality } from "../../../core/quality";
import type { Atlas, AtlasRect } from "../../shared/atlas";
import type { Ctx } from "../../shared/canvas";
import type { ExportFogLight } from "../../shared/export";
import { merge } from "../../shared/shapes";
import { EquipAtlas } from "../gfx/equip";
import { facadeAtlas } from "../gfx/facade";
import type { CoastLib } from "../gfx/materials";

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
  emit(w: KamakuraWorld, parent: Object3D = w.root): Mesh[] {
    const out: Mesh[] = [];
    for (const e of this.m.values()) out.push(w.mesh(merge(e.geos), e.mat, 0, 0, 0, parent, { cast: e.cast }));
    this.m.clear();
    return out;
  }
}

/** Everything a Kamakura builder needs, and where it registers what it makes. */
export class KamakuraWorld {
  readonly root = new Group();
  readonly updaters: Updater[] = [];
  /** No lamps light the haze on a summer afternoon; kept for the exporter's shape. */
  readonly fogLights: ExportFogLight[] = [];
  readonly lib: CoastLib;
  readonly atlas: Atlas;
  readonly quality: Quality;
  /** The equipment atlas: crossing machinery, poles, wires, signs, street furniture and the solid paints. */
  readonly equip: EquipAtlas;
  /** The hillside facades (gfx/facade.ts): 4096² on high and ultra, twice the preset's texture size below. */
  readonly facades: Texture;
  /** Shared atlas materials: printed signs, stripes, markings, boards; and alpha-tested cut-outs. */
  readonly printed: Material;
  readonly cut: Material;

  constructor(lib: CoastLib, atlas: Atlas, quality: Quality) {
    this.lib = lib;
    this.atlas = atlas;
    this.quality = quality;
    this.equip = new EquipAtlas(quality.textureSize >= 2048 ? 2048 : 1024);
    this.facades = facadeAtlas(Math.min(4096, quality.textureSize * 2));
    this.root.name = "world";
    this.printed = lib.printed("atlas", atlas.texture, 0.6);
    this.cut = lib.cutout("atlas", atlas.texture, { rough: 0.6 });
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

  group(x = 0, y = 0, z = 0, ry = 0, parent: Object3D = this.root): Group {
    const g = new Group();
    g.position.set(x, y, z);
    g.rotation.y = ry;
    parent.add(g);
    return g;
  }

  /** Paints (once per key) a cell of the shared atlas; sizes are in 4096-atlas pixels. */
  draw(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    return this.atlas.shared(key, w, h, paint);
  }

  update(fn: Updater): void {
    this.updaters.push(fn);
  }
}
