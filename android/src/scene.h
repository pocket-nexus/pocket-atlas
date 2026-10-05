#ifndef ATLAS_ANDROID_SCENE_H
#define ATLAS_ANDROID_SCENE_H
#include <stdbool.h>
#include <stddef.h>
// One place on the calling thread's GLES 3 context, drawn into the bound
// framebuffer at the size scene_size() was last given.
typedef struct {
  bool reflection, rain, glow, cinematic, paused;
  unsigned shot, features, draws, triangles, mirror_triangles, sprites;
  float time, position[3], target[3], fov, lod;
  // What a `skip` command leaves out or swaps, to find where a frame's time
  // goes: a sum of 1 rigs, 4 what is blended, 8 cutouts, 16 opaque surfaces,
  // 32 the sky, 64 the mirror's own draws; 128 draws each shaded fragment as a
  // sixteenth of white instead, to count them; 256 gives every surface one
  // white texel for its texture; 512 keeps the table's order in a group;
  // 2048 takes the tint out of the shade, 4096 and 8192 light or shade every
  // sunlit surface, 16384 draws them without the shadow fetch; 32768 draws
  // cutouts in one stage.
  unsigned skip;
} AtlasScene;
extern AtlasScene atlas;
// The CPU's part of a frame by phase, smoothed, in milliseconds: choosing what
// is seen, rewriting index buffers, then submitting the mirror, the surfaces
// and the sky, what is blended, and the glows and rain.
enum { PHASE_CULL, PHASE_GATHER, PHASE_MIRROR, PHASE_SURFACES, PHASE_BLENDED, PHASE_EFFECTS, SCENE_PHASES };
extern float scene_phase[SCENE_PHASES];
// The pack is `size` bytes at `offset` of the open file `fd` (an asset of the
// APK, stored, or a file pushed beside it); the scene maps it and closes `fd`.
bool scene_load(int fd, long long offset, size_t size, const char *name, char *error, size_t capacity);
// The drawable in pixels: the window's buffer.
void scene_size(unsigned width, unsigned height);
void scene_free(void);
unsigned scene_shot_count(void);
const char *scene_shot_name(unsigned shot);
void scene_shot(unsigned shot, bool midpoint);
// look: radians to the right and up; move: -1..1 to the right and forward.
void scene_update(float dt, const float look[2], const float move[2]);
// Culls, picks levels of detail and gathers indices, then draws.
void scene_prepare(void);
void scene_render(unsigned drawable);
void scene_control(const char *json);
#endif
