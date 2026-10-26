// Localization coverage helpers (shared shape across this game's tests).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
export const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');

/** Load the translation tables from a classic-script strings file. */
export function loadTables(root, file, globalName) {
  const sandbox = { self: {} };
  vm.runInNewContext(readFileSync(new URL(file, root), 'utf8'), sandbox);
  return sandbox.self[globalName];
}

/** English keys used in code: T('…'), N('…') (deferred), and T(c ? '…' : '…'). */
export function codeKeys(src, extraFns = [], baseFns = ['T', 'N']) {
  const keys = new Set();
  const fns = [...baseFns, ...extraFns].join('|');
  const lit = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${fns})\(\s*(?:${lit})`, 'g'))) keys.add(unq(m[1] ?? m[2]));
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:${fns})\((?:[^()'"?]|'[^'\n]*'|\([^()]*\))*\?\s*(?:${lit})\s*:\s*(?:${lit})`, 'g'))) {
    keys.add(unq(m[1] ?? m[2])); keys.add(unq(m[3] ?? m[4]));
  }
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

/** Problems: missing translations in full locales, placeholder drift, stale or unknown keys. */
export function audit(tables, used) {
  const usedSet = new Set(used);
  const problems = [];
  for (const loc of FULL) {
    const t = tables[loc] || {};
    for (const k of usedSet) if (!Object.prototype.hasOwnProperty.call(t, k)) problems.push(`${loc} missing: ${k}`);
  }
  for (const [loc, table] of Object.entries(tables)) {
    if (!LOCALES.includes(loc)) problems.push(`unknown locale ${loc}`);
    for (const [k, v] of Object.entries(table)) {
      if (!usedSet.has(k)) { problems.push(`${loc} unused: ${k}`); continue; }
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (String(v).match(/\{\w+\}/g) || []).sort().join();
      if (want !== got) problems.push(`${loc} placeholders: ${k}`);
      const tagsK = (k.match(/<\/?\w+/g) || []).sort().join();
      const tagsV = (String(v).match(/<\/?\w+/g) || []).sort().join();
      if (tagsK !== tagsV) problems.push(`${loc} markup: ${k}`);
    }
  }
  for (const loc of ['en-GB', 'es-ES', 'fr-CA']) if (!tables[loc]) problems.push(`no ${loc} table`);
  return problems;
}

/** Load strings + the classic i18n.js in a sandbox; returns the game's I18N global. */
export function bootI18n(root, { strings, i18n, global }) {
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const read = (p) => readFileSync(new URL(p, root), 'utf8');
  vm.runInContext(read(strings), sandbox);
  vm.runInContext(read(i18n), sandbox);
  return { I18N: sandbox[global] };
}
