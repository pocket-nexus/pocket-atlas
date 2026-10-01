#ifndef ATLAS_BROWSER_H
#define ATLAS_BROWSER_H
#include <3ds.h>
#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
// UI selection, query, globe orientation and saved places survive browser_free.
// Call load/free only while the preceding C3D frame has retired.
bool browser_load(const char *path, char *error, size_t capacity);
void browser_free(void);
void browser_update(float dt, u32 down, u32 held);
void browser_render(C3D_RenderTarget *top);
void browser_hud(void);
void browser_control(const char *json);
void browser_status(char *out, size_t capacity);
const char *browser_take_enter(void);
bool browser_wants_keyboard(void);
// Blocking system applet: caller must first retire GPU/capture work.
void browser_keyboard(void);
// Small shared CPU font remains resident across scene changes. Top-left pixel
// positions, 13 px face / 16 px line height, RGB888 colours, RGB565 bottom LCD.
void browser_ui_clear(u32 rgb);
void browser_ui_rect(int x, int y, int w, int h, u32 rgb);
void browser_ui_text(int x, int y, const char *text, u32 rgb);
int browser_ui_wrap(int x, int y, int width, const char *text, u32 rgb);
int browser_ui_width(const char *text);
#endif
