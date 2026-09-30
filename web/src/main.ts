import "./styles.css";
import { App } from "./core/App";
import { readParams } from "./core/params";

function fail(message: string): void {
  const ui = document.getElementById("ui")!;
  ui.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;color:#cfd8e3;font:14px/1.6 system-ui;text-align:center;padding:24px">${message}</div>`;
}

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

if (!document.createElement("canvas").getContext("webgl2")) {
  fail("Pocket City needs WebGL 2. Try a current Chrome, Edge, Firefox or Safari.");
} else {
  const app = new App(canvas, ui, readParams());
  (window as unknown as { pocketCity: App }).pocketCity = app;
  app.start().catch((err) => {
    console.error(err);
    fail(`Something went wrong while starting: ${(err as Error).message}`);
  });
}
