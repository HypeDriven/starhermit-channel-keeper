// Channel Keeper — graphics quality model: presets, per-category overrides,
// GPU detection and a cost summary. Pure (no three.js) so the settings panel,
// the renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  particles: ['low', 'high'],
  background: ['static', 'animated'],
  detail: ['plain', 'detailed'],
  water: ['flat', 'animated'],
};

// Each preset is a row of tiers plus a render scale and a device-pixel-ratio
// cap. Low matches the pre-settings renderer's low tier (dpr 1, no AA, no
// shadows, no post chain).
const TABLE = {
  low: { dprCap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', particles: 'low', background: 'static', detail: 'plain', water: 'flat' },
  balanced: { dprCap: 1.5, scale: 0.9, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', particles: 'high', background: 'animated', detail: 'detailed', water: 'animated' },
  high: { dprCap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', particles: 'high', background: 'animated', detail: 'detailed', water: 'animated' },
  ultra: { dprCap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', particles: 'high', background: 'animated', detail: 'detailed', water: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_CAP = { low: 300, high: 2000 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD, 20 = RTX 5090;
// gpu-level.js → window.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
// Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
export const PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

function gpuApi() { return globalThis.StarHermitGpu; }

/** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  if (!G) return PRESET_LEVELS.balanced;
  return G.detectLevel({ ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, PRESET_LEVELS);
  return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
}

/** Best preset for this GPU (the level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor budget). */
export function scaleCount(n, preset, level) {
  const G = gpuApi();
  const floor = PRESET_LEVELS[preset] || 0;
  return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
}

/**
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → hardware level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
 *   material     'lambert' (cells, water, walls, rocks) | 'standard' | 'physical' (clearcoat water);
 *   bevel        rounded-cell bevel segments when Surface detail is detailed;
 *   grain        soil/pebble grain texture px for cells (cavern wall uses twice this);
 *   rocks        scattered boulders at the floor level; particles = splash budget at the floor level
 *                (the Particles tier still caps it). Counts scale up within the preset on faster GPUs
 *                (StarHermitGpu.scaleBudget, ≤ 4×, never below the floor budget).
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame.
 */
export const BUDGETS = {
  low: { material: 'lambert', bevel: 1, grain: 64, rocks: 8, particles: 200, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', bevel: 2, grain: 128, rocks: 14, particles: 600, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', bevel: 3, grain: 256, rocks: 20, particles: 1200, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', bevel: 4, grain: 256, rocks: 28, particles: 2000, bloomRes: 1, aoRes: 1 },
};

/** A preset's concrete budget for a hardware level and Particles tier. */
export function budgetFor(preset, level, particles = 'high') {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  b.particles = Math.min(PARTICLE_CAP[particles] || PARTICLE_CAP.low, scaleCount(b.particles, preset, level));
  b.rocks = Math.min(60, scaleCount(b.rocks, preset, level));
  return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, dprCap: row.dprCap, renderScale, scale: row.scale * renderScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.budget = budgetFor(preset, level, out.particles);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The post chain runs only when an effect needs it (MSAA uses a multisampled target).
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
  return out;
}

/** Choosing a preset clears every per-category override (render scale and toggles stay). */
export function choosePreset(saved, preset) {
  const s = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const SUMMARY_WORDS = {
  noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion',
  aoHigh: 'full ambient occlusion', bloom: 'bloom', noAA: 'no anti-aliasing',
};

/** Cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels, words = SUMMARY_WORDS) {
  const w = { ...SUMMARY_WORDS, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : `${SHADOW_MAP[r.shadows]}² ${w.shadows}`,
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
