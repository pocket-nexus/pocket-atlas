#ifndef ATLAS_INTERFACE_H
#define ATLAS_INTERFACE_H
#include <stdbool.h>
#include <stddef.h>
// The renderer's side of ui/app/protocol.ts: the interface is a PocketJS
// guest drawn over the scene, and the two talk in JSON lines over the
// guest's service channel (PocketJS's `pocket.overlay`), which this file
// answers in the process instead of over a wire. The renderer fills in
// `interface`; the state goes to the guest when it changed. What the guest
// asked for comes back from interface_next() after its frame.
enum { SCENE_ATLAS, SCENE_LOADING, SCENE_PLACE, SCENE_ERROR };
typedef struct {
  int scene;
  char place[64], message[160];
  // The bodies of JSON arrays, already escaped:
  // "a","b"   "Wide","Corner"   {"key":"rain","value":1},{"key":"rate","value":0,"choices":["30 fps","60 fps"]}
  char installed[768], shots[512], options[768];
  unsigned shot;
  bool tour, paused;
  char stats[96];
  float lat, lon; // where the globe faces, when a spin settles
  char prefs[1024];
} Interface;
extern Interface interface;

typedef enum {
  COMMAND_GLOBE = 1, // x y r (logical px on the primary screen), lat lon, pin
  COMMAND_PINS,      // text: "lat,lon,rrggbb;…"
  COMMAND_SPIN,      // dx dy: a finger on the globe, logical px
  COMMAND_ENTER,     // text: the place
  COMMAND_LEAVE,
  COMMAND_SHOT,   // index
  COMMAND_TOUR,   // on
  COMMAND_PAUSE,  // on
  COMMAND_OPTION, // text: the key; value: 0 or 1, or the choice
  COMMAND_DRIVE,  // mx my lx ly: virtual sticks, -1…1; move y is forward, look y is up
  COMMAND_LOOK,   // dx dy: a finger turning the view, logical px
  COMMAND_HOLD,   // on: the interface has the pad
  COMMAND_PREFS,  // text: to store, and to hand back in `interface.prefs`
  COMMAND_QUIET,  // on: the interface shows nothing just now
} CommandType;
typedef struct {
  CommandType type;
  float x, y, r, lat, lon, dx, dy, mx, my, lx, ly;
  int index, pin, value;
  bool on;
  char text[1024];
} Command;
// The next command the guest sent, oldest first; false when there is none.
bool interface_next(Command *out);
// The guest has not been sent `interface` as it stands.
bool interface_pending(void);
// Appends `"text"` (escaped) to a JSON array body.
void interface_append(char *body, size_t capacity, const char *text);
// Appends a switch to `interface.options`.
void interface_switch(const char *key, bool on);
#endif
