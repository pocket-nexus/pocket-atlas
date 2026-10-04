#include "globe.h"
#define GL_SILENCE_DEPRECATION 1
#include <OpenGL/gl3.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { SURFACE = 512, RINGS = 24, SEGMENTS = 48, MAX_PINS = 48 };
static const float RADIANS = (float)M_PI / 180;
static GLuint surface, mesh, indices, program, halo, dots;
static GLint u_turn, u_place, u_halo_place, u_dot_place;
static struct {
  float at[3], color[3];
} pins[MAX_PINS];
static unsigned pin_count;
static int lit = -1;
static float place[3] = {130, 160, 100}, facing[2] = {31, 131}, goal[2] = {31, 131}, settle;
static bool following = true;

static const char *const sphere_vertex =
  "attribute vec3 aPos; attribute vec2 aUV; uniform mat3 uTurn; uniform vec4 uPlace; varying vec2 vUV; varying vec3 vN;\n"
  "void main() { vN = uTurn * aPos; vUV = aUV;\n"
  // Landscape NDC, then the quarter turn to the portrait drawable.
  "  vec2 p = uPlace.xy + vN.xy * uPlace.zw; gl_Position = vec4(p.y, -p.x, -vN.z * 0.5, 1.0); }\n";
static const char *const sphere_fragment =
  "precision mediump float; uniform sampler2D uTex; varying vec2 vUV; varying vec3 vN;\n"
  "void main() { vec4 t = texture2D(uTex, vUV); vec3 n = normalize(vN);\n"
  // The sun stands behind the left shoulder: a lit limb, night across the face.
  "  float day = smoothstep(-0.05, 0.4, dot(n, vec3(-0.82, 0.30, -0.49)));\n"
  "  float rim = pow(1.0 - n.z, 3.0);\n"
  "  vec3 c = t.rgb * (vec3(0.07, 0.10, 0.16) + day * 1.15) + vec3(1.0, 0.72, 0.42) * t.a * (1.0 - day)\n"
  "    + vec3(0.20, 0.42, 0.85) * rim * (0.35 + 0.65 * day);\n"
  "  gl_FragColor = vec4(c, 1.0); }\n";
static const char *const halo_vertex =
  "attribute vec3 aPos; uniform vec4 uPlace; varying vec2 vAt;\n"
  "void main() { vAt = aPos.xy * 1.3; vec2 p = uPlace.xy + vAt * uPlace.zw; gl_Position = vec4(p.y, -p.x, 0.9, 1.0); }\n";
static const char *const halo_fragment =
  "precision mediump float; varying vec2 vAt;\n"
  "void main() { float d = length(vAt); float a = exp(-(d - 1.0) * 14.0) * step(1.0, d) * (0.55 - 0.35 * vAt.x);\n"
  "  gl_FragColor = vec4(vec3(0.22, 0.46, 1.0) * a, 1.0); }\n";
static const char *const dot_vertex =
  "attribute vec3 aPos; attribute vec4 aColor; uniform vec4 uPlace; varying vec4 vColor;\n"
  "void main() { vColor = aColor; vec2 p = uPlace.xy + aPos.xy * uPlace.zw; gl_Position = vec4(p.y, -p.x, -0.9, 1.0); gl_PointSize = aPos.z; }\n";
static const char *const dot_fragment =
  "precision mediump float; varying vec4 vColor;\n"
  "void main() { float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard;\n"
  // A lit pin is a ring around its colour; the others are plain dots.
  "  vec3 c = mix(vColor.rgb, vec3(1.0), vColor.a * step(0.62, d)); gl_FragColor = vec4(c * (1.0 - 0.5 * step(0.8, d) * (1.0 - vColor.a)), 1.0); }\n";

