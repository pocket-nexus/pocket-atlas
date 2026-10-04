#include "globe.h"
#include "globe_shbin.h"
#include <3ds.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SPHERE_U 48
#define SPHERE_V 24
#define SPHERE_VERTS ((SPHERE_U + 1) * (SPHERE_V + 1))
#define FLAT_VERTS 4096
#define MAX_PINS 48
// tools/atlas-3ds-assets.ts: the surface, the lights and the clouds as PICA
// tiles. Little endian.
typedef struct {
  char magic[4];
  u32 version;
  struct {
    u32 w, h, format, offset, bytes;
  } textures[3];
  float start_lat, start_lon, cloud_speed, sun[3];
} Header;
typedef struct {
  float x, y, z, u, v;
  u8 color[4];
} Vertex;
_Static_assert(sizeof(Header) == 92, "globe header layout");
_Static_assert(sizeof(Vertex) == 24, "PICA attribute stride");

static Header head;
static C3D_Tex textures[3], white;
static unsigned texture_loaded;
static DVLB_s *dvlb;
static shaderProgram_s shader;
static int projection_loc;
static C3D_Mtx projection;
static Vertex *sphere, *flat;
static float (*sphere_points)[3];
static float ring_cos[33], ring_sin[33];
static u16 *indices;
static unsigned flat_count;
static bool ready, placed;
static struct {
  float lat, lon;
  u32 rgb;
} pins[MAX_PINS];
static unsigned pin_count;
static int lit = -1;
static float center[2] = {112, 126}, radius = 96, lat, lon, goal_lat, goal_lon,
             settle, elapsed;
static bool following = true;

