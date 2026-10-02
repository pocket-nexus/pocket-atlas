#include "frame_guard.h"
#include "devserver.h"
#include "scene_shbin.h"
#include <3ds.h>
#include <citro3d.h>
#include <stdio.h>
#include <string.h>

static DVLB_s *parking_dvlb;
static shaderProgram_s parking_program;
static C3D_Tex parking_white;

bool atlas_gpu_park_init(char *error, size_t capacity) {
  if (parking_dvlb)
    return true;
  parking_dvlb = DVLB_ParseFile((u32 *)scene_shbin, scene_shbin_size);
  if (!parking_dvlb) {
    if (error && capacity)
      snprintf(error, capacity, "Cannot load the resident GPU guard program");
    return false;
  }
  Result initialized = shaderProgramInit(&parking_program);
  if (R_FAILED(initialized) ||
      R_FAILED(shaderProgramSetVsh(&parking_program, &parking_dvlb->DVLE[0]))) {
    if (R_SUCCEEDED(initialized))
      shaderProgramFree(&parking_program);
    DVLB_Free(parking_dvlb);
    parking_dvlb = NULL;
    memset(&parking_program, 0, sizeof parking_program);
    if (error && capacity)
      snprintf(error, capacity, "Cannot initialize the resident GPU guard");
    return false;
  }
  // C3D_TexBind dereferences its texture argument, including on units 1/2.
  // Keep a real texture alive across all view unloads instead of binding NULL.
  if (!C3D_TexInit(&parking_white, 8, 8, GPU_RGBA4)) {
    if (parking_white.data)
      C3D_TexDelete(&parking_white);
    memset(&parking_white, 0, sizeof parking_white);
    shaderProgramFree(&parking_program);
    DVLB_Free(parking_dvlb);
    parking_dvlb = NULL;
    memset(&parking_program, 0, sizeof parking_program);
    if (error && capacity)
      snprintf(error, capacity,
               "Cannot allocate the resident GPU guard texture");
    return false;
  }
  memset(parking_white.data, 255, 8 * 8 * 2);
  C3D_TexSetFilter(&parking_white, GPU_NEAREST, GPU_NEAREST);
  C3D_TexSetWrap(&parking_white, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  C3D_TexFlush(&parking_white);
  atlas_gpu_park();
  return true;
}

void atlas_gpu_park(void) {
  if (!parking_dvlb || !parking_white.data)
    return;
  // Bind before free: C3D_BindProgram compares the old and new DVLPs and
  // dereferences the previous program, even when its last GPU frame is done.
  C3D_BindProgram(&parking_program);
  for (int unit = 0; unit < 3; unit++)
    C3D_TexBind(unit, &parking_white);
}

bool atlas_gpu_idle(uint32_t timeout_ms, bool service_debugger) {
  // FrameSync is only VBlank pacing. FrameBegin is the operation that waits
  // for and clears citro3d's GX queue. FrameEnd alone does not wait for it.
  C3D_FrameEnd(GX_CMDLIST_FLUSH);
  uint64_t began = osGetTime();
  while (!C3D_FrameBegin(C3D_FRAME_NONBLOCK)) {
    if (osGetTime() - began >= timeout_ms)
      return false;
    if (service_debugger)
      devserver_poll();
    svcSleepThread(100000);
  }
  // Nothing was drawn or transferred in this fresh frame. Its command offset
  // is zero and targets' used bits were consumed by the preceding FrameEnd,
  // so this closes inFrame without queuing references to any view resources.
  C3D_FrameEnd(GX_CMDLIST_FLUSH);
  return true;
}

void atlas_gpu_park_shutdown(void) {
  // Must follow C3D_Fini: until then its context can hold these pointers.
  if (parking_white.data) {
    C3D_TexDelete(&parking_white);
    memset(&parking_white, 0, sizeof parking_white);
  }
  if (parking_dvlb) {
    shaderProgramFree(&parking_program);
    DVLB_Free(parking_dvlb);
    parking_dvlb = NULL;
    memset(&parking_program, 0, sizeof parking_program);
  }
}
