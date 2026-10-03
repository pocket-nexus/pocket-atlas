#ifndef ATLAS_FRUSTUM_H
#define ATLAS_FRUSTUM_H
#include <stdbool.h>
#include <float.h>
#include <math.h>

// Planes face into the view; center and nonnegative half extents are in world
// space. A box's support radius along a plane is abs(normal) dot half. Unlike
// a sphere around a long chunk, it does not pull invisible lateral geometry
// into the view. The caller also uses this box for conservative skin bounds.
static inline bool atlas_aabb_visible(const float planes[6][4],
                                      const float center[3],
                                      const float half[3]) {
  for (unsigned p = 0; p < 6; ++p) {
    float x = planes[p][0] * center[0], y = planes[p][1] * center[1],
          z = planes[p][2] * center[2];
    float radius = fabsf(planes[p][0]) * half[0] +
                   fabsf(planes[p][1]) * half[1] +
                   fabsf(planes[p][2]) * half[2];
    float distance = x + y + z + planes[p][3];
    // Roundoff must not remove geometry touching a clip plane, including the
    // near plane or a large world-space translation. This only widens bounds.
    float roundoff = 8 * FLT_EPSILON *
        (fabsf(x) + fabsf(y) + fabsf(z) + fabsf(planes[p][3]) + radius);
    if (distance + radius < -roundoff) return false;
  }
  return true;
}
#endif
