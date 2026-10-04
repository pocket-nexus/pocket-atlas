#include "scene.h"
#include <pocket_pica.h>
#include "devserver.h"
#include "navigation.h"
#include "scene_shbin.h"
#include "water_shbin.h"
#include "wet_shbin.h"
#include <malloc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <mbedtls/sha256.h>
#include "memory.h"
#include "visibility.h"
AtlasStats atlas = {.reflection = true,
                    .rain = true,
                    .haze = true,
                    .cinematic = true,
                    .fov = 45,
                    .lod_floor = 2,
                    .step = 4};
extern const char *atlas_stage;
static AtlasHeader *head;
static unsigned configured_lod_floor = 3;
static void apply_lod_floor(void) {
  // The authored feature set defines shared rendering budgets. Open water
  // scenes keep full geometry; dry day/dusk streets retain the middle LOD;
  // wet night scenes retain the measured Old 3DS reflection/traffic budget.
  atlas.lod_floor = configured_lod_floor < 3 ? configured_lod_floor
                    : head && (head->features & SCENE_WATER) ? 0
                    : head && (head->features & SCENE_SKY)   ? 1
                                                             : 2;
}
static AtlasTexture *texture_info;
static AtlasMaterial *materials;
static AtlasDraw *draws;
static AtlasShot *shots;
static AtlasLight *lights;
static AtlasBox *dry;
static AtlasSkin *weights;
static uint8_t *table, *geometry;
static float *animation, *matrices;
static C3D_Tex *textures, white, glow;
static AtlasVertex **skin_vertices, **skin_back;
static DVLB_s *dvlb;
static shaderProgram_s shader;
static DVLB_s *wet_dvlb;
static shaderProgram_s wet_shader;
static C3D_Tex reflection_tex, puddle_tex;
static C3D_RenderTarget *reflection_target;
static C3D_Mtx reflection_vp;
static int reflected_loc, eye_loc, wet_loc;
static bool using_wet, using_water;
static DVLB_s *water_dvlb;
static shaderProgram_s water_shader;
static int uv_loc, wet_uv_loc, water_eye_loc, water_sky_loc, water_params_loc,
    waves0_loc, waves1_loc;
