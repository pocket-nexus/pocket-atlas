// Pocket Atlas on the iPod touch 4 (iOS 6): the shell around the place
// renderer (scene.c), the globe (globe.c) and the interface, a PocketJS guest
// (ui/, QuickJS) drawn over both. The device builds from the macOS SDK's C
// headers, so UIKit is reached through the Objective-C runtime. The main
// thread owns UIKit and receives touches; one render thread owns the GL
// context, the scene and the guest, and they share only `shared` under its
// lock.
//
// The EAGL layer is the portrait screen at 320x480, opaque and untransformed,
// with nothing over it: Core Animation shows the frame as it is instead of
// compositing it with the same GPU. The interface is drawn into a texture
// when what it shows changes, and that texture is laid over the frame; while
// it shows nothing (a tour, nobody touching) the frame is the place alone and
// costs what the place costs. Everything is drawn a quarter turn round, for a
// device held with its home button on the right.
#include "../../n3ds/src/control.h"
#include "../../n3ds/src/interface.h"
#include "contact_latch.h"
#include "globe.h"
#include "pocket_runtime.h"
#include "scene.h"
#define GL_SILENCE_DEPRECATION 1
#include <OpenGL/gl3.h>
#include <dirent.h>
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
} Point; // CGPoint: CGFloat is a float on this device
typedef struct {
  float x, y, width, height;
} Rect;
extern int UIApplicationMain(int, char **, id, id);
extern void glDiscardFramebufferEXT(GLenum, GLsizei, const GLenum *);
extern uint64_t ui_draw_hash(void);
extern int32_t ui_gl_render_over(int32_t, int32_t, int32_t, int32_t, int32_t, int32_t);
// The interface's screen (landscape) and the drawable (portrait), in pixels.
enum { WIDTH = 480, HEIGHT = 320, WINDOW = 120 };

static struct {
  PocketContactLatch touches;
  bool active, parked;
} shared = {.active = true};
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static char bundle[1024], tmp[1024], documents[1024];
static id context, view;
static GLuint framebuffer, colorbuffer;

static SEL sel(const char *name) { return sel_registerName(name); }
static id cls(const char *name) { return (id)objc_getClass(name); }
static id send(id object, const char *name) { return ((id(*)(id, SEL))objc_msgSend)(object, sel(name)); }
static id send_id(id object, const char *name, id value) { return ((id(*)(id, SEL, id))objc_msgSend)(object, sel(name), value); }
static void send_int(id object, const char *name, int value) { ((void (*)(id, SEL, int))objc_msgSend)(object, sel(name), value); }
static id string(const char *text) {
  return ((id(*)(id, SEL, const char *))objc_msgSend)(cls("NSString"), sel("stringWithUTF8String:"), text);
}
static double now(void) {
  static mach_timebase_info_data_t rate;
  if (!rate.denom)
    mach_timebase_info(&rate);
  return (double)mach_absolute_time() * rate.numer / rate.denom * 1e-9;
}
// Replaces the file in one step: the host never reads half a status.
static void write_file(const char *directory, const char *name, const void *data, size_t size) {
  char path[1100], staging[1110];
  snprintf(path, sizeof path, "%s/%s", directory, name);
  snprintf(staging, sizeof staging, "%s.new", path);
  FILE *file = fopen(staging, "wb");
  if (!file)
    return;
  fwrite(data, 1, size, file);
  fclose(file);
  rename(staging, path);
}
// A whole file, with a NUL after it; `before` goes in front.
static char *read_file(const char *directory, const char *name, const char *before, size_t *size) {
  char path[1100];
  snprintf(path, sizeof path, "%s/%s", directory, name);
  FILE *file = fopen(path, "rb");
  if (!file)
    return NULL;
  fseek(file, 0, SEEK_END);
  size_t length = ftell(file), lead = strlen(before);
  rewind(file);
  char *data = malloc(lead + length + 1);
  memcpy(data, before, lead);
  *size = lead + fread(data + lead, 1, length, file);
  data[*size] = 0;
  fclose(file);
  return data;
}

