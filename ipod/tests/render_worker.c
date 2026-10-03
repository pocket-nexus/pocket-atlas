/* Host regression for the render actor. These are explicit App/EAGL stubs:
 * they verify ownership and lifecycle ordering, not device graphics or UIKit. */
#include "render_worker.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static pthread_t main_thread, render_thread;
static int has_render_owner, selected = -1;
static _Thread_local int context_bound;
static atomic_int drawing, frame_number, gl_calls, shutdown_done;
static atomic_int contacts, fail_allocation, hold_frame, fail_context;
static atomic_int suspended;
static atomic_int memory_warnings, frame_memory_warnings;
static atomic_int presented_frames, timed_frames, captured_samples;
static unsigned bound_framebuffer;
static atomic_int hdr_reads;
static atomic_int surface_paused, surface_changes, fail_surface;
static atomic_size_t capture_allocation;
static atomic_int capture_reads, inspect_capture;
static atomic_int fail_read_y = -1, fail_write_after = -1;
static int capture_read_x, capture_read_y, capture_read_width, capture_read_height;
static char atomic_capture_path[1200];
static unsigned pending_gl_error;
static int surface_size = 2;
static char place_text[128] = "initial", command[128], status_text[256] = "{}";

static void sleep_ms(unsigned milliseconds) {
    struct timespec time = { milliseconds / 1000, (long)(milliseconds % 1000) * 1000000 };
    nanosleep(&time, NULL);
}

static void render_owner(void) {
    assert(!pthread_equal(pthread_self(), main_thread));
    if (!has_render_owner) {
        render_thread = pthread_self();
        has_render_owner = 1;
    }
    assert(pthread_equal(pthread_self(), render_thread));
}

static void app_read_owner(void) {
    if (has_render_owner) assert(pthread_equal(pthread_self(), render_thread));
    else assert(pthread_equal(pthread_self(), main_thread));
}

/* Only render_worker.c is compiled with calloc redirected here. */
void *worker_test_calloc(size_t count, size_t size) {
    if (atomic_exchange(&fail_allocation, 0)) return NULL;
    return calloc(count, size);
}
void *worker_test_malloc(size_t bytes) {
    atomic_store(&capture_allocation, bytes);
    return malloc(bytes);
}
size_t worker_test_fwrite(const void *bytes, size_t size, size_t count, FILE *file) {
    int remaining = atomic_load(&fail_write_after);
    if (remaining >= 0 && atomic_fetch_sub(&fail_write_after, 1) == 0)
        return fwrite(bytes, size, count / 2, file); /* A real partial staging file. */
    return fwrite(bytes, size, count, file);
}

static void assert_old_capture(void) {
    FILE *file = fopen(atomic_capture_path, "rb"); assert(file);
    char bytes[5] = {0};
    assert(fread(bytes, 1, sizeof bytes, file) == 4);
    assert(!memcmp(bytes, "old!", 4));
    assert(fclose(file) == 0);
}

void *objc_getClass(const char *name) { return (void *)name; }
void *sel_registerName(const char *name) { return (void *)name; }
/* Objective-C dispatch uses fixed method ABIs, including on arm64 hosts where
 * C variadic arguments would be read from different locations. */
void *objc_msgSend(void *object, const char *selector, uintptr_t first, void *second) {
    void *result = object;
    if (!strcmp(selector, "setCurrentContext:")) {
        void *context = (void *)first;
        int failed = context && !pthread_equal(pthread_self(), main_thread) &&
                     atomic_exchange(&fail_context, 0);
        context_bound = context && !failed;
        result = (void *)(uintptr_t)!failed;
    } else if (!strcmp(selector, "presentRenderbuffer:")) {
        render_owner();
        assert(context_bound);
        if (atomic_load(&inspect_capture)) assert(bound_framebuffer == 1);
        sleep_ms(12);
        atomic_fetch_add(&presented_frames, 1);
        atomic_fetch_add(&gl_calls, 1);
        result = (void *)1;
    } else if (!strcmp(selector, "renderbufferStorage:fromDrawable:")) {
        render_owner(); assert(context_bound); assert(!atomic_load(&drawing));
        void *layer = second;
        int failed = atomic_exchange(&fail_surface, 0);
        if (!failed) surface_size = (int)(uintptr_t)layer;
        else pending_gl_error = 0x0505; /* GL_OUT_OF_MEMORY survives the failed call. */
        result = (void *)(uintptr_t)!failed;
    }
    return result;
}

