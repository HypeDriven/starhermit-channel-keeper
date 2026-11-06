// Localization coverage: every English key the engine client (native/*.ts)
// and the content show is translated in every locale (en-GB → en-US, es-ES →
// es-419, fr-CA → fr-FR inherit), with its placeholders, and no table keeps a
// key nothing shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';
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
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && !k.startsWith('starhermit.')).sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(JSON.parse(read('assets/strings.json')), usedKeys()), []);
});
