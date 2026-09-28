// Unit tests for the pure graphics quality model and its strings (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, PRESETS, detectPreset, resolve, presetTier, choosePreset, describe } from '../js/gfx.js';
import { GFX_LOCALES, gfxStrings, missingKeys, pickLocale } from '../js/gfx-i18n.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // Touch devices cap Auto at balanced.
  assert.equal(detectPreset('Apple M2', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({ preset: 'auto' }, 'high');
  assert.equal(a.preset, 'high');
  assert.equal(a.auto, true);
  const b = resolve({ preset: 'low' }, 'high');
  assert.equal(b.preset, 'low');
  assert.equal(b.auto, false);
  assert.equal(b.post, false, 'low runs without a post chain');
  assert.equal(b.shadows, 'off');
  assert.equal(resolve({}, undefined).preset, 'balanced');
});

test('resolve: overrides apply, invalid tiers fall back to the preset', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'nope' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, presetTier('low', 'shadows'));
  assert.equal(r.post, true, 'bloom override turns the post chain on');
  for (const cat of Object.keys(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(CATEGORIES[cat].includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('resolve: render scale clamps to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'high' }).adaptive, true);
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }).showFps, true);
});

test('choosing a preset clears category overrides but keeps scale and toggles', () => {
  const s = choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, show_fps: true }, 'high');
  assert.equal(s.preset, 'high');
  assert.equal(s.bloom, undefined);
  assert.equal(s.ao, undefined);
  assert.equal(s.render_scale, 1.5);
  assert.equal(s.show_fps, true);
  assert.equal(choosePreset({}, 'bogus').preset, 'auto');
});

test('describe summarises cost', () => {
  const d = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows · no anti-aliasing/);
});

test('graphics strings exist in every required locale', () => {
  for (const l of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(GFX_LOCALES.includes(l), l);
    assert.deepEqual(missingKeys(l), [], `${l} missing keys`);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  assert.equal(gfxStrings('de-DE')('fromPreset', { tier: 'Hoch' }), 'Aus Voreinstellung (Hoch)');
});