void glBindFramebuffer(unsigned target, unsigned buffer) {
    (void)target;
    render_owner(); assert(context_bound); atomic_fetch_add(&gl_calls, 1);
    bound_framebuffer = buffer;
}
void glBindRenderbuffer(unsigned target, unsigned buffer) {
    (void)target; (void)buffer;
    render_owner(); assert(context_bound); atomic_fetch_add(&gl_calls, 1);
}
void glReadPixels(int x, int y, int width, int height, unsigned format, unsigned type, void *pixels) {
    render_owner(); assert(context_bound);
    assert(x == 0 && y == 0 && height > 0);
    assert(format == 0x1908 && type == 0x1401);
    if (bound_framebuffer == 7) {
        assert(width == 3 && height == 2);
        atomic_fetch_add(&hdr_reads, 1);
    }
    if (atomic_load(&inspect_capture)) {
        assert(bound_framebuffer == 1 && width == 130);
        assert(atomic_fetch_add(&capture_reads, 1) == 0);
        capture_read_x = x; capture_read_y = y;
        capture_read_width = width; capture_read_height = height;
        assert_old_capture(); /* Destination stays intact throughout readback. */
    }
    unsigned char *rgba = pixels;
    for (int row = 0; row < height; ++row) {
        for (int column = 0; column < width; ++column) {
            *rgba++ = (unsigned char)column;
            *rgba++ = (unsigned char)(y + row);
            *rgba++ = (unsigned char)(column ^ (y + row));
            *rgba++ = 255;
        }
    }
    if (y == atomic_load(&fail_read_y)) {
        pending_gl_error = 0x0502;
        atomic_store(&fail_read_y, -1);
    }
    atomic_fetch_add(&gl_calls, 1);
}
void glFinish(void) { assert(context_bound); atomic_fetch_add(&gl_calls, 1); }
unsigned glGetError(void) {
    render_owner(); assert(context_bound);
    unsigned error = pending_gl_error;
    pending_gl_error = 0;
    return error;
}
void glGetRenderbufferParameteriv(unsigned target, unsigned parameter, int *value) {
    (void)target; (void)parameter;
    render_owner(); assert(context_bound); *value = surface_size;
}
void glRenderbufferStorage(unsigned target, unsigned format, int width, int height) {
    (void)target; (void)format;
    render_owner(); assert(context_bound); assert(!atomic_load(&drawing));
    assert(width == surface_size && height == surface_size);
}
unsigned glCheckFramebufferStatus(unsigned target) {
    (void)target; render_owner(); assert(context_bound); return 0x8cd5;
}
void atlas_drawable_changed(void) {
    render_owner(); assert(context_bound); assert(!atomic_load(&drawing));
    atomic_fetch_add(&surface_changes, 1);
}

static void *pause_surface(void *unused) {
    (void)unused;
    assert(atlas_worker_surface_pause());
    atomic_store(&surface_paused, 1);
    return NULL;
}

