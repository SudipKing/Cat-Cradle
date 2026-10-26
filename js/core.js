// Neon Cat's Cradle — core: camera, hand tracking, strings, particles, adaptive quality.
// Optional modules (loaded before this file) plug in through window.CC:
//   CC.audio (js/audio.js), CC.sculpture (js/sculpture.js), CC.net (js/multiplayer.js)
window.CC = window.CC || {};

// ---------- Config ----------
const MP_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240';
const TIPS = [4, 8, 12, 16, 20];
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
               [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const PALM = [0, 1, 5, 9, 13, 17];
const PALETTE = [[0, 240, 255], [255, 43, 214], [255, 230, 0]]; // cyan, magenta, yellow
const SPRITE_STEPS = 24;
const STRAND_SAMPLES = 28;

// Quality tiers, stepped automatically by the perf monitor. Model complexity 0 is MediaPipe's
// fast/lite model; procW is the width of the downscaled frame fed to MediaPipe and drawn as background.
// Visual effects go first (MED); the lite model and smaller frame track fast hands worse, so
// they are the last resort (LOW).
const TIERS = [
  { name: 'LOW',  model: 0, procW: 480, blur: false, maxParticles: 250, burstN: 20 },
  { name: 'MED',  model: 1, procW: 640, blur: false, maxParticles: 400, burstN: 30 },
  { name: 'HIGH', model: 1, procW: 640, blur: true,  maxParticles: 700, burstN: 46 },
];
const HAND_HOLD_MS = 300;   // keep a hand that tracking briefly lost (fast motion) before fading it
const FREEZE_DELAY_MS = 2400;
const FPS_LOW = 24, FPS_HIGH = 45;
const POOL_SIZE = TIERS[TIERS.length - 1].maxParticles;

// ---------- State ----------
let video, hands, ctx, proc, procCtx;
let busy = false, modelReady = false, frameFresh = false, lastVideoTime = -1, procKey = '';
let fit = { ox: 0, oy: 0, w: 1, h: 1 };
let tierIdx = TIERS.length - 1;
let sprites = [], overlayCanvas, bgCanvas, cleanMode = false;
let freezeAt = 0, toastTimer = 0;
let qualityLock = null; // null = auto, otherwise a TIERS index pinned with the Q key
const perf = { frames: 0, acc: 0, fps: 60, lowSecs: 0, highSecs: 0, lastSwitch: 0, lastUp: 0, upBlockedUntil: 0 };

const makeHand = () => ({ target: null, pts: null, presence: 0, depth: 0, lastSeen: 0 });
// L/R = local hands, RL/RR = remote partner's hands (multiplayer)
const handState = { L: makeHand(), R: makeHand(), RL: makeHand(), RR: makeHand() };

const makeSprings = () => TIPS.map(() => ({
  init: false, mx: 0, my: 0, vx: 0, vy: 0, rest: 0, touching: false, lastBurst: 0,
  active: false, tension: 0, slack: 0, speed: 0,
  drawn: false, ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, za: 0, zb: 0,
  c0: [0, 0, 0], c1: [0, 0, 0], c2: [0, 0, 0],
}));
const springs = { local: makeSprings(), remote: makeSprings(), crossA: makeSprings(), crossB: makeSprings() };
// Cross strings join each player's hand to the partner's opposite hand, so both players see the same set.
// touch: 'broadcast' = detect + send to partner, 'local' = detect only here, 'none' = partner detects it.
const PAIRS = [
  { set: 'local',  a: 'L',  b: 'R',  hue: 0,    main: true,  touch: 'broadcast' },
  { set: 'remote', a: 'RL', b: 'RR', hue: 0.5,  main: true,  touch: 'none' },
  { set: 'crossA', a: 'RL', b: 'R',  hue: 0.25, main: false, touch: 'local' },
  { set: 'crossB', a: 'L',  b: 'RR', hue: 0.25, main: false, touch: 'local' },
];

// Particle pool: fixed objects, swap-remove on death, so bursts never allocate (no GC stutter).
const pool = Array.from({ length: POOL_SIZE }, () =>
  ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, decay: 0, u: 0, size: 0, ring: false, r: 0 }));
let liveCount = 0;

const $ = id => document.getElementById(id);

