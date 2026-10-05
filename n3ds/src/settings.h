#ifndef ATLAS_SETTINGS_H
#define ATLAS_SETTINGS_H
#include <stdbool.h>
#include <stdint.h>
// What the visitor can set in a place, kept on the SD card and carried to
// the next place. The interface's menu lists them and sets them.
void settings_init(void);
void settings_apply(void);
// Writes the list into `interface.options`.
void settings_list(void);
// The visitor set `key` to `value`: a switch's 0 or 1, or a choice.
void settings_set(const char *key, unsigned value);
void settings_control(const char *json);
unsigned settings_fps(void);
bool settings_antialias(void);
// The statistics line is wanted.
bool settings_stats(void);
#endif
