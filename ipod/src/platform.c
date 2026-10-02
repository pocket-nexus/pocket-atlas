/* Native iOS 6 shell. Rust owns place state, rendering and gesture semantics.
 * Registering classes at runtime avoids modern Objective-C metadata in armv7. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>
#include <dlfcn.h>

typedef void *id, *Class, *SEL;
typedef signed char BOOL;
typedef struct { float x, y; } Point;
typedef struct { float width, height; } Size;
typedef struct { float a, b, c, d, tx, ty; } Transform;
typedef struct { Point origin; Size size; } Rect;

extern Class objc_getClass(const char *);
extern Class objc_allocateClassPair(Class, const char *, size_t);
extern Class object_getClass(id);
extern void objc_registerClassPair(Class);
extern SEL sel_registerName(const char *);
extern BOOL class_addMethod(Class, SEL, void (*)(void), const char *);
extern void *objc_msgSend(void), *objc_msgSend_stret(void);
extern int UIApplicationMain(int, char **, id, id);
extern id NSSearchPathForDirectoriesInDomains(unsigned, unsigned, BOOL);
extern void glGenFramebuffers(int, unsigned *), glBindFramebuffer(unsigned, unsigned);
extern void glGenRenderbuffers(int, unsigned *), glBindRenderbuffer(unsigned, unsigned);
extern void glGetRenderbufferParameteriv(unsigned, unsigned, int *);
extern void glFramebufferRenderbuffer(unsigned, unsigned, unsigned, unsigned);
extern void glRenderbufferStorage(unsigned, unsigned, int, int);
extern void glReadPixels(int, int, int, int, unsigned, unsigned, void *);
extern unsigned glCheckFramebufferStatus(unsigned), glGetError(void);
extern const unsigned char *glGetString(unsigned);
#include "render_worker.h"
#include <mach/mach.h>
#include <mach/mach_time.h>

enum {
    VALUE_PLACE_COUNT, VALUE_MODE, VALUE_SELECTED, VALUE_PAUSED,
    VALUE_CINEMATIC, VALUE_RAIN, VALUE_REFLECTION, VALUE_BLOOM,
    VALUE_SOUND, VALUE_QUALITY, VALUE_SHOT, VALUE_SHOT_COUNT,
    VALUE_SOUND_AVAILABLE, VALUE_COUNT
};
enum { PAGE_ATLAS, PAGE_PLACE, PAGE_SETTINGS, PAGE_ABOUT };
enum { ACTION_BACK = 0, ACTION_SETTINGS = 2, ACTION_PREVIOUS = 3,
       ACTION_PAUSE = 4, ACTION_WALK = 5, ACTION_NEXT = 6,
       ACTION_RESUME = 7, ACTION_QUALITY = 8, ACTION_RAIN = 9,
       ACTION_REFLECTION = 10, ACTION_BLOOM = 11, ACTION_SOUND = 12,
       ACTION_RESTART = 13, ACTION_ABOUT = 14, ACTION_PLACE = 100 };

static id window, view, context, display_link, delegate, overlay;
static id place_title, shot_label, pause_button, walk_button, hint_label;
static id settings_scroll;
static id page_scroll;
static unsigned fbo, color, depth;
static int width, height, active = 1;
static int page = PAGE_ATLAS, return_page = PAGE_ATLAS;
static int last_values[VALUE_COUNT];
static int requested_place = -1;
static Point settings_offset;
static double last;
static unsigned long frames;
static char bundle[1024], tmp[1024];

_Static_assert(VALUE_COUNT == ATLAS_UI_VALUE_COUNT, "UI snapshot ABI");
static AtlasUiSnapshot ui_snapshot;
static unsigned long pending_navigation;
static int pending_place = -1;

/* Only these copied values reach UIKit. A navigation request changes the
 * sheet immediately while the previous 3D frame is still finishing. */
static int ui_value(int field) {
    if (field < 0 || field >= VALUE_COUNT) return 0;
    if (pending_navigation > ui_snapshot.applied_event) {
        if (field == VALUE_MODE) return pending_place < 0 ? 0 : 2;
        if (field == VALUE_SELECTED) return pending_place;
    }
    return ui_snapshot.values[field];
}

static const char *ui_text(int index, int field) {
    if (field < 0 || field >= ATLAS_UI_TEXT_COUNT) return "";
    if (index >= 0) return atlas_worker_catalog_text(index, field);
    if (pending_navigation > ui_snapshot.applied_event && pending_place >= 0 &&
        field != 2 && field != 3)
        return atlas_worker_catalog_text(pending_place, field);
    return ui_snapshot.text[field];
}

static SEL selector(const char *name) { return sel_registerName(name); }
static id klass(const char *name) { return objc_getClass(name); }

static id send(id receiver, const char *name) {
    return ((id (*)(id, SEL))objc_msgSend)(receiver, selector(name));
}

static id send_object(id receiver, const char *name, id value) {
    return ((id (*)(id, SEL, id))objc_msgSend)(receiver, selector(name), value);
}

static void send_int(id receiver, const char *name, int value) {
    ((void (*)(id, SEL, int))objc_msgSend)(receiver, selector(name), value);
}

static int get_int(id receiver, const char *name) {
    return ((int (*)(id, SEL))objc_msgSend)(receiver, selector(name));
}

static void send_float(id receiver, const char *name, float value) {
    ((void (*)(id, SEL, float))objc_msgSend)(receiver, selector(name), value);
}

static id string(const char *value) {
    return ((id (*)(id, SEL, const char *))objc_msgSend)(
        klass("NSString"), selector("stringWithUTF8String:"), value ? value : "");
}

