import { Color, FogExp2, HemisphereLight, PerspectiveCamera, Vector3 } from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { Atlas } from "../shared/atlas";
import { Baker } from "../shared/bake";
import type { Box6, Shot, ShotKey } from "../shared/camera";
import { batchStatic, bearing } from "../shared/geo";
import { createPlacePost, type PostLook } from "../shared/post";
import { buildSky, skyColor, type Sky, type SkySpec } from "../shared/sky";
import { PlaceStage } from "../shared/stage";
import { AkibaAudio } from "./audio";
import { DuskLib } from "./gfx/materials";
import { AkibaWorld } from "./world/context";
import { buildFar } from "./world/far";
import { buildGround } from "./world/ground";
import { buildKaikan } from "./world/kaikan";
import { GEO, SUN, VIEW } from "./world/layout";
import { buildNeighbours } from "./world/neighbours";
import { buildPeople } from "./world/people";
import { buildProps } from "./world/props";

const A = VIEW.arrival;
const B = VIEW.frontal;

const SHOTS: Shot[] = [
  {
    // Viewpoint A: out of the Electric Town South exit, looking ~250° down the street.
    name: "Arrival",
    from: { pos: [A.x + 0.9, A.y, A.z + 0.3], target: [-18.3, 6.4, 4.4], fov: 50 },
    to: { pos: [A.x - 0.6, A.y, A.z + 0.5], target: [-19.5, 6.6, 4.0], fov: 50 },
    duration: 12,
  },
  {
    // Viewpoint B: frontal from the north sidewalk, tilted up the facade.
    name: "Facade",
    from: { pos: [B.x - 2.2, 1.55, B.z - 1.1], target: [-11.6, 15.5, 0], fov: 66 },
    to: { pos: [B.x - 2.6, 1.55, B.z - 1.3], target: [-11.6, 19.5, 0], fov: 68 },
    duration: 12,
  },
  {
    name: "Band",
    from: { pos: [-1.4, 1.62, -7.4], target: [-12.6, 6.6, 0.3], fov: 50 },
    to: { pos: [-2.6, 1.62, -6.9], target: [-13.4, 6.8, 0.3], fov: 50 },
    duration: 11,
  },
  {
    name: "Vista",
    from: { pos: [6.0, 1.55, -9.0], target: [-80, 7.0, -8.0], fov: 40 },
    to: { pos: [4.2, 1.55, -9.2], target: [-80, 7.0, -8.0], fov: 40 },
    duration: 11,
  },
  {
    // From the zebra crossing east of the NE corner, up the corner (the research's c1 angle).
    name: "Corner",
    from: { pos: [7.4, 1.6, -9.6], target: [-10.5, 15.5, 1.5], fov: 58 },
    to: { pos: [6.6, 1.6, -10.4], target: [-11.0, 16.5, 1.5], fov: 58 },
    duration: 11,
  },
  {
    name: "Clock",
    from: { pos: [23.5, 1.45, -14.2], target: [-6, 5.0, -6.0], fov: 46 },
    to: { pos: [22.2, 1.45, -14.0], target: [-6, 5.2, -6.0], fov: 46 },
    duration: 10,
  },
];

/** Camera volumes: the street between the building lines, the footway north, Chuo-dori, the plaza. */
const WALKABLE: Box6[] = [
  [-62, 0.4, -18.4, 44, 26, 0.6],
  [-20.4, 0.4, -60, -17.2, 9, -18.4],
  [-93, 0.4, -60, -60, 20, 60],
  [36, 0.4, -30, 70, 20, 30],
];
const FOCUS: Box6 = [-110, -1, -120, 80, 50, 60];
const INTRO_FROM: ShotKey = { pos: [26, 58, -10], target: [-14, 2, -4], fov: 46 };

/**
 * Blue-hour finish: ambient occlusion for the contact shadows the sky probe
 * cannot give, a wide bloom that LED signage and lamp globes drive
 * (threshold just above white), AgX tone mapping (saturated signs roll off
 * to white instead of clipping) and a grade with cool shadows and warm
 * highlights.
 */
const LOOK: PostLook = {
  tone: "agx",
  ao: { radius: 1.0, intensity: 2.4, color: [0.0, 0.0, 0.02] },
  bloom: { threshold: 1.0, smoothing: 0.45, intensity: 0.95, radius: 0.72, levels: 8 },
  grade: { grain: 0.022, vignette: 0.32, lift: [0.05, 0.22, 0.55], gain: [1.06, 1.0, 0.92], saturation: 1.16, contrast: 1.1 },
  aberration: { offset: [0.0004, 0.0003], modulationOffset: 0.3 },
};
const ENV_AT = new Vector3(-10, 2.6, -9.2);

/**
 * Blue hour, mid-October: the sun 5° below the horizon almost straight down
 * the street (azimuth 262°), the sky deep blue overhead with an amber band
 * over Chuo-dori. Light on the street is artificial: signage, backlit
 * windows, shopfronts and lamps.
 */
