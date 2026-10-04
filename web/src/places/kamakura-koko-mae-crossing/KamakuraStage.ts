import { DirectionalLight, FogExp2, HemisphereLight, Object3D, PCFShadowMap, PerspectiveCamera, Vector3, type Texture } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { Atlas } from "../shared/atlas";
import { Baker } from "../shared/bake";
import type { Box6, Shot, ShotKey } from "../shared/camera";
import { batchStatic, bearing } from "../shared/geo";
import { createPlacePost, type PostLook } from "../shared/post";
import type { Sky } from "../shared/sky";
import { PlaceStage } from "../shared/stage";
import { KamakuraAudio } from "./audio";
import { CoastLib } from "./gfx/materials";
import { buildBuildings } from "./world/buildings";
import { buildCoast } from "./world/coast";
import { KamakuraWorld } from "./world/context";
import { buildCrossing, type CrossingState } from "./world/crossing";
import { buildFar } from "./world/far";
import { COAST, GEO, LOOP, PLATFORM, SUN, VIEW } from "./world/layout";
import { buildPeople } from "./world/people";
import { buildProps } from "./world/props";
import { buildSea } from "./world/sea";
import { bakeClouds, buildDaySky, DAYLIGHT, SKY } from "./world/sky";
import { buildSlope } from "./world/slope";
import { buildTerrain, hillY } from "./world/terrain";
import { buildTraffic } from "./world/traffic";
import { buildTrain, TRAIN } from "./world/train";

/** A shot key from an eye position, a compass heading and a pitch (degrees). */
function key(pos: [number, number, number], heading: number, pitch: number, fov: number): ShotKey {
  const d = bearing(heading, pitch);
  return { pos, target: [pos[0] + d.x * 100, pos[1] + d.y * 100, pos[2] + d.z * 100], fov };
}

const sidewalk = (x: number, z: number, s: number, eye = 1.6): [number, number, number] => {
  const p = COAST.offset(COAST.project(x, z), s, new Vector3());
  return [p.x, 0.21 + eye, p.z];
};

/** An eye over the hillside ground. */
const onHill = (x: number, z: number, eye = 1.6): [number, number, number] => [x, hillY(x, z) + eye, z];

const C = VIEW.crossing;
const PC = VIEW.postcard;
const PL = VIEW.platform;
const R = VIEW.route134;
const SW = VIEW.seawall;
const PK = VIEW.park;

const SHOTS: Shot[] = [
  {
    // The canonical view: 51 m up the slope, eye 17.0 m T.P., heading 183°, tilted 3.4° down,
    // 18° vertical (p01): the horizon 32 % down the frame, the crossing band about 73 %.
    name: "Crossing",
    from: key([C.x - 0.4, 6.9, C.z - 2.5], 183.2, -3.4, 18),
    to: key([C.x, 6.8, C.z], 183, -3.4, 18),
    duration: 12,
  },
  {
    name: "Postcard",
    from: key([PC.x + 0.5, 8.45, PC.z - 1.5], 178.4, -4.7, 17),
    to: key([PC.x, 8.4, PC.z], 177.8, -4.6, 17),
    duration: 11,
  },
  {
    name: "Platform",
    from: key([PL.x - 1.5, PLATFORM.height + 1.6, PL.z + 0.3], 96.2, -0.6, 22),
    to: key([PL.x, PLATFORM.height + 1.6, PL.z], 96.7, -0.8, 22),
    duration: 11,
  },
  {
    name: "Route134",
    from: key(sidewalk(R.x - 2, R.z, 6.0), 86, 2.0, 40),
    to: key(sidewalk(R.x, R.z, 6.0), 84, 2.5, 40),
    duration: 10,
  },
  {
    name: "Seawall",
    from: key(sidewalk(SW.x + 1.5, SW.z, 18.0), 350, 3.7, 40),
    to: key(sidewalk(SW.x, SW.z, 18.0), 349, 3.7, 40),
    duration: 11,
  },
  {
    name: "Park",
    from: key(onHill(PK.x - 0.8, PK.z - 0.6), 136, -5.4, 40),
    to: key(onHill(PK.x, PK.z), 135, -5.4, 40),
    duration: 10,
  },
];

