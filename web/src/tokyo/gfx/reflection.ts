import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  Plane,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { LAYER_NO_REFLECT } from "./layers";

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  // 9-tap gaussian folded into 5 bilinear fetches.
  vec3 c = texture2D(tInput, vUv).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  c += texture2D(tInput, vUv + o1).rgb * 0.3162162162;
  c += texture2D(tInput, vUv - o1).rgb * 0.3162162162;
  c += texture2D(tInput, vUv + o2).rgb * 0.0702702703;
  c += texture2D(tInput, vUv - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Mirror render of the scene about a horizontal plane, plus two blurred
 * copies. Wet materials sample it in screen space (see wet.ts), mixing sharp
 * and blurred by roughness. The blur is stretched vertically, which gives
 * the long streaky light reflections of a rain-soaked street.
 */
export class PlanarReflection {
  readonly textureMatrix = new Matrix4();
  readonly sharp: WebGLRenderTarget;
  readonly blurred: WebGLRenderTarget;
  private tmp: WebGLRenderTarget;
  private tmp2: WebGLRenderTarget;
  readonly soft: WebGLRenderTarget;
  private cam = new PerspectiveCamera();
  private quad = new FullScreenQuad();
  private blurMat = new ShaderMaterial({
    uniforms: { tInput: { value: null }, uDir: { value: [0, 0] } },
    vertexShader: VERT,
    fragmentShader: BLUR_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  private scale: number;
  private planeY: number;
  /** Objects hidden while the mirror is drawn (the reflecting surfaces themselves). */
  readonly hide: Object3D[] = [];
  enabled = true;

  constructor(scale: number, planeY = 0) {
    this.scale = scale;
    this.planeY = planeY;
    const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false } as const;
    this.sharp = new WebGLRenderTarget(4, 4, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: true, samples: 0 });
    this.tmp = new WebGLRenderTarget(4, 4, opts);
    this.blurred = new WebGLRenderTarget(4, 4, opts);
    this.tmp2 = new WebGLRenderTarget(4, 4, opts);
    this.soft = new WebGLRenderTarget(4, 4, opts);
    this.quad.material = this.blurMat;
    this.cam.layers.enableAll();
    this.cam.layers.disable(LAYER_NO_REFLECT);
  }

  get textures(): { sharp: Texture; blurred: Texture; soft: Texture } {
    return { sharp: this.sharp.texture, blurred: this.blurred.texture, soft: this.soft.texture };
  }

  setSize(width: number, height: number): void {
    const w = Math.max(4, Math.round(width * this.scale));
    const h = Math.max(4, Math.round(height * this.scale));
    this.sharp.setSize(w, h);
    this.tmp.setSize(w >> 1, h >> 1);
    this.blurred.setSize(w >> 1, h >> 1);
    this.tmp2.setSize(w >> 2, h >> 2);
    this.soft.setSize(w >> 2, h >> 2);
  }

  private blur(src: WebGLRenderTarget, mid: WebGLRenderTarget, dst: WebGLRenderTarget, rx: number, ry: number, renderer: WebGLRenderer): void {
    const u = this.blurMat.uniforms;
    u.tInput.value = src.texture;
    u.uDir.value = [rx / mid.width, 0];
    renderer.setRenderTarget(mid);
    this.quad.render(renderer);
    u.tInput.value = mid.texture;
    u.uDir.value = [0, ry / dst.height];
    renderer.setRenderTarget(dst);
    this.quad.render(renderer);
  }

  update(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    if (!this.enabled) return;
    const normal = new Vector3(0, 1, 0);
    const planePos = new Vector3(0, this.planeY, 0);
    const camPos = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y <= this.planeY + 0.01) return;

    // Mirror the camera across the plane: position, look target and up.
    const rot = new Matrix4().extractRotation(camera.matrixWorld);
    const view = camPos.clone();
    view.y = 2 * this.planeY - camPos.y;
    const look = new Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    look.y = 2 * this.planeY - look.y;
    const cam = this.cam;
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    cam.lookAt(look);
    cam.near = camera.near;
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);

    // Oblique near plane (Lengyel) so nothing below the surface leaks in.
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, planePos).applyMatrix4(cam.matrixWorldInverse);
    const clip = new Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = cam.projectionMatrix;
    const q = new Vector4(
      (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0],
      (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5],
      -1,
      (1 + pm.elements[10]) / pm.elements[14],
    );
    clip.multiplyScalar(2 / clip.dot(q));
    pm.elements[2] = clip.x;
    pm.elements[6] = clip.y;
    pm.elements[10] = clip.z + 1 - 0.003;
    pm.elements[14] = clip.w;
    cam.projectionMatrixInverse.copy(pm).invert();

    for (const o of this.hide) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.sharp);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.shadowMap.autoUpdate = prevAuto;
    for (const o of this.hide) o.visible = true;

    // Two mip levels; the soft one is blurred repeatedly and mostly vertically,
    // which reads as the long light streaks on wet asphalt.
    this.blur(this.sharp, this.tmp, this.blurred, 1.0, 2.2, renderer);
    this.blur(this.blurred, this.tmp2, this.soft, 1.2, 3.0, renderer);
    this.blur(this.soft, this.tmp2, this.soft, 0.8, 4.5, renderer);
    this.blur(this.soft, this.tmp2, this.soft, 0.6, 7.0, renderer);
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    for (const t of [this.sharp, this.tmp, this.blurred, this.tmp2, this.soft]) t.dispose();
    this.blurMat.dispose();
    this.quad.dispose();
  }
}