// ---- render thread

static float timing[7][WINDOW]; // submit, present, interval, prepare, GPU when profiling, guest turn, interface redraw (ms)
static bool profile, loaded, statistics, quiet;
static unsigned frames, redraws;
static char command[40], captured[40], failure[256];
static GLuint interface_target, interface_texture, overlay;
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
static float rate(void) {
  unsigned n = frames < WINDOW ? frames : WINDOW;
  float interval = 0;
  for (unsigned i = 0; i < n; i++)
    interval += timing[2][i];
  return interval > 0 ? n * 1000 / interval : 0;
}
static void status(void) {
  static const char *const scenes[] = {"atlas", "loading", "running", "error"};
  char text[2560], error[256];
  control_escape(error, sizeof error, failure);
  task_basic_info_data_t task;
  mach_msg_type_number_t count = TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_BASIC_INFO, (task_info_t)&task, &count) != KERN_SUCCESS)
    task.resident_size = 0;
  int at = snprintf(text, sizeof text,
                    "{\"build\":\"%s\",\"state\":\"%s\",\"error\":\"%s\",\"place\":\"%s\",\"shots\":%u,\"shot\":%u,\"shotName\":\"%s\","
                    "\"time\":%.3f,\"cinematic\":%s,\"paused\":%s,\"camera\":[%.3f,%.3f,%.3f],\"frame\":%u,\"fps\":%.3f,",
                    ATLAS_BUILD, scenes[interface.scene], error, interface.place, scene_shot_count(), atlas.shot,
                    loaded ? scene_shot_name(atlas.shot) : "", atlas.time, atlas.cinematic ? "true" : "false", atlas.paused ? "true" : "false",
                    atlas.position[0], atlas.position[1], atlas.position[2], frames, rate());
  // The last 120 presented frames.
  at += summary(text + at, sizeof text - at, "renderMs", timing[0], NULL);
  at += summary(text + at, sizeof text - at, "presentMs", timing[1], NULL);
  at += summary(text + at, sizeof text - at, "workMs", timing[0], timing[1]);
  at += summary(text + at, sizeof text - at, "intervalMs", timing[2], NULL);
  at += summary(text + at, sizeof text - at, "prepareMs", timing[3], NULL);
  at += summary(text + at, sizeof text - at, "gpuMs", timing[4], NULL);
  at += summary(text + at, sizeof text - at, "interfaceMs", timing[5], NULL);
  at += summary(text + at, sizeof text - at, "interfaceDrawMs", timing[6], NULL);
  at += snprintf(text + at, sizeof text - at,
                 "\"interfaceRedraws\":%u,\"interfaceQuiet\":%s,\"interfaceError\":\"%s\",\"draws\":%u,\"triangles\":%u,\"mirrorTriangles\":%u,\"sprites\":%u,"
                 "\"lod\":%.2f,\"reflection\":%s,\"rain\":%s,\"glow\":%s,\"profile\":%s,\"residentBytes\":%u,\"glError\":%u,"
                 "\"lastCommand\":\"%s\",\"capture\":\"%s\"}",
                 redraws, quiet ? "true" : "false", pocket_runtime_error(), atlas.draws, atlas.triangles, atlas.mirror_triangles, atlas.sprites, atlas.lod,
                 atlas.reflection ? "true" : "false", atlas.rain ? "true" : "false", atlas.glow ? "true" : "false",
                 profile ? "true" : "false", (unsigned)task.resident_size, glGetError(), command, captured);
  write_file(tmp, "status.json", text, at);
}

