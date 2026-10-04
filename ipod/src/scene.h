#ifndef ATLAS_IPOD_SCENE_H
#define ATLAS_IPOD_SCENE_H
#include <stdbool.h>
#include <stddef.h>
// One place on the calling thread's GLES 2 context. The drawable is the
// 320x480 portrait screen; the scene is drawn a quarter turn round, for a
// device held with its home button on the right.
typedef struct {
  bool reflection, rain, glow, cinematic, paused;
  unsigned shot, features, draws, triangles, mirror_triangles, sprites;
  float time, position[3], target[3], fov, lod;
} AtlasScene;
extern AtlasScene atlas;
bool scene_load(const char *path, char *error, size_t capacity);
void scene_free(void);
unsigned scene_shot_count(void);
const char *scene_shot_name(unsigned shot);
void scene_shot(unsigned shot, bool midpoint);
// look: radians to the right and up; move: -1..1 to the right and forward.
void scene_update(float dt, const float look[2], const float move[2]);
// Culls, picks levels of detail, skins and gathers indices (no GL), then draws.
void scene_prepare(void);
void scene_render(unsigned drawable);
void scene_control(const char *json);
#endif