static const char *utf8(id value) {
    return ((const char *(*)(id, SEL))objc_msgSend)(value, selector("UTF8String"));
}

/* Resolve application storage through Foundation, independent of the shell's
 * HOME. Called during atlas_init, before handing ownership to the worker. */
const char *atlas_documents_path(void) {
    static char documents[1024];
    id paths = NSSearchPathForDirectoriesInDomains(9, 1, 1);
    if (get_int(paths, "count") == 0) return NULL;
    id path = ((id (*)(id, SEL, unsigned))objc_msgSend)(
        paths, selector("objectAtIndex:"), 0);
    const char *value = utf8(path);
    if (!value || strlen(value) >= sizeof documents) return NULL;
    id manager = send(klass("NSFileManager"), "defaultManager");
    BOOL ready = ((BOOL (*)(id, SEL, id, BOOL, id, void *))objc_msgSend)(
        manager, selector("createDirectoryAtPath:withIntermediateDirectories:attributes:error:"),
        path, 1, NULL, NULL);
    if (!ready) return NULL;
    memcpy(documents, value, strlen(value) + 1);
    return documents;
}

static Rect rectangle(float x, float y, float w, float h) {
    return (Rect){{x, y}, {w, h}};
}

static Rect bounds(id receiver) {
    Rect result;
    ((void (*)(Rect *, id, SEL))objc_msgSend_stret)(
        &result, receiver, selector("bounds"));
    return result;
}

static void set_frame(id receiver, Rect frame) {
    ((void (*)(id, SEL, Rect))objc_msgSend)(receiver, selector("setFrame:"), frame);
}

static Point get_point(id receiver, const char *name) {
    Point result;
    ((void (*)(Point *, id, SEL))objc_msgSend_stret)(
        &result, receiver, selector(name));
    return result;
}

static Point point_in_view(id receiver, const char *name, id target) {
    Point result;
    ((void (*)(Point *, id, SEL, id))objc_msgSend_stret)(
        &result, receiver, selector(name), target);
    return result;
}

static void set_point(id receiver, const char *name, Point value) {
    ((void (*)(id, SEL, Point))objc_msgSend)(receiver, selector(name), value);
}

static void set_size(id receiver, const char *name, Size value) {
    ((void (*)(id, SEL, Size))objc_msgSend)(receiver, selector(name), value);
}

static id color_rgba(float r, float g, float b, float a) {
    return ((id (*)(id, SEL, float, float, float, float))objc_msgSend)(
        klass("UIColor"), selector("colorWithRed:green:blue:alpha:"), r, g, b, a);
}

static id font(float size, int bold) {
    return ((id (*)(id, SEL, float))objc_msgSend)(klass("UIFont"),
        selector(bold ? "boldSystemFontOfSize:" : "systemFontOfSize:"), size);
}

static id make(const char *name, Rect frame) {
    return ((id (*)(id, SEL, Rect))objc_msgSend)(send(klass(name), "alloc"),
        selector("initWithFrame:"), frame);
}

static void add(id parent, id child) { send_object(parent, "addSubview:", child); }
static void background(id receiver, id value) {
    send_object(receiver, "setBackgroundColor:", value);
}

static void round_corners(id receiver, float radius) {
    id layer = send(receiver, "layer");
    send_float(layer, "setCornerRadius:", radius);
    send_int(layer, "setMasksToBounds:", 1);
}

static id label(id parent, Rect frame, const char *text, float size, int bold) {
    id result = make("UILabel", frame);
    send_object(result, "setText:", string(text));
    background(result, color_rgba(0, 0, 0, 0));
    send_object(result, "setTextColor:", color_rgba(.94f, .96f, 1, 1));
    send_object(result, "setFont:", font(size, bold));
    send_int(result, "setNumberOfLines:", 1);
    send_int(result, "setLineBreakMode:", 4); /* Tail truncation. */
    send_int(result, "setUserInteractionEnabled:", 0);
    add(parent, result);
    send(result, "release");
    return result;
}

static void muted(id receiver) {
    send_object(receiver, "setTextColor:", color_rgba(.64f, .72f, .79f, 1));
}

static void button_title(id button, const char *text) {
    ((void (*)(id, SEL, id, unsigned))objc_msgSend)(button,
        selector("setTitle:forState:"), string(text), 0);
}

static id button(id parent, Rect frame, const char *text, int action, int prominent) {
    id result = make("UIButton", frame);
    button_title(result, text);
    send_int(result, "setTag:", action);
    background(result, prominent ? color_rgba(.08f, .35f, .36f, .97f)
                                : color_rgba(.06f, .10f, .14f, .94f));
    send_object(send(result, "titleLabel"), "setFont:", font(13, 1));
    ((void (*)(id, SEL, id, unsigned))objc_msgSend)(result,
        selector("setTitleColor:forState:"), color_rgba(.48f, .90f, .81f, 1), 1);
    ((void (*)(id, SEL, id, SEL, unsigned))objc_msgSend)(result,
        selector("addTarget:action:forControlEvents:"), delegate,
        selector("pressed:"), 1U << 6);
    round_corners(result, 8);
    add(parent, result);
    send(result, "release");
    return result;
}

static id panel(id parent, Rect frame, float alpha) {
    id result = make("UIView", frame);
    background(result, color_rgba(.025f, .045f, .07f, alpha));
    send_int(result, "setUserInteractionEnabled:", 0);
    round_corners(result, 12);
    add(parent, result);
    send(result, "release");
    return result;
}

static id scroll_view(id parent, Rect frame) {
    id result = make("UIScrollView", frame);
    background(result, color_rgba(0, 0, 0, 0));
    send_int(result, "setAlwaysBounceVertical:", 1);
    send_int(result, "setShowsHorizontalScrollIndicator:", 0);
    send_int(result, "setIndicatorStyle:", 2); /* White on the dark sheet. */
    send_int(result, "setDelaysContentTouches:", 0);
    add(parent, result);
    send(result, "release");
    return result;
}

