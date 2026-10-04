#include "../src/skin_bounds.h"
#include <assert.h>
#include <stdio.h>

static void contains(const float *c,const float *e,const float *p) {
  for (unsigned k=0;k<3;++k) assert(fabsf(p[k]-c[k]) <= e[k]+0.00001f);
}
int main(void) {
  AtlasVertex v[4]={{{-1,-1,0},{0,0},{0}}, {{1,1,0},{0,0},{0}},
                    {{-.2f,0,0},{0,0},{0}}, {{.2f,0,0},{0,0},{0}}};
  AtlasSkin w[4]={{{0,0,0,0},{255,0,0,0}},{{0,0,0,0},{255,0,0,0}},
                  {{1,0,0,0},{255,0,0,0}},{{0,1,0,0},{127,128,0,0}}};
  AtlasJointBound *boxes=NULL; unsigned n=0;
  assert(atlas_skin_bounds_build(v,w,4,3,&boxes,&n));
  assert(n==2); // Unused joints add neither work nor bounds.
  float matrices[36]={1,0,0,-40, 0,1,0,0, 0,0,1,0,
                       0,-3,0,65, 2,0,0,9, 0,0,1,-20,
                       1,0,0,999, 0,1,0,999, 0,0,1,999};
  float center[3],extent[3];
  float radius=atlas_skin_bounds(boxes,n,matrices,center,extent);
  assert(radius>50 && radius<60); // Both widely separated petals survive culling.
  for (unsigned i=0;i<4;++i) {
    float point[3]={0};
    for(unsigned j=0;j<4;++j) for(unsigned k=0;k<3;++k) {
      const float *m=matrices+w[i].joint[j]*12;
      float p=m[k*4+3];
      for(unsigned a=0;a<3;++a) p+=m[k*4+a]*v[i].position[a];
      point[k]+=p*(w[i].weight[j]/255.0f);
    }
    contains(center,extent,point);
  }
  free(boxes); boxes=NULL;
  w[3].weight[0]=126;
  assert(!atlas_skin_bounds_build(v,w,4,3,&boxes,&n));
  w[3].weight[0]=127; w[2].joint[0]=3;
  assert(!atlas_skin_bounds_build(v,w,4,3,&boxes,&n));
  puts("skin bounds: separated joints, weighted blend, nonuniform transform and validation passed");
}
