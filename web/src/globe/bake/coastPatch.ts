import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RedFormat, UnsignedByteType, Vector4 } from "three";
import landUrl from "world-atlas/land-10m.json?url";
import { DEG } from "../geo";

export interface CoastRequest {
  /** Absolute URL of land-10m.json (resolved on the main thread against the page). */
  url: string;
  lat: number;
  lon: number;
  halfLat: number;
  halfLon: number;
  size: number;
}

export interface CoastResult extends CoastRequest {
  data?: Uint8Array;
  error?: string;
}

export interface CoastPatch {
  texture: DataTexture;
  /** lat, lon, halfLat, halfLon in radians, as the earth shader expects. */
  rect: Vector4;
}

/**
 * Builds a high-resolution land mask around a destination in a worker.
 * Resolves null (and the globe keeps its global mask) if workers or the
 * 10m data are unavailable.
 */
export function buildCoastPatch(lat: number, lon: number, halfLatDeg = 2.6, size = 2048): { promise: Promise<CoastPatch | null>; cancel: () => void } {
  let worker: Worker | null = null;
  const promise = new Promise<CoastPatch | null>((resolve) => {
    try {
      worker = new Worker(new URL("./coastPatch.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(null);
      return;
    }
    const halfLon = halfLatDeg / Math.max(0.2, Math.cos(lat * DEG));
    const req: CoastRequest = { url: new URL(landUrl, location.href).href, lat, lon, halfLat: halfLatDeg, halfLon, size };
    worker.onmessage = (e: MessageEvent<CoastResult>) => {
      worker?.terminate();
      worker = null;
      const r = e.data;
      if (!r.data) {
        if (r.error) console.warn("[globe] coast patch:", r.error);
        resolve(null);
        return;
      }
      const tex = new DataTexture(r.data, size, size, RedFormat, UnsignedByteType);
      tex.magFilter = LinearFilter;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      resolve({ texture: tex, rect: new Vector4(lat * DEG, lon * DEG, halfLatDeg * DEG, halfLon * DEG) });
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      resolve(null);
    };
    worker.postMessage(req);
  });
  return {
    promise,
    cancel: () => {
      (worker as Worker | null)?.terminate();
      worker = null;
    },
  };
}
