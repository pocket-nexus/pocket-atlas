import {
  CubeCamera, DirectionalLight, FogExp2, HalfFloatType, HemisphereLight, Mesh,
  Object3D, PCFShadowMap, PerspectiveCamera, PMREMGenerator, Scene, Vector3,
  WebGLCubeRenderTarget, type InstancedMesh, type Texture, type WebGLRenderTarget,
} from "three";
import type { PlaceDef, Progress, Stage, StageContext } from "../../../core/types";
import { Atlas } from "../atlas";
import { Baker } from "../bake";
import { CameraRig, type Box6, type Shot, type ShotKey } from "../camera";
import { batchStatic } from "../geo";
import { DayWorld } from "./context";
import { DayLib } from "./materials";
import { createDayPost, type DayPost } from "./post";
import { bakeClouds, buildSky, SKY } from "./sky";

interface DayAudio {
  start(): void;
  stop(): void;
  update(dt: number, camera: PerspectiveCamera, time: number): void;
}

/** A daytime place supplies its layout and atmosphere, never a second renderer. */
export interface DayPlace {
  kind: "daytime-slope" | "daytime-railway";
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
  metadata: Record<string, unknown>;
  audio?: DayAudio;
  build(world: DayWorld, progress: Progress): Promise<void>;
}

