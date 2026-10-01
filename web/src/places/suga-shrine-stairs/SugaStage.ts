import { DirectionalLight, FogExp2, HemisphereLight, Object3D, PCFShadowMap, PerspectiveCamera, Vector3, type Texture } from "three";
import type { PlaceDef, Progress, StageContext } from "../../core/types";
import { Atlas } from "../shared/atlas";
import { Baker } from "../shared/bake";
import type { Box6, Shot, ShotKey } from "../shared/camera";
import { batchStatic, bearing } from "../shared/geo";
import { createPlacePost, type PostLook } from "../shared/post";
import type { Sky } from "../shared/sky";
import { PlaceStage } from "../shared/stage";
import { SugaAudio } from "./audio";
import { DayLib } from "./gfx/materials";
import { SugaWorld } from "./world/context";
import { buildFar } from "./world/far";
import { buildHouses } from "./world/houses";
import { BEARING, GEO, stepY, SUN } from "./world/layout";
import { buildProps } from "./world/props";
import { bakeClouds, buildDaySky, SKY } from "./world/sky";
import { buildStairs } from "./world/stairs";
import { buildTerrain } from "./world/terrain";
import { buildTree } from "./world/tree";

const SHOTS: Shot[] = [
  {
    name: "Stairs",
    from: { pos: [0.3, 1.64, 1.1], target: [-0.3, -9.6, -44], fov: 40 },
    to: { pos: [0.25, 1.62, 0.2], target: [-0.35, -10.3, -44], fov: 40 },
    duration: 12,
  },
  {
    name: "Rails",
    from: { pos: [0.34, -0.2, -2.6], target: [-0.08, -7.6, -24], fov: 38 },
    to: { pos: [0.33, -0.62, -3.5], target: [-0.08, -7.9, -24], fov: 38 },
    duration: 10,
  },
  {
    name: "Below",
    from: { pos: [0.15, -5.95, -24.2], target: [-0.5, -0.6, 1], fov: 42 },
    to: { pos: [0.05, -5.95, -22.6], target: [-0.6, -0.2, 1], fov: 42 },
    duration: 11,
  },
  {
    name: "Lane",
    from: { pos: [0.9, -5.85, -67.2], target: [-0.1, -3.7, -8], fov: 34 },
    to: { pos: [0.7, -5.85, -65.2], target: [-0.1, -3.6, -8], fov: 34 },
    duration: 11,
  },
  {
    name: "Canopy",
    from: { pos: [-1.35, 1.66, 0.2], target: [-13, 0.3, -40], fov: 50 },
    to: { pos: [-1.5, 1.66, -0.4], target: [-14, 0.5, -40], fov: 50 },
    duration: 10,
  },
];

/** Camera volumes: the stair head and street, the flight in steps, the lane, the junction. */
const WALKABLE: Box6[] = [
  [-8, 0.4, -0.3, 8, 12, 7],
  ...Array.from({ length: 6 }, (_, i): Box6 => {
    const z1 = -i * 2.6;
    const z0 = z1 - 2.6;
    return [-1.75, stepY(z0) + 0.35, z0, 1.75, 12, z1];
  }),
  [-9, 0.9, -8, -2.6, 10, 0.8],
  [-2.0, -7.1, -64, 2.0, 8, -15.4],
  [-10, -7.1, -71, 10, 8, -61],
];
const FOCUS: Box6 = [-60, -24, -150, 60, 30, 20];
const INTRO_FROM: ShotKey = { pos: [3.5, 36, 14], target: [0, -6, -34], fov: 40 };

/**
 * Daylight finish: ambient occlusion for the contact shadows the sky probe
 * cannot give, a restrained bloom for sun glints and the sun disc, ACES tone
 * mapping and a clean, saturated summer grade. No chromatic aberration: it
 * tints the fine wire mesh and cables magenta.
 */
const LOOK: PostLook = {
  tone: "aces",
  ao: { radius: 0.9, intensity: 3.0, color: [0.02, 0.03, 0.06] },
  bloom: { threshold: 1.6, smoothing: 0.5, intensity: 0.35, radius: 0.65, levels: 7 },
  grade: { grain: 0.012, vignette: 0.3, lift: [0.02, 0.14, 0.3], gain: [1.05, 1.0, 0.93], saturation: 1.1, contrast: 1.06 },
};

export class SugaStage extends PlaceStage<SugaWorld, SugaAudio> {
  private sky!: Sky;
  private clouds!: Texture;
  private sunDir = bearing(SUN.azimuth, SUN.elevation, BEARING);

