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
  bool reflection, rain, haze, glow, cinematic, hud, hold;
  unsigned step,
      lod_floor;  // lod_floor: 0..2 fixed, 3 automatic by asset features
  float exposure; // display exposure adjustment in EV, -2..2
} AtlasSettings;
extern AtlasStats atlas;
unsigned scene_features(void);
unsigned scene_shot_count(void);
const char *scene_shot_name(unsigned index);
void scene_select_shot(unsigned index);
// The authored tour, or the camera in the visitor's hands where it stands.
void scene_tour(bool on);
void scene_settings_get(AtlasSettings *settings);
void scene_settings_set(const AtlasSettings *settings);
void scene_settings_reset(void);
void scene_frame_budget(float milliseconds);
void atlas_diagnostic(const char *message);
bool scene_load(const char *path, const char *expected_sha256, char *error, size_t capacity);
// move: -1..1 to the right and forward; look: -1..1 to the right and up
// (a rate); drag: pixels a finger turned the view by since the last call.
void scene_update(float dt, const float move[2], const float look[2],
                  const float drag[2]);
void scene_prepare(void);
void scene_measure(void);
void scene_render(C3D_RenderTarget *target);
C3D_RenderTarget *scene_reflection_target(void);
void scene_control(const char *json);
void scene_status(char *out, size_t capacity);
void scene_free(void);
#endif
