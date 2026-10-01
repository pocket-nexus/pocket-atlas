import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial, Sphere, Vector2, type Camera, type IUniform, type WebGLRenderer } from "three";

/**
 * The light field (`kind: "lights"`): one light = one point sprite whose
 * brightness follows its physical size (contract 1 of the dusk-vista places).
 *
 * Attributes (glTF names in brackets; GLTFExporter writes the custom ones
 * with a leading underscore and the primitive as POINTS):
 *
 * | attribute | glTF | meaning |
 * | --- | --- | --- |
 * | `position` | POSITION | centre (m, place frame) |
 * | `color` | COLOR_0 | linear colour, max channel 1 |
 * | `light` | `_LIGHT` vec4 | intensity (linear HDR peak at the physical size), radius (m), phase (0–1), twinkle (0–1) |
 * | `path` | `_PATH` vec4 (optional) | dx, dy, dz (m), cycles per loop (integer) |
 * | `blink` | `_BLINK` vec2 (optional) | cycles per loop (integer), duty (0–1) |
 *
 * Per frame and light, with `u = fract(phase + cycles · t / loop)`:
 *
 *   p = position + path.xyz · u                                       (moving lights)
 *   on while fract(phase + blink.cycles · t / loop) < duty           (blinking lights)
 *   d = |p − eye|
 *   D = radius · H / (d · tan(fovY / 2))       physical diameter, render pixels
 *   S = clamp(D, max(2, minPixels), maxPixels)  sprite diameter (never under 2 render pixels)
 *   k = (D / S)² when D < S, else 1             energy kept when the sprite is wider than the light
 *   w = 1 + twinkle · min(1, d / 8000) · 0.35 · sin(2π (13.7 · phase + 4 t))
 *   value = color · intensity · gain · k · w · T(eye, p),   sprite profile (1 − r²)²
 *
 * Additive, depth test on, depth write off. `T` is the vista haze's
 * transmittance (`shared/haze.ts` `HAZE_GLSL`, evaluated per light); without
 * haze T = 1.
 *
 * `minPixels` and `maxPixels` are render pixels (the handheld renders 272
 * lines, so its sprites and a 272-line web capture match); no sprite is drawn
 * under 2 render pixels (smaller moving sprites flicker on the device). A web
 * capture at a larger size draws the lights finer than the handheld can, as
 * the reference photos show them.
 *
 * Depth pull: the sprite's depth is that of a point pulled toward the eye by
 * the fraction `pull = clamp(depthPull · d / 1000, 0.002, 0.5)` of its
 * distance (screen position unchanged). A light on the far basin floor is
 * seen at a grazing angle: the ground that covers the pixel below it lies
 * Δd/d ≈ (sprite radius in radians) · d / (eye height) nearer, about 7 % at
 * 10 km from the terraces, so a fixed pull would clip the lower half of every
 * distant sprite; 0.012 per km clears a 2-pixel sprite to ~40 km.
 */
export interface LightFieldOptions {
  /** Smallest sprite diameter (render pixels; never under 2). */
  minPixels: number;
  /** Largest sprite diameter (render pixels). */
  maxPixels: number;
  /** Overall gain on every light. */
  gain: number;
  /** Loop length (s): every path and blink repeats over it. */
  loop: number;
  /** Depth pull per kilometre of eye distance (fraction of the distance, clamped to 0.002 … 0.5; default 0.012). */
  depthPull?: number;
  /** Haze transmittance: GLSL defining `float hazeTransmittance(vec3 eye, vec3 p)` and its uniforms. */
  haze?: { glsl: string; uniforms: Record<string, IUniform> };
}


/** One light. Colours are linear RGB; the builder normalises them to a max channel of 1 and moves the rest into intensity. */
export interface Light {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  intensity: number;
  radius: number;
  phase?: number;
  twinkle?: number;
  /** dx, dy, dz (m) and cycles per loop (integer). */
  path?: [number, number, number, number];
  /** Cycles per loop (integer) and duty (0–1). */
  blink?: [number, number];
}

/** Accumulates lights into flat arrays (one builder per Points object). */
export class LightSet {
  readonly name: string;
  private pos: number[] = [];
  private col: number[] = [];
  private lit: number[] = [];
  private pth: number[] = [];
  private blk: number[] = [];
  private moving = false;
  private blinking = false;

  constructor(name: string) {
    this.name = name;
  }

  get count(): number {
    return this.pos.length / 3;
  }

  add(l: Light): void {
    const m = Math.max(l.r, l.g, l.b, 1e-6);
    this.pos.push(l.x, l.y, l.z);
    this.col.push(l.r / m, l.g / m, l.b / m);
    this.lit.push(l.intensity * m, l.radius, l.phase ?? 0, l.twinkle ?? 0);
    this.pth.push(...(l.path ?? [0, 0, 0, 0]));
    this.blk.push(...(l.blink ?? [0, 1]));
    if (l.path) this.moving = true;
    if (l.blink) this.blinking = true;
  }

