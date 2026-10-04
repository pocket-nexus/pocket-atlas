// Pocket Atlas on the 3DS: the globe and the places on the top screen, and
// the interface, a PocketJS guest (`ui/`), over them and on the whole touch
// screen. It draws every 2D pixel and says what the buttons and the stylus
// mean; this file owns the frame, the files and the debug wire.
#include "assets.h"
#include "control.h"
#include "devserver.h"
#include "frame_guard.h"
#include "globe.h"
#include "guest.h"
#include "hbldr.h"
#include "input.h"
#include "interface.h"
#include "native.h"
#include "navigation.h"
#include "scene.h"
#include "settings.h"
#include "soc.h"
#include <3ds.h>
#include <citro3d.h>
#include <malloc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

// The guest's parser and its mount recurse.
unsigned int __stacksize__ = 1024 * 1024;
// libctru would halve the application's memory between malloc and the
// linear heap. Everything large a place owns is linear (scene.c) and the
// largest place (Tokyo, 36 MiB) no longer fits a half beside the
// interface's textures; malloc holds the interface (6 MiB) and a place's
// tables, so it gets 14 MiB and the linear heap the rest.
u32 __ctru_heap_size = 14 * 1024 * 1024;
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

void atlas_diagnostic(const char *message) {
  if (boot_log) {
    fprintf(boot_log, "%llu %s\n", (unsigned long long)osGetTime(), message);
    fflush(boot_log);
  }
  devserver_report_log("info", message);
}

