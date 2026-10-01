import {
  Color,
  CubeCamera,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  type Texture,
} from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";
import { Atlas, SkylineAtlas } from "../shared/atlas";
import { Baker } from "../shared/bake";
import { CameraRig, type Box6, type Shot, type ShotKey } from "../shared/camera";
import { batchStatic } from "../shared/geo";
import { buildTwilightSky, twilightColor, type TwilightSky } from "../shared/sky";
import { AkibaAudio } from "./audio";
import { createDuskPost, type DuskPost } from "./fx/post";
import { DuskLib } from "./gfx/materials";
import { AkibaWorld } from "./world/context";
import { buildFar } from "./world/far";
import { buildGround } from "./world/ground";
import { buildKaikan } from "./world/kaikan";
import { bearing, GEO, SUN, VIEW } from "./world/layout";
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
const ENV_AT = new Vector3(-10, 2.6, -9.2);

/**
 * Blue hour, mid-October: the sun 5° below the horizon almost straight down
 * the street (azimuth 262°), the sky deep blue overhead with an amber band
 * over Chuo-dori. Light on the street is artificial: signage, backlit
 * windows, shopfronts and lamps.
 */
export const DUSK: TwilightSky = {
  zenith: new Color(0.008, 0.024, 0.095),
  horizon: new Color(0.085, 0.1, 0.175),
  ground: new Color(0.03, 0.03, 0.04),
  gradientPower: 0.5,
  groundBlend: 6,
  sun: bearing(SUN.azimuth, SUN.elevation),
  sunColor: new Color(1.0, 0.42, 0.16),
  glow: { intensity: 0.33, wide: [0.33, 8], tight: [1, 36] },
  band: { color: new Color(0.42, 0.19, 0.06), height: 0.075, sunBias: 0.85, sunPower: 2.2 },
  belt: { color: new Color(0.07, 0.035, 0.065), elevation: 0.14, width: 0.09, power: 1.5 },
  shadow: { strength: 0.35, height: 0.07, power: 1.6 },
};

export class AkibaStage implements Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(46, 1, 0.1, 4000);
  private ctx: StageContext;
  private place: PlaceDef;
  private baker!: Baker;
  private world!: AkibaWorld;
  private lib!: DuskLib;
  private post!: DuskPost;
  private rig!: CameraRig;
  private sky!: ReturnType<typeof buildTwilightSky>;
  private env: Texture | null = null;
  private envCube: WebGLCubeRenderTarget | null = null;
  private audio: AkibaAudio;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "c" || e.key === "C") this.rig.toggleCinematic();
  };

  private constructor(ctx: StageContext, place: PlaceDef) {
    this.ctx = ctx;
    this.place = place;
    this.audio = new AkibaAudio(ctx.audio);
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
    const big = quality.textureSize >= 2048;
    const atlas = new SkylineAtlas(big ? 4096 : 2048);
    const art = new SkylineAtlas(big ? 4096 : 2048);
    const letters = new Atlas(2048);
    const lc = letters.texture.image as HTMLCanvasElement;
    lc.getContext("2d")!.clearRect(0, 0, lc.width, lc.height);
    const world = (this.world = new AkibaWorld(lib, atlas, art, letters, quality, 20141020));

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
    this.sky = buildTwilightSky(world.root, DUSK);
    // Sky light: the twilight dome averaged over the upper hemisphere, cool; the ground bounce is faint.
    const hemiSky = twilightColor(DUSK, new Vector3(0, 1, 0)).add(twilightColor(DUSK, new Vector3(-0.7, 0.5, 0.2).normalize())).add(twilightColor(DUSK, new Vector3(0.7, 0.4, -0.2).normalize())).multiplyScalar(1 / 3);
    world.root.add(new HemisphereLight(hemiSky.multiplyScalar(1.8), new Color(0.04, 0.036, 0.036), 1.0));

    await progress(0.76, "Batching geometry");
    const stats = batchStatic(world.root);
    console.info(`[akiba] batched ${stats.before} meshes into ${stats.after}; atlas ${Math.round(atlas.fill * 100)}%, art ${Math.round(art.fill * 100)}%`);
    this.scene.add(world.root);

    await progress(0.86, "Capturing the street");
    this.captureEnvironment();

    await progress(0.92, "Grading the dusk");
    this.post = createDuskPost(renderer, this.scene, this.camera, quality);
    this.rig = new CameraRig(this.camera, this.ctx.canvas, SHOTS, WALKABLE, FOCUS);
    this.rig.onModeChange = (m) => this.ctx.overlay.setCinematic(m === "cinematic");
    const start = SHOTS.find((s) => s.name.toLowerCase() === (this.ctx.params.cam ?? "arrival").toLowerCase()) ?? SHOTS[0];
    this.camera.position.set(...start.to.pos);
    this.camera.lookAt(...start.to.target);
    this.camera.fov = start.to.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    await progress(1, "Signs on");
    if (this.ctx.params.exporting) this.exposeExport();
  }

  /** Renders the finished street into a cube map once; PMREM makes it the IBL. */
  private captureEnvironment(): void {
    const { renderer } = this.ctx;
    const rt = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cube = new CubeCamera(0.1, 3000, rt);
    cube.position.copy(ENV_AT);
    this.scene.add(cube);
    for (const u of this.world.updaters) u(0, this.ctx.params.startTime);
    cube.update(renderer, this.scene);
    this.scene.remove(cube);
    const pmrem = new PMREMGenerator(renderer);
    this.env = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    if (this.ctx.params.exporting) this.envCube = rt;
    else rt.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.35;
  }

  /** `window.pocketAtlasExport()` → glTF and environment for the cooker. */
  private exposeExport(): void {
    const w = window as unknown as { pocketAtlasExport?: (seconds?: number) => Promise<unknown> };
    w.pocketAtlasExport = async (seconds = 20) => {
      const { exportPlace } = await import("../shared/export");
      const fog = this.scene.fog as FogExp2;
      return exportPlace({
        renderer: this.ctx.renderer,
        world: this.world,
        baker: this.baker,
        env: this.envCube,
        envPosition: [ENV_AT.x, ENV_AT.y, ENV_AT.z],
        shots: SHOTS,
        walkable: WALKABLE,
        intro: INTRO_FROM,
        fog: { color: fog.color.toArray(), density: fog.density },
        environmentIntensity: this.scene.environmentIntensity,
        record: seconds,
        fps: 15,
        meta: (c) => ({
          version: c.version,
          units: c.units,
          up: c.up,
          kind: "dusk-street",
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
      tone: "agx",
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
      this.rig.goTo(p.cam ?? "Arrival");
      if (p.view && p.view.length >= 6) {
        const v = p.view;
        this.rig.goToKey({ pos: [v[0], v[1], v[2]], target: [v[3], v[4], v[5]], fov: v[6] ?? 46 });
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
    this.lib.clock.uTime.value = time;
    for (const u of this.world.updaters) u(dt, time);
    this.sky.update(this.camera.position);
    this.audio.update(dt, this.camera);
    this.post.grade.uniforms.get("uFade")!.value = this.rig.fade;
    const bars = this.post.grade.uniforms.get("uBars")!;
    bars.value += ((this.rig.mode === "cinematic" ? 1 : 0) - bars.value) * (1 - Math.exp(-dt * 2.5));
    this.post.render(dt);
  }

  dispose(): void {
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
  }
}
