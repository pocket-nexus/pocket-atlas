#ifndef ATLAS_GLOBE_H
#define ATLAS_GLOBE_H
#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
// The atlas screen's globe on the top screen: the Earth turned to face a
// place, with its city lights and clouds and a pin on every place. The
// interface says where it sits and what it faces; the Circle Pad spins it.
// Call load and free only while the preceding C3D frame has retired.
bool globe_load(const char *path, char *error, size_t capacity);
void globe_free(void);
void globe_place(float x, float y, float radius); // top-screen pixels
void globe_turn(float lat, float lon, int pin);   // degrees; the lit pin, or -1
void globe_pins(const char *list);                // "lat,lon,rrggbb;…"
void globe_spin(float east, float north);         // degrees
// Advances the turn. True once after a spin has settled, with where it faces.
bool globe_update(float dt, float *lat, float *lon);
// Clears the top target and draws.
void globe_render(C3D_RenderTarget *top);
#endif
