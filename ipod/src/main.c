// Pocket Atlas on the iPod touch 4 (iOS 6): the UIKit shell around scene.c.
// The device builds from the macOS SDK's C headers, so UIKit is reached
// through the Objective-C runtime. The main thread owns UIKit (the place list
// and a bar of controls); one render thread owns the GL context and the
// place, and they share only `shared` under its lock.
//
// The EAGL layer is the portrait screen, opaque and untransformed, and nothing
// lies over it while a place plays unless the bar is called up: Core Animation
// then shows the frame as it is instead of compositing it with the same GPU.
// The UIKit views are turned a quarter instead.
#include "../../n3ds/src/control.h"
#include "scene.h"
#define GL_SILENCE_DEPRECATION 1
#include <OpenGL/gl3.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <math.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>
#ifndef ATLAS_BUILD
#define ATLAS_BUILD "development"
#endif
typedef struct {
  float x, y;
} Point; // CGPoint and CGSize: CGFloat is a float on this device
typedef struct {
  float x, y, width, height;
} Rect;
typedef struct {
  float a, b, c, d, tx, ty;
} Transform;
extern int UIApplicationMain(int, char **, id, id);
extern void glDiscardFramebufferEXT(GLenum, GLsizei, const GLenum *);
extern id UIGetScreenImage(void); // a CGImage of the screen as composited, UIKit and all
extern id UIImagePNGRepresentation(id);
enum { WINDOW = 120, MAX_PLACES = 16, ATLAS = -1, NONE = -2 };
enum { ACTION_PREVIOUS = 1, ACTION_NEXT, ACTION_PAUSE, ACTION_ATLAS };

static struct {
  float look[2], move[2];
  int request, action, shown; // place to enter (ATLAS to leave); bar button; place on screen
  bool active, parked, bar; // bar: a command calls up the controls, as a tap does
  char message[256], shot[40], screen[40], screened[40]; // nonce of a screen capture asked for, then written
} shared = {.request = NONE, .shown = ATLAS, .active = true};
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static char places[MAX_PLACES][3][96], bundle[1024], tmp[1024]; // id, name, locality
static int place_count;
static id context, view, menu, bar, message_label, shot_label;
static GLuint framebuffer, colorbuffer;
static struct {
  id touch;
  float start[2], last[2];
  double began;
  bool moved;
} contacts[2];
static double bar_shown;

static SEL sel(const char *name) { return sel_registerName(name); }
static id cls(const char *name) { return (id)objc_getClass(name); }
static id send(id object, const char *name) { return ((id(*)(id, SEL))objc_msgSend)(object, sel(name)); }
static id send_id(id object, const char *name, id value) { return ((id(*)(id, SEL, id))objc_msgSend)(object, sel(name), value); }
static void send_int(id object, const char *name, int value) { ((void (*)(id, SEL, int))objc_msgSend)(object, sel(name), value); }
static id string(const char *text) {
  return ((id(*)(id, SEL, const char *))objc_msgSend)(cls("NSString"), sel("stringWithUTF8String:"), text);
}
static id color(float r, float g, float b, float a) {
  return ((id(*)(id, SEL, float, float, float, float))objc_msgSend)(cls("UIColor"), sel("colorWithRed:green:blue:alpha:"), r, g, b, a);
}
// A view of `class` in landscape coordinates, inside the window (turned a
// quarter, home button on the right) or inside another such view. The GL
// view stays at 320x480 pixels.
static id add(id parent, const char *class, Rect r, bool turn) {
  Rect frame = turn ? (Rect){0, 0, r.width, r.height} : r;
  id v = ((id(*)(id, SEL, Rect))objc_msgSend)(send(cls(class), "alloc"), sel("initWithFrame:"), frame);
  if (turn) {
    ((void (*)(id, SEL, Transform))objc_msgSend)(v, sel("setTransform:"), (Transform){0, 1, -1, 0, 0, 0});
    ((void (*)(id, SEL, Point))objc_msgSend)(v, sel("setCenter:"), (Point){320 - (r.y + r.height / 2), r.x + r.width / 2});
  }
  // PocketJS's link stubs carry no UIKit version, and UIKit draws an app
  // that old at one pixel per point unless a view asks for the screen's.
  ((void (*)(id, SEL, float))objc_msgSend)(v, sel("setContentScaleFactor:"), strcmp(class, "AtlasView") ? 2 : 1);
  send_id(parent, "addSubview:", v);
  return v;
}
static id label(id parent, Rect r, const char *text, float size, float white) {
  id l = add(parent, "UILabel", r, false);
  send_id(l, "setText:", string(text));
  send_id(l, "setFont:", ((id(*)(id, SEL, float))objc_msgSend)(cls("UIFont"), sel("boldSystemFontOfSize:"), size));
  send_id(l, "setTextColor:", color(white, white, white, 1));
  send_id(l, "setBackgroundColor:", color(0, 0, 0, 0));
  return l;
}
static id button(id parent, Rect r, const char *title, int tag, id target) {
  id b = add(parent, "UIButton", r, false);
  ((void (*)(id, SEL, id, unsigned))objc_msgSend)(b, sel("setTitle:forState:"), string(title), 0);
  send_int(b, "setTag:", tag);
  ((void (*)(id, SEL, id, SEL, unsigned))objc_msgSend)(b, sel("addTarget:action:forControlEvents:"), target, sel("pressed:"), 1 << 6);
  return b;
}
static double now(void) {
  static mach_timebase_info_data_t rate;
  if (!rate.denom)
    mach_timebase_info(&rate);
  return (double)mach_absolute_time() * rate.numer / rate.denom * 1e-9;
}
// Replaces the file in one step: the host never reads half a status.
static void write_file(const char *name, const void *data, size_t size) {
  char path[1100], staging[1110];
  snprintf(path, sizeof path, "%s/%s", tmp, name);
  snprintf(staging, sizeof staging, "%s.new", path);
  FILE *file = fopen(staging, "wb");
  if (!file)
    return;
  fwrite(data, 1, size, file);
  fclose(file);
  rename(staging, path);
}

