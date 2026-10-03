#include "../src/animation.h"
#include <assert.h>
#include <stdio.h>

static int close_to(float a, float b) { return fabsf(a-b) < 0.0002f; }
int main(void) {
  struct { AtlasAnimation track; AtlasTrs sample[2]; } data = {
    .track = {sizeof(AtlasAnimation), 2, 1},
    .sample = {{{0,0,0},{1,2,3},{0,0,0,32767}},
               {{10,0,0},{1,2,3},{0,0,32767,0}}}
  };
  assert(atlas_animation_valid(&data, sizeof data, 1, 2));
  float m[12];
  atlas_animation_sample(&data, 0, 0, 1, 0.5f, m);
  assert(close_to(m[3], 5));
  assert(close_to(m[0], 0) && close_to(m[4], 1));
  assert(close_to(m[1], -2) && close_to(m[5], 0));
  assert(close_to(m[10], 3)); // A wheel retains every scale at half a turn.
  for (unsigned k=0; k<3; ++k)
    assert(close_to(sqrtf(m[k]*m[k]+m[k+4]*m[k+4]+m[k+8]*m[k+8]), (float)k+1));
  // Opposite quaternion signs are the same pose across a looping track.
  data.sample[1].rotation[2]=0; data.sample[1].rotation[3]=-32767;
  atlas_animation_sample(&data, 0, 1, 0, 0.5f, m);
  assert(close_to(m[0],1) && close_to(m[5],2) && close_to(m[10],3));
  assert(!atlas_animation_valid(&data, sizeof data-1, 1, 2));
  data.track.count=3; assert(!atlas_animation_valid(&data,sizeof data,1,2));
  data.track.count=2; data.track.offset=0;
  assert(!atlas_animation_valid(&data,sizeof data,1,2));
  data.track.offset=sizeof(AtlasAnimation); data.track.kind=2;
  assert(!atlas_animation_valid(&data,sizeof data,1,2));
  data.track.kind=1; data.sample[0].translation[0]=NAN;
  assert(!atlas_animation_valid(&data,sizeof data,1,2));
  data.sample[0].translation[0]=0; data.sample[0].rotation[3]=0;
  assert(!atlas_animation_valid(&data,sizeof data,1,2));
  struct { AtlasAnimation track; float matrix[12]; } affine = {
    .track={sizeof(AtlasAnimation),1,0},
    .matrix={1,.2f,0,4, 0,1,0,5, 0,0,1,6}
  };
  assert(atlas_animation_valid(&affine,sizeof affine,1,960));
  atlas_animation_sample(&affine,0,959,0,.8f,m);
  assert(close_to(m[1],.2f) && close_to(m[3],4));
  puts("animation: rigid rotation, loop signs, constant affine and malformed ranges passed");
}
