#pragma once
#include <stdbool.h>
#include <stddef.h>

/* Optional AUDI record: 32 f32s, version 1. NULL/0 means no authored sound.
 * False means malformed data. Missing DSP/firmware or resources is a silent
 * visual fallback: load succeeds, but ready stays false. Call stop on unload. */
bool atlas_audio_load(const float *recipe, size_t floats);
void atlas_audio_update(float time, const float eye[3], const float right[3], bool muted, bool paused);
void atlas_audio_stop(void);
bool atlas_audio_ready(void);
