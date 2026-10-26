// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the boulders and splash particles scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level. The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Cells, water, walls and rocks: Lambert, standard PBR, or physical (clearcoat water). */
  material: "lambert" | "standard" | "physical";
  /** Rounded-cell bevel segments (surface detail on). */
  bevel: number;
  /** Soil grain texture size in px for the cells (the cavern wall uses twice this). */
  grain: number;
  /** Scattered boulders beside the board. */
  rocks: number;
  /** Splash particles alive at once. */
  particles: number;
  /** Bloom resolution as a fraction of the frame. */
  bloomRes: number;
  /** Ambient occlusion resolution as a fraction of the frame. */
  aoRes: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Rounded bevelled cells, grain textures, lumpy boulders, image-based reflections, clay strata and wet channel floors. */
  detailed: boolean;
  /** Dust motes and the lamp's breathing. */
  animatedBackground: boolean;
  /** The water's shimmer. */
  animatedWater: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", detailed: false, animatedBackground: false, animatedWater: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", detailed: true, animatedBackground: true, animatedWater: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", detailed: true, animatedBackground: true, animatedWater: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", detailed: true, animatedBackground: true, animatedWater: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", bevel: 1, grain: 64, rocks: 8, particles: 200, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", bevel: 2, grain: 128, rocks: 14, particles: 600, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", bevel: 3, grain: 256, rocks: 20, particles: 1200, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", bevel: 4, grain: 256, rocks: 28, particles: 2000, bloomRes: 1, aoRes: 1 },
};
/** The particle tier caps (js/gfx.js PARTICLE_CAP): Low's tier is "low". */
const PARTICLE_CAP: Record<Preset, number> = { low: 300, balanced: 2000, high: 2000, ultra: 2000 };
/** The first level index of each tier. */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most four times the tier's budget (as
  // StarHermitGpu.scaleBudget did).
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.rocks = Math.min(60, Math.round(b.rocks * k));
  b.particles = Math.min(PARTICLE_CAP[preset], Math.round(b.particles * k));
  return { preset, ...TABLE[preset], budget: b };
}
