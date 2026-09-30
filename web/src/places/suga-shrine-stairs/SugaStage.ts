import {
  CubeCamera,
  DirectionalLight,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  type Texture,
} from "three";
import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";
import { Atlas } from "../shared/atlas";
import { Baker } from "../shared/bake";
import { CameraRig, type Box6, type Shot, type ShotKey } from "../shared/camera";
import { batchStatic } from "../shared/geo";
import { SugaAudio } from "./audio";
import { createDayPost, type DayPost } from "./fx/post";
import { DayLib } from "./gfx/materials";
import { SugaWorld } from "./world/context";
import { buildFar } from "./world/far";
import { buildHouses } from "./world/houses";
import { bearing, BEARING, GEO, stepY, SUN } from "./world/layout";
import { buildProps } from "./world/props";
import { bakeClouds, buildSky, SKY } from "./world/sky";
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

export class SugaStage implements Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(38, 1, 0.1, 4000);
  private ctx: StageContext;
  private place: PlaceDef;
  private baker!: Baker;
  private world!: SugaWorld;
  private post!: DayPost;
  private rig!: CameraRig;
  private sky!: ReturnType<typeof buildSky>;
  private clouds!: Texture;
  private sun!: DirectionalLight;
  private sunDir = bearing(SUN.azimuth, SUN.elevation);
  private env: Texture | null = null;
  private envCube: WebGLCubeRenderTarget | null = null;
  private audio: SugaAudio;
  private shadowFrames = 0;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "c" || e.key === "C") this.rig.toggleCinematic();
  };

  private constructor(ctx: StageContext, place: PlaceDef) {
    this.ctx = ctx;
    this.place = place;
    this.audio = new SugaAudio(ctx.audio);
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
    const atlas = new Atlas(1024);
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
    this.sky = buildSky(world, this.sunDir, this.clouds);
    this.addLights();

    await progress(0.74, "Batching geometry");
    const stats = batchStatic(world.root);
    console.info(`[suga] batched ${stats.before} meshes into ${stats.after}`);
    this.scene.add(world.root);

    await progress(0.84, "Capturing the sky");
    this.captureEnvironment();

    await progress(0.92, "Grading the afternoon");
    this.post = createDayPost(renderer, this.scene, this.camera, quality);
    this.rig = new CameraRig(this.camera, this.ctx.canvas, SHOTS, WALKABLE, FOCUS);
    this.rig.onModeChange = (m) => this.ctx.overlay.setCinematic(m === "cinematic");
    const start = SHOTS.find((s) => s.name.toLowerCase() === (this.ctx.params.cam ?? "stairs").toLowerCase()) ?? SHOTS[0];
    this.camera.position.set(...start.to.pos);
    this.camera.lookAt(...start.to.target);
    this.camera.fov = start.to.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    await progress(1, "Listening to the cicadas");
    if (this.ctx.params.exporting) this.exposeExport();
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
    sun.updateMatrixWorld(true);
    const inv = sun.matrixWorld.clone().invert();
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const x of [-14, 14]) for (const y of [-8, 13]) for (const z of [-70, 8]) {
      const p = new Vector3(x, y, z).applyMatrix4(inv);
      lo.min(p);
      hi.max(p);
    }
    const cam = sun.shadow.camera;
    cam.left = lo.x;
    cam.right = hi.x;
    cam.bottom = lo.y;
    cam.top = hi.y;
    cam.near = Math.max(1, -hi.z - 5);
    cam.far = -lo.z + 5;
    cam.updateProjectionMatrix();
    this.world.root.add(sun);
    this.world.root.add(new HemisphereLight(0xa9c8f0, 0x6a6258, 0.5));
  }

  /** Renders the finished place into a cube map once; PMREM makes it the IBL. */
  private captureEnvironment(): void {
    const { renderer } = this.ctx;
    const rt = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cube = new CubeCamera(0.1, 3000, rt);
    cube.position.set(0, -2.5, -9);
    this.scene.add(cube);
    renderer.shadowMap.needsUpdate = true;
    cube.update(renderer, this.scene);
    this.scene.remove(cube);
    const pmrem = new PMREMGenerator(renderer);
    this.env = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    if (this.ctx.params.exporting) this.envCube = rt;
    else rt.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.86;
  }

  /** `window.pocketAtlasExport()` → glTF, sky probe and cloud panorama for the cooker. */
  private exposeExport(): void {
    const w = window as unknown as { pocketAtlasExport?: (seconds?: number) => Promise<unknown> };
    w.pocketAtlasExport = async (seconds = 1) => {
      const { exportPlace } = await import("../shared/export");
      const fog = this.scene.fog as FogExp2;
      return exportPlace({
        renderer: this.ctx.renderer,
        world: this.world,
        baker: this.baker,
        env: this.envCube,
        envPosition: [0, -2.5, -9],
        shots: SHOTS,
        walkable: WALKABLE,
        intro: INTRO_FROM,
        fog: { color: fog.color.toArray(), density: fog.density },
        environmentIntensity: this.scene.environmentIntensity,
        record: seconds,
        fps: 15,
        files: [{ name: "sky-clouds.png", texture: this.clouds }],
        meta: (c) => ({
          version: c.version,
          units: c.units,
          up: c.up,
          kind: "daytime-slope",
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
          // The cooker's vertex bake stands in for N8AO: sky occlusion by ray casts.
          bake: { skyOcclusion: { rays: 48, reach: 8, foliage: 0.55 } },
        }),
        onProgress: (label) => console.info(`[export] ${label}`),
      });
    };
  }

  /** The grade and bloom as uniforms hold them, for handheld ports. */
  private postMeta(): Record<string, unknown> {
    const u = this.post.grade.uniforms;
    const v3 = (k: string) => (u.get(k)!.value as Vector3).toArray();
    const b = this.post.bloom;
    return {
      tone: "aces",
      exposure: this.ctx.renderer.toneMappingExposure,
      contrast: u.get("uContrast")!.value,
      saturation: u.get("uSaturation")!.value,
      lift: v3("uLift"),
      gain: v3("uGain"),
      vignette: u.get("uVignette")!.value,
      grain: u.get("uGrain")!.value,
      bloomThreshold: b.luminanceMaterial.threshold,
      bloomSmoothing: b.luminanceMaterial.smoothing,
      bloomIntensity: b.intensity,
    };
  }

  enter(): void {
    this.ctx.overlay.showPlace(
      this.place,
      {
        onBack: () => this.ctx.nav.closePlace(),
        onCinematic: () => this.rig.toggleCinematic(),
        onShot: (name) => this.rig.goTo(name),
      },
      SHOTS.map((s) => s.name),
    );
    addEventListener("keydown", this.keyHandler);
    this.audio.start();
    const p = this.ctx.params;
    if (p.shot) {
      this.rig.goTo(p.cam ?? "Stairs");
      if (p.view && p.view.length >= 6) {
        const v = p.view;
        this.rig.goToKey({ pos: [v[0], v[1], v[2]], target: [v[3], v[4], v[5]], fov: v[6] ?? 40 });
      }
      this.rig.autoCinematicAfter = Infinity;
    } else {
      this.rig.startIntro(INTRO_FROM, SHOTS[0].to, 7.5);
    }
  }

  leave(): void {
    this.audio.stop();
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
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(time, this.camera.position);
    this.audio.update(dt, this.camera);
    this.post.grade.uniforms.get("uFade")!.value = this.rig.fade;
    const bars = this.post.grade.uniforms.get("uBars")!;
    bars.value += ((this.rig.mode === "cinematic" ? 1 : 0) - bars.value) * (1 - Math.exp(-dt * 2.5));
    // Everything that casts is static: the sun's shadow map renders once.
    if (this.shadowFrames < 2) {
      this.ctx.renderer.shadowMap.needsUpdate = true;
      this.shadowFrames++;
    }
    this.post.render(dt);
  }

  dispose(): void {
    const { renderer } = this.ctx;
    this.rig.dispose();
    this.post.dispose();
    this.baker.dispose();
    this.env?.dispose();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v && typeof v === "object" && "isTexture" in v) (v as Texture).dispose();
          mat.dispose();
        }
      }
    });
    this.sun?.shadow.map?.dispose();
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.autoUpdate = true;
  }
}
