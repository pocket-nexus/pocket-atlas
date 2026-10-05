// Runs a compiled interface bundle on the host: PocketJS's wasm core and
// software rasterizer, with a renderer that exists only as state (`Mock`).
// It answers commands the way a device's renderer does, so a test can press
// buttons and touch the panel and read what the interface drew and asked for.
import type { Canvas } from "@napi-rs/canvas";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROP } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import { __packTouch, createTouchHitFacts } from "../../vendor/pocketjs/framework/src/touch.ts";
import { createWasmUi } from "../../vendor/pocketjs/hosts/web/wasm-ops.js";
import type { Command, HostState } from "../app/protocol.ts";

const root = resolve(import.meta.dir, "../..");
export type Device = "psp" | "vita" | "3ds" | "ipod";

/** A device's renderer, reduced to the state the interface sees. */
export class Mock {
  state: HostState = {
    scene: "atlas", place: "", message: "", installed: [], shots: [], shot: 0, tour: true, paused: false,
    options: [], stats: "", lat: 0, lon: 0, prefs: "",
  };
  /** Every command received, oldest first. */
  log: Command[] = [];
  globe = { x: 0, y: 0, r: 0, lat: 0, lon: 0, pin: -1 };
  drive = { mx: 0, my: 0, lx: 0, ly: 0 };
  hold = false;
  quiet = false;
  private sent = "";
  shotsOf: Record<string, string[]> = {};
  /** What the place offers once it has loaded. */
  settings: HostState["options"] = [{ key: "rain", value: 1 }, { key: "reflection", value: 1 }, { key: "glow", value: 1 }, { key: "stats", value: 0 }];

  receive(command: Command) {
    this.log.push(command);
    const s = this.state;
    switch (command.type) {
      case "globe": this.globe = { ...command }; break;
      case "enter":
        if (!s.installed.includes(command.place)) Object.assign(s, { scene: "error", place: command.place, message: `${command.place}.place is missing` });
        else Object.assign(s, { scene: "loading", place: command.place });
        break;
      case "leave": Object.assign(s, { scene: "atlas", place: "", shots: [], shot: 0 }); break;
      case "shot": s.shot = command.index; break;
      case "tour": s.tour = command.on; if (command.on) s.paused = false; break;
      case "pause": s.paused = command.on; break;
      case "option":
        s.options = s.options.map((setting) => (setting.key === command.key ? { ...setting, value: command.value } : setting));
        s.stats = s.options.find((setting) => setting.key === "stats")?.value ? "38.4 fps · 41k triangles" : "";
        break;
      case "look": s.tour = false; break;
      case "drive": this.drive = { ...command }; if (command.mx || command.my || command.lx || command.ly) s.tour = false; break;
      case "hold": this.hold = command.on; break;
      case "quiet": this.quiet = command.on; break;
      case "prefs": s.prefs = command.value; break;
    }
  }

  /** The place finished loading. */
  loaded() {
    Object.assign(this.state, { scene: "place", shots: this.shotsOf[this.state.place] ?? ["Wide", "Corner", "Entrance", "Street", "Signs", "Sky"], shot: 0, tour: true, paused: false, options: this.settings });
  }

  /** The state line to deliver, or undefined while nothing changed. */
  poll(): string | undefined {
    const line = JSON.stringify({ type: "state", value: this.state });
    if (line === this.sent) return undefined;
    this.sent = line;
    return line;
  }
}

const VIEW: Record<Device, { w: number; h: number; density: number; aux?: [number, number] }> = {
  psp: { w: 480, h: 272, density: 1 },
  vita: { w: 480, h: 272, density: 2 },
  "3ds": { w: 400, h: 240, density: 1, aux: [320, 240] },
  ipod: { w: 480, h: 320, density: 2 },
};

export interface Rig {
  /** The core, for inspecting the tree. */
  wasm: Awaited<ReturnType<typeof createWasmUi>>;
  mock: Mock;
  view: (typeof VIEW)[Device];
  /** Advance `frames`, holding `buttons`; `touch` is a contact on the touch surface. */
  step(frames?: number, input?: { buttons?: number; touch?: { x: number; y: number; id?: number }[] }): void;
  /** Press and release. */
  press(buttons: number): void;
  tap(x: number, y: number): void;
  /** The primary screen (and the auxiliary one under it) over `backdrop`, at the device's density. */
  shot(backdrop?: string): Promise<Canvas>;
}

