// Pocket Atlas on Android, built for the Redmi 1S (Android 4.3, Adreno 305,
// OpenGL ES 3.0): the shell around the place renderer (scene.c), the globe
// (globe.c) and the interface, a PocketJS guest (ui/, QuickJS) drawn over
// both. A NativeActivity with no Java: native_app_glue runs android_main on
// a thread of its own, and that one thread owns the window, its touches, the
// GL context, the scene and the guest.
//
// The window is landscape. Its buffers are the portrait panel's, drawn
// rotated by the GL driver, and the display processor shows them as an
// overlay: presenting a frame takes no GPU time. The scene is drawn straight
// into the window, whose EGL config supplies the antialiasing; the interface
// is drawn into a texture when what it shows changes and laid over the frame,
// and while it shows nothing the frame is the place alone.
#include "../../n3ds/src/control.h"
#include "../../n3ds/src/interface.h"
#include "contact_latch.h"
#include "globe.h"
#include "pocket_runtime.h"
#include "pocket_spec.h"
#include "scene.h"
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <android/asset_manager.h>
#include <android/log.h>
#include <android/native_window.h>
#include <android/window.h>
#include <android_native_app_glue.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#ifndef ATLAS_BUILD
#define ATLAS_BUILD "development"
#endif
#ifndef ATLAS_PACKAGE
#define ATLAS_PACKAGE "dev.pocketnexus.atlas"
#endif
// The frame rate a launch starts with: the profile's (profiles/redmi1s30.json).
// The window starts without multisampling; a visitor may ask for it.
#ifndef ATLAS_RATE
#define ATLAS_RATE 30
#endif
#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "PocketAtlas", __VA_ARGS__)
// What tools/atlas-android.ts pushes: commands in every build; the library,
// the interface and packs in a development build.
#define PUSHED "/data/local/tmp/" ATLAS_PACKAGE
extern uint64_t ui_draw_hash(void);
extern int32_t ui_gl_render_over(int32_t, int32_t, int32_t, int32_t, int32_t, int32_t);
// The Pocket3D title card, from PocketJS's pocket3d-title (android/title).
extern uint32_t atlas_title_ticks(void);
extern int32_t atlas_title_changed(uint32_t tick);
extern int32_t atlas_title_draw(uint8_t *pixels, size_t length, uint32_t width, uint32_t height, uint32_t tick);
// The interface's screen in logical pixels: two samples each on the panel.
enum { LOGICAL_WIDTH = 640, LOGICAL_HEIGHT = 360, WINDOW = 120 };

