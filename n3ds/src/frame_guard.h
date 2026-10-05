#ifndef ATLAS_FRAME_GUARD_H
#define ATLAS_FRAME_GUARD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Initialize once, after C3D_Init and before loading the first view. This tiny
 * program and 8x8 white texture stay alive until after C3D_Fini, across every
 * scene or globe reload.
 */
bool atlas_gpu_park_init(char *error, size_t capacity);
void atlas_gpu_park_shutdown(void);

/* Move citro3d's cached program/texture pointers off the view being unloaded.
 * Call after atlas_gpu_idle succeeds and BEFORE freeing any view resources.
 * Neither C3D_BindProgram(NULL) nor C3D_TexBind(unit, NULL) is supported. */
void atlas_gpu_park(void);

/* Finish any open frame, retire its GPU queue, then close an untouched empty
 * frame. Success leaves the GPU idle AND citro3d outside a frame, which is
 * required by C3D_RenderTargetDelete. Start a new frame before rendering again.
 * service_debugger must be false while a pending screenshot owns GPU output
 * buffers: the debugger may otherwise free them on disconnect during this wait.
 * On failure do not release GPU resources or pending capture buffers. */
bool atlas_gpu_idle(uint32_t timeout_ms, bool service_debugger);

#endif
