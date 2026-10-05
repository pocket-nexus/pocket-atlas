import "./styles.css";
import { playTitle } from "../../vendor/pocketjs/engine/pocket3d/crates/pocket3d-title/web/pocket3d-title.js";
import { App } from "./core/App";
import { readParams } from "./core/params";

function fail(message: string): void {
  const ui = document.getElementById("ui")!;
  ui.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;color:#cfd8e3;font:14px/1.6 system-ui;text-align:center;padding:24px">${message}</div>`;
}

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;
const params = readParams();
// The Pocket3D title card covers the page while the first stage is built.
// Capture and export runs (?shot, ?export) skip it, so they keep their timing.
const title = params.shot || params.exporting ? Promise.resolve() : playTitle();

if (!document.createElement("canvas").getContext("webgl2")) {
  fail("Pocket Atlas needs WebGL 2. Try a current Chrome, Edge, Firefox or Safari.");
} else {
  const app = new App(canvas, ui, params);
  (window as unknown as { pocketAtlas: App }).pocketAtlas = app;
  app.start(title).catch((err) => {
    console.error(err);
    fail(`Something went wrong while starting: ${(err as Error).message}`);
  });
}
