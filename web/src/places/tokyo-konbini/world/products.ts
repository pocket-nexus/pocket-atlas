import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Rng } from "../../../core/random";
import { LAYER_NO_REFLECT } from "../gfx/layers";

export type Shape = "bottle" | "can" | "box" | "bag" | "cup" | "onigiri" | "tray";

const PALETTE = [0xe63b2e, 0xf5b700, 0x2e7bd6, 0x1faa59, 0xf07b1d, 0x9b3fd1, 0xf4f4f0, 0xe0247a, 0x20b3c7, 0x6b3a1e, 0xf2e3c2, 0x1a1a1a, 0xc9e6f5, 0xffd84a];

function bottleGeo(): BufferGeometry {
  const r = 0.5;
  const pts = [
    new Vector2(0.0, 0),
    new Vector2(r * 0.92, 0.0),
    new Vector2(r, 0.04),
    new Vector2(r, 0.62),
    new Vector2(r * 0.9, 0.7),
    new Vector2(r * 0.45, 0.86),
    new Vector2(r * 0.34, 0.9),
    new Vector2(r * 0.36, 0.92),
    new Vector2(r * 0.36, 1.0),
    new Vector2(0, 1.0),
  ];
  return new LatheGeometry(pts, 8);
}

const GEOS: Record<Shape, () => BufferGeometry> = {
  bottle: bottleGeo,
  can: () => new CylinderGeometry(0.5, 0.5, 1, 10).translate(0, 0.5, 0),
  box: () => new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  bag: () => new RoundedBoxGeometry(1, 1, 1, 1, 0.28).translate(0, 0.5, 0),
  cup: () => new CylinderGeometry(0.5, 0.4, 1, 10).translate(0, 0.5, 0),
  onigiri: () => new CylinderGeometry(0.62, 0.62, 1, 3).rotateX(Math.PI / 2).rotateY(Math.PI / 2).translate(0, 0.45, 0),
  tray: () => new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
};

/** Size ranges (w, h, d) in meters. */
const SIZE: Record<Shape, [[number, number], [number, number], [number, number]]> = {
  bottle: [[0.062, 0.07], [0.19, 0.23], [0.062, 0.07]],
  can: [[0.062, 0.066], [0.1, 0.13], [0.062, 0.066]],
  box: [[0.07, 0.18], [0.09, 0.24], [0.05, 0.14]],
  bag: [[0.14, 0.2], [0.18, 0.26], [0.05, 0.07]],
  cup: [[0.09, 0.105], [0.07, 0.1], [0.09, 0.105]],
  onigiri: [[0.1, 0.1], [0.1, 0.1], [0.035, 0.035]],
  tray: [[0.18, 0.22], [0.045, 0.06], [0.13, 0.16]],
};

const VERT_PARS = /* glsl */ `
varying float vSeed;
varying vec3 vLocal;
`;
const VERT_MAIN = /* glsl */ `
vSeed = float(gl_InstanceID);
vLocal = position;
`;
const FRAG_PARS = /* glsl */ `
uniform float uLit;
uniform sampler2D uPack;
uniform float uPackMix;
varying float vSeed;
varying vec3 vLocal;
float pHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
`;
const FRAG_ALBEDO = /* glsl */ `
{
  // One design per facing run: the run's (jittered) color is the seed, so
  // neighbours in a run match and different runs differ.
  #ifdef USE_INSTANCING_COLOR
    float runSeed = dot(vColor, vec3(12.9898, 78.233, 37.719));
  #else
    float runSeed = vSeed;
  #endif
  float h1 = pHash(runSeed * 0.37 + 1.0);
  float h2 = pHash(runSeed * 0.71 + 7.0);
  float y = vLocal.y;
  // Printed wrap sampled from the packaging atlas (8 bands of goods).
  float band = floor(h2 * 8.0);
  vec2 puv = vec2(h1 * 0.93 + fract(vUv.x) * 0.055, (band + 0.08 + clamp(vUv.y, 0.0, 1.0) * 0.8) / 8.0);
  vec3 pack = texture2D(uPack, puv).rgb;
  float side = step(0.004, y) * step(y, 0.996);
  diffuseColor.rgb = mix(diffuseColor.rgb, pack * 1.15, uPackMix * side * (0.75 + 0.25 * h1));
  // Soft top-down fixture falloff instead of real lights.
  diffuseColor.rgb *= 0.78 + 0.22 * clamp(y, 0.0, 1.0);
}
`;

