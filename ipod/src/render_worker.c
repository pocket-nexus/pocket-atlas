/* The only mutable owner of App after initialization. UIKit publishes input to
 * this mailbox and reads copied snapshots, never Rust references or CStrings. */
#include "render_worker.h"
#include "audio.h"
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void *id, *SEL;
typedef signed char BOOL;
extern id objc_getClass(const char *);
extern SEL sel_registerName(const char *);
extern void *objc_msgSend(void);
extern void glBindFramebuffer(unsigned, unsigned), glBindRenderbuffer(unsigned, unsigned);
extern void glReadPixels(int, int, int, int, unsigned, unsigned, void *), glFinish(void);
extern int atlas_init(const char *), atlas_value(int);
extern void atlas_frame(float, int, int, unsigned), atlas_action(int);
extern void atlas_touch(int, float, float, int), atlas_command(const char *), atlas_shutdown(void);
extern void atlas_suspend(void);
extern const char *atlas_text(int, int), *atlas_status(void);
extern double atlas_seconds(void);

enum { EVENT_ACTION, EVENT_TOUCH, EVENT_COMMAND };
typedef struct Event {
    struct Event *next;
    unsigned long sequence;
    int type, a, b;
    float x, y;
    char *json;
} Event;
typedef struct { char text[ATLAS_UI_TEXT_COUNT][ATLAS_UI_TEXT_BYTES]; } CatalogPlace;

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static pthread_t thread;
static int started, stop_requested, frame_requested, parked, clear_contacts_requested, worker_ready;
/* A reserved priority message in the same mailbox: background suspension must
 * not depend on heap allocation or wait behind a burst of touch moves. */
static int lifecycle_message = -1, desired_active = 1;
static Event *head, *tail;
static unsigned pending_events;
static unsigned long next_sequence, applied_sequence, snapshot_generation;
static AtlasUiSnapshot shared_snapshot;
static CatalogPlace *catalog;
static int catalog_count;
static id context;
static unsigned framebuffer, colorbuffer;
static int width, height;
static char directory[1024];

static SEL sel(const char *name) { return sel_registerName(name); }
static id send(id object, const char *name) {
    return ((id (*)(id, SEL))objc_msgSend)(object, sel(name));
}
static int current_context(id value) {
    return ((BOOL (*)(id, SEL, id))objc_msgSend)(
        objc_getClass("EAGLContext"), sel("setCurrentContext:"), value) != 0;
}
static void write_text(const char *name, const char *text) {
    char path[1100], staging[1110];
    snprintf(path, sizeof path, "%s/%s", directory, name);
    snprintf(staging, sizeof staging, "%s.new", path);
    FILE *file = fopen(staging, "w");
    if (!file) return;
    fputs(text, file);
    if (fclose(file) == 0) rename(staging, path);
}
static void copy_text(char *out, const char *source) {
    if (!source) source = "";
    size_t length = strnlen(source, ATLAS_UI_TEXT_BYTES - 1);
    /* Truncation must not leave NSString with an invalid UTF-8 tail. */
    if (length == ATLAS_UI_TEXT_BYTES - 1 && source[length]) {
        while (length && ((unsigned char)source[length] & 0xc0) == 0x80) --length;
    }
    memcpy(out, source, length);
    out[length] = 0;
}
static void publish_snapshot(void) {
    AtlasUiSnapshot next;
    memset(&next, 0, sizeof next);
    for (int i = 0; i < ATLAS_UI_VALUE_COUNT; ++i) next.values[i] = atlas_value(i);
    for (int i = 0; i < ATLAS_UI_TEXT_COUNT; ++i) copy_text(next.text[i], atlas_text(-1, i));
    next.applied_event = applied_sequence;
    pthread_mutex_lock(&mutex);
    next.generation = ++snapshot_generation;
    shared_snapshot = next;
    pthread_mutex_unlock(&mutex);
}
static void destroy_events(Event *events) {
    while (events) {
        Event *next = events->next;
        free(events->json);
        free(events);
        events = next;
    }
}
/* Called with the mailbox locked. A discarded contact must never be revived
 * by a move/begin queued before backgrounding or an allocation failure. */