static bool glow_enabled = true, hud_enabled = true;
static float exposure_ev, exposure_gain = 1;
static bool hud_first = true, hud_last_connected;
static int hud_previous_shot = -1;
static unsigned hud_previous_effects = UINT32_MAX;
static AtlasVertex *sky_vertices;
#define SKY_SEGMENTS ATLAS_SKY_SEGMENTS
#define SKY_RINGS ATLAS_SKY_RINGS
#define SKY_VERTICES (SKY_SEGMENTS * SKY_RINGS * 6)
static bool reflection_enabled(void) {
  return atlas.reflection && head && (head->features & SCENE_REFLECTION);
}
static void set_shot(unsigned n, bool midpoint);
static void free_camera(void);
static const float *last_model;
static bool last_mirror;
static int last_material = -1;
static float focal_length;
static float world_bounds[4096][7];
static float local_half[4096][3];
static uint8_t skin_used[65536];
static int projection_loc, model_loc, tint_loc;
static C3D_Mtx projection, view, vp;
static C3D_FogLut fog;
static float shot_time, yaw, pitch, freeze_time = -1;
static float detail_range = 6.0f;
static bool camera_hold, input_lock, ui_input_block;
static uint64_t last_control;
static int stick_x, stick_y;
static unsigned measured_frames, frame_hist[128];
static double measured_ms;
static float measured_max, work_max;
void scene_measure(void) {
  measured_frames++;
  measured_ms += atlas.frame_ms;
  measured_max = fmaxf(measured_max, atlas.frame_ms);
  float work =
      fmaxf(atlas.gpu_ms, atlas.prepare_ms + atlas.update_ms) + atlas.submit_ms;
  work_max = fmaxf(work_max, work);
  unsigned bucket = (unsigned)fminf(atlas.frame_ms * 2, 127);
  frame_hist[bucket]++;
}
static float frame_percentile(float p) {
  if (!measured_frames)
    return 0;
  unsigned cumulative = 0;
  for (unsigned i = 0; i < 128; i++) {
    cumulative += frame_hist[i];
    if (cumulative >= measured_frames * p)
      return (i + 1) * 0.5f;
  }
  return 64;
}
static float ident[12] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};
static unsigned over, under;
static int touch_x, touch_y;
static bool touching;
static float smooth_frame = 33.3f;
static float frame_budget = 1000.0f / 30.0f;
static float planes[6][4];
static float distance_draw[4096];
static uint32_t visible_draws[4096], visible_count;
static uint16_t opaque_draws[4096], mirror_draws[4096];
static unsigned opaque_count, mirror_count;
static int8_t main_lods[4096], mirror_lods[4096];
#define BATCH_INDICES ATLAS_BATCH_INDICES
static uint16_t *batch_indices[2];
static unsigned batch_frame, batch_used;
static uint16_t draw_group[4096], group_first[4096];
typedef struct {
  unsigned draw, lod, count;
  const void *vertices, *indices;
} DrawPlan;
static DrawPlan main_plan[4096], mirror_plan[4096];
static unsigned main_plan_count, mirror_plan_count;
#define MAX_FX ATLAS_MAX_FX
static AtlasVertex *fx;
static unsigned fx_count;
static float clampf(float v, float lo, float hi) {
  return fminf(hi, fmaxf(lo, v));
}
static float dot3(const float *a, const float *b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
static void point(float *out, const float *m, const float *p) {
  for (int i = 0; i < 3; i++)
    out[i] = dot3(m + 4 * i, p) + m[4 * i + 3];
}
static bool read_at(FILE *f, uint32_t off, void *out, size_t n) {
  if (fseek(f, off, SEEK_SET) != 0)
    return false;
  uint8_t *p = out;
  while (n) {
    size_t chunk = n < 256 * 1024 ? n : 256 * 1024;
    if (fread(p, 1, chunk, f) != chunk)
      return false;
    p += chunk;
    n -= chunk;
    if (n)
      atlas_loading_poll();
  }
  return true;
}
static bool range(uint32_t off, uint64_t size, uint32_t limit) {
  return (uint64_t)off + size <= limit;
}
static uint32_t rgba(float r, float g, float b, float a) {
  return (uint32_t)(clampf(r, 0, 1) * 255) |
         ((uint32_t)(clampf(g, 0, 1) * 255) << 8) |
         ((uint32_t)(clampf(b, 0, 1) * 255) << 16) |
         ((uint32_t)(clampf(a, 0, 1) * 255) << 24);
}
static void send_progress(const char *s) {
  atlas_diagnostic(s);
  atlas_loading_poll();
}
static bool make_effect_textures(void) {
  if (!C3D_TexInit(&white, 8, 8, GPU_RGBA4) ||
      !C3D_TexInit(&glow, 64, 64, GPU_RGBA4))
    return false;
  memset(white.data, 255, 8 * 8 * 2);
  uint16_t *dst = glow.data;
  for (unsigned y = 0; y < 64; y++)
    for (unsigned x = 0; x < 64; x++) {
      unsigned i = 0;
      for (unsigned b = 0; b < 3; b++) {
        i |= ((x >> b) & 1) << (2 * b);
        i |= ((y >> b) & 1) << (2 * b + 1);
      }
      i += ((y / 8) * 8 + x / 8) * 64;
      float dx = ((float)x + 0.5f) / 32 - 1, dy = ((float)y + 0.5f) / 32 - 1;
      float a = powf(fmaxf(0, 1 - dx * dx - dy * dy), 3);
      dst[i] = 0xfff0 | (uint16_t)(a * 15);
    }
  C3D_TexSetFilter(&white, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetFilter(&glow, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetWrap(&glow, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  C3D_TexFlush(&white);
  C3D_TexFlush(&glow);
  return true;
}
bool scene_load(const char *path, const char *expected_sha256, char *error, size_t capacity) {
  // Call only once the previous GPU frame has retired: resources may still
  // be referenced by its command list. Choices deliberately survive unload.
  scene_free();
  FILE *file = fopen(path, "rb");
  if (!file) {
    snprintf(error, capacity, "cannot open %s", path);
    return false;
  }
  // Verify the opened content-addressed asset, not just its filename and size.
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  bool valid = mbedtls_sha256_starts_ret(&hash, 0) == 0;
  unsigned char buffer[4096], digest[32];
  size_t n, hashed = 0;
  send_progress("Verifying place SHA-256");
  while (valid && (n = fread(buffer, 1, sizeof buffer, file)) != 0) {
    valid = mbedtls_sha256_update_ret(&hash, buffer, n) == 0;
    hashed += n;
    // Large SD assets can take longer than a debug heartbeat. Loading status
    // is safe to inspect; renderer controls wait until publication completes.
    if (hashed >= 256 * 1024) {
      atlas_loading_poll();
      hashed = 0;
    }
  }
  valid = valid && !ferror(file) && mbedtls_sha256_finish_ret(&hash, digest) == 0;
  mbedtls_sha256_free(&hash);
  char actual[65];
  if (valid) for (unsigned i = 0; i < 32; i++) snprintf(actual + i * 2, 3, "%02x", digest[i]);
  if (!valid || !expected_sha256 || strcmp(actual, expected_sha256)) {
    snprintf(error, capacity, "place SHA-256 mismatch");
    fclose(file);
    return false;
  }
  rewind(file);
  uint32_t header[4], sect[5][4];
  long length;
  fseek(file, 0, SEEK_END);
  length = ftell(file);
  if (!read_at(file, 0, header, sizeof header) || !atlas_pack_header_valid(header) ||
      !read_at(file, 16, sect, sizeof sect)) {
    snprintf(error, capacity, "invalid PLCE header");
    fclose(file);
    return false;
  }
  uint32_t po = 0, ps = 0, to = 0, ts = 0, go = 0, gs = 0, ao = 0, as = 0;
  for (unsigned i = 0; i < 5; i++) {
    if (!range(sect[i][1], sect[i][2], length)) {
      snprintf(error, capacity, "section beyond file");
      fclose(file);
      return false;
    }
    switch (sect[i][0]) {
    case 0x41434950:
      po = sect[i][1];
      ps = sect[i][2];
      break;
    case 0x44584554:
      to = sect[i][1];
      ts = sect[i][2];
      break;
    case 0x4d4f4547:
      go = sect[i][1];
      gs = sect[i][2];
      break;
    case 0x4d494e41:
      ao = sect[i][1];
      as = sect[i][2];
      break;
    }
  }
  if (ps < sizeof(AtlasHeader) || ps > 4 * 1024 * 1024 ||
      gs > 24 * 1024 * 1024 || ts > 12 * 1024 * 1024 || as > 16 * 1024 * 1024)
    goto invalid;
  table = malloc(ps);
  if (!table || !read_at(file, po, table, ps))
    goto invalid;
  AtlasHeader *candidate = (AtlasHeader *)table;
  uint64_t required =
      sizeof *candidate + (uint64_t)candidate->textures * sizeof(AtlasTexture) +
      (uint64_t)candidate->materials * sizeof(AtlasMaterial) +
      (uint64_t)candidate->draws * sizeof(AtlasDraw) +
      (uint64_t)candidate->shots * sizeof(AtlasShot) +
      (uint64_t)candidate->lights * sizeof(AtlasLight) +
      (uint64_t)candidate->dry_boxes * sizeof(AtlasBox) + candidate->skin_bytes;
  if (candidate->version != ATLAS_PICA_TABLE_VERSION || required != ps || candidate->draws > 4096 ||
      candidate->textures > 512 || candidate->shots == 0 ||
      candidate->shots > 32 || candidate->matrices > 2048 ||
      !candidate->frames ||
      (uint64_t)candidate->matrices * candidate->frames * 48 > as)
    goto invalid;
  head = candidate;
  apply_lod_floor();
  texture_info = (AtlasTexture *)(head + 1);
  materials = (AtlasMaterial *)(texture_info + head->textures);
  draws = (AtlasDraw *)(materials + head->materials);
  shots = (AtlasShot *)(draws + head->draws);
  lights = (AtlasLight *)(shots + head->shots);
  dry = (AtlasBox *)(lights + head->lights);
  weights = (AtlasSkin *)(dry + head->dry_boxes);
  send_progress("Geometry and animation");
  geometry = linearMemAlign(gs, 128);
  animation = malloc(as ? as : 4);
  matrices = malloc(head->matrices ? head->matrices * 48 : 4);
  skin_vertices = calloc(head->draws, sizeof(void *));
  skin_back = calloc(head->draws, sizeof(void *));
  textures = calloc(head->textures, sizeof(C3D_Tex));
  if (!geometry || !animation || !matrices || !skin_vertices || !skin_back ||
      !textures || !read_at(file, go, geometry, gs) ||
      !read_at(file, ao, animation, as))
    goto invalid;
  if (head->matrices)
    memcpy(matrices, animation, head->matrices * 48);
  for (unsigned i = 0; i < head->draws; i++) {
    AtlasDraw *d = &draws[i];
    if (d->count > 65536 || d->material >= head->materials ||
        !range(d->vertices, (uint64_t)d->count * sizeof(AtlasVertex), gs))
      goto invalid;
    for (unsigned k = 0; k < 4; k++) {
      if (d->lod[k].count % 3 ||
          !range(d->lod[k].offset, (uint64_t)d->lod[k].count * 2, gs))
        goto invalid;
      uint16_t *idx = (uint16_t *)(geometry + d->lod[k].offset);
      for (unsigned j = 0; j < d->lod[k].count; j++)
        if (idx[j] >= d->count)
          goto invalid;
    }
    const AtlasVertex *verts = (const AtlasVertex *)(geometry + d->vertices);
    for (unsigned j = 0; j < d->count; j++)
      for (unsigned k = 0; k < 3; k++)
        local_half[i][k] =
            fmaxf(local_half[i][k], fabsf(verts[j].position[k] - d->center[k]));
    if (d->node == UINT32_MAX && d->skin == UINT32_MAX) {
      const AtlasVertex *vertices =
          (const AtlasVertex *)(geometry + d->vertices);
      bool below_plane = true;
      for (unsigned j = 0; j < d->count; j++)
        if (vertices[j].position[1] > 0.02f) {
          below_plane = false;
          break;
        }
      if (below_plane)
        d->no_reflect = true;
    }
    if (d->node != UINT32_MAX && d->node >= head->matrices)
      goto invalid;
    if (d->skin != UINT32_MAX) {
      if (!range(d->skin, (uint64_t)d->count * sizeof(AtlasSkin),
                 head->skin_bytes) ||
          d->root >= head->matrices)
        goto invalid;
      AtlasSkin *w = (AtlasSkin *)((uint8_t *)weights + d->skin);
      for (unsigned j = 0; j < d->count; j++)
        for (unsigned k = 0; k < 4; k++)
          if (w[j].joint[k] >= head->matrices)
            goto invalid;
      skin_vertices[i] = linearAlloc(d->count * sizeof(AtlasVertex));
      skin_back[i] = linearAlloc(d->count * sizeof(AtlasVertex));
      if (!skin_vertices[i] || !skin_back[i])
        goto invalid;
      memcpy(skin_vertices[i], geometry + d->vertices,
             d->count * sizeof(AtlasVertex));
      memcpy(skin_back[i], geometry + d->vertices,
             d->count * sizeof(AtlasVertex));
    }
  }
  unsigned groups = 0, previous_end = 0, group_vertices = 0,
           group_material = UINT32_MAX;
  for (unsigned i = 0; i < head->draws; i++) {
    AtlasDraw *d = &draws[i];
    bool fixed = d->node == UINT32_MAX && d->skin == UINT32_MAX;
    if (!fixed || d->vertices != previous_end ||
        d->material != group_material || group_vertices + d->count > 65536) {
      group_first[groups++] = i;
      group_vertices = 0;
    }
    draw_group[i] = groups - 1;
    group_vertices += d->count;
    previous_end = d->vertices + d->count * sizeof(AtlasVertex);
    group_material = fixed ? d->material : UINT32_MAX;
  }
  batch_indices[0] = linearAlloc(BATCH_INDICES * sizeof(uint16_t));
  batch_indices[1] = linearAlloc(BATCH_INDICES * sizeof(uint16_t));
  if (!batch_indices[0] || !batch_indices[1])
    goto invalid;
  send_progress("Native tiled textures");
  for (unsigned i = 0; i < head->textures; i++) {
    AtlasTexture *t = &texture_info[i];
    if (t->width < 8 || t->height < 8 || t->width > 1024 || t->height > 1024 ||
        (t->width & (t->width - 1)) || (t->height & (t->height - 1)) ||
        !t->levels || t->levels > 8 ||
        (t->format != 0 && t->format != 3 && t->format != 4) ||
        !range(t->offset, t->bytes, ts))
      goto invalid;
    if (!pocket_pica_texture_init(&textures[i], t->width, t->height, t->levels,
                                  t->format, t->bytes) ||
        !read_at(file, to + t->offset, textures[i].data, t->bytes))
      goto invalid;
    GPU_TEXTURE_WRAP_PARAM wrap[] = {GPU_REPEAT, GPU_CLAMP_TO_EDGE,
                                     GPU_MIRRORED_REPEAT};
    C3D_TexSetWrap(&textures[i], wrap[t->wrap_s % 3], wrap[t->wrap_t % 3]);
    C3D_TexSetFilter(&textures[i], GPU_LINEAR, GPU_LINEAR);
    C3D_TexSetFilterMipmap(&textures[i], GPU_LINEAR);
    if (!pocket_pica_texture_publish(&textures[i], t->bytes))
      goto invalid;
    if (i % 8 == 0)
      atlas_loading_poll();
  }
  for (unsigned i = 0; i < head->materials; i++) {
    AtlasMaterial *m = &materials[i];
    if (m->track != UINT32_MAX &&
        !range(m->track, (uint64_t)head->frames * 4, as))
      goto invalid;
    if (!m->cols || !m->rows || m->frames > (uint64_t)m->cols * m->rows)
      goto invalid;
    if (materials[i].texture != UINT32_MAX &&
        materials[i].texture >= head->textures)
      goto invalid;
  }
  if ((head->sky_texture != UINT32_MAX &&
       head->sky_texture >= head->textures) ||
      (head->cloud_texture != UINT32_MAX &&
       head->cloud_texture >= head->textures))
    goto invalid;
  fclose(file);
  file = NULL;
  GSPGPU_FlushDataCache(geometry, gs);
  dvlb = DVLB_ParseFile((u32 *)scene_shbin, scene_shbin_size);
  if (!dvlb)
    goto invalid;
  shaderProgramInit(&shader);
  shaderProgramSetVsh(&shader, &dvlb->DVLE[0]);
  projection_loc =
      shaderInstanceGetUniformLocation(shader.vertexShader, "projection");
  model_loc = shaderInstanceGetUniformLocation(shader.vertexShader, "model");
  tint_loc = shaderInstanceGetUniformLocation(shader.vertexShader, "tint");
  uv_loc =
      shaderInstanceGetUniformLocation(shader.vertexShader, "uv_transform");
  wet_dvlb = DVLB_ParseFile((u32 *)wet_shbin, wet_shbin_size);
  if (!wet_dvlb)
    goto invalid;
  shaderProgramInit(&wet_shader);
  shaderProgramSetVsh(&wet_shader, &wet_dvlb->DVLE[0]);
  // Both programs intentionally share the first eight uniform registers.
  if (shaderInstanceGetUniformLocation(wet_shader.vertexShader, "projection") !=
          projection_loc ||
      shaderInstanceGetUniformLocation(wet_shader.vertexShader, "model") !=
          model_loc ||
      shaderInstanceGetUniformLocation(wet_shader.vertexShader, "tint") !=
          tint_loc)
    goto invalid;
  reflected_loc =
      shaderInstanceGetUniformLocation(wet_shader.vertexShader, "reflected");
  eye_loc = shaderInstanceGetUniformLocation(wet_shader.vertexShader, "eye");
  wet_loc = shaderInstanceGetUniformLocation(wet_shader.vertexShader, "wet");
  wet_uv_loc =
      shaderInstanceGetUniformLocation(wet_shader.vertexShader, "uv_transform");
  water_dvlb = DVLB_ParseFile((u32 *)water_shbin, water_shbin_size);
  if (!water_dvlb)
    goto invalid;
  shaderProgramInit(&water_shader);
  shaderProgramSetVsh(&water_shader, &water_dvlb->DVLE[0]);
  if (shaderInstanceGetUniformLocation(water_shader.vertexShader,
                                       "projection") != projection_loc ||
      shaderInstanceGetUniformLocation(water_shader.vertexShader, "model") !=
          model_loc ||
      shaderInstanceGetUniformLocation(water_shader.vertexShader, "tint") !=
          tint_loc)
    goto invalid;
  waves0_loc =
      shaderInstanceGetUniformLocation(water_shader.vertexShader, "waves0");
  waves1_loc =
      shaderInstanceGetUniformLocation(water_shader.vertexShader, "waves1");
  water_eye_loc =
      shaderInstanceGetUniformLocation(water_shader.vertexShader, "water_eye");
  water_sky_loc =
      shaderInstanceGetUniformLocation(water_shader.vertexShader, "water_sky");
  water_params_loc = shaderInstanceGetUniformLocation(water_shader.vertexShader,
                                                      "water_params");
  if (head->features & SCENE_REFLECTION) {
    C3D_TexInitParams reflected_params = {
        128, 256, 0, GPU_RGBA8, GPU_TEX_PROJECTION, true};
    if (!C3D_TexInitWithParams(&reflection_tex, NULL, reflected_params) ||
        !C3D_TexInit(&puddle_tex, 64, 64, GPU_RGBA4))
      goto invalid;
    // The mirror uses the scene's 0.08 m near plane. At 20 m, a 16-bit Z
    // buffer merges surfaces separated by about 7.6 cm, so layered signs and
    // shop fronts fight as the view moves. 24-bit Z resolves those layers and
    // costs only 32 KiB more at 128x256; the mirror does not need stencil.
    reflection_target = C3D_RenderTargetCreateFromTex(
        &reflection_tex, GPU_TEXFACE_2D, 0, GPU_RB_DEPTH24);
    if (!reflection_target)
      goto invalid;
    C3D_TexSetFilter(&reflection_tex, GPU_LINEAR, GPU_LINEAR);
    C3D_TexSetWrap(&reflection_tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
    uint16_t *puddles = puddle_tex.data;
    for (unsigned y = 0; y < 64; y++)
      for (unsigned x = 0; x < 64; x++) {
        unsigned index = 0;
        for (unsigned b = 0; b < 3; b++)
          index |= ((x >> b) & 1) << (2 * b) | ((y >> b) & 1) << (2 * b + 1);
        index += ((y / 8) * 8 + x / 8) * 64;
        float u = x * (2 * M_PI / 64), v = y * (2 * M_PI / 64);
        float field = sinf(u + 0.7f * sinf(v * 2)) + 0.45f * cosf(2 * v + u) +
                      0.23f * sinf(u * 5 - v * 3);
        unsigned alpha =
            (unsigned)(clampf(0.38f + field * 0.48f, 0.12f, 1) * 15);
        puddles[index] = 0xfff0 | alpha;
      }
    C3D_TexSetFilter(&puddle_tex, GPU_LINEAR, GPU_LINEAR);
    C3D_TexSetWrap(&puddle_tex, GPU_REPEAT, GPU_REPEAT);
    C3D_TexFlush(&puddle_tex);
  }
  if (head->sky_texture != UINT32_MAX) {
    sky_vertices = linearAlloc(SKY_VERTICES * sizeof(AtlasVertex));
    if (!sky_vertices)
      goto invalid;
    unsigned at = 0;
    static const unsigned corners[6][2] = {{0, 0}, {1, 0}, {1, 1},
                                           {0, 0}, {1, 1}, {0, 1}};
    for (unsigned y = 0; y < SKY_RINGS; y++)
      for (unsigned x = 0; x < SKY_SEGMENTS; x++)
        for (unsigned c = 0; c < 6; c++) {
          float u = (x + corners[c][0]) / (float)SKY_SEGMENTS;
          float v = (y + corners[c][1]) / (float)SKY_RINGS;
          float az = u * 2 * M_PI, elevation = (v - .5f) * M_PI;
          AtlasVertex *p = &sky_vertices[at++];
          p->position[0] = sinf(az) * cosf(elevation) * 800;
          p->position[1] = sinf(elevation) * 800;
          p->position[2] = -cosf(az) * cosf(elevation) * 800;
          p->uv[0] = u;
          p->uv[1] = v;
          memset(p->color, 255, 4);
        }
    GSPGPU_FlushDataCache(sky_vertices, SKY_VERTICES * sizeof(AtlasVertex));
  }
  fx = linearAlloc(MAX_FX * sizeof(AtlasVertex));
  if (!fx || !make_effect_textures())
    goto invalid;
  FogLut_Exp(&fog, head->fog_density, 1.0, 0.08f, 1200.0f);
  atlas.geom_bytes = gs;
  atlas.texture_bytes = ts;
  atlas.animation_bytes = as;
  // A new view may cost much more than the previous one. Start automatic
  // quality within the budget, then probe upward using this scene's timings.
  if (!atlas.hold)
    atlas.step = 4;
  memcpy(atlas.position, shots[0].from, 12);
  memcpy(atlas.target, shots[0].from + 3, 12);
  atlas.fov = shots[0].from[6];
  if (!atlas.cinematic) {
    atlas.cinematic = true;
    free_camera();
  }
  return true;
invalid:
  snprintf(error, capacity,
           "invalid/oversized PICA pack or allocation failed (linear %lu KiB)",
           (unsigned long)(linearSpaceFree() / 1024));
  if (file)
    fclose(file);
  scene_free();
  return false;
}
static void set_shot(unsigned n, bool midpoint) {
  atlas.shot = n % head->shots;
  shot_time = midpoint ? shots[atlas.shot].duration * 0.5f : 0;
  atlas.cinematic = true;
}
static void free_camera(void) {
  if (!atlas.cinematic)
    return;
  float dx = atlas.target[0] - atlas.position[0],
        dy = atlas.target[1] - atlas.position[1],
        dz = atlas.target[2] - atlas.position[2];
  yaw = atan2f(dx, -dz);
  pitch = atan2f(dy, sqrtf(dx * dx + dz * dz));
  atlas.cinematic = false;
}
unsigned scene_features(void) { return head ? head->features : 0; }
unsigned scene_shot_count(void) { return head ? head->shots : 0; }
const char *scene_shot_name(unsigned i) {
  return head && i < head->shots ? shots[i].name : "";
}
void scene_select_shot(unsigned i) {
  if (head && i < head->shots)
    set_shot(i, true);
}
void scene_settings_get(AtlasSettings *s) {
  *s = (AtlasSettings){.reflection = atlas.reflection,
                       .rain = atlas.rain,
                       .haze = atlas.haze,
                       .glow = glow_enabled,
                       .cinematic = atlas.cinematic,
                       .hud = hud_enabled,
                       .hold = atlas.hold,
                       .step = atlas.step,
                       .lod_floor = configured_lod_floor,
                       .exposure = exposure_ev};
}
void scene_settings_set(const AtlasSettings *s) {
  atlas.reflection = s->reflection;
  atlas.rain = s->rain;
  atlas.haze = s->haze;
  glow_enabled = s->glow;
  hud_enabled = s->hud;
  atlas.hold = s->hold;
  atlas.step = s->step > 4 ? 4 : s->step;
  configured_lod_floor = s->lod_floor > 3 ? 3 : s->lod_floor;
  apply_lod_floor();
  exposure_ev = isfinite(s->exposure) ? clampf(s->exposure, -2, 2) : 0;
  exposure_gain = powf(2.0f, exposure_ev / 2.2f);
  if (head && !s->cinematic)
    free_camera();
  else
    atlas.cinematic = s->cinematic;
  over = under = 0;
  scene_hud_reset();
}
void scene_settings_reset(void) {
  AtlasSettings s = {.reflection = true,
                     .rain = true,
                     .haze = true,
                     .glow = true,
                     .cinematic = true,
                     .hud = true,
                     .hold = false,
                     .step = 4,
                     .lod_floor = 3,
                     .exposure = 0};
  scene_settings_set(&s);
}
void scene_hud_reset(void) {
  hud_first = true;
  hud_previous_shot = -1;
  hud_previous_effects = UINT32_MAX;
}

void scene_input_block(bool blocked) { ui_input_block = blocked; }
void scene_frame_budget(float milliseconds) {
  if (isfinite(milliseconds) && milliseconds >= 10 && milliseconds <= 100)
    frame_budget = milliseconds;
}
void scene_update(float dt, uint32_t down, uint32_t held) {
  if (!head)
    return;
  if (input_lock && osGetTime() - last_control > 3000)
    input_lock = false;
  if (input_lock || ui_input_block)
    down = held = 0;
  if (freeze_time >= 0)
    atlas.time = freeze_time;
  else
    atlas.time += dt;
  if (down & KEY_A)
    set_shot(atlas.shot + 1, false);
  if (down & KEY_B) {
    if (atlas.cinematic)
      free_camera();
    else
      atlas.cinematic = true;
  }
  if (down & KEY_X) {
    atlas.hold = !atlas.hold;
    over = under = 0;
  }
  if (down & KEY_Y) {
    atlas.step = (atlas.step + 1) % 5;
    atlas.hold = true;
  }
  if ((down & KEY_SELECT))
    atlas.reflection = !atlas.reflection;
  circlePosition pad;
  hidCircleRead(&pad);
  stick_x = pad.dx;
  stick_y = pad.dy;
  if (input_lock || ui_input_block)
    pad.dx = pad.dy = 0;
  float lx, ly;
  atlas_stick(pad.dx, pad.dy, &lx, &ly);
  float mx = ((held & KEY_RIGHT) ? 1 : 0) - ((held & KEY_LEFT) ? 1 : 0);
  float my = ((held & KEY_UP) ? 1 : 0) - ((held & KEY_DOWN) ? 1 : 0);
  float lift = ((held & KEY_R) ? 1 : 0) - ((held & KEY_L) ? 1 : 0);
  touchPosition p;
  hidTouchRead(&p);
  bool active = (held & KEY_TOUCH) != 0;
  if (active && !touching && p.py >= 32 && p.py < 32 + head->shots * 8) {
    unsigned row = (p.py - 32) / 8;
    if (row < head->shots)
      set_shot(row, true);
  }
  float drag_x = 0, drag_y = 0;
  if (active && touching && p.py > 120) {
    drag_x = (p.px - touch_x) * 0.006f;
    drag_y = (p.py - touch_y) * 0.006f;
  }
  touch_x = p.px;
  touch_y = p.py;
  touching = active;
  if (mx || my || lx || ly || lift || drag_x || drag_y)
    free_camera();
  if (atlas.cinematic) {
    AtlasShot *s = &shots[atlas.shot];
    if (freeze_time < 0 && !camera_hold)
      shot_time += dt;
    if (shot_time > s->duration) {
      set_shot(atlas.shot + 1, false);
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
    yaw += lx * dt * 1.75f + drag_x;
    pitch = clampf(pitch + ly * dt * 1.3f - drag_y, -1.3f, 1.3f);
    // Scene origins are geographic, so stairs/coast may sit below y=0.
    // The free camera may fly; do not apply the street helper's ground clamp.
    float height = atlas.position[1] + lift * dt * 1.8f;
    atlas_move(atlas.position, yaw, mx, my, lift, dt);
    atlas.position[1] = height;
    atlas.target[0] = atlas.position[0] + sinf(yaw) * cosf(pitch);
    atlas.target[1] = atlas.position[1] + sinf(pitch);
    atlas.target[2] = atlas.position[2] - cosf(yaw) * cosf(pitch);
  }
  float f = fmodf(atlas.time * head->fps, (float)head->frames);
  unsigned a = (unsigned)f, b = (a + 1) % head->frames;
  float k = f - a;
  for (unsigned i = 0; i < head->matrices * 12; i++)
    matrices[i] = animation[a * head->matrices * 12 + i] * (1 - k) +
                  animation[b * head->matrices * 12 + i] * k;
  smooth_frame += (atlas.frame_ms - smooth_frame) * 0.05f;
  if (!atlas.hold && atlas.frame > 90) {
    float cost = fmaxf(atlas.gpu_ms, atlas.update_ms + atlas.prepare_ms) +
                 atlas.submit_ms;
    if (cost > frame_budget * 0.954f) {
      under = 0;
      if (++over > 10 && atlas.step < 4) {
        atlas.step++;
        over = 0;
      }
    } else if (cost < frame_budget * 0.88f) {
      over = 0;
      if (++under > 90 && atlas.step > 0) {
        atlas.step--;
        under = 0;
      }
    } else
      over = under = 0;
  }
}
static void camera(void) {
  focal_length = 120.0f / tanf(C3D_AngleFromDegrees(atlas.fov) * 0.5f);
  Mtx_PerspTilt(&projection, C3D_AngleFromDegrees(atlas.fov),
                C3D_AspectRatioTop, 0.08f, 1200.0f, false);
  Mtx_LookAt(&view,
             FVec3_New(atlas.position[0], atlas.position[1], atlas.position[2]),
             FVec3_New(atlas.target[0], atlas.target[1], atlas.target[2]),
             FVec3_New(0, 1, 0), false);
  Mtx_Multiply(&vp, &projection, &view);
  // Clip-space planes, accounting for PICA depth in [-w,0].
  for (int i = 0; i < 6; i++)
    for (int j = 0; j < 4; j++) {
      float rows[4][4];
      for (int r = 0; r < 4; r++) {
        rows[r][0] = vp.r[r].x;
        rows[r][1] = vp.r[r].y;
        rows[r][2] = vp.r[r].z;
        rows[r][3] = vp.r[r].w;
      }
      planes[i][j] = i < 4    ? rows[3][j] + ((i & 1) ? -1 : 1) * rows[i / 2][j]
                     : i == 4 ? -rows[2][j]
                              : rows[3][j] + rows[2][j];
    }
  for (int i = 0; i < 6; i++) {
    float n = sqrtf(dot3(planes[i], planes[i]));
    for (int j = 0; j < 4; j++)
      planes[i][j] /= n;
  }
}
static float bounds(unsigned i, float *center) {
  AtlasDraw *d = &draws[i];
  float radius = d->radius;
  float *extent = world_bounds[i] + 4;
  memcpy(extent, local_half[i], 12);
  if (d->skin != UINT32_MAX) {
    const float *m = matrices + d->root * 12;
    center[0] = m[3];
    center[1] = m[7] + 0.9f;
    center[2] = m[11];
    radius = 2.3f;
    extent[0] = extent[2] = 1.0f;
    extent[1] = 1.3f;
  } else if (d->node != UINT32_MAX) {
    const float *m = matrices + d->node * 12;
    point(center, m, d->center);
    float scale = 0;
    for (int k = 0; k < 3; k++)
      scale = fmaxf(scale, sqrtf(m[k] * m[k] + m[k + 4] * m[k + 4] +
                                 m[k + 8] * m[k + 8]));
    radius *= scale;
    for (int k = 0; k < 3; k++)
      extent[k] = fabsf(m[4 * k]) * local_half[i][0] +
                  fabsf(m[4 * k + 1]) * local_half[i][1] +
                  fabsf(m[4 * k + 2]) * local_half[i][2];
  } else
    memcpy(center, d->center, 12);
  return radius;
}
static bool visible(unsigned i, bool mirror, float *distance) {
  float c[3];
  memcpy(c, world_bounds[i], sizeof c);
  float r = world_bounds[i][3];
  if (mirror)
    c[1] = -c[1];
  const float *extent = world_bounds[i] + 4;
  // Skinning and the water vertex shader deform outside the rigid rest box.
  bool rigid_bounds = draws[i].skin == UINT32_MAX &&
                      !(materials[draws[i].material].flags & MAT_WATER);
  for (int p = 0; p < 6; p++)
    if (rigid_bounds
            ? atlas_box_outside_plane(planes[p], c, extent)
            : dot3(planes[p], c) + planes[p][3] < -r)
      return false;
  // Sphere distance becomes zero beside large street chunks. Nearest AABB
  // distance keeps their 6 cm / 25 cm LOD errors meaningful at screen scale.
  float x = fmaxf(0, fabsf(c[0] - atlas.position[0]) - extent[0]);
  float y = fmaxf(0, fabsf(c[1] - atlas.position[1]) - extent[1]);
  float z = fmaxf(0, fabsf(c[2] - atlas.position[2]) - extent[2]);
  *distance = fmaxf(0.1f, sqrtf(x * x + y * y + z * z));
  // Subpixel static objects may disappear, never the silhouette of a person.
  if (draws[i].skin == UINT32_MAX &&
      r * 240 / (*distance) < 0.3f + atlas.step * 0.15f)
    return false;
  return true;
}
static unsigned select_lod(const AtlasDraw *d, bool mirror, float distance) {
  float tolerance = (0.65f + atlas.step * 0.65f) * (mirror ? 3.5f : 1.0f);
  bool structural = (d->reserved & DRAW_STRUCTURAL_DETAIL) != 0;
  bool preserve = structural && !mirror && distance < 24 &&
                  d->radius * focal_length / distance > 8;
  unsigned lod = atlas.lod_floor;
  if (!structural && !d->lod[lod].count && distance < detail_range)
    lod = 0;
  for (unsigned k = lod + 1; k < 3; k++)
    if (d->lod[k].error * focal_length / distance < tolerance)
      lod = k;
  // The coarse level can omit whole thin components. Keep their bounded-error
  // middle mesh while the local cell is visibly large; never restore the full
  // street chunk or spend this detail in the low-resolution mirror.
  if (preserve && lod > 1)
    lod = 1;
  return lod;
}
static void skin(unsigned i, int main_lod, int mirror_lod) {
  AtlasDraw *d = &draws[i];
  const AtlasVertex *src = (const AtlasVertex *)(geometry + d->vertices);
  AtlasVertex *dst = skin_vertices[i];
  AtlasSkin *w = (AtlasSkin *)((uint8_t *)weights + d->skin);
  memset(skin_used, 0, d->count);
  int levels[] = {main_lod, mirror_lod};
  for (unsigned pass = 0; pass < 2; pass++) {
    int l = levels[pass];
    if (l < 0 || (pass && l == levels[0]))
      continue;
    const uint16_t *indices = (const uint16_t *)(geometry + d->lod[l].offset);
    for (unsigned j = 0; j < d->lod[l].count; j++)
      skin_used[indices[j]] = 1;
  }
  for (unsigned v = 0; v < d->count; v++) {
    if (!skin_used[v])
      continue;
    atlas.skinned_vertices++;
    float p[3] = {0};
    for (unsigned j = 0; j < 4; j++) {
      if (!w[v].weight[j])
        continue;
      float q[3];
      point(q, matrices + w[v].joint[j] * 12, src[v].position);
      float k = w[v].weight[j] / 255.0f;
      for (unsigned c = 0; c < 3; c++)
        p[c] += q[c] * k;
    }
    memcpy(dst[v].position, p, 12);
  }
  GSPGPU_FlushDataCache(dst, d->count * sizeof(AtlasVertex));
}
static void model_uniform(const float *m, bool mirror) {
  if (last_model == m && last_mirror == mirror)
    return;
  last_model = m;
  last_mirror = mirror;
  if (using_wet || using_water) {
    for (int i = 0; i < 3; i++)
      C3D_FVUnifSet(GPU_VERTEX_SHADER, model_loc + i, m[4 * i], m[4 * i + 1],
                    m[4 * i + 2], m[4 * i + 3]);
    return;
  }
  float flip = mirror ? -1 : 1;
  for (int r = 0; r < 4; r++) {
    float x = vp.r[r].x, y = vp.r[r].y * flip, z = vp.r[r].z;
    C3D_FVUnifSet(
        GPU_VERTEX_SHADER, projection_loc + r, x * m[0] + y * m[4] + z * m[8],
        x * m[1] + y * m[5] + z * m[9], x * m[2] + y * m[6] + z * m[10],
        x * m[3] + y * m[7] + z * m[11] + vp.r[r].w);
  }
}
static void attributes(const void *v) {
  C3D_BufInfo *b = C3D_GetBufInfo();
  BufInfo_Init(b);
  BufInfo_Add(b, v, sizeof(AtlasVertex), 3, 0x210);
}
static void common_state(void) {
  using_wet = using_water = false;
  last_model = NULL;
  last_material = -1;
  C3D_BindProgram(&shader);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, uv_loc, 1, 1, 0, 0);
  C3D_AttrInfo *a = C3D_GetAttrInfo();
  AttrInfo_Init(a);
  AttrInfo_AddLoader(a, 0, GPU_FLOAT, 3);
  AttrInfo_AddLoader(a, 1, GPU_FLOAT, 2);
  AttrInfo_AddLoader(a, 2, GPU_UNSIGNED_BYTE, 4);
  // All 24 bytes are consumed: float3 position, float2 UV, RGBA8 color.
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection_loc, &vp);
  for (int i = 0; i < 6; i++)
    C3D_TexEnvInit(C3D_GetTexEnv(i));
  C3D_TexEnv *e = C3D_GetTexEnv(0);
  C3D_TexEnvSrc(e, C3D_Both, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(e, C3D_Both, GPU_MODULATE);
  C3D_TexEnvBufUpdate(C3D_Both, 0);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_DepthMap(true, -1, 0);
  C3D_StencilTest(false, GPU_ALWAYS, 0, 255, 255);
  C3D_FogLutBind(&fog);
  C3D_FogColor(rgba(head->fog[0], head->fog[1], head->fog[2], 1));
}
static void surface_program(bool wet) {
  if (wet == using_wet && !using_water)
    return;
  if (!wet) {
    common_state();
    return;
  }
  using_wet = true;
  using_water = false;
  last_model = NULL;
  last_material = -1;
  C3D_BindProgram(&wet_shader);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, wet_uv_loc, 1, 1, 0, 0);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection_loc, &vp);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, reflected_loc, &reflection_vp);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, eye_loc, atlas.position[0],
                atlas.position[1], atlas.position[2], 1);
  C3D_TexBind(0, &reflection_tex);
  C3D_TexBind(2, &puddle_tex);
  C3D_TexEnv *e = C3D_GetTexEnv(0);
  C3D_TexEnvSrc(e, C3D_RGB, GPU_TEXTURE1, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvSrc(e, C3D_Alpha, GPU_TEXTURE2, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(e, C3D_Both, GPU_MODULATE);
  e = C3D_GetTexEnv(1);
  C3D_TexEnvSrc(e, C3D_RGB, GPU_TEXTURE0, GPU_PREVIOUS, GPU_PREVIOUS);
  C3D_TexEnvOpRgb(e, GPU_TEVOP_RGB_SRC_COLOR, GPU_TEVOP_RGB_SRC_COLOR,
                  GPU_TEVOP_RGB_SRC_ALPHA);
  C3D_TexEnvFunc(e, C3D_RGB, GPU_INTERPOLATE);
  C3D_TexEnvSrc(e, C3D_Alpha, GPU_CONSTANT, 0, 0);
  C3D_TexEnvFunc(e, C3D_Alpha, GPU_REPLACE);
}
static void water_program(void) {
  if (using_water)
    return;
  using_water = true;
  using_wet = false;
  last_material = -1;
  last_model = NULL;
  C3D_BindProgram(&water_shader);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection_loc, &vp);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, water_eye_loc, atlas.position[0],
                atlas.position[1], atlas.position[2], 1);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, water_sky_loc, head->horizon[0],
                head->horizon[1], head->horizon[2], 1);
  for (int i = 0; i < 6; i++)
    C3D_TexEnvInit(C3D_GetTexEnv(i));
  C3D_TexEnv *e = C3D_GetTexEnv(0);
  C3D_TexEnvSrc(e, C3D_RGB, GPU_TEXTURE0, GPU_TEXTURE1, 0);
  C3D_TexEnvFunc(e, C3D_RGB, GPU_MODULATE);
  C3D_TexEnvSrc(e, C3D_Alpha, GPU_PRIMARY_COLOR, 0, 0);
  C3D_TexEnvFunc(e, C3D_Alpha, GPU_REPLACE);
  e = C3D_GetTexEnv(1);
  C3D_TexEnvSrc(e, C3D_RGB, GPU_PREVIOUS, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(e, C3D_RGB, GPU_MODULATE);
}
static float wrap01(float f) { return f - floorf(f); }
static void material_uv(const AtlasMaterial *m) {
  float t = atlas.time + m->phase, sx = 1, sy = 1, u = 0, v = 0;
  if (m->frames > 1) {
    int frame = (int)floorf(t * m->fps) % (int)m->frames;
    if (frame < 0)
      frame += m->frames;
    sx = 1.0f / m->cols;
    sy = 1.0f / m->rows;
    u = (frame % m->cols) * sx;
    v = (frame / m->cols) * sy;
  }
  u += wrap01(t * m->scroll[0]);
  v += wrap01(t * m->scroll[1]);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, using_wet ? wet_uv_loc : uv_loc, sx, sy, u,
                v);
}

