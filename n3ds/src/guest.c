#include "guest.h"
#include "gfx.h"
#include "input.h"
#include "interface.h"
#include "offload.h"
#include "pocket_core.h"
#include "qjs.h"
#include <3ds.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// The guest turns this often, and is told so before it mounts.
#define TURN (1.0f / 30)
static const char rate[] = "globalThis.__simHz=30;";
static bool running, hidden;
static char failure[160];
static float owed = TURN;
static size_t words[2];
// The DrawList backend sets its vertex layout once, on citro3d's own
// objects; the scene and the globe set theirs every frame.
static C3D_AttrInfo attributes;
static C3D_BufInfo buffers;
static uint32_t presses[16];
static unsigned press_count, press_turns;
static bool stylus;
static uint32_t stylus_at;
// The guest rests when no button or stylus has been down for STILL turns and
// neither the state it is shown nor what it draws changed in the last one.
// Resting, it is looked in on every LOOK_IN turns (about once a second): its
// timers follow the wall, not its turns (ui/app/clock.ts).
enum { STILL = 20, LOOK_IN = 30 };
static bool stale;
static unsigned still, skipped;
static uint32_t drawn[2];
// What a turn costs, smoothed: the script, the layout, the two draw lists
// and their vertices, in milliseconds.
static float cost[4];
static unsigned long turns;
static u64 mark;
static void lap(unsigned part) {
  u64 now = svcGetSystemTick();
  float ms = (float)(now - mark) * 1000.0f / SYSCLOCK_ARM11;
  cost[part] += (ms - cost[part]) * 0.125f;
  mark = now;
}
unsigned long guest_cost(float out[4]) {
  memcpy(out, cost, sizeof cost);
  return turns;
}
static uint32_t digest(const uint32_t *words, size_t count) {
  uint32_t hash = 2166136261u ^ (uint32_t)count;
  for (size_t i = 0; i < count; i++)
    hash = (hash ^ words[i]) * 16777619u;
  return hash;
}

// PocketJS's guest driver reaches its companion services through these;
// this application has none.
void offload_frame(void) {}
int offload_session(void) { return 0; }
bool offload_submit(const char *bytes, size_t length) {
  (void)bytes, (void)length;
  return false;
}
size_t offload_take(char *out) {
  (void)out;
  return 0;
}
// The guest's DevTools would take the control lines meant for the renderer.
bool interface_devtools(void) { return false; }