/** Camera volumes: the slope road, the crossing corners, the Route 134 sidewalk and sea wall, the platform, the park. */
const WALKABLE: Box6[] = [
  [-6, 0.8, -70, 7, 14, -2],
  [-14, 0.8, -12, 9, 8, 4],
  [-60, 1.0, -8, 60, 6, 20],
  [-172, 2.0, -16, -104, 6, -9],
  [-31, 2.0, -26, -5, 7, -10],
];
const FOCUS: Box6 = [-200, -12, -150, 200, 40, 300];

/**
 * Seaside daylight finish: ambient occlusion for contact shadows the sky
 * probe cannot give (neutral, so it darkens paint and asphalt without
 * tinting them), a restrained bloom for the lit crossing lamps and sun
 * glints, ACES tone mapping and a clear, slightly cool summer grade.
 */
const LOOK: PostLook = {
  tone: "aces",
  ao: { radius: 0.9, intensity: 2.6, color: [0, 0, 0] },
  bloom: { threshold: 1.5, smoothing: 0.5, intensity: 0.4, radius: 0.6, levels: 7 },
  grade: { grain: 0.01, vignette: 0.22, lift: [0.04, 0.05, 0.07], gain: [1.03, 1.0, 0.95], saturation: 1.12, contrast: 1.08 },
};
const INTRO_FROM: ShotKey = { pos: [30, 55, 170], target: [0, 4, -30], fov: 34 };

export class KamakuraStage extends PlaceStage<KamakuraWorld, KamakuraAudio> {
  private sky!: Sky;
  private clouds!: Texture;
  private sunDir = bearing(SUN.azimuth, SUN.elevation);
  private crossing!: CrossingState;

