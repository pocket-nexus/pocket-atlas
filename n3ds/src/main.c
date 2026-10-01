#include "devserver.h"
#include "hbldr.h"
#include "native.h"
#include "scene.h"
#include "soc.h"
#include <3ds.h>
#include <citro3d.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

unsigned int __stacksize__ = 256 * 1024;
extern int __system_argc;
extern char **__system_argv;
const char *atlas_stage = "boot";
static FILE *boot_log;
static bool capture_reflection;
static const u32 transfer = GX_TRANSFER_FLIP_VERT(0) |
                            GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
                            GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
                            GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
                            GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO);

static void flush_console(void) {
  GSPGPU_FlushDataCache(gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, NULL, NULL),
                        320 * 240 * 2);
}

void atlas_diagnostic(const char *message) {
  if (strcmp(atlas_stage, "running") != 0) {
    printf("%s\n", message);
    flush_console();
  }
  if (boot_log) {
    fprintf(boot_log, "%llu %s\n", (unsigned long long)osGetTime(), message);
    fflush(boot_log);
  }
  devserver_report_log("info", message);
}

static bool capture(C3D_RenderTarget *target) {
  uint8_t *top = NULL, *bottom = NULL;
  unsigned width = target->frameBuf.height, height = target->frameBuf.width;
  if (!devserver_screenshot_begin(atlas.frame, width, height, 320, 240, &top,
                                  &bottom))
    return false;
  C3D_SyncDisplayTransfer(target->frameBuf.colorBuf,
                          GX_BUFFER_DIM(height, width), (u32 *)top,
                          GX_BUFFER_DIM(height, width), transfer);
  GSPGPU_InvalidateDataCache(top, width * height * 3);
  u16 w, h;
  const uint16_t *fb =
      (const uint16_t *)gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, &w, &h);
  if (w != 240 || h != 320) {
    devserver_screenshot_cancel();
    return false;
  }
  // consoleInit selects RGB565; the debug wire carries BGR8 on both surfaces.
  for (unsigned i = 0; i < 320 * 240; i++) {
    unsigned p = fb[i];
    bottom[3 * i] = (p & 31) * 255 / 31;
    bottom[3 * i + 1] = ((p >> 5) & 63) * 255 / 63;
    bottom[3 * i + 2] = ((p >> 11) & 31) * 255 / 31;
  }
  return true;
}

// Full builds seed a hash-addressed SD cache. Thin development builds use
// exactly that asset revision, so a native renderer update is only ~300 KiB.
static bool place_path(char *path, size_t capacity, char *error,
                       size_t error_capacity) {
  snprintf(path, capacity, "sdmc:/pocket-atlas/" ATLAS_PLACE_SHA ".place");
  struct stat st;
  if (stat(path, &st) == 0 && st.st_size == ATLAS_PLACE_BYTES)
    return true;
  FILE *src = fopen("romfs:/scene.place", "rb");
  if (!src) {
    snprintf(error, error_capacity,
             "Asset cache missing: install a full build first");
    return false;
  }
  atlas_diagnostic("Caching shared place assets on SD");
  const char *temp = "sdmc:/pocket-atlas/" ATLAS_PLACE_SHA ".place.tmp";
  FILE *dst = fopen(temp, "wb");
  unsigned char *buffer = malloc(64 * 1024);
  bool ok = dst && buffer;
  size_t total = 0;
  while (ok) {
    size_t n = fread(buffer, 1, 64 * 1024, src);
    if (!n) {
      ok = !ferror(src);
      break;
    }
    if (fwrite(buffer, 1, n, dst) != n) {
      ok = false;
      break;
    }
    total += n;
    devserver_poll();
  }
  free(buffer);
  fclose(src);
  if (dst && fclose(dst) != 0)
    ok = false;
  if (ok && total == ATLAS_PLACE_BYTES && rename(temp, path) == 0)
    return true;
  remove(temp);
  // Standalone playback still works if the optional SD cache cannot be written.
  snprintf(path, capacity, "romfs:/scene.place");
  atlas_diagnostic("SD cache unavailable; reading embedded assets");
  return true;
}

