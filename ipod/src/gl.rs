#![allow(dead_code, non_snake_case)]
use core::ffi::{c_char, c_void};
pub type GLenum = u32;
pub type GLuint = u32;
pub type GLint = i32;
pub type GLsizei = i32;
pub type GLboolean = u8;
pub type GLbitfield = u32;
pub type GLfloat = f32;
pub type GLsizeiptr = isize;

pub const GL_FALSE: GLboolean = 0;
pub const GL_TRUE: GLboolean = 1;
pub const GL_FLOAT: GLenum = 0x1406;
pub const GL_UNSIGNED_BYTE: GLenum = 0x1401;
pub const GL_UNSIGNED_SHORT: GLenum = 0x1403;
pub const GL_TRIANGLES: GLenum = 0x0004;
pub const GL_ARRAY_BUFFER: GLenum = 0x8892;
pub const GL_ELEMENT_ARRAY_BUFFER: GLenum = 0x8893;
pub const GL_STATIC_DRAW: GLenum = 0x88e4;
pub const GL_DYNAMIC_DRAW: GLenum = 0x88e8;
pub const GL_VERTEX_SHADER: GLenum = 0x8b31;
pub const GL_FRAGMENT_SHADER: GLenum = 0x8b30;
pub const GL_COMPILE_STATUS: GLenum = 0x8b81;
pub const GL_LINK_STATUS: GLenum = 0x8b82;
pub const GL_TEXTURE_2D: GLenum = 0x0de1;
pub const GL_TEXTURE_CUBE_MAP: GLenum = 0x8513;
pub const GL_TEXTURE_CUBE_MAP_POSITIVE_X: GLenum = 0x8515;
pub const GL_SAMPLER_CUBE: GLenum = 0x8b60;
pub const GL_TEXTURE0: GLenum = 0x84c0;
pub const GL_COMPRESSED_RGB_PVRTC_4BPPV1_IMG: GLenum = 0x8c00;
pub const GL_RGB: GLenum = 0x1907;
pub const GL_LUMINANCE: GLenum = 0x1909;
pub const GL_UNSIGNED_SHORT_5_6_5: GLenum = 0x8363;
pub const GL_RGBA: GLenum = 0x1908;
pub const GL_LINEAR: GLint = 0x2601;
pub const GL_REPEAT: GLint = 0x2901;
pub const GL_CLAMP_TO_EDGE: GLint = 0x812f;
pub const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
pub const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
pub const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
pub const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
pub const GL_UNPACK_ALIGNMENT: GLenum = 0x0cf5;
pub const GL_BLEND: GLenum = 0x0be2;
pub const GL_ONE: GLenum = 1;
pub const GL_SRC_ALPHA: GLenum = 0x0302;
pub const GL_COLOR_BUFFER_BIT: GLbitfield = 0x0000_4000;
pub const GL_DEPTH_BUFFER_BIT: GLbitfield = 0x0000_0100;
pub const GL_SCISSOR_TEST: GLenum = 0x0c11;
pub const GL_DEPTH_TEST: GLenum = 0x0b71;
pub const GL_CULL_FACE: GLenum = 0x0b44;
pub const GL_LEQUAL: GLenum = 0x0203;
pub const GL_MAX_TEXTURE_SIZE: GLenum = 0x0d33;
pub const GL_NO_ERROR: GLenum = 0;