static float wrapped_label(id parent, float x, float y, float w,
                           const char *text, float size) {
    id result = label(parent, rectangle(x, y, w, 1), text, size, 0);
    send_int(result, "setNumberOfLines:", 0);
    send_int(result, "setLineBreakMode:", 0);
    Size measured;
    ((void (*)(Size *, id, SEL, Size))objc_msgSend_stret)(
        &measured, result, selector("sizeThatFits:"), (Size){w, 5000});
    set_frame(result, rectangle(x, y, w, measured.height));
    return measured.height;
}

static const char *quality_name(int quality) {
    switch (quality) {
        case 1: return "Retina";
        case 2: return "Balanced";
        default: return "Adaptive";
    }
}

static void clear_contacts(void) { atlas_worker_touch(-1, 0, 0, -1); }

static int place_preview(id parent, Rect frame, int index) {
    const char *place = ui_text(index, 4);
    if (!place || !*place || strlen(place) > 100) return 0;
    for (const char *p = place; *p; ++p) {
        if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '-')) return 0;
    }
    char path[1200];
    snprintf(path, sizeof path, "%s/assets/%s.preview.png", bundle, place);
    /* Avoid imageNamed:'s application-wide cache. The image view retains this
     * image only until the directory/about page is removed. At 320x180, all
     * five decoded previews together occupy at most about 1.1 MiB. */
    id image = send_object(send(klass("UIImage"), "alloc"),
                           "initWithContentsOfFile:", string(path));
    if (!image) return 0;
    Size size;
    ((void (*)(Size *, id, SEL))objc_msgSend_stret)(&size, image, selector("size"));
    if (!(size.width > 0 && size.height > 0 && size.width <= 320 && size.height <= 180)) {
        send(image, "release");
        return 0;
    }
    id image_view = make("UIImageView", frame);
    send_object(image_view, "setImage:", image);
    send(image, "release");
    send_int(image_view, "setContentMode:", 2); /* Aspect fill within the thumbnail. */
    send_int(image_view, "setUserInteractionEnabled:", 0);
    send_int(image_view, "setIsAccessibilityElement:", 0);
    round_corners(image_view, 6);
    add(parent, image_view);
    send(image_view, "release");
    return 1;
}

static void draw_atlas(float w, float h) {
    label(overlay, rectangle(18, 14, 270, 28), "POCKET ATLAS", 21, 1);
    muted(label(overlay, rectangle(19, 43, 265, 18),
                "Places worth remembering", 12, 0));
    button(overlay, rectangle(w - 97, 14, 81, 40), "Settings", ACTION_SETTINGS, 0);

    const float browse_x = w * .47f;
    const float browse_w = w - browse_x - 14;
    panel(overlay, rectangle(browse_x, 70, browse_w, h - 84), .94f);
    int count = ui_value(VALUE_PLACE_COUNT);
    char caption[64];
    snprintf(caption, sizeof caption, "%d PLACES TO VISIT", count);
    muted(label(overlay, rectangle(browse_x + 12, 77, browse_w - 24, 19),
                caption, 10, 1));
    id scroll = scroll_view(overlay, rectangle(browse_x + 6, 102, browse_w - 12, h - 123));
    page_scroll = scroll;
    float row_width = browse_w - 12;
    for (int i = 0; i < count; ++i) {
        const float y = i * 119.0f;
        id card = button(scroll, rectangle(0, y, row_width, 112), "", ACTION_PLACE + i, 0);
        int has_preview = place_preview(card, rectangle(8, 8, 88, 49.5f), i);
        float name_x = has_preview ? 104 : 11;
        id name = label(card, rectangle(name_x, 7, row_width - name_x - 10, 49),
                        ui_text(i, 0), 11.5f, 1);
        send_int(name, "setNumberOfLines:", 3);
        const char *context = ui_text(i, 5);
        if (!context || !*context) context = ui_text(i, 1);
        id details = label(card, rectangle(9, 65, row_width - 31, 38), context, 10, 0);
        send_int(details, "setNumberOfLines:", 3);
        muted(details);
        muted(label(card, rectangle(row_width - 20, 72, 13, 27), "›", 24, 0));
        char accessible[1024];
        snprintf(accessible, sizeof accessible, "Visit %s. %s. %s",
                 ui_text(i, 0), context, ui_text(i, 1));
        send_object(card, "setAccessibilityLabel:", string(accessible));
    }
    set_size(scroll, "setContentSize:", (Size){row_width, count * 119.0f});
    if (!count) {
        wrapped_label(scroll, 10, 16, row_width - 20,
                      "No places are installed. Add a place pack to start exploring.", 13);
    }
    muted(label(overlay, rectangle(20, h - 36, browse_x - 30, 19),
                "DRAG TO EXPLORE", 10, 1));
}

static void refresh_place(void) {
    int selected = ui_value(VALUE_SELECTED);
    int state = ui_value(VALUE_MODE);
    int index = selected >= 0 ? selected : requested_place;
    const char *name = index >= 0 ? ui_text(index, 0) : "Pocket Atlas";
    send_object(place_title, "setText:", string(name));
    char caption[256];
    if (state == 2) {
        snprintf(caption, sizeof caption, "Opening place…");
    } else if (state == 3) {
        snprintf(caption, sizeof caption, "%s", ui_text(-1, 3));
    } else {
        int shot = ui_value(VALUE_SHOT), count = ui_value(VALUE_SHOT_COUNT);
        const char *name = ui_text(-1, 2);
        snprintf(caption, sizeof caption, "%s  ·  %d / %d", name, shot + 1, count);
    }
    send_object(shot_label, "setText:", string(caption));
    button_title(pause_button, ui_value(VALUE_PAUSED) ? "Play" : "Pause");
    int cinematic = ui_value(VALUE_CINEMATIC);
    button_title(walk_button, cinematic ? "Walk" : "Cinematic");
    send_object(hint_label, "setText:", string(cinematic ? "" : "LEFT: MOVE     RIGHT: LOOK"));
}

