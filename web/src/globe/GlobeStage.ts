import {
  AddEquation,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  CustomBlending,
  DataTexture,
  Euler,
  Float32BufferAttribute,
  FrontSide,
  GLSL3,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  NoColorSpace,
  NormalBlending,
  OneFactor,
  PerspectiveCamera,
  Points,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SrcAlphaFactor,
  AdditiveBlending,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
  type Texture,
  type WebGLRenderTarget,
} from "three";
import { CITIES } from "../cities/registry";
import { Rng } from "../core/random";
import type { CityDef, Navigator, Stage, StageContext } from "../core/types";
import { bakeAlbedo, bakeClouds, bakeNormals, bakeRelief, bakeSky, bakeTransmittance, GpuBaker } from "./bake/gpu";
import { buildCoastPatch } from "./bake/coastPatch";
import { loadLand, SMALL_H, SMALL_W } from "./bake/land";
import { bakeLights, LIGHTS_MAX } from "./bake/lights";
import {
  ATMOSPHERE_RADIUS,
  CLOUD_RADIUS,
  clamp,
  DEG,
  easeInOutCubic,
  easeOutCubic,
  latLonToVec,
  smoothstep,
  wrapDeg,
  yieldFrame,
} from "./geo";
import { Markers } from "./Markers";
import { GlobePost } from "./post";
import { atmosphereFrag, cloudFrag, earthFrag, SPHERE_VERT } from "./shaders/earth";
import { SKY_FRAG, SKY_VERT, STAR_FRAG, STAR_VERT } from "./shaders/space";

/** Direction towards the sun in view-aligned world space (camera on +Z). */
const SUN = new Vector3(-0.84, 0.31, -0.5).normalize();
/** Galactic frame for the Milky Way bake and star clustering. */
// The band crosses the sky between the globe and the destination list; the
// bulge sits just above the top edge of the frame.
const GAL_N = new Vector3(-0.933, 0.34, -0.115).normalize();
const GAL_C = new Vector3(0.3, 0.55, -1).projectOnPlane(GAL_N).normalize();

const START = { lat: 31, lon: 131 };
const FOV = 30;
const IDLE_DEG_PER_S = 1.6;
/** Fly-in timeline (s): facing turn, vista over the city, end of plunge. */
const DIVE_ROTATE = 1.25;
const DIVE_VISTA = 2.75;
const DIVE_TOTAL = 3.6;
/** Camera-to-city distances (planet radii) at the vista and at the end of the plunge. */
const VISTA_ALT = 0.075;
const DIVE_END_ALT = 0.0135;

interface Settings {
  texW: number;
  cloudW: number;
  steps: number;
  cloudSteps: number;
  segments: number;
  towns: number;
  stars: number;
  skyW: number;
}

function settingsFor(level: string): Settings {
  switch (level) {
    case "low":
      return { texW: 2048, cloudW: 2048, steps: 6, cloudSteps: 4, segments: 128, towns: 26000, stars: 3200, skyW: 1024 };
    case "medium":
      return { texW: 2048, cloudW: 2048, steps: 8, cloudSteps: 5, segments: 192, towns: 36000, stars: 6000, skyW: 2048 };
    case "ultra":
      return { texW: 4096, cloudW: 4096, steps: 12, cloudSteps: 7, segments: 320, towns: 64000, stars: 11000, skyW: 2048 };
    default:
      return { texW: 4096, cloudW: 2048, steps: 10, cloudSteps: 6, segments: 256, towns: 56000, stars: 9000, skyW: 2048 };
  }
}

type Mode = "intro" | "free" | "dive" | "done" | "return";

interface Snapshot {
  lat: number;
  lon: number;
  alt: number;
  fov: number;
  shiftX: number;
  shiftY: number;
  pitch: number;
}

export async function createGlobeStage(ctx: StageContext, nav: Navigator): Promise<Stage> {
  const stage = new GlobeStage(ctx, nav);
  await stage.build();
  return stage;
}