export class DayStage implements Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(38, 1, 0.1, 4000);
  private baker!: Baker;
  private world!: DayWorld;
  private post!: DayPost;
  private rig!: CameraRig;
  private sky!: ReturnType<typeof buildSky>;
  private clouds!: Texture;
  private sun!: DirectionalLight;
  private envTarget: WebGLRenderTarget | null = null;
  private envCube: WebGLCubeRenderTarget | null = null;
  private shadowFrames = 0;
  private exportHook?: (seconds?: number) => Promise<unknown>;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === "c") this.rig.toggleCinematic();
  };

  private constructor(private ctx: StageContext, private place: PlaceDef, private spec: DayPlace) {}

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress, spec: DayPlace): Promise<DayStage> {
    const stage = new DayStage(ctx, place, spec);
    await stage.build(progress);
    return stage;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx;
    const s = this.spec;
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    this.scene.fog = new FogExp2(SKY.horizon.clone().multiplyScalar(0.92), s.fogDensity);
    this.scene.background = SKY.horizon.clone();
    await progress(0.04, "Preparing daylight materials");
    this.baker = new Baker(renderer);
    const lib = new DayLib(this.baker, quality);
    lib.bakeAll();
    this.world = new DayWorld(lib, new Atlas(1024), quality, 20160826);
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
    this.captureEnvironment();
    await progress(0.92, "Grading the afternoon");
    this.post = createDayPost(renderer, this.scene, this.camera, quality, s.season);
    this.rig = new CameraRig(this.camera, this.ctx.canvas, s.shots, s.walkable, s.focus);
    this.rig.onModeChange = (m) => this.ctx.overlay.setCinematic(m === "cinematic");
    const start = s.shots.find((shot) => shot.name.toLowerCase() === this.ctx.params.cam?.toLowerCase()) ?? s.shots[0];
    this.camera.position.set(...start.to.pos);
    this.camera.lookAt(...start.to.target);
    this.camera.fov = start.to.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    if (this.ctx.params.exporting) this.exposeExport();
    await progress(1, "Ready");
  }

  private addLights(): void {
    const s = this.spec;
    const sun = (this.sun = new DirectionalLight(0xfff1dc, s.sunIntensity));
    sun.name = "sun";
    const center = new Vector3(...s.sunCenter);
    sun.position.copy(center).addScaledVector(s.sunDirection, 120);
    sun.lookAt(center);
    const target = new Object3D();
    target.name = "sun-target";
    target.position.set(0, 0, -1);
    sun.add(target);
    sun.target = target;
    sun.castShadow = this.ctx.quality.shadows;
    const q = this.ctx.quality;
    const size = q.level === "high" || q.level === "ultra" ? 4096 : q.shadowMapSize;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 1.6;
    sun.updateMatrixWorld(true);
    const inv = sun.matrixWorld.clone().invert();
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    const b = s.shadowBounds;
    for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) {
      const p = new Vector3(x, y, z).applyMatrix4(inv);
      lo.min(p); hi.max(p);
    }
    Object.assign(sun.shadow.camera, { left: lo.x, right: hi.x, bottom: lo.y, top: hi.y, near: Math.max(1, -hi.z - 5), far: -lo.z + 5 });
    sun.shadow.camera.updateProjectionMatrix();
    this.world.root.add(sun, new HemisphereLight(0xa9c8f0, 0x6a6258, 0.5));
  }

  private captureEnvironment(): void {
    const { renderer } = this.ctx;
    const rt = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cube = new CubeCamera(0.1, 3000, rt);
    cube.position.set(...this.spec.envPosition);
    this.scene.add(cube);
    renderer.shadowMap.needsUpdate = true;
    cube.update(renderer, this.scene);
    this.scene.remove(cube);
    const pmrem = new PMREMGenerator(renderer);
    this.envTarget = pmrem.fromCubemap(rt.texture);
    pmrem.dispose();
    if (this.ctx.params.exporting) this.envCube = rt;
    else rt.dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = this.spec.envIntensity;
  }

  private exposeExport(): void {
    const w = window as unknown as { pocketAtlasExport?: (seconds?: number) => Promise<unknown> };
    this.exportHook = async (seconds = 1) => {
      const { exportPlace } = await import("../export");
      const fog = this.scene.fog as FogExp2;
      return exportPlace({
        renderer: this.ctx.renderer, world: this.world, baker: this.baker, env: this.envCube,
        envPosition: this.spec.envPosition, shots: this.spec.shots, walkable: this.spec.walkable,
        intro: this.spec.intro, fog: { color: fog.color.toArray(), density: fog.density },
        environmentIntensity: this.scene.environmentIntensity, record: seconds, fps: 15,
        files: [{ name: "sky-clouds.png", texture: this.clouds }],
        meta: (c) => ({
          version: c.version, units: c.units, up: c.up, kind: this.spec.kind,
          ...this.spec.metadata, fog: c.fog, hemisphere: c.hemisphere,
          directionalLights: c.directionalLights, environment: c.environment,
          camera: c.camera, ...c.special, tracks: c.tracks, post: this.postMeta(),
          bake: { skyOcclusion: { rays: 48, reach: 1.5, foliage: 0.55 } },
        }),
        onProgress: (label) => console.info(`[export] ${label}`),
      });
    };
    w.pocketAtlasExport = this.exportHook;
  }

  private postMeta(): Record<string, unknown> {
    const u = this.post.grade.uniforms;
    const v = (k: string) => (u.get(k)!.value as Vector3).toArray();
    const b = this.post.bloom;
    return {
      tone: "aces", exposure: this.ctx.renderer.toneMappingExposure,
      contrast: u.get("uContrast")!.value, saturation: u.get("uSaturation")!.value,
      lift: v("uLift"), gain: v("uGain"), vignette: u.get("uVignette")!.value,
      grain: u.get("uGrain")!.value, bloomThreshold: b.luminanceMaterial.threshold,
      bloomSmoothing: b.luminanceMaterial.smoothing, bloomIntensity: b.intensity,
    };
  }

  enter(): void {
    const s = this.spec, p = this.ctx.params;
    this.ctx.overlay.showPlace(this.place, {
      onBack: () => this.ctx.nav.closePlace(), onCinematic: () => this.rig.toggleCinematic(),
      onShot: (name) => this.rig.goTo(name),
    }, s.shots.map((shot) => shot.name));
    addEventListener("keydown", this.keyHandler);
    s.audio?.start();
    if (p.shot || p.cam) {
      this.rig.goTo(p.cam ?? s.shots[0].name);
      if (p.shot && p.view && p.view.length >= 6) {
        const v = p.view;
        this.rig.goToKey({ pos: [v[0], v[1], v[2]], target: [v[3], v[4], v[5]], fov: v[6] ?? 40 });
      }
      if (p.shot) this.rig.autoCinematicAfter = Infinity;
    } else this.rig.startIntro(s.intro, s.shots[0].to, s.introSeconds);
  }

  leave(): void {
    this.spec.audio?.stop();
    removeEventListener("keydown", this.keyHandler);
    this.ctx.overlay.hidePlace();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.post.setSize(width, height);
  }

  frame(dt: number, time: number): void {
    this.rig.update(dt, time);
    this.camera.updateMatrixWorld();
    this.world.viewPosition.copy(this.camera.position);
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.spec.audio?.update(dt, this.camera, time);
    this.post.grade.uniforms.get("uFade")!.value = this.rig.fade;
    const bars = this.post.grade.uniforms.get("uBars")!;
    bars.value += ((this.rig.mode === "cinematic" ? 1 : 0) - bars.value) * (1 - Math.exp(-dt * 2.5));
    if (this.shadowFrames++ < 2 || this.world.shadowsDirty) this.ctx.renderer.shadowMap.needsUpdate = true;
    this.world.shadowsDirty = false;
    this.post.render(dt);
  }

  dispose(): void {
    this.rig.dispose();
    this.post.dispose();
    this.baker.dispose();
    this.envTarget?.dispose();
    this.envCube?.dispose();
    const textures = new Set<Texture>();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      if ((m as InstancedMesh).isInstancedMesh) (m as InstancedMesh).dispose();
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) if (v && typeof v === "object" && "isTexture" in v) textures.add(v as Texture);
        mat.dispose();
      }
    });
    for (const t of textures) t.dispose();
    this.sun.shadow.map?.dispose();
    const w = window as unknown as { pocketAtlasExport?: unknown };
    if (w.pocketAtlasExport === this.exportHook) delete w.pocketAtlasExport;
    this.ctx.renderer.shadowMap.enabled = false;
    this.ctx.renderer.shadowMap.autoUpdate = true;
  }
}
