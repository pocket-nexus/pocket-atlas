import { CubeCamera, HalfFloatType, PMREMGenerator, WebGLCubeRenderTarget, type Scene, type Vector3, type WebGLRenderer } from "three";

/** Capture once; the web filters the cube while the cooker consumes its HDR faces. */
export function captureEnvironmentProbe(renderer: WebGLRenderer, scene: Scene, at: Vector3, opts: {
  near: number; far: number; before?: () => void; after?: () => void;
}) {
  const cube = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
  const camera = new CubeCamera(opts.near, opts.far, cube);
  camera.position.copy(at);
  scene.add(camera);
  const pmrem = new PMREMGenerator(renderer);
  try {
    renderer.shadowMap.needsUpdate = true;
    opts.before?.();
    camera.update(renderer, scene);
    const filtered = pmrem.fromCubemap(cube.texture);
    return { cube, filtered };
  } catch (e) {
    cube.dispose();
    throw e;
  } finally {
    opts.after?.();
    scene.remove(camera);
    pmrem.dispose();
  }
}