// ---------- Color helpers ----------
function paletteInto(u, out) {
  u = ((u % 1) + 1) % 1;
  const f = u * PALETTE.length, i = Math.floor(f), t = f - i;
  const a = PALETTE[i], b = PALETTE[(i + 1) % PALETTE.length];
  out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}
const paletteAt = u => paletteInto(u, [0, 0, 0]);
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
CC.PALETTE = PALETTE;
CC.paletteAt = paletteAt;

// Pre-rendered glow sprites: drawImage is far cheaper than shadowBlur per dot/particle.
function buildSprites() {
  sprites = [];
  for (let i = 0; i < SPRITE_STEPS; i++) {
    const c = paletteAt(i / SPRITE_STEPS), s = 64, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d'), grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.12, rgba(c, 1));
    grad.addColorStop(0.35, rgba(c, 0.35));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    sprites.push(cv);
  }
}
const spriteFor = u => sprites[Math.floor((((u % 1) + 1) % 1) * SPRITE_STEPS) % SPRITE_STEPS];

// Static layers rebuilt only on resize: CRT scanlines + vignette, and the midnight background.
function buildLayers() {
  const W = Math.max(1, width), H = Math.max(1, height); // window can report 0x0 while hidden
  overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = W; overlayCanvas.height = H;
  let g = overlayCanvas.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.22)';
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.65)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);

  bgCanvas = document.createElement('canvas');
  bgCanvas.width = W; bgCanvas.height = H;
  g = bgCanvas.getContext('2d');
  const bg = g.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  bg.addColorStop(0, '#0c1a4a');
  bg.addColorStop(1, '#02040f');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(0,240,255,0.045)';
  g.lineWidth = 1;
  for (let x = 0; x < W; x += 48) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke(); }
  for (let y = 0; y < H; y += 48) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke(); }
}

