#ifndef ATLAS_ASSETS_H
#define ATLAS_ASSETS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ATLAS_ASSET_MAX_BYTES (128u * 1024u * 1024u)
#define ATLAS_ASSET_PATH_BYTES 128

/* Assets are application data, requested over the existing paired control
 * connection. The temporary HTTP endpoint serves only the named pack. */
bool assets_path(const char *sha256, char *path, size_t capacity);

/* Call with the GPU retired and the previous scene released. SOC must already
 * be initialized by the devserver. Pumps that same authenticated connection
 * while receiving; disconnect or L+R+START cancels and removes the partial
 * file. A verified cache hit sets cached=true. No JSON or renderer ownership
 * here. */
bool assets_fetch(const char *host, unsigned port, const char *token,
                  const char *sha256, uint32_t bytes, uint32_t crc32,
                  bool *cached, char *error, size_t error_capacity);

#endif
