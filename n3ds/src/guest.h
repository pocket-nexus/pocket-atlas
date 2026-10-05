#ifndef ATLAS_GUEST_H
#define ATLAS_GUEST_H
#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
// The interface: one PocketJS guest (`ui/`, shared with the other devices)
// drawn over the top screen's scene and on the whole touch screen, through
// PocketJS's 3DS core, QuickJS driver and PICA DrawList backend. What it is
// shown and what it asks for go through interface.h.
bool guest_boot(char *error, size_t capacity);
// The guest's turn when `dt` more seconds make one due: the pad and the
// touch screen go in (hidScanInput first), and what it shows is laid out.
// It rests (a turn a second) while no button or stylus has been down for
// two thirds of a second and neither its state nor its picture just changed.
void guest_turn(float dt);
// After C3D_FrameBegin: builds both screens' vertices.
void guest_prepare(void);
// Over the top target as bound, drawn at `scale` pixels to the pixel.
void guest_draw_top(unsigned scale);
// Clears the bottom target and draws the touch screen, when its picture
// differs from the one it shows.
void guest_draw_bottom(C3D_RenderTarget *bottom);
// Why the interface is not running, or "".
const char *guest_error(void);
// A measurement can leave the interface out of the frame: hidden, it takes
// no turn and draws nothing.
void guest_show(bool shown);
bool guest_shown(void);
// What a turn costs, smoothed, in milliseconds: the script, the layout, the
// two draw lists, their vertices. Returns the turns taken so far.
unsigned long guest_cost(float out[4]);
// From a control message: buttons pressed one after another (BTN bits), and
// a stylus held on the touch screen until it is lifted.
void guest_press(uint32_t buttons);
void guest_touch(bool down, int x, int y);
#endif
