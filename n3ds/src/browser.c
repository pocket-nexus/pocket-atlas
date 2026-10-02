#include "browser.h"
#include "browser_shbin.h"
#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_PLACES 64
#define MAX_TEXTURES (MAX_PLACES + 3)
#define SPHERE_U 64
#define SPHERE_V 32
#define SPHERE_VERTS ((SPHERE_U + 1) * (SPHERE_V + 1))
#define UI_VERTS 16384
#define SAVE_PATH "sdmc:/pocket-atlas/saved.json"

typedef struct {
  char magic[4];
  u32 version, count, places, glyph_count, glyphs, font_w, font_h, font,
      font_size, texture_count, textures, data, bytes;
  float start_lat, start_lon, idle_speed, cloud_speed, sun[3];
  u32 reserved[3];
} Header;
typedef struct {
  u32 text[12];
  float lat, lon;
  u32 flags, accent;
  s32 preview;
} Place;
typedef struct {
  u32 cp;
  u16 x, y, w, h;
  s16 left, top;
  float advance;
} Glyph;
typedef struct {
  u32 w, h, format, offset, bytes, reserved[3];
} Texture;
typedef struct {
  float x, y, z, u, v;
  u8 color[4];
} Vertex;
_Static_assert(sizeof(Header) == 96, "browser header layout");
_Static_assert(sizeof(Place) == 68, "browser place layout");
_Static_assert(sizeof(Glyph) == 20, "browser glyph layout");
_Static_assert(sizeof(Texture) == 32, "browser texture layout");
_Static_assert(sizeof(Vertex) == 24, "PICA attribute stride");

enum {
  ID,
  NAME,
  NATIVE,
  LOCALITY,
  LOCAL_NATIVE,
  COUNTRY,
  WEATHER,
  AUTHOR,
  KIND,
  TAGS,
  SUMMARY,
  ZONE
};
static const char *tabs[] = {"FEATURED", "EXPLORE", "SAVED", "SEARCH"};
static u8 *metadata;
static Header *head;
static Place *places;
static Glyph *glyphs;
static u8 *font;
static C3D_Tex textures[MAX_TEXTURES], font_texture, white;
static unsigned texture_loaded;
static DVLB_s *dvlb;
static shaderProgram_s shader;
static int projection_loc;
static C3D_Mtx projection;
static Vertex *sphere, *ui_vertices;
static float (*sphere_points)[3];
static float ring_cos[33], ring_sin[33];
static u16 *indices;
static unsigned ui_count, sphere_count;
static bool ready, initialized, dirty = true, detail, keyboard;
static unsigned tab, list[MAX_PLACES], count, focus, frame;
static char focus_id[64], enter_id[64], query[193];
static char saved[MAX_PLACES][64];
static unsigned saved_count;
static float lat, lon, goal_lat, goal_lon, zoom = 1, idle, elapsed, toast_time;
static bool turning;
static char toast[128];
static touchPosition touch_start;
static bool touching;
static int detail_scroll, detail_max, clip_top, clip_bottom = 240;

