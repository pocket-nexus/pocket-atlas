#ifndef ATLAS_SKIN_BOUNDS_H
#define ATLAS_SKIN_BOUNDS_H
#include "format.h"
#include <float.h>
#include <math.h>
#include <stdlib.h>

typedef struct {
  uint32_t joint;
  float center[3], half[3];
} AtlasJointBound;

// Every normalized weighted point is in the convex hull of its transformed
// joint points. A union of per-joint bind-space boxes therefore bounds both
// articulated people and independent particles, without an assumed root box.
static inline bool atlas_skin_bounds_build(const AtlasVertex *vertices,
    const AtlasSkin *skin, unsigned count, unsigned matrices,
    AtlasJointBound **out, unsigned *out_count) {
  AtlasJointBound *temp = calloc(matrices, sizeof *temp);
  if (!temp) return false;
  for (unsigned i = 0; i < matrices; ++i)
    for (unsigned k = 0; k < 3; ++k) {
      temp[i].center[k] = FLT_MAX;
      temp[i].half[k] = -FLT_MAX;
    }
  for (unsigned i = 0; i < count; ++i) {
    unsigned sum = 0;
    for (unsigned j = 0; j < 4; ++j) {
      sum += skin[i].weight[j];
      if (!skin[i].weight[j]) continue;
      unsigned id = skin[i].joint[j];
      if (id >= matrices) { free(temp); return false; }
      temp[id].joint = 1;
      for (unsigned k = 0; k < 3; ++k) {
        float p = vertices[i].position[k];
        if (!isfinite(p)) { free(temp); return false; }
        temp[id].center[k] = fminf(temp[id].center[k], p);
        temp[id].half[k] = fmaxf(temp[id].half[k], p);
      }
    }
    if (sum != 255) { free(temp); return false; }
  }
  unsigned n = 0;
  for (unsigned i = 0; i < matrices; ++i) {
    if (!temp[i].joint) continue;
    AtlasJointBound box = {.joint = i};
    for (unsigned k = 0; k < 3; ++k) {
      box.center[k] = (temp[i].center[k] + temp[i].half[k]) * 0.5f;
      box.half[k] = (temp[i].half[k] - temp[i].center[k]) * 0.5f;
    }
    temp[n++] = box;
  }
  if (!n) { free(temp); return false; }
  AtlasJointBound *compact = realloc(temp, n * sizeof *temp);
  *out = compact ? compact : temp;
  *out_count = n;
  return true;
}

static inline float atlas_skin_bounds(const AtlasJointBound *boxes, unsigned count,
    const float *matrices, float center[3], float half[3]) {
  float lo[3] = {FLT_MAX, FLT_MAX, FLT_MAX}, hi[3] = {-FLT_MAX, -FLT_MAX, -FLT_MAX};
  for (unsigned i = 0; i < count; ++i) {
    const AtlasJointBound *box = boxes + i;
    const float *m = matrices + box->joint * 12;
    for (unsigned k = 0; k < 3; ++k) {
      float c = m[k*4+3], e = 0;
      for (unsigned j = 0; j < 3; ++j) {
        c += m[k*4+j] * box->center[j];
        e += fabsf(m[k*4+j]) * box->half[j];
      }
      lo[k] = fminf(lo[k], c-e); hi[k] = fmaxf(hi[k], c+e);
    }
  }
  float radius2 = 0;
  for (unsigned k = 0; k < 3; ++k) {
    center[k] = (lo[k] + hi[k]) * 0.5f;
    half[k] = (hi[k] - lo[k]) * 0.5f;
    radius2 += half[k] * half[k];
  }
  return sqrtf(radius2);
}
#endif
