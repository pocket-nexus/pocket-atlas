#include "../src/frustum.h"
#include "../src/skin_bounds.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
  // Perspective view looking +Z: x/y within +/-z, near .08, far 100.
  const float planes[6][4]={{1,0,1,0},{-1,0,1,0},{0,1,1,0},
                             {0,-1,1,0},{0,0,1,-.08f},{0,0,-1,100}};
  float point[3]={0,0,.08f}, zero[3]={0,0,0};
  assert(atlas_aabb_visible(planes,point,zero)); // Touching near plane.
  point[2]=.079f; assert(!atlas_aabb_visible(planes,point,zero));
  point[2]=100; assert(atlas_aabb_visible(planes,point,zero));
  point[2]=100.01f; assert(!atlas_aabb_visible(planes,point,zero));
  float center[3]={12,0,10}, half[3]={1,1,1};
  assert(atlas_aabb_visible(planes,center,half)); // Corner on side plane.
  center[0]=12.01f; assert(!atlas_aabb_visible(planes,center,half));
  center[0]=5;center[2]=1;half[0]=.1f;half[1]=20;half[2]=.1f;
  assert(!atlas_aabb_visible(planes,center,half)); // Long offscreen column.
  center[0]=0;center[2]=0;half[0]=half[1]=half[2]=1;
  assert(atlas_aabb_visible(planes,center,half)); // Crosses near plane.

  // The existing per-joint bound supplies world coordinates under rotation,
  // shear and nonuniform scale. Every normalized weighted point it encloses
  // must survive whenever that point lies in the frustum.
  AtlasVertex v[2]={{{-1,0,0},{0,0},{0}},{{1,0,0},{0,0},{0}}};
  AtlasSkin w[2]={{{0,1,0,0},{128,127,0,0}},{{0,1,0,0},{64,191,0,0}}};
  AtlasJointBound *boxes=NULL;unsigned count=0;
  assert(atlas_skin_bounds_build(v,w,2,2,&boxes,&count));
  float matrices[24]={0,-2,0,-10, 1,.2f,0,0, 0,0,1,12,
                      2,.3f,0,10, 0,1,0,0, 0,0,1,12};
  atlas_skin_bounds(boxes,count,matrices,center,half);
  assert(atlas_aabb_visible(planes,center,half));
  for(unsigned i=0;i<2;i++) {
    float p[3]={0};
    for(unsigned j=0;j<4;j++)for(unsigned k=0;k<3;k++) {
      const float*m=matrices+w[i].joint[j]*12;
      float q=m[k*4+3];for(unsigned a=0;a<3;a++)q+=m[k*4+a]*v[i].position[a];
      p[k]+=q*(w[i].weight[j]/255.0f);
    }
    assert(atlas_aabb_visible(planes,p,zero));
    for(unsigned k=0;k<3;k++)assert(fabsf(p[k]-center[k])<=half[k]+.00001f);
  }
  free(boxes);
  // Scaled plane equations have the same clipping result, including touch.
  float scaled[6][4];for(unsigned i=0;i<6;i++)for(unsigned k=0;k<4;k++)scaled[i][k]=planes[i][k]*7;
  point[2]=.08f;assert(atlas_aabb_visible(scaled,point,zero));
  puts("frustum: near/far and side touch, long offscreen bounds, transformed skins passed");
}
