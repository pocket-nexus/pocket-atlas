import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// What makes the one APK install and start on both the Redmi 1S (Android 4.3,
// ARMv7) and a current 64-bit phone is spread over the manifest, the tool and
// the shell. These read the sources: a built package is checked by the tool
// itself (`apk`), which needs the NDK.
const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const manifest = read("android/AndroidManifest.xml");
const tool = read("tools/atlas-android.ts");
const shell = read("android/src/main.c");
const attribute = (name: string) => new RegExp(`android:${name}="([^"]*)"`).exec(manifest)?.[1];

test("the manifest's SDK levels are the ones the tool checks in a package", () => {
  const levels = /MIN_SDK = (\d+), TARGET_SDK = (\d+)/.exec(tool);
  expect(levels).not.toBeNull();
  expect(attribute("minSdkVersion")).toBe(levels![1]);
  expect(attribute("targetSdkVersion")).toBe(levels![2]);
  // Android 4.3 is API 18. Android 14 installs nothing that targets below 23, Android 15 nothing below 24.
  expect(Number(levels![1])).toBe(18);
  expect(Number(levels![2])).toBeGreaterThanOrEqual(24);
  expect(tool).toContain("`sdkVersion:'${MIN_SDK}'`, `targetSdkVersion:'${TARGET_SDK}'`");
  expect(tool).toContain('"--min-sdk-version", "18"');
});

test("the launcher's activity is exported and survives every change of configuration", () => {
  // Required of an activity with an intent filter by a package that targets 31 or later.
  expect(attribute("exported")).toBe("true");
  // The shell ends its process when its activity is destroyed, and the system
  // destroys an activity for a change its manifest does not name.
  const named = attribute("configChanges")!.split("|");
  for (const change of ["mcc", "mnc", "locale", "touchscreen", "keyboard", "keyboardHidden", "navigation", "orientation", "screenLayout", "uiMode", "screenSize",
    "smallestScreenSize", "layoutDirection", "density", "fontScale", "colorMode", "fontWeightAdjustment", "grammaticalGender"])
    expect(named).toContain(change);
  // The loader opens libatlas.so as a file beside libmain.so.
  expect(attribute("extractNativeLibs")).toBe("true");
});

test("the package holds a library for the Redmi 1S and one for a 64-bit phone", () => {
  const abis = [...tool.matchAll(/\{ abi: "([^"]+)", clang: "([^"]+)", rust: "([^"]+)", machine: \[[^\]]*\], pageSize: (\d+) \}/g)].map(([, abi, clang, rust, pageSize]) => ({ abi, clang, rust, pageSize: Number(pageSize) }));
  expect(abis).toEqual([
    // API 18, the Redmi 1S's, and its kernel's 4 KiB pages.
    { abi: "armeabi-v7a", clang: "armv7a-linux-androideabi18-clang", rust: "armv7-linux-androideabi", pageSize: 4096 },
    // API 21, the first with 64-bit libraries; segments 16 KiB apart for a kernel with pages of that size.
    { abi: "arm64-v8a", clang: "aarch64-linux-android21-clang", rust: "aarch64-linux-android", pageSize: 16384 },
  ]);
  expect(tool).toContain("`-Wl,-z,max-page-size=${abi.pageSize}`");
  // Both go into the package under names in a fixed order, dated 1980-01-01: two builds give the same bytes.
  expect(tool).toContain('ABIS.flatMap((abi) => ["libatlas.so", "libmain.so"].map((library) => `lib/${abi.abi}/${library}`)).sort()');
});

test("the shell is the entry the loader calls, around the glue's", () => {
  expect(tool).toContain('"-DANativeActivity_onCreate=atlas_glue"');
  expect(shell).toContain("void atlas_activity(ANativeActivity *activity, void *saved, size_t size)");
  expect(read("android/src/loader.c")).toContain('dlsym(library, "atlas_activity")');
});
