#include "settings.h"
#include "browser.h"
#include "control.h"
#include "scene.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
static AtlasSettings prefs;
static unsigned fps = 30, row;
static bool opened, antialias, dirty = true;
static const char *file = "sdmc:/pocket-atlas/settings.json";
static const char *labels[] = {"Frame rate",   "Quality",      "Reflections",
                               "Rain",         "Lit haze",     "Glow",
                               "Exposure",     "Camera",       "Performance",
                               "4x antialias", "Sound",        "Back to atlas"};
static void save(void) {
  FILE *f = fopen("sdmc:/pocket-atlas/settings.json.tmp", "w");
  if (!f)
    return;
  fprintf(
      f,
      "{\"antialias\":%s,\"fps\":%u,\"step\":%u,\"hold\":%s,\"reflection\":%s,"
      "\"rain\":%s,\"haze\":%s,\"glow\":%s,\"exposure\":%.2f,\"hud\":%s,\"muted\":%s}\n",
      antialias ? "true" : "false", fps, prefs.step,
      prefs.hold ? "true" : "false", prefs.reflection ? "true" : "false",
      prefs.rain ? "true" : "false", prefs.haze ? "true" : "false",
      prefs.glow ? "true" : "false", prefs.exposure,
      prefs.hud ? "true" : "false", prefs.muted ? "true" : "false");
  bool failed = ferror(f) != 0;
  if (fclose(f) || failed)
    return;
  const char *backup = "sdmc:/pocket-atlas/settings.json.bak";
  struct stat previous;
  bool had_file = stat(file, &previous) == 0;
  if (had_file) {
    remove(backup);
    if (rename(file, backup)) {
      remove("sdmc:/pocket-atlas/settings.json.tmp");
      return;
    }
  }
  if (rename("sdmc:/pocket-atlas/settings.json.tmp", file)) {
    if (had_file)
      rename(backup, file);
  } else
    remove(backup);
}
static void read_prefs(const char *s) {
  control_bool(s, "antialias", &antialias);
  unsigned f = control_uint(s, "fps", fps);
  if (f == 20 || f == 30 || f == 60)
    fps = f;
  prefs.step = control_uint(s, "step", prefs.step) % 5;
  control_bool(s, "hold", &prefs.hold);
  control_bool(s, "reflection", &prefs.reflection);
  control_bool(s, "rain", &prefs.rain);
  control_bool(s, "haze", &prefs.haze);
  control_bool(s, "glow", &prefs.glow);
  control_bool(s, "hud", &prefs.hud);
  control_bool(s, "muted", &prefs.muted);
  const char *p = control_field(s, "exposure");
  if (p) {
    float v = strtof(p, NULL);
    if (isfinite(v))
      prefs.exposure = fminf(2, fmaxf(-2, v));
  }
}
void settings_init(void) {
  scene_settings_reset();
  scene_settings_get(&prefs);
  FILE *f = fopen(file, "r");
  if (!f)
    f = fopen("sdmc:/pocket-atlas/settings.json.bak", "r");
  if (f) {
    char s[1024];
    size_t n = fread(s, 1, sizeof s - 1, f);
    s[n] = 0;
    fclose(f);
    read_prefs(s);
  }
}
void settings_apply(void) {
  AtlasSettings active = prefs;
  if (!prefs.hold)
    active.step = atlas.step;
  if (opened)
    active.hold = true;
  scene_settings_set(&active);
  C3D_FrameRate(fps);
  scene_frame_budget(1000.0f / fps);
  dirty = true;
}
bool settings_antialias(void) { return antialias; }
unsigned settings_fps(void) { return fps; }
bool settings_open(void) { return opened; }
void settings_close(void) {
  opened = false;
  prefs.cinematic = atlas.cinematic;
  settings_apply();
  scene_hud_reset();
}
void settings_control(const char *json) {
  if (control_field(json, "sheetRow"))
    dirty = true;
  bool reset = false;
  bool next_open = opened;
  if (control_bool(json, "sheet", &next_open)) {
    if (next_open && !opened)
      scene_settings_get(&prefs);
    opened = next_open;
    prefs.cinematic = atlas.cinematic;
    settings_apply();
    scene_hud_reset();
  }
  if (control_bool(json, "sheetReset", &reset) && reset) {
    scene_settings_reset();
    scene_settings_get(&prefs);
    fps = 30;
    antialias = false;
    settings_apply();
    save();
  }
  char name[64];
  if (control_string(json, "sheetRow", name, sizeof name))
    for (unsigned i = 0; i < sizeof labels / sizeof *labels; i++)
      if (!strcmp(labels[i], name))
        row = i;
  if (control_field(json, "settings")) {
    if (!opened)
      scene_settings_get(&prefs);
    read_prefs(json);
    settings_apply();
    save();
  }
}
bool settings_update(uint32_t down) {
  if (down)
    dirty = true;
  if (down & KEY_SELECT) {
    if (!opened)
      scene_settings_get(&prefs);
    opened = !opened;
    prefs.cinematic = atlas.cinematic;
    settings_apply();
    scene_hud_reset();
    return false;
  }
  if (!opened)
    return false;
  if (down & KEY_B) {
    settings_close();
    return false;
  }
  if (down & KEY_X) {
    scene_settings_reset();
    scene_settings_get(&prefs);
    fps = 30;
    antialias = false;
    settings_apply();
    save();
  }
  const unsigned count = sizeof labels / sizeof *labels;
  if (down & KEY_DUP)
    row = (row + count - 1) % count;
  if (down & KEY_DDOWN)
    row = (row + 1) % count;
  if (!(down & (KEY_A | KEY_DLEFT | KEY_DRIGHT)))
    return false;
  prefs.cinematic = atlas.cinematic;
  int direction = down & KEY_DLEFT ? -1 : 1;
  switch (row) {
  case 0:
    fps = direction > 0 ? (fps == 20   ? 30
                           : fps == 30 ? 60
                                       : 20)
                        : (fps == 20   ? 60
                           : fps == 60 ? 30
                                       : 20);
    break;
  case 1: {
    int q = prefs.hold ? (int)prefs.step : -1;
    q = (q + 1 + direction + 6) % 6 - 1;
    prefs.hold = q >= 0;
    if (q >= 0)
      prefs.step = q;
    break;
  }
  case 2:
    prefs.reflection = !prefs.reflection;
    break;
  case 3:
    prefs.rain = !prefs.rain;
    break;
  case 4:
    prefs.haze = !prefs.haze;
    break;
  case 5:
    prefs.glow = !prefs.glow;
    break;
  case 6:
    prefs.exposure = fminf(2, fmaxf(-2, prefs.exposure + direction * .25f));
    break;
  case 7: {
    unsigned n = scene_shot_count();
    if (n)
      scene_select_shot((atlas.shot + n + direction) % n);
    prefs.cinematic = true;
    break;
  }
  case 8:
    prefs.hud = !prefs.hud;
    break;
  case 9:
    antialias = !antialias;
    break;
  case 10:
    prefs.muted = !prefs.muted;
    break;
  case 11:
    settings_close();
    return true;
  }
  settings_apply();
  save();
  return false;
}
void settings_draw(void) {
  static int drawn_shot = -1;
  if (!dirty && drawn_shot == atlas.shot)
    return;
  dirty = false;
  drawn_shot = atlas.shot;
  browser_ui_clear(0x0c1522);
  browser_ui_text(12, 8, "SETTINGS", 0x66dfc7);
  browser_ui_text(12, 25, "A / left / right: change    X: reset", 0x91a6bc);
  unsigned features = scene_features();
  for (unsigned i = 0; i < sizeof labels / sizeof *labels; i++) {
    int y = 40 + i * 15;
    if (row == i)
      browser_ui_rect(7, y - 1, 306, 16, 0x254154);
    char v[72] = "";
    switch (i) {
    case 0:
      snprintf(v, sizeof v, "%u fps target", fps);
      break;
    case 1:
      snprintf(v, sizeof v, "%s %u / 5", prefs.hold ? "Fixed" : "Auto",
               (unsigned)atlas.step + 1);
      break;
    case 2:
    case 3:
    case 4:
    case 5: {
      unsigned flags[] = {SCENE_REFLECTION, SCENE_RAIN, SCENE_HAZE, SCENE_GLOW};
      bool on[] = {prefs.reflection, prefs.rain, prefs.haze, prefs.glow};
      snprintf(v, sizeof v, "%s",
               !(features & flags[i - 2]) ? "Not in this scene"
               : on[i - 2]                ? "On"
                                          : "Off");
      break;
    }
    case 6:
      snprintf(v, sizeof v, "%+.2f EV", prefs.exposure);
      break;
    case 7:
      snprintf(v, sizeof v, "%s",
               atlas.cinematic ? scene_shot_name(atlas.shot) : "Free camera");
      break;
    case 8:
      snprintf(v, sizeof v, "%s", prefs.hud ? "On" : "Off");
      break;
    case 9:
      snprintf(v, sizeof v, "%s", antialias ? "800 x 480" : "400 x 240");
      break;
    case 10:
      snprintf(v, sizeof v, "%s", prefs.muted ? "Muted" : "On");
      break;
    }
    browser_ui_text(13, y, labels[i], 0xf0f4f8);
    browser_ui_text(141, y, v, 0xadc5d5);
  }
  browser_ui_text(12, 224, "B / SELECT: close    START: atlas", 0x91a6bc);
}
