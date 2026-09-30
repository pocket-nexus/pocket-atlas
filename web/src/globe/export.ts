import {
  DataUtils,
  FloatType,
  GLSL3,
  HalfFloatType,
  type IUniform,
  type Object3D,
  PerspectiveCamera,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { DEG } from "./geo";
import { ATMOSPHERE, COMMON } from "./shaders/chunks";

/**
 * The atlas screen of a handheld port (pocket-atlas-cook `atlas`): the globe
 * as a fixed camera sees it. Camera and sun stay put while the Earth turns
 * under them, so everything that depends only on the view ray is baked here
 * at the handheld's resolution: the sky with the atmosphere halo around the
 * disc, and the atmosphere's in-scattering and transmittance over the disc.
 * The rotating surface is shaded on the device from the maps below.
 */
export interface AtlasFraming {
  width: number;
  height: number;
  /** Vertical field of view (degrees). */
  fov: number;
  /** Globe radius and centre on screen (pixels). */
  radiusPx: number;
  centerX: number;
}

export interface AtlasExportInput {
  renderer: WebGLRenderer;
  /** Sky, stars and the atmosphere shell (rendered for the background). */
  background: Object3D[];
  /** Everything else in the globe scene (hidden while the background renders). */
  hide: Object3D[];
  render: (camera: PerspectiveCamera, target: WebGLRenderTarget) => void;
  shared: Record<string, IUniform>;
  albedo: WebGLRenderTarget;
  normals: WebGLRenderTarget;
  clouds: WebGLRenderTarget;
  transmittance: WebGLRenderTarget;
  lights: { data: Uint8Array; width: number; height: number };
  sun: Vector3;
  params: Record<string, number>;
}

export interface AtlasFile {
  name: string;
  width: number;
  height: number;
  /** Channels per texel; `f32` files are little-endian float32. */
  channels: number;
  format: "u8" | "f32";
  srgb?: boolean;
  data: Uint8Array;
}

export interface AtlasExport {
  files: AtlasFile[];
  meta: Record<string, unknown>;
}

/** Camera 1 / sin(angular radius) from the centre, on +Z, image shifted so the globe sits at `centerX`. */
export function atlasCamera(f: AtlasFraming): { camera: PerspectiveCamera; distance: number; shiftNdc: number } {
  const a = Math.atan((f.radiusPx / (f.height / 2)) * Math.tan((f.fov / 2) * DEG));
  const distance = 1 / Math.sin(a);
  const camera = new PerspectiveCamera(f.fov, f.width / f.height, 0.01, 400);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  const sx = f.width / 2 - f.centerX;
  camera.setViewOffset(f.width, f.height, sx, 0, f.width, f.height);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { camera, distance, shiftNdc: -(2 * sx) / f.width };
}

async function readRgba(renderer: WebGLRenderer, rt: WebGLRenderTarget): Promise<Float32Array | Uint8Array> {
  const { width, height } = rt;
  const type = rt.texture.type;
  if (type === HalfFloatType) {
    const half = new Uint16Array(width * height * 4);
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height, half);
    const out = new Float32Array(half.length);
    for (let i = 0; i < half.length; i++) out[i] = DataUtils.fromHalfFloat(half[i]);
    return out;
  }
  if (type === FloatType) {
    const out = new Float32Array(width * height * 4);
    await renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height, out);
    return out;
  }
  const out = new Uint8Array(width * height * 4);
  await renderer.readRenderTargetPixelsAsync(rt, 0, 0, width, height, out);
  return out;
}

/** Camera renders read back bottom-up; screen files are stored top-down. */
function flipRows<T extends Float32Array | Uint8Array>(src: T, width: number, height: number, channels: number): T {
  const out = new (src.constructor as { new (n: number): T })(src.length);
  const row = width * channels;
  for (let y = 0; y < height; y++) out.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return out;
}

const f32 = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function toU8(src: Float32Array, scale = 255): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(src[i] * scale)));
  return out;
}

