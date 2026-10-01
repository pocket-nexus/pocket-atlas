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
extern AtlasStats atlas;
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
