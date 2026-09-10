// Channel Keeper — WebAudio engine. Original synthesized transients only,
// tied to logical events. Buses: master → music / effects / ambience / voice.
// Pitch variants use a seeded stream so replays sound identical.

import { makeRng } from './rng.js';

// Authored one-shot samples (sfx/<name>.opus, see sfx/manifest.json) mapped to
// logical events. Clips are lazy-loaded after the user-gesture unlock; while a
// clip is loading or unavailable the synthesized sounds below stay in use.
const SFX_SAMPLES = {
  ui: 'ui-tick',
  select: 'menu-select',
  carve: 'dig-soft',
  carveHard: 'dig-hard',
  invalid: 'deny-buzz',
  release: 'water-release',
  splash: 'water-splash',
  deliver: 'well-fill',
  contaminate: 'water-fouled',
  undo: 'undo-rewind',
  win: 'round-win',
  lose: 'round-lose',
  achievement: 'achievement-chime',
  hint: 'hint-glimmer',
  springDry: 'spring-dry',
  pause: 'pause-hush',
  resume: 'resume-swell',
};

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.ambienceNodes = [];
    this.musicTimer = null;
    this.rng = makeRng(0xA0D10, 'audio');
    this.onCaption = null; // (text) => void, for captions/text cues
    this._musicStep = 0;
    this._sampleCache = new Map(); // basename -> AudioBuffer | null (loading) | false (failed)
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const mk = (parent) => {
      const g = this.ctx.createGain();
      g.connect(parent);
      return g;
    };
    this.buses.master = mk(this.ctx.destination);
    this.buses.music = mk(this.buses.master);
    this.buses.effects = mk(this.buses.master);
    this.buses.ambience = mk(this.buses.master);
    this.buses.voice = mk(this.buses.master);
    this.applyVolumes();
    this._startAmbience();
    this._startMusic();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    const m = s.muted ? 0 : s.volMaster;
    this.buses.master.gain.value = m * m;
    this.buses.music.gain.value = s.volMusic * s.volMusic;
    this.buses.effects.gain.value = s.volEffects * s.volEffects;
    this.buses.ambience.gain.value = s.volAmbience * s.volAmbience;
    this.buses.voice.gain.value = s.volVoice * s.volVoice;
  }

  setMuted(muted) {
    this.settings.muted = muted;
    this.applyVolumes();
  }

  _caption(text) {
    if (this.onCaption) this.onCaption(text);
  }

  /** Short enveloped oscillator blip. */
  _blip(freq, dur, { type = 'sine', gain = 0.2, bus = 'effects', slide = 0, delay = 0 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.buses[bus]);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /** Filtered noise burst (impacts, digging). */
  _noise(dur, { freq = 800, q = 1, gain = 0.25, bus = 'effects', delay = 0 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (this.rng.next() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.buses[bus]);
    src.start(t0);
  }

  /** Lazy-fetch/decode/cache an authored sample and play it once it is cached.
   *  Returns true only when a cached clip was actually started on the effects
   *  bus; while loading or after a failure the caller falls back to synthesis. */
  _playSample(name) {
    if (!this.ctx) return false;
    const cached = this._sampleCache.get(name);
    if (cached instanceof AudioBuffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = cached;
      src.connect(this.buses.effects);
      src.start();
      return true;
    }
    if (cached === undefined) {
      this._sampleCache.set(name, null); // fetch in flight
      fetch(`sfx/${name}.opus`)
        .then((r) => {
          if (!r.ok) throw new Error(`sfx ${name}: HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => this._sampleCache.set(name, buf))
        .catch(() => this._sampleCache.set(name, false)); // keep synthesis
    }
    return false;
  }

  /** Map a logical game event to sound + caption. */
  event(name, opts = {}) {
    if (!this.ctx) return;
    const vary = 1 + (this.rng.next() - 0.5) * 0.12; // seeded pitch variant
    // Captions fire whether an authored sample or synthesis voices the event.
    switch (name) {
      case 'carve': this._caption('dig'); break;
      case 'carveHard': this._caption('heavy dig'); break;
      case 'invalid': this._caption(opts.reason ? `not allowed: ${opts.reason}` : 'not allowed'); break;
      case 'release': this._caption('water released'); break;
      case 'contaminate': this._caption('water contaminated'); break;
      case 'undo': this._caption('undo'); break;
      case 'win': this._caption('well filled — round complete'); break;
      case 'lose': this._caption('round failed'); break;
      case 'achievement': this._caption('achievement unlocked'); break;
      case 'hint': this._caption('hint'); break;
      case 'springDry': this._caption('the spring has run dry'); break;
      case 'pause': this._caption('paused'); break;
      case 'resume': this._caption('resumed'); break;
    }
    const sample = SFX_SAMPLES[name];
    if (sample && this._playSample(sample)) return;
    switch (name) {
      case 'ui':
        this._blip(660 * vary, 0.06, { type: 'triangle', gain: 0.08 });
        break;
      case 'select':
        this._blip(520 * vary, 0.08, { type: 'triangle', gain: 0.1 });
        this._blip(780 * vary, 0.08, { type: 'triangle', gain: 0.08, delay: 0.05 });
        break;
      case 'carve':
        this._noise(0.09, { freq: 500 * vary, q: 0.8, gain: 0.22 });
        this._blip(180 * vary, 0.07, { type: 'square', gain: 0.05 });
        break;
      case 'carveHard':
        this._noise(0.14, { freq: 300 * vary, q: 1.2, gain: 0.3 });
        this._blip(120 * vary, 0.1, { type: 'square', gain: 0.07 });
        break;
      case 'invalid':
        this._blip(140, 0.12, { type: 'sawtooth', gain: 0.08, slide: -40 });
        break;
      case 'release':
        this._noise(0.5, { freq: 900, q: 0.4, gain: 0.18 });
        this._blip(220, 0.4, { type: 'sine', gain: 0.12, slide: 160 });
        break;
      case 'splash':
        this._noise(0.12, { freq: 1400 * vary, q: 0.6, gain: 0.1 });
        break;
      case 'deliver':
        this._blip(880 * vary, 0.1, { type: 'sine', gain: 0.07 });
        break;
      case 'contaminate':
        this._blip(220, 0.25, { type: 'sawtooth', gain: 0.1, slide: -120 });
        break;
      case 'undo':
        this._blip(440, 0.08, { type: 'triangle', gain: 0.09, slide: -120 });
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) =>
          this._blip(f, 0.35, { type: 'triangle', gain: 0.12, delay: i * 0.09 }));
        break;
      case 'lose':
        [330, 262, 196].forEach((f, i) =>
          this._blip(f, 0.3, { type: 'sine', gain: 0.1, delay: i * 0.12 }));
        break;
      case 'achievement':
        [784, 988, 1175].forEach((f, i) =>
          this._blip(f, 0.25, { type: 'sine', gain: 0.1, delay: i * 0.07 }));
        break;
      case 'hint':
        this._blip(700 * vary, 0.07, { type: 'triangle', gain: 0.07 });
        this._blip(1050 * vary, 0.1, { type: 'triangle', gain: 0.06, delay: 0.06 });
        break;
      case 'springDry':
        this._blip(330, 0.35, { type: 'sine', gain: 0.09, slide: -180 });
        this._noise(0.25, { freq: 600, q: 0.5, gain: 0.08, delay: 0.05 });
        break;
      case 'pause':
        this._blip(392, 0.18, { type: 'sine', gain: 0.07, slide: -60 });
        break;
      case 'resume':
        this._blip(330, 0.14, { type: 'sine', gain: 0.07, slide: 90 });
        break;
      case 'tick':
        break; // ambient only; no per-tick sound
    }
  }

  /** Quiet looping ambience: layered filtered noise + slow LFO. */
  _startAmbience() {
    if (!this.ctx || this.ambienceNodes.length) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // brown-ish noise
      const white = this.rng.next() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 320;
    const g = this.ctx.createGain();
    g.gain.value = 0.16;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 0.05;
    lfo.connect(lfoG).connect(g.gain);
    src.connect(f).connect(g).connect(this.buses.ambience);
    src.start();
    lfo.start();
    this.ambienceNodes = [src, lfo];
  }

  /** Adaptive generative music: slow pentatonic pad, quiet by design. */
  _startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const scale = [220, 262, 294, 330, 392, 440];
    const step = () => {
      if (!this.ctx || document.hidden) return;
      this._musicStep++;
      if (this._musicStep % 2 === 0) {
        const f = scale[Math.floor(this.rng.next() * scale.length)];
        this._blip(f, 2.4, { type: 'sine', gain: 0.035, bus: 'music' });
        this._blip(f / 2, 2.8, { type: 'triangle', gain: 0.025, bus: 'music' });
      }
    };
    this.musicTimer = setInterval(step, 1400);
  }

  /** Background tabs: duck everything. */
  setBackgrounded(hidden) {
    if (!this.ctx) return;
    const s = this.settings;
    const m = (s.muted || hidden) ? 0 : s.volMaster;
    this.buses.master.gain.linearRampToValueAtTime(m * m, this.ctx.currentTime + 0.2);
  }
}
