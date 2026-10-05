// A place on the Redmi 1S (Adreno 305, OpenGL ES 3.0). The pack is the PICA
// table of n3ds/src/format.h with GLES texels, ETC2 among them, and a FELD
// section of light sprites (crates/pocket3d-place-cook/src/pica.rs and
// adreno.rs): light, grade and haze are cooked into the vertex colours, so a
// surface costs one texture fetch. On this GPU a fetch and a triangle are
// cheap, arithmetic in a fragment program is dear, and nothing hidden is
// removed before it is shaded except by the depth test: opaque groups are
// drawn first and the sky last. Adjacent static chunks of a material
// are one group: the indices of its visible chunks, at their levels of
// detail, are kept in one buffer that is rewritten only when that choice
// changes, so a group is one draw call (a draw costs 17 to 20 microseconds
// here). A rig's vertices are moved by its joints in the vertex stage.
#include "scene.h"
#include "../../n3ds/src/control.h"
#include "../../n3ds/src/format.h"
#include "shaders.h"
#include <GLES3/gl3.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#define GL_TEXTURE_MAX_ANISOTROPY_EXT 0x84FE
#define GL_COMPRESSED_RGB8_ETC2 0x9274
enum { SCENE_HAZE = 2, SCENE_REFLECTION = 4 }; // AtlasHeader.features
enum { MAX_DRAWS = 4096, MAX_FX = 12000 };
enum { FORMAT_RGBA8 = 0, FORMAT_RGB565 = 3, FORMAT_RGBA4 = 4, FORMAT_ETC2 = 5 }; // AtlasTexture.format
// The container of this target's pack: crates/pocket3d-place-cook/src/adreno.rs.
#define PACK_VERSION 0x201
static unsigned WIDTH = 1280, HEIGHT = 720, MIRROR_WIDTH = 640, MIRROR_HEIGHT = 360;
#define NEAR 0.1f
typedef struct {
  uint32_t first, count;
  float center[3], radius, min_pixels, max_pixels, depth_pull, period;
} Field;
enum { SPRITE_BYTES = 52 }; // position radius, path cycles, phase blink duty 1/k, colour twinkle
typedef float Mat[16];      // column-major
enum { U_MVP, U_UV, U_TINT, U_FOG, U_FOG_COLOR, U_CUT, U_EYE, U_MIRROR, U_WET, U_WAVE0, U_WAVE1, U_SKY, U_MASK, U_FIELD, U_CLOCK, U_BONE, U_SHADOW, U_SHADE, U_COUNT };
static const char *const uniform_names[U_COUNT] = {"uMVP", "uUV", "uTint", "uFog", "uFogColor", "uCut", "uEye", "uMirror", "uWet",
                                                   "uWave0", "uWave1", "uSky", "uMask", "uField", "uClock", "uBone", "uShadow", "uShade"};
// A rig's joints fit the vertex stage's uniforms: 256 vectors, three a joint.
enum { MAX_JOINTS = 72 };
typedef struct {
  GLuint id;
  GLint at[U_COUNT];
} Program;
// The second row is the first with the sun's shadow read in; the third draws the shadow map.
enum { SURFACE, CUTOUT, RIG, RIG_CUTOUT, SUN, SUN_CUTOUT = SUN + CUTOUT, GLOW = 2 * SUN, WET, WATER, FIELD, CASTER, CASTER_CUTOUT, CASTER_RIG_CUTOUT, PROGRAMS };
// How a draw is drawn: whole, or a cutout's depth and then its colour.
enum { WHOLE, DEPTH_OF, COLOUR_OF };
// AtlasMaterial.flags beside n3ds/src/format.h's: the vertices' alpha is the
// share of their colour left in the sun's shadow (adreno.rs).
enum { MAT_SUN = 1024, SHADOW_SIZE = 2048, SHADOW_LEVELS = 4 };
// SUNL: the sun and its shadow camera as the place was authored.
typedef struct {
  float direction[3], position[3], ortho[6], bias, normal_bias, tint[3];
} Sun;
enum { MAIN, MIRROR }; // the two views a group's indices are gathered for

AtlasScene atlas = {.reflection = true, .rain = true, .glow = true, .cinematic = true, .lod = 1};
// Where the CPU's part of a frame goes, smoothed (ms).
float scene_phase[SCENE_PHASES];
static double stamp;
static double seconds(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}
static void phase(unsigned which) {
  double at = seconds();
  scene_phase[which] += ((float)(at - stamp) * 1000 - scene_phase[which]) * 0.05f;
  stamp = at;
}
static uint8_t *pack, *mapping;
static size_t pack_bytes, mapping_bytes;
static AtlasHeader *head;
static AtlasTexture *texture_info;
static AtlasMaterial *materials;
static AtlasDraw *draws;
static AtlasShot *shots;
static AtlasLight *lights;
static AtlasBox *dry;
static AtlasSkin *weights;
static Field *fields;
static unsigned field_count;
static uint8_t *geometry;
static float *animation, *matrices;
static AtlasVertex *fx;
static unsigned fx_count;
static Program programs[PROGRAMS], *bound;
static GLuint *textures, white, glow, puddle, mirror_texture, mirror_depth, mirror_target, geometry_buffer, sprite_buffer,
    sky_buffer, skin_buffer, shadow_map, shadow_target;
static const Sun *sun;
static Mat shadow_projection;
// The joints each rig reads, in the order its vertices index them: a slice of `rig_joints`.
static uint16_t *rig_joints;
static uint32_t rig_first[MAX_DRAWS];
static uint8_t rig_count[MAX_DRAWS];
// Draws [first[g], first[g + 1]) share a material and a 16-bit vertex range.
// Per view: the level each draw wants (-1: none) and the one in the buffer.
static uint16_t *stream, first[MAX_DRAWS + 1], group_of[MAX_DRAWS];
static unsigned groups, counts[2][MAX_DRAWS], stream_at[MAX_DRAWS];
static GLuint group_buffer[2][MAX_DRAWS];
static int8_t wanted[2][MAX_DRAWS], shown[2][MAX_DRAWS];
static float local_half[MAX_DRAWS][3], world_bounds[MAX_DRAWS][7], distance_draw[MAX_DRAWS];
static uint16_t blended[MAX_DRAWS], order[MAX_DRAWS];
// Where the eye stood when a group's indices were last put in order.
static float gathered_at[MAX_DRAWS][3];
static unsigned blended_count;
static Mat view_projection, turned, mirror_projection;
static float planes[5][4], right[3], up[3], focal, shot_time, yaw, pitch, freeze_time = -1;
static const float *last_model;
static int last_material;
#define NO_VERTICES ((const void *)UINTPTR_MAX)
static const void *last_vertices;

