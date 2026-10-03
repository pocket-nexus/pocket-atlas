/** Real browser input/save smoke check; desktop timings are not Vita acceptance. */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:5197";
const out = resolve(import.meta.dir, "../../.pocket-build/validation/hokkaido-winter-drive/browser");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({channel:"chrome",headless:true,args:["--use-angle=metal","--enable-gpu","--ignore-gpu-blocklist"]});
const page = await browser.newPage({viewport:{width:960,height:544}});
const errors: string[]=[];
page.on("pageerror", e=>errors.push(e.message));
page.on("console", m=>{if(m.type()==="error")errors.push(m.text());});
const check=(v:unknown,message:string)=>{if(!v)throw new Error(message);};
try {
  // A connected but idle controller must not swallow keyboard steering.
  await page.addInitScript(()=>Object.defineProperty(navigator,"getGamepads",{value:()=>[{
    connected:true,axes:[0,0],buttons:Array.from({length:16},()=>({value:0,pressed:false})),
  }]}));
  await page.goto(`${base}/?q=high&mute#/place/hokkaido-winter-drive`);
  await page.waitForFunction(()=>!!(window as any).pocketAtlasDrive,{},{timeout:90_000});
  const read=()=>page.evaluate(()=>{
    const d=(window as any).pocketAtlasDrive;
    return {state:{...d.state},paused:d.paused,chunks:d.residentChunks};
  });
  const initial=await read();
  check(initial.paused,"journey must begin paused");
  await page.screenshot({path:resolve(out,"dispatch.png")});
  await page.locator('[data-act="resume"]').click();
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2000);
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(180);
  await page.keyboard.up("KeyD");
  await page.keyboard.up("KeyW");
  const moving=await read();
  check(moving.state.odometer>1,"throttle must move the car through ordinary input");
  check(Math.abs(moving.state.yaw-initial.state.yaw)>0.015,"neutral gamepad must leave keyboard steering active");
  check(moving.chunks>0&&moving.chunks<=7,"web chunk residency must remain bounded");
  await page.keyboard.press("KeyC");
  await page.screenshot({path:resolve(out,"cabin-moving.png")});
  await page.keyboard.down("Space");
  await page.waitForTimeout(2600);
  await page.keyboard.up("Space");
  const stopped=await read();
  check(Math.abs(stopped.state.speed)<0.08,"brake must stop the vehicle");
  await page.keyboard.press("Escape");
  const saved=await read();
  check(saved.paused,"Escape must pause");
  await page.reload();
  await page.waitForFunction(()=>!!(window as any).pocketAtlasDrive,{},{timeout:90_000});
  const restored=await read();
  check(restored.paused,"reload must resume at dispatch, not moving");
  check(restored.state.odometer===saved.state.odometer&&restored.state.s===saved.state.s,"reload must restore exact saved progress");
  check(errors.length===0,`browser errors: ${errors.join("\n")}`);
  const receipt={kind:"desktop-browser-input",initial,moving,stopped,saved,restored,errors};
  writeFileSync(resolve(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify({ok:true,odometer:moving.state.odometer,residentChunks:moving.chunks,saveReload:true,errors,out}));
} finally { await browser.close(); }