unsafe extern "C" {
    pub fn glActiveTexture(texture: GLenum);
    pub fn glAttachShader(program: GLuint, shader: GLuint);
    pub fn glBindAttribLocation(program: GLuint, index: GLuint, name: *const c_char);
    pub fn glBindBuffer(target: GLenum, buffer: GLuint);
    pub fn glBindTexture(target: GLenum, texture: GLuint);
    pub fn glBlendFunc(source: GLenum, destination: GLenum);
    pub fn glColorMask(red: GLboolean, green: GLboolean, blue: GLboolean, alpha: GLboolean);
    pub fn glBufferData(target: GLenum, size: GLsizeiptr, data: *const c_void, usage: GLenum);
    pub fn glBufferSubData(target: GLenum, offset: isize, size: GLsizeiptr, data: *const c_void);
    pub fn glClear(mask: GLbitfield);
    pub fn glClearColor(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat);
    pub fn glClearDepthf(depth: GLfloat);
    pub fn glCompressedTexImage2D(target: GLenum, level: GLint, internal_format: GLenum, width: GLsizei, height: GLsizei, border: GLint, size: GLsizei, data: *const c_void);
    pub fn glCompileShader(shader: GLuint);
    pub fn glCreateProgram() -> GLuint;
    pub fn glCreateShader(kind: GLenum) -> GLuint;
    pub fn glDeleteBuffers(count: GLsizei, buffers: *const GLuint);
    pub fn glDeleteProgram(program: GLuint);
    pub fn glDeleteShader(shader: GLuint);
    pub fn glDeleteTextures(count: GLsizei, textures: *const GLuint);
    pub fn glDepthFunc(function: GLenum);
    pub fn glDepthMask(flag: GLboolean);
    pub fn glDisable(capability: GLenum);
    pub fn glDisableVertexAttribArray(index: GLuint);
    pub fn glDrawArrays(mode: GLenum, first: GLint, count: GLsizei);
    pub fn glDrawElements(mode: GLenum, count: GLsizei, kind: GLenum, indices: *const c_void);
    pub fn glEnable(capability: GLenum);
    pub fn glEnableVertexAttribArray(index: GLuint);
    pub fn glGenBuffers(count: GLsizei, buffers: *mut GLuint);
    pub fn glGenTextures(count: GLsizei, textures: *mut GLuint);
    pub fn glGetError() -> GLenum;
    pub fn glGetIntegerv(parameter: GLenum, value: *mut GLint);
    pub fn glGetProgramiv(program: GLuint, parameter: GLenum, value: *mut GLint);
    pub fn glGetShaderiv(shader: GLuint, parameter: GLenum, value: *mut GLint);
    pub fn glGetUniformLocation(program: GLuint, name: *const c_char) -> GLint;
    pub fn glLinkProgram(program: GLuint);
    pub fn glPixelStorei(parameter: GLenum, value: GLint);
    pub fn glShaderSource(
        shader: GLuint,
        count: GLsizei,
        source: *const *const c_char,
        length: *const GLint,
    );
    pub fn glTexImage2D(
        target: GLenum,
        level: GLint,
        internal_format: GLint,
        width: GLsizei,
        height: GLsizei,
        border: GLint,
        format: GLenum,
        kind: GLenum,
        pixels: *const c_void,
    );
    pub fn glTexParameteri(target: GLenum, parameter: GLenum, value: GLint);
    pub fn glUniform1i(location: GLint, value: GLint);
    pub fn glUniformMatrix4fv(
        location: GLint,
        count: GLsizei,
        transpose: GLboolean,
        values: *const GLfloat,
    );
    pub fn glUseProgram(program: GLuint);
    pub fn glVertexAttribPointer(
        index: GLuint,
        size: GLint,
        kind: GLenum,
        normalized: GLboolean,
        stride: GLsizei,
        pointer: *const c_void,
    );
    pub fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
}
extern "C" {
    pub fn glBindFramebuffer(t: u32, f: u32);
}

extern "C" {
    pub fn glFinish();
    pub fn glDiscardFramebufferEXT(target: GLenum, count: GLsizei, attachments: *const GLenum);
}
extern "C" {
    pub fn glUniform4fv(location: i32, count: i32, data: *const f32);
    pub fn glUniform1f(location: i32, value: f32);
    pub fn glVertexAttrib4f(index: u32, x: f32, y: f32, z: f32, w: f32);
    pub fn glFrontFace(mode: u32);
    pub fn glPolygonOffset(factor: f32, units: f32);
    pub fn glGenFramebuffers(n: i32, out: *mut u32);
    pub fn glDeleteFramebuffers(n: i32, out: *const u32);
    pub fn glFramebufferTexture2D(
        target: u32,
        attachment: u32,
        kind: u32,
        texture: u32,
        level: i32,
    );
    pub fn glCheckFramebufferStatus(target: u32) -> u32;
    pub fn glGenRenderbuffers(n: i32, out: *mut u32);
    pub fn glBindRenderbuffer(target: u32, id: u32);
    pub fn glRenderbufferStorage(target: u32, format: u32, w: i32, h: i32);
    pub fn glFramebufferRenderbuffer(target: u32, attachment: u32, kind: u32, id: u32);
    pub fn glDeleteRenderbuffers(n: i32, out: *const u32);
    pub fn glGetActiveUniform(
        program: u32,
        index: u32,
        size: i32,
        length: *mut i32,
        count: *mut i32,
        kind: *mut u32,
        name: *mut c_char,
    );
}
extern "C" {
    pub fn glGetAttribLocation(program: u32, name: *const c_char) -> i32;
    pub fn glGetShaderInfoLog(shader: u32, size: i32, len: *mut i32, log: *mut c_char);
    pub fn glGetProgramInfoLog(program: u32, size: i32, len: *mut i32, log: *mut c_char);
}

extern "C" {
    pub fn glGenVertexArraysOES(n: i32, arrays: *mut u32);
    pub fn glBindVertexArrayOES(array: u32);
    pub fn glDeleteVertexArraysOES(n: i32, arrays: *const u32);
}