export const DUSK: SkySpec = {
  zenith: new Color(0.008, 0.024, 0.095),
  horizon: new Color(0.085, 0.1, 0.175),
  ground: new Color(0.03, 0.03, 0.04),
  gradientPower: 0.5,
  groundBlend: 6,
  sun: bearing(SUN.azimuth, SUN.elevation),
  sunColor: new Color(1.0, 0.42, 0.16),
  glow: { intensity: 0.33, wide: [0.33, 8], tight: [1, 36] },
  twilight: {
    band: { color: new Color(0.42, 0.19, 0.06), height: 0.075, sunBias: 0.85, sunPower: 2.2 },
    belt: { color: new Color(0.07, 0.035, 0.065), elevation: 0.14, width: 0.09, power: 1.5 },
    shadow: { strength: 0.35, height: 0.07, power: 1.6 },
  },
};

export class AkibaStage extends PlaceStage<AkibaWorld, AkibaAudio> {
  private lib!: DuskLib;
  private sky!: Sky;

  private constructor(ctx: StageContext, place: PlaceDef) {
    super(ctx, place, new PerspectiveCamera(46, 1, 0.1, 4000), { shots: SHOTS, walkable: WALKABLE, focus: FOCUS, intro: INTRO_FROM, introSeconds: 7.5, viewFov: 46 }, new AkibaAudio(ctx.audio));
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<AkibaStage> {
    const s = new AkibaStage(ctx, place);
    await s.build(progress);
    return s;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx;
    RectAreaLightUniformsLib.init();
    renderer.shadowMap.enabled = false;

    this.scene.fog = new FogExp2(new Color(0.055, 0.065, 0.11), 0.0024);
    this.scene.background = DUSK.zenith.clone();

    await progress(0.04, "Baking pavers and cladding");
    this.baker = new Baker(renderer);
    const lib = (this.lib = new DuskLib(this.baker, quality));
    lib.bakeAll();
    // Cell sizes are in 4096-atlas pixels; the 16 px border scales with them.
    const big = quality.textureSize >= 2048;
    const atlas = new Atlas(big ? 4096 : 2048, { packer: "skyline", pad: big ? 16 : 8 });
    const art = new Atlas(big ? 4096 : 2048, { packer: "skyline", pad: big ? 16 : 8 });
    const letters = new Atlas(2048, { transparent: true });
    const world = (this.world = new AkibaWorld(lib, atlas, art, letters));

    await progress(0.18, "Laying the street");
    buildGround(world);

    await progress(0.28, "Raising Radio Kaikan");
    buildKaikan(world);

    await progress(0.44, "Lighting the neighbours");
    buildNeighbours(world);

    await progress(0.56, "Lamps, bollards and the clock");
    buildProps(world);

    await progress(0.62, "The viaduct and the towers");
    buildFar(world);

    await progress(0.66, "People on the street");
    buildPeople(world);

    await progress(0.7, "Blue hour");
    this.sky = buildSky(world.root, DUSK);
    // Sky light: the twilight dome averaged over the upper hemisphere, cool; the ground bounce is faint.
    const hemiSky = skyColor(DUSK, new Vector3(0, 1, 0)).add(skyColor(DUSK, new Vector3(-0.7, 0.5, 0.2).normalize())).add(skyColor(DUSK, new Vector3(0.7, 0.4, -0.2).normalize())).multiplyScalar(1 / 3);
    world.root.add(new HemisphereLight(hemiSky.multiplyScalar(1.8), new Color(0.04, 0.036, 0.036), 1.0));

    await progress(0.76, "Batching geometry");
    const stats = batchStatic(world.root);
    console.info(`[akiba] batched ${stats.before} meshes into ${stats.after}; atlas ${Math.round(atlas.fill * 100)}%, art ${Math.round(art.fill * 100)}%`);
    this.scene.add(world.root);

    await progress(0.86, "Capturing the street");
    // The signs and the train stand where the clock starts.
    this.captureProbe(ENV_AT, {
      near: 0.1,
      far: 3000,
      intensity: 0.35,
      before: () => {
        for (const u of this.world.updaters) u(0, this.ctx.params.startTime);
      },
    });

    await progress(0.92, "Grading the dusk");
    this.post = createPlacePost(renderer, this.scene, this.camera, quality, LOOK);
    this.startRig();
    await progress(1, "Signs on");
    if (this.ctx.params.exporting) this.exposeAkibaExport();
  }

  /** `window.pocketAtlasExport()` → glTF and environment for the cooker. */
  private exposeAkibaExport(): void {
    this.exposeExport({
      seconds: 20,
      meta: (c) => ({
        version: c.version,
        units: c.units,
        up: c.up,
        kind: this.place.kind,
        geo: { ...GEO, bearing: 0, origin: "Radio Kaikan's NE corner at sidewalk level; +X east, −Z north, y up (metres)" },
        sun: { azimuth: SUN.azimuth, elevation: SUN.elevation, direction: DUSK.sun.toArray(), note: "below the horizon: no sun light, sky only" },
        fog: c.fog,
        hemisphere: c.hemisphere,
        directionalLights: c.directionalLights,
        rectLights: c.rectLights,
        fogLights: c.fogLights,
        environment: c.environment,
        camera: c.camera,
        ...c.special,
        tracks: c.tracks,
        post: this.postMeta(),
        // The street canyon darkens toward the ground; lamp pools keep their shape (edge splits to 0.5 m where the camera goes, coarser with distance).
        bake: { skyOcclusion: { rays: 48, reach: 6, foliage: 0.6, minEdge: 0.5, rounds: 6, abs: 0.002, rel: 0.18, grow: 0.25 } },
      }),
    });
  }

  protected advance(dt: number, time: number): void {
    this.lib.clock.uTime.value = time;
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.audio.update(dt, time, this.camera);
  }
}