static struct android_app *app;
static EGLDisplay display;
static EGLContext context = EGL_NO_CONTEXT;
static EGLSurface surface = EGL_NO_SURFACE;
static bool window_ready, resumed, lost;
// The window as the panel shows it, and its buffer: the display processor
// scales a smaller buffer to the panel.
static int screen_width, screen_height, width, height;
// What a visitor can set: samples a pixel (the window's EGL config) and
// frames a second. The buffer's height is the guard's (`guard`), or pinned by
// a command (`fixed_lines`).
enum { FULL_LINES = 720, LEAST_LINES = 540 };
static int samples, lines = FULL_LINES, fixed_lines, rate = ATLAS_RATE;
static int context_samples = -1, surface_lines;
static PocketContactLatch touches;
static uint32_t pressed; // buttons for the guest's next turn: the back and menu keys
static char files[512];

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}
// Replaces the file in one step, readable by the host's `adb pull`.
static void write_file(const char *name, const void *data, size_t size) {
  char path[640], staging[650];
  snprintf(path, sizeof path, "%s/%s", files, name);
  snprintf(staging, sizeof staging, "%s.new", path);
  int file = open(staging, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (file < 0)
    return;
  fchmod(file, 0644);
  for (size_t at = 0; at < size;) {
    ssize_t n = write(file, (const char *)data + at, size - at);
    if (n <= 0)
      break;
    at += (size_t)n;
  }
  close(file);
  rename(staging, path);
}
static char *read_path(const char *path, const char *before, size_t *size) {
  FILE *file = fopen(path, "rb");
  if (!file)
    return NULL;
  fseek(file, 0, SEEK_END);
  size_t length = (size_t)ftell(file), lead = strlen(before);
  rewind(file);
  char *data = malloc(lead + length + 1);
  memcpy(data, before, lead);
  *size = lead + fread(data + lead, 1, length, file);
  data[*size] = 0;
  fclose(file);
  return data;
}
// A whole file of the app with a NUL after it, `before` in front: the one
// pushed for development, else the APK's asset.
static char *read_asset(const char *name, const char *before, size_t *size) {
  char path[640];
#ifdef ATLAS_DEV
  snprintf(path, sizeof path, PUSHED "/%s", name);
  char *pushed = read_path(path, before, size);
  if (pushed)
    return pushed;
#endif
  (void)path;
  AAsset *asset = AAssetManager_open(app->activity->assetManager, name, AASSET_MODE_BUFFER);
  if (!asset)
    return NULL;
  size_t length = (size_t)AAsset_getLength(asset), lead = strlen(before);
  char *data = malloc(lead + length + 1);
  memcpy(data, before, lead);
  int got = AAsset_read(asset, data + lead, length);
  AAsset_close(asset);
  *size = lead + (got > 0 ? (size_t)got : 0);
  data[*size] = 0;
  return data;
}
// A pack, as an open file and where it lies in it: packs are stored in the
// APK as they are, so the scene maps them from there.
static int open_pack(const char *name, off_t *offset, size_t *size) {
  char path[640];
  struct stat info;
#ifdef ATLAS_DEV
  snprintf(path, sizeof path, PUSHED "/%s", name);
  int pushed = open(path, O_RDONLY);
  if (pushed >= 0 && !fstat(pushed, &info)) {
    *offset = 0, *size = (size_t)info.st_size;
    return pushed;
  }
#endif
  (void)path, (void)info;
  AAsset *asset = AAssetManager_open(app->activity->assetManager, name, AASSET_MODE_UNKNOWN);
  if (!asset)
    return -1;
  off_t start, length;
  int file = AAsset_openFileDescriptor(asset, &start, &length);
  AAsset_close(asset);
  *offset = start, *size = (size_t)length;
  return file;
}

// ---- the window

static EGLConfig config_for(int count) {
  const EGLint want[] = {EGL_RENDERABLE_TYPE, 0x0040 /* EGL_OPENGL_ES3_BIT_KHR */, EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
                         EGL_DEPTH_SIZE, 24, EGL_SAMPLE_BUFFERS, count > 1, EGL_SAMPLES, count > 1 ? count : 0, EGL_NONE};
  EGLConfig config = NULL;
  EGLint found = 0;
  return eglChooseConfig(display, want, &config, 1, &found) && found ? config : NULL;
}
static void drop_surface(void) {
  if (surface == EGL_NO_SURFACE)
    return;
  eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
  eglDestroySurface(display, surface);
  surface = EGL_NO_SURFACE;
}
// The window surface for the buffer size as it stands. Samples belong to the
// EGL config, and a context draws only into surfaces of its own config
// (EGL_BAD_MATCH otherwise): the context is made with the samples wanted at
// that moment, and a change of samples takes a new one (`regraphics`).
static bool make_surface(void) {
  drop_surface();
  if (!display) {
    display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    eglInitialize(display, NULL, NULL);
  }
  if (lines < 360 || lines > 720)
    lines = 720;
  if (context == EGL_NO_CONTEXT) {
    if ((samples != 2 && samples != 4) || !config_for(samples))
      samples = 0;
    context_samples = samples;
  }
  EGLConfig config = config_for(context_samples);
  if (!config)
    return false;
  if (!screen_width) {
    screen_width = ANativeWindow_getWidth(app->window);
    screen_height = ANativeWindow_getHeight(app->window);
  }
  EGLint format = 0;
  eglGetConfigAttrib(display, config, EGL_NATIVE_VISUAL_ID, &format);
  height = lines < screen_height ? lines : screen_height;
  width = height == screen_height ? screen_width : (screen_width * height / screen_height + 7) / 8 * 8;
  ANativeWindow_setBuffersGeometry(app->window, width, height, format);
  surface = eglCreateWindowSurface(display, config, app->window, NULL);
  if (context == EGL_NO_CONTEXT) {
    const EGLint version[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    context = eglCreateContext(display, config, EGL_NO_CONTEXT, version);
  }
  if (surface == EGL_NO_SURFACE || context == EGL_NO_CONTEXT || !eglMakeCurrent(display, surface, surface, context)) {
    LOG("EGL: no surface for %d samples at %dx%d (0x%04x)", context_samples, width, height, eglGetError());
    return false;
  }
  eglQuerySurface(display, surface, EGL_WIDTH, &width);
  eglQuerySurface(display, surface, EGL_HEIGHT, &height);
  eglSwapInterval(display, 1);
  surface_lines = lines;
  scene_size(width, height);
  LOG("window %dx%d shown at %dx%d, %d samples: %s", width, height, screen_width, screen_height, context_samples, glGetString(GL_RENDERER));
  return true;
}

static void on_command(struct android_app *a, int32_t command) {
  (void)a;
  switch (command) {
  case APP_CMD_INIT_WINDOW: window_ready = app->window != NULL; break;
  case APP_CMD_TERM_WINDOW:
    drop_surface();
    window_ready = false;
    break;
  case APP_CMD_RESUME: resumed = true; break;
  case APP_CMD_PAUSE: resumed = false; break;
  case APP_CMD_LOST_FOCUS: pocket_contacts_cancel(&touches); break;
  default: break;
  }
}
// Every finger goes to the interface, in the window's pixels; the back and
// menu keys go to it as the buttons a pad has for the same verbs.
static int32_t on_input(struct android_app *a, AInputEvent *event) {
  (void)a;
  if (AInputEvent_getType(event) == AINPUT_EVENT_TYPE_KEY) {
    int key = AKeyEvent_getKeyCode(event);
    if (key != AKEYCODE_BACK && key != AKEYCODE_MENU)
      return 0;
    if (AKeyEvent_getAction(event) == AKEY_EVENT_ACTION_UP)
      pressed |= key == AKEYCODE_BACK ? POCKET_BTN_CROSS : POCKET_BTN_TRIANGLE;
    return 1;
  }
  if (AInputEvent_getType(event) != AINPUT_EVENT_TYPE_MOTION || !screen_width)
    return 0;
  int action = AMotionEvent_getAction(event), kind = action & AMOTION_EVENT_ACTION_MASK;
  size_t index = (size_t)(action & AMOTION_EVENT_ACTION_POINTER_INDEX_MASK) >> AMOTION_EVENT_ACTION_POINTER_INDEX_SHIFT, count = AMotionEvent_getPointerCount(event);
  // Contacts are kept in the interface's logical pixels.
  const float sx = (float)LOGICAL_WIDTH / screen_width, sy = (float)LOGICAL_HEIGHT / screen_height;
  if (kind == AMOTION_EVENT_ACTION_CANCEL)
    pocket_contacts_cancel(&touches);
  else if (kind == AMOTION_EVENT_ACTION_MOVE)
    for (size_t i = 0; i < count; i++)
      pocket_contact_event(&touches, POCKET_TOUCH_MOVE, AMotionEvent_getPointerId(event, i), AMotionEvent_getX(event, i) * sx, AMotionEvent_getY(event, i) * sy, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  else if (kind == AMOTION_EVENT_ACTION_DOWN || kind == AMOTION_EVENT_ACTION_POINTER_DOWN || kind == AMOTION_EVENT_ACTION_UP || kind == AMOTION_EVENT_ACTION_POINTER_UP)
    pocket_contact_event(&touches, kind == AMOTION_EVENT_ACTION_DOWN || kind == AMOTION_EVENT_ACTION_POINTER_DOWN ? POCKET_TOUCH_DOWN : POCKET_TOUCH_UP,
                         AMotionEvent_getPointerId(event, index), AMotionEvent_getX(event, index) * sx, AMotionEvent_getY(event, index) * sy, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  return 1;
}
// Takes what the system has for the app. False when the activity is over.
// Without a window, or behind another app, it waits here.
static bool pump(void) {
  for (;;) {
    int events;
    struct android_poll_source *source;
    bool drawing = window_ready && resumed;
    while (ALooper_pollAll(drawing ? 0 : 250, NULL, &events, (void **)&source) >= 0) {
      if (source)
        source->process(app, source);
      if (app->destroyRequested)
        return false;
    }
    if (app->destroyRequested)
      return false;
    if (!(window_ready && resumed))
      continue;
    if (surface == EGL_NO_SURFACE || lines != surface_lines) {
      if (!make_surface()) {
        // The context did not survive the window: start over when shown again.
        lost = true;
        return false;
      }
    }
    return true;
  }
}

// ---- drawing a texture over the window

static GLuint cover_program;
static GLint cover_flip;
static void cover_make(void) {
  static const char *const sources[2] = {
    "attribute vec2 aPos; uniform float uFlip; varying vec2 vAt;\n"
    "void main() { gl_Position = vec4(aPos, 0.0, 1.0); vAt = vec2(0.5 + aPos.x * 0.5, 0.5 + aPos.y * uFlip); }\n",
    "precision mediump float; uniform sampler2D uPicture; varying vec2 vAt;\n"
    "void main() { gl_FragColor = texture2D(uPicture, vAt); }\n"};
  cover_program = glCreateProgram();
  for (unsigned i = 0; i < 2; i++) {
    GLuint shader = glCreateShader(i ? GL_FRAGMENT_SHADER : GL_VERTEX_SHADER);
    glShaderSource(shader, 1, &sources[i], NULL);
    glCompileShader(shader);
    glAttachShader(cover_program, shader);
    glDeleteShader(shader);
  }
  glBindAttribLocation(cover_program, 0, "aPos");
  glLinkProgram(cover_program);
  cover_flip = glGetUniformLocation(cover_program, "uFlip");
}
// The whole window: `flip` is 0.5 for a texture drawn by GL, -0.5 for rows from the top.
static void cover(GLuint picture, float flip, bool blend) {
  static const float corners[8] = {-1, -1, 1, -1, -1, 1, 1, 1};
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glViewport(0, 0, width, height);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_CULL_FACE);
  glDisable(GL_SCISSOR_TEST);
  glDepthMask(GL_FALSE);
  (blend ? glEnable : glDisable)(GL_BLEND);
  glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA); // the interface's texture holds premultiplied colour
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  glEnableVertexAttribArray(0);
  glDisableVertexAttribArray(1);
  glDisableVertexAttribArray(2);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, corners);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, picture);
  glUseProgram(cover_program);
  glUniform1f(cover_flip, flip);
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  glDepthMask(GL_TRUE);
}

