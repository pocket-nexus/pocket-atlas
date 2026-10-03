import { Group, Mesh, type BufferGeometry, type Material, type Object3D } from "three";
import type { Quality } from "../../../core/quality";
import { Rng } from "../../../core/random";
import type { Atlas, AtlasRect } from "../../shared/atlas";
import type { Ctx } from "../../shared/canvas";
import type { ExportFogLight } from "../../shared/export";
import type { DayLib } from "../../shared/daylight/materials";

export type Updater = (dt: number, t: number) => void;

/** Everything a Lombard builder needs, and where it registers what it makes. */
export class LombardWorld {
  readonly root = new Group();
  readonly updaters: Updater[] = [];
  shadowsDirty = false;
  /** No lamps are lit on this summer morning; kept for the exporter's shape. */
  readonly fogLights: ExportFogLight[] = [];
  readonly lib: DayLib;
  readonly atlas: Atlas;
  readonly quality: Quality;
  readonly rng: Rng;
  /** Shared atlas materials: printed plates and signs, and backlit displays. */
  readonly printed: Material;
  readonly lit: Material;

  constructor(lib: DayLib, atlas: Atlas, quality: Quality, seed: number) {
    this.lib = lib;
    this.atlas = atlas;
    this.quality = quality;
    this.rng = new Rng(seed);
    this.root.name = "world";
    this.printed = lib.printed("atlas", atlas.texture, 0.5);
    this.lit = lib.printed("atlas-lit", atlas.texture, 0.3, 0.55);
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

  /** Paints (once per key) a cell of the shared 1024² atlas; sizes are in 4096-atlas pixels. */
  draw(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    return this.atlas.shared(key, w, h, paint);
  }

  update(fn: Updater): void {
    this.updaters.push(fn);
  }
}
