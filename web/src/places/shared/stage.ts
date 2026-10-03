import { CubeCamera, HalfFloatType, PMREMGenerator, Scene, Vector3, WebGLCubeRenderTarget, type DirectionalLight, type FogExp2, type InstancedMesh, type Mesh, type PerspectiveCamera, type Skeleton, type SkinnedMesh, type Texture, type WebGLRenderTarget } from "three";
import type { PlaceDef, Stage, StageContext } from "../../core/types";
import type { Baker } from "./bake";
import { CameraRig, type Box6, type Shot, type ShotKey } from "./camera";
import type { CommonMeta, ExportWorld } from "./export";
import { postMeta, type PlacePost } from "./post";

/** What a place's soundscape offers the stage (its per-frame update is the place's own). */
export interface PlaceAudio {
  start(): void;
  stop(): void;
}

/** A place's camera: the named shots, the volumes the free camera may roam, the orbit focus and the intro flight. */
export interface PlaceViews {
  shots: Shot[];
  walkable: Box6[];
  focus: Box6;
  intro: ShotKey;
  /** Intro flight to the first shot (s). */
  introSeconds: number;
  /** Field of view of a `?view=` debug camera without one (degrees). */
  viewFov?: number;
}

/**
 * What every place stage shares: the camera rig over the place's shots, the
 * sun's fitted shadow, the light probe, the post chain's per-frame uniforms,
 * the export hook for the cooker and the dispose path. A place builds its
 * world (setting `baker`, `world`, `post`) and steps it in `advance()`.
 */