#define SKY_SEGMENTS 32
#define SKY_RINGS 16
#define SKY_VERTICES (SKY_SEGMENTS * SKY_RINGS * 6)
static float clampf(float v, float lo, float hi) { return fminf(hi, fmaxf(lo, v)); }
static float dot3(const float *a, const float *b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static float wrap01(float f) { return f - floorf(f); }
// Rows of a 3x4 animation matrix times a point.
static void point(float *out, const float *m, const float *p) {
  for (int i = 0; i < 3; i++)
    out[i] = dot3(m + 4 * i, p) + m[4 * i + 3];
}
static void multiply(Mat out, const Mat a, const Mat b) {
  Mat r;
  for (int c = 0; c < 4; c++)
    for (int k = 0; k < 4; k++)
      r[c * 4 + k] = a[k] * b[c * 4] + a[4 + k] * b[c * 4 + 1] + a[8 + k] * b[c * 4 + 2] + a[12 + k] * b[c * 4 + 3];
  memcpy(out, r, sizeof r);
}
static uint32_t rgba(float r, float g, float b, float a) {
  return (uint32_t)(clampf(r, 0, 1) * 255) | (uint32_t)(clampf(g, 0, 1) * 255) << 8 | (uint32_t)(clampf(b, 0, 1) * 255) << 16 |
         (uint32_t)(clampf(a, 0, 1) * 255) << 24;
}
static float random01(unsigned v) {
  v ^= v >> 16;
  v *= 0x7feb352d;
  v ^= v >> 15;
  v *= 0x846ca68b;
  v ^= v >> 16;
  return (v & 0xffffff) / 16777216.0f;
}

static GLuint compile(GLenum type, const char *define, const char *source, char *error, size_t capacity) {
  GLuint shader = glCreateShader(type);
  const char *parts[] = {"#version 300 es\n", define, source};
  glShaderSource(shader, 3, parts, NULL);
  glCompileShader(shader);
  GLint ok;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    int n = snprintf(error, capacity, "shader %s", define);
    glGetShaderInfoLog(shader, (GLsizei)(capacity - n), NULL, error + n);
  }
  return ok ? shader : 0;
}
static bool link_program(Program *p, const char *define, char *error, size_t capacity) {
  GLuint vertex = compile(GL_VERTEX_SHADER, define, vertex_source, error, capacity);
  GLuint fragment = compile(GL_FRAGMENT_SHADER, define, fragment_source, error, capacity);
  if (!vertex || !fragment)
    return false;
  p->id = glCreateProgram();
  glAttachShader(p->id, vertex);
  glAttachShader(p->id, fragment);
  static const char *const attributes[] = {"aPos", "aUV", "aColor", "aAnim", "aJoint", "aWeight"};
  for (unsigned i = 0; i < 6; i++)
    glBindAttribLocation(p->id, i, attributes[i]);
  glLinkProgram(p->id);
  glDeleteShader(vertex);
  glDeleteShader(fragment);
  GLint ok;
  glGetProgramiv(p->id, GL_LINK_STATUS, &ok);
  if (!ok) {
    snprintf(error, capacity, "link %s", define);
    return false;
  }
  for (unsigned i = 0; i < U_COUNT; i++)
    p->at[i] = glGetUniformLocation(p->id, uniform_names[i]);
  glUseProgram(p->id);
  glUniform1i(glGetUniformLocation(p->id, "uMirrorTex"), 1);
  glUniform1i(glGetUniformLocation(p->id, "uPuddle"), 2);
  glUniform1i(glGetUniformLocation(p->id, "uGlow"), 3);
  glUniform1i(glGetUniformLocation(p->id, "uShadowMap"), 4);
  return true;
}
static GLuint texture(unsigned width, unsigned height, GLenum format, GLenum type, const void *pixels, GLenum wrap) {
  GLuint id;
  glGenTextures(1, &id);
  glBindTexture(GL_TEXTURE_2D, id);
  glTexImage2D(GL_TEXTURE_2D, 0, format, width, height, 0, format, type, pixels);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap);
  return id;
}
static uint8_t *section(uint32_t tag, uint32_t *size) {
  const uint32_t *h = (const uint32_t *)pack;
  for (unsigned i = 0; i < h[2]; i++) {
    const uint32_t *s = h + 4 + i * 4;
    if (s[0] == tag && (uint64_t)s[1] + s[2] <= pack_bytes) {
      *size = s[2];
      return pack + s[1];
    }
  }
  *size = 0;
  return NULL;
}
static bool range(uint32_t offset, uint64_t size, uint32_t limit) { return (uint64_t)offset + size <= limit; }

