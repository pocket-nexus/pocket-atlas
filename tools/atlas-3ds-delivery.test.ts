import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { pocketRuntimeCrc32 } from "../vendor/pocketjs/contracts/spec/pocket-runtime-wire.ts";
import {
  assetHostFor,
  createAssetServer,
  syncAssets,
  type AssetEntry,
} from "./atlas-3ds-delivery.ts";

let directory: string;
let entry: AssetEntry;
const bytes = new Uint8Array(131079).map((_, i) => i * 37 + (i >> 9));
beforeAll(() => {
  const base = resolve(import.meta.dir, "../.pocket-build/validation/3ds");
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "asset-delivery-"));
  const path = join(directory, "fixture.place");
  writeFileSync(path, bytes);
  entry = {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    crc32: pocketRuntimeCrc32(bytes),
  };
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function endpointClosed(address: string): Promise<boolean> {
  const url = new URL(address);
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

test("asset endpoint serves only allowlisted token and hash with exact framing", async () => {
  const server = await createAssetServer([entry], { host: "127.0.0.1" });
  const base = `http://${server.host}:${server.port}`;
  const path = `/${server.token}/${entry.sha256}.place`;
  try {
    const result = await fetch(base + path);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-length")).toBe(String(bytes.length));
    expect(result.headers.get("transfer-encoding")).toBeNull();
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    for (const denied of [
      "/",
      `/${entry.sha256}.place`,
      `/${"a".repeat(64)}/${entry.sha256}.place`,
      `/${server.token}/${"a".repeat(64)}.place`,
      path + "?file=elsewhere",
      `/${server.token}/%2fetc%2fpasswd`,
    ])
      expect((await fetch(base + denied)).status).toBe(404);
    expect((await fetch(base + path, { method: "POST" })).status).toBe(404);
    expect(
      (await fetch(base + path, { headers: { Range: "bytes=0-10" } })).status,
    ).toBe(404);
  } finally {
    await server.close();
  }
});

test("metadata and file content are verified before serving", async () => {
  await expect(
    createAssetServer([{ ...entry, bytes: bytes.length + 1 }], {
      host: "127.0.0.1",
    }),
  ).rejects.toThrow("size mismatch");
  await expect(
    createAssetServer([{ ...entry, crc32: (entry.crc32 ^ 1) >>> 0 }], {
      host: "127.0.0.1",
    }),
  ).rejects.toThrow();
  await expect(
    createAssetServer([{ ...entry, sha256: "0".repeat(64) }], {
      host: "127.0.0.1",
    }),
  ).rejects.toThrow("content hash mismatch");
  await expect(createAssetServer([entry], { host: "0.0.0.0" })).rejects.toThrow(
    "IPv4",
  );
  expect(await assetHostFor("127.0.0.1")).toBe("127.0.0.1");
});

test("sync uses the existing control client and closes the endpoint after receipt", async () => {
  let resolveReceipt!: (message: Record<string, unknown>) => void;
  let url = "";
  let predicate!: (message: Record<string, unknown>) => boolean;
  const client = {
    host: "127.0.0.1",
    waitForCtrl(test: typeof predicate) {
      predicate = test;
      return new Promise<Record<string, unknown>>((resolve) => {
        resolveReceipt = resolve;
      });
    },
    async sendCtrl(message: string | Record<string, unknown>) {
      const control = message as Record<string, any>;
      expect(control.t).toBe("atlas.control");
      const asset = control.asset;
      url = `http://${asset.host}:${asset.port}/${asset.token}/${asset.sha256}.place`;
      const fetched = new Uint8Array(await (await fetch(url)).arrayBuffer());
      expect(pocketRuntimeCrc32(fetched)).toBe(asset.crc32);
      const receipt = {
        t: "atlas.asset",
        sha256: asset.sha256,
        ok: true,
        cached: false,
      };
      expect(predicate(receipt)).toBeTrue();
      expect(predicate({ ...receipt, sha256: "different" })).toBeFalse();
      resolveReceipt(receipt);
    },
  };
  expect(await syncAssets(client, [entry])).toEqual([
    {
      sha256: entry.sha256,
      bytes: entry.bytes,
      crc32: entry.crc32,
      cached: false,
    },
  ]);
  expect(await endpointClosed(url)).toBeTrue();
});

test("device rejection ends sync and shuts down temporary HTTP service", async () => {
  let resolveReceipt!: (message: Record<string, unknown>) => void;
  let url = "";
  const client = {
    host: "127.0.0.1",
    waitForCtrl() {
      return new Promise<Record<string, unknown>>((resolve) => {
        resolveReceipt = resolve;
      });
    },
    async sendCtrl(message: string | Record<string, unknown>) {
      const asset = (message as Record<string, any>).asset;
      url = `http://${asset.host}:${asset.port}/${asset.token}/${asset.sha256}.place`;
      resolveReceipt({
        t: "atlas.asset",
        sha256: asset.sha256,
        ok: false,
        error: "SD full",
      });
    },
  };
  await expect(syncAssets(client, [entry])).rejects.toThrow("SD full");
  expect(await endpointClosed(url)).toBeTrue();
});
