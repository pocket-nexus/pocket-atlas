import { DirectionalLight, FogExp2, HemisphereLight, Object3D, PCFShadowMap, PerspectiveCamera, Vector3, type Color, type Texture } from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { PlaceDef, PlaceKind, Progress, StageContext } from "../../../core/types";
import { Atlas } from "../atlas";
import { Baker } from "../bake";
import type { Box6, Shot, ShotKey } from "../camera";
import { batchStatic } from "../geo";
import { PlaceStage } from "../stage";
import { DayWorld } from "./context";
import { DayLib } from "./materials";
import { createDayPost } from "./post";
import { bakeClouds, buildSky, SKY } from "./sky";
import { buildSky as buildOutdoorSky, type SkySpec } from "../sky";
import { createPlacePost, type PostLook } from "../post";

/** Authored atmosphere over the existing sky, light-bake and post contracts. */
export interface OutdoorAtmosphere {
  sky: SkySpec;
  hemisphere: { sky: Color; ground: Color; intensity: number };
  fogColor?: Color;
  post: PostLook;
  exposure?: number;
  skyOcclusion?: { rays: number; reach: number; foliage: number; minEdge?: number; rounds?: number; abs?: number; rel?: number; grow?: number };
}

interface DayAudio {
  start(): void;
  stop(): void;
  update(dt: number, camera: PerspectiveCamera, time: number): void;
}

/** An outdoor place supplies its layout and atmosphere, never a second renderer. */
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
  atmosphere?: OutdoorAtmosphere;
  loopSeconds?: number;
  metadata: Record<string, unknown>;
  audio?: DayAudio;
  build(world: DayWorld, progress: Progress): Promise<void>;
}

/** Daylight lighting recipe over the common PlaceStage camera, probe, export and disposal lifecycle. */
export class DayStage extends PlaceStage<DayWorld, DayAudio> {
  private sky!: ReturnType<typeof buildSky>;
  private clouds?: Texture;

  private constructor(ctx: StageContext, place: PlaceDef, private spec: DayPlace) {
    super(ctx, place, new PerspectiveCamera(38, 1, 0.1, spec.kind.endsWith("-coast") ? 30000 : 4000), spec, spec.audio ?? { start() {}, stop() {}, update() {} });
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress, spec: DayPlace): Promise<DayStage> {
    const stage = new DayStage(ctx, place, spec);
    await stage.build(progress);
    return stage;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx, s = this.spec;
    RectAreaLightUniformsLib.init();
    renderer.shadowMap.enabled = quality.shadows && s.sunIntensity > 0 && s.sunDirection.y > 0;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    const atmosphere = s.atmosphere;
    this.scene.fog = new FogExp2(atmosphere?.fogColor ?? atmosphere?.sky.horizon ?? SKY.horizon.clone().multiplyScalar(0.92), s.fogDensity);
    this.scene.background = (atmosphere?.sky.horizon ?? SKY.horizon).clone();
    renderer.toneMappingExposure = atmosphere?.exposure ?? 1;
    await progress(0.04, "Preparing outdoor materials");
    this.baker = new Baker(renderer);
    const lib = new DayLib(this.baker, quality); lib.bakeAll();
    this.world = new DayWorld(lib, new Atlas(1024, { pad: 2 }), quality, this.ctx.authoring?.seed ?? 20160826, this.ctx.params.geometry);
    await progress(0.16, atmosphere ? "Preparing the atmosphere" : "Growing clouds");
    this.clouds = atmosphere ? atmosphere.sky.clouds?.texture : bakeClouds(this.baker, s.sunDirection);
    await s.build(this.world, progress);
    this.sky = atmosphere ? buildOutdoorSky(this.world.root, atmosphere.sky) : buildSky(this.world, s.sunDirection, this.clouds!);
    this.addLights();
    await progress(0.74, "Batching geometry");
    const stats = batchStatic(this.world.root);
    console.info(`[${this.place.id}] batched ${stats.before} meshes into ${stats.after}`);
    this.scene.add(this.world.root);
    await progress(0.84, "Capturing the sky");
    this.captureProbe(new Vector3(...s.envPosition), { near: 0.1, far: s.kind.endsWith("-coast") ? 30000 : 3000, intensity: s.envIntensity });
    await progress(0.92, "Grading the light");
    this.post = atmosphere ? createPlacePost(renderer, this.scene, this.camera, quality, atmosphere.post) : createDayPost(renderer, this.scene, this.camera, quality, s.season);
    this.startRig();
    if (this.ctx.params.exporting) this.exposeExport({
      seconds: s.loopSeconds ?? 1,
      files: this.clouds ? [{ name: "sky-clouds.png", texture: this.clouds }] : [],
      meta: c => ({
        version: c.version, units: c.units, up: c.up, kind: s.kind,
        ...s.metadata, fog: c.fog, hemisphere: c.hemisphere,
        directionalLights: c.directionalLights, rectLights: c.rectLights, fogLights: c.fogLights, environment: c.environment,
        camera: c.camera, ...c.special, tracks: c.tracks, post: this.postMeta(),
        bake: { skyOcclusion: atmosphere?.skyOcclusion ?? { rays: 48, reach: 1.5, foliage: 0.55 } },
      }),
    });
    await progress(1, "Ready");
  }

  private addLights(): void {
    const s = this.spec, q = this.ctx.quality;
    const hemi = s.atmosphere?.hemisphere;
    this.world.root.add(hemi ? new HemisphereLight(hemi.sky, hemi.ground, hemi.intensity) : new HemisphereLight(0xa9c8f0, 0x6a6258, 0.5));
    // A below-horizon sun is sky data only; do not spend a shadow pass on it.
    if (s.sunIntensity <= 0 || s.sunDirection.y <= 0) return;
    const sun = (this.sun = new DirectionalLight(s.atmosphere?.sky.sunColor ?? 0xfff1dc, s.sunIntensity)); sun.name = "sun";
    const center = new Vector3(...s.sunCenter);
    sun.position.copy(center).addScaledVector(s.sunDirection, 120); sun.lookAt(center);
    const target = new Object3D(); target.name = "sun-target"; target.position.set(0, 0, -1); sun.add(target); sun.target = target;
    sun.castShadow = q.shadows;
    const size = q.level === "high" || q.level === "ultra" ? 4096 : q.shadowMapSize;
    sun.shadow.mapSize.set(size, size); sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.02; sun.shadow.radius = 1.6;
    const b = s.shadowBounds;
    this.fitSunShadow(sun, [b[0], b[3]], [b[1], b[4]], [b[2], b[5]]);
    this.world.root.add(sun);
  }

  protected advance(dt: number, time: number): void {
    this.world.viewPosition.copy(this.camera.position);
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.audio.update(dt, this.camera, time);
  }
}
