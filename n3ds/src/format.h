#ifndef ATLAS_FORMAT_H
#define ATLAS_FORMAT_H
#include <stddef.h>
#include <stdint.h>
// PLCE v5, PICA section v3. All integers and IEEE floats are little endian.
// Cooker: crates/pocket3d-place-cook/src/pica.rs. GPU records contain no
// pointers.
typedef struct {
  uint32_t version, textures, materials, draws, shots, matrices, frames, lights,
      dry_boxes, skin_bytes;
  float fps, fog_density, haze_density, rain, fog[3], bloom, zenith[3],
      vignette, horizon[3], reserved;
  uint32_t features, sky_texture, cloud_texture;
  float cloud_drift;
} AtlasHeader;
typedef struct {
  uint32_t width, height, format, levels, offset, bytes, wrap_s, wrap_t;
} AtlasTexture;
typedef struct {
  uint32_t texture, flags;
  float alpha, wet, roughness, cutout;
  uint32_t cols, rows, frames;
  float fps, scroll[2], phase;
  uint32_t track;
  float waves[6], wave_scale, wave_mask, distance_roughness;
} AtlasMaterial;
typedef struct {
  uint32_t offset, count;
  float error;
} AtlasLod;
typedef struct {
  uint32_t material, vertices, count, skin, node, root, no_reflect, reserved;
  float center[3], radius;
  AtlasLod lod[4];
} AtlasDraw;
typedef struct {
  char name[32];
  float from[7], to[7], duration;
} AtlasShot;
typedef struct {
  float position[3], radius, color[3], intensity;
} AtlasLight;
typedef struct {
  float min[3], max[3];
} AtlasBox;
typedef struct {
  float position[3], uv[2];
  uint8_t color[4];
} AtlasVertex;
typedef struct {
  uint16_t joint[4];
  uint8_t weight[4];
} AtlasSkin;
_Static_assert(sizeof(AtlasHeader) == 120, "PICA header");
_Static_assert(sizeof(AtlasMaterial) == 92, "PICA material");
_Static_assert(sizeof(AtlasDraw) == 96, "PICA draw");
_Static_assert(sizeof(AtlasShot) == 92, "PICA shot");
_Static_assert(sizeof(AtlasVertex) == 24, "PICA vertex");
_Static_assert(sizeof(AtlasSkin) == 12, "PICA skin");
enum {
  MAT_BLEND = 1,
  MAT_TWO_SIDED = 2,
  MAT_WET = 4,
  MAT_CUTOUT = 8,
  MAT_FOG = 16,
  MAT_GLASS = 32,
  MAT_ADD = 64,
  MAT_DEPTH = 128,
  MAT_WATER = 256
};
#endif