static void use(unsigned which);
static void attributes(const AtlasVertex *client, uint32_t offset, GLuint buffer);
// The sun's shadow map, drawn once: the place's fixed surfaces at their
// finest level, as the authored shadow camera sees them, into a depth texture
// that a sunlit surface reads through a comparison sampler. What moves casts
// nothing: it is lit or shaded by where it stands.
//
// The map has four levels, each drawn from the geometry again at half the
// size of the one before. A far wall covers many of the map's texels with
// each pixel, and reading the finest level there misses the texture cache at
// every fragment (25 ms a frame on the stairs seen from below); the level the
// sampler picks for it is as coarse as the wall's pixels.
static bool cast_shadows(void) {
  // The camera looks along -direction from its position (three.js conventions).
  float z[3] = {sun->direction[0], sun->direction[1], sun->direction[2]}, x[3], y[3];
  const float up[3] = {0, fabsf(z[1]) > 0.999f ? 0 : 1, fabsf(z[1]) > 0.999f ? -1 : 0};
  x[0] = up[1] * z[2] - up[2] * z[1], x[1] = up[2] * z[0] - up[0] * z[2], x[2] = up[0] * z[1] - up[1] * z[0];
  float length = sqrtf(dot3(x, x));
  for (int k = 0; k < 3; k++)
    x[k] /= length;
  y[0] = z[1] * x[2] - z[2] * x[1], y[1] = z[2] * x[0] - z[0] * x[2], y[2] = z[0] * x[1] - z[1] * x[0];
  const float *o = sun->ortho, *at = sun->position;
  const Mat view = {x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot3(x, at), -dot3(y, at), -dot3(z, at), 1};
  const Mat ortho = {2 / (o[1] - o[0]), 0, 0, 0, 0, 2 / (o[3] - o[2]), 0, 0, 0, 0, -2 / (o[5] - o[4]), 0,
                     -(o[1] + o[0]) / (o[1] - o[0]), -(o[3] + o[2]) / (o[3] - o[2]), -(o[5] + o[4]) / (o[5] - o[4]), 1};
  Mat clip;
  multiply(clip, ortho, view);
  // From clip space to the map's texture coordinates and depth.
  static const Mat half = {0.5f, 0, 0, 0, 0, 0.5f, 0, 0, 0, 0, 0.5f, 0, 0.5f, 0.5f, 0.5f, 1};
  multiply(shadow_projection, half, clip);

  glGenTextures(1, &shadow_map);
  glActiveTexture(GL_TEXTURE4);
  glBindTexture(GL_TEXTURE_2D, shadow_map);
  glTexStorage2D(GL_TEXTURE_2D, SHADOW_LEVELS, GL_DEPTH_COMPONENT16, SHADOW_SIZE, SHADOW_SIZE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, SHADOW_LEVELS - 1);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  // One filtered fetch answers "is this depth nearer the sun than the map's": four texels compared, then blended.
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_COMPARE_REF_TO_TEXTURE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_FUNC, GL_LEQUAL);
  glActiveTexture(GL_TEXTURE0);
  glGenFramebuffers(1, &shadow_target);
  glBindFramebuffer(GL_FRAMEBUFFER, shadow_target);
  const GLenum none = GL_NONE;
  glDrawBuffers(1, &none);
  glReadBuffer(GL_NONE);
  glDepthMask(GL_TRUE);
  glClearDepthf(1);
  glEnable(GL_DEPTH_TEST);
  glDepthFunc(GL_LEQUAL);
  glDisable(GL_BLEND);
  glDisable(GL_CULL_FACE);
  // A surface facing the sun must not shade itself: its depth in the map is
  // pushed back by its slope.
  glEnable(GL_POLYGON_OFFSET_FILL);
  glPolygonOffset(2.5f, 6);
  for (unsigned a = 0; a < 3; a++)
    glEnableVertexAttribArray(a);
  GLuint indices;
  glGenBuffers(1, &indices);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, indices);
  for (unsigned level = 0; level < SHADOW_LEVELS; level++) {
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, shadow_map, level);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
      return false;
    glViewport(0, 0, SHADOW_SIZE >> level, SHADOW_SIZE >> level);
    glClear(GL_DEPTH_BUFFER_BIT);
    bound = NULL;
    last_vertices = NO_VERTICES;
    for (unsigned i = 0; i < head->draws; i++) {
      const AtlasDraw *d = &draws[i];
      const AtlasMaterial *m = &materials[d->material];
      if (d->node != UINT32_MAX || d->skin != UINT32_MAX || (m->flags & (MAT_BLEND | MAT_ADD | MAT_GLASS | MAT_WATER)) || !d->lod[0].count)
        continue;
      use(m->flags & MAT_CUTOUT ? CASTER_CUTOUT : CASTER);
      glUniformMatrix4fv(bound->at[U_MVP], 1, GL_FALSE, clip);
      glUniform4f(bound->at[U_UV], 1, 1, 0, 0);
      if (m->flags & MAT_CUTOUT) {
        glUniform4f(bound->at[U_TINT], 0, 1, 0, 0);
        glUniform1f(bound->at[U_CUT], fmaxf(m->cutout, 0.3f));
        glBindTexture(GL_TEXTURE_2D, m->texture == UINT32_MAX ? white : textures[m->texture]);
      }
      attributes(NULL, d->vertices, geometry_buffer);
      glBufferData(GL_ELEMENT_ARRAY_BUFFER, d->lod[0].count * 2, geometry + d->lod[0].offset, GL_STREAM_DRAW);
      glDrawElements(GL_TRIANGLES, d->lod[0].count, GL_UNSIGNED_SHORT, 0);
    }
  }
  glDeleteBuffers(1, &indices);
  glDisable(GL_POLYGON_OFFSET_FILL);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  bound = NULL;
  last_vertices = NO_VERTICES;
  return true;
}
void scene_size(unsigned width, unsigned height) {
  WIDTH = width, HEIGHT = height;
  MIRROR_WIDTH = width / 2, MIRROR_HEIGHT = height / 2;
}
bool scene_load(int file, long long offset, size_t size, const char *path, char *error, size_t capacity) {
  // A rig's vertices get a copy of their joints numbered within the rig.
  AtlasSkin *local = NULL;
  uint16_t *seen = NULL;
  scene_free();
  if (file < 0 || size < 16 + 6 * 16) {
    snprintf(error, capacity, "cannot open %s", path);
    if (file >= 0)
      close(file);
    return false;
  }
  // Private pages: the table is patched below, the rest is paged in as drawn.
  // An asset starts wherever the APK put it: map from the page before.
  size_t lead = (size_t)(offset & 4095);
  pack_bytes = size;
  mapping_bytes = size + lead;
  mapping = mmap(NULL, mapping_bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE, file, (off_t)(offset - lead));
  close(file);
  if (mapping == MAP_FAILED) {
    mapping = NULL;
    snprintf(error, capacity, "cannot map %s", path);
    return false;
  }
  pack = mapping + lead;
  const uint32_t *header = (const uint32_t *)pack;
  uint32_t ps, ts, gs, as, fs;
  uint8_t *table = section(0x41434950, &ps), *texels = section(0x44584554, &ts), *field = section(0x444c4546, &fs);
  geometry = section(0x4d4f4547, &gs);
  animation = (float *)section(0x4d494e41, &as);
  head = (AtlasHeader *)table;
  // Its sections follow the header.
  if (header[0] != 0x45434c50 || header[1] != PACK_VERSION || header[2] < 6 || ps < sizeof *head || fs < 4 || !texels || !geometry ||
      head->version != ATLAS_PICA_TABLE_VERSION || head->draws > MAX_DRAWS || !head->shots || !head->frames ||
      (uint64_t)head->matrices * head->frames * 48 > as ||
      sizeof *head + (uint64_t)head->textures * sizeof(AtlasTexture) + (uint64_t)head->materials * sizeof(AtlasMaterial) +
              (uint64_t)head->draws * sizeof(AtlasDraw) + (uint64_t)head->shots * sizeof(AtlasShot) +
              (uint64_t)head->lights * sizeof(AtlasLight) + (uint64_t)head->dry_boxes * sizeof(AtlasBox) + head->skin_bytes !=
          ps)
    goto invalid;
  texture_info = (AtlasTexture *)(head + 1);
  materials = (AtlasMaterial *)(texture_info + head->textures);
  draws = (AtlasDraw *)(materials + head->materials);
  shots = (AtlasShot *)(draws + head->draws);
  lights = (AtlasLight *)(shots + head->shots);
  dry = (AtlasBox *)(lights + head->lights);
  weights = (AtlasSkin *)(dry + head->dry_boxes);
  field_count = *(uint32_t *)field;
  fields = (Field *)(field + 4);
  if (!range(4, (uint64_t)field_count * sizeof(Field), fs))
    goto invalid;
  const uint8_t *sprites = (const uint8_t *)(fields + field_count);
  unsigned sprite_bytes = fs - 4 - field_count * sizeof(Field);
  for (unsigned i = 0; i < field_count; i++)
    if (!range(fields[i].first * SPRITE_BYTES, (uint64_t)fields[i].count * SPRITE_BYTES, sprite_bytes))
      goto invalid;
  matrices = malloc(head->matrices ? head->matrices * 48 : 4);
  textures = calloc(head->textures ? head->textures : 1, sizeof *textures);
  fx = malloc(MAX_FX * sizeof *fx);
  AtlasVertex *sky = malloc(SKY_VERTICES * sizeof *sky);
  local = malloc(head->skin_bytes ? head->skin_bytes : 4);
  seen = malloc((head->matrices ? head->matrices : 1) * sizeof *seen);
  rig_joints = malloc((size_t)(head->draws ? head->draws : 1) * MAX_JOINTS * sizeof *rig_joints);
  unsigned rig_total = 0, rig_widest = 1;
  if (!matrices || !textures || !sky || !fx || !local || !seen || !rig_joints)
    goto invalid;
  memcpy(local, weights, head->skin_bytes);
  if (head->matrices)
    memcpy(matrices, animation, head->matrices * 48);
  unsigned previous_end = 0, group_vertices = 0, group_material = UINT32_MAX, largest = 0, total = 0;
  groups = 0;
  for (unsigned i = 0; i < head->draws; i++) {
    AtlasDraw *d = &draws[i];
    if (d->count > 65536 || d->material >= head->materials || !range(d->vertices, (uint64_t)d->count * sizeof(AtlasVertex), gs) ||
        (d->node != UINT32_MAX && d->node >= head->matrices))
      goto invalid;
    for (unsigned k = 0; k < 4; k++)
      if (d->lod[k].count % 3 || !range(d->lod[k].offset, (uint64_t)d->lod[k].count * 2, gs))
        goto invalid;
    const AtlasVertex *v = (const AtlasVertex *)(geometry + d->vertices);
    bool fixed = d->node == UINT32_MAX && d->skin == UINT32_MAX, below = fixed;
    memset(local_half[i], 0, sizeof local_half[i]);
    for (unsigned j = 0; j < d->count; j++) {
      for (unsigned k = 0; k < 3; k++)
        local_half[i][k] = fmaxf(local_half[i][k], fabsf(v[j].position[k] - d->center[k]));
      below = below && v[j].position[1] <= 0.02f;
    }
    // The wet ground itself is not mirrored in it.
    if (below)
      d->no_reflect = true;
    if (d->skin != UINT32_MAX) {
      if (!range(d->skin, (uint64_t)d->count * sizeof(AtlasSkin), head->skin_bytes) || d->root >= head->matrices)
        goto invalid;
      AtlasSkin *w = (AtlasSkin *)((uint8_t *)local + d->skin);
      unsigned used = 0;
      memset(seen, 0xff, head->matrices * sizeof *seen);
      rig_first[i] = rig_total;
      for (unsigned j = 0; j < d->count; j++)
        for (unsigned k = 0; k < 4; k++) {
          unsigned joint = w[j].joint[k];
          if (joint >= head->matrices || (seen[joint] == UINT16_MAX && used == MAX_JOINTS))
            goto invalid;
          if (seen[joint] == UINT16_MAX) {
            seen[joint] = (uint16_t)used;
            rig_joints[rig_total + used++] = (uint16_t)joint;
          }
          w[j].joint[k] = seen[joint];
        }
      rig_count[i] = (uint8_t)used;
      rig_total += used;
      if (used > rig_widest)
        rig_widest = used;
    }
    // Adjacent static draws of one material share a 16-bit vertex range.
    if (!fixed || d->vertices != previous_end || d->material != group_material || group_vertices + d->count > 65536) {
      first[groups++] = i;
      group_vertices = total = 0;
    }
    group_of[i] = groups - 1;
    if ((total += d->lod[0].count) > largest)
      largest = total;
    group_vertices += d->count;
    previous_end = d->vertices + d->count * sizeof(AtlasVertex);
    group_material = fixed ? d->material : UINT32_MAX;
  }
  first[groups] = head->draws;
  memset(shown, -1, sizeof shown);
  memset(counts, 0, sizeof counts);
  if (!(stream = malloc(largest * sizeof *stream + 2)))
    goto invalid;
  for (unsigned i = 0; i < head->materials; i++) {
    AtlasMaterial *m = &materials[i];
    if ((m->track != UINT32_MAX && !range(m->track, (uint64_t)head->frames * 4, as)) || !m->cols || !m->rows ||
        (m->texture != UINT32_MAX && m->texture >= head->textures) ||
        ((m->flags & MAT_GLOW) && !(m->waves[0] >= 0 && m->waves[0] < head->textures)))
      goto invalid;
  }
  if ((head->sky_texture != UINT32_MAX && head->sky_texture >= head->textures) ||
      (head->cloud_texture != UINT32_MAX && head->cloud_texture >= head->textures))
    goto invalid;

  char rig[64], rig_cut[80], rig_depth[96], sunned[4][96];
  snprintf(rig, sizeof rig, "#define SKIN\n#define BONES %u\n", rig_widest);
  snprintf(rig_cut, sizeof rig_cut, "%s#define CUT\n", rig);
  snprintf(rig_depth, sizeof rig_depth, "%s#define DEPTH\n", rig_cut);
  const char *defines[PROGRAMS] = {[SURFACE] = "#define SURFACE\n", [CUTOUT] = "#define CUT\n", [RIG] = rig, [RIG_CUTOUT] = rig_cut,
                                   [GLOW] = "#define GLOW\n", [WET] = "#define WET\n", [WATER] = "#define WATER\n", [FIELD] = "#define FIELD\n",
                                   [CASTER] = "#define DEPTH\n", [CASTER_CUTOUT] = "#define DEPTH\n#define CUT\n", [CASTER_RIG_CUTOUT] = rig_depth};
  for (unsigned i = 0; i < SUN; i++) {
    snprintf(sunned[i], sizeof sunned[i], "%s#define SUN\n", defines[i]);
    defines[SUN + i] = sunned[i];
  }
  uint32_t sun_bytes;
  sun = (const Sun *)section(0x4c4e5553, &sun_bytes);
  if (sun && sun_bytes < sizeof *sun)
    goto invalid;
  for (unsigned i = 0; i < PROGRAMS; i++)
    if ((sun || !((i >= SUN && i < GLOW) || i == CASTER)) && !link_program(&programs[i], defines[i], error, capacity)) {
      scene_free();
      return false;
    }
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  for (unsigned i = 0; i < head->textures; i++) {
    const AtlasTexture *t = &texture_info[i];
    static const GLenum formats[] = {GL_RGBA, 0, 0, GL_RGB, GL_RGBA, GL_COMPRESSED_RGB8_ETC2},
                        types[] = {GL_UNSIGNED_BYTE, 0, 0, GL_UNSIGNED_SHORT_5_6_5, GL_UNSIGNED_SHORT_4_4_4_4, 0},
                        wraps[] = {GL_REPEAT, GL_CLAMP_TO_EDGE, GL_MIRRORED_REPEAT};
    if (t->format > FORMAT_ETC2 || !formats[t->format] || !t->levels || !range(t->offset, t->bytes, ts))
      goto invalid;
    const uint8_t *pixels = texels + t->offset;
    unsigned w = t->width, h = t->height;
    glGenTextures(1, &textures[i]);
    glBindTexture(GL_TEXTURE_2D, textures[i]);
    for (unsigned level = 0; level < t->levels; level++, w /= 2, h /= 2) {
      // ETC2 is eight bytes a block of 4 by 4 texels.
      size_t bytes = t->format == FORMAT_ETC2 ? (size_t)((w + 3) / 4) * ((h + 3) / 4) * 8 : (size_t)w * h * (t->format ? 2 : 4);
      if (!w || !h || pixels + bytes > texels + t->offset + t->bytes)
        goto invalid;
      if (t->format == FORMAT_ETC2)
        glCompressedTexImage2D(GL_TEXTURE_2D, level, formats[t->format], w, h, 0, (GLsizei)bytes, pixels);
      else
        glTexImage2D(GL_TEXTURE_2D, level, formats[t->format], w, h, 0, formats[t->format], types[t->format], pixels);
      pixels += bytes;
    }
    // The chain stops at 8 texels (4 per flipbook cell).
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, t->levels - 1);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, t->levels > 1 ? GL_LINEAR_MIPMAP_NEAREST : GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wraps[t->wrap_s % 3]);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wraps[t->wrap_t % 3]);
  }
  static uint8_t square[64 * 64 * 4];
  memset(square, 255, sizeof square);
  white = texture(1, 1, GL_RGBA, GL_UNSIGNED_BYTE, square, GL_REPEAT);
  for (unsigned y = 0; y < 64; y++)
    for (unsigned x = 0; x < 64; x++) {
      float dx = (x + 0.5f) / 32 - 1, dy = (y + 0.5f) / 32 - 1;
      square[(y * 64 + x) * 4 + 3] = (uint8_t)(powf(fmaxf(0, 1 - dx * dx - dy * dy), 3) * 255);
    }
  glow = texture(64, 64, GL_RGBA, GL_UNSIGNED_BYTE, square, GL_CLAMP_TO_EDGE);
  if (head->features & SCENE_REFLECTION) {
    for (unsigned y = 0; y < 64; y++)
      for (unsigned x = 0; x < 64; x++) {
        float u = x * (2 * M_PI / 64), v = y * (2 * M_PI / 64);
        float f = sinf(u + 0.7f * sinf(v * 2)) + 0.45f * cosf(2 * v + u) + 0.23f * sinf(u * 5 - v * 3);
        square[y * 64 + x] = (uint8_t)(clampf(0.38f + f * 0.48f, 0.12f, 1) * 255);
      }
    puddle = texture(64, 64, GL_LUMINANCE, GL_UNSIGNED_BYTE, square, GL_REPEAT);
    mirror_texture = texture(MIRROR_WIDTH, MIRROR_HEIGHT, GL_RGB, GL_UNSIGNED_SHORT_5_6_5, NULL, GL_CLAMP_TO_EDGE);
    glGenRenderbuffers(1, &mirror_depth);
    glBindRenderbuffer(GL_RENDERBUFFER, mirror_depth);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, MIRROR_WIDTH, MIRROR_HEIGHT);
    glGenFramebuffers(1, &mirror_target);
    glBindFramebuffer(GL_FRAMEBUFFER, mirror_target);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, mirror_texture, 0);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, mirror_depth);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
      goto invalid;
  }
  glGenBuffers(1, &geometry_buffer);
  glBindBuffer(GL_ARRAY_BUFFER, geometry_buffer);
  glBufferData(GL_ARRAY_BUFFER, gs, geometry, GL_STATIC_DRAW);
  if (head->skin_bytes) {
    glGenBuffers(1, &skin_buffer);
    glBindBuffer(GL_ARRAY_BUFFER, skin_buffer);
    glBufferData(GL_ARRAY_BUFFER, head->skin_bytes, local, GL_STATIC_DRAW);
  }
  free(local);
  free(seen);
  local = NULL, seen = NULL;
  if (sprite_bytes) {
    glGenBuffers(1, &sprite_buffer);
    glBindBuffer(GL_ARRAY_BUFFER, sprite_buffer);
    glBufferData(GL_ARRAY_BUFFER, sprite_bytes, sprites, GL_STATIC_DRAW);
  }
  static const unsigned corners[6][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}};
  AtlasVertex *p = sky;
  for (unsigned y = 0; y < SKY_RINGS; y++)
    for (unsigned x = 0; x < SKY_SEGMENTS; x++)
      for (unsigned c = 0; c < 6; c++, p++) {
        float u = (x + corners[c][0]) / (float)SKY_SEGMENTS, v = (y + corners[c][1]) / (float)SKY_RINGS;
        float azimuth = u * 2 * M_PI, elevation = (v - .5f) * M_PI;
        *p = (AtlasVertex){{sinf(azimuth) * cosf(elevation), sinf(elevation), -cosf(azimuth) * cosf(elevation)},
                           {u, v},
                           {255, 255, 255, 255}};
      }
  glGenBuffers(1, &sky_buffer);
  glBindBuffer(GL_ARRAY_BUFFER, sky_buffer);
  glBufferData(GL_ARRAY_BUFFER, SKY_VERTICES * sizeof *sky, sky, GL_STATIC_DRAW);
  free(sky);
  if (sun && !cast_shadows())
    goto invalid;
  if (glGetError()) {
    snprintf(error, capacity, "GL error while loading %s", path);
    scene_free();
    return false;
  }
  atlas.features = head->features;
  atlas.time = 0;
  scene_shot(0, false);
  return true;