static char *read_file(const char *path, const char *before, size_t *size) {
  FILE *file = fopen(path, "rb");
  if (!file)
    return NULL;
  fseek(file, 0, SEEK_END);
  size_t length = ftell(file), lead = strlen(before);
  rewind(file);
  char *data = malloc(lead + length + 1);
  if (data) {
    memcpy(data, before, lead);
    *size = lead + fread(data + lead, 1, length, file);
    data[*size] = 0;
  }
  fclose(file);
  return data;
}
bool guest_boot(char *error, size_t capacity) {
  size_t script_size = 0, pak_size = 0;
  // The pak is the guest's for good; the script only until it has run.
  char *pak = read_file("romfs:/atlas.pak", "", &pak_size);
  char *script = read_file("romfs:/atlas.js", rate, &script_size);
  ui_init(1);
  ui_set_viewport(400, 240);
  if (!pak || !script)
    snprintf(failure, sizeof failure, "atlas.js or atlas.pak is missing");
  else if (!ui_create_auxiliary_surface(320, 240))
    snprintf(failure, sizeof failure, "no memory for the touch screen");
  else {
    ui_feed_pak((const uint8_t *)pak, pak_size);
    if (!qjs_boot(script, script_size, (const uint8_t *)pak, pak_size))
      snprintf(failure, sizeof failure, "%s", qjs_last_error());
    else if (!gfx_init(400, 240))
      snprintf(failure, sizeof failure, "no memory for the interface");
    else {
      attributes = *C3D_GetAttrInfo();
      buffers = *C3D_GetBufInfo();
      input_init();
      running = true;
    }
  }
  free(script);
  snprintf(error, capacity, "%s", failure);
  return running;
}
const char *guest_error(void) { return failure; }
void guest_show(bool shown) { hidden = !shown; }
bool guest_shown(void) { return running && !hidden; }
void guest_press(uint32_t buttons) {
  if (press_count < sizeof presses / sizeof *presses)
    presses[press_count++] = buttons;
}
void guest_touch(bool down, int x, int y) {
  stylus = down;
  stylus_at = (uint32_t)y << 9 | (uint32_t)x;
}
void guest_turn(float dt) {
  owed += dt;
  if (owed > 2 * TURN)
    owed = 2 * TURN;
  if (!running || hidden || owed < TURN)
    return;
  owed -= TURN;
  int32_t buttons = input_buttons();
  uint32_t touch = 0;
  size_t touches = input_touch(&touch);
  // A press from a control message is held two turns and let go for one.
  if (press_count) {
    if (++press_turns < 3)
      buttons |= presses[0];
    else {
      memmove(presses, presses + 1, --press_count * sizeof *presses);
      press_turns = 0;
    }
  }
  if (stylus && !touches) {
    touch = stylus_at;
    touches = 1;
  }
  if (buttons || touches)
    still = 0;
  else if (interface_pending() && still > STILL - 1)
    still = STILL - 1;
  if (still >= STILL && ++skipped < LOOK_IN)
    return;
  skipped = 0;
  turns++;
  int32_t hit = 0;
  ui_touch_hits_auxiliary(touches ? &touch : NULL, touches, &hit, 1);
  mark = svcGetSystemTick();
  if (!qjs_frame(buttons, input_analog(), &touch, &hit, touches,
                 input_right_analog())) {
    snprintf(failure, sizeof failure, "%s", qjs_last_error());
    running = false;
    return;
  }
  lap(0);
  // Two core ticks to a turn: the core counts sixtieths.
  ui_tick();
  ui_tick();
  lap(1);
  words[0] = ui_draw();
  words[1] = ui_draw_auxiliary();
  uint32_t now[2] = {digest(ui_draw_list_ptr(), words[0]),
                     digest(ui_draw_auxiliary_list_ptr(), words[1])};
  if (still < STILL)
    still++;
  if (memcmp(now, drawn, sizeof now)) {
    // Something is moving: the next turns show whether it still is.
    memcpy(drawn, now, sizeof now);
    stale = true;
    if (still > STILL - 1)
      still = STILL - 1;
  }
  lap(2);
}
void guest_prepare(void) {
  // The vertices of the last frame stand until the picture changes.
  if (!running || hidden || !stale)
    return;
  stale = false;
  mark = svcGetSystemTick();
  gfx_begin_frame();
  gfx_prepare_surface(0, ui_draw_list_ptr(), words[0], 400, 240);
  gfx_prepare_surface(1, ui_draw_auxiliary_list_ptr(), words[1], 320, 240);
  gfx_finish_frame();
  lap(3);
}
static void draw(uint32_t surface) {
  C3D_SetAttrInfo(&attributes);
  C3D_SetBufInfo(&buffers);
  C3D_AlphaTest(false, GPU_ALWAYS, 0);
  C3D_StencilTest(false, GPU_ALWAYS, 0, 0xff, 0xff);
  C3D_FogGasMode(GPU_NO_FOG, GPU_PLAIN_DENSITY, false);
  C3D_SetScissor(GPU_SCISSOR_DISABLE, 0, 0, 0, 0);
  gfx_draw_surface(surface);
}
void guest_draw_top(unsigned scale) {
  if (!running || hidden)
    return;
  C3D_SetViewport(0, 0, 240 * scale, 400 * scale);
  draw(0);
}
void guest_draw_bottom(C3D_RenderTarget *bottom) {
  // A target nothing was drawn on is not presented: the touch screen keeps
  // its picture until the interface draws another.
  static bool presented;
  static uint32_t picture;
  uint32_t wanted = running && !hidden ? drawn[1] : 0;
  if (presented && wanted == picture)
    return;
  presented = true;
  picture = wanted;
  C3D_RenderTargetClear(bottom, C3D_CLEAR_ALL, 0x0c0e14ff, 0);
  C3D_FrameDrawOn(bottom);
  if (!running || hidden)
    return;
  C3D_SetViewport(0, 0, 240, 320);
  draw(1);
}