static void draw_place(float w, float h) {
    button(overlay, rectangle(12, 10, 71, 42), "‹ Atlas", ACTION_BACK, 0);
    button(overlay, rectangle(w - 93, 10, 81, 42), "Settings", ACTION_SETTINGS, 0);
    panel(overlay, rectangle(90, 10, w - 190, 43), .84f);
    place_title = label(overlay, rectangle(101, 13, w - 212, 20), "", 12, 1);
    shot_label = label(overlay, rectangle(101, 33, w - 212, 15), "", 10, 0);
    muted(shot_label);

    float gap = 6, x = 12, y = h - 48;
    float available = w - 24 - 4 * gap;
    float narrow = available * .15f, middle = available * .21f;
    button(overlay, rectangle(x, y, narrow, 38), "‹ Shot", ACTION_PREVIOUS, 0);
    x += narrow + gap;
    pause_button = button(overlay, rectangle(x, y, middle, 38), "Pause", ACTION_PAUSE, 0);
    x += middle + gap;
    walk_button = button(overlay, rectangle(x, y, available * .28f, 38), "Walk", ACTION_WALK, 1);
    x += available * .28f + gap;
    button(overlay, rectangle(x, y, middle, 38), "About", ACTION_ABOUT, 0);
    x += middle + gap;
    button(overlay, rectangle(x, y, narrow, 38), "Shot ›", ACTION_NEXT, 0);
    hint_label = label(overlay, rectangle(16, h - 75, w - 32, 20), "", 10, 1);
    send_int(hint_label, "setTextAlignment:", 1);
    send_object(hint_label, "setShadowColor:", color_rgba(0, 0, 0, 1));
    set_size(hint_label, "setShadowOffset:", (Size){0, 1});
    refresh_place();
}

static float setting_row(id parent, float y, float w, const char *name,
                         const char *value, const char *description, int action) {
    id row = button(parent, rectangle(0, y, w, 59), "", action, 0);
    label(row, rectangle(12, 7, w * .55f, 23), name, 14, 1);
    id state = label(row, rectangle(w * .55f, 8, w * .45f - 14, 21), value, 13, 1);
    send_int(state, "setTextAlignment:", 2);
    send_object(state, "setTextColor:", color_rgba(.48f, .90f, .81f, 1));
    muted(label(row, rectangle(12, 33, w - 24, 18), description, 10, 0));
    char accessible[512];
    snprintf(accessible, sizeof accessible, "%s, %s. %s", name, value, description);
    send_object(row, "setAccessibilityLabel:", string(accessible));
    return y + 66;
}

static void draw_settings(float w, float h) {
    background(overlay, color_rgba(.025f, .04f, .065f, .98f));
    label(overlay, rectangle(18, 13, w - 120, 31), "Settings", 24, 1);
    muted(label(overlay, rectangle(19, 45, w - 120, 16),
                "Choose how you explore", 11, 0));
    button(overlay, rectangle(w - 97, 14, 81, 40), "Done", ACTION_RESUME, 1);
    settings_scroll = scroll_view(overlay, rectangle(16, 70, w - 32, h - 80));
    page_scroll = settings_scroll;
    float row_width = w - 32;
    float y = 0;
    y = setting_row(settings_scroll, y, row_width, "Image quality",
                    quality_name(ui_value(VALUE_QUALITY)),
                    "Adaptive adjusts resolution to the scene workload.", ACTION_QUALITY);
    y = setting_row(settings_scroll, y, row_width, "Rain",
                    ui_value(VALUE_RAIN) ? "On" : "Off",
                    "Rainfall in wet-weather places.", ACTION_RAIN);
    y = setting_row(settings_scroll, y, row_width, "Reflections",
                    ui_value(VALUE_REFLECTION) ? "On" : "Off",
                    "Scene reflections on wet surfaces.", ACTION_REFLECTION);
    y = setting_row(settings_scroll, y, row_width, "Bloom",
                    ui_value(VALUE_BLOOM) ? "On" : "Off",
                    "Soft glow around lights and bright surfaces.", ACTION_BLOOM);
    if (ui_value(VALUE_SOUND_AVAILABLE)) {
        y = setting_row(settings_scroll, y, row_width, "Sound",
                        ui_value(VALUE_SOUND) ? "On" : "Off",
                        "Ambient sound and place effects.", ACTION_SOUND);
    }
    if (return_page == PAGE_PLACE) {
        y = setting_row(settings_scroll, y, row_width, "Camera",
                        ui_value(VALUE_CINEMATIC) ? "Cinematic" : "Walk",
                        "In Walk: drag left to move, drag right to look.", ACTION_WALK);
        y = setting_row(settings_scroll, y, row_width, "Cinematic playback",
                        ui_value(VALUE_PAUSED) ? "Paused" : "Playing",
                        "Pause or resume the scene and camera sequence.", ACTION_PAUSE);
        button(settings_scroll, rectangle(0, y, row_width, 44),
               "Restart cinematic", ACTION_RESTART, 0);
        y += 52;
        button(settings_scroll, rectangle(0, y, row_width, 44),
               "About this place", ACTION_ABOUT, 0);
        y += 54;
    }
    set_size(settings_scroll, "setContentSize:", (Size){row_width, y});
    float maximum = y - (h - 80);
    if (maximum < 0) maximum = 0;
    if (settings_offset.y > maximum) settings_offset.y = maximum;
    if (settings_offset.y < 0) settings_offset.y = 0;
    set_point(settings_scroll, "setContentOffset:", settings_offset);
}