invalid:
  free(local);
  free(seen);
  snprintf(error, capacity, "invalid place pack or out of memory: %s", path);
  scene_free();
  return false;
}
void scene_free(void) {
  if (head)
    glDeleteTextures(head->textures, textures);
  for (unsigned i = 0; i < PROGRAMS; i++)
    glDeleteProgram(programs[i].id);
  GLuint names[] = {white, glow, puddle, mirror_texture, shadow_map};
  glDeleteTextures(5, names);
  glDeleteFramebuffers(1, &shadow_target);
  GLuint buffers[] = {geometry_buffer, sprite_buffer, sky_buffer, skin_buffer};
  glDeleteBuffers(4, buffers);
  glDeleteBuffers(2 * MAX_DRAWS, group_buffer[0]);
  memset(group_buffer, 0, sizeof group_buffer);
  glDeleteRenderbuffers(1, &mirror_depth);
  glDeleteFramebuffers(1, &mirror_target);
  free(matrices);
  free(textures);
  free(rig_joints);
  rig_joints = NULL;
  free(fx);
  free(stream);
  if (mapping)
    munmap(mapping, mapping_bytes);
  mapping = NULL;
  memset(programs, 0, sizeof programs);
  white = glow = puddle = mirror_texture = mirror_depth = mirror_target = geometry_buffer = sprite_buffer = sky_buffer = skin_buffer = shadow_map = shadow_target = 0;
  sun = NULL;
  pack = NULL;
  head = NULL;
  matrices = NULL;
  textures = NULL;
  fx = NULL;
  stream = NULL;
  bound = NULL;
}