// The interface's own drawable, and the pass that lays it over the frame.
static void cover(void) {
  glGenTextures(1, &interface_texture);
  glBindTexture(GL_TEXTURE_2D, interface_texture);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, WIDTH, HEIGHT, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glGenFramebuffers(1, &interface_target);
  glBindFramebuffer(GL_FRAMEBUFFER, interface_target);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, interface_texture, 0);
  static const char *const sources[2] = {
    // The interface is landscape: its x runs down the portrait drawable.
    "attribute vec2 aPos; varying vec2 vAt;\n"
    "void main() { gl_Position = vec4(aPos, 0.0, 1.0); vAt = vec2(0.5 - aPos.y * 0.5, 0.5 + aPos.x * 0.5); }\n",
    "precision mediump float; uniform sampler2D uInterface; varying vec2 vAt;\n"
    "void main() { gl_FragColor = texture2D(uInterface, vAt); }\n"};
  overlay = glCreateProgram();
  for (unsigned i = 0; i < 2; i++) {
    GLuint shader = glCreateShader(i ? GL_FRAGMENT_SHADER : GL_VERTEX_SHADER);
    glShaderSource(shader, 1, &sources[i], NULL);
    glCompileShader(shader);
    glAttachShader(overlay, shader);
    glDeleteShader(shader);
  }
  glBindAttribLocation(overlay, 0, "aPos");
  glLinkProgram(overlay);
}

// What the interface is told, from what the renderer is doing.
static void publish(void) {
  interface.shot = atlas.shot;
  interface.tour = atlas.cinematic;
  interface.paused = atlas.paused;
  if (!loaded)
    return;
  interface.options[0] = 0;
  if (atlas.features & 1)
    interface_switch("rain", atlas.rain);
  if (atlas.features & 4)
    interface_switch("reflection", atlas.reflection);
  if (atlas.features & 8)
    interface_switch("glow", atlas.glow);
  interface_switch("stats", statistics);
}
static void leave(void) {
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
  char pack[1200];
  snprintf(pack, sizeof pack, "%s/%s.place", bundle, interface.place);
  failure[0] = 0;
  loaded = scene_load(pack, failure, sizeof failure);
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
    break;
  case COMMAND_DRIVE:
    sticks.move[0] = c->mx, sticks.move[1] = c->my, sticks.look[0] = c->lx, sticks.look[1] = c->ly;
    break;
  case COMMAND_PREFS:
    snprintf(interface.prefs, sizeof interface.prefs, "%s", c->text);
    write_file(documents, "interface.json", c->text, strlen(c->text));
    break;
  case COMMAND_QUIET: quiet = c->on; break;
  default: break; // COMMAND_LOOK, COMMAND_HOLD: this device has neither a look pad nor a pad
  }
}

