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
  type ShaderMaterial,
  Vector3,
  WebGLCubeRenderTarget,
  type Texture,
} from "three";
import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";
import { Atlas } from "../shared/atlas";
import { Baker } from "../shared/bake";
import { CameraRig, type Box6, type Shot, type ShotKey } from "../shared/camera";
import { batchStatic } from "../shared/geo";
import type { Water } from "../shared/water";
import { KamakuraAudio } from "./audio";
import { createCoastPost, type CoastPost } from "./fx/post";
import { CoastLib } from "./gfx/materials";
import { buildBuildings } from "./world/buildings";
import { buildCoast } from "./world/coast";
import { KamakuraWorld } from "./world/context";
import { buildCrossing, type CrossingState } from "./world/crossing";
import { buildFar } from "./world/far";
import { bearing, COAST, GEO, LOOP, PLATFORM, SUN, VIEW } from "./world/layout";
import { buildPeople } from "./world/people";
import { buildProps } from "./world/props";
import { buildSea, WATER } from "./world/sea";
import { bakeClouds, buildSky, DAYLIGHT, SKY } from "./world/sky";
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
    from: key([PK.x - 0.8, 0, PK.z - 0.6], 136, -5.4, 40),
    to: key([PK.x, 0, PK.z], 135, -5.4, 40),
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
const INTRO_FROM: ShotKey = { pos: [30, 55, 170], target: [0, 4, -30], fov: 34 };

