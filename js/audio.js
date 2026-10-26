/* Neon Cat's Cradle -- audio module (classic script, pure Web Audio API).
 * API: CC.audio.init(), .muted, .setMuted(bool), .update(strings, dt),
 *      .chime(fingerIndex, intensity), .pluck(fingerIndex, intensity)
 * Every method is a safe no-op before init() (or if Web Audio is unavailable).
 */
window.CC = window.CC || {};

(function () {
  'use strict';

  var MASTER_LEVEL = 0.35;
  var MAX_EVENT_VOICES = 6;          // concurrent chime/pluck voices
  var ROOT_HZ = 110;                 // A2
  var PENTA = [0, 3, 5, 7, 10];      // minor pentatonic semitones
  var STRING_OFFSETS = [0, 2, 4, 5, 7]; // scale-degree offset per string -> stacked chord
  var STEPS_PER_STRING = 10;         // ~2 octaves of pentatonic per string
  var PANS = [-0.6, -0.3, 0, 0.3, 0.6];

  var ctx = null;
  var master = null, busIn = null, voices = [], drone = null;
  var eventVoices = 0;
  var lastEventTime = [0, 0, 0, 0, 0];

  function clamp(x, lo, hi) {
    x = +x;
    if (!isFinite(x)) return lo;
    return x < lo ? lo : (x > hi ? hi : x);
  }

  function degreeToHz(deg) {
    var oct = Math.floor(deg / PENTA.length);
    var semis = PENTA[((deg % PENTA.length) + PENTA.length) % PENTA.length] + 12 * oct;
    return ROOT_HZ * Math.pow(2, semis / 12);
  }

  function ramp(param, value, tc) {
    param.setTargetAtTime(value, ctx.currentTime, tc);
  }

  function makeImpulse(seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function makePanner(pan) {
    if (ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = pan;
      return p;
    }
    return ctx.createGain(); // mono fallback
  }

  function buildGraph() {
    var now = ctx.currentTime;

    // master <- limiter <- (dry + delay + reverb) <- bus lowpass <- busIn
    master = ctx.createGain();
    master.gain.setValueAtTime(0, now);
    master.connect(ctx.destination);

    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(master);

    busIn = ctx.createGain();
    busIn.gain.value = 1;
    var busLP = ctx.createBiquadFilter();
    busLP.type = 'lowpass';
    busLP.frequency.value = 7000;
    busLP.Q.value = 0.5;
    busIn.connect(busLP);

    var dry = ctx.createGain();
    dry.gain.value = 0.75;
    busLP.connect(dry);
    dry.connect(limiter);

    // dotted-eighth-ish feedback delay (~90 bpm)
    var delay = ctx.createDelay(2);
    delay.delayTime.value = 0.5;
    var fb = ctx.createGain();
    fb.gain.value = 0.28;
    var fbLP = ctx.createBiquadFilter();
    fbLP.type = 'lowpass';
    fbLP.frequency.value = 2500;
    var delaySend = ctx.createGain();
    delaySend.gain.value = 0.3;
    busLP.connect(delaySend);
    delaySend.connect(delay);
    delay.connect(fbLP);
    fbLP.connect(fb);
    fb.connect(delay);
    fbLP.connect(limiter);

    var verb = ctx.createConvolver();
    verb.buffer = makeImpulse(3.2, 3);
    var verbSend = ctx.createGain();
    verbSend.gain.value = 0.45;
    busLP.connect(verbSend);
    verbSend.connect(verb);
    verb.connect(limiter);

    // five persistent string voices: saw + detuned triangle -> lowpass -> gain -> pan
    for (var i = 0; i < 5; i++) {
      var f0 = degreeToHz(STRING_OFFSETS[i]);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = f0;
      var o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = f0;
      o2.detune.value = 7;
      var mix2 = ctx.createGain();
      mix2.gain.value = 0.8;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 600;
      lp.Q.value = 4;
      var g = ctx.createGain();
      g.gain.value = 0;
      var pan = makePanner(PANS[i]);
      o1.connect(lp);
      o2.connect(mix2);
      mix2.connect(lp);
      lp.connect(g);
      g.connect(pan);
      pan.connect(busIn);
      o1.start(now);
      o2.start(now);
      voices.push({ o1: o1, o2: o2, lp: lp, g: g, freq: f0, cutoff: 600, gain: 0 });
    }

    // drone pad: root + fifth, slow LFO detune
    var dGain = ctx.createGain();
    dGain.gain.value = 0;
    var dLP = ctx.createBiquadFilter();
    dLP.type = 'lowpass';
    dLP.frequency.value = 500;
    dGain.connect(dLP);
    dLP.connect(busIn);
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.13;
    var lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 9; // cents
    lfo.connect(lfoAmt);
    var droneFreqs = [ROOT_HZ / 2, ROOT_HZ / 2 * 1.5, ROOT_HZ];
    var droneTypes = ['triangle', 'sine', 'sine'];
    for (var d = 0; d < droneFreqs.length; d++) {
      var o = ctx.createOscillator();
      o.type = droneTypes[d];
      o.frequency.value = droneFreqs[d];
      o.detune.value = d === 1 ? -4 : 3;
      lfoAmt.connect(o.detune);
      var og = ctx.createGain();
      og.gain.value = d === 0 ? 0.5 : 0.3;
      o.connect(og);
      og.connect(dGain);
      o.start(now);
    }
    lfo.start(now);
    drone = { g: dGain, gain: 0 };
  }

  function eventSlot(fingerIndex) {
    if (!ctx || ctx.state !== 'running' || audio.muted) return false;
    if (eventVoices >= MAX_EVENT_VOICES) return false;
    var t = ctx.currentTime;
    if (t - lastEventTime[fingerIndex] < 0.07) return false; // per-finger debounce
    lastEventTime[fingerIndex] = t;
    return true;
  }

  function trackVoice(node) {
    eventVoices++;
    node.onended = function () { eventVoices = Math.max(0, eventVoices - 1); };
  }

  var MUTE_KEY = 'cc-muted';
  var suspendTimer = 0;

  function readStoredMute() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
  }

  // Fade the master out, then suspend the whole context so nothing can keep sounding
  // (a gain ramp alone can be lost if it is scheduled while the context is paused).
  function applyMute() {
    if (!ctx || !master) return;
    clearTimeout(suspendTimer);
    var g = master.gain, now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (audio.muted) {
      g.setTargetAtTime(0, now, 0.05);
      suspendTimer = setTimeout(function () {
        if (audio.muted && ctx.state === 'running') ctx.suspend();
      }, 300);
    } else {
      var p = ctx.state === 'suspended' && ctx.resume ? ctx.resume() : null;
      if (p && p.catch) p.catch(function () {});
      g.setTargetAtTime(MASTER_LEVEL, now, 0.12);
    }
  }

  var audio = {
    muted: readStoredMute(),

    init: function () {
      try {
        if (!ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          ctx = new AC();
          buildGraph();
          applyMute();
          return;
        }
        if (!audio.muted && ctx.state === 'suspended' && ctx.resume) {
          var p = ctx.resume();
          if (p && p.catch) p.catch(function () {});
        }
      } catch (e) {
        if (window.console) console.warn('[CC.audio] init failed:', e);
      }
    },

    setMuted: function (m) {
      audio.muted = !!m;
      // Persist, and let other open tabs of the app pick it up through the storage event.
      try { localStorage.setItem(MUTE_KEY, audio.muted ? '1' : '0'); } catch (e) {}
      applyMute();
    },

    update: function (strings, dt) {
      if (!ctx || !voices.length || !strings || audio.muted) return;
      var anyActive = false;
      for (var i = 0; i < 5; i++) {
        var s = strings[i];
        var v = voices[i];
        var active = !!(s && s.active);
        var targetGain = 0;
        if (active) {
          anyActive = true;
          var tension = clamp(s.tension, 0, 1);
          var speed = clamp(s.speed, 0, 60);
          var slack = clamp(s.slack, 0, 400);

          var deg = STRING_OFFSETS[i] + Math.round(tension * (STEPS_PER_STRING - 1));
          var freq = degreeToHz(deg);
          if (Math.abs(freq - v.freq) > 0.5) {
            v.freq = freq;
            ramp(v.o1.frequency, freq, 0.06);
            ramp(v.o2.frequency, freq, 0.06);
          }

          // taut = brighter; slack and sag darken it; wobble opens it a little
          var cutoff = clamp(350 + tension * 3200 + speed * 25 - slack * 1.5, 200, 6000);
          if (Math.abs(cutoff - v.cutoff) / v.cutoff > 0.04) {
            v.cutoff = cutoff;
            ramp(v.lp.frequency, cutoff, 0.08);
          }
          targetGain = clamp(0.045 + Math.min(speed / 30, 1) * 0.05, 0, 0.1);
        }
        if (Math.abs(targetGain - v.gain) > 0.003) {
          var rising = targetGain > v.gain;
          v.gain = targetGain;
          ramp(v.g.gain, targetGain, rising ? 0.06 : 0.25);
        }
      }
      var dTarget = anyActive ? 0.07 : 0;
      if (drone && Math.abs(dTarget - drone.gain) > 0.002) {
        drone.gain = dTarget;
        ramp(drone.g.gain, dTarget, anyActive ? 0.8 : 1.5);
      }
    },

    chime: function (fingerIndex, intensity) {
      try {
        var fi = Math.round(clamp(fingerIndex, 0, 4));
        if (!eventSlot(fi)) return;
        var amp = 0.04 + clamp(intensity, 0, 1) * 0.1;
        var t = ctx.currentTime;
        var f = degreeToHz(STRING_OFFSETS[fi] + 10); // an octave+ above the strings

        var out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, t);
        out.gain.exponentialRampToValueAtTime(amp, t + 0.008);
        out.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        var pan = makePanner(PANS[fi]);
        out.connect(pan);
        pan.connect(busIn);

        // FM carrier with bell-ish inharmonic modulator, plus a fifth partial
        var car = ctx.createOscillator();
        car.type = 'sine';
        car.frequency.value = f;
        var mod = ctx.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = f * 3.5;
        var modG = ctx.createGain();
        modG.gain.setValueAtTime(f * 1.2, t);
        modG.gain.exponentialRampToValueAtTime(1, t + 1.0);
        mod.connect(modG);
        modG.connect(car.frequency);
        car.connect(out);

        var p2 = ctx.createOscillator();
        p2.type = 'sine';
        p2.frequency.value = f * 1.5;
        var p2g = ctx.createGain();
        p2g.gain.value = 0.35;
        p2.connect(p2g);
        p2g.connect(out);

        var end = t + 1.7;
        car.start(t); mod.start(t); p2.start(t);
        car.stop(end); mod.stop(end); p2.stop(end);
        trackVoice(car);
      } catch (e) { /* never throw into the render loop */ }
    },

    pluck: function (fingerIndex, intensity) {
      try {
        var fi = Math.round(clamp(fingerIndex, 0, 4));
        if (!eventSlot(fi)) return;
        var amp = 0.06 + clamp(intensity, 0, 1) * 0.1;
        var t = ctx.currentTime;
        var f = degreeToHz(STRING_OFFSETS[fi] + 5);

        var out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, t);
        out.gain.exponentialRampToValueAtTime(amp, t + 0.004);
        out.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        var lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 6;
        lp.frequency.setValueAtTime(Math.min(f * 12, 9000), t);
        lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.5, 200), t + 0.4);
        var pan = makePanner(PANS[fi]);
        lp.connect(out);
        out.connect(pan);
        pan.connect(busIn);

        var o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        var o2 = ctx.createOscillator();
        o2.type = 'square';
        o2.frequency.value = f * 2;
        var o2g = ctx.createGain();
        o2g.gain.value = 0.25;
        o.connect(lp);
        o2.connect(o2g);
        o2g.connect(lp);

        var end = t + 0.65;
        o.start(t); o2.start(t);
        o.stop(end); o2.stop(end);
        trackVoice(o);
      } catch (e) { /* never throw into the render loop */ }
    }
  };

  window.addEventListener('storage', function (e) {
    if (e.key !== MUTE_KEY) return;
    audio.muted = e.newValue === '1';
    applyMute();
  });

  window.CC.audio = audio;
})();