export abstract class PlaceStage<W extends ExportWorld = ExportWorld, A extends PlaceAudio = PlaceAudio> implements Stage {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  protected readonly ctx: StageContext;
  protected readonly place: PlaceDef;
  protected readonly views: PlaceViews;
  protected readonly audio: A;
  protected baker!: Baker;
  protected world!: W;
  protected post!: PlacePost;
  protected rig!: CameraRig;
  protected sun: DirectionalLight | null = null;
  private envTarget: WebGLRenderTarget | null = null;
  private envCube: WebGLCubeRenderTarget | null = null;
  private envAt = new Vector3();
  private shadowFrames = 0;
  private exportHook?: (seconds?: number) => Promise<unknown>;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "c" || e.key === "C") this.rig.toggleCinematic();
  };

  protected constructor(ctx: StageContext, place: PlaceDef, camera: PerspectiveCamera, views: PlaceViews, audio: A) {
    this.ctx = ctx;
    this.place = place;
    this.camera = camera;
    this.views = views;
    this.audio = audio;
  }

  /** The place's per-frame work after the camera moves: updaters, sky, sound. */
  protected abstract advance(dt: number, time: number): void;

  /** The camera rig over the shots; the camera starts at the `?cam` shot (else the first). */
  protected startRig(): void {
    const { shots, walkable, focus } = this.views;
    this.rig = new CameraRig(this.camera, this.ctx.canvas, shots, walkable, focus);
    this.rig.onModeChange = (m) => this.ctx.overlay.setCinematic(m === "cinematic");
    const name = (this.ctx.params.cam ?? shots[0].name).toLowerCase();
    const start = shots.find((s) => s.name.toLowerCase() === name) ?? shots[0];
    this.camera.position.set(...start.to.pos);
    this.camera.lookAt(...start.to.target);
    this.camera.fov = start.to.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /**
   * Fits the sun's orthographic shadow camera around a world box (the
   * detailed area), given as x, y and z ranges. The sun's direction is its
   * −Z (target child at (0, 0, −1)), as the glTF export reads it.
   */
  protected fitSunShadow(sun: DirectionalLight, xs: [number, number], ys: [number, number], zs: [number, number]): void {
    sun.updateMatrixWorld(true);
    const inv = sun.matrixWorld.clone().invert();
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const x of xs) for (const y of ys) for (const z of zs) {
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
  }

  /**
   * Renders the finished place into a cube map once at `at`; PMREM makes it
   * the image-based light. `before` / `after` wrap the capture (e.g. a probe
   * look of the sky). When exporting, the cube is kept for the cooker and
   * disposed after the export.
   */
  protected captureProbe(at: Vector3, opts: { near: number; far: number; intensity: number; before?: () => void; after?: () => void }): void {
    const { renderer } = this.ctx;
    const rt = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cube = new CubeCamera(opts.near, opts.far, rt);
    cube.position.copy(at);
    this.envAt.copy(at);
    this.scene.add(cube);
    renderer.shadowMap.needsUpdate = true;
    opts.before?.();
    cube.update(renderer, this.scene);
    opts.after?.();
    this.scene.remove(cube);
    const pmrem = new PMREMGenerator(renderer);
    this.envTarget = pmrem.fromCubemap(rt.texture);
    pmrem.dispose();
    if (this.ctx.params.exporting) this.envCube = rt;
    else rt.dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = opts.intensity;
  }

  /**
   * `window.pocketAtlasExport(seconds)` → glTF, the probe and extra files for
   * the cooker (`scripts/export-place.ts`). `meta` arranges the place's
   * `extras.pocketAtlas`; `seconds` of motion are sampled into tracks.
   */
  protected exposeExport(opts: { seconds: number; files?: { name: string; texture: Texture }[]; meta: (c: CommonMeta, seconds: number) => Record<string, unknown> }): void {
    const w = window as unknown as { pocketAtlasExport?: (seconds?: number) => Promise<unknown> };
    let consumed = false;
    this.exportHook = async (seconds = this.ctx.authoring?.sampling.durationSeconds ?? opts.seconds) => {
      if (consumed) throw new Error("Export consumes a fresh scene; reload before exporting again");
      consumed = true;
      const { exportPlace } = await import("./export");
      const fog = this.scene.fog as FogExp2;
      try {
        return await exportPlace({
          renderer: this.ctx.renderer,
          world: this.world,
          baker: this.baker,
          env: this.envCube,
          envPosition: [this.envAt.x, this.envAt.y, this.envAt.z],
          shots: this.views.shots,
          walkable: this.views.walkable,
          intro: this.views.intro,
          fog: { color: fog.color.toArray(), density: fog.density },
          environmentIntensity: this.scene.environmentIntensity,
          record: seconds,
          fps: this.ctx.authoring?.sampling.fps ?? 15,
          startSeconds: this.ctx.authoring?.sampling.startSeconds ?? 0,
          authoring: this.ctx.authoring ? { ...this.ctx.authoring, sampling: { ...this.ctx.authoring.sampling, durationSeconds: seconds } } : undefined,
          files: opts.files,
          meta: (c) => opts.meta(c, seconds),
          onProgress: (label) => console.info(`[export] ${label}`),
        });
      } finally {
        this.envCube?.dispose();
        this.envCube = null;
      }
    };
    w.pocketAtlasExport = this.exportHook;
  }

  /** The tone curve, grade and bloom for the export's `post`. */
  protected postMeta(): Record<string, unknown> {
    return postMeta(this.post, this.ctx.renderer.toneMappingExposure);
  }

  enter(): void {
    const { shots, intro, introSeconds, viewFov } = this.views;
    this.ctx.overlay.showPlace(
      this.place,
      {
        onBack: () => this.ctx.nav.closePlace(),
        onCinematic: () => this.rig.toggleCinematic(),
        onShot: (name) => this.rig.goTo(name),
      },
      shots.map((s) => s.name),
    );
    addEventListener("keydown", this.keyHandler);
    this.audio.start();
    const p = this.ctx.params;
    if (p.shot || p.cam) {
      this.rig.goTo(p.cam ?? shots[0].name);
      if (p.view && p.view.length >= 6) {
        const v = p.view;
        this.rig.goToKey({ pos: [v[0], v[1], v[2]], target: [v[3], v[4], v[5]], fov: v[6] ?? viewFov ?? 40 });
      }
      if (p.shot) this.rig.autoCinematicAfter = Infinity;
    } else {
      this.rig.startIntro(intro, shots[0].to, introSeconds);
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
    this.advance(dt, time);
    const u = this.post.grade.uniforms;
    u.get("uFade")!.value = this.rig.fade;
    const bars = u.get("uBars")!;
    bars.value += ((this.rig.mode === "cinematic" ? 1 : 0) - bars.value) * (1 - Math.exp(-dt * 2.5));
    // Static places reuse the map; an advance() with moving casters may invalidate it.
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
    this.envTarget?.dispose();
    this.envCube?.dispose();
    const skeletons = new Set<Skeleton>();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        if ((m as InstancedMesh).isInstancedMesh) (m as InstancedMesh).dispose();
        if ((m as SkinnedMesh).isSkinnedMesh) skeletons.add((m as SkinnedMesh).skeleton);
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v && typeof v === "object" && "isTexture" in v) (v as Texture).dispose();
          mat.dispose();
        }
      }
    });
    for (const skeleton of skeletons) skeleton.dispose();
    this.sun?.shadow.map?.dispose();
    const w = window as unknown as { pocketAtlasExport?: unknown };
    if (w.pocketAtlasExport === this.exportHook) delete w.pocketAtlasExport;
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.autoUpdate = true;
    renderer.toneMappingExposure = 1;
  }
}
