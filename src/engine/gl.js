/* Minimal WebGL2 helpers: programs with reflected uniforms, render targets, textures. */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});

  function startShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  function checkShader(gl, sh, src, name) {
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh) || '';
      const lines = src.split('\n');
      const m = /ERROR: \d+:(\d+)/.exec(log);
      let ctx = '';
      if (m) {
        const ln = parseInt(m[1], 10);
        ctx = lines
          .slice(Math.max(0, ln - 3), ln + 2)
          .map((l, i) => `${Math.max(1, ln - 2) + i}: ${l}`)
          .join('\n');
      }
      throw new Error(`Shader "${name}" failed to compile:\n${log}\n${ctx}`);
    }
  }

  /**
   * A shader program. The constructor only *starts* compiling and linking. Any status
   * query blocks the page until the driver is done, and the terrain bake shader can take
   * seconds to compile. So callers poll ready() once per frame (KHR_parallel_shader_compile)
   * and then call finalize(), which reports errors and reflects the uniforms.
   */
  class Program {
    constructor(gl, vs, fs, name, parallelExt) {
      this.gl = gl;
      this.name = name;
      this._ext = parallelExt || null;
      this._src = { vs, fs };
      this.p = gl.createProgram();
      this._vs = startShader(gl, gl.VERTEX_SHADER, vs);
      this._fs = startShader(gl, gl.FRAGMENT_SHADER, fs);
      gl.attachShader(this.p, this._vs);
      gl.attachShader(this.p, this._fs);
      gl.linkProgram(this.p);
      this.uniforms = null;
    }

    /** Non-blocking: true once the driver has finished compiling and linking. */
    ready() {
      if (!this._ext) return true;
      return this.gl.getProgramParameter(this.p, this._ext.COMPLETION_STATUS_KHR) !== false;
    }

    /** Check for errors and reflect the uniforms (only call once ready() is true). */
    finalize() {
      if (this.uniforms) return;
      const gl = this.gl;
      const p = this.p;
      const name = this.name;
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
        checkShader(gl, this._vs, this._src.vs, name + '.vs');
        checkShader(gl, this._fs, this._src.fs, name + '.fs');
        throw new Error(`Program "${name}" failed to link: ${gl.getProgramInfoLog(p)}`);
      }
      gl.deleteShader(this._vs);
      gl.deleteShader(this._fs);
      this._vs = this._fs = null;
      this._src = null;
      this.uniforms = {};
      this.samplers = [];
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const uname = info.name.replace(/\[0\]$/, '');
        const loc = gl.getUniformLocation(p, info.name);
        this.uniforms[uname] = { loc, type: info.type };
        if (info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_3D) this.samplers.push(uname);
      }
    }

    set(name, v) {
      const u = this.uniforms && this.uniforms[name];
      if (!u) return;
      const gl = this.gl;
      switch (u.type) {
        case gl.FLOAT:
          gl.uniform1f(u.loc, v);
          break;
        case gl.FLOAT_VEC2:
          if (v.length > 2) gl.uniform2fv(u.loc, v); // an array of vec2
          else gl.uniform2f(u.loc, v[0], v[1]);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3f(u.loc, v[0], v[1], v[2]);
          break;
        case gl.FLOAT_VEC4:
          if (v.length > 4) gl.uniform4fv(u.loc, v); // an array of vec4
          else gl.uniform4f(u.loc, v[0], v[1], v[2], v[3]);
          break;
        case gl.INT:
        case gl.BOOL:
        case gl.SAMPLER_2D:
        case gl.SAMPLER_3D:
          gl.uniform1i(u.loc, v | 0);
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(u.loc, false, v);
          break;
        default:
          break;
      }
    }

    has(name) {
      return !!(this.uniforms && this.uniforms[name]);
    }
  }

  function texParams(gl, target, filter, wrapS, wrapT, wrapR) {
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter === 'mipmap' ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter === 'mipmap' ? gl.LINEAR : filter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrapT);
    if (wrapR !== undefined) gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrapR);
  }

  const FORMATS = {
    rgba16f: (gl) => [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
    rgba8: (gl) => [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    r8: (gl) => [gl.R8, gl.RED, gl.UNSIGNED_BYTE],
    r16f: (gl) => [gl.R16F, gl.RED, gl.HALF_FLOAT],
    rg16f: (gl) => [gl.RG16F, gl.RG, gl.HALF_FLOAT],
    rg32f: (gl) => [gl.RG32F, gl.RG, gl.FLOAT],
    rgba32f: (gl) => [gl.RGBA32F, gl.RGBA, gl.FLOAT],
  };

  function createTexture2D(gl, w, h, fmt, opts = {}) {
    const [internal, format, type] = FORMATS[fmt](gl);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    texParams(gl, gl.TEXTURE_2D, opts.filter ?? gl.NEAREST, opts.wrapS ?? gl.CLAMP_TO_EDGE, opts.wrapT ?? gl.CLAMP_TO_EDGE);
    t._w = w;
    t._h = h;
    t._fmt = fmt;
    return t;
  }

  function createTexture3D(gl, size, fmt, opts = {}) {
    const [internal, format, type] = FORMATS[fmt](gl);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, internal, size, size, size, 0, format, type, null);
    texParams(gl, gl.TEXTURE_3D, opts.filter ?? gl.LINEAR, gl.REPEAT, gl.REPEAT, gl.REPEAT);
    t._size = size;
    return t;
  }

  /** attachments: array of { fmt, filter, wrapS, wrapT } */
  function createTarget(gl, w, h, attachments) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const tex = [];
    const bufs = [];
    attachments.forEach((a, i) => {
      const t = createTexture2D(gl, w, h, a.fmt, a);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      tex.push(t);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    gl.drawBuffers(bufs);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error('Framebuffer incomplete: 0x' + status.toString(16) + ' (' + attachments.map((a) => a.fmt).join(',') + ')');
    }
    return { fbo, tex, bufs, w, h };
  }

  function deleteTarget(gl, t) {
    if (!t) return;
    t.tex.forEach((x) => gl.deleteTexture(x));
    gl.deleteFramebuffer(t.fbo);
  }

  LE.GL = { Program, createTexture2D, createTexture3D, createTarget, deleteTarget };
})();