// The Pocket3D title card: 144 ticks of a sixtieth of a second, first at
// every launch, before the interface boots and before anything of a place or
// the globe is loaded. PocketJS draws each tick's frame into memory; it
// reaches the window through one texture, which is gone when the card ends.
// The card follows the clock: a late frame skips ticks and the card keeps
// its length.
static bool title(void) {
  size_t length = (size_t)width * height * 4;
  uint8_t *pixels = malloc(length);
  GLuint picture;
  glGenTextures(1, &picture);
  glBindTexture(GL_TEXTURE_2D, picture);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  double start = now();
  uint32_t shown = UINT32_MAX;
  bool alive = true;
  while (pixels && (alive = pump())) {
    uint32_t tick = (uint32_t)((now() - start) * 60);
    if (tick >= atlas_title_ticks())
      break;
    bool differs = shown == UINT32_MAX;
    for (uint32_t t = shown + 1; !differs && t <= tick; t++)
      differs = atlas_title_changed(t);
    if (differs && atlas_title_draw(pixels, length, width, height, tick)) {
      glBindTexture(GL_TEXTURE_2D, picture);
      glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
      glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    }
    shown = tick;
    cover(picture, -0.5f, false);
    eglSwapBuffers(display, surface);
  }
  glDeleteTextures(1, &picture);
  free(pixels);
  return alive;
}

// ---- the frame