  /** The geometry: `path` and `blink` only when a light uses them. */
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    g.setAttribute("light", new Float32BufferAttribute(this.lit, 4));
    if (this.moving) g.setAttribute("path", new Float32BufferAttribute(this.pth, 4));
    if (this.blinking) g.setAttribute("blink", new Float32BufferAttribute(this.blk, 2));
    // Bounds over every position a moving light takes, for culling.
    const box: number[] = [];
    for (let i = 0; i < this.count; i++) {
      box.push(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      if (this.moving) box.push(this.pos[i * 3] + this.pth[i * 4], this.pos[i * 3 + 1] + this.pth[i * 4 + 1], this.pos[i * 3 + 2] + this.pth[i * 4 + 2]);
    }
    const bg = new BufferGeometry();
    bg.setAttribute("position", new Float32BufferAttribute(box, 3));
    bg.computeBoundingSphere();
    g.boundingSphere = bg.boundingSphere ?? new Sphere();
    bg.dispose();
    return g;
  }
}

const VERT = /* glsl */ `
attribute vec4 light;
#ifdef LIGHT_PATH
attribute vec4 path;
#endif
#ifdef LIGHT_BLINK
attribute vec2 blink;
#endif
uniform float uTime;
uniform float uLoop;
uniform float uHeight;
uniform float uProjY;
uniform vec2 uPixels;
uniform float uGain;
uniform float uDepthPull;
varying vec3 vColor;
float lightsHaze(vec3 eye, vec3 p) {
#ifdef LIGHT_HAZE
  return hazeTransmittance(eye, p);
#else
  return 1.0;
#endif
}
void main() {
  float phase = light.z;
  vec3 p = position;
#ifdef LIGHT_PATH
  p += path.xyz * fract(phase + path.w * uTime / uLoop);
#endif
  float on = 1.0;
#ifdef LIGHT_BLINK
  on = step(fract(phase + blink.x * uTime / uLoop), blink.y - 1e-5);
#endif
  vec4 world = modelMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * world;
  float d = max(length(mv.xyz), 1e-3);
  float D = light.y * uHeight * uProjY / d;
  float S = clamp(D, max(2.0, uPixels.x), max(2.0, uPixels.y));
  float k = D < S ? (D / S) * (D / S) : 1.0;
  float w = 1.0 + light.w * min(1.0, d / 8000.0) * 0.35 * sin(6.28318530718 * (13.7 * phase + 4.0 * uTime));
  vColor = color * light.x * uGain * k * w * on * lightsHaze(cameraPosition, world.xyz);
  // Depth pull toward the eye: same screen position, nearer depth.
  mv.xyz *= 1.0 - clamp(uDepthPull * d / 1000.0, 0.002, 0.5);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = on > 0.0 ? S : 0.0;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float f = (1.0 - r2) * (1.0 - r2);
  gl_FragColor = vec4(vColor * f, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const size = new Vector2();

/** The light-field material; `material.userData.pocketAtlas` carries the export annotation. */
export function lightsMaterial(opts: LightFieldOptions, set: { moving: boolean; blinking: boolean }): ShaderMaterial {
  const defines: Record<string, string> = {};
  if (set.moving) defines.LIGHT_PATH = "";
  if (set.blinking) defines.LIGHT_BLINK = "";
  if (opts.haze) defines.LIGHT_HAZE = "";
  const m = new ShaderMaterial({
    name: "lights",
    defines,
    uniforms: {
      ...(opts.haze?.uniforms ?? {}),
      uTime: { value: 0 },
      uLoop: { value: opts.loop },
      uHeight: { value: 272 },
      uProjY: { value: 1 },
      uPixels: { value: new Vector2(opts.minPixels, opts.maxPixels) },
      uGain: { value: opts.gain },
      uDepthPull: { value: opts.depthPull ?? 0.012 },
    },
    vertexShader: (opts.haze ? opts.haze.glsl : "") + VERT,
    fragmentShader: FRAG,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    fog: false,
  });
  m.userData = { pocketAtlas: { kind: "lights", minPixels: opts.minPixels, maxPixels: opts.maxPixels, gain: opts.gain, loop: opts.loop, depthPull: opts.depthPull ?? 0.012 } };
  return m;
}

/** A light field ready for the scene: `update(t)` advances its paths and blinks (t in seconds; the loop wraps it). */
export interface LightField {
  points: Points;
  material: ShaderMaterial;
  update(t: number): void;
}

/** Points + material for one set. The render height and field of view are read from the renderer and camera every draw. */
export function buildLightField(set: LightSet, opts: LightFieldOptions): LightField {
  const geometry = set.geometry();
  const material = lightsMaterial(opts, { moving: !!geometry.getAttribute("path"), blinking: !!geometry.getAttribute("blink") });
  const points = new Points(geometry, material);
  points.name = `lights:${set.name}`;
  points.renderOrder = 10;
  points.onBeforeRender = (renderer: WebGLRenderer, _scene, camera: Camera) => {
    const target = renderer.getRenderTarget();
    const h = target ? target.height : renderer.getDrawingBufferSize(size).y;
    material.uniforms.uHeight.value = h;
    material.uniforms.uProjY.value = camera.projectionMatrix.elements[5];
  };
  return {
    points,
    material,
    update(t: number) {
      material.uniforms.uTime.value = ((t % opts.loop) + opts.loop) % opts.loop;
    },
  };
}