static void draw_one(unsigned i, bool mirror, unsigned lod,
                     const DrawPlan *plan) {
  AtlasDraw *d = &draws[i];
  AtlasMaterial *m = &materials[d->material];
  if (d->lod[lod].count == 0)
    return;
  bool wet = reflection_enabled() && !mirror && (m->flags & MAT_WET);
  if (m->flags & MAT_WATER)
    water_program();
  else
    surface_program(wet);
  int material_key = (int)(d->material * 2 + mirror);
  model_uniform(d->node == UINT32_MAX ? ident : matrices + d->node * 12,
                mirror);
  if (last_material != material_key) {
    last_material = material_key;
    float color_scale = wet || using_water ? 1.0f : 1.0f / 255.0f;
    float gain = exposure_gain;
    if (m->track != UINT32_MAX) {
      float f = fmodf(atlas.time * head->fps, (float)head->frames);
      unsigned a = (unsigned)f, b = (a + 1) % head->frames;
      const float *track =
          (const float *)((const uint8_t *)animation + m->track);
      gain *= powf(fmaxf(0, track[a] * (1 - (f - a)) + track[b] * (f - a)),
                   1.0f / 2.2f);
    }
    C3D_FVUnifSet(GPU_VERTEX_SHADER, tint_loc, color_scale * gain,
                  color_scale * gain, color_scale * gain,
                  m->alpha * color_scale);
    C3D_CullFace((m->flags & MAT_TWO_SIDED) ? GPU_CULL_NONE
                 : mirror                   ? GPU_CULL_FRONT_CCW
                                            : GPU_CULL_BACK_CCW);
    C3D_TexBind(wet ? 1 : 0,
                m->texture == UINT32_MAX ? &white : &textures[m->texture]);
    if (using_water) {
      C3D_TexBind(1, m->texture == UINT32_MAX ? &white : &textures[m->texture]);
      C3D_FVUnifSet(GPU_VERTEX_SHADER, waves0_loc, m->waves[0],
                    wrap01(atlas.time * m->waves[1] * m->waves[0]),
                    wrap01(atlas.time * m->waves[2] * m->waves[0]), 0);
      C3D_FVUnifSet(GPU_VERTEX_SHADER, waves1_loc, m->waves[3],
                    wrap01(atlas.time * m->waves[4] * m->waves[3]),
                    wrap01(atlas.time * m->waves[5] * m->waves[3]), 0);
      C3D_FVUnifSet(GPU_VERTEX_SHADER, water_params_loc, m->wave_mask,
                    m->distance_roughness, m->wave_scale, 0);
    } else
      material_uv(m);
    if (wet)
      C3D_FVUnifSet(GPU_VERTEX_SHADER, wet_loc, 0.12f + m->wet * 0.35f, 0.48f,
                    0.12f, 0);
    C3D_AlphaTest((m->flags & MAT_CUTOUT) != 0, GPU_GREATER,
                  (int)(fmaxf(m->cutout, 0.3f) * 255));
    C3D_FogGasMode((m->flags & MAT_FOG) ? GPU_FOG : GPU_NO_FOG,
                   GPU_PLAIN_DENSITY, false);
    bool blend = (m->flags & (MAT_BLEND | MAT_ADD)) || m->alpha < 0.999f;
    C3D_DepthTest(true, GPU_GEQUAL,
                  mirror || ((m->flags & MAT_DEPTH) && !(m->flags & MAT_GLASS))
                      ? GPU_WRITE_ALL
                      : GPU_WRITE_COLOR);
    C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD,
                   blend ? GPU_SRC_ALPHA : GPU_ONE,
                   (m->flags & MAT_ADD) ? GPU_ONE
                   : blend              ? GPU_ONE_MINUS_SRC_ALPHA
                                        : GPU_ZERO,
                   GPU_ONE, GPU_ZERO);
  }
  unsigned count = plan ? plan->count : d->lod[lod].count;
  attributes(plan               ? plan->vertices
             : skin_vertices[i] ? (void *)skin_vertices[i]
                                : geometry + d->vertices);
  C3D_DrawElements(GPU_TRIANGLES, count, C3D_UNSIGNED_SHORT,
                   plan ? plan->indices : geometry + d->lod[lod].offset);
  {
    if (mirror) {
      atlas.reflect_draws++;
      atlas.reflect_triangles += count / 3;
    } else {
      atlas.draws++;
      atlas.triangles += count / 3;
    }
  }
}
static void vertex(AtlasVertex *v, float x, float y, float z, float u, float t,
                   uint32_t c) {
  v->position[0] = x;
  v->position[1] = y;
  v->position[2] = z;
  v->uv[0] = u;
  v->uv[1] = t;
  memcpy(v->color, &c, 4);
}
static void quad(const float *p, float rx, float ry, float rz, float ux,
                 float uy, float uz, uint32_t color) {
  if (fx_count + 6 > MAX_FX)
    return;
  AtlasVertex *v = fx + fx_count;
  fx_count += 6;
  vertex(v, p[0] - rx - ux, p[1] - ry - uy, p[2] - rz - uz, 0, 0, color);
  vertex(v + 1, p[0] + rx - ux, p[1] + ry - uy, p[2] + rz - uz, 1, 0, color);
  vertex(v + 2, p[0] + rx + ux, p[1] + ry + uy, p[2] + rz + uz, 1, 1, color);
  v[3] = v[0];
  v[4] = v[2];
  vertex(v + 5, p[0] - rx + ux, p[1] - ry + uy, p[2] - rz + uz, 0, 1, color);
}
static void fx_draw(unsigned begin, C3D_Tex *tex, bool additive, bool depth) {
  if (fx_count == begin)
    return;
  surface_program(false);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, uv_loc, 1, 1, 0, 0);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_TexBind(0, tex);
  C3D_AlphaTest(false, GPU_ALWAYS, 0);
  C3D_FogGasMode(GPU_NO_FOG, GPU_PLAIN_DENSITY, false);
  C3D_DepthTest(depth, GPU_GEQUAL, GPU_WRITE_COLOR);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                 additive ? GPU_ONE : GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE,
                 GPU_ZERO);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, tint_loc, exposure_gain / 255,
                exposure_gain / 255, exposure_gain / 255, 1.0f / 255);
  model_uniform(ident, false);
  GSPGPU_FlushDataCache(fx + begin, (fx_count - begin) * sizeof(AtlasVertex));
  attributes(fx + begin);
  C3D_DrawArrays(GPU_TRIANGLES, 0, fx_count - begin);
}
static bool dry_at(float x, float y, float z) {
  for (unsigned i = 0; i < head->dry_boxes; i++)
    if (x > dry[i].min[0] && x < dry[i].max[0] && y > dry[i].min[1] &&
        y < dry[i].max[1] && z > dry[i].min[2] && z < dry[i].max[2])
      return true;
  return false;
}
static float random01(unsigned v) {
  v ^= v >> 16;
  v *= 0x7feb352d;
  v ^= v >> 15;
  v *= 0x846ca68b;
  v ^= v >> 16;
  return (v & 0xffffff) / 16777216.0f;
}
static void effects(void) {
  float r[3] = {view.r[0].x, view.r[0].y, view.r[0].z},
        u[3] = {view.r[1].x, view.r[1].y, view.r[1].z};
  unsigned start = fx_count;
  if ((atlas.haze && (head->features & SCENE_HAZE)) || glow_enabled) {
    for (unsigned i = 0; i < head->lights; i++) {
      AtlasLight *l = &lights[i];
      float dx = l->position[0] - atlas.position[0],
            dy = l->position[1] - atlas.position[1],
            dz = l->position[2] - atlas.position[2];
      float dist = sqrtf(dx * dx + dy * dy + dz * dz);
      if (dist > 90 || dist < 0.25f)
        continue;
      float size = fminf(
          l->radius *
              ((atlas.haze && (head->features & SCENE_HAZE)) ? 0.5f : 0.12f),
          4.0f);
      float alpha = clampf(l->intensity * 0.006f, 0.015f, 0.10f);
      uint32_t col = rgba(l->color[0], l->color[1], l->color[2], alpha);
      quad(l->position, r[0] * size, r[1] * size, r[2] * size, u[0] * size,
           u[1] * size, u[2] * size, col);
    }
    fx_draw(start, &glow, true, true);
  }
  start = fx_count;
  if (atlas.rain && head->rain > 0) {
    unsigned counts[] = {850, 600, 400, 250, 150};
    unsigned count = counts[atlas.step];
    for (unsigned i = 0; i < count; i++) {
      float p[3] = {atlas.position[0] + random01(i * 3 + 1) * 28 - 14, 0,
                    atlas.position[2] + random01(i * 3 + 3) * 28 - 14};
      p[1] = fmodf(random01(i * 3 + 2) * 18 + 18 -
                       fmodf(atlas.time * (7 + random01(i + 100) * 4), 18),
                   18);
      if (dry_at(p[0], p[1], p[2]))
        continue;
      float dist =
          sqrtf((p[0] - atlas.position[0]) * (p[0] - atlas.position[0]) +
                (p[2] - atlas.position[2]) * (p[2] - atlas.position[2]));
      float alpha = 0.20f * (1 - clampf(dist / 20, 0, 1));
      float len = 0.10f + random01(i + 300) * 0.16f;
      quad(p, r[0] * 0.010f, r[1] * 0.010f, r[2] * 0.010f, -0.02f, len, 0,
           rgba(0.46f, 0.62f, 0.75f, alpha));
    }
    fx_draw(start, &white, true, true);
  }
}
static int compare_transparent(const void *a, const void *b) {
  float d =
      distance_draw[*(const uint32_t *)a] - distance_draw[*(const uint32_t *)b];
  return d > 0 ? -1 : d < 0 ? 1 : 0;
}
C3D_RenderTarget *scene_reflection_target(void) { return reflection_target; }
static unsigned make_plan(DrawPlan *out, const uint16_t *list, unsigned n,
                          const int8_t *lods) {
  unsigned result = 0;
  for (unsigned j = 0; j < n;) {
    unsigned i = list[j], g = draw_group[i], end = j + 1,
             total = draws[i].lod[lods[i]].count;
    while (end < n && draw_group[list[end]] == g) {
      total += draws[list[end]].lod[lods[list[end]]].count;
      end++;
    }
    DrawPlan p = {i, lods[i], draws[i].lod[lods[i]].count,
                  skin_vertices[i] ? (void *)skin_vertices[i]
                                   : geometry + draws[i].vertices,
                  geometry + draws[i].lod[lods[i]].offset};
    if (end > j + 1 && batch_used + total <= BATCH_INDICES) {
      unsigned base = draws[group_first[g]].vertices;
      uint16_t *dst = batch_indices[batch_frame] + batch_used;
      p.count = total;
      p.vertices = geometry + base;
      p.indices = dst;
      for (unsigned k = j; k < end; k++) {
        AtlasDraw *d = &draws[list[k]];
        AtlasLod *l = &d->lod[lods[list[k]]];
        const uint16_t *src = (const uint16_t *)(geometry + l->offset);
        unsigned offset = (d->vertices - base) / sizeof(AtlasVertex);
        for (unsigned v = 0; v < l->count; v++)
          *dst++ = src[v] + offset;
      }
      batch_used += total;
      j = end;
    } else
      j++;
    out[result++] = p;
  }
  return result;
}
// Preparation touches only CPU data and the alternate skin buffer. The GPU
// can finish the preceding frame while ARM11 computes this frame's geometry.
void scene_prepare(void) {
  u64 start = svcGetSystemTick();
  AtlasVertex **old = skin_vertices;
  skin_vertices = skin_back;
  skin_back = old;
  atlas.draws = atlas.triangles = atlas.reflect_draws =
      atlas.reflect_triangles = atlas.culled = 0;
  camera();
  opaque_count = mirror_count = visible_count = 0;
  for (unsigned i = 0; i < head->draws; i++) {
    AtlasDraw *d = &draws[i];
    AtlasMaterial *m = &materials[d->material];
    world_bounds[i][3] = bounds(i, world_bounds[i]);
    float dist;
    main_lods[i] = mirror_lods[i] = -1;
    if (visible(i, false, &dist)) {
      unsigned lod = select_lod(d, false, dist);
      if (d->lod[lod].count) {
        main_lods[i] = lod;
        if (m->flags & (MAT_BLEND | MAT_ADD | MAT_GLASS)) {
          distance_draw[i] = dist;
          visible_draws[visible_count++] = i;
        } else
          opaque_draws[opaque_count++] = i;
      }
    } else
      atlas.culled++;
    if (reflection_enabled() && !d->no_reflect &&
        !(m->flags & (MAT_WET | MAT_GLASS | MAT_BLEND | MAT_WATER)) &&
        visible(i, true, &dist) && dist <= 65 - atlas.step * 8) {
      unsigned lod = 3;
      if (d->lod[lod].count) {
        mirror_lods[i] = lod;
        mirror_draws[mirror_count++] = i;
      }
    }
  }
  qsort(visible_draws, visible_count, sizeof(uint32_t), compare_transparent);
  batch_frame ^= 1;
  batch_used = 0;
  u64 skin_start = svcGetSystemTick();
  atlas.skinned_vertices = 0;
  for (unsigned i = 0; i < head->draws; i++)
    if (skin_vertices[i] && (main_lods[i] >= 0 || mirror_lods[i] >= 0))
      skin(i, main_lods[i], mirror_lods[i]);
  atlas.skin_ms = (svcGetSystemTick() - skin_start) * 1000.0f / SYSCLOCK_ARM11;
  main_plan_count = make_plan(main_plan, opaque_draws, opaque_count, main_lods);
  mirror_plan_count =
      make_plan(mirror_plan, mirror_draws, mirror_count, mirror_lods);
  GSPGPU_FlushDataCache(batch_indices[batch_frame],
                        batch_used * sizeof(uint16_t));
  atlas.prepare_ms = (svcGetSystemTick() - start) * 1000.0f / SYSCLOCK_ARM11;
}
static void render_sky(void) {
  if (!sky_vertices)
    return;
  common_state();
  float centered[12] = {1, 0, 0, atlas.position[0], 0, 1, 0, atlas.position[1],
                        0, 0, 1, atlas.position[2]};
  model_uniform(centered, false);
  C3D_CullFace(GPU_CULL_NONE);
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
  C3D_AlphaTest(false, GPU_ALWAYS, 0);
  C3D_FogGasMode(GPU_NO_FOG, GPU_PLAIN_DENSITY, false);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, tint_loc, exposure_gain / 255,
                exposure_gain / 255, exposure_gain / 255, 1.0f / 255);
  attributes(sky_vertices);
  C3D_TexBind(0, &textures[head->sky_texture]);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ZERO, GPU_ONE,
                 GPU_ZERO);
  C3D_DrawArrays(GPU_TRIANGLES, 0, SKY_VERTICES);
  atlas.draws++;
  atlas.triangles += SKY_VERTICES / 3;
  if (head->cloud_texture != UINT32_MAX) {
    C3D_FVUnifSet(GPU_VERTEX_SHADER, uv_loc, 1, 1,
                  wrap01(atlas.time * head->cloud_drift), 0);
    C3D_TexBind(0, &textures[head->cloud_texture]);
    // New RGBA8 cloud panoramas are premultiplied after the HDR grade.
    // Retain compatibility with previously cached straight-alpha RGBA4 skies.
    bool premultiplied = texture_info[head->cloud_texture].format == GPU_RGBA8;
    C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD,
                   premultiplied ? GPU_ONE : GPU_SRC_ALPHA,
                   GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ZERO);
    C3D_DrawArrays(GPU_TRIANGLES, 0, SKY_VERTICES);
    atlas.draws++;
    atlas.triangles += SKY_VERTICES / 3;
  }
  common_state();
}