unsigned scene_shot_count(void) { return head ? head->shots : 0; }
const char *scene_shot_name(unsigned shot) { return head && shot < head->shots ? shots[shot].name : ""; }
void scene_shot(unsigned shot, bool midpoint) {
  atlas.shot = shot % head->shots;
  shot_time = midpoint ? shots[atlas.shot].duration * 0.5f : 0;
  atlas.cinematic = true;
}
static void free_camera(void) {
  if (!atlas.cinematic)
    return;
  float d[3] = {atlas.target[0] - atlas.position[0], atlas.target[1] - atlas.position[1], atlas.target[2] - atlas.position[2]};
  yaw = atan2f(d[0], -d[2]);
  pitch = atan2f(d[1], sqrtf(d[0] * d[0] + d[2] * d[2]));
  atlas.cinematic = false;
}
void scene_update(float dt, const float look[2], const float move[2]) {
  if (!head)
    return;
  bool running = freeze_time < 0 && !atlas.paused;
  if (freeze_time >= 0)
    atlas.time = freeze_time;
  else if (running)
    atlas.time += dt;
  if (look[0] || look[1] || move[0] || move[1])
    free_camera();
  if (atlas.cinematic) {
    const AtlasShot *s = &shots[atlas.shot];
    if (running && (shot_time += dt) > s->duration) {
      scene_shot(atlas.shot + 1, false);
      s = &shots[atlas.shot];
    }
    float t = clampf(shot_time / s->duration, 0, 1);
    t = t * t * (3 - 2 * t);
    for (int k = 0; k < 3; k++) {
      atlas.position[k] = s->from[k] + (s->to[k] - s->from[k]) * t;
      atlas.target[k] = s->from[k + 3] + (s->to[k + 3] - s->from[k + 3]) * t;
    }
    atlas.fov = s->from[6] + (s->to[6] - s->from[6]) * t;
  } else {
    yaw += look[0];
    pitch = clampf(pitch + look[1], -1.3f, 1.3f);
    atlas.position[0] += (sinf(yaw) * move[1] + cosf(yaw) * move[0]) * dt * 3;
    atlas.position[2] += (-cosf(yaw) * move[1] + sinf(yaw) * move[0]) * dt * 3;
    atlas.target[0] = atlas.position[0] + sinf(yaw) * cosf(pitch);
    atlas.target[1] = atlas.position[1] + sinf(pitch);
    atlas.target[2] = atlas.position[2] - cosf(yaw) * cosf(pitch);
  }
  float f = fmodf(atlas.time * head->fps, (float)head->frames);
  unsigned a = (unsigned)f % head->frames, b = (a + 1) % head->frames, n = head->matrices * 12;
  const float *from = animation + a * n, *to = animation + b * n;
  for (unsigned i = 0; i < n; i++)
    matrices[i] = from[i] + (to[i] - from[i]) * (f - a);
}

static void camera(void) {
  float f = 1 / tanf(atlas.fov * (float)M_PI / 360), z[3], length;
  focal = HEIGHT * 0.5f * f;
  for (int k = 0; k < 3; k++)
    z[k] = atlas.position[k] - atlas.target[k];
  length = sqrtf(dot3(z, z));
  for (int k = 0; k < 3; k++)
    z[k] /= length;
  right[0] = z[2], right[1] = 0, right[2] = -z[0];
  length = sqrtf(dot3(right, right));
  for (int k = 0; k < 3; k++)
    right[k] /= length;
  up[0] = z[1] * right[2] - z[2] * right[1], up[1] = z[2] * right[0] - z[0] * right[2], up[2] = z[0] * right[1] - z[1] * right[0];
  // Infinite far plane: a vista's horizon is 70 km away.
  Mat projection = {f * (float)HEIGHT / (float)WIDTH, 0, 0, 0, 0, f, 0, 0, 0, 0, -1, -1, 0, 0, -2 * NEAR, 0};
  Mat view = {right[0], up[0], z[0], 0, right[1], up[1], z[1], 0, right[2], up[2], z[2], 0,
              -dot3(right, atlas.position), -dot3(up, atlas.position), -dot3(z, atlas.position), 1};
  multiply(view_projection, projection, view);
  static const Mat flip = {1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  memcpy(turned, view_projection, sizeof turned); // the driver turns a landscape window for the panel
  multiply(mirror_projection, view_projection, flip);
  const float *m = view_projection;
  for (int i = 0; i < 5; i++) {
    for (int j = 0; j < 4; j++)
      planes[i][j] = m[j * 4 + 3] + (i == 4 ? m[j * 4 + 2] : (i & 1 ? -1 : 1) * m[j * 4 + i / 2]);
    float n = sqrtf(dot3(planes[i], planes[i]));
    for (int j = 0; j < 4; j++)
      planes[i][j] /= n;
  }
}
// World centre, radius and half extents of a draw, following its node or rig.
static void bounds(unsigned i) {
  const AtlasDraw *d = &draws[i];
  float *b = world_bounds[i], *extent = b + 4;
  b[3] = d->radius;
  memcpy(extent, local_half[i], 12);
  if (d->skin != UINT32_MAX) {
    const float *m = matrices + d->root * 12;
    b[0] = m[3], b[1] = m[7] + 0.9f, b[2] = m[11], b[3] = 2.3f;
    extent[0] = extent[2] = 1, extent[1] = 1.3f;
  } else if (d->node != UINT32_MAX) {
    const float *m = matrices + d->node * 12;
    point(b, m, d->center);
    float scale = 0;
    for (int k = 0; k < 3; k++) {
      scale = fmaxf(scale, sqrtf(m[k] * m[k] + m[k + 4] * m[k + 4] + m[k + 8] * m[k + 8]));
      extent[k] = fabsf(m[4 * k]) * local_half[i][0] + fabsf(m[4 * k + 1]) * local_half[i][1] + fabsf(m[4 * k + 2]) * local_half[i][2];
    }
    b[3] *= scale;
  } else
    memcpy(b, d->center, 12);
}
static bool visible(unsigned i, bool mirror, float *distance) {
  float c[3] = {world_bounds[i][0], mirror ? -world_bounds[i][1] : world_bounds[i][1], world_bounds[i][2]}, r = world_bounds[i][3];
  for (int p = 0; p < 5; p++)
    if (dot3(planes[p], c) + planes[p][3] < -r)
      return false;
  // The nearest point of the box, not of the sphere: LOD errors of large
  // street chunks stay meaningful beside them.
  const float *extent = world_bounds[i] + 4;
  float x = fmaxf(0, fabsf(c[0] - atlas.position[0]) - extent[0]), y = fmaxf(0, fabsf(c[1] - atlas.position[1]) - extent[1]),
        z = fmaxf(0, fabsf(c[2] - atlas.position[2]) - extent[2]);
  *distance = fmaxf(0.1f, sqrtf(x * x + y * y + z * z));
  // Static chunks under a pixel across may go; a person's silhouette may not.
  return draws[i].skin != UINT32_MAX || r * focal / *distance >= 0.5f;
}
static unsigned select_lod(const AtlasDraw *d, float distance) {
  bool structural = d->reserved & DRAW_STRUCTURAL_DETAIL;
  float pixels = focal / distance;
  unsigned lod = 0;
  for (unsigned k = 1; k < 3; k++)
    if (d->lod[k].error * pixels < atlas.lod)
      lod = k;
  // The coarse level can drop whole rails and rings; keep the middle one
  // while the cell is large on screen.
  if (structural && lod > 1 && distance < 24 && d->radius * focal / distance > 8)
    lod = 1;
  return lod;
}
// Rewrites a group's indices for one view: its draws at the levels they
// want, rebased onto the group's first vertex, in the table's order.
static int nearest_first(const void *a, const void *b) {
  unsigned i = *(const uint16_t *)a, j = *(const uint16_t *)b;
  return distance_draw[i] < distance_draw[j] ? -1 : distance_draw[i] > distance_draw[j] ? 1 : (int)i - (int)j;
}
static void gather(unsigned g, unsigned view) {
  uint16_t *to = stream;
  unsigned n = 0;
  for (unsigned i = first[g]; i < first[g + 1]; i++)
    if ((shown[view][i] = wanted[view][i]) >= 0)
      order[n++] = i;
  // The eye's view from the nearest chunk outward: what stands behind is
  // rejected by depth before it is shaded. The mirror keeps the table's order.
  if (view == MAIN && !(atlas.skip & 512)) {
    qsort(order, n, sizeof *order, nearest_first);
    memcpy(gathered_at[g], atlas.position, 12);
  }
  for (unsigned k = 0; k < n; k++) {
    unsigned i = order[k];
    int lod = shown[view][i];
    const uint16_t *from = (const uint16_t *)(geometry + draws[i].lod[lod].offset);
    unsigned offset = (draws[i].vertices - draws[first[g]].vertices) / sizeof(AtlasVertex);
    if (view == MAIN)
      stream_at[i] = to - stream;
    for (unsigned v = 0; v < draws[i].lod[lod].count; v++)
      *to++ = from[v] + offset;
  }
  counts[view][g] = to - stream;
  if (!group_buffer[view][g])
    glGenBuffers(1, &group_buffer[view][g]);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, group_buffer[view][g]);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, (to - stream) * sizeof *stream, stream, GL_DYNAMIC_DRAW);
}
static bool mirror_on(void) { return atlas.reflection && (head->features & SCENE_REFLECTION); }
static int farthest_first(const void *a, const void *b) {
  float d = distance_draw[*(const uint16_t *)a] - distance_draw[*(const uint16_t *)b];
  return d > 0 ? -1 : d < 0 ? 1 : 0;
}
void scene_prepare(void) {
  if (!head)
    return;
  stamp = seconds();
  camera();
  blended_count = 0;
  for (unsigned i = 0; i < head->draws; i++) {
    const AtlasDraw *d = &draws[i];
    const AtlasMaterial *m = &materials[d->material];
    float distance;
    bounds(i);
    wanted[MAIN][i] = wanted[MIRROR][i] = -1;
    if (visible(i, false, &distance)) {
      unsigned lod = select_lod(d, distance);
      if (d->lod[lod].count) {
        wanted[MAIN][i] = lod;
        distance_draw[i] = distance;
        if (m->flags & (MAT_BLEND | MAT_ADD | MAT_GLASS))
          blended[blended_count++] = i;
      }
    }
    if (mirror_on() && !d->no_reflect && !(m->flags & (MAT_WET | MAT_GLASS | MAT_BLEND | MAT_WATER)) && d->lod[3].count &&
        visible(i, true, &distance) && distance <= 65 && world_bounds[i][3] * focal / distance > 6)
      wanted[MIRROR][i] = 3;
  }
  phase(PHASE_CULL);
  qsort(blended, blended_count, sizeof *blended, farthest_first);
  for (unsigned view = 0; view < 2; view++)
    for (unsigned g = 0; g < groups; g++) {
      // A group of several chunks is put in order again once the eye has
      // moved: 1.5 to 3.25 m by the group, so they do not all fall on one frame.
      float moved[3] = {atlas.position[0] - gathered_at[g][0], atlas.position[1] - gathered_at[g][1], atlas.position[2] - gathered_at[g][2]},
            step = 1.5f + (g & 7) * 0.25f;
      bool stale = view == MAIN && first[g + 1] - first[g] > 1 && counts[MAIN][g] && dot3(moved, moved) > step * step && !(atlas.skip & 512);
      for (unsigned i = first[g]; i < first[g + 1]; i++)
        if (stale || wanted[view][i] != shown[view][i]) {
          gather(g, view);
          break;
        }
    }
  phase(PHASE_GATHER);
}

