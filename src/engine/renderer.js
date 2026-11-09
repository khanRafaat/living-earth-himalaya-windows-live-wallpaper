/*
 * Renderer — owns the WebGL2 context and schedules every pass.
 *
 *  bake      once, in strips (keeps each GPU submission short, avoids Windows TDR)
 *  shadow    progressive refresh when the sun/moon moves; double-buffered + cross-fade
 *  LUTs      transmittance + sky radiance, about once per second
 *  volume    reduced-resolution clouds/mist, temporally accumulated
 *  composite every frame, full resolution
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const { Program, createTexture3D, createTexture2D, createTarget, deleteTarget } = LE.GL;
  const S = LE.shaders;
  const D2R = Math.PI / 180;

  const TRANS_W = 64;
  const TRANS_H = 32;
  const SKY_W = 256;
  const SKY_H = 128;
  const METER_W = 64;
  const METER_H = 18;
  const BAND = 16; // rows per tile band for chunked bake / shadow work
  const FENCE_NOTICED_MS = 8; // a finished frame is only noticed at the next screen refresh, half of one late on average
  const FENCE_GIVE_UP_MS = 5000; // a driver that never signals must not freeze the wallpaper for good
  const HEAD_CAP = 25; // the most a vehicle's headlights may count for, in the scene's light units (sprites.js)
  // the tree on the rock at the left: direction as a share of half the view, distance and ground height (m)
  const HILL_TIP_M = 2.6; // how far past the tree the rock reaches (ledge.js)
  const GRASS_WRAP_M = 50; // a whole number of noise tiles at the grass's wind scales (composite.js)
  const TREE = { u: -0.672, r: 28, y: -3.6, patch: 1.4 }; // near the tip of the rock, below the eye and well off, so the view stays open

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  /**
   * Paces heavy one-off GPU work (terrain bake, shadow passes). It keeps only one chunk in
   * flight, sized to take about one frame of GPU time. That way the GPU, which this
   * wallpaper shares with the Windows desktop, is never flooded and never trips the
   * driver watchdog. A fence tells us when a chunk is done. gl.finish() can't be used:
   * Chrome, Edge and Lively's WebView2 implement it as a flush that returns at once.
   *
   * Chunk cost is measured with a GPU timer query when the browser offers one (exact). The
   * fallback is the time from submit until the fence was seen, an upper bound that includes
   * waiting for the next frame.
   */
  class GpuPacer {
    constructor(gl, o, timerExt) {
      this.gl = gl;
      this.px = o.px;
      this.minPx = o.minPx;
      this.maxPx = o.maxPx;
      this.targetMs = o.targetMs || 16;
      this.grow = o.grow !== false; // only used without a GPU timer
      this.ext = timerExt || null;
      this.query = null;
      this.fence = null;
      this.lastPx = 0;
      this.t0 = 0;
      this.polls = 0;
      this.maxMsPerPx = 0; // worst reliable cost per pixel seen (sizes later background work)
    }

    /** Call right before the chunk's draw call. */
    begin() {
      if (!this.ext || this.query) return;
      this.query = this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    }

    /** Call right after the chunk's draw call. */
    submitted(px) {
      const gl = this.gl;
      if (this.query) gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.lastPx = px;
      this.polls = 0;
      this.t0 = performance.now();
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    }

    /** Non-blocking. False while the previous chunk is still running on the GPU. */
    ready() {
      if (!this.fence) return true;
      const gl = this.gl;
      if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
        this.polls++;
        return false;
      }
      gl.deleteSync(this.fence);
      this.fence = null;
      const wallMs = performance.now() - this.t0;
      let gpuMs = -1;
      if (this.query) {
        const q = this.query;
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
          gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        }
        gl.deleteQuery(q);
        this.query = null;
      }
      const n = Math.max(1, this.lastPx);
      const up = Math.min(this.maxPx, Math.max(this.px, this.lastPx) * 1.5);
      if (gpuMs >= 0) {
        // exact: size the next chunk to the target
        this.maxMsPerPx = Math.max(this.maxMsPerPx, gpuMs / n);
        this.px = clamp((this.lastPx * this.targetMs) / Math.max(gpuMs, 0.05), this.minPx, up);
        return true;
      }
      // Fallback. Judge by elapsed time, not by the poll count: while our chunk keeps the GPU
      // busy the browser also delays the next frame callback, so a long chunk can look
      // "done at the first poll".
      if (wallMs > 25) this.maxMsPerPx = Math.max(this.maxMsPerPx, wallMs / n);
      if (!this.grow) {
        if (this.polls >= 2) this.px = Math.max(this.minPx, Math.min(this.px, this.lastPx * 0.5));
      } else if (wallMs <= 25) {
        this.px = up; // seen by an on-time next frame: there is headroom
      } else {
        this.px = clamp((this.lastPx * this.targetMs) / wallMs, this.minPx, up);
      }
      return true;
    }

    dispose() {
      const gl = this.gl;
      if (this.query) gl.deleteQuery(this.query);
      if (this.fence) gl.deleteSync(this.fence);
      this.query = null;
      this.fence = null;
    }
  }

  class Renderer {
    constructor(canvas, cfg) {
      this.canvas = canvas;
      this.cfg = cfg;
      this.gl = null;
      this.status = 'init'; // init | compiling | baking | shadow | running | lost | error
      this.progress = 0;
      this.frame = 0;
      this.quality = LE.QUALITY_LEVELS[1];
      this.onStatus = null;
      this.onError = null;
      this._compiled = false;
      this._lutAt = -1e9;
      this._shadow = null; // progressive shadow job
      this._shadowMix = 0;
      this._fading = false;
      this._fade = 0;
      this._timer = null;
      this._frameQuery = null;
      this._frameQueryAt = -1e9;
      this.gpuFrameMs = 0; // latest measured GPU time of a frame (0 = not known)
      this._frameFence = null; // the frame last sent to the GPU, until it has finished there
      this._frameFenceAt = 0;
      this.gpuBusyMs = 0; // how long a frame takes on the GPU, smoothed (0 = not known yet)
      this.pictureBands = 8; // slow mode: how many parts a new picture is drawn in
      this.pictureAt = 0; // slow mode: when the picture now fading in was ready
      this._pictureJob = null; // slow mode: the picture being drawn
      this._grassAt = null; // the wind in the grass: when it last moved on, and uGrassWind
      this._grassWind = [0, 0, 0, 0];
    }

    /**
     * The browser's own window and all its tabs draw through the same GPU queue as this page, as does the
     * rest of the desktop. Frames queuing up behind each other are what makes a whole browser seem hung, on a
     * GPU that can't finish a frame in time. So only one frame is ever in flight: the main loop asks
     * frameDone() and sends nothing new until the last frame has finished.
     */
    _fenceFrame() {
      const gl = this.gl;
      if (this._frameFence !== null) gl.deleteSync(this._frameFence);
      else this._frameFenceAt = performance.now();
      this._frameFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    }

    /** Non-blocking. False while the last frame is still on the GPU. */
    frameDone() {
      const f = this._frameFence;
      if (f === null) return true;
      const gl = this.gl;
      const waited = performance.now() - this._frameFenceAt;
      if (!gl.isContextLost() && gl.getSyncParameter(f, gl.SYNC_STATUS) !== gl.SIGNALED && waited < FENCE_GIVE_UP_MS) return false;
      gl.deleteSync(f);
      this._frameFence = null;
      const ms = Math.max(waited - FENCE_NOTICED_MS, 0);
      this.gpuBusyMs = this.gpuBusyMs ? this.gpuBusyMs + (ms - this.gpuBusyMs) * 0.2 : ms;
      return true;
    }

    // ---------------------------------------------------------------- setup
    init() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance', // a dedicated GPU where the PC has one
      });
      if (!gl) throw new Error('WebGL 2 is not available on this system.');
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
        throw new Error('This GPU cannot render to floating-point textures (EXT_color_buffer_float).');
      }
      this.gl = gl;
      this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
      this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      // compile in the background instead of freezing the page (polled in render())
      this.parallelExt = gl.getExtension('KHR_parallel_shader_compile');
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      const V = S.vertex;
      const X = this.parallelExt;
      this.prog = {
        bake: new Program(gl, V, S.bake(), 'bake', X),
        shadow: new Program(gl, V, S.shadow(), 'shadow', X),
        trans: new Program(gl, V, S.transLUT(), 'transLUT', X),
        sky: new Program(gl, V, S.skyLUT(), 'skyLUT', X),
        volume: new Program(gl, V, S.volume(), 'volume', X),
        composite: new Program(gl, V, S.composite(), 'composite', X),
        sprites: new Program(gl, S.spriteVertex, S.spriteFragment(), 'sprites', X),
        fade: new Program(gl, V, S.fade(), 'fade', X),
        fadeRain: new Program(gl, V, S.fadeRain(), 'fadeRain', X),
        roadHeights: new Program(gl, V, S.roadHeights(), 'roadHeights', X),
        noise3D: new Program(gl, V, S.noise3D(), 'noise3D', X),
        noise2D: new Program(gl, V, S.noise2D(), 'noise2D', X),
        adapt: new Program(gl, V, S.adapt(), 'adapt', X),
        // the tree on the rock, and falling leaves (foreground.js)
        treeLight: new Program(gl, V, S.treeLight(), 'treeLight', X),
        treeBark: new Program(gl, S.treeBarkVertex(), S.treeFragment(), 'treeBark', X),
        treeLeaf: new Program(gl, S.treeLeafVertex(), S.treeFragment(), 'treeLeaf', X),
        treeDrift: new Program(gl, S.treeDriftVertex(), S.treeDriftFragment(), 'treeDrift', X),
        treeComp: new Program(gl, S.treeCompVertex, S.treeComp(), 'treeComp', X),
      };
      // Chunks well under a screen refresh, so the desktop and the browser's own window get a turn on the GPU
      // in every refresh while the scene is prepared
      const T = this.timerExt;
      this._bakePacer = new GpuPacer(gl, { px: 4096, minPx: 1024, maxPx: 262144, targetMs: 12 }, T);
      this._shadowPacer = new GpuPacer(gl, { px: 16384, minPx: 2048, maxPx: 524288, targetMs: 12 }, T);
      // background shadow refreshes while running: ~4 ms of GPU per frame
      this._bgPacer = new GpuPacer(gl, { px: 8192, minPx: 1024, maxPx: 131072, targetMs: 4, grow: false }, T);
      this._bgStartPx = 8192;
      this.meter = createTarget(gl, METER_W, METER_H, [{ fmt: 'rgba16f', filter: gl.LINEAR }]);
      gl.bindTexture(gl.TEXTURE_2D, this.meter.tex[0]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.adaptA = createTarget(gl, 1, 1, [{ fmt: 'rgba16f', filter: gl.NEAREST }]);
      this.adaptB = createTarget(gl, 1, 1, [{ fmt: 'rgba16f', filter: gl.NEAREST }]);
      this.adaptValue = 1;
      // instanced sprites (birds, smoke, meteors, satellites)
      this.spriteVAO = gl.createVertexArray();
      this.spriteBuf = gl.createBuffer();
      gl.bindVertexArray(this.spriteVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
      gl.bufferData(gl.ARRAY_BUFFER, LE.Life.MAX * LE.Life.FLOATS * 4, gl.DYNAMIC_DRAW);
      for (let i = 0; i < LE.Life.FLOATS / 4; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, 4, gl.FLOAT, false, LE.Life.FLOATS * 4, i * 16);
        gl.vertexAttribDivisor(i, 1);
      }
      gl.bindVertexArray(this.vao);
      this.life = null;
      this.fg = new LE.Foreground(this);

      this.transLUT = createTarget(gl, TRANS_W, TRANS_H, [{ fmt: 'rgba16f', filter: gl.LINEAR }]);
      this.skyLUT = createTarget(gl, SKY_W, SKY_H, [
        { fmt: 'rgba16f', filter: gl.LINEAR, wrapS: gl.REPEAT, wrapT: gl.CLAMP_TO_EDGE },
      ]);
      this._setStatus('compiling');
    }

    /** True once every program has compiled, been checked, and the noise textures exist. */
    _pollCompile() {
      if (this._compiled) return true;
      for (const k in this.prog) if (!this.prog[k].ready()) return false;
      for (const k in this.prog) this.prog[k].finalize(); // throws with the compile log on error
      this._makeNoise();
      this._compiled = true;
      return true;
    }

    _makeNoise() {
      const gl = this.gl;
      // 3D: 64³ Perlin-Worley / Worley / mist channels
      const N3 = 64;
      this.noise3D = createTexture3D(gl, N3, 'rgba8', { filter: gl.LINEAR });
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, N3, N3);
      gl.useProgram(this.prog.noise3D.p);
      this.prog.noise3D.set('uSize', N3);
      for (let z = 0; z < N3; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.noise3D, 0, z);
        this.prog.noise3D.set('uSlice', z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      // 2D: 256² tileable fbm / worley
      const N2 = 256;
      this.noise2D = createTexture2D(gl, N2, N2, 'rgba8', { filter: gl.LINEAR, wrapS: gl.REPEAT, wrapT: gl.REPEAT });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.noise2D, 0);
      gl.viewport(0, 0, N2, N2);
      gl.useProgram(this.prog.noise2D.p);
      this.prog.noise2D.set('uSize', N2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.noise2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    /** Allocate size-dependent targets and start a fresh bake. */
    resize(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      this.canvas.width = w;
      this.canvas.height = h;
      deleteTarget(gl, this.gbuf);
      deleteTarget(gl, this.shadowA);
      deleteTarget(gl, this.shadowB);
      deleteTarget(gl, this.pictureA);
      deleteTarget(gl, this.pictureB);
      deleteTarget(gl, this.pictureNext);
      this.pictureA = this.pictureB = this.pictureNext = null;
      this._pictureReady = false;
      this._pictureJob = null;
      this.gbuf = createTarget(gl, w, h, [
        { fmt: 'rgba16f', filter: gl.NEAREST },
        { fmt: 'rgba8', filter: gl.NEAREST },
        { fmt: 'rgba16f', filter: gl.NEAREST },
        { fmt: 'rgba8', filter: gl.NEAREST },
      ]);
      this.shadowA = createTarget(gl, w, h, [{ fmt: 'r8', filter: gl.NEAREST }]);
      this.shadowB = createTarget(gl, w, h, [{ fmt: 'r8', filter: gl.NEAREST }]);
      this._allocVolume();
      this.fg.resize(w, h);
      if (this._compiled) this._startBake(); // otherwise the bake starts when compiling finishes
    }

    _allocVolume() {
      const gl = this.gl;
      deleteTarget(gl, this.volA);
      deleteTarget(gl, this.volB);
      const s = this.quality.volScale;
      this.vw = Math.max(16, Math.round(this.w * s));
      this.vh = Math.max(16, Math.round(this.h * s));
      this.volA = createTarget(gl, this.vw, this.vh, [{ fmt: 'rgba16f', filter: gl.NEAREST }]);
      this.volB = createTarget(gl, this.vw, this.vh, [{ fmt: 'rgba16f', filter: gl.NEAREST }]);
      this._volWarm = 0;
    }

    setQuality(q) {
      const prevScale = this.quality.volScale;
      this.quality = q;
      if (this.gl && this.w && q.volScale !== prevScale) {
        this._allocVolume();
        this._holdExposure = true; // the new volume buffers warm up, but the picture's brightness must not jump
      }
    }

    /** Scene parameters that require a re-bake (seed, camera). Changing the view
     *  direction does not: the landscape stays, only the real sky turns around it. */
    sceneKey() {
      const r = this.cfg.render;
      return [r.seed, r.cameraAltitude, r.horizonY, r.maxHFovDeg, this.cfg.road !== false].join('|');
    }

    rebake() {
      if (this.gl && this.w && this._compiled) this._startBake();
    }

    // ---- chunked full-screen work: tiles of BAND rows, or whole rows when the budget allows
    _newJob() {
      return { x: 0, y: 0, done: 0 };
    }

    _nextRect(job, px) {
      const w = this.w;
      const h = this.h;
      px = Math.max(1, Math.round(px));
      if (job.x === 0 && px >= w * BAND) return [0, job.y, w, Math.min(h - job.y, Math.floor(px / w))];
      const rows = Math.min(BAND, h - job.y);
      return [job.x, job.y, Math.min(w - job.x, Math.max(64, Math.round(px / rows))), rows];
    }

    _advance(job, r) {
      job.done += r[2] * r[3];
      job.x += r[2];
      if (job.x >= this.w) {
        job.x = 0;
        job.y += r[3];
      }
    }

    _setStatus(s) {
      this.status = s;
      if (this.onStatus) this.onStatus(s, this.progress);
    }

    _startBake() {
      this._pictureReady = false;
      this._pictureJob = null;
      this._bakeJob = this._newJob();
      this._shadow = null;
      this._shadowMix = 0;
      this._fading = false;
      this._sceneKey = this.sceneKey();
      this._layRoad();
      this._findPeaks();
      this.progress = 0;
      this._setStatus('baking');
    }

    /** The ground height at a list of points. pts = [x, z, ...] in km, packed in a texture of w by h. */
    _groundHeights(pts, w, h) {
      const gl = this.gl;
      const p = this.prog.roadHeights;
      const src = LE.GL.createTexture2D(gl, w, h, 'rg32f');
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RG, gl.FLOAT, pts);
      const target = createTarget(gl, w, h, [{ fmt: 'rgba32f', filter: gl.NEAREST }]);
      this._target(target, w, h);
      gl.useProgram(p.p);
      this._camera(p, this.w, this.h);
      this._bind(p, { uPts: src });
      this._draw();
      const out = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      deleteTarget(gl, target);
      gl.deleteTexture(src);
      const heights = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) heights[i] = out[i * 4];
      return heights;
    }

    /** Lays the road for this landscape and gives the bake its map. A failure only costs the road. */
    _layRoad() {
      const gl = this.gl;
      if (this.roadMap) gl.deleteTexture(this.roadMap);
      this.roadMap = null;
      this.road = null;
      if (this.cfg.road !== false && this.floatTargets) {
        try {
          const R = LE.Road;
          const v = this.viewInfo();
          const heights = this._groundHeights(R.gridPoints(), R.GRID.na, R.GRID.nr);
          const line = R.plan(heights, v.camY, -v.horizonY * v.h * v.pxAng);
          const n = line.length / 2;
          const w = 1024;
          const h = Math.ceil(n / w);
          const pts = new Float32Array(w * h * 2);
          pts.set(line);
          const road = R.finish(line, this._groundHeights(pts, w, h));
          const map = R.vectorMap(road);
          this.roadMap = LE.GL.createTexture2D(gl, map.w, map.h, 'rg16f', { filter: gl.LINEAR });
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, map.w, map.h, gl.RG, gl.FLOAT, map.data);
          this.roadBox = map.box;
          this.road = road;
        } catch (e) {
          console.warn('road: not laid', e);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
      }
      if (this.life) this.life.setRoad(this.road);
    }

    /**
     * The summits that fly banner clouds (volume.js): the tallest, steepest ones in view, at most four and well apart.
     * Found from the land itself once per bake, so they follow the landscape variation and the turn of the range. The
     * land is sampled on a polar grid over the view, every local top above 6 km is looked at again closely, and the
     * ones the picture shows biggest and sharpest are kept. A failure only costs the banner clouds.
     */
    _findPeaks() {
      this.peaks = [];
      if (!this.floatTargets) return;
      try {
        const v = this.viewInfo();
        const camY = v.camY;
        const half = v.hfov / 2 - 2 * D2R;
        const NA = 320, NR = 128, R0 = 12, R1 = 50;
        const da = (2 * half) / NA, dr = (R1 - R0) / NR;
        const pts = new Float32Array(NA * NR * 2);
        for (let j = 0; j < NR; j++) {
          for (let i = 0; i < NA; i++) {
            const a = -half + (i + 0.5) * da, r = R0 + (j + 0.5) * dr;
            pts[(j * NA + i) * 2] = Math.sin(a) * r;
            pts[(j * NA + i) * 2 + 1] = Math.cos(a) * r;
          }
        }
        const h = this._groundHeights(pts, NA, NR);
        const real = (k, r) => h[k] + (r * r) / (2 * 6371); // the land's own height, without the earth's curve
        // local tops: the highest point within 1.8 km
        const tops = [];
        for (let j = 0; j < NR; j++) {
          const r = R0 + (j + 0.5) * dr;
          const nj = Math.ceil(1.8 / dr), ni = Math.ceil(1.8 / (r * da));
          for (let i = 0; i < NA; i++) {
            const k = j * NA + i;
            if (real(k, r) < 6) continue;
            let top = true;
            for (let y = Math.max(0, j - nj); y <= Math.min(NR - 1, j + nj) && top; y++) {
              for (let x = Math.max(0, i - ni); x <= Math.min(NA - 1, i + ni); x++) {
                const kk = y * NA + x;
                if (kk !== k && (h[kk] > h[k] || (h[kk] === h[k] && kk < k))) { top = false; break; }
              }
            }
            if (top) tops.push({ i, j, k, r, a: -half + (i + 0.5) * da });
          }
        }
        tops.sort((p, q) => h[q.k] - h[p.k]);
        tops.length = Math.min(tops.length, 16);
        if (!tops.length) return;
        // look again closely round each, 40 m apart
        const F = 16, step = 0.04;
        const fine = new Float32Array(F * F * tops.length * 2);
        tops.forEach((t, n) => {
          const cx = Math.sin(t.a) * t.r, cz = Math.cos(t.a) * t.r;
          for (let y = 0; y < F; y++) {
            for (let x = 0; x < F; x++) {
              const o = ((n * F + y) * F + x) * 2;
              fine[o] = cx + (x - (F - 1) / 2) * step;
              fine[o + 1] = cz + (y - (F - 1) / 2) * step;
            }
          }
        });
        const hf = this._groundHeights(fine, F * F, tops.length);
        const found = tops.map((t, n) => {
          let best = n * F * F;
          for (let m = n * F * F; m < (n + 1) * F * F; m++) if (hf[m] > hf[best]) best = m;
          const x = fine[best * 2], z = fine[best * 2 + 1], y = hf[best];
          const r = Math.hypot(x, z), a = Math.atan2(x, z);
          const el = Math.atan2(y - camY, r);
          // how sharply it stands up: its height over the ring 1.5 km round it
          let ring = 0;
          for (let q = 0; q < 8; q++) {
            const rx = x + 1.5 * Math.sin((q * Math.PI) / 4), rz = z + 1.5 * Math.cos((q * Math.PI) / 4);
            const ri = Math.round((Math.atan2(rx, rz) + half) / da - 0.5), rj = Math.round((Math.hypot(rx, rz) - R0) / dr - 0.5);
            ring += h[Math.min(NR - 1, Math.max(0, rj)) * NA + Math.min(NA - 1, Math.max(0, ri))] / 8;
          }
          const drop = y - ring;
          // hidden behind a nearer ridge? (its own slopes within 1.2 km don't count)
          let seen = true;
          for (let jj = 0; jj < NR && seen; jj++) {
            const rr = R0 + (jj + 0.5) * dr;
            if (rr > r - 1.2) break;
            if (Math.atan2(h[jj * NA + t.i] - camY, rr) > el + 0.002) seen = false;
          }
          return { x, y, z, r, a, el, drop, seen };
        });
        // the ones the picture shows biggest and sharpest, at least 7 degrees apart
        const score = (p) => p.el * Math.min(1, Math.max(0, (p.drop - 0.25) / 0.9));
        const keep = [];
        for (const p of found.filter((f) => f.seen && f.drop > 0.3).sort((p, q) => score(q) - score(p))) {
          if (keep.length < 4 && keep.every((k) => Math.abs(k.a - p.a) > 7 * D2R)) keep.push(p);
        }
        keep.forEach((p, n) => {
          // each its own rhythm, from where it stands
          const u = Math.abs(Math.sin(p.x * 12.9898 + p.z * 78.233) * 43758.5453) % 1;
          p.periods = [1200 + 1500 * u, 1700 + 1300 * ((u * 7.3) % 1)];
          p.phases = [u * 40, u * 17 + n];
          p.sharp = Math.min(1, 0.55 + 0.45 * Math.min(1, (p.drop - 0.3) / 1.0));
          p.seed = 13.7 * (n + 1) + u * 50;
        });
        this.peaks = keep;
      } catch (e) {
        console.warn('banner clouds: no peaks found', e);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      }
    }

    /**
     * Banner clouds now. How much each summit makes: the weather's share (environment.js, `banner`), how sharply the
     * peak stands up, and a slow rhythm of its own (20 to 50 minutes of real time), so they form and dissolve one by one instead
     * of all together. They stream along the wind at the clouds, the wind the deck drifts with, and grow longer as
     * it blows harder.
     */
    bannerState(state) {
      const out = [];
      if (this.cfg.banners === false || !this.peaks || !this.peaks.length) return out;
      const w = state.weather;
      const amount = Math.max(w.banner || 0, this.bannerForce || 0);
      if (amount <= 0.01) return out;
      const kmh = Math.hypot(w.deckX || 0, w.deckZ || 0);
      const wx = kmh > 0.5 ? w.deckX / kmh : 1, wz = kmh > 0.5 ? w.deckZ / kmh : 0;
      // real seconds, not the scene's clock: in a time-lapse or the demo they must not flicker on and off
      const t = state.time;
      for (const p of this.peaks) {
        const beat = 0.5 + 0.5 * Math.sin(t / p.periods[0] * 2 * Math.PI + p.phases[0]) * Math.cos(t / p.periods[1] * 2 * Math.PI + p.phases[1]);
        // even in the best weather each one is gone for part of its rhythm
        const x = amount * p.sharp * (0.25 + 0.95 * beat);
        const s = Math.min(1, Math.max(0, (x - 0.35) / 0.4));
        const strength = s * s * (3 - 2 * s);
        if (strength < 0.02) continue;
        const len = (1.6 + 2.6 * Math.min(1, Math.max(0, (kmh - 10) / 50))) * (0.6 + 0.4 * strength);
        out.push({ p, strength, len, wx, wz });
      }
      return out;
    }

    _bannerUniforms(p, state) {
      const list = this.bannerState(state);
      // how far the air has flowed through them (km, real time at the cloud wind's speed), wrapped at 2 km, where
      // their noise repeats along the wind, so the wrap never shows
      const w = state.weather;
      const kmh = Math.hypot(w.deckX || 0, w.deckZ || 0);
      const dt = this._bannerT == null ? 0 : Math.min(Math.max(state.time - this._bannerT, 0), 1);
      this._bannerT = state.time;
      this._bannerFlow = ((this._bannerFlow || 0) + (dt * kmh) / 3600) % 2;
      p.set('uBannerFlow', this._bannerFlow);
      p.set('uBanners', list.length);
      if (!list.length) return;
      const A = new Float32Array(16), B = new Float32Array(16);
      list.forEach((b, i) => {
        A.set([b.p.x, b.p.y, b.p.z, b.strength], i * 4);
        B.set([b.wx, b.wz, b.len, b.p.seed], i * 4);
      });
      p.set('uBannerA', A);
      p.set('uBannerB', B);
    }

    /** What the bake and the shadows need to know of the road. Returns the textures to bind. */
    _roadUniforms(p) {
      p.set('uRoadOn', this.roadMap ? 1 : 0);
      if (!this.roadMap) return {};
      p.set('uRoadBox', this.roadBox);
      return { uRoadMap: this.roadMap };
    }

    // ---------------------------------------------------------------- uniforms
    _camera(prog, w, h) {
      const r = this.cfg.render;
      const aspect = w / h;
      const hfov = Math.min(r.maxHFovDeg, Math.max(60, aspect * 39.5)) * D2R;
      prog.set('uRes', [w, h]);
      prog.set('uHFov', hfov);
      prog.set('uHorizonY', r.horizonY);
      prog.set('uCamPos', [0, r.cameraAltitude, 0]);
      const seed = r.seed | 0;
      prog.set('uSeedOff', [((seed * 127.1) % 1000) + 13.7, ((seed * 311.7) % 1000) + 41.3]);
      const turn = this.rangeTurn(w, h);
      prog.set('uRangeTurn', [Math.cos(turn), Math.sin(turn)]);
    }

    /** How far the great range is turned (radians, positive to the right). A window this wide spans two screens side
     *  by side (as the card in main.js assumes), and the sharpest peak would stand on the bezel between them. A
     *  resize bakes the land again, so this follows the window. */
    rangeTurn(w = this.w, h = this.h) {
      return w / Math.max(1, h) > 2.5 ? (this.cfg.render.spanTurnDeg || 0) * D2R : 0;
    }

    _bind(prog, textures) {
      const gl = this.gl;
      let unit = 0;
      for (const name in textures) {
        const tex = textures[name];
        if (!prog.has(name) || !tex) continue;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(tex._size ? gl.TEXTURE_3D : gl.TEXTURE_2D, tex);
        prog.set(name, unit);
        unit++;
      }
    }

    _target(t, w, h) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      if (t) gl.drawBuffers(t.bufs);
      gl.viewport(0, 0, w, h);
    }

    /** r = [x, y, w, h], or null to disable scissoring */
    _scissor(r) {
      const gl = this.gl;
      if (!r) {
        gl.disable(gl.SCISSOR_TEST);
      } else {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(r[0], r[1], r[2], r[3]);
      }
    }

    _draw() {
      this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    }

    /**
     * Full-screen draw split into horizontal bands, each flushed separately. Same pixels as one
     * draw, but Windows can schedule the desktop and other apps' GPU work between the bands
     * instead of waiting behind one long draw. That keeps the PC responsive while a frame renders.
     */
    _drawBands(w, h, n) {
      const step = Math.ceil(h / n);
      const r = this._band || (this._band = [0, 0, 0, 0]);
      for (let y = 0; y < h; y += step) {
        r[0] = 0;
        r[1] = y;
        r[2] = w;
        r[3] = Math.min(step, h - y);
        this._scissor(r);
        this._draw();
        this.gl.flush();
      }
      this._scissor(null);
    }

    // ---------------------------------------------------------------- passes
    /** One paced chunk of the terrain bake. The next chunk waits until the GPU has finished this one. */
    _bakeStep(state) {
      const pacer = this._bakePacer;
      if (!pacer.ready()) return;
      const job = this._bakeJob;
      if (job.y >= this.h) {
        this._beginShadow(state, true);
        return;
      }
      const gl = this.gl;
      const p = this.prog.bake;
      const r = this._nextRect(job, pacer.px);
      this._target(this.gbuf, this.w, this.h);
      gl.useProgram(p.p);
      this._camera(p, this.w, this.h);
      p.set('uNorth', [0, -1]); // snow lingers a little longer on the faces turned toward the viewer
      p.set('uSeason', state.season);
      p.set('uTreeSite', this.treeSite());
      this._bind(p, this._roadUniforms(p));
      this._scissor(r);
      pacer.begin();
      this._draw();
      pacer.submitted(r[2] * r[3]);
      this._scissor(null);
      this._advance(job, r);
      this.progress = Math.min(1, job.done / (this.w * this.h)) * 0.75;
      if (this.onStatus) this.onStatus(this.status, this.progress);
    }

    _beginShadow(state, initial) {
      this._shadow = {
        x: 0,
        y: 0,
        done: 0,
        dir: Float32Array.from(state.keyDir),
        isSun: state.keyIsSun,
        initial,
        target: initial ? this.shadowA : this.shadowB,
      };
      if (initial) this._setStatus('shadow');
      else this._bgPacer.px = this._bgStartPx;
    }

    /**
     * One paced chunk of a shadow job. The first shadow (part of the start-up) runs as fast as
     * the GPU allows. Background refreshes during the day use small chunks (~4 ms of GPU per frame).
     */
    _shadowStep() {
      const job = this._shadow;
      const pacer = job.initial ? this._shadowPacer : this._bgPacer;
      if (!pacer.ready()) return;
      if (job.y >= this.h) {
        this._finishShadow(job);
        return;
      }
      const gl = this.gl;
      const p = this.prog.shadow;
      const r = this._nextRect(job, pacer.px);
      this._target(job.target, this.w, this.h);
      gl.useProgram(p.p);
      this._camera(p, this.w, this.h);
      p.set('uLightDir', job.dir);
      p.set('uTreeSite', this.treeSite());
      this._bind(p, { uG0: this.gbuf.tex[0], uG2: this.gbuf.tex[2], ...this._roadUniforms(p) });
      this._scissor(r);
      pacer.begin();
      this._draw();
      pacer.submitted(r[2] * r[3]);
      this._scissor(null);
      this._advance(job, r);
      if (job.initial) {
        this.progress = 0.75 + 0.25 * Math.min(1, job.done / (this.w * this.h));
        if (this.onStatus) this.onStatus(this.status, this.progress);
      }
    }

    _finishShadow(job) {
      this._shadowDir = job.dir;
      this._shadowIsSun = job.isSun;
      this._shadow = null;
      if (job.initial) {
        // Background refreshes during the day: ~4 ms of GPU per frame. Each refresh starts at the
        // bottom of the screen (the costliest rows), so its first chunk is sized from the worst
        // cost per pixel the initial shadow pass saw.
        const perPx = this._shadowPacer.maxMsPerPx;
        const bg = this._bgPacer;
        this._bgStartPx = clamp(Math.round(perPx > 0 ? bg.targetMs / perPx : bg.maxPx), bg.minPx, bg.maxPx);
        this._shadowMix = 0;
        this._fading = false;
        this._volWarm = 0;
        this._holdExposure = false;
        this._findSmokeSources();
        this._findForestSources();
        this._setStatus('running');
      } else {
        // B now holds the new shadows: cross-fade A → B, then swap
        this._fading = true;
        this._shadowMix = 0;
      }
    }

    _updateLUTs(state) {
      const gl = this.gl;
      const w = state.weather;
      // transmittance
      let p = this.prog.trans;
      this._target(this.transLUT, TRANS_W, TRANS_H);
      gl.useProgram(p.p);
      p.set('uSize', [TRANS_W, TRANS_H]);
      p.set('uMieScale', w.haze);
      this._draw();
      // sky
      p = this.prog.sky;
      this._target(this.skyLUT, SKY_W, SKY_H);
      gl.useProgram(p.p);
      p.set('uSize', [SKY_W, SKY_H]);
      p.set('uMieScale', w.haze);
      p.set('uCamAlt', this.cfg.render.cameraAltitude);
      p.set('uSunDir', state.sunDir);
      p.set('uMoonDir', state.moonDir);
      p.set('uSunE', state.sunE);
      p.set('uMoonE', state.moonE);
      p.set('uAirglow', state.airglowE);
      p.set('uTwilight', state.twilightE);
      this._bind(p, { uTransLUT: this.transLUT.tex[0] });
      this._draw();
    }

    _weatherUniforms(p, state) {
      const w = state.weather;
      p.set('uMieScale', w.haze);
      p.set('uCoverage', w.coverage);
      p.set('uOvercast', w.overcast);
      p.set('uCloudBase', w.cloudBase);
      p.set('uCloudTop', w.cloudTop);
      p.set('uCloudDensity', w.cloudDensity);
      p.set('uWind', state.wind);
      p.set('uCoverWind', state.coverWind);
      p.set('uCoverFront', state.coverFront);
      p.set('uMistWind', state.mistWind);
      p.set('uSunDir', state.sunDir);
      p.set('uMoonDir', state.moonDir);
      p.set('uSunE', state.sunE);
      p.set('uMoonE', state.moonE);
      p.set('uKeyIsSun', state.keyIsSun);
    }

    _volumePass(state) {
      const gl = this.gl;
      const p = this.prog.volume;
      const q = this.quality;
      const w = state.weather;
      const src = this.volA;
      const dst = this.volB;
      this._target(dst, this.vw, this.vh);
      gl.useProgram(p.p);
      this._camera(p, this.w, this.h);
      this._weatherUniforms(p, state);
      p.set('uVolRes', [this.vw, this.vh]);
      p.set('uFrame', this.frame % 64);
      const warm = this._volWarm < 2;
      p.set('uBlend', warm ? 1.0 : this._slow ? Math.max(q.volBlend, this._rest ? 0.4 : 0.3) : q.volBlend);
      p.set('uDetailDrift', state.detailDrift);
      p.set('uLightMarchDir', state.lightMarchDir);
      p.set('uCloudDark', w.cloudDark);
      p.set('uMist', w.mist);
      p.set('uMistBottom', w.mistBottom);
      p.set('uMistTop', w.mistTop);
      p.set('uFog', w.fog);
      p.set('uFogTop', w.fogTop);
      p.set('uCloudSteps', q.cloudSteps);
      p.set('uCloudFine', q.cloudFine);
      p.set('uMistSteps', q.mistSteps);
      p.set('uLightSteps', q.lightSteps);
      // mist rising off the forest and smoke from houses and fires (life.js decides where and how much)
      const L = this.life;
      const plumes = L && L.plumeCount ? L.plumeCount : 0;
      p.set('uPlumes', plumes);
      p.set('uPlumeSteps', q.plumeSteps || 10);
      p.set('uTime', state.time % 2400); // wrapped, as everywhere: the smoke's climb repeats exactly in that time
      p.set('uHeadE', Math.min(state.exposure * 3e-4, HEAD_CAP)); // a fire's glow on its smoke, as a lamp's
      if (plumes) {
        p.set('uPlumeA', L.plumeA);
        p.set('uPlumeB', L.plumeB);
        p.set('uPlumeC', L.plumeC);
      }
      this._bannerUniforms(p, state); // banner clouds streaming from the high summits
      p.set('uAirExt', 0.004 * w.haze + 0.0022 * w.valleyHaze);
      this._bind(p, {
        uG0: this.gbuf.tex[0],
        uShadow: this._shadowMix < 0.5 ? this.shadowA.tex[0] : this.shadowB.tex[0],
        uHistory: src.tex[0],
        uSkyLUT: this.skyLUT.tex[0],
        uTransLUT: this.transLUT.tex[0],
        uNoise3D: this.noise3D,
        uNoise2D: this.noise2D,
      });
      this._drawBands(this.vw, this.vh, 2);
      this.volA = dst;
      this.volB = src;
      this._volWarm++;
    }

    /**
     * The scene: to the screen in flushed bands, or to the meter. With a band { x, y, w, h, grass }: only that
     * rectangle, of the next kept picture, or (grass) on the screen and only the grass in it.
     */
    _compositePass(state, meter, band = null) {
      const gl = this.gl;
      const p = this.prog.composite;
      const w = state.weather;
      if (meter) this._target(this.meter, METER_W, METER_H);
      else this._target(band && !band.grass ? this.pictureNext : null, this.w, this.h);
      gl.useProgram(p.p);
      this._camera(p, this.w, this.h);
      p.set('uMeter', meter ? 1 : 0);
      p.set('uGrassOnly', band && band.grass ? 1 : 0);
      p.set('uGrassWind', this._grassWind);
      p.set('uTreeSite', this.treeSite());
      p.set('uOutScale', meter ? [this.w / METER_W, this.h / METER_H] : [1, 1]);
      this._weatherUniforms(p, state);
      p.set('uVolRes', [this.vw, this.vh]);
      p.set('uShadowMix', this._shadowMix);
      p.set('uKeyDir', state.keyDir);
      p.set('uMoonDiskE', state.moonDiskE);
      p.set('uSunVis', state.sunVis);
      p.set('uMoonVis', state.moonVis);
      p.set('uStarVis', state.starVis);
      p.set('uStarMat', state.starMat);
      p.set('uTime', state.time % 2400); // wrapped: keeps float precision after days of uptime
      p.set('uCirrus', w.cirrus);
      p.set('uCirrusWind', state.cirrusWind);
      p.set('uRain', w.rain);
      p.set('uSnow', w.snow);
      p.set('uWet', w.wet);
      p.set('uSnowLine', state.snowLine);
      p.set('uFlash', w.flash);
      p.set('uFlashPos', w.flashPos);
      p.set('uRainSlant', w.rainSlant);
      p.set('uNight', state.night);
      p.set('uFade', this._fade);
      p.set('uRainLayers', this.quality.rainLayers);
      // Slow mode keeps its pictures without the falling drops and flakes: each fade puts them in front (drawFade).
      // The grass between scenes is drawn on the screen, after that fade, so it has them like a scene frame.
      p.set('uPrecipOff', this._slow && !meter && !(band && band.grass) ? 1 : 0);
      p.set('uFog', w.fog);
      p.set('uDebugView', this.cfg.debugView | 0);
      p.set('uValleyHaze', w.valleyHaze);
      p.set('uLampE', this.cfg.life === false || this.cfg.lights === false ? 0 : state.lampE);
      p.set('uLampDark', state.lampDark);
      p.set('uLocalHour', state.localHour);
      p.set('uGustDir', state.gustDir);
      p.set('uGustTravel', state.gustTravel);
      p.set('uWindAmt', state.windAmt);
      p.set('uTreeSway', state.treeSway);
      const fg = this.fg;
      const tree = fg && fg.enabled ? fg.tree : null;
      p.set('uTreeOn', tree ? 1 : 0);
      if (tree) {
        p.set('uCrownC', tree.crownC);
        p.set('uCrownR', tree.crownR);
        p.set('uTrunkTop', tree.trunkTop);
        p.set('uTreeSwayT', fg.swayOffset(state));
      }
      this._bind(p, {
        uG0: this.gbuf.tex[0],
        uG1: this.gbuf.tex[1],
        uG2: this.gbuf.tex[2],
        uG3: this.gbuf.tex[3],
        uShadowA: this.shadowA.tex[0],
        uShadowB: this.shadowB.tex[0],
        uVol: this.volA.tex[0],
        uSkyLUT: this.skyLUT.tex[0],
        uTransLUT: this.transLUT.tex[0],
        uNoise2D: this.noise2D,
        uNoise3D: this.noise3D,
        uAdapt: this.adaptA.tex[0],
      });
      if (meter) this._draw();
      else if (band) {
        const r = this._band || (this._band = [0, 0, 0, 0]);
        r[0] = band.x;
        r[1] = band.y;
        r[2] = band.w;
        r[3] = band.h;
        this._scissor(r);
        this._draw();
        this._scissor(null);
      } else this._drawBands(this.w, this.h, 4);
    }

    _meterAndAdapt(dtSec) {
      const gl = this.gl;
      this._compositePass(this._lastState, true);
      gl.bindTexture(gl.TEXTURE_2D, this.meter.tex[0]);
      gl.generateMipmap(gl.TEXTURE_2D);
      const p = this.prog.adapt;
      this._target(this.adaptB, 1, 1);
      gl.useProgram(p.p);
      p.set('uMaxLod', Math.floor(Math.log2(Math.max(METER_W, METER_H))));
      p.set('uRate', this._adaptReset ? 1 : 1 - Math.exp(-Math.min(dtSec, 1) / 2.5));
      p.set('uKey', 0.17);
      this._bind(p, { uMeterTex: this.meter.tex[0], uPrev: this.adaptA.tex[0] });
      this._draw();
      const t = this.adaptA;
      this.adaptA = this.adaptB;
      this.adaptB = t;
      this._adaptReset = false;
    }

    /** Projection parameters shared with the life simulation. */
    viewInfo() {
      const r = this.cfg.render;
      const aspect = this.w / this.h;
      const hfov = Math.min(r.maxHFovDeg, Math.max(60, aspect * 39.5)) * D2R;
      return { w: this.w, h: this.h, hfov, pxAng: hfov / this.w, horizonY: r.horizonY, camY: r.cameraAltitude };
    }

    /** Where the tree stands on the rock (ledge.js): x, y, z in metres from the eye, and the radius of its level patch. */
    treeSite() {
      const v = this.viewInfo();
      const a = (TREE.u * v.hfov) / 2;
      return [Math.sin(a) * TREE.r, TREE.y, Math.cos(a) * TREE.r, TREE.patch];
    }

    _spritePass(state) {
      const life = this.life;
      if (!life || !life.count) return;
      const gl = this.gl;
      const p = this.prog.sprites;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, life.data, 0, life.count * LE.Life.FLOATS);
      this._target(null, this.w, this.h);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(p.p);
      this._camera(p, this.w, this.h);
      const w = state.weather;
      p.set('uVolRes', [this.vw, this.vh]);
      p.set('uSunDir', state.sunDir);
      p.set('uSunE', state.sunE);
      p.set('uMoonDir', state.moonDir);
      p.set('uMoonE', state.moonE);
      p.set('uOvercast', w.overcast);
      p.set('uValleyHaze', w.valleyHaze);
      p.set('uMieScale', w.haze);
      p.set('uNight', state.night);
      p.set('uTime', state.time % 2400);
      // About 30 lux close in front of the lamps, against the sun's 100 000 at an irradiance of 1: capped, so on a
      // moonless night the patch reads as lamplight on the road instead of burning out white
      p.set('uHeadE', Math.min(state.exposure * 3e-4, HEAD_CAP));
      this._bind(p, {
        uG0: this.gbuf.tex[0],
        uG1: this.gbuf.tex[1],
        uVol: this.volA.tex[0],
        uAdapt: this.adaptA.tex[0],
        uSkyLUT: this.skyLUT.tex[0],
        uTransLUT: this.transLUT.tex[0],
        uShadow: this.shadowA.tex[0],
      });
      gl.bindVertexArray(this.spriteVAO);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, life.count);
      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);
    }

    /**
     * Houses (each {t km away, a its azimuth, x, y, z}) into villages, each smoking from the house nearest its middle; at
     * most 14 of them, from every part of the view: the nearest village in each of seven slices of it, then the next.
     */
    static villageChimneys(houses, hfov) {
      const sorted = Array.from(houses).sort((p, q) => p.t - q.t);
      const villages = [];
      for (const pt of sorted) {
        const vg = villages.find((g) => Math.hypot(g.x - pt.x, g.z - pt.z) < 0.6);
        if (vg) vg.houses.push(pt);
        else villages.push({ x: pt.x, z: pt.z, houses: [pt] });
      }
      const slices = Array.from({ length: 7 }, () => []);
      for (const vg of villages) {
        const mx = vg.houses.reduce((s, p) => s + p.x, 0) / vg.houses.length;
        const mz = vg.houses.reduce((s, p) => s + p.z, 0) / vg.houses.length;
        const home = vg.houses.reduce((p, q) => (Math.hypot(p.x - mx, p.z - mz) <= Math.hypot(q.x - mx, q.z - mz) ? p : q));
        const k = Math.min(6, Math.max(0, Math.floor((home.a / hfov + 0.5) * 7)));
        slices[k].push({ x: home.x, y: home.y, z: home.z }); // nearest first in each, as the villages were made
      }
      const out = [];
      for (let round = 0; out.length < 14 && slices.some((s) => s.length > round); round++) {
        for (const s of slices) if (s[round] && out.length < 14) out.push(s[round]);
      }
      return out;
    }

    /**
     * One-time read of the house-light map for the villages in view: a chimney in each, across the whole picture and out
     * to the far side of the valley, so smoke can rise from any of them (life.js decides when and how much). It used to
     * take the ten nearest houses, which were all in the one or two villages closest by, and the rest never smoked.
     */
    _findSmokeSources() {
      const gl = this.gl;
      try {
        const step = 1;
        const w = this.w;
        const h = this.h;
        const g3 = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbuf.fbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT3);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, g3);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const v = this.viewInfo();
        // houses: the pixels most covered by a house's light. On a small window a house is smaller than a pixel and
        // never covers one fully, so take the best covered ones there are, down to a little
        const all = [];
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            if (g3[i] > 20 && g3[i + 2] > 30) all.push([x, y, g3[i]]);
          }
        }
        let cands = [];
        for (const least of [200, 120, 60, 20]) {
          cands = all.filter((c) => c[2] > least);
          if (cands.length >= 40) break;
        }
        // the best covered pixel in each small patch of the picture, so a big village close by leaves room for the rest
        const cells = new Map();
        for (const c of cands) {
          const k = ((c[0] / 8) | 0) * 8192 + ((c[1] / 4) | 0);
          const o = cells.get(k);
          if (!o || c[2] > o[2]) cells.set(k, c);
        }
        let pick = [...cells.values()];
        if (pick.length > 2000) {
          for (let i = pick.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pick[i], pick[j]] = [pick[j], pick[i]];
          }
          pick = pick.slice(0, 2000);
        }
        // their distances: G0 read once for just the rows these and their occlusion test need, instead of hundreds of
        // 1-pixel reads (each one stalls the page until the GPU catches up)
        let y0 = h;
        let y1 = 0;
        for (const c of pick) {
          y0 = Math.min(y0, c[1]);
          y1 = Math.max(y1, c[1] + 22);
        }
        y1 = Math.min(h - 1, y1);
        const bandH = Math.max(0, y1 - y0 + 1);
        const g0 = new Float32Array(w * bandH * 4);
        if (bandH > 0) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbuf.fbo);
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          gl.readPixels(0, y0, w, bandH, gl.RGBA, gl.FLOAT, g0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        const dist = (x, y) => g0[((y - y0) * w + x) * 4 + 2];
        const found = [];
        for (const [x, y] of pick) {
          const t = dist(x, y);
          // Villages across the valley too: smoke is drawn in 3D, so from behind a nearer ridge it shows rising above
          // it, as it would. Only one hidden right up past its first hundred metres or so is no use, and beyond 16 km
          // a village's smoke is lost in the haze.
          if (!(t > 1.5 && t < 16)) continue;
          let blocked = true;
          for (const up of [5, 12, 22]) {
            if (y + up >= h) break;
            const d = dist(x, y + up);
            if (!(d > 0 && d < t - 0.25)) blocked = false;
          }
          if (blocked) continue;
          const a = (x - 0.5 * w) * v.pxAng;
          const ty = (y - v.horizonY * h) * v.pxAng;
          const n = Math.hypot(Math.sin(a), ty, Math.cos(a));
          found.push({ t, a, x: (Math.sin(a) / n) * t, y: v.camY + (ty / n) * t, z: (Math.cos(a) / n) * t });
        }
        this.smokeSources = Renderer.villageChimneys(found, w * v.pxAng);
        const out = this.smokeSources;
        if (this.life) this.life.setSmokeSources(out);
      } catch (e) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.smokeSources = [];
      }
    }

    /**
     * Once after the bake: places on the forested slopes where mist can rise off the canopy after rain, or a field
     * be burned. Reads the canopy map whole (8 bits a pixel), and the distances only in a few bands of rows spread
     * from the near slopes to the far ones, instead of the whole depth buffer.
     */
    _findForestSources() {
      const gl = this.gl;
      const w = this.w;
      const h = this.h;
      const STEP = 6;
      const BAND = 30;
      try {
        const v = this.viewInfo();
        const g1 = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbuf.fbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, g1);
        const forest = (x, y) => g1[(y * w + x) * 4 + 3] > 140;
        const rows = [];
        for (let y = 0; y < h - BAND; y += STEP) {
          let n = 0;
          for (let x = 0; x < w; x += STEP) if (forest(x, y)) n++;
          if (n > 6) rows.push(y);
        }
        // six bands, spread through the rows that have forest: near slopes low in the picture, far ones higher up
        const bands = [];
        for (let k = 0; k < 6 && rows.length; k++) {
          const y = rows[Math.min(rows.length - 1, Math.floor(((k + 0.5) / 6) * rows.length))];
          if (bands.every((b) => Math.abs(b - y) >= BAND)) bands.push(y);
        }
        const g0 = new Float32Array(w * BAND * 4);
        const found = [];
        for (const y0 of bands) {
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          gl.readPixels(0, y0, w, BAND, gl.RGBA, gl.FLOAT, g0);
          const dist = (x, y) => g0[((y - y0) * w + x) * 4 + 2];
          for (let y = y0; y < y0 + 8; y += 2) {
            for (let x = (y * 7) % STEP; x < w; x += STEP) {
              if (!forest(x, y)) continue;
              const t = dist(x, y);
              if (!(t > 1.2 && t < 14)) continue;
              // the mist must rise in open view, not straight behind a nearer ridge
              let blocked = false;
              for (const up of [5, 12, 21]) {
                const d = dist(x, y + up);
                if (d > 0 && d < t - 0.25) blocked = true;
              }
              if (blocked) continue;
              const a = (x - 0.5 * w) * v.pxAng;
              const ty = (y - v.horizonY * h) * v.pxAng;
              const n = Math.hypot(Math.sin(a), ty, Math.cos(a));
              found.push({ t, x: (Math.sin(a) / n) * t, y: v.camY + (ty / n) * t, z: (Math.cos(a) / n) * t });
            }
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // spread out over the view, a few hundred metres apart at least
        for (let i = found.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [found[i], found[j]] = [found[j], found[i]];
        }
        const out = [];
        for (const pt of found) {
          if (out.every((o) => Math.hypot(o.x - pt.x, o.z - pt.z) > 0.4)) out.push({ x: pt.x, y: pt.y, z: pt.z });
          if (out.length >= 24) break;
        }
        this.forestSources = out;
        if (this.life) this.life.setForestSources(out);
      } catch (e) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.forestSources = [];
      }
    }

    /** Debug helper: reads back the current exposure correction and metered luminance. */
    readAdapt() {
      const gl = this.gl;
      const buf = new Float32Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.adaptA.fbo);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { correction: buf[0], meteredLum: buf[1] };
    }

    // ---------------------------------------------------------------- frame
    /**
     * Slow mode: the scene is drawn rarely, so each time must do more. A shadow pass advances one chunk per
     * scene, so chunks grow to keep up with the sun. Clouds update each scene and count for more against their
     * history, or they would trail behind the wind. rest = the Windows app's rest mode, far slower than a calm spell.
     */
    setSlowMode(on, rest = on) {
      this._slow = on;
      this._rest = on && rest;
      if (!on) {
        this._pictureReady = false;
        this._pictureJob = null;
      }
      const ms = !on ? 4 : rest ? 25 : 12;
      this._bgPacer.targetMs = ms;
      this._bgPacer.maxPx = 32768 * ms;
    }

    /** Slow mode starts: keeps the scene just drawn on the screen, with nothing to fade from yet. */
    _keepPicture() {
      const gl = this.gl;
      const { w, h } = this;
      if (!this.pictureA) {
        const make = () => createTarget(gl, w, h, [{ fmt: 'rgba8', filter: gl.NEAREST }]);
        this.pictureA = make();
        this.pictureB = make();
        this.pictureNext = make();
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.pictureB.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.pictureB.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.pictureA.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._pictureReady = true;
      this.pictureAt = performance.now();
    }

    /** The wind in the grass moves on: the same air the tree feels, so the two always agree. Called every frame. */
    _grassStep(state) {
      const dt = this._grassAt === null ? 0 : Math.min(Math.max(state.time - this._grassAt, 0), 0.25);
      this._grassAt = state.time;
      const x = state.treeDir[0];
      const z = state.treeDir[1];
      const gw = this._grassWind;
      // Gusts cross grass slower than the wind blows, and light air still moves through it at a walking pace
      const speed = state.treeKmh > 0.5 ? Math.max((state.treeKmh / 3.6) * 0.6, 0.6) : 0;
      gw[0] = (gw[0] + x * speed * dt) % GRASS_WRAP_M;
      gw[1] = (gw[1] + z * speed * dt * 0.3) % GRASS_WRAP_M; // far along the ground is only a little way up the picture
      // Grass answers the lightest air, which hardly moves a tree. The weather state only changes with each scene, so ease.
      const amount = state.windAmt > 0 ? Math.sqrt(state.windAmt / 0.6) : 0;
      const ease = Math.min(dt * 2, 1);
      gw[3] += (amount - gw[3]) * ease;
      gw[2] += (x * amount - gw[2]) * ease;
    }

    /** The part of the picture that can hold the grass, in pixels from the bottom left. */
    _grassBox() {
      const v = this.viewInfo();
      const rowAt = (r) => v.horizonY * v.h + TREE.y / r / v.pxAng;
      const y = Math.max(Math.floor(rowAt(TREE.r * 0.55)), 0);
      const top = Math.min(Math.ceil(rowAt(TREE.r * 2.2)) + 4, v.h);
      const right = ((TREE.u + 1) / 2) * v.w + (HILL_TIP_M + 2) / TREE.r / v.pxAng;
      return { x: 0, y, w: Math.min(Math.ceil(right), v.w), h: Math.max(top - y, 0), grass: true };
    }

    /** Between scenes: the grass alone, in the wind. It is a small part of the picture, so a small part of a frame. */
    _grassPass(state) {
      if (!this.grassMoving()) return;
      this._compositePass(state, false, this._grassBox());
    }

    /** True while the grass is being drawn again between scenes. */
    grassMoving() {
      return !this._rest && this._grassWind[3] >= 0.002;
    }

    /** True while the next kept picture is being drawn or waits for its turn. */
    pictureBusy() {
      return this._pictureJob !== null;
    }

    /** One more band of the next picture. Waits a frame after it is begun: that frame has the clouds to draw. */
    _pictureStep() {
      const job = this._pictureJob;
      if (job.fresh) {
        job.fresh = false;
        return;
      }
      if (job.y >= this.h) return;
      const n = Math.min(Math.ceil(this.h / this.pictureBands), this.h - job.y);
      const now = job.state.time;
      job.state.time = job.time; // the fade moves the clock on, and the bands must match each other
      this._compositePass(job.state, false, { x: 0, y: job.y, w: this.w, h: n });
      job.state.time = now;
      job.y += n;
    }

    /** Every frame should fit one screen refresh: a slow GPU gets more, thinner bands. Only the scene comes later. */
    _tunePictureBands() {
      if (this.gpuBusyMs > 14) this.pictureBands = Math.min(this.pictureBands + 2, 32);
      else if (this.gpuBusyMs < 10) this.pictureBands = Math.max(this.pictureBands - 1, 4);
    }

    /**
     * Slow mode, between scene frames: fades from the previous picture to the latest one (f = 0 to 1) and draws
     * the birds and the tree where they are now. On the way it draws a band of the next picture, which takes over
     * once it is whole and this fade has ended, so nothing jumps. Returns false when there is nothing to show yet.
     */
    drawFade(f, state) {
      const gl = this.gl;
      if (!gl || gl.isContextLost() || this.status !== 'running' || !this._pictureReady) return false;
      this._grassStep(state);
      const job = this._pictureJob;
      if (job) {
        this._pictureStep();
        if (job.y >= this.h && f >= 1) {
          const older = this.pictureA;
          this.pictureA = this.pictureB;
          this.pictureB = this.pictureNext;
          this.pictureNext = older;
          this._pictureJob = null;
          this.pictureAt = performance.now();
          this._tunePictureBands();
          f = 0;
        }
      }
      this._target(null, this.w, this.h);
      const w = state.weather;
      const falling = w.rain > 0.003 || w.snow > 0.003;
      const p = falling ? this.prog.fadeRain : this.prog.fade;
      gl.useProgram(p.p);
      p.set('uMix', f);
      const tex = { uFrom: this.pictureA.tex[0], uTo: this.pictureB.tex[0] };
      if (falling) {
        // the drops and flakes as _compositePass draws them, at this frame's time
        p.set('uRes', [this.w, this.h]);
        p.set('uTime', state.time % 2400);
        p.set('uRain', w.rain);
        p.set('uSnow', w.snow);
        p.set('uRainSlant', w.rainSlant);
        p.set('uRainLayers', this.quality.rainLayers);
        p.set('uFlash', w.flash);
        p.set('uNight', state.night);
        p.set('uFade', this._fade);
        tex.uSkyLUT = this.skyLUT.tex[0];
      }
      this._bind(p, tex);
      this._draw();
      this._grassPass(state);
      this._spritePass(state);
      this.fg.draw(state);
      this._fenceFrame();
      return true;
    }

    /** True while the tree is moving in the wind or leaves are falling (the rest mode's frame rate). */
    foregroundMoving() {
      return !!(this.fg && this.fg.enabled && this.fg.moving);
    }

    /** Returns true when a visible frame was produced. */
    render(state, dtSec) {
      const gl = this.gl;
      if (!gl || gl.isContextLost() || this.status === 'error') return false;
      this.frame++;

      if (this.status === 'compiling') {
        try {
          if (!this._pollCompile()) return false;
        } catch (err) {
          this._setStatus('error');
          if (this.onError) this.onError(err);
          return false;
        }
        if (!this.w) return false;
        this._startBake();
      }

      if (this._sceneKey !== this.sceneKey()) this._startBake();

      if (this.status === 'baking') {
        this._bakeStep(state);
        return false;
      }
      if (this.status === 'shadow') {
        this._shadowStep();
        if (this.status !== 'running') return false;
      }

      // LUTs (≈1 Hz, or immediately after a big light change)
      if (state.time - this._lutAt > 1.0 || state.time < this._lutAt || this._volWarm === 0) {
        this._lutAt = state.time;
        this._updateLUTs(state);
      }

      // shadow refresh when the key light has moved
      if (!this._shadow && !this._fading) {
        const d = this._shadowDir;
        const k = state.keyDir;
        const dot = d ? d[0] * k[0] + d[1] * k[1] + d[2] * k[2] : -1;
        const moved = Math.acos(Math.min(1, Math.max(-1, dot))) / D2R;
        if (moved > 0.35 || state.keyIsSun !== this._shadowIsSun) this._beginShadow(state, false);
      }
      if (this._shadow) this._shadowStep();
      if (this._fading) {
        this._shadowMix = Math.min(1, this._shadowMix + Math.min(dtSec, 0.25) / 2.5);
        if (this._shadowMix >= 1) {
          const t = this.shadowA;
          this.shadowA = this.shadowB;
          this.shadowB = t;
          this._shadowMix = 0;
          this._fading = false;
        }
      }

      const timing = this._beginFrameTimer(state.time);
      this._grassStep(state);

      // volumetrics
      const every = this._slow ? 1 : this.quality.volEvery;
      if (this._volWarm < 4 || this.frame % every === 0) {
        this._volumePass(state);
        if (this._volWarm < 4) this._volumePass(state);
      }

      this._fade = Math.min(1, this._fade + dtSec / 2.5);
      this._lastState = state;
      if (this._volWarm > 5) this._holdExposure = false;
      else if (!this._holdExposure) this._adaptReset = true;
      // auto exposure adapts over ~2.5 s, so metering 10× a second looks the same as every frame
      this._meterDt = (this._meterDt || 0) + dtSec;
      if (this._adaptReset || this._meterDt >= 0.1) {
        this._meterAndAdapt(this._meterDt);
        this._meterDt = 0;
      }
      // In slow mode a kept picture has no birds and no tree: drawFade() draws them where they are now
      if (this._slow && this._pictureReady) {
        this._pictureJob = { state, time: state.time, y: 0, fresh: true };
      } else {
        this._compositePass(state, false);
        if (this._slow) this._keepPicture();
        else {
          this._spritePass(state);
          this.fg.draw(state);
        }
      }
      if (timing) gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      this._fenceFrame();
      return true;
    }

    /**
     * Measures a frame's GPU time about once a second, for the quality governor. Starts after the
     * background shadow chunk, because timer queries can't overlap. Never waits for a result.
     */
    _beginFrameTimer(nowSec) {
      const ext = this.timerExt;
      if (!ext) return false;
      const gl = this.gl;
      if (this._frameQuery) {
        if (!gl.getQueryParameter(this._frameQuery, gl.QUERY_RESULT_AVAILABLE)) return false;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) this.gpuFrameMs = gl.getQueryParameter(this._frameQuery, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(this._frameQuery);
        this._frameQuery = null;
      }
      if (Math.abs(nowSec - this._frameQueryAt) < 1) return false;
      this._frameQueryAt = nowSec;
      this._frameQuery = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, this._frameQuery);
      return true;
    }

    gpuInfo() {
      const gl = this.gl;
      if (!gl) return '';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }

    dispose() {
      const gl = this.gl;
      if (!gl) return;
      [this.gbuf, this.shadowA, this.shadowB, this.volA, this.volB, this.transLUT, this.skyLUT, this.meter, this.adaptA, this.adaptB].forEach((t) => deleteTarget(gl, t));
      gl.deleteTexture(this.noise2D);
      gl.deleteTexture(this.noise3D);
      gl.deleteBuffer(this.spriteBuf);
      gl.deleteVertexArray(this.spriteVAO);
      if (this.fg) this.fg.dispose();
      [this._bakePacer, this._shadowPacer, this._bgPacer].forEach((pc) => pc && pc.dispose());
      if (this._frameQuery) gl.deleteQuery(this._frameQuery);
      if (this._frameFence !== null) gl.deleteSync(this._frameFence);
      this._frameFence = null;
      Object.values(this.prog || {}).forEach((p) => gl.deleteProgram(p.p));
    }
  }

  LE.Renderer = Renderer;
})();
