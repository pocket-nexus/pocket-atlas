import { Group, Mesh, MeshBasicMaterial, type BufferGeometry, type Light, type Material, type Object3D } from "three";
import type { Quality } from "../../../core/quality";
import { Rng } from "../../../core/random";
import type { Atlas, AtlasRect, SkylineAtlas } from "../../shared/atlas";
import type { Ctx } from "../../shared/canvas";
import type { ExportFogLight } from "../../shared/export";
import type { Sign } from "../../shared/signs";
import type { DuskLib } from "../gfx/materials";

export type Updater = (dt: number, t: number) => void;

/** Everything an Akihabara builder needs, and where it registers what it makes. */
export class AkibaWorld {
  readonly root = new Group();
  readonly updaters: Updater[] = [];
  /** The street has no lit haze pass; kept for the exporter's shape. */
  readonly fogLights: ExportFogLight[] = [];
  readonly lib: DuskLib;
  /** Lit signage, shop interiors and small posters (opaque, 4096² on high and ultra). */
  readonly atlas: SkylineAtlas;
  /** Large backlit window artwork and billboards (opaque). */
  readonly art: SkylineAtlas;
  /** Channel letters and cut-out signs (alpha-tested). */
  readonly letters: Atlas;
  readonly quality: Quality;
  readonly rng: Rng;
  readonly signs: Sign[] = [];
  /** Backlit window artwork (art atlas). */
  readonly poster: MeshBasicMaterial;
  /** Lightbox signage by brightness (signage atlas), and the alpha-tested channel letters. */
  readonly sign: MeshBasicMaterial;
  readonly bright: MeshBasicMaterial;
  readonly dim: MeshBasicMaterial;
  readonly mid: MeshBasicMaterial;
  readonly cutoutBright: MeshBasicMaterial;
  /** Red LED letters keep their colour below the tone curve's shoulder. */
  readonly cutoutRed: MeshBasicMaterial;

  constructor(lib: DuskLib, atlas: SkylineAtlas, art: SkylineAtlas, letters: Atlas, quality: Quality, seed: number) {
    this.lib = lib;
    this.atlas = atlas;
    this.art = art;
    this.letters = letters;
    this.quality = quality;
    this.rng = new Rng(seed);
    this.root.name = "world";
    this.poster = lib.lit(art.texture, 1.3, "art");
    this.sign = lib.lit(atlas.texture, 2.0, "atlas");
    this.bright = lib.lit(atlas.texture, 3.6, "atlas");
    this.dim = lib.lit(atlas.texture, 0.55, "atlas");
    this.mid = lib.lit(atlas.texture, 1.2, "atlas");
    this.cutoutBright = lib.lit(letters.texture, 3.2, "letters", { alphaTest: 0.5 });
    this.cutoutRed = lib.lit(letters.texture, 1.9, "letters", { alphaTest: 0.5 });
  }

  mesh(geo: BufferGeometry, mat: Material, x = 0, y = 0, z = 0, parent: Object3D = this.root, opts: { cast?: boolean; receive?: boolean; ry?: number } = {}): Mesh {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    if (opts.ry) m.rotation.y = opts.ry;
    m.castShadow = opts.cast ?? false;
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

  light<T extends Light>(l: T, parent: Object3D = this.root): T {
    parent.add(l);
    return l;
  }

  /** Paints (once per key) a cell of the signage atlas; sizes are in 4096-atlas pixels. */
  draw(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    return this.atlas.shared(key, w, h, paint);
  }

  /** Paints (once per key) a cell of the artwork atlas. */
  drawArt(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    return this.art.shared(key, w, h, paint);
  }

  /** Paints a cut-out cell (transparent background) of the letters atlas. */
  drawCut(key: string, w: number, h: number, paint: (g: Ctx, w: number, h: number) => void): AtlasRect {
    return this.letters.shared(key, w, h, (g, cw, ch) => {
      g.clearRect(0, 0, cw, ch);
      paint(g, cw, ch);
    });
  }

  addSign(s: Sign): Sign {
    this.signs.push(s);
    return s;
  }

  update(fn: Updater): void {
    this.updaters.push(fn);
  }
}