static void use(unsigned which) {
  Program *p = &programs[which];
  if (bound == p)
    return;
  bound = p;
  last_model = NULL;
  last_material = -1;
  glUseProgram(p->id);
  // What a frame holds still, and only where the program reads it.
  if (p->at[U_EYE] >= 0)
    glUniform3fv(p->at[U_EYE], 1, atlas.position);
  if (p->at[U_MIRROR] >= 0)
    glUniformMatrix4fv(p->at[U_MIRROR], 1, GL_FALSE, view_projection);
  if (p->at[U_SKY] >= 0)
    glUniform3fv(p->at[U_SKY], 1, head->horizon);
  if (p->at[U_FOG_COLOR] >= 0)
    glUniform3fv(p->at[U_FOG_COLOR], 1, head->fog);
  if (p->at[U_SHADE] >= 0 && sun) {
    float bias = fmaxf(-sun->bias, 0) + 0.0004f;
    if (atlas.skip & 2048)
      glUniform4f(p->at[U_SHADE], 1, 1, 1, bias);
    else
      glUniform4f(p->at[U_SHADE], sun->tint[0], sun->tint[1], sun->tint[2], atlas.skip & 4096 ? 10 : atlas.skip & 8192 ? -10 : bias);
  }
}
static void attributes(const AtlasVertex *client, uint32_t offset, GLuint buffer) {
  const uint8_t *base = client ? (const uint8_t *)client : (const uint8_t *)(uintptr_t)offset;
  if (last_vertices == base && !client)
    return;
  last_vertices = base;
  glBindBuffer(GL_ARRAY_BUFFER, client ? 0 : buffer);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(AtlasVertex), base);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, sizeof(AtlasVertex), base + 12);
  glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(AtlasVertex), base + 20);
}
static void model(const float *rows, bool mirror) {
  static const float identity[12] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};
  if (!rows)
    rows = identity;
  if (last_model == rows)
    return;
  last_model = rows;
  Mat m = {rows[0], rows[4], rows[8], 0, rows[1], rows[5], rows[9], 0, rows[2], rows[6], rows[10], 0, rows[3], rows[7], rows[11], 1}, clip;
  multiply(clip, mirror ? mirror_projection : turned, m);
  glUniformMatrix4fv(bound->at[U_MVP], 1, GL_FALSE, clip);
  if (bound->at[U_SHADOW] >= 0) {
    multiply(clip, shadow_projection, m);
    glUniformMatrix4fv(bound->at[U_SHADOW], 1, GL_FALSE, clip);
  }
}
// Blend, depth and fog state of everything that is not a place's surface.
static void overlay(GLuint id, bool additive, bool depth) {
  use(SURFACE);
  last_material = -1;
  glBindTexture(GL_TEXTURE_2D, id);
  glUniform4f(bound->at[U_UV], 1, 1, 0, 0);
  glUniform4f(bound->at[U_TINT], 1, 1, 1, 1);
  glUniform1f(bound->at[U_FOG], 0);
  glDisable(GL_CULL_FACE);
  (depth ? glEnable : glDisable)(GL_DEPTH_TEST);
  glDepthMask(GL_FALSE);
  glEnable(GL_BLEND);
  glBlendFunc(additive ? GL_SRC_ALPHA : GL_ONE, additive ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA);
}
// `count` indices at `at` of the buffer of draw i's group, in one view.
// The program that draws draw i whole.
static unsigned program_of(unsigned i, bool mirror) {
  const AtlasDraw *d = &draws[i];
  const AtlasMaterial *m = &materials[d->material];
  bool rig = d->skin != UINT32_MAX, fixed = d->node == UINT32_MAX && !rig, wet = !mirror && fixed && (m->flags & MAT_WET) && mirror_on();
  // A sunlit material's alpha is its shade: only the programs that read the shadow map draw it.
  unsigned kind = (rig ? RIG : SURFACE) + (m->flags & MAT_CUTOUT ? CUTOUT : 0) + (sun && (m->flags & MAT_SUN) && !(atlas.skip & 16384) ? SUN : 0);
  return m->flags & MAT_WATER && fixed ? WATER : wet ? WET : (m->flags & MAT_GLOW) && !rig ? GLOW : kind;
}
static bool cut(unsigned program) { return program < GLOW && (program & CUTOUT); }
static void draw(unsigned i, unsigned at, unsigned count, bool mirror, unsigned stage) {
  const AtlasDraw *d = &draws[i];
  const AtlasMaterial *m = &materials[d->material];
  bool rig = d->skin != UINT32_MAX;
  unsigned program = program_of(i, mirror);
  use(stage == DEPTH_OF ? (rig ? CASTER_RIG_CUTOUT : CASTER_CUTOUT) : stage == COLOUR_OF ? program - CUTOUT : program);
  model(d->node == UINT32_MAX || rig ? NULL : matrices + d->node * 12, mirror);
  if (last_material != (int)d->material) {
    last_material = d->material;
    float t = atlas.time + m->phase, gain = 1, sx = 1, sy = 1, u = 0, v = 0;
    if (m->track != UINT32_MAX) {
      float f = fmodf(atlas.time * head->fps, (float)head->frames);
      unsigned a = (unsigned)f % head->frames, b = (a + 1) % head->frames;
      const float *track = (const float *)((const uint8_t *)animation + m->track);
      gain = powf(fmaxf(0, track[a] + (track[b] - track[a]) * (f - a)), 1 / 2.2f);
    }
    if (m->frames > 1) {
      int frame = (int)floorf(t * m->fps) % (int)m->frames;
      if (frame < 0)
        frame += m->frames;
      sx = 1.0f / m->cols, sy = 1.0f / m->rows;
      u = (frame % m->cols) * sx, v = (frame / m->cols) * sy;
    }
    bool additive = m->flags & MAT_ADD, blend = (m->flags & (MAT_BLEND | MAT_ADD)) || m->alpha < 0.999f;
    // A flashing light's track scales the colour, or a GLOW material's map.
    if (stage == DEPTH_OF) {
      // Its alpha as the colour stage has it: the vertex's, or none where the vertex's is the shade.
      bool shade = program >= SUN;
      glUniform4f(bound->at[U_TINT], shade ? 0 : m->alpha, shade ? m->alpha : 0, 0, 0);
    } else if (m->flags & MAT_GLOW) {
      glUniform4f(bound->at[U_TINT], 1, 1, 1, gain);
      glActiveTexture(GL_TEXTURE3);
      glBindTexture(GL_TEXTURE_2D, textures[(unsigned)m->waves[0]]);
      glActiveTexture(GL_TEXTURE0);
    } else
      glUniform4f(bound->at[U_TINT], gain, gain, gain, m->alpha);
    glUniform4f(bound->at[U_UV], sx, sy, u + wrap01(t * m->scroll[0]), v + wrap01(t * m->scroll[1]));
    // Added light (a distant tower's lattice, lamp glows) stays out of the fog.
    glUniform1f(bound->at[U_FOG], (m->flags & MAT_FOG) && !additive ? head->fog_density : 0);
    // A uniform a program does not read is not sent: a call costs a microsecond here.
    if (bound->at[U_CUT] >= 0)
      glUniform1f(bound->at[U_CUT], fmaxf(m->cutout, 0.3f));
    if (bound->at[U_WET] >= 0)
      glUniform3f(bound->at[U_WET], 0.12f + m->wet * 0.35f, 0.48f, 0.12f);
    if (bound->at[U_WAVE0] >= 0) {
      glUniform3f(bound->at[U_WAVE0], m->waves[0], wrap01(atlas.time * m->waves[1] * m->waves[0]),
                  wrap01(atlas.time * m->waves[2] * m->waves[0]));
      glUniform3f(bound->at[U_WAVE1], m->waves[3], wrap01(atlas.time * m->waves[4] * m->waves[3]),
                  wrap01(atlas.time * m->waves[5] * m->waves[3]));
      glUniform1f(bound->at[U_MASK], m->wave_mask);
    }
    glBindTexture(GL_TEXTURE_2D, m->texture == UINT32_MAX ? white : textures[m->texture]);
    if (m->flags & MAT_TWO_SIDED)
      glDisable(GL_CULL_FACE);
    else
      glEnable(GL_CULL_FACE);
    glEnable(GL_DEPTH_TEST);
    glDepthMask(stage != COLOUR_OF && (mirror || ((m->flags & MAT_DEPTH) && !(m->flags & MAT_GLASS))));
    (blend ? glEnable : glDisable)(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, additive ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA);
    if (atlas.skip & 256)
      glBindTexture(GL_TEXTURE_2D, white);
    if (atlas.skip & 128) {
      // Every fragment that is shaded adds a sixteenth of white.
      glBindTexture(GL_TEXTURE_2D, white);
      glUniform4f(bound->at[U_TINT], 1, 1, 1, 1);
      glUniform1f(bound->at[U_FOG], 0);
      glEnable(GL_BLEND);
      glBlendFunc(GL_ONE, GL_ONE);
    }
  }
  attributes(NULL, draws[first[group_of[i]]].vertices, geometry_buffer);
  if (atlas.skip & 128) {
    glDisableVertexAttribArray(2);
    glVertexAttrib4f(2, 1 / 16.0f, 1 / 16.0f, 1 / 16.0f, 1);
  }
  if (rig) {
    // Its joints as the frame poses them, then each vertex's four and their weights.
    float rows[MAX_JOINTS * 12];
    for (unsigned k = 0; k < rig_count[i]; k++)
      memcpy(rows + k * 12, matrices + rig_joints[rig_first[i] + k] * 12, 48);
    glUniform4fv(bound->at[U_BONE], rig_count[i] * 3, rows);
    glBindBuffer(GL_ARRAY_BUFFER, skin_buffer);
    glEnableVertexAttribArray(4);
    glEnableVertexAttribArray(5);
    glVertexAttribPointer(4, 4, GL_UNSIGNED_SHORT, GL_FALSE, sizeof(AtlasSkin), (const void *)(uintptr_t)d->skin);
    glVertexAttribPointer(5, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(AtlasSkin), (const void *)(uintptr_t)(d->skin + 8));
  }
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, group_buffer[mirror][group_of[i]]);
  glDrawElements(GL_TRIANGLES, count, GL_UNSIGNED_SHORT, (const void *)(uintptr_t)(at * sizeof *stream));
  if (rig) {
    glDisableVertexAttribArray(4);
    glDisableVertexAttribArray(5);
  }
  atlas.draws++;
  *(mirror ? &atlas.mirror_triangles : &atlas.triangles) += count / 3;
}

