#ifndef POCKET_ATLAS_IPOD_AUDIO_H
#define POCKET_ATLAS_IPOD_AUDIO_H

/* Calls have one owner: initialization/shutdown on the platform thread,
 * otherwise the render worker after ownership transfer. The files are baked from the existing
 * web audio classes by tools/atlas-ipod-audio.ts, under assets/<id>.audio.caf. */
int atlas_audio_init(const char *bundle_path);
int atlas_audio_available(void);
int atlas_audio_update(const char *place_id, double scene_seconds, int enabled, int paused);
void atlas_audio_active(int active);
void atlas_audio_shutdown(void);
const char *atlas_audio_error(void);

#endif
