#include "assets.h"
#include "browser.h"
#include "control.h"
#include "devserver.h"
#include "frame_guard.h"
#include "hbldr.h"
#include "native.h"
#include "scene.h"
#include "settings.h"
#include "soc.h"
#include <3ds.h>
#include <citro3d.h>
#include <math.h>
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
  if (strcmp(atlas_stage, "running") != 0 &&
      strcmp(atlas_stage, "browser") != 0) {
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

typedef struct {
  const char *id, *sha;
  unsigned bytes, crc;
} PlaceAsset;
#define ENTRY(id, sha, bytes, crc) {id, sha, bytes, crc},
static const PlaceAsset places[] = {ATLAS_CATALOG(ENTRY)};
#undef ENTRY
static bool in_place, loaded;
static char current_place[80], pending_place[80], app_error[256],
    asset_request[1024];
static bool pending_atlas;
static char pending_browser_control[2048];
static const PlaceAsset *find_place(const char *id) {
  for (unsigned i = 0; i < sizeof places / sizeof *places; i++)
    if (!strcmp(id, places[i].id))
      return &places[i];
  return NULL;
}
static void report_status(void) {
  char detail[3072], response[4096], escaped[512];
  if (in_place)
    scene_status(detail, sizeof detail);
  else
    browser_status(detail, sizeof detail);
  control_escape(escaped, sizeof escaped, app_error);
  // Preserve the scene's flat telemetry for existing profiling tools.
  if (in_place && detail[0] == '{') {
    size_t n = strlen(detail);
    if (n && detail[n - 1] == '}')
      detail[n - 1] = 0;
    snprintf(response, sizeof response,
             "%s,\"place\":\"%s\",\"sheet\":%s,\"targetFps\":%u,\"antialias\":%"
             "s,\"error\":\"%s\",\"packSha256\":\"%s\"}",
             detail, current_place, settings_open() ? "true" : "false",
             settings_fps(), settings_antialias() ? "true" : "false", escaped,
             loaded && find_place(current_place) ? find_place(current_place)->sha : "");
  } else {
    snprintf(response, sizeof response,
             "{\"t\":\"atlas.status\",\"build\":\"" ATLAS_BUILD_ID
             "\",\"phase\":\"%s\",\"frame\":%lu,\"place\":null,\"frameMs\":%."
             "3f,\"cpuMs\":%.3f,\"gpuMs\":%.3f,\"linearFree\":%lu,\"vramFree\":"
             "%lu,\"browser\":%s,\"error\":\"%s\"}",
             atlas_stage, (unsigned long)atlas.frame, atlas.frame_ms,
             atlas.cpu_ms, atlas.gpu_ms, (unsigned long)linearSpaceFree(),
             (unsigned long)vramSpaceFree(), detail[0] ? detail : "{}",
             escaped);
  }
  devserver_send_ctrl(response, strlen(response));
}
static void controls(const char *json) {
  bool home = false;
  if (control_bool(json, "atlas", &home) && home) {
    pending_atlas = true;
    snprintf(pending_browser_control, sizeof pending_browser_control, "%s",
             json);
  }
  char id[80];
  if (control_string(json, "place", id, sizeof id)) {
    if (find_place(id))
      snprintf(pending_place, sizeof pending_place, "%s", id);
    else
      snprintf(app_error, sizeof app_error, "Place is not available: %s", id);
  }
  if (control_field(json, "asset")) {
    if (strlen(json) < sizeof asset_request)
      snprintf(asset_request, sizeof asset_request, "%s", json);
    else
      snprintf(app_error, sizeof app_error, "Asset request too large");
  }
  if (in_place) {
    settings_control(json);
    scene_control(json);
  } else
    browser_control(json);
}
static void release_view(void) {
  atlas_gpu_park();
  if (in_place)
    scene_free();
  else
    browser_free();
  loaded = false;
  settings_close();
}
static bool open_browser(void) {
  app_error[0] = 0;
  in_place = false;
  current_place[0] = 0;
  atlas_stage = "loading";
  loaded = browser_load("romfs:/atlas.3ds", app_error, sizeof app_error);
  atlas_stage = loaded ? "browser" : "load-error";
  C3D_FrameRate(30);
  if (loaded && pending_browser_control[0])
    browser_control(pending_browser_control);
  pending_browser_control[0] = 0;
  return loaded;
}
// Called only after FrameBegin has retired the preceding GPU work.
static void change_view(void) {
  release_view();
  app_error[0] = 0;
  if (pending_place[0]) {
    const PlaceAsset *asset = find_place(pending_place);
    atlas_stage = "loading";
    atlas_diagnostic("Loading selected place");
    char path[192];
    struct stat st;
    if (asset && assets_path(asset->sha, path, sizeof path) &&
        !stat(path, &st) && (unsigned long)st.st_size == asset->bytes) {
      in_place = true;
      loaded = scene_load(path, asset->sha, app_error, sizeof app_error);
      if (loaded) {
        snprintf(current_place, sizeof current_place, "%s", pending_place);
        settings_apply();
        atlas_stage = "first-frame";
      } else
        scene_free();
    } else
      snprintf(app_error, sizeof app_error,
               "Assets missing. Install the SD bundle or run atlas-3ds sync.");
    pending_place[0] = 0;
  }
  if (!loaded) {
    char error[256];
    snprintf(error, sizeof error, "%s", app_error);
    open_browser();
    if (error[0])
      snprintf(app_error, sizeof app_error, "%s", error);
  }
  pending_atlas = false;
}
static void fetch_asset(void) {
  release_view();
  atlas_stage = "syncing";
  char host[32], token[65], sha[65], error[256] = "Malformed asset request";
  bool cached = false, ok = false;
  unsigned long port = control_uint(asset_request, "port", 0);
  unsigned long bytes = control_uint(asset_request, "bytes", 0);
  unsigned long crc = control_uint(asset_request, "crc32", 0);
  sha[0] = 0;
  if (control_string(asset_request, "host", host, sizeof host) &&
      control_string(asset_request, "token", token, sizeof token) &&
      control_string(asset_request, "sha256", sha, sizeof sha) && port &&
      port <= 65535) {
    browser_ui_clear(0x0c1522);
    browser_ui_text(12, 30, "Updating place assets...", 0x66dfc7);
    browser_ui_text(12, 55, "Keep the console connected.", 0xc1d0dc);
    flush_console();
    ok = assets_fetch(host, port, token, sha, bytes, crc, &cached, error,
                      sizeof error);
  }
  char escaped[512], response[768];
  control_escape(escaped, sizeof escaped, ok ? "" : error);
  snprintf(response, sizeof response,
           "{\"t\":\"atlas.asset\",\"sha256\":\"%.64s\",\"ok\":%s,\"cached\":%"
           "s,\"error\":\"%s\"}",
           sha, ok ? "true" : "false", cached ? "true" : "false", escaped);
  asset_request[0] = 0;
  open_browser();
  if (!ok)
    snprintf(app_error, sizeof app_error, "%s", error);
  devserver_send_ctrl(response, strlen(response));
  devserver_poll();
}
static C3D_RenderTarget *make_top(bool antialias) {
  unsigned scale = antialias ? 2 : 1;
  C3D_RenderTarget *target = C3D_RenderTargetCreate(
      240 * scale, 400 * scale, GPU_RB_RGBA8, GPU_RB_DEPTH24_STENCIL8);
  if (target)
    C3D_RenderTargetSetOutput(
        target, GFX_TOP, GFX_LEFT,
        transfer | (antialias ? GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_XY) : 0));
  return target;
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
  bool gpu_ok = C3D_Init(0x200000), gpu_stalled = false, antialias = false;
  C3D_RenderTarget *top = gpu_ok ? make_top(false) : NULL;
  Result romfs = romfsInit();
  if (gpu_ok && !atlas_gpu_park_init(app_error, sizeof app_error)) {
    snprintf(app_error, sizeof app_error, "GPU program initialization failed");
    gpu_ok = false;
  }
  settings_init();
  if (!gpu_ok || !top)
    snprintf(app_error, sizeof app_error, "PICA initialization failed");
  else if (R_FAILED(romfs))
    snprintf(app_error, sizeof app_error, "romfsInit failed: %08lx",
             (unsigned long)romfs);
  else
    open_browser();
  if (!loaded) {
    atlas_stage = "load-error";
    atlas_diagnostic(app_error);
  }
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
        devserver_flush(1000);
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
    char control[16384];
    size_t n;
    while ((n = devserver_recv_ctrl(control, sizeof control - 1)) > 0) {
      control[n] = 0;
      char *save = NULL;
      for (char *line = strtok_r(control, "\n", &save); line;
           line = strtok_r(NULL, "\n", &save)) {
        if (strstr(line, "\"screenshot\"")) {
          capture_reflection = in_place && strstr(line, "\"reflection\"");
          devserver_request_screenshot();
        }
        controls(line);
        report_status();
      }
    }
    if (native_receiving() || gpu_stalled || !gpu_ok || !top ||
        (!loaded && !asset_request[0] && !pending_place[0] && !pending_atlas)) {
      svcSleepThread(1000000);
      continue;
    }
    float frame_seconds = (float)(now - last) / SYSCLOCK_ARM11;
    float dt = frame_seconds;
    last = now;
    if (dt > .25f)
      dt = 1.0f / 30;
    u32 pace = C3D_FrameCounter(0);
    u64 update_start = svcGetSystemTick();
    if (loaded && in_place) {
      if (down & KEY_START)
        pending_atlas = true;
      bool was_open = settings_open();
      if (settings_update(down))
        pending_atlas = true;
      scene_input_block(settings_open() || was_open);
      scene_update(dt, settings_open() || was_open ? 0 : down & ~KEY_SELECT,
                   settings_open() || was_open ? 0 : held & ~KEY_SELECT);
      atlas.update_ms =
          (svcGetSystemTick() - update_start) * 1000.0f / SYSCLOCK_ARM11;
      scene_prepare();
    } else if (loaded) {
      browser_update(dt, down, held);
      const char *enter = browser_take_enter();
      if (enter && find_place(enter))
        snprintf(pending_place, sizeof pending_place, "%s", enter);
    }
    if (!in_place)
      atlas.update_ms =
          (svcGetSystemTick() - update_start) * 1000.0f / SYSCLOCK_ARM11;
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
    atlas.gpu_ms = C3D_GetDrawingTime();
    if (!strcmp(atlas_stage, "first-frame"))
      atlas_stage = "running";
    if (capture_pending) {
      devserver_screenshot_ready();
      capture_pending = false;
    }
    bool changing = asset_request[0] || pending_atlas || pending_place[0];
    bool maintenance = changing ||
                       (in_place && settings_antialias()) != antialias ||
                       (!in_place && browser_wants_keyboard());
    // FrameBegin above retired the GPU. End this empty frame before freeing
    // targets: citro3d explicitly forbids deletion while inside a frame.
    if (maintenance)
      C3D_FrameEnd(GX_CMDLIST_FLUSH);
    if (asset_request[0])
      fetch_asset();
    else if (pending_atlas || pending_place[0])
      change_view();
    bool desired_aa = in_place && settings_antialias();
    if (desired_aa != antialias) {
      C3D_RenderTarget *replacement = make_top(desired_aa);
      if (replacement) {
        C3D_RenderTargetDelete(top);
        top = replacement;
        antialias = desired_aa;
      } else {
        settings_control("{\"settings\":{\"antialias\":false}}");
        snprintf(app_error, sizeof app_error,
                 "Not enough video memory for antialiasing");
      }
    }
    if (changing) {
      last = svcGetSystemTick();
      dt = 1.0f / 30;
      if (in_place)
        scene_prepare();
    }
    if (!in_place && browser_wants_keyboard()) {
      browser_keyboard();
      C3D_RenderTargetSetOutput(top, GFX_TOP, GFX_LEFT, transfer);
      last = svcGetSystemTick();
    }
    if (maintenance) {
      u64 deadline = svcGetSystemTick() + SYSCLOCK_ARM11 * 4ULL;
      while (!C3D_FrameBegin(C3D_FRAME_NONBLOCK)) {
        if (svcGetSystemTick() >= deadline) {
          gpu_stalled = true;
          break;
        }
        svcSleepThread(100000);
      }
      if (gpu_stalled) {
        atlas_stage = "gpu-timeout";
        continue;
      }
    }
    if (shot && !maintenance) {
      C3D_RenderTarget *source =
          in_place && capture_reflection ? scene_reflection_target() : top;
      if (source)
        capture_pending = capture(source);
      shot = false;
    }
    u64 pace_start = svcGetSystemTick();
    while (C3D_FrameCounter(0) == pace) {
      if (!capture_pending)
        devserver_poll();
      svcSleepThread(100000);
    }
    float period = 1000.0f / (in_place ? settings_fps() : 30);
    // Delay only when BOTH processors have spare budget. A short GPU pass
    // must not add idle time on top of a CPU-heavy animation/culling frame.
    float work_ms = fmaxf(atlas.gpu_ms, atlas.prepare_ms + atlas.update_ms) +
                    atlas.submit_ms;
    float delay_ms = period - 10.333f - work_ms;
    if (delay_ms > 0 && atlas.frame > 1)
      svcSleepThread((s64)(delay_ms * 1000000));
    gpu_wait += svcGetSystemTick() - pace_start;
    if (loaded) {
      if (in_place)
        scene_render(top);
      else
        browser_render(top);
    }
    C3D_FrameEnd(GX_CMDLIST_FLUSH);
    atlas.cpu_ms =
        (float)(svcGetSystemTick() - now - gpu_wait) * 1000.0f / SYSCLOCK_ARM11;
    atlas.frame_ms = frame_seconds * 1000.0f;
    atlas.frame++;
    if (in_place)
      scene_measure();
    devserver_set_runtime(&state, NULL, atlas_stage, 0);
    devserver_set_frame_stats(atlas.frame, atlas.draws + atlas.reflect_draws,
                              3 * (atlas.triangles + atlas.reflect_triangles),
                              0);
    devserver_set_frame_timing(0, 0, 0, (uint32_t)(atlas.cpu_ms * 1000),
                               (uint32_t)(atlas.frame_ms * 1000));
    shot = shot || devserver_take_screenshot_request();
    if (!in_place || settings_open() || hud++ % 15 == 0 || changing) {
      if (!in_place)
        browser_hud();
      else if (settings_open())
        settings_draw();
      else
        scene_hud();
      if (app_error[0]) {
        browser_ui_rect(0, 204, 320, 36, 0x4b2020);
        browser_ui_wrap(6, 205, 308, app_error, 0xffdfd0);
      }
      flush_console();
    }
  }
  // Retire captures and leave the frame before deleting render targets.
  if (gpu_ok && !gpu_stalled && !atlas_gpu_idle(4000, !capture_pending))
    gpu_stalled = true;
  if (gpu_ok && !gpu_stalled) {
    release_view();
    if (top)
      C3D_RenderTargetDelete(top);
    C3D_Fini();
    atlas_gpu_park_shutdown();
  }
  if (!gpu_stalled || !capture_pending)
    devserver_shutdown();
  soc_shutdown();
  if (R_SUCCEEDED(romfs))
    romfsExit();
  if (native_exit_pending() && !native_finish_exit(error, sizeof error))
    atlas_diagnostic(error);
  if (boot_log)
    fclose(boot_log);
  gfxExit();
  return 0;
}
