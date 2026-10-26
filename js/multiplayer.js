/* Neon Cat's Cradle — multiplayer link (PeerJS / WebRTC data channel).
 * Classic script. Exposes CC.net. Requires global `Peer` (PeerJS 1.5.x) loaded first;
 * if missing, the module still loads and reports status 'error'.
 */
window.CC = window.CC || {};
(function () {
  'use strict';

  var PROTO = 1;                       // bump when message formats change
  var ID_PREFIX = 'catcradle-';
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 5;
  var HAND_INTERVAL_MS = 50;           // ~20 Hz
  var JOIN_TIMEOUT_MS = 15000;
  var MAX_BUFFERED = 256 * 1024;       // skip hand frames if the channel is backed up
  var EVENT_TYPES = { burst: 1, freeze: 1, undo: 1, clear: 1 };

  // ---------------------------------------------------------------- hand codec
  // Packet (little endian):
  //   u8 magic 0x48 'H' | u8 flags (bit0 = L present, bit1 = R present) | u16 version | u32 seq
  //   then for each present hand (L first): 21 x [u16 x, u16 y, i16 z]
  //   x,y: [-0.5, 1.5] -> [0, 65535]   (step ~3e-5)
  //   z:   z * 4096 clamped to int16   (range +/-8, step ~2.4e-4)
  var MAGIC = 0x48, NPTS = 21, HDR = 8, HAND_BYTES = NPTS * 6;
  var XY_MIN = -0.5, XY_SPAN = 2, Z_SCALE = 4096;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v) { v = +v; return isFinite(v) ? v : 0; }
  function validHand(h) { return h && h.length >= NPTS; }

  function encodeHands(L, R, seq) {
    var hasL = validHand(L), hasR = validHand(R);
    var buf = new ArrayBuffer(HDR + (hasL ? HAND_BYTES : 0) + (hasR ? HAND_BYTES : 0));
    var dv = new DataView(buf);
    dv.setUint8(0, MAGIC);
    dv.setUint8(1, (hasL ? 1 : 0) | (hasR ? 2 : 0));
    dv.setUint16(2, PROTO, true);
    dv.setUint32(4, seq >>> 0, true);
    var off = HDR;
    [hasL ? L : null, hasR ? R : null].forEach(function (h) {
      if (!h) return;
      for (var i = 0; i < NPTS; i++) {
        var p = h[i] || {};
        dv.setUint16(off, Math.round(clamp((num(p.x) - XY_MIN) / XY_SPAN, 0, 1) * 65535), true);
        dv.setUint16(off + 2, Math.round(clamp((num(p.y) - XY_MIN) / XY_SPAN, 0, 1) * 65535), true);
        dv.setInt16(off + 4, Math.round(clamp(num(p.z) * Z_SCALE, -32768, 32767)), true);
        off += 6;
      }
    });
    return buf;
  }

  function toArrayBuffer(data) {
    if (typeof ArrayBuffer === 'undefined' || !data) return null;
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return null;
  }

  // returns {seq, L, R} or null if malformed
  function decodeHands(data) {
    var buf = toArrayBuffer(data);
    if (!buf || buf.byteLength < HDR) return null;
    var dv = new DataView(buf);
    if (dv.getUint8(0) !== MAGIC) return null;
    var flags = dv.getUint8(1);
    var need = HDR + ((flags & 1) ? HAND_BYTES : 0) + ((flags & 2) ? HAND_BYTES : 0);
    if (buf.byteLength < need) return null;
    var off = HDR;
    function readHand() {
      var h = new Array(NPTS);
      for (var i = 0; i < NPTS; i++) {
        h[i] = {
          x: dv.getUint16(off, true) / 65535 * XY_SPAN + XY_MIN,
          y: dv.getUint16(off + 2, true) / 65535 * XY_SPAN + XY_MIN,
          z: dv.getInt16(off + 4, true) / Z_SCALE
        };
        off += 6;
      }
      return h;
    }
    var L = (flags & 1) ? readHand() : null;
    var R = (flags & 2) ? readHand() : null;
    return { seq: dv.getUint32(4, true), L: L, R: R };
  }

  // ------------------------------------------------------- event sanitizing
  function sanitizeEvent(type, d) {
    d = d || {};
    if (type === 'burst') return { x: num(d.x), y: num(d.y), u: num(d.u) };
    if (type === 'freeze') {
      var strands = Array.isArray(d.strands) ? d.strands.slice(0, 64) : [];
      return {
        strands: strands.map(function (s) {
          s = s || {};
          var pts = Array.isArray(s.points) ? s.points.slice(0, 512) : [];
          var cols = Array.isArray(s.colors) ? s.colors.slice(0, 8) : [];
          return {
            points: pts.map(function (p) { p = p || {}; return { x: num(p.x), y: num(p.y), z: num(p.z) }; }),
            colors: cols.map(function (c) {
              c = Array.isArray(c) ? c : [];
              return [clamp(num(c[0]), 0, 255), clamp(num(c[1]), 0, 255), clamp(num(c[2]), 0, 255)];
            })
          };
        })
      };
    }
    return {};
  }

  // ------------------------------------------------------------------ state
  var peer = null, conn = null, role = null;   // role: 'host' | 'guest' | null
  var sendSeq = 0, lastRecvSeq = -1, lastHandSend = 0;
  var listeners = {};
  var joinTimer = null;
  var helloOk = false;

  var net = {
    status: 'offline',
    roomCode: null,
    remote: null,
    protocol: PROTO,
    _codec: { encodeHands: encodeHands, decodeHands: decodeHands } // exposed for tests
  };

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function emit(type, payload) {
    var arr = listeners[type];
    if (!arr) return;
    arr.slice().forEach(function (cb) {
      try { cb(payload); } catch (e) { if (typeof console !== 'undefined') console.error('[CC.net] listener error', e); }
    });
  }

  function setStatus(s) {
    if (net.status === s) { renderUI(); return; }
    net.status = s;
    renderUI();
    emit('status', s);
  }

  function hasPeerLib() { return typeof Peer === 'function'; }

  function randomCode() {
    var out = '';
    var rnd = null;
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) { rnd = new Uint32Array(CODE_LEN); crypto.getRandomValues(rnd); }
    } catch (e) { rnd = null; }
    for (var i = 0; i < CODE_LEN; i++) {
      var r = rnd ? rnd[i] : Math.floor(Math.random() * 4294967296);
      out += ALPHABET[r % ALPHABET.length];
    }
    return out;
  }

  function normalizeCode(code) {
    return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function destroyPeer() {
    clearTimeout(joinTimer); joinTimer = null;
    if (conn) { var c = conn; conn = null; try { c.close(); } catch (e) {} }
    if (peer) { var p = peer; peer = null; try { p.destroy(); } catch (e) {} }
    net.remote = null;
    helloOk = false;
  }

  function safeSend(c, msg) {
    try { if (c && c.open) { c.send(msg); return true; } } catch (e) {}
    return false;
  }

  // ------------------------------------------------------------ connection
  function attachConn(c, onReady, onFail) {
    conn = c;
    lastRecvSeq = -1;
    sendSeq = 0;
    helloOk = false;

    c.on('open', function () {
      if (conn !== c) return;
      safeSend(c, { t: 'hello', v: PROTO, app: 'catcradle' });
    });

    c.on('data', function (data) {
      if (conn !== c) return;
      // binary hand packet
      var buf = toArrayBuffer(data);
      if (buf) {
        if (!helloOk) return;
        var h = decodeHands(buf);
        if (!h) return;
        if (lastRecvSeq >= 0 && h.seq <= lastRecvSeq) return;   // stale / out of order
        lastRecvSeq = h.seq;
        net.remote = { L: h.L, R: h.R, lastUpdate: now() };
        return;
      }
      if (!data || typeof data !== 'object') return;
      switch (data.t) {
        case 'hello':
          if (data.v !== PROTO || data.app !== 'catcradle') {
            safeSend(c, { t: 'bye', reason: 'version', v: PROTO });
            fail('Version mismatch (them v' + data.v + ', us v' + PROTO + '). Reload both pages.');
            return;
          }
          if (helloOk) return;
          helloOk = true;
          clearTimeout(joinTimer); joinTimer = null;
          net.remote = { L: null, R: null, lastUpdate: now() };
          setStatus('connected');
          toast('Linked with partner.', 'ok');
          if (onReady) { onReady(); onReady = null; onFail = null; }
          return;
        case 'busy':
          fail('Room is full.');
          return;
        case 'bye':
          if (data.reason === 'version') fail('Partner runs a different version (v' + data.v + '). Reload both pages.');
          return;
        case 'ev':
          if (!helloOk || !EVENT_TYPES[data.type]) return;
          emit(data.type, sanitizeEvent(data.type, data.d));
          return;
      }
    });

    c.on('close', function () {
      if (conn !== c) return;
      lostPartner('Partner disconnected.');
    });
    c.on('error', function (err) {
      if (conn !== c) return;
      lostPartner('Link error: ' + ((err && err.type) || (err && err.message) || 'unknown'));
    });

    function fail(msg) {
      var f = onFail; onReady = null; onFail = null;
      if (f) { f(new Error(msg)); }
      if (role === 'host') {
        dropConn();                  // keep the room open for a compatible partner
        setStatus('hosting');
        toast(msg, 'err', true);
      } else {
        role = null;
        destroyPeer();
        net.roomCode = null;
        setStatus('error');
        toast(msg, 'err', true);
      }
    }
  }

  function dropConn() {
    if (conn) { var c = conn; conn = null; try { c.close(); } catch (e) {} }
    net.remote = null;
    helloOk = false;
  }

  function lostPartner(msg) {
    dropConn();
    if (role === 'host' && peer && !peer.destroyed) {
      setStatus('hosting');
      toast(msg + ' Waiting for a new partner…', 'warn', true);
    } else {
      role = null;
      destroyPeer();
      net.roomCode = null;
      setStatus('offline');
      toast(msg, 'warn', true);
    }
  }

  // ------------------------------------------------------------- public API
  net.host = function () {
    try {
      if (!hasPeerLib()) { setStatus('error'); toast('PeerJS failed to load — multiplayer unavailable.', 'err', true); return Promise.reject(new Error('PeerJS not loaded')); }
      if (role === 'host' && peer && net.roomCode && (net.status === 'hosting' || net.status === 'connected')) {
        return Promise.resolve(net.roomCode);
      }
      net.leave(true);
      role = 'host';
      setStatus('connecting');
      toast('Opening room…');
      return new Promise(function (resolve, reject) {
        var attempts = 0;
        function tryOpen() {
          attempts++;
          var code = randomCode();
          var p;
          try { p = new Peer(ID_PREFIX + code, { debug: 1 }); }
          catch (e) { role = null; setStatus('error'); toast('Could not create peer: ' + e.message, 'err', true); reject(e); return; }
          peer = p;
          var opened = false;
          p.on('open', function () {
            if (peer !== p) return;
            opened = true;
            net.roomCode = code;
            setStatus('hosting');
            toast('Room open. Share the code or link.', 'ok');
            resolve(code);
          });
          p.on('connection', function (c) {
            if (peer !== p) { try { c.close(); } catch (e) {} return; }
            if (conn) {
              c.on('open', function () { safeSend(c, { t: 'busy' }); setTimeout(function () { try { c.close(); } catch (e) {} }, 500); });
              return;
            }
            attachConn(c, null, null);
          });
          p.on('disconnected', function () {
            // lost the broker; existing data channel can survive. Try to re-register the id.
            if (peer !== p || p.destroyed) return;
            try { p.reconnect(); } catch (e) {}
          });
          p.on('error', function (err) {
            if (peer !== p) return;
            var type = err && err.type;
            if (!opened && type === 'unavailable-id' && attempts < 6) {
              try { p.destroy(); } catch (e) {}
              peer = null;
              tryOpen();
              return;
            }
            if (!opened) {
              role = null;
              destroyPeer();
              net.roomCode = null;
              setStatus('error');
              toast('Could not open room: ' + (type || (err && err.message) || 'error'), 'err', true);
              reject(err instanceof Error ? err : new Error(String(type)));
              return;
            }
            // errors after open: network/server hiccups. Keep hosting if possible.
            if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
              toast('Broker connection trouble (' + type + ').', 'warn');
            } else {
              toast('Peer error: ' + (type || 'unknown'), 'warn');
            }
          });
        }
        tryOpen();
      });
    } catch (e) {
      try { setStatus('error'); } catch (e2) {}
      return Promise.reject(e);
    }
  };

  net.join = function (code) {
    try {
      code = normalizeCode(code);
      if (!hasPeerLib()) { setStatus('error'); toast('PeerJS failed to load — multiplayer unavailable.', 'err', true); return Promise.reject(new Error('PeerJS not loaded')); }
      if (code.length < 3) { toast('Enter a room code.', 'warn'); return Promise.reject(new Error('bad code')); }
      net.leave(true);
      role = 'guest';
      net.roomCode = code;
      setStatus('connecting');
      toast('Joining ' + code + '…');
      return new Promise(function (resolve, reject) {
        var settled = false;
        function ok() { if (settled) return; settled = true; resolve(); }
        function bad(err, msg) {
          if (settled) return; settled = true;
          role = null;
          destroyPeer();
          net.roomCode = null;
          setStatus(net.status === 'error' ? 'error' : 'offline');
          if (msg) toast(msg, 'err', true);
          reject(err);
        }
        var p;
        try { p = new Peer({ debug: 1 }); }
        catch (e) { bad(e, 'Could not create peer: ' + e.message); return; }
        peer = p;
        joinTimer = setTimeout(function () { bad(new Error('timeout'), 'Timed out joining ' + code + '.'); }, JOIN_TIMEOUT_MS);
        p.on('open', function () {
          if (peer !== p) return;
          var c;
          try { c = p.connect(ID_PREFIX + code, { reliable: true, serialization: 'binary', metadata: { v: PROTO } }); }
          catch (e) { bad(e, 'Could not connect: ' + e.message); return; }
          if (!c) { bad(new Error('connect failed'), 'Could not connect.'); return; }
          attachConn(c, ok, function (err) { settled = true; reject(err); });
        });
        p.on('disconnected', function () {
          // broker gone; data channel may still be alive. Nothing else needs the broker as guest.
        });
        p.on('error', function (err) {
          if (peer !== p) return;
          var type = err && err.type;
          if (!settled) {
            bad(err instanceof Error ? err : new Error(String(type)),
              type === 'peer-unavailable' ? 'Room ' + code + ' not found.' : 'Join failed: ' + (type || 'error'));
          } else if (type === 'peer-unavailable' || type === 'network') {
            lostPartner('Connection lost (' + type + ').');
          }
        });
      });
    } catch (e) {
      try { setStatus('error'); } catch (e2) {}
      return Promise.reject(e);
    }
  };

  net.leave = function (quiet) {
    try {
      if (conn) safeSend(conn, { t: 'bye', reason: 'leave' });
      role = null;
      destroyPeer();
      net.roomCode = null;
      if (net.status !== 'error' || quiet !== true) setStatus(hasPeerLib() ? 'offline' : 'error');
      if (quiet !== true) toast('Left the room.');
    } catch (e) {}
  };

  net.sendHands = function (L, R) {
    try {
      if (!conn || !helloOk || !conn.open) return;
      var t = now();
      if (t - lastHandSend < HAND_INTERVAL_MS) return;
      var dc = conn.dataChannel;
      if (dc && dc.bufferedAmount > MAX_BUFFERED) return;
      lastHandSend = t;
      sendSeq = (sendSeq + 1) >>> 0;
      conn.send(encodeHands(L, R, sendSeq));
    } catch (e) {}
  };

  net.sendEvent = function (type, data) {
    try {
      if (!EVENT_TYPES[type] || !conn || !helloOk) return false;
      return safeSend(conn, { t: 'ev', type: type, d: sanitizeEvent(type, data) });
    } catch (e) { return false; }
  };

  net.on = function (type, cb) {
    try {
      if (typeof cb !== 'function') return function () {};
      (listeners[type] = listeners[type] || []).push(cb);
      return function off() {
        var arr = listeners[type]; if (!arr) return;
        var i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1);
      };
    } catch (e) { return function () {}; }
  };

  net.togglePanel = function (force) {
    try {
      buildUI();
      if (!ui.root) return;
      var show = typeof force === 'boolean' ? force : ui.root.classList.contains('cc-hidden');
      ui.root.classList.toggle('cc-hidden', !show);
      if (show && ui.input && !net.roomCode) { try { ui.input.focus({ preventScroll: true }); } catch (e) {} }
    } catch (e) {}
  };

  // -------------------------------------------------------------------- UI
  var ui = { root: null };
  var toastTimer = null;

  var CSS = [
    '#cc-net{position:fixed;right:16px;bottom:16px;z-index:50;width:250px;font:12px/1.6 "Consolas","SF Mono","Menlo",monospace;',
    ' letter-spacing:.08em;color:#cfefff;padding:12px 14px;border:1px solid rgba(0,240,255,.35);border-radius:6px;',
    ' background:rgba(2,6,20,.72);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);text-shadow:0 0 6px rgba(0,240,255,.8);',
    ' box-shadow:0 0 18px rgba(0,240,255,.12);transition:opacity .25s,transform .25s;}',
    '#cc-net.cc-hidden{opacity:0;pointer-events:none;transform:translateY(8px);}',
    '#cc-net *{box-sizing:border-box;font-family:inherit;}',
    '#cc-net .cc-title{display:flex;justify-content:space-between;align-items:center;color:#00f0ff;letter-spacing:.25em;margin-bottom:6px;}',
    '#cc-net .cc-title span{color:#ff2bd6;text-shadow:0 0 6px rgba(255,43,214,.9);cursor:pointer;letter-spacing:0;padding:0 2px;}',
    '#cc-net .cc-status{margin-bottom:8px;}',
    '#cc-net .cc-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:#456;vertical-align:middle;}',
    '#cc-net[data-status=connecting] .cc-dot,#cc-net[data-status=hosting] .cc-dot{background:#ffe600;box-shadow:0 0 8px #ffe600;}',
    '#cc-net[data-status=connected] .cc-dot{background:#00f0ff;box-shadow:0 0 8px #00f0ff;}',
    '#cc-net[data-status=error] .cc-dot{background:#ff2bd6;box-shadow:0 0 8px #ff2bd6;}',
    '#cc-net .cc-k{color:#ffe600;text-shadow:0 0 6px rgba(255,230,0,.8);}',
    '#cc-net button{cursor:pointer;background:rgba(0,240,255,.06);color:#00f0ff;border:1px solid rgba(0,240,255,.45);border-radius:4px;',
    ' padding:4px 10px;font-size:12px;letter-spacing:.12em;text-shadow:0 0 6px rgba(0,240,255,.8);transition:background .15s,box-shadow .15s;}',
    '#cc-net button:hover{background:rgba(0,240,255,.16);box-shadow:0 0 10px rgba(0,240,255,.35);}',
    '#cc-net button:disabled{opacity:.35;cursor:default;box-shadow:none;}',
    '#cc-net button.cc-mag{color:#ff2bd6;border-color:rgba(255,43,214,.5);background:rgba(255,43,214,.06);text-shadow:0 0 6px rgba(255,43,214,.9);}',
    '#cc-net button.cc-mag:hover{background:rgba(255,43,214,.16);box-shadow:0 0 10px rgba(255,43,214,.35);}',
    '#cc-net .cc-row{display:flex;gap:6px;margin:6px 0;align-items:center;}',
    '#cc-net input{flex:1;min-width:0;background:rgba(0,0,0,.35);color:#ffe600;border:1px solid rgba(255,230,0,.4);border-radius:4px;',
    ' padding:4px 8px;font-size:13px;letter-spacing:.3em;text-transform:uppercase;text-shadow:0 0 6px rgba(255,230,0,.8);outline:none;}',
    '#cc-net input:focus{box-shadow:0 0 10px rgba(255,230,0,.35);}',
    '#cc-net .cc-room{display:none;margin:8px 0;padding:8px;border:1px dashed rgba(255,43,214,.45);border-radius:4px;text-align:center;}',
    '#cc-net .cc-room.cc-on{display:block;}',
    '#cc-net .cc-code{font-size:28px;letter-spacing:.3em;color:#ff2bd6;text-shadow:0 0 12px rgba(255,43,214,.95);padding-left:.3em;user-select:all;}',
    '#cc-net .cc-link{font-size:10px;letter-spacing:0;word-break:break-all;color:#8fb8c8;text-shadow:none;margin:4px 0;user-select:all;}',
    '#cc-net .cc-msg{min-height:1.6em;font-size:11px;margin-top:6px;color:#8fb8c8;text-shadow:none;}',
    '#cc-net .cc-msg.ok{color:#00f0ff;text-shadow:0 0 6px rgba(0,240,255,.8);}',
    '#cc-net .cc-msg.warn{color:#ffe600;text-shadow:0 0 6px rgba(255,230,0,.8);}',
    '#cc-net .cc-msg.err{color:#ff2bd6;text-shadow:0 0 6px rgba(255,43,214,.9);}',
    '#cc-net .cc-hint{font-size:10px;color:#5f8796;text-shadow:none;margin-top:4px;}'
  ].join('\n');

  var STATUS_TEXT = {
    offline: 'OFFLINE',
    connecting: 'CONNECTING…',
    hosting: 'HOSTING — waiting for partner',
    connected: 'CONNECTED',
    error: 'ERROR'
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function shareLink(code) {
    try { return location.origin + location.pathname + '?room=' + code; } catch (e) { return '?room=' + code; }
  }

  function buildUI() {
    if (ui.root) return;
    if (typeof document === 'undefined' || !document.body || !document.createElement) return;
    try {
      var style = el('style');
      style.id = 'cc-net-style';
      style.textContent = CSS;
      (document.head || document.body).appendChild(style);

      var root = el('div', 'cc-hidden');
      root.id = 'cc-net';
      root.setAttribute('data-status', net.status);

      var title = el('div', 'cc-title');
      title.appendChild(el('div', null, 'LINK'));
      var close = el('span', null, '×');
      close.title = 'Hide (M)';
      close.addEventListener('click', function () { net.togglePanel(false); });
      title.appendChild(close);
      root.appendChild(title);

      var status = el('div', 'cc-status');
      var dot = el('span', 'cc-dot');
      var statusText = el('span', null, '');
      status.appendChild(dot); status.appendChild(statusText);
      root.appendChild(status);

      var hostRow = el('div', 'cc-row');
      var hostBtn = el('button', null, '[HOST]');
      hostBtn.addEventListener('click', function () { net.host().catch(function () {}); });
      hostRow.appendChild(hostBtn);
      root.appendChild(hostRow);

      var room = el('div', 'cc-room');
      room.appendChild(el('div', 'cc-hint', 'ROOM CODE'));
      var codeEl = el('div', 'cc-code', '');
      room.appendChild(codeEl);
      var linkEl = el('div', 'cc-link', '');
      room.appendChild(linkEl);
      var copyBtn = el('button', 'cc-mag', '[COPY LINK]');
      copyBtn.addEventListener('click', function () {
        if (!net.roomCode) return;
        var link = shareLink(net.roomCode);
        var done = function () { toast('Link copied.', 'ok'); };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(done, function () { fallbackCopy(link) ? done() : toast('Copy failed — select the link.', 'warn'); });
          } else if (fallbackCopy(link)) done(); else toast('Copy failed — select the link.', 'warn');
        } catch (e) { toast('Copy failed — select the link.', 'warn'); }
      });
      room.appendChild(copyBtn);
      root.appendChild(room);

      var joinRow = el('div', 'cc-row');
      var input = el('input');
      input.type = 'text';
      input.maxLength = 8;
      input.placeholder = 'CODE';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'Room code');
      var joinBtn = el('button', null, '[JOIN]');
      function doJoin() { net.join(input.value).catch(function () {}); }
      joinBtn.addEventListener('click', doJoin);
      ['keydown', 'keyup', 'keypress'].forEach(function (ev) {
        input.addEventListener(ev, function (e) {
          e.stopPropagation();
          if (ev === 'keydown' && e.key === 'Enter') { e.preventDefault(); doJoin(); }
          if (ev === 'keydown' && e.key === 'Escape') { input.blur(); }
        });
      });
      joinRow.appendChild(input); joinRow.appendChild(joinBtn);
      root.appendChild(joinRow);

      var leaveRow = el('div', 'cc-row');
      var leaveBtn = el('button', 'cc-mag', '[LEAVE]');
      leaveBtn.addEventListener('click', function () { net.leave(); });
      leaveRow.appendChild(leaveBtn);
      root.appendChild(leaveRow);

      var msg = el('div', 'cc-msg', '');
      root.appendChild(msg);
      root.appendChild(el('div', 'cc-hint', 'M to hide · peer-to-peer via PeerJS'));

      document.body.appendChild(root);
      ui = { root: root, statusText: statusText, hostBtn: hostBtn, room: room, codeEl: codeEl, linkEl: linkEl,
             input: input, joinBtn: joinBtn, leaveBtn: leaveBtn, msg: msg };

      // ?room=CODE -> open panel and prefill (no auto-join)
      try {
        var q = new URLSearchParams(location.search).get('room');
        if (q) { input.value = normalizeCode(q).slice(0, 8); root.classList.remove('cc-hidden'); toast('Press JOIN to link with room ' + input.value + '.', 'warn'); }
      } catch (e) {}

      if (!hasPeerLib()) { net.status = 'error'; toast('PeerJS failed to load — multiplayer unavailable.', 'err'); }
      renderUI();
    } catch (e) { ui = { root: null }; }
  }

  function fallbackCopy(text) {
    try {
      var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  function renderUI() {
    if (!ui.root) return;
    try {
      var s = net.status;
      ui.root.setAttribute('data-status', s);
      ui.statusText.textContent = STATUS_TEXT[s] || s;
      var hosting = role === 'host' && net.roomCode && (s === 'hosting' || s === 'connected');
      ui.room.classList.toggle('cc-on', !!hosting);
      ui.codeEl.textContent = hosting ? net.roomCode : '';
      ui.linkEl.textContent = hosting ? shareLink(net.roomCode) : '';
      var busy = s === 'connecting' || s === 'hosting' || s === 'connected';
      var noLib = !hasPeerLib();
      ui.hostBtn.disabled = busy || noLib;
      ui.joinBtn.disabled = busy || noLib;
      ui.input.disabled = busy || noLib;
      ui.leaveBtn.disabled = !busy && !peer;
    } catch (e) {}
  }

  function toast(text, kind, reveal) {
    if (typeof console !== 'undefined' && kind === 'err') console.warn('[CC.net]', text);
    if (!ui.root) return;
    try {
      ui.msg.textContent = text;
      ui.msg.className = 'cc-msg' + (kind ? ' ' + kind : '');
      if (reveal) ui.root.classList.remove('cc-hidden');
      clearTimeout(toastTimer);
      if (kind !== 'err') toastTimer = setTimeout(function () { if (ui.msg) { ui.msg.textContent = ''; ui.msg.className = 'cc-msg'; } }, 6000);
    } catch (e) {}
  }

  // ------------------------------------------------------------------ init
  if (!hasPeerLib()) net.status = 'error';

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
    else buildUI();
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', function () { try { if (conn) safeSend(conn, { t: 'bye', reason: 'leave' }); destroyPeer(); } catch (e) {} });
  }

  CC.net = net;
})();