static void *render(void *unused) {
  (void)unused;
  send_id(cls("EAGLContext"), "setCurrentContext:", context);
  cover();
  char path[1200], json[1024];
  snprintf(path, sizeof path, "%s/globe.rgba", bundle);
  if (!globe_load(path))
    snprintf(failure, sizeof failure, "globe.rgba is missing");

  // The interface: its bundle and pak beside the executable. The renderers
  // step it thirty times a second, and say so before it mounts.
  size_t script_size, pak_size, prefs_size;
  char *script = read_file(bundle, "atlas.js", "globalThis.__simHz=30;", &script_size), *pak = read_file(bundle, "atlas.pak", "", &pak_size);
  if (!script || !pak || !pocket_runtime_boot(script, script_size, (const uint8_t *)pak, pak_size, WIDTH, HEIGHT) || !pocket_runtime_gl_initialize())
    snprintf(failure, sizeof failure, "interface: %s", script && pak ? pocket_runtime_error() : "atlas.js or atlas.pak is missing");
  DIR *directory = opendir(bundle);
  for (struct dirent *entry; directory && (entry = readdir(directory));) {
    char *suffix = strstr(entry->d_name, ".place");
    if (suffix && !suffix[6]) {
      *suffix = 0;
      interface_append(interface.installed, sizeof interface.installed, entry->d_name);
    }
  }
  if (directory)
    closedir(directory);
  char *prefs = read_file(documents, "interface.json", "", &prefs_size);
  if (prefs)
    snprintf(interface.prefs, sizeof interface.prefs, "%s", prefs);
  free(prefs);

  bool capture = false, screen = false;
  double previous = now(), started = previous, reported = 0, turn = 0;
  unsigned waited = 0, idle = 0;
  uint64_t drawn_hash = 0;
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
      previous = started = now();
    }
    shared.parked = false;
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
      bool atlas_screen = false;
      if (control_string(json, "place", id, sizeof id) && (strcmp(id, interface.place) || !loaded)) {
        enter(id); // at once: the rest of the command is for the place
        load();
      }
      if (control_bool(json, "atlas", &atlas_screen) && atlas_screen)
        leave();
      control_bool(json, "capture", &capture);
      control_bool(json, "screen", &screen);
      // Waits for the GPU inside every frame: its time, not a frame rate.
      control_bool(json, "profile", &profile);
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
      if (loaded)
        scene_control(json);
      control_string(json, "nonce", command, sizeof command);
      reported = 0;
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
      pthread_mutex_lock(&lock);
      for (int i = 0; i < 4; i++) {
        if (i < fingers.count)
          pocket_contact_event(&shared.touches, i < fingered.count ? POCKET_TOUCH_MOVE : POCKET_TOUCH_DOWN, -1 - i, fingers.at[i][0], fingers.at[i][1], WIDTH, HEIGHT);
        else if (i < fingered.count)
          pocket_contact_event(&shared.touches, POCKET_TOUCH_UP, -1 - i, fingered.at[i][0], fingered.at[i][1], WIDTH, HEIGHT);
      }
      fingered = fingers;
      bool touching = shared.touches.contacts[0].used || shared.touches.cancelled_count;
      if (touching || !quiet || json[0] || interface.scene == SCENE_LOADING || ++idle >= 6) {
        pocket_contacts_sample(&shared.touches, &input, WIDTH, HEIGHT, WIDTH, HEIGHT, pocket_runtime_hit_test_bounds);
        pthread_mutex_unlock(&lock);
        input.buttons = 0;
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
          glViewport(0, 0, WIDTH, HEIGHT);
          glDisable(GL_SCISSOR_TEST);
          glClearColor(0, 0, 0, 0);
          glClear(GL_COLOR_BUFFER_BIT);
          ui_gl_render_over(0, 0, WIDTH, HEIGHT, WIDTH, HEIGHT);
        }
        timing[5][frames % WINDOW] = (float)(turned - start) * 1000;
        timing[6][frames % WINDOW] = (float)(now() - turned) * 1000;
      } else
        pthread_mutex_unlock(&lock);
    }

    double prepared = start;
    if (loaded) {
      const float look[2] = {sticks.look[0] * dt * 1.8f, sticks.look[1] * dt * 1.3f};
      scene_update(dt, look, sticks.move);
      scene_prepare();
      prepared = now();
      scene_render(framebuffer);
    } else {
      float lat, lon;
      if (globe_update(dt, &lat, &lon))
        interface.lat = lat, interface.lon = lon;
      glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
      globe_render(HEIGHT, WIDTH);
    }
    static uint8_t pixels[WIDTH * HEIGHT * 4];
    if (capture) {
      // The frame before the interface: rows of the portrait drawable from
      // its bottom; the host turns them.
      glReadPixels(0, 0, HEIGHT, WIDTH, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      write_file(tmp, "frame.rgba", pixels, sizeof pixels);
    }
    if (!quiet) {
      static const float corners[8] = {-1, -1, 1, -1, -1, 1, 1, 1};
      glDisable(GL_DEPTH_TEST);
      glDisable(GL_CULL_FACE);
      glDepthMask(GL_FALSE);
      glEnable(GL_BLEND);
      glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA); // the interface's texture holds premultiplied colour
      glBindBuffer(GL_ARRAY_BUFFER, 0);
      glEnableVertexAttribArray(0);
      glDisableVertexAttribArray(1);
      glDisableVertexAttribArray(2);
      glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, corners);
      glActiveTexture(GL_TEXTURE0);
      glBindTexture(GL_TEXTURE_2D, interface_texture);
      glUseProgram(overlay);
      glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
      glDepthMask(GL_TRUE);
    }
    double drawn = now();
    if (profile)
      glFinish();
    timing[3][frames % WINDOW] = (float)(prepared - start) * 1000;
    timing[4][frames % WINDOW] = (float)(now() - drawn) * 1000;
    if (screen) {
      // The frame as presented, interface and all.
      glReadPixels(0, 0, HEIGHT, WIDTH, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      write_file(tmp, "screen.rgba", pixels, sizeof pixels);
    }
    if (capture || screen) {
      snprintf(captured, sizeof captured, "%s", command);
      capture = screen = false;
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
      if (statistics && loaded)
        snprintf(interface.stats, sizeof interface.stats, "%.0f fps · %uk triangles", rate(), (atlas.triangles + atlas.mirror_triangles + 500) / 1000);
      else
        interface.stats[0] = 0;
      status();
    }
    send(pool, "drain");
  }
  return NULL;
}