static void draw_about(float w, float h) {
    background(overlay, color_rgba(.025f, .04f, .065f, .99f));
    label(overlay, rectangle(18, 15, w - 130, 32), "About this place", 23, 1);
    button(overlay, rectangle(w - 97, 14, 81, 40), "Done", ACTION_RESUME, 1);
    id scroll = scroll_view(overlay, rectangle(20, 72, w - 40, h - 82));
    page_scroll = scroll;
    float content_width = w - 40;
    int has_preview = place_preview(scroll, rectangle(0, 0, 160, 90), -1);
    float y;
    if (has_preview) {
        id name = label(scroll, rectangle(176, 0, content_width - 176, 86),
                        ui_text(-1, 0), 21, 1);
        send_int(name, "setNumberOfLines:", 3);
        y = 106;
    } else {
        y = wrapped_label(scroll, 0, 0, content_width, ui_text(-1, 0), 23) + 19;
    }
    const char *context = ui_text(-1, 5);
    if (context && *context) y += wrapped_label(scroll, 0, y, content_width, context, 13) + 18;
    const char *author = ui_text(-1, 6);
    if (author && *author) {
        char credit[256];
        snprintf(credit, sizeof credit, "Created by %s", author);
        muted(label(scroll, rectangle(0, y, content_width, 19), credit, 12, 0));
        y += 34;
    }
    muted(label(scroll, rectangle(0, y, content_width, 18), "THE PLACE", 10, 1));
    y += 25;
    y += wrapped_label(scroll, 0, y, content_width, ui_text(-1, 1), 15) + 25;
    muted(label(scroll, rectangle(0, y, content_width, 18), "EXPLORE", 10, 1));
    y += 25;
    y += wrapped_label(scroll, 0, y, content_width,
                       "Follow the cinematic views, choose a shot, or switch to Walk "
                       "to find your own perspective.", 13) + 20;
    set_size(scroll, "setContentSize:", (Size){content_width, y});
}

static void show_ui(void) {
    clear_contacts();
    if (settings_scroll) settings_offset = get_point(settings_scroll, "contentOffset");
    settings_scroll = NULL;
    page_scroll = NULL;
    place_title = shot_label = pause_button = walk_button = hint_label = NULL;
    if (overlay) {
        send(overlay, "removeFromSuperview");
        send(overlay, "release");
    }
    Rect frame = bounds(view);
    overlay = make("AtlasOverlay", frame);
    background(overlay, color_rgba(0, 0, 0, 0));
    send_int(overlay, "setMultipleTouchEnabled:", 1);
    /* Modal sheets consume empty-space touches. Scene/atlas chrome passes them
     * through to the EAGL view so multiple gestures can coexist with buttons. */
    send_int(overlay, "setTag:", page >= PAGE_SETTINGS);
    add(view, overlay);
    float w = frame.size.width, h = frame.size.height;
    switch (page) {
        case PAGE_SETTINGS: draw_settings(w, h); break;
        case PAGE_ABOUT: draw_about(w, h); break;
        case PAGE_PLACE: draw_place(w, h); break;
        default: draw_atlas(w, h); break;
    }
    for (int i = 0; i < VALUE_COUNT; ++i) last_values[i] = ui_value(i);
}

static void perform_action(int action) {
    clear_contacts();
    if (action == ACTION_SETTINGS) {
        return_page = page;
        settings_offset = (Point){0, 0};
        page = PAGE_SETTINGS;
    } else if (action == ACTION_ABOUT) {
        /* About always returns to the place. This also avoids nested sheets. */
        return_page = PAGE_PLACE;
        page = PAGE_ABOUT;
    } else if (action == ACTION_RESUME) {
        page = return_page;
    } else {
        unsigned long sequence = atlas_worker_action(action);
        if (!sequence) return;
        if (sequence && (action == ACTION_BACK || action >= ACTION_PLACE)) {
            pending_navigation = sequence;
            pending_place = action == ACTION_BACK ? -1 : action - ACTION_PLACE;
        }
        if (action == ACTION_BACK) {
            requested_place = -1;
            page = PAGE_ATLAS;
        } else if (action >= ACTION_PLACE && action < ACTION_PLACE + ui_value(VALUE_PLACE_COUNT)) {
            requested_place = action - ACTION_PLACE;
            page = PAGE_PLACE;
        } else if (action == ACTION_RESTART) {
            page = PAGE_PLACE;
        }
    }
    show_ui();
}

static void pressed(id self, SEL command, id sender) {
    (void)self; (void)command;
    perform_action(get_int(sender, "tag"));
}

/* The validation mailbox exercises the same action dispatcher as UIKit. It
 * cannot prove finger ergonomics, but allows reproducible captures of sheets
 * and scroll bounds without adding a second UI state machine in Rust. */