double atlas_seconds(void) {
    struct timeval time;
    gettimeofday(&time, NULL);
    return time.tv_sec + time.tv_usec * 1e-6;
}
int atlas_init(const char *path) {
    (void)path;
    assert(pthread_equal(pthread_self(), main_thread));
    has_render_owner = 0; selected = -1;
    snprintf(place_text, sizeof place_text, "initial");
    return 1;
}
int atlas_value(int field) {
    app_read_owner();
    if (field == 0) return 2;
    if (field == 1) return selected >= 0;
    if (field == 2) return selected;
    return 0;
}
const char *atlas_text(int index, int field) {
    (void)field;
    app_read_owner();
    return index < 0 ? place_text : (index == 0 ? "one" : "two");
}
const char *atlas_status(void) { render_owner(); return status_text; }
int atlas_hdr_target(unsigned *target, int *width, int *height) {
    render_owner(); assert(context_bound); assert(!atomic_load(&drawing));
    if (selected < 0) return 0;
    *target = 7; *width = 3; *height = 2;
    return selected == 105 ? 2 : 1;
}
void atlas_action(int action) { render_owner(); selected = action; }
void atlas_touch(int phase, float x, float y, int contact) {
    (void)x; (void)y; (void)contact;
    render_owner();
    if (phase < 0) atomic_store(&contacts, 0);
    else if (phase == 0) atomic_fetch_add(&contacts, 1);
    else if (phase == 3 || phase == 4) atomic_fetch_sub(&contacts, 1);
}
void atlas_command(const char *json) {
    render_owner();
    snprintf(command, sizeof command, "%s", json);
}
void atlas_frame(float dt, int width, int height, unsigned framebuffer) {
    (void)dt; (void)width; (void)height; (void)framebuffer;
    render_owner(); assert(context_bound);
    atomic_store(&frame_memory_warnings, atomic_load(&memory_warnings));
    atomic_store(&drawing, 1);
    while (atomic_load(&hold_frame)) sleep_ms(1);
    sleep_ms(150); /* Emulate a slow device without consuming CPU. */
    int frame = atomic_fetch_add(&frame_number, 1) + 1;
    snprintf(place_text, sizeof place_text, "completed-%d", frame);
    snprintf(status_text, sizeof status_text,
             "{\"frame\":%d,\"nonce\":\"%s\",\"memoryWarnings\":%d}",
             frame, command, atomic_load(&memory_warnings));
    atomic_store(&drawing, 0);
}
void atlas_frame_completed(float render_ms, float present_ms, float interval_ms) {
    render_owner(); assert(context_bound); assert(!atomic_load(&drawing));
    assert(render_ms >= 140.0f);
    assert(present_ms >= 10.0f);
    assert(atomic_load(&presented_frames) == atomic_load(&timed_frames) + 1);
    if (interval_ms < 0.0f) atomic_fetch_add(&captured_samples, 1);
    else if (interval_ms > 0.0f) assert(interval_ms >= 150.0f);
    atomic_fetch_add(&timed_frames, 1);
}
void atlas_shutdown(void) {
    assert(pthread_equal(pthread_self(), main_thread));
    assert(!atomic_load(&drawing));
    atomic_store(&shutdown_done, 1);
}
void atlas_suspend(void) {
    render_owner(); assert(context_bound); assert(!atomic_load(&drawing));
    atomic_fetch_add(&suspended, 1);
}
void atlas_memory_warning(void) {
    render_owner(); assert(context_bound); assert(!atomic_load(&drawing));
    atomic_fetch_add(&memory_warnings, 1);
}
int atlas_audio_init(const char *path) {
    (void)path; assert(pthread_equal(pthread_self(), main_thread)); return 1;
}
void atlas_audio_active(int active) { (void)active; render_owner(); }
void atlas_audio_shutdown(void) {
    assert(pthread_equal(pthread_self(), main_thread)); assert(!atomic_load(&drawing));
}

