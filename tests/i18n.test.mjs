// Localization coverage: every English key the engine client (native/*.ts)
// and the content show is translated in every locale (en-GB → en-US, es-ES →
// es-419, fr-CA → fr-FR inherit), with its placeholders, and no table keeps a
// key nothing shows; the classic js/i18n.js switches locale as
// native/i18n.ts drives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadTables, codeKeys, audit, bootI18n } from './i18n-common.mjs';
import { TUTORIALS, CHALLENGES, PRACTICE_DIFFICULTIES, ACHIEVEMENTS } from '../js/content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    codeKeys(read('native/' + f), ['tr']).forEach((k) => keys.add(k));
  }
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

test('the locale switches as the engine client sets it, with the regional tables', () => {
  const { I18N } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CKI18N' });
  assert.equal(I18N.lang, 'en-US');
  assert.equal(I18N.setLocale('de-DE'), 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.setLocale('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
  assert.equal(I18N.T('Resume'), 'Resume');
  I18N.setLocale('fr-CA');
  assert.equal(I18N.T('Score'), 'Pointage');
  assert.equal(I18N.setLocale('xx-YY'), 'en-US');
  assert.equal(I18N.T('Stage {n}', { n: 3 }), 'Stage 3');
});