static void interface_command(const char *json) {
    id data = ((id (*)(id, SEL, unsigned))objc_msgSend)(
        string(json), selector("dataUsingEncoding:"), 4); /* NSUTF8StringEncoding. */
    id dictionary = ((id (*)(id, SEL, id, unsigned, id *))objc_msgSend)(
        klass("NSJSONSerialization"), selector("JSONObjectWithData:options:error:"),
        data, 0, NULL);
    BOOL is_dictionary = ((BOOL (*)(id, SEL, id))objc_msgSend)(
        dictionary, selector("isKindOfClass:"), klass("NSDictionary"));
    if (!is_dictionary) return;
    id action_value = send_object(dictionary, "objectForKey:", string("uiAction"));
    BOOL is_number = ((BOOL (*)(id, SEL, id))objc_msgSend)(
        action_value, selector("isKindOfClass:"), klass("NSNumber"));
    if (is_number) {
        int action = get_int(action_value, "intValue");
        int scene_action = action == ACTION_PREVIOUS || action == ACTION_NEXT ||
                           action == ACTION_PAUSE || action == ACTION_WALK ||
                           action == ACTION_RESTART || action == ACTION_ABOUT;
        int valid = action == ACTION_BACK || (action >= ACTION_SETTINGS && action <= ACTION_ABOUT) ||
                    (action >= ACTION_PLACE && action < ACTION_PLACE + ui_value(VALUE_PLACE_COUNT));
        if (valid && (!scene_action || ui_value(VALUE_MODE) == 1)) perform_action(action);
    }
    id scroll_value = send_object(dictionary, "objectForKey:", string("uiScroll"));
    is_number = ((BOOL (*)(id, SEL, id))objc_msgSend)(
        scroll_value, selector("isKindOfClass:"), klass("NSNumber"));
    if (is_number && page_scroll) {
        float requested = ((float (*)(id, SEL))objc_msgSend)(scroll_value, selector("floatValue"));
        Size content;
        ((void (*)(Size *, id, SEL))objc_msgSend_stret)(
            &content, page_scroll, selector("contentSize"));
        float maximum = content.height - bounds(page_scroll).size.height;
        if (maximum < 0) maximum = 0;
        if (!(requested >= 0)) requested = 0;
        if (requested > maximum) requested = maximum;
        set_point(page_scroll, "setContentOffset:", (Point){0, requested});
    }
}

static id overlay_hit_test(id self, SEL command, Point point, id event) {
    (void)command;
    Rect frame = bounds(self);
    if (point.x < 0 || point.y < 0 || point.x >= frame.size.width || point.y >= frame.size.height)
        return NULL;
    id children = send(self, "subviews");
    unsigned count = (unsigned)get_int(children, "count");
    while (count) {
        id child = ((id (*)(id, SEL, unsigned))objc_msgSend)(
            children, selector("objectAtIndex:"), --count);
        Point local;
        ((void (*)(Point *, id, SEL, Point, id))objc_msgSend_stret)(
            &local, self, selector("convertPoint:toView:"), point, child);
        id hit = ((id (*)(id, SEL, Point, id))objc_msgSend)(
            child, selector("hitTest:withEvent:"), local, event);
        if (hit) return hit;
    }
    return get_int(self, "tag") ? self : NULL;
}

static void ignore_touch(id self, SEL command, id touches, id event) {
    (void)self; (void)command; (void)touches; (void)event;
}

static Class layer_class(id self, SEL command) {
    (void)self; (void)command;
    return klass("CAEAGLLayer");
}

static void touch(id self, SEL command, id touches, id event) {
    (void)command; (void)event;
    id changed = send(touches, "allObjects");
    unsigned count = (unsigned)get_int(changed, "count");
    for (unsigned i = 0; i < count; ++i) {
        id contact = ((id (*)(id, SEL, unsigned))objc_msgSend)(
            changed, selector("objectAtIndex:"), i);
        Point position = point_in_view(contact, "locationInView:", self);
        int phase = get_int(contact, "phase");
        atlas_worker_touch(phase, position.x, position.y, (int)(uintptr_t)contact);
    }
}

static double now(void) {
    mach_timebase_info_data_t rate;
    mach_timebase_info(&rate);
    return (double)mach_absolute_time() * (double)rate.numer / (double)rate.denom * 1e-9;
}

static void atomic_text(const char *name, const char *text) {
    char destination[1100], staging[1108];
    snprintf(destination, sizeof destination, "%s/%s", tmp, name);
    snprintf(staging, sizeof staging, "%s.new", destination);
    FILE *file = fopen(staging, "w");
    if (file) {
        fputs(text, file);
        if (fclose(file) == 0) rename(staging, destination);
    }
}

static int consume_request(const char *name) {
    char path[1100];
    snprintf(path, sizeof path, "%s/%s", tmp, name);
    return unlink(path) == 0;
}

/* UIGetScreenImage includes both the EAGL surface and UIKit subviews. Rendering
 * a CALayer into a bitmap alone loses EAGL content. Keep the raw GL mailbox for
 * renderer comparisons and write this second, composited capture separately. */
static void capture_interface(void) {
    typedef void *(*ScreenImage)(void);
    typedef id (*PNGRepresentation)(id);
    typedef void (*ReleaseImage)(void *);
    void *handle = (void *)(intptr_t)-2; /* Darwin RTLD_DEFAULT. */
    ScreenImage screen_image = (ScreenImage)dlsym(handle, "UIGetScreenImage");
    PNGRepresentation png = (PNGRepresentation)dlsym(handle, "UIImagePNGRepresentation");
    ReleaseImage release_image = (ReleaseImage)dlsym(handle, "CGImageRelease");
    if (!screen_image || !png || !release_image) {
        atomic_text("capture-ui-error.txt", "Screen capture is unavailable on this iOS runtime.");
        return;
    }
    void *image = screen_image();
    if (!image) {
        atomic_text("capture-ui-error.txt", "UIGetScreenImage returned no image.");
        return;
    }
    id ui_image = ((id (*)(id, SEL, void *))objc_msgSend)(
        klass("UIImage"), selector("imageWithCGImage:"), image);
    id data = png(ui_image);
    char path[1100];
    snprintf(path, sizeof path, "%s/frame-ui.png", tmp);
    BOOL written = ((BOOL (*)(id, SEL, id, BOOL))objc_msgSend)(
        data, selector("writeToFile:atomically:"), string(path), 1);
    release_image(image);
    if (!written) atomic_text("capture-ui-error.txt", "Writing the UIKit capture failed.");
    else {
        snprintf(path, sizeof path, "%s/capture-ui-error.txt", tmp);
        unlink(path);
    }
}

