/* iOS 6 soundscape playback. AVAudioPlayer decodes the native IMA4 CAF stream,
 * keeping synthesis and the large source PCM out of the device render loop. */
#include "audio.h"
#include <dlfcn.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef void *id, *SEL;
typedef signed char BOOL;
extern id objc_getClass(const char *);
extern SEL sel_registerName(const char *);
extern void *objc_msgSend(void);

static id player, session;
static int available, foreground = 1, session_active, load_failed;
static char bundle[1024], selected[128], error_message[512];

static SEL sel(const char *name) { return sel_registerName(name); }
static id send(id object, const char *name) {
    return ((id (*)(id, SEL))objc_msgSend)(object, sel(name));
}
static id string(const char *value) {
    return ((id (*)(id, SEL, const char *))objc_msgSend)(
        objc_getClass("NSString"), sel("stringWithUTF8String:"), value);
}
static int boolean(id object, const char *name) {
    return ((BOOL (*)(id, SEL))objc_msgSend)(object, sel(name)) != 0;
}
static double number(id object, const char *name) {
    return ((double (*)(id, SEL))objc_msgSend)(object, sel(name));
}
static void set_number(id object, const char *name, double value) {
    ((void (*)(id, SEL, double))objc_msgSend)(object, sel(name), value);
}
static void failure(const char *fallback, id error) {
    const char *description = error ? ((const char *(*)(id, SEL))objc_msgSend)(
        send(error, "localizedDescription"), sel("UTF8String")) : NULL;
    snprintf(error_message, sizeof error_message, "%s", description ? description : fallback);
}
static void stop_player(void) {
    if (!player) return;
    send(player, "stop");
    send(player, "release");
    player = NULL;
}
static int activate_session(int active) {
    if (active == session_active) return 1;
    id error = NULL;
    BOOL success = ((BOOL (*)(id, SEL, BOOL, id *))objc_msgSend)(
        session, sel("setActive:error:"), (BOOL)active, &error);
    if (!success) {
        if (active) failure("Could not activate the sound output.", error);
        return 0;
    }
    session_active = active;
    return 1;
}

int atlas_audio_init(const char *bundle_path) {
    atlas_audio_shutdown();
    foreground = 1;
    if (!bundle_path || strlen(bundle_path) >= sizeof bundle) {
        failure("Invalid sound asset directory.", NULL);
        return 0;
    }
    snprintf(bundle, sizeof bundle, "%s", bundle_path);
    /* The executable links AVFoundation. Explicit loading also permits a
     * useful capability result if a legacy packaging tool drops unused dylibs. */
    dlopen("/System/Library/Frameworks/AVFoundation.framework/AVFoundation", RTLD_LAZY);
    if (!objc_getClass("AVAudioPlayer") || !objc_getClass("AVAudioSession")) {
        failure("This runtime does not provide native sound playback.", NULL);
        return 0;
    }
    session = send(objc_getClass("AVAudioSession"), "sharedInstance");
    id *ambient = (id *)dlsym((void *)-2, "AVAudioSessionCategoryAmbient");
    id error = NULL;
    BOOL success = ((BOOL (*)(id, SEL, id, id *))objc_msgSend)(
        session, sel("setCategory:error:"), ambient ? *ambient : string("AVAudioSessionCategoryAmbient"), &error);
    if (!success) {
        failure("Could not configure ambient sound.", error);
        return 0;
    }
    available = 1;
    return 1;
}

int atlas_audio_available(void) { return available; }
const char *atlas_audio_error(void) { return error_message; }

static int valid_place(const char *place) {
    size_t length = place ? strlen(place) : 0;
    if (!length || length >= sizeof selected) return 0;
    for (size_t i = 0; i < length; ++i) {
        char c = place[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return 0;
    }
    return strcmp(place, "atlas") != 0;
}

static int load_player(void) {
    char path[1200];
    snprintf(path, sizeof path, "%s/assets/%s.audio.caf", bundle, selected);
    if (access(path, R_OK) != 0) {
        failure("The soundscape file is not installed.", NULL);
        return 0;
    }
    id url = ((id (*)(id, SEL, id))objc_msgSend)(
        objc_getClass("NSURL"), sel("fileURLWithPath:"), string(path));
    id error = NULL;
    player = ((id (*)(id, SEL, id, id *))objc_msgSend)(
        send(objc_getClass("AVAudioPlayer"), "alloc"), sel("initWithContentsOfURL:error:"), url, &error);
    if (!player) {
        failure("The soundscape could not be decoded.", error);
        return 0;
    }
    ((void (*)(id, SEL, int))objc_msgSend)(player, sel("setNumberOfLoops:"), -1);
    ((void (*)(id, SEL, float))objc_msgSend)(player, sel("setVolume:"), 1.0f);
    if (!boolean(player, "prepareToPlay")) {
        failure("The soundscape could not be prepared.", NULL);
        stop_player();
        return 0;
    }
    return 1;
}

int atlas_audio_update(const char *place, double scene_seconds, int enabled, int paused) {
    if (!available) return 0;
    if (!valid_place(place)) {
        stop_player();
        selected[0] = 0;
        error_message[0] = 0;
        activate_session(0);
        return 0;
    }
    if (strcmp(selected, place) != 0) {
        stop_player();
        snprintf(selected, sizeof selected, "%s", place);
        error_message[0] = 0;
        load_failed = 0;
    }
    if (!enabled || paused || !foreground) {
        if (player && boolean(player, "isPlaying")) send(player, "pause");
        activate_session(0);
        if (!enabled) load_failed = 0; /* An explicit unmute can retry a failure. */
        return 0;
    }
    if (load_failed) return 0;
    if (!player && !load_player()) {
        load_failed = 1; /* No repeated file I/O on every rendering frame. */
        return 0;
    }
    if (!activate_session(1)) return 0;
    double duration = number(player, "duration");
    if (!isfinite(scene_seconds) || !isfinite(duration) || duration <= 0) {
        failure("The soundscape has an invalid duration or scene clock.", NULL);
        send(player, "pause");
        return 0;
    }
    double target = fmod(scene_seconds, duration);
    if (target < 0) target += duration;
    double delta = fabs(number(player, "currentTime") - target);
    if (delta > duration * .5) delta = duration - delta;
    /* Re-seek on resume or a real scene-time jump.
     * Small AVAudioPlayer/render clock differences must not cause audio clicks. */
    int playing = boolean(player, "isPlaying");
    if (!playing || delta > .25) set_number(player, "setCurrentTime:", target);
    if (!playing && !boolean(player, "play")) {
        failure("The sound output could not start.", NULL);
        return 0;
    }
    error_message[0] = 0;
    return boolean(player, "isPlaying");
}

void atlas_audio_active(int active) {
    foreground = active != 0;
    if (!foreground) {
        stop_player();
        activate_session(0);
    }
}

void atlas_audio_shutdown(void) {
    stop_player();
    if (session) activate_session(0);
    session = NULL;
    available = session_active = load_failed = 0;
    bundle[0] = selected[0] = error_message[0] = 0;
}
