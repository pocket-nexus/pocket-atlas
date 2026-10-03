import { DirectionalLight, FogExp2, HemisphereLight, Object3D, PCFShadowMap, PerspectiveCamera, Vector3, type Texture } from "three";
import type { PlaceDef, PlaceKind, Progress, StageContext } from "../../../core/types";
import { Atlas } from "../atlas";
import { Baker } from "../bake";
import type { Box6, Shot, ShotKey } from "../camera";
import type { AudioRecipe } from "../audio-recipe";
import { batchStatic } from "../geo";
import { PlaceStage } from "../stage";
import { DayWorld } from "./context";
import { DayLib } from "./materials";
import { createDayPost } from "./post";
import { bakeClouds, buildSky, SKY } from "./sky";

interface DayAudio {
  start(): void;
  stop(): void;
  update(dt: number, camera: PerspectiveCamera, time: number): void;
}

/** A daytime place supplies its layout and atmosphere, never a second renderer. */
export interface DayPlace {
  kind: PlaceKind;
  season: "summer" | "spring";
  shots: Shot[];
  walkable: Box6[];
  focus: Box6;
  intro: ShotKey;
  introSeconds: number;
  sunDirection: Vector3;
  sunIntensity: number;
  sunCenter: [number, number, number];
  shadowBounds: Box6;
  envPosition: [number, number, number];
  envIntensity: number;
  fogDensity: number;
  loopSeconds?: number;
  metadata: Record<string, unknown>;
  audio?: DayAudio;
  audioRecipe?: AudioRecipe;
  build(world: DayWorld, progress: Progress): Promise<void>;
}

/** Daylight lighting recipe over the common PlaceStage camera, probe, export and disposal lifecycle. */
export class DayStage extends PlaceStage<DayWorld, DayAudio> {
  private sky!: ReturnType<typeof buildSky>;
  private clouds!: Texture;

  private constructor(ctx: StageContext, place: PlaceDef, private spec: DayPlace) {
    super(ctx, place, new PerspectiveCamera(38, 1, 0.1, 4000), spec, spec.audio ?? { start() {}, stop() {}, update() {} });
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress, spec: DayPlace): Promise<DayStage> {
    const stage = new DayStage(ctx, place, spec);
    await stage.build(progress);
    return stage;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx, s = this.spec;
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    this.scene.fog = new FogExp2(SKY.horizon.clone().multiplyScalar(0.92), s.fogDensity);
    this.scene.background = SKY.horizon.clone();
    await progress(0.04, "Preparing daylight materials");
    this.baker = new Baker(renderer);
    const lib = new DayLib(this.baker, quality); lib.bakeAll();
    this.world = new DayWorld(lib, new Atlas(1024, { pad: 2 }), quality, 20160826, this.ctx.params.geometry);
    await progress(0.16, "Growing clouds");
    this.clouds = bakeClouds(this.baker, s.sunDirection);
    await s.build(this.world, progress);
    this.sky = buildSky(this.world, s.sunDirection, this.clouds);
    this.addLights();
    await progress(0.74, "Batching geometry");
    const stats = batchStatic(this.world.root);
    console.info(`[${this.place.id}] batched ${stats.before} meshes into ${stats.after}`);
    this.scene.add(this.world.root);
    await progress(0.84, "Capturing the sky");
    this.captureProbe(new Vector3(...s.envPosition), { near: 0.1, far: 3000, intensity: s.envIntensity });
    await progress(0.92, "Grading the afternoon");
    this.post = createDayPost(renderer, this.scene, this.camera, quality, s.season);
    this.startRig();
    if (this.ctx.params.exporting) this.exposeExport({
      seconds: s.loopSeconds ?? 1,
      files: [{ name: "sky-clouds.png", texture: this.clouds }],
      meta: c => ({
        version: c.version, units: c.units, up: c.up, kind: s.kind,
        ...s.metadata, audio: s.audioRecipe, fog: c.fog, hemisphere: c.hemisphere,
        directionalLights: c.directionalLights, environment: c.environment,
        camera: c.camera, ...c.special, tracks: c.tracks, post: this.postMeta(),
        bake: { skyOcclusion: { rays: 48, reach: 1.5, foliage: 0.55 } },
      }),
    });
    await progress(1, "Ready");
  }

  private addLights(): void {
    const s = this.spec, q = this.ctx.quality;
    const sun = (this.sun = new DirectionalLight(0xfff1dc, s.sunIntensity)); sun.name = "sun";
    const center = new Vector3(...s.sunCenter);
    sun.position.copy(center).addScaledVector(s.sunDirection, 120); sun.lookAt(center);
    const target = new Object3D(); target.name = "sun-target"; target.position.set(0, 0, -1); sun.add(target); sun.target = target;
    sun.castShadow = q.shadows;
    const size = q.level === "high" || q.level === "ultra" ? 4096 : q.shadowMapSize;
    sun.shadow.mapSize.set(size, size); sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.02; sun.shadow.radius = 1.6;
    const b = s.shadowBounds;
    this.fitSunShadow(sun, [b[0], b[3]], [b[1], b[4]], [b[2], b[5]]);
    this.world.root.add(sun, new HemisphereLight(0xa9c8f0, 0x6a6258, 0.5));
  }

  protected advance(dt: number, time: number): void {
    this.world.viewPosition.copy(this.camera.position);
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.audio.update(dt, this.camera, time);
    if (this.world.shadowsDirty) this.ctx.renderer.shadowMap.needsUpdate = true;
    this.world.shadowsDirty = false;
  }
}
