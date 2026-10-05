#include "interface.h"
#include "control.h"
#include "svcwire.h" // PocketJS's declaration of the service wire for this host
#include <stdio.h>
#include <string.h>

Interface interface;
static Interface sent;
static bool opened, fresh;
// Lines from the guest: one frame sends a handful at most.
enum { QUEUE = 16, LINE = 1200 };
static char lines[QUEUE][LINE];
static unsigned head, count;

#ifdef __3DS__
bool svcwire_open(const char *app) {
#else
int svcwire_open(const char *app) {
#endif
  opened = !strcmp(app, "pocket.overlay");
  fresh = true; // a fresh guest gets the whole state
  return opened;
}
void svcwire_pump(void) {}
bool interface_pending(void) { return opened && (fresh || memcmp(&sent, &interface, sizeof sent)); }
size_t svcwire_recv_lines(char *out, size_t capacity) {
  if (!interface_pending())
    return 0;
  // Only the fields that changed go out: the guest keeps the rest, and a
  // statistics line twice a second is then a few dozen bytes to parse.
  static const char *const scenes[] = {"atlas", "loading", "place", "error"};
  char text[2 * sizeof interface.prefs];
  size_t n = 0;
#define PUT(...) n += (size_t)snprintf(out + (n < capacity ? n : capacity), n < capacity ? capacity - n : 0, __VA_ARGS__)
#define CHANGED(field) (fresh || memcmp(&sent.field, &interface.field, sizeof sent.field))
#define TEXT(field) (fresh || strcmp(sent.field, interface.field))
  PUT("{\"type\":\"state\",\"value\":{");
  size_t empty = n;
  if (CHANGED(scene))
    PUT("\"scene\":\"%s\",", scenes[interface.scene & 3]);
  if (TEXT(place))
    PUT("\"place\":\"%s\",", interface.place);
  if (TEXT(message)) {
    control_escape(text, sizeof text, interface.message);
    PUT("\"message\":\"%s\",", text);
  }
  if (TEXT(installed))
    PUT("\"installed\":[%s],", interface.installed);
  if (TEXT(shots))
    PUT("\"shots\":[%s],", interface.shots);
  if (CHANGED(shot))
    PUT("\"shot\":%u,", interface.shot);
  if (CHANGED(tour))
    PUT("\"tour\":%s,", interface.tour ? "true" : "false");
  if (CHANGED(paused))
    PUT("\"paused\":%s,", interface.paused ? "true" : "false");
  if (TEXT(options))
    PUT("\"options\":[%s],", interface.options);
  if (TEXT(stats)) {
    control_escape(text, sizeof text, interface.stats);
    PUT("\"stats\":\"%s\",", text);
  }
  if (CHANGED(lat))
    PUT("\"lat\":%.3f,", interface.lat);
  if (CHANGED(lon))
    PUT("\"lon\":%.3f,", interface.lon);
  if (TEXT(prefs)) {
    control_escape(text, sizeof text, interface.prefs);
    PUT("\"prefs\":\"%s\",", text);
  }
#undef PUT
#undef CHANGED
#undef TEXT
  if (n + 3 >= capacity)
    return 0;
  sent = interface;
  fresh = false;
  if (n == empty)
    return 0; // only bytes past the end of a text differed
  memcpy(out + n - 1, "}}\n", 4);
  return n + 2;
}
void svcwire_send_line(const char *line, size_t length) {
  if (count == QUEUE || length >= LINE)
    return; // nothing the guest sends is worth more than the frame
  char *slot = lines[(head + count++) % QUEUE];
  memcpy(slot, line, length);
  slot[length] = 0;
}
void svcwire_reset(void) { head = count = 0; }
void svcwire_shutdown(void) { opened = false; }

bool interface_next(Command *out) {
  static const char *const names[] = {"", "globe", "pins", "spin", "enter", "leave", "shot", "tour",
                                      "pause", "option", "drive", "look", "hold", "prefs", "quiet"};
  while (count) {
    const char *json = lines[head];
    head = (head + 1) % QUEUE;
    count--;
    char type[16];
    if (!control_string(json, "type", type, sizeof type))
      continue;
    memset(out, 0, sizeof *out);
    for (unsigned i = 1; i < sizeof names / sizeof *names; i++)
      if (!strcmp(type, names[i]))
        out->type = (CommandType)i;
    if (!out->type)
      continue;
#define NUMBER(field) out->field = (float)control_number(json, #field, 0)
    NUMBER(x), NUMBER(y), NUMBER(r), NUMBER(lat), NUMBER(lon), NUMBER(dx), NUMBER(dy);
    NUMBER(mx), NUMBER(my), NUMBER(lx), NUMBER(ly);
#undef NUMBER
    out->mx /= 100, out->my /= 100, out->lx /= 100, out->ly /= 100;
    out->index = (int)control_number(json, "index", 0);
    out->pin = (int)control_number(json, "pin", -1);
    out->value = (int)control_number(json, "value", 0);
    control_bool(json, "on", &out->on);
    static const char *const texts[] = {"place", "key", "list", "value"};
    for (unsigned i = 0; i < 4 && !out->text[0]; i++)
      control_string(json, texts[i], out->text, sizeof out->text);
    return true;
  }
  return false;
}
void interface_append(char *body, size_t capacity, const char *text) {
  size_t at = strlen(body);
  if (at + 2 * strlen(text) + 4 >= capacity)
    return;
  if (at)
    body[at++] = ',';
  body[at++] = '"';
  control_escape(body + at, capacity - at - 1, text);
  strcat(body, "\"");
}
void interface_switch(const char *key, bool on) {
  size_t at = strlen(interface.options);
  snprintf(interface.options + at, sizeof interface.options - at, "%s{\"key\":\"%s\",\"value\":%d}", at ? "," : "", key, on);
}