/** Per-pixel atmosphere over the disc: rgb in-scattering (MODE 0) or transmittance (MODE 1). */
const DISC_FRAG = /* glsl */ `
precision highp float;
#define ATMOS_STEPS 48
${COMMON}
${ATMOSPHERE}
uniform vec3 uSunDir;
uniform mat4 uInvViewProj;
uniform vec3 uEye;
uniform vec2 uRes;
uniform int uMode;
out vec4 fragColor;
void main() {
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec4 far = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize(far.xyz / far.w - uEye);
  vec2 tp = raySphere(uEye, rd, PLANET_R);
  if (!(tp.x < tp.y && tp.y > 0.0)) { fragColor = uMode == 0 ? vec4(0.0) : vec4(1.0); return; }
  vec3 ins, tr;
  scatter(uEye, rd, tp.x, uSunDir, 0.5, ins, tr);
  fragColor = uMode == 0 ? vec4(ins, 1.0) : vec4(tr, 1.0);
}`;

export async function exportAtlas(inp: AtlasExportInput, framing: AtlasFraming): Promise<AtlasExport> {
  const { renderer } = inp;
  const { camera, distance, shiftNdc } = atlasCamera(framing);
  const W = framing.width;
  const H = framing.height;
  const screen = () => new WebGLRenderTarget(W, H, { type: FloatType, format: RGBAFormat, depthBuffer: true });
  const files: AtlasFile[] = [];

  // Background: sky, stars and the halo, with the surface and markers hidden.
  const shown = inp.hide.map((o) => o.visible);
  inp.hide.forEach((o) => (o.visible = false));
  inp.background.forEach((o) => (o.visible = true));
  const bg = screen();
  inp.render(camera, bg);
  inp.hide.forEach((o, i) => (o.visible = shown[i]));
  const bgPx = flipRows((await readRgba(renderer, bg)) as Float32Array, W, H, 4);
  bg.dispose();
  files.push({ name: "space", width: W, height: H, channels: 4, format: "f32", data: f32(bgPx) });

  // Atmosphere over the disc.
  const quad = new FullScreenQuad();
  const invViewProj = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).invert();
  const mat = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: DISC_FRAG,
    uniforms: {
      ...inp.shared,
      uSunDir: { value: inp.sun },
      uInvViewProj: { value: invViewProj },
      uEye: { value: new Vector3(0, 0, distance) },
      uRes: { value: [W, H] },
      uMode: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  quad.material = mat;
  for (const [mode, name] of [
    [0, "inscatter"],
    [1, "transmittance"],
  ] as const) {
    mat.uniforms.uMode.value = mode;
    const rt = screen();
    renderer.setRenderTarget(rt);
    quad.render(renderer);
    renderer.setRenderTarget(null);
    const px = flipRows((await readRgba(renderer, rt)) as Float32Array, W, H, 4);
    rt.dispose();
    files.push({ name, width: W, height: H, channels: 4, format: "f32", data: f32(px) });
  }
  mat.dispose();
  quad.dispose();

  // Surface maps (equirectangular, row 0 = v 0 = north pole). The bakes
  // write v = gl_FragCoord.y / height, so read-back rows are already in v
  // order; the lights DataTexture uploads row 0 as v 0.
  const albedo = (await readRgba(renderer, inp.albedo)) as Uint8Array;
  files.push({ name: "albedo", width: inp.albedo.width, height: inp.albedo.height, channels: 4, format: "u8", srgb: true, data: albedo });
  const normals = (await readRgba(renderer, inp.normals)) as Float32Array;
  files.push({ name: "normals", width: inp.normals.width, height: inp.normals.height, channels: 4, format: "u8", data: toU8(normals) });
  const clouds = (await readRgba(renderer, inp.clouds)) as Uint8Array;
  files.push({ name: "clouds", width: inp.clouds.width, height: inp.clouds.height, channels: 4, format: "u8", data: clouds });
  files.push({ name: "lights", width: inp.lights.width, height: inp.lights.height, channels: 2, format: "u8", data: inp.lights.data });
  const trans = (await readRgba(renderer, inp.transmittance)) as Float32Array;
  files.push({ name: "sun-transmittance", width: inp.transmittance.width, height: inp.transmittance.height, channels: 4, format: "f32", data: f32(trans) });

  return {
    files,
    meta: {
      framing,
      camera: { distance, fov: framing.fov, shiftNdc },
      sun: inp.sun.toArray(),
      ...inp.params,
    },
  };
}
