import { Group, Mesh, MeshBasicMaterial, type BufferGeometry, type Material, type Object3D } from "three";
import type { Atlas, AtlasRect } from "../../shared/atlas";
import type { Ctx } from "../../shared/canvas";
import type { ExportFogLight } from "../../shared/export";
import type { Sign } from "../../shared/signs";
import { LEVEL, type DuskLib } from "../gfx/materials";

export type Updater = (dt: number, t: number) => void;

/** Everything an Akihabara builder needs, and where it registers what it makes. */
export class AkibaWorld {
  readonly root = new Group();
  readonly updaters: Updater[] = [];
  /** The street has no lit haze pass; kept for the exporter's shape. */
  readonly fogLights: ExportFogLight[] = [];
  readonly lib: DuskLib;
  /** Lit signage and small posters (opaque, 4096² on high and ultra). */
  readonly atlas: Atlas;
  /** Large backlit window artwork, billboards and the shop interiors seen through glass (opaque). */
  readonly art: Atlas;
  /** Channel letters and cut-out signs (alpha-tested). */
  readonly letters: Atlas;
  /** Backlit window artwork (art atlas). */
  readonly poster: MeshBasicMaterial;
  /** Shop interiors behind glass (art atlas): one level, no fog. */
  readonly interior: MeshBasicMaterial;
  /** Lightbox signage by brightness (signage atlas), and the alpha-tested channel letters. */
  readonly sign: MeshBasicMaterial;
  readonly bright: MeshBasicMaterial;
  readonly dim: MeshBasicMaterial;
  readonly mid: MeshBasicMaterial;
  readonly cutoutBright: MeshBasicMaterial;
  /** Red LED letters keep their colour below the tone curve's shoulder. */
  readonly cutoutRed: MeshBasicMaterial;

  constructor(lib: DuskLib, atlas: Atlas, art: Atlas, letters: Atlas) {
    this.lib = lib;
    this.atlas = atlas;
    this.art = art;
    this.letters = letters;
    this.root.name = "world";
    this.poster = lib.lit(art.texture, 1.3, "art");
    this.interior = lib.lit(art.texture, LEVEL.interior, "art-interior", { fog: false });
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

  /** Registers an animated sign: it steps on the place clock with the other updaters. */
  addSign(s: Sign): Sign {
    this.update((_dt, t) => s.update(t));
    return s;
  }

  update(fn: Updater): void {
    this.updaters.push(fn);
  }
}