export class KamakuraStage implements Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(24, 1, 0.4, 30000);
  private ctx: StageContext;
  private place: PlaceDef;
  private baker!: Baker;
  private world!: KamakuraWorld;
  private post!: CoastPost;
  private rig!: CameraRig;
  private sky!: ReturnType<typeof buildSky>;
  private clouds!: Texture;
  private sun!: DirectionalLight;
  private sunDir = bearing(SUN.azimuth, SUN.elevation);
  private env: Texture | null = null;
  private envCube: WebGLCubeRenderTarget | null = null;
  private envPosition: [number, number, number] = [0, 4, 9];
  private water!: Water;
  private crossing!: CrossingState;
  private audio: KamakuraAudio;
  private shadowFrames = 0;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "c" || e.key === "C") this.rig.toggleCinematic();
  };

  private constructor(ctx: StageContext, place: PlaceDef) {
    this.ctx = ctx;
    this.place = place;
    this.audio = new KamakuraAudio(ctx.audio);
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
    const world = (this.world = new KamakuraWorld(lib, atlas, quality, 20260725));

    await progress(0.14, "Growing summer cumulus");
    // Fair-weather cumulus over the hills and the far peninsulas, few over the bay.
    this.clouds = bakeClouds(this.baker, this.sunDir, { coverage: 0.08, landCoverage: 0.24, size: quality.level === "high" || quality.level === "ultra" ? 2048 : 1024 });

    await progress(0.24, "Filling Sagami Bay");
    this.water = buildSea(world, this.baker);
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
    buildTrain(world, this.crossing);
    buildTraffic(world);
    buildPeople(world);
    this.sky = buildSky(world, this.sunDir, this.clouds);
    this.addLights();

    await progress(0.76, "Batching geometry");
    const stats = batchStatic(world.root);
    console.info(`[kamakura] batched ${stats.before} meshes into ${stats.after}; ${lib.count} materials`);
    this.scene.add(world.root);

    await progress(0.86, "Capturing the sky");
    this.captureEnvironment();

    await progress(0.93, "Grading the afternoon");
    this.post = createCoastPost(renderer, this.scene, this.camera, quality);
    // Shot eye heights over the hillside are set once the ground exists.
    const park = SHOTS.find((s) => s.name === "Park")!;
    for (const k of [park.from, park.to]) {
      const y = hillY(k.pos[0], k.pos[2]) + 1.6;
      k.target[1] += y - k.pos[1];
      k.pos[1] = y;
    }
    this.rig = new CameraRig(this.camera, this.ctx.canvas, SHOTS, WALKABLE, FOCUS);
    this.rig.onModeChange = (m) => this.ctx.overlay.setCinematic(m === "cinematic");
    const start = SHOTS.find((s) => s.name.toLowerCase() === (this.ctx.params.cam ?? "crossing").toLowerCase()) ?? SHOTS[0];
    this.camera.position.set(...start.to.pos);
    this.camera.lookAt(...start.to.target);
    this.camera.fov = start.to.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    await progress(1, "Waiting for the bell");
    if (this.ctx.params.exporting) this.exposeExport();
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
    sun.updateMatrixWorld(true);
    const inv = sun.matrixWorld.clone().invert();
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const x of [-48, 52]) for (const y of [-9, 26]) for (const z of [-78, 26]) {
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
    // Hemisphere: grey-blue sky fill from above, sunlit asphalt and sand below.
    this.world.root.add(new HemisphereLight(DAYLIGHT.hemiSky, DAYLIGHT.hemiGround, DAYLIGHT.hemiIntensity));
    // A bright, slightly hazy afternoon: a touch under unit exposure keeps the
    // white villas and the cream train out of the shoulder of the ACES curve.
    this.ctx.renderer.toneMappingExposure = DAYLIGHT.exposure;
  }

  /** Renders the finished place into a cube map once; PMREM makes it the IBL. */
  private captureEnvironment(): void {
    const { renderer } = this.ctx;
    const rt = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cube = new CubeCamera(0.3, 30000, rt);
    cube.position.set(...this.envPosition);
    this.scene.add(cube);
    renderer.shadowMap.needsUpdate = true;
    // The probe sees a less saturated upper sky (see DAYLIGHT); the dome keeps its own.
    const probe = (this.sky.sky.material as ShaderMaterial).uniforms.uProbe;
    probe.value = DAYLIGHT.probeSky;
    cube.update(renderer, this.scene);
    probe.value = 0;
    this.scene.remove(cube);
    const pmrem = new PMREMGenerator(renderer);
    this.env = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    if (this.ctx.params.exporting) this.envCube = rt;
    else rt.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = DAYLIGHT.environmentIntensity;
  }

  /** `window.pocketAtlasExport()` → glTF, sky probe and cloud panorama for the cooker. */
  private exposeExport(): void {
    const w = window as unknown as { pocketAtlasExport?: (seconds?: number) => Promise<unknown> };
    w.pocketAtlasExport = async (seconds = LOOP) => {
      const { exportPlace } = await import("../shared/export");
      const fog = this.scene.fog as FogExp2;
      return exportPlace({
        renderer: this.ctx.renderer,
        world: this.world,
        baker: this.baker,
        env: this.envCube,
        envPosition: this.envPosition,
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
          kind: "daytime-coast",
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
          water: { material: WATER.name, note: "Kind::Water; see places/shared/water.ts for the model the device matches" },
          post: this.postMeta(),
          // The cooker's vertex bake stands in for N8AO (radius 0.9 m): sky occlusion by ray casts within 1.5 m.
          bake: { skyOcclusion: { rays: 48, reach: 1.5, foliage: 0.55 } },
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
      this.rig.goTo(p.cam ?? "Crossing");
      if (p.view && p.view.length >= 6) {
        const v = p.view;
        this.rig.goToKey({ pos: [v[0], v[1], v[2]], target: [v[3], v[4], v[5]], fov: v[6] ?? 40 });
      }
      this.rig.autoCinematicAfter = Infinity;
    } else {
      this.rig.startIntro(INTRO_FROM, SHOTS[0].to, 8);
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
    this.audio.update(dt, time, this.camera, this.crossing);
    this.post.grade.uniforms.get("uFade")!.value = this.rig.fade;
    const bars = this.post.grade.uniforms.get("uBars")!;
    bars.value += ((this.rig.mode === "cinematic" ? 1 : 0) - bars.value) * (1 - Math.exp(-dt * 2.5));
    // Every caster the handheld shadows is static: the sun's shadow map renders once.
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
    this.water.material.dispose();
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
    renderer.toneMappingExposure = 1;
  }
}