static void discard_pending_touches(void) {
    Event **link = &head;
    tail = NULL;
    while (*link) {
        Event *event = *link;
        if (event->type == EVENT_TOUCH) {
            *link = event->next;
            free(event);
            --pending_events;
        } else {
            tail = event;
            link = &event->next;
        }
    }
}
static void capture_framebuffer(void) {
    char request[1100];
    snprintf(request, sizeof request, "%s/capture", directory);
    if (unlink(request) != 0) return;
    size_t bytes = (size_t)width * (size_t)height * 4;
    unsigned char *pixels = malloc(bytes);
    if (!pixels) {
        write_text("capture-error.txt", "Not enough memory for the frame capture.");
        return;
    }
    glBindFramebuffer(0x8d40, framebuffer);
    glReadPixels(0, 0, width, height, 0x1908, 0x1401, pixels);
    char path[1100], staging[1110];
    snprintf(path, sizeof path, "%s/frame.rgba", directory);
    snprintf(staging, sizeof staging, "%s.new", path);
    FILE *file = fopen(staging, "wb");
    if (file) {
        size_t count = fwrite(pixels, 1, bytes, file);
        int closed = fclose(file);
        if (count == bytes && closed == 0) rename(staging, path);
        else unlink(staging);
    }
    free(pixels);
}

static void *render_main(void *unused) {
    (void)unused;
    int bound = current_context(context);
    pthread_mutex_lock(&mutex);
    worker_ready = bound ? 1 : -1;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&mutex);
    if (!bound) {
        write_text("error.txt", "Rendering thread could not acquire EAGL context.");
        return NULL;
    }
    double last_frame = atlas_seconds(), last_status = 0;
    for (;;) {
        pthread_mutex_lock(&mutex);
        while (!stop_requested && lifecycle_message < 0 &&
               (parked || (!frame_requested && !head && !clear_contacts_requested)))
            pthread_cond_wait(&changed, &mutex);
        if (stop_requested) {
            pthread_mutex_unlock(&mutex);
            break;
        }
        int lifecycle = lifecycle_message;
        lifecycle_message = -1;
        int clear_contacts = clear_contacts_requested;
        if (lifecycle == 0 || clear_contacts) {
            discard_pending_touches();
            clear_contacts_requested = 0;
        }
        Event *events = NULL;
        int render = 0;
        if (lifecycle < 0 && !parked) {
            events = head;
            head = tail = NULL;
            pending_events = 0;
            render = frame_requested || events != NULL || clear_contacts;
            frame_requested = 0;
        }
        pthread_mutex_unlock(&mutex);

        id pool = send(send(objc_getClass("NSAutoreleasePool"), "alloc"), "init");
        if (lifecycle == 0) {
            /* Finish the in-flight GL work before UIKit completes its
             * background callback. No GL call occurs while parked. */
            atlas_touch(-1, 0, 0, -1);
            atlas_audio_active(0);
            if (bound) {
                glFinish();
                atlas_suspend();
                write_text("status.json", atlas_status());
                current_context(NULL); bound = 0;
            }
            pthread_mutex_lock(&mutex);
            parked = 1;
            pthread_cond_broadcast(&changed);
            pthread_mutex_unlock(&mutex);
        } else if (lifecycle == 1) {
            bound = current_context(context);
            if (bound) {
                if (clear_contacts) atlas_touch(-1, 0, 0, -1);
                atlas_audio_active(1);
            } else {
                write_text("status.json", "{\"state\":\"error\",\"error\":\"EAGL context could not resume\"}");
            }
            last_frame = atlas_seconds();
            pthread_mutex_lock(&mutex);
            parked = !bound;
            if (!bound) desired_active = 0;
            frame_requested = bound;
            pthread_cond_broadcast(&changed);
            pthread_mutex_unlock(&mutex);
        } else if (bound && render) {
            if (clear_contacts) atlas_touch(-1, 0, 0, -1);
            int command_applied = 0;
            for (Event *event = events; event; event = event->next) {
                switch (event->type) {
                    case EVENT_ACTION: atlas_action(event->a); break;
                    case EVENT_TOUCH: atlas_touch(event->a, event->x, event->y, event->b); break;
                    case EVENT_COMMAND: atlas_command(event->json); command_applied = 1; break;
                }
                applied_sequence = event->sequence;
            }
            /* A background request arriving during input processing takes
             * precedence over beginning another expensive frame. Applied
             * commands remain unacknowledged until a later completed frame. */
            pthread_mutex_lock(&mutex);
            int can_draw = desired_active && !stop_requested;
            pthread_mutex_unlock(&mutex);
            if (can_draw) {
                double time = atlas_seconds();
                atlas_frame((float)(time - last_frame), width, height, framebuffer);
                last_frame = time;
                capture_framebuffer();
                glBindRenderbuffer(0x8d41, colorbuffer);
                BOOL presented = ((BOOL (*)(id, SEL, unsigned))objc_msgSend)(
                    context, sel("presentRenderbuffer:"), 0x8d41);
                if (presented) {
                    /* Publish only after presentation: a command's nonce in
                     * status.json must describe a frame actually completed. */
                    publish_snapshot();
                    double completed = atlas_seconds();
                    if (command_applied || completed - last_status > .5) {
                        write_text("status.json", atlas_status());
                        last_status = completed;
                    }
                } else write_text("error.txt", "EAGL presentation failed.");
            }
        }
        destroy_events(events);
        send(pool, "release");
    }
    id pool = send(send(objc_getClass("NSAutoreleasePool"), "alloc"), "init");
    atlas_touch(-1, 0, 0, -1);
    atlas_audio_active(0);
    if (bound) { glFinish(); current_context(NULL); }
    send(pool, "release");
    return NULL;
}

