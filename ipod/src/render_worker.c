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
extern unsigned glGetError(void);
extern void glGetRenderbufferParameteriv(unsigned, unsigned, int *);
extern void glRenderbufferStorage(unsigned, unsigned, int, int);
extern unsigned glCheckFramebufferStatus(unsigned);
extern int atlas_init(const char *), atlas_value(int);
extern void atlas_frame(float, int, int, unsigned), atlas_action(int);
extern void atlas_touch(int, float, float, int), atlas_command(const char *), atlas_shutdown(void);
extern void atlas_suspend(void);
extern void atlas_memory_warning(void);
extern void atlas_frame_completed(float render_ms, float present_ms, float interval_ms);
/* Target result: 0 absent, 1 sqrt-encoded HDR, 2 display-sRGB prelit color. */
extern int atlas_hdr_target(unsigned *, int *, int *);
extern void atlas_drawable_changed(void);
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
static int started, stop_requested, frame_requested, parked, background_parked;
static int clear_contacts_requested, worker_ready;
/* Memory pressure must not depend on allocating an Event while out of memory.
 * Keep one independent notification until the owner can safely consume it. */
static int memory_warning_requested;
/* A reserved priority message in the same mailbox: background suspension must
 * not depend on heap allocation or wait behind a burst of touch moves. */