static void refresh_ui(void) {
    int state = ui_value(VALUE_MODE);
    int count = ui_value(VALUE_PLACE_COUNT);
    int selected = ui_value(VALUE_SELECTED);
    /* Commands from the debug mailbox change the native UI through the same
     * state as finger input; a captured title must describe the rendered place. */
    if (state == 0 && last_values[VALUE_MODE] != 0) {
        page = PAGE_ATLAS;
        show_ui();
    } else if (state != 0 && (page == PAGE_ATLAS || selected != last_values[VALUE_SELECTED])) {
        page = PAGE_PLACE;
        show_ui();
    } else if (page == PAGE_ATLAS && count != last_values[VALUE_PLACE_COUNT]) {
        show_ui();
    } else if (page == PAGE_SETTINGS) {
        for (int i = VALUE_PAUSED; i <= VALUE_QUALITY; ++i) {
            if (ui_value(i) != last_values[i]) {
                show_ui();
                break;
            }
        }
    } else if (page == PAGE_PLACE) {
        /* Avoid creating NSStrings and committing label layers on every frame.
         * Camera motion belongs to GL; UIKit only changes with visible state. */
        const int fields[] = {VALUE_MODE, VALUE_SELECTED, VALUE_PAUSED,
                              VALUE_CINEMATIC, VALUE_SHOT, VALUE_SHOT_COUNT};
        for (unsigned i = 0; i < sizeof fields / sizeof fields[0]; ++i) {
            if (ui_value(fields[i]) != last_values[fields[i]]) {
                refresh_place();
                break;
            }
        }
    }
    for (int i = 0; i < VALUE_COUNT; ++i) last_values[i] = ui_value(i);
}

static void tick(id self, SEL command, id timer) {
    (void)self; (void)command; (void)timer;
    if (!active) return;
    double time = now();
    static double ui_ms = 33.333, last_status;
    if (last > 0) ui_ms = ui_ms * .9 + (time - last) * 1000 * .1;
    last = time;
    atlas_worker_snapshot(&ui_snapshot);
    char path[1100];
    snprintf(path, sizeof path, "%s/control.json", tmp);
    FILE *file = fopen(path, "r");
    if (file) {
        char data[4096];
        size_t count = fread(data, 1, sizeof data - 1, file);
        data[count] = 0;
        fclose(file);
        unlink(path);
        clear_contacts();
        atlas_worker_command(data);
        interface_command(data);
    }
    refresh_ui();
    atlas_worker_request_frame();
    if (consume_request("capture-ui")) capture_interface();
    ++frames;
    if (time - last_status > .5) {
        char status[512];
        snprintf(status, sizeof status,
                 "{\"thread\":\"main\",\"uiFrame\":%lu,\"uiFrameMs\":%.3f,"
                 "\"renderSnapshot\":%lu,\"appliedEvent\":%lu,\"queuedEvents\":%u,\"page\":%d,\"scrollY\":%.1f}",
                 frames, ui_ms, ui_snapshot.generation, ui_snapshot.applied_event,
                 atlas_worker_pending_events(), page, page_scroll ? get_point(page_scroll, "contentOffset").y : 0);
        atomic_text("ui-status.json", status);
        last_status = time;
    }
}