class GlobeStage implements Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 0.001, 400);

  private cfg: Settings;
  private earthGroup = new Group();
  private spaceGroup = new Group();
  private shared: Record<string, IUniform> = {};
  private earthMat!: ShaderMaterial;
  private cloudMat!: ShaderMaterial;
  private atmoMat!: ShaderMaterial;
  private skyMat!: ShaderMaterial;
  private starMat!: ShaderMaterial;
  private cloudMesh!: Mesh;
  private markers!: Markers;
  private post!: GlobePost;
  private targets: WebGLRenderTarget[] = [];
  private textures: Texture[] = [];
  private geometries: BufferGeometry[] = [];
  private listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];

  // View state. `lat`/`lon` is the geographic point facing the camera.
  private lat = START.lat;
  private lon = START.lon;
  private vLat = 0;
  private vLon = 0;
  private zoom = 1;
  private zoomTarget = 1;
  private baseDist = 4.5;
  private alt = 3.5;
  private fov = FOV;
  private shiftX = 0;
  private shiftY = 0;
  private shiftTargetX = 0;
  private shiftTargetY = 0;
  private pitch = 0;
  private roll = 0;
  private w = 1;
  private h = 1;
  private euler = new Euler();
  private nadirTmp = new Vector3();
  private invQuat = new Quaternion();

  // Interaction.
  private pointers = new Map<number, { x: number; y: number }>();
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private lastX = 0;
  private lastY = 0;
  private lastMoveT = 0;
  private pinch = 0;
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private lastInteract = -1e9;
  private hovered = -1;
  private cardHover = -1;
  private shownHover = -1;
  private focus: { lat: number; lon: number; until: number } | null = null;

  // Sequencing.
  private mode: Mode = "free";
  private modeT = 0;
  private from: Snapshot | null = null;
  private diveCity = -1;
  private lastCity: CityDef | null = null;
  private entered = false;
  private visible = false;
  private fadeStarted = false;
  private time = 0;
  private debugDiveT: number | null = null;
  private sound: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private soundStarted = false;
  private cancelAudio: (() => void) | null = null;
  readonly timings: Record<string, number> = {};
  private cancelCoast: (() => void) | null = null;
  private disposed = false;

  constructor(
    private ctx: StageContext,
    private nav: Navigator,
  ) {
    this.cfg = settingsFor(ctx.quality.level);
  }

  // ------------------------------------------------------------------ build

  async build(): Promise<void> {
    const { renderer } = this.ctx;
    const cfg = this.cfg;
    const t0 = performance.now();
    const mark = (k: string, since: number) => (this.timings[k] = Math.round(performance.now() - since));
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const texH = cfg.texW / 2;

    let t = performance.now();
    const land = await loadLand(cfg.texW, texH);
    mark("land", t);
    await yieldFrame();

    t = performance.now();
    const lightsData = bakeLights(cfg.texW, texH, land.small, cfg.towns);
    const lights = new DataTexture(lightsData, cfg.texW, texH, RGFormat, UnsignedByteType);
    this.setupEquirect(lights, aniso, true);
    this.textures.push(lights);
    mark("lights", t);
    await yieldFrame();

    t = performance.now();
    const maskTex = new CanvasTexture(land.canvas as HTMLCanvasElement);
    maskTex.flipY = false;
    maskTex.generateMipmaps = false;
    maskTex.minFilter = LinearFilter;
    maskTex.colorSpace = NoColorSpace;
    maskTex.wrapS = RepeatWrapping;
    const fieldsTex = new DataTexture(land.fields, SMALL_W, SMALL_H, RGBAFormat, UnsignedByteType);
    fieldsTex.minFilter = LinearFilter;
    fieldsTex.magFilter = LinearFilter;
    fieldsTex.wrapS = RepeatWrapping;
    fieldsTex.needsUpdate = true;

    const baker = new GpuBaker(renderer);
    const trans = bakeTransmittance(baker);
    const reliefW = cfg.texW / 2;
    const relief = bakeRelief(baker, reliefW, reliefW / 2, { tMask: { value: maskTex } });
    const normals = bakeNormals(
      baker,
      reliefW,
      reliefW / 2,
      { tRelief: { value: relief.texture }, uReliefRes: { value: new Vector2(reliefW, reliefW / 2) }, uBump: { value: 0.05 } },
      aniso,
    );
    const albedo = bakeAlbedo(
      baker,
      cfg.texW,
      texH,
      { tMask: { value: maskTex }, tFields: { value: fieldsTex }, tRelief: { value: relief.texture } },
      aniso,
    );
    await yieldFrame();
    const clouds = bakeClouds(baker, cfg.cloudW, cfg.cloudW / 2, aniso);
    const sky = bakeSky(baker, cfg.skyW, cfg.skyW / 2, { uGalN: { value: GAL_N }, uGalC: { value: GAL_C } });
    baker.dispose();
    relief.dispose();
    maskTex.dispose();
    fieldsTex.dispose();
    this.targets.push(trans, normals, albedo, clouds, sky);
    mark("gpu", t);

    // ---------------------------------------------------------- materials
    this.shared = {
      uEarthRot: { value: new Matrix3() },
      uSunDir: { value: SUN.clone() },
      uLightsMax: { value: LIGHTS_MAX },
      uLightsGain: { value: 0.95 },
      uNight: { value: 0.012 },
      uCloudOffset: { value: new Vector2() },
      uTime: { value: 0 },
      tTransmittance: { value: trans.texture },
      uSunI: { value: 6.5 },
      uSurface: { value: 0.82 },
    };
    const S = this.shared;
    const seg = cfg.segments;

    this.earthMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SPHERE_VERT,
      fragmentShader: earthFrag(cfg.steps),
      uniforms: {
        ...S,
        tAlbedo: { value: albedo.texture },
        tNormal: { value: normals.texture },
        tLights: { value: lights },
        tClouds: { value: clouds.texture },
        uCloudShadow: { value: 0.5 },
        uSpecular: { value: 1 },
        uDetail: { value: 0 },
        tCoast: { value: null },
        uCoastRect: { value: new Vector4() },
        uCoastOn: { value: 0 },
      },
    });
    const earthGeo = new SphereGeometry(1, seg, seg / 2);
    const earth = new Mesh(earthGeo, this.earthMat);

    this.cloudMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SPHERE_VERT,
      fragmentShader: cloudFrag(cfg.cloudSteps),
      uniforms: {
        ...S,
        tClouds: { value: clouds.texture },
        tLights: { value: lights },
        uOpacity: { value: 1.05 },
        uGlow: { value: 0.7 },
        uDetail: { value: 0 },
        uTarget: { value: new Vector4(0, 0, 1, 0) },
        uNadir: { value: new Vector4(0, 0, 1, 0) },
      },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    const cloudGeo = new SphereGeometry(CLOUD_RADIUS, seg, seg / 2);
    this.cloudMesh = new Mesh(cloudGeo, this.cloudMat);
    this.cloudMesh.renderOrder = 2;

    this.atmoMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SPHERE_VERT,
      fragmentShader: atmosphereFrag(cfg.steps + 2),
      uniforms: { ...S, uAirglow: { value: 0.1 }, uLimbBoost: { value: 1.5 }, uTerminator: { value: 0.35 } },
      side: BackSide,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: SrcAlphaFactor,
    });
    const atmoGeo = new SphereGeometry(ATMOSPHERE_RADIUS, Math.max(96, seg / 2), Math.max(48, seg / 4));
    const atmosphere = new Mesh(atmoGeo, this.atmoMat);
    atmosphere.renderOrder = 4;

    this.markers = new Markers(CITIES);

    this.earthGroup.add(earth, this.cloudMesh, this.markers.group);
    this.scene.add(this.earthGroup, atmosphere);

    // --------------------------------------------------------------- space
    this.skyMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { tSky: { value: sky.texture }, uSunDir: S.uSunDir, uSkyGain: { value: 1.35 }, uSunGlow: { value: 1 } },
      side: BackSide,
      depthWrite: false,
    });
    const skyGeo = new SphereGeometry(100, 64, 32);
    const skyMesh = new Mesh(skyGeo, this.skyMat);
    skyMesh.renderOrder = -10;
    const stars = this.makeStars(cfg.stars);
    this.spaceGroup.add(skyMesh, stars);
    this.scene.add(this.spaceGroup);
    for (const o of [skyMesh, stars, atmosphere]) o.frustumCulled = false;
    this.geometries.push(earthGeo, cloudGeo, atmoGeo, skyGeo, stars.geometry);

    // ---------------------------------------------------------------- post
    this.post = new GlobePost(renderer, this.scene, this.camera, this.ctx.quality.msaa, this.ctx.quality.level === "low");

    this.bindInput();
    this.applyView();
    t = performance.now();
    await renderer.compileAsync(this.scene, this.camera);
    this.post.render(0, true);
    mark("compile", t);
    this.timings.total = Math.round(performance.now() - t0);

    if (this.ctx.params.stats) console.info("[globe] build ms", JSON.stringify(this.timings));
    this.loadCoastPatch();
    if (import.meta.env.DEV) this.exposeDebug();
  }

  /** High-resolution coastline for the fly-in, built in a worker while the globe is already on screen. */
  private loadCoastPatch(): void {
    const live = CITIES.find((c) => c.status === "live");
    if (!live) return;
    const t0 = performance.now();
    const job = buildCoastPatch(live.lat, live.lon);
    this.cancelCoast = job.cancel;
    void job.promise.then((patch) => {
      this.cancelCoast = null;
      if (!patch || this.disposed) {
        patch?.texture.dispose();
        return;
      }
      this.textures.push(patch.texture);
      const u = this.earthMat.uniforms;
      u.tCoast.value = patch.texture;
      (u.uCoastRect.value as Vector4).copy(patch.rect);
      u.uCoastOn.value = 1;
      this.ctx.renderer.initTexture(patch.texture);
      this.timings.coast = Math.round(performance.now() - t0);
      if (this.ctx.params.stats) console.info("[globe] coast patch ms", this.timings.coast);
    });
  }

  private setupEquirect(tex: Texture, aniso: number, mip: boolean): void {
    tex.wrapS = RepeatWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = mip ? LinearMipmapLinearFilter : LinearFilter;
    tex.generateMipmaps = mip;
    tex.anisotropy = aniso;
    tex.colorSpace = NoColorSpace;
    tex.needsUpdate = true;
  }

  private makeStars(count: number): Points {
    const rng = new Rng(0x57a125);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const e2 = new Vector3().crossVectors(GAL_N, GAL_C);
    const v = new Vector3();
    const tints = [
      new Color(0.66, 0.76, 1.0),
      new Color(0.86, 0.9, 1.0),
      new Color(1.0, 0.97, 0.92),
      new Color(1.0, 0.9, 0.76),
      new Color(1.0, 0.76, 0.55),
      new Color(1.0, 0.64, 0.45),
    ];
    const weights = [0.08, 0.2, 0.3, 0.2, 0.14, 0.08];
    for (let i = 0; i < count; i++) {
      if (rng.next() < 0.38) {
        const l = rng.range(0, Math.PI * 2);
        const b = rng.gauss() * 0.1;
        v.copy(GAL_C).multiplyScalar(Math.cos(l) * Math.cos(b)).addScaledVector(e2, Math.sin(l) * Math.cos(b)).addScaledVector(GAL_N, Math.sin(b));
      } else {
        const z = rng.range(-1, 1);
        const phi = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(1 - z * z);
        v.set(r * Math.cos(phi), r * Math.sin(phi), z);
      }
      v.normalize().multiplyScalar(90).toArray(pos, i * 3);
      const u = rng.next();
      const bright = 0.05 + 0.5 * Math.pow(u, 5) + 2.2 * Math.pow(u, 40);
      let k = rng.next();
      let ti = 0;
      while (ti < weights.length - 1 && k > weights[ti]) k -= weights[ti++];
      const c = tints[ti];
      col[i * 3] = c.r * bright;
      col[i * 3 + 1] = c.g * bright;
      col[i * 3 + 2] = c.b * bright;
      size[i] = 1.6 + 2.4 * Math.pow(u, 8) + rng.next() * 0.6;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new Float32BufferAttribute(col, 3));
    geo.setAttribute("aSize", new Float32BufferAttribute(size, 1));
    this.starMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uPixelRatio: { value: 1 }, uBright: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const pts = new Points(geo, this.starMat);
    pts.renderOrder = -9;
    return pts;
  }

  // ------------------------------------------------------------- lifecycle

  enter(): void {
    this.visible = true;
    this.ctx.overlay.showGlobe({
      onHover: (id) => this.onCardHover(id),
      onSelect: (id) => this.select(id),
    });
    this.measureLayout();
    this.post.fade = 0;
    this.shownHover = -1;
    this.lastInteract = this.time;
    if (!this.entered) {
      this.entered = true;
      if (this.ctx.params.shot) this.snapToOverview();
      else this.startIntro();
    } else if (this.lastCity) {
      this.startReturn(this.lastCity);
    } else {
      this.mode = "free";
    }
  }

  leave(): void {
    this.visible = false;
    this.ctx.overlay.hideGlobe();
    this.ctx.overlay.setHovered(null);
    this.ctx.overlay.hideTooltip();
    this.ctx.canvas.classList.remove("is-pointing");
    this.stopSound();
    this.pointers.clear();
    this.dragging = false;
    this.hovered = -1;
    this.cardHover = -1;
    this.shownHover = -1;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.w = width;
    this.h = height;
    this.camera.aspect = width / height;
    this.measureLayout();
    if (this.mode === "free") {
      this.shiftX = this.shiftTargetX;
      this.shiftY = this.shiftTargetY;
    }
    this.post.setSize(width, height);
    this.starMat.uniforms.uPixelRatio.value = pixelRatio;
    this.applyView();
  }

  /** Frames the globe in the area the destination list leaves free. */
  private measureLayout(): void {
    const w = this.w;
    const h = this.h;
    let freeW = w;
    let freeH = h;
    let sx = 0;
    let sy = 0;
    const list = this.ctx.overlay.root.querySelector<HTMLElement>(".pc-city-list");
    const r = list?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      if (r.left > w * 0.45) {
        freeW = r.left;
        sx = (w - freeW) / 2;
      } else if (r.top > h * 0.35) {
        // Stacked layout: the list sits below, the brand header above.
        const brand = this.ctx.overlay.root.querySelector<HTMLElement>(".pc-brand")?.getBoundingClientRect();
        const top = brand && brand.height > 0 ? brand.bottom + 8 : 0;
        freeH = r.top - top;
        sy = h / 2 - (top + freeH / 2);
      }
    }
    this.shiftTargetX = sx;
    this.shiftTargetY = sy;
    const radiusPx = Math.min(0.37 * h, 0.4 * freeW, 0.4 * freeH);
    const a = Math.atan((radiusPx / (h / 2)) * Math.tan((FOV / 2) * DEG));
    this.baseDist = 1 / Math.sin(a);
  }

  frame(dt: number, time: number): void {
    this.time = time;
    this.shared.uTime.value = time;
    if (this.mode === "done") {
      // Behind the loading screen: keep the canvas black and the GPU idle.
      const r = this.ctx.renderer;
      r.setRenderTarget(null);
      r.setClearColor(0x000000, 1);
      r.clear();
      return;
    }
    this.updateMotion(dt);
    this.applyView();
    this.updateHover();

    const altNow = this.camera.position.length() - 1;
    (this.shared.uCloudOffset.value as Vector2).set(time * 0.00005, 0);
    // Close to the surface the baked maps are magnified; blend in procedural detail.
    const zoomDetail = smoothstep(1.2, 0.2, altNow);
    this.cloudMat.uniforms.uDetail.value = zoomDetail;
    this.earthMat.uniforms.uDetail.value = zoomDetail;
    const target = this.cloudMat.uniforms.uTarget.value as Vector4;
    const nadir = this.cloudMat.uniforms.uNadir.value as Vector4;
    if (this.mode === "dive" && this.diveCity >= 0) {
      const c = CITIES[this.diveCity];
      const d = latLonToVec(c.lat, c.lon);
      target.set(d.x, d.y, d.z, 1);
      const n = this.nadirTmp.copy(this.camera.position).applyQuaternion(this.invQuat.copy(this.earthGroup.quaternion).invert()).normalize();
      const plunge = clamp(((this.debugDiveT ?? this.modeT) - DIVE_VISTA) / (DIVE_TOTAL - DIVE_VISTA), 0, 1);
      nadir.set(n.x, n.y, n.z, smoothstep(0.25, 0.85, plunge));
    } else {
      target.w = 0;
      nadir.w = 0;
    }
    // Up close the frame is all city light: hold exposure and bloom back.
    const low = smoothstep(0.03, 0.002, altNow);
    this.shared.uLightsGain.value = 0.95 * (1 - 0.35 * zoomDetail) * (1 - 0.5 * low);
    this.post.bloom.intensity = 0.95 * (1 - 0.45 * zoomDetail);
    this.cloudMat.side = this.camera.position.length() < CLOUD_RADIUS ? BackSide : FrontSide;

    const pxPerUnit = (2 * Math.tan((this.fov / 2) * DEG)) / this.h;
    const active = this.hovered >= 0 ? this.hovered : this.cardHover;
    const diveT = (this.debugDiveT ?? this.modeT);
    const diveFade = this.mode === "dive" ? smoothstep(DIVE_ROTATE * 0.9, DIVE_VISTA - 0.5, diveT) : 0;
    this.markers.update(dt, time, active, pxPerUnit, this.mode === "dive" ? Math.max(0.001, diveFade) : 0, this.diveCity);

    this.post.render(dt, this.ctx.params.shot);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelCoast?.();
    this.leave();
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners = [];
    for (const rt of this.targets) rt.dispose();
    for (const t of this.textures) t.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of [this.earthMat, this.cloudMat, this.atmoMat, this.skyMat, this.starMat]) m.dispose();
    this.markers.dispose();
    this.post.dispose();
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__globe;
  }

  // ---------------------------------------------------------------- motion

  private snapshot(): Snapshot {
    return { lat: this.lat, lon: this.lon, alt: this.alt, fov: this.fov, shiftX: this.shiftX, shiftY: this.shiftY, pitch: this.pitch };
  }

  private snapToOverview(): void {
    this.mode = "free";
    this.lat = START.lat;
    this.lon = START.lon;
    this.zoom = this.zoomTarget = 1;
    this.alt = this.baseDist - 1;
    this.fov = FOV;
    this.shiftX = this.shiftTargetX;
    this.shiftY = this.shiftTargetY;
    this.pitch = this.roll = 0;
  }

  private startIntro(): void {
    this.snapToOverview();
    this.mode = "intro";
    this.modeT = 0;
    this.from = { ...this.snapshot(), lon: START.lon + 38, lat: START.lat - 6, alt: (this.baseDist - 1) * 2.3 };
  }

  private startReturn(city: CityDef): void {
    this.mode = "return";
    this.modeT = 0;
    this.diveCity = -1;
    this.fadeStarted = false;
    this.focus = null;
    this.zoom = this.zoomTarget = 1;
    this.from = { lat: city.lat, lon: city.lon, alt: 0.035, fov: 22, shiftX: 0, shiftY: 0, pitch: 28 * DEG };
    this.lat = city.lat;
    this.lon = city.lon;
  }

  private updateMotion(dt: number): void {
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    this.modeT += dt;
    switch (this.mode) {
      case "intro": {
        const f = this.from!;
        const t = clamp(this.modeT / 3.6, 0, 1);
        const e = easeOutCubic(t);
        this.lon = f.lon + (START.lon - f.lon) * e;
        this.lat = f.lat + (START.lat - f.lat) * e;
        this.alt = Math.exp(Math.log(f.alt) + (Math.log(this.baseDist - 1) - Math.log(f.alt)) * easeInOutCubic(t));
        this.shiftX = this.shiftTargetX;
        this.shiftY = this.shiftTargetY;
        if (t >= 1) this.mode = "free";
        break;
      }
      case "return": {
        const f = this.from!;
        const t = clamp(this.modeT / 2.8, 0, 1);
        const e = easeOutCubic(t);
        const to = this.baseDist - 1;
        this.alt = Math.exp(Math.log(f.alt) + (Math.log(to) - Math.log(f.alt)) * easeOutCubic(Math.min(1, t * 1.1)));
        this.fov = f.fov + (FOV - f.fov) * e;
        this.pitch = f.pitch * (1 - e);
        this.shiftX = f.shiftX + (this.shiftTargetX - f.shiftX) * e;
        this.shiftY = f.shiftY + (this.shiftTargetY - f.shiftY) * e;
        this.lat = f.lat + (clamp(f.lat, -25, 42) - f.lat) * e;
        if (t >= 1) this.mode = "free";
        break;
      }
      case "dive":
        this.updateDive();
        break;
      case "free":
      default: {
        if (!this.dragging) {
          if (this.focus && this.time > this.focus.until) this.focus = null;
          if (this.focus) {
            // Critically damped spring towards the focus point.
            const w = 3.2;
            const dLon = wrapDeg(this.focus.lon - this.lon);
            const dLat = this.focus.lat - this.lat;
            this.vLon += (w * w * dLon - 2 * w * this.vLon) * dt;
            this.vLat += (w * w * dLat - 2 * w * this.vLat) * dt;
            this.lon += this.vLon * dt;
            this.lat += this.vLat * dt;
          } else {
            this.lon += this.vLon * dt;
            this.lat += this.vLat * dt;
            const decay = Math.exp(-dt * 2.2);
            this.vLon *= decay;
            this.vLat *= decay;
            const idle = this.ctx.params.shot || this.cardHover >= 0 || this.hovered >= 0 ? 0 : smoothstep(4, 7, this.time - this.lastInteract);
            this.lon -= IDLE_DEG_PER_S * idle * dt;
          }
        }
        this.zoom += (this.zoomTarget - this.zoom) * k(7);
        const targetAlt = (this.baseDist - 1) * this.zoom;
        this.alt += (targetAlt - this.alt) * k(6);
        this.fov += (FOV - this.fov) * k(4);
        this.shiftX += (this.shiftTargetX - this.shiftX) * k(4);
        this.shiftY += (this.shiftTargetY - this.shiftY) * k(4);
        this.pitch *= 1 - k(4);
        this.roll *= 1 - k(4);
      }
    }
    this.lat = clamp(this.lat, -70, 78);
    this.lon = wrapDeg(this.lon);
  }

  /**
   * Fly-in: turn the city to face the camera, descend while pitching up until
   * the limb and airglow sit at the top of frame over the city lights, hold a
   * beat, then plunge through the cloud deck while the image fades to black.
   */
  private updateDive(): void {
    const f = this.from!;
    const city = CITIES[this.diveCity];
    const t = this.debugDiveT ?? this.modeT;
    const a = easeInOutCubic(clamp(t / DIVE_ROTATE, 0, 1));
    this.lon = f.lon + wrapDeg(city.lon - f.lon) * a;
    this.lat = f.lat + (city.lat - f.lat) * a;
    this.shiftX = f.shiftX * (1 - a);
    this.shiftY = f.shiftY * (1 - a);

    const lerpLog = (x: number, y: number, k: number) => Math.exp(Math.log(x) + (Math.log(y) - Math.log(x)) * k);
    const plunge = clamp((t - DIVE_VISTA) / (DIVE_TOTAL - DIVE_VISTA), 0, 1);
    if (t < DIVE_VISTA) {
      this.alt = lerpLog(f.alt, VISTA_ALT, smoothstep(0, DIVE_VISTA, t));
    } else {
      this.alt = lerpLog(VISTA_ALT, DIVE_END_ALT, Math.pow(plunge, 1.7));
    }
    this.pitch = (62 * smoothstep(DIVE_ROTATE * 0.7, DIVE_VISTA, t) + 7 * plunge * plunge) * DEG;
    this.fov = f.fov + (32 - f.fov) * smoothstep(DIVE_ROTATE * 0.5, DIVE_VISTA, t) - 13 * smoothstep(0, 1, plunge);
    this.roll = (3 * smoothstep(DIVE_ROTATE, DIVE_VISTA, t) + 4 * plunge * plunge) * DEG;
    this.post.setZoomBlur(0.13 * smoothstep(0.05, 1, plunge), 0.5, 0.5);
    if (this.debugDiveT !== null) return;
    if (!this.soundStarted && t > DIVE_ROTATE - 0.3) this.playWhoosh();
    const fadeFrom = DIVE_TOTAL - 0.7;
    if (!this.fadeStarted && t > fadeFrom) {
      this.fadeStarted = true;
      void this.ctx.overlay.fadeTo(1, 680);
    }
    this.post.fade = smoothstep(fadeFrom, DIVE_TOTAL - 0.02, t);
    if (t >= DIVE_TOTAL + 0.05) {
      this.mode = "done";
      this.post.setZoomBlur(0, 0.5, 0.5);
      this.nav.openCity(city);
    }
  }

  private applyView(): void {
    this.euler.set(this.lat * DEG, -this.lon * DEG, 0, "XYZ");
    this.earthGroup.quaternion.setFromEuler(this.euler);
    this.earthGroup.updateMatrixWorld(true);
    (this.shared.uEarthRot.value as Matrix3).setFromMatrix4(this.earthGroup.matrixWorld);

    const cam = this.camera;
    const a = this.alt;
    cam.position.set(0, -Math.sin(this.pitch) * a, 1 + Math.cos(this.pitch) * a);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 1);
    if (this.roll) cam.rotateZ(this.roll);
    cam.fov = this.fov;
    // Near plane from the closest surface in front: the ground or, just above
    // it, the cloud deck.
    const h = cam.position.length() - 1;
    cam.near = clamp(Math.min(h, Math.abs(h - (CLOUD_RADIUS - 1))) * 0.4, 0.00002, 0.3);
    cam.far = 150;
    cam.aspect = this.w / this.h;
    if (Math.abs(this.shiftX) > 0.01 || Math.abs(this.shiftY) > 0.01) {
      cam.setViewOffset(this.w, this.h, this.shiftX, this.shiftY, this.w, this.h);
    } else {
      cam.clearViewOffset();
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.spaceGroup.position.copy(cam.position);
  }

  // ----------------------------------------------------------- interaction

  private on(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private interactive(): boolean {
    return this.visible && (this.mode === "free" || this.mode === "intro" || this.mode === "return");
  }

  private bindInput(): void {
    const canvas = this.ctx.canvas;
    this.on(canvas, "pointerdown", ((e: PointerEvent) => {
      if (!this.interactive()) return;
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.touch();
      if (this.mode !== "free") this.mode = "free";
      this.focus = null;
      if (this.pointers.size === 1) {
        this.dragging = true;
        this.downX = this.lastX = e.clientX;
        this.downY = this.lastY = e.clientY;
        this.downT = this.lastMoveT = performance.now();
        this.vLon = this.vLat = 0;
      } else if (this.pointers.size === 2) {
        this.pinch = this.pinchDistance();
      }
    }) as EventListener);
    this.on(canvas, "pointermove", ((e: PointerEvent) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pointerInside = true;
      const p = this.pointers.get(e.pointerId);
      if (!p || !this.interactive()) return;
      p.x = e.clientX;
      p.y = e.clientY;
      this.touch();
      if (this.pointers.size >= 2) {
        const d = this.pinchDistance();
        if (this.pinch > 0 && d > 0) this.zoomTarget = clamp(this.zoomTarget * (this.pinch / d), 0.42, 1.45);
        this.pinch = d;
        return;
      }
      if (!this.dragging) return;
      const now = performance.now();
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      const degPerPx = ((2 * Math.tan((this.fov / 2) * DEG) * this.alt) / this.h) / DEG;
      this.lon -= dx * degPerPx;
      this.lat += dy * degPerPx;
      const dtm = Math.max(1, now - this.lastMoveT) / 1000;
      const blend = 0.35;
      this.vLon = this.vLon * (1 - blend) + ((-dx * degPerPx) / dtm) * blend;
      this.vLat = this.vLat * (1 - blend) + ((dy * degPerPx) / dtm) * blend;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.lastMoveT = now;
    }) as EventListener);
    const up = ((e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (this.pointers.size === 0 && this.dragging) {
        this.dragging = false;
        const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
        const quick = performance.now() - this.downT < 450;
        if (performance.now() - this.lastMoveT > 90) this.vLon = this.vLat = 0;
        const maxV = 140;
        this.vLon = clamp(this.vLon, -maxV, maxV);
        this.vLat = clamp(this.vLat, -maxV, maxV);
        if (moved < 6 && quick && e.type === "pointerup") {
          this.vLon = this.vLat = 0;
          const hit = this.markers.pick(this.camera, e.clientX, e.clientY, this.w, this.h, e.pointerType === "touch" ? 28 : 18);
          if (hit) this.select(hit.city.id);
        }
      }
      if (this.pointers.size === 1) {
        // Pinch ended with one finger down: continue as a drag from here.
        const [rest] = this.pointers.values();
        this.lastX = rest.x;
        this.lastY = rest.y;
        this.dragging = true;
      }
      this.pinch = 0;
    }) as EventListener;
    this.on(canvas, "pointerup", up);
    this.on(canvas, "pointercancel", up);
    this.on(canvas, "pointerleave", ((e: PointerEvent) => {
      if (e.pointerType === "mouse" && this.pointers.size === 0) this.pointerInside = false;
    }) as EventListener);
    this.on(
      canvas,
      "wheel",
      ((e: WheelEvent) => {
        if (!this.interactive()) return;
        e.preventDefault();
        this.touch();
        if (this.mode !== "free") this.mode = "free";
        const scale = e.deltaMode === 1 ? 16 : 1;
        this.zoomTarget = clamp(this.zoomTarget * Math.exp(e.deltaY * scale * 0.0011), 0.42, 1.45);
      }) as EventListener,
      { passive: false },
    );
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private touch(): void {
    this.lastInteract = this.time;
  }

  private onCardHover(id: string | null): void {
    const i = id ? CITIES.findIndex((c) => c.id === id) : -1;
    this.cardHover = i;
    if (i >= 0 && this.mode === "free" && !this.dragging) {
      const c = CITIES[i];
      // Turn gently: bring the city into the lit-limb-free part of the disc without fully centring it.
      this.focus = { lat: clamp(c.lat * 0.75, -40, 55), lon: c.lon - 4, until: Infinity };
    } else if (i < 0 && this.focus && this.focus.until === Infinity) {
      this.focus = null;
      this.touch();
    }
  }

  private select(id: string): void {
    const i = CITIES.findIndex((c) => c.id === id);
    if (i < 0 || !this.interactive()) return;
    const city = CITIES[i];
    this.touch();
    if (city.status === "live" && city.load) {
      this.startDive(i);
    } else {
      if (this.mode !== "free") this.mode = "free";
      this.focus = { lat: clamp(city.lat * 0.8, -45, 60), lon: city.lon, until: this.time + 4.5 };
      this.ctx.overlay.toast(`${city.name} is under construction`);
    }
  }

  private startDive(i: number): void {
    this.mode = "dive";
    this.modeT = 0;
    this.diveCity = i;
    this.lastCity = CITIES[i];
    this.fadeStarted = false;
    this.soundStarted = false;
    this.focus = null;
    this.dragging = false;
    this.pointers.clear();
    this.vLat = this.vLon = 0;
    this.from = this.snapshot();
    this.ctx.overlay.hideGlobe();
    this.ctx.overlay.hideTooltip();
    this.ctx.canvas.classList.remove("is-pointing");
    this.hovered = -1;
    this.cardHover = -1;
  }

  private updateHover(): void {
    const overlay = this.ctx.overlay;
    let next = -1;
    if (this.interactive() && this.pointerInside && !this.dragging && this.pointers.size === 0) {
      const hit = this.markers.pick(this.camera, this.pointerX, this.pointerY, this.w, this.h, 18);
      if (hit) next = CITIES.indexOf(hit.city);
    }
    if (next !== this.hovered) {
      this.hovered = next;
      this.ctx.canvas.classList.toggle("is-pointing", next >= 0);
    }
    const active = this.mode === "dive" ? -1 : this.hovered >= 0 ? this.hovered : this.cardHover;
    if (active !== this.shownHover) {
      this.shownHover = active;
      if (this.visible) overlay.setHovered(active >= 0 ? CITIES[active].id : null);
      if (active < 0) overlay.hideTooltip();
    }
    if (active >= 0 && this.visible) {
      const sp = this.markers.screenPos(active, this.camera, this.w, this.h);
      if (sp) overlay.showTooltip(CITIES[active], sp.x, sp.y);
      else overlay.hideTooltip();
    }
  }

  // ----------------------------------------------------------------- audio

  /** One-shot rush of filtered noise under the dive; audio exists by now (the dive starts from a click). */
  private playWhoosh(): void {
    const audio = this.ctx.audio;
    this.cancelAudio?.();
    this.cancelAudio = audio.whenReady(() => {
      const ac = audio.ctx;
      const bus = audio.bus();
      if (!ac || !bus || audio.isMuted || this.mode !== "dive") return;
      const buf = audio.noiseBuffer(3, 1);
      if (!buf) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 0.9;
      const g = ac.createGain();
      const t = ac.currentTime;
      lp.frequency.setValueAtTime(160, t);
      lp.frequency.exponentialRampToValueAtTime(2600, t + 1.9);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 1.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.35);
      src.connect(lp).connect(g).connect(bus);
      src.start(t);
      src.stop(t + 2.4);
      this.sound = { src, gain: g };
    });
    this.soundStarted = true;
  }

  private stopSound(): void {
    this.cancelAudio?.();
    this.cancelAudio = null;
    const s = this.sound;
    this.sound = null;
    const ac = this.ctx.audio.ctx;
    if (!s || !ac) return;
    // Short fade so leaving mid-whoosh does not click.
    s.gain.gain.cancelScheduledValues(ac.currentTime);
    s.gain.gain.setTargetAtTime(0.0001, ac.currentTime, 0.05);
    try {
      s.src.stop(ac.currentTime + 0.3);
    } catch {
      // already stopped
    }
  }

  // ----------------------------------------------------------------- debug

  private exposeDebug(): void {
    (window as unknown as Record<string, unknown>).__globe = {
      timings: this.timings,
      post: this.post,
      scene: this.scene,
      hover: (id: string | null) => this.onCardHover(id),
      pointAt: (id: string) => {
        const i = CITIES.findIndex((c) => c.id === id);
        this.applyView();
        const sp = this.markers.screenPos(i, this.camera, this.w, this.h);
        if (!sp) return;
        this.pointerX = sp.x;
        this.pointerY = sp.y;
        this.pointerInside = true;
      },
      screen: (id: string) => this.markers.screenPos(CITIES.findIndex((c) => c.id === id), this.camera, this.w, this.h),
      select: (id: string) => this.select(id),
      view: (lat: number, lon: number, zoom = 1) => {
        this.mode = "free";
        this.lat = lat;
        this.lon = lon;
        this.vLat = this.vLon = 0;
        this.zoom = this.zoomTarget = zoom;
        this.alt = (this.baseDist - 1) * zoom;
        this.lastInteract = this.time + 1e6;
      },
      freezeDive: (t: number) => {
        const i = CITIES.findIndex((c) => c.status === "live");
        if (this.mode !== "dive") this.startDive(i);
        this.debugDiveT = t;
        this.modeT = t;
      },
      /** Average frame interval over n frames (only meaningful with vsync off). */
      perf: (n = 120) =>
        new Promise<number>((resolve) => {
          let k = 0;
          let t0 = 0;
          const step = (ts: number) => {
            if (k === 10) t0 = ts;
            if (k++ < n + 10) requestAnimationFrame(step);
            else resolve(Math.round(((ts - t0) / n) * 100) / 100);
          };
          requestAnimationFrame(step);
        }),
      sun: (x: number, y: number, z: number) => (this.shared.uSunDir.value as Vector3).set(x, y, z).normalize(),
      state: () => ({ mode: this.mode, lat: this.lat, lon: this.lon, alt: this.alt, fov: this.fov, hovered: this.hovered }),
    };
  }
}