// ---- render thread

static float timing[5][WINDOW]; // submit, present, interval between presents, prepare, GPU when profiling (ms)
static bool profile;
static unsigned frames;
static char command[40], captured[40], failure[256];
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
static void status(int place) {
  char text[2048], error[256], screened[40];
  control_escape(error, sizeof error, failure);
  pthread_mutex_lock(&lock);
  memcpy(screened, shared.screened, sizeof screened);
  pthread_mutex_unlock(&lock);
  unsigned n = frames < WINDOW ? frames : WINDOW;
  float interval = 0;
  for (unsigned i = 0; i < n; i++)
    interval += timing[2][i];
  task_basic_info_data_t task;
  mach_msg_type_number_t count = TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_BASIC_INFO, (task_info_t)&task, &count) != KERN_SUCCESS)
    task.resident_size = 0;
  int at = snprintf(text, sizeof text,
                    "{\"build\":\"%s\",\"state\":\"%s\",\"error\":\"%s\",\"place\":\"%s\",\"shots\":%u,\"shot\":%u,\"shotName\":\"%s\","
                    "\"time\":%.3f,\"cinematic\":%s,\"paused\":%s,\"camera\":[%.3f,%.3f,%.3f],\"frame\":%u,\"fps\":%.3f,",
                    ATLAS_BUILD, failure[0] ? "error" : place < 0 ? "atlas" : "running", error, place < 0 ? "" : places[place][0],
                    scene_shot_count(), atlas.shot, place < 0 ? "" : scene_shot_name(atlas.shot), atlas.time, atlas.cinematic ? "true" : "false",
                    atlas.paused ? "true" : "false", atlas.position[0], atlas.position[1], atlas.position[2], frames,
                    interval > 0 ? n * 1000 / interval : 0);
  // The same windows as PR #15's frameTiming: the last 120 presented frames.
  at += summary(text + at, sizeof text - at, "renderMs", timing[0], NULL);
  at += summary(text + at, sizeof text - at, "presentMs", timing[1], NULL);
  at += summary(text + at, sizeof text - at, "workMs", timing[0], timing[1]);
  at += summary(text + at, sizeof text - at, "intervalMs", timing[2], NULL);
  at += summary(text + at, sizeof text - at, "prepareMs", timing[3], NULL);
  at += summary(text + at, sizeof text - at, "gpuMs", timing[4], NULL);
  at += snprintf(text + at, sizeof text - at,
                 "\"draws\":%u,\"triangles\":%u,\"mirrorTriangles\":%u,\"sprites\":%u,\"lod\":%.2f,\"reflection\":%s,\"rain\":%s,"
                 "\"glow\":%s,\"profile\":%s,\"residentBytes\":%u,\"glError\":%u,\"lastCommand\":\"%s\",\"capture\":\"%s\",\"screen\":\"%s\"}",
                 atlas.draws, atlas.triangles, atlas.mirror_triangles, atlas.sprites, atlas.lod, atlas.reflection ? "true" : "false",
                 atlas.rain ? "true" : "false", atlas.glow ? "true" : "false", profile ? "true" : "false", (unsigned)task.resident_size, glGetError(), command, captured, screened);
  write_file("status.json", text, at);
}
static void *render(void *unused) {
  (void)unused;
  send_id(cls("EAGLContext"), "setCurrentContext:", context);
  int place = ATLAS;
  bool loaded = false, capture = false;
  double previous = now(), started = previous, reported = 0;
  char path[1200], json[1024];
  snprintf(path, sizeof path, "%s/control.json", tmp);
  unlink(path);
  for (;;) {
    id pool = send(send(cls("NSAutoreleasePool"), "alloc"), "init");
    pthread_mutex_lock(&lock);
    while (!shared.active) {
      // Background GL kills the process: finish, then wait to be resumed.
      glFinish();
      shared.parked = true;
      pthread_cond_broadcast(&changed);
      pthread_cond_wait(&changed, &lock);
      previous = now();
    }
    shared.parked = false;
    float look[2] = {shared.look[0], shared.look[1]}, move[2] = {shared.move[0], shared.move[1]};
    int request = shared.request, action = shared.action;
    shared.look[0] = shared.look[1] = 0;
    shared.request = NONE;
    shared.action = 0;
    pthread_mutex_unlock(&lock);

    // Commands from the host (tools/atlas-ipod.ts ctl): a JSON file replaced
    // in one step, acknowledged by its nonce in the status.
    FILE *file = fopen(path, "rb");
    json[0] = 0;
    if (file) {
      json[fread(json, 1, sizeof json - 1, file)] = 0;
      fclose(file);
      unlink(path);
      char id[96];
      bool leave = false;
      if (control_string(json, "place", id, sizeof id))
        for (int i = 0; i < place_count; i++)
          if (!strcmp(id, places[i][0]) && (i != place || !loaded))
            request = i;
      if (control_bool(json, "atlas", &leave) && leave)
        request = ATLAS;
      control_bool(json, "capture", &capture);
      bool screen = false;
      pthread_mutex_lock(&lock);
      control_bool(json, "bar", &shared.bar);
      if (control_bool(json, "screen", &screen) && screen)
        control_string(json, "nonce", shared.screen, sizeof shared.screen);
      pthread_mutex_unlock(&lock);
      // Waits for the GPU inside every frame: its time, not a frame rate.
      control_bool(json, "profile", &profile);
    }
    if (request != NONE) {
      scene_free();
      place = request;
      loaded = false;
      failure[0] = 0;
      frames = 0;
      if (place >= 0) {
        char pack[1200];
        snprintf(pack, sizeof pack, "%s/%s.place", bundle, places[place][0]);
        loaded = scene_load(pack, failure, sizeof failure);
      }
      pthread_mutex_lock(&lock);
      shared.shown = loaded ? place : ATLAS;
      snprintf(shared.message, sizeof shared.message, "%s", failure);
      pthread_mutex_unlock(&lock);
      previous = now();
    }
    if (json[0]) {
      scene_control(json);
      control_string(json, "nonce", command, sizeof command);
    }
    if (!loaded) {
      if (now() - reported > 0.5) {
        reported = now();
        status(ATLAS);
      }
      usleep(100000);
      send(pool, "drain");
      continue;
    }
    if (action == ACTION_PAUSE)
      atlas.paused = !atlas.paused;
    else if (action)
      scene_shot(atlas.shot + (action == ACTION_NEXT ? 1 : scene_shot_count() - 1), false);

    double start = now();
    scene_update(fminf((float)(start - started), 0.1f), look, move);
    started = start;
    scene_prepare();
    double prepared = now();
    scene_render(framebuffer);
    double drawn = now();
    if (profile)
      glFinish();
    timing[3][frames % WINDOW] = (float)(prepared - start) * 1000;
    timing[4][frames % WINDOW] = (float)(now() - drawn) * 1000;
    if (capture) {
      // Rows of the portrait drawable from its bottom; the host turns them.
      static uint8_t pixels[320 * 480 * 4];
      glReadPixels(0, 0, 320, 480, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      write_file("frame.rgba", pixels, sizeof pixels);
      snprintf(captured, sizeof captured, "%s", command);
      capture = false;
      reported = 0;
      start = now(); // a readback is not a frame's work
    }
    const GLenum depth = GL_DEPTH_ATTACHMENT;
    glDiscardFramebufferEXT(GL_FRAMEBUFFER, 1, &depth);
    glBindRenderbuffer(GL_RENDERBUFFER, colorbuffer);
    double submitted = now();
    ((BOOL(*)(id, SEL, unsigned))objc_msgSend)(context, sel("presentRenderbuffer:"), GL_RENDERBUFFER);
    double presented = now();
    timing[0][frames % WINDOW] = (float)(submitted - start) * 1000;
    timing[1][frames % WINDOW] = (float)(presented - submitted) * 1000;
    timing[2][frames % WINDOW] = (float)(presented - previous) * 1000;
    frames++;
    previous = presented;
    if (presented - reported > 0.5) {
      reported = presented;
      pthread_mutex_lock(&lock);
      snprintf(shared.shot, sizeof shared.shot, "%s", scene_shot_name(atlas.shot));
      pthread_mutex_unlock(&lock);
      status(place);
    }
    send(pool, "drain");
  }
  return NULL;
}

// ---- main thread

static void request(int place, int action) {
  pthread_mutex_lock(&lock);
  if (place != NONE)
    shared.request = place;
  if (place == ATLAS)
    shared.shown = ATLAS;
  shared.action = action;
  pthread_mutex_unlock(&lock);
}
static void pressed(id self, SEL _cmd, id sender) {
  (void)self, (void)_cmd;
  int tag = ((int (*)(id, SEL))objc_msgSend)(sender, sel("tag"));
  bar_shown = now();
  if (tag >= 100) {
    char text[160];
    snprintf(text, sizeof text, "Loading %s…", places[tag - 100][1]);
    send_id(message_label, "setText:", string(text));
    request(tag - 100, 0);
  } else if (tag == ACTION_ATLAS) {
    send_id(message_label, "setText:", string(""));
    send_int(menu, "setHidden:", 0);
    send_int(bar, "setHidden:", 1);
    request(ATLAS, 0);
  } else
    request(NONE, tag);
}
// The list leaves the screen once its place is drawing; the bar hides itself.
static void tick(id self, SEL _cmd, id timer) {
  (void)self, (void)_cmd, (void)timer;
  pthread_mutex_lock(&lock);
  int shown = shared.shown;
  char message[256], shot[40], screen[40], path[1100];
  memcpy(message, shared.message, sizeof message);
  memcpy(shot, shared.shot, sizeof shot);
  memcpy(screen, shared.screen, sizeof screen);
  shared.screen[0] = 0;
  if (shared.bar) {
    shared.bar = false;
    bar_shown = now();
    send_int(bar, "setHidden:", 0);
  }
  pthread_mutex_unlock(&lock);
  if (screen[0]) {
    id image = UIGetScreenImage();
    snprintf(path, sizeof path, "%s/screen.png", tmp);
    ((BOOL(*)(id, SEL, id, BOOL))objc_msgSend)(UIImagePNGRepresentation(send_id(cls("UIImage"), "imageWithCGImage:", image)),
                                              sel("writeToFile:atomically:"), string(path), 1);
    send(image, "release");
    pthread_mutex_lock(&lock);
    memcpy(shared.screened, screen, sizeof screen);
    pthread_mutex_unlock(&lock);
  }
  send_int(menu, "setHidden:", shown >= 0);
  if (shown < 0 && message[0])
    send_id(message_label, "setText:", string(message));
  send_id(shot_label, "setText:", string(shot));
  if (shown < 0 || now() - bar_shown > 4)
    send_int(bar, "setHidden:", 1);
}
// One finger on the left half walks, one on the right half looks, a tap
// calls up the bar.
static void touched(id self, SEL _cmd, id touches, id event) {
  (void)_cmd, (void)event;
  id all = send(touches, "allObjects");
  unsigned count = ((unsigned (*)(id, SEL))objc_msgSend)(all, sel("count"));
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < count; i++) {
    id touch = ((id(*)(id, SEL, unsigned))objc_msgSend)(all, sel("objectAtIndex:"), i);
    Point at = ((Point(*)(id, SEL, id))objc_msgSend_stret)(touch, sel("locationInView:"), self);
    float p[2] = {at.y, 320 - at.x}; // portrait points to landscape
    int phase = ((int (*)(id, SEL))objc_msgSend)(touch, sel("phase")), slot = contacts[0].touch == touch ? 0 : contacts[1].touch == touch ? 1 : -1;
    if (phase == 0) {
      slot = !contacts[0].touch ? 0 : !contacts[1].touch ? 1 : -1;
      if (slot >= 0)
        contacts[slot] = (typeof(contacts[0])){touch, {p[0], p[1]}, {p[0], p[1]}, now(), false};
      continue;
    }
    if (slot < 0)
      continue;
    bool walking = contacts[slot].start[0] < 240;
    float dx = p[0] - contacts[slot].start[0], dy = p[1] - contacts[slot].start[1];
    contacts[slot].moved = contacts[slot].moved || dx * dx + dy * dy > 100;
    if (walking && contacts[slot].moved) {
      shared.move[0] = fmaxf(-1, fminf(1, dx / 60));
      shared.move[1] = fmaxf(-1, fminf(1, -dy / 60));
    } else if (contacts[slot].moved) {
      shared.look[0] += (p[0] - contacts[slot].last[0]) * 0.006f;
      shared.look[1] -= (p[1] - contacts[slot].last[1]) * 0.006f;
    }
    contacts[slot].last[0] = p[0], contacts[slot].last[1] = p[1];
    if (phase >= 3) {
      if (walking)
        shared.move[0] = shared.move[1] = 0;
      if (!contacts[slot].moved && now() - contacts[slot].began < 0.4) {
        bar_shown = now();
        send_int(bar, "setHidden:", 0);
      }
      contacts[slot].touch = NULL;
    }
  }
  pthread_mutex_unlock(&lock);
}
static Class layer_class(id self, SEL _cmd) {
  (void)self, (void)_cmd;
  return objc_getClass("CAEAGLLayer");
}
static void active(id self, SEL _cmd, id application) {
  (void)self, (void)application;
  pthread_mutex_lock(&lock);
  shared.active = _cmd == sel("applicationDidBecomeActive:");
  shared.move[0] = shared.move[1] = 0;
  contacts[0].touch = contacts[1].touch = NULL;
  pthread_cond_broadcast(&changed);
  while (!shared.active && !shared.parked)
    pthread_cond_wait(&changed, &lock);
  pthread_mutex_unlock(&lock);
}
static BOOL launched(id self, SEL _cmd, id application, id options) {
  (void)_cmd, (void)options;
  snprintf(bundle, sizeof bundle, "%s", ((const char *(*)(id, SEL))objc_msgSend)(send(send(cls("NSBundle"), "mainBundle"), "bundlePath"), sel("UTF8String")));
  snprintf(tmp, sizeof tmp, "%s/tmp", getenv("HOME"));
  // places.tsv (tools/atlas-ipod.ts): id, name and locality of each place.
  char path[1200], line[320];
  snprintf(path, sizeof path, "%s/places.tsv", bundle);
  FILE *file = fopen(path, "r");
  while (file && place_count < MAX_PLACES && fgets(line, sizeof line, file))
    if (sscanf(line, "%95[^\t]\t%95[^\t]\t%95[^\n]", places[place_count][0], places[place_count][1], places[place_count][2]) == 3)
      place_count++;
  if (file)
    fclose(file);

  id window = ((id(*)(id, SEL, Rect))objc_msgSend)(send(cls("UIWindow"), "alloc"), sel("initWithFrame:"), (Rect){0, 0, 320, 480});
  view = add(window, "AtlasView", (Rect){0, 0, 320, 480}, false);
  send_int(view, "setMultipleTouchEnabled:", 1);
  send_int(send(view, "layer"), "setOpaque:", 1);
  context = ((id(*)(id, SEL, int))objc_msgSend)(send(cls("EAGLContext"), "alloc"), sel("initWithAPI:"), 2);
  send_id(cls("EAGLContext"), "setCurrentContext:", context);
  GLuint depth;
  glGenFramebuffers(1, &framebuffer);
  glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
  glGenRenderbuffers(1, &colorbuffer);
  glBindRenderbuffer(GL_RENDERBUFFER, colorbuffer);
  ((BOOL(*)(id, SEL, unsigned, id))objc_msgSend)(context, sel("renderbufferStorage:fromDrawable:"), GL_RENDERBUFFER, send(view, "layer"));
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, colorbuffer);
  glGenRenderbuffers(1, &depth);
  glBindRenderbuffer(GL_RENDERBUFFER, depth);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, 320, 480); // OES_depth24
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
  if (!context || glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    snprintf(shared.message, sizeof shared.message, "OpenGL ES 2 is not available");
  send_id(cls("EAGLContext"), "setCurrentContext:", NULL);

  menu = add(window, "UIView", (Rect){0, 0, 480, 320}, true);
  send_id(menu, "setBackgroundColor:", color(0.04f, 0.05f, 0.07f, 1));
  label(menu, (Rect){16, 10, 300, 28}, "Pocket Atlas", 22, 1);
  message_label = label(menu, (Rect){16, 288, 448, 22}, "", 13, 0.7f);
  id list = add(menu, "UIScrollView", (Rect){0, 46, 480, 236}, false);
  ((void (*)(id, SEL, Point))objc_msgSend)(list, sel("setContentSize:"), (Point){16 + place_count * 276, 236});
  for (int i = 0; i < place_count; i++) {
    id card = button(list, (Rect){16 + i * 276, 0, 260, 146}, "", 100 + i, self);
    snprintf(path, sizeof path, "%s/%s.jpg", bundle, places[i][0]);
    id image = send_id(cls("UIImage"), "imageWithContentsOfFile:", string(path));
    ((void (*)(id, SEL, id, unsigned))objc_msgSend)(card, sel("setBackgroundImage:forState:"), image, 0);
    label(list, (Rect){16 + i * 276, 154, 260, 22}, places[i][1], 16, 1);
    label(list, (Rect){16 + i * 276, 176, 260, 18}, places[i][2], 12, 0.6f);
  }
  bar = add(window, "UIView", (Rect){0, 0, 480, 44}, true);
  send_id(bar, "setBackgroundColor:", color(0, 0, 0, 0.55f));
  send_int(bar, "setHidden:", 1);
  button(bar, (Rect){8, 0, 70, 44}, "Atlas", ACTION_ATLAS, self);
  button(bar, (Rect){150, 0, 44, 44}, "<", ACTION_PREVIOUS, self);
  shot_label = label(bar, (Rect){194, 0, 132, 44}, "", 15, 1);
  send_int(shot_label, "setTextAlignment:", 1);
  button(bar, (Rect){326, 0, 44, 44}, ">", ACTION_NEXT, self);
  button(bar, (Rect){402, 0, 70, 44}, "Pause", ACTION_PAUSE, self);
  send(window, "makeKeyAndVisible");
  send_int(application, "setIdleTimerDisabled:", 1);
  ((id(*)(id, SEL, double, id, SEL, id, BOOL))objc_msgSend)(cls("NSTimer"), sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
                                                          0.2, self, sel("tick:"), NULL, 1);
  pthread_t thread;
  pthread_create(&thread, NULL, render, NULL);
  return 1;
}
int main(int argc, char **argv) {
  send(send(cls("NSAutoreleasePool"), "alloc"), "init");
  Class surface = objc_allocateClassPair(objc_getClass("UIView"), "AtlasView", 0);
  class_addMethod(object_getClass((id)surface), sel("layerClass"), (IMP)layer_class, "#@:");
  static const char *const touches[] = {"touchesBegan:withEvent:", "touchesMoved:withEvent:", "touchesEnded:withEvent:",
                                        "touchesCancelled:withEvent:"};
  for (unsigned i = 0; i < 4; i++)
    class_addMethod(surface, sel(touches[i]), (IMP)touched, "v@:@@");
  objc_registerClassPair(surface);
  Class delegate = objc_allocateClassPair(objc_getClass("NSObject"), "AtlasDelegate", 0);
  class_addMethod(delegate, sel("application:didFinishLaunchingWithOptions:"), (IMP)launched, "c@:@@");
  class_addMethod(delegate, sel("applicationWillResignActive:"), (IMP)active, "v@:@");
  class_addMethod(delegate, sel("applicationDidBecomeActive:"), (IMP)active, "v@:@");
  class_addMethod(delegate, sel("pressed:"), (IMP)pressed, "v@:@");
  class_addMethod(delegate, sel("tick:"), (IMP)tick, "v@:@");
  objc_registerClassPair(delegate);
  return UIApplicationMain(argc, argv, NULL, string("AtlasDelegate"));
}
