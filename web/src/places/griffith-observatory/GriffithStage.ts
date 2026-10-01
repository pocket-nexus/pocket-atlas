import { Color, FogExp2, HemisphereLight, PerspectiveCamera, Vector3 } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { Baker } from "../shared/bake";
import type { Box6, Shot, ShotKey } from "../shared/camera";
import { batchStatic, bearing } from "../shared/geo";
import { createPlacePost, type PostLook } from "../shared/post";
import type { Sky } from "../shared/sky";
import { PlaceStage } from "../shared/stage";
import { GriffithAudio } from "./audio";
import { GriffithWorld } from "./world/context";
import { GEO, LOOP, SUN, SUN_DIR, VIEW } from "./world/layout";
import { buildObservatory } from "./world/observatory";
import { BLUE_HOUR, buildBlueHourSky } from "./world/sky";
import { buildVista } from "./world/vista";

/** A shot key from an eye position, a compass heading and a pitch (degrees). */
function key(pos: [number, number, number], heading: number, pitch: number, fov: number): ShotKey {
  const d = bearing(heading, pitch);
  return { pos, target: [pos[0] + d.x * 100, pos[1] + d.y * 100, pos[2] + d.z * 100], fov };
}

const L = VIEW.lawn;
const T = VIEW.terrace;
const S = VIEW.sign;
const O = VIEW.overlook;

const SHOTS: Shot[] = [
  {
    // O1: the front lawn on the axis, the lit north façade and the three domes (p04).
    name: "Lawn",
    from: key([L.x + 0.6, L.eye, L.z - 3], 180.5, 4, L.fov),
    to: key([L.x, L.eye, L.z], 180, 4, L.fov),
    duration: 12,
  },
  {
    // O2: the upper west terrace, the basin carpet and downtown at 150° (p09, p11).
    name: "Terrace",
    from: key([T.x, T.eye, T.z], 146, -3, T.fov),
    to: key([T.x + 0.4, T.eye, T.z + 0.3], 153, -3, T.fov),
    duration: 12,
  },
  {
    // O3: the Hollywood Sign and the Mt Lee tower over the west lawn (p13, p22).
    name: "Sign",
    from: key([S.x, S.eye, S.z], 311.2, 3, 14),
    to: key([S.x - 0.5, S.eye, S.z - 0.3], 312.4, 3.1, 14),
    duration: 10,
  },
  {
    // O4: Tiffany & Co. Foundation Overlook, telephoto: the domes against downtown (p02).
    name: "Overlook",
    from: key([O.x, O.eye, O.z], 151.2, -1.1, O.fov),
    to: key([O.x + 1.5, O.eye, O.z], 151.8, -1.0, O.fov),
    duration: 12,
  },
  {
    // The drum from the hillside lookout below the west terrace (p01); area A places it on the terrain.
    name: "Drum",
    from: key([-58, -8, 24], 66, 14, 40),
    to: key([-56, -8, 22], 70, 14, 40),
    duration: 11,
  },
  {
    // The east roof terrace looking south-south-west: downtown left, the uplit drum right (p14).
    name: "Roof",
    from: key([24, 10.5, 9], 204, -4, 40),
    to: key([23, 10.5, 10], 198, -4, 40),
    duration: 11,
  },
];

/** Camera volumes: the lawn and walks, the terraces and roof decks, the hillside lookout, the overlook. */
const WALKABLE: Box6[] = [
  [-60, 0.5, -170, 60, 6, -30],
  [-50, 0, -40, 50, 14, 40],
  [-90, -20, -10, -40, 0, 50],
  [-500, 30, -930, -460, 45, -890],
];
const FOCUS: Box6 = [-80, -30, -120, 80, 40, 60];
const INTRO_FROM: ShotKey = { pos: [-300, 420, -1800], target: [0, 10, 0], fov: 30 };

/** Blue-hour finish: placeholder until area C grades it against the photos. */
const LOOK: PostLook = {
  tone: "agx",
  ao: { radius: 0.8, intensity: 2.0, color: [0, 0, 0] },
  bloom: { threshold: 1.0, smoothing: 0.6, intensity: 0.6, radius: 0.7, levels: 7 },
  grade: { grain: 0.015, vignette: 0.25, lift: [0.01, 0.012, 0.025], gain: [1.0, 0.98, 1.0], saturation: 1.05, contrast: 1.05 },
};

export class GriffithStage extends PlaceStage<GriffithWorld, GriffithAudio> {
  private sky!: Sky;

  private constructor(ctx: StageContext, place: PlaceDef) {
    super(ctx, place, new PerspectiveCamera(40, 1, 0.3, 120000), { shots: SHOTS, walkable: WALKABLE, focus: FOCUS, intro: INTRO_FROM, introSeconds: 8, viewFov: 40 }, new GriffithAudio());
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<GriffithStage> {
    const s = new GriffithStage(ctx, place);
    await s.build(progress);
    return s;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx;
    renderer.shadowMap.enabled = false;
    this.scene.fog = new FogExp2(BLUE_HOUR.horizon.clone(), 0.00002);
    this.scene.background = BLUE_HOUR.zenith.clone();

    await progress(0.05, "Pouring the concrete");
    this.baker = new Baker(renderer);
    const world = (this.world = new GriffithWorld(this.baker, quality));

    await progress(0.2, "Raising the domes");
    buildObservatory(world);

    await progress(0.45, "Lighting the basin");
    buildVista(world);

    await progress(0.7, "Waiting for blue hour");
    this.sky = buildBlueHourSky(world);
    world.root.add(new HemisphereLight(new Color(0.06, 0.08, 0.16), new Color(0.03, 0.025, 0.02), 1.0));

    await progress(0.8, "Batching geometry");
    const stats = batchStatic(world.root);
    console.info(`[griffith] batched ${stats.before} meshes into ${stats.after}`);
    this.scene.add(world.root);

    await progress(0.88, "Capturing the terrace");
    this.captureProbe(new Vector3(0, 6, -40), { near: 0.3, far: 60000, intensity: 0.4 });

    await progress(0.94, "Grading the evening");
    this.post = createPlacePost(renderer, this.scene, this.camera, quality, LOOK);
    this.startRig();
    await progress(1, "Lights on");
    if (this.ctx.params.exporting) this.exposeGriffithExport();
  }

  /** `window.pocketAtlasExport()` → glTF and environment for the cooker. */
  private exposeGriffithExport(): void {
    this.exposeExport({
      seconds: LOOP,
      meta: (c, seconds) => ({
        version: c.version,
        units: c.units,
        up: c.up,
        kind: this.place.kind,
        geo: {
          lat: GEO.lat,
          lon: GEO.lon,
          datum: GEO.datum,
          address: GEO.address,
          note: "origin at the planetarium dome's centre; +X east, −Z north; y above the front lawn (346.0 m above sea level); sea level at y = −346",
        },
        sun: { azimuth: SUN.azimuth, elevation: SUN.elevation, direction: SUN_DIR.toArray(), note: "below the horizon: no sun light, sky only" },
        fog: c.fog,
        hemisphere: c.hemisphere,
        directionalLights: c.directionalLights,
        environment: c.environment,
        camera: c.camera,
        ...c.special,
        tracks: c.tracks,
        loop: { seconds },
        post: this.postMeta(),
      }),
    });
  }

  protected advance(dt: number, time: number): void {
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
  }
}
