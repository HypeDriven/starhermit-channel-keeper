// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom and their resolutions, the grade,
// anti-aliasing) are the level's own (levelSettings(): the same table every
// StarHermit game reads). The game's art (materials, bevel segments, grain
// textures, boulders, the animated water and background) is the browser
// build's four presets (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS
// on the weakest GPU Auto gave it) keyed by the level's quality tier, with
// the boulders and splash particles scaled within the tier by the level's
// particle budget against the tier's anchor level (quantum, molecular,
// terrestrial, galactic), at most 4×. The runtime owns what the old Graphics
// panel did besides: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution and the frame-rate limit and readout.
// The per-category overrides of the old panel are not offered (the runtime's
// Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: Preset;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution as a fraction of the frame (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "detailed" | "animatedBackground" | "animatedWater">;
const TABLE: Record<Preset, Art> = {
  low: { detailed: false, animatedBackground: false, animatedWater: false },
  balanced: { detailed: true, animatedBackground: true, animatedWater: true },
  high: { detailed: true, animatedBackground: true, animatedWater: true },
  ultra: { detailed: true, animatedBackground: true, animatedWater: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", bevel: 1, grain: 64, rocks: 8, particles: 200 },
  balanced: { material: "standard", bevel: 2, grain: 128, rocks: 14, particles: 600 },
  high: { material: "physical", bevel: 3, grain: 256, rocks: 20, particles: 1200 },
  ultra: { material: "physical", bevel: 4, grain: 256, rocks: 28, particles: 2000 },
};
/** The particle tier caps (js/gfx.js PARTICLE_CAP): Low's tier is "low". */
const PARTICLE_CAP: Record<Preset, number> = { low: 300, balanced: 2000, high: 2000, ultra: 2000 };
/** Each tier's reference level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // Counts grow with the level's particle budget above the tier's anchor, at
  // most four times the tier's budget (as StarHermitGpu.scaleBudget did).
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.rocks = Math.min(60, Math.round(b.rocks * k));
  b.particles = Math.min(PARTICLE_CAP[preset], Math.round(b.particles * k));
  return {
    preset, ...TABLE[preset], budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
  };
}