int atlas_worker_start(void *eagl, unsigned fbo, unsigned color,
                       int drawable_width, int drawable_height,
                       const char *bundle, const char *tmp) {
    pthread_mutex_lock(&mutex);
    if (started) { pthread_mutex_unlock(&mutex); return 0; }
    stop_requested = frame_requested = parked = clear_contacts_requested = worker_ready = 0;
    lifecycle_message = -1;
    desired_active = 1;
    next_sequence = applied_sequence = 0;
    pending_events = 0;
    head = tail = NULL;
    memset(&shared_snapshot, 0, sizeof shared_snapshot);
    pthread_mutex_unlock(&mutex);
    context = eagl;
    framebuffer = fbo;
    colorbuffer = color;
    width = drawable_width;
    height = drawable_height;
    snprintf(directory, sizeof directory, "%s", tmp);
    atlas_audio_init(bundle);
    atlas_init(bundle);
    catalog_count = atlas_value(0);
    if (catalog_count < 0 || catalog_count > 1000) catalog_count = 0;
    catalog = calloc((size_t)catalog_count, sizeof *catalog);
    if (catalog_count && !catalog) {
        write_text("error.txt", "Not enough memory for the place directory.");
        atlas_audio_shutdown(); atlas_shutdown();
        return 0;
    }
    for (int place = 0; place < catalog_count; ++place)
        for (int field = 0; field < ATLAS_UI_TEXT_COUNT; ++field)
            copy_text(catalog[place].text[field], atlas_text(place, field));
    publish_snapshot();
    glFinish();
    current_context(NULL);
    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setstacksize(&attributes, 2 * 1024 * 1024);
    int error = pthread_create(&thread, &attributes, render_main, NULL);
    pthread_attr_destroy(&attributes);
    if (!error) {
        pthread_mutex_lock(&mutex);
        while (!worker_ready) pthread_cond_wait(&changed, &mutex);
        error = worker_ready < 0;
        pthread_mutex_unlock(&mutex);
        if (error) pthread_join(thread, NULL);
    }
    if (error) {
        current_context(context);
        atlas_audio_shutdown(); atlas_shutdown();
        free(catalog); catalog = NULL; catalog_count = 0;
        write_text("error.txt", "Could not start the rendering thread.");
        return 0;
    }
    pthread_mutex_lock(&mutex);
    started = 1;
    pthread_mutex_unlock(&mutex);
    return 1;
}

