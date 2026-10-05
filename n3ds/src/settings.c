#include "settings.h"
#include "control.h"
#include "interface.h"
#include "scene.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
static AtlasSettings prefs;
static unsigned fps = 30;
static bool antialias;
static const char *file = "sdmc:/pocket-atlas/settings.json";
static const unsigned rates[] = {30, 60, 20};
static const float stops[] = {-1, -.5f, 0, .5f, 1};
static void save(void) {
  FILE *f = fopen("sdmc:/pocket-atlas/settings.json.tmp", "w");
  if (!f)
    return;
  fprintf(
      f,
      "{\"antialias\":%s,\"fps\":%u,\"step\":%u,\"hold\":%s,\"reflection\":%s,"
      "\"rain\":%s,\"haze\":%s,\"glow\":%s,\"exposure\":%.2f,\"hud\":%s}\n",
      antialias ? "true" : "false", fps, prefs.step,
      prefs.hold ? "true" : "false", prefs.reflection ? "true" : "false",
      prefs.rain ? "true" : "false", prefs.haze ? "true" : "false",
      prefs.glow ? "true" : "false", prefs.exposure,
      prefs.hud ? "true" : "false");
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
  prefs.hud = false;
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
  active.cinematic = atlas.cinematic;
  if (!prefs.hold)
    active.step = atlas.step;
  scene_settings_set(&active);
  C3D_FrameRate(fps);
  scene_frame_budget(1000.0f / fps);
}
bool settings_antialias(void) { return antialias; }
unsigned settings_fps(void) { return fps; }
bool settings_stats(void) { return prefs.hud; }
void settings_control(const char *json) {
  bool reset = false;
  if (control_bool(json, "sheetReset", &reset) && reset) {
    scene_settings_reset();
    scene_settings_get(&prefs);
    fps = 30;
    antialias = false;
    settings_apply();
    save();
  }
  if (control_field(json, "settings")) {
    read_prefs(json);
    settings_apply();
    save();
  }
}
void settings_list(void) {
  char *out = interface.options;
  size_t cap = sizeof interface.options, n = 0;
  unsigned features = scene_features(), rate = fps == 60 ? 1 : fps == 20 ? 2 : 0,
           stop = 2;
  for (unsigned i = 0; i < 5; i++)
    if (fabsf(stops[i] - prefs.exposure) < .13f)
      stop = i;
  n += snprintf(out + n, cap - n,
                "{\"key\":\"rate\",\"value\":%u,\"choices\":[\"30 fps\",\"60 "
                "fps\",\"20 fps\"]},{\"key\":\"quality\",\"value\":%u,"
                "\"choices\":[\"Auto · %u of 5\",\"1 of 5\",\"2 of 5\",\"3 of "
                "5\",\"4 of 5\",\"5 of 5\"]},{\"key\":\"smoothing\",\"value\":"
                "%d}",
                rate, prefs.hold ? prefs.step + 1 : 0, (unsigned)atlas.step + 1,
                antialias);
  const struct {
    unsigned feature;
    const char *key;
    bool on;
  } effects[] = {{SCENE_REFLECTION, "reflection", prefs.reflection},
                 {SCENE_RAIN, "rain", prefs.rain},
                 {SCENE_HAZE, "haze", prefs.haze},
                 {SCENE_GLOW, "glow", prefs.glow}};
  for (unsigned i = 0; i < 4; i++)
    if (features & effects[i].feature)
      n += snprintf(out + n, cap - n, ",{\"key\":\"%s\",\"value\":%d}",
                    effects[i].key, effects[i].on);
  snprintf(out + n, cap - n,
           ",{\"key\":\"exposure\",\"value\":%u,\"choices\":[\"−1 EV\",\"−½ "
           "EV\",\"0 EV\",\"+½ EV\",\"+1 EV\"]},{\"key\":\"stats\",\"value\":"
           "%d}",
           stop, prefs.hud);
}
void settings_set(const char *key, unsigned value) {
  bool on = value != 0;
  if (!strcmp(key, "rate"))
    fps = rates[value % 3];
  else if (!strcmp(key, "quality")) {
    prefs.hold = on;
    if (on)
      prefs.step = (value - 1) % 5;
  } else if (!strcmp(key, "smoothing"))
    antialias = on;
  else if (!strcmp(key, "reflection"))
    prefs.reflection = on;
  else if (!strcmp(key, "rain"))
    prefs.rain = on;
  else if (!strcmp(key, "haze"))
    prefs.haze = on;
  else if (!strcmp(key, "glow"))
    prefs.glow = on;
  else if (!strcmp(key, "exposure"))
    prefs.exposure = stops[value % 5];
  else if (!strcmp(key, "stats"))
    prefs.hud = on;
  else
    return;
  settings_apply();
  save();
}