static float clampf(float v, float lo, float hi) {
  return fmaxf(lo, fminf(hi, v));
}
static float wrap(float v) { return v - 360 * floorf((v + 180) / 360); }
static const char *str(const Place *p, unsigned field) {
  return (char *)metadata + p->text[field];
}
static Place *selected(void) {
  return count && focus < count ? &places[list[focus]] : NULL;
}
static unsigned morton(unsigned x, unsigned y, unsigned w) {
  return ((y / 8) * (w / 8) + x / 8) * 64 + (x & 1) + ((y & 1) << 1) +
         ((x & 2) << 1) + ((y & 2) << 2) + ((x & 4) << 2) + ((y & 4) << 3);
}
static bool range(u32 off, u32 bytes, u32 limit) {
  return off <= limit && bytes <= limit - off;
}
static void notify(const char *message) {
  snprintf(toast, sizeof toast, "%s", message);
  toast_time = 2.4f;
  dirty = true;
}
static const Glyph *glyph(u32 cp) {
  if (!head)
    return NULL;
  unsigned lo = 0, hi = head->glyph_count;
  while (lo < hi) {
    unsigned mid = (lo + hi) / 2;
    if (glyphs[mid].cp < cp)
      lo = mid + 1;
    else
      hi = mid;
  }
  if (lo < head->glyph_count && glyphs[lo].cp == cp)
    return &glyphs[lo];
  return cp == '?' ? NULL : glyph('?');
}
static u32 utf8(const char **p) {
  const u8 *s = (const u8 *)*p;
  if (!*s)
    return 0;
  u32 cp = *s++;
  unsigned extra = 0;
  if (cp >= 0xf0 && cp < 0xf5) {
    cp &= 7;
    extra = 3;
  } else if (cp >= 0xe0 && cp < 0xf0) {
    cp &= 15;
    extra = 2;
  } else if (cp >= 0xc2 && cp < 0xe0) {
    cp &= 31;
    extra = 1;
  } else if (cp >= 128)
    cp = '?';
  for (unsigned i = 0; i < extra; i++) {
    if ((*s & 0xc0) != 0x80) {
      cp = '?';
      break;
    }
    cp = (cp << 6) | (*s++ & 63);
  }
  *p = (const char *)s;
  return cp;
}
static bool drawable(const char *text) {
  if (!*text)
    return false;
  while (*text) {
    u32 cp = utf8(&text);
    const Glyph *g = glyph(cp);
    if (!g || g->cp != cp)
      return false;
  }
  return true;
}
static const char *native_name(const Place *p) {
  return drawable(str(p, NATIVE)) ? str(p, NATIVE) : str(p, NAME);
}
static void encode(char *out, size_t cap, size_t *at, u32 cp) {
  u8 b[4];
  unsigned n;
  if (cp < 128) {
    b[0] = cp;
    n = 1;
  } else if (cp < 2048) {
    b[0] = 0xc0 | (cp >> 6);
    b[1] = 0x80 | (cp & 63);
    n = 2;
  } else if (cp < 65536) {
    b[0] = 0xe0 | (cp >> 12);
    b[1] = 0x80 | ((cp >> 6) & 63);
    b[2] = 0x80 | (cp & 63);
    n = 3;
  } else {
    b[0] = 0xf0 | (cp >> 18);
    b[1] = 0x80 | ((cp >> 12) & 63);
    b[2] = 0x80 | ((cp >> 6) & 63);
    b[3] = 0x80 | (cp & 63);
    n = 4;
  }
  if (*at + n < cap) {
    memcpy(out + *at, b, n);
    *at += n;
    out[*at] = 0;
  }
}
static void fold(const char *in, char *out, size_t cap) {
  size_t at = 0;
  out[0] = 0;
  while (*in) {
    u32 cp = utf8(&in);
    if (cp >= 'A' && cp <= 'Z')
      cp += 32;
    else if ((cp >= 0xc0 && cp <= 0xd6) || (cp >= 0xd8 && cp <= 0xde))
      cp += 32;
    else if (cp == 0x130)
      cp = 'i';
    else if ((cp >= 0x100 && cp <= 0x12f && !(cp & 1)) ||
             (cp >= 0x132 && cp <= 0x137 && !(cp & 1)) ||
             (cp >= 0x14a && cp <= 0x177 && !(cp & 1)))
      cp++;
    encode(out, cap, &at, cp);
  }
}
static const char *field(const char *json, const char *name) {
  char key[48];
  snprintf(key, sizeof key, "\"%s\"", name);
  const char *p = strstr(json, key);
  if (!p)
    return NULL;
  p = strchr(p + strlen(key), ':');
  if (!p)
    return NULL;
  do
    p++;
  while (isspace((unsigned char)*p));
  return p;
}
static bool string_value(const char *p, char *out, size_t cap) {
  if (!p || *p++ != '"' || !cap)
    return false;
  size_t at = 0;
  out[0] = 0;
  while (*p && *p != '"') {
    u32 cp;
    if (*p == '\\') {
      p++;
      cp = (u8)*p++;
      if (cp == 'n' || cp == 'r' || cp == 't')
        cp = ' ';
      else if (cp == 'u') {
        char hex[5] = {0};
        if (strlen(p) < 4)
          return false;
        memcpy(hex, p, 4);
        cp = strtoul(hex, NULL, 16);
        p += 4;
        if (cp >= 0xd800 && cp <= 0xdbff && p[0] == '\\' && p[1] == 'u' &&
            strlen(p) >= 6) {
          memcpy(hex, p + 2, 4);
          u32 low = strtoul(hex, NULL, 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
            p += 6;
          }
        }
      }
    } else
      cp = utf8(&p);
    encode(out, cap, &at, cp);
  }
  return *p == '"';
}
static int saved_index(const char *id) {
  for (unsigned i = 0; i < saved_count; i++)
    if (!strcmp(saved[i], id))
      return i;
  return -1;
}
static void read_saved(void) {
  FILE *f = fopen(SAVE_PATH, "rb");
  if (!f)
    f = fopen(SAVE_PATH ".bak", "rb");
  if (!f)
    return;
  char data[8192];
  size_t n = fread(data, 1, sizeof data - 1, f);
  fclose(f);
  data[n] = 0;
  const char *p = field(data, "saved");
  if (!p || *p++ != '[')
    return;
  while (*p && saved_count < MAX_PLACES) {
    while (isspace((u8)*p) || *p == ',')
      p++;
    char id[64];
    if (!string_value(p, id, sizeof id))
      break;
    // IDs are registry slugs, never arbitrary JSON strings or paths.
    bool valid = *id != 0;
    for (const char *q = id; *q; q++)
      if (!isalnum((u8)*q) && *q != '-' && *q != '_')
        valid = false;
    if (valid && saved_index(id) < 0)
      snprintf(saved[saved_count++], 64, "%s", id);
    p++;
    while (*p && *p != '"')
      p++;
    if (*p)
      p++;
  }
}
static bool write_saved(void) {
  mkdir("sdmc:/pocket-atlas", 0777);
  FILE *f = fopen(SAVE_PATH ".tmp", "wb");
  if (!f)
    return false;
  bool ok = fputs("{\"saved\":[", f) >= 0;
  for (unsigned i = 0; i < saved_count; i++)
    if (fprintf(f, "%s\"%s\"", i ? "," : "", saved[i]) < 0)
      ok = false;
  if (fputs("]}\n", f) < 0)
    ok = false;
  if (fclose(f))
    ok = false;
  if (!ok) {
    remove(SAVE_PATH ".tmp");
    return false;
  }
  // FAT rename does not necessarily replace an existing destination.
  // Keep one recoverable previous copy across the two directory operations.
  FILE *previous = fopen(SAVE_PATH, "rb");
  if (previous) {
    fclose(previous);
    remove(SAVE_PATH ".bak");
    if (rename(SAVE_PATH, SAVE_PATH ".bak"))
      return false;
  }
  if (rename(SAVE_PATH ".tmp", SAVE_PATH)) {
    rename(SAVE_PATH ".bak", SAVE_PATH);
    return false;
  }
  remove(SAVE_PATH ".bak");
  return true;
}
static int place_index(const char *id) {
  if (head)
    for (unsigned i = 0; i < head->count; i++)
      if (!strcmp(str(&places[i], ID), id))
        return i;
  return -1;
}
static float proximity(const Place *p) {
  float a = lat * (M_PI / 180), b = p->lat * (M_PI / 180),
        d = (lon - p->lon) * (M_PI / 180);
  return sinf(a) * sinf(b) + cosf(a) * cosf(b) * cosf(d);
}
static int score(const Place *p) {
  char words[sizeof query];
  fold(query, words, sizeof words);
  const unsigned fields[] = {NAME, NATIVE, LOCALITY, LOCAL_NATIVE, COUNTRY,
                             TAGS, KIND,   AUTHOR,   SUMMARY};
  const int weights[] = {8, 8, 6, 6, 4, 4, 3, 2, 1};
  int total = 0;
  char first_word[sizeof query] = {0};
  char *saveptr;
  for (char *word = strtok_r(words, " \t\r\n", &saveptr); word;
       word = strtok_r(NULL, " \t\r\n", &saveptr)) {
    if (!*first_word)
      snprintf(first_word, sizeof first_word, "%s", word);
    int best = 0;
    for (unsigned j = 0; j < sizeof fields / sizeof *fields; j++) {
      char value[1024];
      fold(str(p, fields[j]), value, sizeof value);
      if (fields[j] == KIND)
        for (char *k = value; *k; k++)
          if (*k == '-')
            *k = ' ';
      if (strstr(value, word) && weights[j] > best)
        best = weights[j];
    }
    if (!best)
      return 0;
    total += best;
  }
  char name[512];
  fold(str(p, NAME), name, sizeof name);
  if (*first_word && !strncmp(name, first_word, strlen(first_word)))
    total += 4;
  return total;
}
static void rebuild(bool preserve) {
  count = 0;
  if (!head)
    return;
  int scores[MAX_PLACES] = {0};
  float distances[MAX_PLACES] = {0};
  if (tab == 2) {
    for (unsigned i = 0; i < saved_count; i++) {
      int k = place_index(saved[i]);
      if (k >= 0)
        list[count++] = k;
    }
  } else
    for (unsigned i = 0; i < head->count; i++) {
      if (tab == 0 && !(places[i].flags & 2))
        continue;
      if (tab == 3 && !(scores[i] = score(&places[i])))
        continue;
      distances[i] = proximity(&places[i]);
      list[count++] = i;
    }
  if (!count && tab == 0)
    for (unsigned i = 0; i < head->count; i++)
      list[count++] = i;
  for (unsigned i = 1; i < count && tab != 2; i++) {
    unsigned k = list[i], j = i;
    while (j) {
      unsigned prev = list[j - 1];
      bool before = tab == 1 ? distances[k] > distances[prev]
                    : tab == 3
                        ? scores[k] > scores[prev] ||
                              (scores[k] == scores[prev] &&
                               (places[k].flags & 1) > (places[prev].flags & 1))
                        : (places[k].flags & 1) > (places[prev].flags & 1);
      if (!before)
        break;
      list[j--] = prev;
    }
    list[j] = k;
  }
  focus = 0;
  if (preserve)
    for (unsigned i = 0; i < count; i++)
      if (!strcmp(str(&places[list[i]], ID), focus_id))
        focus = i;
  Place *p = selected();
  if (p)
    snprintf(focus_id, sizeof focus_id, "%s", str(p, ID));
  dirty = true;
}
static void focus_changed(bool turn) {
  Place *p = selected();
  if (!p)
    return;
  snprintf(focus_id, sizeof focus_id, "%s", str(p, ID));
  if (turn) {
    goal_lat = p->lat;
    goal_lon = p->lon;
    turning = true;
    idle = 0;
  }
  detail_scroll = 0;
  dirty = true;
}
static void set_tab(unsigned t) {
  tab = t % 4;
  detail = false;
  rebuild(true);
  focus_changed(true);
}
static void select_id(const char *id) {
  int i = place_index(id);
  if (i < 0)
    return;
  bool present = false;
  for (unsigned j = 0; j < count; j++)
    if (list[j] == (unsigned)i)
      present = true;
  if (!present)
    tab = 1;
  snprintf(focus_id, sizeof focus_id, "%s", id);
  rebuild(true);
  focus_changed(true);
}
static void toggle_saved(const char *id) {
  int place = place_index(id);
  if (place < 0)
    return;
  int i = saved_index(id);
  if (i >= 0) {
    memmove(saved[i], saved[i + 1], (saved_count - i - 1) * 64);
    saved_count--;
  } else if (saved_count < MAX_PLACES) {
    memmove(saved[1], saved[0], saved_count * 64);
    snprintf(saved[0], 64, "%s", id);
    saved_count++;
  }
  bool ok = write_saved();
  notify(ok ? (i >= 0 ? "Removed from Saved" : "Saved for later")
            : "Could not save to SD card");
  if (tab == 2) {
    rebuild(true);
    focus_changed(false);
  }
}
static void enter(void) {
  Place *p = selected();
  if (!p)
    return;
  if (p->flags & 1)
    snprintf(enter_id, sizeof enter_id, "%s", str(p, ID));
  else
    notify("This place is coming soon");
}