int atlas_worker_snapshot(AtlasUiSnapshot *out) {
    pthread_mutex_lock(&mutex);
    int fresh = out->generation != shared_snapshot.generation;
    if (fresh) *out = shared_snapshot;
    pthread_mutex_unlock(&mutex);
    return fresh;
}

const char *atlas_worker_catalog_text(int index, int field) {
    if (index < 0 || index >= catalog_count || field < 0 || field >= ATLAS_UI_TEXT_COUNT) return "";
    return catalog[index].text[field];
}

static unsigned long post_event(Event *event) {
    if (!event) return 0;
    pthread_mutex_lock(&mutex);
    if (!started || stop_requested || (event->type == EVENT_TOUCH && !desired_active)) {
        pthread_mutex_unlock(&mutex);
        destroy_events(event);
        return 0;
    }
    event->sequence = ++next_sequence;
    unsigned long sequence = event->sequence;
    /* Preserve begin/end/cancel and button order. Consecutive move events for
     * the same contact need only the latest coordinate while a slow frame runs. */
    if (event->type == EVENT_TOUCH && event->a == 1 && tail &&
        tail->type == EVENT_TOUCH && tail->a == 1 && tail->b == event->b) {
        tail->x = event->x; tail->y = event->y; tail->sequence = sequence;
        free(event);
    } else {
        if (tail) tail->next = event;
        else head = event;
        tail = event;
        ++pending_events;
    }
    pthread_cond_signal(&changed);
    pthread_mutex_unlock(&mutex);
    return sequence;
}

unsigned long atlas_worker_action(int action) {
    Event *event = calloc(1, sizeof *event);
    if (!event) return 0;
    event->type = EVENT_ACTION; event->a = action;
    return post_event(event);
}
void atlas_worker_touch(int phase, float x, float y, int contact) {
    Event *event = calloc(1, sizeof *event);
    if (!event) {
        /* In particular, losing an end/cancel must never leave a virtual stick
         * held. This reserved mailbox flag needs no allocation to recover. */
        pthread_mutex_lock(&mutex);
        if (started && !stop_requested) {
            clear_contacts_requested = 1;
            pthread_cond_signal(&changed);
        }
        pthread_mutex_unlock(&mutex);
        return;
    }
    event->type = EVENT_TOUCH; event->a = phase; event->b = contact;
    event->x = x; event->y = y;
    post_event(event);
}
void atlas_worker_command(const char *json) {
    Event *event = calloc(1, sizeof *event);
    if (!event) return;
    event->type = EVENT_COMMAND;
    event->json = strdup(json);
    if (!event->json) { free(event); return; }
    post_event(event);
}
void atlas_worker_request_frame(void) {
    pthread_mutex_lock(&mutex);
    if (started && desired_active && !stop_requested) {
        frame_requested = 1;
        pthread_cond_signal(&changed);
    }
    pthread_mutex_unlock(&mutex);
}
unsigned atlas_worker_pending_events(void) {
    pthread_mutex_lock(&mutex);
    unsigned result = pending_events;
    pthread_mutex_unlock(&mutex);
    return result;
}
void atlas_worker_active(int active) {
    pthread_mutex_lock(&mutex);
    if (started && !stop_requested) {
        desired_active = active != 0;
        lifecycle_message = desired_active;
        pthread_cond_signal(&changed);
        if (!desired_active) {
            while (!parked) pthread_cond_wait(&changed, &mutex);
        }
    }
    pthread_mutex_unlock(&mutex);
}
void atlas_worker_stop(void) {
    pthread_mutex_lock(&mutex);
    if (!started) { pthread_mutex_unlock(&mutex); return; }
    stop_requested = 1;
    pthread_cond_signal(&changed);
    pthread_mutex_unlock(&mutex);
    pthread_join(thread, NULL);
    /* Ownership returns to this thread only after join has completed. */
    current_context(context);
    atlas_audio_shutdown();
    atlas_shutdown();
    glFinish();
    current_context(NULL);
    pthread_mutex_lock(&mutex);
    destroy_events(head);
    head = tail = NULL;
    free(catalog); catalog = NULL; catalog_count = 0;
    started = 0;
    pthread_mutex_unlock(&mutex);
}
