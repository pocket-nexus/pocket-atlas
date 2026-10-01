#ifndef ATLAS_NAVIGATION_H
#define ATLAS_NAVIGATION_H
#include <math.h>

// Old 3DS center drift can exceed the old per-axis 15-unit threshold.
// A radial deadzone preserves diagonals and ramps gently into camera motion.
static inline void atlas_stick(int x, int y, float *look_x, float *look_y) {
  float length = sqrtf((float)x * x + (float)y * y);
  if (length <= 28) {
    *look_x = *look_y = 0;
    return;
  }
  float t = fminf((length - 28) / 128.0f, 1.0f);
  float response = t * (0.35f + 0.65f * t * t) / length;
  *look_x = x * response;
  *look_y = y * response;
}

static inline void atlas_move(float position[3], float yaw, float x,
                              float forward, float lift, float dt) {
  float length = sqrtf(x * x + forward * forward);
  if (length > 1) {
    x /= length;
    forward /= length;
  }
  position[0] += (sinf(yaw) * forward + cosf(yaw) * x) * dt * 3.0f;
  position[2] += (-cosf(yaw) * forward + sinf(yaw) * x) * dt * 3.0f;
  position[1] = fmaxf(0.3f, position[1] + lift * dt * 1.8f);
}
#endif