int main(void) {
  gfxInitDefault();
  gfxSet3D(false);
  gfxSetDoubleBuffering(GFX_BOTTOM, false);
  consoleInit(GFX_BOTTOM, NULL);
  mkdir("sdmc:/pocket-atlas", 0777);
  boot_log = fopen("sdmc:/pocket-atlas/boot.log", "w");
  atlas_diagnostic("Pocket Atlas " ATLAS_BUILD_ID);
  char error[256] = {0};
  PocketRuntimeState state = {0};
  if (__system_argc > 0 && __system_argv)
    native_set_running_path(__system_argv[0]);
  mkdir("sdmc:/pocketjs", 0777);
  mkdir("sdmc:/pocketjs/runtime", 0777);
  devserver_allow_packages(false);
  DevserverInitResult dev = devserver_init(&state, error, sizeof error);
  atlas_diagnostic(dev == DEVSERVER_READY ? "Remote debugger ready" : error);
  bool gpu_ok = C3D_Init(0x200000), loaded = false, gpu_stalled = false;
  C3D_RenderTarget *top = NULL;
  if (gpu_ok) {
    C3D_FrameRate(30.0f);
    top =
        C3D_RenderTargetCreate(240, 400, GPU_RB_RGBA8, GPU_RB_DEPTH24_STENCIL8);
    if (top)
      C3D_RenderTargetSetOutput(top, GFX_TOP, GFX_LEFT, transfer);
  }
  Result romfs = romfsInit();
  if (!gpu_ok || !top)
    snprintf(error, sizeof error, "PICA initialization failed");
  else if (R_FAILED(romfs))
    snprintf(error, sizeof error, "romfsInit failed: %08lx",
             (unsigned long)romfs);
  else {
    atlas_stage = "loading";
    devserver_set_runtime(&state, NULL, atlas_stage, 0);
    atlas_diagnostic("Loading the place");
    char place[192];
    if (place_path(place, sizeof place, error, sizeof error))
      loaded = scene_load(place, error, sizeof error);
  }
  atlas_stage = loaded ? "first-frame" : "load-error";
  atlas_diagnostic(loaded ? "Submitting first frame" : error);
  devserver_set_runtime(&state, NULL, atlas_stage, 0);
  u64 last = svcGetSystemTick(), next_retry = 0;
  unsigned hud = 0;
  bool shot = false, capture_pending = false;
  while (aptMainLoop()) {
    hidScanInput();
    uint32_t held = hidKeysHeld(), down = hidKeysDown();
    if ((held & (KEY_L | KEY_R | KEY_START)) == (KEY_L | KEY_R | KEY_START))
      break;
    if (!capture_pending)
      devserver_poll();
    u64 now = svcGetSystemTick();
    if (dev != DEVSERVER_READY && now >= next_retry) {
      dev = devserver_init(&state, error, sizeof error);
      next_retry = now + SYSCLOCK_ARM11 * 3ULL;
    }
    char launch[POCKET_RUNTIME_NATIVE_NAME_BYTES + 1],
        path[POCKET_NATIVE_PATH_BYTES];
    if (devserver_take_launch(launch) && native_path_for(launch, path)) {
      if (hbldr_launch_on_exit(path, error, sizeof error)) {
        devserver_flush(1000); // retire the preceding staged/installed receipt
        devserver_report_native("launching", launch, "exiting to start it");
        devserver_poll();
        devserver_flush(1000);
        for (unsigned i = 0; i < 200; i++) {
          devserver_poll();
          svcSleepThread(1000000);
        }
        break;
      }
      devserver_report_native("launch-error", launch, error);
    }
    char control[4096];
    size_t n;
    while ((n = devserver_recv_ctrl(control, sizeof control - 1)) > 0) {
      control[n] = 0;
      char *save = NULL;
      for (char *line = strtok_r(control, "\n", &save); line;
           line = strtok_r(NULL, "\n", &save)) {
        if (strstr(line, "\"screenshot\"")) {
          capture_reflection = strstr(line, "\"reflection\"") != NULL;
          devserver_request_screenshot();
        }
        if (loaded)
          scene_control(line);
        char status[2048];
        scene_status(status, sizeof status);
        devserver_send_ctrl(status, strlen(status));
      }
    }
    // Retain networking and the CPU console after a failed load or GPU stall.
    // Calling C3D_Fini here would wait on the hung GPU forever.
    if (native_receiving() || !loaded || gpu_stalled) {
      svcSleepThread(1000000);
      continue;
    }
    float dt = (float)(now - last) / SYSCLOCK_ARM11;
    last = now;
    if (dt > 0.25f)
      dt = 1.0f / 30.0f;
    u32 pace = C3D_FrameCounter(0);
    u64 update_start = svcGetSystemTick();
    scene_update(dt, down, held);
    atlas.update_ms =
        (svcGetSystemTick() - update_start) * 1000.0f / SYSCLOCK_ARM11;
    scene_prepare();
    u64 wait_start = svcGetSystemTick();
    while (!C3D_FrameBegin(C3D_FRAME_NONBLOCK)) {
      if (!capture_pending)
        devserver_poll();
      svcSleepThread(100000);
      if (svcGetSystemTick() - wait_start > SYSCLOCK_ARM11 * 4ULL) {
        atlas_stage = "gpu-timeout";
        atlas_diagnostic("GPU timeout: debugger remains available");
        devserver_set_runtime(&state, NULL, atlas_stage, 0);
        gpu_stalled = true;
        break;
      }
    }
    if (gpu_stalled)
      continue;
    u64 gpu_wait = svcGetSystemTick() - wait_start;
    atlas.gpu_ms =
        C3D_GetDrawingTime(); // the retired frame, before starting a new timer
    if (atlas.frame == 1) {
      atlas_stage = "running";
      atlas_diagnostic("First frame retired");
      devserver_set_runtime(&state, NULL, atlas_stage, 0);
    }
    if (capture_pending) {
      devserver_screenshot_ready();
      capture_pending = false;
    }
    if (shot) {
      capture_pending =
          capture(capture_reflection ? scene_reflection_target() : top);
      shot = false;
    }
    // Prepare while the preceding GPU frame runs, then anchor submission to
    // the 30 Hz vblank cadence. Waiting after submission let variable CPU
    // preparation shift GPU completion across adjacent display vblanks.
    u64 pace_start = svcGetSystemTick();
    // Top and bottom LCD vblanks have different phases. Only the top screen
    // presents the 3D scene; waiting for both can skip a 30 Hz deadline.
    while (C3D_FrameCounter(0) == pace) {
      if (!capture_pending)
        devserver_poll();
      svcSleepThread(100000);
    }
    float delay_ms = 23.0f - (atlas.gpu_ms + atlas.submit_ms);
    if (delay_ms > 0 && atlas.frame > 1)
      svcSleepThread((s64)(delay_ms * 1000000));
    gpu_wait += svcGetSystemTick() - pace_start;
    scene_render(top);
    C3D_FrameEnd(GX_CMDLIST_FLUSH);
    atlas.cpu_ms =
        (float)(svcGetSystemTick() - now - gpu_wait) * 1000.0f / SYSCLOCK_ARM11;
    atlas.frame_ms = dt * 1000.0f;
    atlas.frame++;
    scene_measure();
    devserver_set_frame_stats(atlas.frame, atlas.draws + atlas.reflect_draws,
                              3 * (atlas.triangles + atlas.reflect_triangles),
                              0);
    devserver_set_frame_timing(0, 0, 0, (uint32_t)(atlas.cpu_ms * 1000),
                               (uint32_t)(atlas.frame_ms * 1000));
    shot = devserver_take_screenshot_request();
    if (hud++ % 15 == 0) {
      scene_hud();
      flush_console();
    }
  }
  devserver_shutdown();
  soc_shutdown();
  if (gpu_ok && !gpu_stalled) {
    C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
    C3D_FrameEnd(GX_CMDLIST_FLUSH);
    C3D_FrameSync();
    scene_free();
    if (top)
      C3D_RenderTargetDelete(top);
    C3D_Fini();
  }
  if (R_SUCCEEDED(romfs))
    romfsExit();
  if (native_exit_pending()) {
    if (!native_finish_exit(error, sizeof error))
      atlas_diagnostic(error);
  }
  if (boot_log)
    fclose(boot_log);
  gfxExit();
  return 0;
}