static float clampf(float v, float lo, float hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
bool globe_load(const char *path, char *error, size_t capacity) {
  globe_free();
  FILE *f = fopen(path, "rb");
  if (!f) {
    snprintf(error, capacity, "Globe missing: %s", path);
    return false;
  }
  if (fread(&head, 1, sizeof head, f) != sizeof head ||
      memcmp(head.magic, "AG3D", 4) || head.version != 1)
    goto invalid;
  for (unsigned i = 0; i < 3; i++) {
    u32 w = head.textures[i].w, h = head.textures[i].h;
    if (w < 8 || w > 1024 || (w & (w - 1)) || h < 8 || h > 1024 ||
        (h & (h - 1)) || head.textures[i].format > 1 ||
        head.textures[i].bytes != w * h * 2 ||
        !C3D_TexInit(&textures[i], w, h,
                     head.textures[i].format ? GPU_RGBA4 : GPU_RGB565))
      goto invalid;
    texture_loaded++;
    if (fseek(f, head.textures[i].offset, SEEK_SET) ||
        fread(textures[i].data, 1, head.textures[i].bytes, f) !=
            head.textures[i].bytes)
      goto invalid;
    C3D_TexSetFilter(&textures[i], GPU_LINEAR, GPU_LINEAR);
    C3D_TexSetWrap(&textures[i], GPU_REPEAT, GPU_CLAMP_TO_EDGE);
    C3D_TexFlush(&textures[i]);
  }
  fclose(f);
  f = NULL;
  if (!C3D_TexInit(&white, 8, 8, GPU_RGBA4))
    goto invalid;
  memset(white.data, 255, 128);
  C3D_TexFlush(&white);
  sphere = linearAlloc(SPHERE_VERTS * sizeof(Vertex) * 3);
  sphere_points = malloc(SPHERE_VERTS * sizeof(*sphere_points));
  indices = linearAlloc(SPHERE_U * SPHERE_V * 6 * sizeof(u16));
  flat = linearAlloc(FLAT_VERTS * sizeof(Vertex));
  if (!sphere || !sphere_points || !indices || !flat)
    goto invalid;
  for (unsigned j = 0; j <= SPHERE_V; j++) {
    float a = (0.5f - (float)j / SPHERE_V) * (float)M_PI;
    for (unsigned i = 0; i <= SPHERE_U; i++) {
      float b = ((float)i / SPHERE_U - 0.5f) * (float)(2 * M_PI);
      float *p = sphere_points[j * (SPHERE_U + 1) + i];
      p[0] = cosf(a) * sinf(b);
      p[1] = sinf(a);
      p[2] = cosf(a) * cosf(b);
    }
  }
  for (unsigned i = 0; i <= 32; i++) {
    ring_cos[i] = cosf(i * (float)(2 * M_PI / 32));
    ring_sin[i] = sinf(i * (float)(2 * M_PI / 32));
  }
  unsigned n = 0;
  for (unsigned y = 0; y < SPHERE_V; y++)
    for (unsigned x = 0; x < SPHERE_U; x++) {
      u16 a = y * (SPHERE_U + 1) + x, b = a + 1, c = a + SPHERE_U + 1,
          d = c + 1;
      u16 six[] = {a, c, b, b, c, d};
      memcpy(indices + n, six, sizeof six);
      n += 6;
    }
  GSPGPU_FlushDataCache(indices, n * 2);
  dvlb = DVLB_ParseFile((u32 *)globe_shbin, globe_shbin_size);
  if (!dvlb)
    goto invalid;
  shaderProgramInit(&shader);
  shaderProgramSetVsh(&shader, &dvlb->DVLE[0]);
  projection_loc =
      shaderInstanceGetUniformLocation(shader.vertexShader, "projection");
  // Sphere points facing the camera have positive z, as do the pins. With
  // GEQUAL, this handedness gives depth = .5 + .5*z; the opposite handedness
  // draws the rear hemisphere through the pins.
  Mtx_OrthoTilt(&projection, 0, 400, 240, 0, -1, 1, false);
  if (!placed) {
    lat = goal_lat = head.start_lat;
    lon = goal_lon = head.start_lon;
    placed = true;
  }
  ready = true;
  return true;
invalid:
  if (f)
    fclose(f);
  snprintf(error, capacity, "Invalid globe or insufficient GPU memory");
  globe_free();
  return false;
}
void globe_free(void) {
  ready = false;
  for (unsigned i = 0; i < texture_loaded; i++)
    C3D_TexDelete(&textures[i]);
  memset(textures, 0, sizeof textures);
  texture_loaded = 0;
  if (white.data)
    C3D_TexDelete(&white);
  memset(&white, 0, sizeof white);
  if (dvlb) {
    shaderProgramFree(&shader);
    DVLB_Free(dvlb);
    dvlb = NULL;
  }
  if (sphere)
    linearFree(sphere);
  if (indices)
    linearFree(indices);
  if (flat)
    linearFree(flat);
  free(sphere_points);
  sphere = flat = NULL;
  sphere_points = NULL;
  indices = NULL;
}
void globe_place(float x, float y, float r) {
  center[0] = x, center[1] = y, radius = r;
}
void globe_turn(float to_lat, float to_lon, int pin) {
  goal_lat = to_lat, goal_lon = to_lon;
  lit = pin;
  following = true;
}
void globe_pins(const char *list) {
  pin_count = 0;
  int used;
  for (const char *p = list;
       pin_count < MAX_PINS &&
       sscanf(p, "%f,%f,%lx%n", &pins[pin_count].lat, &pins[pin_count].lon,
              (unsigned long *)&pins[pin_count].rgb, &used) == 3;
       p += used + (p[used] == ';'))
    pin_count++;
}
void globe_spin(float east, float north) {
  following = false;
  lon += east;
  lat = clampf(lat + north, -80, 80);
  settle = 0.4f;
}
bool globe_update(float dt, float *at_lat, float *at_lon) {
  elapsed += dt;
  if (following) {
    float ease = 1 - expf(-dt * 5);
    lat += (goal_lat - lat) * ease;
    lon += remainderf(goal_lon - lon, 360) * ease;
  } else if (settle > 0 && (settle -= dt) <= 0) {
    *at_lat = lat;
    *at_lon = lon = remainderf(lon, 360);
    return true;
  }
  return false;
}

static void vertex(Vertex *v, float x, float y, float z, float u, float t,
                   u32 rgb, unsigned alpha) {
  *v = (Vertex){x, y, z, u, t, {rgb >> 16, rgb >> 8, rgb, alpha}};
}
static void bind_buffer(Vertex *v) {
  C3D_BufInfo *info = C3D_GetBufInfo();
  BufInfo_Init(info);
  BufInfo_Add(info, v, sizeof(Vertex), 3, 0x210);
}
static void draw(unsigned start) {
  if (flat_count == start)
    return;
  GSPGPU_FlushDataCache(flat + start, (flat_count - start) * sizeof(Vertex));
  bind_buffer(flat + start);
  C3D_TexBind(0, &white);
  C3D_DrawArrays(GPU_TRIANGLES, 0, flat_count - start);
}
static void quad(float x, float y, float w, float h, u32 rgb, unsigned alpha) {
  if (flat_count + 6 > FLAT_VERTS)
    return;
  Vertex *v = flat + flat_count;
  vertex(v, x, y, 0, 0, 0, rgb, alpha);
  vertex(v + 1, x + w, y, 0, 0, 0, rgb, alpha);
  vertex(v + 2, x, y + h, 0, 0, 0, rgb, alpha);
  v[3] = v[1];
  vertex(v + 4, x + w, y + h, 0, 0, 0, rgb, alpha);
  v[5] = v[2];
  flat_count += 6;
}
static void circle(float x, float y, float r, u32 rgb, unsigned alpha,
                   float inner) {
  const unsigned segments = 32;
  if (flat_count + segments * 6 > FLAT_VERTS)
    return;
  for (unsigned i = 0; i < segments; i++) {
    float ca = ring_cos[i], sa = ring_sin[i], cb = ring_cos[i + 1],
          sb = ring_sin[i + 1];
    Vertex *v = flat + flat_count;
    vertex(v, x + ca * r, y + sa * r, 0, 0, 0, rgb, alpha);
    vertex(v + 1, x + cb * r, y + sb * r, 0, 0, 0, rgb, alpha);
    vertex(v + 2, x + ca * inner, y + sa * inner, 0, 0, 0, rgb,
           inner ? alpha : 0);
    v[3] = v[1];
    vertex(v + 4, x + cb * inner, y + sb * inner, 0, 0, 0, rgb,
           inner ? alpha : 0);
    v[5] = v[2];
    flat_count += 6;
  }
}
void globe_render(C3D_RenderTarget *top) {
  C3D_RenderTargetClear(top, C3D_CLEAR_ALL, 0x050913ff, 0);
  C3D_FrameDrawOn(top);
  if (!ready)
    return;
  flat_count = 0;
  C3D_BindProgram(&shader);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection_loc, &projection);
  C3D_AttrInfo *attr = C3D_GetAttrInfo();
  AttrInfo_Init(attr);
  AttrInfo_AddLoader(attr, 0, GPU_FLOAT, 3);
  AttrInfo_AddLoader(attr, 1, GPU_FLOAT, 2);
  AttrInfo_AddLoader(attr, 2, GPU_UNSIGNED_BYTE, 4);
  for (int i = 0; i < 6; i++)
    C3D_TexEnvInit(C3D_GetTexEnv(i));
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvSrc(env, C3D_Both, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_MODULATE);
  C3D_TexEnvBufUpdate(C3D_Both, 0);
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_ALL);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_AlphaTest(false, GPU_ALWAYS, 0);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                 GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA);
  C3D_FogGasMode(GPU_NO_FOG, GPU_PLAIN_DENSITY, false);
  C3D_StencilTest(false, GPU_ALWAYS, 0, 0xff, 0xff);
  C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0);
  float cx = center[0], cy = center[1];
  unsigned start = flat_count;
  for (unsigned i = 0; i < 64; i++) {
    unsigned v = i * 2654435761u;
    quad((v % 4000) * .1f, ((v >> 12) % 2400) * .1f, 1, 1, 0x92aac9,
         50 + (v & 127));
  }
  // A narrow atmospheric limb around a shaded, genuinely rotating sphere.
  for (int i = 6; i > 0; i--)
    circle(cx, cy, radius + i * 1.1f, 0x3f87d1, 7, radius);
  draw(start);
  // Rotate and light once: the object sphere and ring points are immutable,
  // and the three texture passes share transformed positions.
  float a = lat * (float)(M_PI / 180), b = lon * (float)(M_PI / 180);
  float ca = cosf(a), sa = sinf(a), cb = cosf(b), sb = sinf(b);
  float drift = elapsed * head.cloud_speed;
  for (unsigned k = 0; k < SPHERE_VERTS; k++) {
    const float *p = sphere_points[k];
    float x = cb * p[0] - sb * p[2], q = sb * p[0] + cb * p[2];
    float y = ca * p[1] - sa * q, z = sa * p[1] + ca * q;
    float mu = x * head.sun[0] + y * head.sun[1] + z * head.sun[2];
    float light = sqrtf(fmaxf(mu, 0)),
          night = clampf((.07f - mu) * (1 / .22f), 0, 1);
    float r = radius * (0.962f * 3.7f) / (3.7f - z);
    unsigned c = (unsigned)(25.5f + 229.5f * light);
    Vertex *v = &sphere[k];
    vertex(v, cx + x * r, cy - y * r, z, (float)(k % (SPHERE_U + 1)) / SPHERE_U,
           (float)(k / (SPHERE_U + 1)) / SPHERE_V, (c << 16) | (c << 8) | c,
           255);
    sphere[k + SPHERE_VERTS] = *v;
    sphere[k + 2 * SPHERE_VERTS] = *v;
    c = (unsigned)(night * 255);
    memset(sphere[k + SPHERE_VERTS].color, c, 3);
    c = (unsigned)(40.8f + 214.2f * light);
    memset(sphere[k + 2 * SPHERE_VERTS].color, c, 3);
    sphere[k + 2 * SPHERE_VERTS].u += drift;
  }
  GSPGPU_FlushDataCache(sphere, SPHERE_VERTS * sizeof(Vertex) * 3);
  for (unsigned pass = 0; pass < 3; pass++) {
    bind_buffer(sphere + pass * SPHERE_VERTS);
    C3D_TexBind(0, &textures[pass]);
    C3D_DepthTest(true, GPU_GEQUAL,
                  pass == 0 ? GPU_WRITE_ALL : GPU_WRITE_COLOR);
    if (pass == 1)
      C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ONE, GPU_ONE,
                     GPU_ONE);
    else
      C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                     GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA);
    C3D_DrawElements(GPU_TRIANGLES, SPHERE_U * SPHERE_V * 6, C3D_UNSIGNED_SHORT,
                     indices);
  }
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_ALL);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                 GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA);
  // Pins on the near side; the lit one larger, with a slow ring.
  start = flat_count;
  for (unsigned i = 0; i < pin_count; i++) {
    float la = pins[i].lat * (float)(M_PI / 180),
          lo = pins[i].lon * (float)(M_PI / 180);
    float ox = cosf(la) * sinf(lo), oy = sinf(la), oz = cosf(la) * cosf(lo);
    float x = cb * ox - sb * oz, q = sb * ox + cb * oz;
    float y = ca * oy - sa * q, z = sa * oy + ca * q;
    if (z < .27f)
      continue;
    float r = radius * .962f * 3.7f / (3.7f - z), sx = cx + x * r,
          sy = cy - y * r;
    bool active = (int)i == lit;
    circle(sx, sy, active ? 4 : 2.4f, pins[i].rgb, 255, active ? 3 : 1);
    if (active)
      circle(sx, sy, 7 + sinf(elapsed * 3) * .6f, 0xffffff, 220,
             6 + sinf(elapsed * 3) * .6f);
  }
  draw(start);
}
