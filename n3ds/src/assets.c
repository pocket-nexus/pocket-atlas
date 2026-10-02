#include "assets.h"
#include "dev_protocol.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __3DS__
#include "devserver.h"
#include <3ds.h>
#else
#include <time.h>
#endif

#ifndef ATLAS_ASSET_DIRECTORY
#define ATLAS_ASSET_DIRECTORY "sdmc:/pocket-atlas"
#endif
#ifndef ATLAS_ASSET_IDLE_MS
#define ATLAS_ASSET_IDLE_MS 30000u
#endif
#define ASSET_TOTAL_MS (20u * 60u * 1000u)
#define ASSET_BUFFER_BYTES (64u * 1024u)
#define ASSET_HEADER_BYTES 8192u

static uint64_t milliseconds(void) {
#ifdef __3DS__
  return osGetTime();
#else
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
#endif
}

static bool fail(char *error, size_t capacity, const char *format, ...) {
  if (error && capacity) {
    va_list args;
    va_start(args, format);
    vsnprintf(error, capacity, format, args);
    va_end(args);
  }
  return false;
}

static bool pump(char *error, size_t capacity) {
#ifdef __3DS__
  devserver_poll();
  if (!devserver_connected())
    return fail(error, capacity,
                "Asset transfer cancelled: debugger disconnected");
  hidScanInput();
  const uint32_t exit_keys = KEY_L | KEY_R | KEY_START;
  if (!aptMainLoop() || (hidKeysHeld() & exit_keys) == exit_keys)
    return fail(error, capacity, "Asset transfer cancelled");
#else
  (void)error;
  (void)capacity;
#endif
  return true;
}

static void yield_network(void) {
#ifdef __3DS__
  svcSleepThread(1000000);
#else
  const struct timespec pause = {.tv_nsec = 1000000};
  nanosleep(&pause, NULL);
#endif
}

static bool hex64(const char *value) {
  if (!value || strlen(value) != 64)
    return false;
  for (unsigned i = 0; i < 64; i++)
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f')))
      return false;
  return true;
}

static bool ipv4(const char *host, struct in_addr *address) {
  if (!host || strlen(host) > 15)
    return false;
  unsigned parts[4];
  char tail;
  if (sscanf(host, "%u.%u.%u.%u%c", &parts[0], &parts[1], &parts[2], &parts[3],
             &tail) != 4)
    return false;
  for (unsigned i = 0; i < 4; i++)
    if (parts[i] > 255)
      return false;
  char canonical[16];
  snprintf(canonical, sizeof canonical, "%u.%u.%u.%u", parts[0], parts[1],
           parts[2], parts[3]);
  return strcmp(host, canonical) == 0 &&
         inet_pton(AF_INET, host, address) == 1 && parts[0] != 0 &&
         parts[0] < 224;
}

bool assets_path(const char *sha256, char *path, size_t capacity) {
  if (!hex64(sha256) || !path || !capacity)
    return false;
  int n = snprintf(path, capacity, ATLAS_ASSET_DIRECTORY "/%s.place", sha256);
  return n > 0 && (size_t)n < capacity;
}

/* -1 is cancellation, 0 is absent/corrupt, 1 is a verified cache hit. */
static int verify_cached(const char *path, uint32_t bytes,
                         uint32_t expected_crc, uint8_t *buffer, char *error,
                         size_t error_capacity) {
  struct stat info;
  if (stat(path, &info) != 0 || info.st_size != bytes)
    return 0;
  FILE *file = fopen(path, "rb");
  if (!file)
    return 0;
  uint32_t crc = 0, total = 0;
  int result = 0;
  while (total < bytes) {
    if (!pump(error, error_capacity)) {
      result = -1;
      break;
    }
    size_t count = bytes - total;
    if (count > ASSET_BUFFER_BYTES)
      count = ASSET_BUFFER_BYTES;
    size_t n = fread(buffer, 1, count, file);
    if (n != count)
      break;
    crc = pocket_runtime_crc32(crc, buffer, n);
    total += n;
  }
  if (total == bytes && crc == expected_crc && !ferror(file))
    result = 1;
  fclose(file);
  return result;
}

