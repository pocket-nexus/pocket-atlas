#ifndef ATLAS_SETTINGS_H
#define ATLAS_SETTINGS_H
#include <stdbool.h>
#include <stdint.h>
void settings_init(void);
void settings_apply(void);
bool settings_update(uint32_t down);
void settings_control(const char *json);
void settings_draw(void);
bool settings_open(void);
void settings_close(void);
unsigned settings_fps(void);
bool settings_antialias(void);
#endif
