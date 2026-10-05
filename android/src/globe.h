#ifndef ATLAS_ANDROID_GLOBE_H
#define ATLAS_ANDROID_GLOBE_H
#include <stdbool.h>
// The atlas screen's globe: the night side of the Earth with its city
// lights and a lit limb, turned to face a place, a pin on every place. The
// interface says where on the landscape screen it sits and what it faces.
// The surface tools/atlas-globe.ts writes: `bytes` of RGBA, twice as wide as tall.
bool globe_load(const void *texels, unsigned bytes);
void globe_logical(float width, float height);    // the interface's screen, logical pixels
void globe_place(float x, float y, float radius); // logical pixels
void globe_turn(float lat, float lon, int pin);   // degrees; the lit pin, or -1
void globe_pins(const char *list);                // "lat,lon,rrggbb;…"
void globe_spin(float dx, float dy);              // a finger's travel, logical pixels
// Advances the turn. True once after a spin has settled, with where it faces.
bool globe_update(float dt, float *lat, float *lon);
// Clears the bound drawable (`width` by `height` pixels) and draws.
void globe_render(int width, int height);
#endif
