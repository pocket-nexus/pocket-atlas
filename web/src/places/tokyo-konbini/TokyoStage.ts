import {
  Color,
  CubeCamera,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  type Texture,
} from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { PlaceDef, Progress, Stage, StageContext } from "../../core/types";
import { TokyoAudio } from "./audio";
import { CameraRig, type Shot, type ShotKey } from "./camera";
import { createPost, type PostChain } from "./fx/post";
import { Rain } from "./fx/rain";
import { Atlas } from "./gfx/atlas";
import { Baker } from "./gfx/bake";
import { batchStatic } from "./gfx/geo";
import { LAYER_NO_REFLECT } from "./gfx/layers";
import { MaterialLib } from "./gfx/materials";
import { PlanarReflection } from "./gfx/reflection";
import { createWetShared, type WetShared } from "./gfx/wet";
import { World } from "./world/context";
import { bakePuddles, buildGround } from "./world/ground";
import { buildKonbini, type Konbini } from "./world/konbini";
import { L, SHOP_BOX } from "./world/layout";
import { buildBlocks } from "./world/blocks";
import { buildPeople } from "./world/people";
import { buildProps } from "./world/props";
import { buildSky } from "./world/sky";
import { buildTraffic } from "./world/traffic";

const SHOTS: Shot[] = [
  {
    name: "Konbini",
    from: { pos: [12.7, 1.55, 8.6], target: [1.6, 2.1, -3.2], fov: 36 },
    to: { pos: [12.1, 1.6, 7.0], target: [1.2, 2.2, -3.2], fov: 36 },
    duration: 12,
  },
  {
    name: "Puddles",
    from: { pos: [3.6, 0.3, 6.5], target: [1.2, 1.25, -3.2], fov: 40 },
    to: { pos: [2.2, 0.26, 6.3], target: [1.0, 1.35, -3.2], fov: 40 },
    duration: 10,
  },
  {
    name: "Vending",
    from: { pos: [-8.3, 1.45, 3.9], target: [-5.6, 1.05, -1.4], fov: 40 },
    to: { pos: [-7.3, 1.35, 3.2], target: [-5.4, 1.1, -1.4], fov: 40 },
    duration: 10,
  },
  {
    name: "Crossing",
    from: { pos: [10.4, 1.7, -0.9], target: [10.0, 8.0, -80], fov: 34 },
    to: { pos: [10.1, 1.7, -3.4], target: [10.0, 8.5, -80], fov: 32 },
    duration: 12,
  },
  {
    name: "Inside",
    from: { pos: [-1.6, 1.45, -9.5], target: [0.4, 1.3, 4.0], fov: 44 },
    to: { pos: [-1.3, 1.5, -7.6], target: [0.8, 1.4, 4.0], fov: 44 },
    duration: 10,
  },
  {
    name: "Wires",
    from: { pos: [9.4, 0.9, -0.2], target: [5.8, 8.5, -2.8], fov: 50 },
    to: { pos: [8.9, 1.1, -0.7], target: [5.2, 9.0, -3.0], fov: 50 },
    duration: 9,
  },
];

const WALKABLE: [number, number, number, number, number, number][] = [
  [-60, 0.2, L.mainNorth + 0.2, 60, 14, L.mainSouth - 0.25],
  [L.crossWest + 0.25, 0.2, -80, L.crossEast - 0.25, 14, 80],
  [L.apron.x0 + 0.3, 0.2, L.apron.z0 + 0.25, L.apron.x1, 2.7, L.apron.z1],
  [L.konbini.x0 + 0.6, 0.6, L.konbini.z0 + 0.8, L.konbini.x1 - 0.6, 2.5, L.konbini.front - 0.4],
];

// Straight down the cross street's air column, so the crane never clips a roof.
const INTRO_FROM: ShotKey = { pos: [10.2, 46, 14], target: [4, 0, -2], fov: 42 };
const SHOP_DOOR = new Vector3(2.1, 1.4, L.konbini.front);