static C3D_RenderTarget *bottom_target;
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
  C3D_SyncDisplayTransfer(bottom_target->frameBuf.colorBuf,
                          GX_BUFFER_DIM(240, 320), (u32 *)bottom,
                          GX_BUFFER_DIM(240, 320), transfer);
  GSPGPU_InvalidateDataCache(bottom, 320 * 240 * 3);
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
static bool pending_atlas, held;
static unsigned loading_turns;
static float look_drag[2];
static const PlaceAsset *find_place(const char *id) {
  for (unsigned i = 0; i < sizeof places / sizeof *places; i++)
    if (!strcmp(id, places[i].id))
      return &places[i];
  return NULL;
}
// The places whose pack is on the SD card.
static void list_installed(void) {
  interface.installed[0] = 0;
  for (unsigned i = 0; i < sizeof places / sizeof *places; i++) {
    char path[192];
    struct stat st;
    if (assets_path(places[i].sha, path, sizeof path) && !stat(path, &st) &&
        (unsigned long)st.st_size == places[i].bytes)
      interface_append(interface.installed, sizeof interface.installed,
                       places[i].id);
  }
}
static void report_status(void) {
  static const char *const scenes[] = {"atlas", "loading", "place", "error"};
  char detail[3072], response[4096], escaped[512], guest[320];
  float cost[4];
  control_escape(escaped, sizeof escaped, app_error);
  control_escape(guest, sizeof guest, guest_error());
  unsigned long turns = guest_cost(cost);
  // Preserve the scene's flat telemetry for existing profiling tools.
  if (in_place) {
    scene_status(detail, sizeof detail);
    size_t n = strlen(detail);
    if (n && detail[n - 1] == '}')
      detail[n - 1] = 0;
    snprintf(response, sizeof response,
             "%s,\"place\":\"%s\",\"scene\":\"%s\",\"interface\":%s,"
             "\"interfaceMs\":[%.2f,%.2f,%.2f,%.2f],\"interfaceTurns\":%lu,"
             "\"heapUsed\":%lu,\"heapSize\":%lu,\"held\":%s,\"targetFps\":%u,"
             "\"antialias\":%s,\"error\":\"%s\",\"interfaceError\":\"%s\","
             "\"packSha256\":\"%s\"}",
             detail, current_place, scenes[interface.scene & 3],
             guest_shown() ? "true" : "false", cost[0], cost[1], cost[2], cost[3],
             turns, (unsigned long)mallinfo().uordblks, (unsigned long)__ctru_heap_size,
             held ? "true" : "false", settings_fps(),
             settings_antialias() ? "true" : "false", escaped, guest,
             loaded && find_place(current_place) ? find_place(current_place)->sha : "");
  } else {
    snprintf(response, sizeof response,
             "{\"t\":\"atlas.status\",\"build\":\"" ATLAS_BUILD_ID
             "\",\"phase\":\"%s\",\"scene\":\"%s\",\"frame\":%lu,\"place\":null,"
             "\"frameMs\":%.3f,\"cpuMs\":%.3f,\"gpuMs\":%.3f,\"linearFree\":%lu,"
             "\"vramFree\":%lu,\"interfaceMs\":[%.2f,%.2f,%.2f,%.2f],"
             "\"interfaceTurns\":%lu,\"heapUsed\":%lu,\"heapSize\":%lu,"
             "\"installed\":[%s],\"error\":\"%s\",\"interfaceError\":\"%s\"}",
             atlas_stage, scenes[interface.scene & 3], (unsigned long)atlas.frame,
             atlas.frame_ms, atlas.cpu_ms, atlas.gpu_ms,
             (unsigned long)linearSpaceFree(), (unsigned long)vramSpaceFree(),
             cost[0], cost[1], cost[2], cost[3], turns,
             (unsigned long)mallinfo().uordblks, (unsigned long)__ctru_heap_size,
             interface.installed, escaped, guest);
  }
  devserver_send_ctrl(response, strlen(response));
}
// A control message can press the interface's buttons and hold the stylus on
// the touch screen: "press":"down,a" and "touch":[x,y] (or false).
static void drive(const char *json) {
  static const struct {
    const char *name;
    uint32_t button;
  } buttons[] = {{"select", 0x1},  {"start", 0x8},    {"up", 0x10},
                 {"right", 0x20},  {"down", 0x40},    {"left", 0x80},
                 {"l", 0x100},     {"r", 0x200},      {"x", 0x1000},
                 {"a", 0x2000},    {"b", 0x4000},     {"y", 0x8000}};
  char press[160];
  if (control_string(json, "press", press, sizeof press)) {
    char *save = NULL;
    for (char *name = strtok_r(press, ",", &save); name;
         name = strtok_r(NULL, ",", &save))
      for (unsigned i = 0; i < sizeof buttons / sizeof *buttons; i++)
        if (!strcmp(name, buttons[i].name))
          guest_press(buttons[i].button);
  }
  const char *touch = control_field(json, "touch");
  int x, y;
  if (touch)
    guest_touch(sscanf(touch, " [%d ,%d", &x, &y) == 2, x, y);
  bool shown;
  if (control_bool(json, "interface", &shown))
    guest_show(shown);
}
static void controls(const char *json) {
  bool home = false;
  if (control_bool(json, "atlas", &home) && home)
    pending_atlas = true;
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
  drive(json);
  if (in_place) {
    settings_control(json);
    scene_control(json);
  }
}
static void release_view(void) {
  atlas_gpu_park();
  if (in_place)
    scene_free();
  else
    globe_free();
  loaded = false;
  held = false;
}
static bool open_atlas(void) {
  in_place = false;
  current_place[0] = 0;
  atlas_stage = "loading";
  char error[256] = "";
  loaded = globe_load("romfs:/globe.3ds", error, sizeof error);
  atlas_stage = loaded ? "atlas" : "load-error";
  C3D_FrameRate(30);
  list_installed();
  interface.place[0] = interface.shots[0] = interface.options[0] = 0;
  interface.stats[0] = 0;
  // A place that would not open is said so until the visitor leaves it.
  if (app_error[0]) {
    interface.scene = SCENE_ERROR;
    snprintf(interface.message, sizeof interface.message, "%.159s", app_error);
  } else if (!loaded) {
    interface.scene = SCENE_ERROR;
    snprintf(interface.message, sizeof interface.message, "%.159s", error);
  } else
    interface.scene = SCENE_ATLAS;
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
        interface.scene = SCENE_PLACE;
        snprintf(interface.place, sizeof interface.place, "%.63s", current_place);
        interface.paused = false;
        interface.shots[0] = 0;
        for (unsigned i = 0; i < scene_shot_count(); i++)
          interface_append(interface.shots, sizeof interface.shots,
                           scene_shot_name(i));
      } else
        scene_free();
    } else
      snprintf(app_error, sizeof app_error,
               "Assets missing. Install the SD bundle or run atlas-3ds sync.");
    pending_place[0] = 0;
  }
  if (!loaded)
    open_atlas();
  pending_atlas = false;
}
// What the interface asked for.
static void obey(const Command *c) {
  switch (c->type) {
  case COMMAND_GLOBE:
    globe_place(c->x, c->y, c->r);
    globe_turn(c->lat, c->lon, c->pin);
    break;
  case COMMAND_PINS: globe_pins(c->text); break;
  case COMMAND_SPIN: globe_spin(-c->dx * 0.5f, c->dy * 0.5f); break;
  case COMMAND_ENTER:
    if (find_place(c->text)) {
      snprintf(pending_place, sizeof pending_place, "%.79s", c->text);
      snprintf(interface.place, sizeof interface.place, "%.63s", c->text);
      interface.scene = SCENE_LOADING;
      interface.message[0] = 0;
      loading_turns = 0;
    }
    break;
  case COMMAND_LEAVE:
    if (in_place)
      pending_atlas = true;
    else {
      app_error[0] = 0;
      interface.scene = loaded ? SCENE_ATLAS : SCENE_ERROR;
    }
    break;
  case COMMAND_SHOT: scene_select_shot(c->index); break;
  case COMMAND_TOUR: scene_tour(c->on); break;
  case COMMAND_PAUSE: {
    // The place's clock and its camera stand still together.
    char json[80];
    snprintf(json, sizeof json, "{\"cameraHold\":%s,\"time\":%.3f}",
             c->on ? "true" : "false", c->on ? atlas.time : -1.0f);
    scene_control(json);
    interface.paused = c->on;
    break;
  }
  case COMMAND_OPTION: settings_set(c->text, c->value); break;
  case COMMAND_LOOK: look_drag[0] += c->dx, look_drag[1] += c->dy; break;
  case COMMAND_HOLD: held = c->on; break;
  case COMMAND_PREFS: {
    snprintf(interface.prefs, sizeof interface.prefs, "%.*s", (int)sizeof interface.prefs - 1, c->text);
    FILE *f = fopen("sdmc:/pocket-atlas/interface.json", "w");
    if (f) {
      fputs(c->text, f);
      fclose(f);
    }
    break;
  }
  default: break;
  }
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
  if (!ok)
    snprintf(app_error, sizeof app_error, "%s", error);
  open_atlas();
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
  if (gpu_ok) {
    bottom_target = C3D_RenderTargetCreate(240, 320, GPU_RB_RGBA8, -1);
    if (bottom_target)
      C3D_RenderTargetSetOutput(bottom_target, GFX_BOTTOM, GFX_LEFT, transfer);
  }
  if (!gpu_ok || !top || !bottom_target) {
    snprintf(app_error, sizeof app_error, "PICA initialization failed");
    gpu_ok = false;
  } else if (R_FAILED(romfs))
    snprintf(app_error, sizeof app_error, "romfsInit failed: %08lx",
             (unsigned long)romfs);
  else {
    // The interface, then what it kept from last time (the saved places).
    if (!guest_boot(error, sizeof error))
      atlas_diagnostic(error);
    FILE *kept = fopen("sdmc:/pocket-atlas/interface.json", "r");
    if (kept) {
      interface.prefs[fread(interface.prefs, 1, sizeof interface.prefs - 1, kept)] = 0;
      fclose(kept);
    }
    open_atlas();
  }
  if (!loaded) {
    atlas_stage = "load-error";
    atlas_diagnostic(app_error);
  }
  devserver_set_runtime(&state, NULL, atlas_stage, 0);
  u64 last = svcGetSystemTick(), next_retry = 0;
  unsigned published = 0;
  bool shot = false, capture_pending = false;
  while (aptMainLoop()) {
    hidScanInput();
    uint32_t keys = hidKeysHeld();
    if ((keys & (KEY_L | KEY_R | KEY_START)) == (KEY_L | KEY_R | KEY_START))
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
    if (native_receiving() || gpu_stalled || !gpu_ok) {
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
    // The interface's turn: it is shown where things stand and says what
    // the visitor asked for.
    if (in_place && loaded) {
      interface.shot = atlas.shot;
      interface.tour = atlas.cinematic;
      if (published++ % 15 == 0) {
        settings_list();
        if (settings_stats())
          snprintf(interface.stats, sizeof interface.stats,
                   "%.0f fps · %luk triangles", 1000.0f / fmaxf(atlas.frame_ms, 1),
                   (unsigned long)(atlas.triangles + atlas.reflect_triangles) / 1000);
        else
          interface.stats[0] = 0;
      }
    }
    guest_turn(dt);
    for (Command c; interface_next(&c);)
      obey(&c);
    // A place is read once the interface has had two turns to say so.
    bool entering = pending_place[0] && (interface.scene != SCENE_LOADING || ++loading_turns > 4);
    // The Circle Pad walks (or spins the globe); the d-pad, the C-stick and
    // a stylus on the interface's pad look: unless a menu has the pad.
    circlePosition pad = {0, 0};
    int right = 0x8080;
    if (!held) {
      hidCircleRead(&pad);
      right = input_right_analog();
    }
    float move[2], look[2], cstick[2];
    atlas_stick(pad.dx, pad.dy, &move[0], &move[1]);
    atlas_stick(((right >> 8) - 128) * 156 / 127, (128 - (right & 255)) * 156 / 127, &cstick[0], &cstick[1]);
    look[0] = cstick[0] + (held ? 0 : ((keys & KEY_DRIGHT) ? 1 : 0) - ((keys & KEY_DLEFT) ? 1 : 0));
    look[1] = cstick[1] + (held ? 0 : ((keys & KEY_DUP) ? 1 : 0) - ((keys & KEY_DDOWN) ? 1 : 0));
    if (loaded && in_place) {
      scene_update(dt, move, look, look_drag);
      atlas.update_ms =
          (svcGetSystemTick() - update_start) * 1000.0f / SYSCLOCK_ARM11;
      scene_prepare();
    } else if (loaded) {
      if (move[0] || move[1])
        globe_spin(move[0] * 60 * dt, move[1] * 60 * dt);
      float lat, lon;
      if (globe_update(dt, &lat, &lon))
        interface.lat = lat, interface.lon = lon;
    }
    look_drag[0] = look_drag[1] = 0;
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
    bool changing = asset_request[0] || pending_atlas || entering;
    bool maintenance = changing ||
                       (in_place && settings_antialias()) != antialias;
    // FrameBegin above retired the GPU. End this empty frame before freeing
    // targets: citro3d explicitly forbids deletion while inside a frame.
    if (maintenance)
      C3D_FrameEnd(GX_CMDLIST_FLUSH);
    if (asset_request[0])
      fetch_asset();
    else if (pending_atlas || entering)
      change_view();
    bool desired_aa = in_place && settings_antialias();
    if (desired_aa != antialias) {
      C3D_RenderTarget *replacement = make_top(desired_aa);
      if (replacement) {
        C3D_RenderTargetDelete(top);
        top = replacement;
        antialias = desired_aa;
      } else
        settings_set("smoothing", 0); // not enough video memory for it
    }
    if (changing) {
      last = svcGetSystemTick();
      dt = 1.0f / 30;
      if (in_place)
        scene_prepare();
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
    guest_prepare();
    if (loaded && in_place)
      scene_render(top);
    else
      globe_render(top);
    guest_draw_top(antialias ? 2 : 1);
    guest_draw_bottom(bottom_target);
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
  }
  // Retire captures and leave the frame before deleting render targets.
  if (gpu_ok && !gpu_stalled && !atlas_gpu_idle(4000, !capture_pending))
    gpu_stalled = true;
  if (gpu_ok && !gpu_stalled) {
    release_view();
    if (top)
      C3D_RenderTargetDelete(top);
    if (bottom_target)
      C3D_RenderTargetDelete(bottom_target);
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
