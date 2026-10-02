/** Application-owned .place delivery. PocketJS continues to own pairing,
 * control and native installation; the temporary HTTP server only serves the
 * explicitly selected content-addressed assets. */
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { pocketRuntimeCrc32 } from "../vendor/pocketjs/contracts/spec/pocket-runtime-wire.ts";
import type { PocketRuntimeClient } from "../vendor/pocketjs/tools/3ds-runtime-client.ts";

export const ASSET_MAX_BYTES = 128 * 1024 * 1024;
export interface AssetEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly crc32: number;
}
export interface AssetReceipt {
  readonly sha256: string;
  readonly bytes: number;
  readonly crc32: number;
  readonly cached: boolean;
}
export interface AssetServerOptions {
  /** Local IPv4 address advertised to the console, also used for binding. */
  readonly host: string;
  readonly port?: number;
}

function ipv4(host: string): boolean {
  const first = Number(host.split(".")[0]);
  return isIP(host) === 4 && first > 0 && first < 224;
}

/** A UDP route lookup selects the local interface without sending a packet. */
export async function assetHostFor(deviceHost: string): Promise<string> {
  if (!ipv4(deviceHost))
    throw new Error("Asset device host must be an IPv4 address");
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(8131, deviceHost, resolve);
    });
    return socket.address().address;
  } finally {
    socket.close();
  }
}

/** Verify every allowed file before opening the endpoint. Paths, query strings,
 * directory listings, ranges, and files outside this allowlist are never served. */
export async function createAssetServer(
  entries: readonly AssetEntry[],
  options: AssetServerOptions,
) {
  if (!ipv4(options.host))
    throw new Error("Asset server host must be an IPv4 address");
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  )
    throw new Error("Invalid asset server port");
  const allowed = new Map<string, AssetEntry>();
  for (const entry of entries) {
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes > ASSET_MAX_BYTES ||
      !Number.isInteger(entry.crc32) ||
      entry.crc32 < 0 ||
      entry.crc32 > 0xffffffff
    )
      throw new Error(`Invalid asset metadata: ${entry.path}`);
    const file = Bun.file(entry.path);
    if (file.size !== entry.bytes)
      throw new Error(`Asset size mismatch: ${entry.path}`);
    const content = new Uint8Array(await file.arrayBuffer());
    if (
      createHash("sha256").update(content).digest("hex") !== entry.sha256 ||
      pocketRuntimeCrc32(content) !== entry.crc32
    )
      throw new Error(`Asset content hash mismatch: ${entry.path}`);
    allowed.set(entry.sha256, entry);
  }
  const token = randomBytes(32).toString("hex");
  const server = Bun.serve({
    hostname: options.host,
    port: options.port ?? 0,
    // The 3DS receives a file incrementally. It may spend time writing to SD.
    idleTimeout: 255,
    fetch(request) {
      const url = new URL(request.url);
      const match = /^\/([a-f0-9]{64})\/([a-f0-9]{64})\.place$/.exec(
        url.pathname,
      );
      const entry = match?.[1] === token ? allowed.get(match[2]!) : undefined;
      if (
        request.method !== "GET" ||
        !entry ||
        url.search ||
        request.headers.has("range")
      )
        return new Response("Not found", { status: 404 });
      return new Response(Bun.file(entry.path), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(entry.bytes),
          "Cache-Control": "no-store",
          Connection: "close",
        },
      });
    },
  });
  return {
    host: options.host,
    port: server.port!,
    token,
    close() {
      return server.stop(true);
    },
  };
}

type AssetClient = Pick<
  PocketRuntimeClient,
  "host" | "sendCtrl" | "waitForCtrl"
>;
export interface SyncAssetOptions {
  /** Override the local IPv4 interface selected from the route to client.host. */
  readonly host?: string;
  readonly port?: number;
  /** Per file, includes SD CRC verification; Old 3DS transfers take minutes. */
  readonly timeoutMs?: number;
  readonly onProgress?: (
    receipt: AssetReceipt,
    completed: number,
    total: number,
  ) => void;
}

/** Keep exclusive use of this already paired client until the promise settles.
 * The host renderer retires its GPU before handling each asset request. */
export async function syncAssets(
  client: AssetClient,
  entries: readonly AssetEntry[],
  options: SyncAssetOptions = {},
): Promise<AssetReceipt[]> {
  if (!entries.length) return [];
  const server = await createAssetServer(entries, {
    host: options.host ?? (await assetHostFor(client.host)),
    port: options.port,
  });
  const receipts: AssetReceipt[] = [];
  try {
    for (const entry of entries) {
      // Install the listener before writing so cached receipts cannot race it.
      const response = client.waitForCtrl(
        (m) => m.t === "atlas.asset" && m.sha256 === entry.sha256,
        options.timeoutMs ?? 21 * 60 * 1000,
      );
      // Attach rejection handling immediately, including if sendCtrl fails.
      const sent = client.sendCtrl({
        t: "atlas.control",
        asset: {
          host: server.host,
          port: server.port,
          token: server.token,
          sha256: entry.sha256,
          bytes: entry.bytes,
          crc32: entry.crc32,
        },
      });
      const [message] = await Promise.all([response, sent]);
      if (message.ok !== true)
        throw new Error(
          `Asset ${entry.sha256.slice(0, 12)} failed: ${String(message.error ?? "unknown device error")}`,
        );
      const receipt = {
        sha256: entry.sha256,
        bytes: entry.bytes,
        crc32: entry.crc32,
        cached: message.cached === true,
      };
      receipts.push(receipt);
      options.onProgress?.(receipt, receipts.length, entries.length);
    }
    return receipts;
  } finally {
    await server.close();
  }
}
