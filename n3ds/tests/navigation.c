#include "../src/navigation.h"
#include <assert.h>
#include <stdio.h>
static int close_to(float a, float b) { return fabsf(a - b) < 0.0001f; }
int main(void) {
  float x, y;
  atlas_stick(-12, -19, &x, &y);
  assert(x == 0 && y == 0);
  atlas_stick(156, 0, &x, &y);
  assert(close_to(x, 1) && y == 0);
  atlas_stick(0, 156, &x, &y);
  assert(x == 0 && close_to(y, 1));
  atlas_stick(-156, 0, &x, &y);
  assert(close_to(x, -1) && y == 0);
  atlas_stick(120, 120, &x, &y);
  assert(close_to(x, y) && close_to(x * x + y * y, 1));
  float p[3] = {0, 1, 0};
  atlas_move(p, 0, 0, 1, 0, 1);
  assert(close_to(p[0], 0) && close_to(p[2], -3));
  p[0] = p[2] = 0;
  atlas_move(p, acosf(-1) / 2, 0, 1, 0, 1);
  assert(close_to(p[0], 3) && close_to(p[2], 0));
  p[0] = p[2] = 0;
  atlas_move(p, 0, 1, 1, 0, 1);
  assert(close_to(hypotf(p[0], p[2]), 3));
  atlas_move(p, 0, 0, 0, -1, 1);
  assert(close_to(p[1], 0.3f));
  puts("navigation: deadzone, axes, camera-relative movement and diagonal "
       "speed passed");
}
