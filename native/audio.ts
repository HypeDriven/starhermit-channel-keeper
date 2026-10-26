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
// gain. The music and ambience voices, which the browser build made with
// oscillators and filtered noise, are rendered once into clips (createClip)
// with the same envelopes; the synthesized stand-ins it played while a
// sample loaded are not ported (the engine's web runtime drops clip loads
// while a synthesis graph changes: the arrow-exodus finding). Clips load
// once the mixer runs (natively at once, in a browser after the first
// press), one at a time; rendered voices are made one a frame after that.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
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
const queue: string[] = [];
let loading = false;
let wantClips = false;
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** Plays a logical event's sample. */
export function event(name: string): void {
  const file = SAMPLES[name];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  try { playClip(clip, { bus: "effects", gain: LEVEL.effects }); }
  catch { clips.delete(file!); load(file!); } // a clip the mixer lost: load it again
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 11025;
/** js/audio.js _blip's envelope: 0.0001 → peak in 8 ms, back to 0.0001 by `dur`. */
function env(t: number, peak: number, dur: number): number {
  if (t < 0 || t > dur) return 0;
  if (t < 0.008) return 0.0001 * Math.pow(peak / 0.0001, t / 0.008);
  return peak * Math.pow(0.0001 / peak, (t - 0.008) / (dur - 0.008));
}
/** One music step: a sine at f (2.4 s, 0.035) with a triangle at f / 2 (2.8 s, 0.025). */
function noteClip(f: number): AudioClip {
  const n = Math.round(2.85 * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const ph = ((f / 2) * t) % 1;
    out[i] = Math.sin(2 * Math.PI * f * t) * env(t, 0.035, 2.4) + (1 - 4 * Math.abs(ph - 0.5)) * env(t, 0.025, 2.8);
  }
  return createClip([out], RATE);
}
/** The ambience: brown-ish noise lowpassed at 320 Hz at 0.16, its gain swung ±0.05
 * by a 0.07 Hz sine, one swell long (1 / 0.07 s), the loop's ends cross-faded. */
function ambienceClip(): AudioClip {
  const n = Math.round(RATE / 0.07), fade = RATE;
  const raw = new Float32Array(n + fade);
  const rng = makeRng(0xA0D10, "ambience");
  let last = 0;
  for (let i = 0; i < raw.length; i++) { last = (last + 0.02 * (rng.next() * 2 - 1)) / 1.02; raw[i] = last * 3; }
  // RBJ biquad lowpass, Q 1 (Web Audio's default for a lowpass BiquadFilterNode)
  const w = (2 * Math.PI * 320) / RATE, alpha = Math.sin(w) / 2, c = Math.cos(w), a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < raw.length; i++) {
    const x0 = raw[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    raw[i] = y0;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = raw[i]!;
    if (i < fade) { const k = i / fade; v = v * k + raw[n + i]! * (1 - k); }
    out[i] = v * (0.16 + 0.05 * Math.sin((2 * Math.PI * 0.07 * i) / RATE));
  }
  return createClip([out], RATE);
}

const SCALE = [220, 262, 294, 330, 392, 440];
const notes: AudioClip[] = [];
let ambience: AudioClip | null = null;
/** One rendered voice a frame, once the samples are in; false when all are made. */
function renderNext(): boolean {
  if (notes.length < SCALE.length) { notes.push(noteClip(SCALE[notes.length]!)); return true; }
  if (!ambience) { ambience = ambienceClip(); return true; }
  return false;
}

// -- music and ambience -------------------------------------------------------------------
const rng = makeRng(0xA0D10, "audio");
let nextNote = 0;
let ambSound: Sound | null = null;

/** Each frame: the samples once the mixer runs, one rendered voice a frame,
 * then the ambience loop and the music's notes by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of new Set(Object.values(SAMPLES))) load(name);
  }
  pump();
  if (loading || queue.length) return;
  try { if (renderNext()) return; } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  const now = context.currentTime;
  if (!ambSound && ambience) {
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
