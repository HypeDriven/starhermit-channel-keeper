// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json's event table) per logical event; the
// generative music (a slow pentatonic pad: every 2.8 s a sine note with a
// triangle an octave below, picked by a seeded stream); and the cavern
// ambience (brown noise lowpassed at 320 Hz, its level breathing with a
// 0.07 Hz swell).
//
// The browser build's buses become the runtime's (Options › Audio owns the
// volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects". The old default bus levels (music 0.6², effects
// 0.9², ambience 0.5²: its gains were squared) are folded into each sound's
// gain. The music and ambience voices are offline graphs rendered once into
// clips with the same envelopes; the synthesized stand-ins the browser build
// played while a sample loaded are not ported. The clips load and the voices
// render at once in onStart; the sound starts once the mixer runs (in a
// browser after the first press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { makeRng } from "../js/rng.js";
import { N } from "./i18n.ts";

const LEVEL = { music: 0.36, effects: 0.81, ambience: 0.25 };
/** Logical event → authored sample (sfx/manifest.json). */
const SAMPLES: Record<string, string> = {
  ui: "ui-tick", select: "menu-select", carve: "dig-soft", carveHard: "dig-hard", invalid: "deny-buzz",
  release: "water-release", splash: "water-splash", deliver: "well-fill", contaminate: "water-fouled",
  undo: "undo-rewind", win: "round-win", lose: "round-lose", achievement: "achievement-chime", hint: "hint-glimmer",
  springDry: "spring-dry", pause: "pause-hush", resume: "resume-swell",
};
/** The caption each meaningful sound shows (js/audio.js event()). */
export const CAPTIONS: Record<string, string> = {
  carve: N("dig"), carveHard: N("heavy dig"), invalid: N("not allowed"), release: N("water released"), contaminate: N("water contaminated"),
  undo: N("undo"), win: N("well filled — round complete"), lose: N("round failed"), achievement: N("achievement unlocked"), hint: N("hint"),
  springDry: N("the spring has run dry"), pause: N("paused"), resume: N("resumed"),
};

const clips = new Map<string, AudioClip>();
/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  void renderVoices().catch((e: unknown) => console.warn(`audio: ${String(e)}`));
}

/** Plays a logical event's sample. */
export function event(name: string): void {
  const file = SAMPLES[name];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  try { playClip(clip, { bus: "effects", gain: LEVEL.effects }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 11025;
/** js/audio.js _blip: a voice from 0.0001 to `peak` in 8 ms, back to 0.0001 by `dur`. */
function blip(off: OfflineAudioContext, type: "sine" | "triangle", f: number, peak: number, dur: number): void {
  const osc = off.createOscillator();
  osc.type = type;
  osc.frequency.value = f;
  const g = off.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.exponentialRampToValueAtTime(peak, 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, dur);
  osc.connect(g).connect(off.destination);
  osc.start();
  osc.stop(dur);
}
/** One music step: a sine at f (2.4 s, 0.035) with a triangle at f / 2 (2.8 s, 0.025). */
async function renderNote(f: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(2.85 * RATE), RATE);
  blip(off, "sine", f, 0.035, 2.4);
  blip(off, "triangle", f / 2, 0.025, 2.8);
  return createClip(await off.startRendering());
}
/** The ambience: brown noise lowpassed at 320 Hz, its gain swung ±31 % by a 0.07 Hz sine,
 * one swell long (1 / 0.07 s), seamless (filtered periodic noise is periodic once settled). */
const AMBIENCE_GAIN = 0.1311; // measured: rms 0.0273, the old ambience's
async function renderAmbience(): Promise<AudioClip> {
  const n = Math.round(RATE / 0.07), settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: 0xA0D10, seconds: n / RATE });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 320;
  const g = off.createGain();
  g.gain.value = AMBIENCE_GAIN;
  const swell = off.createOscillator();
  swell.frequency.value = 0.07;
  const depth = off.createGain();
  depth.gain.value = AMBIENCE_GAIN * (0.05 / 0.16);
  swell.connect(depth).connect(g.gain);
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  swell.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}

const SCALE = [220, 262, 294, 330, 392, 440];
const notes: AudioClip[] = [];
let ambience: AudioClip | null = null;
/** Every voice, one graph at a time; the ambience last, as update() waits on it. */
async function renderVoices(): Promise<void> {
  for (const f of SCALE) notes.push(await renderNote(f));
  ambience = await renderAmbience();
}

// -- music and ambience -------------------------------------------------------------------
const rng = makeRng(0xA0D10, "audio");
let nextNote = 0;
let ambSound: Sound | null = null;

/** Each frame once the mixer runs and the voices are rendered: the ambience loop and the music's notes by mixer time. */
export function update(): void {
  if (context.state !== "running" || !ambience) return;
  const now = context.currentTime;
  if (!ambSound) {
    try { ambSound = playClip(ambience, { bus: "effects", gain: 0.0001, loop: true }); ambSound.fade(LEVEL.ambience, 2); }
    catch { ambSound = null; }
    return;
  }
  // music: every 1.4 s step, a note on every second one
  if (nextNote === 0 || now - nextNote > 3) nextNote = now + 2.8;
  if (now < nextNote) return;
  nextNote += 2.8;
  try { playClip(notes[Math.floor(rng.next() * SCALE.length)]!, { bus: "music", gain: LEVEL.music }); } catch { /* the mixer is full */ }
}