// ---- main thread

// Every finger goes to the interface, in its landscape pixels.
static void touched(id self, SEL _cmd, id touches, id event) {
  (void)_cmd, (void)event;
  id all = send(touches, "allObjects");
  unsigned count = ((unsigned (*)(id, SEL))objc_msgSend)(all, sel("count"));
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < count; i++) {
    id touch = ((id(*)(id, SEL, unsigned))objc_msgSend)(all, sel("objectAtIndex:"), i);
    Point at = ((Point(*)(id, SEL, id))objc_msgSend_stret)(touch, sel("locationInView:"), self);
    int phase = ((int (*)(id, SEL))objc_msgSend)(touch, sel("phase")); // began, moved, stationary, ended, cancelled
    pocket_contact_event(&shared.touches, phase == 0 ? POCKET_TOUCH_DOWN : phase == 3 ? POCKET_TOUCH_UP : phase == 4 ? POCKET_TOUCH_CANCEL : POCKET_TOUCH_MOVE,
                         (int)((uintptr_t)touch >> 4 & 0x3fffffff), at.y, HEIGHT - at.x, WIDTH, HEIGHT);
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
  pocket_contacts_cancel(&shared.touches);
  pthread_cond_broadcast(&changed);
  while (!shared.active && !shared.parked)
    pthread_cond_wait(&changed, &lock);
  pthread_mutex_unlock(&lock);
}
static BOOL launched(id self, SEL _cmd, id application, id options) {
  (void)self, (void)_cmd, (void)options;
  snprintf(bundle, sizeof bundle, "%s", ((const char *(*)(id, SEL))objc_msgSend)(send(send(cls("NSBundle"), "mainBundle"), "bundlePath"), sel("UTF8String")));
  snprintf(tmp, sizeof tmp, "%s/tmp", getenv("HOME"));
  snprintf(documents, sizeof documents, "%s/Documents", getenv("HOME"));

  // PocketJS's link stubs carry no UIKit version, and UIKit gives an app that
  // old one pixel per point: the layer is 320 by 480 pixels.
  id window = ((id(*)(id, SEL, Rect))objc_msgSend)(send(cls("UIWindow"), "alloc"), sel("initWithFrame:"), (Rect){0, 0, HEIGHT, WIDTH});
  view = ((id(*)(id, SEL, Rect))objc_msgSend)(send(cls("AtlasView"), "alloc"), sel("initWithFrame:"), (Rect){0, 0, HEIGHT, WIDTH});
  send_id(window, "addSubview:", view);
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
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, HEIGHT, WIDTH); // OES_depth24
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
  if (!context || glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    snprintf(failure, sizeof failure, "OpenGL ES 2 is not available");
  send_id(cls("EAGLContext"), "setCurrentContext:", NULL);
  send(window, "makeKeyAndVisible");
  send_int(application, "setIdleTimerDisabled:", 1);
  // The guest's parser recurses: give its thread the main thread's megabyte.
  pthread_t thread;
  pthread_attr_t attributes;
  pthread_attr_init(&attributes);
  pthread_attr_setstacksize(&attributes, 1 << 20);
  pthread_create(&thread, &attributes, render, NULL);
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
  objc_registerClassPair(delegate);
  return UIApplicationMain(argc, argv, NULL, string("AtlasDelegate"));
}