static bool keep_waiting(uint64_t start, uint64_t last, char *error,
                         size_t capacity) {
  if (!pump(error, capacity))
    return false;
  uint64_t now = milliseconds();
  if (now - last >= ATLAS_ASSET_IDLE_MS || now - start >= ASSET_TOTAL_MS)
    return fail(error, capacity, "Asset transfer timed out");
  return true;
}

static bool retryable(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
}

/* The server sends an exact Content-Length, without compression or chunking.
 * Reject ambiguous framing instead of attempting to be a general HTTP client.
 */
static bool check_headers(char *header, uint32_t bytes, char *error,
                          size_t capacity) {
  char *line = strstr(header, "\r\n");
  if (!line)
    return fail(error, capacity, "Invalid asset HTTP response");
  *line = 0;
  if ((strncmp(header, "HTTP/1.1 200", 12) != 0 &&
       strncmp(header, "HTTP/1.0 200", 12) != 0) ||
      (header[12] != ' ' && header[12] != 0))
    return fail(error, capacity, "Asset server did not return HTTP 200");
  bool length_seen = false;
  while (*(line += 2)) {
    if (line[0] == '\r' && line[1] == '\n')
      break;
    char *end = strstr(line, "\r\n");
    if (!end)
      return fail(error, capacity, "Invalid asset HTTP headers");
    *end = 0;
    char *colon = strchr(line, ':');
    if (!colon)
      return fail(error, capacity, "Invalid asset HTTP header");
    *colon++ = 0;
    while (*colon == ' ' || *colon == '\t')
      colon++;
    if (strcasecmp(line, "Content-Length") == 0) {
      if (length_seen || !*colon)
        return fail(error, capacity, "Invalid asset Content-Length");
      uint64_t length = 0;
      for (; *colon; colon++) {
        if (*colon < '0' || *colon > '9')
          return fail(error, capacity, "Invalid asset Content-Length");
        length = length * 10 + *colon - '0';
        if (length > ATLAS_ASSET_MAX_BYTES)
          return fail(error, capacity, "Asset Content-Length exceeds limit");
      }
      if (length != bytes)
        return fail(error, capacity, "Asset Content-Length mismatch");
      length_seen = true;
    } else if (strcasecmp(line, "Transfer-Encoding") == 0 ||
               (strcasecmp(line, "Content-Encoding") == 0 &&
                strcasecmp(colon, "identity") != 0)) {
      return fail(error, capacity, "Unsupported asset HTTP encoding");
    }
    line = end;
  }
  return length_seen || fail(error, capacity, "Asset Content-Length missing");
}

bool assets_fetch(const char *host, unsigned port, const char *token,
                  const char *sha256, uint32_t bytes, uint32_t expected_crc,
                  bool *cached, char *error, size_t error_capacity) {
  if (cached)
    *cached = false;
  if (error && error_capacity)
    error[0] = 0;
  struct sockaddr_in address = {.sin_family = AF_INET};
  char path[ATLAS_ASSET_PATH_BYTES], temporary[ATLAS_ASSET_PATH_BYTES + 4];
  if (!assets_path(sha256, path, sizeof path) || !hex64(token) ||
      !ipv4(host, &address.sin_addr) || !port || port > 65535 || !bytes ||
      bytes > ATLAS_ASSET_MAX_BYTES)
    return fail(error, error_capacity, "Invalid asset request");
  address.sin_port = htons(port);
  snprintf(temporary, sizeof temporary, "%s.tmp", path);
  uint8_t *buffer = malloc(ASSET_BUFFER_BYTES);
  if (!buffer)
    return fail(error, error_capacity, "No memory for asset transfer");
  int verified =
      verify_cached(path, bytes, expected_crc, buffer, error, error_capacity);
  if (verified != 0) {
    free(buffer);
    if (cached)
      *cached = verified > 0;
    return verified > 0;
  }
  int fd = -1;
  FILE *file = NULL;
  bool ok = false;
  uint64_t start = milliseconds(), last = start;
  char header[ASSET_HEADER_BYTES + 1];
  size_t header_bytes = 0;
  uint32_t total = 0, crc = 0;
  bool headers_done = false;
  if (mkdir(ATLAS_ASSET_DIRECTORY, 0777) != 0 && errno != EEXIST) {
    fail(error, error_capacity, "Cannot create asset cache directory");
    goto done;
  }
  fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) {
    fail(error, error_capacity, "Cannot create asset socket");
    goto done;
  }