interface Item {
  shape: Shape;
  m: Matrix4;
  color: Color;
}

/**
 * Collects product placements, then builds one InstancedMesh per shape. The
 * shop's even LED light is carried as emission (see MaterialLib.interior).
 */
export class ProductBatch {
  private items: Item[] = [];
  private rng: Rng;
  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** One item standing at `pos` (base center), facing yaw `ry`. */
  add(shape: Shape, pos: Vector3, ry: number, color: number, scale?: Vector3): Vector3 {
    const r = this.rng;
    const s = SIZE[shape];
    const size = scale ?? new Vector3(r.range(...s[0]), r.range(...s[1]), r.range(...s[2]));
    const m = new Matrix4().compose(pos, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry + r.range(-0.06, 0.06)), size);
    this.items.push({ shape, m, color: new Color(color) });
    return size;
  }

  /**
   * Fills a shelf run with "facings": runs of 2–6 identical products, like a
   * real planogram. `along` is the unit direction of the run, `out` points to
   * the aisle; items sit `inset` behind the shelf lip and rows go `rows` deep.
   */
  fillRun(start: Vector3, along: Vector3, length: number, out: Vector3, shapes: Shape[], rows = 2, inset = 0.03, maxH = 0.3): void {
    const r = this.rng;
    const ry = Math.atan2(out.x, out.z);
    let t = 0.02;
    while (t < length - 0.05) {
      const shape = r.pick(shapes);
      // Jitter so every run has its own design seed (see FRAG_ALBEDO).
      const color = new Color(r.pick(PALETTE)).offsetHSL(r.range(-0.02, 0.02), 0, r.range(-0.03, 0.03)).getHex();
      const s = SIZE[shape];
      const size = new Vector3(r.range(...s[0]), Math.min(maxH, r.range(...s[1])), r.range(...s[2]));
      const run = r.int(2, 6);
      for (let k = 0; k < run && t + size.x < length; k++) {
        for (let row = 0; row < rows; row++) {
          const p = start
            .clone()
            .addScaledVector(along, t + size.x / 2)
            .addScaledVector(out, -(inset + size.z / 2 + row * (size.z + 0.01)));
          this.add(shape, p, ry, color, size.clone());
        }
        t += size.x + 0.006;
      }
      t += r.range(0.004, 0.02);
    }
  }

  build(parent: Object3D, lit: number, pack: Texture): void {
    const byShape = new Map<Shape, Item[]>();
    for (const it of this.items) {
      const list = byShape.get(it.shape) ?? [];
      list.push(it);
      byShape.set(it.shape, list);
    }
    // Unlit: the stock is only ever seen under the shop's flat LED light, so
    // skipping the light loop saves the most expensive fragments in the shop.
    const mat = new MeshBasicMaterial({ fog: false });
    mat.defines = { USE_UV: "" };
    mat.userData.pocketAtlas = { kind: "products", lit, packMix: 0.85, pack };
    const local = { uLit: { value: lit }, uPack: { value: pack }, uPackMix: { value: 0.85 } };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, local);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAG_ALBEDO}\ndiffuseColor.rgb *= uLit;`);
    };
    mat.customProgramCacheKey = () => "products";
    for (const [shape, list] of byShape) {
      const im = new InstancedMesh(GEOS[shape](), mat, list.length);
      list.forEach((it, i) => {
        im.setMatrixAt(i, it.m);
        im.setColorAt(i, it.color);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = false;
      // Behind glass and inside: not worth a second draw in the street mirror.
      im.layers.set(LAYER_NO_REFLECT);
      im.computeBoundingSphere();
      im.name = `products:${shape}`;
      parent.add(im);
    }
  }

  get count(): number {
    return this.items.length;
  }
}
