/* Host integration test: the real streaming client, local HTTP sockets, and
 * the same CRC implementation as the paired runtime. No 3DS is contacted.
 * From the repository root:
 * mkdir -p .pocket-build/validation/3ds/asset-cache-test
 * cc -std=gnu11 -Wall -Wextra -Werror -DATLAS_ASSET_IDLE_MS=100 \
 *   '-DATLAS_ASSET_DIRECTORY=".pocket-build/validation/3ds/asset-cache-test"' \
 *   -In3ds/src -Ivendor/pocketjs/hosts/3ds/src n3ds/tests/assets.c \
 *   n3ds/src/assets.c vendor/pocketjs/hosts/3ds/src/dev_protocol.c \
 *   -o .pocket-build/validation/3ds/assets-test
 * .pocket-build/validation/3ds/assets-test
 */
#include "assets.h"
#include "dev_protocol.h"
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *token =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
static const char *sha =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
static unsigned char content[131079];

static void send_all(int fd, const void *data, size_t length) {
  const unsigned char *bytes = data;
  while (length) {
    ssize_t n = send(fd, bytes, length, 0);
    if (n < 0 && (errno == EPIPE || errno == ECONNRESET))
      return; /* rejection tests close without consuming the response */
    assert(n > 0);
    bytes += n;
    length -= n;
  }
}

static unsigned serve(const char *headers, size_t body_bytes, bool pause,
                      pid_t *child) {
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  assert(listener >= 0);
  struct sockaddr_in address = {.sin_family = AF_INET};
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  assert(bind(listener, (struct sockaddr *)&address, sizeof address) == 0);
  assert(listen(listener, 1) == 0);
  socklen_t length = sizeof address;
  assert(getsockname(listener, (struct sockaddr *)&address, &length) == 0);
  *child = fork();
  assert(*child >= 0);
  if (*child == 0) {
    alarm(5);
    int fd = accept(listener, NULL, NULL);
    assert(fd >= 0);
    char request[512] = {0};
    size_t total = 0;
    while (!strstr(request, "\r\n\r\n")) {
      ssize_t n = recv(fd, request + total, sizeof request - total - 1, 0);
      assert(n > 0);
      total += n;
    }
    char expected[160];
    snprintf(expected, sizeof expected, "GET /%s/%s.place HTTP/1.1\r\n", token,
             sha);
    assert(strncmp(request, expected, strlen(expected)) == 0);
    if (pause)
      usleep(250000);
    /* Deliberately split the status line and header terminator over recv calls.
     */
    size_t h = strlen(headers);
    send_all(fd, headers, 5);
    usleep(2000);
    send_all(fd, headers + 5, h - 6);
    usleep(2000);
    send_all(fd, headers + h - 1, 1);
    send_all(fd, content, body_bytes);
    close(fd);
    close(listener);
    _exit(0);
  }
  close(listener);
  return ntohs(address.sin_port);
}

static void reap(pid_t child) {
  int status;
  assert(waitpid(child, &status, 0) == child);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  for (size_t i = 0; i < sizeof content; i++)
    content[i] = (i * 37 + (i >> 9)) & 255;
  uint32_t crc = pocket_runtime_crc32(0, content, sizeof content);
  char path[ATLAS_ASSET_PATH_BYTES], temporary[ATLAS_ASSET_PATH_BYTES + 4];
  assert(assets_path(sha, path, sizeof path));
  snprintf(temporary, sizeof temporary, "%s.tmp", path);
  remove(path);
  remove(temporary);
  assert(!assets_path("../bad", path, sizeof path));
  assert(!assets_path(sha, path, 12));
  assert(assets_path(sha, path, sizeof path));
  char headers[256], error[256];
  snprintf(
      headers, sizeof headers,
      "HTTP/1.1 200 OK\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
      sizeof content);
  bool cached = true;
  assert(!assets_fetch("127.00.0.1", 1, token, sha, sizeof content, crc,
                       &cached, error, sizeof error));
  assert(!cached && strstr(error, "Invalid asset request"));
  assert(!assets_fetch("127.0.0.1", 1, "../bad", sha, sizeof content, crc,
                       &cached, error, sizeof error));
  assert(!assets_fetch("127.0.0.1", 1, token, sha, ATLAS_ASSET_MAX_BYTES + 1,
                       crc, &cached, error, sizeof error));
  pid_t child;
  unsigned port = serve(headers, sizeof content, false, &child);
  assert(assets_fetch("127.0.0.1", port, token, sha, sizeof content, crc,
                      &cached, error, sizeof error));
  assert(!cached && !error[0]);
  reap(child);
  FILE *file = fopen(path, "rb");
  assert(file);
  unsigned char received[sizeof content];
  assert(fread(received, 1, sizeof received, file) == sizeof received);
  assert(fgetc(file) == EOF);
  fclose(file);
  assert(memcmp(received, content, sizeof content) == 0);
  /* The listener is gone: a valid cache must complete without network I/O. */
  assert(assets_fetch("127.0.0.1", port, token, sha, sizeof content, crc,
                      &cached, error, sizeof error));
  assert(cached);
  /* Same-size damage must trigger a new download, not a false cache hit. */
  file = fopen(path, "r+b");
  assert(file);
  fputc(content[0] ^ 255, file);
  fclose(file);
  port = serve(headers, sizeof content, false, &child);
  assert(assets_fetch("127.0.0.1", port, token, sha, sizeof content, crc,
                      &cached, error, sizeof error));
  assert(!cached);
  reap(child);
  remove(path);
  const char *bad_headers[] = {
      "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 999999999999999999\r\n\r\n",
      "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n",
  };
  for (unsigned i = 0; i < sizeof bad_headers / sizeof bad_headers[0]; i++) {
    port = serve(bad_headers[i], 0, false, &child);
    assert(!assets_fetch("127.0.0.1", port, token, sha, sizeof content, crc,
                         &cached, error, sizeof error));
    assert(error[0] && access(path, F_OK) != 0 && access(temporary, F_OK) != 0);
    reap(child);
  }
  port = serve(headers, sizeof content - 1, false, &child);
  assert(!assets_fetch("127.0.0.1", port, token, sha, sizeof content, crc,
                       &cached, error, sizeof error));
  assert(strstr(error, "ended early") && access(temporary, F_OK) != 0);
  reap(child);
  port = serve(headers, sizeof content, false, &child);
  assert(!assets_fetch("127.0.0.1", port, token, sha, sizeof content, crc ^ 1,
                       &cached, error, sizeof error));
  assert(strstr(error, "CRC-32") && access(temporary, F_OK) != 0);
  reap(child);
#if defined(ATLAS_ASSET_IDLE_MS) && ATLAS_ASSET_IDLE_MS < 250
  port = serve(headers, sizeof content, true, &child);
  assert(!assets_fetch("127.0.0.1", port, token, sha, sizeof content, crc,
                       &cached, error, sizeof error));
  assert(strstr(error, "timed out") && access(temporary, F_OK) != 0);
  reap(child);
#endif
  puts("asset delivery: streaming, cache integrity, HTTP rejection, cleanup "
       "passed");
  return 0;
}