  private constructor(ctx: StageContext, place: PlaceDef) {
    super(ctx, place, new PerspectiveCamera(38, 1, 0.1, 4000), { shots: SHOTS, walkable: WALKABLE, focus: FOCUS, intro: INTRO_FROM, introSeconds: 7.5 }, new SugaAudio(ctx.audio));
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<SugaStage> {
    const s = new SugaStage(ctx, place);
    await s.build(progress);
    return s;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx;
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;

    this.scene.fog = new FogExp2(SKY.horizon.clone().multiplyScalar(0.92), 0.0011);
    this.scene.background = SKY.horizon.clone();

    await progress(0.04, "Cutting granite");
    this.baker = new Baker(renderer);
    const lib = new DayLib(this.baker, quality);
    lib.bakeAll();
    const atlas = new Atlas(1024, { pad: 2 });
    const world = (this.world = new SugaWorld(lib, atlas, quality, 20160826));

    await progress(0.16, "Growing summer cumulus");
    this.clouds = bakeClouds(this.baker, this.sunDir);

    await progress(0.28, "Laying the stairs");
    buildTerrain(world);
    buildStairs(world);

    await progress(0.4, "Building the neighbourhood");
    buildHouses(world);

    await progress(0.52, "Stringing the wires");
    buildProps(world);

    await progress(0.6, "Leafing the cherry tree");
    buildTree(world);

    await progress(0.66, "Raising the ridge");
    buildFar(world);
    this.sky = buildDaySky(world, this.sunDir, this.clouds);
    this.addLights();

    await progress(0.74, "Batching geometry");
    const stats = batchStatic(world.root);
    console.info(`[suga] batched ${stats.before} meshes into ${stats.after}`);
    this.scene.add(world.root);

    await progress(0.84, "Capturing the sky");
    this.captureProbe(new Vector3(0, -2.5, -9), { near: 0.1, far: 3000, intensity: 0.86 });

    await progress(0.92, "Grading the afternoon");
    this.post = createPlacePost(renderer, this.scene, this.camera, quality, LOOK);
    this.startRig();
    await progress(1, "Listening to the cicadas");
    if (this.ctx.params.exporting) this.exposeSugaExport();
  }

  /**
   * The sun is a real directional light (exported as a glTF directional
   * light) whose orthographic shadow covers the flight, the lane and the
   * junction; the hemisphere and the captured sky probe fill the shade.
   */
  private addLights(): void {
    const q = this.ctx.quality;
    const sun = (this.sun = new DirectionalLight(0xfff1dc, 10.5));
    sun.name = "sun";
    const center = new Vector3(0, -3.5, -30);
    sun.position.copy(center).addScaledVector(this.sunDir, 120);
    sun.lookAt(center);
    // Target as a child at (0, 0, −1): the glTF light's direction is the node's −Z.
    const target = new Object3D();
    target.name = "sun-target";
    target.position.set(0, 0, -1);
    sun.add(target);
    sun.target = target;
    sun.castShadow = q.shadows;
    // One sun map covers the detailed area; leaf dapples need ~2 cm texels.
    const size = q.level === "high" || q.level === "ultra" ? 4096 : q.shadowMapSize;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 1.6;
    // Fit the orthographic frustum to the detailed area (stairs to junction).
    this.fitSunShadow(sun, [-14, 14], [-8, 13], [-70, 8]);
    this.world.root.add(sun);
    this.world.root.add(new HemisphereLight(0xa9c8f0, 0x6a6258, 0.5));
  }

  /** `window.pocketAtlasExport()` → glTF, sky probe and cloud panorama for the cooker. */
  private exposeSugaExport(): void {
    this.exposeExport({
      seconds: 1,
      files: [{ name: "sky-clouds.png", texture: this.clouds }],
      meta: (c) => ({
        version: c.version,
        units: c.units,
        up: c.up,
        kind: this.place.kind,
        geo: { ...GEO, bearing: BEARING, note: "−Z faces the bearing; the world is not rotated to north" },
        sun: { azimuth: SUN.azimuth, elevation: SUN.elevation, direction: [this.sunDir.x, this.sunDir.y, this.sunDir.z] },
        fog: c.fog,
        hemisphere: c.hemisphere,
        directionalLights: c.directionalLights,
        environment: c.environment,
        camera: c.camera,
        ...c.special,
        tracks: c.tracks,
        post: this.postMeta(),
        // The cooker's vertex bake stands in for N8AO (radius 0.9 m): sky occlusion by ray casts within 1.5 m.
        bake: { skyOcclusion: { rays: 48, reach: 1.5, foliage: 0.55 } },
      }),
    });
  }

  protected advance(dt: number, time: number): void {
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.audio.update(dt, this.camera);
  }
}