// ---------- p5 lifecycle ----------
function setup() {
  pixelDensity(1);
  createCanvas(windowWidth, windowHeight);
  ctx = drawingContext;
  buildSprites();
  buildLayers();
  proc = document.createElement('canvas');
  procCtx = proc.getContext('2d', { alpha: false });

  // Ask for a modest capture size: we only ever use a <=640px-wide copy of the frame.
  video = createCapture({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false }, () => {
    $('status').textContent = 'loading hand model…';
    $('msg').textContent = 'LOADING HAND MODEL…';
  });
  video.elt.setAttribute('playsinline', '');
  video.elt.muted = true;
  video.hide();

  hands = new Hands({ locateFile: f => `${MP_URL}/${f}` });
  hands.setOptions({ maxNumHands: 2, modelComplexity: TIERS[tierIdx].model, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
  hands.onResults(onResults);

  // Surface camera permission failures (p5 swallows them).
  navigator.mediaDevices?.getUserMedia({ video: true }).then(s => s.getTracks().forEach(t => t.stop()))
    .catch(err => {
      $('status').textContent = 'camera unavailable';
      $('msg').classList.remove('hidden');
      $('msg').textContent = `CAMERA ERROR: ${err.name}. Allow camera access (and serve over https or localhost).`;
    });

  // Browsers only allow audio after a user gesture.
  const unlockAudio = () => {
    CC.audio?.init();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  CC.sculpture?.init(width, height);
  setupNet();
  setInterval(updateHud, 500);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildLayers();
  CC.sculpture?.resize(width, height);
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

const layerText = n => `${n} layer${n === 1 ? '' : 's'}`;

function keyPressed() {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const k = key.toLowerCase();
  const sc = CC.sculpture;
  if (key === ' ') {
    // A countdown, because one person can't hold both hands up and press Space at the same time.
    if (!sc) toast('Sculpture unavailable');
    else if (freezeAt) { freezeAt = 0; toast('Freeze cancelled'); }
    else freezeAt = performance.now() + FREEZE_DELAY_MS;
    return false;
  }
  if (k === 'z' || keyCode === BACKSPACE) {
    if (sc && sc.count > 0) { sc.undo(); CC.net?.sendEvent('undo'); toast(`Undo · ${layerText(sc.count)}`); }
    else toast('Nothing to undo');
    updateHud();
    return false;
  }
  if (k === 'x') {
    if (sc && sc.count > 0) { sc.clear(); CC.net?.sendEvent('clear'); toast('Sculpture cleared'); }
    else toast('Nothing to clear');
  }
  else if (k === 'q') {
    // AUTO -> HIGH -> MED -> LOW -> AUTO
    qualityLock = qualityLock === null ? TIERS.length - 1 : qualityLock === 0 ? null : qualityLock - 1;
    if (qualityLock !== null) setTier(qualityLock);
    toast(qualityLock === null ? 'Quality: auto' : `Quality locked: ${TIERS[qualityLock].name}`);
  }
  else if (k === 'c') cleanMode = !cleanMode;
  else if (k === 'h') $('hud').classList.toggle('hidden');
  else if (k === 'm') CC.net?.togglePanel();
  else if (k === 's' && CC.audio) {
    CC.audio.init();
    CC.audio.setMuted(!CC.audio.muted);
    toast(CC.audio.muted ? 'Sound muted' : 'Sound on');
  }
  updateHud();
}

function updateHud() {
  const t = TIERS[tierIdx];
  $('fps').textContent = Math.round(perf.fps);
  $('quality').textContent = `${t.name}${qualityLock === null ? ' auto' : ' locked'} (model ${t.model}, ${t.procW}px)`;
  $('mode').textContent = cleanMode ? 'CLEAN/CRT' : 'CAMERA';
  $('sound').textContent = !CC.audio ? 'n/a' : CC.audio.muted ? 'muted' : 'on';
  $('link').textContent = CC.net ? (CC.net.roomCode ? `${CC.net.status} ${CC.net.roomCode}` : CC.net.status) : 'n/a';
  $('layers').textContent = CC.sculpture ? CC.sculpture.count : 0;
}

// ---------- Adaptive performance ----------
function monitorPerf(dtMs) {
  perf.frames++; perf.acc += dtMs;
  if (perf.acc < 1000) return;
  perf.fps = perf.frames * 1000 / perf.acc;
  perf.frames = 0; perf.acc = 0;
  if (!modelReady || document.hidden || qualityLock !== null) return;

  if (perf.fps < FPS_LOW) { perf.lowSecs++; perf.highSecs = 0; }
  else if (perf.fps > FPS_HIGH) { perf.highSecs++; perf.lowSecs = 0; }
  else perf.lowSecs = perf.highSecs = 0;

  const now = performance.now();
  if (now - perf.lastSwitch < 4000) return; // let a model swap settle before judging again
  if (perf.lowSecs >= 2 && tierIdx > 0) {
    // Stepping up then straight back down means this machine can't hold that tier: stop trying for a while.
    if (now - perf.lastUp < 15000) perf.upBlockedUntil = now + 60000;
    setTier(tierIdx - 1);
  } else if (perf.highSecs >= 8 && tierIdx < TIERS.length - 1 && now > perf.upBlockedUntil) {
    perf.lastUp = now;
    setTier(tierIdx + 1);
  }
}

function setTier(i) {
  const prev = TIERS[tierIdx];
  tierIdx = i;
  perf.lastSwitch = performance.now();
  perf.lowSecs = perf.highSecs = 0;
  if (TIERS[i].model !== prev.model) hands.setOptions({ modelComplexity: TIERS[i].model });
  if (liveCount > TIERS[i].maxParticles) liveCount = TIERS[i].maxParticles;
  updateHud();
}

// ---------- Video + detection ----------
// Copies each new camera frame once into a small canvas. That copy feeds MediaPipe and is
// upscaled as the (darkened) background, so per-frame pixel work stays small.
function grabFrame() {
  const v = video.elt, vw = v.videoWidth, vh = v.videoHeight;
  if (v.readyState < 2 || !vw) return false;
  const key = `${vw}x${vh}x${tierIdx}`;
  if (key !== procKey) {
    procKey = key;
    proc.width = TIERS[tierIdx].procW;
    proc.height = Math.round(proc.width * vh / vw);
  }
  if (v.currentTime !== lastVideoTime) {
    lastVideoTime = v.currentTime;
    procCtx.drawImage(v, 0, 0, proc.width, proc.height);
    frameFresh = true;
  }
  const s = Math.max(width / vw, height / vh); // "cover" fit
  fit.w = vw * s; fit.h = vh * s;
  fit.ox = (width - fit.w) / 2; fit.oy = (height - fit.h) / 2;
  return true;
}

// Fire-and-forget detection: never block rendering waiting on the model.
function pumpDetection() {
  if (busy || !frameFresh) return;
  busy = true;
  frameFresh = false;
  hands.send({ image: proc }).catch(e => console.error(e)).finally(() => { busy = false; });
}

function onResults(res) {
  if (!modelReady) {
    modelReady = true;
    $('status').textContent = 'tracking';
    $('msg').classList.add('hidden');
  }
  const lms = res.multiHandLandmarks || [], hd = res.multiHandedness || [];
  // Mirror x so landmarks match the mirrored display. Coordinates stay normalized (0..1 of the video frame).
  const found = lms.map((pts, i) => ({ pts: pts.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })), label: hd[i] && hd[i].label }));
  const hL = handState.L, hR = handState.R;
  let L = null, R = null;
  if (found.length >= 2) {
    found.sort((a, b) => a.pts[0].x - b.pts[0].x);
    L = found[0]; R = found[1];
  } else if (found.length === 1) {
    const w = found[0].pts[0];
    if (hL.target && hR.target) {
      // Both hands were just tracked: the survivor is whichever one it is closest to.
      const dL = Math.hypot(w.x - hL.target[0].x, w.y - hL.target[0].y);
      const dR = Math.hypot(w.x - hR.target[0].x, w.y - hR.target[0].y);
      if (dL < dR) L = found[0]; else R = found[0];
    } else if (found[0].label === 'Right') {
      // MediaPipe labels assume a mirrored input; ours is raw, so "Right" is the user's left hand.
      L = found[0];
    } else R = found[0];
  }
  // Fast motion makes MediaPipe drop a hand for a few frames. Hold its last pose briefly so the
  // strings stay attached instead of snapping off.
  const now = performance.now();
  for (const [h, f] of [[hL, L], [hR, R]]) {
    if (f) { h.target = f.pts; h.lastSeen = now; }
    else if (now - h.lastSeen > HAND_HOLD_MS) h.target = null;
  }
  $('handCount').textContent = found.length;
}

// ---------- Multiplayer wiring ----------
const toNorm = s => ({
  colors: s.colors,
  points: s.points.map(p => ({ x: (p.x - fit.ox) / fit.w, y: (p.y - fit.oy) / fit.h, z: p.z / fit.h })),
});
const fromNorm = s => ({
  colors: s.colors,
  points: s.points.map(p => ({ x: fit.ox + p.x * fit.w, y: fit.oy + p.y * fit.h, z: p.z * fit.h })),
});

function setupNet() {
  const net = CC.net;
  if (!net) return;
  net.on('burst', d => { burst(fit.ox + d.x * fit.w, fit.oy + d.y * fit.h, d.u); CC.audio?.chime(Math.round(d.u * 5) % 5, 0.6); });
  net.on('freeze', d => CC.sculpture?.freeze(d.strands.map(fromNorm)));
  net.on('undo', () => CC.sculpture?.undo());
  net.on('clear', () => CC.sculpture?.clear());
  net.on('status', updateHud);
}

function syncNet() {
  const net = CC.net;
  const connected = net && net.status === 'connected';
  if (connected) net.sendHands(handState.L.target, handState.R.target);
  const r = connected ? net.remote : null;
  const fresh = r && performance.now() - r.lastUpdate < 600;
  handState.RL.target = fresh ? r.L : null;
  handState.RR.target = fresh ? r.R : null;
}

// ---------- Main loop ----------
function draw() {
  monitorPerf(deltaTime);
  const hasVideo = grabFrame();
  if (hasVideo) pumpDetection();
  syncNet();

  // Background
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  if (cleanMode || !hasVideo) {
    ctx.drawImage(bgCanvas, 0, 0);
  } else {
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(proc, fit.ox, fit.oy, fit.w, fit.h);
    ctx.restore();
    ctx.fillStyle = 'rgba(2,4,16,0.6)'; // darken for the futuristic look and neon contrast
    ctx.fillRect(0, 0, width, height);
  }

  updateHands();

  ctx.globalCompositeOperation = 'lighter'; // additive blending = free extra glow
  const t = millis() / 1000;
  if (cleanMode) for (const h of Object.values(handState)) drawSilhouette(h);
  drawSkeleton(handState.L, t, 0);
  drawSkeleton(handState.R, t, 0);
  drawSkeleton(handState.RL, t, 0.5);
  drawSkeleton(handState.RR, t, 0.5);

  if (CC.sculpture && CC.sculpture.count > 0) {
    CC.sculpture.render(t);
    ctx.globalAlpha = 1;
    ctx.drawImage(CC.sculpture.canvas, 0, 0);
  }

  drawAllStrings(t);
  CC.audio?.update(springs.local, deltaTime / 1000);
  updateParticles();
  drawJoints(handState.L, t, 0, 1);
  drawJoints(handState.R, t, 0, 1);
  drawJoints(handState.RL, t, 0.5, 0.8);
  drawJoints(handState.RR, t, 0.5, 0.8);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  if (freezeAt) drawFreezeCountdown();
  ctx.globalAlpha = 1;
  if (cleanMode) drawCRT(t);
  else { ctx.globalAlpha = 0.6; ctx.drawImage(overlayCanvas, 0, 0); ctx.globalAlpha = 1; }
}

// ---------- Hands ----------
function updateHands() {
  for (const h of Object.values(handState)) {
    if (h.target) {
      if (!h.pts) h.pts = h.target.map(() => ({ x: 0, y: 0, z: 0 }));
      const snap = h.presence === 0;
      for (let i = 0; i < 21; i++) {           // smooth jitter between detections
        const p = h.target[i], q = h.pts[i];
        const x = fit.ox + p.x * fit.w, y = fit.oy + p.y * fit.h;
        if (snap) { q.x = x; q.y = y; q.z = p.z; }
        else { q.x += (x - q.x) * 0.5; q.y += (y - q.y) * 0.5; q.z += (p.z - q.z) * 0.5; }
      }
      // Apparent hand size is our depth cue: bigger hand = closer to the camera.
      const scale = Math.hypot(h.pts[0].x - h.pts[9].x, h.pts[0].y - h.pts[9].y) / fit.h;
      h.depth = Math.max(-300, Math.min(300, (scale - 0.14) * 1800));
      h.presence = Math.min(1, h.presence + 0.15);
    } else if (h.pts) {
      h.presence -= 0.08;
      if (h.presence <= 0) { h.presence = 0; h.pts = null; }
    }
  }
}

// Depth of a landmark in the sculpture's pixel-ish z units (+ = toward camera).
const tipDepth = (h, j) => h.depth - h.pts[j].z * fit.w * 0.6;

function drawSilhouette(h) {
  if (!h.pts) return;
  const p = h.pts, scale = Math.hypot(p[0].x - p[9].x, p[0].y - p[9].y);
  ctx.globalAlpha = 0.16 * h.presence;
  ctx.strokeStyle = ctx.fillStyle = 'rgb(40,90,200)';
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = scale * 0.32;
  ctx.beginPath();
  for (const [a, b] of BONES) { ctx.moveTo(p[a].x, p[a].y); ctx.lineTo(p[b].x, p[b].y); }
  ctx.stroke();
  ctx.beginPath();
  PALM.forEach((i, k) => k ? ctx.lineTo(p[i].x, p[i].y) : ctx.moveTo(p[i].x, p[i].y));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawSkeleton(h, t, hue) {
  if (!h.pts) return;
  const p = h.pts;
  ctx.globalAlpha = 0.35 * h.presence;
  ctx.strokeStyle = rgba(paletteAt(t * 0.05 + hue), 1);
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of BONES) { ctx.moveTo(p[a].x, p[a].y); ctx.lineTo(p[b].x, p[b].y); }
  ctx.stroke();
}

function drawJoints(h, t, hue, sizeMul) {
  if (!h.pts) return;
  ctx.globalAlpha = h.presence * sizeMul;
  for (let j = 0; j < 21; j++) {
    const finger = j === 0 ? 0 : Math.floor((j - 1) / 4);
    const isTip = TIPS.includes(j);
    const size = (isTip ? 38 : 22) * sizeMul * (0.9 + 0.1 * Math.sin(t * 6 + j));
    ctx.drawImage(spriteFor(finger / 5 + t * 0.08 + hue), h.pts[j].x - size / 2, h.pts[j].y - size / 2, size, size);
  }
}

// ---------- Elastic strings ----------
function drawAllStrings(t) {
  const diag = Math.hypot(width, height), tier = TIERS[tierIdx];
  for (const pair of PAIRS) {
    const A = handState[pair.a], B = handState[pair.b], set = springs[pair.set];
    const active = !!(A.pts && B.pts);
    for (let i = 0; i < TIPS.length; i++) {
      const s = set[i];
      s.drawn = s.active = active;
      if (!active) { s.init = false; s.touching = false; s.speed = 0; continue; }
      drawString(s, A, B, i, pair, t, diag, tier);
    }
  }
}

function drawString(s, A, B, i, pair, t, diag, tier) {
  const a = A.pts[TIPS[i]], b = B.pts[TIPS[i]];
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
  if (!s.init) { s.init = true; s.mx = midX; s.my = midY; s.vx = s.vy = 0; s.rest = d; }

  // Rest length lags behind actual distance: pulling apart = taut, pushing together = slack + sag.
  s.rest += (d - s.rest) * 0.03;
  s.slack = Math.max(0, s.rest - d);
  s.tension = Math.min(1, d / (diag * 0.55));
  const sag = 8 + s.slack * 0.7 + (1 - s.tension) * 18;

  // Damped spring on the string's midpoint gives the wobbly, elastic overshoot.
  s.vx += (midX - s.mx) * 0.2;
  s.vy += (midY + sag - s.my) * 0.2;
  s.vx *= 0.78; s.vy *= 0.78;
  s.mx += s.vx; s.my += s.vy;
  s.speed = Math.hypot(s.vx, s.vy);
  // Quadratic control point so the curve passes through the spring midpoint.
  const cx = 2 * s.mx - midX, cy = 2 * s.my - midY;
  s.ax = a.x; s.ay = a.y; s.bx = b.x; s.by = b.y; s.cx = cx; s.cy = cy;
  s.za = tipDepth(A, TIPS[i]); s.zb = tipDepth(B, TIPS[i]);

  // Farther apart -> thinner and hotter (cyan -> magenta -> yellow).
  const w = (4.2 - s.tension * 3.2) * (pair.main ? 1 : 0.7);
  const shift = s.tension * 0.66 + i * 0.04 + t * 0.06 + pair.hue;
  paletteInto(shift, s.c0); paletteInto(shift + 0.33, s.c1); paletteInto(shift + 0.66, s.c2);
  const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  grad.addColorStop(0, rgba(s.c0));
  grad.addColorStop(0.5, rgba(s.c1));
  grad.addColorStop(1, rgba(s.c2));
  const alpha = Math.min(A.presence, B.presence) * (pair.main ? 1 : 0.75);

  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(cx, cy, b.x, b.y);
  // Pass 1: wide soft halo (cheap, no shadow)
  ctx.strokeStyle = grad;
  ctx.globalAlpha = 0.18 * alpha;
  ctx.lineWidth = w * 5;
  ctx.stroke();
  // Pass 2: glowing body; shadowBlur only on main strings and when the quality tier allows it
  ctx.globalAlpha = 0.9 * alpha;
  ctx.lineWidth = w;
  if (tier.blur && pair.main) {
    ctx.shadowColor = rgba(s.c1);
    ctx.shadowBlur = 14 + s.tension * 10;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Pass 3: hot white core for a laser look
  ctx.globalAlpha = 0.7 * alpha;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(0.6, w * 0.3);
  ctx.stroke();

  // Fingertip contact -> particle burst (edge-triggered with cooldown).
  if (pair.touch === 'none') return;
  const touching = d < diag * 0.03;
  const now = millis();
  if (touching && !s.touching && now - s.lastBurst > 300) {
    const u = i / 5 + pair.hue;
    burst(midX, midY, u);
    CC.audio?.chime(i, Math.min(1, 0.4 + s.speed / 20));
    if (pair.touch === 'broadcast') CC.net?.sendEvent('burst', { x: (midX - fit.ox) / fit.w, y: (midY - fit.oy) / fit.h, u });
    s.lastBurst = now;
  }
  s.touching = touching;
}

// ---------- Sculpture (freeze strings into 3D) ----------
function sampleStrand(s) {
  const points = [];
  for (let k = 0; k < STRAND_SAMPLES; k++) {
    const t = k / (STRAND_SAMPLES - 1), u = 1 - t;
    points.push({
      x: u * u * s.ax + 2 * u * t * s.cx + t * t * s.bx,
      y: u * u * s.ay + 2 * u * t * s.cy + t * t * s.by,
      z: s.za + (s.zb - s.za) * t,
    });
  }
  return { points, colors: [s.c0.slice(), s.c1.slice(), s.c2.slice()] };
}

function freezeSculpture() {
  if (!CC.sculpture) return;
  const strands = [];
  for (const set of Object.values(springs)) for (const s of set) if (s.drawn) strands.push(sampleStrand(s));
  if (!strands.length) { toast('Show both hands to freeze'); return; }
  CC.sculpture.freeze(strands);
  for (let i = 0; i < Math.min(5, strands.length); i++) CC.audio?.pluck(i, 0.7);
  CC.net?.sendEvent('freeze', { strands: strands.map(toNorm) });
  toast(`Frozen · ${layerText(CC.sculpture.count)}`);
  updateHud();
}

function drawFreezeCountdown() {
  const left = freezeAt - performance.now();
  if (left <= 0) { freezeAt = 0; freezeSculpture(); return; }
  const n = Math.ceil(left / (FREEZE_DELAY_MS / 3));
  const frac = (left % (FREEZE_DELAY_MS / 3)) / (FREEZE_DELAY_MS / 3);
  ctx.globalAlpha = 0.35 + 0.65 * frac;
  ctx.font = `bold ${Math.round(Math.min(width, height) * 0.18)}px Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#00f0ff';
  ctx.shadowBlur = 30;
  ctx.fillText(n, width / 2, height / 2);
  ctx.shadowBlur = 0;
  ctx.font = '14px Consolas, monospace';
  ctx.fillText('HOLD YOUR STRINGS · SPACE TO CANCEL', width / 2, height / 2 + Math.min(width, height) * 0.13);
}

// ---------- Particles ----------
function spawn() {
  return liveCount < TIERS[tierIdx].maxParticles ? pool[liveCount++] : null;
}

function burst(x, y, hue) {
  const n = TIERS[tierIdx].burstN;
  for (let k = 0; k < n; k++) {
    const p = spawn();
    if (!p) break;
    const ang = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 9;
    p.ring = false; p.x = x; p.y = y; p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
    p.life = 1; p.decay = 0.012 + Math.random() * 0.025; p.u = hue + Math.random() * 0.6; p.size = 10 + Math.random() * 22;
  }
  const r = spawn();
  if (r) { r.ring = true; r.x = x; r.y = y; r.r = 4; r.life = 1; r.decay = 0.04; r.u = hue; }
}

function updateParticles() {
  // Iterate backwards so swap-removal only moves already-updated particles.
  for (let i = liveCount - 1; i >= 0; i--) {
    const p = pool[i];
    p.life -= p.decay;
    if (p.life <= 0) {
      liveCount--;
      pool[i] = pool[liveCount];
      pool[liveCount] = p;
      continue;
    }
    if (p.ring) {
      p.r += 7;
      ctx.globalAlpha = p.life * 0.8;
      ctx.strokeStyle = rgba(paletteAt(p.u));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    p.vx *= 0.95; p.vy = p.vy * 0.95 + 0.06;
    p.x += p.vx; p.y += p.vy;
    const sz = p.size * p.life;
    ctx.globalAlpha = p.life;
    ctx.drawImage(spriteFor(p.u), p.x - sz / 2, p.y - sz / 2, sz, sz);
  }
}

// ---------- CRT overlay ----------
function drawCRT(t) {
  ctx.globalAlpha = 0.92 + Math.random() * 0.08; // faint flicker
  ctx.drawImage(overlayCanvas, 0, 0);
  // Slow rolling bright band
  const y = ((t * 0.12) % 1.2 - 0.1) * height;
  const g = ctx.createLinearGradient(0, y - 60, 0, y + 60);
  g.addColorStop(0, 'rgba(120,200,255,0)');
  g.addColorStop(0.5, 'rgba(120,200,255,0.05)');
  g.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 60, width, 120);
}
