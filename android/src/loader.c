// What NativeActivity loads (android.app.lib_name): it finds the app's own
// library and hands the activity to it. A development build first looks for
// a library pushed to the phone (tools/atlas-android.ts native), so a change
// to the renderer needs no install; a release build has no such door.
#include <android/log.h>
#include <android/native_activity.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#ifndef ATLAS_PACKAGE
#define ATLAS_PACKAGE "dev.pocketnexus.atlas"
#endif

typedef void Entry(ANativeActivity *, void *, size_t);

__attribute__((visibility("default"))) void ANativeActivity_onCreate(ANativeActivity *activity, void *saved, size_t size) {
  char path[512];
  void *library = NULL;
#ifdef ATLAS_DEV
  snprintf(path, sizeof path, "/data/local/tmp/%s/libatlas.so", ATLAS_PACKAGE);
  if (!access(path, R_OK))
    library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
#endif
  if (!library) {
    // Beside this library, wherever the system unpacked the APK's.
    Dl_info here;
    if (dladdr((void *)ANativeActivity_onCreate, &here) && here.dli_fname && strrchr(here.dli_fname, '/')) {
      snprintf(path, sizeof path, "%.*s/libatlas.so", (int)(strrchr(here.dli_fname, '/') - here.dli_fname), here.dli_fname);
      library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    }
    if (!library) {
      snprintf(path, sizeof path, "/data/data/%s/lib/libatlas.so", ATLAS_PACKAGE);
      library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    }
  }
  Entry *entry = library ? (Entry *)dlsym(library, "atlas_activity") : NULL;
  __android_log_print(entry ? ANDROID_LOG_INFO : ANDROID_LOG_ERROR, "PocketAtlas", "%s: %s", path, entry ? "loaded" : dlerror());
  if (entry)
    entry(activity, saved, size);
  else
    ANativeActivity_finish(activity);
}
