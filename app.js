"use strict";
// Steam Game Wall — an endless tilted wall of Steam library covers with a clock on top.
// The wall is one infinite plane drawn with WebGL2: every visible grid cell is an
// instanced quad whose cover lives in a slot of a TEXTURE_2D_ARRAY. Cells that scroll
// out free their slot; cells scrolling in take a fresh cover from a persistent deck.
(async () => {
  const DEFAULTS = {
    wall: { postersOnScreen: 45, gapPx: 8, cornerRadiusPx: 4 },
    camera: { perspectivePx: 1200, rotateXDeg: 12, rotateYDeg: -10, rotateZDeg: -18, scale: 1.4, zoomAmplitude: 0.04, zoomPeriodSec: 150 },
    motion: { speedPxPerSec: 18, directionDeg: 215 },
    overlay: { dim: 0.35, centerShade: 0.6, vignette: 0.8 },
    clock: { locale: "ru-RU", hour12: false, timeSizeVh: 16, dateSizeVh: 3.4, offsetYVh: 0, fontWeight: 300, dateFormat: "{weekday}, {day} {month} {year}" },
    selection: { avoidRepeatsAcrossRuns: true, excludeAppIds: [] },
    performance: { maxFps: 60, textureWidth: 0, textureBudgetMB: 192, renderScale: 1 },
  };
  const REF_DIAGONAL = Math.hypot(1920, 1080);   // wall geometry is in 1080p-equivalent reference pixels
  const MAX_STEP_MS = 100;
  const STORE_KEY = "steamGameWall.deck.v1";

  const canvas = document.getElementById("wall");
  let stopped = false;

  function merge(base, over) {
    const out = { ...base };
    for (const k in over) {
      const v = over[k];
      out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] ? merge(base[k], v) : v;
    }
    return out;
  }

  async function loadJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  let cfg = DEFAULTS;
  try { cfg = merge(DEFAULTS, await loadJson("config.json")); } catch (e) { console.warn("config.json:", e); }

  // ---------- clock ----------------------------------------------------------------------------
  const root = document.documentElement.style;
  root.setProperty("--dim", cfg.overlay.dim);
  root.setProperty("--center-shade", cfg.overlay.centerShade);
  root.setProperty("--vignette", cfg.overlay.vignette);
  root.setProperty("--time-size", cfg.clock.timeSizeVh + "vh");
  root.setProperty("--date-size", cfg.clock.dateSizeVh + "vh");
  root.setProperty("--clock-offset", cfg.clock.offsetYVh + "vh");
  root.setProperty("--clock-weight", cfg.clock.fontWeight);

  const locale = cfg.clock.locale || navigator.language;
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: !!cfg.clock.hour12 });
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "long" });
  const dayMonthFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }); // genitive month in ru
  const timeEl = document.getElementById("time"), dateEl = document.getElementById("date");
  let shownMinute = "";

  function formatDate(d) {
    const parts = dayMonthFmt.formatToParts(d);
    const pick = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    const s = cfg.clock.dateFormat
      .replace("{weekday}", weekdayFmt.format(d))
      .replace("{day}", pick("day"))
      .replace("{month}", pick("month"))
      .replace("{year}", String(d.getFullYear()));
    return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
  }

  function tickClock() {
    const d = new Date();
    const key = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate() + " " + d.getHours() + ":" + d.getMinutes();
    if (key === shownMinute) return;
    shownMinute = key;
    timeEl.textContent = timeFmt.format(d);
    dateEl.textContent = formatDate(d);
  }
  tickClock();
  const clockTimer = setInterval(tickClock, 1000); // writes the DOM only when the minute changes

  // ---------- library ----------------------------------------------------------------------------
  let library = [];
  try { library = (await loadJson("cache/games.json")).games; }
  catch {
    try { await loadScript("cache/games.js"); library = (window.__LIBRARY__ || {}).games || []; } catch { /* no cache yet */ }
  }
  const excluded = new Set((cfg.selection.excludeAppIds || []).map(Number));
  library = (library || []).filter((g) => !excluded.has(Number(g.appid)));
  if (!library.length) { console.warn("Library cache is empty — run tools/library-sync.ps1"); return; }
  const byId = new Map(library.map((g) => [g.appid, g]));

  // Persistent shuffled deck: each run continues where the previous one stopped, so
  // consecutive runs show different games until the whole library has been cycled.
  const deck = (() => {
    const ids = library.map((g) => g.appid);
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
    let order = null, pos = 0;
    if (cfg.selection.avoidRepeatsAcrossRuns) {
      try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
        if (saved && Array.isArray(saved.order)) {
          const known = new Set(ids);
          const kept = saved.order.filter((id) => known.has(id));
          pos = Math.min(saved.order.slice(0, saved.pos).filter((id) => known.has(id)).length, kept.length);
          const seen = new Set(kept);
          // New games go somewhere into the not-yet-shown part of the deck.
          for (const id of shuffle(ids.filter((id) => !seen.has(id)))) kept.splice(pos + ((Math.random() * (kept.length - pos + 1)) | 0), 0, id);
          order = kept;
        }
      } catch { /* storage unavailable */ }
    }
    if (!order) { order = shuffle(ids.slice()); pos = 0; }

    function reshuffle() {
      const tail = new Set(order.slice(-Math.floor(order.length / 3)));
      const next = shuffle(order.slice());
      // keep the last third of the previous pass away from the start of the next one
      next.sort((a, b) => (tail.has(a) ? 1 : 0) - (tail.has(b) ? 1 : 0));
      const head = Math.floor(next.length * 2 / 3);
      order = shuffle(next.slice(0, head)).concat(shuffle(next.slice(head)));
      pos = 0;
    }

    let saveTimer = 0;
    function save() {
      if (!cfg.selection.avoidRepeatsAcrossRuns) return;
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ order, pos })); } catch { }
    }
    function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; save(); }, 3000); }

    // isBlocked(id) → true if the id must not be used right now (already on the wall / adjacent).
    function next(isBlocked) {
      if (pos >= order.length) reshuffle();
      for (let k = pos; k < order.length; k++) {
        if (!isBlocked(order[k])) {
          [order[pos], order[k]] = [order[k], order[pos]];
          scheduleSave();
          return order[pos++];
        }
      }
      return null;
    }
    return { next, save };
  })();

  // ---------- WebGL ------------------------------------------------------------------------------
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: "low-power", desynchronized: false });
  if (!gl) { console.error("WebGL2 unavailable"); return; }
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stopped = true; });
  canvas.addEventListener("webglcontextrestored", () => location.reload());

  const VS = `#version 300 es
  layout(location=0) in vec2 aCorner;
  layout(location=1) in vec4 aInst;      // plane x, plane y, texture layer, alpha
  uniform vec2 uSize;                     // poster size, plane px
  uniform vec3 uA, uB;                    // plane basis after rotate*scale
  uniform float uP;                       // perspective distance
  uniform vec2 uHalf;                     // half viewport, reference px
  out vec3 vUV; out vec2 vLocal; out float vAlpha;
  void main() {
    vec2 p = aInst.xy + aCorner * uSize;
    vec3 q = p.x * uA + p.y * uB;
    gl_Position = vec4(q.x / uHalf.x, -q.y / uHalf.y, 0.0, (uP - q.z) / uP);
    vUV = vec3(aCorner, aInst.z);
    vLocal = aCorner * uSize;
    vAlpha = aInst.w;
  }`;
  const FS = `#version 300 es
  precision highp float;
  precision highp sampler2DArray;
  uniform sampler2DArray uTex;
  uniform vec2 uSize;
  uniform float uRadius;
  in vec3 vUV; in vec2 vLocal; in float vAlpha;
  out vec4 outColor;
  void main() {
    vec2 h = uSize * 0.5;
    vec2 d = abs(vLocal - h) - (h - uRadius);
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uRadius;
    float aa = max(fwidth(dist), 1e-3);
    float mask = clamp(0.5 - dist / aa, 0.0, 1.0) * vAlpha;
    outColor = vec4(texture(uTex, vUV).rgb * mask, mask);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = {};
  for (const n of ["uSize", "uA", "uB", "uP", "uHalf", "uTex", "uRadius"]) U[n] = gl.getUniformLocation(prog, n);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);
  gl.uniform1i(U.uTex, 0);
  gl.uniform1f(U.uP, cfg.camera.perspectivePx);
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");

  // ---------- camera math (mirrors the vertex shader) -------------------------------------------
  const rad = (deg) => deg * Math.PI / 180;
  const P = cfg.camera.perspectivePx;
  // CSS order: perspective rotateZ rotateX rotateY scale → M = Rz·Rx·Ry (scale applied separately)
  const M = (() => {
    const z = rad(cfg.camera.rotateZDeg), x = rad(cfg.camera.rotateXDeg), y = rad(cfg.camera.rotateYDeg);
    const mul = (A, B) => A.map((r) => [0, 1, 2].map((c) => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]));
    const Rz = [[Math.cos(z), -Math.sin(z), 0], [Math.sin(z), Math.cos(z), 0], [0, 0, 1]];
    const Rx = [[1, 0, 0], [0, Math.cos(x), -Math.sin(x)], [0, Math.sin(x), Math.cos(x)]];
    const Ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
    return mul(mul(Rz, Rx), Ry);
  })();
  const basis = (s) => ({
    a: [M[0][0] * s, M[1][0] * s, M[2][0] * s],
    b: [M[0][1] * s, M[1][1] * s, M[2][1] * s],
  });
  // Screen point (ref px from centre) → plane point.
  function unproject(X, Y, { a, b }) {
    const a11 = P * a[0] + X * a[2], a12 = P * b[0] + X * b[2];
    const a21 = P * a[1] + Y * a[2], a22 = P * b[1] + Y * b[2];
    const det = a11 * a22 - a12 * a21;
    return [(X * P * a22 - a12 * Y * P) / det, (a11 * Y * P - a21 * X * P) / det];
  }
  // Projected scale factor (screen ref px per plane px) at a plane point.
  function localScale(u, v, { a, b }) {
    const z = u * a[2] + v * b[2];
    return Math.hypot(a[0], a[1]) * P / (P - z);
  }

  // ---------- layout ------------------------------------------------------------------------------
  const G = {};    // geometry, recomputed on resize
  function layout() {
    const dpr = (window.devicePixelRatio || 1) * cfg.performance.renderScale;
    canvas.width = Math.max(1, Math.round(innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    // Reference space has the diagonal of a 1920×1080 screen with the real aspect ratio,
    // so 16:10, 21:9 etc. get the same perspective strength instead of a stretched one.
    const refPerCss = REF_DIAGONAL / Math.hypot(innerWidth, innerHeight);
    G.halfW = innerWidth * refPerCss / 2;
    G.halfH = innerHeight * refPerCss / 2;
    gl.uniform2f(U.uHalf, G.halfW, G.halfH);

    const posters = cfg.wall.postersOnScreen;
    G.posters = posters;

    // Poster size so that ~posters cells fit in the visible quad at base scale.
    const base = basis(cfg.camera.scale);
    const quadPts = corners(base);
    let area = 0;
    for (let i = 0; i < 4; i++) { const [x1, y1] = quadPts[i], [x2, y2] = quadPts[(i + 1) % 4]; area += x1 * y2 - x2 * y1; }
    area = Math.abs(area) / 2;
    const g = cfg.wall.gapPx, perCell = area / posters;
    const w = (-2.5 * g + Math.sqrt(6.25 * g * g - 6 * (g * g - perCell))) / 3;
    const changed = Math.abs((G.posterW || 0) - w) > 0.5;
    G.posterW = w; G.posterH = w * 1.5;
    G.pitchX = w + g; G.pitchY = G.posterH + g;
    gl.uniform2f(U.uSize, G.posterW, G.posterH);
    gl.uniform1f(U.uRadius, Math.min(cfg.wall.cornerRadiusPx, w / 4));

    // Texture size: the largest on-screen poster (near corner, max zoom) in device pixels.
    const zoomMax = basis(cfg.camera.scale * (1 + cfg.camera.zoomAmplitude));
    let maxScale = 0;
    for (const [u, v] of corners(zoomMax)) maxScale = Math.max(maxScale, localScale(u, v, zoomMax));
    const devicePerRef = canvas.width / (2 * G.halfW);
    let tw = cfg.performance.textureWidth || Math.round(w * maxScale * devicePerRef);

    // Slot capacity: cells needed at the widest zoom-out, plus headroom.
    const zoomMin = basis(cfg.camera.scale * (1 - cfg.camera.zoomAmplitude));
    const capacity = Math.ceil(neededCells(zoomMin, 0, 0).length * 1.15) + 12;

    // Keep the texture array (with mips ≈ ×4/3) inside the VRAM budget.
    const budget = cfg.performance.textureBudgetMB * 1024 * 1024;
    const maxTw = Math.floor(Math.sqrt(budget / (capacity * 1.5 * 4 * 4 / 3)));
    tw = Math.max(160, Math.min(600, maxTw, Math.ceil(tw / 8) * 8));
    tw -= tw % 8;
    const th = Math.round(tw * 1.5);

    if (changed || !G.tex || G.texW !== tw || G.capacity < capacity) allocate(tw, th, changed ? capacity : Math.max(capacity, G.capacity || 0));
  }

  function corners(bs) {
    return [[-G.halfW, -G.halfH], [G.halfW, -G.halfH], [G.halfW, G.halfH], [-G.halfW, G.halfH]].map(([X, Y]) => unproject(X, Y, bs));
  }

  // Cells whose rectangle comes within one cell of the visible quad (the extra ring is the preload zone).
  function neededCells(bs, ox, oy) {
    const q = corners(bs);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of q) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // signed-distance edges of the (convex) quad, oriented inward
    let orient = 0;
    for (let i = 0; i < 4; i++) { const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4]; orient += ax * by - bx * ay; }
    const sign = orient > 0 ? 1 : -1;
    const edges = q.map(([ax, ay], i) => {
      const [bx, by] = q[(i + 1) % 4];
      const nx = -(by - ay) * sign, ny = (bx - ax) * sign, len = Math.hypot(nx, ny);
      return [nx / len, ny / len, (nx * ax + ny * ay) / len];
    });
    // half a cell diagonal covers any overlap; the rest is a short preload strip
    const margin = Math.hypot(G.pitchX, G.pitchY) * (0.5 + 0.25);
    const out = [];
    const i0 = Math.floor((x0 + ox) / G.pitchX) - 2, i1 = Math.floor((x1 + ox) / G.pitchX) + 2;
    const j0 = Math.floor((y0 + oy) / G.pitchY) - 2, j1 = Math.floor((y1 + oy) / G.pitchY) + 2;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = i * G.pitchX - ox + G.posterW / 2, cy = j * G.pitchY - oy + G.posterH / 2;
        let inside = true;
        for (const [nx, ny, c] of edges) if (nx * cx + ny * cy - c < -margin) { inside = false; break; }
        if (inside) out.push([i, j]);
      }
    }
    return out;
  }

  // ---------- cells & textures ----------------------------------------------------------------------
  const cells = new Map();            // "i,j" → { i, j, appid, slot, ready, born }
  const onWall = new Map();           // appid → count of cells showing it
  let freeSlots = [];

  function allocate(tw, th, capacity) {
    for (const c of cells.values()) c.cancelled = true;
    cells.clear(); onWall.clear();
    if (G.tex) gl.deleteTexture(G.tex);
    G.tex = gl.createTexture();
    G.texW = tw; G.texH = th; G.capacity = capacity;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, G.tex);
    // Posters never get much smaller than 1/16 of the texture, so a short chain is enough.
    G.levels = Math.min(6, Math.floor(Math.log2(Math.max(tw, th))) + 1);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, G.levels, gl.RGBA8, tw, th, capacity);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    freeSlots = Array.from({ length: capacity }, (_, k) => capacity - 1 - k);
    G.instances = new Float32Array(capacity * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, G.instances.byteLength, gl.DYNAMIC_DRAW);
  }

  // Decodes a cover into its full mip chain off the main thread, so a new cover never
  // forces a generateMipmap over the whole texture array.
  async function decodeCover(appid) {
    const url = byId.get(appid).file;
    const opts = (w, h) => ({ resizeWidth: w, resizeHeight: h, resizeQuality: "high", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    let src;
    try {
      src = await createImageBitmap(await (await fetch(url)).blob());
    } catch {
      src = new Image();
      src.src = url;
      await src.decode();
    }
    // Centre-crop to exactly 2:3 so off-ratio art is trimmed rather than squashed.
    const sw0 = src.width, sh0 = src.height;
    const sw = Math.min(sw0, Math.round(sh0 * 2 / 3)), sh = Math.min(sh0, Math.round(sw0 * 1.5));
    const level0 = await createImageBitmap(src, (sw0 - sw) >> 1, (sh0 - sh) >> 1, sw, sh, opts(G.texW, G.texH));
    if (src.close) src.close();
    const chain = [level0];
    for (let l = 1; l < G.levels; l++) {
      const prev = chain[l - 1];
      chain.push(await createImageBitmap(prev, opts(Math.max(1, G.texW >> l), Math.max(1, G.texH >> l))));
    }
    return chain;
  }

  function neighbours(i, j) {
    const ids = new Set();
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const c = cells.get((i + di) + "," + (j + dj));
      if (c) ids.add(c.appid);
    }
    return ids;
  }

  function addCell(i, j, now) {
    if (!freeSlots.length) return;
    const near = neighbours(i, j);
    let appid = deck.next((id) => onWall.has(id) || near.has(id));
    if (appid == null) appid = deck.next((id) => near.has(id));
    if (appid == null) return;
    const cell = { i, j, appid, slot: freeSlots.pop(), ready: false, born: now, cancelled: false };
    cells.set(i + "," + j, cell);
    onWall.set(appid, (onWall.get(appid) || 0) + 1);
    const tex = G.tex;
    decodeCover(appid).then((chain) => {
      if (!cell.cancelled && !stopped && tex === G.tex) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        chain.forEach((bmp, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, cell.slot, bmp.width, bmp.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, bmp));
        cell.ready = true; cell.readyAt = performance.now();
      }
      chain.forEach((bmp) => bmp.close());
    }).catch((e) => { console.warn("cover", appid, e); });
  }

  function removeCell(key, cell) {
    cell.cancelled = true;
    cells.delete(key);
    freeSlots.push(cell.slot);
    const n = onWall.get(cell.appid) - 1;
    if (n > 0) onWall.set(cell.appid, n); else onWall.delete(cell.appid);
  }

  // ---------- frame loop ------------------------------------------------------------------------------
  const dir = rad(cfg.motion.directionDeg);
  const planeSpeed = cfg.motion.speedPxPerSec / cfg.camera.scale;   // ≈ screen px/s at the centre
  const vx = Math.cos(dir) * planeSpeed, vy = Math.sin(dir) * planeSpeed;
  // random start position so the wall never opens on the same spot
  let ox = Math.random() * 1e5, oy = Math.random() * 1e5;
  const t0 = performance.now();
  let lastFrame = 0, lastDraw = 0, revealed = false;
  const frameBudget = 1000 / Math.max(1, cfg.performance.maxFps) - 1;
  let frameHandle = 0;

  function syncCells(bs, now) {
    const want = neededCells(bs, ox, oy);
    const keys = new Set();
    for (const [i, j] of want) keys.add(i + "," + j);
    for (const [key, cell] of cells) if (!keys.has(key)) removeCell(key, cell);
    // add in order of distance from the centre so the visible area fills first
    const missing = want.filter(([i, j]) => !cells.has(i + "," + j));
    if (missing.length > 1) {
      const d = ([i, j]) => { const x = i * G.pitchX - ox, y = j * G.pitchY - oy; return x * x + y * y; };
      missing.sort((p, q) => d(p) - d(q));
    }
    for (const [i, j] of missing) addCell(i, j, now);
  }

  function frame(now) {
    if (stopped) return;
    frameHandle = requestAnimationFrame(frame);
    if (now - lastDraw < frameBudget) return;
    lastDraw = now;
    const step = lastFrame ? Math.min(now - lastFrame, MAX_STEP_MS) / 1000 : 0;
    lastFrame = now;
    ox += vx * step; oy += vy * step;

    const t = (now - t0) / 1000;
    const s = cfg.camera.scale * (1 + cfg.camera.zoomAmplitude * Math.sin(t * 2 * Math.PI / cfg.camera.zoomPeriodSec));
    const bs = basis(s);
    syncCells(bs, now);

    let n = 0, pending = 0;
    const inst = G.instances;
    for (const c of cells.values()) {
      if (!c.ready) { pending++; continue; }
      // fade in covers that finish loading after the wall is already on screen
      const alpha = revealed ? Math.min(1, (now - c.readyAt) / 600) : 1;
      inst[n * 4] = c.i * G.pitchX - ox;
      inst[n * 4 + 1] = c.j * G.pitchY - oy;
      inst[n * 4 + 2] = c.slot;
      inst[n * 4 + 3] = alpha;
      n++;
    }
    if (!revealed && (pending === 0 || now - t0 > 1500) && n > 0) {
      revealed = true;
      for (const c of cells.values()) if (c.ready) c.readyAt = 0;
      canvas.classList.add("ready");
    }

    gl.uniform3f(U.uA, bs.a[0], bs.a[1], bs.a[2]);
    gl.uniform3f(U.uB, bs.b[0], bs.b[1], bs.b[2]);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, n * 4);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }

  layout();
  window.__steamGameWallStats = () => ({
    canvas: canvas.width + "x" + canvas.height, posters: G.posters, posterW: Math.round(G.posterW),
    cells: cells.size, capacity: G.capacity, texture: G.texW + "x" + G.texH,
    vramMB: Math.round(G.capacity * G.texW * G.texH * 4 * 4 / 3 / 1048576),
  });
  let resizeTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 150); });
  frameHandle = requestAnimationFrame(frame);

  window.addEventListener("pagehide", () => {
    stopped = true;
    cancelAnimationFrame(frameHandle);
    clearInterval(clockTimer);
    deck.save();
  });
})();