bool browser_load(const char *path, char *error, size_t capacity) {
  browser_free();
  FILE *f = fopen(path, "rb");
  Header candidate;
  if (!f) {
    snprintf(error, capacity, "Atlas pack missing: %s", path);
    return false;
  }
  if (fread(&candidate, 1, sizeof candidate, f) != sizeof candidate ||
      memcmp(candidate.magic, "AT3B", 4) || candidate.version != 1 ||
      candidate.count > MAX_PLACES || !candidate.count ||
      candidate.texture_count > MAX_TEXTURES || candidate.texture_count < 3 ||
      candidate.data > 2 * 1024 * 1024 || candidate.data < sizeof candidate ||
      candidate.bytes < candidate.data || candidate.font_w < 8 ||
      candidate.font_w > 1024 || (candidate.font_w & (candidate.font_w - 1)) ||
      candidate.font_h < 8 || candidate.font_h > 1024 ||
      (candidate.font_h & (candidate.font_h - 1)) ||
      candidate.font_size != candidate.font_w * candidate.font_h ||
      candidate.glyph_count > 8192 ||
      !range(candidate.places, candidate.count * sizeof(Place),
             candidate.data) ||
      !range(candidate.glyphs, candidate.glyph_count * sizeof(Glyph),
             candidate.data) ||
      !range(candidate.textures, candidate.texture_count * sizeof(Texture),
             candidate.data) ||
      !range(candidate.font, candidate.font_size, candidate.data))
    goto invalid;
  free(metadata);
  metadata = malloc(candidate.data);
  head = NULL;
  if (!metadata || fseek(f, 0, SEEK_SET) ||
      fread(metadata, 1, candidate.data, f) != candidate.data)
    goto invalid;
  head = (Header *)metadata;
  places = (Place *)(metadata + head->places);
  glyphs = (Glyph *)(metadata + head->glyphs);
  font = metadata + head->font;
  for (unsigned i = 0; i < head->count; i++) {
    Place *p = &places[i];
    for (unsigned j = 0; j < 12; j++)
      if (p->text[j] >= head->data ||
          !memchr(metadata + p->text[j], 0, head->data - p->text[j]))
        goto invalid;
    if (strlen(str(p, ID)) >= sizeof focus_id || !isfinite(p->lat) ||
        !isfinite(p->lon) || p->lat < -90 || p->lat > 90 ||
        p->preview >= (int)head->texture_count)
      goto invalid;
  }
  for (unsigned i = 0; i < head->glyph_count; i++) {
    Glyph *g = &glyphs[i];
    if (g->x + g->w > head->font_w || g->y + g->h > head->font_h ||
        !isfinite(g->advance) || g->advance < 0 || g->advance > 128 ||
        (i && glyphs[i - 1].cp >= g->cp))
      goto invalid;
  }
  Texture *ts = (Texture *)(metadata + head->textures);
  for (unsigned i = 0; i < head->texture_count; i++) {
    Texture *t = &ts[i];
    if (t->w < 8 || t->w > 1024 || (t->w & (t->w - 1)) || t->h < 8 ||
        t->h > 1024 || (t->h & (t->h - 1)) || t->format > 1 ||
        t->bytes != t->w * t->h * 2 || t->offset < head->data ||
        !range(t->offset, t->bytes, head->bytes) ||
        !C3D_TexInit(&textures[i], t->w, t->h,
                     t->format ? GPU_RGBA4 : GPU_RGB565))
      goto invalid;
    texture_loaded++;
    if (fseek(f, t->offset, SEEK_SET) ||
        fread(textures[i].data, 1, t->bytes, f) != t->bytes)
      goto invalid;
    C3D_TexSetFilter(&textures[i], GPU_LINEAR, GPU_LINEAR);
    C3D_TexSetWrap(&textures[i], i < 3 ? GPU_REPEAT : GPU_CLAMP_TO_EDGE,
                   GPU_CLAMP_TO_EDGE);
    C3D_TexFlush(&textures[i]);
  }
  fclose(f);
  f = NULL;
  if (!C3D_TexInit(&font_texture, head->font_w, head->font_h, GPU_RGBA4) ||
      !C3D_TexInit(&white, 8, 8, GPU_RGBA4))
    goto invalid;
  for (unsigned y = 0; y < head->font_h; y++)
    for (unsigned x = 0; x < head->font_w; x++)
      ((u16 *)
           font_texture.data)[morton(x, head->font_h - y - 1, head->font_w)] =
          0xfff0 | (font[y * head->font_w + x] >> 4);
  memset(white.data, 255, 128);
  C3D_TexSetFilter(&font_texture, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetWrap(&font_texture, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  C3D_TexFlush(&font_texture);
  C3D_TexFlush(&white);
  sphere = linearAlloc(SPHERE_VERTS * sizeof(Vertex) * 3);
  sphere_points = malloc(SPHERE_VERTS * sizeof(*sphere_points));
  indices = linearAlloc(SPHERE_U * SPHERE_V * 6 * sizeof(u16));
  ui_vertices = linearAlloc(UI_VERTS * sizeof(Vertex));
  if (!sphere || !sphere_points || !indices || !ui_vertices)
    goto invalid;
  for (unsigned j = 0; j <= SPHERE_V; j++) {
    float a = (0.5f - (float)j / SPHERE_V) * (float)M_PI;
    float ca = cosf(a), sa = sinf(a);
    for (unsigned i = 0; i <= SPHERE_U; i++) {
      float b = ((float)i / SPHERE_U - 0.5f) * (float)(2 * M_PI);
      float *p = sphere_points[j * (SPHERE_U + 1) + i];
      p[0] = ca * sinf(b);
      p[1] = sa;
      p[2] = ca * cosf(b);
    }
  }
  for (unsigned i = 0; i <= 32; i++) {
    ring_cos[i] = cosf(i * (float)(2 * M_PI / 32));
    ring_sin[i] = sinf(i * (float)(2 * M_PI / 32));
  }
  sphere_count = 0;
  for (unsigned y = 0; y < SPHERE_V; y++)
    for (unsigned x = 0; x < SPHERE_U; x++) {
      u16 a = y * (SPHERE_U + 1) + x, b = a + 1, c = a + SPHERE_U + 1,
          d = c + 1;
      u16 six[] = {a, c, b, b, c, d};
      memcpy(indices + sphere_count, six, sizeof six);
      sphere_count += 6;
    }
  GSPGPU_FlushDataCache(indices, sphere_count * 2);
  dvlb = DVLB_ParseFile((u32 *)browser_shbin, browser_shbin_size);
  if (!dvlb)
    goto invalid;
  shaderProgramInit(&shader);
  shaderProgramSetVsh(&shader, &dvlb->DVLE[0]);
  projection_loc =
      shaderInstanceGetUniformLocation(shader.vertexShader, "projection");
  // Sphere points facing the camera have positive z, as do the markers.
  // With GEQUAL, this handedness gives depth = .5 + .5*z; the opposite
  // handedness draws the rear hemisphere through foreground markers.
  Mtx_OrthoTilt(&projection, 0, 400, 240, 0, -1, 1, false);
  if (!initialized) {
    lat = head->start_lat;
    lon = head->start_lon;
    read_saved();
    initialized = true;
  }
  rebuild(true);
  if (!*focus_id)
    focus_changed(false);
  ready = true;
  dirty = true;
  return true;
invalid:
  if (f)
    fclose(f);
  snprintf(error, capacity, "Invalid atlas pack or insufficient GPU memory");
  browser_free();
  free(metadata);
  metadata = NULL;
  head = NULL;
  glyphs = NULL;
  font = NULL;
  places = NULL;
  return false;
}
void browser_free(void) {
  ready = false;
  for (unsigned i = 0; i < texture_loaded; i++)
    C3D_TexDelete(&textures[i]);
  memset(textures, 0, sizeof textures);
  texture_loaded = 0;
  if (font_texture.data)
    C3D_TexDelete(&font_texture);
  if (white.data)
    C3D_TexDelete(&white);
  memset(&font_texture, 0, sizeof font_texture);
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
  if (ui_vertices)
    linearFree(ui_vertices);
  sphere = NULL;
  free(sphere_points);
  sphere_points = NULL;
  indices = NULL;
  ui_vertices = NULL;
  // Keep only the small catalog/coverage font, used by the scene's settings.
}
void browser_update(float dt, u32 down, u32 held) {
  if (!ready)
    return;
  elapsed += dt;
  idle += dt;
  frame++;
  if (toast_time > 0) {
    toast_time -= dt;
    if (toast_time <= 0)
      dirty = true;
  }
  circlePosition stick;
  hidCircleRead(&stick);
  float radius = hypotf(stick.dx, stick.dy),
        speed = clampf((radius - 28) / 128, 0, 1);
  bool spun = speed > 0;
  if (spun) {
    lon = wrap(lon + stick.dx / radius * speed * 60 * dt / zoom);
    lat = clampf(lat + stick.dy / radius * speed * 60 * dt / zoom, -85, 85);
    turning = false;
    idle = 0;
  }
  if (turning) {
    float k = 1 - expf(-dt * 5);
    lat += (goal_lat - lat) * k;
    lon = wrap(lon + wrap(goal_lon - lon) * k);
    if (fabsf(goal_lat - lat) + fabsf(wrap(goal_lon - lon)) < .04f)
      turning = false;
  } else if (idle > 8)
    lon = wrap(lon + head->idle_speed * dt);
  if (spun && tab == 1)
    rebuild(false);
  if (down & KEY_L)
    set_tab((tab + 3) % 4);
  if (down & KEY_R)
    set_tab((tab + 1) % 4);
  if (detail && (down & (KEY_DOWN | KEY_UP))) {
    detail_scroll += down & KEY_DOWN ? 32 : -32;
    detail_scroll = (int)clampf(detail_scroll, 0, detail_max);
    dirty = true;
  } else if (count && down & (KEY_DOWN | KEY_UP)) {
    focus = down & KEY_DOWN ? (focus + 1 < count ? focus + 1 : focus)
                            : (focus ? focus - 1 : 0);
    focus_changed(true);
  }
  if (held & KEY_LEFT) {
    zoom = clampf(zoom - dt * .6f, .7f, 1.45f);
    idle = 0;
  }
  if (held & KEY_RIGHT) {
    zoom = clampf(zoom + dt * .6f, .7f, 1.45f);
    idle = 0;
  }
  if (down & KEY_B) {
    detail = !detail;
    dirty = true;
  }
  if (down & KEY_X)
    keyboard = true;
  if (down & KEY_Y) {
    Place *p = selected();
    if (p) {
      char id[64];
      snprintf(id, sizeof id, "%s", str(p, ID));
      toggle_saved(id);
    }
  }
  if (down & KEY_A)
    enter();
  if (down & KEY_TOUCH) {
    hidTouchRead(&touch_start);
    touching = true;
  }
  if (touching && !(held & KEY_TOUCH)) {
    touching = false;
    if (touch_start.py < 28)
      set_tab(touch_start.px / 80);
    else if (!detail && touch_start.py >= 54 && touch_start.py < 190) {
      unsigned row = touch_start.py < 54 ? 0 : (touch_start.py - 54) / 34;
      unsigned first = focus > 1 ? focus - 1 : 0;
      if (first + 4 > count)
        first = count > 4 ? count - 4 : 0;
      if (first + row < count) {
        focus = first + row;
        focus_changed(true);
      }
    } else if (touch_start.py >= 214) {
      if (touch_start.px < 80)
        enter();
      else if (touch_start.px < 160)
        keyboard = true;
      else if (touch_start.px < 240) {
        Place *p = selected();
        if (p) {
          char id[64];
          snprintf(id, sizeof id, "%s", str(p, ID));
          toggle_saved(id);
        }
      } else {
        detail = !detail;
        dirty = true;
      }
    }
  }
}
const char *browser_take_enter(void) {
  static char result[64];
  if (!*enter_id)
    return NULL;
  snprintf(result, sizeof result, "%s", enter_id);
  enter_id[0] = 0;
  return result;
}
bool browser_wants_keyboard(void) { return keyboard; }
void browser_keyboard(void) {
  keyboard = false;
  SwkbdState state;
  char text[sizeof query];
  swkbdInit(&state, SWKBD_TYPE_NORMAL, 2, 64);
  swkbdSetInitialText(&state, query);
  swkbdSetHintText(&state, "Name, city, country or tag");
  swkbdSetValidation(&state, SWKBD_ANYTHING, 0, 0);
  swkbdSetFeatures(&state, SWKBD_PREDICTIVE_INPUT);
  SwkbdButton result = swkbdInputText(&state, text, sizeof text);
  if (result == SWKBD_BUTTON_CONFIRM) {
    snprintf(query, sizeof query, "%s", text);
    set_tab(3);
  }
  dirty = true;
}

static u16 rgb565(u32 c) {
  return ((c >> 8) & 0xf800) | ((c >> 5) & 0x07e0) | ((c >> 3) & 31);
}
static u16 *bottom(void) {
  return (u16 *)gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, NULL, NULL);
}
void browser_ui_rect(int x, int y, int w, int h, u32 rgb) {
  u16 *fb = bottom(), color = rgb565(rgb);
  if (!fb)
    return;
  int x1 = x + w, y1 = y + h;
  if (x < 0)
    x = 0;
  if (y < 0)
    y = 0;
  if (x1 > 320)
    x1 = 320;
  if (y1 > 240)
    y1 = 240;
  for (int xx = x; xx < x1; xx++)
    for (int yy = y; yy < y1; yy++)
      fb[xx * 240 + 239 - yy] = color;
}
void browser_ui_clear(u32 rgb) { browser_ui_rect(0, 0, 320, 240, rgb); }
int browser_ui_width(const char *s) {
  float width = 0;
  while (*s) {
    const Glyph *g = glyph(utf8(&s));
    if (g)
      width += g->advance;
  }
  return (int)ceilf(width);
}
void browser_ui_text(int x, int y, const char *s, u32 rgb) {
  if (!head || !font)
    return;
  u16 *fb = bottom();
  float pen = x;
  unsigned r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  while (*s) {
    u32 cp = utf8(&s);
    const Glyph *ch = glyph(cp);
    if (!ch)
      continue;
    int gx = (int)roundf(pen) + ch->left, gy = y + 12 + ch->top;
    for (unsigned yy = 0; yy < ch->h; yy++)
      for (unsigned xx = 0; xx < ch->w; xx++) {
        int dx = gx + xx, dy = gy + yy;
        if (dx < 0 || dx >= 320 || dy < clip_top || dy >= clip_bottom)
          continue;
        unsigned a = font[(ch->y + yy) * head->font_w + ch->x + xx];
        if (!a)
          continue;
        u16 *dest = &fb[dx * 240 + 239 - dy], old = *dest;
        unsigned inv = 255 - a;
        unsigned rr = (r * a + ((old >> 11) * 255 / 31) * inv) / 255;
        unsigned gg = (g * a + (((old >> 5) & 63) * 255 / 63) * inv) / 255;
        unsigned bb = (b * a + ((old & 31) * 255 / 31) * inv) / 255;
        *dest = (rr >> 3) << 11 | (gg >> 2) << 5 | (bb >> 3);
      }
    pen += ch->advance;
    if (pen > 320)
      break;
  }
}
static void fit(char *out, size_t cap, const char *s, int width) {
  size_t n = 0;
  float pen = 0;
  while (*s) {
    const char *start = s;
    const Glyph *g = glyph(utf8(&s));
    if (!g)
      continue;
    if (pen + g->advance > width - 10 && *s) {
      if (n + 4 < cap) {
        memcpy(out + n, "…", 3);
        n += 3;
      }
      break;
    }
    size_t bytes = s - start;
    if (n + bytes >= cap)
      break;
    memcpy(out + n, start, bytes);
    n += bytes;
    pen += g->advance;
  }
  out[n] = 0;
}
static const char *line(char *out, size_t cap, const char *s, int width) {
  const char *start = s, *space = NULL;
  size_t n = 0, space_n = 0;
  float pen = 0;
  while (*s && *s != '\n') {
    const char *before = s;
    const Glyph *g = glyph(utf8(&s));
    if (!g)
      continue;
    if (pen + g->advance > width && n) {
      s = before;
      if (space) {
        s = space;
        n = space_n;
      }
      break;
    }
    size_t bytes = s - before;
    if (n + bytes >= cap) {
      s = before;
      break;
    }
    memcpy(out + n, before, bytes);
    n += bytes;
    pen += g->advance;
    if (*before == ' ') {
      space = s;
      space_n = n - 1;
    }
  }
  out[n] = 0;
  if (s == start && *s)
    utf8(&s);
  while (*s == ' ' || *s == '\n')
    s++;
  return s;
}
int browser_ui_wrap(int x, int y, int width, const char *s, u32 rgb) {
  while (*s) {
    char row[512];
    s = line(row, sizeof row, s, width);
    browser_ui_text(x, y, row, rgb);
    y += 16;
  }
  return y;
}
void browser_hud(void) {
  if (!ready || (!dirty && frame % 30))
    return;
  dirty = false;
  browser_ui_clear(0x0c111b);
  for (unsigned t = 0; t < 4; t++) {
    if (tab == t) {
      browser_ui_rect(t * 80, 0, 80, 27, 0x202e42);
      browser_ui_rect(t * 80 + 6, 25, 68, 2, 0x7fc9e8);
    }
    browser_ui_text(t * 80 + (80 - browser_ui_width(tabs[t])) / 2, 6, tabs[t],
                    tab == t ? 0xffffff : 0x9baac0);
  }
  Place *p = selected();
  char text[512];
  if (detail && p) {
    clip_top = 31;
    clip_bottom = 195;
    int y =
        browser_ui_wrap(10, 34 - detail_scroll, 300, str(p, NAME), 0xffffff);
    browser_ui_text(10, y, native_name(p), p->accent);
    y += 20;
    snprintf(text, sizeof text, "%s · %s", str(p, LOCALITY), str(p, COUNTRY));
    y = browser_ui_wrap(10, y, 300, text, 0xc4d0df);
    y = browser_ui_wrap(10, y + 3, 300, str(p, SUMMARY), 0xc4d0df);
    snprintf(text, sizeof text, "%s · %s", str(p, KIND), str(p, TAGS));
    y = browser_ui_wrap(10, y + 4, 300, text, 0x8fb8d0);
    {
      snprintf(text, sizeof text, "%s · %s", str(p, WEATHER), str(p, AUTHOR));
      y = browser_ui_wrap(10, y + 3, 300, text, 0x94a5bb);
    }
    {
      snprintf(text, sizeof text, "%.4f°, %.4f°", p->lat, p->lon);
      browser_ui_text(10, y + 3, text, 0x8296af);
      y += 19;
    }
    detail_max = y + detail_scroll > 195 ? y + detail_scroll - 195 : 0;
    clip_top = 0;
    clip_bottom = 240;
  } else {
    if (tab == 0)
      snprintf(text, sizeof text, "Picked for you · %u places", count);
    else if (tab == 1)
      snprintf(text, sizeof text, "Nearest %.1f°, %.1f°", lat, lon);
    else if (tab == 2)
      snprintf(text, sizeof text, "%u saved places", count);
    else if (*query)
      snprintf(text, sizeof text, "%u matches: %s", count, query);
    else
      snprintf(text, sizeof text, "Search a name, city, country or tag");
    char short_text[256];
    fit(short_text, sizeof short_text, text, 300);
    browser_ui_text(10, 34, short_text, 0x9eafc6);
    unsigned first = focus > 1 ? focus - 1 : 0;
    if (first + 4 > count)
      first = count > 4 ? count - 4 : 0;
    for (unsigned row = 0; row < 4 && row + first < count; row++) {
      unsigned i = first + row;
      Place *item = &places[list[i]];
      int y = 54 + row * 34;
      if (i == focus) {
        browser_ui_rect(6, y, 308, 32, 0x233449);
        browser_ui_rect(6, y, 3, 32, item->accent);
      }
      fit(short_text, sizeof short_text, str(item, NAME), 247);
      browser_ui_text(14, y + 1, short_text, i == focus ? 0xffffff : 0xc4d0df);
      snprintf(text, sizeof text, "%s · %s", str(item, LOCALITY),
               native_name(item));
      fit(short_text, sizeof short_text, text, 268);
      browser_ui_text(14, y + 16, short_text, 0x94a8bf);
      browser_ui_text(275, y + 2, item->flags & 1 ? "Open" : "Soon",
                      item->flags & 1 ? 0x90dcc4 : 0x8793a5);
      if (saved_index(str(item, ID)) >= 0)
        browser_ui_text(296, y + 17, "★", 0xffd28a);
    }
    if (!count) {
      const char *title = tab == 2 ? "No saved places yet"
                          : *query ? "No places found"
                                   : "Find a place";
      browser_ui_text(16, 85, title, 0xe4ebf4);
      browser_ui_wrap(16, 110, 280,
                      tab == 2 ? "Press Y on a place to keep it here."
                               : "Press X to type with the system keyboard.",
                      0x9eafc6);
    }
  }
  browser_ui_rect(0, 195, 320, 45, 0x101c2b);
  if (toast_time > 0) {
    fit(text, sizeof text, toast, 300);
    browser_ui_text(10, 197, text, 0xffd28a);
  } else
    browser_ui_text(10, 197,
                    detail ? "D-pad: scroll details  Circle: globe"
                           : "Circle: globe  D-pad: list / zoom  L/R: tabs",
                    0x8ca3bd);
  browser_ui_text(10, 220, "A Enter", 0xd4e5f3);
  browser_ui_text(86, 220, "X Search", 0xd4e5f3);
  browser_ui_text(169, 220,
                  p && saved_index(str(p, ID)) >= 0 ? "Y Unsave" : "Y Save",
                  0xd4e5f3);
  browser_ui_text(246, 220, detail ? "B List" : "B Info", 0xd4e5f3);
}

static void vertex(Vertex *v, float x, float y, float z, float u, float vv,
                   u32 color, unsigned alpha) {
  *v = (Vertex){x, y, z, u, vv, {color >> 16, color >> 8, color, alpha}};
}
static void bind_buffer(Vertex *v) {
  C3D_BufInfo *info = C3D_GetBufInfo();
  BufInfo_Init(info);
  BufInfo_Add(info, v, sizeof(Vertex), 3, 0x210);
}
static void draw(unsigned start, C3D_Tex *tex) {
  if (ui_count == start)
    return;
  GSPGPU_FlushDataCache(ui_vertices + start,
                        (ui_count - start) * sizeof(Vertex));
  bind_buffer(ui_vertices + start);
  C3D_TexBind(0, tex);
  C3D_DrawArrays(GPU_TRIANGLES, 0, ui_count - start);
}
static void quad(float x, float y, float w, float h, float u0, float v0,
                 float u1, float v1, u32 rgb, unsigned alpha) {
  if (ui_count + 6 > UI_VERTS)
    return;
  Vertex *v = ui_vertices + ui_count;
  vertex(v, x, y, 0, u0, v0, rgb, alpha);
  vertex(v + 1, x + w, y, 0, u1, v0, rgb, alpha);
  vertex(v + 2, x, y + h, 0, u0, v1, rgb, alpha);
  v[3] = v[1];
  vertex(v + 4, x + w, y + h, 0, u1, v1, rgb, alpha);
  v[5] = v[2];
  ui_count += 6;
}
static void circle(float x, float y, float r, u32 rgb, unsigned alpha,
                   float inner) {
  const unsigned segments = 32;
  if (ui_count + segments * 6 > UI_VERTS)
    return;
  for (unsigned i = 0; i < segments; i++) {
    float ca = ring_cos[i], sa = ring_sin[i], cb = ring_cos[i + 1],
          sb = ring_sin[i + 1];
    Vertex *v = ui_vertices + ui_count;
    vertex(v, x + ca * r, y + sa * r, 0, 0, 0, rgb, alpha);
    vertex(v + 1, x + cb * r, y + sb * r, 0, 0, 0, rgb, alpha);
    vertex(v + 2, x + ca * inner, y + sa * inner, 0, 0, 0, rgb,
           inner ? alpha : 0);
    v[3] = v[1];
    vertex(v + 4, x + cb * inner, y + sb * inner, 0, 0, 0, rgb,
           inner ? alpha : 0);
    v[5] = v[2];
    ui_count += 6;
  }
}
static void gpu_text(float x, float y, const char *s, u32 rgb, float scale) {
  while (*s) {
    const Glyph *g = glyph(utf8(&s));
    if (!g)
      continue;
    quad(x + g->left * scale, y + (12 + g->top) * scale, g->w * scale,
         g->h * scale, (float)g->x / head->font_w, (float)g->y / head->font_h,
         (float)(g->x + g->w) / head->font_w,
         (float)(g->y + g->h) / head->font_h, rgb, 255);
    x += g->advance * scale;
  }
}
static int gpu_wrap(int x, int y, int width, int limit, const char *s,
                    u32 rgb) {
  for (int row = 0; *s && row < limit; row++) {
    char text[512];
    s = line(text, sizeof text, s, width);
    gpu_text(x, y, text, rgb, 1);
    y += 16;
  }
  return y;
}
static void unit(float la, float lo, float *x, float *y, float *z) {
  la *= M_PI / 180;
  lo *= M_PI / 180;
  float a = lat * (M_PI / 180), b = lon * (M_PI / 180);
  float ox = cosf(la) * sinf(lo), oy = sinf(la), oz = cosf(la) * cosf(lo);
  *x = cosf(b) * ox - sinf(b) * oz;
  float q = sinf(b) * ox + cosf(b) * oz;
  *y = cosf(a) * oy - sinf(a) * q;
  *z = sinf(a) * oy + cosf(a) * q;
}
void browser_render(C3D_RenderTarget *top) {
  if (!ready)
    return;
  ui_count = 0;
  C3D_RenderTargetClear(top, C3D_CLEAR_ALL, 0x050913ff, 0);
  C3D_FrameDrawOn(top);
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
  float cx = 109, cy = 136, radius = 90 * zoom;
  unsigned start = ui_count;
  for (unsigned i = 0; i < 64; i++) {
    unsigned v = i * 2654435761u;
    float x = (v % 4000) * .1f, y = ((v >> 12) % 2400) * .1f;
    quad(x, y, 1, 1, 0, 0, 0, 0, 0x92aac9, 50 + (v & 127));
  }
  // A narrow atmospheric limb around a shaded, genuinely rotating sphere.
  for (int i = 6; i > 0; i--)
    circle(cx, cy, radius + i * 1.1f, 0x3f87d1, 7, radius);
  draw(start, &white);
  // Rotate and light once. Old 3DS spends tens of milliseconds in thousands
  // of redundant transcendental calls; the object sphere and ring points are
  // immutable, and the three texture passes share transformed positions.
  float a = lat * (float)(M_PI / 180), b = lon * (float)(M_PI / 180);
  float ca = cosf(a), sa = sinf(a), cb = cosf(b), sb = sinf(b);
  float drift = elapsed * head->cloud_speed;
  for (unsigned k = 0; k < SPHERE_VERTS; k++) {
    const float *p = sphere_points[k];
    float x = cb * p[0] - sb * p[2], q = sb * p[0] + cb * p[2];
    float y = ca * p[1] - sa * q, z = sa * p[1] + ca * q;
    float mu = x * head->sun[0] + y * head->sun[1] + z * head->sun[2];
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
    C3D_CullFace(GPU_CULL_NONE);
    if (pass == 1)
      C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ONE, GPU_ONE,
                     GPU_ONE);
    else
      C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                     GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA);
    C3D_DrawElements(GPU_TRIANGLES, sphere_count, C3D_UNSIGNED_SHORT, indices);
  }
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_ALL);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA,
                 GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA);
  start = ui_count;
  for (unsigned i = 0; i < head->count; i++) {
    float x, y, z;
    unit(places[i].lat, places[i].lon, &x, &y, &z);
    if (z < .27f)
      continue;
    float r = radius * .962f * 3.7f / (3.7f - z), sx = cx + x * r,
          sy = cy - y * r;
    bool active = count && list[focus] == i, listed = false;
    for (unsigned j = 0; j < count; j++)
      if (list[j] == i)
        listed = true;
    circle(sx, sy, active ? 4 : 2.4f, places[i].accent, listed ? 255 : 110,
           active ? 3 : 1);
    if (active)
      circle(sx, sy, 7 + sinf(elapsed * 3) * .6f, 0xffffff, 220,
             6 + sinf(elapsed * 3) * .6f);
  }
  // Card shields the globe at close zoom, preserving the usable globe viewport.
  quad(218, 34, 176, 187, 0, 0, 0, 0, 0x101c2b, 246);
  draw(start, &white);
  Place *p = selected();
  if (p) {
    start = ui_count;
    if (p->preview >= 0) {
      quad(222, 38, 168, 84, 0, 0, 1, 1, 0xffffff, 255);
      draw(start, &textures[p->preview]);
    } else {
      quad(222, 38, 168, 84, 0, 0, 0, 0, p->accent, 90);
      draw(start, &white);
    }
  }
  start = ui_count;
  gpu_text(12, 8, "Pocket Atlas", 0xf3f6ff, 1.45f);
  char text[256];
  snprintf(text, sizeof text, "%u places · %u open", (unsigned)head->count,
           (unsigned)head->texture_count - 3);
  gpu_text(13, 30, text, 0x95aac6, 1);
  if (p) {
    if (p->preview < 0) {
      const char *locality = drawable(str(p, LOCAL_NATIVE))
                                 ? str(p, LOCAL_NATIVE)
                                 : str(p, LOCALITY);
      gpu_wrap(233, 68, 148, 2, locality, 0xe4edf8);
    }
    int y = gpu_wrap(226, 128, 158, 2, str(p, NAME), 0xf2f5fa);
    gpu_wrap(226, y + 2, 158, 1, native_name(p), p->accent);
    fit(text, sizeof text, str(p, LOCALITY), 158);
    gpu_text(226, y + 21, text, 0xa9bdd4, 1);
    gpu_text(226, 201, p->flags & 1 ? "A  Visit this place" : "Coming soon",
             p->flags & 1 ? 0xa1e0cf : 0x99a6bb, 1);
    if (saved_index(str(p, ID)) >= 0)
      gpu_text(370, 201, "★", 0xffd28a, 1);
  } else {
    gpu_wrap(229, 88, 152, 4,
             tab == 2 ? "Save a place with Y to keep it here."
                      : "Search the places you remember.",
             0xb7cadf);
  }
  snprintf(text, sizeof text, "%.1f°  %.1f°", lat, lon);
  gpu_text(14, 219, text, 0x7f96b3, 1);
  draw(start, &font_texture);
}