  private constructor(ctx: StageContext, place: PlaceDef) {
    super(ctx, place, new PerspectiveCamera(24, 1, 0.4, 30000), { shots: SHOTS, walkable: WALKABLE, focus: FOCUS, intro: INTRO_FROM, introSeconds: 8 }, new KamakuraAudio(ctx.audio));
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<KamakuraStage> {
    const s = new KamakuraStage(ctx, place);
    await s.build(progress);
    return s;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx;
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;

    // Sea haze: FogExp2 that leaves the land near the crossing clear, takes a
    // quarter of the light at Hayama (10 km), half at the 15.8 km horizon and
    // three quarters at Jogashima (22 km).
    this.scene.fog = new FogExp2(SKY.horizon.clone().multiplyScalar(0.97), 0.000052);
    this.scene.background = SKY.horizon.clone();

    await progress(0.04, "Mixing the asphalt");
    this.baker = new Baker(renderer);
    const lib = new CoastLib(this.baker, quality);
    lib.bakeAll();
    const atlas = new Atlas(2048);
    const world = (this.world = new KamakuraWorld(lib, atlas, quality));

    await progress(0.14, "Growing summer cumulus");
    // Fair-weather cumulus over the hills and the far peninsulas, few over the bay.
    this.clouds = bakeClouds(this.baker, this.sunDir, quality.level === "high" || quality.level === "ultra" ? 2048 : 1024);

    await progress(0.24, "Filling Sagami Bay");
    buildSea(world, this.baker);
    buildFar(world);

    await progress(0.34, "Laying the Enoden");
    buildCoast(world);
    this.crossing = buildCrossing(world);

    await progress(0.44, "Climbing the slope");
    buildTerrain(world);
    buildSlope(world);

    await progress(0.54, "Building the villas");
    buildBuildings(world);

    await progress(0.62, "Stringing the wires");
    buildProps(world);

    await progress(0.68, "Running the trains");
    buildTrain(world);
    buildTraffic(world);
    buildPeople(world);
    this.sky = buildDaySky(world, this.sunDir, this.clouds);
    this.addLights();

    await progress(0.76, "Batching geometry");
    const stats = batchStatic(world.root, { preserveObjects: this.ctx.params.exporting });
    console.info(`[kamakura] batched ${stats.before} meshes into ${stats.after}; ${lib.count} materials`);
    this.scene.add(world.root);

    await progress(0.86, "Capturing the sky");
    // The probe sees a less saturated upper sky (see DAYLIGHT); the dome keeps its own.
    this.captureProbe(new Vector3(0, 4, 9), {
      near: 0.3,
      far: 30000,
      intensity: DAYLIGHT.environmentIntensity,
      before: () => this.sky.setProbe(DAYLIGHT.probeSky),
      after: () => this.sky.setProbe(0),
    });

    await progress(0.93, "Grading the afternoon");
    this.post = createPlacePost(renderer, this.scene, this.camera, quality, LOOK);
    this.startRig();
    await progress(1, "Waiting for the bell");
    if (this.ctx.params.exporting) this.exposeKamakuraExport();
  }

  /**
   * The sun is a real directional light (exported as a glTF directional
   * light) whose orthographic shadow covers the crossing, the slope road up
   * to the canonical camera and the strip along Route 134; the hemisphere
   * and the captured probe fill the shade.
   */
  private addLights(): void {
    const q = this.ctx.quality;
    const sun = (this.sun = new DirectionalLight(DAYLIGHT.sunColor, DAYLIGHT.sunIntensity));
    sun.name = "sun";
    const center = new Vector3(0, 2, -22);
    sun.position.copy(center).addScaledVector(this.sunDir, 160);
    sun.lookAt(center);
    const target = new Object3D();
    target.name = "sun-target";
    target.position.set(0, 0, -1);
    sun.add(target);
    sun.target = target;
    sun.castShadow = q.shadows;
    const size = q.level === "high" || q.level === "ultra" ? 4096 : q.shadowMapSize;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 1.4;
    this.fitSunShadow(sun, [-48, 52], [-9, 26], [-78, 26]);
    this.world.root.add(sun);
    // Hemisphere: grey-blue sky fill from above, sunlit asphalt and sand below.
    this.world.root.add(new HemisphereLight(DAYLIGHT.hemiSky, DAYLIGHT.hemiGround, DAYLIGHT.hemiIntensity));
    // A bright, slightly hazy afternoon: a touch under unit exposure keeps the
    // white villas and the cream train out of the shoulder of the ACES curve.
    this.ctx.renderer.toneMappingExposure = DAYLIGHT.exposure;
  }

  /** `window.pocketAtlasExport()` → glTF, sky probe and cloud panorama for the cooker. */
  private exposeKamakuraExport(): void {
    this.exposeExport({
      seconds: LOOP,
      files: [{ name: "sky-clouds.png", texture: this.clouds }],
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
          note: "origin at the crossing on the rail; +X east, −Z north; y above the rail (10.2 m T.P.); the sea at y = −10.2",
        },
        sun: { azimuth: SUN.azimuth, elevation: SUN.elevation, direction: [this.sunDir.x, this.sunDir.y, this.sunDir.z] },
        fog: c.fog,
        hemisphere: c.hemisphere,
        directionalLights: c.directionalLights,
        environment: c.environment,
        camera: c.camera,
        ...c.special,
        tracks: c.tracks,
        loop: { seconds, train: TRAIN.summary },
        post: this.postMeta(),
        // The cooker's vertex bake stands in for N8AO (radius 0.9 m): sky occlusion by ray casts within 1.5 m.
        bake: { skyOcclusion: { rays: 48, reach: 1.5, foliage: 0.55 } },
      }),
    });
  }

  protected advance(dt: number, time: number): void {
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.audio.update(dt, time, this.camera, this.crossing);
  }
}