#ifdef SO_NOSIGPIPE
  int no_sigpipe = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof no_sigpipe);
#endif
  if (connect(fd, (struct sockaddr *)&address, sizeof address) < 0) {
    if (errno != EINPROGRESS && errno != EWOULDBLOCK) {
      fail(error, error_capacity, "Asset server connection failed (%d)", errno);
      goto done;
    }
    for (;;) {
      if (!keep_waiting(start, last, error, error_capacity))
        goto done;
      // SOC can leave SO_ERROR at its internal EINPROGRESS value even after
      // writability. Use the same repeat-connect contract as PocketJS svcwire:
      // EALREADY while connecting, zero/EISCONN once established.
      int connected = connect(fd, (struct sockaddr *)&address, sizeof address);
      if (connected == 0 || errno == EISCONN)
        break;
      if (errno != EALREADY && errno != EINPROGRESS && !retryable()) {
        fail(error, error_capacity, "Asset server connection failed (%d)",
             errno);
        goto done;
      }
      yield_network();
    }
  }
  char request[256];
  size_t request_bytes = snprintf(
      request, sizeof request,
      "GET /%s/%s.place HTTP/1.1\r\nHost: %s:%u\r\nConnection: close\r\n\r\n",
      token, sha256, host, port);
  for (size_t sent = 0; sent < request_bytes;) {
    if (!keep_waiting(start, last, error, error_capacity))
      goto done;
    ssize_t n = send(fd, request + sent, request_bytes - sent, 0);
    if (n > 0) {
      sent += n;
      last = milliseconds();
    } else if (n < 0 && retryable()) {
      yield_network();
    } else {
      fail(error, error_capacity, "Asset request send failed");
      goto done;
    }
  }
  file = fopen(temporary, "wb");
  if (!file) {
    fail(error, error_capacity, "Cannot write asset cache");
    goto done;
  }
  while (!headers_done || total < bytes) {
    if (!keep_waiting(start, last, error, error_capacity))
      goto done;
    ssize_t n = recv(fd, buffer, ASSET_BUFFER_BYTES, 0);
    if (n < 0 && retryable()) {
      yield_network();
      continue;
    }
    if (n <= 0) {
      fail(error, error_capacity, "Asset response ended early (%lu/%lu bytes)",
           (unsigned long)total, (unsigned long)bytes);
      goto done;
    }
    last = milliseconds();
    size_t body = 0;
    if (!headers_done) {
      while (body < (size_t)n && !headers_done) {
        if (header_bytes == ASSET_HEADER_BYTES || buffer[body] == 0) {
          fail(error, error_capacity, "Invalid or oversized asset HTTP header");
          goto done;
        }
        header[header_bytes++] = buffer[body++];
        if (header_bytes >= 4 &&
            memcmp(header + header_bytes - 4, "\r\n\r\n", 4) == 0) {
          header[header_bytes] = 0;
          if (!check_headers(header, bytes, error, error_capacity))
            goto done;
          headers_done = true;
        }
      }
    }
    size_t count = n - body;
    if (count > bytes - total) {
      fail(error, error_capacity, "Asset response exceeds declared size");
      goto done;
    }
    if (count && fwrite(buffer + body, 1, count, file) != count) {
      fail(error, error_capacity, "Asset cache write failed");
      goto done;
    }
    crc = pocket_runtime_crc32(crc, buffer + body, count);
    total += count;
  }
  if (crc != expected_crc) {
    fail(error, error_capacity, "Asset CRC-32 mismatch");
    goto done;
  }
  if (fclose(file) != 0) {
    file = NULL;
    fail(error, error_capacity, "Asset cache flush failed");
    goto done;
  }
  file = NULL;
  // The existing file failed size/CRC verification; FAT rename does not
  // replace it. Keep the verified temporary file until the old entry is gone.
  if (remove(path) != 0 && errno != ENOENT) {
    fail(error, error_capacity, "Cannot replace damaged asset cache");
    goto done;
  }
  if (rename(temporary, path) != 0) {
    fail(error, error_capacity, "Cannot finalize asset cache");
    goto done;
  }
  ok = true;
done:
  if (fd >= 0)
    close(fd);
  if (file)
    fclose(file);
  if (!ok)
    remove(temporary);
  free(buffer);
  return ok;
}