static void quad(const float *p, float size, float length, uint32_t color) {
  if (fx_count + 6 > MAX_FX)
    return;
  static const float corner[6][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}};
  // A billboard, or a streak along the world's vertical when it has a length.
  const float tall[3] = {-0.02f, length, 0}, *v = length ? tall : up;
  for (unsigned c = 0; c < 6; c++) {
    AtlasVertex *out = &fx[fx_count++];
    float a = (corner[c][0] * 2 - 1) * size, b = (corner[c][1] * 2 - 1) * (length ? 1 : size);
    for (int k = 0; k < 3; k++)
      out->position[k] = p[k] + right[k] * a + v[k] * b;
    out->uv[0] = corner[c][0], out->uv[1] = corner[c][1];
    memcpy(out->color, &color, 4);
  }
}
static void fx_draw(unsigned begin, GLuint id) {
  if (fx_count == begin)
    return;
  overlay(id, true, true);
  model(NULL, false);
  last_vertices = NO_VERTICES;
  attributes(fx + begin, 0, 0);
  glDrawArrays(GL_TRIANGLES, 0, fx_count - begin);
  atlas.draws++;
}
static void effects(void) {
  unsigned start = fx_count = 0;
  bool haze = head->features & SCENE_HAZE;
  for (unsigned i = 0; atlas.glow && i < head->lights; i++) {
    const AtlasLight *l = &lights[i];
    float d[3] = {l->position[0] - atlas.position[0], l->position[1] - atlas.position[1], l->position[2] - atlas.position[2]};
    float distance = sqrtf(dot3(d, d));
    if (distance > 90 || distance < 0.25f)
      continue;
    quad(l->position, fminf(l->radius * (haze ? 0.5f : 0.12f), 4), 0,
         rgba(l->color[0], l->color[1], l->color[2], clampf(l->intensity * 0.006f, 0.015f, 0.10f)));
  }
  fx_draw(start, glow);
  start = fx_count;
  for (unsigned i = 0; atlas.rain && head->rain > 0 && i < 850; i++) {
    float p[3] = {atlas.position[0] + random01(i * 3 + 1) * 28 - 14, 0, atlas.position[2] + random01(i * 3 + 3) * 28 - 14};
    p[1] = fmodf(random01(i * 3 + 2) * 18 + 18 - fmodf(atlas.time * (7 + random01(i + 100) * 4), 18), 18);
    bool sheltered = false;
    for (unsigned b = 0; b < head->dry_boxes && !sheltered; b++)
      sheltered = p[0] > dry[b].min[0] && p[0] < dry[b].max[0] && p[1] > dry[b].min[1] && p[1] < dry[b].max[1] &&
                  p[2] > dry[b].min[2] && p[2] < dry[b].max[2];
    if (sheltered)
      continue;
    float dx = p[0] - atlas.position[0], dz = p[2] - atlas.position[2];
    quad(p, 0.010f, 0.10f + random01(i + 300) * 0.16f, rgba(0.46f, 0.62f, 0.75f, 0.20f * (1 - clampf(sqrtf(dx * dx + dz * dz) / 20, 0, 1))));
  }
  fx_draw(start, white);
}
static void sky_dome(void) {
  if (head->sky_texture == UINT32_MAX)
    return;
  // Behind everything drawn so far: only the pixels left over are shaded.
  overlay(textures[head->sky_texture], false, true);
  glDisable(GL_BLEND);
  glDepthRangef(1, 1);
  const float centred[12] = {1, 0, 0, atlas.position[0], 0, 1, 0, atlas.position[1], 0, 0, 1, atlas.position[2]};
  model(centred, false);
  last_vertices = NO_VERTICES;
  attributes(NULL, 0, sky_buffer);
  glDrawArrays(GL_TRIANGLES, 0, SKY_VERTICES);
  if (head->cloud_texture != UINT32_MAX) {
    // Cloud panoramas are premultiplied after the grade.
    glEnable(GL_BLEND);
    glBindTexture(GL_TEXTURE_2D, textures[head->cloud_texture]);
    glUniform4f(bound->at[U_UV], 1, 1, wrap01(atlas.time * head->cloud_drift), 0);
    glDrawArrays(GL_TRIANGLES, 0, SKY_VERTICES);
  }
  glDepthRangef(0, 1);
  last_vertices = NO_VERTICES;
  atlas.draws += 2;
}
static void light_fields(void) {
  if (!field_count)
    return;
  bool begun = false;
  for (unsigned i = 0; i < field_count; i++) {
    const Field *f = &fields[i];
    bool inside = true;
    for (int p = 0; p < 5 && inside; p++)
      inside = dot3(planes[p], f->center) + planes[p][3] >= -f->radius;
    if (!inside || !f->count)
      continue;
    if (!begun) {
      begun = true;
      use(FIELD);
      glUniformMatrix4fv(bound->at[U_MVP], 1, GL_FALSE, turned);
      glEnable(GL_DEPTH_TEST);
      glDepthMask(GL_FALSE);
      glEnable(GL_BLEND);
      glBlendFunc(GL_ONE, GL_ONE);
      glBindBuffer(GL_ARRAY_BUFFER, sprite_buffer);
      glEnableVertexAttribArray(3);
      for (unsigned a = 0; a < 3; a++)
        glVertexAttribPointer(a == 2 ? 3 : a, 4, GL_FLOAT, GL_FALSE, SPRITE_BYTES, (const void *)(uintptr_t)(a * 16));
      glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, SPRITE_BYTES, (const void *)48);
      last_vertices = NO_VERTICES;
    }
    glUniform4f(bound->at[U_FIELD], 2 * focal, f->min_pixels, f->max_pixels, f->depth_pull / 1000);
    glUniform2f(bound->at[U_CLOCK], atlas.time / f->period, 2 * (float)M_PI * wrap01(4 * atlas.time));
    glDrawArrays(GL_POINTS, f->first, f->count);
    atlas.draws++;
    atlas.sprites += f->count;
  }
  if (begun)
    glDisableVertexAttribArray(3);
}
void scene_render(unsigned drawable) {
  if (!head)
    return;
  atlas.draws = atlas.triangles = atlas.mirror_triangles = atlas.sprites = 0;
  bound = NULL;
  last_vertices = NO_VERTICES;
  for (unsigned a = 0; a < 3; a++)
    glEnableVertexAttribArray(a);
  glActiveTexture(GL_TEXTURE1);
  glBindTexture(GL_TEXTURE_2D, mirror_texture);
  glActiveTexture(GL_TEXTURE2);
  glBindTexture(GL_TEXTURE_2D, puddle);
  glActiveTexture(GL_TEXTURE4);
  glBindTexture(GL_TEXTURE_2D, shadow_map);
  glActiveTexture(GL_TEXTURE0);
  glDepthFunc(GL_LEQUAL);
  glDepthMask(GL_TRUE);
  glClearColor(head->horizon[0], head->horizon[1], head->horizon[2], 1);
  if (atlas.skip & 128)
    glClearColor(0, 0, 0, 1);
  stamp = seconds();
  if (mirror_on()) {
    glBindFramebuffer(GL_FRAMEBUFFER, mirror_target);
    glViewport(0, 0, MIRROR_WIDTH, MIRROR_HEIGHT);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glFrontFace(GL_CW);
    for (unsigned g = 0; g < groups; g++)
      if (counts[MIRROR][g] && !(atlas.skip & 64) && !((atlas.skip & 1) && draws[first[g]].skin != UINT32_MAX))
        draw(first[g], 0, counts[MIRROR][g], true, WHOLE);
    glFrontFace(GL_CCW);
    glDepthMask(GL_TRUE);
    bound = NULL;
    // The mirror's depth is of no use once it is drawn: the tiles need not store it.
    const GLenum depth = GL_DEPTH_ATTACHMENT;
    glInvalidateFramebuffer(GL_FRAMEBUFFER, 1, &depth);
  }
  phase(PHASE_MIRROR);
  glBindFramebuffer(GL_FRAMEBUFFER, drawable);
  glViewport(0, 0, WIDTH, HEIGHT);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
  // Opaque surfaces first: a fragment behind what is drawn fails the depth
  // test before it is shaded. A program that may `discard` is never rejected
  // early on this GPU, whatever stands in front of it, so a cutout is drawn
  // twice: its depth by a program of one fetch and the `discard`, then its
  // colour where the depth is equal, by the program of an opaque surface.
  bool twice = !(atlas.skip & 32768);
  for (unsigned pass = 0; pass < 3; pass++) {
    if (pass == 1 && twice)
      glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
    if (pass == 2) {
      glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
      if (!twice)
        break;
      glDepthFunc(GL_EQUAL);
    }
    for (unsigned g = 0; g < groups; g++) {
      unsigned flags = materials[draws[first[g]].material].flags;
      if (!counts[MAIN][g] || (flags & (MAT_BLEND | MAT_ADD | MAT_GLASS)) || cut(program_of(first[g], false)) != (pass > 0))
        continue;
      if ((atlas.skip & 1) && draws[first[g]].skin != UINT32_MAX)
        continue;
      if (atlas.skip & (pass ? 8 : 16))
        continue;
      draw(first[g], 0, counts[MAIN][g], false, !pass || !twice ? WHOLE : pass == 1 ? DEPTH_OF : COLOUR_OF);
    }
  }
  glDepthFunc(GL_LEQUAL);
  if (!(atlas.skip & 32))
    sky_dome();
  phase(PHASE_SURFACES);
  for (unsigned j = 0; j < blended_count && !(atlas.skip & 4); j++)
    draw(blended[j], stream_at[blended[j]], draws[blended[j]].lod[shown[MAIN][blended[j]]].count, false, WHOLE);
  light_fields();
  phase(PHASE_BLENDED);
  effects();
  glDepthMask(GL_TRUE);
  phase(PHASE_EFFECTS);
}

