#ifndef ATLAS_CONTROL_H
#define ATLAS_CONTROL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
// Control records arrive over PocketJS's authenticated, length-bounded wire.
// Skip quoted contents when locating keys, so search text cannot act as a key.
static inline const char *control_field(const char *json, const char *key) {
  size_t n = strlen(key);
  for (const char *p = json; *p; p++) {
    if (*p != '"')
      continue;
    const char *begin = ++p;
    while (*p && *p != '"') {
      if (*p == '\\' && p[1])
        p++;
      p++;
    }
    if (!*p)
      break;
    const char *end = p;
    const char *v = p + 1;
    while (*v == ' ' || *v == '\t' || *v == '\r' || *v == '\n')
      v++;
    if (*v != ':' || (size_t)(end - begin) != n || memcmp(begin, key, n))
      continue;
    do {
      v++;
    } while (*v == ' ' || *v == '\t' || *v == '\r' || *v == '\n');
    return v;
  }
  return NULL;
}
static inline bool control_string(const char *json, const char *key, char *out,
                                  size_t cap) {
  const char *p = control_field(json, key);
  if (!p || *p++ != '"' || !cap)
    return false;
  size_t n = 0;
  while (*p && *p != '"') {
    if (*p == '\\') {
      p++;
      if (*p != '\\' && *p != '"' && *p != '/')
        return false;
    }
    if (!*p || n + 1 >= cap)
      return false;
    out[n++] = *p++;
  }
  out[n] = 0;
  return *p == '"';
}
static inline bool control_bool(const char *json, const char *key, bool *out) {
  const char *p = control_field(json, key);
  if (!p)
    return false;
  if (!strncmp(p, "true", 4)) {
    *out = true;
    return true;
  }
  if (!strncmp(p, "false", 5)) {
    *out = false;
    return true;
  }
  return false;
}
static inline unsigned long control_uint(const char *json, const char *key,
                                         unsigned long fallback) {
  const char *p = control_field(json, key);
  if (!p || *p < '0' || *p > '9')
    return fallback;
  return strtoul(p, NULL, 10);
}
static inline double control_number(const char *json, const char *key,
                                    double fallback) {
  const char *p = control_field(json, key);
  if (!p || (*p != '-' && (*p < '0' || *p > '9')))
    return fallback;
  return strtod(p, NULL);
}
static inline void control_escape(char *out, size_t cap, const char *s) {
  size_t n = 0;
  while (*s && n + 2 < cap) {
    unsigned char c = *s++;
    if (c == '"' || c == '\\')
      out[n++] = '\\';
    out[n++] = c < 32 ? ' ' : c;
  }
  if (cap)
    out[n] = 0;
}
#endif
