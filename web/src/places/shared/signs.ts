import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshBasicMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type BufferAttribute,
  type BufferGeometry,
} from "three";

/**
 * Animated signage: LED bands, video screens, scrolling message boards.
 *
 * A sign is an unlit material (HDR colour × texture) whose texture is a
 * flipbook (frames in a grid), a strip that scrolls, or both. Both animate
 * by offsetting UVs, so the web drives `texture.offset` and the export
 * carries the parameters instead of the motion:
 *
 *   userData.pocketAtlas = {
 *     kind: "sign",
 *     color: [r, g, b],            linear HDR multiplier of the texture
 *     frames, cols, rows, fps,     flipbook (frames ≥ 2)
 *     phase,                       seconds added to the place clock
 *     scroll: [du, dv],            UV units per second (wrap = repeat)
 *     uv: "frame0",                mesh UVs address frame 0's cell
 *   }
 *
 * UV space is glTF's: u right, v down from the top row of the exported image
 * (these textures use flipY = false, so the canvas is the exported image).
 * Frame f covers the cell (f mod cols, ⌊f / cols⌋): u ∈ [c/cols, (c+1)/cols],
 * v ∈ [r/rows, (r+1)/rows]. Mesh UVs lie in frame 0's cell, so a renderer
 * that ignores the annotation still shows a whole frame; at place time t
 * (the clock that drives the animation tracks) the frame is
 * f = ⌊(t + phase) · fps⌋ mod frames and the UV offset is (c/cols, r/rows).
 * The scroll is applied after the flipbook: each component of
 * scroll · (t + phase) wraps to [0, 1) as x − ⌊x⌋ and adds to the frame's
 * offset (the device's `UvAnim::apply` runs in the same order).
 */
export interface Flipbook {
  frames: number;
  cols: number;
  rows: number;
  fps: number;
}

export interface SignAnimation {
  flipbook?: Flipbook;
  scroll?: [number, number];
  phase?: number;
}

/** A canvas texture laid out for a sign: rows top-down (flipY off), sRGB, mipmapped. */
export function signTexture(c: HTMLCanvasElement, opts: { repeat?: boolean; mipmaps?: boolean; anisotropy?: number } = {}): CanvasTexture {
  const t = new CanvasTexture(c);
  t.flipY = false;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = opts.anisotropy ?? 8;
  t.generateMipmaps = opts.mipmaps !== false;
  t.minFilter = opts.mipmaps === false ? LinearFilter : LinearMipmapLinearFilter;
  t.wrapS = t.wrapT = opts.repeat ? RepeatWrapping : ClampToEdgeWrapping;
  return t;
}

/**
 * Rewrites a geometry's [0,1] UVs (v up, three.js convention) into frame 0's
 * cell in glTF space (v down): u' = u / cols, v' = (1 − v) / rows.
 */
export function frameUV(geo: BufferGeometry, cols = 1, rows = 1): BufferGeometry {
  const uv = geo.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / cols, (1 - uv.getY(i)) / rows);
  uv.needsUpdate = true;
  return geo;
}

/** An unlit sign whose texture animates; `update(t)` steps it on the place clock. */
export class Sign {
  readonly material: MeshBasicMaterial;
  readonly anim: SignAnimation;
  private texture: CanvasTexture;

  constructor(name: string, texture: CanvasTexture, color: Color, anim: SignAnimation, opts: { alphaTest?: number; fog?: boolean } = {}) {
    this.texture = texture;
    this.anim = anim;
    // The web material carries the HDR colour directly (bloom picks it up);
    // the exporter clamps base colour and keeps the HDR value in the annotation.
    this.material = new MeshBasicMaterial({ map: texture, color: color.clone(), fog: opts.fog ?? true, alphaTest: opts.alphaTest ?? 0 });
    this.material.name = name;
    const fb = anim.flipbook;
    this.material.userData.pocketAtlas = {
      kind: "sign",
      color: color.toArray(),
      ...(fb ? { frames: fb.frames, cols: fb.cols, rows: fb.rows, fps: fb.fps } : {}),
      ...(anim.scroll ? { scroll: anim.scroll } : {}),
      phase: anim.phase ?? 0,
      uv: "frame0",
    };
  }

  /** UV offset at place time t: the flipbook frame's cell, then the scroll. */
  update(t: number): void {
    const a = this.anim;
    const tt = t + (a.phase ?? 0);
    let u = 0;
    let v = 0;
    if (a.flipbook) {
      const fb = a.flipbook;
      const f = ((Math.floor(tt * fb.fps) % fb.frames) + fb.frames) % fb.frames;
      u = (f % fb.cols) / fb.cols;
      v = Math.floor(f / fb.cols) / fb.rows;
    }
    if (a.scroll) {
      const fr = (x: number) => x - Math.floor(x);
      u += fr(a.scroll[0] * tt);
      v += fr(a.scroll[1] * tt);
    }
    this.texture.offset.set(u, v);
  }
}