static void wait_drawing(void) {
    for (int i = 0; i < 2000 && !atomic_load(&drawing); ++i) sleep_ms(1);
    assert(atomic_load(&drawing));
}
static void wait_ack(AtlasUiSnapshot *snapshot, unsigned long sequence) {
    for (int i = 0; i < 2000; ++i) {
        atlas_worker_snapshot(snapshot);
        if (snapshot->applied_event >= sequence) return;
        sleep_ms(1);
    }
    assert(!"render snapshot acknowledgement timed out");
}
static void wait_status(const char *directory, const char *nonce) {
    char path[1200];
    snprintf(path, sizeof path, "%s/status.json", directory);
    for (int i = 0; i < 2000; ++i) {
        FILE *file = fopen(path, "r");
        if (file) {
            char bytes[512] = {0};
            fread(bytes, 1, sizeof bytes - 1, file);
            fclose(file);
            if (strstr(bytes, nonce)) return;
        }
        sleep_ms(1);
    }
    assert(!"status file acknowledgement timed out");
}

int main(int argc, char **argv) {
    assert(argc == 2);
    alarm(15); /* A locking regression produces a failing run, never a hung CI. */
    main_thread = pthread_self();
    context_bound = 1;
    char directory[1100];
    snprintf(directory, sizeof directory, "%s/run-XXXXXX", argv[1]);
    assert(mkdtemp(directory));
    assert(atlas_worker_start((void *)1, 1, 2, 2, 2, directory, directory));
    AtlasUiSnapshot initial = {0}, snapshot = {0};
    assert(atlas_worker_snapshot(&initial));
    assert(!strcmp(initial.text[0], "initial"));

    /* The producer must return even while the consumer is deliberately held
     * inside a frame. A mutex around atlas_frame would deadlock this test. */
    atomic_store(&hold_frame, 1);
    atlas_worker_request_frame(); wait_drawing();
    /* Pressure delivery neither allocates nor blocks behind the slow owner.
     * Multiple warnings before the next frame collapse into one notification. */
    atomic_store(&fail_allocation, 1);
    for (int i = 0; i < 3; ++i) atlas_worker_memory_warning();
    assert(atomic_exchange(&fail_allocation, 0) == 1);
    assert(atomic_load(&memory_warnings) == 0);
    unsigned long sequence = atlas_worker_action(100);
    atlas_worker_touch(0, 20, 30, 8);
    atlas_worker_touch(1, 30, 40, 8);
    atlas_worker_touch(1, 40, 50, 8);
    atlas_worker_touch(3, 40, 50, 8);
    atlas_worker_command("confirmed-after-render");
    atlas_worker_snapshot(&snapshot);
    assert(snapshot.applied_event < sequence);
    assert(atomic_load(&drawing));
    atomic_store(&hold_frame, 0);
    wait_ack(&snapshot, sequence);
    assert(strcmp(snapshot.text[0], "initial"));
    assert(!strcmp(initial.text[0], "initial"));
    wait_status(directory, "confirmed-after-render");
    assert(atomic_load(&memory_warnings) == 1);
    assert(atomic_load(&frame_memory_warnings) == 1);

    /* A drawable transition waits for the in-flight frame, without releasing
     * Scene/audio as backgrounding does. Only the owner changes GL storage. */
    atomic_store(&hold_frame, 1);
    atlas_worker_request_frame(); wait_drawing();
    pthread_t transition;
    assert(pthread_create(&transition, NULL, pause_surface, NULL) == 0);
    sleep_ms(20);
    assert(!atomic_load(&surface_paused));
    atomic_store(&hold_frame, 0);
    pthread_join(transition, NULL);
    assert(atomic_load(&surface_paused));
    assert(atomic_load(&suspended) == 0);
    int parked_gl_calls = atomic_load(&gl_calls);
    sequence = atlas_worker_action(103);
    sleep_ms(20);
    assert(atomic_load(&gl_calls) == parked_gl_calls);
    char transition_capture[1200];
    snprintf(transition_capture, sizeof transition_capture, "%s/capture", directory);
    FILE *transition_file = fopen(transition_capture, "w"); assert(transition_file); fclose(transition_file);
    int resized_width = 0, resized_height = 0;
    assert(atlas_worker_surface_resize((void *)4, 3, &resized_width, &resized_height));
    assert(resized_width == 4 && resized_height == 4);
    wait_ack(&snapshot, sequence);
    assert(snapshot.values[2] == 103);
    snprintf(transition_capture, sizeof transition_capture, "%s/frame.json", directory);
    transition_file = fopen(transition_capture, "r"); assert(transition_file);
    char transition_metadata[256] = {0};
    assert(fread(transition_metadata, 1, sizeof transition_metadata - 1, transition_file) > 0);
    fclose(transition_file);
    assert(strstr(transition_metadata, "\"source\":\"drawable\""));
    assert(strstr(transition_metadata, "\"width\":4,\"height\":4"));
    assert(atlas_worker_surface_pause());
    atomic_store(&fail_surface, 1);
    assert(!atlas_worker_surface_resize((void *)2, 3, &resized_width, &resized_height));
    assert(atlas_worker_surface_resize((void *)4, 3, &resized_width, &resized_height));
    assert(atlas_worker_surface_pause());
    assert(atlas_worker_surface_resize((void *)2, 3, &resized_width, &resized_height));
    assert(resized_width == 2 && resized_height == 2);
    assert(atomic_load(&surface_changes) == 3);
    assert(atomic_load(&suspended) == 0);

    /* A failed resize leaves the owner parked with a live context. Background
     * must still await suspend; immediate resume+resize must not overwrite the
     * asynchronous context reacquisition message. */
    assert(atlas_worker_surface_pause());
    atomic_store(&fail_surface, 1);
    assert(!atlas_worker_surface_resize((void *)4, 3, &resized_width, &resized_height));
    atlas_worker_active(0);
    assert(atomic_load(&suspended) == 1);
    atlas_worker_active(1);
    assert(atlas_worker_surface_pause());
    assert(atlas_worker_surface_resize((void *)2, 3, &resized_width, &resized_height));

    char path[1200];
    snprintf(path, sizeof path, "%s/capture", directory);
    FILE *file = fopen(path, "w"); assert(file); fclose(file);
    snprintf(path, sizeof path, "%s/capture-hdr", directory);
    file = fopen(path, "w"); assert(file); fclose(file);
    atlas_worker_request_frame(); wait_drawing();
    atlas_worker_touch(0, 70, 80, 99);
    atlas_worker_touch(1, 90, 100, 99);
    atlas_worker_active(0);
    assert(!atomic_load(&drawing));
    assert(atomic_load(&suspended) == 2);
    int calls = atomic_load(&gl_calls);
    int background_frames = atomic_load(&frame_number);
    for (int i = 0; i < 3; ++i) atlas_worker_memory_warning();
    sleep_ms(70);
    assert(calls == atomic_load(&gl_calls));
    assert(background_frames == atomic_load(&frame_number));
    assert(atomic_load(&memory_warnings) == 1);
    assert(atomic_load(&contacts) == 0);
    atlas_worker_touch(0, 99, 99, 55); /* Background input must be ignored. */
    snprintf(path, sizeof path, "%s/frame.rgba", directory);
    file = fopen(path, "r"); assert(file);
    fseek(file, 0, SEEK_END); assert(ftell(file) == 16); fclose(file);
    snprintf(path, sizeof path, "%s/frame.rgba.new", directory);
    assert(access(path, F_OK) != 0);
    snprintf(path, sizeof path, "%s/frame.json", directory);
    file = fopen(path, "r"); assert(file);
    memset(transition_metadata, 0, sizeof transition_metadata);
    assert(fread(transition_metadata, 1, sizeof transition_metadata - 1, file) > 0); fclose(file);
    assert(strstr(transition_metadata, "\"width\":2,\"height\":2"));
    assert(strstr(transition_metadata, "\"origin\":\"bottom-left\""));
    assert(atomic_load(&hdr_reads) == 1);
    snprintf(path, sizeof path, "%s/frame-hdr.rgba", directory);
    file = fopen(path, "r"); assert(file);
    fseek(file, 0, SEEK_END); assert(ftell(file) == 24); fclose(file);
    snprintf(path, sizeof path, "%s/frame-hdr.json", directory);
    file = fopen(path, "r"); assert(file);
    char metadata[512] = {0};
    assert(fread(metadata, 1, sizeof metadata - 1, file) > 0); fclose(file);
    assert(strstr(metadata, "\"width\":3,\"height\":2"));
    assert(strstr(metadata, "\"encoding\":\"sqrt(c/(1+c))\""));
    assert(strstr(metadata, "\"renderingProfile\":\"full-hdr\""));
    assert(strstr(metadata, "\"depth\":\"log\""));
    assert(strstr(metadata, "\"origin\":\"bottom-left\""));
    snprintf(path, sizeof path, "%s/frame-hdr.rgba.new", directory);
    assert(access(path, F_OK) != 0);
    snprintf(path, sizeof path, "%s/frame-hdr.json.new", directory);
    assert(access(path, F_OK) != 0);

    atlas_worker_active(1); atlas_worker_request_frame(); wait_drawing();
    assert(atomic_load(&memory_warnings) == 2);
    assert(atomic_load(&frame_memory_warnings) == 2);
    assert(atomic_load(&contacts) == 0);
    atlas_worker_touch(0, 50, 50, 77);
    sequence = atlas_worker_action(101); wait_ack(&snapshot, sequence);
    assert(atomic_load(&contacts) == 1);
    atomic_store(&fail_allocation, 1);
    atlas_worker_touch(3, 50, 50, 77);
    sequence = atlas_worker_action(102); wait_ack(&snapshot, sequence);
    assert(atomic_load(&contacts) == 0);
    atlas_worker_request_frame(); wait_drawing(); atlas_worker_active(0);
    atlas_worker_memory_warning(); /* Pending pressure must not outlive App. */
    atlas_worker_stop();
    assert(atomic_load(&shutdown_done));

    /* Failed context handoff also joins before destroying App, and must leave
     * the worker reusable instead of a started thread that can never park. */
    context_bound = 1;
    atomic_store(&fail_context, 1);
    assert(!atlas_worker_start((void *)1, 1, 2, 2, 2, directory, directory));
    context_bound = 1;
    assert(atlas_worker_start((void *)1, 1, 2, 2, 2, directory, directory));
    sequence = atlas_worker_action(104); assert(sequence == 1);
    wait_ack(&snapshot, sequence); assert(snapshot.values[2] == 104);
    assert(atomic_load(&memory_warnings) == 2);
    snprintf(path, sizeof path, "%s/capture-hdr", directory);
    file = fopen(path, "w"); assert(file); fclose(file);
    sequence = atlas_worker_action(105); wait_ack(&snapshot, sequence);
    snprintf(path, sizeof path, "%s/frame-hdr.json", directory);
    file = fopen(path, "r"); assert(file);
    memset(metadata, 0, sizeof metadata);
    assert(fread(metadata, 1, sizeof metadata - 1, file) > 0); fclose(file);
    assert(strstr(metadata, "\"renderingProfile\":\"display-prelit\""));
    assert(strstr(metadata, "\"encoding\":\"display-srgb\""));
    assert(strstr(metadata, "\"depth\":\"inverse-distance-when-used/zero-when-unused\""));
    assert(!strstr(metadata, "sqrt("));
    snprintf(path, sizeof path, "%s/capture-hdr", directory);
    file = fopen(path, "w"); assert(file); fclose(file);
    sequence = atlas_worker_action(-1); wait_ack(&snapshot, sequence);
    snprintf(path, sizeof path, "%s/frame-hdr.json", directory);
    assert(access(path, F_OK) != 0);
    snprintf(path, sizeof path, "%s/capture-hdr-error.txt", directory);
    assert(access(path, F_OK) == 0);

    /* A 130-row drawable must use one complete readback, including rows beyond
     * the old 64-row boundary. Verify every output byte and preservation of the
     * old capture until atomic completion. GL and partial-write failures must
     * remove staging/metadata without exposing or replacing partial pixels. */
    assert(atlas_worker_surface_pause());
    assert(atlas_worker_surface_resize((void *)130, 3, &resized_width, &resized_height));
    sequence = atlas_worker_action(-1); wait_ack(&snapshot, sequence);
    snprintf(atomic_capture_path, sizeof atomic_capture_path, "%s/frame.rgba", directory);
    for (int failure = 0; failure < 3; ++failure) {
        file = fopen(atomic_capture_path, "wb"); assert(file);
        assert(fwrite("old!", 1, 4, file) == 4); assert(fclose(file) == 0);
        atomic_store(&capture_reads, 0);
        atomic_store(&capture_allocation, 0);
        atomic_store(&fail_read_y, failure == 1 ? 0 : -1);
        atomic_store(&fail_write_after, failure == 2 ? 0 : -1);
        atomic_store(&inspect_capture, 1);
        snprintf(path, sizeof path, "%s/capture", directory);
        file = fopen(path, "w"); assert(file); assert(fclose(file) == 0);
        sequence = atlas_worker_action(-1); wait_ack(&snapshot, sequence);
        atomic_store(&inspect_capture, 0);
        assert(atomic_load(&capture_allocation) == 130 * 130 * 4);
        assert(atomic_load(&capture_reads) == 1);
        assert(capture_read_x == 0 && capture_read_y == 0);
        assert(capture_read_width == 130 && capture_read_height == 130);
        snprintf(path, sizeof path, "%s/frame.rgba.new", directory);
        assert(access(path, F_OK) != 0);
        snprintf(path, sizeof path, "%s/frame.json", directory);
        assert((access(path, F_OK) == 0) == !failure);
        snprintf(path, sizeof path, "%s/capture-error.txt", directory);
        assert((access(path, F_OK) == 0) == (failure != 0));
        if (failure) {
            assert_old_capture();
        } else {
            file = fopen(atomic_capture_path, "rb"); assert(file);
            for (int y = 0; y < 130; ++y) {
                for (int x = 0; x < 130; ++x) {
                    assert(fgetc(file) == x);
                    assert(fgetc(file) == y);
                    assert(fgetc(file) == (x ^ y));
                    assert(fgetc(file) == 255);
                }
            }
            assert(fgetc(file) == EOF); assert(fclose(file) == 0);
        }
    }
    /* No display tick/input is needed to wake an idle foreground owner, and
     * its completed warning frame publishes status immediately. */
    atlas_worker_memory_warning();
    wait_status(directory, "\"memoryWarnings\":3");
    assert(atomic_load(&memory_warnings) == 3);
    atlas_worker_stop();

    assert(atomic_load(&timed_frames) == atomic_load(&presented_frames));
    assert(atomic_load(&captured_samples) > 0);
    const char *files[] = {"status.json", "frame.rgba", "frame.json", "capture", "error.txt",
                          "capture-error.txt", "frame-hdr.rgba", "frame-hdr.json", "capture-hdr",
                          "capture-hdr-error.txt"};
    for (unsigned i = 0; i < sizeof files / sizeof files[0]; ++i) {
        snprintf(path, sizeof path, "%s/%s", directory, files[i]); unlink(path);
    }
    assert(rmdir(directory) == 0);
    printf("PASS: exclusive owner; nonblocking input; copied snapshot; post-frame nonce; "
           "completed render/present timing; capture exclusion; atomic capture and HDR metadata; "
           "single full-frame capture, exact row order, GL/write failure cleanup; "
           "surface transition barrier and sticky-error rollback; background after failed resize; "
           "background GL barrier; stale-touch purge; OOM end recovery; "
           "allocation-free coalesced memory pressure; deferred background warning; "
           "resume; failed context handoff; restart; join-before-shutdown (%d frames).\n",
           atomic_load(&frame_number));
    return 0;
}