static float timing[7][WINDOW]; // work before the swap, swap, interval, prepare, GPU, guest turn, interface redraw (ms)
// The GPU's time on a frame's commands, from EXT_disjoint_timer_query: asked
// of every third frame and read when it has come back, so nothing waits. The
// swap's own interval stops at the refresh; this does not.
#define GL_TIME_ELAPSED_EXT 0x88BF
static GLuint gpu_timer;
static bool gpu_timing;
static float gpu_ms;
static bool profile, loaded, statistics, quiet;
// The panel's refresh, as the app can know it. `eglSwapBuffers` returns when
// the frame is queued and waits for the compositor only while the queue is
// full, which a place at 30 frames a second never makes it: the app times its
// own frames onto the refreshes (`due`). Queued at any other pace they are
// shown for one refresh and two by turns.
//
// Where the refreshes fall comes from the display driver, which publishes the
// time of the last vertical sync on the app's own clock
// (/sys/class/graphics/fb0/vsync_event on Qualcomm's MDP). Without that file
// the atlas screen stands in: the GPU has little to do there, the queue is
// full, and every return of the swap follows a latch.
static double refresh = 1 / 60.0, latch, streak_from, due;
static unsigned streak, longest;
static bool synced; // the driver's syncs, not the swap's returns
// The fence ahead of the last swap, when that swap was called, and how long
// the GPU took from there to the frame's last tile (smoothed).
static GLsync drawn;
static double swapped;
static float gpu_expected = 0.012f;
static void latched(double at) {
  if (at == latch)
    return;
  double n = floor((at - latch) / refresh + 0.5);
  if (latch && n >= 1 && n < 8 && fabs(at - latch - n * refresh) < 0.0015) {
    // The period over the longest run of refreshes seen: its error is one
    // reading's jitter over the run's length.
    streak += (unsigned)n;
    if (streak >= 120 && streak >= longest)
      longest = streak, refresh = (at - streak_from) / streak;
  } else
    streak = 0, streak_from = at;
  latch = at;
}
// The driver's last vertical sync in seconds of CLOCK_MONOTONIC, or 0.
static double vertical_sync(void) {
  static int file = -2;
  if (file == -2)
    file = open("/sys/class/graphics/fb0/vsync_event", O_RDONLY);
  char text[64];
  ssize_t length = file < 0 ? 0 : pread(file, text, sizeof text - 1, 0);
  if (length < 7 || strncmp(text, "VSYNC=", 6))
    return 0;
  text[length] = 0;
  return (double)strtoull(text + 6, NULL, 10) * 1e-9;
}
// The middle of the first slot between two refreshes at or after a moment.
static double slot_after(double t) { return latch + (ceil((t - latch) / refresh - 0.5) + 0.5) * refresh; }
static unsigned frames, redraws, late, marked, marked_late;
static float worst;
static char command[40], captured[40], failure[256];
static GLuint interface_target, interface_texture;
static struct {
  float move[2], look[2];
} sticks;
// Contacts a command holds on the panel, for driving the interface from the host.
static struct {
  int count;
  float at[4][2];
} fingers, fingered;

static int compare(const void *a, const void *b) { return (*(const float *)a > *(const float *)b) - (*(const float *)a < *(const float *)b); }
static int summary(char *out, size_t capacity, const char *name, const float *a, const float *b) {
  float sorted[WINDOW], sum = 0;
  unsigned n = frames < WINDOW ? frames : WINDOW;
  for (unsigned i = 0; i < n; i++)
    sum += sorted[i] = a[i] + (b ? b[i] : 0);
  qsort(sorted, n, sizeof *sorted, compare);
  return snprintf(out, capacity, "\"%s\":{\"mean\":%.3f,\"p95\":%.3f,\"max\":%.3f},", name, n ? sum / n : 0, n ? sorted[n * 95 / 100] : 0,
                  n ? sorted[n - 1] : 0);
}
static float fps(void) {
  unsigned n = frames < WINDOW ? frames : WINDOW;
  float interval = 0;
  for (unsigned i = 0; i < n; i++)
    interval += timing[2][i];
  return interval > 0 ? n * 1000 / interval : 0;
}
static unsigned resident(void) {
  unsigned pages = 0, total;
  FILE *file = fopen("/proc/self/statm", "r");
  if (file) {
    if (fscanf(file, "%u %u", &total, &pages) != 2)
      pages = 0;
    fclose(file);
  }
  return pages * 4096u;
}
static void status(void) {
  static const char *const scenes[] = {"atlas", "loading", "running", "error"};
  char text[3072], error[256];
  control_escape(error, sizeof error, failure);
  int at = snprintf(text, sizeof text,
                    "{\"build\":\"%s\",\"state\":\"%s\",\"error\":\"%s\",\"place\":\"%s\",\"shots\":%u,\"shot\":%u,\"shotName\":\"%s\","
                    "\"time\":%.3f,\"cinematic\":%s,\"paused\":%s,\"camera\":[%.3f,%.3f,%.3f],\"frame\":%u,\"fps\":%.3f,"
                    "\"window\":[%d,%d],\"fixedLines\":%d,\"refreshMs\":%.4f,\"refreshes\":\"%s\",\"drawnMs\":%.2f,\"samples\":%d,\"rate\":%d,\"late\":%u,\"marked\":%u,\"markedLate\":%u,\"worstMs\":%.2f,",
                    ATLAS_BUILD, scenes[interface.scene], error, interface.place, scene_shot_count(), atlas.shot,
                    loaded ? scene_shot_name(atlas.shot) : "", atlas.time, atlas.cinematic ? "true" : "false", atlas.paused ? "true" : "false",
                    atlas.position[0], atlas.position[1], atlas.position[2], frames, fps(), width, height, fixed_lines, refresh * 1000, synced ? "driver" : "swap", rate == 30 && loaded ? gpu_expected * 1000 : 0.0f, samples, rate, late, marked, marked_late, worst);
  // The last 120 frames shown.
  at += summary(text + at, sizeof text - at, "workMs", timing[0], NULL);
  at += summary(text + at, sizeof text - at, "swapMs", timing[1], NULL);
  at += summary(text + at, sizeof text - at, "intervalMs", timing[2], NULL);
  at += summary(text + at, sizeof text - at, "prepareMs", timing[3], NULL);
  at += summary(text + at, sizeof text - at, "gpuMs", timing[4], NULL);
  at += summary(text + at, sizeof text - at, "interfaceMs", timing[5], NULL);
  at += summary(text + at, sizeof text - at, "interfaceDrawMs", timing[6], NULL);
  at += snprintf(text + at, sizeof text - at,
                 "\"interfaceRedraws\":%u,\"interfaceQuiet\":%s,\"interfaceError\":\"%s\",\"draws\":%u,\"triangles\":%u,\"mirrorTriangles\":%u,\"sprites\":%u,"
                 "\"phases\":[%.2f,%.2f,%.2f,%.2f,%.2f,%.2f],"
                 "\"lod\":%.2f,\"reflection\":%s,\"rain\":%s,\"glow\":%s,\"profile\":%s,\"residentBytes\":%u,\"glError\":%u,"
                 "\"lastCommand\":\"%s\",\"capture\":\"%s\"}",
                 redraws, quiet ? "true" : "false", pocket_runtime_error(), atlas.draws, atlas.triangles, atlas.mirror_triangles, atlas.sprites,
                 scene_phase[0], scene_phase[1], scene_phase[2], scene_phase[3], scene_phase[4], scene_phase[5], atlas.lod,
                 atlas.reflection ? "true" : "false", atlas.rain ? "true" : "false", atlas.glow ? "true" : "false",
                 profile ? "true" : "false", resident(), glGetError(), command, captured);
  write_file("status.json", text, at);
}