void browser_control(const char *json) {
  if (!head)
    return;
  char text[256];
  const char *p;
  if (string_value(field(json, "tab"), text, sizeof text)) {
    char upper[256];
    fold(text, upper, sizeof upper);
    for (unsigned i = 0; i < 4; i++) {
      char label[32];
      fold(tabs[i], label, sizeof label);
      if (!strcmp(upper, label))
        set_tab(i);
    }
  }
  if (string_value(field(json, "search"), query, sizeof query))
    set_tab(3);
  if (string_value(field(json, "select"), text, sizeof text))
    select_id(text);
  if (string_value(field(json, "save"), text, sizeof text))
    toggle_saved(text);
  if ((p = field(json, "keyboard")) && !strncmp(p, "true", 4))
    keyboard = true;
  if ((p = field(json, "details"))) {
    detail = !strncmp(p, "true", 4);
    dirty = true;
  }
  if ((p = field(json, "lat"))) {
    float v = strtof(p, NULL);
    if (isfinite(v))
      lat = clampf(v, -85, 85);
    turning = false;
    idle = 0;
  }
  if ((p = field(json, "lon"))) {
    float v = strtof(p, NULL);
    if (isfinite(v))
      lon = wrap(v);
    turning = false;
    idle = 0;
  }
  if ((p = field(json, "zoom"))) {
    float v = strtof(p, NULL);
    if (isfinite(v))
      zoom = clampf(v, .7f, 1.45f);
  }
  if (field(json, "lat") || field(json, "lon")) {
    if (tab == 1)
      rebuild(false);
    dirty = true;
  }
  if (string_value(field(json, "place"), text, sizeof text)) {
    select_id(text);
    if (place_index(text) >= 0)
      enter();
  }
  if ((p = field(json, "enter")) && !strncmp(p, "true", 4))
    enter();
}
static void append(char *out, size_t cap, size_t *n, const char *text) {
  if (*n >= cap)
    return;
  size_t len = strlen(text);
  if (len >= cap - *n)
    len = cap - *n - 1;
  memcpy(out + *n, text, len);
  *n += len;
  out[*n] = 0;
}
static void quoted(char *out, size_t cap, size_t *n, const char *text) {
  append(out, cap, n, "\"");
  for (const u8 *p = (const u8 *)text; *p; p++) {
    char b[8] = {*p, 0};
    if (*p == '"' || *p == '\\') {
      b[0] = '\\';
      b[1] = *p;
      b[2] = 0;
    } else if (*p < 32)
      snprintf(b, sizeof b, "\\u%04x", *p);
    append(out, cap, n, b);
  }
  append(out, cap, n, "\"");
}
void browser_status(char *out, size_t cap) {
  if (!cap)
    return;
  size_t n = 0;
  out[0] = 0;
  char text[256];
  snprintf(text, sizeof text,
           "{\"tab\":\"%s\",\"lat\":%.3f,\"lon\":%.3f,\"zoom\":%.3f,"
           "\"details\":%s,\"keyboard\":%s,\"selected\":",
           tabs[tab], lat, lon, zoom, detail ? "true" : "false",
           keyboard ? "true" : "false");
  append(out, cap, &n, text);
  Place *p = selected();
  quoted(out, cap, &n, p ? str(p, ID) : "");
  append(out, cap, &n, ",\"query\":");
  quoted(out, cap, &n, query);
  append(out, cap, &n, ",\"list\":[");
  for (unsigned i = 0; i < count; i++) {
    if (i)
      append(out, cap, &n, ",");
    quoted(out, cap, &n, str(&places[list[i]], ID));
  }
  append(out, cap, &n, "],\"saved\":[");
  for (unsigned i = 0; i < saved_count; i++) {
    if (i)
      append(out, cap, &n, ",");
    quoted(out, cap, &n, saved[i]);
  }
  append(out, cap, &n, "]}");
}