static GLuint link(const char *vertex, const char *fragment) {
  GLuint p = glCreateProgram();
  const char *sources[2] = {vertex, fragment};
  for (unsigned i = 0; i < 2; i++) {
    GLuint s = glCreateShader(i ? GL_FRAGMENT_SHADER : GL_VERTEX_SHADER);
    glShaderSource(s, 1, &sources[i], NULL);
    glCompileShader(s);
    glAttachShader(p, s);
    glDeleteShader(s);
  }
  glBindAttribLocation(p, 0, "aPos");
  glBindAttribLocation(p, 1, "aUV");
  glBindAttribLocation(p, 2, "aColor");
  glLinkProgram(p);
  return p;
}
static void point(float lat, float lon, float out[3]) {
  out[0] = cosf(lat * RADIANS) * sinf(lon * RADIANS);
  out[1] = sinf(lat * RADIANS);
  out[2] = cosf(lat * RADIANS) * cosf(lon * RADIANS);
}

bool globe_load(const char *path) {
  static uint8_t texels[SURFACE * SURFACE / 2 * 4];
  FILE *file = fopen(path, "rb");
  bool read = file && fread(texels, 1, sizeof texels, file) == sizeof texels;
  if (file)
    fclose(file);
  if (!read)
    return false;
  glGenTextures(1, &surface);
  glBindTexture(GL_TEXTURE_2D, surface);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, SURFACE, SURFACE / 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, texels);
  glGenerateMipmap(GL_TEXTURE_2D);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

  // Rings of latitude from the north pole, then a square for the halo.
  static float vertices[(RINGS + 1) * (SEGMENTS + 1) + 4][5];
  static uint16_t triangles[RINGS * SEGMENTS * 6];
  unsigned v = 0, t = 0;
  for (unsigned j = 0; j <= RINGS; j++)
    for (unsigned i = 0; i <= SEGMENTS; i++, v++) {
      point(90 - 180.0f * j / RINGS, 360.0f * i / SEGMENTS - 180, vertices[v]);
      vertices[v][3] = (float)i / SEGMENTS;
      vertices[v][4] = (float)j / RINGS;
    }
  for (unsigned j = 0; j < RINGS; j++)
    for (unsigned i = 0; i < SEGMENTS; i++) {
      uint16_t a = j * (SEGMENTS + 1) + i, b = a + SEGMENTS + 1;
      const uint16_t six[6] = {a, b, a + 1, a + 1, b, b + 1};
      memcpy(triangles + t, six, sizeof six);
      t += 6;
    }
  for (unsigned k = 0; k < 4; k++, v++)
    vertices[v][0] = k & 1 ? 1 : -1, vertices[v][1] = k & 2 ? 1 : -1;
  glGenBuffers(1, &mesh);
  glBindBuffer(GL_ARRAY_BUFFER, mesh);
  glBufferData(GL_ARRAY_BUFFER, sizeof vertices, vertices, GL_STATIC_DRAW);
  glGenBuffers(1, &indices);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, indices);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof triangles, triangles, GL_STATIC_DRAW);
  program = link(sphere_vertex, sphere_fragment);
  halo = link(halo_vertex, halo_fragment);
  dots = link(dot_vertex, dot_fragment);
  u_turn = glGetUniformLocation(program, "uTurn");
  u_place = glGetUniformLocation(program, "uPlace");
  u_halo_place = glGetUniformLocation(halo, "uPlace");
  u_dot_place = glGetUniformLocation(dots, "uPlace");
  return true;
}
void globe_place(float x, float y, float radius) { place[0] = x, place[1] = y, place[2] = radius; }
void globe_turn(float lat, float lon, int pin) {
  goal[0] = lat, goal[1] = lon;
  lit = pin;
  following = true;
}
void globe_pins(const char *list) {
  pin_count = 0;
  float lat, lon;
  unsigned rgb;
  int used;
  for (const char *p = list; pin_count < MAX_PINS && sscanf(p, "%f,%f,%x%n", &lat, &lon, &rgb, &used) == 3; p += used + (p[used] == ';')) {
    point(lat, lon, pins[pin_count].at);
    for (unsigned c = 0; c < 3; c++)
      pins[pin_count].color[c] = (rgb >> (16 - 8 * c) & 255) / 255.0f;
    pin_count++;
  }
}
void globe_spin(float dx, float dy) {
  following = false;
  facing[1] -= dx / place[2] / RADIANS;
  facing[0] = fmaxf(-80, fminf(80, facing[0] + dy / place[2] / RADIANS));
  settle = 0.4f;
}
bool globe_update(float dt, float *lat, float *lon) {
  if (following) {
    float ease = 1 - expf(-dt * 5), turn = remainderf(goal[1] - facing[1], 360);
    facing[0] += (goal[0] - facing[0]) * ease;
    facing[1] += turn * ease;
  } else if (settle > 0 && (settle -= dt) <= 0) {
    *lat = facing[0];
    *lon = facing[1] = remainderf(facing[1], 360);
    return true;
  }
  return false;
}
void globe_render(int width, int height) {
  glViewport(0, 0, width, height);
  glClearColor(0.012f, 0.018f, 0.035f, 1);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
  if (!surface)
    return;
  // Facing (lat, lon) comes to +Z: about Y by -lon, then about X by lat.
  float a = facing[0] * RADIANS, b = -facing[1] * RADIANS, ca = cosf(a), sa = sinf(a), cb = cosf(b), sb = sinf(b);
  const float turn[9] = {cb, sa * sb, -ca * sb, 0, ca, sa, sb, -sa * cb, ca * cb}; // columns
  // Centre and radius in landscape NDC (480 by 320 logical pixels).
  const float where[4] = {place[0] / 240 - 1, 1 - place[1] / 160, place[2] / 240, place[2] / 160};
  glDisable(GL_CULL_FACE);
  glDisable(GL_BLEND);
  glDisable(GL_SCISSOR_TEST);
  glEnable(GL_DEPTH_TEST);
  glDepthFunc(GL_LEQUAL);
  glDepthMask(GL_TRUE);
  glBindBuffer(GL_ARRAY_BUFFER, mesh);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, indices);
  glEnableVertexAttribArray(0);
  glEnableVertexAttribArray(1);
  glDisableVertexAttribArray(2);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 20, (void *)0);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 20, (void *)12);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, surface);
  glUseProgram(program);
  glUniformMatrix3fv(u_turn, 1, GL_FALSE, turn);
  glUniform4fv(u_place, 1, where);
  glDrawElements(GL_TRIANGLES, RINGS * SEGMENTS * 6, GL_UNSIGNED_SHORT, 0);
  glEnable(GL_BLEND);
  glBlendFunc(GL_ONE, GL_ONE);
  glUseProgram(halo);
  glUniform4fv(u_halo_place, 1, where);
  glDrawArrays(GL_TRIANGLE_STRIP, (RINGS + 1) * (SEGMENTS + 1), 4);
  glDisable(GL_BLEND);

  // Pins on the near side; the lit one last and larger.
  static float dot[MAX_PINS][7];
  unsigned n = 0;
  float scale = (float)height / 480;
  for (unsigned pass = 0; pass < 2; pass++)
    for (unsigned i = 0; i < pin_count; i++) {
      if (((int)i == lit) != pass)
        continue;
      const float *p = pins[i].at, z = turn[2] * p[0] + turn[5] * p[1] + turn[8] * p[2];
      if (z < 0.08f)
        continue;
      dot[n][0] = turn[0] * p[0] + turn[3] * p[1] + turn[6] * p[2];
      dot[n][1] = turn[1] * p[0] + turn[4] * p[1] + turn[7] * p[2];
      dot[n][2] = (pass ? 11 : 5) * scale;
      memcpy(dot[n] + 3, pins[i].color, 12);
      dot[n++][6] = pass;
    }
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  glDisable(GL_DEPTH_TEST);
  glDisableVertexAttribArray(1);
  glEnableVertexAttribArray(2);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 28, dot[0]);
  glVertexAttribPointer(2, 4, GL_FLOAT, GL_FALSE, 28, dot[0] + 3);
  glUseProgram(dots);
  glUniform4fv(u_dot_place, 1, where);
  glDrawArrays(GL_POINTS, 0, n);
  glDisableVertexAttribArray(2);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
}