/** Boots the bundle `bun tools/atlas-ui.ts <device>` wrote. One per process: the bundle owns `globalThis.frame`. */
export async function boot(device: Device, installed: string[]): Promise<Rig> {
  const view = VIEW[device];
  const directory = join(root, ".pocket-build/ui", device);
  const wasmPath = join(root, "vendor/pocketjs/hosts/web/pocketjs.wasm");
  if (!existsSync(wasmPath)) throw new Error("run `bun tools/wasm.ts` in vendor/pocketjs first");
  const wasm = await createWasmUi(readFileSync(wasmPath), { width: view.w, height: view.h, rasterDensity: view.density });
  if (view.aux) wasm.createAuxiliarySurface(view.aux[0], view.aux[1]);
  const mock = new Mock();
  mock.state.installed = installed;
  const globals = globalThis as Record<string, any>;
  const pending: string[] = [];
  Object.assign(wasm.ops, {
    svcOpen: (name: string) => name === "pocket.overlay",
    svcPoll: () => {
      const line = mock.poll();
      return line;
    },
    svcSend: (line: string) => pending.push(line),
  });
  globals.ui = wasm.ops;
  globals.__pak = readFileSync(join(directory, "atlas.pak")).buffer;
  (0, eval)(readFileSync(join(directory, "atlas.js"), "utf8"));

  // A box under the interface whose colour the two-pass matte flips.
  const ops = wasm.ops as any;
  const facts = createTouchHitFacts((x, y) => (view.aux ? ops.hitTestBoundsAuxiliary(x, y) : ops.hitTestBounds(x, y)));
  const frame = (buttons: number, touch: { x: number; y: number; id?: number }[]) => {
    const packed = touch.map((t) => __packTouch(t.id ?? 1, t.x, t.y));
    const surface = view.aux ? 1 : 0;
    globals.frame(buttons, undefined, packed, facts(packed), packed.map(() => surface));
    for (const line of pending.splice(0)) mock.receive(JSON.parse(line));
    wasm.tick();
  };

  // The rasterizer has no alpha; render over black and over white and take
  // the difference (the root's own colour is the only thing that changes).
  type Drawing = typeof import("@napi-rs/canvas");
  const matte = ({ createCanvas, ImageData }: Drawing, render: () => Uint8Array, rootNode: number, w: number, h: number, scale: number): Canvas => {
    ops.setProp(rootNode, PROP.bgColor, 0xff000000);
    const black = render().slice();
    ops.setProp(rootNode, PROP.bgColor, 0xffffffff);
    const white = render().slice();
    ops.setProp(rootNode, PROP.bgColor, 0);
    const pixels = new Uint8ClampedArray(black.length);
    for (let i = 0; i < black.length; i += 4) {
      const alpha = 255 - (white[i + 1] - black[i + 1]);
      pixels[i + 3] = alpha;
      for (let c = 0; c < 3; c++) pixels[i + c] = alpha ? Math.min(255, (black[i + c] * 255) / alpha) : 0;
    }
    const canvas = createCanvas(w * scale, h * scale);
    canvas.getContext("2d").putImageData(new ImageData(pixels, w * scale, h * scale), 0, 0);
    return canvas;
  };

  return {
    wasm,
    mock, view,
    step(frames = 1, input = {}) {
      for (let i = 0; i < frames; i++) frame(input.buttons ?? 0, input.touch ?? []);
    },
    press(buttons) {
      frame(buttons, []);
      frame(buttons, []);
      frame(0, []);
    },
    tap(x, y) {
      frame(0, [{ x, y }]);
      frame(0, [{ x, y }]);
      frame(0, []);
      frame(0, []);
    },
    async shot(backdrop) {
      // Only pictures need a canvas: a test of what the interface asks for does not.
      const drawing = await import("@napi-rs/canvas");
      const { createCanvas, loadImage } = drawing;
      const scale = view.density;
      const top = matte(drawing, () => wasm.renderScaled(scale), 1, view.w, view.h, scale);
      const auxH = view.aux ? view.aux[1] : 0;
      const canvas = createCanvas(view.w * scale, (view.h + auxH) * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (backdrop && existsSync(backdrop)) ctx.drawImage(await loadImage(backdrop), 0, 0, view.w * scale, view.h * scale);
      else if (mock.state.scene === "atlas" && mock.globe.r) {
        // Stand-in for the renderer's globe.
        const g = mock.globe;
        const fill = ctx.createRadialGradient((g.x - g.r * 0.3) * scale, (g.y - g.r * 0.3) * scale, 0, g.x * scale, g.y * scale, g.r * scale);
        fill.addColorStop(0, "#27496f");
        fill.addColorStop(1, "#060b16");
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(g.x * scale, g.y * scale, g.r * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.drawImage(top, 0, 0);
      if (view.aux) {
        const bottom = matte(drawing, () => wasm.renderAuxiliary(), ops.__auxiliarySurface.root, view.aux[0], view.aux[1], 1);
        ctx.drawImage(bottom, ((view.w - view.aux[0]) / 2) * scale, view.h * scale, view.aux[0] * scale, view.aux[1] * scale);
      }
      return canvas;
    },
  };
}

export { PROP };
