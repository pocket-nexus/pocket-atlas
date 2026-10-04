#ifndef ATLAS_VISIBILITY_H
#define ATLAS_VISIBILITY_H
#include <math.h>
#include <stdbool.h>

/* World AABB support along a frustum plane. Thin street/foliage chunks have
 * loose bounding spheres; their already-computed extents give a tighter,
 * conservative test without removing any intersecting geometry. */
static inline bool atlas_box_outside_plane(const float plane[4],
                                            const float center[3],
                                            const float half[3]) {
  float farthest = plane[3];
  for (unsigned k = 0; k < 3; k++)
    farthest += plane[k] * center[k] + fabsf(plane[k]) * half[k];
  return farthest < 0;
}
#endif
