import {
  GLSL3,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  WebGLRenderTarget,
  type IUniform,
  type Texture,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { GLSL_NOISE } from "./glsl";

/**
 * Bakes procedural PBR surfaces on the GPU. A surface is a GLSL function
 *
 *   Surface surface(vec2 uv)   // uv in [0,1), must tile at the edges
 *
 * returning albedo (linear), height, roughness, ao and metalness. Three passes
 * produce an sRGB albedo map, a tangent-space normal map derived from the
 * height field, and an ORM map (R = ao, G = roughness, B = metalness) in the
 * channel layout three.js samples.
 */
export interface SurfaceMaps {
  map: Texture;
  normalMap: Texture;
  ormMap: Texture;
}

const SURFACE_HEAD = /* glsl */ `
struct Surface { vec3 albedo; float height; float rough; float ao; float metal; };
Surface S(vec3 a, float h, float r, float ao, float m) { Surface s; s.albedo = a; s.height = h; s.rough = r; s.ao = ao; s.metal = m; return s; }
`;

export class Baker {
  private quad = new FullScreenQuad();
  private targets: WebGLRenderTarget[] = [];
  private renderer: WebGLRenderer;
  private anisotropy: number;
  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  /** Arbitrary full-screen bake; `body` writes `vec4 outColor` from `vUv`. */
  bake(
    width: number,
    height: number,
    body: string,
    opts: { srgb?: boolean; uniforms?: Record<string, IUniform>; repeat?: boolean; mipmaps?: boolean; header?: string } = {},
  ): Texture {
    const mip = opts.mipmaps !== false;
    const rt = new WebGLRenderTarget(width, height, {
      type: UnsignedByteType,
      generateMipmaps: mip,
      minFilter: mip ? LinearMipmapLinearFilter : LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      colorSpace: opts.srgb ? SRGBColorSpace : NoColorSpace,
      anisotropy: this.anisotropy,
    });
    if (opts.repeat !== false) {
      rt.texture.wrapS = RepeatWrapping;
      rt.texture.wrapT = RepeatWrapping;
    }
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { uRes: { value: [width, height] }, ...(opts.uniforms ?? {}) },
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        out vec4 outColor;
        uniform vec2 uRes;
        ${GLSL_NOISE}
        ${opts.header ?? ""}
        void main() {
          ${body}
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad.material = mat;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
    mat.dispose();
    this.targets.push(rt);
    return rt.texture;
  }

  /**
   * `surfaceGlsl` defines `Surface surface(vec2 uv)`. `bump` converts height
   * units into the slope used for the normal map.
   */
  surface(size: number, surfaceGlsl: string, opts: { bump?: number; uniforms?: Record<string, IUniform> } = {}): SurfaceMaps {
    const head = SURFACE_HEAD + surfaceGlsl;
    const bumpScale = opts.bump ?? 1;
    const uniforms = opts.uniforms;
    const map = this.bake(size, size, `Surface s = surface(vUv); outColor = vec4(s.albedo, 1.0);`, { srgb: true, header: head, uniforms });
    const normalMap = this.bake(
      size,
      size,
      /* glsl */ `
        vec2 e = 1.0 / uRes;
        float hl = surface(fract(vUv - vec2(e.x, 0.0))).height;
        float hr = surface(fract(vUv + vec2(e.x, 0.0))).height;
        float hd = surface(fract(vUv - vec2(0.0, e.y))).height;
        float hu = surface(fract(vUv + vec2(0.0, e.y))).height;
        vec3 n = normalize(vec3((hl - hr) * ${bumpScale.toFixed(4)} * uRes.x / 512.0, (hd - hu) * ${bumpScale.toFixed(4)} * uRes.y / 512.0, 1.0));
        outColor = vec4(n * 0.5 + 0.5, 1.0);`,
      { header: head, uniforms },
    );
    const ormMap = this.bake(
      size,
      size,
      `Surface s = surface(vUv); outColor = vec4(s.ao, s.rough, s.metal, 1.0);`,
      { header: head, uniforms },
    );
    return { map, normalMap, ormMap };
  }

  /** The render target that owns a baked texture (for export readback). */
  targetOf(texture: Texture): WebGLRenderTarget | undefined {
    return this.targets.find((rt) => rt.texture === texture);
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    this.quad.dispose();
  }
}