// The interface's own drawable: the window's size at two samples a logical pixel.
static void interface_make(void) {
  glGenTextures(1, &interface_texture);
  glBindTexture(GL_TEXTURE_2D, interface_texture);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, screen_width, screen_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glGenFramebuffers(1, &interface_target);
  glBindFramebuffer(GL_FRAMEBUFFER, interface_target);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, interface_texture, 0);
}

static void choice(const char *key, int value, const char *choices) {
  size_t at = strlen(interface.options);
  snprintf(interface.options + at, sizeof interface.options - at, "%s{\"key\":\"%s\",\"value\":%d,\"choices\":[%s]}", at ? "," : "", key, value, choices);
}
// What the interface is told, from what the renderer is doing.
static void publish(void) {
  interface.shot = atlas.shot;
  interface.tour = atlas.cinematic;
  interface.paused = atlas.paused;
  if (!loaded)
    return;
  interface.options[0] = 0;
  choice("rate", rate == 30, "\"60 fps\",\"30 fps\"");
  choice("smoothing", samples == 4 ? 2 : samples == 2, "\"Off\",\"2x\",\"4x\"");
  if (atlas.features & 1)
    interface_switch("rain", atlas.rain);
  if (atlas.features & 4)
    interface_switch("reflection", atlas.reflection);
  if (atlas.features & 8)
    interface_switch("glow", atlas.glow);
  interface_switch("stats", statistics);
}
static void leave(void) {
  lines = fixed_lines ? fixed_lines : FULL_LINES;
  scene_free();
  loaded = false;
  frames = 0;
  memset(&sticks, 0, sizeof sticks);
  interface.scene = SCENE_ATLAS;
  interface.place[0] = interface.shots[0] = interface.options[0] = interface.stats[0] = 0;
}
static void enter(const char *place) {
  leave();
  snprintf(interface.place, sizeof interface.place, "%s", place);
  interface.scene = SCENE_LOADING;
}
// The place the interface is waiting for; it has had a frame to say so.
static void load(void) {
  char pack[160];
  snprintf(pack, sizeof pack, "%s.place", interface.place);
  failure[0] = 0;
  off_t offset = 0;
  size_t size = 0;
  int file = open_pack(pack, &offset, &size);
  loaded = scene_load(file, offset, size, pack, failure, sizeof failure);
  interface.scene = loaded ? SCENE_PLACE : SCENE_ERROR;
  snprintf(interface.message, sizeof interface.message, "%s", failure);
  for (unsigned i = 0; loaded && i < scene_shot_count(); i++)
    interface_append(interface.shots, sizeof interface.shots, scene_shot_name(i));
}
static void obey(const Command *c) {
  switch (c->type) {
  case COMMAND_GLOBE:
    globe_place(c->x, c->y, c->r);
    globe_turn(c->lat, c->lon, c->pin);
    break;
  case COMMAND_PINS: globe_pins(c->text); break;
  case COMMAND_SPIN: globe_spin(c->dx, c->dy); break;
  case COMMAND_ENTER: enter(c->text); break;
  case COMMAND_LEAVE: leave(); break;
  case COMMAND_SHOT:
    if (loaded)
      scene_shot(c->index, false);
    break;
  case COMMAND_TOUR: scene_control(c->on ? "{\"cinematic\":true,\"pause\":false}" : "{\"cinematic\":false}"); break;
  case COMMAND_PAUSE: atlas.paused = c->on; break;
  case COMMAND_OPTION:
    if (!strcmp(c->text, "rain"))
      atlas.rain = c->value;
    else if (!strcmp(c->text, "reflection"))
      atlas.reflection = c->value;
    else if (!strcmp(c->text, "glow"))
      atlas.glow = c->value;
    else if (!strcmp(c->text, "stats"))
      statistics = c->value;
    else if (!strcmp(c->text, "rate")) {
      rate = c->value ? 30 : 60;
      lines = fixed_lines ? fixed_lines : FULL_LINES;
    }
    else if (!strcmp(c->text, "smoothing"))
      samples = c->value == 2 ? 4 : c->value == 1 ? 2 : 0;
    break;
  case COMMAND_DRIVE:
    sticks.move[0] = c->mx, sticks.move[1] = c->my, sticks.look[0] = c->lx, sticks.look[1] = c->ly;
    break;
  case COMMAND_PREFS:
    snprintf(interface.prefs, sizeof interface.prefs, "%s", c->text);
    write_file("interface.json", c->text, strlen(c->text));
    break;
  case COMMAND_QUIET: quiet = c->on; break;
  default: break; // COMMAND_LOOK, COMMAND_HOLD: this device has neither a look pad nor a pad
  }
}
// The places in the APK, and in a development build the ones pushed beside it.
static void installed(void) {
  AAssetDir *assets = AAssetManager_openDir(app->activity->assetManager, "");
  for (const char *name; assets && (name = AAssetDir_getNextFileName(assets));) {
    const char *suffix = strstr(name, ".place");
    if (suffix && !suffix[6]) {
      char id[96];
      snprintf(id, sizeof id, "%.*s", (int)(suffix - name), name);
      interface_append(interface.installed, sizeof interface.installed, id);
    }
  }
  if (assets)
    AAssetDir_close(assets);
#ifdef ATLAS_DEV
  DIR *directory = opendir(PUSHED);
  for (struct dirent *entry; directory && (entry = readdir(directory));) {
    char *suffix = strstr(entry->d_name, ".place"), quoted[100];
    if (suffix && !suffix[6]) {
      *suffix = 0;
      snprintf(quoted, sizeof quoted, "\"%s\"", entry->d_name);
      if (!strstr(interface.installed, quoted))
        interface_append(interface.installed, sizeof interface.installed, entry->d_name);
    }
  }
  if (directory)
    closedir(directory);
#endif
}

