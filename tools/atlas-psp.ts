// PSP uses PocketJS's pinned SDK resolver, Atlas owns the place renderer.
// bun tools/atlas-psp.ts cook|build|serve|run|status|ctl|capture|package
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePspBuildToolchain } from "../vendor/pocketjs/tools/psp-toolchain.ts";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const command = args[0] ?? "build";
const opt = (key: string, fallback: string) => { const at = args.indexOf(key); return at < 0 ? fallback : args[at + 1] ?? fallback; };
const place = opt("--place", "tokyo-konbini");
if (!/^[a-z0-9-]+$/.test(place)) throw new Error("invalid place id");
const share = resolve(root, ".pocket-build/psp/host0");
const pack = resolve(root, `.pocket-build/places/${place}/${place}.psp.place`);
const port = opt("--port", "10000");
mkdirSync(share, { recursive: true });

async function build() {
  if (!existsSync(pack)) throw new Error("cook the PSP place first");
  const tc = resolvePspBuildToolchain();
  await $`${tc.rustup} run ${tc.manifest.rust.toolchain} cargo psp --release --locked`.cwd(`${root}/psp`).env({
    ...tc.environment, RUST_PSP_ABORT_ONLY: "1",
    RUST_PSP_TARGET: `${root}/vendor/pocketjs/hosts/psp/targets/mipsel-sony-psp.json`,
  });
  const out = `${root}/psp/target/mipsel-sony-psp/release`;
  cpSync(`${out}/pocket-atlas-psp.prx`, `${share}/pocket-atlas.prx`);
  cpSync(`${out}/EBOOT.PBP`, `${share}/EBOOT.PBP`);
  cpSync(pack, `${share}/scene.place`);
  console.log(`PSP release: ${share}`);
}
async function shell(text: string) {
  const p = Bun.spawn(["pspsh", "-p", port, "-e", text], {stdout:"pipe",stderr:"pipe"});
  const timeout = setTimeout(()=>p.kill(),15000);
  const [out,err,code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  clearTimeout(timeout);console.log(out+err);
  if (code !== 0 || /Error:|Error loading|Could not|failed/i.test(out+err)) throw new Error(`pspsh failed: ${text}`);
}
if (command === "cook") {
  await $`cargo run --release --locked -p pocket3d-place-cook -- psp --in ${root}/.pocket-build/places/${place}/${place}.place --out ${pack}`.cwd(root);
} else if (command === "build") await build();
else if (command === "serve") {
  const running = await $`pgrep -x usbhostfs_pc`.nothrow().quiet();
  if (running.exitCode === 0) throw new Error("usbhostfs_pc already owns a PSP session; reuse it or stop it explicitly first");
  await $`usbhostfs_pc -b ${port} ${share}`;
} else if (command === "run") {
  if (!args.includes("--no-build")) await build();
  await shell("reset"); await Bun.sleep(1500);
  rmSync(`${share}/status.json`,{force:true});
  await Bun.write(`${share}/control.txt`,`0 -1 0 1 1 ${Date.now()%1000000000}\n`);
  await shell("ldstart host0:/pocket-atlas.prx");
  const deadline=Date.now()+30000;
  while(!existsSync(`${share}/status.json`)) {if(Date.now()>deadline)throw new Error("PSP loaded but did not report a rendered frame window");await Bun.sleep(250);}
  console.log(readFileSync(`${share}/status.json`,"utf8"));
} else if (command === "status") {
  if(Date.now()-statSync(`${share}/status.json`).mtimeMs>10000)throw new Error("PSP status is stale; check the running app and PSPLINK host");
  console.log(readFileSync(`${share}/status.json`,"utf8"));
}
else if (command === "shots") {
  const directory=resolve(opt("--out",`${root}/.pocket-build/validation/psp/shots-${Date.now()}`));
  mkdirSync(directory,{recursive:true});
  const rows=[];
  try {
    const shotCount=readFileSync(`${share}/scene.place`).readUInt32LE(52);
    for(let shot=0;shot<shotCount;shot++) {
      const previous=JSON.parse(readFileSync(`${share}/status.json`,"utf8")).frame;
      await Bun.write(`${share}/control.txt`,`${shot} 10 0 1 1 ${Date.now()%1000000000}\n`);
      const samples=[];let last=-1;const deadline=Date.now()+45000;
      while(samples.length<5) {
        await Bun.sleep(500);
        if(Date.now()>deadline) throw new Error(`shot ${shot} stopped reporting`);
        let s;try{s=JSON.parse(readFileSync(`${share}/status.json`,"utf8"));}catch{continue;}
        if(s.frame>previous+30&&s.frame!==last&&s.shotIndex===shot&&s.time===10) {samples.push(s);last=s.frame;}
      }
      const row={shot:samples[0].shot,fps:samples.reduce((n,s)=>n+s.fps,0)/samples.length,workMs:samples.reduce((n,s)=>n+s.workMs,0)/samples.length,maxWorkMs:Math.max(...samples.map(s=>s.maxWorkMs)),draws:samples[0].draws,triangles:samples[0].triangles,samples};
      rows.push(row);console.log(JSON.stringify({...row,samples:undefined}));
      const file=`shot-${shot}.bmp`;await shell(`scrshot ${file}`);cpSync(`${share}/${file}`,`${directory}/${row.shot}.bmp`);
    }
  } finally {
    await Bun.write(`${directory}/shots.json`,JSON.stringify(rows,null,2));
    await Bun.write(`${share}/control.txt`,`0 -1 0 1 1 ${Date.now()%1000000000}\n`);
  }
}
else if (command === "ctl") {
  // shot, fixed time (-1 = live), pause, rain, reflection, nonce; one atomic file.
  const c = JSON.parse(args[1] ?? "{}");
  const data = `${c.shot ?? -1} ${c.time ?? -1} ${Number(c.pause ?? false)} ${Number(c.rain ?? true)} ${Number(c.reflection ?? true)} ${Date.now()%1000000000}\n`;
  await Bun.write(`${share}/control.txt`,data);
} else if (command === "capture") {
  const out = resolve(opt("--out",`${root}/.pocket-build/validation/psp/${Date.now()}.bmp`));
  mkdirSync(resolve(out,".."),{recursive:true});
  const file = `capture-${Date.now()}.bmp`;
  await shell(`scrshot ${file}`);
  if (!existsSync(`${share}/${file}`)) throw new Error("PSPLINK did not write the screenshot");
  cpSync(`${share}/${file}`,out);
} else if (command === "package") {
  await build();
  const out = `${root}/dist/PSP/GAME/PocketAtlas`;
  mkdirSync(out,{recursive:true});
  cpSync(`${share}/EBOOT.PBP`,`${out}/EBOOT.PBP`);
  cpSync(`${share}/scene.place`,`${out}/scene.place`);
  console.log(`Copy dist/PSP to the Memory Stick: ${out}`);
} else throw new Error(`unknown PSP command ${command}`);