static BOOL launch(id self, SEL command, id application, id options) {
    (void)command; (void)options;
    delegate = self;
    snprintf(bundle, sizeof bundle, "%s", utf8(send(send(klass("NSBundle"), "mainBundle"), "bundlePath")));
    const char *home = getenv("HOME");
    snprintf(tmp, sizeof tmp, "%s/tmp", home ? home : ".");
    Rect screen = bounds(send(klass("UIScreen"), "mainScreen"));
    window = make("UIWindow", screen);
    view = make("AtlasView", rectangle(0, 0, 480, 320));
    Transform rotation = {0, 1, -1, 0, 0, 0};
    ((void (*)(id, SEL, Transform))objc_msgSend)(view, selector("setTransform:"), rotation);
    set_point(view, "setCenter:", (Point){160, 240});
    send_int(view, "setMultipleTouchEnabled:", 1);
    send_float(view, "setContentScaleFactor:", 2);
    add(window, view);
    send(window, "makeKeyAndVisible");
    send_int(application, "setIdleTimerDisabled:", 1);
    send_int(application, "setStatusBarHidden:", 1);

    context = ((id (*)(id, SEL, int))objc_msgSend)(
        send(klass("EAGLContext"), "alloc"), selector("initWithAPI:"), 2);
    if (!context) {
        atomic_text("status.json", "{\"error\":\"EAGL ES2 unavailable\"}");
        return 1;
    }
    send_object(klass("EAGLContext"), "setCurrentContext:", context);
    id layer = send(view, "layer");
    send_int(layer, "setOpaque:", 1);
    send_float(layer, "setContentsScale:", 2);
    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(0x8d40, fbo);
    glGenRenderbuffers(1, &color);
    glBindRenderbuffer(0x8d41, color);
    ((BOOL (*)(id, SEL, unsigned, id))objc_msgSend)(
        context, selector("renderbufferStorage:fromDrawable:"), 0x8d41, layer);
    glGetRenderbufferParameteriv(0x8d41, 0x8d42, &width);
    glGetRenderbufferParameteriv(0x8d41, 0x8d43, &height);
    glFramebufferRenderbuffer(0x8d40, 0x8ce0, 0x8d41, color);
    glGenRenderbuffers(1, &depth);
    glBindRenderbuffer(0x8d41, depth);
    glRenderbufferStorage(0x8d41, 0x81a5, width, height);
    glFramebufferRenderbuffer(0x8d40, 0x8d00, 0x8d41, depth);
    char info[4096];
    snprintf(info, sizeof info,
             "{\"renderer\":\"%s\",\"version\":\"%s\",\"extensions\":\"%s\","
             "\"width\":%d,\"height\":%d,\"framebuffer\":%u,\"glError\":%u}",
             glGetString(0x1f01), glGetString(0x1f02), glGetString(0x1f03),
             width, height, glCheckFramebufferStatus(0x8d40), glGetError());
    atomic_text("gpu.json", info);
    atomic_text("startup.txt", "GPU ready; initializing places");
    if (!atlas_worker_start(context, fbo, color, width, height, bundle, tmp)) {
        atomic_text("status.json", "{\"state\":\"error\",\"error\":\"Rendering thread initialization failed\"}");
        return 1;
    }
    atlas_worker_snapshot(&ui_snapshot);
    atomic_text("startup.txt", "Places ready; constructing native interface");
    show_ui();
    atomic_text("startup.txt", "Interface ready; scheduling display link");
    last = now();
    display_link = ((id (*)(id, SEL, id, SEL))objc_msgSend)(
        klass("CADisplayLink"), selector("displayLinkWithTarget:selector:"), self, selector("tick:"));
    send_int(display_link, "setFrameInterval:", 2);
    /* Use Foundation's actual common-mode object, including its identity.
     * Fall back to the default mode on a runtime without that export. */
    id *common_mode = (id *)dlsym((void *)(intptr_t)-2, "NSRunLoopCommonModes");
    id mode = common_mode ? *common_mode : string("kCFRunLoopDefaultMode");
    ((void (*)(id, SEL, id, id))objc_msgSend)(display_link,
        selector("addToRunLoop:forMode:"), send(klass("NSRunLoop"), "mainRunLoop"),
        mode);
    atomic_text("startup.txt", "Display link scheduled");
    return 1;
}

static void inactive(id self, SEL command, id application) {
    (void)self; (void)command; (void)application;
    clear_contacts();
    active = 0;
    send_int(display_link, "setPaused:", 1);
    atlas_worker_active(0);
}

static void resumed(id self, SEL command, id application) {
    (void)self; (void)command; (void)application;
    clear_contacts();
    last = now();
    active = 1; atlas_worker_active(1);
    send_int(display_link, "setPaused:", 0);
}

static void terminated(id self, SEL command, id application) {
    (void)self; (void)command; (void)application;
    clear_contacts();
    send(display_link, "invalidate");
    atlas_worker_stop();
}

void atlas_log(const char *text) {
    fprintf(stderr, "Atlas: %s\n", text);
    atomic_text("error.txt", text);
}

int main(int argc, char **argv) {
    id pool = send(send(klass("NSAutoreleasePool"), "alloc"), "init");
    const char *touch_events[] = {"touchesBegan:withEvent:", "touchesMoved:withEvent:",
                                  "touchesEnded:withEvent:", "touchesCancelled:withEvent:"};
    Class render_view = objc_allocateClassPair(klass("UIView"), "AtlasView", 0);
    class_addMethod(object_getClass(render_view), selector("layerClass"), (void (*)(void))layer_class, "#@:");
    for (int i = 0; i < 4; ++i)
        class_addMethod(render_view, selector(touch_events[i]), (void (*)(void))touch, "v@:@@");
    objc_registerClassPair(render_view);
    Class chrome = objc_allocateClassPair(klass("UIView"), "AtlasOverlay", 0);
    class_addMethod(chrome, selector("hitTest:withEvent:"), (void (*)(void))overlay_hit_test, "@@:{CGPoint=ff}@");
    for (int i = 0; i < 4; ++i)
        class_addMethod(chrome, selector(touch_events[i]), (void (*)(void))ignore_touch, "v@:@@");
    objc_registerClassPair(chrome);
    Class app_delegate = objc_allocateClassPair(klass("NSObject"), "AtlasDelegate", 0);
    class_addMethod(app_delegate, selector("application:didFinishLaunchingWithOptions:"),
                    (void (*)(void))launch, "c@:@@");
    class_addMethod(app_delegate, selector("tick:"), (void (*)(void))tick, "v@:@");
    class_addMethod(app_delegate, selector("pressed:"), (void (*)(void))pressed, "v@:@");
    class_addMethod(app_delegate, selector("applicationWillResignActive:"), (void (*)(void))inactive, "v@:@");
    class_addMethod(app_delegate, selector("applicationDidEnterBackground:"), (void (*)(void))inactive, "v@:@");
    class_addMethod(app_delegate, selector("applicationDidBecomeActive:"), (void (*)(void))resumed, "v@:@");
    class_addMethod(app_delegate, selector("applicationWillTerminate:"), (void (*)(void))terminated, "v@:@");
    objc_registerClassPair(app_delegate);
    int result = UIApplicationMain(argc, argv, NULL, string("AtlasDelegate"));
    send(pool, "release");
    return result;
}

double atlas_seconds(void) { return now(); }

unsigned atlas_resident_bytes(void) {
    task_basic_info_data_t info;
    mach_msg_type_number_t count=TASK_BASIC_INFO_COUNT;
    return task_info(mach_task_self(),TASK_BASIC_INFO,(task_info_t)&info,&count)==KERN_SUCCESS ? (unsigned)info.resident_size : 0;
}
