#include "visibility.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>

static uint32_t seed = 731;
static float sample(void) {
  seed = seed * 1664525u + 1013904223u;
  return ((int)(seed >> 24) - 128) * 0.25f;
}
int main(void) {
  const float plane[4] = {1, 0, 0, 0};
  const float center[3] = {-2, 0, 0}, thin[3] = {.1f, 1, 100};
  assert(atlas_box_outside_plane(plane, center, thin));
  // Its 100 m sphere intersects this plane although the whole thin box is out.
  assert(center[0] + 100 > 0);
  const float touching[3] = {2, 1, 100};
  assert(!atlas_box_outside_plane(plane, center, touching));
  // An independent eight-corner oracle checks arbitrary planes, anisotropic
  // extents and translated/reflected boxes. Boundary contact stays visible.
  for (unsigned trial = 0; trial < 10000; trial++) {
    float p[4], c[3], h[3];
    for (unsigned k = 0; k < 4; k++) p[k] = sample();
    for (unsigned k = 0; k < 3; k++) { c[k] = sample(); h[k] = fabsf(sample()); }
    bool all_outside = true;
    for (unsigned corner = 0; corner < 8; corner++) {
      float distance = p[3];
      for (unsigned k = 0; k < 3; k++)
        distance += p[k] * (c[k] + ((corner & (1u << k)) ? h[k] : -h[k]));
      if (distance >= 0) all_outside = false;
    }
    assert(atlas_box_outside_plane(p, c, h) == all_outside);
  }
  puts("visibility: thin bounds, boundary contact and 10000 corner oracles passed");
}