static int lifecycle_message = -1, desired_active = 1;
static id surface_layer;
static unsigned surface_depth;
static int surface_result;
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
static int write_text(const char *name, const char *text) {
    char path[1100], staging[1110];
    snprintf(path, sizeof path, "%s/%s", directory, name);
    snprintf(staging, sizeof staging, "%s.new", path);
    FILE *file = fopen(staging, "w");
    if (!file) return 0;
    int written = fputs(text, file) >= 0;
    int closed = fclose(file) == 0;
    if (written && closed && rename(staging, path) == 0) return 1;
    unlink(staging);
    return 0;
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
static int capture_pixels(const char *name, unsigned target, int w, int h) {
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return 0;
    const int stripe_rows = h < 64 ? h : 64;
    const size_t row_bytes = (size_t)w * 4;
    unsigned char *pixels = malloc(row_bytes * (size_t)stripe_rows);
    if (!pixels) return 0;
    char path[1100], staging[1110];
    snprintf(path, sizeof path, "%s/%s", directory, name);
    snprintf(staging, sizeof staging, "%s.new", path);
    FILE *file = fopen(staging, "wb");
    int saved = 0;
    if (file) {
        int valid = 1;
        glBindFramebuffer(0x8d40, target);
        /* Preserve bottom-to-top RGBA rows without retaining a full drawable
         * CPU copy. RGBA8 row sizes are naturally aligned to GLES's default 4. */
        for (int y = 0; y < h; y += stripe_rows) {
            int rows = h - y < stripe_rows ? h - y : stripe_rows;
            size_t bytes = row_bytes * (size_t)rows;
            glReadPixels(0, y, w, rows, 0x1908, 0x1401, pixels);
            if (glGetError() != 0 || fwrite(pixels, 1, bytes, file) != bytes) {
                valid = 0;
                break;
            }
        }
        glBindFramebuffer(0x8d40, framebuffer);
        int flushed = fflush(file);
        int closed = fclose(file);
        saved = valid && flushed == 0 && closed == 0 && rename(staging, path) == 0;
    }
    if (!saved) unlink(staging);
    free(pixels);
    return saved;
}

static int consume_capture(const char *name) {
    char path[1100];
    snprintf(path, sizeof path, "%s/%s", directory, name);
    return unlink(path) == 0;
}

static int capture_framebuffer(void) {
    int captured = 0;
    if (consume_capture("capture")) {
        captured = 1;
        consume_capture("capture-error.txt");
        consume_capture("frame.json");
        if (!capture_pixels("frame.rgba", framebuffer, width, height)) {
            write_text("capture-error.txt", "Could not read or save the frame capture.");
        } else {
            char metadata[192];
            snprintf(metadata, sizeof metadata,
                     "{\"source\":\"drawable\",\"width\":%d,\"height\":%d,\"format\":\"rgba8\","
                     "\"encoding\":\"display-srgb\",\"origin\":\"bottom-left\"}", width, height);
            if (!write_text("frame.json", metadata))
                write_text("capture-error.txt", "Could not save frame capture metadata.");
        }
    }
    if (consume_capture("capture-hdr")) {
        captured = 1;
        consume_capture("capture-hdr-error.txt");
        /* Metadata is the completion marker for this pair. It appears only
         * after the complete raw buffer has been atomically replaced. */
        consume_capture("frame-hdr.json");
        unsigned target = 0;
        int w = 0, h = 0;
        int profile = atlas_hdr_target(&target, &w, &h);
        if (profile != 1 && profile != 2) {
            write_text("capture-hdr-error.txt", "No supported scene color target is available.");
        } else if (!capture_pixels("frame-hdr.rgba", target, w, h)) {
            write_text("capture-hdr-error.txt", "Could not read or save the HDR capture.");
        } else {
            char metadata[256];
            snprintf(metadata, sizeof metadata,
                     "{\"width\":%d,\"height\":%d,\"format\":\"rgba8\","
                     "\"renderingProfile\":\"%s\",\"encoding\":\"%s\",\"depth\":\"%s\",\"origin\":\"bottom-left\"}",
                     w, h, profile == 2 ? "display-prelit" : "full-hdr",
                     profile == 2 ? "display-srgb" : "sqrt(c/(1+c))",
                     profile == 2 ? "inverse-distance-when-used/zero-when-unused" : "log");
            if (!write_text("frame-hdr.json", metadata))
                write_text("capture-hdr-error.txt", "Could not save HDR capture metadata.");
        }
    }
    return captured;
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
    double last_frame = atlas_seconds(), last_status = 0, last_present = 0;
    for (;;) {
        pthread_mutex_lock(&mutex);
        while (!stop_requested && lifecycle_message < 0 &&
               (parked || (!frame_requested && !head && !clear_contacts_requested &&
                           !memory_warning_requested)))
            pthread_cond_wait(&changed, &mutex);
        if (stop_requested) {
            pthread_mutex_unlock(&mutex);
            break;
        }
        int lifecycle = lifecycle_message;
        id resize_layer = surface_layer;
        unsigned resize_depth = surface_depth;
        lifecycle_message = -1;
        int clear_contacts = clear_contacts_requested;
        if (lifecycle == 0 || clear_contacts) {
            discard_pending_touches();
            clear_contacts_requested = 0;
        }
        Event *events = NULL;
        int render = 0;
        int memory_warning = 0;
        if (lifecycle < 0 && !parked) {
            events = head;
            head = tail = NULL;
            pending_events = 0;
            memory_warning = memory_warning_requested;
            memory_warning_requested = 0;
            render = frame_requested || events != NULL || clear_contacts || memory_warning;
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
            background_parked = 1;
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
            last_present = 0;
            pthread_mutex_lock(&mutex);
            parked = !bound;
            background_parked = !bound;
            if (!bound) desired_active = 0;
            frame_requested = bound;
            pthread_cond_broadcast(&changed);
            pthread_mutex_unlock(&mutex);
        } else if (lifecycle == 2) {
            /* Unlike backgrounding, a scale transition keeps the complete
             * scene and its EAGL ownership. UIKit changes the layer only after
             * this acknowledgement, while no GPU work references it. */
            if (bound) glFinish();
            pthread_mutex_lock(&mutex);
            parked = 1;
            pthread_cond_broadcast(&changed);
            pthread_mutex_unlock(&mutex);
        } else if (lifecycle == 3) {
            int new_width = 0, new_height = 0;
            int ready = 0;
            if (bound) {
                glBindRenderbuffer(0x8d41, colorbuffer);
                BOOL allocated = ((BOOL (*)(id, SEL, unsigned, id))objc_msgSend)(
                    context, sel("renderbufferStorage:fromDrawable:"), 0x8d41, resize_layer);
                if (allocated) {
                    glGetRenderbufferParameteriv(0x8d41, 0x8d42, &new_width);
                    glGetRenderbufferParameteriv(0x8d41, 0x8d43, &new_height);
                    if (new_width > 0 && new_height > 0) {
                        glBindRenderbuffer(0x8d41, resize_depth);
                        glRenderbufferStorage(0x8d41, 0x81a5, new_width, new_height);
                        glBindFramebuffer(0x8d40, framebuffer);
                        ready = glCheckFramebufferStatus(0x8d40) == 0x8cd5;
                    }
                }
                glFinish();
                /* Even a failed storage call can leave GL_OUT_OF_MEMORY.
                 * Consume this attempt's errors before UIKit asks the owner
                 * to rebuild the previous surface as a rollback. */
                unsigned error;
                while ((error = glGetError()) != 0) ready = 0;
            }
            if (ready) {
                atlas_drawable_changed();
                last_frame = atlas_seconds();
                last_present = 0;
            } else write_text("error.txt", "Could not resize the EAGL drawable.");
            pthread_mutex_lock(&mutex);
            if (ready) { width = new_width; height = new_height; }
            surface_result = ready ? 1 : -1;
            parked = !ready;
            frame_requested = ready;
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
            /* A background request may have overtaken this batch. Leave its
             * pressure notification for resume instead of rebuilding released
             * resources or losing the warning during suspension. */
            if (!can_draw && memory_warning && !stop_requested) memory_warning_requested = 1;
            pthread_mutex_unlock(&mutex);
            if (can_draw) {
                /* Apply after ordinary input so an already queued Full command
                 * cannot immediately undo this emergency memory fallback. */
                if (memory_warning) atlas_memory_warning();
                double time = atlas_seconds();
                atlas_frame((float)(time - last_frame), width, height, framebuffer);
                double rendered = atlas_seconds();
                last_frame = time;
                int captured = capture_framebuffer();
                glBindRenderbuffer(0x8d41, colorbuffer);
                double present_started = atlas_seconds();
                BOOL presented = ((BOOL (*)(id, SEL, unsigned))objc_msgSend)(
                    context, sel("presentRenderbuffer:"), 0x8d41);
                if (presented) {
                    double completed = atlas_seconds();
                    /* Readback is diagnostic work, not a frame-rate sample.
                     * -1 excludes its interval; 0 starts/resumes the clock. */
                    float interval = captured ? -1.0f : last_present > 0 ?
                        (float)((completed - last_present) * 1000.0) : 0.0f;
                    atlas_frame_completed((float)((rendered - time) * 1000.0),
                        (float)((completed - present_started) * 1000.0), interval);
                    last_present = completed;
                    /* Publish only after presentation: a command's nonce in
                     * status.json must describe a frame actually completed. */
                    publish_snapshot();
                    if (command_applied || memory_warning || completed - last_status > .5) {
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
    stop_requested = frame_requested = parked = background_parked = 0;
    clear_contacts_requested = worker_ready = 0;
    memory_warning_requested = 0;
    lifecycle_message = -1;
    surface_layer = NULL;
    surface_depth = 0;
    surface_result = 0;
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
void atlas_worker_memory_warning(void) {
    pthread_mutex_lock(&mutex);
    if (started && !stop_requested) {
        memory_warning_requested = 1;
        /* A background warning must not resume EAGL or start another frame.
         * Resume/resize signals will release a notification held while parked. */
        if (desired_active && !parked) pthread_cond_signal(&changed);
    }
    pthread_mutex_unlock(&mutex);
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
            /* A failed drawable resize is also parked, but still owns live
             * GL resources. Only background suspension is an adequate ack. */
            while (!background_parked && !stop_requested)
                pthread_cond_wait(&changed, &mutex);
        }
    }
    pthread_mutex_unlock(&mutex);
}
int atlas_worker_surface_pause(void) {
    pthread_mutex_lock(&mutex);
    /* Resume is asynchronous. Do not overwrite its lifecycle message with a
     * surface transition before the context has been rebound by the owner. */
    while (started && desired_active && background_parked && !stop_requested)
        pthread_cond_wait(&changed, &mutex);
    if (!started || stop_requested || !desired_active) {
        pthread_mutex_unlock(&mutex);
        return 0;
    }
    lifecycle_message = 2;
    pthread_cond_signal(&changed);
    while (!parked && !stop_requested) pthread_cond_wait(&changed, &mutex);
    int ready = parked && !stop_requested;
    pthread_mutex_unlock(&mutex);
    return ready;
}
int atlas_worker_surface_resize(void *layer, unsigned depth, int *out_width, int *out_height) {
    pthread_mutex_lock(&mutex);
    if (!started || stop_requested || !desired_active || !parked) {
        pthread_mutex_unlock(&mutex);
        return 0;
    }
    surface_layer = layer;
    surface_depth = depth;
    surface_result = 0;
    lifecycle_message = 3;
    pthread_cond_signal(&changed);
    while (!surface_result && !stop_requested) pthread_cond_wait(&changed, &mutex);
    int ready = surface_result > 0 && !stop_requested;
    if (ready) { *out_width = width; *out_height = height; }
    pthread_mutex_unlock(&mutex);
    return ready;
}
void atlas_worker_stop(void) {
    pthread_mutex_lock(&mutex);
    if (!started) { pthread_mutex_unlock(&mutex); return; }
    stop_requested = 1;
    pthread_cond_broadcast(&changed);
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
