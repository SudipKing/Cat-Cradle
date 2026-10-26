/* Neon Cat's Cradle - persistent 3D string sculpture.
 * Classic script: exposes CC.sculpture. Renders frozen strands into its own offscreen
 * canvas (WebGL1, Canvas2D fallback); core composites it with 'lighter'.
 */
(function () {
  'use strict';
  window.CC = window.CC || {};

  // ---- tuning ----
  var FOCAL = 900;               // perspective focal length (px)
  var MAX_LAYERS = 60;
  var MAX_VERTS = 65000;          // Uint16 index limit
  var REVEAL_SEC = 0.4;           // draw-on duration
  var SETTLE_SEC = 1.2;           // new layer blends from "as drawn" into the swaying pose
  var YAW_AMP = 25 * Math.PI / 180, YAW_SPEED = 0.42;
  var PITCH_AMP = 7 * Math.PI / 180, PITCH_SPEED = 0.29;
  var HALF_W = 9;                 // ribbon half width (px): ~3px core inside ~14px halo
  var NODE_R = 8;                 // endpoint node radius (px)
  var STRIDE = 9;                 // static floats per vertex: u v t kind r g b birth layer

  var canvas = null, W = 0, H = 0, mode = 'none';
  var gl = null, ctx2d = null, glLost = false;
  var prog = null, bufStatic = null, bufDyn = null, bufIdx = null, loc = {};
  var layers = [];
  var tcx = 0, tcy = 0, tcz = 0;  // target centroid (recomputed on freeze/undo/clear)
  var scx = 0, scy = 0, scz = 0;  // smoothed centroid used for rendering
  var haveCentroid = false;
  var t0 = null, lastT = null;
  var staticDirty = true, nVerts = 0, nIdx = 0;
  var dyn = new Float32Array(0), scratch = new Float32Array(0);
  var cleared = true;

  // ---- shaders ----
  var VS = [
    'attribute vec3 aPos;',      // screen x, y (px), perspective scale
    'attribute vec4 aUVTK;',     // across u, v, t along strand, kind (0 ribbon, 1 node)
    'attribute vec3 aCol;',
    'attribute vec2 aBL;',       // birth time, layer index
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform float uCount;',
    'varying vec2 vUV;',
    'varying float vT;',
    'varying float vKind;',
    'varying vec3 vCol;',
    'varying float vBright;',
    'varying float vReveal;',
    'varying float vFlash;',
    'void main() {',
    '  vec2 c = aPos.xy / uRes * 2.0 - 1.0;',
    '  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);',
    '  float age = max(uTime - aBL.x, 0.0);',
    '  vReveal = clamp(age / ' + REVEAL_SEC.toFixed(3) + ', 0.0, 1.0) * 1.04;',
    '  vFlash = exp(-age * 3.5);',
    '  float rank = uCount - 1.0 - aBL.y;',
    '  float dim = max(0.42, 1.0 - rank * 0.035);',
    '  vBright = dim * clamp(aPos.z, 0.7, 1.35);',
    '  vUV = aUVTK.xy;',
    '  vT = aUVTK.z;',
    '  vKind = aUVTK.w;',
    '  vCol = aCol;',
    '}'
  ].join('\n');

  var FS = [
    'precision mediump float;',
    'varying vec2 vUV;',
    'varying float vT;',
    'varying float vKind;',
    'varying vec3 vCol;',
    'varying float vBright;',
    'varying float vReveal;',
    'varying float vFlash;',
    'void main() {',
    '  float d = vKind < 0.5 ? abs(vUV.x) : length(vUV);',
    '  if (d >= 1.0) discard;',
    '  float vis;',
    '  if (vKind < 0.5) {',
    '    vis = 1.0 - smoothstep(vReveal - 0.03, vReveal, vT);',
    '  } else {',
    '    vis = step(vT, vReveal);',
    '  }',
    '  if (vis <= 0.0) discard;',
    '  float halo = max(exp(-d * d * 4.0) - 0.0183, 0.0);',
    '  float coreW = vKind < 0.5 ? 0.18 : 0.3;',
    '  float core = 1.0 - smoothstep(0.0, coreW, d);',
    // bright "pen tip" travelling along the strand while it draws on
    '  float tip = vKind < 0.5 ? exp(-abs(vT - vReveal) * 30.0) * step(vReveal, 1.0) : 0.0;',
    '  vec3 col = vCol * halo * 0.75 + mix(vCol, vec3(1.0), 0.7) * core;',
    '  col += vec3(1.0) * tip * halo;',
    '  col *= vBright * (1.0 + vFlash * 1.8) * vis;',
    // premultiplied output: alpha >= every channel keeps the canvas valid for drawImage
    '  gl_FragColor = vec4(col, min(max(max(col.r, col.g), col.b), 1.0));',
    '}'
  ].join('\n');

  // ---- helpers ----
  function num(v) { v = +v; return isFinite(v) ? v : 0; }

  function normColors(cols) {
    var out = new Float32Array(9);
    var def = [[0, 240, 255], [255, 43, 214], [255, 230, 0]];
    for (var i = 0; i < 3; i++) {
      var c = (cols && cols[i]) || (cols && cols[cols.length - 1]) || def[i];
      for (var k = 0; k < 3; k++) {
        var v = num(c[k]) / 255;
        out[i * 3 + k] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    return out;
  }

  function cssColor(c, i) {
    return 'rgb(' + Math.round(c[i * 3] * 255) + ',' + Math.round(c[i * 3 + 1] * 255) + ',' + Math.round(c[i * 3 + 2] * 255) + ')';
  }

  function strandVerts(n) { return 2 * n + 8; }
  function strandIdx(n) { return (n - 1) * 6 + 12; }

  function totalVerts() {
    var v = 0;
    for (var i = 0; i < layers.length; i++) v += layers[i].nVerts;
    return v;
  }

  function recomputeCentroid() {
    var sx = 0, sy = 0, sz = 0, n = 0;
    for (var i = 0; i < layers.length; i++) {
      var p = layers[i].pts, m = layers[i].nPts;
      for (var j = 0; j < m; j++) { sx += p[j * 3]; sy += p[j * 3 + 1]; sz += p[j * 3 + 2]; }
      n += m;
    }
    if (n) {
      tcx = sx / n; tcy = sy / n; tcz = sz / n;
      if (!haveCentroid) { scx = tcx; scy = tcy; scz = tcz; haveCentroid = true; }
    } else {
      haveCentroid = false;
    }
  }

  function ensureScratch() {
    var maxPts = 0;
    for (var i = 0; i < layers.length; i++) if (layers[i].nPts > maxPts) maxPts = layers[i].nPts;
    if (scratch.length < maxPts * 3) scratch = new Float32Array(maxPts * 3);
  }

  function changed() {
    recomputeCentroid();
    ensureScratch();
    staticDirty = true;
    if (!layers.length) t0 = null;
  }

  // ---- WebGL setup ----
  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('sculpture shader: ' + log);
    }
    return s;
  }

  function setupGL() {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('sculpture link: ' + gl.getProgramInfoLog(p));
    prog = p;
    loc = {
      aPos: gl.getAttribLocation(p, 'aPos'),
      aUVTK: gl.getAttribLocation(p, 'aUVTK'),
      aCol: gl.getAttribLocation(p, 'aCol'),
      aBL: gl.getAttribLocation(p, 'aBL'),
      uRes: gl.getUniformLocation(p, 'uRes'),
      uTime: gl.getUniformLocation(p, 'uTime'),
      uCount: gl.getUniformLocation(p, 'uCount')
    };
    bufStatic = gl.createBuffer();
    bufDyn = gl.createBuffer();
    bufIdx = gl.createBuffer();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    // Additive. Fragment output is premultiplied (rgb already scaled), so ONE/ONE.
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
    staticDirty = true;
  }

  function makeCanvas() {
    var c = document.createElement('canvas');
    c.width = Math.max(1, W | 0);
    c.height = Math.max(1, H | 0);
    return c;
  }

  function tryWebGL() {
    var c = makeCanvas();
    var opts = { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true, depth: false, stencil: false };
    var g = null;
    try { g = c.getContext('webgl', opts) || c.getContext('experimental-webgl', opts); } catch (e) { g = null; }
    if (!g) return false;
    gl = g;
    try { setupGL(); } catch (e) {
      if (window.console) console.warn(e);
      gl = null;
      return false;
    }
    c.addEventListener('webglcontextlost', function (e) { e.preventDefault(); glLost = true; }, false);
    c.addEventListener('webglcontextrestored', function () {
      try { setupGL(); glLost = false; cleared = false; } catch (e) { fallback2D(); }
    }, false);
    canvas = c;
    mode = 'webgl';
    return true;
  }

  function fallback2D() {
    gl = null;
    canvas = makeCanvas();
    ctx2d = canvas.getContext('2d');
    mode = ctx2d ? '2d' : 'none';
    cleared = false;
  }

  // Rebuild static attributes + indices (only on freeze/undo/clear).
  function rebuildStatic() {
    staticDirty = false;
    nVerts = totalVerts();
    nIdx = 0;
    for (var i = 0; i < layers.length; i++) nIdx += layers[i].nIdx;
    if (!nVerts) return;
    var st = new Float32Array(nVerts * STRIDE);
    var ix = new Uint16Array(nIdx);
    var v = 0, k = 0;
    for (var li = 0; li < layers.length; li++) {
      var L = layers[li], birth = L.birth == null ? 0 : L.birth;
      for (var si = 0; si < L.strands.length; si++) {
        var S = L.strands[si], n = S.n, c = S.cols;
        var base = v;
        for (var j = 0; j < n; j++) {
          var t = j / (n - 1), a, b, f;
          if (t < 0.5) { a = 0; b = 3; f = t * 2; } else { a = 3; b = 6; f = (t - 0.5) * 2; }
          var r = c[a] + (c[b] - c[a]) * f, g = c[a + 1] + (c[b + 1] - c[a + 1]) * f, bl = c[a + 2] + (c[b + 2] - c[a + 2]) * f;
          for (var side = 0; side < 2; side++) {
            var o = v * STRIDE;
            st[o] = side ? 1 : -1; st[o + 1] = 0; st[o + 2] = t; st[o + 3] = 0;
            st[o + 4] = r; st[o + 5] = g; st[o + 6] = bl; st[o + 7] = birth; st[o + 8] = li;
            v++;
          }
          if (j < n - 1) {
            var q = base + j * 2;
            ix[k++] = q; ix[k++] = q + 1; ix[k++] = q + 2;
            ix[k++] = q + 1; ix[k++] = q + 3; ix[k++] = q + 2;
          }
        }
        // endpoint nodes (start: color 0, t=0; end: color 2, t=1)
        for (var e = 0; e < 2; e++) {
          var ci = e ? 6 : 0, nb = v;
          for (var cn = 0; cn < 4; cn++) {
            var oo = v * STRIDE;
            st[oo] = (cn === 1 || cn === 2) ? 1 : -1;
            st[oo + 1] = cn >= 2 ? 1 : -1;
            st[oo + 2] = e; st[oo + 3] = 1;
            st[oo + 4] = c[ci]; st[oo + 5] = c[ci + 1]; st[oo + 6] = c[ci + 2];
            st[oo + 7] = birth; st[oo + 8] = li;
            v++;
          }
          ix[k++] = nb; ix[k++] = nb + 1; ix[k++] = nb + 2;
          ix[k++] = nb; ix[k++] = nb + 2; ix[k++] = nb + 3;
        }
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStatic);
    gl.bufferData(gl.ARRAY_BUFFER, st, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STATIC_DRAW);
    if (dyn.length < nVerts * 3) {
      dyn = new Float32Array(nVerts * 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufDyn);
      gl.bufferData(gl.ARRAY_BUFFER, dyn.byteLength, gl.DYNAMIC_DRAW);
    }
  }

  // ---- projection (shared) ----
  var cY = 1, sY = 0, cP = 1, sP = 0;

  // Projects layer L's points into scratch as [sx, sy, scale] triples.
  function projectLayer(L, t) {
    var p = L.pts, m = L.nPts, out = scratch;
    var age = t - L.birth;
    var k = age >= SETTLE_SEC ? 1 : (age <= 0 ? 0 : age / SETTLE_SEC);
    k = k * k * (3 - 2 * k);
    var minD = FOCAL * 0.25;
    for (var j = 0; j < m; j++) {
      var x = p[j * 3], y = p[j * 3 + 1], z = p[j * 3 + 2];
      var dx = x - scx, dy = y - scy, dz = z - scz;
      // un-project the as-drawn screen offset to 3D at its depth, so zero rotation is identity
      var u = (FOCAL - dz) / FOCAL;
      if (u < 0.25) u = 0.25;
      var X = dx * u, Y = dy * u, Z = dz;
      // yaw around vertical axis
      var X1 = X * cY + Z * sY, Z1 = -X * sY + Z * cY;
      // pitch around horizontal axis
      var Y2 = Y * cP - Z1 * sP, Z2 = Y * sP + Z1 * cP;
      var den = FOCAL - Z2;
      if (den < minD) den = minD;
      var s = FOCAL / den;
      var sx = scx + X1 * s, sy = scy + Y2 * s;
      if (k < 1) { sx = x + (sx - x) * k; sy = y + (sy - y) * k; s = 1 + (s - 1) * k; }
      out[j * 3] = sx; out[j * 3 + 1] = sy; out[j * 3 + 2] = s;
    }
  }

  function updateFrame(t) {
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].birth == null) { layers[i].birth = t; staticDirty = true; }
    }
    if (t0 == null) t0 = layers.length ? layers[0].birth : t;
    var dt = lastT == null ? 0 : t - lastT;
    if (dt < 0 || dt > 0.5) dt = 0.05;
    lastT = t;
    var a = 1 - Math.exp(-dt * 5);
    scx += (tcx - scx) * a; scy += (tcy - scy) * a; scz += (tcz - scz) * a;
    var tt = t - t0;
    var yaw = YAW_AMP * Math.sin(tt * YAW_SPEED);
    var pitch = PITCH_AMP * Math.sin(tt * PITCH_SPEED);
    cY = Math.cos(yaw); sY = Math.sin(yaw);
    cP = Math.cos(pitch); sP = Math.sin(pitch);
  }

  // ---- WebGL render ----
  function renderGL(t) {
    if (staticDirty) rebuildStatic();
    var d = dyn, v = 0;
    for (var li = 0; li < layers.length; li++) {
      var L = layers[li];
      projectLayer(L, t);
      var P = scratch;
      for (var si = 0; si < L.strands.length; si++) {
        var S = L.strands[si], off = S.off, n = S.n, j, o, s, ws;
        for (j = 0; j < n; j++) {
          var i0 = (off + (j > 0 ? j - 1 : 0)) * 3, i1 = (off + (j < n - 1 ? j + 1 : n - 1)) * 3, ic = (off + j) * 3;
          var tx = P[i1] - P[i0], ty = P[i1 + 1] - P[i0 + 1];
          var len = Math.sqrt(tx * tx + ty * ty);
          var nx = 0, ny = 1;
          if (len > 1e-4) { nx = -ty / len; ny = tx / len; }
          s = P[ic + 2];
          ws = s < 0.6 ? 0.6 : s > 1.6 ? 1.6 : s;
          var hw = HALF_W * ws, x = P[ic], y = P[ic + 1];
          o = v * 3;
          d[o] = x - nx * hw; d[o + 1] = y - ny * hw; d[o + 2] = s;
          d[o + 3] = x + nx * hw; d[o + 4] = y + ny * hw; d[o + 5] = s;
          v += 2;
        }
        for (var e = 0; e < 2; e++) {
          var ie = (off + (e ? n - 1 : 0)) * 3;
          var ex = P[ie], ey = P[ie + 1];
          s = P[ie + 2];
          ws = s < 0.6 ? 0.6 : s > 1.6 ? 1.6 : s;
          var r = NODE_R * ws;
          o = v * 3;
          d[o] = ex - r; d[o + 1] = ey - r; d[o + 2] = s;
          d[o + 3] = ex + r; d[o + 4] = ey - r; d[o + 5] = s;
          d[o + 6] = ex + r; d[o + 7] = ey + r; d[o + 8] = s;
          d[o + 9] = ex - r; d[o + 10] = ey + r; d[o + 11] = s;
          v += 4;
        }
      }
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!nIdx) return;
    gl.useProgram(prog);
    gl.uniform2f(loc.uRes, canvas.width, canvas.height);
    gl.uniform1f(loc.uTime, t);
    gl.uniform1f(loc.uCount, layers.length);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufDyn);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, v * 3));
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 12, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufStatic);
    gl.enableVertexAttribArray(loc.aUVTK);
    gl.vertexAttribPointer(loc.aUVTK, 4, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(loc.aCol);
    gl.vertexAttribPointer(loc.aCol, 3, gl.FLOAT, false, STRIDE * 4, 16);
    gl.enableVertexAttribArray(loc.aBL);
    gl.vertexAttribPointer(loc.aBL, 2, gl.FLOAT, false, STRIDE * 4, 28);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx);
    gl.drawElements(gl.TRIANGLES, nIdx, gl.UNSIGNED_SHORT, 0);
  }

  // ---- Canvas2D fallback render ----
  function render2D(t) {
    var g = ctx2d, n = layers.length;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (var li = 0; li < n; li++) {
      var L = layers[li];
      projectLayer(L, t);
      var P = scratch, age = Math.max(0, t - L.birth);
      var reveal = Math.min(1, age / REVEAL_SEC);
      var bright = Math.max(0.42, 1 - (n - 1 - li) * 0.035) * (1 + Math.exp(-age * 3.5) * 1.2);
      for (var si = 0; si < L.strands.length; si++) {
        var S = L.strands[si], off = S.off, cnt = S.n;
        var last = reveal * (cnt - 1), whole = Math.floor(last);
        var b = off * 3;
        g.beginPath();
        g.moveTo(P[b], P[b + 1]);
        for (var j = 1; j <= whole; j++) g.lineTo(P[(off + j) * 3], P[(off + j) * 3 + 1]);
        var ex = P[(off + whole) * 3], ey = P[(off + whole) * 3 + 1];
        if (whole < cnt - 1) {
          var f = last - whole, q = (off + whole + 1) * 3;
          ex = ex + (P[q] - ex) * f; ey = ey + (P[q + 1] - ey) * f;
          g.lineTo(ex, ey);
        }
        var e = (off + cnt - 1) * 3;
        var grad = g.createLinearGradient(P[b], P[b + 1], P[e], P[e + 1]);
        grad.addColorStop(0, S.css[0]); grad.addColorStop(0.5, S.css[1]); grad.addColorStop(1, S.css[2]);
        var sc = P[(off + (cnt >> 1)) * 3 + 2];
        sc = sc < 0.6 ? 0.6 : sc > 1.6 ? 1.6 : sc;
        g.strokeStyle = grad;
        g.globalAlpha = Math.min(1, 0.22 * bright);
        g.lineWidth = 14 * sc;
        g.stroke();
        g.globalAlpha = Math.min(1, 0.55 * bright);
        g.lineWidth = 4.5 * sc;
        g.stroke();
        g.strokeStyle = '#ffffff';
        g.globalAlpha = Math.min(1, 0.75 * bright);
        g.lineWidth = 1.6 * sc;
        g.stroke();
        // endpoint nodes
        g.fillStyle = '#ffffff';
        g.globalAlpha = Math.min(1, 0.8 * bright);
        g.beginPath();
        g.arc(P[b], P[b + 1], 2.6 * sc, 0, Math.PI * 2);
        if (reveal >= 1) { g.moveTo(P[e] + 2.6 * sc, P[e + 1]); g.arc(P[e], P[e + 1], 2.6 * sc, 0, Math.PI * 2); }
        g.fill();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  function clearSurface() {
    if (mode === 'webgl' && gl && !glLost) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else if (mode === '2d' && ctx2d) {
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // ---- public API ----
  CC.sculpture = {
    get canvas() { return canvas; },
    get count() { return layers.length; },
    get mode() { return mode; },

    init: function (width, height) {
      W = Math.max(1, num(width) | 0);
      H = Math.max(1, num(height) | 0);
      if (canvas) { this.resize(W, H); return; }
      if (!tryWebGL()) fallback2D();
      cleared = false;
    },

    resize: function (width, height) {
      W = Math.max(1, num(width) | 0);
      H = Math.max(1, num(height) | 0);
      if (!canvas) return;
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      cleared = false;
    },

    freeze: function (strands) {
      if (!strands || !strands.length) return;
      var list = [], total = 0, i, j;
      for (i = 0; i < strands.length; i++) {
        var s = strands[i], pts = s && s.points;
        if (!pts || pts.length < 2) continue;
        if (2 * pts.length + 8 > MAX_VERTS) continue;
        list.push(s);
        total += pts.length;
      }
      if (!list.length) return;
      var arr = new Float32Array(total * 3), meta = [], off = 0, nv = 0, ni = 0;
      for (i = 0; i < list.length; i++) {
        var P = list[i].points, n = P.length;
        for (j = 0; j < n; j++) {
          var p = P[j] || {};
          arr[(off + j) * 3] = num(p.x);
          arr[(off + j) * 3 + 1] = num(p.y);
          arr[(off + j) * 3 + 2] = num(p.z);
        }
        var cols = normColors(list[i].colors);
        meta.push({ off: off, n: n, cols: cols, css: [cssColor(cols, 0), cssColor(cols, 1), cssColor(cols, 2)] });
        off += n;
        nv += strandVerts(n);
        ni += strandIdx(n);
      }
      layers.push({ pts: arr, nPts: total, strands: meta, birth: null, nVerts: nv, nIdx: ni });
      while (layers.length > MAX_LAYERS) layers.shift();
      while (layers.length > 1 && totalVerts() > MAX_VERTS) layers.shift();
      changed();
    },

    undo: function () {
      if (!layers.length) return;
      layers.pop();
      changed();
    },

    clear: function () {
      if (!layers.length) return;
      layers.length = 0;
      changed();
    },

    render: function (timeSec) {
      if (!canvas) return;
      var t = num(timeSec);
      if (!layers.length) {
        if (!cleared) { clearSurface(); cleared = true; }
        lastT = t;
        return;
      }
      cleared = false;
      updateFrame(t);
      try {
        if (mode === 'webgl') { if (gl && !glLost) renderGL(t); }
        else if (mode === '2d') render2D(t);
      } catch (e) {
        if (window.console) console.warn('sculpture render failed', e);
      }
    }
  };
})();
