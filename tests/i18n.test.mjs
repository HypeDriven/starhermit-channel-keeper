// Localization coverage: every English key the markup, code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders and markup survive, and the language follows
// sh-language.js and switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n } from './i18n-common.mjs';
import { TUTORIALS, CHALLENGES, PRACTICE_DIFFICULTIES, ACHIEVEMENTS } from '../js/content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/main.js', 'js/ui.js', 'js/platform.js']) codeKeys(read(f), ['tr'], ['N']).forEach((k) => keys.add(k));
  for (const m of read('js/audio.js').matchAll(/_caption\('((?:[^'\\]|\\.)*)'\)/g)) keys.add(m[1]);
  keys.add('not allowed');
  for (const t of TUTORIALS) { keys.add(t.name); if (t.goal) keys.add(t.goal); for (const s of t.tutorial.steps) keys.add(s.text); }
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.goal); }
  for (const p of PRACTICE_DIFFICULTIES) keys.add(p.name);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  ['none'].forEach((k) => keys.add(k));
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'CK_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CKI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
});
