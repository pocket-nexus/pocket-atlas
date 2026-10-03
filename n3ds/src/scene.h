#ifndef ATLAS_SCENE_H
#define ATLAS_SCENE_H
#include "format.h"
#include <3ds.h>
#include <citro3d.h>
typedef struct {
  uint32_t frame, draws, triangles, reflect_draws, reflect_triangles, culled,
      step, lod_floor;
  float cpu_ms, gpu_ms, frame_ms, time, skin_ms, update_ms, submit_ms,
      prepare_ms;
  uint32_t skinned_vertices;
  uint32_t geom_bytes, texture_bytes, animation_bytes;
  bool hold, reflection, rain, haze, cinematic;
  int shot;
  float position[3], target[3], fov;
} AtlasStats;
enum {
  SCENE_RAIN = 1,
  SCENE_HAZE = 2,
  SCENE_REFLECTION = 4,
  SCENE_GLOW = 8,
  SCENE_SKY = 16,
  SCENE_WATER = 32,
  SCENE_UV_ANIMATION = 64,
  SCENE_MOTION = 128
};
typedef struct {
  bool reflection, rain, haze, glow, cinematic, hud, hold, muted;
  unsigned step,
      lod_floor;  // lod_floor: 0..2 fixed, 3 automatic by asset features
  float exposure; // display exposure adjustment in EV, -2..2
} AtlasSettings;
extern AtlasStats atlas;
unsigned scene_features(void);
unsigned scene_shot_count(void);
const char *scene_shot_name(unsigned index);
void scene_select_shot(unsigned index);
void scene_settings_get(AtlasSettings *settings);
void scene_settings_set(const AtlasSettings *settings);
void scene_settings_reset(void);
void scene_hud_reset(void);
void scene_input_block(bool blocked);
void scene_frame_budget(float milliseconds);
void atlas_diagnostic(const char *message);
bool scene_load(const char *path, char *error, size_t capacity);
void scene_update(float dt, uint32_t down, uint32_t held);
void scene_prepare(void);
void scene_measure(void);
void scene_render(C3D_RenderTarget *target);
C3D_RenderTarget *scene_reflection_target(void);
void scene_control(const char *json);
void scene_status(char *out, size_t capacity);
void scene_hud(void);
void scene_free(void);
#endif