// What the shell itself keeps on the GPU: the pass that covers the window,
// the interface's drawable and the globe.
static void graphics(void) {
  size_t size = 0;
  cover_make();
  interface_make();
  globe_logical(LOGICAL_WIDTH, LOGICAL_HEIGHT);
  char *texels = read_asset("globe.rgba", "", &size);
  if (!globe_load(texels, (unsigned)size))
    snprintf(failure, sizeof failure, "globe.rgba is missing");
  free(texels);
}
// The guard of a place's frame rate. The display processor scales a smaller
// window buffer to the panel at no cost to the GPU, so the buffer's height is
// what a place pays its frame rate with: 720 lines on entering, and one step
// down (648, 576, 540) each time half of 30 frames were slow: 4 % longer than
// the rate allows from one swap to the next, or at 30 a GPU time within
// 3.5 ms of two refreshes. It asks for half the frames because a place's
// first second has slow frames of its own (first uses of textures and
// programs). It does not climb: a place keeps the size its heaviest view
// so far could hold.
static void guard(bool slow_frame) {
  static unsigned judged, slow, settling;
  static int judged_lines;
  if (!loaded || fixed_lines || profile || lines != judged_lines) {
    // A new size, or a new place: its first frames are the change's, not the place's.
    judged = slow = 0, settling = 30, judged_lines = lines;
    return;
  }
  if (settling) {
    settling--;
    return;
  }
  judged++, slow += slow_frame;
  if (judged < 30)
    return;
  if (slow >= 15 && lines > LEAST_LINES)
    lines = lines > 648 ? 648 : lines > 576 ? 576 : LEAST_LINES;
  judged = slow = 0;
}
static uint64_t drawn_hash;
// A change of samples: a new context, and everything on the GPU made again
// in it. The place comes back at the shot and the time it was left at.
static bool regraphics(void) {
  char back[256] = "";
  if (loaded)
    snprintf(back, sizeof back, "{\"shot\":%u,\"pause\":%s}", atlas.shot, atlas.paused ? "true" : "false");
  if (loaded && !atlas.cinematic)
    snprintf(back, sizeof back, "{\"view\":[%f,%f,%f,%f,%f,%f,%f],\"pause\":%s}", atlas.position[0], atlas.position[1], atlas.position[2], atlas.target[0],
             atlas.target[1], atlas.target[2], atlas.fov, atlas.paused ? "true" : "false");
  float time = atlas.time;
  drawn = 0; // the old context's
  scene_free();
  drop_surface();
  eglDestroyContext(display, context);
  context = EGL_NO_CONTEXT;
  if (!make_surface())
    return false;
  // The interface's renderer first: it lets go of the names it held in the old context.
  pocket_runtime_gl_reset();
  pocket_runtime_gl_initialize();
  graphics();
  drawn_hash = 0;
  gpu_timer = 0;
  gpu_timing = false;
  if (loaded) {
    interface.shots[0] = 0;
    load();
    if (loaded) {
      scene_control(back);
      atlas.time = time;
    }
  }
  frames = 0;
  return true;
}

