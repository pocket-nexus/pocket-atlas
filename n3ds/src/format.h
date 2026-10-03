#ifndef ATLAS_FORMAT_H
#define ATLAS_FORMAT_H
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
// PLCE v5, PICA section v4. All integers and IEEE floats are little endian.
// Cooker: crates/pocket3d-place-cook/src/pica.rs. GPU records contain no
// pointers.
#define ATLAS_PICA_CONTAINER_VERSION 5
#define ATLAS_PICA_TABLE_VERSION 4
static inline bool atlas_pack_header_valid(const uint32_t header[4]) {
  return header[0] == 0x45434c50 &&
         header[1] == ATLAS_PICA_CONTAINER_VERSION &&
         (header[2] == 5 || header[2] == 6);
}
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
// AtlasDraw.reserved: local tubes/rings with a shape-preserving middle LOD.
enum { DRAW_STRUCTURAL_DETAIL = 1 };
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
// ANIM begins with one descriptor per logical matrix. Identical descriptors
// may share sample bytes. A constant track has one sample, otherwise frames.
// kind 0: 48-byte row-major affine matrix; kind 1: float translation[3],
// float scale[3], snorm16 quaternion[4] (xyzw). Material tracks follow in ANIM.
typedef struct {
  uint32_t offset, count, kind;
} AtlasAnimation;
typedef struct {
  float translation[3], scale[3];
  int16_t rotation[4];
} AtlasTrs;
_Static_assert(sizeof(AtlasHeader) == 120, "PICA header");
_Static_assert(sizeof(AtlasMaterial) == 92, "PICA material");
_Static_assert(sizeof(AtlasDraw) == 96, "PICA draw");
_Static_assert(sizeof(AtlasShot) == 92, "PICA shot");
_Static_assert(sizeof(AtlasVertex) == 24, "PICA vertex");
_Static_assert(sizeof(AtlasSkin) == 12, "PICA skin");
_Static_assert(sizeof(AtlasAnimation) == 12, "PICA animation descriptor");
_Static_assert(sizeof(AtlasTrs) == 32, "PICA TRS sample");
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