void scene_control(const char *json) {
  if (!head)
    return;
  const char *s;
  if ((s = control_field(json, "shot"))) {
    unsigned n = (unsigned)strtoul(s, NULL, 10);
    for (unsigned i = 0; *s == '"' && i < head->shots; i++)
      if (!strncmp(s + 1, shots[i].name, strlen(shots[i].name)))
        n = i;
    if (n < head->shots)
      scene_shot(n, true);
  }
  // A time freezes the place's loop there; a negative one lets it run.
  if ((s = control_field(json, "time"))) {
    float t = strtof(s, NULL);
    freeze_time = isfinite(t) && t >= 0 ? t : -1;
  }
  if ((s = control_field(json, "lod"))) {
    float pixels = strtof(s, NULL);
    if (isfinite(pixels) && pixels >= 0.25f && pixels <= 16)
      atlas.lod = pixels;
  }
  // A view pins the camera: position, target and vertical field of view.
  float view[7];
  if ((s = control_field(json, "view")) && sscanf(s, " [%f ,%f ,%f ,%f ,%f ,%f ,%f", view, view + 1, view + 2, view + 3, view + 4, view + 5, view + 6) == 7) {
    memcpy(atlas.position, view, 12);
    memcpy(atlas.target, view + 3, 12);
    atlas.fov = view[6];
    atlas.cinematic = true;
    free_camera();
  }
  bool cinematic = atlas.cinematic;
  if (control_bool(json, "cinematic", &cinematic) && !cinematic)
    free_camera();
  else
    atlas.cinematic = cinematic;
  control_bool(json, "pause", &atlas.paused);
  control_bool(json, "reflection", &atlas.reflection);
  control_bool(json, "rain", &atlas.rain);
  control_bool(json, "glow", &atlas.glow);
  if ((s = control_field(json, "skip"))) {
    atlas.skip = (unsigned)strtoul(s, NULL, 10);
    memset(shown, -2, sizeof shown); // every group is gathered again
  }
}
