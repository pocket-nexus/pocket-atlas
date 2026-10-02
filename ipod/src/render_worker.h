#ifndef POCKET_ATLAS_RENDER_WORKER_H
#define POCKET_ATLAS_RENDER_WORKER_H

#define ATLAS_UI_VALUE_COUNT 13
#define ATLAS_UI_TEXT_COUNT 7
#define ATLAS_UI_TEXT_BYTES 2048

typedef struct {
    unsigned long generation;
    unsigned long applied_event;
    int values[ATLAS_UI_VALUE_COUNT];
    char text[ATLAS_UI_TEXT_COUNT][ATLAS_UI_TEXT_BYTES];
} AtlasUiSnapshot;

/* start() initializes Rust/audio with the caller's current EAGL context, takes
 * the immutable catalog snapshot, then transfers exclusive ownership to one
 * rendering thread. No UIKit object is accessed from that thread. */
int atlas_worker_start(void *context, unsigned framebuffer, unsigned colorbuffer,
                       int width, int height, const char *bundle, const char *tmp);
int atlas_worker_snapshot(AtlasUiSnapshot *out);
const char *atlas_worker_catalog_text(int index, int field);
unsigned long atlas_worker_action(int action);
void atlas_worker_touch(int phase, float x, float y, int contact);
void atlas_worker_command(const char *json);
void atlas_worker_request_frame(void);
unsigned atlas_worker_pending_events(void);
/* Pausing waits until the current frame ends and GL has finished/unbound.
 * Resuming is asynchronous; both audio and EAGL changes happen on the owner. */
void atlas_worker_active(int active);
/* Join first, then temporarily reacquire the context to destroy Rust/GL state. */
void atlas_worker_stop(void);

#endif