void scene_render(C3D_RenderTarget *target) {
  u64 render_start = svcGetSystemTick();
  fx_count = 0;
  common_state();
  // Clear uses RGBA byte order, unlike TEV packed ABGR constants.
  uint32_t bg = ((uint32_t)(head->horizon[0] * 255) << 24) |
                ((uint32_t)(head->horizon[1] * 255) << 16) |
                ((uint32_t)(head->horizon[2] * 255) << 8) | 255;
  C3D_RenderTargetClear(target, C3D_CLEAR_ALL, bg, 0);
  C3D_FrameDrawOn(target);
  if (reflection_enabled()) {
    reflection_vp = vp;
    C3D_RenderTargetClear(reflection_target, C3D_CLEAR_ALL, bg, 0);
    C3D_FrameDrawOn(reflection_target);
    for (unsigned j = 0; j < mirror_plan_count; j++) {
      DrawPlan *p = &mirror_plan[j];
      draw_one(p->draw, true, p->lod, p);
    }
    C3D_FrameDrawOn(target);
  }
  render_sky();
  for (unsigned j = 0; j < main_plan_count; j++) {
    DrawPlan *p = &main_plan[j];
    draw_one(p->draw, false, p->lod, p);
  }
  for (unsigned j = 0; j < visible_count; j++) {
    unsigned i = visible_draws[j];
    draw_one(i, false, main_lods[i], NULL);
  }
  effects();
  atlas.submit_ms =
      (svcGetSystemTick() - render_start) * 1000.0f / SYSCLOCK_ARM11;
}
static const char *field(const char *json, const char *name) {
  char pattern[64];
  snprintf(pattern, sizeof pattern, "\"%s\"", name);
  const char *p = strstr(json, pattern);
  if (!p)
    return NULL;
  p += strlen(pattern);
  while (*p == ' ')
    p++;
  if (*p++ != ':')
    return NULL;
  while (*p == ' ')
    p++;
  return p;
}
static bool boolean(const char *json, const char *key, bool *v) {
  const char *s = field(json, key);
  if (!s)
    return false;
  if (strncmp(s, "true", 4) == 0) {
    *v = true;
    return true;
  }
  if (strncmp(s, "false", 5) == 0) {
    *v = false;
    return true;
  }
  return false;
}
void scene_control(const char *json) {
  last_control = osGetTime();
  if (!head)
    return;
  const char *s;
  if ((s = field(json, "shot"))) {
    unsigned n = (unsigned)strtoul(s, NULL, 10);
    if (*s == '\"') {
      for (unsigned i = 0; i < head->shots; i++)
        if (strncmp(s + 1, shots[i].name, strlen(shots[i].name)) == 0) {
          n = i;
          break;
        }
    }
    if (n < head->shots)
      set_shot(n, true);
  }
  if ((s = field(json, "shotPhase"))) {
    char *end;
    float phase = strtof(s, &end);
    if (end != s && isfinite(phase))
      shot_time = shots[atlas.shot].duration * clampf(phase, 0, 1);
  }
  if ((s = field(json, "step"))) {
    long n = strtol(s, NULL, 10);
    if (n >= 0 && n < 5)
      atlas.step = n;
  }
  if ((s = field(json, "lodFloor"))) {
    long n = strtol(s, NULL, 10);
    if (n >= 0 && n <= 3) {
      configured_lod_floor = n;
      apply_lod_floor();
    }
  }
  if ((s = field(json, "detailRange"))) {
    float n = strtof(s, NULL);
    if (isfinite(n) && n >= 0 && n <= 30)
      detail_range = n;
  }
  if ((s = field(json, "time"))) {
    float t = strtof(s, NULL);
    if (isfinite(t) && t >= 0 && t < 100000)
      freeze_time = t;
  }
  bool play = false;
  if (boolean(json, "play", &play) && play)
    freeze_time = -1;
  bool measure = false;
  if (boolean(json, "measure", &measure) && measure) {
    measured_frames = 0;
    measured_ms = 0;
    measured_max = work_max = 0;
    memset(frame_hist, 0, sizeof frame_hist);
  }
  boolean(json, "cameraHold", &camera_hold);
  boolean(json, "inputLock", &input_lock);
  boolean(json, "hold", &atlas.hold);
  boolean(json, "reflection", &atlas.reflection);
  boolean(json, "rain", &atlas.rain);
  boolean(json, "haze", &atlas.haze);
  boolean(json, "glow", &glow_enabled);
  boolean(json, "bloom", &glow_enabled);
  boolean(json, "hud", &hud_enabled);
  if ((s = field(json, "exposure"))) {
    float n = strtof(s, NULL);
    if (isfinite(n)) {
      exposure_ev = clampf(n, -2, 2);
      exposure_gain = powf(2, exposure_ev / 2.2f);
    }
  }
  bool cinematic = atlas.cinematic;
  if (boolean(json, "cinematic", &cinematic)) {
    if (!cinematic)
      free_camera();
    else
      atlas.cinematic = true;
  }
}
void scene_status(char *out, size_t capacity) {
#ifndef ATLAS_BUILD_ID
#define ATLAS_BUILD_ID "development"
#endif
  snprintf(
      out, capacity,
      "{\"t\":\"atlas.status\",\"build\":\"%s\",\"phase\":\"%s\",\"frame\":%lu,"
      "\"shot\":\"%"
      "s\",\"step\":%lu,\"lodFloor\":%lu,\"lodSetting\":%u,\"hold\":%s,"
      "\"frameMs\":%.3f,"
      "\"cpuMs\":%.3f,\"skinMs\":%.3f,\"updateMs\":%.3f,\"submitMs\":%.3f,"
      "\"prepareMs\":%.3f,\"skinnedVertices\":%lu,\"gpuMs\":%.3f,\"time\":%."
      "3f,\"draws\":%lu,\"triangles\":%lu,\"reflectionDraws\":%lu,"
      "\"reflectionTriangles\":%lu,"
      "\"culled\":%lu,\"reflection\":%s,\"rain\":%s,\"haze\":%s,\"position\":[%"
      ".3f,%.3f,%.3f],"
      "\"textureBytes\":%lu,\"geometryBytes\":%lu,\"animationBytes\":%lu,"
      "\"linearFree\":%lu,"
      "\"vramFree\":%lu,\"measuredFrames\":%u,\"frameMean\":%.3f,\"frameP95\":%"
      ".3f,\"frameMax\":%.3f,\"workMax\":%.3f,\"inputLock\":%s,\"stick\":[%d,%"
      "d]}",
      ATLAS_BUILD_ID, atlas_stage, (unsigned long)atlas.frame,
      shots ? shots[atlas.shot].name : "loading", (unsigned long)atlas.step,
      (unsigned long)atlas.lod_floor, configured_lod_floor,
      atlas.hold ? "true" : "false", atlas.frame_ms, atlas.cpu_ms,
      atlas.skin_ms, atlas.update_ms, atlas.submit_ms, atlas.prepare_ms,
      (unsigned long)atlas.skinned_vertices, atlas.gpu_ms, atlas.time,
      (unsigned long)atlas.draws, (unsigned long)atlas.triangles,
      (unsigned long)atlas.reflect_draws,
      (unsigned long)atlas.reflect_triangles, (unsigned long)atlas.culled,
      atlas.reflection ? "true" : "false", atlas.rain ? "true" : "false",
      atlas.haze ? "true" : "false", atlas.position[0], atlas.position[1],
      atlas.position[2], (unsigned long)atlas.texture_bytes,
      (unsigned long)atlas.geom_bytes, (unsigned long)atlas.animation_bytes,
      (unsigned long)linearSpaceFree(), (unsigned long)vramSpaceFree(),
      measured_frames, measured_frames ? measured_ms / measured_frames : 0,
      frame_percentile(.95f), measured_max, work_max,
      input_lock ? "true" : "false", stick_x, stick_y);
}
void scene_hud(void) {
  if (!head)
    return;
  DevserverSnapshot dev;
  devserver_snapshot(&dev);
  if (hud_first) {
    consoleClear();
    printf("\x1b[H\x1b[36mPOCKET ATLAS\x1b[0m     Nintendo 3DS\n\n\n\n");
    for (unsigned i = 0; i < head->shots; i++)
      printf("  %-28s\n", shots[i].name);
    printf("\nCircle pad: look  D-pad: move\n");
    printf("Touch / drag here to look around\n\n");
    printf("A next shot   B camera   L/R height\nX auto/hold   Y quality  "
           "SELECT settings\nSTART atlas   L+R+START exit\n");
    printf("\x1b[23;1H%s:%u", dev.ip, dev.port);
  }
  if (!hud_enabled) {
    if (hud_first) {
      printf("\x1b[2;1HPerformance overlay off\n");
      hud_first = false;
    }
    return;
  }
  // Redrawing the entire console cost several milliseconds on Old 3DS.
  // Static instructions stay resident; refresh only three telemetry rows.
  printf("\x1b[2;1H%5.1f fps %5.1f ms  quality %lu %s  \n",
         1000.0f / fmaxf(smooth_frame, 1), smooth_frame,
         (unsigned long)atlas.step, atlas.hold ? "HOLD" : "AUTO");
  printf("CPU %5.1f  GPU %5.1f ms             \n", atlas.cpu_ms, atlas.gpu_ms);
  printf("%-15s %6lu triangles      ",
         atlas.cinematic ? "Cinematic" : "Free camera",
         (unsigned long)atlas.triangles);
  if (hud_previous_shot != atlas.shot) {
    if (hud_previous_shot >= 0)
      printf("\x1b[%d;1H ", 5 + hud_previous_shot);
    printf("\x1b[%d;1H>", 5 + atlas.shot);
    hud_previous_shot = atlas.shot;
  }
  unsigned effects = atlas.rain | (atlas.haze << 1) | (atlas.reflection << 2);
  if (hud_first || effects != hud_previous_effects) {
    printf("\x1b[21;1HRain %s  Haze %s  Reflection %s    ",
           !(head->features & SCENE_RAIN) ? "--"
           : atlas.rain                   ? "on"
                                          : "off",
           !(head->features & SCENE_HAZE) ? "--"
           : atlas.haze                   ? "on"
                                          : "off",
           !(head->features & SCENE_REFLECTION) ? "--"
           : atlas.reflection                   ? "on"
                                                : "off");
    hud_previous_effects = effects;
  }
  if (hud_first || dev.connected != hud_last_connected) {
    printf("\x1b[24;1H%-12s", dev.connected ? "CONNECTED" : "ready");
    hud_last_connected = dev.connected;
  }
  hud_first = false;
}
void scene_free(void) {
  // main parks the program and binds resident textures before releasing a
  // drawn scene. Citro3D's public TexBind API does not accept NULL.
  AtlasSettings saved;
  scene_settings_get(&saved);
  if (head && textures) {
    for (unsigned i = 0; i < head->textures; i++)
      if (textures[i].data)
        pocket_pica_texture_destroy(&textures[i]);
  }
  if (head && skin_vertices) {
    for (unsigned i = 0; i < head->draws; i++)
      if (skin_vertices[i])
        linearFree(skin_vertices[i]);
  }
  if (head && skin_back) {
    for (unsigned i = 0; i < head->draws; i++)
      if (skin_back[i])
        linearFree(skin_back[i]);
  }
  if (reflection_target)
    C3D_RenderTargetDelete(reflection_target);
  if (reflection_tex.data)
    C3D_TexDelete(&reflection_tex);
  if (puddle_tex.data)
    C3D_TexDelete(&puddle_tex);
  if (wet_dvlb) {
    shaderProgramFree(&wet_shader);
    DVLB_Free(wet_dvlb);
  }
  if (water_dvlb) {
    shaderProgramFree(&water_shader);
    DVLB_Free(water_dvlb);
  }
  if (sky_vertices)
    linearFree(sky_vertices);
  if (white.data)
    C3D_TexDelete(&white);
  if (glow.data)
    C3D_TexDelete(&glow);
  if (dvlb) {
    shaderProgramFree(&shader);
    DVLB_Free(dvlb);
  }
  if (fx)
    linearFree(fx);
  if (geometry)
    linearFree(geometry);
  for (unsigned i = 0; i < 2; i++)
    if (batch_indices[i])
      linearFree(batch_indices[i]);
  free(textures);
  free(skin_vertices);
  free(skin_back);
  free(matrices);
  free(animation);
  free(table);
  head = NULL;
  shots = NULL;
  textures = NULL;
  skin_vertices = skin_back = NULL;
  table = geometry = NULL;
  animation = matrices = NULL;
  fx = NULL;
  batch_indices[0] = batch_indices[1] = NULL;
  dvlb = wet_dvlb = water_dvlb = NULL;
  sky_vertices = NULL;
  reflection_target = NULL;
  memset(&white, 0, sizeof white);
  memset(&glow, 0, sizeof glow);
  memset(&puddle_tex, 0, sizeof puddle_tex);
  memset(&reflection_tex, 0, sizeof reflection_tex);
  texture_info = NULL;
  materials = NULL;
  draws = NULL;
  lights = NULL;
  dry = NULL;
  weights = NULL;
  memset(local_half, 0, sizeof local_half);
  memset(world_bounds, 0, sizeof world_bounds);
  memset(&shader, 0, sizeof shader);
  memset(&wet_shader, 0, sizeof wet_shader);
  memset(&water_shader, 0, sizeof water_shader);
  memset(&atlas, 0, sizeof atlas);
  scene_settings_set(&saved);
  atlas.fov = 45;
  shot_time = yaw = pitch = 0;
  freeze_time = -1;
  camera_hold = input_lock = touching = ui_input_block = false;
  last_control = 0;
  stick_x = stick_y = touch_x = touch_y = 0;
  smooth_frame = 33.3f;
  visible_count = opaque_count = mirror_count = main_plan_count =
      mirror_plan_count = 0;
  batch_frame = batch_used = fx_count = 0;
  using_wet = using_water = false;
  last_model = NULL;
  last_material = -1;
  last_mirror = false;
  measured_frames = 0;
  measured_ms = measured_max = work_max = 0;
  memset(frame_hist, 0, sizeof frame_hist);
  detail_range = 6;
}
