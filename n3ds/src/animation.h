#ifndef ATLAS_ANIMATION_H
#define ATLAS_ANIMATION_H
#include "format.h"
#include <math.h>
#include <string.h>

// Validate the actual byte ranges before any CPU or GPU animation access.
static inline bool atlas_animation_valid(const void *bytes, size_t size,
                                         uint32_t matrices, uint32_t frames) {
  uint64_t table = (uint64_t)matrices * sizeof(AtlasAnimation);
  if (!frames || table > size) return false;
  const AtlasAnimation *tracks = bytes;
  for (unsigned i = 0; i < matrices; ++i) {
    const AtlasAnimation *t = tracks + i;
    size_t stride = t->kind == 1 ? sizeof(AtlasTrs) : 48;
    if (t->kind > 1 || (t->count != 1 && t->count != frames) ||
        t->offset % 4 || t->offset < table ||
        (uint64_t)t->offset + (uint64_t)t->count * stride > size)
      return false;
    for (unsigned j = 0; j < t->count; ++j) {
      const float *f = (const float *)((const uint8_t *)bytes + t->offset + j * stride);
      for (unsigned k = 0; k < (t->kind ? 6u : 12u); ++k)
        if (!isfinite(f[k])) return false;
      if (t->kind) {
        const AtlasTrs *v = (const AtlasTrs *)f;
        if (!(v->rotation[0] || v->rotation[1] || v->rotation[2] || v->rotation[3]))
          return false;
      }
    }
  }
  return true;
}

static inline void atlas_animation_sample(const void *bytes, unsigned index,
                                           unsigned a, unsigned b, float k,
                                           float out[12]) {
  const AtlasAnimation *t = (const AtlasAnimation *)bytes + index;
  if (t->count == 1) a = b = 0;
  const uint8_t *data = (const uint8_t *)bytes + t->offset;
  if (!t->kind) {
    const float *x = (const float *)(data + a * 48),
                *y = (const float *)(data + b * 48);
    for (unsigned i = 0; i < 12; ++i) out[i] = x[i] + (y[i] - x[i]) * k;
    return;
  }
  const AtlasTrs *x = (const AtlasTrs *)data + a, *y = (const AtlasTrs *)data + b;
  float q[4], scale[3], dot = 0, length = 0;
  for (unsigned i = 0; i < 4; ++i)
    dot += (float)x->rotation[i] * (float)y->rotation[i];
  // Unit quaternions interpolate the shortest arc without shrinking a rigid
  // object. q and -q represent the same rotation, including the loop boundary.
  float sign = dot < 0 ? -1 : 1;
  for (unsigned i = 0; i < 4; ++i) {
    q[i] = (float)x->rotation[i] * (1 - k) + (float)y->rotation[i] * (k * sign);
    length += q[i] * q[i];
  }
  float norm = 1 / sqrtf(length);
  for (unsigned i = 0; i < 4; ++i) q[i] *= norm;
  for (unsigned i = 0; i < 3; ++i) {
    out[i * 4 + 3] = x->translation[i] + (y->translation[i] - x->translation[i]) * k;
    scale[i] = x->scale[i] + (y->scale[i] - x->scale[i]) * k;
  }
  float xx=q[0]*q[0], yy=q[1]*q[1], zz=q[2]*q[2],
        xy=q[0]*q[1], xz=q[0]*q[2], yz=q[1]*q[2],
        wx=q[3]*q[0], wy=q[3]*q[1], wz=q[3]*q[2];
  out[0]=(1-2*(yy+zz))*scale[0]; out[1]=2*(xy-wz)*scale[1]; out[2]=2*(xz+wy)*scale[2];
  out[4]=2*(xy+wz)*scale[0]; out[5]=(1-2*(xx+zz))*scale[1]; out[6]=2*(yz-wx)*scale[2];
  out[8]=2*(xz-wy)*scale[0]; out[9]=2*(yz+wx)*scale[1]; out[10]=(1-2*(xx+yy))*scale[2];
}
#endif
