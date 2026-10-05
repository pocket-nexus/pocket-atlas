// The app icon is the Pocket3D icon on every console. PocketJS holds the files
// (vendor/pocketjs/engine/pocket3d/icon/); each build reads them from there,
// and this repository tracks no icon of its own.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { POCKET3D_ICON } from "../vendor/pocketjs/tools/pocket3d-icon.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const count = (text: string, part: string) => text.split(part).length - 1;

/** True for a path a console's launcher, or a build of this repository, would read as the icon. */
function launcherIcon(path: string): boolean {
  const name = basename(path);
  // PSP ICON0.PNG, PS Vita sce_sys/icon0.png, and a drawing either was baked from
  if (/^icon0\./i.test(name)) return true;
  // Nintendo 3DS: an SMDH, or a picture one is made from
  if (/\.smdh$/i.test(name) || (path.startsWith("n3ds/") && /^icon.*\.png$/i.test(name))) return true;
  // iPod touch: Icon.png, Icon@2x.png and the other names SpringBoard reads from a bundle
  return /^Icon.*\.png$/.test(name) || (path.startsWith("ipod/") && /^icon.*\.png$/i.test(name));
}

test("the rule names each console's icon file and leaves the game's own pictures alone", () => {
  for (const path of ["psp/assets/icon0.png", "psp/assets/ICON0.PNG", "psp/assets/icon0.svg", "vita/assets/sce_sys/icon0.png",
    "n3ds/icon.png", "n3ds/icon-small.png", "n3ds/atlas.smdh", "ipod/Icon.png", "ipod/Icon@2x.png", "ipod/assets/icon-72.png"])
    expect([path, launcherIcon(path)]).toEqual([path, true]);
  for (const path of ["psp/assets/pic1.png", "vita/assets/sce_sys/livearea/contents/bg.png", "vita/assets/sce_sys/livearea/contents/startup.png"])
    expect([path, launcherIcon(path)]).toEqual([path, false]);
});

test("no icon file is tracked outside vendor/", () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  expect(listed.exitCode).toBe(0);
  const tracked = listed.stdout.toString().split("\0").filter(Boolean);
  expect(tracked).toContain("psp/assets/pic1.png");
  expect(tracked.filter((path) => !path.startsWith("vendor/") && launcherIcon(path))).toEqual([]);
});

test("the pinned PocketJS holds the icon of every console", () => {
  for (const file of Object.values(POCKET3D_ICON)) {
    expect(file.startsWith(resolve(root, "vendor/pocketjs/engine/pocket3d/icon") + "/")).toBe(true);
    expect([file, existsSync(file)]).toEqual([file, true]);
  }
});

test("every console's build reads the icon from PocketJS", () => {
  // PSP: cargo-psp's manifest, and the pack-pbp call that writes the EBOOT again (ICON0.PNG is its third argument)
  expect(read("psp/Psp.toml")).toMatch(/^xmb_icon_png = "\.\.\/vendor\/pocketjs\/engine\/pocket3d\/icon\/psp\/ICON0\.PNG"$/m);
  const psp = read("tools/atlas-psp.ts");
  expect(count(psp, "pack-pbp ")).toBeGreaterThan(0);
  expect(count(psp, "/PARAM.SFO ${POCKET3D_ICON.psp} NULL NULL ")).toBe(count(psp, "pack-pbp "));

  // PS Vita: every package, the development build and the standalone VPK, replaces sce_sys/icon0.png
  const vita = read("tools/atlas.ts");
  expect(count(vita, "packageVitaVpk(")).toBeGreaterThan(0);
  expect(count(vita, "icon: POCKET3D_ICON.vita")).toBe(count(vita, "packageVitaVpk("));

  // Nintendo 3DS: smdhtool takes the large icon, the output, then the small icon
  const makefile = read("n3ds/Makefile");
  expect(makefile).toContain("\nICON := /atlas/vendor/pocketjs/engine/pocket3d/icon/3ds/icon.png\n");
  expect(makefile).toContain("\nSMALL_ICON := /atlas/vendor/pocketjs/engine/pocket3d/icon/3ds/icon-small.png\n");
  expect(count(makefile, "smdhtool --create")).toBe(1);
  expect(makefile).toMatch(/smdhtool --create .* \$\(ICON\) \$@ \$\(SMALL_ICON\)$/m);

  // iPod touch: both files copied under the names Info.plist lists, with no gloss added
  const ipod = read("tools/atlas-ipod.ts");
  expect(ipod).toContain('cpSync(POCKET3D_ICON.ios, join(bundle, "Icon.png"))');
  expect(ipod).toContain('cpSync(POCKET3D_ICON.ios2x, join(bundle, "Icon@2x.png"))');
  expect(ipod).toContain('CFBundleIconFiles: `<array>${text("Icon.png")}${text("Icon@2x.png")}</array>`');
  expect(ipod).toContain('UIPrerenderedIcon: "<true/>"');
});