export class TokyoStage implements Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(38, 1, 0.1, 2600);
  private ctx: StageContext;
  private baker!: Baker;
  private wet!: WetShared;
  private world!: World;
  private konbini!: Konbini;
  private reflection!: PlanarReflection;
  private rain!: Rain;
  private post!: PostChain;
  private rig!: CameraRig;
  private sky!: ReturnType<typeof buildSky>;
  private env: Texture | null = null;
  private envCube: WebGLCubeRenderTarget | null = null;
  private audio: TokyoAudio;
  private place: PlaceDef;
  private height = 1;
  private frameNo = 0;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "c" || e.key === "C") this.rig.toggleCinematic();
  };

  private constructor(ctx: StageContext, place: PlaceDef) {
    this.ctx = ctx;
    this.place = place;
    this.audio = new TokyoAudio(ctx.audio);
  }

  static async create(ctx: StageContext, place: PlaceDef, progress: Progress): Promise<TokyoStage> {
    const s = new TokyoStage(ctx, place);
    await s.build(progress);
    return s;
  }

  private async build(progress: Progress): Promise<void> {
    const { renderer, quality } = this.ctx;
    RectAreaLightUniformsLib.init();
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;

    this.scene.fog = new FogExp2(new Color(0x0f0e14), 0.017);
    this.scene.background = new Color(0x05060a);
    this.camera.layers.enable(LAYER_NO_REFLECT);

    await progress(0.04, "Baking asphalt, tile and steel");
    this.baker = new Baker(renderer);
    this.wet = createWetShared();
    this.wet.uPuddleTex.value = bakePuddles(this.baker);
    const lib = new MaterialLib(this.baker, this.wet, quality);
    lib.bakeAll();
    const atlas = new Atlas(quality.textureSize >= 2048 ? 4096 : 2048);
    const world = (this.world = new World(lib, atlas, quality, 20240929));

    await progress(0.2, "Laying the street");
    buildGround(world, this.baker);

    await progress(0.32, "Stocking the konbini");
    this.konbini = buildKonbini(world);

    await progress(0.44, "Raising the neighbours");
    buildBlocks(world);

    await progress(0.54, "Stringing power lines");
    buildProps(world);
    buildTraffic(world);
    buildPeople(world);

    await progress(0.62, "Hanging the sky");
    this.sky = buildSky(world);
    world.root.add(new HemisphereLight(0x2a3148, 0x0b0908, 0.12));

    await progress(0.7, "Batching geometry");
    const stats = batchStatic(world.root);
    console.info(`[tokyo] batched ${stats.before} meshes into ${stats.after}`);
    this.scene.add(world.root);

    // Planar reflection shared by every wet ground material.
    this.reflection = new PlanarReflection(quality.reflectionScale, 0);
    this.world.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && !Array.isArray(m.material) && m.material.defines && "WET_PLANAR" in m.material.defines) this.reflection.hide.push(m);
    });
    const tex = this.reflection.textures;
    this.wet.uReflSharp.value = tex.sharp;
    this.wet.uReflBlur.value = tex.blurred;
    this.wet.uReflSoft.value = tex.soft;
    this.wet.uReflMatrix.value = this.reflection.textureMatrix;

    await progress(0.8, "Summoning the rain");
    this.rain = new Rain(quality.rainDrops, quality.splashes, world.dryBoxes);
    this.rain.setLights(world.fogLights);
    this.rain.addDrips(world.dripEdges, world.dryBoxes);
    this.rain.addSteam(world.steamVents);
    this.scene.add(this.rain.group);

    await progress(0.86, "Capturing reflections");
    this.captureEnvironment();

    await progress(0.92, "Grading the film");
    this.post = createPost(renderer, this.scene, this.camera, quality);
    this.post.fog.setBox(new Vector3(...SHOP_BOX.min), new Vector3(...SHOP_BOX.max));
    this.post.fog.uniforms.get("uDensity")!.value = 0.014;
    (this.post.fog.uniforms.get("uAmbient")!.value as Color).set(0x0d0c12);
    this.post.fog.uniforms.get("uAmbientDensity")!.value = 0.01;

    this.rig = new CameraRig(this.camera, this.ctx.canvas, SHOTS, WALKABLE);
    this.rig.onModeChange = (m) => this.ctx.overlay.setCinematic(m === "cinematic");
    const start = SHOTS.find((s) => s.name.toLowerCase() === (this.ctx.params.cam ?? "konbini").toLowerCase()) ?? SHOTS[0];
    this.camera.position.set(...start.to.pos);
    this.camera.lookAt(...start.to.target);
    this.camera.fov = start.to.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    await progress(1, "Opening the doors");
    if (this.ctx.params.exporting) this.exposeExport();
  }

  /** `window.pocketAtlasExport()` → glTF + environment for the Vita cooker. */
  private exposeExport(): void {
    const w = window as unknown as { pocketAtlasExport?: (seconds?: number) => Promise<unknown> };
    w.pocketAtlasExport = async (seconds = 20) => {
      const { exportPlace } = await import("./export");
      return exportPlace({
        renderer: this.ctx.renderer,
        world: this.world,
        baker: this.baker,
        env: this.envCube,
        envPosition: [3.5, 2.2, 3.0],
        shots: SHOTS,
        walkable: WALKABLE,
        intro: INTRO_FROM,
        shopBox: SHOP_BOX,
        fog: { color: (this.scene.fog as FogExp2).color.toArray(), density: (this.scene.fog as FogExp2).density },
        haze: {
          density: this.post.fog.uniforms.get("uDensity")!.value as number,
          ambient: (this.post.fog.uniforms.get("uAmbient")!.value as Color).toArray(),
          ambientDensity: this.post.fog.uniforms.get("uAmbientDensity")!.value as number,
        },
        environmentIntensity: this.scene.environmentIntensity,
        doors: this.konbini.door,
        record: seconds,
        fps: 15,
        onProgress: (label) => console.info(`[export] ${label}`),
      });
    };
  }

  /** Renders the finished street into a cube map once; PMREM makes it the IBL. */
  private captureEnvironment(): void {
    const { renderer } = this.ctx;
    const rt = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cube = new CubeCamera(0.1, 1200, rt);
    cube.position.set(3.5, 2.2, 3.0);
    this.scene.add(cube);
    this.rain.group.visible = false;
    renderer.shadowMap.needsUpdate = true;
    cube.update(renderer, this.scene);
    this.rain.group.visible = true;
    this.scene.remove(cube);
    const pmrem = new PMREMGenerator(renderer);
    this.env = pmrem.fromCubemap(rt.texture).texture;
    pmrem.dispose();
    if (this.ctx.params.exporting) this.envCube = rt;
    else rt.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.38;
  }

  enter(): void {
    const shots = SHOTS.map((s) => s.name);
    this.ctx.overlay.showPlace(this.place, {
      onBack: () => this.ctx.nav.closePlace(),
      onCinematic: () => this.rig.toggleCinematic(),
      onShot: (name) => this.rig.goTo(name),
    }, shots);
    addEventListener("keydown", this.keyHandler);
    this.audio.start();
    const p = this.ctx.params;
    if (p.shot) {
      this.rig.goTo(p.cam ?? "Konbini");
      if (p.view && p.view.length >= 6) {
        const v = p.view;
        this.rig.goToKey({ pos: [v[0], v[1], v[2]], target: [v[3], v[4], v[5]], fov: v[6] ?? 40 });
      }
      this.rig.autoCinematicAfter = Infinity;
    } else {
      const to = SHOTS[0].to;
      this.rig.startIntro(INTRO_FROM, to, 7.5);
    }
  }

  leave(): void {
    this.audio.stop();
    removeEventListener("keydown", this.keyHandler);
    this.ctx.overlay.hidePlace();
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.height = height * pixelRatio;
    this.post.setSize(width, height);
    this.reflection.setSize(width * pixelRatio, height * pixelRatio);
  }

  frame(dt: number, time: number): void {
    const { renderer } = this.ctx;
    this.rig.update(dt, time);
    this.camera.updateMatrixWorld();
    const camPos = this.camera.position;
    this.wet.uTime.value = time;
    for (const u of this.world.updaters) u(dt, time);
    this.updateDoor(dt);
    this.audio.update(dt, this.camera, SHOP_DOOR);
    this.sky.update(time, camPos);
    this.weather(time);
    this.rain.update(time, this.camera, this.rig.target, this.height);
    this.post.fog.sync(this.camera, this.world.fogLights);
    this.post.grade.uniforms.get("uFade")!.value = this.rig.fade;
    const bars = this.post.grade.uniforms.get("uBars")!;
    bars.value += ((this.rig.mode === "cinematic" ? 1 : 0) - bars.value) * (1 - Math.exp(-dt * 2.5));
    if (this.post.dof) {
      const cocMat = this.post.dof.cocMaterial;
      cocMat.focusDistance = this.rig.focusDistance();
      cocMat.focusRange = Math.max(7, this.rig.focusDistance() * 1.5);
    }
    this.reflection.update(renderer, this.scene, this.camera);
    // Casters are almost all static; the taxi, doors and people move slowly
    // enough that refreshing shadow maps at 20 Hz is indistinguishable.
    if (this.frameNo++ % 3 === 0) renderer.shadowMap.needsUpdate = true;
    this.post.render(dt);
  }

  /** Rain swells and eases over a minute or so; gusts lean the streaks. */
  private weather(t: number): void {
    const swell = 0.5 + 0.5 * Math.sin(t * 0.09) * Math.sin(t * 0.037 + 1.3);
    const intensity = 0.85 + 0.35 * swell;
    const gust = Math.max(0, Math.sin(t * 0.21) * Math.sin(t * 0.083 + 0.7));
    this.rain.intensity = intensity;
    this.rain.wind.set(0.7 + 2.2 * gust, 0.3 + 0.6 * gust);
    this.wet.uRain.value = 0.9 + 0.1 * swell;
    this.audio.setIntensity(intensity, gust);
  }

  private updateDoor(dt: number): void {
    const d = this.konbini.door;
    const doorPos = new Vector3(2.1, 1.0, L.konbini.front);
    const near = this.camera.position.distanceTo(doorPos) < 3.2;
    const goal = near ? 1 : 0;
    if (near && d.open < 0.05) this.audio.chime();
    d.open += (goal - d.open) * (1 - Math.exp(-dt * (goal ? 3.5 : 2.2)));
    d.left.position.x = 1.6 - d.open * 0.98;
    d.right.position.x = 2.6 + d.open * 0.98;
  }

  dispose(): void {
    const { renderer } = this.ctx;
    this.rig.dispose();
    this.post.dispose();
    this.reflection.dispose();
    this.rain.dispose();
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
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.autoUpdate = true;
  }
}
