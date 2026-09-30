import { Color, Group, Mesh, Vector3, type BufferGeometry, type Light, type Material, type Object3D } from "three";
import type { Quality } from "../../core/quality";
import { Rng } from "../../core/random";
import type { Atlas } from "../gfx/atlas";
import type { MaterialLib } from "../gfx/materials";
import type { FogLight } from "../fx/post";

export type Updater = (dt: number, t: number) => void;

/** Everything a world builder needs, and where it registers what it makes. */
export class World {
  readonly root = new Group();
  /** Lights that scatter in the haze and tint nearby rain. */
  readonly fogLights: FogLight[] = [];
  readonly updaters: Updater[] = [];
  /** Axis-aligned volumes where rain must not fall (interiors, canopies). */
  readonly dryBoxes: [Vector3, Vector3][] = [];
  readonly lib: MaterialLib;
  readonly atlas: Atlas;
  readonly quality: Quality;
  readonly rng: Rng;

  constructor(lib: MaterialLib, atlas: Atlas, quality: Quality, seed = 1) {
    this.lib = lib;
    this.atlas = atlas;
    this.quality = quality;
    this.rng = new Rng(seed);
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

  group(x = 0, y = 0, z = 0, ry = 0, parent: Object3D = this.root): Group {
    const g = new Group();
    g.position.set(x, y, z);
    g.rotation.y = ry;
    parent.add(g);
    return g;
  }

  light<T extends Light | Object3D>(l: T, parent: Object3D = this.root): T {
    parent.add(l);
    return l;
  }

  fog(position: Vector3, color: Color | number | string, intensity: number, radius: number, spot?: { direction: Vector3; cosOuter: number; cosInner: number }): FogLight {
    const f: FogLight = {
      position: position.clone(),
      color: new Color(color),
      intensity,
      radius,
      ...(spot ? { direction: spot.direction.clone().normalize(), cosOuter: spot.cosOuter, cosInner: spot.cosInner } : {}),
      gain: 1,
    };
    this.fogLights.push(f);
    return f;
  }

  /** Exhaust vents that puff steam. */
  readonly steamVents: { origin: Vector3; dir: Vector3 }[] = [];

  /** Edges water runs off (fed to the rain's drip streams). */
  readonly dripEdges: [Vector3, Vector3][] = [];

  drip(a: [number, number, number], b: [number, number, number]): void {
    this.dripEdges.push([new Vector3(...a), new Vector3(...b)]);
  }

  dry(min: [number, number, number], max: [number, number, number]): void {
    this.dryBoxes.push([new Vector3(...min), new Vector3(...max)]);
  }

  update(fn: Updater): void {
    this.updaters.push(fn);
  }
}
