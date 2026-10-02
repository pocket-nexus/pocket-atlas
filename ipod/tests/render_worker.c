/* Host regression for the render actor. These are explicit App/EAGL stubs:
 * they verify ownership and lifecycle ordering, not device graphics or UIKit. */
#include "render_worker.h"
#include <assert.h>
#include <pthread.h>
#include <stdarg.h>
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

void *objc_getClass(const char *name) { return (void *)name; }
void *sel_registerName(const char *name) { return (void *)name; }
void *objc_msgSend(void *object, const char *selector, ...) {
    va_list args;
    va_start(args, selector);
    void *result = object;
    if (!strcmp(selector, "setCurrentContext:")) {
        void *context = va_arg(args, void *);
        int failed = context && !pthread_equal(pthread_self(), main_thread) &&
                     atomic_exchange(&fail_context, 0);
        context_bound = context && !failed;
        result = (void *)(uintptr_t)!failed;
    } else if (!strcmp(selector, "presentRenderbuffer:")) {
        render_owner();
        assert(context_bound);
        atomic_fetch_add(&gl_calls, 1);
        result = (void *)1;
    }
    va_end(args);
    return result;
}

void glBindFramebuffer(unsigned target, unsigned buffer) {
    (void)target; (void)buffer;
    render_owner(); assert(context_bound); atomic_fetch_add(&gl_calls, 1);
}
void glBindRenderbuffer(unsigned target, unsigned buffer) {
    (void)target; (void)buffer;
    render_owner(); assert(context_bound); atomic_fetch_add(&gl_calls, 1);
}
void glReadPixels(int x, int y, int width, int height, unsigned format, unsigned type, void *pixels) {
    (void)x; (void)y; (void)format; (void)type;
    render_owner(); assert(context_bound);
    memset(pixels, 17, (size_t)width * (size_t)height * 4);
    atomic_fetch_add(&gl_calls, 1);
}
void glFinish(void) { assert(context_bound); atomic_fetch_add(&gl_calls, 1); }

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
    atomic_store(&drawing, 1);
    while (atomic_load(&hold_frame)) sleep_ms(1);
    sleep_ms(150); /* Emulate a slow device without consuming CPU. */
    int frame = atomic_fetch_add(&frame_number, 1) + 1;
    snprintf(place_text, sizeof place_text, "completed-%d", frame);
    snprintf(status_text, sizeof status_text, "{\"frame\":%d,\"nonce\":\"%s\"}", frame, command);
    atomic_store(&drawing, 0);
}
void atlas_shutdown(void) {
    assert(pthread_equal(pthread_self(), main_thread));
    assert(!atomic_load(&drawing));
    atomic_store(&shutdown_done, 1);
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

    char path[1200];
    snprintf(path, sizeof path, "%s/capture", directory);
    FILE *file = fopen(path, "w"); assert(file); fclose(file);
    atlas_worker_request_frame(); wait_drawing();
    atlas_worker_touch(0, 70, 80, 99);
    atlas_worker_touch(1, 90, 100, 99);
    atlas_worker_active(0);
    assert(!atomic_load(&drawing));
    int calls = atomic_load(&gl_calls);
    sleep_ms(70);
    assert(calls == atomic_load(&gl_calls));
    assert(atomic_load(&contacts) == 0);
    atlas_worker_touch(0, 99, 99, 55); /* Background input must be ignored. */
    snprintf(path, sizeof path, "%s/frame.rgba", directory);
    file = fopen(path, "r"); assert(file);
    fseek(file, 0, SEEK_END); assert(ftell(file) == 16); fclose(file);
    snprintf(path, sizeof path, "%s/frame.rgba.new", directory);
    assert(access(path, F_OK) != 0);

    atlas_worker_active(1); atlas_worker_request_frame(); wait_drawing();
    assert(atomic_load(&contacts) == 0);
    atlas_worker_touch(0, 50, 50, 77);
    sequence = atlas_worker_action(101); wait_ack(&snapshot, sequence);
    assert(atomic_load(&contacts) == 1);
    atomic_store(&fail_allocation, 1);
    atlas_worker_touch(3, 50, 50, 77);
    sequence = atlas_worker_action(102); wait_ack(&snapshot, sequence);
    assert(atomic_load(&contacts) == 0);
    atlas_worker_request_frame(); wait_drawing(); atlas_worker_stop();
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
    atlas_worker_stop();

    const char *files[] = {"status.json", "frame.rgba", "capture", "error.txt"};
    for (unsigned i = 0; i < sizeof files / sizeof files[0]; ++i) {
        snprintf(path, sizeof path, "%s/%s", directory, files[i]); unlink(path);
    }
    assert(rmdir(directory) == 0);
    printf("PASS: exclusive owner; nonblocking input; copied snapshot; post-frame nonce; "
           "atomic capture; background GL barrier; stale-touch purge; OOM end recovery; "
           "resume; failed context handoff; restart; join-before-shutdown (%d frames).\n",
           atomic_load(&frame_number));
    return 0;
}