static void run(void) {
  char json[1024];
  size_t script_size, pak_size, prefs_size;
  cover_make();
#ifdef ATLAS_DEV
  // A development run may skip the card; nothing in a release build reads this.
  if (access(PUSHED "/no-title", F_OK))
#endif
    if (!title())
      return;
  glDeleteProgram(cover_program);
  graphics();

  // The interface: its bundle and pak. The renderers step it thirty times a
  // second, and say so before it mounts.
  char *script = read_asset("atlas.js", "globalThis.__simHz=30;", &script_size), *pak = read_asset("atlas.pak", "", &pak_size);
  if (!script || !pak || !pocket_runtime_boot(script, script_size, (const uint8_t *)pak, pak_size, LOGICAL_WIDTH, LOGICAL_HEIGHT) || !pocket_runtime_gl_initialize())
    snprintf(failure, sizeof failure, "interface: %s", script && pak ? pocket_runtime_error() : "atlas.js or atlas.pak is missing");
  installed();
  char path[640];
  snprintf(path, sizeof path, "%s/interface.json", files);
  char *prefs = read_path(path, "", &prefs_size);
  if (prefs)
    snprintf(interface.prefs, sizeof interface.prefs, "%s", prefs);
  free(prefs);

  bool capture = false, screen = false;
  double previous = now(), started = previous, reported = 0, turn = 0;
  unsigned waited = 0, idle = 0;
  long long commanded = 0;
  uint8_t *pixels = malloc((size_t)screen_width * screen_height * 4);
  while (pump()) {
    if (samples != context_samples && !regraphics()) {
      lost = true;
      break;
    }
    // Commands from the host (tools/atlas-android.ts ctl): a JSON file pushed
    // in one step, acknowledged by its nonce in the status.
    struct stat info;
    json[0] = 0;
    if (!stat(PUSHED "/control.json", &info) && (long long)info.st_ctime * 1000000000ll + (long long)info.st_ctime_nsec != commanded) {
      commanded = (long long)info.st_ctime * 1000000000ll + (long long)info.st_ctime_nsec;
      size_t size;
      char *text = read_path(PUSHED "/control.json", "", &size), nonce[40] = "";
      if (text)
        control_string(text, "nonce", nonce, sizeof nonce);
      if (text && nonce[0] && strcmp(nonce, command))
        snprintf(json, sizeof json, "%s", text);
      free(text);
    }
    if (json[0]) {
      char id[96];
      bool atlas_screen = false;
      if (control_string(json, "place", id, sizeof id) && (strcmp(id, interface.place) || !loaded)) {
        enter(id); // at once: the rest of the command is for the place
        load();
      }
      if (control_bool(json, "atlas", &atlas_screen) && atlas_screen)
        leave();
      control_bool(json, "capture", &capture);
      control_bool(json, "screen", &screen);
      // Times the GPU on every third frame (`gpuMs`). The query costs the
      // frames around it their place in the refresh: a time, not a frame rate.
      control_bool(json, "profile", &profile);
      samples = (int)control_number(json, "samples", samples);
      // `lines` pins the buffer's height; 0 gives it back to the guard.
      int was = rate, pinned = fixed_lines;
      fixed_lines = (int)control_number(json, "lines", fixed_lines);
      rate = control_number(json, "rate", rate) < 45 ? 30 : 60;
      if (fixed_lines != pinned || rate != was)
        lines = fixed_lines ? fixed_lines : FULL_LINES;
      // Counts frames and late frames from here on.
      bool mark = false;
      if (control_bool(json, "mark", &mark) && mark)
        marked = marked_late = 0, worst = 0;
      // Fingers held on the panel until the next `touch`: [[x, y], …] in the interface's pixels.
      const char *touch = control_field(json, "touch");
      if (touch && *touch == '[') {
        fingers.count = 0;
        for (touch++; fingers.count < 4; touch = strchr(touch, ']') + 1) {
          touch += strspn(touch, " ,");
          if (sscanf(touch, "[%f ,%f", &fingers.at[fingers.count][0], &fingers.at[fingers.count][1]) != 2)
            break;
          fingers.count++;
        }
      }
      const char *key = control_field(json, "key");
      if (key && !strncmp(key, "\"back\"", 6))
        pressed |= POCKET_BTN_CROSS;
      if (key && !strncmp(key, "\"menu\"", 6))
        pressed |= POCKET_BTN_TRIANGLE;
      if (loaded)
        scene_control(json);
      control_string(json, "nonce", command, sizeof command);
      reported = 0;
      if ((samples != 2 && samples != 4) || !config_for(samples))
        samples = 0;
      if (samples != context_samples || lines != surface_lines)
        continue; // the window is made again before anything is drawn
    }

    // The interface's turn, thirty times a second: what the fingers are
    // doing goes in, what it wants comes out, and it is redrawn into its
    // texture when what it shows has changed. While it shows nothing and no
    // finger is down it is only looked in on.
    double start = now();
    float dt = fminf((float)(start - started), 0.1f);
    started = start;
    turn += dt;
    timing[5][frames % WINDOW] = timing[6][frames % WINDOW] = 0;
    if (turn >= 1.0 / 30) {
      turn = fmod(turn, 1.0 / 30);
      PocketRuntimeContactsInput input;
      for (int i = 0; i < 4; i++) {
        if (i < fingers.count)
          pocket_contact_event(&touches, i < fingered.count ? POCKET_TOUCH_MOVE : POCKET_TOUCH_DOWN, -1 - i, fingers.at[i][0], fingers.at[i][1], LOGICAL_WIDTH, LOGICAL_HEIGHT);
        else if (i < fingered.count)
          pocket_contact_event(&touches, POCKET_TOUCH_UP, -1 - i, fingered.at[i][0], fingered.at[i][1], LOGICAL_WIDTH, LOGICAL_HEIGHT);
      }
      fingered = fingers;
      bool touching = touches.contacts[0].used || touches.cancelled_count;
      // The back key at the atlas leaves the app; anywhere else the interface decides.
      if ((pressed & POCKET_BTN_CROSS) && interface.scene == SCENE_ATLAS && !fingers.count) {
        ANativeActivity_finish(app->activity);
        pressed = 0;
      }
      if (touching || pressed || !quiet || json[0] || interface.scene == SCENE_LOADING || ++idle >= 6) {
        pocket_contacts_sample(&touches, &input, LOGICAL_WIDTH, LOGICAL_HEIGHT, LOGICAL_WIDTH, LOGICAL_HEIGHT, pocket_runtime_hit_test_bounds);
        input.buttons = pressed;
        pressed = 0;
        publish();
        if (interface.scene == SCENE_LOADING && ++waited > 2) {
          load();
          publish();
          waited = 0;
          started = now();
        }
        pocket_runtime_frame_contacts(&input, 2 * (idle ? idle : 1));
        idle = 0;
        for (Command c; interface_next(&c);)
          obey(&c);
        double turned = now();
        uint64_t hash = quiet ? drawn_hash : ui_draw_hash();
        if (hash != drawn_hash) {
          drawn_hash = hash;
          redraws++;
          glBindFramebuffer(GL_FRAMEBUFFER, interface_target);
          glViewport(0, 0, screen_width, screen_height);
          glDisable(GL_SCISSOR_TEST);
          glClearColor(0, 0, 0, 0);
          glClear(GL_COLOR_BUFFER_BIT);
          ui_gl_render_over(0, 0, screen_width, screen_height, screen_width, screen_height);
        }
        timing[5][frames % WINDOW] = (float)(turned - start) * 1000;
        timing[6][frames % WINDOW] = (float)(now() - turned) * 1000;
      }
    }
    if (samples != context_samples || lines != surface_lines)
      continue; // a setting the interface changed: the window first

    if (!gpu_timer)
      glGenQueries(1, &gpu_timer);
    if (gpu_timing) {
      GLuint ready = 0, nanoseconds = 0;
      glGetQueryObjectuiv(gpu_timer, GL_QUERY_RESULT_AVAILABLE, &ready);
      if (ready) {
        glGetQueryObjectuiv(gpu_timer, GL_QUERY_RESULT, &nanoseconds);
        gpu_ms = nanoseconds * 1e-6f;
        gpu_timing = false;
      }
    }
    bool timed = profile && !gpu_timing && frames % 3 == 0;
    if (timed)
      glBeginQuery(GL_TIME_ELAPSED_EXT, gpu_timer);
    double prepared = start;
    if (loaded) {
      const float look[2] = {sticks.look[0] * dt * 1.8f, sticks.look[1] * dt * 1.3f};
      scene_update(dt, look, sticks.move);
      scene_prepare();
      prepared = now();
      scene_render(0);
    } else {
      float lat, lon;
      if (globe_update(dt, &lat, &lon))
        interface.lat = lat, interface.lon = lon;
      glBindFramebuffer(GL_FRAMEBUFFER, 0);
      globe_render(width, height);
    }
    if (capture && pixels) {
      // The frame before the interface: rows from the bottom.
      glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      write_file("frame.rgba", pixels, (size_t)width * height * 4);
    }
    if (!quiet)
      cover(interface_texture, 0.5f, true);
    if (timed) {
      glEndQuery(GL_TIME_ELAPSED_EXT);
      gpu_timing = true;
    }
    timing[3][frames % WINDOW] = (float)(prepared - start) * 1000;
    timing[4][frames % WINDOW] = gpu_ms;
    if (screen && pixels) {
      // The frame as presented, interface and all.
      glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      write_file("screen.rgba", pixels, (size_t)width * height * 4);
    }
    if (capture || screen) {
      snprintf(captured, sizeof captured, "%s", command);
      capture = screen = false;
      reported = 0;
      start = now(); // a readback is not a frame's work
    }
    const GLenum unused[] = {GL_DEPTH, GL_STENCIL};
    glInvalidateFramebuffer(GL_FRAMEBUFFER, 2, unused);
    double submitted = now();
    // At 30 frames a second in a place, a frame is ready in the middle of
    // every second slot between two refreshes. The swap returns once the
    // frame is queued, long before the GPU has drawn it, and the display
    // takes a frame at the first refresh after its last tile: a frame whose
    // last tile falls beside a refresh is shown for one refresh or three by
    // turns. So the swap is called as long before the slot as the GPU took
    // over the frames before, which a fence set ahead of each swap tells.
    bool paced = rate == 30 && loaded;
    // A sync the driver timed within the last tenth of a second is where the refreshes fall.
    double sync = vertical_sync();
    synced = sync > 0 && submitted - sync < 0.1;
    if (synced)
      latched(sync);
    if (drawn) {
      // The frame before: its last tile is waited for, or was drawn while this frame was put together.
      GLenum fence = glClientWaitSync(drawn, 0, paced ? 60000000 : 0);
      float took = (float)(now() - swapped);
      if (fence == GL_CONDITION_SATISFIED || (fence == GL_ALREADY_SIGNALED && took < gpu_expected))
        gpu_expected += (took - gpu_expected) * 0.3f;
      glDeleteSync(drawn);
      drawn = 0;
    }
    if (paced) {
      double at = now();
      if (due < at - refresh || due > at + 3 * refresh)
        due = slot_after(at + gpu_expected);
      double wait = due - gpu_expected - at;
      if (wait > 0)
        usleep((useconds_t)(wait * 1e6));
      drawn = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    }
    double swapping = now();
    eglSwapBuffers(display, surface);
    double presented = now();
    float took = (float)(presented - swapping);
    swapped = swapping;
    if (paced) {
      // Two refreshes on; a frame that will be late keeps two from where it lands.
      double ready = swapping + gpu_expected;
      due = (ready > due + refresh * 0.5 ? slot_after(ready) : due) + 2 * refresh;
    } else if (!synced && !loaded && took > 0.003f)
      latched(presented);
    float interval = (float)(presented - previous) * 1000;
    timing[0][frames % WINDOW] = (float)(submitted - start) * 1000;
    timing[1][frames % WINDOW] = took * 1000;
    timing[2][frames % WINDOW] = interval;
    // A frame is late when it is shown a refresh or more after its turn.
    bool behind = interval > (rate == 30 ? 41.7f : 25.0f);
    if (frames > 2) {
      late += behind, marked++, marked_late += behind;
      if (interval > worst)
        worst = interval;
    }
    // At 30 the GPU's own time says a frame cannot make every second refresh before the intervals do.
    guard(interval > 1040.0f / rate || (paced && gpu_expected > 2 * refresh - 0.0035));
    frames++;
    previous = presented;
    if (presented - reported > 0.5) {
      reported = presented;
      if (statistics && loaded)
        snprintf(interface.stats, sizeof interface.stats, "%.0f fps · %uk triangles", fps(), (atlas.triangles + atlas.mirror_triangles + 500) / 1000);
      else
        interface.stats[0] = 0;
      status();
    }
  }
  free(pixels);
}

void android_main(struct android_app *state) {
  app = state;
  app->onAppCmd = on_command;
  app->onInputEvent = on_input;
  snprintf(files, sizeof files, "%s", app->activity->internalDataPath);
  mkdir(files, 0771);
  // Full screen, and the screen stays on while a place is shown.
  ANativeActivity_setWindowFlags(app->activity, AWINDOW_FLAG_KEEP_SCREEN_ON | AWINDOW_FLAG_FULLSCREEN
#ifdef ATLAS_DEV
                                                    | AWINDOW_FLAG_SHOW_WHEN_LOCKED | AWINDOW_FLAG_TURN_SCREEN_ON | AWINDOW_FLAG_DISMISS_KEYGUARD
#endif
                                 , 0);
  if (pump())
    run();
  // A process holds one guest and one GL context: the next launch starts a new one.
  if (lost)
    LOG("the GL context was lost with the window");
  ANativeActivity_finish(app->activity);
  for (int i = 0; i < 40 && !app->destroyRequested; i++) {
    int events;
    struct android_poll_source *source;
    if (ALooper_pollAll(50, NULL, &events, (void **)&source) >= 0 && source)
      source->process(app, source);
  }
  _exit(0);
}
